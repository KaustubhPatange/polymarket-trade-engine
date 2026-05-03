import { ASSETS, DURATIONS, useSettings } from "../settings";

type Props = { strategies: string[] };

export function GlobalFilters({ strategies }: Props) {
  const { asset, duration, strategy, setAsset, setDuration, setStrategy } = useSettings();

  return (
    <div className="filters">
      <div className="filter-group">
        <span className="filter-label">Asset</span>
        {ASSETS.map((a) => (
          <button
            key={a}
            type="button"
            className={"filter-chip" + (asset === a ? " active" : "")}
            onClick={() => setAsset(a)}
          >
            {a}
          </button>
        ))}
      </div>
      <div className="filter-group">
        <span className="filter-label">Market</span>
        {DURATIONS.map((d) => (
          <button
            key={d}
            type="button"
            className={"filter-chip" + (duration === d ? " active" : "")}
            onClick={() => setDuration(d)}
          >
            {d}
          </button>
        ))}
      </div>
      {strategies.length > 0 && (
        <div className="filter-group">
          <span className="filter-label">Strategy</span>
          <select
            className="filter-select"
            value={strategy}
            onChange={(e) => setStrategy(e.target.value)}
          >
            <option value="All">All</option>
            {strategies.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
