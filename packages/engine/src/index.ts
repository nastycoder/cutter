import type {
  Config,
  CatalogItem,
  RecipeStep,
  ProductLine,
  RankMap,
  LedgerEntry,
  SettlementResult,
} from "@cutter/shared";

export interface SettleInput {
  config: Config;
  catalog: CatalogItem[];
  recipes: RecipeStep[];
  line: ProductLine;
  ranks: RankMap;
  entries: LedgerEntry[];
}

/**
 * Pure settlement engine — the waterfall from DESIGN.md §5.
 * TODO (Phase 3): implement reimburse → labor → revenue → commission →
 * distributable → work/rank split → net, with the $220K golden test.
 */
export function settle(_input: SettleInput): SettlementResult {
  throw new Error("settle() not yet implemented — Phase 3");
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

export const ENGINE_READY = false;
