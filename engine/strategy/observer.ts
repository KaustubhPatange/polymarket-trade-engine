// Observer strategy — data collection only, places NO orders. Ever.
//
// Purpose: keep the lifecycle alive for the entire market window so the
// engine's Logger keeps writing its 1-second NDJSON snapshots
// (orderbook_snapshot / remaining / ticker / market_price), and so the
// lifecycle reaches the post-slot-end STOPPING branch that waits for
// resolution — that is what writes the `resolution` entry (the outcome
// label) to the log. Run with --always-log so rounds without orders are
// still written to disk.

import type { Strategy } from "./types.ts";
import { Env } from "../../utils/config.ts";

const TICK_MS = 500;
const STATUS_LOG_EVERY_MS = 60_000;

export const observer: Strategy = async (ctx) => {
  // ── Prod guard ────────────────────────────────────────────────────────────
  // This strategy never trades, but there is no reason to ever run it against
  // the real CLOB either. Do not remove this guard.
  if (Env.get("PROD")) {
    ctx.log("[observer] This strategy is for simulation/observation only.", "red");
    process.exit(1);
  }

  // Hard guarantee: even a bug in this file cannot place an order.
  ctx.blockBuys();
  ctx.blockSells();

  // Keep the lifecycle in RUNNING for the whole window. Released exactly once,
  // and never before slotEndMs — releasing early would let the lifecycle enter
  // STOPPING with time still remaining, which skips the resolution wait and
  // leaves the log without a `resolution` entry.
  const release = ctx.hold();

  const state = { destroyed: false, released: false };

  const releaseOnce = () => {
    if (state.released) return;
    state.released = true;
    release();
  };

  let lastStatusMs = 0;

  const tick = setInterval(() => {
    if (state.destroyed) return;

    const now = Date.now();
    if (now >= ctx.slotEndMs) {
      // Slot is over — the engine transitions to STOPPING on its own and
      // waits for resolution. Our hold is no longer needed.
      clearInterval(tick);
      releaseOnce();
      return;
    }

    // Periodic operator heartbeat (console log only — the NDJSON data log is
    // written automatically by the engine's Logger every second).
    if (now - lastStatusMs >= STATUS_LOG_EVERY_MS) {
      lastStatusMs = now;
      const remaining = Math.floor((ctx.slotEndMs - now) / 1000);
      const spot = ctx.ticker.price;
      const open = ctx.getMarketResult()?.openPrice;
      const gap =
        spot !== undefined && open !== undefined
          ? (spot - open).toFixed(2)
          : "n/a";
      const upAsk = ctx.orderBook.bestAskInfo("UP")?.price ?? "n/a";
      const downAsk = ctx.orderBook.bestAskInfo("DOWN")?.price ?? "n/a";
      ctx.log(
        `[observer] ${remaining}s left | gap ${gap} | upAsk ${upAsk} | downAsk ${downAsk}`,
        "dim",
      );
    }
  }, TICK_MS);

  return () => {
    state.destroyed = true;
    clearInterval(tick);
    // Cleanup runs when the lifecycle is being torn down (STOPPING/destroy),
    // i.e. never before slot end — safe to release here as a fallback.
    releaseOnce();
  };
};
