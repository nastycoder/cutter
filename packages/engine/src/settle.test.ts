import { test } from "node:test";
import assert from "node:assert/strict";
import { settle } from "./index";
import type { CatalogItem, RecipeStep, ProductLine, Config, LedgerEntry } from "@cutter/shared";

// ---- honey fixtures (mirror seedDefaults) ----
const catalog: CatalogItem[] = [
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
const recipes: RecipeStep[] = [
  { lineId: "honey", step: "refine", inputs: [{ itemId: "poppy", qty: 5 }, { itemId: "acetone", qty: 2 }], output: { itemId: "heroin_powder", yield: 4 } },
  { lineId: "honey", step: "cut", inputs: [{ itemId: "baking_soda", qty: 2 }, { itemId: "heroin_powder", qty: 2 }], output: { itemId: "cut_heroin", yield: 4 } },
  { lineId: "honey", step: "bottle", inputs: [{ itemId: "vial", qty: 4 }, { itemId: "cut_heroin", qty: 4 }], output: { itemId: "vial_heroin", yield: 4 }, canFail: true },
  { lineId: "honey", step: "dose", inputs: [{ itemId: "vial_heroin", qty: 1 }, { itemId: "syringe", qty: 1 }], output: { itemId: "honey", yield: 2 }, canFail: true },
];
const line: ProductLine = { id: "honey", name: "Honey", finalItemId: "honey", referencePrice: 125 };
const config: Config = {
  laborRate: 25,
  workSplitPct: 0.7,
  commissionPct: 0.08,
  rankMultipliers: { 1: 5, 2: 4, 3: 3, 4: 2, 5: 1 },
};

const dep = (actor: string, itemId: string, qty: number): LedgerEntry => ({ id: `${actor}-${itemId}`, type: "deposit", actor, ts: 0, deposit: { itemId, qty } });
const proc = (actor: string, step: string, made: number): LedgerEntry => ({ id: `${actor}-${step}`, type: "process", actor, ts: 0, process: { step, made } });
const sell = (by: string, qty: number, cash: number): LedgerEntry => ({ id: `sale-${by}`, type: "sale", actor: by, ts: 0, sale: { qty, cash, by } });

test("600-poppy / 5-hand golden batch ties to the dollar", () => {
  const entries: LedgerEntry[] = [
    dep("marco", "vial", 960), dep("marco", "syringe", 900),
    dep("rico", "baking_soda", 480), dep("rico", "cleaning_kit", 110),
    dep("vinny", "poppy", 600), dep("vinny", "acetone", 240),
    proc("tony", "refine", 480), proc("tony", "cut", 960), proc("tony", "bottle", 900),
    proc("lou", "dose", 1700),
    sell("rico", 1700, 220000),
  ];
  const memberLevels = { marco: 1, rico: 3, vinny: 3, tony: 4, lou: 3 };

  const r = settle({ config, catalog, recipes, line, entries, memberLevels });
  const net = Object.fromEntries(r.perMember.map((p) => [p.userId, Math.round(p.net)]));

  assert.equal(net.marco, 114972);
  assert.equal(net.rico, 55679);
  assert.equal(net.vinny, 25976);
  assert.equal(net.tony, 12518);
  assert.equal(net.lou, 10855);
  assert.equal(Math.round(r.perMember.reduce((s, p) => s + p.net, 0)), 220000);
  assert.ok(r.tiesOut, "settlement must tie to revenue");
  assert.equal(r.loss, false);
});
