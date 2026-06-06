// Create the Midnight Mafia rank hierarchy in a guild (via the bot, ToS-compliant)
// and pre-map each role to its level in Cutter's data layer.
//
// Requires the app re-invited with the `bot` scope + Manage Roles permission.
// Run: GUILD_ID=<id> TABLE_NAME=Cutter AWS_PROFILE=cutter AWS_REGION=us-east-1 \
//        npx ts-node scripts/setup-roles.ts
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import * as store from "../packages/bot/src/store";

const GID = process.env.GUILD_ID;
if (!GID) throw new Error("set GUILD_ID");

const HIERARCHY: { level: number; color: number; roles: string[] }[] = [
  { level: 1, color: 0xe8b84b, roles: ["Don", "Underboss"] },
  { level: 2, color: 0xc0c0c0, roles: ["Captain", "Soldier", "Warlord"] },
  { level: 3, color: 0xcd7f32, roles: ["Ambassador", "Corner Boss", "Street Soldier", "Dealer", "Supplier"] },
  { level: 4, color: 0x5865f2, roles: ["Hittaz", "Goon", "Hustler"] },
  { level: 5, color: 0x95a5a6, roles: ["Runners", "Lookouts"] },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const sm = new SecretsManagerClient({});
  const secret = await sm.send(
    new GetSecretValueCommand({ SecretId: "cutter/discord" })
  );
  const { botToken } = JSON.parse(secret.SecretString ?? "{}");
  if (!botToken) throw new Error("no botToken in secret");

  console.log(`Creating rank roles in guild ${GID}…\n`);
  // Create lowest level first so higher ranks land higher in the role list.
  for (const tier of [...HIERARCHY].reverse()) {
    for (const name of [...tier.roles].reverse()) {
      const res = await fetch(`https://discord.com/api/v10/guilds/${GID}/roles`, {
        method: "POST",
        headers: {
          Authorization: `Bot ${botToken}`,
          "content-type": "application/json",
          "X-Audit-Log-Reason": "Cutter rank setup",
        },
        body: JSON.stringify({ name, color: tier.color, hoist: false, mentionable: false }),
      });
      if (!res.ok) {
        console.error(`  FAIL  ${name}: ${res.status} ${await res.text()}`);
        if (res.status === 429) await sleep(3000);
        continue;
      }
      const role: any = await res.json();
      await store.putRank(GID!, role.id, tier.level);
      console.log(`  L${tier.level}  ${name.padEnd(16)} ${role.id}`);
      await sleep(400); // be gentle with rate limits
    }
  }

  const ranks = await store.listRanks(GID!);
  console.log(`\n✅ ${ranks.length} role→level mappings written to DynamoDB.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
