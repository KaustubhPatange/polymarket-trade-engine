import { OrderBook } from "../tracker/orderbook.ts";
import { APIQueue } from "../tracker/api-queue.ts";
import { Logger } from "./logger.ts";
import type { EarlyBirdClient, PlacedOrder } from "./client.ts";
import type { LogColor } from "./log.ts";
import type {
  Strategy,
  StrategyContext,
  OrderRequest,
} from "./strategy/types.ts";
import type { CancelOrderResponse } from "../utils/trading.ts";
import type { WalletTracker } from "./wallet-tracker.ts";
import type { TickerTracker } from "../tracker/ticker";
import { slotFromSlug } from "../utils/slot.ts";
import type { UserChannel } from "./user-channel.ts";

export type LifecycleState = "INIT" | "RUNNING" | "STOPPING" | "DONE";

export type PendingOrder = {
  orderId: string;
  tokenId: string;
  action: "buy" | "sell";
  orderType?: "GTC" | "FOK";
  price: number;
  shares: number;
  expireAtMs: number;
  placedAtMs: number;
  onFilled?: (filledShares: number) => void;
  onExpired?: () => void | Promise<void>;
  onFailed?: (reason: string) => void | Promise<void>;
};

export type CompletedOrder = {
  action: "buy" | "sell";
  price: number;
  shares: number;
  fee: number;
  tokenId: string;
};

/** Serializable subset of PendingOrder (no callbacks). */
export type PendingOrderSnapshot = Omit<
  PendingOrder,
  "onFilled" | "onExpired" | "onFailed"
>;

type RecoveryOptions = {
  state: "RUNNING" | "STOPPING";
  conditionId: string;
  clobTokenIds: [string, string];
  pendingOrders: PendingOrder[];
  orderHistory: CompletedOrder[];
};

type MarketLifecycleOptions = {
  slug: string;
  apiQueue: APIQueue;
  client: EarlyBirdClient;
  log: (msg: string, color?: LogColor) => void;
  strategyName: string;
  strategy: Strategy;
  tracker: WalletTracker;
  ticker: TickerTracker;
  userChannel: UserChannel;
  recovery?: RecoveryOptions;
  alwaysLog?: boolean;
  /** Optional OrderBook override (used in tests to inject SimOrderBook). */
  orderBook?: OrderBook;
};

export class MarketLifecycle {
  private _state: LifecycleState = "INIT";
  private _ticking = false;
  private _orderBook: OrderBook;
  private _userChannel: UserChannel;

  private _clobTokenIds: [string, string] | null = null;
  private _conditionId: string | null = null;

  private _feeRate = 0;
  private _pendingOrders: PendingOrder[] = [];
  private _orderHistory: CompletedOrder[] = [];
  private _buyBlocked = false;
  private _sellBlocked = false;
  private _pnl = 0;
  private _inFlight = 0;
  private _strategyLocks = 0;
  private _marketLogger = new Logger();
  private _marketOpenTimer: ReturnType<typeof setTimeout> | null = null;
  private _marketPriceHandle: { cancel: () => void } | null = null;
  private _strategyCleanup: (() => void) | null = null;

  readonly slug: string;
  private readonly apiQueue: APIQueue;
  private readonly client: EarlyBirdClient;
  private readonly _log: (msg: string, color?: LogColor) => void;
  private readonly _strategyName: string;
  private readonly _strategy: Strategy;
  private readonly _tracker: WalletTracker;
  private readonly _ticker: TickerTracker;
  private readonly _alwaysLog: boolean;

  constructor(opts: MarketLifecycleOptions) {
    this.slug = opts.slug;
    this.apiQueue = opts.apiQueue;
    this.client = opts.client;
    this._log = opts.log;
    this._strategyName = opts.strategyName;
    this._strategy = opts.strategy;
    this._tracker = opts.tracker;
    this._ticker = opts.ticker;
    this._alwaysLog = opts.alwaysLog ?? false;
    this._orderBook = opts.orderBook ?? new OrderBook();
    this._userChannel = opts.userChannel;

    const recovery = opts.recovery;
    if (recovery) {
      this._state = recovery.state;
      this._clobTokenIds = recovery.clobTokenIds;
      this._pendingOrders = recovery.pendingOrders;
      this._orderHistory = recovery.orderHistory;
      if (recovery.state === "STOPPING") this._buyBlocked = true;
      this._orderBook.subscribe(recovery.clobTokenIds);
      this._userChannel.subscribe(recovery.conditionId);

      // track pending orders for user channel
      for (const pending of this._pendingOrders) {
        const orderId = pending.orderId;
        this._userChannel.trackOrder(orderId, {
          req: {
            tokenId: pending.tokenId,
            action: pending.action,
            price: pending.price,
            shares: pending.shares,
            orderType: pending.orderType,
          },
          expireAtMs: pending.expireAtMs,
          onFilled: (gross) => {
            const p = this._pendingOrders.find((o) => o.orderId === orderId);
            if (!p) return;
            this._commitFill(p, gross, 0);
          },
        });
      }
    }
  }

  get state(): LifecycleState {
    return this._state;
  }
  get pnl(): number {
    return this._pnl;
  }
  get clobTokenIds(): [string, string] | null {
    return this._clobTokenIds;
  }
  get conditionId(): string | null {
    return this._conditionId;
  }
  get pendingOrders(): PendingOrderSnapshot[] {
    return this._pendingOrders.map(
      ({ onFilled, onExpired, onFailed, ...rest }) => rest,
    );
  }
  get orderHistory(): CompletedOrder[] {
    return this._orderHistory;
  }
  /** Unix ms timestamp when this lifecycle's market slot starts (market opens). */
  get slotStartMs(): number {
    return slotFromSlug(this.slug).startTime;
  }
  /** Unix ms timestamp when this lifecycle's market slot ends. */
  get slotEndMs(): number {
    return slotFromSlug(this.slug).endTime;
  }
  get remainingSecs(): number {
    return (this.slotEndMs - Date.now()) / 1000;
  }
  get strategyName(): string {
    return this._strategyName;
  }

  /** Returns orderbook snapshot for a tokenId owned by this lifecycle. */
  getBookSnapshot(tokenId: string) {
    if (!this._clobTokenIds) return null;
    let side: "UP" | "DOWN" | null = null;
    if (tokenId === this._clobTokenIds[0]) side = "UP";
    else if (tokenId === this._clobTokenIds[1]) side = "DOWN";
    if (!side) return null;
    const askInfo = this._orderBook.bestAskInfo(side);
    const bidInfo = this._orderBook.bestBidInfo(side);
    return {
      bestAsk: askInfo?.price ?? null,
      bestAskLiquidity: askInfo?.liquidity ?? null,
      bestBid: bidInfo?.price ?? null,
      bestBidLiquidity: bidInfo?.liquidity ?? null,
    };
  }

  /**
   * Signal graceful shutdown. INIT lifecycles are marked DONE immediately.
   * RUNNING lifecycles transition to STOPPING on next tick.
   */
  shutdown(): void {
    if (this._state === "INIT") {
      this._setState("DONE");
      return;
    }
    if (this._state === "RUNNING") {
      this._buyBlocked = true;
      this._setState("STOPPING");
    }
    // STOPPING already — no-op
  }

  destroy(): void {
    if (this._orderHistory.length > 0 || this._alwaysLog) {
      this._marketLogger.endSlot(this.slug);
    }
    this._marketLogger.destroy();
    this._marketPriceHandle?.cancel();
    if (this._marketOpenTimer) clearTimeout(this._marketOpenTimer);
    this._orderBook.destroy();
    for (const pending of this._pendingOrders) {
      this._userChannel.untrackOrder(pending.orderId);
    }
    this._userChannel.destroy();
    this._log(`[${this.slug}] destroy()`, "dim");
  }

  private _setState(next: LifecycleState): void {
    if (this._state === next) return;
    this._log(`[${this.slug}] state: ${this._state} → ${next}`, "dim");
    this._state = next;
  }

  async tick(): Promise<void> {
    if (this._ticking || this._state === "DONE") return;
    this._ticking = true;
    try {
      await this._step();
    } catch (e) {
      this._log(`[${this.slug}] tick error: ${e}`, "red");
    } finally {
      this._ticking = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Core engine
  // ---------------------------------------------------------------------------

  private async _step(): Promise<void> {
    switch (this._state) {
      case "INIT":
        return this._handleInit();
      case "RUNNING":
        return this._handleRunning();
      case "STOPPING":
        return this._handleStopping();
    }
  }

  async setup(): Promise<void> {
    await this.apiQueue.queueEventDetails(this.slug);
    const event = this.apiQueue.eventDetails.get(this.slug);
    if (!event) return;
    const market = event.markets[0];
    if (!market) return;

    this._conditionId = market.conditionId;
    if (!this._clobTokenIds) {
      const tokenIds: string[] = JSON.parse(market.clobTokenIds);
      this._clobTokenIds = [tokenIds[0]!, tokenIds[1]!];
    }
    this._feeRate = market.feeSchedule?.rate ?? 0;
  }

  private async _handleInit(): Promise<void> {
    await this.setup();
    if (!this._clobTokenIds) return;

    const slot = slotFromSlug(this.slug);
    const delayMs = Math.max(0, slot.startTime - Date.now());
    this._marketOpenTimer = setTimeout(() => {
      this._marketPriceHandle = this.apiQueue.queueMarketPrice(slot);
    }, delayMs);

    this._orderBook.subscribe(this._clobTokenIds);
    this._userChannel.subscribe(this._conditionId!);
    this._marketLogger.setSnapshotProvider(() =>
      this._orderBook.getSnapshotData(),
    );
    this._marketLogger.setTickerProvider(() => ({
      assetPrice: this._ticker.price,
      binancePrice: this._ticker.binancePrice,
      coinbasePrice: this._ticker.coinbasePrice,
      okxPrice: this._ticker.okxPrice,
      bybitPrice: this._ticker.bybitPrice,
      divergence: this._ticker.divergence,
    }));
    this._marketLogger.setMarketResultProvider(() => {
      const data = this.apiQueue.marketResult.get(slot.startTime);
      if (!data?.openPrice) return {};
      const assetPrice = this._ticker.price;
      const gap = assetPrice
        ? parseFloat((assetPrice - data.openPrice).toFixed(2))
        : undefined;
      return { openPrice: data.openPrice, gap, priceToBeat: data.openPrice };
    });
    this._marketLogger.startSlot(
      this.slug,
      Date.now(),
      this.slotEndMs,
      this._strategyName,
    );

    const ctx: StrategyContext = {
      slug: this.slug,
      slotStartMs: this.slotStartMs,
      slotEndMs: this.slotEndMs,
      clobTokenIds: this._clobTokenIds,
      orderBook: this._orderBook,
      log: this._log,
      getOrderById: this.client.getOrderById.bind(this.client),
      postOrders: this._postOrders.bind(this),
      cancelOrders: this._cancelOrders.bind(this),
      emergencySells: this._emergencySells.bind(this),
      blockBuys: () => {
        this._buyBlocked = true;
      },
      blockSells: () => {
        this._sellBlocked = true;
      },
      pendingOrders: this._pendingOrders,
      orderHistory: this._orderHistory,
      hold: () => {
        this._strategyLocks++;
        let released = false;
        return () => {
          if (!released) {
            released = true;
            this._strategyLocks--;
          }
        };
      },
      ticker: this._ticker,
      getMarketResult: () => {
        const slot = slotFromSlug(this.slug);
        return this.apiQueue.marketResult.get(slot.startTime);
      },
    };

    await this._orderBook.waitForReady();
    await this._userChannel.waitForReady();

    const cleanup = await this._strategy(ctx);
    if (cleanup) this._strategyCleanup = cleanup;
    this._setState("RUNNING");
  }

  /**
   * Generic tick for RUNNING: check pending order expiries and fire callbacks.
   * Fills arrive asynchronously via the user channel's onFilled callback.
   * Transitions to STOPPING when the slot ends or all orders drain.
   */
  private async _handleRunning(): Promise<void> {
    if (Date.now() >= this.slotEndMs) {
      this._setState("STOPPING");
      this._log(
        `[${this.slug}] Market closed — transitioning to STOPPING`,
        "yellow",
      );
      return;
    }

    await this._checkExpiries();

    // If no pending orders remain, no placements in flight, no strategy holds,
    // and no unfilled positions that a stop-loss may still sell, we're done
    if (
      this._pendingOrders.length === 0 &&
      this._inFlight === 0 &&
      this._strategyLocks === 0 &&
      !this._hasUnfilledPositions()
    ) {
      this._setState("STOPPING");
    }
  }

  /**
   * STOPPING: cancel pending buys, drain sells, emergency sell on timeout.
   */
  private async _handleStopping(): Promise<void> {
    this._strategyCleanup?.();
    this._strategyCleanup = null;

    // Cancel any remaining buys (in case shutdown was called externally)
    await this._cancelPendingBuys();

    const pendingSells = this._pendingOrders.filter((o) => o.action === "sell");

    const remaining = this.remainingSecs;

    if (remaining <= 0) {
      // Slot expired — cancel whatever is left
      if (pendingSells.length > 0) {
        this._log(
          `[${this.slug}] Slot expired with ${pendingSells.length} unfilled SELL order(s) — cancelling`,
          "yellow",
        );
        const response = await this._cancelOrders(
          pendingSells.map((o) => o.orderId),
        );
        // Force-remove any not_canceled (slot is over, nothing we can do)
        for (const id of Object.keys(response.not_canceled)) {
          this._removePendingOrder(id);
        }
      }
      await this._waitForResolution();
      this._computePnl();
      await this._autoRedeem();
      this._setState("DONE");
      return;
    }

    // Check expiries for remaining sells
    await this._checkExpiries();

    if (this._pendingOrders.length === 0 && this._inFlight === 0) {
      if (this._hasUnfilledPositions()) {
        await this._waitForResolution();
        this._computePnl();
        await this._autoRedeem();
      } else {
        this._computePnl();
      }
      this._setState("DONE");
    }
  }

  /**
   * Cancel any orders that have passed their expireAtMs.
   * Fills arrive via user channel callbacks — this only handles expiry.
   */
  private async _checkExpiries(): Promise<void> {
    const now = Date.now();
    for (const pending of this._pendingOrders) {
      if (now < pending.expireAtMs) continue;
      // Defer expiry for orders that have MATCHED but are awaiting MINED.
      // Cancelling here would race against the in-flight settlement — the
      // trade would be dropped and onFilled never fires.
      if (this._userChannel.isMatched(pending.orderId)) continue;
      // Read partial fill from channel BEFORE cancel (order still tracked here).
      const partialShares = this._userChannel.getMatchedSoFar(pending.orderId);
      // _cancelOrders untracks from channel BEFORE the API call (race-safe).
      await this._cancelOrders([pending.orderId]);
      if (partialShares > 0) {
        this._commitFill(pending, partialShares, 0);
      } else if (pending.onExpired) {
        this._marketLogger.log(this._createOrderEntry(pending, "expired"));
        void pending.onExpired();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Strategy-facing order APIs
  // ---------------------------------------------------------------------------

  /**
   * Fire-and-forget order placement. Returns immediately — do NOT await the
   * result to know if an order was placed. Use `onFilled` to react to a fill
   * and `onExpired` to react to a cancellation or failed placement.
   * Buys retry up to BUY_MAX_RETRIES times on balance errors; sells retry until slot end.
   */
  private _postOrders(requests: OrderRequest[]): void {
    const buys = requests.filter(
      (o) => o.req.action === "buy" && !this._buyBlocked,
    );
    const sells = requests.filter(
      (o) => o.req.action === "sell" && !this._sellBlocked,
    );

    const maxRetries = parseInt(process.env.BUY_MAX_RETRIES ?? "30", 10);
    const retryDelayMs = parseInt(process.env.BUY_RETRY_DELAY_MS ?? "500", 10);

    if (buys.length > 0) this._placeWithRetry(buys, retryDelayMs, maxRetries);
    if (sells.length > 0) this._placeWithRetry(sells, 500, Infinity);
  }

  private async _cancelOrders(
    orderIds: string[],
  ): Promise<CancelOrderResponse> {
    // Skip orders that have MATCHED but are awaiting MINED — cancelling them
    // would unlock the wallet here while the pending settlement still fires
    // onFilled later, double-counting the tracker.
    const cancellable = orderIds.filter(
      (id) => !this._userChannel.isMatched(id),
    );
    // untrack order to avoid "CANCELLATION" event in processOrderEvent
    for (const id of cancellable) this._userChannel.untrackOrder(id);

    const response = await this.client.cancelOrders(cancellable);
    for (const id of response.canceled) {
      const pending = this._pendingOrders.find((o) => o.orderId === id);
      if (pending) {
        this._trackerUnlock(pending);
        this._marketLogger.log(this._createOrderEntry(pending, "canceled"));
      }
      this._removePendingOrder(id);
    }
    return response;
  }

  private async _emergencySells(orderIds: string[]): Promise<void> {
    const sells = orderIds
      .map((id) =>
        this._pendingOrders.find(
          (o) => o.orderId === id && o.action === "sell",
        ),
      )
      .filter((o): o is PendingOrder => !!o);

    if (sells.length === 0) return;

    // Cancel all in batch
    const response = await this._cancelOrders(sells.map((o) => o.orderId));
    const canceledSells = sells.filter((s) =>
      response.canceled.includes(s.orderId),
    );

    if (canceledSells.length === 0) return;

    await Promise.all(
      canceledSells.map((sell) => this._emergencySellLoop(sell)),
    );
  }

  /**
   * Places a GTC sell at the current best bid and retries on rejection until
   * the order fills or the slot ends. Each retry reads a fresh best bid so the
   * price tracks the market.
   */
  private async _emergencySellLoop(sell: PendingOrder): Promise<void> {
    this._inFlight++;
    return (async () => {
      while (Date.now() < this.slotEndMs) {
        const side = sell.tokenId === this._clobTokenIds![0] ? "UP" : "DOWN";
        const bestBid =
          this._orderBook.bestBidPrice(side as "UP" | "DOWN") ?? sell.price;

        let filled = false;
        let failed = false;

        await new Promise<void>((resolve) => {
          this._placeWithRetry([
            {
              req: {
                tokenId: sell.tokenId,
                action: "sell" as const,
                price: bestBid,
                shares: sell.shares,
                orderType: "GTC" as const,
              },
              expireAtMs: Date.now() + 2000,
              onFilled: (_filledShares) => {
                filled = true;
                resolve();
              },
              onFailed: (reason) => {
                if (!reason.includes("not enough balance")) failed = true;
                resolve();
              },
              onExpired: () => {
                // GTC expired after 2s — retry with fresh bid
                failed = true;
                resolve();
              },
            },
          ]);
        });

        if (filled) break;
        if (!failed) break; // unexpected stop (e.g. sell blocked)
      }
    })()
      .catch((e) =>
        this._log(`[${this.slug}] _emergencySellLoop error: ${e}`, "red"),
      )
      .finally(() => {
        this._inFlight--;
      });
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Commit a fill: update tracker, record in history, remove from pending, log, fire callback.
   */
  private _commitFill(
    pending: PendingOrder,
    shares: number,
    fee: number,
  ): void {
    if (pending.action === "buy") {
      this._tracker.onBuyFilled(
        pending.orderId,
        pending.tokenId,
        pending.price,
        shares,
      );
    } else {
      this._tracker.onSellFilled(
        pending.orderId,
        pending.tokenId,
        pending.price,
        shares,
      );
    }
    this._orderHistory.push({
      action: pending.action,
      price: pending.price,
      shares,
      fee,
      tokenId: pending.tokenId,
    });
    this._removePendingOrder(pending.orderId);
    this._marketLogger.log(
      this._createOrderEntry(pending, "filled", { shares }),
    );
    if (pending.onFilled) pending.onFilled(shares);
  }

  /**
   * Fire-and-forget: places orders and retries any that fail with a balance
   * error (350 ms apart) until the slot ends or all orders are placed.
   */
  private _placeWithRetry(
    items: Array<OrderRequest>,
    retryDelayMs = 350,
    maxRetries = Infinity,
  ): void {
    this._inFlight++;
    (async () => {
      let remaining = [...items];
      let retryCount = 0;
      while (remaining.length > 0) {
        // Stop retrying if the relevant block flag was set after this loop started
        const beforeBlock = remaining.length;
        remaining = remaining.filter((item) => {
          if (item.req.action === "buy" && this._buyBlocked) return false;
          if (item.req.action === "sell" && this._sellBlocked) return false;
          return true;
        });
        if (remaining.length === 0) {
          // log if blocked, take 0 item assuming all item kinds are same from postOrder
          if (beforeBlock > 0) {
            const kind = items[0]!.req.action === "buy" ? "buy" : "sell";
            this._log(
              `[${this.slug}] Retry stopped: ${kind} is blocked`,
              "yellow",
            );
          }
          break;
        }

        // Pre-flight: drop orders past their expiry
        remaining = remaining.filter((item) => {
          if (Date.now() >= item.expireAtMs) {
            if (item.onFailed) item.onFailed("order expired before placement");
            return false;
          }
          return true;
        });
        if (remaining.length === 0) break;

        // Pre-flight: skip network call for orders the tracker knows will fail
        const retryNext: typeof remaining = [];
        remaining = remaining.filter((item) => {
          const ok =
            item.req.action === "buy"
              ? this._tracker.canPlaceBuy(item.req.price, item.req.shares)
              : this._tracker.canPlaceSell(item.req.tokenId, item.req.shares);
          if (!ok) retryNext.push(item);
          return ok;
        });
        if (remaining.length === 0) {
          if (retryCount === 0) {
            // log if balance too low, take 0 item assuming all item kinds are same from postOrder
            const kind = retryNext[0]!.req.action === "buy" ? "buy" : "sell";
            this._log(
              `[${this.slug}] Retry stopped: wallet balance too low to place ${kind}`,
              "yellow",
            );
          }
          remaining = retryNext;
          retryCount++;
          if (retryCount >= maxRetries) {
            for (const item of remaining) {
              if (item.onFailed) item.onFailed("not enough balance");
            }
            break;
          }
          await new Promise((r) => setTimeout(r, retryDelayMs));
          continue;
        }

        const placed = await this.client.postMultipleOrders(
          remaining.map((r) => ({
            ...r.req,
            tickSize: this._orderBook.getTickSize(r.req.tokenId),
            feeRateBps: this._orderBook.getFeeRate(r.req.tokenId),
            negRisk: false,
          })),
        );

        for (let i = 0; i < placed.length; i++) {
          const p = placed[i];
          const item = remaining[i]!;
          if (!p || !p.orderId) {
            if (
              p?.errorMsg?.includes("not enough balance") &&
              Date.now() < this.slotEndMs &&
              retryCount < maxRetries
            ) {
              // Parse actual balance from CLOB error and adjust shares
              const balMatch = p.errorMsg.match(
                /balance:\s*(\d+).*?order amount:\s*(\d+)/,
              );
              if (balMatch) {
                const actualBalance = parseInt(balMatch[1]!, 10);
                const orderAmount = parseInt(balMatch[2]!, 10);
                if (actualBalance > 0 && actualBalance < orderAmount) {
                  item.req.shares = actualBalance / 1e6;
                }
              }
              retryNext.push(item);
            } else {
              const reason = p?.errorMsg ?? "unknown";
              const side =
                item.req.tokenId === this._clobTokenIds?.[0] ? "UP" : "DOWN";
              this._log(
                `[${this.slug}] Order placement failed (${item.req.action.toUpperCase()} ${side} @ ${item.req.price}): ${reason}`,
                "red",
              );
              if (item.onFailed) item.onFailed(reason);
            }
            continue;
          }
          this._trackerLock(item, p);
          this._pendingOrders.push({
            orderId: p.orderId,
            tokenId: item.req.tokenId,
            action: item.req.action,
            orderType: item.req.orderType,
            price: item.req.price,
            shares: item.req.shares,
            expireAtMs: item.expireAtMs,
            placedAtMs: Date.now(),
            onFilled: item.onFilled,
            onExpired: item.onExpired,
            onFailed: item.onFailed,
          });
          this._marketLogger.log(this._createOrderEntry(item.req, "placed"));

          // Wrap the OrderRequest with fill accounting and register with the user channel.
          // The channel calls wrapped.onFilled when the order is fully settled on-chain.
          const orderId = p.orderId;
          const wrapped: OrderRequest = {
            req: item.req,
            expireAtMs: item.expireAtMs,
            onFilled: (gross) => {
              const pending = this._pendingOrders.find(
                (o) => o.orderId === orderId,
              );
              if (!pending) return;
              let fee = 0;
              if (pending.orderType === "FOK" && this._feeRate > 0) {
                fee =
                  gross * this._feeRate * pending.price * (1 - pending.price);
              }
              const net =
                pending.action === "buy" && fee > 0
                  ? gross - fee / pending.price
                  : gross;
              this._commitFill(pending, net, fee);
            },
            onFailed: (reason) => {
              const pending = this._pendingOrders.find(
                (o) => o.orderId === orderId,
              );
              if (!pending) return;
              this._removePendingOrder(orderId);
              this._trackerUnlock(pending);
              this._marketLogger.log(
                this._createOrderEntry(pending, "failed", { reason }),
              );
              item.onFailed?.(reason);
            },
          };
          this._userChannel.trackOrder(orderId, wrapped);
        }

        if (retryNext.length === 0) break;
        remaining = retryNext;
        retryCount++;
        if (retryCount % 5 === 0) {
          const summary = retryNext
            .map((r) => {
              const side =
                r.req.tokenId === this._clobTokenIds?.[0] ? "UP" : "DOWN";
              return `${r.req.action.toUpperCase()} ${side} @ ${r.req.price} (shares: ${r.req.shares})`;
            })
            .join(", ");
          const errors = placed
            ?.filter((p) => p?.errorMsg)
            .map((p) => p!.errorMsg)
            .join("; ");
          this._log(
            `[${this.slug}] Balance not ready — retrying (attempt ${retryCount}): ${summary} | error: ${errors || "pre-flight rejected"}`,
            "yellow",
          );
        }
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    })()
      .catch((e) =>
        this._log(`[${this.slug}] _placeWithRetry error: ${e}`, "red"),
      )
      .finally(() => {
        this._inFlight--;
      });
  }

  private _removePendingOrder(orderId: string): void {
    const idx = this._pendingOrders.findIndex((o) => o.orderId === orderId);
    if (idx !== -1) this._pendingOrders.splice(idx, 1);
  }

  private async _cancelPendingBuys(): Promise<void> {
    const buys = this._pendingOrders.filter((o) => o.action === "buy");
    if (buys.length === 0) return;

    this._log(
      `[${this.slug}] Cancelling ${buys.length} pending BUY order(s)`,
      "yellow",
    );
    await this._cancelOrders(buys.map((o) => o.orderId));
  }

  private _side(tokenId: string): "UP" | "DOWN" {
    return tokenId === this._clobTokenIds?.[0] ? "UP" : "DOWN";
  }

  private _createOrderEntry(
    order: {
      action: "buy" | "sell";
      tokenId: string;
      price: number;
      shares: number;
    },
    status: "placed" | "filled" | "failed" | "expired" | "canceled",
    opts?: { shares?: number; reason?: string },
  ) {
    return {
      type: "order" as const,
      action: order.action,
      side: this._side(order.tokenId),
      price: order.price,
      shares: opts?.shares ?? order.shares,
      status,
      reason: opts?.reason,
    };
  }

  /** Lock tracker reservation for a pending order (buy or sell). */
  private _trackerLock(req: OrderRequest, order: PlacedOrder): void {
    const side = this._side(req.req.tokenId);
    const label = `[${this.slug}] ${req.req.action.toUpperCase()} ${side} @ ${req.req.price}`;
    if (req.req.action === "buy") {
      this._tracker.lockForBuy(
        order.orderId,
        req.req.price,
        req.req.shares,
        label,
      );
    } else {
      this._tracker.lockForSell(
        order.orderId,
        req.req.tokenId,
        req.req.shares,
        label,
      );
    }
  }

  /** Unlock tracker reservation for a pending order (buy or sell). */
  private _trackerUnlock(pending: PendingOrder): void {
    const side = this._side(pending.tokenId);
    const label = `[${this.slug}] ${pending.action.toUpperCase()} ${side} @ ${pending.price}`;
    if (pending.action === "buy")
      this._tracker.unlockBuy(pending.orderId, label);
    else this._tracker.unlockSell(pending.orderId, label);
  }

  private _hasUnfilledPositions(): boolean {
    const held = new Map<string, number>();
    for (const o of this._orderHistory) {
      const cur = held.get(o.tokenId) ?? 0;
      if (o.action === "buy") held.set(o.tokenId, cur + o.shares);
      else held.set(o.tokenId, cur - o.shares);
    }
    for (const shares of held.values()) {
      if (shares > 0) return true;
    }
    return false;
  }

  private async _autoRedeem(): Promise<void> {
    if (!this._conditionId) return; // belt-and-suspenders

    this._log(`[${this.slug}] Redeeming positions...`, "dim");
    try {
      await this.client.redeemPositions(this._conditionId, true);
      this._log(`[${this.slug}] Redemption successful`, "green");
    } catch (e) {
      this._log(`[${this.slug}] Redemption failed: ${e}`, "red");
    }
  }

  private async _waitForResolution(): Promise<void> {
    const slot = slotFromSlug(this.slug);
    if (!this._marketPriceHandle) {
      this._marketPriceHandle = this.apiQueue.queueMarketPrice(slot);
    }
    while (true) {
      const data = this.apiQueue.marketResult.get(slot.startTime);
      if (data?.closePrice) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  private _computePnl(): void {
    let pnl = 0;
    const held = new Map<string, number>();

    for (const o of this._orderHistory) {
      if (o.action === "sell") pnl += o.price * o.shares;
      else pnl -= o.price * o.shares;
      pnl -= o.fee ?? 0;

      const cur = held.get(o.tokenId) ?? 0;
      if (o.action === "buy") held.set(o.tokenId, cur + o.shares);
      else held.set(o.tokenId, cur - o.shares);
    }

    const slot = slotFromSlug(this.slug);
    const data = this.apiQueue.marketResult.get(slot.startTime);

    if (data?.closePrice) {
      const resolvedUp = data.closePrice > data.openPrice;
      const upToken = this._clobTokenIds![0];
      let unfilledShares = 0;
      let payout = 0;

      for (const [tokenId, shares] of held) {
        if (shares <= 0) continue;
        unfilledShares += shares;
        const isUp = tokenId === upToken;
        const payoutPerShare =
          (resolvedUp && isUp) || (!resolvedUp && !isUp) ? 1.0 : 0.0;
        payout += shares * payoutPerShare;
      }
      pnl += payout;

      this._tracker.onResolution(held, payout);
      this._pnl = parseFloat(pnl.toFixed(4));
      this._log(
        `[${this.slug}] Resolved ${resolvedUp ? "UP" : "DOWN"}. PnL: ${this._pnl >= 0 ? "+" : ""}$${this._pnl.toFixed(2)}`,
        this._pnl >= 0 ? "green" : "red",
      );
      this._marketLogger.log({
        type: "resolution",
        direction: resolvedUp ? "UP" : "DOWN",
        openPrice: data.openPrice,
        closePrice: data.closePrice,
        unfilledShares,
        payout,
        pnl: this._pnl,
      });
    } else {
      this._pnl = parseFloat(pnl.toFixed(4));
      this._log(
        `[${this.slug}] Settled. PnL: ${this._pnl >= 0 ? "+" : ""}$${this._pnl.toFixed(2)}`,
        this._pnl >= 0 ? "green" : "red",
      );
    }
  }
}
