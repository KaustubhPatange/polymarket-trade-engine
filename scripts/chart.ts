#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "fs";
import { basename } from "path";
import { execSync } from "child_process";

const args = process.argv.slice(2);
const openFlag = args.includes("--open");
const logFile = args.find((a) => !a.startsWith("--"));
if (!logFile) {
  console.error("Usage: bun scripts/eb-chart.ts <early-bird-{slug}.log> [--open]");
  process.exit(1);
}

const raw = readFileSync(logFile, "utf-8");

// Parse all JSON objects (handles both single-line and multi-line pretty-printed entries)
function parseAllJson(text: string): any[] {
  const results: any[] = [];
  let depth = 0,
    start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") {
      if (depth++ === 0) start = i;
    } else if (c === "}" && --depth === 0 && start !== -1) {
      try {
        results.push(JSON.parse(text.slice(start, i + 1)));
      } catch {}
      start = -1;
    }
  }
  return results;
}

const entries = parseAllJson(raw);

const slotEntry = entries.find(
  (e) => e.type === "slot" && e.action === "start",
);
const startTime: number = slotEntry?.startTime ?? entries[0]?.ts ?? 0;
const endTime: number = slotEntry?.endTime ?? 0;
const slug: string = slotEntry?.slug ?? basename(logFile, ".log");
const assetName = slug.split("-")[0]?.toUpperCase() ?? "BTC";
const strategyName: string | null = slotEntry?.strategy ?? null;
const totalDuration = endTime > startTime ? (endTime - startTime) / 1000 : 300;
const allRemaining: number[] = [];
const el = (ts: number) => parseFloat(((ts - startTime) / 1000).toFixed(2));

// Pair each orderbook_snapshot with the immediately following remaining entry
type Snapshot = {
  elapsed: number;
  remaining: number | null;
  upAsk: number | null;
  upBid: number | null;
  downAsk: number | null;
  downBid: number | null;
};
const snapshots: Snapshot[] = [];
let pendingSnap: any = null;
for (const e of entries) {
  if (e.type === "orderbook_snapshot") {
    pendingSnap = e;
  } else if (e.type === "remaining" && pendingSnap) {
    snapshots.push({
      elapsed: el(pendingSnap.ts),
      remaining: e.seconds ?? null,
      upAsk: pendingSnap.up?.asks?.[0]?.[0] ?? null,
      upBid: pendingSnap.up?.bids?.[0]?.[0] ?? null,
      downAsk: pendingSnap.down?.asks?.[0]?.[0] ?? null,
      downBid: pendingSnap.down?.bids?.[0]?.[0] ?? null,
    });
    pendingSnap = null;
  }
}

const orders = entries
  .filter((e) => e.type === "order")
  .map((e) => ({
    elapsed: el(e.ts),
    action: e.action as "buy" | "sell",
    side: e.side as "UP" | "DOWN",
    price: e.price as number,
    shares: e.shares as number,
    status: e.status as string,
    reason: e.reason as string | undefined,
  }));

// ── order fill stats ─────────────────────────────────────────────────────────
const buyFilledUp    = orders.filter(o => o.action === "buy"  && o.side === "UP"   && o.status === "filled").length;
const buyFilledDown  = orders.filter(o => o.action === "buy"  && o.side === "DOWN" && o.status === "filled").length;
const sellFilledUp   = orders.filter(o => o.action === "sell" && o.side === "UP"   && o.status === "filled").length;
const sellFilledDown = orders.filter(o => o.action === "sell" && o.side === "DOWN" && o.status === "filled").length;
const pendingUp   = Math.max(0, buyFilledUp   - sellFilledUp);
const pendingDown = Math.max(0, buyFilledDown - sellFilledDown);

const resolutionEntry = entries.find(e => e.type === "resolution") as {
  direction: "UP" | "DOWN";
  openPrice: number;
  closePrice: number;
  unfilledShares: number;
  payout: number;
  pnl: number;
} | undefined;

// ── datasets ─────────────────────────────────────────────────────────────────

const snapMeta = (s: Snapshot) => ({
  upAsk: s.upAsk,
  upBid: s.upBid,
  downAsk: s.downAsk,
  downBid: s.downBid,
  remaining: s.remaining,
});

const rem = (s: Snapshot) =>
  s.remaining ?? parseFloat((totalDuration - s.elapsed).toFixed(2));

const upAskData = snapshots
  .filter((s) => s.upAsk != null)
  .map((s) => ({ x: rem(s), y: s.upAsk as number, meta: snapMeta(s) }));
const upBidData = snapshots
  .filter((s) => s.upBid != null)
  .map((s) => ({ x: rem(s), y: s.upBid as number, meta: snapMeta(s) }));
const downAskData = snapshots
  .filter((s) => s.downAsk != null)
  .map((s) => ({ x: rem(s), y: s.downAsk as number, meta: snapMeta(s) }));
const downBidData = snapshots
  .filter((s) => s.downBid != null)
  .map((s) => ({ x: rem(s), y: s.downBid as number, meta: snapMeta(s) }));

function statusColor(status: string): string {
  if (status === "filled") return "#4ade80";
  if (status === "placed") return "#06b6d4";
  if (status === "canceled") return "#6b7280";
  if (status === "expired") return "#94a3b8";
  if (status === "failed") return "#ef4444";
  return "#6b7280";
}

function nearestSnapshot(elapsedSec: number): Snapshot | null {
  if (!snapshots.length) return null;
  return snapshots.reduce((prev, curr) =>
    Math.abs(curr.elapsed - elapsedSec) < Math.abs(prev.elapsed - elapsedSec)
      ? curr
      : prev,
  );
}

const orderData = orders.map((o) => {
  const snap = nearestSnapshot(o.elapsed);
  return {
    x: parseFloat((totalDuration - o.elapsed).toFixed(2)),
    y: o.price,
    meta: {
      label: `${o.status.toUpperCase()} ${o.action.toUpperCase()} ${o.side}`,
      action: o.action,
      side: o.side,
      price: o.price,
      shares: o.shares,
      status: o.status,
      elapsed: o.elapsed,
      remaining: parseFloat((totalDuration - o.elapsed).toFixed(1)),
      reason: o.reason,
      upAsk: snap?.upAsk ?? null,
      upBid: snap?.upBid ?? null,
      downAsk: snap?.downAsk ?? null,
      downBid: snap?.downBid ?? null,
    },
  };
});
const orderColors = orders.map((o) => statusColor(o.status));
const orderShapes = orders.map((o) =>
  o.action === "buy" ? "triangle" : "rectRot",
);

allRemaining.push(
  ...snapshots.map((s) => rem(s)),
  ...orders.map((o) => parseFloat((totalDuration - o.elapsed).toFixed(2))),
);
const xMax = allRemaining.length
  ? Math.ceil(Math.max(...allRemaining))
  : totalDuration;
const xMin = allRemaining.length ? Math.floor(Math.min(...allRemaining)) : 0;

// ── Asset price data ──────────────────────────────────────────────────────────
type BtcPoint = {
  remaining: number;
  assetPrice: number;
  coinbasePrice?: number;
  binancePrice?: number;
  gap?: number;
  priceToBeat?: number;
};
const btcPoints: BtcPoint[] = [];
let _lastRemaining: number | null = null;
let _lastMarketPrice: {
  openPrice: number;
  gap?: number;
  priceToBeat?: number;
} | null = null;
for (const e of entries) {
  if (e.type === "remaining") {
    _lastRemaining = e.seconds ?? null;
  } else if (e.type === "market_price" && e.openPrice != null) {
    _lastMarketPrice = {
      openPrice: e.openPrice,
      gap: e.gap,
      priceToBeat: e.priceToBeat,
    };
  } else if (
    e.type === "ticker" &&
    _lastRemaining !== null &&
    e.assetPrice != null
  ) {
    btcPoints.push({
      remaining: _lastRemaining,
      assetPrice: e.assetPrice,
      coinbasePrice: e.coinbasePrice ?? undefined,
      binancePrice: e.binancePrice ?? undefined,
      gap: _lastMarketPrice?.gap,
      priceToBeat: _lastMarketPrice?.priceToBeat,
    });
    _lastRemaining = null;
  }
}

// Deduplicate by remaining (keep last entry per value — timer + log() can emit same remaining twice)
const _btcByRemaining = new Map<number, BtcPoint>();
for (const p of btcPoints) _btcByRemaining.set(p.remaining, p);
const dedupedBtcPoints = [..._btcByRemaining.values()].sort((a, b) => b.remaining - a.remaining);

const priceToBeat =
  dedupedBtcPoints.findLast((p) => p.priceToBeat != null)?.priceToBeat ?? null;
const firstPtbPoint = dedupedBtcPoints.find((p) => p.priceToBeat != null) ?? null;

const btcLineData = dedupedBtcPoints.map((p) => ({
  x: p.remaining,
  y: p.assetPrice,
  meta: {
    remaining: p.remaining,
    assetPrice: p.assetPrice,
    coinbasePrice: p.coinbasePrice,
    binancePrice: p.binancePrice,
    gap: p.gap,
    priceToBeat: p.priceToBeat,
  },
}));

const coinbaseLineData = dedupedBtcPoints
  .filter((p) => p.coinbasePrice != null)
  .map((p) => ({ x: p.remaining, y: p.coinbasePrice as number }));

const binanceLineData = dedupedBtcPoints
  .filter((p) => p.binancePrice != null)
  .map((p) => ({ x: p.remaining, y: p.binancePrice as number }));

const ptbLineData =
  priceToBeat != null && firstPtbPoint != null
    ? [
        { x: firstPtbPoint.remaining, y: priceToBeat },
        { x: xMin, y: priceToBeat },
      ]
    : [];

// ── HTML ──────────────────────────────────────────────────────────────────────
const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${slug}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; }
    body {
      background: #0f172a; color: #e2e8f0;
      font-family: ui-monospace, monospace;
      padding: clamp(12px, 2vw, 24px);
      display: flex; flex-direction: column; gap: 12px;
      min-height: 100vh;
    }
    .topbar { display: flex; align-items: center; gap: 8px; flex-shrink: 0; flex-wrap: wrap; }
    .infobar {
      display: flex; align-items: center; gap: 16px; flex-shrink: 0; flex-wrap: wrap;
      font-size: 0.7rem; color: #94a3b8; background: #1e293b;
      border-radius: 8px; padding: 6px 14px;
    }
    .infobar .stat { display: flex; align-items: center; gap: 6px; }
    .infobar .stat-label { color: #64748b; }
    .infobar .badge {
      display: inline-block; padding: 1px 7px; border-radius: 4px;
      font-size: 0.68rem; font-weight: 600; letter-spacing: 0.03em;
    }
    .badge-up   { background: #14532d; color: #4ade80; }
    .badge-down { background: #1e3a5f; color: #60a5fa; }
    .badge-warn { background: #451a03; color: #fb923c; }
    .badge-pnl-pos { background: #14532d; color: #4ade80; }
    .badge-pnl-neg { background: #450a0a; color: #f87171; }
    .badge-resolved { background: #312e81; color: #a5b4fc; }
    h1 { font-size: clamp(0.75rem, 1.5vw, 1rem); color: #94a3b8; margin-right: auto; }
    .st-toggle {
      font-family: ui-monospace, monospace; font-size: 0.65rem;
      padding: 3px 10px; border-radius: 20px; border: 1px solid #334155;
      background: #1e293b; color: #64748b; cursor: pointer; letter-spacing: 0.04em;
      transition: background 0.15s, color 0.15s, border-color 0.15s;
    }
    .st-toggle.active { background: #334155; color: #e2e8f0; border-color: #475569; }
    .panes { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
    .pane {
      background: #1e293b; border-radius: 12px;
      padding: clamp(12px, 2vw, 20px);
      position: relative; min-height: 0;
    }
    .pane canvas { position: absolute; inset: clamp(12px, 2vw, 20px); }
    .pane-main { flex: 1 0 0; min-height: 420px; }
    .pane-btc  { flex: 0 0 220px; }
    #tooltip {
      position: fixed; background: #0f172a; border: 1px solid #334155;
      border-radius: 8px; padding: 10px 14px; font-size: 0.75rem;
      pointer-events: none; display: none; z-index: 100; min-width: 160px;
      line-height: 1.8; color: #cbd5e1;
    }
    #tooltip b { color: #f8fafc; display: block; margin-bottom: 4px; }
  </style>
</head>
<body>
  <div class="topbar">
    <h1>${slug}${strategyName ? ` <span style="color:#64748b;font-size:0.8em;font-weight:normal">— ${strategyName}</span>` : ""}</h1>
    <button class="st-toggle active" data-status="placed">Placed</button>
    <button class="st-toggle active" data-status="filled">Filled</button>
    <button class="st-toggle active" data-status="canceled">Cancelled</button>
    <button class="st-toggle active" data-status="expired">Expired</button>
    <button class="st-toggle active" data-status="failed">Failed</button>
  </div>
  <div class="infobar">
    <div class="stat">
      <span class="stat-label">BUY filled</span>
      <span class="badge badge-up">UP ${buyFilledUp}</span>
      <span class="badge badge-down">DOWN ${buyFilledDown}</span>
    </div>
    <div class="stat">
      <span class="stat-label">SELL filled</span>
      <span class="badge badge-up">UP ${sellFilledUp}</span>
      <span class="badge badge-down">DOWN ${sellFilledDown}</span>
    </div>
    ${pendingUp > 0 || pendingDown > 0 ? `<div class="stat">
      <span class="stat-label">Pending (unfilled)</span>
      ${pendingUp   > 0 ? `<span class="badge badge-warn">UP ${pendingUp}</span>`   : ""}
      ${pendingDown > 0 ? `<span class="badge badge-warn">DOWN ${pendingDown}</span>` : ""}
    </div>` : ""}
    ${resolutionEntry ? `<div class="stat">
      <span class="stat-label">Resolved</span>
      <span class="badge badge-resolved">${resolutionEntry.direction}</span>
    </div>
    <div class="stat">
      <span class="stat-label">PnL</span>
      <span class="badge ${resolutionEntry.pnl >= 0 ? "badge-pnl-pos" : "badge-pnl-neg"}">${resolutionEntry.pnl >= 0 ? "+" : ""}${resolutionEntry.pnl.toFixed(2)}</span>
    </div>` : ""}
  </div>
  <div class="panes">
    <div class="pane pane-main"><canvas id="chart-main"></canvas></div>
    <div class="pane pane-btc"><canvas id="chart-btc"></canvas></div>
  </div>
  <div id="tooltip"></div>

  <script>
    const upAskData   = ${JSON.stringify(upAskData)};
    const upBidData   = ${JSON.stringify(upBidData)};
    const downAskData = ${JSON.stringify(downAskData)};
    const downBidData = ${JSON.stringify(downBidData)};
    const orderData   = ${JSON.stringify(orderData)};
    const orderColors = ${JSON.stringify(orderColors)};
    const orderShapes = ${JSON.stringify(orderShapes)};
    const btcLineData      = ${JSON.stringify(btcLineData)};
    const ptbLineData      = ${JSON.stringify(ptbLineData)};
    const priceToBeat      = ${JSON.stringify(priceToBeat)};
    const coinbaseLineData = ${JSON.stringify(coinbaseLineData)};
    const binanceLineData  = ${JSON.stringify(binanceLineData)};

    const tooltip = document.getElementById("tooltip");

    Chart.register({
      id: "crosshair",
      afterDraw(chart) {
        if (chart._crosshairX == null) return;
        const { ctx, chartArea, scales } = chart;
        if (!scales.x) return;
        const x = scales.x.getPixelForValue(chart._crosshairX);
        if (x < chartArea.left || x > chartArea.right) return;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.bottom);
        ctx.strokeStyle = "#475569";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.restore();
      },
    });

    const mainChart = new Chart(document.getElementById("chart-main"), {
      type: "scatter",
      data: {
        datasets: [
          { label: "UP Ask",   data: upAskData,   type: "line", borderColor: "#ef4444", backgroundColor: "transparent", borderWidth: 2,   pointRadius: 0, pointHoverRadius: 0, tension: 0.1, order: 5 },
          { label: "UP Bid",   data: upBidData,   type: "line", borderColor: "#22c55e", backgroundColor: "transparent", borderWidth: 2,   pointRadius: 0, pointHoverRadius: 0, tension: 0.1, order: 4 },
          { label: "DOWN Ask", data: downAskData, type: "line", borderColor: "#ef4444", backgroundColor: "transparent", borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 0, tension: 0.1, borderDash: [5, 3], order: 3 },
          { label: "DOWN Bid", data: downBidData, type: "line", borderColor: "#22c55e", backgroundColor: "transparent", borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 0, tension: 0.1, borderDash: [5, 3], order: 2 },
          {
            label: "Orders",
            data: orderData,
            backgroundColor: orderColors,
            borderColor: orderColors,
            borderWidth: 2,
            pointRadius: 8,
            pointHoverRadius: 10,
            pointStyle: orderShapes,
            order: 1,
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: "nearest", intersect: false },
        plugins: {
          legend: { labels: { color: "#94a3b8", font: { family: "ui-monospace, monospace", size: 11 } } },
          tooltip: {
            enabled: false,
            external({ chart, tooltip: tt }) {
              if (tt.opacity === 0 || !tt.dataPoints?.length) { tooltip.style.display = "none"; return; }
              const dp = tt.dataPoints[0];
              const ds = chart.data.datasets[dp.datasetIndex];
              if (!ds) { tooltip.style.display = "none"; return; }
              const pt = ds.data[dp.dataIndex];
              if (!pt?.meta) { tooltip.style.display = "none"; return; }
              const m = pt.meta;
              let rows;
              if (dp.datasetIndex === 4) {
                // Find ALL visible orders within ±1s of this x (handles stacked orders)
                const visibleOrders = allOrderData.filter((p) => activeStatuses.has(p.meta.status));
                const nearby = visibleOrders.filter((p) => Math.abs(p.x - pt.x) <= 0.3);
                const targets = nearby.length > 0 ? nearby : [pt];
                const ref = targets[0].meta;
                rows = targets.map((o) => {
                  const om = o.meta;
                  const reason = om.reason ? \` — \${om.reason}\` : "";
                  return \`<b>\${om.label}</b> \${om.price != null ? om.price : ""}\${om.shares != null ? " × " + om.shares + " shares" : ""}\${reason}<br>\`;
                }).join("");
                if (ref.remaining != null) rows += \`<span style="color:#64748b">Remaining: \${ref.remaining}s</span><br>\`;
                if (ref.upAsk  != null) rows += \`<span style="color:#64748b">UP Ask: \${ref.upAsk} · Bid: \${ref.upBid}</span><br>\`;
                if (ref.downAsk != null) rows += \`<span style="color:#64748b">DOWN Ask: \${ref.downAsk} · Bid: \${ref.downBid}</span><br>\`;
              } else {
                rows = \`<b>Orderbook</b>\`;
                if (m.remaining != null) rows += \`Remaining: \${m.remaining}s<br>\`;
                if (m.upAsk     != null) rows += \`UP Ask: \${m.upAsk}<br>\`;
                if (m.upBid     != null) rows += \`UP Bid: \${m.upBid}<br>\`;
                if (m.downAsk   != null) rows += \`DOWN Ask: \${m.downAsk}<br>\`;
                if (m.downBid   != null) rows += \`DOWN Bid: \${m.downBid}<br>\`;
              }
              tooltip.innerHTML = rows;
              tooltip.style.display = "block";
              const cr = chart.canvas.getBoundingClientRect();
              const tipW = tooltip.offsetWidth;
              const rawLeft = tt.caretX + cr.left + 12;
              const left = rawLeft + tipW > window.innerWidth ? tt.caretX + cr.left - tipW - 12 : rawLeft;
              tooltip.style.left = left + "px";
              tooltip.style.top  = (tt.caretY + cr.top - 10) + "px";
            },
          },
        },
        scales: {
          x: {
            type: "linear", min: ${xMin}, max: ${xMax}, reverse: true,
            title: { display: true, text: "Remaining (seconds)", color: "#64748b" },
            ticks: { color: "#64748b", stepSize: 30 },
            grid: { color: "#334155" },
          },
          y: {
            min: 0.01, max: 1.00,
            title: { display: true, text: "Price", color: "#64748b" },
            ticks: { color: "#64748b" },
            grid: { color: "#334155" },
          },
        },
      },
    });

    // ── BTC price chart ───────────────────────────────────────────────────────
    const btcChart = new Chart(document.getElementById("chart-btc"), {
      type: "scatter",
      data: {
        datasets: [
          {
            label: "${assetName} Price",
            data: btcLineData,
            type: "line",
            borderColor: "#3b82f6",
            backgroundColor: "transparent",
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 0,
            tension: 0.2,
            order: 2,
          },
          {
            label: "Price to Beat",
            data: ptbLineData,
            type: "line",
            borderColor: "#f97316",
            backgroundColor: "transparent",
            borderWidth: 1.5,
            borderDash: [6, 4],
            pointRadius: 0,
            pointHoverRadius: 0,
            order: 3,
          },
          ...(coinbaseLineData.length ? [{
            label: "Coinbase",
            data: coinbaseLineData,
            type: "line",
            borderColor: "#a78bfa",
            backgroundColor: "transparent",
            borderWidth: 1.5,
            borderDash: [3, 3],
            pointRadius: 0,
            pointHoverRadius: 0,
            order: 4,
          }] : []),
          ...(binanceLineData.length ? [{
            label: "Binance",
            data: binanceLineData,
            type: "line",
            borderColor: "#fbbf24",
            backgroundColor: "transparent",
            borderWidth: 1.5,
            borderDash: [3, 3],
            pointRadius: 0,
            pointHoverRadius: 0,
            order: 5,
          }] : []),
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "nearest", intersect: false },
        plugins: {
          legend: { labels: { color: "#94a3b8", font: { family: "ui-monospace, monospace", size: 11 } } },
          tooltip: {
            backgroundColor: "#0f172a", borderColor: "#334155", borderWidth: 1,
            titleColor: "#94a3b8", bodyColor: "#cbd5e1",
            bodyFont: { family: "ui-monospace, monospace", size: 11 },
            filter: (item) => item.datasetIndex === 0,
            callbacks: {
              title: (items) => {
                const m = items[0]?.raw?.meta;
                return m?.remaining != null ? m.remaining.toFixed(1) + "s remaining" : "";
              },
              label: (item) => {
                const m = item.raw?.meta;
                return m?.assetPrice != null ? \`${assetName}: $\${m.assetPrice.toLocaleString()}\` : "";
              },
              afterLabel: (item) => {
                const m = item.raw?.meta;
                if (!m) return [];
                const lines = [];
                if (m.priceToBeat   != null) lines.push(\`Price to Beat: $\${m.priceToBeat.toLocaleString()}\`);
                if (m.coinbasePrice != null) lines.push(\`Coinbase: $\${m.coinbasePrice.toLocaleString()}\`);
                if (m.binancePrice  != null) lines.push(\`Binance: $\${m.binancePrice.toLocaleString()}\`);
                if (m.gap           != null) lines.push(\`Gap: \${m.gap >= 0 ? "+" : ""}\${m.gap.toFixed(2)}\`);
                return lines;
              },
            },
          },
        },
        scales: {
          x: {
            type: "linear", min: ${xMin}, max: ${xMax}, reverse: true,
            title: { display: true, text: "Remaining (seconds)", color: "#64748b" },
            ticks: { color: "#64748b", stepSize: 30 },
            grid: { color: "#334155" },
          },
          y: {
            title: { display: true, text: "${assetName} Price (USD)", color: "#64748b" },
            ticks: { color: "#64748b" },
            grid: { color: "#334155" },
          },
        },
      },
    });

    // ── order status toggles ──────────────────────────────────────────────────
    const allOrderData   = ${JSON.stringify(orderData)};
    const allOrderColors = ${JSON.stringify(orderColors)};
    const allOrderShapes = ${JSON.stringify(orderShapes)};
    const activeStatuses = new Set(["placed", "filled", "canceled", "expired", "failed"]);

    function applyOrderFilter() {
      const mainChart = Chart.getChart("chart-main");
      if (!mainChart) return;
      const ds = mainChart.data.datasets.find((d) => d.label === "Orders");
      if (!ds) return;
      const filtered = allOrderData.filter((p) => activeStatuses.has(p.meta.status));
      const indices  = allOrderData.map((_, i) => i).filter((i) => activeStatuses.has(allOrderData[i].meta.status));
      ds.data            = filtered;
      ds.backgroundColor = indices.map((i) => allOrderColors[i]);
      ds.borderColor     = indices.map((i) => allOrderColors[i]);
      ds.pointStyle      = indices.map((i) => allOrderShapes[i]);
      mainChart.update("none");
    }

    document.querySelectorAll(".st-toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const status = btn.dataset.status;
        if (activeStatuses.has(status)) { activeStatuses.delete(status); btn.classList.remove("active"); }
        else                             { activeStatuses.add(status);    btn.classList.add("active"); }
        applyOrderFilter();
      });
    });

    // ── crosshair + tooltip sync ─────────────────────────────────────────────
    const allCharts = [Chart.getChart("chart-main"), btcChart];

    function nearestIndexAtX(data, xVal) {
      if (!data?.length) return -1;
      let best = 0, bestDist = Infinity;
      for (let i = 0; i < data.length; i++) {
        const d = Math.abs((data[i]?.x ?? 0) - xVal);
        if (d < bestDist) { bestDist = d; best = i; }
      }
      return best;
    }

    document.querySelectorAll(".pane canvas").forEach((canvas) => {
      canvas.addEventListener("mousemove", (e) => {
        const c = Chart.getChart(canvas);
        if (!c?.scales?.x) return;
        const xVal = c.scales.x.getValueForPixel(e.clientX - canvas.getBoundingClientRect().left);
        allCharts.forEach((ch) => {
          if (!ch) return;
          ch._crosshairX = xVal;
          const data = ch.data.datasets[0]?.data;
          const idx = nearestIndexAtX(data, xVal);
          if (idx !== -1) {
            const pt = data[idx];
            ch.tooltip.setActiveElements(
              [{ datasetIndex: 0, index: idx }],
              { x: ch.scales.x.getPixelForValue(pt.x), y: ch.scales.y.getPixelForValue(pt.y) },
            );
          }
          ch.update("none");
        });
      });
      canvas.addEventListener("mouseleave", () => {
        allCharts.forEach((ch) => {
          if (!ch) return;
          ch._crosshairX = null;
          ch.tooltip.setActiveElements([], {});
          ch.update("none");
        });
        tooltip.style.display = "none";
      });
    });
  </script>
</body>
</html>`;

const outFile = logFile.replace(/\.log$/, ".html");
writeFileSync(outFile, html);
console.log(`Chart written → ${outFile}`);
if (openFlag) {
  const cmd = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
  execSync(`${cmd} "${outFile}"`);
}
