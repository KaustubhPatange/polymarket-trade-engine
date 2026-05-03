import type { LogEntry, ParsedRun, Resolution, Outcome, SlugInfo } from "./types";

// Slug shape: `<asset>-updown-<duration>-<unixSec>` (e.g. `btc-updown-5m-1777699500`).
// Returns nulls for slugs that don't match this convention.
export function parseSlugInfo(slug: string): SlugInfo {
  const parts = slug.split("-");
  return {
    asset: parts[0] ? parts[0].toUpperCase() : null,
    duration: parts[2] ?? null,
  };
}

// Parse all top-level JSON objects from a log file. Handles both single-line
// and pretty-printed multi-line entries (depth-tracking brace scan).
export function parseAllJson(text: string): LogEntry[] {
  const results: LogEntry[] = [];
  let depth = 0;
  let start = -1;
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

function deriveOutcome(resolution: Resolution | null): Outcome {
  if (!resolution) return "incomplete";
  if (resolution.pnl > 0) return "win";
  if (resolution.pnl < 0) return "loss";
  return "skip";
}

export function parseLog(filename: string, raw: string): ParsedRun | null {
  const entries = parseAllJson(raw);
  if (!entries.length) return null;

  const slot = entries.find((e) => e.type === "slot" && e.action === "start");
  if (!slot) return null;

  const slug: string = slot.slug ?? filename.replace(/^early-bird-/, "").replace(/\.log$/, "");
  const strategy: string | null = slot.strategy ?? null;
  const startTime: number = slot.startTime ?? slot.ts ?? 0;
  const endTime: number = slot.endTime ?? 0;

  const resolutionEntry = entries.find((e) => e.type === "resolution");
  const resolution: Resolution | null = resolutionEntry
    ? {
        direction: resolutionEntry.direction,
        openPrice: resolutionEntry.openPrice,
        closePrice: resolutionEntry.closePrice,
        unfilledShares: resolutionEntry.unfilledShares,
        payout: resolutionEntry.payout,
        pnl: resolutionEntry.pnl,
      }
    : null;

  // Spend = Σ (price × shares) over filled buy orders.
  let spend = 0;
  for (const e of entries) {
    if (
      e.type === "order" &&
      e.action === "buy" &&
      e.status === "filled" &&
      typeof e.price === "number" &&
      typeof e.shares === "number"
    ) {
      spend += e.price * e.shares;
    }
  }

  return {
    filename,
    slug,
    strategy,
    startTime,
    endTime,
    resolution,
    spend,
    outcome: deriveOutcome(resolution),
    raw: entries,
  };
}
