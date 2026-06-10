// Re-seed a guild's default catalog & recipes in the live table.
// Safe: only touches the seeded honey chain (replaces its steps, removes ids
// the seed has retired) — custom items, other lines, config, ranks, channels,
// and the ledger are untouched.
//
//   TABLE_NAME=Cutter AWS_PROFILE=cutter GUILD_ID=<guild id> npx ts-node scripts/seed-guild.ts
import * as store from "../packages/bot/src/store";

const guildId = process.env.GUILD_ID;
if (!guildId) throw new Error("set GUILD_ID=<guild id>");

async function main() {
  await store.seedDefaults(guildId!);
  const [items, recipes] = await Promise.all([store.listCatalog(guildId!), store.listRecipes(guildId!)]);
  console.log(`Guild ${guildId} re-seeded.`);
  console.log("ITEMS:  ", items.map((i) => i.id).sort().join(", "));
  console.log("RECIPES:", recipes.map((r) => `${r.lineId}#${r.step}`).sort().join(", "));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
