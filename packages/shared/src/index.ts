// Shared domain types — the contract between the engine and the bot.

export type ItemKind = "base" | "intermediate" | "final";
export type ItemSource = "farmed" | "bought";

export interface CatalogItem {
  id: string;
  name: string;
  kind: ItemKind;
  value: number; // cost-basis (farm-labor or black-market price); 0 for derived intermediates
  source?: ItemSource;
  lineId?: string; // omitted = shared (e.g. cleaning kit)
}

/** A fixed yield is a number; a variable yield is a [min,max] range. */
export type Yield = number | [number, number];

export interface RecipeStep {
  lineId: string;
  step: string; // e.g. "refine"
  inputs: { itemId: string; qty: number }[];
  output: { itemId: string; yield: Yield };
  canFail?: boolean; // informational only
}

export interface ProductLine {
  id: string;
  name: string;
  finalItemId: string;
  referencePrice: number; // projection + personal-use withdrawal valuation
}

export interface Config {
  laborRate: number; // $ per unit produced
  workSplitPct: number; // 0..1 — rank gets (1 - workSplitPct)
  commissionPct: number; // 0..1 of cash a seller moves
  rankMultipliers: Record<number, number>; // level (1..5) -> weight
  officerRoleId?: string;
  operationsCategoryId?: string; // Discord category for active job channels
  archiveCategoryId?: string; // Discord category for closed/settled job channels
  guideChannelId?: string; // read-only guide channel created on /setup
}

/** Discord roleId -> level (1..5). Unmapped members settle at level 5. */
export type RankMap = Record<string, number>;

export type EntryType = "deposit" | "process" | "withdraw" | "sale" | "void";

export interface LedgerEntry {
  id: string; // ULID
  type: EntryType;
  actor: string; // discord user id
  ts: number;
  // discriminated payload
  deposit?: { itemId?: string; qty?: number; cash?: number };
  process?: { step: string; made: number };
  withdraw?: { itemId?: string; qty?: number; cash?: number };
  sale?: { qty: number; cash: number; by: string };
  voids?: string; // id of the entry this reverses
}

export interface Job {
  id: string;
  name: string;
  lineId: string;
  status: "open" | "settling" | "closed";
  channelId: string;
}

export interface MemberPayout {
  userId: string;
  level: number;
  reimbursed: number;
  commission: number;
  work: number;
  rank: number;
  withdrawals: number;
  net: number;
}

export interface SettlementResult {
  perMember: MemberPayout[];
  revenue: number;
  reimbursed: number;
  commission: number;
  distributable: number;
  workPool: number;
  rankPool: number;
  loss: boolean;
  tiesOut: boolean;
}
