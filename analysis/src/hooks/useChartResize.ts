import { useEffect, type RefObject } from "react";
import type { Chart } from "chart.js";

// Observe the canvas's parent box and force a Chart.js resize whenever it
// changes — covers the cases where Chart.js's built-in responsive listener
// misses layout shifts (grid cell reflow, fullscreen toggle, etc.).
export function useChartResize(
  chartRef: RefObject<Chart | null>,
  canvasRef: RefObject<HTMLCanvasElement | null>,
) {
  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;

    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        chartRef.current?.resize();
      });
    });
    ro.observe(parent);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [chartRef, canvasRef]);
}
