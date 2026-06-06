import { verifyKey } from "discord-interactions";
import {
  InteractionType,
  InteractionResponseType,
  type APIInteraction,
} from "discord-api-types/v10";
import * as store from "./store";
import * as rest from "./rest";
import { getSecret } from "./secret";
import { buildCosts, itemValues, inventory } from "@cutter/engine";
import type { Config } from "@cutter/shared";
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
  actorId,
  channelId,
  snowflakeTs,
} from "./discord";

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

  if (sub === "open") {
    const name = option<string>(i, "name")!.trim();
    const lineId = option<string>(i, "product")!;
    const line = (await store.listLines(gid)).find((l) => l.id === lineId);
    if (!line) return reply("⚠️ Pick a product line from the list.");

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
      return reply("⚠️ I couldn't create the job channel — make sure I have **Manage Channels**, then try again.");
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
    return reply(`🟢 Opened **${name}** _(${line.name})_ → <#${channel.id}>`, false);
  }

  if (sub === "list") {
    const jobs = await store.listOpenJobs(gid);
    if (!jobs.length) return reply("No open jobs. Start one with `/job open`.");
    return reply(
      "🟢 **Open jobs**\n" +
        jobs.map((j) => `• **${j.name}** _(${j.lineId})_ — <#${j.channelId}>`).join("\n")
    );
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
    return reply(`🔴 Closed **${job.name}** — archived to read-only.`, false);
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
    return reply(`💰 <@${actor}> deposited **$${cash}** → **${job.name}**.`, false);
  }
  if (itemId && qty != null) {
    const item = await store.getCatalogItem(gid, itemId);
    if (!item) return reply("⚠️ Pick an item from the list.");
    await store.appendEntry(job.id, { id: i.id, type: "deposit", actor, ts: snowflakeTs(i.id), deposit: { itemId, qty } });
    return reply(`📥 <@${actor}> deposited **${qty}× ${item.name}** → **${job.name}**.`, false);
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
    return reply(`💸 <@${actor}> withdrew **$${cash}** from **${job.name}**.`, false);
  }
  if (itemId && qty != null) {
    const item = await store.getCatalogItem(gid, itemId);
    if (!item) return reply("⚠️ Pick an item from the list.");
    await store.appendEntry(job.id, { id: i.id, type: "withdraw", actor, ts: snowflakeTs(i.id), withdraw: { itemId, qty } });
    return reply(`📤 <@${actor}> withdrew **${qty}× ${item.name}** from **${job.name}**.`, false);
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
  return reply(`⚗️ <@${actorId(i)}> ran **${step}** → **${made}** on **${job.name}**.`, false);
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
  return reply(`💵 <@${by}> sold **${qty}** for **$${cash}** on **${job.name}**.`, false);
}

async function handleLedger(i: any) {
  const job = await resolveJob(i);
  if (isErr(job)) return reply(job.error);
  const entries = await store.listEntries(job.id);
  if (!entries.length) return reply(`📜 **${job.name}** — no entries yet.`);
  const fmt = (e: any): string => {
    const who = `<@${e.actor}>`;
    if (e.type === "deposit")
      return e.deposit.cash != null ? `💰 ${who} +$${e.deposit.cash}` : `📥 ${who} +${e.deposit.qty}× ${e.deposit.itemId}`;
    if (e.type === "withdraw")
      return e.withdraw.cash != null ? `💸 ${who} −$${e.withdraw.cash}` : `📤 ${who} −${e.withdraw.qty}× ${e.withdraw.itemId}`;
    if (e.type === "process") return `⚗️ ${who} ${e.process.step} → ${e.process.made}`;
    if (e.type === "sale") return `💵 <@${e.sale.by}> sold ${e.sale.qty} for $${e.sale.cash}`;
    return `• ${e.type}`;
  };
  const recent = entries.slice(-25).map(fmt).join("\n");
  const more = entries.length > 25 ? `\n_…${entries.length - 25} earlier_` : "";
  return reply(`📜 **${job.name}** — ledger (${entries.length} entries)\n${recent}${more}`);
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

  return reply(
    [
      `📊 **${job.name}** _(${line?.name ?? job.lineId})_ · ${job.status}`,
      members.length ? "**Contributors**\n" + members.join("\n") : "_No contributions yet._",
      `**Pool** — deposited ${m(totalDep)} · made ${madeFinal} ${finalName} · sold ${soldQty} for ${m(revenue)}`,
      `**On hand** — ${onHand.length ? onHand.join(" · ") : "nothing"}`,
      recon,
    ].join("\n")
  );
}
