import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Env } from "../../utils/config.ts";

const ENV_KEYS = [
  "TICKER",
  "MARKET_WINDOW",
  "MARKET_ASSET",
  "PROD",
  "PRIVATE_KEY",
  "POLY_FUNDER_ADDRESS",
  "BUILDER_KEY",
  "BUILDER_SECRET",
  "BUILDER_PASSPHRASE",
] as const;

describe("Env.get", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  test("returns default when env var is not set", () => {
    expect(Env.get("MARKET_WINDOW")).toBe("5m");
  });

  test("returns env var value when set", () => {
    process.env.MARKET_WINDOW = "15m";
    expect(Env.get("MARKET_WINDOW")).toBe("15m");
  });

  test("parses boolean env var correctly", () => {
    process.env.PROD = "true";
    expect(Env.get("PROD")).toBe(true);

    process.env.PROD = "false";
    expect(Env.get("PROD")).toBe(false);
  });

  test("parses comma-separated array env var", () => {
    process.env.TICKER = "binance,coinbase";
    expect(Env.get("TICKER")).toEqual(["binance", "coinbase"]);
  });

  test("trims whitespace in array values", () => {
    process.env.TICKER = "binance , coinbase";
    expect(Env.get("TICKER")).toEqual(["binance", "coinbase"]);
  });

  test("returns string for string config keys", () => {
    process.env.PRIVATE_KEY = "abc";
    expect(Env.get("PRIVATE_KEY")).toBe("abc");
  });
});

describe("Env.getAssetConfig", () => {
  let savedAsset: string | undefined;

  beforeEach(() => {
    savedAsset = process.env.MARKET_ASSET;
  });

  afterEach(() => {
    if (savedAsset === undefined) {
      delete process.env.MARKET_ASSET;
    } else {
      process.env.MARKET_ASSET = savedAsset;
    }
  });

  test("returns correct config for each asset", () => {
    const assets = ["btc", "eth", "xrp", "sol", "doge"] as const;
    for (const asset of assets) {
      process.env.MARKET_ASSET = asset;
      const config = Env.getAssetConfig();
      expect(config.slugPrefix).toBe(asset);
      expect(config.binanceStream).toBe(`${asset}usdt`);
      expect(config.apiSymbol).toBe(asset.toUpperCase());
    }
  });

  test("throws for invalid asset", () => {
    process.env.MARKET_ASSET = "invalid";
    expect(() => Env.getAssetConfig()).toThrow("Invalid MARKET_ASSET");
  });
});
