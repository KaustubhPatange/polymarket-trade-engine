type ReservedSell = { tokenId: string; count: number };

export class WalletTracker {
  private _balance: number;
  private _reservedForBuys = new Map<string, number>(); // orderId -> cost
  private _shares = new Map<string, number>(); // tokenId -> share count
  private _reservedForSells = new Map<string, ReservedSell>(); // orderId -> { tokenId, count }
  private _log: (msg: string) => void;

  constructor(
    initialBalance: number,
    log?: (msg: string) => void,
  ) {
    this._balance = initialBalance;
    this._log = log ?? (() => {});
    this._log(`[wallet] Init: $${initialBalance.toFixed(2)}`);
  }

  get available(): number {
    let reserved = 0;
    for (const cost of this._reservedForBuys.values()) reserved += cost;
    return this._balance - reserved;
  }

  get balance(): number {
    return this._balance;
  }

  availableShares(tokenId: string): number {
    const total = this._shares.get(tokenId) ?? 0;
    let reserved = 0;
    for (const r of this._reservedForSells.values()) {
      if (r.tokenId === tokenId) reserved += r.count;
    }
    return total - reserved;
  }

  canPlaceBuy(price: number, shares: number): boolean {
    return this.available >= price * shares;
  }

  canPlaceSell(tokenId: string, shares: number): boolean {
    return this.availableShares(tokenId) >= shares;
  }

  // -- Buy lifecycle --

  lockForBuy(orderId: string, price: number, shares: number, label: string): void {
    const cost = price * shares;
    this._reservedForBuys.set(orderId, cost);
    this._log(
      `[wallet] lockBuy ${label}: -$${cost.toFixed(2)} | avail=$${this.available.toFixed(2)}`,
    );
  }

  unlockBuy(orderId: string, label: string): void {
    const cost = this._reservedForBuys.get(orderId);
    if (cost == null) return;
    this._reservedForBuys.delete(orderId);
    this._log(
      `[wallet] unlockBuy ${label}: +$${cost.toFixed(2)} | avail=$${this.available.toFixed(2)}`,
    );
  }

  /** Buy filled: USDC leaves wallet, shares added optimistically. */
  onBuyFilled(orderId: string, tokenId: string, shareCount: number): void {
    const cost = this._reservedForBuys.get(orderId);
    if (cost == null) return;
    this._reservedForBuys.delete(orderId);
    this._balance -= cost;

    const current = this._shares.get(tokenId) ?? 0;
    this._shares.set(tokenId, current + shareCount);

    this._log(
      `[wallet] buyFill(${orderId}): balance=$${this._balance.toFixed(2)}, ` +
        `${tokenId.slice(0, 8)}... shares: ${current} + ${shareCount} = ${current + shareCount}`,
    );
  }

  // -- Sell lifecycle --

  lockForSell(orderId: string, tokenId: string, shares: number, label: string): void {
    this._reservedForSells.set(orderId, { tokenId, count: shares });
    this._log(
      `[wallet] lockSell ${label}: -${shares} shares | availShares=${this.availableShares(tokenId)}`,
    );
  }

  unlockSell(orderId: string, label: string): void {
    const r = this._reservedForSells.get(orderId);
    if (!r) return;
    this._reservedForSells.delete(orderId);
    this._log(
      `[wallet] unlockSell ${label}: +${r.count} shares | availShares=${this.availableShares(r.tokenId)}`,
    );
  }

  /** Sell filled: shares leave wallet, USDC credited optimistically. */
  onSellFilled(
    orderId: string,
    tokenId: string,
    sellPrice: number,
    shareCount: number,
  ): void {
    this._reservedForSells.delete(orderId);

    const current = this._shares.get(tokenId) ?? 0;
    this._shares.set(tokenId, Math.max(0, current - shareCount));

    const proceeds = sellPrice * shareCount;
    this._balance += proceeds;

    this._log(
      `[wallet] sellFill(${orderId}): ${tokenId.slice(0, 8)}... shares: ${current} - ${shareCount} = ${Math.max(0, current - shareCount)}, ` +
        `balance=$${this._balance.toFixed(2)}`,
    );
  }

  // -- Direct adjustments (for sim recovery) --

  debit(amount: number): void {
    this._balance -= amount;
  }
  credit(amount: number): void {
    this._balance += amount;
  }

  addAvailableShares(tokenId: string, count: number): void {
    const current = this._shares.get(tokenId) ?? 0;
    this._shares.set(tokenId, current + count);
  }

  /** Called when a market resolves: credits USDC payout and clears held shares. */
  onResolution(held: Map<string, number>, payout: number): void {
    for (const [tokenId, shares] of held) {
      if (shares > 0) this._shares.set(tokenId, 0);
    }
    if (payout > 0) {
      this._balance += payout;
      this._log(
        `[wallet] resolution payout: +$${payout.toFixed(2)} | balance=$${this._balance.toFixed(2)}`,
      );
    }
  }

}
