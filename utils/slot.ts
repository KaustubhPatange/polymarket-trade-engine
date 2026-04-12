import { Env, type MarketWindow } from "./config.ts";

const INTERVAL_MAP: Record<MarketWindow, number> = {
  "5m": 300,
  "15m": 900,
};

function getInterval(): number {
  const window = Env.get("MARKET_WINDOW");
  const interval = INTERVAL_MAP[window];
  if (!interval) {
    throw new Error(
      `Invalid MARKET_WINDOW "${window}". Must be one of: ${Object.keys(INTERVAL_MAP).join(", ")}`,
    );
  }
  return interval;
}

const BASE_TIMESTAMP = 1772568900;

let _nowOffsetMs = 0;

/**
 * Shift the "virtual now" used by all slot calculations.
 * --market +N  → N slots ahead of current
 * --market <ts> → align to that slot's start timestamp (seconds)
 */
export function setMarketOffset(arg: string) {
  const interval = getInterval();
  if (arg.startsWith("+") || arg.startsWith("-")) {
    _nowOffsetMs = parseInt(arg) * interval * 1000;
  } else {
    const targetSec = parseInt(arg);
    const slotStart =
      BASE_TIMESTAMP +
      Math.floor((targetSec - BASE_TIMESTAMP) / interval) * interval;
    _nowOffsetMs = slotStart * 1000 - Date.now();
  }
}

/** offset: 0 = current slot, -1 = previous, 1 = next, etc. */
export function getSlotTS(offset = 0): { startTime: number; endTime: number } {
  const interval = getInterval();
  const nowSec = Math.floor((Date.now() + _nowOffsetMs) / 1000);
  const slotTs =
    BASE_TIMESTAMP +
    Math.floor((nowSec - BASE_TIMESTAMP) / interval) * interval +
    offset * interval;
  return {
    startTime: slotTs * 1000,
    endTime: (slotTs + interval) * 1000,
  };
}
export type Slot = ReturnType<typeof getSlotTS>;

/** offset: 0 = current slot, -1 = previous, 1 = next, etc. */
export function getSlug(offset = 0) {
  const window = Env.get("MARKET_WINDOW");
  const ts = getSlotTS(offset).startTime / 1000;
  return `btc-updown-${window}-${ts}`;
}

/**
 * Extract the Slot (startTime/endTime in ms) from a slug string.
 * Parses the interval from the slug itself (e.g. "5m" or "15m") so
 * recovery works correctly regardless of the current MARKET_WINDOW config.
 */
export function slotFromSlug(slug: string): Slot {
  const parts = slug.split("-");
  const ts = parseInt(parts.at(-1)!);
  const windowLabel = parts.at(-2)! as MarketWindow;
  const interval = INTERVAL_MAP[windowLabel] ?? getInterval();
  return { startTime: ts * 1000, endTime: (ts + interval) * 1000 };
}
