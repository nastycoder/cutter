import type {
  Config,
  House,
  CatalogItem,
  RecipeStep,
  ProductLine,
  LedgerEntry,
  MemberTab,
  MemberPayout,
  PayoutResult,
  TreasuryInventory,
} from "@cutter/shared";

const round2 = (x: number) => Math.round(x * 100) / 100;

/** Drop void markers and the entries they reverse, so corrections vanish from all math. */
export function liveEntries(entries: LedgerEntry[]): LedgerEntry[] {
  const voided = new Set<string>();
  for (const e of entries) if (e.type === "void" && e.voids) voided.add(e.voids);
  return entries.filter((e) => e.type !== "void" && !voided.has(e.id));
}

// ---- contribution accrual (current cycle) ----

export interface AccrueInput {
  config: Config;
  catalog: CatalogItem[];
  recipes: RecipeStep[];
  lines: ProductLine[];
  entries: LedgerEntry[]; // current cycle only
  /** Unreimbursed capital carried from the previous (loss) cycle — added to capital. */
  openingClaims?: Record<string, number>;
}

/**
 * Replay the cycle's entries into per-member tabs: capital (buys at catalog +
 * cash fronted), farm pay, labor, commission — minus advances taken and
 * personal withdrawals (incl. losses charged to the member). Credit follows
 * the doer (`credit:`/`by:`), never the carrier.
 */
export function accrueTabs(input: AccrueInput): Map<string, MemberTab> {
  const { config, catalog, recipes, lines, openingClaims } = input;
  const values = itemValues(catalog, recipes, lines, config.targetMargin ?? 0);

  const M = new Map<string, MemberTab>();
  const get = (u: string): MemberTab => {
    let t = M.get(u);
    if (!t) {
      t = { userId: u, capital: 0, farm: 0, labor: 0, commission: 0, earned: 0, advances: 0, withdrawals: 0 };
      M.set(u, t);
    }
    return t;
  };
  for (const [u, claim] of Object.entries(openingClaims ?? {})) {
    if (claim > 0) get(u).capital += claim;
  }

  for (const e of liveEntries(input.entries)) {
    if (e.type === "deposit" && e.deposit) {
      get(e.deposit.credit).farm += (values[e.deposit.itemId] ?? 0) * e.deposit.qty;
    } else if (e.type === "buy" && e.buy) {
      get(e.actor).capital += (values[e.buy.itemId] ?? 0) * e.buy.qty;
    } else if (e.type === "fund" && e.fund) {
      get(e.actor).capital += e.fund.cash;
    } else if (e.type === "process" && e.process) {
      get(e.process.credit).labor += e.process.made * config.laborRate;
    } else if (e.type === "sale" && e.sale) {
      get(e.sale.by).commission += config.commissionPct * e.sale.cash;
    } else if (e.type === "withdraw" && e.withdraw) {
      const v = e.withdraw.cash ?? (values[e.withdraw.itemId!] ?? 0) * (e.withdraw.qty ?? 0);
      get(e.actor).withdrawals += v;
    } else if (e.type === "advance" && e.advance) {
      get(e.advance.userId).advances += e.advance.amount;
    } else if (e.type === "loss" && e.loss?.charge) {
      const v = e.loss.cash ?? (values[e.loss.itemId!] ?? 0) * (e.loss.qty ?? 0);
      get(e.loss.charge).withdrawals += v;
    }
    // transfer / checkout / return / reconcile / spend / uncharged loss: no tab effect —
    // a crew-shared loss simply never becomes cash, so it shrinks the fund on its own.
  }

  for (const t of M.values()) t.earned = t.capital + t.farm + t.labor + t.commission;
  return M;
}

/** What a member could be advanced right now (earned − already advanced − withdrawals). */
export function advanceable(tab: MemberTab): number {
  return Math.max(0, tab.earned - tab.advances - tab.withdrawals);
}

// ---- payout (cycle settlement) ----

export interface PayoutInput extends AccrueInput {
  /** Money-house balance at payout time (full-ledger replay) — what gets handed out. */
  cash: number;
  /** userId -> rank level (1..5). Missing members default to level 5. */
  memberLevels: Record<string, number>;
}

/**
 * Settle the cycle: pay every tab at its value, then split the surplus (the
 * fund) by rank weight among this cycle's contributors. Loss guard: if cash
 * can't cover what's owed, reimburse capital pro-rata first, then work, pay
 * no fund — nobody goes negative, and unreimbursed capital carries over.
 * Σ(net) ties to cash to the cent.
 */
export function payout(input: PayoutInput): PayoutResult {
  const { config, memberLevels } = input;
  const cash = Math.max(0, input.cash);
  const levelOf = (u: string) => memberLevels[u] ?? 5;
  const weightOf = (u: string) => config.rankMultipliers[levelOf(u)] ?? 1;

  const tabs = accrueTabs(input);
  const perMember: MemberPayout[] = [...tabs.values()].map((t) => ({
    ...t,
    level: levelOf(t.userId),
    rankShare: 0,
    net: 0,
    forgiven: 0,
    unpaidCapital: 0,
  }));

  // What each member is still owed for work/capital (may be negative = they owe).
  const owedOf = (p: MemberPayout) => p.earned - p.advances - p.withdrawals;
  const totalOwed = perMember.reduce((s, p) => s + Math.max(0, owedOf(p)), 0);
  const loss = cash < totalOwed;
  const carryover: Record<string, number> = {};
  let fund = 0;

  if (loss) {
    // Waterfall the available cash: capital claims first (pro-rata), then
    // farm/labor/commission pro-rata. No fund. Shortfalled capital carries over.
    const capClaim = (p: MemberPayout) => Math.min(p.capital, Math.max(0, owedOf(p)));
    const totalCap = perMember.reduce((s, p) => s + capClaim(p), 0);
    const capRatio = totalCap > 0 ? Math.min(1, cash / totalCap) : 0;
    const afterCap = Math.max(0, cash - totalCap);
    const workClaim = (p: MemberPayout) => Math.max(0, owedOf(p)) - capClaim(p);
    const totalWork = perMember.reduce((s, p) => s + workClaim(p), 0);
    const workRatio = totalWork > 0 ? Math.min(1, afterCap / totalWork) : 0;
    for (const p of perMember) {
      const capPaid = capClaim(p) * capRatio;
      p.net = capPaid + workClaim(p) * workRatio;
      p.forgiven = Math.max(0, -owedOf(p));
      p.unpaidCapital = round2(capClaim(p) - capPaid);
      if (p.unpaidCapital >= 0.01) carryover[p.userId] = p.unpaidCapital;
      else p.unpaidCapital = 0;
    }
  } else {
    // Fund = surplus cash; split purely by rank weight among contributors.
    // Anyone whose net would go negative is floored at 0 (debt forgiven) and
    // dropped from the split, so Σ(net) = cash holds at every round.
    const active = new Set(perMember.map((p) => p.userId));
    const byId = new Map(perMember.map((p) => [p.userId, p]));
    for (;;) {
      const act = [...active].map((u) => byId.get(u)!);
      fund = cash - act.reduce((s, p) => s + owedOf(p), 0);
      const contributors = act.filter((p) => p.earned > 0);
      const totalWeight = contributors.reduce((s, p) => s + weightOf(p.userId), 0);
      for (const p of act) {
        p.rankShare = p.earned > 0 && totalWeight > 0 ? fund * (weightOf(p.userId) / totalWeight) : 0;
        p.net = owedOf(p) + p.rankShare;
      }
      const broke = act.filter((p) => p.net < -1e-9);
      if (!broke.length) break;
      for (const p of broke) {
        p.forgiven = -p.net;
        p.net = 0;
        p.rankShare = 0;
        active.delete(p.userId);
      }
    }
  }

  // Round nets to the cent; push the rounding remainder onto the largest net.
  const target = round2(cash);
  let rounded = 0;
  for (const p of perMember) {
    p.net = round2(p.net);
    p.rankShare = round2(p.rankShare);
    rounded += p.net;
  }
  if (perMember.length) {
    const diff = round2(target - rounded);
    if (Math.abs(diff) >= 0.01) {
      let top = perMember[0];
      for (const p of perMember) if (p.net > top.net) top = p;
      top.net = round2(top.net + diff);
    }
  }
  const tiesOut = Math.abs(perMember.reduce((s, p) => s + p.net, 0) - target) < 0.011;

  return {
    perMember,
    cash: target,
    owed: round2(totalOwed),
    fund: round2(fund),
    loss,
    tiesOut,
    carryover,
  };
}

// ---- valuation (unchanged from v1) ----

/**
 * Per-unit build cost (cost of supplies) for every catalog item, derived from
 * recipes: base items use their catalog value; produced items sum their inputs
 * recursively and divide by yield (variable yields use the range midpoint).
 */
export function buildCosts(
  catalog: CatalogItem[],
  recipes: RecipeStep[]
): Record<string, number> {
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const recipeByOutput = new Map<string, RecipeStep>();
  for (const r of recipes) recipeByOutput.set(r.output.itemId, r);
  const memo: Record<string, number> = {};
  const visiting = new Set<string>();

  const cost = (itemId: string): number => {
    if (memo[itemId] !== undefined) return memo[itemId];
    const recipe = recipeByOutput.get(itemId);
    if (!recipe || visiting.has(itemId)) {
      const v = byId.get(itemId)?.value ?? 0; // base/unknown, or cycle guard
      memo[itemId] = v;
      return v;
    }
    visiting.add(itemId);
    const y =
      typeof recipe.output.yield === "number"
        ? recipe.output.yield
        : (recipe.output.yield[0] + recipe.output.yield[1]) / 2;
    let inputs = 0;
    for (const inp of recipe.inputs) inputs += cost(inp.itemId) * inp.qty;
    visiting.delete(itemId);
    const per = y > 0 ? inputs / y : 0;
    memo[itemId] = per;
    return per;
  };

  const out: Record<string, number> = {};
  for (const c of catalog) out[c.id] = cost(c.id);
  return out;
}

/**
 * Back-solve the per-unit value of a line's *farmed* inputs from its reference
 * price: pick a single $/unit `f` (shared by all farmed inputs of the line) so
 * that building one final unit costs `referencePrice × (1 − margin)`. Because the
 * final's build cost is linear in `f`, we sample it at f=0 and f=1 to recover the
 * slope, then solve. Result is clamped ≥ 0 (a margin that bought costs already
 * blow through leaves farmed inputs worth nothing rather than going negative).
 */
export function farmValue(
  catalog: CatalogItem[],
  recipes: RecipeStep[],
  line: ProductLine,
  margin: number
): number {
  const farmedIds = new Set(
    catalog.filter((c) => c.source === "farmed" && c.lineId === line.id).map((c) => c.id)
  );
  if (!farmedIds.size) return 0;
  const at = (f: number) =>
    buildCosts(
      catalog.map((c) => (farmedIds.has(c.id) ? { ...c, value: f } : c)),
      recipes
    )[line.finalItemId] ?? 0;
  const b0 = at(0);
  const slope = at(1) - b0; // build-cost increase per $1 of farmed value
  if (slope <= 0) return 0;
  const target = line.referencePrice * (1 - margin);
  return Math.max(0, (target - b0) / slope);
}

/** Map of every farmed base item → its auto-derived per-unit value (per its line). */
export function farmValues(
  catalog: CatalogItem[],
  recipes: RecipeStep[],
  lines: ProductLine[],
  margin: number
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!(margin > 0)) return out; // margin 0 → keep static catalog values
  for (const l of lines) {
    const f = farmValue(catalog, recipes, l, margin);
    for (const c of catalog) if (c.source === "farmed" && c.lineId === l.id) out[c.id] = f;
  }
  return out;
}

/**
 * Effective per-unit value of every item for deposits/withdrawals:
 * base bought = catalog value, base farmed = back-solved from the reference price
 * (when margin > 0), intermediate = build cost, final = the line's reference price.
 */
export function itemValues(
  catalog: CatalogItem[],
  recipes: RecipeStep[],
  lines: ProductLine[],
  margin = 0
): Record<string, number> {
  const fv = farmValues(catalog, recipes, lines, margin);
  const cat = Object.keys(fv).length
    ? catalog.map((c) => (fv[c.id] !== undefined ? { ...c, value: fv[c.id] } : c))
    : catalog;
  const v = buildCosts(cat, recipes);
  for (const l of lines) v[l.finalItemId] = l.referencePrice;
  return v;
}

// ---- inventory replay (house-aware) ----

/**
 * Replay the FULL ledger into per-house stock, money-house cash, and per-member
 * holdings. Each entry carries its house effects explicitly: deposits/buys add,
 * a process consumes its recipe inputs (made ÷ yield crafts; base from raw,
 * produced from product) and adds its output to product, transfers move,
 * sales draw the seller's holding first then the product house, checkout/return
 * move between the product house and a holding, reconcile pins an absolute
 * count, and a payout drains the money house.
 */
export function treasuryInventory(
  entries: LedgerEntry[],
  recipes: RecipeStep[],
  catalog: CatalogItem[]
): TreasuryInventory {
  const kindOf = new Map(catalog.map((c) => [c.id, c.kind]));
  const recipeOf = new Map(recipes.map((r) => [`${r.lineId}#${r.step}`, r]));
  const inv: TreasuryInventory = { raw: {}, product: {}, cash: 0, holdings: {} };
  const house = (h: "raw" | "product") => inv[h];
  const add = (h: "raw" | "product", id: string, q: number) => {
    house(h)[id] = (house(h)[id] ?? 0) + q;
  };
  const holding = (u: string) => (inv.holdings[u] ??= {});
  const addHold = (u: string, id: string, q: number) => {
    holding(u)[id] = (holding(u)[id] ?? 0) + q;
  };
  const goodsHouse = (h: House, id: string, q: number) => {
    if (h === "raw" || h === "product") add(h, id, q);
  };

  for (const e of liveEntries(entries)) {
    if (e.type === "deposit" && e.deposit) {
      goodsHouse(e.deposit.house, e.deposit.itemId, e.deposit.qty);
    } else if (e.type === "buy" && e.buy) {
      goodsHouse(e.buy.house, e.buy.itemId, e.buy.qty);
    } else if (e.type === "fund" && e.fund) {
      inv.cash += e.fund.cash;
    } else if (e.type === "process" && e.process) {
      const r = recipeOf.get(`${e.process.lineId}#${e.process.step}`);
      if (r) {
        const y =
          typeof r.output.yield === "number"
            ? r.output.yield
            : (r.output.yield[0] + r.output.yield[1]) / 2;
        const crafts = y > 0 ? e.process.made / y : 0;
        for (const inp of r.inputs) {
          add(kindOf.get(inp.itemId) === "base" ? "raw" : "product", inp.itemId, -crafts * inp.qty);
        }
        add("product", r.output.itemId, e.process.made);
      }
    } else if (e.type === "transfer" && e.transfer) {
      goodsHouse(e.transfer.from, e.transfer.itemId, -e.transfer.qty);
      goodsHouse(e.transfer.to, e.transfer.itemId, e.transfer.qty);
    } else if (e.type === "sale" && e.sale) {
      const fromHolding = Math.min(holding(e.sale.by)[e.sale.itemId] ?? 0, e.sale.qty);
      if (fromHolding > 0) addHold(e.sale.by, e.sale.itemId, -fromHolding);
      if (e.sale.qty - fromHolding > 0) add("product", e.sale.itemId, -(e.sale.qty - fromHolding));
      inv.cash += e.sale.cash;
    } else if (e.type === "withdraw" && e.withdraw) {
      if (e.withdraw.cash != null) inv.cash -= e.withdraw.cash;
      else if (e.withdraw.itemId) goodsHouse(e.withdraw.house, e.withdraw.itemId, -(e.withdraw.qty ?? 0));
    } else if (e.type === "advance" && e.advance) {
      inv.cash -= e.advance.amount;
    } else if (e.type === "spend" && e.spend) {
      inv.cash -= e.spend.amount;
    } else if (e.type === "reconcile" && e.reconcile) {
      if (e.reconcile.house === "raw" || e.reconcile.house === "product") {
        house(e.reconcile.house)[e.reconcile.itemId] = e.reconcile.count;
      }
    } else if (e.type === "loss" && e.loss) {
      if (e.loss.cash != null) inv.cash -= e.loss.cash;
      else if (e.loss.itemId) {
        if (e.loss.holder) addHold(e.loss.holder, e.loss.itemId, -(e.loss.qty ?? 0));
        else goodsHouse(e.loss.house ?? "product", e.loss.itemId, -(e.loss.qty ?? 0));
      }
    } else if (e.type === "checkout" && e.checkout) {
      add("product", e.checkout.itemId, -e.checkout.qty);
      addHold(e.actor, e.checkout.itemId, e.checkout.qty);
    } else if (e.type === "return" && e.return) {
      addHold(e.actor, e.return.itemId, -e.return.qty);
      add("product", e.return.itemId, e.return.qty);
    } else if (e.type === "payout") {
      inv.cash = 0;
    }
  }

  const clean = (rec: Record<string, number>) => {
    for (const k of Object.keys(rec)) if (Math.abs(rec[k]) < 1e-6) delete rec[k];
  };
  clean(inv.raw);
  clean(inv.product);
  for (const u of Object.keys(inv.holdings)) {
    clean(inv.holdings[u]);
    if (!Object.keys(inv.holdings[u]).length) delete inv.holdings[u];
  }
  if (Math.abs(inv.cash) < 1e-6) inv.cash = 0;
  return inv;
}
