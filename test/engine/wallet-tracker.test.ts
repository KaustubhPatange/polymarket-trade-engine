import { describe, test, expect } from "bun:test";
import { WalletTracker } from "../../engine/wallet-tracker.ts";

const UP = "UP_TOKEN";
const DOWN = "DOWN_TOKEN";

function makeTracker(balance = 100) {
  return new WalletTracker(balance);
}

describe("canPlaceBuy", () => {
  test("returns true when available >= price * shares", () => {
    const t = makeTracker(10);
    expect(t.canPlaceBuy(0.5, 6)).toBe(true); // 3.00 <= 10
  });

  test("returns false when available < price * shares", () => {
    const t = makeTracker(2);
    expect(t.canPlaceBuy(0.5, 6)).toBe(false); // 3.00 > 2
  });

  test("accounts for existing buy reservations", () => {
    const t = makeTracker(10);
    t.lockForBuy("order-1", 0.5, 6, "test"); // reserves 3.00, available = 7
    expect(t.canPlaceBuy(0.5, 6)).toBe(true); // available 7 >= cost 3 → true
  });

  test("returns false when reserved amount leaves insufficient balance", () => {
    const t = makeTracker(5);
    t.lockForBuy("order-1", 0.5, 6, "test"); // reserves 3.00, available = 2
    expect(t.canPlaceBuy(0.5, 6)).toBe(false); // needs 3.00, available = 2
  });
});

describe("lockForBuy / unlockBuy", () => {
  test("lockForBuy reduces available balance", () => {
    const t = makeTracker(10);
    t.lockForBuy("o1", 0.5, 6, "test");
    expect(t.available).toBeCloseTo(7); // 10 - 3
  });

  test("unlockBuy restores balance", () => {
    const t = makeTracker(10);
    t.lockForBuy("o1", 0.5, 6, "test");
    t.unlockBuy("o1", "test");
    expect(t.available).toBeCloseTo(10);
  });

  test("unlockBuy on unknown id is a no-op", () => {
    const t = makeTracker(10);
    expect(() => t.unlockBuy("unknown", "test")).not.toThrow();
    expect(t.available).toBe(10);
  });
});

describe("onBuyFilled", () => {
  test("deducts balance and adds shares", () => {
    const t = makeTracker(10);
    t.lockForBuy("o1", 0.5, 6, "test");
    t.onBuyFilled("o1", UP, 0.5, 6);
    expect(t.balance).toBeCloseTo(7); // 10 - 3
    expect(t.availableShares(UP)).toBe(6);
  });

  test("partial fill after cancel: deducts actual cost (no reservation)", () => {
    const t = makeTracker(10);
    // No lock — reservation already cleared by cancel
    t.onBuyFilled("o1", UP, 0.5, 3);
    expect(t.balance).toBeCloseTo(8.5); // 10 - 1.5
    expect(t.availableShares(UP)).toBe(3);
  });
});

describe("canPlaceSell", () => {
  test("returns true when available shares >= shares", () => {
    const t = makeTracker(10);
    t.lockForBuy("o1", 0.5, 6, "test");
    t.onBuyFilled("o1", UP, 0.5, 6);
    expect(t.canPlaceSell(UP, 6)).toBe(true);
  });

  test("returns false when not enough shares", () => {
    const t = makeTracker(10);
    expect(t.canPlaceSell(UP, 6)).toBe(false); // no shares
  });

  test("accounts for existing sell reservations", () => {
    const t = makeTracker(10);
    t.lockForBuy("o1", 0.5, 6, "test");
    t.onBuyFilled("o1", UP, 0.5, 6);
    t.lockForSell("s1", UP, 4, "test"); // reserves 4
    expect(t.canPlaceSell(UP, 4)).toBe(false); // only 2 free
  });
});

describe("lockForSell / unlockSell", () => {
  test("lockForSell reduces availableShares", () => {
    const t = makeTracker(10);
    t.lockForBuy("o1", 0.5, 6, "test");
    t.onBuyFilled("o1", UP, 0.5, 6);
    t.lockForSell("s1", UP, 4, "test");
    expect(t.availableShares(UP)).toBe(2);
  });

  test("unlockSell restores availableShares", () => {
    const t = makeTracker(10);
    t.lockForBuy("o1", 0.5, 6, "test");
    t.onBuyFilled("o1", UP, 0.5, 6);
    t.lockForSell("s1", UP, 4, "test");
    t.unlockSell("s1", "test");
    expect(t.availableShares(UP)).toBe(6);
  });
});

describe("onSellFilled", () => {
  test("removes shares and credits balance", () => {
    const t = makeTracker(10);
    t.lockForBuy("o1", 0.5, 6, "test");
    t.onBuyFilled("o1", UP, 0.5, 6);
    const balanceBefore = t.balance;
    t.lockForSell("s1", UP, 6, "test");
    t.onSellFilled("s1", UP, 0.64, 6);
    expect(t.availableShares(UP)).toBe(0);
    expect(t.balance).toBeCloseTo(balanceBefore + 0.64 * 6);
  });
});

describe("onResolution", () => {
  test("winning token: credits payout and zeroes shares", () => {
    const t = makeTracker(10);
    t.lockForBuy("o1", 0.5, 6, "test");
    t.onBuyFilled("o1", UP, 0.5, 6);
    const balanceBefore = t.balance;
    const held = new Map([[UP, 6]]);
    t.onResolution(held, 6); // $6 payout (6 shares × $1)
    expect(t.availableShares(UP)).toBe(0);
    expect(t.balance).toBeCloseTo(balanceBefore + 6);
  });

  test("losing token: zeroes shares, no balance change", () => {
    const t = makeTracker(10);
    t.lockForBuy("o1", 0.5, 6, "test");
    t.onBuyFilled("o1", DOWN, 0.5, 6);
    const balanceBefore = t.balance;
    const held = new Map([[DOWN, 6]]);
    t.onResolution(held, 0); // $0 payout
    expect(t.availableShares(DOWN)).toBe(0);
    expect(t.balance).toBeCloseTo(balanceBefore);
  });
});
