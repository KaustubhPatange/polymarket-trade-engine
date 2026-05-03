import { formatDateTime, useSettings } from "../settings";
import type { ParsedRun } from "../types";

type Props = {
  runs: ParsedRun[];
  value: string | null;
  onChange: (slug: string | null) => void;
};

const fmtPnl = (n: number) =>
  n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`;

// Pull the trailing unix-seconds suffix out of slugs like `btc-updown-5m-1777699500`.
// Falls back to the run's startTime (ms → s) when no suffix is present.
function slugUnixSec(run: ParsedRun): number {
  const m = run.slug.match(/(\d{10})$/);
  if (m) return Number(m[1]);
  return Math.floor(run.startTime / 1000);
}

export function RunSlugDropdown({ runs, value, onChange }: Props) {
  const { tz } = useSettings();
  const sorted = runs
    .filter((r) => r.resolution)
    .map((r) => ({ run: r, ts: slugUnixSec(r) }))
    .sort((a, b) => b.ts - a.ts);

  return (
    <select
      className="dropdown dropdown-wide"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">Select Strategy Run…</option>
      {sorted.map(({ run: r, ts }) => {
        const tag = r.outcome === "win" ? "WIN" : r.outcome === "loss" ? "LOSS" : "—";
        return (
          <option key={r.filename} value={r.filename}>
            {formatDateTime(ts * 1000, tz)} — {tag} {fmtPnl(r.resolution!.pnl)}
            {r.strategy ? ` · ${r.strategy}` : ""}
          </option>
        );
      })}
    </select>
  );
}
