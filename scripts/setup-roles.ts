// Configure a guild with one "root level" role per rank level (I–V) and map
// each to its level in Cutter's data. Idempotent: removes any prior Cutter-
// managed roles (old per-title roles or re-runs) before creating the set.
//
// Requires the app invited with the `bot` scope + Manage Roles permission.
// Run: GUILD_ID=<id> TABLE_NAME=Cutter AWS_PROFILE=cutter AWS_REGION=us-east-1 \
//        npx ts-node scripts/setup-roles.ts
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import * as store from "../packages/bot/src/store";
import * as db from "../packages/bot/src/db";

const GID = process.env.GUILD_ID;
if (!GID) throw new Error("set GUILD_ID");

// One role per level — the level/tier roles.
const TIERS: { level: number; name: string; color: number }[] = [
  { level: 1, name: "Leadership", color: 0xe8b84b },
  { level: 2, name: "Consigliere", color: 0xc0c0c0 },
  { level: 3, name: "Capos", color: 0xcd7f32 },
  { level: 4, name: "Enforcers", color: 0x5865f2 },
  { level: 5, name: "Associates", color: 0x95a5a6 },
];

// Old per-title roles from the first pass — cleaned up so we end on just the 5.
const OLD_TITLES = [
  "Don", "Underboss", "Captain", "Soldier", "Warlord", "Ambassador",
  "Corner Boss", "Street Soldier", "Dealer", "Supplier", "Hittaz",
  "Goon", "Hustler", "Runners", "Lookouts",
];
const MANAGED = new Set<string>([...OLD_TITLES, ...TIERS.map((t) => t.name)]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let TOKEN = "";
async function api(path: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${TOKEN}`,
      "content-type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (res.status === 429 && attempt < 6) {
    const body: any = await res.clone().json().catch(() => ({}));
    await sleep((body.retry_after ?? 1) * 1000 + 300);
    return api(path, init, attempt + 1);
  }
  return res;
}

async function main() {
  const sm = new SecretsManagerClient({});
  const secret = await sm.send(
    new GetSecretValueCommand({ SecretId: "cutter/discord" })
  );
  TOKEN = JSON.parse(secret.SecretString ?? "{}").botToken;
  if (!TOKEN) throw new Error("no botToken in secret");

  // 1. remove any prior Cutter-managed roles
  const roles: any[] = await (await api(`/guilds/${GID}/roles`)).json();
  for (const r of roles.filter((r) => MANAGED.has(r.name))) {
    const d = await api(`/guilds/${GID}/roles/${r.id}`, {
      method: "DELETE",
      headers: { "X-Audit-Log-Reason": "Cutter: switch to per-level roles" },
    });
    console.log(`  removed ${r.name}${d.ok ? "" : ` (FAIL ${d.status})`}`);
    await sleep(400);
  }

  // 2. clear the old rank map
  for (const m of await store.listRanks(GID!)) {
    await db.deleteItem(db.gpk(GID!), `RANK#${m.roleId}`);
  }

  // 3. create the 5 level roles (lowest first → highest ends on top), map to levels
  console.log("\nCreating level roles…");
  for (const tier of [...TIERS].reverse()) {
    const res = await api(`/guilds/${GID}/roles`, {
      method: "POST",
      headers: { "X-Audit-Log-Reason": "Cutter rank setup" },
      body: JSON.stringify({ name: tier.name, color: tier.color, hoist: true, mentionable: false }),
    });
    if (!res.ok) {
      console.error(`  FAIL ${tier.name}: ${res.status} ${await res.text()}`);
      continue;
    }
    const role: any = await res.json();
    await store.putRank(GID!, role.id, tier.level);
    console.log(`  L${tier.level}  ${tier.name.padEnd(12)} ${role.id}`);
    await sleep(400);
  }

  console.log(`\n✅ ${(await store.listRanks(GID!)).length} level roles mapped (I→V).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
