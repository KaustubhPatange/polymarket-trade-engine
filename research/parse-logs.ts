// Phase 2.1 — NDJSON market-log parser.
//
// Reads every per-market log under logs/ (files named early-bird-<slug>.log
// where <slug> contains "-updown-") and flattens each ~1s snapshot group
// (orderbook_snapshot + remaining + ticker + market_price) into one CSV row,
// labeled with the market's final resolution. Slugs without a resolution
// entry (crashed mid-slot, still running) are skipped and counted.
//
// Usage: bun research/parse-logs.ts [--logs logs] [--out research/dataset.csv]

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

type Row = {
  slug: string;
  timestampMs: number;
  secondsRemaining: number | null;
  spotPrice: number | null;
  binancePrice: number | null;
  coinbasePrice: number | null;
  okxPrice: number | null;
  bybitPrice: number | null;
  divergence: number | null;
  priceToBeat: number | null;
  gap: number | null;
  gapPct: number | null;
  upAsk: number | null;
  upBid: number | null;
  downAsk: number | null;
  downBid: number | null;
  upAskLiquidity: number | null;
  upBidLiquidity: number | null;
  downAskLiquidity: number | null;
  downBidLiquidity: number | null;
  spread: number | null;
  vol60: number | null;
  resolvedDirection: "UP" | "DOWN" | null;
  outcomeUp: 0 | 1 | null;
};

const COLUMNS: (keyof Row)[] = [
  "slug",
  "timestampMs",
  "secondsRemaining",
  "spotPrice",
  "binancePrice",
  "coinbasePrice",
  "okxPrice",
  "bybitPrice",
  "divergence",
  "priceToBeat",
  "gap",
  "gapPct",
  "upAsk",
  "upBid",
  "downAsk",
  "downBid",
  "upAskLiquidity",
  "upBidLiquidity",
  "downAskLiquidity",
  "downBidLiquidity",
  "spread",
  "vol60",
  "resolvedDirection",
  "outcomeUp",
];

type BookSide = { bids: [number, number][]; asks: [number, number][] };

/** Best level as { price, usdLiquidity } matching OrderBook.bestAskInfo semantics. */
function best(levels: [number, number][] | undefined): {
  price: number | null;
  liquidity: number | null;
} {
  const lvl = levels?.[0];
  if (!lvl) return { price: null, liquidity: null };
  const [price, size] = lvl;
  return { price, liquidity: price * size };
}

function parseFile(path: string): { rows: Row[]; resolved: boolean } {
  const lines = readFileSync(path, "utf8").split("\n");

  const rows: Row[] = [];
  let current: Row | null = null;
  let resolution: { direction: "UP" | "DOWN" } | null = null;

  // rolling 60s spot window for vol60
  let spotWindow: { ts: number; spot: number }[] = [];

  const flush = () => {
    if (current) rows.push(current);
    current = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: any;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // tolerate torn writes from crashes
    }

    switch (entry.type) {
      case "slot":
        flush();
        if (entry.action === "start") spotWindow = [];
        break;

      case "orderbook_snapshot": {
        flush();
        const up: BookSide | null = entry.up ?? null;
        const down: BookSide | null = entry.down ?? null;
        const upAsk = best(up?.asks);
        const upBid = best(up?.bids);
        const downAsk = best(down?.asks);
        const downBid = best(down?.bids);
        current = {
          slug: "", // filled from filename by caller
          timestampMs: entry.ts,
          secondsRemaining: null,
          spotPrice: null,
          binancePrice: null,
          coinbasePrice: null,
          okxPrice: null,
          bybitPrice: null,
          divergence: null,
          priceToBeat: null,
          gap: null,
          gapPct: null,
          upAsk: upAsk.price,
          upBid: upBid.price,
          downAsk: downAsk.price,
          downBid: downBid.price,
          upAskLiquidity: upAsk.liquidity,
          upBidLiquidity: upBid.liquidity,
          downAskLiquidity: downAsk.liquidity,
          downBidLiquidity: downBid.liquidity,
          spread:
            upAsk.price !== null && upBid.price !== null
              ? parseFloat((upAsk.price - upBid.price).toFixed(4))
              : null,
          vol60: null,
          resolvedDirection: null,
          outcomeUp: null,
        };
        break;
      }

      case "remaining":
        if (current) current.secondsRemaining = entry.seconds;
        break;

      case "ticker": {
        if (!current) break;
        current.spotPrice = entry.assetPrice ?? null;
        current.binancePrice = entry.binancePrice ?? null;
        current.coinbasePrice = entry.coinbasePrice ?? null;
        current.okxPrice = entry.okxPrice ?? null;
        current.bybitPrice = entry.bybitPrice ?? null;
        current.divergence = entry.divergence ?? null;
        if (current.spotPrice !== null) {
          spotWindow.push({ ts: current.timestampMs, spot: current.spotPrice });
          const cutoff = current.timestampMs - 60_000;
          while (spotWindow.length > 0 && spotWindow[0]!.ts < cutoff) {
            spotWindow.shift();
          }
          if (spotWindow.length >= 10) {
            const n = spotWindow.length;
            const mean = spotWindow.reduce((s, p) => s + p.spot, 0) / n;
            const variance =
              spotWindow.reduce((s, p) => s + (p.spot - mean) ** 2, 0) / n;
            current.vol60 = parseFloat(Math.sqrt(variance).toFixed(4));
          }
        }
        break;
      }

      case "market_price": {
        if (!current) break;
        const open = entry.priceToBeat ?? entry.openPrice ?? null;
        current.priceToBeat = open;
        if (open !== null && current.spotPrice !== null) {
          current.gap = parseFloat((current.spotPrice - open).toFixed(4));
          current.gapPct = parseFloat((current.gap / open).toFixed(8));
        }
        break;
      }

      case "resolution":
        resolution = { direction: entry.direction };
        break;
    }
  }
  flush();

  if (!resolution) return { rows: [], resolved: false };

  const outcomeUp: 0 | 1 = resolution.direction === "UP" ? 1 : 0;
  for (const row of rows) {
    row.resolvedDirection = resolution.direction;
    row.outcomeUp = outcomeUp;
  }
  return { rows, resolved: true };
}

function toCsvValue(v: string | number | null): string {
  if (v === null) return "";
  return String(v);
}

function main() {
  const args = process.argv.slice(2);
  const getArg = (name: string, fallback: string) => {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] ? args[i + 1]! : fallback;
  };
  const logsDir = getArg("--logs", "logs");
  const outPath = getArg("--out", join("research", "dataset.csv"));

  const files = readdirSync(logsDir)
    .filter((f) => f.startsWith("early-bird-") && f.includes("-updown-") && f.endsWith(".log"))
    .sort();

  if (files.length === 0) {
    console.error(`No market log files found in ${logsDir}/`);
    process.exit(1);
  }

  const allRows: Row[] = [];
  let resolvedFiles = 0;
  let unresolvedFiles = 0;

  for (const file of files) {
    const slug = file.replace(/^early-bird-/, "").replace(/\.log$/, "");
    const { rows, resolved } = parseFile(join(logsDir, file));
    if (!resolved) {
      unresolvedFiles++;
      continue;
    }
    resolvedFiles++;
    for (const row of rows) row.slug = slug;
    allRows.push(...rows);
  }

  // Chronological order — required for the time-based train/test split later.
  allRows.sort((a, b) => a.timestampMs - b.timestampMs);

  const header = COLUMNS.join(",");
  const body = allRows
    .map((row) => COLUMNS.map((c) => toCsvValue(row[c])).join(","))
    .join("\n");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, header + "\n" + body + "\n");

  const inWindow = allRows.filter(
    (r) => r.secondsRemaining !== null && r.secondsRemaining <= 300,
  ).length;
  console.log(
    `Parsed ${files.length} files: ${resolvedFiles} resolved, ${unresolvedFiles} without resolution (skipped).`,
  );
  console.log(
    `Wrote ${allRows.length} rows (${inWindow} inside the market window) to ${outPath}`,
  );
}

main();
