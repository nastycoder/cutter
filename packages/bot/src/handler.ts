import { verifyKey } from "discord-interactions";
import {
  InteractionType,
  InteractionResponseType,
  type APIInteraction,
} from "discord-api-types/v10";
import * as store from "./store";
import * as rest from "./rest";
import { getSecret } from "./secret";
import { buildCosts, itemValues, inventory, settle, liveEntries } from "@cutter/engine";
import type { Config } from "@cutter/shared";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const lambdaClient = new LambdaClient({});

// Commands whose work exceeds Discord's 3s window are deferred: we ACK immediately,
// then this Lambda invokes itself asynchronously to do the work and edit the reply.
function isDeferrable(i: any): boolean {
  const n = commandName(i);
  return n === "settle" || (n === "job" && subcommand(i) === "open");
}

async function invokeSelf(payload: unknown): Promise<void> {
  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME!,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify(payload)),
    })
  );
}

async function runFollowup(i: any): Promise<void> {
  try {
    const content =
      commandName(i) === "settle"
        ? await settleWork(i)
        : commandName(i) === "job" && subcommand(i) === "open"
          ? await jobOpenWork(i)
          : "Unknown deferred command.";
    await rest.editOriginal(i.application_id, i.token, content);
  } catch (e) {
    console.error("followup error", e);
    try {
      await rest.editOriginal(i.application_id, i.token, "⚠️ Something went wrong.");
    } catch {
      /* give up */
    }
  }
}
import {
  json,
  reply,
  embed,
  COLORS,
  commandName,
  subcommand,
  option,
  guildId,
  isOfficer,
  focusedOption,
  autocompleteResult,
  slug,
  actorId,
  channelId,
  snowflakeTs,
} from "./discord";

interface ProxyEvent {
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}

export async function handler(event: any) {
  // Async self-invocation: do the deferred work, then edit the original reply.
  if (event?.source === "followup") {
    await runFollowup(event.interaction);
    return;
  }

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
    if (isDeferrable(interaction)) {
      try {
        await invokeSelf({ source: "followup", interaction });
        const ephemeral = commandName(interaction) === "settle";
        return json({
          type: InteractionResponseType.DeferredChannelMessageWithSource,
          ...(ephemeral ? { data: { flags: 64 } } : {}),
        });
      } catch (e) {
        console.error("defer dispatch failed, handling inline", e);
      }
    }
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
    case "job":
      return handleJob(i);
    case "deposit":
      return handleDeposit(i);
    case "process":
      return handleProcess(i);
    case "withdraw":
      return handleWithdraw(i);
    case "sale":
      return handleSale(i);
    case "ledger":
      return handleLedger(i);
    case "status":
      return handleStatus(i);
    case "settle":
      return reply(await settleWork(i), true);
    case "me":
      return handleMe(i);
    case "void":
      return handleVoid(i);
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
    embed({
      title: "🛠️ Cutter is set up",
      color: COLORS.gold,
      description: [
        `Officer role: <@&${officerRoleId}>`,
        "Seeded product line **Honey** (catalog · recipes)",
        "Default dials: labor $25/unit · 70/30 · 8% commission · ranks 5/4/3/2/1",
        "",
        "Next: map ranks with `/rank map`, tune with `/config`.",
      ].join("\n"),
    })
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
    return reply(embed({ description: `✅ Updated **${dial}** → ${value}.`, color: COLORS.green }));
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
    embed({
      title: "⚙️ Economy dials",
      color: COLORS.gold,
      fields: [
        { name: "Labor rate", value: `$${config.laborRate} / unit`, inline: true },
        { name: "Work / Rank", value: `${Math.round(config.workSplitPct * 100)} / ${Math.round((1 - config.workSplitPct) * 100)}`, inline: true },
        { name: "Commission", value: `${Math.round(config.commissionPct * 100)}%`, inline: true },
        { name: "Rank weights (I→V)", value: mults, inline: false },
        { name: "Reference prices", value: refs, inline: false },
        { name: "Officer role", value: config.officerRoleId ? `<@&${config.officerRoleId}>` : "_unset_", inline: false },
      ],
    })
  );
}

async function handleAutocomplete(i: any) {
  const f = focusedOption(i);
  if (!f) return autocompleteResult([]);
  const gid = guildId(i);
  const q = f.value.toLowerCase();

  if (f.name === "item") {
    let items = await store.listCatalog(gid);
    if (subcommand(i) === "set") items = items.filter((it) => it.kind === "base");
    return autocompleteResult(
      items
        .filter((it) => it.name.toLowerCase().includes(q) || it.id.includes(q))
        .map((it) => ({
          name: it.kind === "base" ? `${it.name} — $${it.value}` : it.name,
          value: it.id,
        }))
    );
  }
  if (f.name === "product") {
    const lines = await store.listLines(gid);
    return autocompleteResult(
      lines
        .filter((l) => l.name.toLowerCase().includes(q))
        .map((l) => ({ name: l.name, value: l.id }))
    );
  }
  if (f.name === "step") {
    const jobId = await store.getChannelJobId(gid, channelId(i));
    const job = jobId ? await store.getJob(jobId) : undefined;
    const recipes = await store.listRecipes(gid);
    return autocompleteResult(
      recipes
        .filter((r) => (!job || r.lineId === job.lineId) && r.step.toLowerCase().includes(q))
        .map((r) => ({ name: `${r.step} → ${r.output.itemId}`, value: r.step }))
    );
  }
  if (f.name === "entry") {
    const jobId = await store.getChannelJobId(gid, channelId(i));
    if (!jobId) return autocompleteResult([]);
    const entries = await store.listEntries(jobId);
    const voided = new Set(entries.filter((e: any) => e.type === "void").map((e: any) => e.voids));
    const label = (e: any): string => {
      if (e.type === "deposit") return e.deposit.cash != null ? `deposit $${e.deposit.cash}` : `deposit ${e.deposit.qty}× ${e.deposit.itemId}`;
      if (e.type === "withdraw") return e.withdraw.cash != null ? `withdraw $${e.withdraw.cash}` : `withdraw ${e.withdraw.qty}× ${e.withdraw.itemId}`;
      if (e.type === "process") return `process ${e.process.step} → ${e.process.made}`;
      if (e.type === "sale") return `sale ${e.sale.qty} for $${e.sale.cash}`;
      return e.type;
    };
    return autocompleteResult(
      (entries as any[])
        .filter((e) => e.type !== "void" && !voided.has(e.id))
        .slice(-25)
        .reverse()
        .map((e) => ({ name: label(e).slice(0, 100), value: e.id }))
    );
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
    return reply(embed({ description: `✅ Added **${name}** = $${value} (${source}, ${kind}).`, color: COLORS.green }));
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
    return reply(embed({ description: `✅ **${item.name}** → $${item.value}${source ? ` (${source})` : ""}.`, color: COLORS.green }));
  }

  if (sub === "remove") {
    if (!isOfficer(i, config)) return reply("⛔ Officers only.");
    const id = option<string>(i, "item")!;
    const item = await store.getCatalogItem(gid, id);
    if (!item) return reply("⚠️ Pick an existing item from the list.");
    await store.deleteCatalogItem(gid, id);
    return reply(embed({ description: `🗑️ Removed **${item.name}**.`, color: COLORS.gray }));
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
    embed({
      title: "📦 Catalog",
      color: COLORS.gold,
      fields: [
        { name: "Base", value: base },
        { name: "Intermediate — auto build cost", value: inter },
        { name: "Final — reference price", value: fin },
      ],
    })
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
    return reply(embed({ description: `✅ <@&${roleId}> → **Level ${level}** (${config.rankMultipliers[level]}×).`, color: COLORS.green }));
  }
  if (sub === "unmap") {
    if (!isOfficer(i, config)) return reply("⛔ Officers only.");
    const roleId = option<string>(i, "role")!;
    await store.deleteRank(gid, roleId);
    return reply(embed({ description: `✅ Removed mapping for <@&${roleId}>.`, color: COLORS.gray }));
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
    return reply(embed({ description: `✅ Level ${level} weight → **${weight}×**.  Now (I→V): **${all}**`, color: COLORS.green }));
  }

  // list
  const ranks = await store.listRanks(gid);
  if (!ranks.length) return reply("🏷️ No role→level mappings yet — use `/rank map`.");
  const body = ranks
    .sort((a, b) => a.level - b.level)
    .map((r) => `Level ${r.level} (${config.rankMultipliers[r.level]}×) — <@&${r.roleId}>`)
    .join("\n");
  return reply(embed({ title: "🏷️ Rank map", description: body, color: COLORS.gold }));
}

// ---- jobs & ledger (Phase 2) ----

function isErr(x: any): x is { error: string } {
  return x && typeof x.error === "string";
}

async function resolveJob(i: any): Promise<store.JobMeta | { error: string }> {
  const jobId = await store.getChannelJobId(guildId(i), channelId(i));
  if (!jobId) {
    return { error: "❓ Run this in a job's channel — open one with `/job open`." };
  }
  const job = await store.getJob(jobId);
  if (!job || job.status === "closed") return { error: "❓ This channel has no open job." };
  return job;
}

async function ensureCategory(
  gid: string,
  config: Config,
  key: "operationsCategoryId" | "archiveCategoryId",
  name: string
): Promise<string> {
  if (config[key]) return config[key]!;
  const cat = await rest.createChannel(gid, { name, type: 4 });
  config[key] = cat.id;
  await store.putConfig(gid, config);
  return cat.id;
}

async function handleJob(i: any) {
  const gid = guildId(i);
  const sub = subcommand(i);
  const config = await store.getConfig(gid);

  if (sub === "open") return reply(await jobOpenWork(i), false);

  if (sub === "list") {
    const jobs = await store.listOpenJobs(gid);
    if (!jobs.length) return reply("No open jobs. Start one with `/job open`.");
    return reply(
      embed({
        title: "🟢 Open jobs",
        color: COLORS.green,
        description: jobs.map((j) => `• **${j.name}** _(${j.lineId})_ — <#${j.channelId}>`).join("\n"),
      })
    );
  }

  if (sub === "reopen") {
    if (!isOfficer(i, config)) return reply("⛔ Officers only.");
    const jobId = await store.getChannelJobId(gid, channelId(i));
    const job = jobId ? await store.getJob(jobId) : undefined;
    if (!job) return reply("❓ No job is bound to this channel.");
    if (job.status === "open") return reply("That job is already open.");
    await store.setJobStatus(gid, job.id, "open");
    try {
      const opsCat = await ensureCategory(gid, config, "operationsCategoryId", "Operations");
      await rest.modifyChannel(job.channelId, {
        name: `${slug(job.name) || "job"}-${BigInt(job.id).toString(36).slice(-5)}`,
        parent_id: opsCat,
        permission_overwrites: [],
      });
    } catch (e) {
      console.error("reopen channel failed", e);
    }
    return reply(embed({ description: `🔓 Reopened **${job.name}** — back in Operations & writable. Fix it up, then \`/settle\` again.`, color: COLORS.blue }), false);
  }

  if (sub === "close") {
    const job = await resolveJob(i);
    if (isErr(job)) return reply(job.error);
    if (job.createdBy !== actorId(i) && !isOfficer(i, config)) {
      return reply("⛔ Only whoever opened this job (or an officer) can close it.");
    }
    try {
      const archiveCat = await ensureCategory(gid, config, "archiveCategoryId", "Archive");
      await rest.modifyChannel(job.channelId, {
        name: `✅-${slug(job.name) || "job"}-${BigInt(job.id).toString(36).slice(-5)}`,
        parent_id: archiveCat,
        permission_overwrites: [{ id: gid, type: 0, deny: "2048" }], // @everyone: deny Send Messages
      });
    } catch (e) {
      console.error("archive failed", e);
    }
    await store.setJobStatus(gid, job.id, "closed");
    return reply(embed({ description: `🔴 Closed **${job.name}** — archived to read-only.`, color: COLORS.gray }), false);
  }
  return reply("Unknown subcommand.");
}

async function handleDeposit(i: any) {
  const job = await resolveJob(i);
  if (isErr(job)) return reply(job.error);
  const gid = guildId(i);
  const actor = actorId(i);
  const cash = option<number>(i, "cash");
  const itemId = option<string>(i, "item");
  const qty = option<number>(i, "qty");
  if (cash != null) {
    await store.appendEntry(job.id, { id: i.id, type: "deposit", actor, ts: snowflakeTs(i.id), deposit: { cash } });
    return reply(embed({ description: `💰 <@${actor}> deposited **$${cash}**`, color: COLORS.green }), false);
  }
  if (itemId && qty != null) {
    const item = await store.getCatalogItem(gid, itemId);
    if (!item) return reply("⚠️ Pick an item from the list.");
    await store.appendEntry(job.id, { id: i.id, type: "deposit", actor, ts: snowflakeTs(i.id), deposit: { itemId, qty } });
    return reply(embed({ description: `📥 <@${actor}> deposited **${qty}× ${item.name}**`, color: COLORS.green }), false);
  }
  return reply("Provide `item` + `qty`, or `cash`.");
}

async function handleWithdraw(i: any) {
  const job = await resolveJob(i);
  if (isErr(job)) return reply(job.error);
  const gid = guildId(i);
  const actor = actorId(i);
  const cash = option<number>(i, "cash");
  const itemId = option<string>(i, "item");
  const qty = option<number>(i, "qty");
  if (cash != null) {
    await store.appendEntry(job.id, { id: i.id, type: "withdraw", actor, ts: snowflakeTs(i.id), withdraw: { cash } });
    return reply(embed({ description: `💸 <@${actor}> withdrew **$${cash}**`, color: COLORS.blue }), false);
  }
  if (itemId && qty != null) {
    const item = await store.getCatalogItem(gid, itemId);
    if (!item) return reply("⚠️ Pick an item from the list.");
    await store.appendEntry(job.id, { id: i.id, type: "withdraw", actor, ts: snowflakeTs(i.id), withdraw: { itemId, qty } });
    return reply(embed({ description: `📤 <@${actor}> withdrew **${qty}× ${item.name}**`, color: COLORS.blue }), false);
  }
  return reply("Provide `item` + `qty`, or `cash`.");
}

async function handleProcess(i: any) {
  const job = await resolveJob(i);
  if (isErr(job)) return reply(job.error);
  const step = option<string>(i, "step")!;
  const made = option<number>(i, "made")!;
  await store.appendEntry(job.id, {
    id: i.id,
    type: "process",
    actor: actorId(i),
    ts: snowflakeTs(i.id),
    process: { step, made },
  });
  return reply(embed({ description: `⚗️ <@${actorId(i)}> ran **${step}** → **${made}**`, color: COLORS.gold }), false);
}

async function handleSale(i: any) {
  const job = await resolveJob(i);
  if (isErr(job)) return reply(job.error);
  const qty = option<number>(i, "qty")!;
  const cash = option<number>(i, "cash")!;
  const by = option<string>(i, "by") ?? actorId(i);
  await store.appendEntry(job.id, {
    id: i.id,
    type: "sale",
    actor: actorId(i),
    ts: snowflakeTs(i.id),
    sale: { qty, cash, by },
  });
  return reply(embed({ description: `💵 <@${by}> sold **${qty}** for **$${cash}**`, color: COLORS.green }), false);
}

function entryLine(e: any): string {
  const who = `<@${e.actor}>`;
  if (e.type === "deposit")
    return e.deposit.cash != null ? `💰 ${who} +$${e.deposit.cash}` : `📥 ${who} +${e.deposit.qty}× ${e.deposit.itemId}`;
  if (e.type === "withdraw")
    return e.withdraw.cash != null ? `💸 ${who} −$${e.withdraw.cash}` : `📤 ${who} −${e.withdraw.qty}× ${e.withdraw.itemId}`;
  if (e.type === "process") return `⚗️ ${who} ${e.process.step} → ${e.process.made}`;
  if (e.type === "sale") return `💵 <@${e.sale.by}> sold ${e.sale.qty} for $${e.sale.cash}`;
  if (e.type === "void") return `🚫 ${who} voided an entry`;
  return `• ${e.type}`;
}

function ledgerBody(job: any, entries: any[], full = false): string {
  if (!entries.length) return `📜 **${job.name}** — no entries yet.`;
  const voided = new Set(entries.filter((e) => e.type === "void").map((e) => e.voids));
  const list = full ? entries : entries.slice(-25);
  const lines = list.map((e) => (voided.has(e.id) ? `~~${entryLine(e)}~~ _(voided)_` : entryLine(e)));
  const more = !full && entries.length > 25 ? `\n_…${entries.length - 25} earlier (full list in the settled record)_` : "";
  return `📜 **${job.name}** — ledger (${entries.length} entries)\n${lines.join("\n")}${more}`;
}

/** Post text to a channel, splitting on newlines to stay under Discord's 2000-char limit. */
async function postChunks(channelId: string, text: string): Promise<void> {
  const chunks: string[] = [];
  let buf = "";
  for (const ln of text.split("\n")) {
    if ((buf ? buf.length + 1 : 0) + ln.length > 1900) {
      if (buf) chunks.push(buf);
      buf = ln;
    } else buf = buf ? `${buf}\n${ln}` : ln;
  }
  if (buf) chunks.push(buf);
  for (const c of chunks) await rest.postMessage(channelId, c);
}

async function handleLedger(i: any) {
  const job = await resolveJob(i);
  if (isErr(job)) return reply(job.error);
  const entries = await store.listEntries(job.id);
  return reply(embed({ description: ledgerBody(job, entries), color: COLORS.gold }));
}

async function handleStatus(i: any) {
  const job = await resolveJob(i);
  if (isErr(job)) return reply(job.error);
  const gid = guildId(i);
  const [entries, catalog, recipes, lines, config] = await Promise.all([
    store.listEntries(job.id),
    store.listCatalog(gid),
    store.listRecipes(gid),
    store.listLines(gid),
    store.getConfig(gid),
  ]);
  return reply(statusBody(job, entries, catalog, recipes, lines, config));
}

function statusBody(
  job: any,
  entries: any[],
  catalog: any[],
  recipes: any[],
  lines: any[],
  config: any
) {
  entries = liveEntries(entries);
  const line = lines.find((l) => l.id === job.lineId);
  const finalId = line?.finalItemId;
  const finalName = catalog.find((c) => c.id === finalId)?.name ?? finalId ?? "product";
  const values = itemValues(catalog, recipes, lines);
  const stepOut = new Map(
    recipes.filter((r) => r.lineId === job.lineId).map((r) => [r.step, r.output.itemId])
  );

  const per = new Map<string, { dep: number; lab: number; wd: number; sold: number }>();
  const G = (u: string) => {
    if (!per.has(u)) per.set(u, { dep: 0, lab: 0, wd: 0, sold: 0 });
    return per.get(u)!;
  };
  let revenue = 0,
    madeFinal = 0,
    soldQty = 0,
    wdFinalQty = 0,
    totalDep = 0;

  for (const e of entries as any[]) {
    if (e.type === "deposit") {
      const v = e.deposit.cash ?? (values[e.deposit.itemId] ?? 0) * (e.deposit.qty ?? 0);
      G(e.actor).dep += v;
      totalDep += v;
    } else if (e.type === "process") {
      G(e.actor).lab += (e.process.made ?? 0) * config.laborRate;
      if (stepOut.get(e.process.step) === finalId) madeFinal += e.process.made ?? 0;
    } else if (e.type === "withdraw") {
      const v = e.withdraw.cash ?? (values[e.withdraw.itemId] ?? 0) * (e.withdraw.qty ?? 0);
      G(e.actor).wd += v;
      if (e.withdraw.itemId === finalId) wdFinalQty += e.withdraw.qty ?? 0;
    } else if (e.type === "sale") {
      revenue += e.sale.cash;
      soldQty += e.sale.qty;
      G(e.sale.by).sold += e.sale.cash;
    }
  }

  const m = (n: number) => `$${Math.round(n).toLocaleString()}`;
  const q = (n: number) => `${+n.toFixed(1)}`.replace(/\.0$/, "");
  const members = [...per.entries()]
    .sort((a, b) => b[1].dep + b[1].lab + b[1].sold - (a[1].dep + a[1].lab + a[1].sold))
    .map(
      ([u, c]) =>
        `• <@${u}> — in ${m(c.dep)} · labor ${m(c.lab)}${c.sold ? ` · sold ${m(c.sold)}` : ""}${
          c.wd ? ` · out ${m(c.wd)}` : ""
        }`
    );

  // current on-hand inventory (leftover inputs, intermediates mid-chain, unsold final)
  const inv = inventory(
    entries,
    recipes.filter((r) => r.lineId === job.lineId),
    finalId
  );
  const nameOf = (id: string) => catalog.find((c) => c.id === id)?.name ?? id;
  const onHand = Object.entries(inv)
    .filter(([, n]) => Math.abs(n) > 0.0001)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([id, n]) => `${nameOf(id)} ×${q(n)}`);
  const finalOnHand = inv[finalId ?? ""] ?? 0;

  const recon =
    finalOnHand > 0.0001
      ? `⚠️ **${q(finalOnHand)} ${finalName}** not yet sold or withdrawn — clear before settling.`
      : madeFinal > 0
        ? `✅ All ${finalName} sold or withdrawn.`
        : `_No ${finalName} produced yet._`;

  return embed({
    title: `📊 ${job.name} — ${line?.name ?? job.lineId} · ${job.status}`,
    color: finalOnHand > 0.0001 ? COLORS.gold : madeFinal > 0 ? COLORS.green : COLORS.gray,
    description: [recon, "", members.length ? "**Contributors**\n" + members.join("\n") : "_No contributions yet._"].join("\n"),
    fields: [
      { name: "Pool", value: `deposited ${m(totalDep)} · made ${madeFinal} ${finalName} · sold ${soldQty} for ${m(revenue)}` },
      { name: "On hand", value: onHand.length ? onHand.join(" · ") : "nothing" },
    ],
  });
}

function bestLevel(roles: string[] | undefined, rankMap: Record<string, number>): number {
  let best = 5;
  for (const r of roles ?? []) {
    const lvl = rankMap[r];
    if (lvl != null && lvl < best) best = lvl;
  }
  return best;
}

async function jobOpenWork(i: any) {
  const gid = guildId(i);
  const config = await store.getConfig(gid);
  const name = option<string>(i, "name")!.trim();
  const lineId = option<string>(i, "product")!;
  const line = (await store.listLines(gid)).find((l) => l.id === lineId);
  if (!line) return "⚠️ Pick a product line from the list.";

  let channel: { id: string };
  try {
    const opsCat = await ensureCategory(gid, config, "operationsCategoryId", "Operations");
    channel = await rest.createChannel(gid, {
      name: `${slug(name) || "job"}-${BigInt(i.id).toString(36).slice(-5)}`,
      type: 0,
      parent_id: opsCat,
      topic: `Cutter job — ${name} (${line.name})`,
    });
  } catch (e) {
    console.error("channel create failed", e);
    return "⚠️ I couldn't create the job channel — make sure I have **Manage Channels**, then try again.";
  }

  await store.createJob(gid, {
    id: i.id,
    name,
    lineId,
    status: "open",
    channelId: channel.id,
    guildId: gid,
    createdBy: actorId(i),
    createdAt: snowflakeTs(i.id),
  });
  try {
    await rest.postMessage(
      channel.id,
      `🔪 **${name}** — ${line.name}\nLog the op right here: \`/deposit\` · \`/process\` · \`/sale\`. \`/ledger\` shows history, \`/status\` tracks the pool.`
    );
  } catch {
    /* welcome message is best-effort */
  }
  return embed({
    description: `🟢 Opened **${name}** _(${line.name})_ → <#${channel.id}>`,
    color: COLORS.green,
  });
}

async function settleWork(i: any): Promise<string> {
  const job = await resolveJob(i);
  if (isErr(job)) return job.error;
  const gid = guildId(i);
  const config = await store.getConfig(gid);
  if (job.createdBy !== actorId(i) && !isOfficer(i, config)) {
    return "⛔ Only whoever opened this job (or an officer) can settle it.";
  }

  const [entries, catalog, recipes, lines, ranks] = await Promise.all([
    store.listEntries(job.id),
    store.listCatalog(gid),
    store.listRecipes(gid),
    store.listLines(gid),
    store.listRanks(gid),
  ]);
  const line = lines.find((l) => l.id === job.lineId);
  if (!line) return "⚠️ This job's product line is missing.";
  if (!entries.some((e) => e.type === "sale")) {
    return "⚠️ No sales logged — nothing to settle. Log a `/sale` first.";
  }

  // resolve each participant's rank level from their Discord roles
  const rankMap = Object.fromEntries(ranks.map((r) => [r.roleId, r.level]));
  const participants = new Set<string>();
  for (const e of entries as any[]) participants.add(e.type === "sale" ? e.sale.by : e.actor);
  const levels = await Promise.all(
    [...participants].map(async (uid) => {
      try {
        const mem = await rest.getMember(gid, uid);
        return [uid, bestLevel(mem.roles, rankMap)] as const;
      } catch {
        return [uid, 5] as const;
      }
    })
  );
  const memberLevels = Object.fromEntries(levels);

  const result = settle({ config, catalog, recipes, line, entries, memberLevels });

  // persist payouts, close, archive
  await Promise.all(
    result.perMember.map((p) =>
      store.putPayout(job.id, {
        userId: p.userId,
        level: p.level,
        reimbursed: p.reimbursed,
        commission: p.commission,
        work: p.work,
        rank: p.rank,
        net: p.net,
      })
    )
  );
  await store.setJobStatus(gid, job.id, "closed");
  job.status = "closed";

  const m = (n: number) => `$${Math.round(n).toLocaleString()}`;
  const finalName = catalog.find((c) => c.id === line.finalItemId)?.name ?? "product";
  const unsold = inventory(entries, recipes.filter((r) => r.lineId === job.lineId), line.finalItemId)[line.finalItemId] ?? 0;
  const rows = [...result.perMember]
    .sort((a, b) => b.net - a.net)
    .map((p) => {
      const earned = p.net - p.reimbursed;
      return `**<@${p.userId}>** — take-home **${m(p.net)}**  _(capital back ${m(p.reimbursed)} · earned ${m(earned)})_`;
    });
  const foot = result.loss
    ? `⚠️ **Loss** — revenue didn't cover capital; reimbursements paid pro-rata, no profit split.`
    : `Pool: ${m(result.revenue)} − reimbursed ${m(result.reimbursed)} − commission ${m(result.commission)} → **${m(result.distributable)}** split ${Math.round(config.workSplitPct * 100)}/${Math.round((1 - config.workSplitPct) * 100)}.` +
      (result.tiesOut ? "" : " ⚠️ rounding mismatch.") +
      (unsold > 0.0001 ? `\n⚠️ ${+unsold.toFixed(1)} ${finalName} unsold — not in this payout.` : "");
  const payoutEmbed = embed({
    title: `💰 Settlement — ${job.name} · ${m(result.revenue)}`,
    color: result.loss ? COLORS.red : COLORS.green,
    description: [...rows, "", foot].join("\n"),
  });

  // Post the self-contained dispute record (ledger → status → payout) as the channel's
  // last messages, then archive read-only. Done before archiving so the channel is still writable.
  // record posting is best-effort (must run while the channel is still writable)
  try {
    await postChunks(job.channelId, ledgerBody(job, entries, true));
    await rest.postMessage(job.channelId, statusBody(job, entries, catalog, recipes, lines, config));
    await rest.postMessage(job.channelId, payoutEmbed);
  } catch (e) {
    console.error("settle record post failed", e);
  }
  // archive is its own step so a record-post failure never skips it
  try {
    const archiveCat = await ensureCategory(gid, config, "archiveCategoryId", "Archive");
    await rest.modifyChannel(job.channelId, {
      name: `💰-${slug(job.name) || "job"}-${BigInt(job.id).toString(36).slice(-5)}`,
      parent_id: archiveCat,
      permission_overwrites: [{ id: gid, type: 0, deny: "2048" }],
    });
  } catch (e) {
    console.error("settle archive failed", e);
  }

  return `✅ Settled **${job.name}** — ${m(result.revenue)} paid out. Full record posted to the channel; archived read-only.`;
}

async function handleMe(i: any) {
  const job = await resolveJob(i);
  if (isErr(job)) return reply(job.error);
  const gid = guildId(i);
  const me = actorId(i);
  const [entries, catalog, recipes, lines, config, ranks] = await Promise.all([
    store.listEntries(job.id),
    store.listCatalog(gid),
    store.listRecipes(gid),
    store.listLines(gid),
    store.getConfig(gid),
    store.listRanks(gid),
  ]);
  const line = lines.find((l) => l.id === job.lineId);
  const values = itemValues(catalog, recipes, lines);
  let dep = 0, lab = 0, wd = 0, soldCash = 0;
  for (const e of liveEntries(entries) as any[]) {
    if (e.type === "deposit" && e.actor === me) dep += e.deposit.cash ?? (values[e.deposit.itemId] ?? 0) * (e.deposit.qty ?? 0);
    else if (e.type === "process" && e.actor === me) lab += (e.process.made ?? 0) * config.laborRate;
    else if (e.type === "withdraw" && e.actor === me) wd += e.withdraw.cash ?? (values[e.withdraw.itemId] ?? 0) * (e.withdraw.qty ?? 0);
    else if (e.type === "sale" && e.sale.by === me) soldCash += e.sale.cash;
  }
  const rankMap = Object.fromEntries(ranks.map((r) => [r.roleId, r.level]));
  const myLevel = bestLevel(i.member?.roles, rankMap);
  const m = (n: number) => `$${Math.round(n).toLocaleString()}`;
  const fields = [
    { name: "Rank", value: `Level ${myLevel} (${config.rankMultipliers[myLevel] ?? 1}×)`, inline: true },
    { name: "Capital fronted", value: m(dep), inline: true },
    { name: "Labor", value: m(lab), inline: true },
  ];
  if (soldCash) fields.push({ name: "Sold", value: `${m(soldCash)} → commission ${m(soldCash * config.commissionPct)}`, inline: true });
  if (wd) fields.push({ name: "Withdrawn", value: `−${m(wd)}`, inline: true });
  return reply(
    embed({
      title: `🧍 You on ${job.name}`,
      color: COLORS.blue,
      description: `_(${line?.name ?? job.lineId})_ — capital is reimbursed first; exact take-home is set at \`/settle\`.`,
      fields,
    })
  );
}

async function handleVoid(i: any) {
  const job = await resolveJob(i);
  if (isErr(job)) return reply(job.error);
  const config = await store.getConfig(guildId(i));
  if (!isOfficer(i, config)) return reply("⛔ Officers only.");
  const entryId = option<string>(i, "entry")!;
  const entries = await store.listEntries(job.id);
  const target = entries.find((e) => e.id === entryId) as any;
  if (!target) return reply("⚠️ Pick an entry from the list.");
  if (target.type === "void") return reply("⚠️ That's already a void marker.");
  await store.appendEntry(job.id, { id: i.id, type: "void", actor: actorId(i), ts: snowflakeTs(i.id), voids: entryId });
  return reply(embed({ description: `🚫 <@${actorId(i)}> voided: ${entryLine(target)}`, color: COLORS.red }), false);
}
