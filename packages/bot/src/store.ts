// Domain repository — typed read/write of guild config, lines, catalog, recipes,
// ranks, the treasury ledger, and payout archives.
import type {
  Config,
  ChannelKind,
  ProductLine,
  CatalogItem,
  RecipeStep,
  LedgerEntry,
  MemberPayout,
} from "@cutter/shared";
import * as db from "./db";

export const DEFAULT_CONFIG: Config = {
  laborRate: 25,
  commissionPct: 0.08,
  targetMargin: 0.4,
  rankMultipliers: { 1: 5, 2: 4, 3: 3, 4: 2, 5: 1 },
};

export async function getConfig(gid: string): Promise<Config> {
  const raw = await db.getItem<Record<string, any>>(db.gpk(gid), "CONFIG");
  if (!raw) return { ...DEFAULT_CONFIG };
  return {
    laborRate: raw.laborRate ?? DEFAULT_CONFIG.laborRate,
    commissionPct: raw.commissionPct ?? DEFAULT_CONFIG.commissionPct,
    targetMargin: raw.targetMargin ?? DEFAULT_CONFIG.targetMargin,
    rankMultipliers: raw.rankMultipliers ?? DEFAULT_CONFIG.rankMultipliers,
    officerRoleId: raw.officerRoleId,
    operationsCategoryId: raw.operationsCategoryId,
    guideChannelId: raw.guideChannelId,
    guidePosted: raw.guidePosted,
    houseChannels: raw.houseChannels,
    cycleNumber: raw.cycleNumber,
    cycleStartedAt: raw.cycleStartedAt,
  };
}

export async function putConfig(gid: string, c: Config): Promise<void> {
  await db.putItem({ PK: db.gpk(gid), SK: "CONFIG", ...c });
}

export async function listLines(gid: string): Promise<ProductLine[]> {
  return db.queryPrefix<ProductLine>(db.gpk(gid), "LINE#");
}
export async function putLine(gid: string, line: ProductLine): Promise<void> {
  await db.putItem({ PK: db.gpk(gid), SK: `LINE#${line.id}`, ...line });
}
export async function deleteLine(gid: string, lineId: string): Promise<void> {
  await db.deleteItem(db.gpk(gid), `LINE#${lineId}`);
}

export async function listCatalog(gid: string): Promise<CatalogItem[]> {
  return db.queryPrefix<CatalogItem>(db.gpk(gid), "ITEM#");
}
export async function putCatalogItem(gid: string, item: CatalogItem): Promise<void> {
  await db.putItem({ PK: db.gpk(gid), SK: `ITEM#${item.id}`, ...item });
}
export async function getCatalogItem(gid: string, id: string): Promise<CatalogItem | undefined> {
  return db.getItem<CatalogItem>(db.gpk(gid), `ITEM#${id}`);
}
export async function deleteCatalogItem(gid: string, id: string): Promise<void> {
  await db.deleteItem(db.gpk(gid), `ITEM#${id}`);
}

export async function putRecipe(gid: string, r: RecipeStep): Promise<void> {
  await db.putItem({ PK: db.gpk(gid), SK: `RECIPE#${r.lineId}#${r.step}`, ...r });
}
export async function listRecipes(gid: string): Promise<RecipeStep[]> {
  return db.queryPrefix<RecipeStep>(db.gpk(gid), "RECIPE#");
}
export async function deleteRecipe(gid: string, lineId: string, step: string): Promise<void> {
  await db.deleteItem(db.gpk(gid), `RECIPE#${lineId}#${step}`);
}

export async function putRank(gid: string, roleId: string, level: number): Promise<void> {
  await db.putItem({ PK: db.gpk(gid), SK: `RANK#${roleId}`, roleId, level });
}
export async function listRanks(gid: string): Promise<{ roleId: string; level: number }[]> {
  return db.queryPrefix<{ roleId: string; level: number }>(db.gpk(gid), "RANK#");
}
export async function deleteRank(gid: string, roleId: string): Promise<void> {
  await db.deleteItem(db.gpk(gid), `RANK#${roleId}`);
}

// ---- house channels ----

export async function putChannelHouse(gid: string, channelId: string, house: ChannelKind): Promise<void> {
  await db.putItem({ PK: db.gpk(gid), SK: `CHANNEL#${channelId}`, house });
}

export async function getChannelHouse(gid: string, channelId: string): Promise<ChannelKind | undefined> {
  const p = await db.getItem<{ house?: ChannelKind }>(db.gpk(gid), `CHANNEL#${channelId}`);
  return p?.house;
}

// ---- treasury ledger (cycle-prefixed, one partition per guild) ----

const lpk = (gid: string) => `LEDGER#${gid}`;
const cyc = (n: number) => `C${String(n).padStart(4, "0")}`;
/** Snowflakes are decimal strings of varying length — zero-pad so SKs sort chronologically. */
const entrySk = (cycle: number, id: string) => `${cyc(cycle)}#${id.padStart(20, "0")}`;

export async function appendEntry(gid: string, entry: LedgerEntry): Promise<void> {
  await db.putItem({ PK: lpk(gid), SK: entrySk(entry.cycle, entry.id), ...entry });
}

/** Entries of one cycle, in chronological order (contribution accrual). */
export async function listCycleEntries(gid: string, cycle: number): Promise<LedgerEntry[]> {
  return db.queryPrefix<LedgerEntry>(lpk(gid), `${cyc(cycle)}#`);
}

/** Every entry ever — inventory is a replay of the full ledger. */
export async function listAllEntries(gid: string): Promise<LedgerEntry[]> {
  return db.queryPrefix<LedgerEntry>(lpk(gid), "C");
}

// ---- payout archive ----

export interface PayoutRecord {
  cycle: number;
  ts: number;
  cash: number;
  fund: number;
  loss: boolean;
  perMember: MemberPayout[];
  carryover: Record<string, number>; // unreimbursed capital → next cycle's opening claims
}

export async function putPayoutRecord(gid: string, rec: PayoutRecord): Promise<void> {
  await db.putItem({ PK: `PAYOUT#${gid}`, SK: cyc(rec.cycle), ...rec });
}

export async function getPayoutRecord(gid: string, cycle: number): Promise<PayoutRecord | undefined> {
  return db.getItem<PayoutRecord>(`PAYOUT#${gid}`, cyc(cycle));
}

/** Seed the honey + coke product lines (the chains we've fully specced) + default dials. */
export async function seedDefaults(gid: string): Promise<void> {
  const lines: ProductLine[] = [
    { id: "honey", name: "Honey", finalItemId: "honey", referencePrice: 125 },
    { id: "coke", name: "Coke", finalItemId: "bag_of_coke", referencePrice: 135 },
  ];
  for (const l of lines) await putLine(gid, l);

  // Replace the seeded chains cleanly: drop any previously-seeded steps and the
  // catalog ids this seed has retired, so a re-run of /setup never leaves a
  // stale "refine" step or "Heroin powder" item behind.
  const seededLineIds = new Set(lines.map((l) => l.id));
  const oldSteps = (await listRecipes(gid)).filter((r) => seededLineIds.has(r.lineId));
  for (const r of oldSteps) await deleteRecipe(gid, r.lineId, r.step);
  for (const legacy of ["poppy", "heroin_powder"]) await deleteCatalogItem(gid, legacy);

  const items: CatalogItem[] = [
    // honey
    { id: "poppy_seed", name: "Poppy seed", kind: "base", value: 20, source: "farmed", lineId: "honey" },
    { id: "acetone", name: "Acetone", kind: "base", value: 30, source: "farmed", lineId: "honey" },
    { id: "baking_soda", name: "Baking soda", kind: "base", value: 5, source: "bought", lineId: "honey" },
    { id: "vial", name: "Vial", kind: "base", value: 15, source: "bought", lineId: "honey" },
    { id: "syringe", name: "Syringe", kind: "base", value: 15, source: "bought", lineId: "honey" },
    { id: "cleaning_kit", name: "Cleaning kit", kind: "base", value: 50, source: "bought" },
    { id: "weak_heroin_powder", name: "Weak heroin powder", kind: "intermediate", value: 0, lineId: "honey" },
    { id: "cut_heroin", name: "Cut heroin", kind: "intermediate", value: 0, lineId: "honey" },
    { id: "vial_heroin", name: "Vial heroin", kind: "intermediate", value: 0, lineId: "honey" },
    { id: "honey", name: "Honey", kind: "final", value: 0, lineId: "honey" },
    // coke (cut also consumes honey's baking soda + acetone cross-line)
    { id: "coca_leaves", name: "Coca leaves", kind: "base", value: 20, source: "farmed", lineId: "coke" },
    { id: "illegal_gas", name: "Illegal Gas", kind: "base", value: 50, source: "farmed", lineId: "coke" },
    { id: "weed_baggie", name: "Weed baggie", kind: "base", value: 20, source: "bought", lineId: "coke" },
    { id: "raw_cocaine", name: "Raw cocaine", kind: "intermediate", value: 0, lineId: "coke" },
    { id: "loose_cocaine", name: "Loose cocaine", kind: "intermediate", value: 0, lineId: "coke" },
    { id: "bag_of_coke", name: "Bag of coke", kind: "final", value: 0, lineId: "coke" },
  ];
  for (const it of items) await putCatalogItem(gid, it);

  const recipes: RecipeStep[] = [
    { lineId: "honey", step: "dry", inputs: [{ itemId: "poppy_seed", qty: 5 }, { itemId: "acetone", qty: 2 }], output: { itemId: "weak_heroin_powder", yield: 4 } },
    { lineId: "honey", step: "cut", inputs: [{ itemId: "weak_heroin_powder", qty: 2 }, { itemId: "baking_soda", qty: 2 }], output: { itemId: "cut_heroin", yield: 4 } },
    { lineId: "honey", step: "bottle", inputs: [{ itemId: "cut_heroin", qty: 4 }, { itemId: "vial", qty: 1 }], output: { itemId: "vial_heroin", yield: 4 }, canFail: true },
    { lineId: "honey", step: "dose", inputs: [{ itemId: "vial_heroin", qty: 1 }, { itemId: "syringe", qty: 1 }], output: { itemId: "honey", yield: 2 }, canFail: true },
    { lineId: "coke", step: "powder", inputs: [{ itemId: "coca_leaves", qty: 3 }, { itemId: "illegal_gas", qty: 1 }], output: { itemId: "raw_cocaine", yield: 3 } },
    { lineId: "coke", step: "cut", inputs: [{ itemId: "raw_cocaine", qty: 1 }, { itemId: "baking_soda", qty: 2 }, { itemId: "acetone", qty: 1 }], output: { itemId: "loose_cocaine", yield: 3 } },
    { lineId: "coke", step: "bag", inputs: [{ itemId: "loose_cocaine", qty: 3 }, { itemId: "weed_baggie", qty: 1 }], output: { itemId: "bag_of_coke", yield: 12 } },
  ];
  for (const r of recipes) await putRecipe(gid, r);
}
