import type { MarketState, PersistentState } from "./state.ts";
import type { EarlyBirdClient } from "./client.ts";
import { MarketLifecycle } from "./market-lifecycle.ts";
import type { PendingOrder, CompletedOrder } from "./market-lifecycle.ts";
import { APIQueue } from "../tracker/api-queue.ts";
import type { LogColor } from "./log.ts";
import { strategies } from "./strategy/index.ts";
import type { WalletTracker } from "./wallet-tracker.ts";
import type { TickerTracker } from "../tracker/ticker";
import { slotFromSlug } from "../utils/slot.ts";

type LogFn = (msg: string, color?: LogColor) => void;

/**
 * Rebuild lifecycle state from a persisted snapshot.
 *
 * For each market in the saved state:
 * 1. Restore all pending orders into client
 * 2. Check fill status of each
 * 3. Filled orders → move to orderHistory
 * 4. Live orders → keep in pending list (no callbacks — drain mode)
 * 5. If only sells remain, resume as STOPPING
 * 6. If buys remain and slot expired, cancel all and skip
 */
export async function recover(
  state: PersistentState,
  client: EarlyBirdClient,
  apiQueue: APIQueue,
  logFn: LogFn,
  tracker: WalletTracker,
  ticker: TickerTracker,
): Promise<Map<string, MarketLifecycle>> {
  const lifecycles = new Map<string, MarketLifecycle>();

  for (const market of state.activeMarkets) {
    const lifecycle = await recoverMarket(
      market,
      client,
      apiQueue,
      logFn,
      tracker,
      ticker,
    );
    if (lifecycle) lifecycles.set(market.slug, lifecycle);
  }

  return lifecycles;
}

async function recoverMarket(
  market: MarketState,
  client: EarlyBirdClient,
  apiQueue: APIQueue,
  logFn: LogFn,
  tracker: WalletTracker,
  ticker: TickerTracker,
): Promise<MarketLifecycle | null> {
  const strategy = strategies[market.strategyName];
  if (!strategy) {
    logFn(
      `[startup] Unknown strategy "${market.strategyName}" for ${market.slug}. Skipping.`,
      "yellow",
    );
    return null;
  }

  const slotActive = Date.now() < slotFromSlug(market.slug).endTime;

  // Restore all pending orders into client
  for (const order of market.pendingOrders) {
    client.restoreOrder({
      id: order.orderId,
      tokenId: order.tokenId,
      action: order.action,
      price: order.price,
      shares: order.shares,
      actualShares: order.shares,
      status: "live",
    });
  }

  // Check fill status
  const orderStatuses = await Promise.all(
    market.pendingOrders.map((o) => client.getOrderById(o.orderId)),
  );

  const orderHistory: CompletedOrder[] = [...market.orderHistory];
  const stillPending: PendingOrder[] = [];

  for (let i = 0; i < market.pendingOrders.length; i++) {
    const order = market.pendingOrders[i]!;
    const status = orderStatuses[i];

    if (status?.status === "filled") {
      orderHistory.push({
        action: order.action,
        price: order.price,
        shares: order.shares,
        fee: 0,
        tokenId: order.tokenId,
      });
    } else if (status?.status === "live") {
      stillPending.push({
        orderId: order.orderId,
        tokenId: order.tokenId,
        action: order.action,
        price: order.price,
        shares: order.shares,
        expireAtMs: order.expireAtMs,
        placedAtMs: 0, // already confirmed live — bypass CLOB indexing grace period
        // No callbacks — recovered markets run in drain mode
      });
    }
  }

  const pendingBuys = stillPending.filter((o) => o.action === "buy");
  const pendingSells = stillPending.filter((o) => o.action === "sell");

  if (!slotActive) {
    // Slot expired — cancel everything remaining
    const toCancel = stillPending.map((o) => o.orderId);
    if (toCancel.length > 0) {
      logFn(
        `[startup] Cancelling ${toCancel.length} stale order(s) for ${market.slug}`,
        "yellow",
      );
      await client.cancelOrders(toCancel);
    }
    return null;
  }

  // Cancel any remaining buys — we can't reconstruct strategy callbacks
  if (pendingBuys.length > 0) {
    logFn(
      `[startup] Cancelling ${pendingBuys.length} BUY order(s) for ${market.slug} (cannot restore callbacks)`,
      "yellow",
    );
    await client.cancelOrders(pendingBuys.map((o) => o.orderId));
  }

  if (pendingSells.length === 0 && orderHistory.length === 0) {
    // Nothing to recover
    return null;
  }

  if (pendingSells.length === 0) {
    // All orders settled — nothing to do
    logFn(
      `[startup] All orders for ${market.slug} already settled. Skipping.`,
      "dim",
    );
    return null;
  }

  // Resume as STOPPING with only sell orders to drain
  logFn(
    `[startup] Resuming ${market.slug} in STOPPING with ${pendingSells.length} SELL order(s) to drain`,
  );
  return new MarketLifecycle({
    slug: market.slug,
    apiQueue,
    client,
    log: logFn,
    strategyName: market.strategyName,
    strategy,
    tracker,
    ticker,
    recovery: {
      state: "STOPPING",
      clobTokenIds: market.clobTokenIds,
      pendingOrders: pendingSells,
      orderHistory,
    },
  });
}
