import type { Strategy } from "./types.ts";
import { simulationStrategy } from "./simulation.ts";
import { lateEntry } from "./late-entry.ts";
import { orderflowSignalStrategy } from "./orderflow-signal.ts";

export const strategies: Record<string, Strategy> = {
  "simulation": simulationStrategy,
  "late-entry": lateEntry,
  "orderflow-signal": orderflowSignalStrategy,
};

export const DEFAULT_STRATEGY = "orderflow-signal";

export type { Strategy, StrategyContext } from "./types.ts";
