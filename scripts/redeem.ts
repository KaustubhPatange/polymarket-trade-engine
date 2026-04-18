import { Command } from "commander";
import { Env } from "../utils/config.ts";
import { PolymarketEarlyBirdClient } from "../engine/client.ts";

type Position = {
  conditionId: string;
  title: string;
  outcome: string;
  size: number;
  redeemable: boolean;
};

async function fetchRedeemablePositions(
  proxyWallet: string,
): Promise<Position[]> {
  const url = `https://data-api.polymarket.com/positions?user=${proxyWallet}&redeemable=true`;
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(`Positions API error: ${res.status} ${res.statusText}`);
  return (await res.json()) as Position[];
}

const program = new Command()
  .description(
    "Batch redeem resolved Polymarket positions via on-chain CTF call",
  )
  .option(
    "--dry-run",
    "Print what would be redeemed without sending transactions",
  )
  .parse();

const opts = program.opts<{ dryRun?: boolean }>();

const isDryRun = opts.dryRun ?? false;

const proxyWallet = Env.get("POLY_FUNDER_ADDRESS");
if (!proxyWallet) {
  console.error("POLY_FUNDER_ADDRESS env var must be set");
  process.exit(1);
}

console.log(`Fetching redeemable positions for ${proxyWallet}...`);
const positions = await fetchRedeemablePositions(proxyWallet);

if (positions.length === 0) {
  console.log("No redeemable positions found.");
  process.exit(0);
}

// Deduplicate by conditionId — YES and NO tokens are separate positions, same conditionId
const seen = new Set<string>();
const markets = positions.filter((p) => {
  if (seen.has(p.conditionId)) return false;
  seen.add(p.conditionId);
  return true;
});

console.log(`Found ${markets.length} market(s) to redeem.\n`);

let client: PolymarketEarlyBirdClient | null = null;
if (!isDryRun) {
  client = new PolymarketEarlyBirdClient();
  await client.init();
}

for (const market of markets) {
  console.log(
    `[${market.title ?? market.conditionId}] conditionId: ${market.conditionId}`,
  );

  if (isDryRun) {
    console.log(`  DRY RUN — skipping tx\n`);
    continue;
  }

  try {
    await client!.redeemPositions(market.conditionId);
    console.log(`  Redeemed successfully\n`);
  } catch (e) {
    console.error(`  Redemption failed: ${e}\n`);
  }
}
