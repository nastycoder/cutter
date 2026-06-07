# Cutter — Technical Design

Discord bot that tracks contributions to Midnight Mafia drug operations and settles each
haul fairly. Slash-command driven, serverless on AWS, TypeScript end to end.

> Status: **reviewed — all open items resolved.**

---

## 1. Architecture

100% command-driven → **HTTP Interactions** (no gateway/WebSocket), which means fully serverless
and roles arrive free in every interaction payload.

```
Discord ──POST /interactions──► API Gateway (HTTP API)
                                      │
                                      ▼
                          Lambda "interactions" (Node 20, TS)
                          1. verify Ed25519 signature
                          2. PING→PONG | route slash command | autocomplete
                          3. quick cmds → reply inline (type 4)
                             /settle → defer (type 5), compute, PATCH original
                                      │
                    ┌─────────────────┼──────────────────┐
                    ▼                 ▼                  ▼
              DynamoDB           Secrets Mgr         CloudWatch
          (single table)    (token, public key,        (logs)
                                 app id)
```

- **No VPC** (DynamoDB needs none) → Node cold start ~300–600 ms, safely inside Discord's 3 s ACK window.
- **Cost**: API GW + Lambda + DynamoDB on-demand for a small crew ≈ **$0–1/mo** (mostly free tier).
- **Three Discord specifics to nail**: signature verification, deferred responses, command registration.

---

## 2. Repo layout (npm workspaces)

```
cutter/
├─ packages/
│  ├─ shared/      # types: entities, config, command schemas (imported by all)
│  ├─ engine/      # PURE settlement + recipe math — no AWS, fully unit-tested
│  ├─ bot/         # Lambda handler: verify, route, command impls, Dynamo repo
│  └─ infra/       # CDK app + CutterStack
├─ scripts/
│  └─ register-commands.ts   # registers slash commands with Discord (deploy step)
└─ DESIGN.md
```

The **engine is isolated and pure** so it's trivially testable. Our worked $220K batch becomes a
**golden test** — settlement must tie to the dollar.

---

## 3. Data model (DynamoDB single table)

Table `Cutter`, on-demand. One partition holds an entire job's ledger → one Query settles it.

| Entity | PK | SK | Notes |
|---|---|---|---|
| Guild config (dials) | `GUILD#<gid>` | `CONFIG` | labor rate, split, commission %, rank multipliers, officer role, Operations/Archive category ids (reference price is per-line) |
| Product line | `GUILD#<gid>` | `LINE#<lineId>` | name, final-product item, reference sell price (cocaine, honey, moonshine, meth…) |
| Catalog item | `GUILD#<gid>` | `ITEM#<itemId>` | name, kind (base/intermediate/final), value, source (farmed/bought), line (or shared, e.g. cleaning kit) |
| Recipe step | `GUILD#<gid>` | `RECIPE#<lineId>#<step>` | inputs[], output item + yield (**fixed n** or **variable/range**), can-fail flag (info only) |
| Rank map | `GUILD#<gid>` | `RANK#<roleId>` | → level 1–5 |
| Channel pointer | `GUILD#<gid>` | `CHANNEL#<channelId>` | → the job bound to that channel (one job per auto-created channel; cleared on close) |
| Job meta | `JOB#<jobId>` | `META` | name, status (open/settling/closed), channelId, createdBy/At, settledAt |
| Ledger entry | `JOB#<jobId>` | `ENTRY#<interactionId>` | type (deposit/process/withdraw/sale), actor, payload; keyed by Discord interaction id (time-sortable + idempotent) |
| Payout (audit) | `JOB#<jobId>` | `PAYOUT#<userId>` | written at settle: reimbursed/commission/work/rank/net |

**GSI1** (list jobs by status): `GSI1PK=GUILD#<gid>#<status>`, `GSI1SK=<createdAt>` — only Job-meta items project.

Access patterns: load guild config = Query `GUILD#<gid>`; append entry = Put `JOB#<jobId>`;
list open jobs = Query GSI1; **settle = Query `JOB#<jobId>` (all entries) → engine**.

---

## 4. Command surface

**The channel is the job.** `/job open` **auto-creates a dedicated channel** (`#name-<id>`, under an
**Operations** category) and binds the job to it. Every job-scoped command resolves the job from **the channel
it's run in** — there's no `job:` argument to confuse anyone; you just run the command in the op's channel.
Concurrent ops (even same product) each get their own channel, fully isolated. On close/settle the channel is
**archived** (renamed, moved to an **Archive** category, set read-only). Item/step options use **autocomplete**
scoped to the channel's product line.

### Member (anyone)
| Command | Does |
|---|---|
| `/job open name: product:<line>` | open a job — **auto-creates its channel** under Operations |
| `/job list` | list open jobs (with channel links) |
| `/job close` | close + archive the channel — **the opener or an officer** |
| `/settle` | run the engine, post the payout, archive the channel — **the opener or an officer** |
| `/status` | current state — pool inventory, totals, and **unaccounted** product (made but unsold/unwithdrawn) |
| `/ledger` | full chronological history — every deposit/process/sale/withdraw, with who & when |
| `/deposit item:<auto> qty:` · `/deposit cash:` | add materials / cash to the pool (valued at catalog) |
| `/process step:<auto> made:` | log a craft — just report what you **made**; labor credited on output produced |
| `/withdraw item:<auto> qty:` · `/withdraw cash:` | pull from pool (debited at value) |
| `/sale qty: cash: [by:@user]` | log a real-cash sale of the job's product (sums into revenue) |
| `/me` | my current standing in this channel's job |

### Officer (gated to the configured officer role)
| Command | Does |
|---|---|
| `/setup` | **first-run wizard** — seed starting values + map Discord roles → levels + set the officer role (§4.1). Gated on Discord *Manage Server*, since no officer role exists yet |
| `/void entry:` | reverse a mistaken entry — appends a logged reversal (never hard-deletes) |
| `/job reopen` | reopen a settled job for corrections (audit-logged) |
| `/config` · `/config set <dial> <value>` | open the stepper **panel** (§4.1), or set a dial directly |
| `/catalog list` · `/catalog add` · `/catalog set` · `/catalog remove` | manage items — select-to-edit; intermediates auto-valued (build cost) |
| `/recipe line add` · `/recipe step set` · `/recipe list` | define product lines & chains (modal + paste shorthand, §4.2) |
| `/rank map` · `/rank weights` · `/rank list` · `/rank unmap` | role→level & level→multiplier |

### 4.1 Interactive components — `/setup` wizard & `/config` panel

Buttons, select menus, and modals all post back to the **same `/interactions` Lambda** as
`MESSAGE_COMPONENT` / `MODAL_SUBMIT` interactions; we route on `custom_id`, mutate state, and
**edit the message in place**. No new infrastructure.

**`/setup` (onboarding wizard)** — gated on Discord *Manage Server* (the officer role doesn't exist
yet). Ephemeral, re-runnable, never touches jobs:
1. **Load starting values** — seeds the starting product line (honey), its catalog & recipes, and default dials if absent.
2. **Officer role** — a role-select picks who holds privileged commands from here on.
3. **Map levels** — a level dropdown + role-select; chosen roles accumulate under each level (I–V); the embed shows the running map.
4. **Save** — writes `CONFIG`, `RANK#<roleId>`, and any seeded `ITEM#`/`RECIPE#`.

```
🛠  CUTTER SETUP                                    (Manage Server)
─────────────────────────────────────────────
Starting values  ✅ loaded (catalog · recipes · dials)
Officer role     @Capo
Level map        I:@Don @Underboss   II:@Captain …   III:@Dealer …
─────────────────────────────────────────────
[ Level ▾ ]   [ Roles ▾ (role select) ]        [ Load defaults ] [ Save ]
```

**`/config` (stepper panel)** — officer-only. A dropdown focuses one dial; step buttons nudge it; the
embed re-renders on each press. `/config set <dial> <value>` stays for precise/scriptable edits and the
long item-price list.

```
⚙  ECONOMY DIALS                                      officers only
─────────────────────────────────────────────
▸ Labor rate        ▰▰▰░░░░░   $25 / unit
  Work ╱ Rank       ▰▰▰▰▰▰▰░   70 ╱ 30
  Sell commission   ▰▰░░░░░░    8 %
  Rank multipliers  pick a level ▾ to step  (5·4·3·2·1)
─────────────────────────────────────────────
 [ Dial ▾ ]   [ −10 ] [ −1 ] [ +1 ] [ +10 ]   [ Reset ] [ Done ]
```

**One press changes exactly one stored value.** Two special cases: the **Work/Rank split is a single
seesaw** (`rank = 100 − work`, so both ends move from one press), and **rank-multiplier percentages are
read-only previews** recomputed from `weight ÷ total` — never edited directly. Every other dial is independent.

### 4.2 Product lines — fully data-driven

A **product line** is a named chain (cocaine, honey, moonshine, meth…) with its own steps, intermediates,
final product, and reference sell price — all stored as `LINE#` / `RECIPE#` / `ITEM#` data, never code.
`/job open product:<line>` picks the line, which scopes what `/process` offers, what `/sale` moves, and
which reference price drives projections. The engine derives **each line's own build-cost ladder** from its
recipes, so settlement is identical regardless of the drug.

`/setup` seeds **honey** — the chain we've fully specced — as the starting template. **Cocaine, moonshine,
and meth** are added with `/recipe line add` + `/recipe step set` once you've got their formulas (cocaine in
particular has a variable-yield step, which the builder handles). No deploy, no code change.

**Defining a line, no code.** `/recipe line add` opens a modal (name · final product · reference price).
`/recipe step set` opens a modal with a one-line-per-step shorthand the bot parses, validates, and previews
before saving:

```
refine   : 5 coca + 2 acetone        -> 4 coca paste
wash   * : 2 solvent + 2 coca paste  -> 12-15 cocaine      (12–15 = variable yield · `*` = can fail, info only)
press  * : 4 cocaine + 1 press kit   -> 4 brick
```

A plain number is a **fixed yield**; a **range** like `12-15` marks a **variable yield** — the cook reports
the actual count with `/process made:` each run, so settlement uses real output, never a guess. Unknown
base/bought items prompt for a value + source; **intermediates auto-create** (cost derived, no price needed);
the final product is tagged to the line. On confirm the line is **immediately craftable** — autocomplete,
build-cost ladders, and yield handling all rebuild from the data.

### 4.3 Status & ledger

`/ledger` prints the **append-only history** — every entry with actor and timestamp.
It's the audit trail; any settlement can be traced back through it.

`/status` is the **live reconciliation**: current pool inventory (raw · intermediate · final · cash),
running totals (deposited / made / sold / withdrawn), and an **Unaccounted** section flagging anything that
blocks a clean settle — final product made but not yet sold or withdrawn, and intermediates still sitting
mid-chain. A job settles cleanly when nothing's unaccounted (or the remainder is explicitly valued as leftover).

---

## 5. Settlement engine (pure function)

```
settle(config, catalog, recipes, ranks, entries) → { perMember[], totals, tiesOut }
```

**Waterfall** (the model we validated):
1. **Reimburse capital** — each member's **total fronted** material + cash value returned off the top.
2. **Labor** — each process entry reports `made` (product produced). Credit the cook `laborRate × made`,
   paid on what they actually made — so a botched craft **self-penalizes** (less output → less pay) and
   **variable yields just work** (the cook reports the real count). No failure tracking: materials that get
   wasted in a botch stay deposited (and reimbursed); their cost is absorbed by the pool via lower output → lower revenue.
3. **Revenue** = Σ sale cash (real money; the $125 ref is projection-only).
4. **Commission** — `commissionPct × cash each seller moved`, paid off the top (hazard pay, rank-independent).
5. **Distributable** = revenue − reimbursements − commission.
   - if **< 0** → loss branch: shortfall absorbed **rank-weighted** (higher rank eats more).
6. **Split** distributable → work `splitPct` / rank `1−splitPct`.
7. **Work share** ∝ contribution (materials fronted value + labor value).
8. **Rank share** ∝ rank multiplier among participants.
9. **Net** = reimbursed + commission + work + rank − withdrawals.

Build costs are derived bottom-up from **each line's** recipes (honey: powder $40 → cut $45 → vial heroin $95
at current prices), never from street price. Output separates **capital returned** from **earned** so big numbers don't read as rigged.

**Golden test**: the 600-poppy / 5-hand run must produce Marco $114,972 · Rico $55,679 · Vinny $25,976 ·
Tony $12,518 · Lou $10,855, summing to $220,000.

### 5.1 Integrity, corrections & edge cases

- **One engine, three callers** — the same pure `settle()` runs on current entries for `/me` and `/status`
  (a live preview) and at close for `/settle` (final). No duplicated math.
- **Anchored on deposits + labor + sales** — settlement never needs intermediate inventory, so dropping
  `attempts` costs nothing. `/status` reconciles **final product** exactly (made vs sold + withdrawn + on-hand);
  raw/intermediate stock is shown best-effort only.
- **Corrections** — `/void` (officer) appends a **reversing entry**; nothing is hard-deleted, so the ledger
  stays a true audit trail.
- **Settle lock & reopen** — `/settle` flips the job to `settling` (no new entries), writes payouts, then
  `closed`; `/job reopen` returns it to `open` for fixes and logs the reopen itself.
- **Idempotency** — every ledger write is keyed by the Discord interaction id, so retries can't double-post.
- **Rounding** — money rounds to the cent; the remainder is allocated largest-share-first, so payouts always
  tie to the total to the penny.
- **Unmapped member** — no mapped role → settles at **Level V (1×)** for the rank share (still gets work + capital).
- **Withdrawals** — personal-use product debited at the **line's reference price**; cash/material at value.
- **Loss branch** — if revenue can't cover capital, commission is **not** paid, reimbursements return
  **pro-rata**, and the remaining shortfall is shared **rank-weighted** (higher rank absorbs more).

---

## 6. Discord integration

- **Signature**: verify Ed25519 (`X-Signature-Ed25519` + timestamp) against the app public key on every request; PING(type 1)→PONG.
- **Deferred**: `/settle` returns type 5 within 3 s, then PATCHes `/webhooks/<appId>/<interactionToken>/messages/@original` with the table (15-min window). Everything else replies inline (type 4).
- **Registration**: `register-commands.ts` upserts commands via Discord REST. **Guild-scoped** for dev (instant); global for prod. Run as a deploy step / CDK custom resource.
- **Rank detection**: `interaction.member.roles` → map via `RANK#<roleId>` → level → multiplier. Promotions in Discord update cuts automatically.
- **Output**: payout as a monospaced **code-block table** (aligns cleanly) in the settle reply; rendered-image payouts are a later polish.

---

## 7. Permissions & config

- **Officer gating**: a configured **officer role** (e.g. Capo+), checked against `interaction.member.roles`
  (falls back to Discord *Manage Server* before one is set). Officer-only: void, job-reopen, catalog,
  recipe, config, rank. **`/job open` is open to all; `/job close` and `/settle` = the opener or an officer.** The role id lives in `CONFIG`.
- All economy values live in `CONFIG`/`ITEM`/`RECIPE` items — **nothing hardcoded**; the engine reads them at runtime.
- **Guild-scoped** from day one (every key carries `<gid>`), so multi-crew is possible later at no refactor cost,
  even though we target the one crew now.

---

## 8. Deployment (CDK / TypeScript)

`CutterStack`:
- DynamoDB table (single-table + GSI1), on-demand, point-in-time recovery on.
- `NodejsFunction` (esbuild bundle), env: `TABLE_NAME`, secret ARN; IAM → table RW + secret read.
- HTTP API Gateway → `POST /interactions` → Lambda. Output the endpoint URL.
- Secrets Manager secret `cutter/discord`: `{ publicKey, botToken, appId }`.
- CloudWatch log retention (e.g. 1 month).

**Bootstrap order**: create Discord app (portal) → store secret → `cdk deploy` → paste API URL into the
portal's *Interactions Endpoint URL* → run `register-commands`.

---

## 9. Build phases

| Phase | Deliverable |
|---|---|
| **0 · Skeleton** ✅ | CDK stack, secret, signature verify, `/ping`→pong working end to end in Discord |
| **1 · Config** ✅ | data model + `/setup` + `/catalog` (CRUD + autocomplete) + `/config` + `/rank` |
| **2 · Ledger** ◷ | **auto-channel** `/job` lifecycle + `/deposit` `/process` `/withdraw` `/sale` + `/ledger`; `/status` next |
| **3 · Settle** | engine package + golden test + `/settle` output |
| **4 · Polish** | **`/config` stepper panel**, `/me`, `/void` + `/job reopen`, loss & debt edge cases, rendered-image payouts |
| **5 · Harden** | full test suite, observability, README/runbook |

---

## 10. Decisions

- ✅ **Job model** — `/job open` **auto-creates a dedicated channel** per job (under an *Operations* category)
  and binds it; every command resolves the job from its channel (no `job:` argument). Closed jobs are archived
  (read-only, *Archive* category). **Anyone** opens a job; the **opener or an officer** closes it.
- ✅ **Catalog** — items are a first-class registry edited by **select-then-edit** (autocomplete): `/catalog
  add|set|remove|list`. Intermediates **auto-value at build cost** (derived live from recipes); only base items are priced.
- ✅ **Officer gating** — dedicated, configurable **officer role** (Manage Server fallback before setup).
- ✅ **Output** — code-block table now; rendered-image payouts later.
- ✅ **Product lines** — fully data-driven; **honey seeded**, cocaine/moonshine/meth added via `/recipe`
  (cocaine has a variable-yield step — engine supports fixed & variable yields). See §4.2 / §5.
- ✅ **Botches** — cook-eats-botch rule **dropped**; a botch self-penalizes (less output → less labor) and the
  material loss is absorbed by the pool. `/process` takes just `made:` — no `attempts`/`failed`.
- ✅ **Personal-use withdrawals** — debited at the **line's reference price**; sales always use real cash.
- ✅ **Sales** — any member may log `/sale` (audit log + `by:` keep it honest).
- ✅ **Unmapped member** — settles at Level V (1×) rank weight.
- ✅ **Losses** — commission unpaid; reimbursements pro-rata; shortfall rank-weighted.
- ✅ **Corrections** — officer `/void` (reversing entry) + `/job reopen`; nothing hard-deleted.

### Crew-requested addenda
- **Rank-cut reference** — standalone pinnable card: the rank pool is 30% of profit, split by weight
  5/4/3/2/1 (Level I→V); your slice = your weight ÷ total weight of everyone on the run.
