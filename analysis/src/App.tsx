import { useMemo, useState } from "react";
import { useLogs } from "./hooks/useLogs";
import { MarketRunsChart } from "./components/MarketRunsChart";
import { StrategyWinRateChart } from "./components/StrategyWinRateChart";
import { RunDetail } from "./components/RunDetail";
import { SettingsButton } from "./components/SettingsButton";
import { GlobalFilters } from "./components/GlobalFilters";
import { SettingsProvider, useSettings } from "./settings";
import { uniqueStrategies } from "./aggregate";
import { parseSlugInfo } from "./parse";
import type { Rate } from "./types";

function AppInner() {
  const allRuns = useLogs();
  const { asset, duration, strategy } = useSettings();
  const [topRate, setTopRate] = useState<Rate>("day");
  const [midRate, setMidRate] = useState<Rate>("day");
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);

  const runs = useMemo(
    () =>
      allRuns.filter((r) => {
        const info = parseSlugInfo(r.slug);
        return info.asset === asset && info.duration === duration;
      }),
    [allRuns, asset, duration],
  );

  const strategies = useMemo(() => uniqueStrategies(runs), [runs]);

  const filteredRuns = useMemo(
    () =>
      strategy === "All"
        ? runs
        : runs.filter((r) => r.strategy === strategy),
    [runs, strategy],
  );

  return (
    <div className="app">
      <div className="app-header">
        <div className="app-header-left">
          <h1 className="app-title">Run Analysis</h1>
          <GlobalFilters strategies={strategies} />
        </div>
        <SettingsButton />
      </div>
      <MarketRunsChart runs={filteredRuns} rate={topRate} onRateChange={setTopRate} />
      <StrategyWinRateChart
        runs={filteredRuns}
        rate={midRate}
        onRateChange={setMidRate}
      />
      <RunDetail runs={filteredRuns} slug={selectedSlug} onSelect={setSelectedSlug} />
    </div>
  );
}

export function App() {
  return (
    <SettingsProvider>
      <AppInner />
    </SettingsProvider>
  );
}
