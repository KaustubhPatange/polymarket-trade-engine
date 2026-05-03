import { useEffect, useMemo, useRef, useState } from "react";
import { Chart, registerables } from "chart.js";
import { RunSlugDropdown } from "./RunSlugDropdown";
import { buildRunChartData, type RunChartData } from "../runChartData";
import type { ParsedRun } from "../types";

function useFullscreen(): [boolean, () => void, () => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!on) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOn(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [on]);
  return [on, () => setOn(true), () => setOn(false)];
}

Chart.register(...registerables);

type Props = {
  runs: ParsedRun[];
  slug: string | null; // we use filename as the unique key (slugs can repeat)
  onSelect: (filename: string | null) => void;
};

const ALL_STATUSES = [
  "placed",
  "filled",
  "canceled",
  "expired",
  "failed",
] as const;

export function RunDetail({ runs, slug, onSelect }: Props) {
  const selected = useMemo(
    () => (slug ? (runs.find((r) => r.filename === slug) ?? null) : null),
    [runs, slug],
  );

  const data = useMemo(
    () => (selected ? buildRunChartData(selected) : null),
    [selected],
  );

  const [fullscreen, openFs, closeFs] = useFullscreen();

  return (
    <div className={"card" + (fullscreen ? " card-fullscreen" : "")}>
      <div className="card-header">
        <div className="card-toolbar-left">
          <RunSlugDropdown runs={runs} value={slug} onChange={onSelect} />
          {data && (
            <span className="card-title">
              {data.slug}
              {data.strategyName ? ` — ${data.strategyName}` : ""}
            </span>
          )}
        </div>
        <div className="card-toolbar-right">
          {fullscreen && (
            <button type="button" className="card-close" onClick={closeFs}>
              Close ✕
            </button>
          )}
          {data && (
            <button
              type="button"
              className="ratemenu-trigger"
              title="View full screen"
              onClick={openFs}
            >
              ⛶
            </button>
          )}
        </div>
      </div>
      <div className="card-body" style={{ display: "block" }}>
        {data ? (
          <RunDetailChart
            key={selected!.filename}
            data={data}
            fullscreen={fullscreen}
          />
        ) : (
          <div className="rd-empty">
            Select a run from the dropdown above to view its chart.
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Inner chart component (mounts/unmounts cleanly when key changes) ───────
function RunDetailChart({
  data,
  fullscreen,
}: {
  data: RunChartData;
  fullscreen: boolean;
}) {
  const mainRef = useRef<HTMLCanvasElement | null>(null);
  const btcRef = useRef<HTMLCanvasElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const btcTooltipRef = useRef<HTMLDivElement | null>(null);
  const scrollbarRef = useRef<HTMLDivElement | null>(null);
  const scrollbarThumbRef = useRef<HTMLDivElement | null>(null);

  const [activeStatuses, setActiveStatuses] = useState<Set<string>>(
    () => new Set(ALL_STATUSES),
  );
  const activeStatusesRef = useRef(activeStatuses);
  activeStatusesRef.current = activeStatuses;

  // Imperative handles set by the main effect; called by button handlers.
  const applyOrderFilterRef = useRef<() => void>(() => {});
  const zoomInRef = useRef<() => void>(() => {});
  const zoomOutRef = useRef<() => void>(() => {});
  const zoomResetRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!mainRef.current || !btcRef.current) return;

    const tooltip = tooltipRef.current!;
    const btcTooltip = btcTooltipRef.current!;
    const scrollbar = scrollbarRef.current!;
    const scrollbarThumb = scrollbarThumbRef.current!;

    const X_BOUNDS = { min: data.xMin, max: data.xMax };
    const MIN_RANGE = 2;
    const X_REVERSED = true;

    const allOrderData = data.orderData;
    const allOrderColors = data.orderColors;
    const allOrderShapes = data.orderShapes;

    // Crosshair plugin (scoped per Chart instance via _crosshairX).
    const crosshairPlugin = {
      id: "crosshair-" + Math.random(),
      afterDraw(chart: any) {
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
    };

    const mainChart = new Chart(mainRef.current, {
      type: "scatter",
      plugins: [crosshairPlugin],
      data: {
        datasets: [
          {
            label: "UP Ask",
            data: data.upAskData as any,
            type: "line",
            borderColor: "#ef4444",
            backgroundColor: "transparent",
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 0,
            tension: 0.1,
            order: 5,
          },
          {
            label: "UP Bid",
            data: data.upBidData as any,
            type: "line",
            borderColor: "#22c55e",
            backgroundColor: "transparent",
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 0,
            tension: 0.1,
            order: 4,
          },
          {
            label: "DOWN Ask",
            data: data.downAskData as any,
            type: "line",
            borderColor: "#ef4444",
            backgroundColor: "transparent",
            borderWidth: 1.5,
            pointRadius: 0,
            pointHoverRadius: 0,
            tension: 0.1,
            borderDash: [5, 3],
            order: 3,
          },
          {
            label: "DOWN Bid",
            data: data.downBidData as any,
            type: "line",
            borderColor: "#22c55e",
            backgroundColor: "transparent",
            borderWidth: 1.5,
            pointRadius: 0,
            pointHoverRadius: 0,
            tension: 0.1,
            borderDash: [5, 3],
            order: 2,
          },
          {
            label: "Orders",
            data: data.orderData as any,
            backgroundColor: data.orderColors,
            borderColor: data.orderColors,
            borderWidth: 2,
            pointRadius: 8,
            pointHoverRadius: 10,
            pointStyle: data.orderShapes as any,
            // Allow order markers to render past the y-axis edges so triangles/squares
            // at prices near 0.01 or 1.00 aren't cropped by the plot area.
            clip: false,
            order: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "nearest", intersect: false },
        plugins: {
          legend: {
            labels: {
              color: "#94a3b8",
              font: { family: "ui-monospace, monospace", size: 11 },
            },
          },
          tooltip: { enabled: false },
        },
        scales: {
          x: {
            type: "linear",
            min: data.xMin,
            max: data.xMax,
            reverse: true,
            title: {
              display: true,
              text: "Remaining (seconds)",
              color: "#64748b",
            },
            ticks: { color: "#64748b", stepSize: 30 },
            grid: { color: "#334155" },
          },
          y: {
            min: 0.01,
            max: 1.0,
            title: { display: true, text: "Price", color: "#64748b" },
            ticks: { color: "#64748b" },
            grid: { color: "#334155" },
          },
        },
      },
    });

    const assetName = data.assetName;
    const btcChart = new Chart(btcRef.current, {
      type: "scatter",
      plugins: [crosshairPlugin],
      data: {
        datasets: [
          {
            label: `${assetName} Price`,
            data: data.btcLineData as any,
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
            data: data.ptbLineData as any,
            type: "line",
            borderColor: "#f97316",
            backgroundColor: "transparent",
            borderWidth: 1.5,
            borderDash: [6, 4],
            pointRadius: 0,
            pointHoverRadius: 0,
            order: 3,
          },
          ...(data.coinbaseLineData.length
            ? [
                {
                  label: "Coinbase",
                  data: data.coinbaseLineData as any,
                  type: "line" as const,
                  borderColor: "#a78bfa",
                  backgroundColor: "transparent",
                  borderWidth: 1.5,
                  borderDash: [3, 3],
                  pointRadius: 0,
                  pointHoverRadius: 0,
                  order: 4,
                },
              ]
            : []),
          ...(data.binanceLineData.length
            ? [
                {
                  label: "Binance",
                  data: data.binanceLineData as any,
                  type: "line" as const,
                  borderColor: "#fbbf24",
                  backgroundColor: "transparent",
                  borderWidth: 1.5,
                  borderDash: [3, 3],
                  pointRadius: 0,
                  pointHoverRadius: 0,
                  order: 5,
                },
              ]
            : []),
          ...(data.okxLineData.length
            ? [
                {
                  label: "OKX",
                  data: data.okxLineData as any,
                  type: "line" as const,
                  borderColor: "#34d399",
                  backgroundColor: "transparent",
                  borderWidth: 1.5,
                  borderDash: [3, 3],
                  pointRadius: 0,
                  pointHoverRadius: 0,
                  order: 6,
                },
              ]
            : []),
          ...(data.bybitLineData.length
            ? [
                {
                  label: "ByBit",
                  data: data.bybitLineData as any,
                  type: "line" as const,
                  borderColor: "#f472b6",
                  backgroundColor: "transparent",
                  borderWidth: 1.5,
                  borderDash: [3, 3],
                  pointRadius: 0,
                  pointHoverRadius: 0,
                  order: 7,
                },
              ]
            : []),
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "nearest", intersect: false },
        plugins: {
          legend: {
            labels: {
              color: "#94a3b8",
              font: { family: "ui-monospace, monospace", size: 11 },
            },
          },
          tooltip: { enabled: false },
        },
        scales: {
          x: {
            type: "linear",
            min: data.xMin,
            max: data.xMax,
            reverse: true,
            title: {
              display: true,
              text: "Remaining (seconds)",
              color: "#64748b",
            },
            ticks: { color: "#64748b", stepSize: 30 },
            grid: { color: "#334155" },
          },
          y: {
            title: {
              display: true,
              text: `${assetName} Price (USD)`,
              color: "#64748b",
            },
            ticks: { color: "#64748b" },
            grid: { color: "#334155" },
          },
        },
      },
    });

    const allCharts = [mainChart, btcChart];

    // ── status filter (Orders dataset) ────────────────────────────────────
    const applyOrderFilter = () => {
      const ds: any = mainChart.data.datasets.find(
        (d: any) => d.label === "Orders",
      );
      if (!ds) return;
      const active = activeStatusesRef.current;
      const indices = allOrderData
        .map((_, i) => i)
        .filter((i) => active.has(allOrderData[i]!.meta.status));
      ds.data = indices.map((i) => allOrderData[i]);
      ds.backgroundColor = indices.map((i) => allOrderColors[i]);
      ds.borderColor = indices.map((i) => allOrderColors[i]);
      ds.pointStyle = indices.map((i) => allOrderShapes[i]);
      mainChart.update("none");
    };
    applyOrderFilterRef.current = applyOrderFilter;

    // ── shared helpers ─────────────────────────────────────────────────────
    const currentXRange = () => {
      const xs = (mainChart as any).scales.x;
      return { min: xs.min ?? X_BOUNDS.min, max: xs.max ?? X_BOUNDS.max };
    };

    const syncScrollbar = () => {
      const total = X_BOUNDS.max - X_BOUNDS.min;
      if (total <= 0) return;
      const { min, max } = currentXRange();
      const trackW = scrollbar.clientWidth;
      const leftFrac = X_REVERSED
        ? (X_BOUNDS.max - max) / total
        : (min - X_BOUNDS.min) / total;
      const widthFrac = (max - min) / total;
      scrollbarThumb.style.left = leftFrac * trackW + "px";
      scrollbarThumb.style.width = Math.max(20, widthFrac * trackW) + "px";
    };

    const refreshPtbLine = (newMin: number, newMax: number) => {
      if (data.priceToBeat == null || data.ptbStartRemaining == null) return;
      const ptbDs: any = btcChart.data.datasets.find(
        (d: any) => d.label === "Price to Beat",
      );
      if (!ptbDs) return;
      const lo = Math.max(newMin, X_BOUNDS.min);
      const hi = Math.min(newMax, data.ptbStartRemaining);
      ptbDs.data =
        hi > lo
          ? [
              { x: hi, y: data.priceToBeat },
              { x: lo, y: data.priceToBeat },
            ]
          : [];
    };

    const setXRange = (newMin: number, newMax: number) => {
      if (newMin < X_BOUNDS.min) {
        newMax += X_BOUNDS.min - newMin;
        newMin = X_BOUNDS.min;
      }
      if (newMax > X_BOUNDS.max) {
        newMin -= newMax - X_BOUNDS.max;
        newMax = X_BOUNDS.max;
      }
      refreshPtbLine(newMin, newMax);
      for (const ch of allCharts) {
        (ch.options.scales!.x as any).min = newMin;
        (ch.options.scales!.x as any).max = newMax;
        ch.update("none");
      }
      syncScrollbar();
    };

    const applyZoom = (factor: number, focusX?: number) => {
      const { min: curMin, max: curMax } = currentXRange();
      const center = focusX ?? (curMin + curMax) / 2;
      const range = (curMax - curMin) * factor;
      if (range < MIN_RANGE) return;
      if (range > X_BOUNDS.max - X_BOUNDS.min) {
        setXRange(X_BOUNDS.min, X_BOUNDS.max);
        return;
      }
      const ratio = (center - curMin) / (curMax - curMin);
      setXRange(center - range * ratio, center + range * (1 - ratio));
    };

    const applyPan = (deltaXPixels: number) => {
      const xs = (mainChart as any).scales.x;
      const { min: curMin, max: curMax } = currentXRange();
      const pxPerUnit = (xs.right - xs.left) / (curMax - curMin);
      const sign = xs.options.reverse ? 1 : -1;
      const dx = (sign * deltaXPixels) / pxPerUnit;
      setXRange(curMin + dx, curMax + dx);
    };

    zoomInRef.current = () => applyZoom(0.6);
    zoomOutRef.current = () => applyZoom(1 / 0.6);
    zoomResetRef.current = () => setXRange(X_BOUNDS.min, X_BOUNDS.max);

    // ── crosshair / cursor / wheel / drag ─────────────────────────────────
    const nearestIndexAtX = (arr: any[], xVal: number) => {
      if (!arr?.length) return -1;
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < arr.length; i++) {
        const d = Math.abs((arr[i]?.x ?? 0) - xVal);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      return best;
    };

    const hasInteractiveElementAt = (chart: any, e: MouseEvent) => {
      const hits = chart.getElementsAtEventForMode(
        e,
        "point",
        { intersect: true },
        false,
      );
      if (hits.length) return true;
      const rect = chart.canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      for (const ds of chart.data.datasets) {
        if (ds.type !== "line" || !ds.data?.length) continue;
        for (const pt of ds.data) {
          if (pt?.x == null || pt?.y == null) continue;
          const dx = chart.scales.x.getPixelForValue(pt.x) - px;
          const dy = chart.scales.y.getPixelForValue(pt.y) - py;
          if (dx * dx + dy * dy < 64) return true;
        }
      }
      return false;
    };

    // Place a tooltip near (anchorClientX, anchorClientY) in viewport coords,
    // flipping to the left or above when it would otherwise overflow the viewport.
    const placeTooltip = (
      el: HTMLDivElement,
      anchorClientX: number,
      anchorClientY: number,
    ) => {
      const tipW = el.offsetWidth;
      const tipH = el.offsetHeight;
      const margin = 12;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // Horizontal: prefer right of anchor, flip left if it overflows.
      let left = anchorClientX + margin;
      if (left + tipW > vw - 4) left = anchorClientX - tipW - margin;
      if (left < 4) left = 4;

      // Vertical: center on anchor, then clamp inside viewport so the tooltip
      // never gets clipped at the top or bottom edge.
      let top = anchorClientY - tipH / 2;
      if (top < 4) top = 4;
      if (top + tipH > vh - 4) top = Math.max(4, vh - tipH - 4);

      el.style.left = left + "px";
      el.style.top = top + "px";
    };

    const cleanups: Array<() => void> = [];

    const canvases: HTMLCanvasElement[] = [mainRef.current, btcRef.current];
    let panLastX: number | null = null;

    canvases.forEach((canvas) => {
      const onMove = (e: MouseEvent) => {
        const c: any = Chart.getChart(canvas);
        if (!c?.scales?.x) return;
        if (!canvas.classList.contains("rd-panning")) {
          canvas.style.cursor = hasInteractiveElementAt(c, e)
            ? "default"
            : "grab";
        }
        const rect = canvas.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const xVal = c.scales.x.getValueForPixel(px);

        // Update crosshair on both charts.
        for (const ch of allCharts as any[]) {
          ch._crosshairX = xVal;
          ch.update("none");
        }

        // Render BOTH tooltips synced to xVal so the user sees orderbook + asset
        // price simultaneously regardless of which canvas the cursor is on.

        // ── Main chart tooltip (orderbook / orders) ─────────────────────────
        {
          const ORDER_HIT_PX = 22;
          // Order detection is anchored to cursor pixel position — only meaningful
          // when the cursor is actually over the main canvas.
          const onMainCanvas = canvas === mainRef.current;
          const ordersDatasetVisible = mainChart.isDatasetVisible(4);
          const visibleOrders: any[] = [];
          if (ordersDatasetVisible && onMainCanvas) {
            for (const op of allOrderData as any[]) {
              if (activeStatusesRef.current.has(op.meta.status)) {
                visibleOrders.push(op);
              }
            }
          }
          let bestOrder: any = null;
          let bestOrderD2 = ORDER_HIT_PX * ORDER_HIT_PX;
          for (const op of visibleOrders) {
            const dx = mainChart.scales.x.getPixelForValue(op.x) - px;
            const dy = mainChart.scales.y.getPixelForValue(op.y) - py;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestOrderD2) {
              bestOrderD2 = d2;
              bestOrder = op;
            }
          }

          let rows = "";
          let anchorX: number | null = null;
          let anchorY: number | null = null;

          if (bestOrder) {
            const nearby = visibleOrders.filter(
              (p: any) => Math.abs(p.x - bestOrder.x) <= 0.3,
            );
            const ref = nearby[0].meta;
            rows = nearby
              .map((o: any) => {
                const om = o.meta;
                const reason = om.reason ? ` — ${om.reason}` : "";
                return `<b>${om.label}</b> ${om.price ?? ""}${om.shares != null ? " × " + om.shares + " shares" : ""}${reason}<br>`;
              })
              .join("");
            if (ref.remaining != null)
              rows += `<span style="color:#64748b">Remaining: ${ref.remaining}s</span><br>`;
            if (ref.upAsk != null)
              rows += `<span style="color:#64748b">UP Ask: ${ref.upAsk} · Bid: ${ref.upBid}</span><br>`;
            if (ref.downAsk != null)
              rows += `<span style="color:#64748b">DOWN Ask: ${ref.downAsk} · Bid: ${ref.downBid}</span><br>`;
            anchorX = mainChart.scales.x.getPixelForValue(bestOrder.x);
            anchorY = mainChart.scales.y.getPixelForValue(bestOrder.y);
          } else {
            const arr = mainChart.data.datasets[0]?.data;
            const idx = nearestIndexAtX(arr, xVal);
            const m = idx !== -1 ? (arr[idx] as any)?.meta : null;
            if (m) {
              rows = `<b>Orderbook</b>`;
              if (m.remaining != null) rows += `Remaining: ${m.remaining}s<br>`;
              if (m.upAsk != null) rows += `UP Ask: ${m.upAsk}<br>`;
              if (m.upBid != null) rows += `UP Bid: ${m.upBid}<br>`;
              if (m.downAsk != null) rows += `DOWN Ask: ${m.downAsk}<br>`;
              if (m.downBid != null) rows += `DOWN Bid: ${m.downBid}<br>`;
              const pt = arr[idx] as any;
              anchorX = mainChart.scales.x.getPixelForValue(pt.x);
              anchorY = mainChart.scales.y.getPixelForValue(pt.y);
            }
          }

          if (rows && anchorX != null && anchorY != null) {
            const mainRect = mainRef.current!.getBoundingClientRect();
            tooltip.innerHTML = rows;
            tooltip.style.display = "block";
            placeTooltip(tooltip, anchorX + mainRect.left, anchorY + mainRect.top);
          } else {
            tooltip.style.display = "none";
          }
        }

        // ── BTC chart tooltip (asset price + external sources) ──────────────
        {
          const arr = btcChart.data.datasets[0]?.data;
          const idx = nearestIndexAtX(arr, xVal);
          const m = idx !== -1 ? (arr[idx] as any)?.meta : null;
          if (!m) {
            btcTooltip.style.display = "none";
          } else {
            let rows = "";
            if (m.remaining != null)
              rows += `<b>${m.remaining.toFixed(1)}s remaining</b>`;
            if (m.assetPrice != null)
              rows += `${data.assetName}: $${m.assetPrice.toLocaleString()}<br>`;
            if (m.priceToBeat != null)
              rows += `<span style="color:#64748b">Price to Beat: $${m.priceToBeat.toLocaleString()}</span><br>`;
            if (m.coinbasePrice != null)
              rows += `<span style="color:#64748b">Coinbase: $${m.coinbasePrice.toLocaleString()}</span><br>`;
            if (m.binancePrice != null)
              rows += `<span style="color:#64748b">Binance: $${m.binancePrice.toLocaleString()}</span><br>`;
            if (m.okxPrice != null)
              rows += `<span style="color:#64748b">OKX: $${m.okxPrice.toLocaleString()}</span><br>`;
            if (m.bybitPrice != null)
              rows += `<span style="color:#64748b">ByBit: $${m.bybitPrice.toLocaleString()}</span><br>`;
            if (m.gap != null)
              rows += `<span style="color:#64748b">Gap: ${m.gap >= 0 ? "+" : ""}${m.gap.toFixed(2)}</span><br>`;

            const pt = arr[idx] as any;
            const anchorX = btcChart.scales.x.getPixelForValue(pt.x);
            const anchorY = btcChart.scales.y.getPixelForValue(pt.y);
            const btcRect = btcRef.current!.getBoundingClientRect();

            btcTooltip.innerHTML = rows;
            btcTooltip.style.display = "block";
            placeTooltip(btcTooltip, anchorX + btcRect.left, anchorY + btcRect.top);
          }
        }
      };
      const onLeave = () => {
        for (const ch of allCharts as any[]) {
          ch._crosshairX = null;
          ch.update("none");
        }
        tooltip.style.display = "none";
        btcTooltip.style.display = "none";
      };
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const c: any = Chart.getChart(canvas);
        if (!c?.scales?.x) return;
        if (e.shiftKey) {
          applyPan(e.deltaY + e.deltaX);
        } else {
          const xVal = c.scales.x.getValueForPixel(
            e.clientX - canvas.getBoundingClientRect().left,
          );
          applyZoom(e.deltaY < 0 ? 0.85 : 1 / 0.85, xVal);
        }
      };
      const onMouseDown = (e: MouseEvent) => {
        if (e.button !== 0) return;
        panLastX = e.clientX;
        canvas.classList.add("rd-panning");
        canvas.style.cursor = "grabbing";
        e.preventDefault();
      };

      canvas.addEventListener("mousemove", onMove);
      canvas.addEventListener("mouseleave", onLeave);
      canvas.addEventListener("wheel", onWheel, { passive: false });
      canvas.addEventListener("mousedown", onMouseDown);

      cleanups.push(() => {
        canvas.removeEventListener("mousemove", onMove);
        canvas.removeEventListener("mouseleave", onLeave);
        canvas.removeEventListener("wheel", onWheel);
        canvas.removeEventListener("mousedown", onMouseDown);
      });
    });

    const onWindowMove = (e: MouseEvent) => {
      if (panLastX == null) return;
      const dx = e.clientX - panLastX;
      panLastX = e.clientX;
      applyPan(dx);
    };
    const onWindowUp = () => {
      if (panLastX != null) {
        panLastX = null;
        for (const c of canvases) {
          c.classList.remove("rd-panning");
          c.style.cursor = "grab";
        }
      }
      if (sbDragOffset != null) {
        sbDragOffset = null;
        scrollbarThumb.classList.remove("dragging");
      }
    };
    window.addEventListener("mousemove", onWindowMove);
    window.addEventListener("mouseup", onWindowUp);
    cleanups.push(() => {
      window.removeEventListener("mousemove", onWindowMove);
      window.removeEventListener("mouseup", onWindowUp);
    });

    // ── scrollbar ──────────────────────────────────────────────────────────
    let sbDragOffset: number | null = null;
    const scrollbarPosToRange = (thumbLeftPx: number) => {
      const total = X_BOUNDS.max - X_BOUNDS.min;
      const trackW = scrollbar.clientWidth;
      const thumbW = scrollbarThumb.offsetWidth;
      const maxLeft = Math.max(0, trackW - thumbW);
      const clamped = Math.max(0, Math.min(maxLeft, thumbLeftPx));
      const leftFrac = maxLeft > 0 ? clamped / trackW : 0;
      const widthFrac = thumbW / trackW;
      let newMin: number;
      let newMax: number;
      if (X_REVERSED) {
        newMax = X_BOUNDS.max - leftFrac * total;
        newMin = newMax - widthFrac * total;
      } else {
        newMin = X_BOUNDS.min + leftFrac * total;
        newMax = newMin + widthFrac * total;
      }
      setXRange(newMin, newMax);
    };

    const onThumbDown = (e: MouseEvent) => {
      sbDragOffset = e.clientX - scrollbarThumb.getBoundingClientRect().left;
      scrollbarThumb.classList.add("dragging");
      e.preventDefault();
      e.stopPropagation();
    };
    const onSbMove = (e: MouseEvent) => {
      if (sbDragOffset == null) return;
      const trackLeft = scrollbar.getBoundingClientRect().left;
      scrollbarPosToRange(e.clientX - trackLeft - sbDragOffset);
    };
    const onTrackDown = (e: MouseEvent) => {
      if (e.target === scrollbarThumb) return;
      const trackLeft = scrollbar.getBoundingClientRect().left;
      const thumbW = scrollbarThumb.offsetWidth;
      scrollbarPosToRange(e.clientX - trackLeft - thumbW / 2);
    };
    const onResize = () => syncScrollbar();
    scrollbarThumb.addEventListener("mousedown", onThumbDown);
    window.addEventListener("mousemove", onSbMove);
    scrollbar.addEventListener("mousedown", onTrackDown);
    window.addEventListener("resize", onResize);
    cleanups.push(() => {
      scrollbarThumb.removeEventListener("mousedown", onThumbDown);
      window.removeEventListener("mousemove", onSbMove);
      scrollbar.removeEventListener("mousedown", onTrackDown);
      window.removeEventListener("resize", onResize);
    });

    requestAnimationFrame(syncScrollbar);

    return () => {
      for (const fn of cleanups) fn();
      mainChart.destroy();
      btcChart.destroy();
    };
  }, [data]);

  // Re-apply order filter whenever active set changes (without re-creating charts).
  useEffect(() => {
    applyOrderFilterRef.current?.();
  }, [activeStatuses]);

  // Resize charts when fullscreen toggles so they fill new container size.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      Chart.getChart(mainRef.current!)?.resize();
      Chart.getChart(btcRef.current!)?.resize();
      window.dispatchEvent(new Event("resize"));
    });
    return () => cancelAnimationFrame(id);
  }, [fullscreen]);

  const toggleStatus = (status: string) => {
    setActiveStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  return (
    <div className={"rd" + (fullscreen ? " rd-fullscreen" : "")}>
      <div className="rd-toolbar">
        {ALL_STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            className={"rd-toggle" + (activeStatuses.has(s) ? " active" : "")}
            onClick={() => toggleStatus(s)}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
        <div className="rd-zoom-group">
          <button
            type="button"
            className="rd-zoom-btn"
            onClick={() => zoomOutRef.current()}
          >
            −
          </button>
          <button
            type="button"
            className="rd-zoom-btn"
            onClick={() => zoomInRef.current()}
          >
            +
          </button>
          <button
            type="button"
            className="rd-zoom-btn rd-reset"
            onClick={() => zoomResetRef.current()}
          >
            RESET
          </button>
        </div>
      </div>
      <div className="rd-stats">
        <span className="rd-stat-label">BUY filled</span>
        <span className="rd-badge rd-up">UP {data.buyFilledUp}</span>
        <span className="rd-badge rd-down">DOWN {data.buyFilledDown}</span>
        <span className="rd-stat-label">SELL filled</span>
        <span className="rd-badge rd-up">UP {data.sellFilledUp}</span>
        <span className="rd-badge rd-down">DOWN {data.sellFilledDown}</span>
        {(data.pendingUp > 0 || data.pendingDown > 0) && (
          <>
            <span className="rd-stat-label">Pending</span>
            {data.pendingUp > 0 && (
              <span className="rd-badge rd-warn">UP {data.pendingUp}</span>
            )}
            {data.pendingDown > 0 && (
              <span className="rd-badge rd-warn">DOWN {data.pendingDown}</span>
            )}
          </>
        )}
        {data.resolution && (
          <>
            <span className="rd-stat-label">Resolved</span>
            <span className="rd-badge rd-resolved">
              {data.resolution.direction}
            </span>
            <span className="rd-stat-label">PnL</span>
            <span
              className={
                "rd-badge " +
                (data.resolution.pnl >= 0 ? "rd-pnl-pos" : "rd-pnl-neg")
              }
            >
              {data.resolution.pnl >= 0 ? "+" : ""}
              {data.resolution.pnl.toFixed(2)}
            </span>
          </>
        )}
      </div>
      <div className="rd-pane rd-pane-main">
        <canvas ref={mainRef} />
      </div>
      <div className="rd-pane rd-pane-btc">
        <canvas ref={btcRef} />
      </div>
      <div className="rd-scrollbar" ref={scrollbarRef}>
        <div className="rd-scrollbar-thumb" ref={scrollbarThumbRef} />
      </div>
      <div className="rd-tooltip" ref={tooltipRef} />
      <div className="rd-tooltip" ref={btcTooltipRef} />
    </div>
  );
}
