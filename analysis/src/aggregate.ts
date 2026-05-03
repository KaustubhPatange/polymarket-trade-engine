import { getZonedParts, type Tz } from "./settings";
import type {
  Bin,
  MarketBinData,
  ParsedRun,
  Rate,
  StrategyBinData,
} from "./types";

const pad = (n: number) => String(n).padStart(2, "0");

export function binKeyFor(ms: number, rate: Rate, tz: Tz): string {
  const { y, mo, d, h } = getZonedParts(ms, tz);
  const base = `${y}-${pad(mo + 1)}-${pad(d)}`;
  return rate === "hour" ? `${base}-${pad(h)}` : base;
}

function labelFor(key: string, rate: Rate): string {
  const [y = "", m = "", d = "", h = ""] = key.split("-");
  return rate === "hour" ? `${m}-${d} ${h}:00` : `${y.slice(2)}-${m}-${d}`;
}

// Walk the time range in fixed-size steps and collect every bin key encountered,
// so the x-axis fills in empty bins between first and last run. Step size is a
// little less than a full bin to handle DST seams safely.
function fillRange(
  firstMs: number,
  lastMs: number,
  rate: Rate,
  tz: Tz,
): string[] {
  if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs)) return [];
  const step = rate === "hour" ? 30 * 60_000 : 12 * 3_600_000; // 30m or 12h
  const seen = new Set<string>();
  for (let t = firstMs; t <= lastMs + step; t += step) {
    seen.add(binKeyFor(t, rate, tz));
  }
  return [...seen].sort();
}

function rangeFromRuns(runs: ParsedRun[]): { from: number; to: number } {
  let from = Infinity;
  let to = -Infinity;
  for (const r of runs) {
    if (!r.resolution) continue;
    if (r.startTime < from) from = r.startTime;
    if (r.startTime > to) to = r.startTime;
  }
  return { from, to };
}

// For info-panel display we want a meaningful "from / to" range for the bin.
// Walk outward from a known-in-bin timestamp at coarse steps; cheap and correct
// across DST transitions.
function binBoundsForKey(
  key: string,
  rate: Rate,
  tz: Tz,
  hint: number,
): { startMs: number; endMs: number } {
  const step = rate === "hour" ? 60_000 : 30 * 60_000; // 1m / 30m
  const limit = rate === "hour" ? 70 : 60; // ~70m or 30h max walk

  let lo = hint;
  for (let i = 1; i <= limit; i++) {
    const t = hint - i * step;
    if (binKeyFor(t, rate, tz) !== key) break;
    lo = t;
  }
  let hi = hint;
  for (let i = 1; i <= limit; i++) {
    const t = hint + i * step;
    if (binKeyFor(t, rate, tz) !== key) break;
    hi = t;
  }
  return { startMs: lo, endMs: hi };
}

export function binMarketRuns(
  runs: ParsedRun[],
  rate: Rate,
  tz: Tz,
): Bin<MarketBinData>[] {
  const groups = new Map<string, ParsedRun[]>();
  const hintByKey = new Map<string, number>();

  for (const r of runs) {
    if (!r.resolution) continue;
    const k = binKeyFor(r.startTime, rate, tz);
    let arr = groups.get(k);
    if (!arr) groups.set(k, (arr = []));
    arr.push(r);
    if (!hintByKey.has(k)) hintByKey.set(k, r.startTime);
  }

  const { from, to } = rangeFromRuns(runs);
  const allKeys = fillRange(from, to, rate, tz);

  return allKeys.map((key) => {
    const list = groups.get(key) ?? [];
    let up = 0;
    let down = 0;
    for (const r of list) {
      if (r.resolution!.direction === "UP") up++;
      else down++;
    }
    const hint = hintByKey.get(key) ?? from;
    const { startMs, endMs } = binBoundsForKey(key, rate, tz, hint);
    return {
      key,
      label: labelFor(key, rate),
      startMs,
      endMs,
      data: { up, down, runs: list },
    };
  });
}

export function binStrategyOutcomes(
  runs: ParsedRun[],
  rate: Rate,
  tz: Tz,
  strategy: string | "All",
): Bin<StrategyBinData>[] {
  const filtered = runs.filter(
    (r) =>
      r.resolution &&
      (strategy === "All" || r.strategy === strategy) &&
      r.outcome !== "incomplete",
  );

  const groups = new Map<string, ParsedRun[]>();
  const hintByKey = new Map<string, number>();
  for (const r of filtered) {
    const k = binKeyFor(r.startTime, rate, tz);
    let arr = groups.get(k);
    if (!arr) groups.set(k, (arr = []));
    arr.push(r);
    if (!hintByKey.has(k)) hintByKey.set(k, r.startTime);
  }

  const { from, to } = rangeFromRuns(filtered);
  const allKeys = fillRange(from, to, rate, tz);

  return allKeys.map((key) => {
    const list = groups.get(key) ?? [];
    let wins = 0;
    let losses = 0;
    let skipped = 0;
    let spend = 0;
    let pnl = 0;
    let winAmount = 0;
    let lossAmount = 0;
    for (const r of list) {
      spend += r.spend;
      pnl += r.resolution!.pnl;
      if (r.outcome === "win") {
        wins++;
        winAmount += r.resolution!.pnl;
      } else if (r.outcome === "loss") {
        losses++;
        lossAmount += Math.abs(r.resolution!.pnl);
      } else {
        skipped++;
      }
    }
    const hint = hintByKey.get(key) ?? from;
    const { startMs, endMs } = binBoundsForKey(key, rate, tz, hint);
    return {
      key,
      label: labelFor(key, rate),
      startMs,
      endMs,
      data: {
        wins,
        losses,
        skipped,
        spend,
        pnl,
        winAmount,
        lossAmount,
        runs: list,
      },
    };
  });
}

export function uniqueStrategies(runs: ParsedRun[]): string[] {
  const set = new Set<string>();
  for (const r of runs) if (r.strategy) set.add(r.strategy);
  return [...set].sort();
}

export function dateRange(runs: ParsedRun[]): { from: number; to: number } | null {
  if (!runs.length) return null;
  let from = Infinity;
  let to = -Infinity;
  for (const r of runs) {
    if (r.startTime < from) from = r.startTime;
    if (r.startTime > to) to = r.startTime;
  }
  return { from, to };
}
