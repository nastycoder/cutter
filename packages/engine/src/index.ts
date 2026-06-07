import type {
  Config,
  CatalogItem,
  RecipeStep,
  ProductLine,
  LedgerEntry,
  MemberPayout,
  SettlementResult,
} from "@cutter/shared";

export interface SettleInput {
  config: Config;
  catalog: CatalogItem[];
  recipes: RecipeStep[];
  line: ProductLine; // the job's product line (revenue + its final)
  /** All guild lines, so a chain built on another line (e.g. crack ← loose cocaine)
   *  values that line's intermediates/farmed inputs correctly. Defaults to [line]. */
  lines?: ProductLine[];
  entries: LedgerEntry[];
  /** userId -> rank level (1..5). Missing members default to level 5. */
  memberLevels: Record<string, number>;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** Drop void markers and the entries they reverse, so corrections vanish from all math. */
export function liveEntries(entries: LedgerEntry[]): LedgerEntry[] {
  const voided = new Set<string>();
  for (const e of entries) if (e.type === "void" && e.voids) voided.add(e.voids);
  return entries.filter((e) => e.type !== "void" && !voided.has(e.id));
}

/**
 * Pure settlement engine — the waterfall from DESIGN.md §5:
 * reimburse capital → labor → revenue → commission → distributable →
 * work/rank split → net. Money ties to revenue − withdrawals to the cent.
 */
export function settle(input: SettleInput): SettlementResult {
  const { config, catalog, recipes, line, entries, memberLevels } = input;
  const values = itemValues(catalog, recipes, input.lines ?? [line], config.targetMargin ?? 0);
  const levelOf = (u: string) => memberLevels[u] ?? 5;
  const weightOf = (u: string) => config.rankMultipliers[levelOf(u)] ?? 1;

  interface Acc {
    reimbursed: number;
    commission: number;
    work: number;
    rank: number;
    withdrawals: number;
    material: number;
    labor: number;
  }
  const M = new Map<string, Acc>();
  const get = (u: string): Acc => {
    let a = M.get(u);
    if (!a) {
      a = { reimbursed: 0, commission: 0, work: 0, rank: 0, withdrawals: 0, material: 0, labor: 0 };
      M.set(u, a);
    }
    return a;
  };

  let revenue = 0;
  for (const e of liveEntries(entries)) {
    if (e.type === "deposit" && e.deposit) {
      const v = e.deposit.cash ?? (values[e.deposit.itemId!] ?? 0) * (e.deposit.qty ?? 0);
      const a = get(e.actor);
      a.reimbursed += v;
      a.material += v;
    } else if (e.type === "process" && e.process) {
      get(e.actor).labor += (e.process.made ?? 0) * config.laborRate;
    } else if (e.type === "withdraw" && e.withdraw) {
      const v = e.withdraw.cash ?? (values[e.withdraw.itemId!] ?? 0) * (e.withdraw.qty ?? 0);
      get(e.actor).withdrawals += v;
    } else if (e.type === "sale" && e.sale) {
      revenue += e.sale.cash;
      get(e.sale.by).commission += config.commissionPct * e.sale.cash;
    }
  }

  const sum = (f: (a: Acc) => number) => [...M.values()].reduce((s, a) => s + f(a), 0);
  const totalReimburse = sum((a) => a.reimbursed);
  const totalCommission = sum((a) => a.commission);
  let distributable = revenue - totalReimburse - totalCommission;
  const loss = distributable < 0;

  if (loss) {
    // No commission; pay reimbursements pro-rata from the available revenue.
    const ratio = totalReimburse > 0 ? Math.max(0, revenue) / totalReimburse : 0;
    for (const a of M.values()) {
      a.commission = 0;
      a.reimbursed = a.reimbursed * ratio;
    }
    distributable = 0;
  }

  const workPool = distributable * config.workSplitPct;
  const rankPool = distributable - workPool;
  const totalContribution = sum((a) => a.material + a.labor);
  const totalWeight = [...M.keys()].reduce((s, u) => s + weightOf(u), 0);

  for (const [u, a] of M) {
    const contribution = a.material + a.labor;
    a.work = totalContribution > 0 ? workPool * (contribution / totalContribution) : 0;
    a.rank = totalWeight > 0 ? rankPool * (weightOf(u) / totalWeight) : 0;
  }

  const perMember: MemberPayout[] = [...M.entries()].map(([userId, a]) => ({
    userId,
    level: levelOf(userId),
    reimbursed: a.reimbursed,
    commission: a.commission,
    work: a.work,
    rank: a.rank,
    withdrawals: a.withdrawals,
    net: a.reimbursed + a.commission + a.work + a.rank - a.withdrawals,
  }));

  // round nets to the cent; push the rounding remainder onto the largest net
  const target = round2(revenue - sum((a) => a.withdrawals));
  let rounded = 0;
  for (const p of perMember) {
    p.net = round2(p.net);
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
    revenue,
    reimbursed: round2(sum((a) => a.reimbursed)),
    commission: round2(sum((a) => a.commission)),
    distributable,
    workPool,
    rankPool,
    loss,
    tiesOut,
  };
}

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

/**
 * Replay the ledger into current on-hand quantities per item: deposits add,
 * a process consumes its recipe inputs (made ÷ yield crafts) and adds its output,
 * withdrawals and sales remove. Best-effort for variable yields (range midpoint).
 */
export function inventory(
  entries: LedgerEntry[],
  recipes: RecipeStep[],
  finalItemId?: string
): Record<string, number> {
  const byStep = new Map(recipes.map((r) => [r.step, r]));
  const inv: Record<string, number> = {};
  const add = (id: string, q: number) => {
    inv[id] = (inv[id] ?? 0) + q;
  };
  for (const e of liveEntries(entries)) {
    if (e.type === "deposit" && e.deposit?.itemId) add(e.deposit.itemId, e.deposit.qty ?? 0);
    else if (e.type === "withdraw" && e.withdraw?.itemId) add(e.withdraw.itemId, -(e.withdraw.qty ?? 0));
    else if (e.type === "process" && e.process) {
      const r = byStep.get(e.process.step);
      if (r) {
        const y =
          typeof r.output.yield === "number"
            ? r.output.yield
            : (r.output.yield[0] + r.output.yield[1]) / 2;
        const crafts = y > 0 ? (e.process.made ?? 0) / y : 0;
        for (const inp of r.inputs) add(inp.itemId, -crafts * inp.qty);
        add(r.output.itemId, e.process.made ?? 0);
      }
    } else if (e.type === "sale" && finalItemId && e.sale) {
      add(finalItemId, -(e.sale.qty ?? 0));
    }
  }
  for (const k of Object.keys(inv)) if (Math.abs(inv[k]) < 1e-6) delete inv[k];
  return inv;
}

export const ENGINE_READY = false;
