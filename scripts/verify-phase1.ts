// Server-side verification of the Phase 1 data layer (no Discord needed).
// Runs the same store code /setup uses, against the live DynamoDB table.
import * as store from "../packages/bot/src/store";

const GID = process.env.VERIFY_GID ?? "verify-sandbox";

async function main() {
  console.log(`Seeding guild "${GID}" (same path as /setup)…\n`);
  await store.seedDefaults(GID);
  const cfg = await store.getConfig(GID);
  await store.putConfig(GID, { ...cfg, officerRoleId: "123456789" });

  const config = await store.getConfig(GID);
  const lines = await store.listLines(GID);
  const catalog = await store.listCatalog(GID);

  console.log("CONFIG:", JSON.stringify(config));
  console.log(
    "\nLINES:",
    lines.map((l) => `${l.name} (final=${l.finalItemId}, ref=$${l.referencePrice})`).join("; ")
  );
  console.log(
    "\nCATALOG:",
    catalog
      .sort((a, b) => a.kind.localeCompare(b.kind))
      .map((c) => `${c.id}=$${c.value}[${c.kind}/${c.source ?? "shared"}]`)
      .join(", ")
  );
  console.log(`\n✅ ${lines.length} line, ${catalog.length} catalog items written & read back.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
