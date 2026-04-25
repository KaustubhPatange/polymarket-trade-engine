import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  setMarketOffset,
  getSlotTS,
  getSlug,
  slotFromSlug,
} from "../../utils/slot.ts";

const BASE_TIMESTAMP = 1772568900;

describe("slot", () => {
  let savedWindow: string | undefined;
  let savedAsset: string | undefined;

  beforeEach(() => {
    savedWindow = process.env.MARKET_WINDOW;
    savedAsset = process.env.MARKET_ASSET;
    process.env.MARKET_WINDOW = "5m";
    process.env.MARKET_ASSET = "btc";
    setMarketOffset("+0");
  });

  afterEach(() => {
    setMarketOffset("+0");
    if (savedWindow === undefined) {
      delete process.env.MARKET_WINDOW;
    } else {
      process.env.MARKET_WINDOW = savedWindow;
    }
    if (savedAsset === undefined) {
      delete process.env.MARKET_ASSET;
    } else {
      process.env.MARKET_ASSET = savedAsset;
    }
  });

  test("getSlotTS returns start and end aligned to 5m intervals", () => {
    const slot = getSlotTS();
    expect(slot.endTime - slot.startTime).toBe(300_000);
  });

  test("getSlotTS with offset=1 returns next slot", () => {
    const current = getSlotTS(0);
    const next = getSlotTS(1);
    expect(next.startTime).toBe(current.endTime);
  });

  test("getSlotTS with offset=-1 returns previous slot", () => {
    const current = getSlotTS(0);
    const prev = getSlotTS(-1);
    expect(prev.endTime).toBe(current.startTime);
  });

  test("getSlug produces correct slug format", () => {
    const slug = getSlug();
    expect(slug).toMatch(/^btc-updown-5m-\d+$/);
  });

  test("slotFromSlug parses slug back to correct slot (roundtrip)", () => {
    const slug = getSlug();
    const fromSlug = slotFromSlug(slug);
    const fromTS = getSlotTS();
    expect(fromSlug.startTime).toBe(fromTS.startTime);
    expect(fromSlug.endTime).toBe(fromTS.endTime);
  });

  test("slotFromSlug parses 15m slug correctly", () => {
    const slug = `btc-updown-15m-${BASE_TIMESTAMP}`;
    const slot = slotFromSlug(slug);
    expect(slot.startTime).toBe(BASE_TIMESTAMP * 1000);
    expect(slot.endTime - slot.startTime).toBe(900_000);
  });

  test("setMarketOffset with +N shifts forward by N slots", () => {
    const before = getSlotTS();
    setMarketOffset("+2");
    const after = getSlotTS();
    expect(after.startTime).toBe(before.startTime + 2 * 300_000);
  });

  test("setMarketOffset with -N shifts backward by N slots", () => {
    const before = getSlotTS();
    setMarketOffset("-2");
    const after = getSlotTS();
    expect(after.startTime).toBe(before.startTime - 2 * 300_000);
  });

  test("setMarketOffset with timestamp aligns to that slot", () => {
    const targetTs = BASE_TIMESTAMP + 150; // mid-slot
    setMarketOffset(String(targetTs));
    const slot = getSlotTS();
    expect(slot.startTime).toBe(BASE_TIMESTAMP * 1000);
    expect(slot.endTime).toBe((BASE_TIMESTAMP + 300) * 1000);
  });

  test("slot boundaries are always aligned to BASE_TIMESTAMP", () => {
    const slot = getSlotTS();
    expect((slot.startTime / 1000 - BASE_TIMESTAMP) % 300).toBe(0);
  });
});
