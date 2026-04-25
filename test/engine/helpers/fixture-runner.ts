import { readFileSync } from "fs";
import { join } from "path";
import sinon, { type SinonFakeTimers } from "sinon";
import {
  MarketLifecycle,
  type LifecycleState,
} from "../../../engine/market-lifecycle.ts";
import { EarlyBirdSimClient } from "../../../engine/client.ts";
import { WalletTracker } from "../../../engine/wallet-tracker.ts";
import type { Strategy } from "../../../engine/strategy/types.ts";
import { SimOrderBook } from "./sim-orderbook.ts";
import { SimTickerTracker } from "./sim-ticker.ts";
import {
  MockAPIQueue,
  FIXTURE_SLUG,
  UP_TOKEN,
  DOWN_TOKEN,
} from "./mock-api-queue.ts";

export { UP_TOKEN, DOWN_TOKEN, FIXTURE_SLUG };

export const SLOT_START_MS = 1777108200000;
export const SLOT_END_MS = 1777108500000;
const LOG_START_TS = 1777108047232;

type LogEvent = {
  ts: number;
  type: string;
  [k: string]: unknown;
};

function loadFixtureEvents(): LogEvent[] {
  const logPath = join(import.meta.dirname, "../../__fixtures__/orderbook.log");
  const lines = readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l.trim());
  return lines.map((l) => JSON.parse(l) as LogEvent);
}

/**
 * Self-contained test harness for early-bird engine tests.
 *
 * Key design: lifecycle ticks are scheduled as fake timers (every TICK_MS) so
 * clock.tickAsync() drives both time advancement and order processing in lock-step.
 * This avoids the await-deadlock that occurs when lifecycle.tick() internally
 * awaits simulateDelay() (a faked setTimeout) while we're also awaiting tick().
 *
 * Usage:
 *   const runner = new FixtureRunner();
 *   await runner.setup(myStrategy);
 *   await runner.advanceTo(someTs);
 *   // assert on runner.lifecycle.pnl, runner.lifecycle.state, etc.
 *   runner.teardown();
 */
export class FixtureRunner {
  readonly simBook: SimOrderBook;
  readonly simTicker: SimTickerTracker;
  readonly apiQueue: MockAPIQueue;
  readonly client: EarlyBirdSimClient;
  readonly tracker: WalletTracker;
  lifecycle!: MarketLifecycle;

  private clock!: SinonFakeTimers;
  private events: LogEvent[];
  private eventIdx = 0;

  /** Interval (fake ms) at which lifecycle.tick() is automatically fired. */
  static readonly TICK_MS = 100;

  constructor(walletBalance = Infinity) {
    this.events = loadFixtureEvents();
    this.simBook = new SimOrderBook();
    this.simTicker = new SimTickerTracker();
    this.apiQueue = new MockAPIQueue();
    this.tracker = new WalletTracker(walletBalance);

    // Wire SimClient to read book state from simBook via lifecycle.getBookSnapshot.
    // Forward reference is safe because lifecycle is assigned before any order is placed.
    this.client = new EarlyBirdSimClient((tokenId) => {
      if (!this.lifecycle) {
        return {
          bestAsk: null,
          bestAskLiquidity: null,
          bestBid: null,
          bestBidLiquidity: null,
        };
      }
      return (
        this.lifecycle.getBookSnapshot(tokenId) ?? {
          bestAsk: null,
          bestAskLiquidity: null,
          bestBid: null,
          bestBidLiquidity: null,
        }
      );
    });
  }

  /**
   * Install fake timers, create the MarketLifecycle with the given strategy,
   * and tick through INIT → RUNNING.
   */
  async setup(strategy: Strategy): Promise<void> {
    // Suppress simClient network delay so lifecycle ticks are fast
    process.env.SIM_DELAY_MS = "0";

    this.clock = sinon.useFakeTimers({
      now: LOG_START_TS,
      toFake: [
        "Date",
        "setTimeout",
        "setInterval",
        "clearTimeout",
        "clearInterval",
        "performance",
      ],
      shouldClearNativeTimers: true,
    });

    this.lifecycle = new MarketLifecycle({
      slug: FIXTURE_SLUG,
      apiQueue: this.apiQueue,
      client: this.client,
      log: () => {},
      strategyName: "test",
      strategy,
      tracker: this.tracker,
      ticker: this.simTicker as any,
      orderBook: this.simBook,
    });

    // Apply the first real snapshot (second line has non-null data at LOG_START_TS + 1001ms)
    this._applyEventsUpTo(LOG_START_TS + 2000);

    // Schedule the initial tick and advance enough for INIT → RUNNING to complete.
    // Strategy runs synchronously inside _handleInit (postOrders is fire-and-forget).
    this._scheduleTick(0);
    await this.clock.tickAsync(FixtureRunner.TICK_MS * 3);
  }

  /**
   * Drive fake time forward to targetTs, applying log events and lifecycle ticks
   * in chronological order so the book state at any fake-clock moment reflects
   * only events whose ts ≤ clock.now — not the full future state.
   */
  async advanceTo(targetTs: number): Promise<void> {
    const delta = targetTs - this.clock.now;
    if (delta <= 0) return;

    // Schedule each log event as a fake timer at its natural offset.
    // Events are registered before ticks, so same-ms events fire before ticks.
    while (this.eventIdx < this.events.length) {
      const event = this.events[this.eventIdx]!;
      if (event.ts > targetTs) break;
      const delay = event.ts - this.clock.now; // always >= 0 (events are ordered)
      const e = event;
      setTimeout(() => this._applyEvent(e), delay);
      this.eventIdx++;
    }

    // Schedule lifecycle ticks every TICK_MS throughout the range
    const TICK_MS = FixtureRunner.TICK_MS;
    for (let t = TICK_MS; t <= delta; t += TICK_MS) {
      this._scheduleTick(t);
    }
    this._scheduleTick(delta);

    await this.clock.tickAsync(delta);
  }

  /**
   * Poll by advancing 1s steps until lifecycle.state === target or timeoutTs exceeded.
   */
  async waitForState(
    state: LifecycleState,
    timeoutTs = SLOT_END_MS + 120_000,
  ): Promise<void> {
    const STEP = 1000;
    while (this.lifecycle.state !== state) {
      if (this.clock.now >= timeoutTs) {
        throw new Error(
          `waitForState("${state}") timed out at ts=${this.clock.now}; current="${this.lifecycle.state}"`,
        );
      }
      await this.advanceTo(this.clock.now + STEP);
    }
  }

  /** Restore sinon clock and destroy the lifecycle. */
  teardown(): void {
    delete process.env.SIM_DELAY_MS;
    this.lifecycle?.destroy();
    this.clock?.restore();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Schedule a single lifecycle tick as a fake timer at `delayMs` from now. */
  private _scheduleTick(delayMs: number): void {
    setTimeout(() => {
      this.lifecycle.tick().catch(() => {});
    }, delayMs);
  }

  private _applyEventsUpTo(targetTs: number): void {
    while (this.eventIdx < this.events.length) {
      const event = this.events[this.eventIdx]!;
      if (event.ts > targetTs) break;
      this._applyEvent(event);
      this.eventIdx++;
    }
  }

  private _applyEvent(event: LogEvent): void {
    if (event.type === "orderbook_snapshot") {
      const up = event.up as {
        bids: [number, number][];
        asks: [number, number][];
      } | null;
      const down = event.down as {
        bids: [number, number][];
        asks: [number, number][];
      } | null;
      this.simBook.applyLogSnapshot(UP_TOKEN, DOWN_TOKEN, { up, down });
    } else if (event.type === "ticker") {
      this.simTicker.setTicker({
        assetPrice: event.assetPrice as number,
        binancePrice: event.binancePrice as number,
        coinbasePrice: event.coinbasePrice as number,
        divergence: event.divergence as number,
      });
    }
  }
}
