import { Command } from "commander";
import * as readline from "readline";
import { EarlyBird } from "./engine/early-bird.ts";
import { strategies, DEFAULT_STRATEGY } from "./engine/strategy/index.ts";
import { acquireProcessLock } from "./utils/process-lock.ts";

const program = new Command()
  .description(
    "Automated trading engine for Polymarket binary prediction markets (e.g. BTC Up/Down 5-minute) ",
  )
  .option(
    "-s, --strategy <name>",
    `Strategy to run (${Object.keys(strategies).join(", ")})`,
    DEFAULT_STRATEGY,
  )
  .option(
    "--slot-offset <n>",
    "Which future market slot to pre-enter or trade in current market (1 = next slot, 2 = slot after next, …)",
    (v) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 1)
        throw new Error("--slot-offset must be a positive integer");
      return n;
    },
    1,
  )
  .option(
    "--prod",
    "Run against the real Polymarket CLOB (requires PRIVATE_KEY)",
  )
  .option(
    "--rounds <n>",
    "Number of market rounds to trade then exit (0 = recover existing only, omit for unlimited)",
    (v) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 0)
        throw new Error("--rounds must be a non-negative integer");
      return n;
    },
  )
  .option(
    "--always-log",
    "Always write the slot log file even if no market was entered (useful for debugging)",
  )
  .parse();

const opts = program.opts<{
  strategy: string;
  slotOffset: number;
  prod?: boolean;
  rounds?: number;
  alwaysLog?: boolean;
}>();

acquireProcessLock("early-bird");

if (!strategies[opts.strategy]) {
  console.error(`Unknown strategy: "${opts.strategy}"`);
  console.error(`Available: ${Object.keys(strategies).join(", ")}`);
  process.exit(1);
}

if (opts.prod && process.env.FORCE_PROD !== "true") {
  const answer = await new Promise<string>((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(
      "Run in PRODUCTION mode with real funds? Enter Y to confirm: ",
      (ans) => {
        rl.close();
        resolve(ans);
      },
    );
  });

  if (answer !== "Y") {
    console.log("Aborted.");
    process.exit(0);
  }

  process.env.PROD = "true";
}

const rounds = opts.rounds !== undefined ? opts.rounds : null;
const bot = new EarlyBird(
  opts.strategy,
  opts.slotOffset,
  opts.prod ?? false,
  rounds,
  opts.alwaysLog ?? false,
);
await bot.start();
