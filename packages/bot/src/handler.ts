import { verifyKey } from "discord-interactions";
import {
  InteractionType,
  InteractionResponseType,
  type APIInteraction,
} from "discord-api-types/v10";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import * as store from "./store";
import { buildCosts } from "@cutter/engine";
import {
  json,
  reply,
  commandName,
  subcommand,
  option,
  guildId,
  isOfficer,
  focusedOption,
  autocompleteResult,
  slug,
} from "./discord";

interface DiscordSecret {
  publicKey: string;
  appId: string;
  botToken: string;
}

const sm = new SecretsManagerClient({});
let cachedSecret: DiscordSecret | undefined;

async function getSecret(): Promise<DiscordSecret> {
  if (cachedSecret) return cachedSecret;
  const res = await sm.send(
    new GetSecretValueCommand({ SecretId: process.env.DISCORD_SECRET_ARN! })
  );
  cachedSecret = JSON.parse(res.SecretString!) as DiscordSecret;
  return cachedSecret;
}

interface ProxyEvent {
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}

export async function handler(event: ProxyEvent) {
  const sig = event.headers?.["x-signature-ed25519"];
  const ts = event.headers?.["x-signature-timestamp"];
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : event.body ?? "";

  const { publicKey } = await getSecret();
  const valid = !!sig && !!ts && (await verifyKey(rawBody, sig, ts, publicKey));
  if (!valid) return { statusCode: 401, body: "invalid request signature" };

  const interaction = JSON.parse(rawBody) as APIInteraction;

  if (interaction.type === InteractionType.Ping) {
    return json({ type: InteractionResponseType.Pong });
  }

  if (interaction.type === InteractionType.ApplicationCommandAutocomplete) {
    return handleAutocomplete(interaction);
  }

  if (interaction.type === InteractionType.ApplicationCommand) {
    try {
      return await route(interaction);
    } catch (err) {
      console.error("command error", err);
      return reply("⚠️ Something went wrong handling that command.");
    }
  }

  return json({ type: InteractionResponseType.Pong });
}

async function route(i: any) {
  switch (commandName(i)) {
    case "ping":
      return reply("🔪 Cutter is live. *pong.*");
    case "setup":
      return handleSetup(i);
    case "config":
      return handleConfig(i);
    case "catalog":
      return handleCatalog(i);
    case "rank":
      return handleRank(i);
    default:
      return reply(`Unknown command: \`${commandName(i)}\``);
  }
}

async function handleSetup(i: any) {
  const gid = guildId(i);
  const config = await store.getConfig(gid);
  if (!isOfficer(i, config)) {
    return reply("⛔ `/setup` requires the **Manage Server** permission.");
  }
  const officerRoleId = option<string>(i, "officer");
  await store.seedDefaults(gid);
  await store.putConfig(gid, { ...config, officerRoleId });
  return reply(
    [
      "🛠️ **Cutter is set up.**",
      `• Officer role: <@&${officerRoleId}>`,
      "• Seeded product line **Honey** (catalog · recipes)",
      "• Default dials: labor $25/unit · 70/30 work·rank · 8% commission · ranks 5/4/3/2/1",
      "",
      "Next: map your ranks with `/rank map`, then tune with `/config`.",
    ].join("\n")
  );
}

async function handleConfig(i: any) {
  const gid = guildId(i);
  const config = await store.getConfig(gid);
  const sub = subcommand(i);

  if (sub === "set") {
    if (!isOfficer(i, config)) return reply("⛔ Officers only.");
    const dial = option<string>(i, "dial")!;
    const value = option<number>(i, "value")!;
    if (dial === "labor-rate") config.laborRate = value;
    else if (dial === "work-split") config.workSplitPct = value / 100;
    else if (dial === "commission") config.commissionPct = value / 100;
    await store.putConfig(gid, config);
    return reply(`✅ Updated **${dial}** → ${value}.`);
  }

  // view
  const lines = await store.listLines(gid);
  const refs =
    lines.map((l) => `${l.name} $${l.referencePrice}`).join(" · ") || "—";
  const mults = Object.entries(config.rankMultipliers)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([lvl, w]) => `${w}×`)
    .join(" / ");
  return reply(
    [
      "⚙️ **Economy dials**",
      `• Labor rate: **$${config.laborRate}** / unit`,
      `• Work / Rank split: **${Math.round(config.workSplitPct * 100)} / ${Math.round(
        (1 - config.workSplitPct) * 100
      )}**`,
      `• Sell commission: **${Math.round(config.commissionPct * 100)}%**`,
      `• Rank weights (I→V): **${mults}**`,
      `• Reference prices: ${refs}`,
      `• Officer role: ${config.officerRoleId ? `<@&${config.officerRoleId}>` : "_unset_"}`,
    ].join("\n")
  );
}

async function handleAutocomplete(i: any) {
  const focused = focusedOption(i);
  if (focused?.name === "item") {
    const q = focused.value.toLowerCase();
    let items = await store.listCatalog(guildId(i));
    // /catalog set only edits base items — intermediates are derived (build cost).
    if (subcommand(i) === "set") items = items.filter((it) => it.kind === "base");
    const choices = items
      .filter((it) => it.name.toLowerCase().includes(q) || it.id.includes(q))
      .map((it) => ({
        name: `${it.name} — $${it.value}${it.source ? ` (${it.source})` : ""}`,
        value: it.id,
      }));
    return autocompleteResult(choices);
  }
  return autocompleteResult([]);
}

async function handleCatalog(i: any) {
  const gid = guildId(i);
  const config = await store.getConfig(gid);
  const sub = subcommand(i);

  if (sub === "add") {
    if (!isOfficer(i, config)) return reply("⛔ Officers only.");
    const name = option<string>(i, "name")!.trim();
    const id = slug(name);
    if (!id) return reply("⚠️ Give the item a name.");
    if (await store.getCatalogItem(gid, id)) {
      return reply(`⚠️ **${name}** already exists — use \`/catalog set\` to change its price.`);
    }
    const value = option<number>(i, "value")!;
    const source = option<"farmed" | "bought">(i, "source") ?? "bought";
    const kind = (option<string>(i, "kind") as any) ?? "base";
    await store.putCatalogItem(gid, { id, name, kind, value, source });
    return reply(`✅ Added **${name}** = $${value} (${source}, ${kind}).`);
  }

  if (sub === "set") {
    if (!isOfficer(i, config)) return reply("⛔ Officers only.");
    const id = option<string>(i, "item")!;
    const item = await store.getCatalogItem(gid, id);
    if (!item) return reply("⚠️ Pick an existing item from the list (or use `/catalog add`).");
    if (item.kind !== "base") {
      return reply(
        `⚠️ **${item.name}** is ${item.kind === "final" ? "a final product (price = the line's reference price)" : "auto-valued from its recipe (build cost)"} — edit the base ingredients or recipe instead.`
      );
    }
    item.value = option<number>(i, "value")!;
    const source = option<"farmed" | "bought">(i, "source");
    if (source) item.source = source;
    await store.putCatalogItem(gid, item);
    return reply(`✅ **${item.name}** → $${item.value}${source ? ` (${source})` : ""}.`);
  }

  if (sub === "remove") {
    if (!isOfficer(i, config)) return reply("⛔ Officers only.");
    const id = option<string>(i, "item")!;
    const item = await store.getCatalogItem(gid, id);
    if (!item) return reply("⚠️ Pick an existing item from the list.");
    await store.deleteCatalogItem(gid, id);
    return reply(`🗑️ Removed **${item.name}**.`);
  }

  // list
  const items = await store.listCatalog(gid);
  if (!items.length) return reply("📦 Catalog is empty — run `/setup` first.");
  const recipes = await store.listRecipes(gid);
  const lines = await store.listLines(gid);
  const refByFinal = new Map(lines.map((l) => [l.finalItemId, l.referencePrice]));
  const costs = buildCosts(items, recipes);
  const money = (n: number) => `$${+n.toFixed(2)}`;

  const base = items
    .filter((it) => it.kind === "base")
    .map((it) => `${it.name} ${money(it.value)}${it.source ? ` _(${it.source})_` : ""}`)
    .join(" · ") || "—";
  const inter = items
    .filter((it) => it.kind === "intermediate")
    .map((it) => `${it.name} ${money(costs[it.id] ?? 0)}`)
    .join(" · ") || "—";
  const fin = items
    .filter((it) => it.kind === "final")
    .map((it) => `${it.name} ${money(refByFinal.get(it.id) ?? costs[it.id] ?? 0)}`)
    .join(" · ") || "—";

  return reply(
    [
      "📦 **Catalog**",
      `**Base:** ${base}`,
      `**Intermediate:** ${inter}  _(auto build cost)_`,
      `**Final:** ${fin}  _(sells at reference price)_`,
    ].join("\n")
  );
}

async function handleRank(i: any) {
  const gid = guildId(i);
  const config = await store.getConfig(gid);
  const sub = subcommand(i);

  if (sub === "map") {
    if (!isOfficer(i, config)) return reply("⛔ Officers only.");
    const roleId = option<string>(i, "role")!;
    const level = option<number>(i, "level")!;
    await store.putRank(gid, roleId, level);
    return reply(`✅ <@&${roleId}> → **Level ${level}** (${config.rankMultipliers[level]}×).`);
  }
  if (sub === "unmap") {
    if (!isOfficer(i, config)) return reply("⛔ Officers only.");
    const roleId = option<string>(i, "role")!;
    await store.deleteRank(gid, roleId);
    return reply(`✅ Removed mapping for <@&${roleId}>.`);
  }
  if (sub === "weights") {
    if (!isOfficer(i, config)) return reply("⛔ Officers only.");
    const level = option<number>(i, "level")!;
    const weight = option<number>(i, "weight")!;
    config.rankMultipliers[level] = weight;
    await store.putConfig(gid, config);
    const all = Object.entries(config.rankMultipliers)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([, w]) => `${w}×`)
      .join(" / ");
    return reply(`✅ Level ${level} weight → **${weight}×**.  Now (I→V): **${all}**`);
  }

  // list
  const ranks = await store.listRanks(gid);
  if (!ranks.length) return reply("🏷️ No role→level mappings yet — use `/rank map`.");
  const body = ranks
    .sort((a, b) => a.level - b.level)
    .map((r) => `Level ${r.level} (${config.rankMultipliers[r.level]}×) — <@&${r.roleId}>`)
    .join("\n");
  return reply(`🏷️ **Rank map**\n${body}`);
}
