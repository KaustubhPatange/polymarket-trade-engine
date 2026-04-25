import { describe, test, expect, afterEach } from "bun:test";
import { fetchWithRetry } from "../../utils/fetch-retry";

let server: ReturnType<typeof Bun.serve>;
let requestCount: number;

afterEach(() => {
  server?.stop(true);
});

function createServer(handler: (req: Request) => Response | Promise<Response>) {
  requestCount = 0;
  server = Bun.serve({
    port: 0,
    fetch(req) {
      requestCount++;
      return handler(req);
    },
  });
  return `http://localhost:${server.port}`;
}

describe("fetchWithRetry", () => {
  test("returns response on first successful fetch", async () => {
    const url = createServer(() => new Response("ok", { status: 200 }));
    const res = await fetchWithRetry(url);
    expect(await (res as Response).text()).toBe("ok");
    expect(requestCount).toBe(1);
  });

  test("retries on server error and succeeds", async () => {
    const url = createServer(() => {
      if (requestCount <= 2) return new Response("fail", { status: 500 });
      return new Response("ok", { status: 200 });
    });
    const res = await fetchWithRetry(url, {
      totalRetry: 3,
      retryBackOff: () => 1,
    });
    expect(await (res as Response).text()).toBe("ok");
    expect(requestCount).toBe(3);
  });

  test("throws after exhausting all retries", async () => {
    const url = createServer(() => new Response("fail", { status: 500 }));
    expect(
      fetchWithRetry(url, {
        totalRetry: 2,
        retryBackOff: () => 1,
      }),
    ).rejects.toThrow();
  });

  test("resolveWhen transforms the response", async () => {
    const url = createServer(
      () =>
        new Response(JSON.stringify({ value: 42 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const result = await fetchWithRetry<{ value: number }>(url, {
      resolveWhen: (res) => res.json() as Promise<{ value: number }>,
    });
    expect(result.value).toBe(42);
  });

  test("respects custom retryBackOff", async () => {
    const url = createServer(() => {
      if (requestCount <= 1) return new Response("fail", { status: 500 });
      return new Response("ok", { status: 200 });
    });
    const start = Date.now();
    const res = await fetchWithRetry(url, {
      totalRetry: 2,
      retryBackOff: () => 5,
    });
    const elapsed = Date.now() - start;
    expect(await (res as Response).text()).toBe("ok");
    expect(elapsed).toBeLessThan(500);
  });

  test("retries correct number of times before throwing", async () => {
    const url = createServer(() => new Response("fail", { status: 500 }));
    try {
      await fetchWithRetry(url, {
        totalRetry: 3,
        retryBackOff: () => 1,
      });
    } catch {
      // expected
    }
    // 1 initial + 3 retries = 4 total requests
    expect(requestCount).toBe(4);
  });

  test("abort signal cancels fetch", async () => {
    // Server always fails so fetchWithRetry enters the retry/sleep path
    // where the abort signal is checked after sleeping
    const url = createServer(() => new Response("fail", { status: 500 }));
    const controller = new AbortController();
    // Abort after first request fails and enters retry backoff
    setTimeout(() => controller.abort(), 100);
    const result = await fetchWithRetry(url, {
      abort: controller.signal,
      totalRetry: 5,
      retryBackOff: () => 500,
    });
    expect(result).toBeUndefined();
  });

  test("onError is called on each retry", async () => {
    let errorCount = 0;
    const url = createServer(() => {
      if (requestCount <= 2) return new Response("fail", { status: 500 });
      return new Response("ok", { status: 200 });
    });
    const res = await fetchWithRetry(url, {
      totalRetry: 3,
      retryBackOff: () => 1,
      onError: () => {
        errorCount++;
      },
    });
    expect(await (res as Response).text()).toBe("ok");
    expect(errorCount).toBe(2);
  });

  test("onError throwing stops retrying", async () => {
    const url = createServer(() => new Response("fail", { status: 500 }));
    expect(
      fetchWithRetry(url, {
        totalRetry: 5,
        retryBackOff: () => 1,
        onError: () => {
          throw new Error("stop");
        },
      }),
    ).rejects.toThrow("stop");
    // Wait a tick for requestCount to settle
    await Bun.sleep(10);
    // initial request + at most 1 retry before onError throws on first error
    expect(requestCount).toBeLessThanOrEqual(2);
  });

  test("returns undefined when abort is already signaled", async () => {
    const url = createServer(() => new Response("ok", { status: 200 }));
    const controller = new AbortController();
    controller.abort();
    const result = await fetchWithRetry(url, {
      abort: controller.signal,
    });
    expect(result).toBeUndefined();
    expect(requestCount).toBe(0);
  });

  test("useCurl fetches via system curl", async () => {
    const url = createServer(() => new Response("curl-ok", { status: 200 }));
    const res = await fetchWithRetry(url, {
      useCurl: true,
    });
    const text = await (res as Response).text();
    expect(text).toContain("curl-ok");
  });
});
