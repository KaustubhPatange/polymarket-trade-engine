import { mock } from "bun:test";

type MockEntry = { clear: () => void };

/**
 * Manages module mocks with proper restoration.
 *
 * Workaround for https://github.com/oven-sh/bun/issues/7823 —
 * mock.module() does not restore on its own, so we re-call it with the
 * original spread to restore the previous exports.
 *
 * Usage:
 *   const mocker = new ModuleMocker();
 *   await mocker.mock("../../tracker/orderbook.ts", () => ({ OrderBook: ... }));
 *   afterAll(() => mocker.clear());
 */
export class ModuleMocker {
  private mocks: MockEntry[] = [];

  async mock(
    modulePath: string,
    factory: () => Record<string, unknown>,
  ): Promise<void> {
    const original = { ...(await import(modulePath)) };
    const result = { ...original, ...factory() };
    mock.module(modulePath, () => result);
    this.mocks.push({
      clear: () => mock.module(modulePath, () => original),
    });
  }

  clear(): void {
    this.mocks.forEach((m) => m.clear());
    this.mocks = [];
  }
}
