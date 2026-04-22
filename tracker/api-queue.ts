import { fetchWithRetry } from "../utils/fetch-retry";
import { Env } from "../utils/config";
import type { Slot } from "../utils/slot";

const variantMap: Record<string, string> = {
  "5m": "fiveminute",
  "15m": "fifteen",
};
const variant = variantMap[Env.get("MARKET_WINDOW")] ?? "fiveminute";

export type MarketData = {
  startTime: number;
  endTime: number;
  completed: boolean;
  openPrice: number;
  closePrice: number | null;
};

export type EventResponse = {
  id: string;
  ticker: string;
  negRisk: boolean;
  markets: {
    id: string;
    conditionId: string;
    clobTokenIds: string; // JSON array string e.g. '["upId","downId"]'
    outcomes: string; // JSON array string e.g. '["Up","Down"]'
    outcomePrices: string; // JSON array string e.g. '["0.99","0.01"]'
    closed: boolean;
    feeSchedule?: {
      rate: number;
      exponent: number;
      takerOnly: boolean;
      rebateRate: number;
    };
  }[];
};

export class APIQueue {
  private eventResponse: Map<string, EventResponse> = new Map();
  private _marketResult: Map<number, MarketData> = new Map();
  private _queuedSlots = new Set<number>();

  get eventDetails() {
    return this.eventResponse;
  }

  get marketResult() {
    return this._marketResult;
  }

  async queueEventDetails(slug: string) {
    const res = await fetchWithRetry(
      `https://gamma-api.polymarket.com/events?slug=${slug}`,
    );
    const event: EventResponse = ((await res.json()) as any[])[0];
    this.eventResponse.set(slug, event);
  }

  queueMarketPrice(slot: Slot): { cancel: () => void } {
    if (this._queuedSlots.has(slot.startTime)) return { cancel: () => {} };
    this._queuedSlots.add(slot.startTime);

    const { startTime, endTime } = slot;
    const controller = new AbortController();

    const url = new URL("https://polymarket.com/api/crypto/crypto-price");
    url.searchParams.set("symbol", Env.getAssetConfig().apiSymbol);
    url.searchParams.set("variant", variant);
    url.searchParams.set("eventStartTime", startTime.toString());
    url.searchParams.set("endDate", endTime.toString());

    fetchWithRetry(url, {
      options: { headers: { Accept: "application/json" } },
      // The API now requires TLSv1.3 with mlkem768x25519 which is only available
      // in latest curl 8.19.0. Bun or Node is compiled with latest BoringSSL
      // which causes ECONNRESET.
      useCurl: true,
      totalRetry: Number.MAX_VALUE,
      abort: controller.signal,
      resolveWhen: async (res) => {
        const data = (await res.json()) as MarketData;
        if (data.openPrice) this.marketResult.set(slot.startTime, data);
        if (!data.closePrice) throw new Error("Close price not set");
      },
      onError: (e: unknown) => {
        const code = (e as any)?.code;
        if (code === "ECONNRESET") {
          console.error(
            "\n[fatal] ECONNRESET on crypto-price API — flip useCurl to true in queueMarketPrice() to fix it.\n",
          );
          process.exit(1);
        }
      },
      retryBackOff: (currentRetry) => {
        // market data is set delay by 5s
        // once open price is set we do not do exponential retry delay
        if (this.marketResult.get(slot.startTime)) {
          return 8000;
        } else {
          return currentRetry * 500;
        }
      },
    });

    return { cancel: () => controller.abort() };
  }
}
