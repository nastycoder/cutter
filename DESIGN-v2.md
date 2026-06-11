# Cutter v2 — The Contribution Treasury

> Supersedes the job-centric model in `DESIGN.md`. v1's settlement engine, catalog,
> recipes, auto-pricing, and rank system are **reused**; what changes is the container
> (jobs → a standing treasury with cycles and per-house inventory) and the surplus split.

## 1. Why v2

The "job" was the wrong primitive. The crew runs a **continuous operation**, not bounded jobs:

- Operations run for **days**; there's no clean open/close to settle against.
- Members cycle **in and out** of the city; contributions land asynchronously.
- Materials and product get **handed off** constantly, so "who's in this job" stopped meaning "who earned a cut."
- Everything is **pooled** across what v1 forced into separate channels.

v2 replaces the job with a **standing treasury** mirrored as the crew's real **stash houses**, tracks **who did what continuously**, pays **work at its value**, and on an officer's `/payout` splits the **leftover profit by rank** and starts a fresh cycle.

## 2. Core concepts

- **Treasury** — one persistent ledger per guild. Never closes.
- **Stash houses (locations)** — the bot mirrors the real in-game stashes:
  - 🌿 **Raw** — farmed/bought base materials
  - 🧪 **Product** — intermediates + finished goods
  - 💰 **Money** — cash
  - (🔫 Guns — out of scope for now)
- **Cycle** — the accounting window between payouts. Contributions accrue within the current cycle; `/payout` distributes and starts the next cycle. **Inventory persists across cycles; contribution counters reset.**
- **Contribution** — any logged farm, buy, fund, process, or sale. *Credit follows the doer, not the carrier* (see `credit:`), so handoffs never move a cut.
- **The fund** — realized cash beyond what's owed to members for their work/capital. The crew's profit; split by rank at payout.

## 3. The payout model

### 3.1 What each member earns (their *tab*, accrued live within a cycle)

```
capital_m      = cash fronted + bought items at catalog value  → reimbursed
farm_m         = farmed materials credited to m × item value     → paid (auto-priced)
labor_m        = units m processed × labor rate                  → paid
commission_m   = commission% × m's sales                         → paid
advances_m     = cash already handed to m this cycle             → subtracted
earned_m       = capital_m + farm_m + labor_m + commission_m
```

Every kind of work has a value and is paid that value. Capital is reimbursed at cost.

### 3.2 The fund (surplus) and the rank split

```
cash           = money-house balance this cycle
fund           = cash − Σ(earned_m − advances_m)      # realized profit
contributors   = members with any contribution this cycle
rankShare_m    = fund × weight(m) / Σ weight(contributors)   # RANK ONLY
```

The fund is split **purely by current rank weight** (5/4/3/2/1) among everyone who
contributed this cycle. Contributing is the ticket in; rank sizes the slice. (Because
farm materials are auto-priced to leave the margin, and labor/commission are bounded,
the fund is normally positive — it *is* the margin, minus any `/spend`.)

### 3.3 `/payout` (officer) — settle the cycle

```
payout_m = earned_m + rankShare_m − advances_m       (paid in cash from the money house)
```

Then: archive a payout record, **reset the cycle** (contribution counters clear; inventory
carries over), increment the cycle number. After a full payout the money house nets to the
amounts physically handed out.

**Loss guard (reused from v1):** if cash can't cover capital, reimburse pro-rata, pay no
fund — nobody goes negative. Any unreimbursed capital carries forward as an opening claim
in the next cycle.

### 3.4 Advances (mid-cycle)

A member who needs cash before payout can be advanced against **what they've already
earned** (never against the not-yet-known rank share):

```
advanceable_m = (capital_m + farm_m + labor_m + commission_m) − advances_m
              , capped by money-house cash
```

`/advance @m amount:` hands over cash now (logged); it's reconciled at `/payout` via the
`− advances_m` term. This is the "I need some money" flow — full or partial, by availability.

### 3.5 Loss (busted / robbed / spoiled)

A loss removes value from the treasury and is recorded on the ledger (cause + note + reporter):

- **Goods** leave the house's inventory; **cash** leaves the money house.
- **Crew-shared (default):** lost goods never become revenue and lost cash is gone, so the loss
  comes out of the **fund** — everyone's rank-cut shrinks. The crew carries its own risk.
- **Charged to a member (officer):** `charge:@m` debits the loss value (at catalog) against that
  member's tab, so they personally eat it and the crew fund is spared.
- **No one goes negative:** if a loss is catastrophic (past all profit, into capital/work), the
  loss-branch pro-rates remaining cash.
- **Anyone may record** a loss in the moment; officers can **`/void`** a bogus one — and a
  recovered loss (busted product returned, goods got back) is simply a voided loss entry that
  restores the inventory/cash.

### 3.6 Checkout & return — product going out to sell

Product usually leaves a house in someone's hands before it's sold. That custody is tracked so a
selling run reconciles cleanly:

- **`/checkout product: qty:`** — pulls product from #product-house into your **holding** (you're
  now carrying it). It is **not** a withdrawal — it doesn't touch your tab; it's crew product in
  your custody.
- **`/sale product: qty: cash:`** — draws from the seller's holding first (then the house), books
  revenue + commission.
- **`/return product: qty:`** — puts unsold product back in the house from your holding.
- **`/holding [@member]`** — what product someone has out right now. Total product = house + all
  holdings, so nothing is double-counted.

A run reconciles when the holding returns to zero: **checked out = sold + returned**. So *"took
out 200, sold 150, put 50 back"* is `/checkout 200` → `/sale 150` → `/return 50`, holding back to
0. Anything still outstanding is product in the wind — return it, or log a `/loss` if it got
taken (a loss can hit a member's holding, not just a house).

## 4. Worked example (one cycle)

Labor rate $25/unit, commission 8%, ranks 5/4/3/2/1.

| Member | Rank | Did | capital | farm | labor | comm. |
|---|---|---|--:|--:|--:|--:|
| Marco | I (5×) | fronted 200 vials @ $50 | 10,000 | — | — | — |
| Vinny | III (3×) | farmed 600 poppy seed @ $20 | — | 12,000 | — | — |
| Tony | IV (2×) | processed 480 units | — | — | 12,000 | — |
| Rico | III (3×) | sold $80,000 | — | — | — | 6,400 |

- Mid-cycle, Vinny needs cash → `/advance @Vinny 5000` (≤ his $12,000 farm pay). Money house −$5,000.
- Sales this cycle: $80,000. Earned total = 10,000 + 12,000 + 12,000 + 6,400 = **$40,400**.
- `fund = 80,000 − 40,400 = $39,600`. Contributors' rank weights: 5+3+2+3 = 13.
  - Marco 5/13·39,600 = $15,231 · Vinny 3/13 = $9,138 · Tony 2/13 = $6,092 · Rico 3/13 = $9,138
- `/payout` hands out: Marco $25,231 · Vinny $21,138 − $5,000 advance = **$16,138** · Tony $18,092 · Rico $15,538. Cycle resets.

## 5. Data model (DynamoDB single table)

```
PK = GUILD#<gid>
  SK CONFIG                      laborRate, commissionPct, farmMargin, rankMultipliers,
                                 officerRoleId, opsCategoryId, archiveCategoryId,
                                 guideChannelId, houseChannels{raw,product,money,treasury},
                                 cycleNumber, cycleStartedAt
  SK LINE#<id> / ITEM#<id> / RECIPE#<lineId>#<step> / RANK#<roleId>     (unchanged from v1)
  SK CHANNEL#<channelId>         → { house: raw|product|money|treasury }

PK = LEDGER#<gid>
  SK C<cycle:0000>#<snowflakeId> → entry { type, actor, credit, ts, house, payload }
       types: deposit | buy | fund | process | transfer | sale | withdraw |
              advance | spend | reconcile | loss | checkout | return
  (inventory is a replay of ALL entries; contribution accrual replays the CURRENT cycle only)

PK = PAYOUT#<gid>
  SK <cycle:0000>               → archived record { perMember[], fund, revenue, ts }
```

- **Inventory** per house = replay of all ledger entries' house effects (deposits/buys add,
  process consumes raw + adds product, transfer moves, sale/withdraw remove, reconcile adjusts).
- **Current-cycle accrual** = replay entries with the current cycle prefix only.
- No GSI required (the jobs-by-status index retires).

## 6. Commands

Per-house channels; the **house is inferred from the channel** for location actions.
Cross-house actions name their destination. Reports/payout live in **#money-house / #treasury**.

| Channel | Command | Does |
|---|---|---|
| #raw / #product | `/deposit item: qty: [credit:@who]` | add farmed/owned material; **farm pay** to credit (default: you) |
| #raw / #product | `/buy item: qty:` | buy supplies or product; **capital** = catalog value × qty, owed to buyer |
| #money | `/fund-cash amount:` *(deposit cash)* | fund the treasury with cash; **capital** owed back |
| #raw→#product | `/process line: step: made: [credit:@who]` | consume raw → product; **labor pay** to credit |
| any | `/transfer item: qty: to:#house` | move stock between houses (logistics; no pay effect) |
| #product | `/checkout product: qty:` | take product into your **holding** to go sell (not a withdrawal; no tab effect) |
| #money | `/sale product: qty: cash: [by:@who]` | sell from holding then house → cash; **commission** to seller |
| #product | `/return product: qty:` | put unsold product back from your holding |
| #treasury | `/holding [@member]` | product a member has checked out (out = sold + returned + still out) |
| any house | `/reconcile item: count:` | officer logs real in-game count; bot records shrinkage vs expected |
| any | `/withdraw item:\|cash: qty:` | take out for personal use; valued, **deducted from your tab** |
| house / #money | `/loss item:\|cash: qty: cause: [charge:@m] [note:]` | record busted/robbed/spoiled; pulls from inventory/cash; crew-shared, or officer `charge:` to a member. Anyone records; officers `/void` |
| #treasury | `/owed [@member]` | live tab: earned this cycle, advances taken, advanceable now |
| #treasury | `/advance @member amount:` | officer hands a partial advance against earned (logged) |
| #treasury | `/payout` | settle the cycle: pay tabs + split fund by rank, archive, **reset** |
| #treasury | `/fund` | show current fund + money-house cash + cycle |
| #treasury | `/spend amount: reason:` | officer spends crew cash on ops (logged; shrinks the fund) |
| #treasury | `/stash [house]` | inventory of a house (expected counts) |
| #treasury | `/me` · `/ledger` · `/status` | personal standing · history · treasury overview |
| officer | `/setup officer:@role` | build houses, channels, guide+deck; init cycle 1 |
| officer | `/config` · `/rank` · `/catalog` · `/recipe` | unchanged from v1 (minus `workSplitPct`) |

Because the treasury holds **multiple product lines at once** (no per-job isolation), the line
can't be inferred from context the way v1's job did:
- **`/process` takes `line:`** — a step name like `dry` may exist in several recipes, so the
  line disambiguates which recipe to run. `step:` autocompletes to that line's steps.
- **`/sale` takes `product:`** — a house stores finished goods from every line, so the sale
  names which product moved. `product:` autocompletes to the lines' final items.
- **`/buy` takes no `cost:`** — everything bought is valued at its catalog price (capital =
  price × qty), including finished product bought in bulk to flip. Score a deal or overpay on
  your own and the difference is **yours** — the crew reimburses catalog value, no more, no less.
  The item's kind picks the house (base → raw, product → product), or run it in the house channel.

## 7. Engine changes

- **`payout(cycleEntries, config, catalog, recipes, lines)`** replaces `settle()`:
  - Accrue capital/farm/labor/commission per member (same valuation as v1).
  - `fund = cash − Σ(earned − advances)`; split fund by **rank weight among contributors**
    (replaces v1's 70/30 work/rank pool).
  - Returns `perMember[]` with the same breakdown shape + `rankShare`.
  - Keep the loss-branch guard and cent-rounding remainder logic.
- **`itemValues` / `buildCosts` / farm auto-pricing** — unchanged (value farm pay + inventory).
- **`inventory()`** — extended to be house-aware (per-house balances).
- Retire `workSplitPct`.

## 8. Setup & channels

`/setup` creates the **Operations** category with **#raw-house**, **#product-house**,
**#money-house**, **#treasury**, and the read-only **#cutter-guide** (with the deck). It
records each channel's house in `CHANNEL#`, sets the officer role, seeds the Honey + Coke lines,
and initializes cycle 1. Self-heals (recreates) any house channel that's been deleted.

## 9. Migration

No live data to preserve (servers hold only seed data) → **clean start**: deploy v2, run
`/setup` fresh. v1 job records, if any, are ignored. Document a one-time note in the runbook.

## 10. Survives vs. retires

- **Survives:** catalog (incl. bought costs), recipes, farm auto-pricing, labor rate,
  commission, rank weights, inventory replay, loss-branch, embeds/config panel, the deck.
- **Retires:** the **job** entity & per-job channels, `workSplitPct` and the 70/30 pool split,
  per-job settle/archive, the jobs-by-status GSI.

## 11. Open items

- **Carryover:** unreimbursed capital on a loss cycle carries as an opening claim (confirm UX).
- **Rank eligibility:** fund goes to *contributors* this cycle (idle rank-holders get nothing) — confirm.
- **`contribution × rank`** alternative for the fund split is a one-line swap if ever wanted.
- **Guns house** deferred.
