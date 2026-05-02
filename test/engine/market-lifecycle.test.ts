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

// ---------------------------------------------------------------------------
// Test 10: strategy cleanup is called when lifecycle transitions to STOPPING
// ---------------------------------------------------------------------------

describe("Test 10: strategy cleanup is invoked on STOPPING transition", () => {
  let runner: FixtureRunner;
  let cleanupCallCount = 0;

  beforeEach(async () => {
    runner = new FixtureRunner();
    cleanupCallCount = 0;

    await runner.setup(async (ctx) => {
      // Buy fills immediately; sell at 0.99 won't match any bid in the fixture —
      // keeps the lifecycle in STOPPING across multiple ticks so we can verify
      // cleanup is only called once despite repeated _handleStopping invocations.
      ctx.postOrders([
        {
          req: { tokenId: DOWN_TOKEN, action: "buy", price: 0.5, shares: 6 },
          expireAtMs: SLOT_END_MS,
          onFilled: (shares) => {
            ctx.postOrders([
              {
                req: {
                  tokenId: DOWN_TOKEN,
                  action: "sell",
                  price: 0.99,
                  shares,
                },
                expireAtMs: SLOT_END_MS,
              },
            ]);
          },
        },
      ]);
      return () => {
        cleanupCallCount++;
      };
    });
  });

  afterEach(() => runner.teardown());

  test(
    "cleanup fn is called exactly once across multiple STOPPING ticks",
    async () => {
      // Buy fills; sell at 0.99 is placed but won't match any bid
      await runner.advanceTo(LOG_START_TS + 2000);

      // Force STOPPING while the unfillable sell is still pending
      runner.lifecycle.shutdown();
      expect(runner.lifecycle.state).toBe("STOPPING");

      // Advance ~500 ms — ~5 ticks fire in STOPPING; cleanup must run only once
      await runner.advanceTo(LOG_START_TS + 2500);
      expect(runner.lifecycle.state).toBe("STOPPING");
      expect(cleanupCallCount).toBe(1);

      // Advance past slot end — sell gets cancelled, lifecycle resolves to DONE
      await runner.advanceTo(TS_AFTER_SLOT);
      await runner.waitForState("DONE", TS_AFTER_SLOT + 30_000);

      expect(cleanupCallCount).toBe(1);
    },
    TEST_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Test 11: lifecycle-initiated cancel does not fire onFailed
// ---------------------------------------------------------------------------

describe("Test 11: lifecycle-initiated cancel does not call onFailed", () => {
  let runner: FixtureRunner;
  let failedCalled = false;

  beforeEach(async () => {
    runner = new FixtureRunner();
    failedCalled = false;

    await runner.setup(async (ctx) => {
      const expiry = Date.now() + 2000;
      ctx.postOrders([
        {
          req: { tokenId: UP_TOKEN, action: "buy", price: 0.4, shares: 6 },
          // UP ask is 0.51 — a buy at 0.40 never fills, so expiry triggers cancel
          expireAtMs: expiry,
          onFailed: () => {
            failedCalled = true;
          },
        },
      ]);
    });
  });

  afterEach(() => runner.teardown());

  test(
    "order cancelled via expiry does not trigger onFailed",
    async () => {
      // Advance past the 2s expiry. _cancelOrders untracks the order from the
      // channel before calling the API, so no CANCELLATION callback fires.
      await runner.advanceTo(LOG_START_TS + 5000);

      expect(failedCalled).toBe(false);
    },
    TEST_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Test 12: emergencySells should fill in the 2s per-attempt window even when
// MINED settlement is delayed by 4s (production-like simulation timing).
// ---------------------------------------------------------------------------
//
describe("Test 12: emergencySells fills despite 4s MINED delay", () => {
  let runner: FixtureRunner;
  let emergencyTriggered = false;

  beforeEach(async () => {
    runner = new FixtureRunner();
    emergencyTriggered = false;

    await runner.setup(async (ctx) => {
      const release = ctx.hold();

      ctx.postOrders([
        {
          req: { tokenId: DOWN_TOKEN, action: "buy", price: 0.5, shares: 6 },
          expireAtMs: SLOT_END_MS,
          onFilled: (boughtShares) => {
            // Switch to prod-like 4s MINED delay before placing the sell so
            // the buy itself isn't affected — only the emergency-sell path is.
            process.env.SIM_BALANCE_DELAY_MS = "4000";

            // Park the sell at 0.99 — far above any DOWN bid in the fixture,
            // so it sits idle until emergencySells re-prices it at the bid.
            ctx.postOrders([
              {
                req: {
                  tokenId: DOWN_TOKEN,
                  action: "sell",
                  price: 0.99,
                  shares: boughtShares,
                },
                expireAtMs: SLOT_END_MS,
              },
            ]);

            // Once the parked sell is registered in pendingOrders, trigger
            // emergencySells. 500ms is far longer than the 0ms simulateDelay,
            // so the sell will be visible in pendingOrders.
            setTimeout(() => {
              const sellIds = ctx.pendingOrders
                .filter((o) => o.action === "sell")
                .map((o) => o.orderId);
              if (sellIds.length > 0) {
                emergencyTriggered = true;
                void ctx.emergencySells(sellIds).finally(() => release());
              } else {
                release();
              }
            }, 500);
          },
        },
      ]);
    });
  });

  afterEach(() => runner.teardown());

  test(
    "emergency sell fills via MINED before per-attempt expiry cancels it",
    async () => {
      // Timeline:
      //   T+0ms       buy @ 0.50 placed
      //   T+~100ms    buy MATCHED + MINED (SIM_BALANCE_DELAY_MS=0 at this point)
      //   T+~100ms    onFilled → SIM_BALANCE_DELAY_MS=4000; parked SELL @ 0.99 placed
      //   T+600ms     emergencySells triggered → cancels 0.99 sell, places at bid 0.49
      //   T+~700ms    _check synthesizes MATCHED on the 0.49 sell; MINED scheduled for T+~4700ms
      //   T+~2700ms   _checkExpiries fires (2s after place)
      //                 - WITHOUT fix: cancels and untracks; MINED at T+~4700 is dropped
      //                 - WITH fix:    sees matched state, defers expiry
      //   T+~4700ms   MINED fires → onFilled → loop exits (only with fix)
      //
      // 10s of fake time is enough for the full sequence; without the fix
      // the order would still be in retry-loop limbo and these asserts fail.
      await runner.advanceTo(LOG_START_TS + 10_000);

      expect(emergencyTriggered).toBe(true);

      // The emergency sell loop re-priced from 0.99 to the live DOWN bid
      // (0.49) before filling. Verify via orderHistory — the parked sell at
      // 0.99 was cancelled by emergencySells and never appears as a fill.
      const sellHistory = runner.lifecycle.orderHistory.filter(
        (o) => o.action === "sell",
      );
      expect(sellHistory).toHaveLength(1);
      expect(sellHistory[0]!.price).toBe(0.49);
      expect(sellHistory[0]!.shares).toBe(6);

      // 6 shares × (0.49 - 0.50) = -$0.06
      expect(runner.lifecycle.pnl).toBeCloseTo(-0.06, 5);
    },
    TEST_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Test 13: emergencySells promise resolves only after all sells fill
// ---------------------------------------------------------------------------

describe("Test 13: emergencySells promise awaits all loops", () => {
  let runner: FixtureRunner;
  let resolvedAt: number | null = null;
  let pendingWhenResolved: number | null = null;

  beforeEach(async () => {
    runner = new FixtureRunner();
    resolvedAt = null;
    pendingWhenResolved = null;

    await runner.setup(async (ctx) => {
      const release = ctx.hold();

      ctx.postOrders([
        {
          req: { tokenId: DOWN_TOKEN, action: "buy", price: 0.5, shares: 6 },
          expireAtMs: SLOT_END_MS,
          onFilled: (boughtShares) => {
            // Park sell at 0.99 — won't fill at any DOWN bid in the fixture.
            ctx.postOrders([
              {
                req: {
                  tokenId: DOWN_TOKEN,
                  action: "sell",
                  price: 0.99,
                  shares: boughtShares,
                },
                expireAtMs: SLOT_END_MS,
              },
            ]);

            setTimeout(() => {
              const sellIds = ctx.pendingOrders
                .filter((o) => o.action === "sell")
                .map((o) => o.orderId);
              void ctx.emergencySells(sellIds).then(() => {
                resolvedAt = Date.now();
                pendingWhenResolved = ctx.pendingOrders.filter(
                  (o) => o.action === "sell",
                ).length;
                release();
              });
            }, 500);
          },
        },
      ]);
    });
  });

  afterEach(() => runner.teardown());

  test(
    "promise stays pending until the re-priced sell fills",
    async () => {
      // Buy fills; emergencySells fires at +600ms; parked 0.99 sell is cancelled
      // and the loop re-prices to the live bid. While the loop is mid-flight,
      // pendingOrders still contains the re-priced sell — promise must not have
      // resolved yet.
      await runner.advanceTo(LOG_START_TS + 700);
      expect(resolvedAt).toBeNull();

      // Advance enough for the re-priced sell to fill.
      await runner.advanceTo(LOG_START_TS + 10_000);

      expect(resolvedAt).not.toBeNull();
      // No sells should be pending when the promise resolved — proves it waited.
      expect(pendingWhenResolved).toBe(0);

      const sellHistory = runner.lifecycle.orderHistory.filter(
        (o) => o.action === "sell",
      );
      expect(sellHistory).toHaveLength(1);
      expect(sellHistory[0]!.shares).toBe(6);
    },
    TEST_TIMEOUT,
  );
});
