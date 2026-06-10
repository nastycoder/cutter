// Shared domain types — the contract between the engine and the bot.

export type ItemKind = "base" | "intermediate" | "final";
export type ItemSource = "farmed" | "bought";

/** Stash houses. Goods live in raw/product; cash lives in money. */
export type House = "raw" | "product" | "money";
/** A house channel, or the treasury channel (reports/payout — holds no stock). */
export type ChannelKind = House | "treasury";

export interface CatalogItem {
  id: string;
  name: string;
  kind: ItemKind;
  value: number; // bought = black-market price; farmed = auto-derived (ignored when targetMargin>0); 0 for intermediates
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
  commissionPct: number; // 0..1 of cash a seller moves
  targetMargin?: number; // 0..1 — farmed inputs back-solved so final build cost = refPrice × (1−margin); 0/undefined = static
  rankMultipliers: Record<number, number>; // level (1..5) -> weight
  officerRoleId?: string;
  operationsCategoryId?: string; // Discord category holding the house channels
  guideChannelId?: string; // read-only guide channel created on /setup
  guidePosted?: boolean; // guide content posted to the guide channel (post once)
  houseChannels?: Partial<Record<ChannelKind, string>>; // house -> channelId
  cycleNumber?: number; // current accounting cycle (1-based; set by /setup)
  cycleStartedAt?: number;
}

/** Discord roleId -> level (1..5). Unmapped members settle at level 5. */
export type RankMap = Record<string, number>;

export type EntryType =
  | "deposit"
  | "buy"
  | "fund"
  | "process"
  | "transfer"
  | "sale"
  | "withdraw"
  | "advance"
  | "spend"
  | "reconcile"
  | "loss"
  | "checkout"
  | "return"
  | "payout"
  | "void";

export type LossCause = "busted" | "robbed" | "spoiled" | "other";

export interface LedgerEntry {
  id: string; // interaction snowflake (doubles as an ordered key)
  type: EntryType;
  actor: string; // discord user id
  ts: number;
  cycle: number;
  // discriminated payloads — each entry records its house effects explicitly,
  // so replay never needs channel context
  deposit?: { itemId: string; qty: number; house: House; credit: string }; // farm pay → credit
  buy?: { itemId: string; qty: number; house: House }; // capital (catalog value × qty) → actor
  fund?: { cash: number }; // cash into the money house; capital → actor
  process?: { lineId: string; step: string; made: number; credit: string }; // labor pay → credit
  transfer?: { itemId: string; qty: number; from: House; to: House }; // logistics; no pay effect
  sale?: { itemId: string; qty: number; cash: number; by: string }; // draws by's holding first, then product house; commission → by
  withdraw?: { itemId?: string; qty?: number; cash?: number; house: House }; // personal use; value debited from actor's tab
  advance?: { userId: string; amount: number }; // cash handed out mid-cycle, reconciled at payout
  spend?: { amount: number; reason: string }; // crew expense — shrinks the fund
  reconcile?: { itemId: string; count: number; house: House }; // absolute correction at this point of the replay
  loss?: {
    itemId?: string;
    qty?: number;
    cash?: number;
    house?: House; // where the goods/cash were lost from…
    holder?: string; // …or whose holding they were lost from
    cause: LossCause;
    charge?: string; // officer: debit this member's tab instead of the crew fund
    note?: string;
  };
  checkout?: { itemId: string; qty: number }; // product house → actor's holding (no tab effect)
  return?: { itemId: string; qty: number }; // actor's holding → product house
  payout?: { total: number }; // cycle settled — drains the money house (cash handed out)
  voids?: string; // id of the entry this reverses
}

/** What a member has accrued within the current cycle. */
export interface MemberTab {
  userId: string;
  capital: number; // cash fronted + bought items at catalog value (incl. opening claims)
  farm: number; // farmed materials credited × item value
  labor: number; // units processed × labor rate
  commission: number; // commission% × sales made
  earned: number; // capital + farm + labor + commission
  advances: number; // cash already handed out this cycle
  withdrawals: number; // personal-use withdrawals + losses charged to the member
}

export interface MemberPayout extends MemberTab {
  level: number;
  rankShare: number; // slice of the fund (rank weight among contributors)
  net: number; // earned + rankShare − advances − withdrawals, floored at 0
  forgiven: number; // deficit wiped by the no-one-goes-negative floor
  unpaidCapital: number; // loss cycle: carries to the next cycle as an opening claim
}

export interface PayoutResult {
  perMember: MemberPayout[];
  cash: number; // money house at payout time (what gets handed out)
  owed: number; // Σ max(0, earned − advances − withdrawals)
  fund: number; // cash − owed (0 in a loss cycle)
  loss: boolean; // cash couldn't cover what's owed for work/capital
  tiesOut: boolean;
  carryover: Record<string, number>; // userId → unreimbursed capital
}

/** Per-house stock + per-member holdings, replayed from the full ledger. */
export interface TreasuryInventory {
  raw: Record<string, number>;
  product: Record<string, number>;
  cash: number; // money house
  holdings: Record<string, Record<string, number>>; // userId → itemId → qty out
}
