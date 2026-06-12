import type { Strategy } from "./types.ts";
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const SIGNAL_PATH = join(import.meta.dir, "../../../signal.json");
const TRADE_LOG_PATH = join(import.meta.dir, "../../logs/trades.csv");
const TRADE_LOG_HEADER = "timestamp,window,direction,entry_price,exit_price,shares,pnl,exit_reason,score,confidence,duration_s\n";
const SCORE_THRESHOLD = 0.55;   // 0.45 flooded us with marginal coin-flips that got whipsawed
const CONFIDENCE_THRESHOLD = 0.62;
const REPRICE_TARGET = 0.20;
const MAX_BUY_PRICE = 0.65;
const MIN_BUY_PRICE = 0.30;        // skip if crowd is >70% bearish
const SIGNAL_MAX_AGE_MS = 30_000;
const POLL_INTERVAL_MS = 10_000;
const MIN_REMAINING_MS = 90_000;
const MIN_GAP_USD = -75;           // skip BUY_UP if BTC is more than $75 below strike
const HOLD_GAP_THRESHOLD = 150;    // hold to resolution instead of selling when gap >= $150
const BAIL_OUT_GAP = 30;           // bail out of hold-to-resolution if gap drops below $30
const LATE_HOLD_PRICE = 0.90;      // switch to hold-to-resolution if bid >= this with <60s left
const PARTIAL_SELL_RATIO = 1.0;    // sell everything at target — no resolution gamble
const REQUIRED_CONSECUTIVE = 2;    // require 2 back-to-back qualifying signals before entry
const MAX_BID_SWING = 0.08;        // skip if book swung this much across last 4 polls
const BID_HISTORY_SIZE = 4;

// Sniper constants — last-minute "already decided" entries
const SNIPER_THRESHOLD = 0.95;     // enter when a side's bid is at or above this
const SNIPER_MAX_ASK = 0.93;       // never pay more than this — risk/reward is unplayable above it
const SNIPER_BAIL = 0.90;          // sell immediately if price drops below this after entry
const SNIPER_WINDOW_MS = 90_000;   // only snipe in the last 90 seconds
const SNIPER_SHARES = 10;          // size up — risk is tiny at 0.95+
const SNIPER_POLL_MS = 2_000;      // check every 2s in the sniper window

type Signal = {
  action: "BUY_UP" | "BUY_DOWN" | "NO_TRADE";
  score: number;
  confidence: number;
  label: string;
  regime: string;
  timestamp: number;
};

function readSignal(): Signal | null {
  try {
    const raw = readFileSync(SIGNAL_PATH, "utf-8");
    const signal = JSON.parse(raw) as Signal;
    if (Date.now() - signal.timestamp > SIGNAL_MAX_AGE_MS) return null;
    return signal;
  } catch {
    return null;
  }
}

function logTrade(data: {
  window: string;
  direction: string;
  entryPrice: number;
  exitPrice: number;
  shares: number;
  exitReason: string;
  score: number;
  confidence: number;
  durationMs: number;
}) {
  try {
    const dir = join(import.meta.dir, "../../logs");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(TRADE_LOG_PATH)) appendFileSync(TRADE_LOG_PATH, TRADE_LOG_HEADER);
    const pnl = (data.exitPrice - data.entryPrice) * data.shares;
    const row = [
      new Date().toISOString(),
      data.window,
      data.direction,
      data.entryPrice.toFixed(4),
      data.exitPrice.toFixed(4),
      data.shares.toFixed(4),
      pnl.toFixed(4),
      data.exitReason,
      data.score.toFixed(4),
      data.confidence.toFixed(4),
      (data.durationMs / 1000).toFixed(1),
    ].join(",") + "\n";
    appendFileSync(TRADE_LOG_PATH, row);
  } catch {
    // non-critical
  }
}

export const orderflowSignalStrategy: Strategy = async (ctx) => {
  const timers: NodeJS.Timeout[] = [];
  let inPosition = false;
  let destroyed = false;
  let countdownActive = false;
  let lastBid: number | null = null;
  let consecutiveQualifying = 0;
  let windowTraded = false;   // block re-entry after a win in the same window
  const bidHistory: number[] = [];

  // Trades held to resolution can't be logged at window close — the outcome
  // isn't known yet. They're buffered here and flushed once closePrice arrives
  // (via poller, or via cleanup since resolution can land ~ms before destroy).
  type PendingResolution = {
    side: "UP" | "DOWN";
    entryPrice: number;
    shares: number;
    entryTime: number;
    exitReason: string;
    score: number;
    confidence: number;
    lastBid: number | null;
  };
  const pendingResolutions: PendingResolution[] = [];

  function flushResolutionLogs(final: boolean): void {
    if (pendingResolutions.length === 0) return;
    const windowId = String((ctx.slotEndMs - 300_000) / 1000);
    const result = ctx.getMarketResult();
    const close = result?.closePrice ?? null;

    if (result && close !== null) {
      const winner = close >= result.openPrice ? "UP" : "DOWN";
      while (pendingResolutions.length > 0) {
        const p = pendingResolutions.shift()!;
        const won = winner === p.side;
        if (!won) log(`[resolution] ${p.side} LOST — resolved at 0.00`, "red");
        logTrade({
          window: windowId,
          direction: p.side,
          entryPrice: p.entryPrice,
          exitPrice: won ? 1.0 : 0.0,
          shares: p.shares,
          exitReason: won ? p.exitReason : `${p.exitReason} loss`,
          score: p.score,
          confidence: p.confidence,
          durationMs: Date.now() - p.entryTime,
        });
      }
      return;
    }

    // Close price never arrived and we're tearing down — log best estimate
    // rather than silently dropping the trade. Marked so it's visible in the CSV.
    if (final) {
      while (pendingResolutions.length > 0) {
        const p = pendingResolutions.shift()!;
        logTrade({
          window: windowId,
          direction: p.side,
          entryPrice: p.entryPrice,
          exitPrice: p.lastBid ?? 1.0,
          shares: p.shares,
          exitReason: `${p.exitReason} (unconfirmed)`,
          score: p.score,
          confidence: p.confidence,
          durationMs: Date.now() - p.entryTime,
        });
      }
    }
  }

  const resolutionFlushPoll = setInterval(() => flushResolutionLogs(false), 2_000);
  timers.push(resolutionFlushPoll as unknown as NodeJS.Timeout);

  // Dynamic thresholds based on gap (BTC price minus strike price).
  // Large positive gap = BTC already winning → lower confidence bar, bigger target.
  // Negative gap = BTC needs to reverse → raise confidence bar, take profits quicker.
  function thresholdsFromGap(gap: number | null): { confidenceThreshold: number; repriceTarget: number } {
    if (gap === null) return { confidenceThreshold: CONFIDENCE_THRESHOLD, repriceTarget: REPRICE_TARGET };
    if (gap >= 150)  return { confidenceThreshold: 0.50, repriceTarget: 0.25 }; // well above — near-certainty, go bigger
    if (gap >= 50)   return { confidenceThreshold: 0.52, repriceTarget: 0.22 }; // comfortably above
    if (gap >= 0)    return { confidenceThreshold: 0.55, repriceTarget: 0.20 }; // at/just above — defaults
    if (gap >= -30)  return { confidenceThreshold: 0.65, repriceTarget: 0.17 }; // slightly below — need stronger signal, exit quicker
    return           { confidenceThreshold: 0.72, repriceTarget: 0.15 };        // -30 to -75 — reversal needed, very strict
  }

  function sharesFromConfidenceAndGap(confidence: number, gap: number | null): number {
    let base: number;
    if (confidence >= 0.85) base = 10;
    else if (confidence >= 0.75) base = 7;
    else if (confidence >= 0.65) base = 5;
    else base = 3;
    // Large positive gap = BTC clearly winning, size up
    if (gap !== null && gap >= 150) return Math.min(base + 2, 10);
    // Negative gap = BTC needs reversal, size down
    if (gap !== null && gap < 0) return Math.max(base - 1, 2);
    return base;
  }

  const release = ctx.hold();

  function log(msg: string, color?: string) {
    if (countdownActive) process.stdout.write("\n");
    ctx.log(msg, color);
  }

  function tryTrade() {
    if (destroyed || inPosition) return;

    if (windowTraded) {
      log(`[orderflow] skip — already won this window, no re-entry`, "yellow");
      return;
    }

    const remaining = ctx.slotEndMs - Date.now();
    if (remaining < MIN_REMAINING_MS) {
      log(`[orderflow] <90s remaining, no more entries this window`, "yellow");
      return;
    }

    const signal = readSignal();
    if (!signal) {
      consecutiveQualifying = 0;
      log("[orderflow] no valid signal", "yellow");
      return;
    }

    // Block bearish and directionless regimes
    if (["TREND_DOWN", "LONG_SQUEEZE", "RANGE", "HIGH_VOLATILITY"].includes(signal.regime)) {
      consecutiveQualifying = 0;
      log(`[orderflow] skip — regime (${signal.regime})`, "yellow");
      return;
    }

    // Gap check — skip BUY_UP if BTC is too far below the strike price
    const openPrice = ctx.getMarketResult()?.openPrice ?? null;
    const btcPrice = ctx.ticker.price;
    const gap = openPrice !== null && btcPrice !== undefined ? btcPrice - openPrice : null;
    if (gap !== null && gap < MIN_GAP_USD) {
      consecutiveQualifying = 0;
      log(`[orderflow] skip — BTC $${gap.toFixed(0)} below strike (min ${MIN_GAP_USD})`, "yellow");
      return;
    }

    const { confidenceThreshold, repriceTarget } = thresholdsFromGap(gap);

    const qualifies =
      signal.score > 0 &&
      signal.score >= SCORE_THRESHOLD &&
      signal.confidence >= confidenceThreshold;

    if (!qualifies) {
      consecutiveQualifying = 0;
      log(
        `[orderflow] skip — score=${signal.score.toFixed(2)} conf=${signal.confidence.toFixed(2)} (need ${confidenceThreshold.toFixed(2)})`,
        "yellow",
      );
      return;
    }

    consecutiveQualifying++;
    if (consecutiveQualifying < REQUIRED_CONSECUTIVE) {
      const gapLabel = gap !== null ? ` gap=${gap >= 0 ? "+" : ""}${gap.toFixed(0)}` : "";
      log(
        `[orderflow] signal ${consecutiveQualifying}/${REQUIRED_CONSECUTIVE} — waiting for confirmation | score=${signal.score.toFixed(2)} conf=${signal.confidence.toFixed(2)} threshold=${confidenceThreshold.toFixed(2)}${gapLabel}`,
        "yellow",
      );
      return;
    }
    consecutiveQualifying = 0;

    const side = "UP";
    const tokenId = ctx.clobTokenIds[0];
    const askInfo = ctx.orderBook.bestAskInfo(side);

    if (!askInfo || askInfo.liquidity < 1) {
      log(`[orderflow] no liquidity on ${side}, skipping`, "yellow");
      return;
    }

    const buyPrice = askInfo.price;

    if (buyPrice > MAX_BUY_PRICE) {
      log(`[orderflow] skip — ask ${buyPrice.toFixed(2)} above max ${MAX_BUY_PRICE}`, "yellow");
      return;
    }

    if (buyPrice < MIN_BUY_PRICE) {
      log(`[orderflow] skip — ask ${buyPrice.toFixed(2)} below min ${MIN_BUY_PRICE} (crowd >70% bearish)`, "yellow");
      consecutiveQualifying = 0;
      return;
    }

    // Momentum check: skip if bid has been falling
    const currentBid = ctx.orderBook.bestBidPrice(side);
    if (lastBid !== null && currentBid !== null && currentBid < lastBid - 0.04) {
      log(`[orderflow] skip — bid falling ${lastBid.toFixed(2)} → ${currentBid.toFixed(2)}`, "yellow");
      lastBid = currentBid;
      consecutiveQualifying = 0;
      return;
    }
    lastBid = currentBid ?? lastBid;

    // Book volatility check: skip if bid has been swinging wildly across recent polls
    if (currentBid !== null) {
      bidHistory.push(currentBid);
      if (bidHistory.length > BID_HISTORY_SIZE) bidHistory.shift();
    }
    if (bidHistory.length >= BID_HISTORY_SIZE) {
      const swing = Math.max(...bidHistory) - Math.min(...bidHistory);
      if (swing > MAX_BID_SWING) {
        consecutiveQualifying = 0;
        log(`[orderflow] skip — book unstable, swing=${swing.toFixed(3)} > max=${MAX_BID_SWING}`, "yellow");
        return;
      }
    }

    // Whale dump: cross-exchange divergence means a large seller is hitting one exchange
    if (ctx.ticker.isWhaleDump) {
      consecutiveQualifying = 0;
      log(`[orderflow] skip — whale dump detected (cross-exchange divergence)`, "yellow");
      return;
    }

    const sellTarget = Math.min(buyPrice + repriceTarget, 0.95);
    const shares = sharesFromConfidenceAndGap(signal.confidence, gap);

    let holdToResolution = gap !== null && gap >= HOLD_GAP_THRESHOLD;
    const gapStr = gap !== null ? ` | gap=${gap >= 0 ? "+" : ""}${gap.toFixed(0)}` : "";
    const modeStr = holdToResolution ? " | HOLD TO RESOLUTION" : ` → ${sellTarget.toFixed(2)}`;
    log(
      `[orderflow] ENTRY — ${signal.label} | score=${signal.score.toFixed(2)} conf=${signal.confidence.toFixed(2)} | UP @ ${buyPrice}${modeStr} | shares=${shares}${gapStr}`,
      "cyan",
    );

    const entryTime = Date.now();
    const entryScore = signal.score;
    const entryConfidence = signal.confidence;
    const windowId = String((ctx.slotEndMs - 300_000) / 1000);

    inPosition = true;

    ctx.postOrders([
      {
        req: {
          tokenId,
          action: "buy",
          price: buyPrice,
          shares,
          orderType: "FOK",
        },
        expireAtMs: ctx.slotEndMs - MIN_REMAINING_MS,

        onFilled(filledShares) {
          const fillMsg = holdToResolution
            ? `[orderflow] BUY filled — ${filledShares} shares @ ${buyPrice} | holding to resolution`
            : `[orderflow] BUY filled — ${filledShares} shares @ ${buyPrice} | target=${sellTarget.toFixed(2)}`;
          log(fillMsg, "green");

          const partialShares = Math.round(filledShares * PARTIAL_SELL_RATIO * 10000) / 10000;
          const holdShares = Math.round((filledShares - partialShares) * 10000) / 10000;

          let partialSold = false;
          let fullyExited = false;
          let bearishReads = 0;        // consecutive bearish *distinct* signals before bailing
          let lastSeenSignalTs = 0;    // dedupe: signal.json only refreshes every ~20s
          countdownActive = true;

          function sellShares(shares: number, reason: string, onDone?: () => void) {
            const pendingSells = ctx.pendingOrders.filter((o) => o.action === "sell");
            if (pendingSells.length > 0) {
              log(`[orderflow] sell already in flight (${reason}), skipping`, "yellow");
              onDone?.();
              return;
            }
            const bid = ctx.orderBook.bestBidPrice(side);
            const sellPrice = (bid && bid > 0) ? bid : 0.01;
            log(`[orderflow] ${reason} — FAK sell ${shares.toFixed(4)}sh @ ${sellPrice}`, "cyan");
            ctx.postOrders([{
              req: { tokenId, action: "sell", price: sellPrice, shares, orderType: "FAK" },
              expireAtMs: ctx.slotEndMs,
              onFilled() {
                log(`[orderflow] SELL filled @ ${sellPrice} (${reason})`, "green");
                logTrade({
                  window: windowId,
                  direction: "UP",
                  entryPrice: buyPrice,
                  exitPrice: sellPrice,
                  shares,
                  exitReason: reason,
                  score: entryScore,
                  confidence: entryConfidence,
                  durationMs: Date.now() - entryTime,
                });
                onDone?.();
              },
              onFailed(r) { log(`[orderflow] sell failed (${r}) — ${reason}`, "red"); },
            }]);
          }

          function doTimeExit() {
            if (fullyExited || destroyed) return;
            fullyExited = true;
            countdownActive = false;
            clearInterval(pricePoller);
            const sharesToSell = partialSold ? holdShares : filledShares;
            if (sharesToSell > 0) sellShares(sharesToSell, "time limit");
            inPosition = false;
          }

          const pricePoller = setInterval(() => {
            if (fullyExited || destroyed) { clearInterval(pricePoller); return; }
            const remaining = ctx.slotEndMs - Date.now();
            const bid = ctx.orderBook.bestBidPrice(side);
            const holdingNow = partialSold ? holdShares : filledShares;

            // Exit logic — two distinct dangers, handled separately:
            //
            // (1) REAL DUMP: the bid is actually dropping below our entry. This is
            //     real-time truth and the biggest source of loss (−$19 last night).
            //     Bail FAST — every second of delay deepens the loss.
            //
            // (2) SLOW BLEED: regime turns bearish but price is still holding near
            //     entry. The regime is a 20s-stale noisy classifier, so a single
            //     bearish refresh is usually noise (68 trades bled ~$3 panic-selling
            //     at −1 cent on a flicker). Require 2 distinct refreshes to confirm.
            const DUMP_EXIT_MARGIN = 0.06;   // bid this far below entry = real adverse move
            if (bid !== null && bid < buyPrice - DUMP_EXIT_MARGIN) {
              process.stdout.write("\n");
              log(`[orderflow] PRICE DUMP — bid ${bid.toFixed(2)} dropped below entry ${buyPrice.toFixed(2)}, selling now`, "red");
              fullyExited = true;
              countdownActive = false;
              clearInterval(pricePoller);
              sellShares(holdingNow, "price dump", () => { inPosition = false; });
              return;
            }

            const liveSignal = readSignal();
            if (liveSignal && liveSignal.timestamp !== lastSeenSignalTs) {
              lastSeenSignalTs = liveSignal.timestamp;
              const bearish = liveSignal.regime === "TREND_DOWN" || liveSignal.regime === "LONG_SQUEEZE";
              bearishReads = bearish ? bearishReads + 1 : 0;
            }
            if (bearishReads >= 2) {
              process.stdout.write("\n");
              log(`[orderflow] REGIME FLIP — confirmed bearish over ${bearishReads} refreshes, selling now`, "red");
              fullyExited = true;
              countdownActive = false;
              clearInterval(pricePoller);
              sellShares(holdingNow, "regime flip", () => { inPosition = false; });
              return;
            }

            if (holdToResolution) {
              // Recompute current gap every tick to watch for gap shrinkage
              const currentBtc = ctx.ticker.price;
              const currentGap = openPrice !== null && currentBtc !== undefined
                ? currentBtc - openPrice : null;
              const gapNow = currentGap !== null ? `gap=${currentGap >= 0 ? "+" : ""}${currentGap.toFixed(0)}` : "gap=??";
              process.stdout.write(`\r[orderflow] HOLDING TO RESOLUTION | bid=${bid?.toFixed(2) ?? "??"} ${gapNow} remaining=${Math.round(remaining / 1000)}s holding=${holdingNow.toFixed(2)}sh`.padEnd(100));

              // Bail out if gap shrinks below safety threshold — BTC heading back to strike
              if (currentGap !== null && currentGap < BAIL_OUT_GAP) {
                process.stdout.write("\n");
                log(`[orderflow] BAIL OUT — gap shrunk to $${currentGap.toFixed(0)}, selling now`, "red");
                fullyExited = true;
                countdownActive = false;
                clearInterval(pricePoller);
                sellShares(holdingNow, "bail out gap shrink", () => { inPosition = false; });
                return;
              }

              // Window closing — release lock and let resolution handle payout.
              // Buffer the trade so it reaches the CSV with the real outcome
              // (this branch previously never logged at all).
              if (remaining < 10_000) {
                process.stdout.write("\n");
                log(`[orderflow] window closing — holding ${holdingNow.toFixed(2)}sh to resolution`, "green");
                fullyExited = true;
                countdownActive = false;
                clearInterval(pricePoller);
                pendingResolutions.push({
                  side: "UP",
                  entryPrice: buyPrice,
                  shares: holdingNow,
                  entryTime,
                  exitReason: "hold resolution",
                  score: entryScore,
                  confidence: entryConfidence,
                  lastBid: bid,
                });
                inPosition = false;
              }
              return;
            }

            // Normal mode: sell at target or time exit
            const line = `[orderflow] bid=${bid?.toFixed(2) ?? "??"} target=${sellTarget.toFixed(2)} remaining=${Math.round(remaining / 1000)}s holding=${holdingNow.toFixed(2)}sh`;
            process.stdout.write(`\r${line.padEnd(90)}`);

            if (!partialSold && bid && bid >= sellTarget) {
              process.stdout.write("\n");
              partialSold = true;
              fullyExited = true;
              countdownActive = false;
              clearInterval(pricePoller);
              log(`[orderflow] TARGET HIT — selling all (${partialShares.toFixed(4)}sh)`, "green");
              sellShares(partialShares, "target hit", () => {
                windowTraded = true;
                inPosition = false;
              });
            } else if (remaining < 60_000) {
              // If token is already at 0.90+ don't panic sell — switch to hold mode
              if (!partialSold && bid && bid >= LATE_HOLD_PRICE) {
                process.stdout.write("\n");
                log(`[orderflow] bid=${bid.toFixed(2)} ≥ ${LATE_HOLD_PRICE} with ${Math.round(remaining / 1000)}s left — holding to resolution`, "green");
                holdToResolution = true;
              } else {
                process.stdout.write("\n");
                doTimeExit();
              }
            }
          }, 2_000);

          timers.push(pricePoller as unknown as NodeJS.Timeout);
        },

        onExpired() {
          log("[orderflow] buy expired — no fill", "yellow");
          inPosition = false;
          consecutiveQualifying = 0;
        },

        onFailed(reason) {
          log(`[orderflow] buy failed (${reason})`, "red");
          inPosition = false;
          consecutiveQualifying = 0;
        },
      },
    ]);
  }

  function trySnipe() {
    if (destroyed || inPosition) return;
    const remaining = ctx.slotEndMs - Date.now();
    if (remaining > SNIPER_WINDOW_MS || remaining < 30_000) return;

    const upBid = ctx.orderBook.bestBidPrice("UP");
    const downBid = ctx.orderBook.bestBidPrice("DOWN");

    let side: "UP" | "DOWN" | null = null;
    if (upBid !== null && upBid >= SNIPER_THRESHOLD) side = "UP";
    else if (downBid !== null && downBid >= SNIPER_THRESHOLD) side = "DOWN";

    if (!side) return;

    const decidedBid = side === "UP" ? upBid! : downBid!;
    const tokenId = side === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1];
    const askInfo = ctx.orderBook.bestAskInfo(side);

    if (!askInfo || askInfo.liquidity < 1) {
      log(`[sniper] ${side} @ ${decidedBid.toFixed(2)} but no liquidity`, "yellow");
      return;
    }

    // Cap the price we'll pay. Above this the bet is "risk $0.96 to make $0.04" —
    // a single whipsaw wipes out dozens of wins, so skip it entirely.
    if (askInfo.price > SNIPER_MAX_ASK) {
      log(`[sniper] ${side} @ ${decidedBid.toFixed(2)} but ask ${askInfo.price.toFixed(2)} > max ${SNIPER_MAX_ASK}`, "yellow");
      return;
    }

    const buyPrice = askInfo.price;
    inPosition = true;
    log(
      `[sniper] ENTRY — ${side} decided @ ${decidedBid.toFixed(2)} | buying @ ${buyPrice} | ${Math.round(remaining / 1000)}s left`,
      "cyan",
    );

    const entryTime = Date.now();

    ctx.postOrders([{
      req: { tokenId, action: "buy", price: buyPrice, shares: SNIPER_SHARES, orderType: "FOK" },
      expireAtMs: ctx.slotEndMs - 10_000,

      onFilled(filledShares) {
        log(`[sniper] ${side} filled — ${filledShares}sh @ ${buyPrice} | holding to resolution`, "green");

        // Require the drop to persist across reads before bailing. A single
        // sub-threshold tick is almost always a thin-book wick that recovers —
        // bailing on it sells into garbage liquidity (cost us -$3 on a DOWN bet
        // that ultimately won). A real reversal stays down for consecutive reads.
        let bailReads = 0;

        const watchPoller = setInterval(() => {
          if (destroyed) { clearInterval(watchPoller); return; }
          const rem = ctx.slotEndMs - Date.now();
          const currentBid = ctx.orderBook.bestBidPrice(side!);
          process.stdout.write(
            `\r[sniper] HOLDING ${side} | bid=${currentBid?.toFixed(2) ?? "??"} remaining=${Math.round(rem / 1000)}s`.padEnd(80),
          );

          // Count consecutive sub-threshold reads; reset the moment it recovers.
          if (currentBid !== null && currentBid < SNIPER_BAIL) {
            bailReads++;
          } else {
            bailReads = 0;
          }

          // Bail only if the drop held for 2 consecutive reads (~4s) AND there's
          // still time for it to matter. Inside the final 15s a wick can't be
          // distinguished from resolution noise, so hold to the outcome instead.
          if (bailReads >= 2 && currentBid !== null && rem > 15_000) {
            process.stdout.write("\n");
            log(`[sniper] BAIL — held below ${SNIPER_BAIL} for ${bailReads} reads (bid=${currentBid.toFixed(2)}), selling`, "red");
            clearInterval(watchPoller);
            const sellPrice = currentBid ?? 0.01;
            ctx.postOrders([{
              req: { tokenId, action: "sell", price: sellPrice, shares: filledShares, orderType: "FAK" },
              expireAtMs: ctx.slotEndMs,
              onFilled() {
                logTrade({
                  window: String((ctx.slotEndMs - 300_000) / 1000),
                  direction: side!,
                  entryPrice: buyPrice,
                  exitPrice: sellPrice,
                  shares: filledShares,
                  exitReason: "sniper bail",
                  score: 1.0,
                  confidence: 1.0,
                  durationMs: Date.now() - entryTime,
                });
                inPosition = false;
              },
              onFailed() { inPosition = false; },
            }]);
            return;
          }

          // Window closing — hold through resolution. The actual outcome isn't
          // known yet (a last-second reversal resolves at 0.00, not 1.00), so
          // buffer the trade and log it once closePrice arrives.
          if (rem < 10_000) {
            process.stdout.write("\n");
            log(`[sniper] window closing — ${filledShares}sh held to resolution`, "green");
            clearInterval(watchPoller);
            pendingResolutions.push({
              side: side!,
              entryPrice: buyPrice,
              shares: filledShares,
              entryTime,
              exitReason: "sniper resolution",
              score: 1.0,
              confidence: 1.0,
              lastBid: currentBid,
            });
            inPosition = false;
          }
        }, SNIPER_POLL_MS);

        timers.push(watchPoller as unknown as NodeJS.Timeout);
      },

      onExpired() {
        log("[sniper] buy expired — no fill", "yellow");
        inPosition = false;
      },

      onFailed(reason) {
        log(`[sniper] buy failed (${reason})`, "red");
        inPosition = false;
      },
    }]);
  }

  const poll = setInterval(() => {
    if (destroyed) {
      clearInterval(poll);
      return;
    }
    if (Date.now() >= ctx.slotEndMs) {
      clearInterval(poll);
      release();
      return;
    }
    tryTrade();
  }, POLL_INTERVAL_MS);

  timers.push(poll as unknown as NodeJS.Timeout);

  // Sniper poller — runs every 2s, only acts in the last 90 seconds
  const sniperPoll = setInterval(() => {
    if (destroyed) { clearInterval(sniperPoll); return; }
    if (Date.now() >= ctx.slotEndMs) { clearInterval(sniperPoll); return; }
    trySnipe();
  }, SNIPER_POLL_MS);

  timers.push(sniperPoll as unknown as NodeJS.Timeout);

  tryTrade();

  return () => {
    destroyed = true;
    // Resolution data typically arrives just before destroy — flush held trades
    // here with the real outcome, since the 2s poller usually misses that window.
    flushResolutionLogs(true);
    for (const t of timers) clearTimeout(t);
    clearInterval(poll);
    clearInterval(sniperPoll);
    release();
  };
};
