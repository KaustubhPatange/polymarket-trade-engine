export type LogEntry = Record<string, any>;

export type Resolution = {
  direction: "UP" | "DOWN";
  openPrice: number;
  closePrice: number;
  unfilledShares: number;
  payout: number;
  pnl: number;
};

export type Outcome = "win" | "loss" | "skip" | "incomplete";

export type ParsedRun = {
  filename: string;
  slug: string;
  strategy: string | null;
  startTime: number;
  endTime: number;
  resolution: Resolution | null;
  spend: number;
  outcome: Outcome;
  raw: LogEntry[];
};

export type Rate = "day" | "hour";

export type Bin<T> = {
  key: string;
  label: string;
  startMs: number;
  endMs: number;
  data: T;
};

export type MarketBinData = {
  up: number;
  down: number;
  runs: ParsedRun[];
};

export type SlugInfo = {
  asset: string | null;     // "BTC", "ETH", … from slug prefix
  duration: string | null;  // "5m", "15m", … from third segment
};

export type StrategyBinData = {
  wins: number;
  losses: number;
  skipped: number;
  spend: number;
  pnl: number;
  winAmount: number;
  lossAmount: number;
  runs: ParsedRun[];
};
