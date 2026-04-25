import { describe, test, expect } from "bun:test";
import { PriceLevelMap } from "../../utils/price-level-map.ts";

describe("PriceLevelMap", () => {
  test("asc map: best returns lowest price", () => {
    const map = new PriceLevelMap("asc");
    map.set(30, 1);
    map.set(10, 1);
    map.set(20, 1);
    expect(map.best).toBe(10);
  });

  test("desc map: best returns highest price", () => {
    const map = new PriceLevelMap("desc");
    map.set(10, 1);
    map.set(30, 1);
    map.set(20, 1);
    expect(map.best).toBe(30);
  });

  test("set updates existing price level", () => {
    const map = new PriceLevelMap("asc");
    map.set(10, 5);
    map.set(10, 8);
    expect(map.get(10)).toBe(8);
  });

  test("delete removes price level", () => {
    const map = new PriceLevelMap("asc");
    map.set(10, 5);
    map.delete(10);
    expect(map.get(10)).toBeUndefined();
    expect(map.size).toBe(0);
  });

  test("delete non-existent key is safe", () => {
    const map = new PriceLevelMap("asc");
    expect(() => map.delete(999)).not.toThrow();
  });

  test("clear resets map and liquidity", () => {
    const map = new PriceLevelMap("asc");
    map.set(10, 5);
    map.set(20, 3);
    map.clear();
    expect(map.size).toBe(0);
    expect(map.totalLiquidity).toBe(0);
    expect(map.best).toBeNull();
  });

  test("totalLiquidity tracks correctly on set", () => {
    const map = new PriceLevelMap("asc");
    map.set(10, 5); // 10 * 5 = 50
    expect(map.totalLiquidity).toBe(50);
    map.set(20, 3); // 50 + 20 * 3 = 110
    expect(map.totalLiquidity).toBe(110);
  });

  test("totalLiquidity adjusts on update", () => {
    const map = new PriceLevelMap("asc");
    map.set(10, 5); // 50
    map.set(10, 8); // removes 50, adds 80
    expect(map.totalLiquidity).toBe(80);
  });

  test("totalLiquidity adjusts on delete", () => {
    const map = new PriceLevelMap("asc");
    map.set(10, 5); // 50
    map.set(20, 3); // 110
    map.delete(10); // 110 - 50 = 60
    expect(map.totalLiquidity).toBe(60);
  });

  test("size returns correct count", () => {
    const map = new PriceLevelMap("asc");
    expect(map.size).toBe(0);
    map.set(10, 1);
    map.set(20, 1);
    expect(map.size).toBe(2);
  });

  test("best returns null for empty map", () => {
    const map = new PriceLevelMap("asc");
    expect(map.best).toBeNull();
  });

  test("entries iterates in sorted order (asc)", () => {
    const map = new PriceLevelMap("asc");
    map.set(30, 3);
    map.set(10, 1);
    map.set(20, 2);
    const prices = [...map.entries()].map(([p]) => p);
    expect(prices).toEqual([10, 20, 30]);
  });

  test("entries iterates in sorted order (desc)", () => {
    const map = new PriceLevelMap("desc");
    map.set(10, 1);
    map.set(30, 3);
    map.set(20, 2);
    const prices = [...map.entries()].map(([p]) => p);
    expect(prices).toEqual([30, 20, 10]);
  });

  test("top(n) returns first n levels", () => {
    const map = new PriceLevelMap("asc");
    map.set(30, 3);
    map.set(10, 1);
    map.set(20, 2);
    const result = map.top(2);
    expect(result).toEqual([
      [10, 1],
      [20, 2],
    ]);
  });

  test("top(n) returns all if n > size", () => {
    const map = new PriceLevelMap("asc");
    map.set(10, 1);
    map.set(20, 2);
    const result = map.top(10);
    expect(result).toEqual([
      [10, 1],
      [20, 2],
    ]);
  });
});
