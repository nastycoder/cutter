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

export const ENGINE_READY = false;
