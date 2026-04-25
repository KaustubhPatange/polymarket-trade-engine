/**
 * Minimal TickerTracker stand-in for tests.
 * Has the same public interface used by MarketLifecycle and strategies.
 */
export class SimTickerTracker {
  private _price: number | undefined;
  private _binancePrice: number | undefined;
  private _coinbasePrice: number | undefined;
  private _divergence: number | null = null;

  get price() {
    return this._price;
  }

  get binancePrice() {
    return this._binancePrice;
  }

  get coinbasePrice() {
    return this._coinbasePrice;
  }

  get divergence(): number | null {
    return this._divergence;
  }

  get isKillswitch(): boolean {
    return false;
  }

  get isWhaleDump(): boolean {
    return false;
  }

  setTicker(event: {
    assetPrice: number;
    binancePrice: number;
    coinbasePrice: number;
    divergence: number;
  }): void {
    this._price = event.assetPrice;
    this._binancePrice = event.binancePrice;
    this._coinbasePrice = event.coinbasePrice;
    this._divergence = event.divergence;
  }

  // ── Methods required by EarlyBird.start() ──────────────────────────────────
  schedule(): void {}
  async waitForReady(): Promise<void> {}
  destroy(): void {}
}
