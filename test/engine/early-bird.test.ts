import { describe, test, expect, afterEach, afterAll } from "bun:test";
import sinon, { type SinonFakeTimers, type SinonStub } from "sinon";
import { EarlyBird } from "../../engine/early-bird.ts";
import type { PersistentState } from "../../engine/state.ts";
import {
  MockAPIQueue,
  FIXTURE_SLUG,
  UP_TOKEN,
  DOWN_TOKEN,
} from "./helpers/mock-api-queue.ts";
import { SimTickerTracker } from "./helpers/sim-ticker.ts";
import { ModuleMocker } from "../helpers/mock-module.ts";

// ─── Module mocks ─────────────────────────────────────────────────────────────

const stateStore: { load: PersistentState | null } = { load: null };

const mocker = new ModuleMocker();

await mocker.mock("../../engine/state.ts", () => ({
  loadState: (_path: string) => stateStore.load,
  saveState: () => {},
}));

await mocker.mock("../../engine/strategy/index.ts", () => ({
  strategies: { "test-strategy": async () => {} },
  DEFAULT_STRATEGY: "test-strategy",
}));

await mocker.mock("../../tracker/orderbook.ts", () => ({
  OrderBook: class {
    subscribe() {}
    destroy() {}
    async waitForReady() {}
    bestAskInfo() { return null; }
    bestBidInfo() { return null; }
    bestBidPrice() { return null; }
    getSnapshotData() { return null; }
    getTickSize() { return "0.01"; }
    getFeeRate() { return 1000; }
    getTokenId(_: "UP" | "DOWN") { return ""; }
  },
}));

afterAll(() => mocker.clear());

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * T_BASE: fake clock anchor.
 *   getSlug(1) at T_BASE = "btc-updown-5m-1777108200" (FIXTURE_SLUG)
 *   getSlug(2) at T_BASE = "btc-updown-5m-1777108500" (NEXT_SLOT_SLUG)
 *
 * FIXTURE_SLUG's slot ends at ~April 2026. Only use it in fake-timer tests
 * where Date.now() is pinned to T_BASE.
 *
 * FUTURE_SLOT_SLUG ends in April 2027, safely past today's real wall-clock
 * date — used in recovery tests that evaluate slotActive with real Date.now().
 */
const T_BASE = 1777107950000;
const NEXT_SLOT_SLUG = "btc-updown-5m-1777108500";

// 1808643900 = BASE_TIMESTAMP + 120250 × 300 (a valid 5-min slot)
const FUTURE_SLOT_SLUG = "btc-updown-5m-1808643900";
const FUTURE_SLOT_END_MS = (1808643900 + 300) * 1000;

const TEST_TIMEOUT = 10_000;

// ─── Harness ──────────────────────────────────────────────────────────────────

type Harness = {
  eb: EarlyBird;
  clock: SinonFakeTimers;
  exitStub: SinonStub;
  teardown: () => void;
};

type HarnessOpts = {
  rounds?: number | null;
  slotOffset?: number;
  maxSessionLoss?: number;
  apiQueue?: MockAPIQueue;
};

function makeHarness(opts: HarnessOpts = {}): Harness {
  process.env.SIM_DELAY_MS = "0";
  process.env.WALLET_BALANCE = "50000";
  process.env.ORDERBOOK_WS_URL = "ws://127.0.0.1:1";
  if (opts.maxSessionLoss !== undefined) {
    process.env.MAX_SESSION_LOSS = String(opts.maxSessionLoss);
  }

  const clock = sinon.useFakeTimers({
    now: T_BASE,
    toFake: [
      "Date",
      "setTimeout",
      "setInterval",
      "clearTimeout",
      "clearInterval",
      "performance",
    ],
    shouldClearNativeTimers: true,
  });

  const exitStub = sinon.stub(process, "exit");

  const eb = new EarlyBird(
    "test-strategy",
    opts.slotOffset ?? 1,
    /*prod=*/ false,
    opts.rounds !== undefined ? opts.rounds : null,
  );

  (eb as any)._ticker = new SimTickerTracker();
  (eb as any)._apiQueue = opts.apiQueue ?? new MockAPIQueue();

  return {
    eb,
    clock,
    exitStub,
    teardown() {
      stateStore.load = null;
      clock.restore();
      try {
        exitStub.restore();
      } catch {}
      delete process.env.SIM_DELAY_MS;
      delete process.env.WALLET_BALANCE;
      delete process.env.ORDERBOOK_WS_URL;
      delete process.env.MAX_SESSION_LOSS;
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("EarlyBird — rounds", () => {
  let h: Harness;

  afterEach(() => h.teardown());

  test(
    "rounds=1: creates exactly 1 lifecycle then shuts down",
    async () => {
      h = makeHarness({ rounds: 1 });
      await h.eb.start();

      (h.eb as any)._tick();

      expect((h.eb as any)._lifecycles.has(FIXTURE_SLUG)).toBe(true);
      expect((h.eb as any)._roundsCreated).toBe(1);

      const lc = (h.eb as any)._lifecycles.get(FIXTURE_SLUG)!;
      (lc as any)._state = "DONE";

      (h.eb as any)._tick();

      expect((h.eb as any)._shuttingDown).toBe(true);
      expect(h.exitStub.calledWith(0)).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "rounds=2: creates exactly 2 lifecycles across a slot boundary then shuts down",
    async () => {
      h = makeHarness({ rounds: 2 });
      await h.eb.start();

      // Tick 1 at T_BASE → lc1 (FIXTURE_SLUG)
      (h.eb as any)._tick();

      expect((h.eb as any)._roundsCreated).toBe(1);
      expect((h.eb as any)._lifecycles.has(FIXTURE_SLUG)).toBe(true);

      // Force lc1 done; tick processes it (getSlug(1) still = FIXTURE_SLUG → no new lc)
      ((h.eb as any)._lifecycles.get(FIXTURE_SLUG) as any)._state = "DONE";
      (h.eb as any)._tick();

      expect((h.eb as any)._completedSlugs.has(FIXTURE_SLUG)).toBe(true);
      expect((h.eb as any)._lifecycles.size).toBe(0);

      // Jump past slot boundary → getSlug(1) = NEXT_SLOT_SLUG
      h.clock.setSystemTime(T_BASE + 250_100);

      // Tick 3 → lc2 (NEXT_SLOT_SLUG)
      (h.eb as any)._tick();

      expect((h.eb as any)._lifecycles.has(NEXT_SLOT_SLUG)).toBe(true);
      expect((h.eb as any)._roundsCreated).toBe(2);

      // Force lc2 done; tick: rounds exhausted + no lifecycles → shutdown → exit(0)
      ((h.eb as any)._lifecycles.get(NEXT_SLOT_SLUG) as any)._state = "DONE";
      (h.eb as any)._tick();

      expect((h.eb as any)._shuttingDown).toBe(true);
      expect(h.exitStub.calledWith(0)).toBe(true);
    },
    TEST_TIMEOUT,
  );
});

describe("EarlyBird — slotOffset", () => {
  let h: Harness;

  afterEach(() => h.teardown());

  test(
    "slotOffset=1: lifecycle slug matches getSlug(1) at T_BASE",
    async () => {
      h = makeHarness({ slotOffset: 1 });
      await h.eb.start();

      (h.eb as any)._tick();

      expect((h.eb as any)._lifecycles.has(FIXTURE_SLUG)).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "slotOffset=2: lifecycle slug matches getSlug(2) at T_BASE, not getSlug(1)",
    async () => {
      h = makeHarness({ slotOffset: 2 });
      await h.eb.start();

      (h.eb as any)._tick();

      expect((h.eb as any)._lifecycles.has(NEXT_SLOT_SLUG)).toBe(true);
      expect((h.eb as any)._lifecycles.has(FIXTURE_SLUG)).toBe(false);
    },
    TEST_TIMEOUT,
  );
});

describe("EarlyBird — multiple concurrent lifecycles", () => {
  let h: Harness;

  afterEach(() => h.teardown());

  test(
    "advancing past a slot boundary creates a second lifecycle while the first is still running",
    async () => {
      h = makeHarness({ rounds: null });
      await h.eb.start();

      // Tick at T_BASE: lc1 (FIXTURE_SLUG) created; leave it running
      (h.eb as any)._tick();

      expect((h.eb as any)._lifecycles.size).toBe(1);
      expect((h.eb as any)._lifecycles.has(FIXTURE_SLUG)).toBe(true);

      // Jump past slot boundary → getSlug(1) = NEXT_SLOT_SLUG
      h.clock.setSystemTime(T_BASE + 250_100);

      // Tick: lc2 (NEXT_SLOT_SLUG) created while lc1 still running
      (h.eb as any)._tick();

      expect((h.eb as any)._lifecycles.size).toBe(2);
      expect((h.eb as any)._lifecycles.has(FIXTURE_SLUG)).toBe(true);
      expect((h.eb as any)._lifecycles.has(NEXT_SLOT_SLUG)).toBe(true);
    },
    TEST_TIMEOUT,
  );
});

describe("EarlyBird — session loss shutdown", () => {
  let h: Harness;

  afterEach(() => h.teardown());

  test(
    "completing a lifecycle with loss >= MAX_SESSION_LOSS triggers shutdown",
    async () => {
      h = makeHarness({ rounds: null, maxSessionLoss: 1 });
      await h.eb.start();

      (h.eb as any)._tick();

      const lc = (h.eb as any)._lifecycles.get(FIXTURE_SLUG)!;
      (lc as any)._state = "DONE";
      (lc as any)._pnl = -2.0;

      (h.eb as any)._tick();

      expect((h.eb as any)._shuttingDown).toBe(true);
      expect(h.exitStub.calledWith(0)).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "loss below MAX_SESSION_LOSS does not trigger shutdown",
    async () => {
      h = makeHarness({ rounds: null, maxSessionLoss: 5 });
      await h.eb.start();

      (h.eb as any)._tick();

      const lc = (h.eb as any)._lifecycles.get(FIXTURE_SLUG)!;
      (lc as any)._state = "DONE";
      (lc as any)._pnl = -1.0;

      (h.eb as any)._tick();

      expect((h.eb as any)._shuttingDown).toBe(false);
      expect(h.exitStub.called).toBe(false);
    },
    TEST_TIMEOUT,
  );
});

describe("EarlyBird — recovery", () => {
  afterEach(() => {
    stateStore.load = null;
  });

  test(
    "state with pending sell order: recovered lifecycle is STOPPING",
    async () => {
      // Inject in-memory state — no files written
      stateStore.load = {
        sessionPnl: 0,
        sessionLoss: 0,
        activeMarkets: [
          {
            slug: FUTURE_SLOT_SLUG,
            state: "STOPPING",
            strategyName: "test-strategy",
            clobTokenIds: [UP_TOKEN, DOWN_TOKEN],
            pendingOrders: [
              {
                orderId: "order-recovery-1",
                tokenId: UP_TOKEN,
                action: "sell",
                price: 0.6,
                shares: 5,
                expireAtMs: FUTURE_SLOT_END_MS,
                placedAtMs: Date.now(),
              },
            ],
            orderHistory: [],
          },
        ],
        completedMarkets: [],
      };

      process.env.SIM_DELAY_MS = "0";
      process.env.WALLET_BALANCE = "50000";
      process.env.ORDERBOOK_WS_URL = "ws://127.0.0.1:1";

      const eb = new EarlyBird("test-strategy", 1, false, null);
      (eb as any)._ticker = new SimTickerTracker();
      (eb as any)._apiQueue = new MockAPIQueue();

      const exitStub = sinon.stub(process, "exit");
      try {
        await eb.start();

        expect((eb as any)._lifecycles.has(FUTURE_SLOT_SLUG)).toBe(true);
        expect((eb as any)._lifecycles.get(FUTURE_SLOT_SLUG)!.state).toBe(
          "STOPPING",
        );
      } finally {
        exitStub.restore();
        delete process.env.SIM_DELAY_MS;
        delete process.env.WALLET_BALANCE;
        delete process.env.ORDERBOOK_WS_URL;
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "state with expired slot: stale market is NOT recovered",
    async () => {
      // btc-updown-5m-100 ends at (100 + 300) * 1000 = 400_000 ms — well in the past
      stateStore.load = {
        sessionPnl: 0,
        sessionLoss: 0,
        activeMarkets: [
          {
            slug: "btc-updown-5m-100",
            state: "STOPPING",
            strategyName: "test-strategy",
            clobTokenIds: [UP_TOKEN, DOWN_TOKEN],
            pendingOrders: [
              {
                orderId: "order-expired-1",
                tokenId: UP_TOKEN,
                action: "sell",
                price: 0.6,
                shares: 5,
                expireAtMs: 400_000,
                placedAtMs: 100_000,
              },
            ],
            orderHistory: [],
          },
        ],
        completedMarkets: [],
      };

      process.env.SIM_DELAY_MS = "0";
      process.env.WALLET_BALANCE = "50000";
      process.env.ORDERBOOK_WS_URL = "ws://127.0.0.1:1";

      const eb = new EarlyBird("test-strategy", 1, false, null);
      (eb as any)._ticker = new SimTickerTracker();
      (eb as any)._apiQueue = new MockAPIQueue();

      const exitStub = sinon.stub(process, "exit");
      try {
        await eb.start();

        expect((eb as any)._lifecycles.has("btc-updown-5m-100")).toBe(false);
      } finally {
        exitStub.restore();
        delete process.env.SIM_DELAY_MS;
        delete process.env.WALLET_BALANCE;
        delete process.env.ORDERBOOK_WS_URL;
      }
    },
    TEST_TIMEOUT,
  );
});
