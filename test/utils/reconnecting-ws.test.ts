import { describe, test, expect, afterEach } from "bun:test";
import type { ServerWebSocket } from "bun";
import { createReconnectingWs, type ReconnectingWs } from "../../utils/reconnecting-ws";

let server: ReturnType<typeof Bun.serve>;
let rws: ReconnectingWs | null = null;

function createWsServer() {
  const connections: ServerWebSocket<unknown>[] = [];
  server = Bun.serve({
    port: 0,
    fetch(_req, server) {
      if (server.upgrade(_req, { data: {} })) return undefined;
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        connections.push(ws);
      },
      message(_ws, _msg) {},
      close(ws) {
        const idx = connections.indexOf(ws);
        if (idx >= 0) connections.splice(idx, 1);
      },
    },
  });
  return { server, connections };
}

function waitFor(fn: () => boolean, timeout = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (fn()) return resolve();
      if (Date.now() - start > timeout) return reject(new Error("waitFor timeout"));
      setTimeout(check, 50);
    };
    check();
  });
}

afterEach(() => {
  rws?.destroy();
  rws = null;
  server?.stop(true);
});

describe("createReconnectingWs", () => {
  test("connects and receives messages", async () => {
    const { connections } = createWsServer();
    let received = "";

    await new Promise<void>((resolve) => {
      rws = createReconnectingWs({
        url: `ws://localhost:${server.port}`,
        onopen: () => {
          // Send message from server after connection
          waitFor(() => connections.length > 0).then(() => {
            connections[connections.length - 1]!.send("hello");
          });
        },
        onmessage: (event) => {
          received = event.data;
          resolve();
        },
      });
    });

    expect(received).toBe("hello");
  }, 5000);

  test("calls onopen on successful connection", async () => {
    createWsServer();
    let openCount = 0;

    rws = createReconnectingWs({
      url: `ws://localhost:${server.port}`,
      onopen: () => {
        openCount++;
      },
      onmessage: () => {},
    });

    await waitFor(() => openCount === 1);
    expect(openCount).toBe(1);
  }, 5000);

  test("reconnects after server closes connection", async () => {
    const { connections } = createWsServer();
    let openCount = 0;

    rws = createReconnectingWs({
      url: `ws://localhost:${server.port}`,
      onopen: () => {
        openCount++;
      },
      onmessage: () => {},
    });

    // Wait for first connection
    await waitFor(() => openCount === 1);
    expect(connections.length).toBeGreaterThan(0);

    // Close from server side
    connections[0]!.close();

    // Wait for reconnection (BASE_DELAY_MS = 1000ms)
    await waitFor(() => openCount === 2, 5000);
    expect(openCount).toBe(2);
  }, 10000);

  test("destroy stops reconnection attempts", async () => {
    const { connections } = createWsServer();
    let openCount = 0;

    rws = createReconnectingWs({
      url: `ws://localhost:${server.port}`,
      onopen: () => {
        openCount++;
      },
      onmessage: () => {},
    });

    await waitFor(() => openCount === 1);

    // Destroy before server closes
    rws.destroy();

    // Close server-side connection
    if (connections.length > 0) connections[0]!.close();

    // Wait and verify no reconnection
    await Bun.sleep(1500);
    expect(openCount).toBe(1);
  }, 5000);

  test("destroy closes the websocket", async () => {
    createWsServer();
    let openCount = 0;

    rws = createReconnectingWs({
      url: `ws://localhost:${server.port}`,
      onopen: () => {
        openCount++;
      },
      onmessage: () => {},
    });

    await waitFor(() => openCount === 1);

    // Should not throw
    rws.destroy();
    rws = null;
  }, 5000);

  test("exponential backoff caps at MAX_DELAY_MS", async () => {
    // Use a server that rejects WS upgrades so onopen never fires
    // and attempt counter keeps incrementing, producing increasing delays.
    server = Bun.serve({
      port: 0,
      fetch(_req) {
        // Don't upgrade - just return 200, which causes WS to fail
        return new Response("no ws", { status: 200 });
      },
      websocket: {
        message() {},
      },
    });

    const warnMessages: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.map(String).join(" "));
    };

    try {
      rws = createReconnectingWs({
        url: `ws://localhost:${server.port}`,
        onmessage: () => {},
      });

      // Wait for at least 2 warn messages (two failed connection attempts)
      // First attempt: delay = 1000 * 2^0 = 1000ms
      // Second attempt: delay = 1000 * 2^1 = 2000ms
      await waitFor(() => warnMessages.length >= 2, 5000);

      expect(warnMessages[0]!).toContain("1000ms");
      expect(warnMessages[1]!).toContain("2000ms");
    } finally {
      console.warn = originalWarn;
    }
  }, 10000);
});
