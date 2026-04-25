/**
 * OrderBook tests using a local WS server.
 *
 * WS_URL is a module-level const in orderbook.ts evaluated at first import.
 * We set ORDERBOOK_WS_URL before the dynamic import so the const captures
 * the test server address.
 */
import { describe, test, expect, afterEach, afterAll } from "bun:test";
import type { ServerWebSocket } from "bun";

// ── Fixed port for the test WS server ────────────────────────────────────────
const FIXED_PORT = 17432;
process.env.ORDERBOOK_WS_URL = `ws://localhost:${FIXED_PORT}`;
process.env.MARKET_ASSET = "btc"; // required by getDisplayLines → Env.getAssetConfig

// Dynamic import AFTER env var is set so WS_URL const sees the right value.
const { OrderBook } = await import("../../tracker/orderbook.ts");
import fixtureData from "../__fixtures__/orderbook-ws-messages.json";

const UP_ID = fixtureData.UP_ID;
const DOWN_ID = fixtureData.DOWN_ID;

// ── Helpers ───────────────────────────────────────────────────────────────────

function waitFor(fn: () => boolean, timeout = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (fn()) return resolve();
      if (Date.now() - start > timeout)
        return reject(new Error("waitFor timeout"));
      setTimeout(check, 50);
    };
    check();
  });
}

// ── Test server + OrderBook lifecycle ─────────────────────────────────────────

let server: ReturnType<typeof Bun.serve>;
let ob: InstanceType<typeof OrderBook>;
let connections: ServerWebSocket<unknown>[] = [];

/**
 * Spin up the local WS server.
 * `onSubscribe` is called with the first ServerWebSocket that sends a message
 * so the handler can push fixture data back to the client.
 */
function createServer(
  onSubscribe: (ws: ServerWebSocket<unknown>, raw: string) => void,
) {
  connections = [];
  server = Bun.serve({
    port: FIXED_PORT,
    fetch(_req, server) {
      if (server.upgrade(_req, { data: {} })) return undefined;
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        connections.push(ws);
      },
      message(ws, msg) {
        onSubscribe(ws, msg as string);
      },
      close(ws) {
        connections = connections.filter((c) => c !== ws);
      },
    },
  });
}

afterEach(() => {
  ob?.destroy();
  server?.stop(true);
  connections = [];
});

afterAll(() => {
  delete process.env.ORDERBOOK_WS_URL;
  delete process.env.MARKET_ASSET;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("OrderBook", () => {
  // ── Snapshot ────────────────────────────────────────────────────────────────

  test("applies initial book snapshot — correct best bids for UP and DOWN", async () => {
    createServer((ws) => {
      ws.send(JSON.stringify(fixtureData.snapshot));
    });

    ob = new OrderBook();
    ob.subscribe([UP_ID, DOWN_ID]);
    await ob.waitForReady();

    expect(ob.bestBidPrice("UP")).toBeCloseTo(0.5, 5);
    expect(ob.bestBidPrice("DOWN")).toBeCloseTo(0.49, 5);
  });

  test("applies initial book snapshot — correct best asks for UP and DOWN", async () => {
    createServer((ws) => {
      ws.send(JSON.stringify(fixtureData.snapshot));
    });

    ob = new OrderBook();
    ob.subscribe([UP_ID, DOWN_ID]);
    await ob.waitForReady();

    const upAsk = ob.bestAskInfo("UP");
    const downAsk = ob.bestAskInfo("DOWN");

    expect(upAsk?.price).toBeCloseTo(0.51, 5);
    expect(downAsk?.price).toBeCloseTo(0.5, 5);
  });

  test("bestBidInfo returns correct price and liquidity after snapshot", async () => {
    createServer((ws) => {
      ws.send(JSON.stringify(fixtureData.snapshot));
    });

    ob = new OrderBook();
    ob.subscribe([UP_ID, DOWN_ID]);
    await ob.waitForReady();

    const info = ob.bestBidInfo("UP");
    // best bid for UP: price=0.50, size=88 → liquidity = 0.50 * 88 = 44
    expect(info).not.toBeNull();
    expect(info!.price).toBeCloseTo(0.5, 5);
    expect(info!.liquidity).toBeCloseTo(0.5 * 88, 4);
  });

  test("bestAskInfo returns correct price and liquidity after snapshot", async () => {
    createServer((ws) => {
      ws.send(JSON.stringify(fixtureData.snapshot));
    });

    ob = new OrderBook();
    ob.subscribe([UP_ID, DOWN_ID]);
    await ob.waitForReady();

    const info = ob.bestAskInfo("DOWN");
    // best ask for DOWN: price=0.50, size=88 → liquidity = 0.50 * 88 = 44
    expect(info).not.toBeNull();
    expect(info!.price).toBeCloseTo(0.5, 5);
    expect(info!.liquidity).toBeCloseTo(0.5 * 88, 4);
  });

  // ── tick_size carried by first book message ──────────────────────────────────

  test("stores tick_size from snapshot book message", async () => {
    createServer((ws) => {
      ws.send(JSON.stringify(fixtureData.snapshot));
    });

    ob = new OrderBook();
    ob.subscribe([UP_ID, DOWN_ID]);
    await ob.waitForReady();

    // Snapshot first book message has tick_size "0.01" — applied to both IDs
    expect(ob.getTickSize(UP_ID)).toBe("0.01");
    expect(ob.getTickSize(DOWN_ID)).toBe("0.01");
  });

  // ── getTokenId ───────────────────────────────────────────────────────────────

  test("getTokenId returns the correct asset IDs", async () => {
    createServer((ws) => {
      ws.send(JSON.stringify(fixtureData.snapshot));
    });

    ob = new OrderBook();
    ob.subscribe([UP_ID, DOWN_ID]);
    await ob.waitForReady();

    expect(ob.getTokenId("UP")).toBe(UP_ID);
    expect(ob.getTokenId("DOWN")).toBe(DOWN_ID);
  });

  // ── price_change — BUY (bid) update ─────────────────────────────────────────

  test("price_change BUY — adds new bid level and updates best bid", async () => {
    let step = 0;
    createServer((ws) => {
      if (step === 0) {
        ws.send(JSON.stringify(fixtureData.snapshot));
        step = 1;
      }
    });

    ob = new OrderBook();
    ob.subscribe([UP_ID, DOWN_ID]);
    await ob.waitForReady();

    // Send price_change from server; wait for it to be applied
    connections[0]!.send(JSON.stringify(fixtureData.priceChange));
    // priceChange adds bid level 0.54 with size 200 → new best bid
    await waitFor(() => ob.bestBidPrice("UP") !== 0.5);

    expect(ob.bestBidPrice("UP")).toBeCloseTo(0.54, 5);
  });

  // ── price_change — SELL (ask) update ────────────────────────────────────────

  test("price_change SELL — updates existing ask level size", async () => {
    let step = 0;
    createServer((ws) => {
      if (step === 0) {
        ws.send(JSON.stringify(fixtureData.snapshot));
        step = 1;
      }
    });

    ob = new OrderBook();
    ob.subscribe([UP_ID, DOWN_ID]);
    await ob.waitForReady();

    // Capture baseline liquidity at best ask before update
    const before = ob.bestAskInfo("UP");
    expect(before?.price).toBeCloseTo(0.51, 5);
    expect(before?.liquidity).toBeCloseTo(0.51 * 955, 4); // size was 955

    connections[0]!.send(JSON.stringify(fixtureData.priceChangeAsk));
    // priceChangeAsk sets ask level 0.51 → size 99
    await waitFor(() => {
      const info = ob.bestAskInfo("UP");
      return info !== null && Math.abs(info.liquidity - 0.51 * 99) < 0.001;
    });

    const after = ob.bestAskInfo("UP");
    expect(after?.price).toBeCloseTo(0.51, 5);
    expect(after?.liquidity).toBeCloseTo(0.51 * 99, 4);
  });

  // ── price_change — size=0 deletes level ─────────────────────────────────────

  test("price_change size=0 — removes bid level", async () => {
    let step = 0;
    createServer((ws) => {
      if (step === 0) {
        ws.send(JSON.stringify(fixtureData.snapshot));
        step = 1;
      }
    });

    ob = new OrderBook();
    ob.subscribe([UP_ID, DOWN_ID]);
    await ob.waitForReady();

    expect(ob.bestBidPrice("UP")).toBeCloseTo(0.5, 5);

    connections[0]!.send(JSON.stringify(fixtureData.priceChangeDelete));
    // priceChangeDelete removes bid 0.50 → best bid drops to 0.49
    await waitFor(() => {
      const best = ob.bestBidPrice("UP");
      return best !== null && Math.abs(best - 0.49) < 0.001;
    });

    expect(ob.bestBidPrice("UP")).toBeCloseTo(0.49, 5);
  });

  // ── tick_size_change ─────────────────────────────────────────────────────────

  test("tick_size_change updates stored tick size for the asset", async () => {
    let step = 0;
    createServer((ws) => {
      if (step === 0) {
        ws.send(JSON.stringify(fixtureData.snapshot));
        step = 1;
      }
    });

    ob = new OrderBook();
    ob.subscribe([UP_ID, DOWN_ID]);
    await ob.waitForReady();

    expect(ob.getTickSize(UP_ID)).toBe("0.01");

    connections[0]!.send(JSON.stringify(fixtureData.tickSizeChange));
    await waitFor(() => ob.getTickSize(UP_ID) !== "0.01");

    expect(ob.getTickSize(UP_ID)).toBe("0.001");
    // DOWN_ID is unaffected by a change targeted at UP_ID
    expect(ob.getTickSize(DOWN_ID)).toBe("0.01");
  });

  // ── last_trade_price ─────────────────────────────────────────────────────────

  test("last_trade_price stores fee rate in bps", async () => {
    let step = 0;
    createServer((ws) => {
      if (step === 0) {
        ws.send(JSON.stringify(fixtureData.snapshot));
        step = 1;
      }
    });

    ob = new OrderBook();
    ob.subscribe([UP_ID, DOWN_ID]);
    await ob.waitForReady();

    // Default before any last_trade_price message
    expect(ob.getFeeRate(UP_ID)).toBe(1000);

    connections[0]!.send(JSON.stringify(fixtureData.lastTradePriceUp));
    await waitFor(() => ob.getFeeRate(UP_ID) !== 1000);

    expect(ob.getFeeRate(UP_ID)).toBe(200);
    // DOWN_ID unchanged
    expect(ob.getFeeRate(DOWN_ID)).toBe(1000);
  });

  // ── getSnapshotData ──────────────────────────────────────────────────────────

  test("getSnapshotData returns structured top-5 levels for both books", async () => {
    createServer((ws) => {
      ws.send(JSON.stringify(fixtureData.snapshot));
    });

    ob = new OrderBook();
    ob.subscribe([UP_ID, DOWN_ID]);
    await ob.waitForReady();

    const data = ob.getSnapshotData() as {
      up: { bids: [number, number][]; asks: [number, number][] };
      down: { bids: [number, number][]; asks: [number, number][] };
    };

    expect(data.up).not.toBeNull();
    expect(data.down).not.toBeNull();

    // UP bids sorted desc: 0.50, 0.49, 0.48, 0.47, 0.46
    expect(data.up.bids[0]![0]).toBeCloseTo(0.5, 5);
    expect(data.up.bids[4]![0]).toBeCloseTo(0.46, 5);

    // UP asks sorted asc: 0.51, 0.52, 0.53, 0.54, 0.55  (0.56 is 6th, not in top-5)
    expect(data.up.asks[0]![0]).toBeCloseTo(0.51, 5);
    expect(data.up.asks[4]![0]).toBeCloseTo(0.55, 5);

    // DOWN bids sorted desc: 0.49, 0.48, 0.47, 0.46, 0.45  (0.44 is 6th)
    expect(data.down.bids[0]![0]).toBeCloseTo(0.49, 5);
    expect(data.down.asks[0]![0]).toBeCloseTo(0.5, 5);
  });

  // ── getDisplayLines ──────────────────────────────────────────────────────────

  test("getDisplayLines returns waiting message before snapshot", async () => {
    // Server never sends a snapshot
    createServer(() => {});

    ob = new OrderBook();
    ob.subscribe([UP_ID, DOWN_ID]);

    // Give the WS time to connect but not receive any data
    await waitFor(() => connections.length > 0);

    const lines = ob.getDisplayLines();
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("Waiting");
  });

  test("getDisplayLines returns table lines after snapshot", async () => {
    let step = 0;
    createServer((ws) => {
      if (step === 0) {
        ws.send(JSON.stringify(fixtureData.snapshot));
        step = 1;
      }
    });

    ob = new OrderBook();
    ob.subscribe([UP_ID, DOWN_ID]);
    await ob.waitForReady();

    // Send fee rate messages for both sides so the table shows "(fee: 1000bps)"
    connections[0]!.send(JSON.stringify(fixtureData.lastTradePriceUp));
    connections[0]!.send(JSON.stringify(fixtureData.lastTradePriceDown));
    await waitFor(
      () =>
        (ob as any).feeRates.has(UP_ID) && (ob as any).feeRates.has(DOWN_ID),
    );

    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
    const output = ob.getDisplayLines().map(stripAnsi).join("\n");

    const expected = [
      "UP   Ask: $25,809  Bid: $3,166    DOWN   Ask: $25,770  Bid: $3,448",
      "\r",
      "── UP (fee: 200bps)            ── DOWN (fee: 1000bps)      ",
      "   BID    SIZE   ASK    SIZE      BID    SIZE   ASK    SIZE",
      "  0.50      88  0.51     955     0.49     955  0.50      88",
      "  0.49      83  0.52     109     0.48     109  0.51      83",
      "  0.48     153  0.53     116     0.47     116  0.52     153",
      "  0.47     168  0.54      33     0.46      33  0.53     168",
      "  0.46     125  0.55     351     0.45     351  0.54     125",
    ].join("\n");

    expect(output).toBe(expected);
  });

  // ── calculateBuy (private — accessed via cast) ────────────────────────────────

  test("calculateBuy walks ask levels and returns correct cost/shares/profit", async () => {
    createServer((ws) => {
      ws.send(JSON.stringify(fixtureData.snapshot));
    });

    ob = new OrderBook();
    ob.subscribe([UP_ID, DOWN_ID]);
    await ob.waitForReady();

    // UP asks (asc): [0.51,955], [0.52,109], ...
    // Spend $10:
    //   Level 0.51: costForAll = 955 * 0.51 = 487.05 > 10
    //               → shares += 10 / 0.51 ≈ 19.6078..., remaining = 0
    // cost = 10, payout = shares, profit = payout - cost
    const result = (ob as any).calculateBuy(UP_ID, 10) as {
      cost: number;
      shares: number;
      payout: number;
      profit: number;
    };

    expect(result).not.toBeNull();
    expect(result.cost).toBeCloseTo(10, 5);
    expect(result.shares).toBeCloseTo(10 / 0.51, 4);
    expect(result.payout).toBeCloseTo(result.shares, 8);
    expect(result.profit).toBeCloseTo(result.payout - 10, 8);
  });

  test("calculateBuy handles low liquidity — cost is less than requested amount", async () => {
    // Send a custom snapshot with only one thin ask level for UP
    const thinSnapshot = [
      {
        event_type: "book",
        asset_id: UP_ID,
        bids: [{ price: "0.51", size: "10" }],
        asks: [{ price: "0.60", size: "5" }], // only 5 shares available at 0.60
      },
      {
        event_type: "book",
        asset_id: DOWN_ID,
        bids: [{ price: "0.48", size: "10" }],
        asks: [{ price: "0.49", size: "10" }],
      },
    ];

    createServer((ws) => {
      ws.send(JSON.stringify(thinSnapshot));
    });

    ob = new OrderBook();
    ob.subscribe([UP_ID, DOWN_ID]);
    await ob.waitForReady();

    // Try to spend $10 but only 5 shares @ $0.60 = $3 available
    const result = (ob as any).calculateBuy(UP_ID, 10) as {
      cost: number;
      shares: number;
      payout: number;
      profit: number;
    };

    expect(result).not.toBeNull();
    expect(result.cost).toBeCloseTo(3, 5); // only $3 spent
    expect(result.shares).toBeCloseTo(5, 5);
    expect(result.profit).toBeCloseTo(5 - 3, 5); // payout - cost
  });

  test("calculateBuy returns null when book has no asks", async () => {
    // Snapshot with empty asks for UP
    const emptyAsksSnapshot = [
      {
        event_type: "book",
        asset_id: UP_ID,
        bids: [{ price: "0.51", size: "10" }],
        asks: [],
      },
      {
        event_type: "book",
        asset_id: DOWN_ID,
        bids: [{ price: "0.48", size: "10" }],
        asks: [{ price: "0.49", size: "10" }],
      },
    ];

    createServer((ws) => {
      ws.send(JSON.stringify(emptyAsksSnapshot));
    });

    ob = new OrderBook();
    ob.subscribe([UP_ID, DOWN_ID]);
    await ob.waitForReady();

    const result = (ob as any).calculateBuy(UP_ID, 10);
    expect(result).toBeNull();
  });
});
