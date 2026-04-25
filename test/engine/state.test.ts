import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { loadState, saveState } from "../../engine/state.ts";
import type { PersistentState } from "../../engine/state.ts";

const TMP_DIR = join(import.meta.dirname, "__tmp_state__");
const STATE_PATH = join(TMP_DIR, "state.json");

function emptyState(): PersistentState {
  return {
    sessionPnl: 0,
    activeMarkets: [],
    completedMarkets: [],
  };
}

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  // Clean up written files
  try {
    const { readdirSync, unlinkSync, rmdirSync } = require("fs");
    for (const f of readdirSync(TMP_DIR)) {
      unlinkSync(join(TMP_DIR, f));
    }
    rmdirSync(TMP_DIR);
  } catch {}
});

describe("loadState", () => {
  test("returns null for missing file", () => {
    expect(loadState(join(TMP_DIR, "nonexistent.json"))).toBeNull();
  });

  test("returns null for invalid JSON", () => {
    writeFileSync(STATE_PATH, "not valid json", "utf8");
    expect(loadState(STATE_PATH)).toBeNull();
  });

  test("parses a valid PersistentState", () => {
    const state: PersistentState = {
      sessionPnl: 1.23,
      sessionLoss: -0.5,
      activeMarkets: [],
      completedMarkets: [],
    };
    writeFileSync(STATE_PATH, JSON.stringify(state), "utf8");
    const loaded = loadState(STATE_PATH);
    expect(loaded).not.toBeNull();
    expect(loaded!.sessionPnl).toBe(1.23);
    expect(loaded!.sessionLoss).toBe(-0.5);
  });

  test("defaults completedMarkets to [] when missing", () => {
    const raw = { sessionPnl: 0, activeMarkets: [] };
    writeFileSync(STATE_PATH, JSON.stringify(raw), "utf8");
    const loaded = loadState(STATE_PATH);
    expect(loaded!.completedMarkets).toEqual([]);
  });

  test("parses non-empty activeMarkets and completedMarkets", () => {
    const state: PersistentState = {
      sessionPnl: 2.5,
      activeMarkets: [
        {
          slug: "btc-updown-5m-1234",
          state: "RUNNING",
          strategyName: "test",
          clobTokenIds: ["UP", "DOWN"],
          pendingOrders: [],
          orderHistory: [],
        },
      ],
      completedMarkets: [
        {
          slug: "btc-updown-5m-9999",
          strategyName: "test",
          pnl: -1.0,
          orderHistory: [],
        },
      ],
    };
    writeFileSync(STATE_PATH, JSON.stringify(state), "utf8");
    const loaded = loadState(STATE_PATH);
    expect(loaded!.activeMarkets).toHaveLength(1);
    expect(loaded!.activeMarkets[0]!.slug).toBe("btc-updown-5m-1234");
    expect(loaded!.completedMarkets).toHaveLength(1);
    expect(loaded!.completedMarkets[0]!.pnl).toBe(-1.0);
  });
});

describe("saveState", () => {
  test("creates a file that can be round-tripped", () => {
    const state = emptyState();
    state.sessionPnl = 42;
    saveState(STATE_PATH, state);
    const loaded = loadState(STATE_PATH);
    expect(loaded!.sessionPnl).toBe(42);
  });

  test("overwrites existing state", () => {
    saveState(STATE_PATH, { ...emptyState(), sessionPnl: 1 });
    saveState(STATE_PATH, { ...emptyState(), sessionPnl: 2 });
    expect(loadState(STATE_PATH)!.sessionPnl).toBe(2);
  });

  test("is atomic — no .tmp file left after save", () => {
    saveState(STATE_PATH, emptyState());
    expect(existsSync(STATE_PATH + ".tmp")).toBe(false);
    expect(existsSync(STATE_PATH)).toBe(true);
  });

  test("creates parent directories if needed", () => {
    const nested = join(TMP_DIR, "nested", "deep", "state.json");
    saveState(nested, emptyState());
    expect(existsSync(nested)).toBe(true);
  });

  test("produces valid JSON", () => {
    saveState(STATE_PATH, emptyState());
    const raw = readFileSync(STATE_PATH, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
