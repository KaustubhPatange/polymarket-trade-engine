import { PriceLevelMap } from "../utils/price-level-map.ts";
import { renderOrderBookTable } from "../utils/orderbook-table.ts";
import { Env } from "../utils/config.ts";

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

type OrderLevel = { price: string; size: string };

type BookMessage = {
  asset_id: string;
  bids: OrderLevel[];
  asks: OrderLevel[];
  // first book event always contains tick size
  tick_size?: string;
  event_type: "book";
};

type PriceChangeMessage = {
  price_changes: {
    asset_id: string;
    price: string;
    size: string;
    side: string;
    best_bid: string;
    best_ask: string;
  }[];
  event_type: "price_change";
};

type TickSizeChangeMessage = {
  event_type: "tick_size_change";
  asset_id: string;
  new_tick_size: string;
};

type LastTradePriceMessage = {
  event_type: "last_trade_price";
  asset_id: string;
  fee_rate_bps: string;
};

type AssetBook = {
  bids: PriceLevelMap; // desc — best = highest bid
  asks: PriceLevelMap; // asc  — best = lowest ask
};

export class OrderBook {
  private ws?: WebSocket;
  private assetIds: string[] = ["", ""];
  private books = new Map<string, AssetBook>();
  private tickSizes = new Map<string, string>(); // tokenId -> tickSize
  private feeRates = new Map<string, number>(); // tokenId -> feeRateBps

  subscribe(clobTokenIds: string[]) {
    this.destroy();
    this.assetIds = clobTokenIds;
    this.books.clear();
    this.tickSizes.clear();
    this.feeRates.clear();

    this.ws = new WebSocket(WS_URL);

    this.ws.onopen = () => this.sendSubscription();
    this.ws.onmessage = (event) => this.handleMessage(event);
    this.ws.onerror = (err) => console.error("OrderBook WS error:", err);
    this.ws.onclose = () => {
      if (this.assetIds.length > 0) {
        setTimeout(() => this.subscribe(this.assetIds), 1000);
      }
    };
  }

  destroy() {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = undefined;
    }
  }

  private sendSubscription() {
    this.ws?.send(
      JSON.stringify({
        type: "market",
        assets_ids: this.assetIds,
      }),
    );
  }

  private handleMessage(event: MessageEvent) {
    if (!event.data) return;
    const data = JSON.parse(event.data as string);

    // Initial snapshot is an array of book messages
    if (Array.isArray(data)) {
      for (const book of data as BookMessage[]) {
        this.applyBookSnapshot(book);
      }
      return;
    }

    if (data.event_type === "book") {
      this.applyBookSnapshot(data as BookMessage);
    } else if (data.event_type === "price_change") {
      this.applyPriceChange(data as PriceChangeMessage);
    } else if (data.event_type === "tick_size_change") {
      const msg = data as TickSizeChangeMessage;
      this.tickSizes.set(msg.asset_id, msg.new_tick_size);
    } else if (data.event_type === "last_trade_price") {
      const msg = data as LastTradePriceMessage;
      this.feeRates.set(msg.asset_id, parseFloat(msg.fee_rate_bps));
    }
  }

  private getOrCreateBook(assetId: string): AssetBook {
    let book = this.books.get(assetId);
    if (!book) {
      book = {
        bids: new PriceLevelMap("desc"),
        asks: new PriceLevelMap("asc"),
      };
      this.books.set(assetId, book);
    }
    return book;
  }

  private applyBookSnapshot(msg: BookMessage) {
    const book = this.getOrCreateBook(msg.asset_id);
    book.bids.clear();
    book.asks.clear();
    for (const level of msg.bids) {
      book.bids.set(parseFloat(level.price), parseFloat(level.size));
    }
    for (const level of msg.asks) {
      book.asks.set(parseFloat(level.price), parseFloat(level.size));
    }
    if (msg.tick_size) {
      this.tickSizes.set(this.assetIds[0]!, msg.tick_size);
      this.tickSizes.set(this.assetIds[1]!, msg.tick_size);
    }
  }

  private applyPriceChange(msg: PriceChangeMessage) {
    for (const change of msg.price_changes) {
      const book = this.getOrCreateBook(change.asset_id);
      const map = change.side === "BUY" ? book.bids : book.asks;
      const size = parseFloat(change.size);
      if (size === 0) {
        map.delete(parseFloat(change.price));
      } else {
        map.set(parseFloat(change.price), size);
      }
    }
  }

  /**
   * Calculate how many shares you get and the payout for spending `amount` USDC
   * on an asset by walking the ask side of the order book.
   * Each share pays $1 if the outcome is correct.
   *
   * Returns { cost, shares, payout, toWin } or null if no book data.
   */
  private calculateBuy(assetId: string, amount: number) {
    const book = this.books.get(assetId);
    if (!book || book.asks.size === 0) return null;

    let remaining = amount;
    let totalShares = 0;

    for (const [price, size] of book.asks.entries()) {
      if (remaining <= 0) break;
      const costForAll = size * price;

      if (costForAll <= remaining) {
        totalShares += size;
        remaining -= costForAll;
      } else {
        totalShares += remaining / price;
        remaining = 0;
      }
    }

    // ideally remaining should be 0 i.e cost 10$
    // but in low liquidity markets we might not have enough asks
    const cost = amount - remaining;
    const payout = totalShares; // each share pays $1
    const profit = payout - cost;

    return { cost, shares: totalShares, payout, profit };
  }

  /** Get buy calculation for Up (index 0) and Down (index 1) */
  private getNetGain(amount: number) {
    if (this.assetIds.length < 2) return null;

    const up = this.calculateBuy(this.assetIds[0]!, amount);
    const down = this.calculateBuy(this.assetIds[1]!, amount);

    return { up, down };
  }

  private _fmtGain(r: ReturnType<typeof this.calculateBuy>, label: string) {
    if (!r) return `${label}: --`;
    return `${label}: $${r.profit.toFixed(2)}`;
  }

  /** Resolves once both UP and DOWN books have received their initial snapshot. */
  waitForReady(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (
        this.books.has(this.assetIds[0]!) &&
        this.books.has(this.assetIds[1]!)
      ) {
        resolve();
        return;
      }
      const interval = setInterval(() => {
        if (
          this.books.has(this.assetIds[0]!) &&
          this.books.has(this.assetIds[1]!)
        ) {
          clearInterval(interval);
          resolve();
        }
      }, 100);
    });
  }

  bestBidPrice(side: "UP" | "DOWN"): number | null {
    const assetId = side === "UP" ? this.assetIds[0]! : this.assetIds[1]!;
    return this.books.get(assetId)?.bids.best ?? null;
  }

  /** Best bid price and USDC value at that level { price, liquidity } */
  bestBidInfo(
    side: "UP" | "DOWN",
  ): { price: number; liquidity: number } | null {
    const assetId = side === "UP" ? this.assetIds[0]! : this.assetIds[1]!;
    const book = this.books.get(assetId);
    if (!book) return null;
    const price = book.bids.best;
    if (price === null) return null;
    const size = book.bids.get(price) ?? 0;
    return { price, liquidity: price * size };
  }

  getTokenId(side: "UP" | "DOWN"): string {
    return side === "UP" ? this.assetIds[0]! : this.assetIds[1]!;
  }

  /** Tick size for the given asset, or 0.01 if not yet received. */
  getTickSize(assetId: string): string {
    return this.tickSizes.get(assetId) ?? "0.01";
  }

  /** Fee rate in bps for the given asset, or 1000 if not yet received. */
  getFeeRate(assetId: string): number {
    return this.feeRates.get(assetId) ?? 1000;
  }

  /** Best ask price and USDC value at that level { price, liquidity } */
  bestAskInfo(
    side: "UP" | "DOWN",
  ): { price: number; liquidity: number } | null {
    const assetId = side === "UP" ? this.assetIds[0]! : this.assetIds[1]!;
    const book = this.books.get(assetId);
    if (!book) return null;
    const price = book.asks.best;
    if (price === null) return null;
    const size = book.asks.get(price) ?? 0;
    return { price, liquidity: price * size };
  }

  /** Structured snapshot of both books for logging. */
  getSnapshotData(): object {
    const toEntries = (
      map: { top: (n: number) => [number, number][] },
      depth: number,
    ) => map.top(depth).map(([price, size]) => [price, size]);

    const upBook = this.books.get(this.assetIds[0]!);
    const downBook = this.books.get(this.assetIds[1]!);
    const DEPTH = 5;
    return {
      up: upBook
        ? {
            bids: toEntries(upBook.bids, DEPTH),
            asks: toEntries(upBook.asks, DEPTH),
          }
        : null,
      down: downBook
        ? {
            bids: toEntries(downBook.bids, DEPTH),
            asks: toEntries(downBook.asks, DEPTH),
          }
        : null,
    };
  }

  /** Order book depth table + net gain as an array of display lines */
  getDisplayLines(amount: number): string[] {
    const { apiSymbol } = Env.getAssetConfig();
    if (this.assetIds.length < 2) return [`${apiSymbol} Order Book: Waiting...`];

    const upBook = this.books.get(this.assetIds[0]!);
    const downBook = this.books.get(this.assetIds[1]!);
    if (!upBook || !downBook) return [`${apiSymbol} Order Book: Waiting...`];

    const DEPTH = 5;
    const fmt = (v: number) => "$" + Math.round(v).toLocaleString();
    const liquidity =
      `UP   Ask: ${fmt(upBook.asks.totalLiquidity)}  Bid: ${fmt(upBook.bids.totalLiquidity)}` +
      `    DOWN   Ask: ${fmt(downBook.asks.totalLiquidity)}  Bid: ${fmt(downBook.bids.totalLiquidity)}`;

    const upFee = this.feeRates.get(this.assetIds[0]!);
    const downFee = this.feeRates.get(this.assetIds[1]!);

    return [
      liquidity,
      "\r",
      ...renderOrderBookTable(
        { bids: upBook.bids.top(DEPTH), asks: upBook.asks.top(DEPTH) },
        { bids: downBook.bids.top(DEPTH), asks: downBook.asks.top(DEPTH) },
        { upFee, downFee },
      ),
    ];
  }
}
