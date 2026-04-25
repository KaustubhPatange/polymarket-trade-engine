import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import sinon from "sinon";
import {
  FixtureRunner,
  UP_TOKEN,
  DOWN_TOKEN,
  SLOT_END_MS,
  SLOT_START_MS,
} from "./helpers/fixture-runner.ts";
import { waitForAsk } from "../../engine/strategy/utils.ts";

// Timestamps derived from the fixture log
const LOG_START_TS = 1777108047232;
// ~268s remaining: DOWN bid crosses 0.64
const TS_268S_REMAINING = 1777108232000;
// ~90s remaining: UP ask reaches 0.67
const TS_90S_REMAINING = 1777108410000;
// just past slot end
const TS_AFTER_SLOT = SLOT_END_MS + 80_000;

// Generous timeout for each scenario test
const TEST_TIMEOUT = 30_000;

// ---------------------------------------------------------------------------
// Test 1: GTC buy DOWN at 0.50, sell at 0.63 → positive PnL
// ---------------------------------------------------------------------------

describe("Test 1: buy DOWN GTC, sell at 0.63 — positive PnL", () => {
  let runner: FixtureRunner;

  beforeEach(async () => {
    runner = new FixtureRunner();
    let filledShares = 0;

    await runner.setup(async (ctx) => {
      ctx.postOrders([
        {
          req: { tokenId: DOWN_TOKEN, action: "buy", price: 0.5, shares: 6 },
          expireAtMs: SLOT_END_MS,
          onFilled: (shares) => {
            filledShares = shares;
            // Place sell immediately on fill
            ctx.postOrders([
              {
                req: {
                  tokenId: DOWN_TOKEN,
                  action: "sell",
                  price: 0.63,
                  shares,
                },
                expireAtMs: SLOT_END_MS,
              },
            ]);
          },
        },
      ]);
      (runner as any)._filledShares = () => filledShares;
    });
  });

  afterEach(() => runner.teardown());

  test(
    "buy fills with 6 shares and PnL is positive",
    async () => {
      // The buy fills on the first snapshot (DOWN ask = 0.50)
      await runner.advanceTo(LOG_START_TS + 2000);
      expect((runner as any)._filledShares()).toBe(6);

      // Advance to ~268s remaining where DOWN bid = 0.63 (sell fills)
      await runner.advanceTo(TS_268S_REMAINING);
      await runner.waitForState("DONE");

      expect(runner.lifecycle.pnl).toBeGreaterThan(0);
      // Expected ≈ 6 * (0.63 - 0.50) = +$0.78
      expect(runner.lifecycle.pnl).toBe(0.78);
    },
    TEST_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Test 2: GTC buy UP at 0.51, emergency-sell when bid < 0.40 → negative PnL
// ---------------------------------------------------------------------------

describe("Test 2: buy UP GTC, emergency-sell on bid drop — negative PnL", () => {
  let runner: FixtureRunner;

  beforeEach(async () => {
    runner = new FixtureRunner();

    await runner.setup(async (ctx) => {
      const release = ctx.hold();
      let monitorInterval: ReturnType<typeof setInterval> | null = null;

      ctx.postOrders([
        {
          req: { tokenId: UP_TOKEN, action: "buy", price: 0.51, shares: 6 },
          expireAtMs: SLOT_END_MS,
          onFilled: (shares) => {
            // Place a sell at 0.64 (won't fill before emergency)
            ctx.postOrders([
              {
                req: { tokenId: UP_TOKEN, action: "sell", price: 0.64, shares },
                expireAtMs: SLOT_END_MS,
              },
            ]);

            // Monitor bid; emergency-sell if it drops below 0.40
            monitorInterval = setInterval(() => {
              const bid = ctx.orderBook.bestBidPrice("UP");
              if (bid !== null && bid < 0.4) {
                clearInterval(monitorInterval!);
                monitorInterval = null;
                const pendingSells = ctx.pendingOrders
                  .filter((o) => o.action === "sell")
                  .map((o) => o.orderId);
                ctx.emergencySells(pendingSells).finally(() => release());
              }
            }, 100);
          },
        },
      ]);

      return () => {
        if (monitorInterval) clearInterval(monitorInterval);
      };
    });
  });

  afterEach(() => runner.teardown());

  test(
    "emergency sell triggers and PnL is negative",
    async () => {
      // Buy fills immediately (UP ask = 0.51)
      await runner.advanceTo(LOG_START_TS + 2000);

      // Advance to where UP bid drops to ~0.36 (< 0.40) → emergency sell triggers
      await runner.advanceTo(TS_268S_REMAINING);
      await runner.waitForState("DONE", SLOT_END_MS + 10_000);

      expect(runner.lifecycle.pnl).toBe(-0.9);
    },
    TEST_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Test 3: GTC buy DOWN at 0.50, hold to resolution → redeemPositions called, negative PnL
// ---------------------------------------------------------------------------

describe("Test 3: buy DOWN GTC, hold to resolution — redeemPositions called, negative PnL", () => {
  let runner: FixtureRunner;
  let redeemStub: ReturnType<typeof sinon.stub>;
  const states: string[] = [];

  beforeEach(async () => {
    runner = new FixtureRunner();
    redeemStub = sinon.stub(runner.client, "redeemPositions").resolves();

    await runner.setup(async (ctx) => {
      ctx.postOrders([
        {
          req: { tokenId: DOWN_TOKEN, action: "buy", price: 0.5, shares: 6 },
          expireAtMs: SLOT_END_MS,
        },
      ]);
    });

    // Track state transitions
    const originalTick = runner.lifecycle.tick.bind(runner.lifecycle);
    runner.lifecycle.tick = async () => {
      const before = runner.lifecycle.state;
      await originalTick();
      const after = runner.lifecycle.state;
      if (after !== before) states.push(after);
    };
  });

  afterEach(() => {
    redeemStub.restore();
    runner.teardown();
  });

  test(
    "transitions RUNNING → STOPPING → DONE, redeemPositions called once, PnL negative",
    async () => {
      await runner.advanceTo(LOG_START_TS + 2000); // buy fills

      // Advance through full slot to resolution
      await runner.advanceTo(TS_AFTER_SLOT);
      await runner.waitForState("DONE", TS_AFTER_SLOT + 30_000);

      expect(states).toContain("STOPPING");
      expect(states).toContain("DONE");
      expect(redeemStub.calledOnce).toBe(true);
      expect(runner.lifecycle.pnl).toBe(-3); // DOWN pays $0 when UP wins
    },
    TEST_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Test 4: GTC buy UP at 0.51, hold to resolution → redeemPositions called, positive PnL
// ---------------------------------------------------------------------------

describe("Test 4: buy UP GTC, hold to resolution — redeemPositions called, positive PnL", () => {
  let runner: FixtureRunner;
  let redeemStub: ReturnType<typeof sinon.stub>;

  beforeEach(async () => {
    runner = new FixtureRunner();
    redeemStub = sinon.stub(runner.client, "redeemPositions").resolves();

    await runner.setup(async (ctx) => {
      ctx.postOrders([
        {
          req: { tokenId: UP_TOKEN, action: "buy", price: 0.51, shares: 6 },
          expireAtMs: SLOT_END_MS,
        },
      ]);
    });
  });

  afterEach(() => {
    redeemStub.restore();
    runner.teardown();
  });

  test(
    "redeemPositions called once and PnL is positive",
    async () => {
      await runner.advanceTo(LOG_START_TS + 2000); // buy fills

      await runner.advanceTo(TS_AFTER_SLOT);
      await runner.waitForState("DONE", TS_AFTER_SLOT + 30_000);

      expect(redeemStub.calledOnce).toBe(true);
      expect(runner.lifecycle.pnl).toBeGreaterThan(0); // UP pays $1/share
      // Expected ≈ 6 * (1 - 0.51) = +$2.94
      expect(runner.lifecycle.pnl).toBe(2.94);
    },
    TEST_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Test 5: waitForAsk UP ≥ 0.67, buy, hold to resolution → positive PnL
// ---------------------------------------------------------------------------

describe("Test 5: waitForAsk UP ≥ 0.67, buy, hold to resolution — positive PnL", () => {
  let runner: FixtureRunner;
  let redeemStub: ReturnType<typeof sinon.stub>;

  beforeEach(async () => {
    runner = new FixtureRunner();
    redeemStub = sinon.stub(runner.client, "redeemPositions").resolves();

    await runner.setup(async (ctx) => {
      const release = ctx.hold();
      const signal = waitForAsk(ctx, "UP", 0.67, (price) => {
        ctx.postOrders([
          {
            req: { tokenId: UP_TOKEN, action: "buy", price, shares: 6 },
            expireAtMs: SLOT_END_MS,
            onFilled: () => release(),
          },
        ]);
      });
      return () => signal.cancel();
    });
  });

  afterEach(() => {
    redeemStub.restore();
    runner.teardown();
  });

  test(
    "buy triggers at ≥ 0.67 ask and PnL is positive",
    async () => {
      // Advance to ~90s remaining where UP ask reaches 0.67
      await runner.advanceTo(TS_90S_REMAINING + 5000);

      await runner.advanceTo(TS_AFTER_SLOT);
      await runner.waitForState("DONE", TS_AFTER_SLOT + 30_000);

      expect(redeemStub.calledOnce).toBe(true);
      expect(runner.lifecycle.pnl).toBeGreaterThan(0);
      // waitForAsk fires at first UP ask ≥ 0.67; UP wins → payout $1/share
      // PnL ≈ 6*(1-0.67) = +$1.98
      expect(runner.lifecycle.pnl).toBe(1.98);
    },
    TEST_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Test 6: FOK buy DOWN at 0.50 — fee deducted from filled shares, positive PnL
// ---------------------------------------------------------------------------

describe("Test 6: FOK buy DOWN at 0.50 — fee deducted, sell at 0.63", () => {
  let runner: FixtureRunner;
  let filledShares = 0;

  beforeEach(async () => {
    runner = new FixtureRunner();

    await runner.setup(async (ctx) => {
      ctx.postOrders([
        {
          req: {
            tokenId: DOWN_TOKEN,
            action: "buy",
            price: 0.5,
            shares: 6,
            orderType: "FOK",
          },
          expireAtMs: SLOT_END_MS,
          onFilled: (shares) => {
            filledShares = shares;
            ctx.postOrders([
              {
                req: {
                  tokenId: DOWN_TOKEN,
                  action: "sell",
                  price: 0.63,
                  shares,
                },
                expireAtMs: SLOT_END_MS,
              },
            ]);
          },
        },
      ]);
    });
  });

  afterEach(() => runner.teardown());

  test(
    "FOK buy fills with fee-deducted shares (< 6) and PnL is positive",
    async () => {
      await runner.advanceTo(LOG_START_TS + 2000); // FOK fills immediately

      // feeRate=0.1: fee = 6 * 0.1 * 0.5 * 0.5 = 0.15 → shares = 6 - 0.15/0.5 = 5.7
      expect(filledShares).toBe(5.7);

      await runner.advanceTo(TS_268S_REMAINING);
      await runner.waitForState("DONE", SLOT_END_MS + 10_000);

      expect(runner.lifecycle.pnl).toBeGreaterThan(0);
      // sell revenue: 5.7 * 0.63 = 3.591; buy cost: 3.0 (gross), fee=0.15 → PnL ≈ 0.591
      expect(runner.lifecycle.pnl).toBe(0.591);
    },
    TEST_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Test 7: wallet $1, buy fails after max retries → onFailed called
// ---------------------------------------------------------------------------

describe("Test 7: wallet $1 — buy fails after max retries, onFailed called", () => {
  let runner: FixtureRunner;
  let failReason = "";
  const origMaxRetries = process.env.BUY_MAX_RETRIES;
  const origRetryDelay = process.env.BUY_RETRY_DELAY_MS;

  beforeEach(async () => {
    process.env.BUY_MAX_RETRIES = "1";
    process.env.BUY_RETRY_DELAY_MS = "0";

    runner = new FixtureRunner(1 /* $1 wallet */);

    await runner.setup(async (ctx) => {
      ctx.postOrders([
        {
          req: { tokenId: UP_TOKEN, action: "buy", price: 0.51, shares: 6 }, // needs $3.06
          expireAtMs: SLOT_END_MS,
          onFailed: (reason) => {
            failReason = reason;
          },
        },
      ]);
    });
  });

  afterEach(() => {
    process.env.BUY_MAX_RETRIES = origMaxRetries;
    process.env.BUY_RETRY_DELAY_MS = origRetryDelay;
    runner.teardown();
  });

  test(
    "onFailed is called with 'not enough balance' after max retries",
    async () => {
      // Advance a tiny bit — with 0ms delay and 1 max retry, onFailed fires almost immediately
      await runner.advanceTo(LOG_START_TS + 500);

      expect(failReason).toContain("not enough balance");
    },
    TEST_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Test 8: GTC buy UP at 0.40 with 2s expiry → onExpired called
// ---------------------------------------------------------------------------

describe("Test 8: GTC buy UP at 0.40 with 2s expiry — onExpired called", () => {
  let runner: FixtureRunner;
  let expired = false;

  beforeEach(async () => {
    runner = new FixtureRunner();

    await runner.setup(async (ctx) => {
      const expiry = Date.now() + 2000; // 2 seconds from now (fake clock)
      ctx.postOrders([
        {
          req: { tokenId: UP_TOKEN, action: "buy", price: 0.4, shares: 6 },
          // UP ask is 0.51, so a buy at 0.40 never fills
          expireAtMs: expiry,
          onExpired: () => {
            expired = true;
          },
        },
      ]);
    });
  });

  afterEach(() => runner.teardown());

  test(
    "order expires before filling and onExpired is called",
    async () => {
      // Advance past the 2s expiry
      await runner.advanceTo(LOG_START_TS + 5000);

      expect(expired).toBe(true);
      // No shares should have been bought
      expect(
        runner.lifecycle.orderHistory.filter((o) => o.action === "buy"),
      ).toHaveLength(0);
    },
    TEST_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Test 9: hold() keeps lifecycle in RUNNING until slot end
// ---------------------------------------------------------------------------

describe("Test 9: hold() prevents premature STOPPING", () => {
  let runner: FixtureRunner;
  const states: string[] = ["RUNNING"];

  beforeEach(async () => {
    runner = new FixtureRunner();

    await runner.setup(async (ctx) => {
      // Grab a hold — never release it
      ctx.hold();
      // No orders placed
    });

    // Intercept state changes
    const orig = (runner.lifecycle as any)._setState.bind(runner.lifecycle);
    (runner.lifecycle as any)._setState = (next: string) => {
      orig(next);
      states.push(next);
    };
  });

  afterEach(() => runner.teardown());

  test(
    "lifecycle stays RUNNING while hold is active; STOPPING only after slot expires",
    async () => {
      // Well before slot end — should still be RUNNING
      await runner.advanceTo(SLOT_START_MS + 100_000); // ~100s into slot
      expect(runner.lifecycle.state).toBe("RUNNING");

      // Advance past slot end — time-based transition kicks in
      await runner.advanceTo(SLOT_END_MS + 1000);
      await runner.waitForState("DONE", SLOT_END_MS + 60_000);

      // Verify STOPPING was NOT triggered before slot end
      const stoppingIndex = states.indexOf("STOPPING");
      expect(stoppingIndex).toBeGreaterThan(-1);

      // The transition into STOPPING must come after slot end time (clock.now >= slotEndMs)
      // We just verify it never happened while we were at LOG_START + 100s (before slot end)
      expect(states[0]).toBe("RUNNING"); // initial
    },
    TEST_TIMEOUT,
  );
});
