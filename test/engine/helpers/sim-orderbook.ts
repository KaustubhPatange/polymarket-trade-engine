import { OrderBook } from "../../../tracker/orderbook.ts";
import { PriceLevelMap } from "../../../utils/price-level-map.ts";

type PriceLevel = [number, number]; // [price, size]

type SideSnapshot = {
  bids: PriceLevel[];
  asks: PriceLevel[];
};

/**
 * An OrderBook subclass for testing that:
 * - Skips all WebSocket work (subscribe / waitForReady / destroy are no-ops)
 * - Allows direct state injection via setSnapshot / setTickSize / setFeeRate
 */
export class SimOrderBook extends OrderBook {
  override subscribe(_clobTokenIds: string[]): void {
    // Store asset IDs so the inherited accessor methods work
    (this as any).assetIds = _clobTokenIds;
  }

  override waitForReady(): Promise<void> {
    return Promise.resolve();
  }

  override destroy(): void {}

  setSnapshot(
    upTokenId: string,
    downTokenId: string,
    up: SideSnapshot,
    down: SideSnapshot,
  ): void {
    (this as any).assetIds = [upTokenId, downTokenId];

    const buildBook = (snap: SideSnapshot) => ({
      bids: buildMap("desc", snap.bids),
      asks: buildMap("asc", snap.asks),
    });

    this.books.set(upTokenId, buildBook(up));
    this.books.set(downTokenId, buildBook(down));
  }

  setTickSize(tokenId: string, tickSize: string): void {
    this.tickSizes.set(tokenId, tickSize);
  }

  setFeeRate(tokenId: string, bps: number): void {
    this.feeRates.set(tokenId, bps);
  }

  applyLogSnapshot(
    upTokenId: string,
    downTokenId: string,
    event: { up: SideSnapshot | null; down: SideSnapshot | null },
  ): void {
    if (event.up) {
      this.books.set(upTokenId, {
        bids: buildMap("desc", event.up.bids),
        asks: buildMap("asc", event.up.asks),
      });
    }
    if (event.down) {
      this.books.set(downTokenId, {
        bids: buildMap("desc", event.down.bids),
        asks: buildMap("asc", event.down.asks),
      });
    }
  }
}

function buildMap(order: "asc" | "desc", levels: PriceLevel[]): PriceLevelMap {
  const map = new PriceLevelMap(order);
  for (const [price, size] of levels) {
    map.set(price, size);
  }
  return map;
}
