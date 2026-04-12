#!/usr/bin/env bun
// Enable all three BTC price sources for this script
process.env["BTC_TICKER"] = "polymarket,binance,coinbase";

const windowArgIdx = process.argv.indexOf("--window");
const windowArgVal = windowArgIdx !== -1 ? process.argv[windowArgIdx + 1] : "5m";
process.env["MARKET_WINDOW"] = windowArgVal;

import { APIQueue } from "../tracker/api-queue";
import { OrderBook } from "../tracker/orderbook";
import { TickerTracker } from "../tracker/ticker";
import { toIST } from "../utils/date";
import { getSlotTS, getSlug, setMarketOffset } from "../utils/slot";
import { TerminalDisplay } from "../utils/terminal";
import { BUY_AMOUNT } from "../utils/constants";

const marketArgIdx = process.argv.indexOf("--market");
const marketArgVal = marketArgIdx !== -1 ? process.argv[marketArgIdx + 1] : undefined;
if (marketArgVal) setMarketOffset(marketArgVal);

const continuous = process.argv.includes("--continuous");

const ticker = new TickerTracker();
const apiQueue = new APIQueue();
const orderBook = new OrderBook();
const display = new TerminalDisplay();

let currentSlot = { startTime: 0, endTime: 0 };
// In fixed mode, lock to the slot resolved at startup and never transition.
const fixedSlot = continuous ? null : getSlotTS();

function subscribeSlot(slotTs: ReturnType<typeof getSlotTS>) {
  currentSlot = slotTs;
  ticker.schedule();
  apiQueue.queueMarketPrice(slotTs);
  apiQueue.queueMarketPrice(getSlotTS(-1));
  const slug = `btc-updown-5m-${slotTs.startTime / 1000}`;
  apiQueue.queueEventDetails(slug).then(() => {
    const market = apiQueue.eventDetails.get(slug)?.markets[0];
    if (market) {
      const tokenIds: string[] = JSON.parse(market.clobTokenIds);
      orderBook.subscribe(tokenIds);
    }
  });
}

function loop() {
  const slotTs = fixedSlot ?? getSlotTS();

  if (slotTs.startTime !== currentSlot.startTime) {
    subscribeSlot(slotTs);
  }

  const elapsed = Math.floor(Date.now() / 1000 - currentSlot.startTime / 1000);
  const remaining = 300 - elapsed;
  const btcPrice = ticker.price;
  const priceToBeat = apiQueue.marketResult.get(currentSlot.startTime)?.openPrice;
  const gap =
    btcPrice !== undefined && priceToBeat !== undefined
      ? btcPrice - priceToBeat
      : null;

  const btc = btcPrice ? "$" + btcPrice.toLocaleString() : "Waiting...";
  const ptb = priceToBeat ? "$" + priceToBeat.toLocaleString() : "Waiting...";
  const gapStr = gap !== null ? (gap >= 0 ? "+" : "") + gap.toFixed(0) : "--";
  const btcLine = `BTC: ${btc}  |  To Beat: ${ptb}  |  Gap: ${gapStr}  |  ${remaining}s left`;

  const tickerLine = ticker.format();

  const currentSlug = `btc-updown-5m-${currentSlot.startTime / 1000}`;
  display.update([
    `Slot: ${currentSlug}`,
    `Window: ${toIST(currentSlot.startTime)} → ${toIST(currentSlot.endTime)} IST`,
    btcLine,
    ...(tickerLine ? [tickerLine] : []),
    "\r",
    ...orderBook.getDisplayLines(BUY_AMOUNT),
  ]);

  setTimeout(() => loop());
}

loop();
