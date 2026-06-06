// Domain repository — typed read/write of guild config, lines, catalog, recipes, ranks.
import type {
  Config,
  ProductLine,
  CatalogItem,
  RecipeStep,
} from "@cutter/shared";
import * as db from "./db";

export const DEFAULT_CONFIG: Config = {
  laborRate: 25,
  workSplitPct: 0.7,
  commissionPct: 0.08,
  rankMultipliers: { 1: 5, 2: 4, 3: 3, 4: 2, 5: 1 },
};

export async function getConfig(gid: string): Promise<Config> {
  const raw = await db.getItem<Record<string, any>>(db.gpk(gid), "CONFIG");
  if (!raw) return { ...DEFAULT_CONFIG };
  return {
    laborRate: raw.laborRate ?? DEFAULT_CONFIG.laborRate,
    workSplitPct: raw.workSplitPct ?? DEFAULT_CONFIG.workSplitPct,
    commissionPct: raw.commissionPct ?? DEFAULT_CONFIG.commissionPct,
    rankMultipliers: raw.rankMultipliers ?? DEFAULT_CONFIG.rankMultipliers,
    officerRoleId: raw.officerRoleId,
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

export async function putRank(gid: string, roleId: string, level: number): Promise<void> {
  await db.putItem({ PK: db.gpk(gid), SK: `RANK#${roleId}`, roleId, level });
}
export async function listRanks(gid: string): Promise<{ roleId: string; level: number }[]> {
  return db.queryPrefix<{ roleId: string; level: number }>(db.gpk(gid), "RANK#");
}
export async function deleteRank(gid: string, roleId: string): Promise<void> {
  await db.deleteItem(db.gpk(gid), `RANK#${roleId}`);
}

/** Seed the honey product line (the chain we've fully specced) + default dials. */
export async function seedDefaults(gid: string): Promise<void> {
  await putLine(gid, {
    id: "honey",
    name: "Honey",
    finalItemId: "honey",
    referencePrice: 125,
  });

  const items: CatalogItem[] = [
    { id: "poppy", name: "Poppy", kind: "base", value: 20, source: "farmed", lineId: "honey" },
    { id: "acetone", name: "Acetone", kind: "base", value: 30, source: "farmed", lineId: "honey" },
    { id: "baking_soda", name: "Baking soda", kind: "base", value: 50, source: "bought", lineId: "honey" },
    { id: "vial", name: "Vial", kind: "base", value: 50, source: "bought", lineId: "honey" },
    { id: "syringe", name: "Syringe", kind: "base", value: 50, source: "bought", lineId: "honey" },
    { id: "cleaning_kit", name: "Cleaning kit", kind: "base", value: 50, source: "bought" },
    { id: "heroin_powder", name: "Heroin powder", kind: "intermediate", value: 0, lineId: "honey" },
    { id: "cut_heroin", name: "Cut heroin", kind: "intermediate", value: 0, lineId: "honey" },
    { id: "vial_heroin", name: "Vial heroin", kind: "intermediate", value: 0, lineId: "honey" },
    { id: "honey", name: "Honey", kind: "final", value: 0, lineId: "honey" },
  ];
  for (const it of items) await putCatalogItem(gid, it);

  const recipes: RecipeStep[] = [
    { lineId: "honey", step: "refine", inputs: [{ itemId: "poppy", qty: 5 }, { itemId: "acetone", qty: 2 }], output: { itemId: "heroin_powder", yield: 4 } },
    { lineId: "honey", step: "cut", inputs: [{ itemId: "baking_soda", qty: 2 }, { itemId: "heroin_powder", qty: 2 }], output: { itemId: "cut_heroin", yield: 4 } },
    { lineId: "honey", step: "bottle", inputs: [{ itemId: "vial", qty: 4 }, { itemId: "cut_heroin", qty: 4 }], output: { itemId: "vial_heroin", yield: 4 }, canFail: true },
    { lineId: "honey", step: "dose", inputs: [{ itemId: "vial_heroin", qty: 1 }, { itemId: "syringe", qty: 1 }], output: { itemId: "honey", yield: 2 }, canFail: true },
  ];
  for (const r of recipes) await putRecipe(gid, r);
}
