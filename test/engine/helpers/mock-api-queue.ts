import { APIQueue } from "../../../tracker/api-queue.ts";
import type { Slot } from "../../../utils/slot.ts";

export const FIXTURE_SLUG = "btc-updown-5m-1777108200";
export const UP_TOKEN = "UP_TOKEN_ID";
export const DOWN_TOKEN = "DOWN_TOKEN_ID";
export const CONDITION_ID = "0xtest_condition_id";
// fee rate as a fraction: 1000bps = 10% = 0.1
export const FEE_RATE = 0.1;

/**
 * An APIQueue that never makes real HTTP calls.
 * Pre-populated with fixture metadata and the UP resolution from orderbook.log.
 */
export class MockAPIQueue extends APIQueue {
  constructor() {
    super();

    // Pre-populate event details for the fixture slug
    (this as any).eventResponse.set(FIXTURE_SLUG, {
      id: "test-event",
      ticker: "BTC-UPDOWN",
      negRisk: false,
      markets: [
        {
          id: "test-market",
          conditionId: CONDITION_ID,
          clobTokenIds: JSON.stringify([UP_TOKEN, DOWN_TOKEN]),
          outcomes: JSON.stringify(["Up", "Down"]),
          outcomePrices: JSON.stringify(["0.5", "0.5"]),
          closed: false,
          feeSchedule: {
            rate: FEE_RATE,
            exponent: 2,
            takerOnly: true,
            rebateRate: 0,
          },
        },
      ],
    });

    // Pre-populate the market result (UP resolution from orderbook.log)
    // slot.startTime = 1777108200000 (matches the fixture slug)
    const SLOT_START_TIME = 1777108200000;
    (this as any)._marketResult.set(SLOT_START_TIME, {
      startTime: SLOT_START_TIME,
      endTime: 1777108500000,
      completed: true,
      openPrice: 77643.36752,
      closePrice: 77644.65, // closePrice > openPrice → direction UP
    });
  }

  override async queueEventDetails(_slug: string): Promise<void> {
    // Already pre-populated — no network call
  }

  override queueMarketPrice(_slot: Slot): { cancel: () => void } {
    // Already pre-populated — no network call
    return { cancel: () => {} };
  }
}
