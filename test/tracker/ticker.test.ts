import { describe, test, expect, beforeEach, afterEach } from "bun:test";

// Binance blocks WebSocket connections from cloud/datacenter IPs (e.g. GitHub Actions / AWS).
const isCI = !!process.env.CI;
import { TickerTracker } from "../../tracker/ticker.ts";

describe("TickerTracker", () => {
  let tracker: TickerTracker;
  let savedTicker: string | undefined;
  let savedAsset: string | undefined;
  let savedWindow: string | undefined;

  beforeEach(() => {
    savedTicker = process.env.TICKER;
    savedAsset = process.env.MARKET_ASSET;
    savedWindow = process.env.MARKET_WINDOW;
    process.env.MARKET_ASSET = "btc";
    process.env.MARKET_WINDOW = "5m";
  });

  afterEach(() => {
    tracker?.destroy();
    if (savedTicker === undefined) delete process.env.TICKER;
    else process.env.TICKER = savedTicker;
    if (savedAsset === undefined) delete process.env.MARKET_ASSET;
    else process.env.MARKET_ASSET = savedAsset;
    if (savedWindow === undefined) delete process.env.MARKET_WINDOW;
    else process.env.MARKET_WINDOW = savedWindow;
  });

  test.skipIf(isCI)(
    "Binance ticker streams a price",
    async () => {
      process.env.TICKER = "binance";
      tracker = new TickerTracker();
      tracker.schedule();
      await tracker.waitForReady();
      expect(tracker.binancePrice).toBeGreaterThan(0);
      expect(Number.isFinite(tracker.binancePrice!)).toBe(true);
    },
    10_000,
  );

  test(
    "Coinbase ticker streams a price",
    async () => {
      process.env.TICKER = "coinbase";
      tracker = new TickerTracker();
      tracker.schedule();
      await tracker.waitForReady();
      expect(tracker.coinbasePrice).toBeGreaterThan(0);
      expect(Number.isFinite(tracker.coinbasePrice!)).toBe(true);
    },
    10_000,
  );

  test("divergence, isWhaleDump, isKillswitch reflect injected prices", () => {
    tracker = new TickerTracker();
    const t = tracker as any;

    // No prices yet — divergence should be null, flags false
    expect(tracker.divergence).toBeNull();
    expect(tracker.isWhaleDump).toBe(false);
    expect(tracker.isKillswitch).toBe(false);

    // Normal prices, negligible divergence
    t.binanceValue = 100_000;
    t.coinbaseValue = 100_010;
    expect(tracker.divergence).toBeCloseTo(10, 2);
    expect(tracker.isWhaleDump).toBe(false); // 10 < 150 (0.15% of 100k)
    expect(tracker.isKillswitch).toBe(false); // 10 < 50

    // Whale dump + killswitch: divergence > 0.15% of Binance ($150) and > $50
    t.coinbaseValue = 100_200;
    expect(tracker.divergence).toBeCloseTo(200, 2);
    expect(tracker.isWhaleDump).toBe(true);  // 200 > 150 (0.15% of 100k)
    expect(tracker.isKillswitch).toBe(true); // 200 > 50

    // Killswitch only: divergence > $50 but < $150 — not a whale dump
    t.binanceValue = 100_000;
    t.coinbaseValue = 100_060;
    expect(tracker.divergence).toBeCloseTo(60, 2);
    expect(tracker.isKillswitch).toBe(true);
    expect(tracker.isWhaleDump).toBe(false); // 60 < 150 (0.15% of 100k)
  });

  test.skipIf(isCI)(
    "OKX ticker streams a price",
    async () => {
      process.env.TICKER = "okx";
      tracker = new TickerTracker();
      tracker.schedule();
      await tracker.waitForReady();
      expect(tracker.okxPrice).toBeGreaterThan(0);
      expect(Number.isFinite(tracker.okxPrice!)).toBe(true);
    },
    15_000,
  );

  test.skipIf(isCI)(
    "ByBit ticker streams a price",
    async () => {
      process.env.TICKER = "bybit";
      tracker = new TickerTracker();
      tracker.schedule();
      await tracker.waitForReady();
      expect(tracker.bybitPrice).toBeGreaterThan(0);
      expect(Number.isFinite(tracker.bybitPrice!)).toBe(true);
    },
    15_000,
  );

  test(
    "Polymarket ticker streams a price",
    async () => {
      process.env.TICKER = "polymarket";
      tracker = new TickerTracker();
      tracker.schedule();
      await tracker.waitForReady();
      expect(tracker.price).toBeGreaterThan(0);
      expect(Number.isFinite(tracker.price!)).toBe(true);
    },
    15_000,
  );
});
