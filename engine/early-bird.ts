import { APIQueue } from "../tracker/api-queue.ts";
import type { EarlyBirdClient } from "./client.ts";
import { EarlyBirdSimClient, PolymarketEarlyBirdClient } from "./client.ts";
import { MarketLifecycle } from "./market-lifecycle.ts";
import { loadState, saveState, type CompletedMarketState } from "./state.ts";
import { getSlug } from "../utils/slot.ts";
import { log } from "./log.ts";
import { recover } from "./recovery.ts";
import {
  strategies,
  DEFAULT_STRATEGY,
  type Strategy,
} from "./strategy/index.ts";
import { WalletTracker } from "./wallet-tracker.ts";
import { TickerTracker } from "../tracker/ticker";

const SAVE_INTERVAL_MS = 5000;

export class EarlyBird {
  private _lifecycles = new Map<string, MarketLifecycle>();
  private _completedSlugs = new Set<string>();
  private _completedMarkets: CompletedMarketState[] = [];
  private _client: EarlyBirdClient;
  private _apiQueue = new APIQueue();
  private _sessionPnl = 0;
  private _sessionLoss = 0;
  private _shuttingDown = false;
  private _lastSaveMs = 0;
  private readonly _strategyName: string;
  private readonly _strategy: Strategy;
  private readonly _slotOffset: number;

  private readonly _statePath: string;
  private readonly _rounds: number | null; // null = unlimited
  private readonly _prod: boolean;
  private readonly _minSessionPnl: number;
  private _roundsCreated = 0;
  private _tracker!: WalletTracker;
  private _ticker = new TickerTracker();

  constructor(
    strategyName?: string,
    slotOffset = 1,
    prod = false,
    rounds: number | null = null,
  ) {
    this._prod = prod;
    this._statePath = prod
      ? "state/early-bird-prod.json"
      : "state/early-bird.json";
    this._rounds = rounds;
    this._strategyName = strategyName ?? DEFAULT_STRATEGY;
    this._strategy = strategies[this._strategyName]!;
    this._slotOffset = slotOffset;
    this._minSessionPnl = parseFloat(process.env.MAX_SESSION_LOSS ?? "3");
    if (prod) {
      this._client = new PolymarketEarlyBirdClient();
    } else {
      this._client = new EarlyBirdSimClient((tokenId) => {
        for (const lifecycle of this._lifecycles.values()) {
          const snap = lifecycle.getBookSnapshot(tokenId);
          if (snap) return snap;
        }
        return {
          bestAsk: null,
          bestAskLiquidity: null,
          bestBid: null,
          bestBidLiquidity: null,
        };
      });
    }
  }

  async start(): Promise<void> {
    log.write("[startup] Starting");
    this._ticker.schedule();
    await this._ticker.waitForReady();
    log.write("[startup] BTC ticker ready");

    await this._client.init();

    // Seed wallet tracker
    let initialBalance: number;
    if (this._prod) {
      await this._client.updateUSDCBalance();
      initialBalance = await this._client.getUSDCBalance();
      log.write(`[startup] On-chain balance: $${initialBalance.toFixed(2)}`);
    } else {
      initialBalance = parseFloat(process.env.WALLET_BALANCE ?? "50");
      log.write(`[startup] Sim balance: $${initialBalance.toFixed(2)}`);
    }
    this._tracker = new WalletTracker(initialBalance, (msg) =>
      log.write(msg, "dim"),
    );

    log.write(
      `[startup] Min session PnL exit: $${this._minSessionPnl.toFixed(2)}`,
    );

    const state = loadState(this._statePath);
    if (state) {
      log.write(`[startup] Loading state from ${this._statePath}`);
      this._sessionPnl = state.sessionPnl;
      this._sessionLoss = state.sessionLoss ?? 0;

      if (Math.abs(this._sessionLoss) >= this._minSessionPnl) {
        log.write(
          `[startup] Session loss from previous session ($${this._sessionLoss.toFixed(2)}) already meets or exceeds the MAX_SESSION_LOSS threshold (-$${this._minSessionPnl.toFixed(2)}). ` +
            `The engine would shut down immediately. ` +
            `To start fresh, reset "sessionLoss" to 0 in ${this._statePath}, or increase MAX_SESSION_LOSS in your .env.`,
          "red",
        );
        process.exit(1);
      }

      // Sim recovery: replay order history to reconstruct balance
      if (!this._prod) {
        for (const market of state.activeMarkets) {
          for (const order of market.orderHistory) {
            if (order.action === "buy")
              this._tracker.debit(order.price * order.shares);
            else this._tracker.credit(order.price * order.shares);
          }
        }
      }

      const recovered = await recover(
        state,
        this._client,
        this._apiQueue,
        (msg, color) => log.write(msg, color),
        this._tracker,
        this._ticker,
      );
      for (const [slug, lifecycle] of recovered) {
        this._lifecycles.set(slug, lifecycle);
      }
    } else {
      log.write("[startup] No saved state found. Starting fresh.");
    }

    process.on("exit", () => {
      log.flush();
      this._saveState();
    });

    const onSignal = (sig: string) => {
      log.write(
        `[shutdown] ${sig} received. Initiating graceful shutdown...`,
        "yellow",
      );
      log.flush();
      this._saveState();
      this._startShutdown(`${sig} received.`);
    };
    process.on("SIGINT", () => onSignal("SIGINT"));
    process.on("SIGTERM", () => onSignal("SIGTERM"));

    setInterval(() => this._tick(), 100);
  }

  private _tick(): void {
    // Create a new lifecycle for next market if not shutting down and rounds allow
    const roundsExhausted =
      this._rounds !== null && this._roundsCreated >= this._rounds;
    if (!this._shuttingDown && !roundsExhausted) {
      const slug = getSlug(this._slotOffset);
      if (!this._lifecycles.has(slug) && !this._completedSlugs.has(slug)) {
        this._lifecycles.set(
          slug,
          new MarketLifecycle(
            slug,
            this._apiQueue,
            this._client,
            (msg, color) => log.write(msg, color),
            this._strategyName,
            this._strategy,
            this._tracker,
            this._ticker,
          ),
        );
        this._roundsCreated++;
      }
    }

    // Tick all lifecycles (fire-and-forget; _ticking guard prevents re-entry)
    const done: string[] = [];
    for (const [slug, lifecycle] of this._lifecycles) {
      lifecycle
        .tick()
        .catch((e) => log.write(`[${slug}] tick error: ${e}`, "red"));
      if (lifecycle.state === "DONE") done.push(slug);
    }

    // Process completed lifecycles
    for (const slug of done) {
      const lifecycle = this._lifecycles.get(slug)!;
      this._sessionPnl = parseFloat(
        (this._sessionPnl + lifecycle.pnl).toFixed(4),
      );
      if (lifecycle.pnl < 0) {
        this._sessionLoss = parseFloat(
          (this._sessionLoss + lifecycle.pnl).toFixed(4),
        );
      }
      log.write(
        `[${slug}] Session PnL: ${this._sessionPnl >= 0 ? "+" : ""}$${this._sessionPnl.toFixed(2)}`,
        this._sessionPnl >= 0 ? "green" : "red",
      );
      this._completedMarkets.push({
        slug,
        strategyName: lifecycle.strategyName,
        pnl: lifecycle.pnl,
        orderHistory: lifecycle.orderHistory,
      });
      lifecycle.destroy();
      this._lifecycles.delete(slug);
      this._completedSlugs.add(slug);

      if (Math.abs(this._sessionLoss) >= this._minSessionPnl) {
        this._startShutdown(
          `Session loss limit reached (total losses: $${this._sessionLoss.toFixed(2)}, threshold: -$${this._minSessionPnl.toFixed(2)}).`,
        );
      }
    }

    // Check slot-end timeout for active stopping lifecycles
    if (!this._shuttingDown) {
      const nowMs = Date.now();
      for (const [slug, lifecycle] of this._lifecycles) {
        if (lifecycle.state === "STOPPING") {
          if (nowMs > lifecycle.slotEndMs) {
            this._startShutdown(
              `SELL order for ${slug} didn't fill by slot end.`,
            );
            break;
          }
        }
      }
    }

    // Throttled state persistence (every 5s)
    if (Date.now() - this._lastSaveMs >= SAVE_INTERVAL_MS) {
      this._saveState();
    }

    // Auto-shutdown when all rounds complete and no lifecycles remain
    if (!this._shuttingDown && roundsExhausted && this._lifecycles.size === 0) {
      this._startShutdown(`All ${this._rounds} round(s) complete.`);
    }

    // Exit once all lifecycles are settled during shutdown
    if (this._shuttingDown && this._lifecycles.size === 0) {
      log.write("[shutdown] All settled. Exiting.", "dim");
      this._saveState();
      this._ticker.destroy();
      process.exit(0);
    }
  }

  private _startShutdown(reason: string): void {
    if (this._shuttingDown) return;
    this._shuttingDown = true;
    log.write(`[shutdown] ${reason}`, "yellow");
    log.write("[shutdown] Signalling all lifecycles to cancel.", "yellow");

    for (const [, lifecycle] of this._lifecycles) {
      lifecycle.shutdown();
    }

    const stoppingCount = [...this._lifecycles.values()].filter(
      (l) => l.state === "STOPPING",
    ).length;

    if (stoppingCount > 0) {
      log.write(
        `[shutdown] Waiting for ${stoppingCount} lifecycle(s) to settle...`,
      );
    }
  }

  private _saveState(): void {
    this._lastSaveMs = Date.now();
    const activeMarkets = [...this._lifecycles.entries()]
      .filter(([, l]) => l.state === "RUNNING" || l.state === "STOPPING")
      .map(([slug, l]) => ({
        slug,
        state: l.state as "RUNNING" | "STOPPING",
        strategyName: l.strategyName,
        clobTokenIds: l.clobTokenIds!,
        pendingOrders: l.pendingOrders,
        orderHistory: l.orderHistory,
      }));

    saveState(this._statePath, {
      sessionPnl: this._sessionPnl,
      sessionLoss: this._sessionLoss,
      activeMarkets,
      completedMarkets: this._completedMarkets,
    });
  }
}
