import { Env } from "../utils/config";
import {
  createReconnectingWs,
  type ReconnectingWs,
} from "../utils/reconnecting-ws";

const COINBASE_WS_URL = "wss://ws-feed.exchange.coinbase.com";

// Maximum acceptable lag between Binance event time and current time
const MAX_STALENESS_MS = 1000; // 1 second
// Killswitch: abort trading if Binance/Coinbase diverge by more than $50 absolute
const KILLSWITCH_THRESHOLD = 50.0;
// Whale dump: Coinbase diverges from Binance by more than 0.15%
const WHALE_DUMP_THRESHOLD_PCT = 0.0015;

export class TickerTracker {
  private polymarketWs?: ReconnectingWs;
  private binanceWs?: ReconnectingWs;
  private coinbaseWs?: ReconnectingWs;
  private polymarketValue?: number;
  private binanceValue?: number;
  private coinbaseValue?: number;
  private validated = false;

  get price() {
    return this.polymarketValue ?? this.binanceValue ?? this.coinbaseValue;
  }

  get coinbasePrice() {
    return this.coinbaseValue;
  }

  get binancePrice() {
    return this.binanceValue;
  }

  // True when Binance/Coinbase diverge by more than $50 — market is structurally broken.
  get isKillswitch(): boolean {
    if (!this.divergence) return false;
    return this.divergence > KILLSWITCH_THRESHOLD;
  }

  // True when Coinbase drops vs Binance by more than 0.15% — whale dump signal.
  get isWhaleDump(): boolean {
    if (!this.price || !this.coinbaseValue) return false;
    return (
      Math.abs(this.coinbaseValue - this.price) >
      this.price * WHALE_DUMP_THRESHOLD_PCT
    );
  }

  get divergence(): number | null {
    if (!this.price || !this.coinbaseValue) return null;
    return Math.abs(this.coinbaseValue - this.price);
  }

  /** Resolves once every stream configured in TICKER has received its first price. */
  waitForReady(): Promise<void> {
    return new Promise<void>((resolve) => {
      const streams = Env.get("TICKER");
      const isReady = () =>
        (streams.indexOf("polymarket") === -1 ||
          this.polymarketValue !== undefined) &&
        (streams.indexOf("binance") === -1 ||
          this.binanceValue !== undefined) &&
        (streams.indexOf("coinbase") === -1 ||
          this.coinbaseValue !== undefined);
      if (isReady()) {
        resolve();
        return;
      }
      const interval = setInterval(() => {
        if (isReady()) {
          clearInterval(interval);
          resolve();
        }
      }, 100);
    });
  }

  schedule() {
    this.destroy();
    this.validated = false;

    const streams = Env.get("TICKER");
    if (streams.indexOf("polymarket") != -1) {
      this.connectPolymarket();
    }
    if (streams.indexOf("binance") != -1) {
      this.connectBinance();
    }
    if (streams.indexOf("coinbase") != -1) {
      this.connectCoinbase();
    }
  }

  private connectBinance() {
    const { binanceStream } = Env.getAssetConfig();
    this.binanceWs = createReconnectingWs({
      url: `wss://stream.binance.com:9443/ws/${binanceStream}@ticker`,
      label: "Binance",
      onmessage: (event) => {
        if (!event.data) return;
        const json = JSON.parse(event.data as string);
        const price = parseFloat(json.c); // "c" = last price
        if (!price) return;

        if (!this.validated) {
          this.validated = true;
          const eventTime: number = json.E; // "E" = event time ms
          if (eventTime) {
            const lagMs = Date.now() - eventTime;
            if (lagMs > MAX_STALENESS_MS) {
              const lagSec = Math.round(lagMs / 1000);
              console.error(
                `[Price Feed] Binance price feed is stale: event is ${lagSec}s behind current time (max allowed: ${MAX_STALENESS_MS / 1000}s). Exiting.`,
              );
              process.exit(1);
            }
          }
        }

        this.binanceValue = price;
      },
      onerror: (err) => console.error("Binance WS error:", err),
    });
  }

  private connectCoinbase() {
    const { coinbaseProduct } = Env.getAssetConfig();
    this.coinbaseWs = createReconnectingWs({
      url: COINBASE_WS_URL,
      label: "Coinbase",
      onopen: (ws) => {
        ws.send(
          JSON.stringify({
            type: "subscribe",
            product_ids: [coinbaseProduct],
            channels: ["ticker"],
          }),
        );
      },
      onmessage: (event) => {
        if (!event.data) return;
        const json = JSON.parse(event.data as string);
        if (json.type !== "ticker") return;
        const price = parseFloat(json.price);
        if (!price) return;
        this.coinbaseValue = price;
      },
      onerror: (err) => console.error("Coinbase WS error:", err),
    });
  }

  private connectPolymarket() {
    const WS_URL = "wss://ws-live-data.polymarket.com";
    const MARKET = Env.getAssetConfig().polymarketSymbol;

    this.polymarketWs = createReconnectingWs({
      url: WS_URL,
      label: "Polymarket",
      onopen: (ws) => {
        ws.send(
          JSON.stringify({
            action: "subscribe",
            subscriptions: [
              {
                topic: "crypto_prices_chainlink",
                type: "update",
                filters: JSON.stringify({ symbol: MARKET }),
              },
            ],
          }),
        );
      },
      onmessage: (event) => {
        if (!event.data) return;
        const json = JSON.parse(event.data as string);
        const price: number = json.payload?.value;
        if (!price) return;

        if (!this.validated) {
          this.validated = true;
          const eventTime: number = json.timestamp; // top-level timestamp ms
          if (eventTime) {
            const lagMs = Date.now() - eventTime;
            if (lagMs > MAX_STALENESS_MS) {
              const lagSec = Math.round(lagMs / 1000);
              console.error(
                `[Price Feed] Polymarket price feed is stale: event is ${lagSec}s behind current time (max allowed: ${MAX_STALENESS_MS / 1000}s). Exiting.`,
              );
              process.exit(1);
            }
          }
        }

        this.polymarketValue = price;
      },
      // Polymarket WS error: {"isTrusted":true}
      onerror: (err) =>
        console.error(
          "Polymarket WS error:",
          JSON.stringify(err) + "\n\n\n\n\n",
        ),
    });
  }

  format(): string | null {
    const parts: string[] = [];
    if (this.binanceValue !== undefined)
      parts.push(`Binance: $${this.binanceValue.toLocaleString()}`);
    if (this.coinbaseValue !== undefined)
      parts.push(`Coinbase: $${this.coinbaseValue.toLocaleString()}`);
    if (this.divergence !== null)
      parts.push(`Divergence: $${this.divergence.toFixed(2)}`);
    if (this.isWhaleDump) parts.push(`\x1b[31mWhale Dump\x1b[0m`);
    return parts.length > 0 ? parts.join("  |  ") : null;
  }

  destroy() {
    this.polymarketWs?.destroy();
    this.polymarketWs = undefined;
    this.binanceWs?.destroy();
    this.binanceWs = undefined;
    this.coinbaseWs?.destroy();
    this.coinbaseWs = undefined;
  }
}
