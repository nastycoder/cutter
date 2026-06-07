import { test } from "node:test";
import assert from "node:assert/strict";
import { settle, buildCosts, itemValues, inventory, liveEntries, farmValue } from "./index";
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
const depCash = (actor: string, cash: number): LedgerEntry => ({ id: `${actor}-cash`, type: "deposit", actor, ts: 0, deposit: { cash } });
const proc = (actor: string, step: string, made: number): LedgerEntry => ({ id: `${actor}-${step}`, type: "process", actor, ts: 0, process: { step, made } });
const sell = (by: string, qty: number, cash: number): LedgerEntry => ({ id: `sale-${by}-${cash}`, type: "sale", actor: by, ts: 0, sale: { qty, cash, by } });
const wdrCash = (actor: string, cash: number): LedgerEntry => ({ id: `wd-${actor}`, type: "withdraw", actor, ts: 0, withdraw: { cash } });
const voidOf = (id: string): LedgerEntry => ({ id: `void-${id}`, type: "void", actor: "x", ts: 0, voids: id });
const sumNet = (r: { perMember: { net: number }[] }) => r.perMember.reduce((s, p) => s + p.net, 0);

const run = (entries: LedgerEntry[], memberLevels: Record<string, number>) =>
  settle({ config, catalog, recipes, line, entries, memberLevels });

test("buildCosts derives the honey cost-of-goods ladder", () => {
  const c = buildCosts(catalog, recipes);
  assert.equal(c.poppy, 20);
  assert.equal(c.vial, 50);
  assert.equal(c.heroin_powder, 40);
  assert.equal(c.cut_heroin, 45);
  assert.equal(c.vial_heroin, 95);
  assert.equal(c.honey, 72.5);
});

test("itemValues = build cost, final overridden to reference price", () => {
  const v = itemValues(catalog, recipes, [line]);
  assert.equal(v.poppy, 20);
  assert.equal(v.cut_heroin, 45);
  assert.equal(v.honey, 125);
});

test("farmValue back-solves a farmed $/unit so the final hits the margin target", () => {
  const f = farmValue(catalog, recipes, line, 0.4);
  assert.ok(Math.abs(f - 12.5 / 0.4375) < 1e-6); // ≈ $28.57
  // building one honey at that farmed value lands on refPrice × (1 − margin) = $75
  const cat = catalog.map((c) => (c.source === "farmed" ? { ...c, value: f } : c));
  assert.ok(Math.abs(buildCosts(cat, recipes).honey - 75) < 1e-6);
});

test("itemValues(margin) auto-prices farmed inputs; bought + final untouched", () => {
  const v = itemValues(catalog, recipes, [line], 0.4);
  const f = 12.5 / 0.4375;
  assert.ok(Math.abs(v.poppy - f) < 1e-6);
  assert.ok(Math.abs(v.acetone - f) < 1e-6); // single shared farmed value
  assert.equal(v.vial, 50); // bought stays at its black-market price
  assert.equal(v.honey, 125); // final = reference price
});

test("higher margin → cheaper farmed inputs, clamped at 0", () => {
  assert.ok(farmValue(catalog, recipes, line, 0.3) > farmValue(catalog, recipes, line, 0.4));
  assert.equal(farmValue(catalog, recipes, line, 0.5), 0); // target 62.5 = bought-only cost → nothing left
});

test("cross-line build: crack values loose cocaine via the cocaine line's farmed back-solve", () => {
  const cat: CatalogItem[] = [
    { id: "coca_leaf", name: "Coca leaf", kind: "base", value: 0, source: "farmed", lineId: "cocaine" },
    { id: "chemicals", name: "Chemicals", kind: "base", value: 50, source: "bought", lineId: "cocaine" },
    { id: "loose_cocaine", name: "Loose cocaine", kind: "intermediate", value: 0, lineId: "cocaine" },
    { id: "cocaine_bag", name: "Cocaine bag", kind: "final", value: 0, lineId: "cocaine" },
    { id: "baking", name: "Baking", kind: "base", value: 20, source: "bought", lineId: "crack" },
    { id: "crack_rock", name: "Crack rock", kind: "final", value: 0, lineId: "crack" },
  ];
  const rec: RecipeStep[] = [
    { lineId: "cocaine", step: "extract", inputs: [{ itemId: "coca_leaf", qty: 10 }, { itemId: "chemicals", qty: 1 }], output: { itemId: "loose_cocaine", yield: 4 } },
    { lineId: "cocaine", step: "bag", inputs: [{ itemId: "loose_cocaine", qty: 4 }], output: { itemId: "cocaine_bag", yield: 1 } },
    { lineId: "crack", step: "cook", inputs: [{ itemId: "loose_cocaine", qty: 2 }, { itemId: "baking", qty: 1 }], output: { itemId: "crack_rock", yield: 5 } },
  ];
  const cocaineLine: ProductLine = { id: "cocaine", name: "Cocaine", finalItemId: "cocaine_bag", referencePrice: 1000 };
  const crackLine: ProductLine = { id: "crack", name: "Crack", finalItemId: "crack_rock", referencePrice: 300 };

  const all = itemValues(cat, rec, [crackLine, cocaineLine], 0.4);
  assert.ok(Math.abs(all.coca_leaf - 55) < 1e-6); // back-solved from cocaine's $1000 @ 40%
  assert.ok(Math.abs(all.loose_cocaine - 150) < 1e-6); // 2.5·55 + 12.5 — loose, not the bagged final
  assert.equal(all.cocaine_bag, 1000); // bagged coke = its own reference price
  assert.equal(all.crack_rock, 300);

  // Without the cocaine line in scope, loose cocaine collapses to bought-only cost (coca leaf = 0)
  const crackOnly = itemValues(cat, rec, [crackLine], 0.4);
  assert.ok(Math.abs(crackOnly.loose_cocaine - 12.5) < 1e-6);
});

test("buildCosts uses the midpoint for a variable yield", () => {
  const vc: CatalogItem[] = [
    { id: "x", name: "X", kind: "base", value: 10 },
    { id: "y", name: "Y", kind: "final", value: 0, lineId: "L" },
  ];
  const vr: RecipeStep[] = [{ lineId: "L", step: "s", inputs: [{ itemId: "x", qty: 2 }], output: { itemId: "y", yield: [12, 15] } }];
  const c = buildCosts(vc, vr);
  assert.ok(Math.abs(c.y - (10 * 2) / 13.5) < 1e-9); // 20 / midpoint(13.5)
});

test("inventory tracks leftover inputs and unsold final", () => {
  const inv = inventory([dep("a", "vial_heroin", 50), dep("a", "syringe", 60), proc("a", "dose", 100)], recipes, "honey");
  assert.equal(inv.syringe, 10);
  assert.equal(inv.vial_heroin ?? 0, 0);
  assert.equal(inv.honey, 100);
});

test("liveEntries drops voided originals and void markers", () => {
  const e1 = dep("a", "poppy", 100);
  const e2 = dep("b", "poppy", 50);
  const live = liveEntries([e1, voidOf(e1.id), e2]);
  assert.equal(live.length, 1);
  assert.equal(live[0].id, e2.id);
});

test("golden: 600-poppy / 5-hand batch ties to the dollar", () => {
  const entries = [
    dep("marco", "vial", 960), dep("marco", "syringe", 900),
    dep("rico", "baking_soda", 480), dep("rico", "cleaning_kit", 110),
    dep("vinny", "poppy", 600), dep("vinny", "acetone", 240),
    proc("tony", "refine", 480), proc("tony", "cut", 960), proc("tony", "bottle", 900),
    proc("lou", "dose", 1700),
    sell("rico", 1700, 220000),
  ];
  const r = run(entries, { marco: 1, rico: 3, vinny: 3, tony: 4, lou: 3 });
  const net = Object.fromEntries(r.perMember.map((p) => [p.userId, Math.round(p.net)]));
  assert.deepEqual(net, { marco: 114972, rico: 55679, vinny: 25976, tony: 12518, lou: 10855 });
  assert.equal(Math.round(sumNet(r)), 220000);
  assert.ok(r.tiesOut);
  assert.equal(r.loss, false);
});

test("withdrawals reduce net; total ties to revenue − withdrawals", () => {
  const r = run([dep("a", "poppy", 100), proc("a", "refine", 80), sell("a", 100, 10000), wdrCash("a", 2000)], { a: 3 });
  assert.equal(Math.round(r.perMember[0].net), 8000); // 10000 − 2000 withdrawn
  assert.ok(r.tiesOut);
});

test("commission pays the seller even with no other contribution", () => {
  const r = run([dep("a", "poppy", 10), sell("a", 50, 2500), sell("b", 50, 2500)], { a: 3, b: 3 });
  const net = Object.fromEntries(r.perMember.map((p) => [p.userId, Math.round(p.net)]));
  // a: reimburse 200 + commission 200 + all work 3080 + rank 660 = 4140
  // b: commission 200 + rank 660 = 860
  assert.equal(net.a, 4140);
  assert.equal(net.b, 860);
  assert.equal(Math.round(sumNet(r)), 5000);
});

test("loss branch: revenue below capital → no commission, pro-rata reimbursement", () => {
  const r = run([dep("a", "vial", 100), sell("a", 1, 100)], { a: 3 }); // $5,000 capital, $100 revenue
  assert.equal(r.loss, true);
  assert.equal(Math.round(r.perMember[0].net), 100);
  assert.equal(Math.round(sumNet(r)), 100);
});

test("voided deposit is excluded from settlement", () => {
  const big = dep("a", "vial", 100); // would be $5,000 capital
  const r = run([big, voidOf(big.id), dep("a", "poppy", 10), proc("a", "refine", 8), sell("a", 100, 1000)], { a: 3 });
  assert.equal(Math.round(r.perMember[0].net), 1000); // big deposit gone → ties to revenue
  assert.ok(r.tiesOut);
});

test("unmapped member settles at level 5", () => {
  const r = run([dep("a", "poppy", 100), dep("b", "poppy", 100), sell("a", 100, 10000)], { a: 1 });
  assert.equal(r.perMember.find((p) => p.userId === "b")!.level, 5);
  assert.ok(r.tiesOut);
});
