import type { LogEntry, ParsedRun } from "./types";

// Mirrors the data-prep section of scripts/chart.ts (lines ~37-277).

type Snapshot = {
  elapsed: number;
  remaining: number | null;
  upAsk: number | null;
  upBid: number | null;
  downAsk: number | null;
  downBid: number | null;
};

type SnapMeta = Pick<Snapshot, "upAsk" | "upBid" | "downAsk" | "downBid" | "remaining">;

type LinePoint = { x: number; y: number; meta?: SnapMeta };

type OrderMeta = {
  label: string;
  action: "buy" | "sell";
  side: "UP" | "DOWN";
  price: number;
  shares: number;
  status: string;
  elapsed: number;
  remaining: number;
  reason?: string;
  upAsk: number | null;
  upBid: number | null;
  downAsk: number | null;
  downBid: number | null;
};

type OrderPoint = { x: number; y: number; meta: OrderMeta };

type BtcPoint = {
  remaining: number;
  assetPrice: number;
  coinbasePrice?: number;
  binancePrice?: number;
  okxPrice?: number;
  bybitPrice?: number;
  gap?: number;
  priceToBeat?: number;
};

type BtcLinePoint = {
  x: number;
  y: number;
  meta: {
    remaining: number;
    assetPrice: number;
    coinbasePrice?: number;
    binancePrice?: number;
    okxPrice?: number;
    bybitPrice?: number;
    gap?: number;
    priceToBeat?: number;
  };
};

export type RunChartData = {
  slug: string;
  assetName: string;
  strategyName: string | null;
  resolution: ParsedRun["resolution"];
  buyFilledUp: number;
  buyFilledDown: number;
  sellFilledUp: number;
  sellFilledDown: number;
  pendingUp: number;
  pendingDown: number;
  upAskData: LinePoint[];
  upBidData: LinePoint[];
  downAskData: LinePoint[];
  downBidData: LinePoint[];
  orderData: OrderPoint[];
  orderColors: string[];
  orderShapes: string[];
  btcLineData: BtcLinePoint[];
  coinbaseLineData: { x: number; y: number }[];
  binanceLineData: { x: number; y: number }[];
  okxLineData: { x: number; y: number }[];
  bybitLineData: { x: number; y: number }[];
  ptbLineData: { x: number; y: number }[];
  priceToBeat: number | null;
  ptbStartRemaining: number | null;
  xMin: number;
  xMax: number;
};

function statusColor(status: string): string {
  if (status === "filled") return "#4ade80";
  if (status === "placed") return "#06b6d4";
  if (status === "canceled") return "#6b7280";
  if (status === "expired") return "#94a3b8";
  if (status === "failed") return "#ef4444";
  return "#6b7280";
}

export function buildRunChartData(run: ParsedRun): RunChartData {
  const entries: LogEntry[] = run.raw;
  const slot = entries.find((e) => e.type === "slot" && e.action === "start");

  const startTime: number = slot?.startTime ?? entries[0]?.ts ?? run.startTime;
  const endTime: number = slot?.endTime ?? run.endTime ?? 0;
  const slug: string = slot?.slug ?? run.slug;
  const assetName = slug.split("-")[0]?.toUpperCase() ?? "BTC";
  const strategyName: string | null = slot?.strategy ?? run.strategy;
  const totalDuration = endTime > startTime ? (endTime - startTime) / 1000 : 300;

  const el = (ts: number) => parseFloat(((ts - startTime) / 1000).toFixed(2));

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

  const buyFilledUp = orders.filter(
    (o) => o.action === "buy" && o.side === "UP" && o.status === "filled",
  ).length;
  const buyFilledDown = orders.filter(
    (o) => o.action === "buy" && o.side === "DOWN" && o.status === "filled",
  ).length;
  const sellFilledUp = orders.filter(
    (o) => o.action === "sell" && o.side === "UP" && o.status === "filled",
  ).length;
  const sellFilledDown = orders.filter(
    (o) => o.action === "sell" && o.side === "DOWN" && o.status === "filled",
  ).length;
  const pendingUp = Math.max(0, buyFilledUp - sellFilledUp);
  const pendingDown = Math.max(0, buyFilledDown - sellFilledDown);

  const snapMeta = (s: Snapshot): SnapMeta => ({
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

  const nearestSnapshot = (elapsedSec: number): Snapshot | null => {
    if (!snapshots.length) return null;
    return snapshots.reduce((prev, curr) =>
      Math.abs(curr.elapsed - elapsedSec) < Math.abs(prev.elapsed - elapsedSec)
        ? curr
        : prev,
    );
  };

  const orderData: OrderPoint[] = orders.map((o) => {
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

  const allRemaining: number[] = [];
  allRemaining.push(...snapshots.map((s) => rem(s)));
  allRemaining.push(
    ...orders.map((o) => parseFloat((totalDuration - o.elapsed).toFixed(2))),
  );
  const xMax = allRemaining.length
    ? Math.ceil(Math.max(...allRemaining))
    : totalDuration;
  const xMin = allRemaining.length ? Math.floor(Math.min(...allRemaining)) : 0;

  // ── Asset price data ─────────────────────────────────────────────────────
  const btcPoints: BtcPoint[] = [];
  let lastRemaining: number | null = null;
  let lastMarketPrice: { gap?: number; priceToBeat?: number } | null = null;
  for (const e of entries) {
    if (e.type === "remaining") {
      lastRemaining = e.seconds ?? null;
    } else if (e.type === "market_price" && e.openPrice != null) {
      lastMarketPrice = { gap: e.gap, priceToBeat: e.priceToBeat };
    } else if (
      e.type === "ticker" &&
      lastRemaining !== null &&
      e.assetPrice != null
    ) {
      btcPoints.push({
        remaining: lastRemaining,
        assetPrice: e.assetPrice,
        coinbasePrice: e.coinbasePrice ?? undefined,
        binancePrice: e.binancePrice ?? undefined,
        okxPrice: e.okxPrice ?? undefined,
        bybitPrice: e.bybitPrice ?? undefined,
        gap: lastMarketPrice?.gap,
        priceToBeat: lastMarketPrice?.priceToBeat,
      });
      lastRemaining = null;
    }
  }

  const byRemaining = new Map<number, BtcPoint>();
  for (const p of btcPoints) byRemaining.set(p.remaining, p);
  const dedupedBtcPoints = [...byRemaining.values()].sort(
    (a, b) => b.remaining - a.remaining,
  );

  const ptbPoints = dedupedBtcPoints.filter((p) => p.priceToBeat != null);
  const priceToBeat: number | null =
    ptbPoints.length > 0 ? ptbPoints[ptbPoints.length - 1]!.priceToBeat! : null;
  const firstPtbPoint = ptbPoints[0] ?? null;
  const ptbStartRemaining = firstPtbPoint?.remaining ?? null;

  const btcLineData: BtcLinePoint[] = dedupedBtcPoints.map((p) => ({
    x: p.remaining,
    y: p.assetPrice,
    meta: {
      remaining: p.remaining,
      assetPrice: p.assetPrice,
      coinbasePrice: p.coinbasePrice,
      binancePrice: p.binancePrice,
      okxPrice: p.okxPrice,
      bybitPrice: p.bybitPrice,
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
  const okxLineData = dedupedBtcPoints
    .filter((p) => p.okxPrice != null)
    .map((p) => ({ x: p.remaining, y: p.okxPrice as number }));
  const bybitLineData = dedupedBtcPoints
    .filter((p) => p.bybitPrice != null)
    .map((p) => ({ x: p.remaining, y: p.bybitPrice as number }));

  const ptbLineData =
    priceToBeat != null && firstPtbPoint != null
      ? [
          { x: firstPtbPoint.remaining, y: priceToBeat },
          { x: xMin, y: priceToBeat },
        ]
      : [];

  return {
    slug,
    assetName,
    strategyName,
    resolution: run.resolution,
    buyFilledUp,
    buyFilledDown,
    sellFilledUp,
    sellFilledDown,
    pendingUp,
    pendingDown,
    upAskData,
    upBidData,
    downAskData,
    downBidData,
    orderData,
    orderColors,
    orderShapes,
    btcLineData,
    coinbaseLineData,
    binanceLineData,
    okxLineData,
    bybitLineData,
    ptbLineData,
    priceToBeat,
    ptbStartRemaining,
    xMin,
    xMax,
  };
}
