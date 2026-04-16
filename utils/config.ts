export type MarketWindow = "5m" | "15m";
export type MarketAsset = "btc" | "eth" | "xrp" | "sol" | "doge";

export type Config = {
  TICKER: ("polymarket" | "binance" | "coinbase")[];
  MARKET_WINDOW: MarketWindow;
  MARKET_ASSET: MarketAsset;
  PROD: boolean;
  PRIVATE_KEY: string;
  POLY_FUNDER_ADDRESS: string;
};

const ASSET_TICKER_MAP: Record<
  MarketAsset,
  {
    slugPrefix: string;
    binanceStream: string;
    coinbaseProduct: string;
    polymarketSymbol: string;
    apiSymbol: string;
  }
> = {
  btc: {
    slugPrefix: "btc",
    binanceStream: "btcusdt",
    coinbaseProduct: "BTC-USD",
    polymarketSymbol: "btc/usd",
    apiSymbol: "BTC",
  },
  eth: {
    slugPrefix: "eth",
    binanceStream: "ethusdt",
    coinbaseProduct: "ETH-USD",
    polymarketSymbol: "eth/usd",
    apiSymbol: "ETH",
  },
  xrp: {
    slugPrefix: "xrp",
    binanceStream: "xrpusdt",
    coinbaseProduct: "XRP-USD",
    polymarketSymbol: "xrp/usd",
    apiSymbol: "XRP",
  },
  sol: {
    slugPrefix: "sol",
    binanceStream: "solusdt",
    coinbaseProduct: "SOL-USD",
    polymarketSymbol: "sol/usd",
    apiSymbol: "SOL",
  },
  doge: {
    slugPrefix: "doge",
    binanceStream: "dogeusdt",
    coinbaseProduct: "DOGE-USD",
    polymarketSymbol: "doge/usd",
    apiSymbol: "DOGE",
  },
};

export class Env {
  private static readonly defaults: Config = {
    TICKER: ["polymarket", "coinbase"],
    MARKET_WINDOW: "5m",
    MARKET_ASSET: "btc",
    PROD: false,
    PRIVATE_KEY: "",
    POLY_FUNDER_ADDRESS: "",
  };

  static get<T extends keyof Config>(key: T): Config[T] {
    const raw = process.env[key];
    const defaultVal = this.defaults[key];

    // No env var set, return default
    if (raw === undefined) return defaultVal;

    // Infer type from default value
    if (typeof defaultVal === "boolean") {
      return (raw === "true") as Config[T];
    }

    if (Array.isArray(defaultVal)) {
      return raw.split(",").map((s) => s.trim()) as Config[T];
    }

    return raw as Config[T];
  }

  static getAssetConfig() {
    const asset = Env.get("MARKET_ASSET");
    const config = ASSET_TICKER_MAP[asset];
    if (!config) {
      throw new Error(
        `Invalid MARKET_ASSET "${asset}". Must be one of: ${Object.keys(ASSET_TICKER_MAP).join(", ")}`,
      );
    }
    return config;
  }
}
