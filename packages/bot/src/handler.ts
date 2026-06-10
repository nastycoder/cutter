import { verifyKey } from "discord-interactions";
import {
  InteractionType,
  InteractionResponseType,
  type APIInteraction,
} from "discord-api-types/v10";
import * as store from "./store";
import * as rest from "./rest";
import { getSecret } from "./secret";
import {
  payout,
  accrueTabs,
  advanceable,
  itemValues,
  treasuryInventory,
  liveEntries,
} from "@cutter/engine";
import type {
  Config,
  ChannelKind,
  House,
  LedgerEntry,
  CatalogItem,
  RecipeStep,
  ProductLine,
  MemberTab,
  LossCause,
} from "@cutter/shared";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import * as fs from "node:fs";
import * as path from "node:path";

const lambdaClient = new LambdaClient({});

// Tutorial deck assets are bundled next to the handler (see infra commandHooks).
const DECK_DIR = __dirname;
function slideFiles(): string[] {
  try {
    return fs
      .readdirSync(DECK_DIR)
      .filter((n) => /^tutorial-\d+\.png$/.test(n))
      .sort();
  } catch {
    return [];
  }
}
function readDeck(name: string): Uint8Array | null {
  try {
    return fs.readFileSync(path.join(DECK_DIR, name));
  } catch {
    return null;
  }
}

// Commands whose work exceeds Discord's 3s window are deferred: we ACK immediately,
// then this Lambda invokes itself asynchronously to do the work and edit the reply.
function isDeferrable(i: any): boolean {
  const n = commandName(i);
  return n === "setup" || n === "payout";
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
    const n = commandName(i);
    const content =
      n === "setup"
        ? await setupWork(i)
        : n === "payout"
          ? await payoutWork(i)
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
  type MsgData,
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

  if (interaction.type === InteractionType.MessageComponent) {
    return handleComponent(interaction);
  }

  if (interaction.type === InteractionType.ModalSubmit) {
    return handleModal(interaction);
  }

  if (interaction.type === InteractionType.ApplicationCommand) {
    if (isDeferrable(interaction)) {
      try {
        await invokeSelf({ source: "followup", interaction });
        const ephemeral = commandName(interaction) === "setup";
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
      return reply(await setupWork(i), true);
    case "config":
      return handleConfig(i);
    case "catalog":
      return handleCatalog(i);
    case "rank":
      return handleRank(i);
    case "recipe":
      return handleRecipe(i);
    case "deposit":
      return handleDeposit(i);
    case "buy":
      return handleBuy(i);
    case "fund-cash":
      return handleFundCash(i);
    case "process":
      return handleProcess(i);
    case "transfer":
      return handleTransfer(i);
    case "checkout":
      return handleCheckout(i);
    case "sale":
      return handleSale(i);
    case "return":
      return handleReturn(i);
    case "holding":
      return handleHolding(i);
    case "reconcile":
      return handleReconcile(i);
    case "withdraw":
      return handleWithdraw(i);
    case "loss":
      return handleLoss(i);
    case "void":
      return handleVoid(i);
    case "owed":
      return handleOwed(i);
    case "advance":
      return handleAdvance(i);
    case "payout":
      return reply(await payoutWork(i), false);
    case "fund":
      return handleFund(i);
    case "spend":
      return handleSpend(i);
    case "stash":
      return handleStash(i);
    case "me":
      return handleMe(i);
    case "ledger":
      return handleLedger(i);
    case "status":
      return handleStatus(i);
    default:
      return reply(`Unknown command: \`${commandName(i)}\``);
  }
}

// ---- shared loading & helpers ----

interface GuildData {
  config: Config;
  catalog: CatalogItem[];
  recipes: RecipeStep[];
  lines: ProductLine[];
}

async function loadGuild(gid: string): Promise<GuildData> {
  const [config, catalog, recipes, lines] = await Promise.all([
    store.getConfig(gid),
    store.listCatalog(gid),
    store.listRecipes(gid),
    store.listLines(gid),
  ]);
  return { config, catalog, recipes, lines };
}

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
const qty = (n: number) => `${+n.toFixed(1)}`.replace(/\.0$/, "");

const HOUSE_LABEL: Record<ChannelKind, string> = {
  raw: "🌿 raw house",
  product: "🧪 product house",
  money: "💰 money house",
  treasury: "🏦 treasury",
};

function houseLink(config: Config, kind: ChannelKind): string {
  const id = config.houseChannels?.[kind];
  return id ? `<#${id}>` : HOUSE_LABEL[kind];
}

type GoodsHouse = "raw" | "product";

/** The house a goods item naturally lives in: base → raw, produced → product. */
function kindHouse(item: CatalogItem): GoodsHouse {
  return item.kind === "base" ? "raw" : "product";
}

/** Resolve the goods house for a command: the channel's house wins, else the item's kind. */
async function goodsHouse(i: any, item: CatalogItem): Promise<GoodsHouse> {
  const h = await store.getChannelHouse(guildId(i), channelId(i));
  return h === "raw" || h === "product" ? h : kindHouse(item);
}

function needsSetup(config: Config): string | undefined {
  if (!config.cycleNumber) return "⚠️ The treasury isn't set up yet — an officer needs to run `/setup` first.";
  return undefined;
}

function mkEntry(i: any, config: Config, type: LedgerEntry["type"], payload: Partial<LedgerEntry>): LedgerEntry {
  return {
    id: i.id,
    type,
    actor: actorId(i),
    ts: snowflakeTs(i.id),
    cycle: config.cycleNumber!,
    ...payload,
  } as LedgerEntry;
}

function valuesOf(g: GuildData): Record<string, number> {
  return itemValues(g.catalog, g.recipes, g.lines, g.config.targetMargin ?? 0);
}

function itemName(g: GuildData, id: string): string {
  return g.catalog.find((c) => c.id === id)?.name ?? id;
}

function findItem(g: GuildData, id: string): CatalogItem | undefined {
  return g.catalog.find((c) => c.id === id);
}

// ---- /setup ----

const HOUSE_CHANNELS: { kind: ChannelKind; name: string; topic: string }[] = [
  { kind: "raw", name: "🌿-raw-house", topic: "Raw materials — /deposit · /buy · what's farmed and bought" },
  { kind: "product", name: "🧪-product-house", topic: "Product — /process · /checkout · /return" },
  { kind: "money", name: "💰-money-house", topic: "The cash — /sale · /fund-cash · /advance" },
  { kind: "treasury", name: "🏦-treasury", topic: "The books — /status · /owed · /fund · /payout" },
];

async function ensureCategory(gid: string, config: Config): Promise<string> {
  if (config.operationsCategoryId) {
    if (await rest.getChannel(config.operationsCategoryId)) return config.operationsCategoryId;
    config.operationsCategoryId = undefined;
  }
  const cat = await rest.createChannel(gid, { name: "Operations", type: 4 });
  config.operationsCategoryId = cat.id;
  await store.putConfig(gid, config);
  return cat.id;
}

async function setupWork(i: any): Promise<MsgData | string> {
  const gid = guildId(i);
  let config = await store.getConfig(gid);
  if (!isOfficer(i, config)) {
    return "⛔ `/setup` requires the **Manage Server** permission.";
  }
  const officerRoleId = option<string>(i, "officer");
  await store.seedDefaults(gid);
  config = { ...config, officerRoleId };
  config.cycleNumber ??= 1;
  config.cycleStartedAt ??= snowflakeTs(i.id);
  await store.putConfig(gid, config);

  const created: string[] = [];
  try {
    const opsCat = await ensureCategory(gid, config);
    config.houseChannels ??= {};
    for (const h of HOUSE_CHANNELS) {
      const existing = config.houseChannels[h.kind];
      if (existing && (await rest.getChannel(existing))) continue;
      const ch = await rest.createChannel(gid, { name: h.name, type: 0, parent_id: opsCat, topic: h.topic });
      config.houseChannels[h.kind] = ch.id;
      await store.putChannelHouse(gid, ch.id, h.kind);
      created.push(`<#${ch.id}>`);
    }
    await store.putConfig(gid, config);
  } catch (e) {
    console.error("house channels failed", e);
    return "⚠️ I couldn't create the house channels — make sure I have **Manage Channels**, then run `/setup` again.";
  }

  // read-only guide channel; (re)post the crew guide once
  let guideLine = "";
  try {
    if (config.guideChannelId && !(await rest.getChannel(config.guideChannelId))) {
      config.guideChannelId = undefined;
      config.guidePosted = false;
    }
    if (!config.guideChannelId) {
      const ch = await rest.createChannel(gid, {
        name: "📖-cutter-guide",
        type: 0,
        parent_id: config.operationsCategoryId,
        topic: "How we run & get paid",
      });
      config.guideChannelId = ch.id;
      await store.putConfig(gid, config);
    }
    // upload the tutorial deck once: slides inline as a gallery + the PDF to
    // download. The deck is the guide.
    if (config.guideChannelId && !config.guidePosted) {
      const { appId } = await getSecret();
      await rest.modifyChannel(config.guideChannelId, {
        permission_overwrites: [
          { id: gid, type: 0, deny: "2048" }, // @everyone: no Send Messages
          { id: appId, type: 1, allow: "52224" }, // bot: View+Send+EmbedLinks+AttachFiles
        ],
      });
      const slides = slideFiles()
        .map((n) => ({ name: n, data: readDeck(n), contentType: "image/png" }))
        .filter((s): s is { name: string; data: Uint8Array; contentType: string } => s.data != null);
      // Discord caps attachments at 10 per message — post the slides in batches.
      for (let k = 0; k < slides.length; k += 10) {
        await rest.postFiles(
          config.guideChannelId,
          slides.slice(k, k + 10),
          k === 0 ? "📑 **Cutter crew guide** — swipe through the slides:" : undefined
        );
      }
      const pdf = readDeck("Cutter-Tutorial.pdf");
      if (pdf) {
        await rest.postFiles(config.guideChannelId, [{ name: "Cutter-Tutorial.pdf", data: pdf, contentType: "application/pdf" }], "📄 Full deck (PDF) — download or print:");
      }
      if (slides.length || pdf) {
        config.guidePosted = true;
        await store.putConfig(gid, config);
      }
    }
    guideLine = `Crew guide deck → <#${config.guideChannelId}> (read-only)`;
  } catch (e) {
    console.error("guide channel failed", e);
  }

  return embed({
    title: "🛠️ Cutter is set up — the treasury is open",
    color: COLORS.gold,
    description: [
      `Officer role: <@&${officerRoleId}>`,
      `Houses: ${houseLink(config, "raw")} · ${houseLink(config, "product")} · ${houseLink(config, "money")} · ${houseLink(config, "treasury")}`,
      created.length ? `Created: ${created.join(" ")}` : "",
      `Cycle **${config.cycleNumber}** is live — log work as it happens, \`/payout\` settles it.`,
      "Seeded product line **Honey** (catalog · recipes)",
      "Default dials: labor $25/unit · 8% commission · 40% farm margin · ranks 5/4/3/2/1",
      guideLine,
      "",
      "Next: map ranks with `/rank map`, tune with `/config`.",
    ]
      .filter(Boolean)
      .join("\n"),
  });
}

// ---- logging commands ----

async function handleDeposit(i: any) {
  const gid = guildId(i);
  const g = await loadGuild(gid);
  const gate = needsSetup(g.config);
  if (gate) return reply(gate);
  const itemId = option<string>(i, "item")!;
  const n = option<number>(i, "qty")!;
  if (!(n > 0)) return reply("⚠️ Quantity must be positive.");
  const item = findItem(g, itemId);
  if (!item) return reply("⚠️ Pick an item from the list.");
  const credit = option<string>(i, "credit") ?? actorId(i);
  const house = await goodsHouse(i, item);
  await store.appendEntry(gid, mkEntry(i, g.config, "deposit", { deposit: { itemId, qty: n, house, credit } }));
  const v = (valuesOf(g)[itemId] ?? 0) * n;
  return reply(
    embed({
      description:
        `📥 **${qty(n)}× ${item.name}** into ${houseLink(g.config, house)} — farm pay **${money(v)}** to <@${credit}>` +
        (credit !== actorId(i) ? ` _(banked by <@${actorId(i)}>)_` : ""),
      color: COLORS.green,
    }),
    false
  );
}

async function handleBuy(i: any) {
  const gid = guildId(i);
  const g = await loadGuild(gid);
  const gate = needsSetup(g.config);
  if (gate) return reply(gate);
  const itemId = option<string>(i, "item")!;
  const n = option<number>(i, "qty")!;
  if (!(n > 0)) return reply("⚠️ Quantity must be positive.");
  const item = findItem(g, itemId);
  if (!item) return reply("⚠️ Pick an item from the list.");
  const house = await goodsHouse(i, item);
  const capital = (valuesOf(g)[itemId] ?? 0) * n;
  await store.appendEntry(gid, mkEntry(i, g.config, "buy", { buy: { itemId, qty: n, house } }));
  return reply(
    embed({
      description: `🛒 <@${actorId(i)}> bought **${qty(n)}× ${item.name}** → ${houseLink(g.config, house)} — capital **${money(capital)}** owed back (catalog)`,
      color: COLORS.green,
    }),
    false
  );
}

async function handleFundCash(i: any) {
  const gid = guildId(i);
  const config = await store.getConfig(gid);
  const gate = needsSetup(config);
  if (gate) return reply(gate);
  const amount = option<number>(i, "amount")!;
  if (!(amount > 0)) return reply("⚠️ Amount must be positive.");
  await store.appendEntry(gid, mkEntry(i, config, "fund", { fund: { cash: amount } }));
  return reply(
    embed({
      description: `💰 <@${actorId(i)}> funded the treasury with **${money(amount)}** → ${houseLink(config, "money")} — capital owed back`,
      color: COLORS.green,
    }),
    false
  );
}

async function handleProcess(i: any) {
  const gid = guildId(i);
  const g = await loadGuild(gid);
  const gate = needsSetup(g.config);
  if (gate) return reply(gate);
  const lineId = option<string>(i, "line")!;
  const step = option<string>(i, "step")!;
  const made = option<number>(i, "made")!;
  if (!(made > 0)) return reply("⚠️ `made` must be positive.");
  const line = g.lines.find((l) => l.id === lineId);
  if (!line) return reply("⚠️ Pick a product line from the list.");
  const recipe = g.recipes.find((r) => r.lineId === lineId && r.step === step);
  if (!recipe) return reply(`⚠️ **${line.name}** has no step \`${step}\` — check \`/recipe list\`.`);
  const credit = option<string>(i, "credit") ?? actorId(i);
  await store.appendEntry(gid, mkEntry(i, g.config, "process", { process: { lineId, step, made, credit } }));
  const y = typeof recipe.output.yield === "number" ? recipe.output.yield : (recipe.output.yield[0] + recipe.output.yield[1]) / 2;
  const crafts = y > 0 ? made / y : 0;
  const consumed = recipe.inputs.map((inp) => `${qty(crafts * inp.qty)}× ${itemName(g, inp.itemId)}`).join(" + ");
  return reply(
    embed({
      description:
        `⚗️ **${line.name} / ${step}** → **${qty(made)}× ${itemName(g, recipe.output.itemId)}** — labor **${money(made * g.config.laborRate)}** to <@${credit}>` +
        `\n_consumed: ${consumed}_`,
      color: COLORS.gold,
    }),
    false
  );
}

async function handleTransfer(i: any) {
  const gid = guildId(i);
  const g = await loadGuild(gid);
  const gate = needsSetup(g.config);
  if (gate) return reply(gate);
  const itemId = option<string>(i, "item")!;
  const n = option<number>(i, "qty")!;
  if (!(n > 0)) return reply("⚠️ Quantity must be positive.");
  const item = findItem(g, itemId);
  if (!item) return reply("⚠️ Pick an item from the list.");
  const toChannel = option<string>(i, "to")!;
  const to = await store.getChannelHouse(gid, toChannel);
  if (to !== "raw" && to !== "product") {
    return reply(`⚠️ \`to:\` must be a goods house — ${houseLink(g.config, "raw")} or ${houseLink(g.config, "product")}.`);
  }
  // from = this channel's house; otherwise wherever the item has stock
  let from = await store.getChannelHouse(gid, channelId(i));
  if (from !== "raw" && from !== "product") {
    const inv = treasuryInventory(await store.listAllEntries(gid), g.recipes, g.catalog);
    const inRaw = (inv.raw[itemId] ?? 0) > 0;
    const inProduct = (inv.product[itemId] ?? 0) > 0;
    from = inRaw && !inProduct ? "raw" : inProduct && !inRaw ? "product" : undefined;
    if (!from) {
      return reply(`⚠️ Can't tell which house **${item.name}** is leaving — run this in the source house channel.`);
    }
  }
  if (from === to) return reply("⚠️ That's the same house.");
  await store.appendEntry(gid, mkEntry(i, g.config, "transfer", { transfer: { itemId, qty: n, from, to } }));
  return reply(
    embed({
      description: `🚚 <@${actorId(i)}> moved **${qty(n)}× ${item.name}** ${houseLink(g.config, from)} → ${houseLink(g.config, to)}`,
      color: COLORS.blue,
    }),
    false
  );
}

async function handleCheckout(i: any) {
  const gid = guildId(i);
  const g = await loadGuild(gid);
  const gate = needsSetup(g.config);
  if (gate) return reply(gate);
  const itemId = option<string>(i, "product")!;
  const n = option<number>(i, "qty")!;
  if (!(n > 0)) return reply("⚠️ Quantity must be positive.");
  const item = findItem(g, itemId);
  if (!item) return reply("⚠️ Pick a product from the list.");
  const inv = treasuryInventory(await store.listAllEntries(gid), g.recipes, g.catalog);
  const onHand = inv.product[itemId] ?? 0;
  if (n > onHand + 1e-9) {
    return reply(`⚠️ Only **${qty(onHand)}× ${item.name}** in ${houseLink(g.config, "product")} — can't check out ${qty(n)}.`);
  }
  await store.appendEntry(gid, mkEntry(i, g.config, "checkout", { checkout: { itemId, qty: n } }));
  const holding = (inv.holdings[actorId(i)]?.[itemId] ?? 0) + n;
  return reply(
    embed({
      description: `🎒 <@${actorId(i)}> checked out **${qty(n)}× ${item.name}** to sell — now holding **${qty(holding)}** for the crew`,
      color: COLORS.blue,
    }),
    false
  );
}

async function handleSale(i: any) {
  const gid = guildId(i);
  const g = await loadGuild(gid);
  const gate = needsSetup(g.config);
  if (gate) return reply(gate);
  const itemId = option<string>(i, "product")!;
  const n = option<number>(i, "qty")!;
  const cash = option<number>(i, "cash")!;
  if (!(n > 0) || !(cash >= 0)) return reply("⚠️ Check the numbers.");
  const item = findItem(g, itemId);
  if (!item) return reply("⚠️ Pick a product from the list.");
  const by = option<string>(i, "by") ?? actorId(i);
  const inv = treasuryInventory(await store.listAllEntries(gid), g.recipes, g.catalog);
  const held = inv.holdings[by]?.[itemId] ?? 0;
  const fromHolding = Math.min(held, n);
  const fromHouse = n - fromHolding;
  await store.appendEntry(gid, mkEntry(i, g.config, "sale", { sale: { itemId, qty: n, cash, by } }));
  const src =
    fromHolding > 0 && fromHouse > 0
      ? ` _(${qty(fromHolding)} from holding + ${qty(fromHouse)} from the house)_`
      : fromHolding > 0
        ? ` _(holding: ${qty(held - fromHolding)} still out)_`
        : "";
  const short = fromHouse > (inv.product[itemId] ?? 0) + 1e-9
    ? `\n⚠️ The books only show ${qty(inv.product[itemId] ?? 0)} in the house — \`/reconcile\` if the shelf disagrees.`
    : "";
  return reply(
    embed({
      description:
        `💵 <@${by}> sold **${qty(n)}× ${item.name}** for **${money(cash)}** — commission **${money(cash * g.config.commissionPct)}**${src}${short}`,
      color: COLORS.green,
    }),
    false
  );
}

async function handleReturn(i: any) {
  const gid = guildId(i);
  const g = await loadGuild(gid);
  const gate = needsSetup(g.config);
  if (gate) return reply(gate);
  const itemId = option<string>(i, "product")!;
  const n = option<number>(i, "qty")!;
  if (!(n > 0)) return reply("⚠️ Quantity must be positive.");
  const item = findItem(g, itemId);
  if (!item) return reply("⚠️ Pick a product from the list.");
  const inv = treasuryInventory(await store.listAllEntries(gid), g.recipes, g.catalog);
  const held = inv.holdings[actorId(i)]?.[itemId] ?? 0;
  if (n > held + 1e-9) {
    return reply(`⚠️ You're only holding **${qty(held)}× ${item.name}** — can't return ${qty(n)}.`);
  }
  await store.appendEntry(gid, mkEntry(i, g.config, "return", { return: { itemId, qty: n } }));
  const left = held - n;
  return reply(
    embed({
      description:
        `↩️ <@${actorId(i)}> returned **${qty(n)}× ${item.name}** to ${houseLink(g.config, "product")}` +
        (left > 1e-9 ? ` — still holding **${qty(left)}**` : " — holding squared ✅"),
      color: COLORS.green,
    }),
    false
  );
}

async function handleHolding(i: any) {
  const gid = guildId(i);
  const g = await loadGuild(gid);
  const gate = needsSetup(g.config);
  if (gate) return reply(gate);
  const member = option<string>(i, "member");
  const inv = treasuryInventory(await store.listAllEntries(gid), g.recipes, g.catalog);
  const rows: string[] = [];
  for (const [uid, items] of Object.entries(inv.holdings)) {
    if (member && uid !== member) continue;
    const list = Object.entries(items)
      .filter(([, q]) => Math.abs(q) > 1e-9)
      .map(([id, q]) => `${qty(q)}× ${itemName(g, id)}`)
      .join(" · ");
    if (list) rows.push(`• <@${uid}> — ${list}`);
  }
  if (!rows.length) {
    return reply(member ? `🎒 <@${member}> has nothing checked out.` : "🎒 Nothing's checked out — every run is squared.");
  }
  return reply(embed({ title: "🎒 Product out right now", color: COLORS.blue, description: rows.join("\n") }));
}

async function handleReconcile(i: any) {
  const gid = guildId(i);
  const g = await loadGuild(gid);
  const gate = needsSetup(g.config);
  if (gate) return reply(gate);
  if (!isOfficer(i, g.config)) return reply("⛔ Officers only.");
  const itemId = option<string>(i, "item")!;
  const count = option<number>(i, "count")!;
  if (!(count >= 0)) return reply("⚠️ Count can't be negative.");
  const item = findItem(g, itemId);
  if (!item) return reply("⚠️ Pick an item from the list.");
  const house = await goodsHouse(i, item);
  const inv = treasuryInventory(await store.listAllEntries(gid), g.recipes, g.catalog);
  const expected = inv[house][itemId] ?? 0;
  const diff = count - expected;
  await store.appendEntry(gid, mkEntry(i, g.config, "reconcile", { reconcile: { itemId, count, house } }));
  return reply(
    embed({
      description:
        `📋 <@${actorId(i)}> counted **${qty(count)}× ${item.name}** in ${houseLink(g.config, house)} — books said ${qty(expected)}` +
        (Math.abs(diff) > 1e-9 ? ` → **${diff > 0 ? "+" : ""}${qty(diff)}** recorded` : " ✅ books match"),
      color: Math.abs(diff) > 1e-9 ? COLORS.gold : COLORS.green,
    }),
    false
  );
}

async function handleWithdraw(i: any) {
  const gid = guildId(i);
  const g = await loadGuild(gid);
  const gate = needsSetup(g.config);
  if (gate) return reply(gate);
  const cash = option<number>(i, "cash");
  const itemId = option<string>(i, "item");
  const n = option<number>(i, "qty");
  if (cash != null) {
    if (!(cash > 0)) return reply("⚠️ Amount must be positive.");
    await store.appendEntry(gid, mkEntry(i, g.config, "withdraw", { withdraw: { cash, house: "money" } }));
    return reply(
      embed({ description: `📤 <@${actorId(i)}> withdrew **${money(cash)}** for personal use — off their tab at payout`, color: COLORS.blue }),
      false
    );
  }
  if (itemId && n != null) {
    if (!(n > 0)) return reply("⚠️ Quantity must be positive.");
    const item = findItem(g, itemId);
    if (!item) return reply("⚠️ Pick an item from the list.");
    const house = await goodsHouse(i, item);
    const v = (valuesOf(g)[itemId] ?? 0) * n;
    await store.appendEntry(gid, mkEntry(i, g.config, "withdraw", { withdraw: { itemId, qty: n, house } }));
    return reply(
      embed({
        description: `📤 <@${actorId(i)}> withdrew **${qty(n)}× ${item.name}** (${money(v)}) for personal use — off their tab at payout`,
        color: COLORS.blue,
      }),
      false
    );
  }
  return reply("Provide `item` + `qty`, or `cash`.");
}

async function handleLoss(i: any) {
  const gid = guildId(i);
  const g = await loadGuild(gid);
  const gate = needsSetup(g.config);
  if (gate) return reply(gate);
  const cause = (option<string>(i, "cause") ?? "other") as LossCause;
  const note = option<string>(i, "note");
  const charge = option<string>(i, "charge");
  const holder = option<string>(i, "holder");
  if (charge && !isOfficer(i, g.config)) {
    return reply("⛔ Only an officer can charge a loss to a member — log it without `charge:` and flag them.");
  }
  const cash = option<number>(i, "cash");
  const itemId = option<string>(i, "item");
  const n = option<number>(i, "qty");

  let body: string;
  if (cash != null) {
    if (!(cash > 0)) return reply("⚠️ Amount must be positive.");
    await store.appendEntry(gid, mkEntry(i, g.config, "loss", { loss: { cash, cause, charge, note } }));
    body = `🚨 **${money(cash)}** lost (${cause})`;
  } else if (itemId && n != null) {
    if (!(n > 0)) return reply("⚠️ Quantity must be positive.");
    const item = findItem(g, itemId);
    if (!item) return reply("⚠️ Pick an item from the list.");
    if (holder) {
      const inv = treasuryInventory(await store.listAllEntries(gid), g.recipes, g.catalog);
      const held = inv.holdings[holder]?.[itemId] ?? 0;
      if (n > held + 1e-9) {
        return reply(`⚠️ <@${holder}> is only holding ${qty(held)}× ${item.name} — check \`/holding\`.`);
      }
      await store.appendEntry(gid, mkEntry(i, g.config, "loss", { loss: { itemId, qty: n, holder, cause, charge, note } }));
      body = `🚨 **${qty(n)}× ${item.name}** lost from <@${holder}>'s holding (${cause})`;
    } else {
      const house = await goodsHouse(i, item);
      await store.appendEntry(gid, mkEntry(i, g.config, "loss", { loss: { itemId, qty: n, house, cause, charge, note } }));
      body = `🚨 **${qty(n)}× ${item.name}** lost from ${houseLink(g.config, house)} (${cause})`;
    }
  } else {
    return reply("Provide `item` + `qty`, or `cash`.");
  }
  const chargedV = cash ?? (valuesOf(g)[itemId!] ?? 0) * (n ?? 0);
  return reply(
    embed({
      description: [
        body,
        charge ? `⚖️ Charged to <@${charge}> — **${money(chargedV)}** off their cut.` : "🤝 Crew-shared — comes out of the fund.",
        note ? `_"${note}"_` : "",
        "Recovered later? An officer can `/void` this entry.",
      ]
        .filter(Boolean)
        .join("\n"),
      color: COLORS.red,
    }),
    false
  );
}

async function handleVoid(i: any) {
  const gid = guildId(i);
  const g = await loadGuild(gid);
  const gate = needsSetup(g.config);
  if (gate) return reply(gate);
  if (!isOfficer(i, g.config)) return reply("⛔ Officers only.");
  const entryId = option<string>(i, "entry")!;
  const entries = await store.listCycleEntries(gid, g.config.cycleNumber!);
  const target = entries.find((e) => e.id === entryId);
  if (!target) return reply("⚠️ Pick an entry from the list (only this cycle's entries can be voided).");
  if (target.type === "void") return reply("⚠️ That's already a void marker.");
  if (target.type === "payout") return reply("⚠️ A payout can't be voided.");
  await store.appendEntry(gid, mkEntry(i, g.config, "void", { voids: entryId }));
  return reply(
    embed({ description: `🚫 <@${actorId(i)}> voided: ${entryLine(g, target)}`, color: COLORS.red }),
    false
  );
}

// ---- treasury reports & payout ----

async function cycleState(gid: string, g: GuildData) {
  const [cycleEntries, allEntries, prev] = await Promise.all([
    store.listCycleEntries(gid, g.config.cycleNumber!),
    store.listAllEntries(gid),
    g.config.cycleNumber! > 1 ? store.getPayoutRecord(gid, g.config.cycleNumber! - 1) : Promise.resolve(undefined),
  ]);
  const openingClaims = prev?.carryover ?? {};
  const tabs = accrueTabs({ config: g.config, catalog: g.catalog, recipes: g.recipes, lines: g.lines, entries: cycleEntries, openingClaims });
  const inv = treasuryInventory(allEntries, g.recipes, g.catalog);
  const owed = [...tabs.values()].reduce((s, t) => s + Math.max(0, t.earned - t.advances - t.withdrawals), 0);
  return { cycleEntries, allEntries, openingClaims, tabs, inv, owed, fund: inv.cash - owed };
}

function tabLines(t: MemberTab): string {
  const parts: string[] = [];
  if (t.capital) parts.push(`capital ${money(t.capital)}`);
  if (t.farm) parts.push(`farm ${money(t.farm)}`);
  if (t.labor) parts.push(`labor ${money(t.labor)}`);
  if (t.commission) parts.push(`commission ${money(t.commission)}`);
  if (t.advances) parts.push(`advanced −${money(t.advances)}`);
  if (t.withdrawals) parts.push(`taken −${money(t.withdrawals)}`);
  return parts.join(" · ") || "nothing yet";
}

async function handleOwed(i: any) {
  const gid = guildId(i);
  const g = await loadGuild(gid);
  const gate = needsSetup(g.config);
  if (gate) return reply(gate);
  const member = option<string>(i, "member") ?? actorId(i);
  const s = await cycleState(gid, g);
  const t = s.tabs.get(member);
  if (!t) return reply(`🧾 <@${member}> has no contributions in cycle ${g.config.cycleNumber} yet.`);
  const cap = Math.min(advanceable(t), Math.max(0, s.inv.cash));
  return reply(
    embed({
      title: `🧾 Cycle ${g.config.cycleNumber} tab`,
      color: COLORS.gold,
      description: [
        `<@${member}> — ${tabLines(t)}`,
        "",
        `**Earned so far: ${money(t.earned)}**${t.advances || t.withdrawals ? ` · still owed ${money(Math.max(0, t.earned - t.advances - t.withdrawals))}` : ""}`,
        `Advanceable now: **${money(cap)}** _(rank share lands at payout)_`,
      ].join("\n"),
    })
  );
}

async function handleAdvance(i: any) {
  const gid = guildId(i);
  const g = await loadGuild(gid);
  const gate = needsSetup(g.config);
  if (gate) return reply(gate);
  if (!isOfficer(i, g.config)) return reply("⛔ Officers only — members ask an officer for an advance.");
  const member = option<string>(i, "member")!;
  const amount = option<number>(i, "amount")!;
  if (!(amount > 0)) return reply("⚠️ Amount must be positive.");
  const s = await cycleState(gid, g);
  const t = s.tabs.get(member);
  const cap = t ? advanceable(t) : 0;
  if (amount > cap + 1e-9) {
    return reply(`⚠️ <@${member}> has **${money(cap)}** advanceable (earned − already advanced) — can't advance ${money(amount)}.`);
  }
  if (amount > s.inv.cash + 1e-9) {
    return reply(`⚠️ The money house only has **${money(s.inv.cash)}**.`);
  }
  await store.appendEntry(gid, mkEntry(i, g.config, "advance", { advance: { userId: member, amount } }));
  return reply(
    embed({
      description: `🤝 <@${actorId(i)}> advanced **${money(amount)}** to <@${member}> — squares up at payout _(${money(cap - amount)} still advanceable)_`,
      color: COLORS.green,
    }),
    false
  );
}

async function handleSpend(i: any) {
  const gid = guildId(i);
  const g = await loadGuild(gid);
  const gate = needsSetup(g.config);
  if (gate) return reply(gate);
  if (!isOfficer(i, g.config)) return reply("⛔ Officers only.");
  const amount = option<number>(i, "amount")!;
  const reason = option<string>(i, "reason")!;
  if (!(amount > 0)) return reply("⚠️ Amount must be positive.");
  const s = await cycleState(gid, g);
  if (amount > s.inv.cash + 1e-9) {
    return reply(`⚠️ The money house only has **${money(s.inv.cash)}**.`);
  }
  await store.appendEntry(gid, mkEntry(i, g.config, "spend", { spend: { amount, reason } }));
  return reply(
    embed({ description: `🧾 <@${actorId(i)}> spent **${money(amount)}** of crew cash — _${reason}_ (comes out of the fund)`, color: COLORS.gold }),
    false
  );
}

async function handleFund(i: any) {
  const gid = guildId(i);
  const g = await loadGuild(gid);
  const gate = needsSetup(g.config);
  if (gate) return reply(gate);
  const s = await cycleState(gid, g);
  return reply(
    embed({
      title: `💼 Cycle ${g.config.cycleNumber} — the fund`,
      color: s.fund >= 0 ? COLORS.green : COLORS.red,
      description: [
        `Money house: **${money(s.inv.cash)}**`,
        `Owed for work/capital so far: **${money(s.owed)}**`,
        s.fund >= 0
          ? `**Fund (profit if we paid out now): ${money(s.fund)}** — splits by rank at \`/payout\``
          : `**Short ${money(-s.fund)}** — sales haven't covered work/capital yet`,
      ].join("\n"),
    })
  );
}

async function handleStash(i: any) {
  const gid = guildId(i);
  const g = await loadGuild(gid);
  const gate = needsSetup(g.config);
  if (gate) return reply(gate);
  const inv = treasuryInventory(await store.listAllEntries(gid), g.recipes, g.catalog);
  const pick = option<string>(i, "house") as House | undefined;
  const chHouse = await store.getChannelHouse(gid, channelId(i));
  const wanted: House[] = pick ? [pick] : chHouse === "raw" || chHouse === "product" || chHouse === "money" ? [chHouse] : ["raw", "product", "money"];
  const listOf = (rec: Record<string, number>) =>
    Object.entries(rec)
      .filter(([, q]) => Math.abs(q) > 1e-9)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .map(([id, q]) => `${itemName(g, id)} ×${qty(q)}`)
      .join(" · ") || "empty";
  const fields = wanted.map((h) => ({
    name: HOUSE_LABEL[h],
    value: h === "money" ? money(inv.cash) : listOf(inv[h]),
  }));
  const out = Object.entries(inv.holdings)
    .map(([uid, items]) =>
      Object.entries(items)
        .filter(([, q]) => Math.abs(q) > 1e-9)
        .map(([id, q]) => `<@${uid}> ${qty(q)}× ${itemName(g, id)}`)
        .join(" · ")
    )
    .filter(Boolean)
    .join(" · ");
  if (!pick && out) fields.push({ name: "🎒 out with members", value: out });
  return reply(embed({ title: "📦 Stash — expected counts (books)", color: COLORS.gold, fields }));
}

function bestLevel(roles: string[] | undefined, rankMap: Record<string, number>): number {
  let best = 5;
  for (const r of roles ?? []) {
    const lvl = rankMap[r];
    if (lvl != null && lvl < best) best = lvl;
  }
  return best;
}

async function handleMe(i: any) {
  const gid = guildId(i);
  const g = await loadGuild(gid);
  const gate = needsSetup(g.config);
  if (gate) return reply(gate);
  const me = actorId(i);
  const [s, ranks] = await Promise.all([cycleState(gid, g), store.listRanks(gid)]);
  const rankMap = Object.fromEntries(ranks.map((r) => [r.roleId, r.level]));
  const myLevel = bestLevel(i.member?.roles, rankMap);
  const t = s.tabs.get(me);
  const held = Object.entries(s.inv.holdings[me] ?? {})
    .filter(([, q]) => Math.abs(q) > 1e-9)
    .map(([id, q]) => `${qty(q)}× ${itemName(g, id)}`)
    .join(" · ");
  const fields = [
    { name: "Rank", value: `Level ${myLevel} (${g.config.rankMultipliers[myLevel] ?? 1}×)`, inline: true },
    { name: "Earned this cycle", value: t ? money(t.earned) : "$0", inline: true },
    { name: "Advanceable", value: t ? money(Math.min(advanceable(t), Math.max(0, s.inv.cash))) : "$0", inline: true },
  ];
  if (held) fields.push({ name: "🎒 Holding", value: held, inline: false });
  return reply(
    embed({
      title: `🧍 You — cycle ${g.config.cycleNumber}`,
      color: COLORS.blue,
      description: t
        ? `${tabLines(t)}\n_Work is paid at its value; your rank share of the fund lands at \`/payout\`._`
        : "_No contributions this cycle yet — anything you log lands on your tab._",
      fields,
    })
  );
}

function entryLine(g: GuildData, e: LedgerEntry): string {
  const who = `<@${e.actor}>`;
  const nm = (id: string) => itemName(g, id);
  if (e.type === "deposit" && e.deposit)
    return `📥 ${who} +${qty(e.deposit.qty)}× ${nm(e.deposit.itemId)}${e.deposit.credit !== e.actor ? ` _(credit <@${e.deposit.credit}>)_` : ""}`;
  if (e.type === "buy" && e.buy) return `🛒 ${who} bought ${qty(e.buy.qty)}× ${nm(e.buy.itemId)}`;
  if (e.type === "fund" && e.fund) return `💰 ${who} funded ${money(e.fund.cash)}`;
  if (e.type === "process" && e.process)
    return `⚗️ <@${e.process.credit}> ${e.process.lineId}/${e.process.step} → ${qty(e.process.made)}`;
  if (e.type === "transfer" && e.transfer)
    return `🚚 ${who} ${qty(e.transfer.qty)}× ${nm(e.transfer.itemId)} ${e.transfer.from}→${e.transfer.to}`;
  if (e.type === "sale" && e.sale) return `💵 <@${e.sale.by}> sold ${qty(e.sale.qty)}× ${nm(e.sale.itemId)} for ${money(e.sale.cash)}`;
  if (e.type === "withdraw" && e.withdraw)
    return e.withdraw.cash != null
      ? `📤 ${who} −${money(e.withdraw.cash)}`
      : `📤 ${who} −${qty(e.withdraw.qty ?? 0)}× ${nm(e.withdraw.itemId!)}`;
  if (e.type === "advance" && e.advance) return `🤝 advance ${money(e.advance.amount)} → <@${e.advance.userId}>`;
  if (e.type === "spend" && e.spend) return `🧾 spent ${money(e.spend.amount)} — ${e.spend.reason}`;
  if (e.type === "reconcile" && e.reconcile)
    return `📋 ${nm(e.reconcile.itemId)} counted at ${qty(e.reconcile.count)} (${e.reconcile.house})`;
  if (e.type === "loss" && e.loss) {
    const what = e.loss.cash != null ? money(e.loss.cash) : `${qty(e.loss.qty ?? 0)}× ${nm(e.loss.itemId!)}`;
    const from = e.loss.holder ? ` from <@${e.loss.holder}>` : "";
    return `🚨 lost ${what}${from} (${e.loss.cause})${e.loss.charge ? ` — charged <@${e.loss.charge}>` : ""}`;
  }
  if (e.type === "checkout" && e.checkout) return `🎒 ${who} checked out ${qty(e.checkout.qty)}× ${nm(e.checkout.itemId)}`;
  if (e.type === "return" && e.return) return `↩️ ${who} returned ${qty(e.return.qty)}× ${nm(e.return.itemId)}`;
  if (e.type === "payout" && e.payout) return `💰 payout — cycle settled, ${money(e.payout.total)} handed out`;
  if (e.type === "void") return `🚫 ${who} voided an entry`;
  return `• ${e.type}`;
}

function ledgerBody(g: GuildData, entries: LedgerEntry[], full = false): string {
  const cycle = g.config.cycleNumber;
  if (!entries.length) return `📜 **Cycle ${cycle}** — no entries yet.`;
  const voided = new Set(entries.filter((e) => e.type === "void").map((e) => e.voids));
  const list = full ? entries : entries.slice(-25);
  const lines = list.map((e) => (voided.has(e.id) ? `~~${entryLine(g, e)}~~ _(voided)_` : entryLine(g, e)));
  const more = !full && entries.length > 25 ? `\n_…${entries.length - 25} earlier this cycle_` : "";
  return `📜 **Cycle ${cycle}** — ledger (${entries.length} entries)\n${lines.join("\n")}${more}`;
}

async function handleLedger(i: any) {
  const gid = guildId(i);
  const g = await loadGuild(gid);
  const gate = needsSetup(g.config);
  if (gate) return reply(gate);
  const entries = await store.listCycleEntries(gid, g.config.cycleNumber!);
  return reply(embed({ description: ledgerBody(g, entries), color: COLORS.gold }));
}

async function handleStatus(i: any) {
  const gid = guildId(i);
  const g = await loadGuild(gid);
  const gate = needsSetup(g.config);
  if (gate) return reply(gate);
  const s = await cycleState(gid, g);
  const listOf = (rec: Record<string, number>) =>
    Object.entries(rec)
      .filter(([, q]) => Math.abs(q) > 1e-9)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, 8)
      .map(([id, q]) => `${itemName(g, id)} ×${qty(q)}`)
      .join(" · ") || "empty";
  const contributors = [...s.tabs.values()]
    .filter((t) => t.earned > 0)
    .sort((a, b) => b.earned - a.earned)
    .slice(0, 12)
    .map((t) => `• <@${t.userId}> — ${tabLines(t)}`);
  const claims = Object.entries(s.openingClaims).map(([u, v]) => `<@${u}> ${money(v)}`).join(" · ");
  return reply(
    embed({
      title: `📊 Treasury — cycle ${g.config.cycleNumber}`,
      color: s.fund >= 0 ? COLORS.green : COLORS.gold,
      description: [
        `Cash **${money(s.inv.cash)}** · owed for work **${money(s.owed)}** · fund **${money(Math.max(0, s.fund))}**`,
        claims ? `Opening claims carried in: ${claims}` : "",
        "",
        contributors.length ? "**Contributors this cycle**\n" + contributors.join("\n") : "_No contributions this cycle yet._",
      ]
        .filter(Boolean)
        .join("\n"),
      fields: [
        { name: HOUSE_LABEL.raw, value: listOf(s.inv.raw) },
        { name: HOUSE_LABEL.product, value: listOf(s.inv.product) },
      ],
    })
  );
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

async function payoutWork(i: any): Promise<MsgData | string> {
  const gid = guildId(i);
  const g = await loadGuild(gid);
  const gate = needsSetup(g.config);
  if (gate) return gate;
  if (!isOfficer(i, g.config)) return "⛔ Officers only — `/payout` settles the whole cycle.";

  const cycle = g.config.cycleNumber!;
  const s = await cycleState(gid, g);
  if (![...s.tabs.values()].some((t) => t.earned > 0) && s.inv.cash <= 0) {
    return `⚠️ Nothing to settle in cycle ${cycle} — no contributions and no cash.`;
  }

  // resolve each participant's rank level from their Discord roles
  const ranks = await store.listRanks(gid);
  const rankMap = Object.fromEntries(ranks.map((r) => [r.roleId, r.level]));
  const levels = await Promise.all(
    [...s.tabs.keys()].map(async (uid) => {
      try {
        const mem = await rest.getMember(gid, uid);
        return [uid, bestLevel(mem.roles, rankMap)] as const;
      } catch {
        return [uid, 5] as const;
      }
    })
  );

  const result = payout({
    config: g.config,
    catalog: g.catalog,
    recipes: g.recipes,
    lines: g.lines,
    entries: s.cycleEntries,
    openingClaims: s.openingClaims,
    cash: s.inv.cash,
    memberLevels: Object.fromEntries(levels),
  });

  // archive, drain the money house, open the next cycle
  await store.putPayoutRecord(gid, {
    cycle,
    ts: snowflakeTs(i.id),
    cash: result.cash,
    fund: result.fund,
    loss: result.loss,
    perMember: result.perMember,
    carryover: result.carryover,
  });
  await store.appendEntry(gid, mkEntry(i, g.config, "payout", { payout: { total: result.cash } }));
  g.config.cycleNumber = cycle + 1;
  g.config.cycleStartedAt = snowflakeTs(i.id);
  await store.putConfig(gid, g.config);

  const rows = [...result.perMember]
    .sort((a, b) => b.net - a.net)
    .map((p) => {
      const bits = [
        p.capital ? `capital back ${money(p.capital)}` : "",
        p.farm ? `farm ${money(p.farm)}` : "",
        p.labor ? `labor ${money(p.labor)}` : "",
        p.commission ? `commission ${money(p.commission)}` : "",
        p.rankShare ? `rank ${money(p.rankShare)}` : "",
        p.advances ? `advanced −${money(p.advances)}` : "",
        p.withdrawals ? `taken −${money(p.withdrawals)}` : "",
        p.forgiven ? `forgiven ${money(p.forgiven)}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return `**<@${p.userId}>** — hand them **${money(p.net)}**  _(${bits})_`;
    });
  const carry = Object.entries(result.carryover).map(([u, v]) => `<@${u}> ${money(v)}`).join(" · ");
  const foot = result.loss
    ? `⚠️ **Loss cycle** — cash didn't cover work/capital. Capital reimbursed first, pro-rata; no fund.` +
      (carry ? `\nCarried to cycle ${cycle + 1} as opening claims: ${carry}` : "")
    : `Cash ${money(result.cash)} − owed ${money(result.owed)} → fund **${money(result.fund)}** split by rank among contributors.` +
      (result.tiesOut ? "" : " ⚠️ rounding mismatch.");
  const unsold = Object.entries(s.inv.product).filter(([, q]) => q > 1e-9).length;
  const payoutEmbed = embed({
    title: `💰 Payday — cycle ${cycle} · ${money(result.cash)}`,
    color: result.loss ? COLORS.red : COLORS.green,
    description: [...rows, "", foot, unsold ? `📦 Inventory carries into cycle ${cycle + 1} (nothing resets but the tally).` : ""].filter(Boolean).join("\n"),
  });

  // post the dispute record (full cycle ledger + payout) to the treasury channel
  const recordCh = g.config.houseChannels?.treasury ?? channelId(i);
  try {
    await postChunks(recordCh, ledgerBody(g, s.cycleEntries, true));
    await rest.postMessage(recordCh, payoutEmbed);
  } catch (e) {
    console.error("payout record post failed", e);
  }

  return payoutEmbed;
}

// ---- autocomplete ----

async function handleAutocomplete(i: any) {
  const f = focusedOption(i);
  if (!f) return autocompleteResult([]);
  const gid = guildId(i);
  const q = f.value.toLowerCase();

  if (f.name === "item") {
    let items = await store.listCatalog(gid);
    if (commandName(i) === "catalog" && subcommand(i) === "set") items = items.filter((it) => it.kind === "base");
    return autocompleteResult(
      items
        .filter((it) => it.name.toLowerCase().includes(q) || it.id.includes(q))
        .map((it) => ({
          name: it.kind === "base" ? `${it.name} — $${it.value}` : it.name,
          value: it.id,
        }))
    );
  }
  if (f.name === "line") {
    const lines = await store.listLines(gid);
    return autocompleteResult(
      lines.filter((l) => l.name.toLowerCase().includes(q)).map((l) => ({ name: l.name, value: l.id }))
    );
  }
  if (f.name === "product") {
    const [lines, catalog] = await Promise.all([store.listLines(gid), store.listCatalog(gid)]);
    const nameOf = (id: string) => catalog.find((c) => c.id === id)?.name ?? id;
    return autocompleteResult(
      lines
        .map((l) => ({ name: `${nameOf(l.finalItemId)} (${l.name})`, value: l.finalItemId }))
        .filter((c) => c.name.toLowerCase().includes(q))
    );
  }
  if (f.name === "step") {
    const lineId = option<string>(i, "line");
    const recipes = await store.listRecipes(gid);
    return autocompleteResult(
      recipes
        .filter((r) => (!lineId || r.lineId === lineId) && r.step.toLowerCase().includes(q))
        .map((r) => ({ name: `${r.step} → ${r.output.itemId}`, value: r.step }))
    );
  }
  if (f.name === "entry") {
    const [config, catalog, recipes, lines] = await Promise.all([
      store.getConfig(gid),
      store.listCatalog(gid),
      store.listRecipes(gid),
      store.listLines(gid),
    ]);
    if (!config.cycleNumber) return autocompleteResult([]);
    const g: GuildData = { config, catalog, recipes, lines };
    const entries = await store.listCycleEntries(gid, config.cycleNumber);
    const voided = new Set(entries.filter((e) => e.type === "void").map((e) => e.voids));
    const strip = (s: string) => s.replace(/<@&?(\d+)>/g, "@$1").replace(/[*_~`]/g, "");
    return autocompleteResult(
      entries
        .filter((e) => e.type !== "void" && e.type !== "payout" && !voided.has(e.id))
        .slice(-25)
        .reverse()
        .map((e) => ({ name: strip(entryLine(g, e)).slice(0, 100), value: e.id }))
    );
  }
  return autocompleteResult([]);
}

// ---- /config interactive panel ----

const clampFill = (n: number) => Math.max(0, Math.min(8, n));
const BAR = (fill: number) => "▰".repeat(clampFill(fill)) + "░".repeat(8 - clampFill(fill));
const RANK_DEFAULT: Record<number, number> = { 1: 5, 2: 4, 3: 3, 4: 2, 5: 1 };

interface Dial {
  key: string;
  label: string;
  fine: number;
  coarse: number;
  val: (c: Config) => string;
  fill: (c: Config) => number;
  apply: (c: Config, d: number) => void;
  reset: (c: Config) => void;
}

const DIALS: Dial[] = [
  {
    key: "labor", label: "Labor rate", fine: 1, coarse: 10,
    val: (c) => `$${c.laborRate} / unit`,
    fill: (c) => Math.round((Math.min(c.laborRate, 200) / 200) * 8),
    apply: (c, d) => { c.laborRate = Math.max(0, c.laborRate + d); },
    reset: (c) => { c.laborRate = 25; },
  },
  {
    key: "commission", label: "Sell commission", fine: 1, coarse: 5,
    val: (c) => `${Math.round(c.commissionPct * 100)} %`,
    fill: (c) => Math.round((Math.min(c.commissionPct, 0.3) / 0.3) * 8),
    apply: (c, d) => { c.commissionPct = Math.min(1, Math.max(0, c.commissionPct + d / 100)); },
    reset: (c) => { c.commissionPct = 0.08; },
  },
  {
    key: "margin", label: "Farm margin", fine: 1, coarse: 5,
    val: (c) => `${Math.round((c.targetMargin ?? 0) * 100)} %`,
    fill: (c) => Math.round(Math.min(c.targetMargin ?? 0, 1) * 8),
    apply: (c, d) => { c.targetMargin = Math.min(0.95, Math.max(0, (c.targetMargin ?? 0) + d / 100)); },
    reset: (c) => { c.targetMargin = 0.4; },
  },
  ...[1, 2, 3, 4, 5].map(
    (lvl): Dial => ({
      key: `rank${lvl}`, label: `Rank L${lvl} weight`, fine: 1, coarse: 5,
      val: (c) => `${c.rankMultipliers[lvl] ?? 0}×`,
      fill: (c) => Math.round((Math.min(c.rankMultipliers[lvl] ?? 0, 10) / 10) * 8),
      apply: (c, d) => { c.rankMultipliers[lvl] = Math.max(0, (c.rankMultipliers[lvl] ?? 0) + d); },
      reset: (c) => { c.rankMultipliers[lvl] = RANK_DEFAULT[lvl]; },
    })
  ),
];

const stepBtn = (key: string, delta: number, label: string) => ({
  type: 2,
  style: 2,
  label,
  custom_id: `cfg:step:${key}:${delta}`,
});

function renderPanel(config: Config, focusedKey: string): MsgData {
  const focused = DIALS.find((d) => d.key === focusedKey) ?? DIALS[0];
  const deltas = [...new Set([-focused.coarse, -focused.fine, focused.fine, focused.coarse])].sort((a, b) => a - b);
  const lines = DIALS.map(
    (d) => `${d.key === focused.key ? "▸" : " "} ${d.label.padEnd(16)} ${BAR(d.fill(config))}  ${d.val(config)}`
  );
  return {
    embeds: [
      {
        title: "⚙️ Economy dials",
        description: "```\n" + lines.join("\n") + "\n```",
        color: COLORS.gold,
        footer: { text: `Adjusting: ${focused.label}` },
      },
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 3,
            custom_id: "cfg:sel",
            placeholder: "Pick a dial to adjust",
            options: DIALS.map((d) => ({ label: d.label, value: d.key, default: d.key === focused.key })),
          },
        ],
      },
      {
        type: 1,
        components: deltas.map((d) => stepBtn(focused.key, d, `${d > 0 ? "+" : "−"}${Math.abs(d)}`)),
      },
      {
        type: 1,
        components: [
          { type: 2, style: 4, label: "Reset", custom_id: `cfg:reset:${focused.key}` },
          { type: 2, style: 3, label: "Done", custom_id: "cfg:done" },
        ],
      },
    ],
  };
}

async function handleComponent(i: any) {
  const cid: string = i.data?.custom_id ?? "";
  if (!cid.startsWith("cfg:")) return json({ type: 6 }); // DeferredMessageUpdate — ignore
  const gid = guildId(i);
  const config = await store.getConfig(gid);
  if (!isOfficer(i, config)) {
    return json({ type: 4, data: { content: "⛔ Officers only.", flags: 64 } });
  }
  const [, action, key, deltaStr] = cid.split(":");
  let focused = key ?? DIALS[0].key;
  if (action === "sel") {
    focused = i.data.values?.[0] ?? DIALS[0].key;
  } else if (action === "step") {
    const dial = DIALS.find((d) => d.key === key);
    if (dial) {
      dial.apply(config, Number(deltaStr));
      await store.putConfig(gid, config);
    }
  } else if (action === "reset") {
    const dial = DIALS.find((d) => d.key === key);
    if (dial) {
      dial.reset(config);
      await store.putConfig(gid, config);
    }
  } else if (action === "done") {
    return json({
      type: 7, // UpdateMessage
      data: {
        embeds: [
          {
            title: "⚙️ Dials saved",
            color: COLORS.green,
            description: DIALS.map((d) => `**${d.label}:** ${d.val(config)}`).join("\n"),
          },
        ],
        components: [],
      },
    });
  }
  return json({ type: 7, data: renderPanel(config, focused) });
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
    else if (dial === "commission") config.commissionPct = value / 100;
    else if (dial === "farm-margin") config.targetMargin = value / 100;
    await store.putConfig(gid, config);
    return reply(embed({ description: `✅ Updated **${dial}** → ${value}.`, color: COLORS.green }));
  }

  if (sub === "panel") {
    if (!isOfficer(i, config)) return reply("⛔ Officers only.");
    return reply(renderPanel(config, DIALS[0].key), true);
  }

  // view
  const lines = await store.listLines(gid);
  const refs = lines.map((l) => `${l.name} $${l.referencePrice}`).join(" · ") || "—";
  const mults = Object.entries(config.rankMultipliers)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([, w]) => `${w}×`)
    .join(" / ");
  return reply(
    embed({
      title: "⚙️ Economy dials",
      color: COLORS.gold,
      fields: [
        { name: "Labor rate", value: `$${config.laborRate} / unit`, inline: true },
        { name: "Commission", value: `${Math.round(config.commissionPct * 100)}%`, inline: true },
        { name: "Cycle", value: `${config.cycleNumber ?? "—"}`, inline: true },
        { name: "Farm margin", value: `${Math.round((config.targetMargin ?? 0) * 100)}% — farmed inputs auto-priced from product`, inline: false },
        { name: "Rank weights (I→V)", value: mults, inline: false },
        { name: "Reference prices", value: refs, inline: false },
        { name: "Officer role", value: config.officerRoleId ? `<@&${config.officerRoleId}>` : "_unset_", inline: false },
      ],
    })
  );
}

// ---- catalog / rank / recipe (unchanged from v1) ----

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
    const autoFarmed = item.source === "farmed" && (config.targetMargin ?? 0) > 0;
    return reply(
      embed({
        description:
          `✅ **${item.name}** → $${item.value}${source ? ` (${source})` : ""}.` +
          (autoFarmed
            ? `\n\n_Note: this is a farmed input, so its value is auto-derived from the product price (farm margin ${Math.round((config.targetMargin ?? 0) * 100)}%). The number you set is stored but won't be used until you turn the farm margin to 0 in \`/config\`._`
            : ""),
        color: COLORS.green,
      })
    );
  }

  if (sub === "remove") {
    if (!isOfficer(i, config)) return reply("⛔ Officers only.");
    const id = option<string>(i, "item")!;
    const item = await store.getCatalogItem(gid, id);
    if (!item) return reply("⚠️ Pick an existing item from the list.");
    const used = (await store.listRecipes(gid))
      .filter((r) => r.output.itemId === id || r.inputs.some((x) => x.itemId === id))
      .map((r) => `${r.lineId}/${r.step}`);
    await store.deleteCatalogItem(gid, id);
    return reply(
      embed({
        description:
          `🗑️ Removed **${item.name}**.` +
          (used.length
            ? `\n⚠️ Still referenced by recipe step(s): ${used.join(", ")} — fix them with \`/recipe build\` or they'll value it at $0.`
            : ""),
        color: COLORS.gray,
      })
    );
  }

  // list
  const items = await store.listCatalog(gid);
  if (!items.length) return reply("📦 Catalog is empty — run `/setup` first.");
  const recipes = await store.listRecipes(gid);
  const lines = await store.listLines(gid);
  const margin = config.targetMargin ?? 0;
  const values = itemValues(items, recipes, lines, margin); // farmed back-solved, intermediates built, finals = ref price
  const m2 = (n: number) => `$${+n.toFixed(2)}`;

  const base = items
    .filter((it) => it.kind === "base")
    .map((it) => {
      const auto = it.source === "farmed" && margin > 0;
      return `${it.name} ${m2(values[it.id] ?? it.value)}${
        auto ? " _(farmed·auto)_" : it.source ? ` _(${it.source})_` : ""
      }`;
    })
    .join(" · ") || "—";
  const inter = items
    .filter((it) => it.kind === "intermediate")
    .map((it) => `${it.name} ${m2(values[it.id] ?? 0)}`)
    .join(" · ") || "—";
  const fin = items
    .filter((it) => it.kind === "final")
    .map((it) => `${it.name} ${m2(values[it.id] ?? 0)}`)
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
      footer: margin > 0
        ? `Farmed inputs auto-priced at ${Math.round(margin * 100)}% target margin (/config).`
        : undefined,
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

async function handleRecipe(i: any) {
  const gid = guildId(i);
  const config = await store.getConfig(gid);
  if (!isOfficer(i, config)) return reply("⛔ Officers only.");
  const sub = subcommand(i);

  if (sub === "line") {
    const name = option<string>(i, "name")!.trim();
    const finalName = option<string>(i, "final")!.trim();
    const price = option<number>(i, "price")!;
    const lineId = slug(name);
    const finalItemId = slug(finalName);
    await store.putLine(gid, { id: lineId, name, finalItemId, referencePrice: price });
    await store.putCatalogItem(gid, { id: finalItemId, name: finalName, kind: "final", value: 0, lineId });
    return reply(
      embed({
        description: `✅ Product line **${name}** added (final: **${finalName}**, sells ~$${price}). Define its steps with \`/recipe build\`.`,
        color: COLORS.green,
      })
    );
  }

  if (sub === "build") {
    const lineId = option<string>(i, "line")!;
    const line = (await store.listLines(gid)).find((l) => l.id === lineId);
    if (!line) return reply("⚠️ Pick a product line (add one with `/recipe line`).");
    // Pre-fill with the current chain so this doubles as an editor: tweak a qty,
    // add a step, or delete a line to drop that step — saving replaces the chain.
    const [recipes, catalog] = await Promise.all([store.listRecipes(gid), store.listCatalog(gid)]);
    const nameOf = (id: string) => catalog.find((c) => c.id === id)?.name ?? id;
    const prefill = recipes
      .filter((r) => r.lineId === lineId)
      .map((r) => {
        const y = typeof r.output.yield === "number" ? `${r.output.yield}` : `${r.output.yield[0]}-${r.output.yield[1]}`;
        const ins = r.inputs.map((x) => `${x.qty} ${nameOf(x.itemId)}`).join(" + ");
        return `${r.step}${r.canFail ? " *" : ""} : ${ins} -> ${y} ${nameOf(r.output.itemId)}`;
      })
      .join("\n")
      .slice(0, 4000);
    return json({
      type: 9, // MODAL
      data: {
        custom_id: `recipe:build:${lineId}`,
        title: `Steps for ${line.name}`.slice(0, 45),
        components: [
          {
            type: 1,
            components: [
              {
                type: 4,
                custom_id: "steps",
                style: 2,
                label: "One per line — saving replaces the chain",
                required: true,
                value: prefill || undefined,
                placeholder: "dry : 5 poppy seed + 2 acetone -> 4 weak powder\nwash * : 2 solvent + 2 powder -> 12-15 cocaine",
              },
            ],
          },
        ],
      },
    });
  }

  if (sub === "remove") {
    const lineId = option<string>(i, "line")!;
    const line = (await store.listLines(gid)).find((l) => l.id === lineId);
    if (!line) return reply("⚠️ Pick a product line to remove.");
    const steps = (await store.listRecipes(gid)).filter((r) => r.lineId === lineId);
    for (const r of steps) await store.deleteRecipe(gid, lineId, r.step);
    await store.deleteLine(gid, lineId);
    return reply(
      embed({
        description: `🗑️ Removed product line **${line.name}** and its ${steps.length} step(s). Its catalog items remain — clear any you no longer need with \`/catalog remove\`.`,
        color: COLORS.gray,
      })
    );
  }

  // list
  const lines = await store.listLines(gid);
  if (!lines.length) return reply("No product lines yet. Add one with `/recipe line`.");
  const recipes = await store.listRecipes(gid);
  const fields = lines.map((l) => ({
    name: `${l.name} → ${l.finalItemId} ($${l.referencePrice})`,
    value:
      recipes
        .filter((r) => r.lineId === l.id)
        .map((r) => {
          const ins = r.inputs.map((inp) => `${inp.qty} ${inp.itemId}`).join(" + ");
          const y = typeof r.output.yield === "number" ? `${r.output.yield}` : `${r.output.yield[0]}-${r.output.yield[1]}`;
          return `• ${r.step}: ${ins} → ${y} ${r.output.itemId}`;
        })
        .join("\n") || "_no steps yet_",
  }));
  return reply(embed({ title: "🧪 Product lines", color: COLORS.gold, fields }));
}

async function handleModal(i: any) {
  const cid: string = i.data?.custom_id ?? "";
  if (!cid.startsWith("recipe:build:")) return json({ type: 6 });
  const gid = guildId(i);
  const config = await store.getConfig(gid);
  if (!isOfficer(i, config)) return reply("⛔ Officers only.");
  const lineId = cid.slice("recipe:build:".length);
  const line = (await store.listLines(gid)).find((l) => l.id === lineId);
  if (!line) return reply("⚠️ That product line is gone.");

  // Resolve referenced items against what already exists so a recipe that builds
  // on another (e.g. crack uses cocaine) links to the canonical item instead of
  // minting a near-duplicate. Match by id OR by the slug of the existing name.
  const [catalog, allRecipes] = await Promise.all([store.listCatalog(gid), store.listRecipes(gid)]);
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const nameIndex = new Map<string, string>();
  for (const c of catalog) {
    nameIndex.set(c.id, c.id);
    nameIndex.set(slug(c.name), c.id);
  }
  const resolveId = (rawName: string) => nameIndex.get(slug(rawName)) ?? slug(rawName);

  const text: string = i.data.components?.[0]?.components?.[0]?.value ?? "";
  interface ParsedStep {
    step: string;
    canFail: boolean;
    inputs: { itemId: string; name: string; qty: number }[];
    output: { itemId: string; name: string; yield: number | [number, number] };
  }
  const steps: ParsedStep[] = [];
  const errors: string[] = [];
  for (const raw of text.split("\n").map((s) => s.trim()).filter(Boolean)) {
    const m = raw.match(/^([^:]+):(.+?)->(.+)$/);
    if (!m) { errors.push(raw); continue; }
    const canFail = m[1].includes("*");
    const step = slug(m[1].replace(/\*/g, ""));
    const inputs = m[2].split("+").map((p) => p.trim()).filter(Boolean).map((p) => {
      const mm = p.match(/^(\d+(?:\.\d+)?)\s+(.+)$/);
      return mm ? { itemId: resolveId(mm[2]), name: mm[2].trim(), qty: Number(mm[1]) } : null;
    });
    const outM = m[3].trim().match(/^(\d+)(?:-(\d+))?\s+(.+)$/);
    if (!step || inputs.some((x) => !x) || !outM) { errors.push(raw); continue; }
    steps.push({
      step,
      canFail,
      inputs: inputs as { itemId: string; name: string; qty: number }[],
      output: { itemId: resolveId(outM[3]), name: outM[3].trim(), yield: outM[2] ? [Number(outM[1]), Number(outM[2])] : Number(outM[1]) },
    });
  }
  if (!steps.length) {
    return reply("⚠️ Couldn't parse any steps. Format: `step: 5 poppy seed + 2 acetone -> 4 weak powder`");
  }

  const outputs = new Set(steps.map((s) => s.output.itemId));
  const existing = new Set(catalog.map((c) => c.id));
  const newBase: string[] = [];
  const linked = new Set<string>(); // existing produced items this recipe builds on
  const ensureItem = async (id: string, name: string, kind: "base" | "intermediate" | "final") => {
    const ex = byId.get(id);
    if (ex) {
      // Reuse the existing item untouched; note when we're consuming another line's product.
      if (ex.kind !== "base" && ex.lineId !== lineId) linked.add(ex.name);
      return;
    }
    if (existing.has(id)) return;
    await store.putCatalogItem(
      gid,
      kind === "base"
        ? { id, name, kind, value: 0, source: "bought", lineId }
        : { id, name, kind, value: 0, lineId }
    );
    existing.add(id);
    if (kind === "base") newBase.push(name);
  };
  for (const s of steps) {
    for (const inp of s.inputs) await ensureItem(inp.itemId, inp.name, outputs.has(inp.itemId) ? "intermediate" : "base");
    await ensureItem(s.output.itemId, s.output.name, s.output.itemId === line.finalItemId ? "final" : "intermediate");
  }
  for (const s of steps) {
    await store.putRecipe(gid, {
      lineId,
      step: s.step,
      inputs: s.inputs.map((x) => ({ itemId: x.itemId, qty: x.qty })),
      output: { itemId: s.output.itemId, yield: s.output.yield },
      canFail: s.canFail,
    });
  }
  // Replace semantics: drop any prior step of this line that's no longer present.
  const keep = new Set(steps.map((s) => s.step));
  const removed: string[] = [];
  for (const r of allRecipes.filter((r) => r.lineId === lineId && !keep.has(r.step))) {
    await store.deleteRecipe(gid, lineId, r.step);
    removed.push(r.step);
  }
  return reply(
    embed({
      title: "🧪 Recipe saved",
      color: COLORS.green,
      description: [
        `**${line.name}** — ${steps.length} step(s) saved.`,
        linked.size ? `🔗 Builds on existing: ${[...linked].join(", ")}` : "",
        newBase.length ? `New base items to price (\`/catalog set\`): ${newBase.join(", ")}` : "",
        removed.length ? `🗑️ Removed step(s): ${removed.join(", ")}` : "",
        errors.length ? `⚠️ Skipped ${errors.length} unparseable line(s).` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    })
  );
}
