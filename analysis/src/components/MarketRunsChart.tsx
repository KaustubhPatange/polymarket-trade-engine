import { useEffect, useMemo, useRef, useState } from "react";
import { Chart, registerables } from "chart.js";
import { BarChartCard } from "./BarChartCard";
import { InfoPanel, type Stat } from "./InfoPanel";
import { binMarketRuns } from "../aggregate";
import { useChartResize } from "../hooks/useChartResize";
import { useSettings } from "../settings";
import type { Bin, MarketBinData, ParsedRun, Rate } from "../types";

Chart.register(...registerables);

type Props = {
  runs: ParsedRun[];
  rate: Rate;
  onRateChange: (rate: Rate) => void;
};

export function MarketRunsChart({ runs, rate, onRateChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<Chart | null>(null);
  const [hoverBin, setHoverBin] = useState<Bin<MarketBinData> | null>(null);

  useChartResize(chartRef, canvasRef);

  const { tz } = useSettings();
  const bins = useMemo(() => binMarketRuns(runs, rate, tz), [runs, rate, tz]);

  const aggregate = useMemo(() => {
    let up = 0;
    let down = 0;
    let from = Infinity;
    let to = -Infinity;
    for (const r of runs) {
      if (!r.resolution) continue;
      if (r.resolution.direction === "UP") up++;
      else down++;
      if (r.startTime < from) from = r.startTime;
      if (r.startTime > to) to = r.startTime;
    }
    const incomplete = runs.filter((r) => !r.resolution).length;
    return {
      total: up + down,
      up,
      down,
      incomplete,
      from: Number.isFinite(from) ? from : undefined,
      to: Number.isFinite(to) ? to : undefined,
    };
  }, [runs]);

  useEffect(() => {
    if (!canvasRef.current) return;
    chartRef.current?.destroy();
    chartRef.current = new Chart(canvasRef.current, {
      type: "bar",
      data: {
        labels: bins.map((b) => b.label),
        datasets: [
          {
            label: "UP",
            data: bins.map((b) => b.data.up),
            backgroundColor: "#22c55e",
            stack: "s",
          },
          {
            label: "DOWN",
            data: bins.map((b) => b.data.down),
            backgroundColor: "#3b82f6",
            stack: "s",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "index", intersect: false },
        onHover: (_evt, elements) => {
          const idx = elements[0]?.index;
          setHoverBin(idx != null ? bins[idx] ?? null : null);
        },
        plugins: {
          legend: { labels: { color: "#94a3b8", font: { size: 11 } } },
          tooltip: {
            backgroundColor: "#0f172a",
            borderColor: "#334155",
            borderWidth: 1,
            titleColor: "#94a3b8",
            bodyColor: "#cbd5e1",
          },
        },
        scales: {
          x: {
            stacked: true,
            ticks: { color: "#64748b", maxRotation: 0, autoSkip: true },
            grid: { color: "#1e293b" },
          },
          y: {
            stacked: true,
            beginAtZero: true,
            ticks: { color: "#64748b", precision: 0 },
            grid: { color: "#334155" },
            title: { display: true, text: "# market runs", color: "#64748b" },
          },
        },
      },
    });
    const canvas = canvasRef.current;
    const onLeave = () => setHoverBin(null);
    canvas.addEventListener("mouseleave", onLeave);
    return () => {
      canvas.removeEventListener("mouseleave", onLeave);
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [bins]);

  const display = hoverBin
    ? {
        total: hoverBin.data.up + hoverBin.data.down,
        up: hoverBin.data.up,
        down: hoverBin.data.down,
        from: hoverBin.startMs,
        to: hoverBin.endMs - 1,
        scoped: true as const,
      }
    : { ...aggregate, scoped: false as const };

  const stats: Stat[] = [
    { label: "Total Runs", value: display.total },
    { label: "Total Up", value: display.up, badgeClass: "up" },
    { label: "Total Down", value: display.down, badgeClass: "down" },
  ];

  return (
    <BarChartCard
      title={<span className="card-title">MARKET RUNS · UP vs DOWN</span>}
      rate={rate}
      onRateChange={onRateChange}
      chart={<canvas ref={canvasRef} />}
      side={
        <InfoPanel
          title={display.scoped ? "BIN" : "ALL TIME"}
          stats={stats}
          fromMs={display.from}
          toMs={display.to}
          footer={
            !display.scoped && aggregate.incomplete > 0
              ? `+${aggregate.incomplete} incomplete (no resolution)`
              : undefined
          }
        />
      }
    />
  );
}
