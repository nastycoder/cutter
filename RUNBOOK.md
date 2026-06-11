# Cutter — Runbook

Operating guide for Cutter, the Midnight Mafia treasury & fair-split bot.
Architecture lives in [`DESIGN-v2.md`](./DESIGN-v2.md) (the crew-facing version is
[`CREW-GUIDE.md`](./CREW-GUIDE.md)); this is how to **deploy, run, and fix** it.

---

## 1. What it is

A Discord bot that runs the crew's **Contribution Treasury**: per-house channels mirror the
real stash houses (🌿 raw · 🧪 product · 💰 money · 🏦 treasury), every contribution is logged
as it happens, and an officer's **`/payout`** settles the cycle — everyone's work paid at its
value, the profit (the **fund**) split **by rank** among that cycle's contributors.
Serverless on AWS (API Gateway → Lambda → DynamoDB), TypeScript end to end.

> **v2 note (clean start):** v2 replaced the v1 *job* model. There was no live data to keep —
> deploy, `npm run register`, then run `/setup` fresh in the server. Old v1 job records in the
> table are simply ignored.

---

## 2. Deploy & operate

Deploys with AWS CDK under your own AWS profile (set `AWS_PROFILE`, or pass `--profile`).

```bash
npm install
npm run build          # type-check shared + engine + bot
npm test               # run the engine test suite (the §4 worked cycle must tie to the cent)
npm run synth          # cdk synth (no deploy)
npm run deploy         # cdk deploy
```

**First-time bootstrap**

1. Create a Discord application at <https://discord.com/developers/applications>; copy the
   **Application ID** + **Public Key** (General Info) and the **Bot Token** (Bot tab).
2. `npm run deploy` — creates the DynamoDB table, the `cutter/discord` secret, the Lambda, and the HTTP API.
3. Store the three Discord values in the secret:
   ```bash
   aws secretsmanager put-secret-value --secret-id cutter/discord \
     --secret-string '{"publicKey":"…","appId":"…","botToken":"…"}'
   ```
4. Paste the stack's `InteractionsUrl` output into the app's **Interactions Endpoint URL** (General Info) → it must verify (green ✓).
5. Invite the app with the bot scope + Manage Roles + Manage Channels permissions, then register commands:
   ```bash
   GUILD_ID=<server id> npm run register
   ```
6. In the server, run **`/setup officer:@<role>`** — it builds the house channels + the read-only
   guide, seeds the Honey + Coke lines, and opens cycle 1. Then map ranks (`scripts/setup-roles.ts` or `/rank map`).

**Redeploy** after code changes: `npm run deploy`. **Re-register** only when command shapes change: `npm run register`.

---

## 3. Command reference

### Anyone — logging work (house from the channel you're in, or the item's kind)
| Command | What it does |
|---|---|
| `/deposit item: qty: [credit:@who]` | Bank farmed materials — **farm pay** to whoever did the work (handoff-safe) |
| `/buy item: qty:` | Buy with your own cash — **capital** at catalog value, owed back |
| `/fund-cash amount:` | Front the treasury cash — capital, owed back |
| `/process line: step: made: [credit:@who]` | Log a cook — consumes inputs, adds product, **labor pay** |
| `/transfer item: qty: to:#house` | Move stock between houses (logistics, no pay effect) |
| `/checkout product: qty:` | Take product into your **holding** to go sell (not a withdrawal) |
| `/sale product: qty: cash: [by:@who]` | Real-cash sale — draws your holding first; **commission** to the seller |
| `/return product: qty:` | Put unsold product back from your holding |
| `/withdraw item: qty:` · `/withdraw cash:` | Personal use — valued, off your tab at payout |
| `/loss cause: item:\|cash: [holder:@m] [note:]` | Busted/robbed/spoiled — crew-shared by default |

### Anyone — reading the books
| Command | What it does |
|---|---|
| `/me` | Your standing this cycle: tab, rank, holding |
| `/owed [@member]` | A live tab: earned, advanced, advanceable now |
| `/holding [@member]` | Product members have checked out |
| `/stash [house]` | What the books say is on a shelf |
| `/fund` | Cash · owed for work · the profit on top |
| `/status` | The whole treasury at a glance |
| `/ledger` | This cycle's blow-by-blow |

### Officer only
| Command | What it does |
|---|---|
| `/setup officer:@role` | First-run/repair: house channels, guide, seed, cycle 1 (needs Manage Server) |
| `/advance @member amount:` | Hand cash now against what they've earned (reconciles at payout) |
| `/payout` | **Payday** — pay every tab + split the fund by rank, archive, start the next cycle |
| `/spend amount: reason:` | Spend crew cash on ops (logged; shrinks the fund) |
| `/reconcile item: count:` | Log a real shelf count — records shrinkage vs the books |
| `/loss … charge:@member` | Put a loss on one member's tab instead of the crew |
| `/void entry:` | Reverse a mistaken entry (also how a recovered loss comes back) |
| `/config` · `/catalog` · `/recipe` · `/rank` | Dials, prices, lines & chains, role→level map |

---

## 4. Running the operation (the flow)

1. **Log as you go**, in the house you're working in: `/deposit` what's farmed (`credit:` the
   farmer on handoffs), `/buy` supplies, `/process` each cook, `/checkout → /sale → /return`
   for selling runs, `/loss` the moment something goes wrong.
2. **`/status` / `/owed`** any time — the books are live; nobody waits for a close to know
   where they stand. Need cash early? An officer `/advance`s against what you've earned.
3. **`/payout`** (officer) when the crew's ready to cash out — posts the full cycle record +
   who gets handed what, then opens the next cycle. **Inventory carries over; tabs reset.**

---

## 5. How the split works

At `/payout`:
1. **Work paid at its value** — capital reimbursed (buys at catalog + cash fronted), farm pay
   (auto-priced when the farm margin is on), labor (`laborRate × made`), commission on sales.
2. **The fund** = money-house cash − everything owed for work. Split **purely by rank weight**
   (level read live from Discord roles; unmapped = Level V) among **this cycle's contributors** —
   idle rank-holders get nothing.
3. **Net** = work + rank share − advances − withdrawals/charges. Ties to cash to the cent.

Edge cases: **loss cycle** (cash can't cover work) → capital reimbursed pro-rata first, no fund,
shortfall carries to the next cycle as an opening claim; **nobody goes negative** — a deficit is
floored at 0 (and reported as forgiven); **voided** entries vanish from the math; crew-shared
**losses** come out of the fund on their own (lost goods never become revenue).

---

## 6. Configuration

All economy values are data — nothing hardcoded, all editable in Discord (officers):
- **Dials** — `laborRate`, commission %, farm margin, rank weights. Tune with **`/config panel`** or `/config set`.
- **Prices** — `/catalog add|set` (only base items are priced; intermediates derive their build cost live).
- **Product lines & recipes** — `/recipe`. Honey and Coke are seeded; add more lines as you get the formulas.
- **Ranks** — `/rank map` (role→level) and `/rank weights` (level→multiplier).

---

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| `/setup` blocked | Needs **Manage Server**; run it as a server admin |
| "I couldn't create the house channels" | Re-invite the app with **Manage Channels**, `/setup` again (it self-heals) |
| A house channel got deleted | Run `/setup` again — missing channels are rebuilt and re-mapped |
| Commands don't appear | Re-invite with `applications.commands` scope; `npm run register` (guild-scoped = instant) |
| "interaction failed" | Check Lambda logs (`/aws/lambda/cutter-interactions`); usually a bad component payload |
| "the application did not respond" | The 3s window — `/setup` & `/payout` are deferred, so the work still completes; other commands should be instant |
| Endpoint won't verify in the portal | Confirm the `publicKey` in the `cutter/discord` secret matches the app |
| Deploy: `Token is expired` | Refresh SSO: `aws sso login --profile <name>` |
| A mistaken entry | Officer `/void entry:` (current cycle); a recovered loss = void the loss |
| Books don't match the shelf | Officer `/reconcile item: count:` pins the real count and records the shrinkage |

Logs: CloudWatch `/aws/lambda/cutter-interactions`. Tests: `npm test` (and CI on every push).
