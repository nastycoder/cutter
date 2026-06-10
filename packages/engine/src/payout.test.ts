import { test } from "node:test";
import assert from "node:assert/strict";
import {
  payout,
  accrueTabs,
  advanceable,
  buildCosts,
  itemValues,
  farmValue,
  treasuryInventory,
  liveEntries,
} from "./index";
import type { CatalogItem, RecipeStep, ProductLine, Config, LedgerEntry, EntryType } from "@cutter/shared";

// ---- honey fixtures (mirror seedDefaults) ----
const catalog: CatalogItem[] = [
  { id: "poppy_seed", name: "Poppy seed", kind: "base", value: 20, source: "farmed", lineId: "honey" },
  { id: "acetone", name: "Acetone", kind: "base", value: 30, source: "farmed", lineId: "honey" },
  { id: "baking_soda", name: "Baking soda", kind: "base", value: 50, source: "bought", lineId: "honey" },
  { id: "vial", name: "Vial", kind: "base", value: 50, source: "bought", lineId: "honey" },
  { id: "syringe", name: "Syringe", kind: "base", value: 50, source: "bought", lineId: "honey" },
  { id: "cleaning_kit", name: "Cleaning kit", kind: "base", value: 50, source: "bought" },
  { id: "weak_heroin_powder", name: "Weak heroin powder", kind: "intermediate", value: 0, lineId: "honey" },
  { id: "cut_heroin", name: "Cut heroin", kind: "intermediate", value: 0, lineId: "honey" },
  { id: "vial_heroin", name: "Vial heroin", kind: "intermediate", value: 0, lineId: "honey" },
  { id: "honey", name: "Honey", kind: "final", value: 0, lineId: "honey" },
];
const recipes: RecipeStep[] = [
  { lineId: "honey", step: "dry", inputs: [{ itemId: "poppy_seed", qty: 5 }, { itemId: "acetone", qty: 2 }], output: { itemId: "weak_heroin_powder", yield: 4 } },
  { lineId: "honey", step: "cut", inputs: [{ itemId: "baking_soda", qty: 2 }, { itemId: "weak_heroin_powder", qty: 2 }], output: { itemId: "cut_heroin", yield: 4 } },
  { lineId: "honey", step: "bottle", inputs: [{ itemId: "cut_heroin", qty: 4 }, { itemId: "vial", qty: 1 }], output: { itemId: "vial_heroin", yield: 4 }, canFail: true },
  { lineId: "honey", step: "dose", inputs: [{ itemId: "vial_heroin", qty: 1 }, { itemId: "syringe", qty: 1 }], output: { itemId: "honey", yield: 2 }, canFail: true },
];
const line: ProductLine = { id: "honey", name: "Honey", finalItemId: "honey", referencePrice: 125 };
const lines = [line];
// margin 0 → static catalog prices, matching the DESIGN-v2 worked example
const config: Config = {
  laborRate: 25,
  commissionPct: 0.08,
  targetMargin: 0,
  rankMultipliers: { 1: 5, 2: 4, 3: 3, 4: 2, 5: 1 },
};

let seq = 0;
const E = (type: EntryType, actor: string, payload: Partial<LedgerEntry>): LedgerEntry =>
  ({ id: String(++seq), type, actor, ts: seq, cycle: 1, ...payload } as LedgerEntry);

const dep = (credit: string, itemId: string, qty: number, house: "raw" | "product" = "raw") =>
  E("deposit", credit, { deposit: { itemId, qty, house, credit } });
const depBy = (actor: string, credit: string, itemId: string, qty: number) =>
  E("deposit", actor, { deposit: { itemId, qty, house: "raw", credit } });
const buy = (actor: string, itemId: string, qty: number, house: "raw" | "product" = "raw") =>
  E("buy", actor, { buy: { itemId, qty, house } });
const fundCash = (actor: string, cash: number) => E("fund", actor, { fund: { cash } });
const proc = (credit: string, step: string, made: number) =>
  E("process", credit, { process: { lineId: "honey", step, made, credit } });
const sell = (by: string, itemId: string, qty: number, cash: number) =>
  E("sale", by, { sale: { itemId, qty, cash, by } });
const adv = (userId: string, amount: number) => E("advance", "officer", { advance: { userId, amount } });
const wdCash = (actor: string, cash: number) => E("withdraw", actor, { withdraw: { cash, house: "money" } });
const wdItem = (actor: string, itemId: string, qty: number, house: "raw" | "product" = "raw") =>
  E("withdraw", actor, { withdraw: { itemId, qty, house } });
const spend = (amount: number, reason = "ops") => E("spend", "officer", { spend: { amount, reason } });
const loss = (p: NonNullable<LedgerEntry["loss"]>) => E("loss", "anyone", { loss: p });
const checkout = (actor: string, itemId: string, qty: number) => E("checkout", actor, { checkout: { itemId, qty } });
const ret = (actor: string, itemId: string, qty: number) => E("return", actor, { return: { itemId, qty } });
const voidOf = (id: string) => E("void", "officer", { voids: id });

const cashOf = (entries: LedgerEntry[]) => treasuryInventory(entries, recipes, catalog).cash;
const run = (entries: LedgerEntry[], memberLevels: Record<string, number>, openingClaims?: Record<string, number>) =>
  payout({ config, catalog, recipes, lines, entries, memberLevels, openingClaims, cash: cashOf(entries) });
const sumNet = (r: { perMember: { net: number }[] }) => r.perMember.reduce((s, p) => s + p.net, 0);
const netOf = (r: { perMember: { userId: string; net: number }[] }) =>
  Object.fromEntries(r.perMember.map((p) => [p.userId, Math.round(p.net * 100) / 100]));

// ---- valuation (unchanged from v1) ----

test("buildCosts derives the honey cost-of-goods ladder", () => {
  const c = buildCosts(catalog, recipes);
  assert.equal(c.poppy_seed, 20);
  assert.equal(c.vial, 50);
  assert.equal(c.weak_heroin_powder, 40);
  assert.equal(c.cut_heroin, 45);
  assert.equal(c.vial_heroin, 57.5); // (4 × 45 + 1 × 50) / 4
  assert.equal(c.honey, 53.75);
});

test("itemValues = build cost, final overridden to reference price", () => {
  const v = itemValues(catalog, recipes, lines);
  assert.equal(v.poppy_seed, 20);
  assert.equal(v.cut_heroin, 45);
  assert.equal(v.honey, 125);
});

test("farmValue back-solves a farmed $/unit so the final hits the margin target", () => {
  const f = farmValue(catalog, recipes, line, 0.4);
  assert.ok(Math.abs(f - 31.25 / 0.4375) < 1e-6); // ≈ $71.43
  const cat = catalog.map((c) => (c.source === "farmed" ? { ...c, value: f } : c));
  assert.ok(Math.abs(buildCosts(cat, recipes).honey - 75) < 1e-6);
});

test("itemValues(margin) auto-prices farmed inputs; bought + final untouched", () => {
  const v = itemValues(catalog, recipes, lines, 0.4);
  const f = 31.25 / 0.4375;
  assert.ok(Math.abs(v.poppy_seed - f) < 1e-6);
  assert.ok(Math.abs(v.acetone - f) < 1e-6); // single shared farmed value
  assert.equal(v.vial, 50);
  assert.equal(v.honey, 125);
});

test("higher margin → cheaper farmed inputs, clamped at 0", () => {
  assert.ok(farmValue(catalog, recipes, line, 0.3) > farmValue(catalog, recipes, line, 0.4));
  assert.equal(farmValue(catalog, recipes, line, 0.7), 0); // target $37.50 < the $43.75 bought-only cost → nothing left
});

test("liveEntries drops voided originals and void markers", () => {
  const e1 = dep("a", "poppy_seed", 100);
  const e2 = dep("b", "poppy_seed", 50);
  const live = liveEntries([e1, voidOf(e1.id), e2]);
  assert.equal(live.length, 1);
  assert.equal(live[0].id, e2.id);
});

// ---- payout: the Contribution Treasury ----

test("golden: the DESIGN-v2 §4 worked cycle ties to the cent", () => {
  const entries = [
    buy("marco", "vial", 200), // capital 200 × $50 = 10,000
    depBy("carrier", "vinny", "poppy_seed", 600), // farm 600 × $20 = 12,000 — credit follows the doer
    proc("tony", "dry", 480), // labor 480 × $25 = 12,000
    sell("rico", "honey", 1700, 80000), // commission 8% = 6,400
    adv("vinny", 5000),
  ];
  const r = run(entries, { marco: 1, vinny: 3, tony: 4, rico: 3 });
  assert.equal(r.loss, false);
  assert.equal(r.cash, 75000); // 80,000 sales − 5,000 advanced
  assert.equal(r.fund, 39600); // 80,000 − 40,400 earned
  assert.deepEqual(netOf(r), {
    marco: 25230.77, // 10,000 + 5/13 of the fund
    vinny: 16138.46, // 12,000 + 3/13 − 5,000 advance
    tony: 18092.31, // 12,000 + 2/13
    rico: 15538.46, // 6,400 + 3/13
  });
  assert.ok(r.tiesOut);
  assert.equal(Math.round(sumNet(r)), 75000);
});

test("accrueTabs: advanceable = earned − advances − withdrawals", () => {
  const tabs = accrueTabs({
    config, catalog, recipes, lines,
    entries: [depBy("x", "vinny", "poppy_seed", 600), adv("vinny", 5000)],
  });
  const t = tabs.get("vinny")!;
  assert.equal(t.farm, 12000);
  assert.equal(t.advances, 5000);
  assert.equal(advanceable(t), 7000);
});

test("a cash withdrawal is payout-neutral (works like a self-advance)", () => {
  const base = [dep("a", "poppy_seed", 100), sell("a", "honey", 80, 10000)];
  const plain = run(base, { a: 3 });
  const withWd = run([...base, wdCash("a", 2000)], { a: 3 });
  assert.equal(Math.round(plain.perMember[0].net), 10000);
  assert.equal(Math.round(withWd.perMember[0].net), 8000); // got 2,000 early
  assert.ok(withWd.tiesOut);
});

test("an item withdrawal feeds the fund — the member buys it from the crew", () => {
  // carol funds, alice farms, bob takes 100 poppy_seed ($2,000) for himself
  const entries = [
    fundCash("carol", 10000),
    dep("alice", "poppy_seed", 100),
    sell("carol", "honey", 40, 5000),
    wdItem("bob", "poppy_seed", 100),
  ];
  const r = run(entries, { carol: 5, alice: 5, bob: 5 });
  assert.equal(r.loss, false);
  // cash 15,000 − owed (carol 10,400 + alice 2,000) = 2,600 fund — bob's 2,000 in it
  assert.equal(r.fund, 2600);
  assert.deepEqual(netOf(r), { carol: 11700, alice: 3300, bob: 0 });
  assert.equal(r.perMember.find((p) => p.userId === "bob")!.forgiven, 2000);
  assert.ok(r.tiesOut);
});

test("a loss charged to a member debits their tab; the crew fund is spared", () => {
  const base = [dep("a", "poppy_seed", 100), dep("b", "poppy_seed", 100), sell("a", "honey", 80, 10000)];
  const plain = run(base, { a: 3, b: 3 });
  const charged = run(
    [...base, loss({ itemId: "poppy_seed", qty: 50, house: "raw", cause: "busted", charge: "b" })],
    { a: 3, b: 3 }
  );
  // b eats the $1,000 (50 × $20); it lands in the fund, so a's cut grows
  assert.equal(charged.fund, plain.fund + 1000);
  assert.equal(Math.round(charged.perMember.find((p) => p.userId === "b")!.net),
    Math.round(plain.perMember.find((p) => p.userId === "b")!.net) - 500); // −1,000 + half the fund bump
  assert.ok(charged.tiesOut);
});

test("a crew-shared cash loss shrinks the fund, not anyone's work pay", () => {
  const base = [dep("a", "poppy_seed", 100), sell("a", "honey", 80, 10000)];
  const plain = run(base, { a: 3 });
  const robbed = run([...base, loss({ cash: 3000, cause: "robbed" })], { a: 3 });
  assert.equal(robbed.fund, plain.fund - 3000);
  assert.equal(robbed.perMember[0].farm, 2000); // work pay untouched
  assert.ok(robbed.tiesOut);
});

test("/spend shrinks the fund", () => {
  const base = [dep("a", "poppy_seed", 100), sell("a", "honey", 80, 10000)];
  const r = run([...base, spend(1500)], { a: 3 });
  assert.equal(r.fund, run(base, { a: 3 }).fund - 1500);
});

test("loss guard: capital reimbursed pro-rata first, shortfall carries over", () => {
  // marco + rico fronted 15,000 cash; a robbery leaves only 6,000
  const entries = [fundCash("marco", 10000), fundCash("rico", 5000), loss({ cash: 9000, cause: "robbed" })];
  const r = run(entries, { marco: 1, rico: 3 });
  assert.equal(r.loss, true);
  assert.equal(r.fund, 0);
  assert.deepEqual(netOf(r), { marco: 4000, rico: 2000 }); // 6,000 × 10/15, × 5/15
  assert.deepEqual(r.carryover, { marco: 6000, rico: 3000 });
  assert.ok(r.tiesOut);
});

test("loss guard: capital is senior to work pay", () => {
  // 10,000 cash on hand; marco fronted 10,000, tony is owed 10,000 labor
  const entries = [fundCash("marco", 10000), proc("tony", "dry", 400)];
  const r = run(entries, { marco: 1, tony: 4 });
  assert.equal(r.loss, true);
  assert.deepEqual(netOf(r), { marco: 10000, tony: 0 }); // capital home first
  assert.deepEqual(r.carryover, {}); // capital fully reimbursed; unpaid labor doesn't carry
});

test("opening claims are reimbursed in the next cycle before the fund splits", () => {
  const entries = [sell("rico", "honey", 80, 10000)];
  const r = run(entries, { marco: 1, rico: 3 }, { marco: 6000 });
  assert.equal(r.loss, false);
  const marco = r.perMember.find((p) => p.userId === "marco")!;
  assert.equal(marco.capital, 6000);
  // fund = 10,000 − (6,000 + 800) = 3,200, split 5/3
  assert.deepEqual(netOf(r), { marco: 8000, rico: 2000 });
  assert.ok(r.tiesOut);
});

test("only contributors share the fund; idle rank-holders get nothing", () => {
  const entries = [dep("a", "poppy_seed", 100), sell("a", "honey", 80, 10000), adv("idle", 0)];
  const r = run(entries, { a: 5, idle: 1 });
  const idle = r.perMember.find((p) => p.userId === "idle");
  assert.equal(idle?.rankShare ?? 0, 0);
  assert.equal(idle?.net ?? 0, 0);
});

test("voided entries vanish from the payout", () => {
  const big = buy("a", "vial", 100); // would be 5,000 capital
  const entries = [big, voidOf(big.id), dep("a", "poppy_seed", 10), sell("a", "honey", 10, 1000)];
  const r = run(entries, { a: 3 });
  assert.equal(r.perMember[0].capital, 0);
  assert.equal(Math.round(sumNet(r)), 1000);
  assert.ok(r.tiesOut);
});

test("unmapped member settles at level 5", () => {
  const r = run([dep("a", "poppy_seed", 100), dep("b", "poppy_seed", 100), sell("a", "honey", 80, 10000)], { a: 1 });
  assert.equal(r.perMember.find((p) => p.userId === "b")!.level, 5);
  assert.ok(r.tiesOut);
});

// ---- inventory replay (house-aware) ----

test("process consumes base inputs from raw and produced inputs from product", () => {
  const inv = treasuryInventory(
    [dep("a", "vial_heroin", 50, "product"), dep("a", "syringe", 60, "raw"), proc("a", "dose", 100)],
    recipes,
    catalog
  );
  assert.equal(inv.raw.syringe, 10);
  assert.equal(inv.product.vial_heroin ?? 0, 0);
  assert.equal(inv.product.honey, 100);
});

test("buys land in their house; transfers move stock; cash flows through money", () => {
  const entries = [
    buy("a", "poppy_seed", 100, "raw"),
    E("transfer", "a", { transfer: { itemId: "poppy_seed", qty: 40, from: "raw", to: "product" } }),
    fundCash("b", 5000),
    adv("c", 1000),
    spend(500),
  ];
  const inv = treasuryInventory(entries, recipes, catalog);
  assert.equal(inv.raw.poppy_seed, 60);
  assert.equal(inv.product.poppy_seed, 40);
  assert.equal(inv.cash, 3500);
});

test("checkout → sale (holding first) → return squares a selling run", () => {
  const entries = [
    buy("x", "honey", 200, "product"),
    checkout("rico", "honey", 150),
    sell("rico", "honey", 100, 100000), // draws rico's holding
    ret("rico", "honey", 50),
  ];
  const inv = treasuryInventory(entries, recipes, catalog);
  assert.equal(inv.holdings.rico, undefined); // 150 out = 100 sold + 50 back
  assert.equal(inv.product.honey, 100); // 200 − 150 + 50
  assert.equal(inv.cash, 100000);
});

test("a sale beyond the holding draws the rest from the product house", () => {
  const entries = [buy("x", "honey", 200, "product"), checkout("rico", "honey", 50), sell("rico", "honey", 80, 8000)];
  const inv = treasuryInventory(entries, recipes, catalog);
  assert.equal(inv.holdings.rico, undefined); // all 50 went
  assert.equal(inv.product.honey, 120); // 150 − 30 house-drawn
});

test("a loss can hit a member's holding", () => {
  const entries = [
    buy("x", "honey", 100, "product"),
    checkout("rico", "honey", 60),
    loss({ itemId: "honey", qty: 60, holder: "rico", cause: "robbed" }),
  ];
  const inv = treasuryInventory(entries, recipes, catalog);
  assert.equal(inv.holdings.rico, undefined);
  assert.equal(inv.product.honey, 40);
});

test("reconcile pins an absolute count at its point in the replay", () => {
  const entries = [
    dep("a", "poppy_seed", 500),
    E("reconcile", "officer", { reconcile: { itemId: "poppy_seed", count: 480, house: "raw" } }),
    dep("a", "poppy_seed", 20),
  ];
  const inv = treasuryInventory(entries, recipes, catalog);
  assert.equal(inv.raw.poppy_seed, 500); // 480 pinned + 20 after
});

test("a payout entry drains the money house; goods and holdings persist", () => {
  const entries = [
    fundCash("a", 5000),
    buy("x", "honey", 100, "product"),
    checkout("rico", "honey", 20),
    E("payout", "officer", { payout: { total: 5000 } }),
  ];
  const inv = treasuryInventory(entries, recipes, catalog);
  assert.equal(inv.cash, 0);
  assert.equal(inv.product.honey, 80);
  assert.equal(inv.holdings.rico.honey, 20);
});

test("inventory uses the midpoint for a variable yield", () => {
  const vc: CatalogItem[] = [
    { id: "x", name: "X", kind: "base", value: 10 },
    { id: "y", name: "Y", kind: "final", value: 0, lineId: "L" },
  ];
  const vr: RecipeStep[] = [{ lineId: "L", step: "s", inputs: [{ itemId: "x", qty: 2 }], output: { itemId: "y", yield: [12, 15] } }];
  const inv = treasuryInventory(
    [
      E("deposit", "a", { deposit: { itemId: "x", qty: 27, house: "raw", credit: "a" } }),
      E("process", "a", { process: { lineId: "L", step: "s", made: 27, credit: "a" } }),
    ],
    vr,
    vc
  );
  assert.equal(inv.raw.x, 23); // 27 − 2 × (27 / 13.5)
  assert.equal(inv.product.y, 27);
});
