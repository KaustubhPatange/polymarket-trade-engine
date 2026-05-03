import { useEffect, useMemo, useRef, useState } from "react";
import { Chart, registerables } from "chart.js";
import { BarChartCard } from "./BarChartCard";
import { InfoPanel, type Stat } from "./InfoPanel";
import { binStrategyOutcomes } from "../aggregate";
import { useChartResize } from "../hooks/useChartResize";
import { useSettings } from "../settings";
import type { Bin, ParsedRun, Rate, StrategyBinData } from "../types";

Chart.register(...registerables);

type Props = {
  runs: ParsedRun[];
  rate: Rate;
  onRateChange: (rate: Rate) => void;
};

const fmt$ = (n: number) => `$${n.toFixed(2)}`;
const fmtPnl = (n: number) =>
  n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`;

export function StrategyWinRateChart({ runs, rate, onRateChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<Chart | null>(null);
  const [hoverBin, setHoverBin] = useState<Bin<StrategyBinData> | null>(null);

  useChartResize(chartRef, canvasRef);

  const { tz } = useSettings();
  const bins = useMemo(
    () => binStrategyOutcomes(runs, rate, tz, "All"),
    [runs, rate, tz],
  );

  const aggregate = useMemo(() => {
    let wins = 0;
    let losses = 0;
    let skipped = 0;
    let spend = 0;
    let pnl = 0;
    let winAmount = 0;
    let lossAmount = 0;
    let from = Infinity;
    let to = -Infinity;
    for (const r of runs) {
      if (!r.resolution) continue;
      spend += r.spend;
      pnl += r.resolution.pnl;
      if (r.outcome === "win") {
        wins++;
        winAmount += r.resolution.pnl;
      } else if (r.outcome === "loss") {
        losses++;
        lossAmount += Math.abs(r.resolution.pnl);
      } else {
        skipped++;
      }
      if (r.startTime < from) from = r.startTime;
      if (r.startTime > to) to = r.startTime;
    }
    return {
      trades: wins + losses,
      wins,
      losses,
      skipped,
      spend,
      pnl,
      winAmount,
      lossAmount,
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
            label: "Wins",
            data: bins.map((b) => b.data.wins),
            backgroundColor: "#22c55e",
            stack: "s",
          },
          {
            label: "Losses",
            data: bins.map((b) => b.data.losses),
            backgroundColor: "#ef4444",
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
            title: { display: true, text: "# runs", color: "#64748b" },
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
        trades: hoverBin.data.wins + hoverBin.data.losses,
        wins: hoverBin.data.wins,
        losses: hoverBin.data.losses,
        spend: hoverBin.data.spend,
        pnl: hoverBin.data.pnl,
        winAmount: hoverBin.data.winAmount,
        lossAmount: hoverBin.data.lossAmount,
        from: hoverBin.startMs,
        to: hoverBin.endMs - 1,
        scoped: true as const,
      }
    : { ...aggregate, scoped: false as const };

  const stats: Stat[] = [
    { label: "Total Trades", value: display.trades },
    { label: "Total Wins", value: display.wins, badgeClass: "win" },
    { label: "Total Loss", value: display.losses, badgeClass: "loss" },
    { label: "Total Spend", value: fmt$(display.spend) },
    {
      label: "Profit",
      value: fmtPnl(display.pnl),
      badgeClass: display.pnl >= 0 ? "win" : "loss",
    },
    { label: "Win Amount", value: fmt$(display.winAmount), badgeClass: "win" },
    { label: "Loss Amount", value: fmt$(display.lossAmount), badgeClass: "loss" },
  ];

  return (
    <BarChartCard
      title={<span className="card-title">STRATEGY WIN RATE</span>}
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
            !display.scoped && aggregate.skipped > 0
              ? `+${aggregate.skipped} skipped (pnl == 0)`
              : undefined
          }
        />
      }
    />
  );
}
