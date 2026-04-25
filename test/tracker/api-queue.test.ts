import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { APIQueue } from "../../tracker/api-queue.ts";

function waitFor(fn: () => boolean, timeout = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (fn()) return resolve();
      if (Date.now() - start > timeout)
        return reject(new Error("waitFor timeout"));
      setTimeout(check, 100);
    };
    check();
  });
}

describe("APIQueue", () => {
  let q: APIQueue;

  beforeEach(() => {
    process.env.MARKET_ASSET = "btc";
    process.env.MARKET_WINDOW = "5m";
    q = new APIQueue();
  });

  afterEach(() => {
    delete process.env.MARKET_ASSET;
    delete process.env.MARKET_WINDOW;
  });

  // --- Unit tests ---

  test("queueMarketPrice returns a cancel function", () => {
    const slot = { startTime: Date.now(), endTime: Date.now() + 300_000 };
    const result = q.queueMarketPrice(slot);
    expect(typeof result.cancel).toBe("function");
    result.cancel();
  });

  test("queueMarketPrice deduplicates: same slot queued only once", () => {
    const slot = { startTime: 999999, endTime: 999999 + 300_000 };
    const first = q.queueMarketPrice(slot);
    const second = q.queueMarketPrice(slot);
    expect((q as any)._queuedSlots.size).toBe(1);
    first.cancel();
    second.cancel();
  });

  test("cancel() aborts the in-flight request", async () => {
    const slot = {
      startTime: Date.now() + 1_000_000,
      endTime: Date.now() + 1_300_000,
    };
    const { cancel } = q.queueMarketPrice(slot);
    cancel();
    await Bun.sleep(200);
    expect(q.marketResult.has(slot.startTime)).toBe(false);
  });

  // --- Integration tests (real Polymarket API) ---

  test(
    "queueEventDetails fetches event data for a known slug",
    async () => {
      const slug = "btc-updown-5m-1776491100";
      await q.queueEventDetails(slug);
      const event = q.eventDetails.get(slug);
      expect(event).toBeDefined();
      expect(typeof event!.id).toBe("string");
      expect(typeof event!.ticker).toBe("string");
      expect(Array.isArray(event!.markets)).toBe(true);
      expect(event!.markets.length).toBeGreaterThan(0);
      expect(typeof event!.markets[0]!.clobTokenIds).toBe("string");
    },
    15_000,
  );

  test(
    "queueMarketPrice fetches complete data for a past slot",
    async () => {
      const slot = { startTime: 1776491100000, endTime: 1776491400000 };
      process.env.MARKET_ASSET = "btc";
      process.env.MARKET_WINDOW = "5m";
      const { cancel } = q.queueMarketPrice(slot);
      await waitFor(() => q.marketResult.has(slot.startTime), 15_000);
      cancel();
      const data = q.marketResult.get(slot.startTime)!;
      expect(typeof data.openPrice).toBe("number");
      expect(typeof data.closePrice).toBe("number");
    },
    20_000,
  );
});
