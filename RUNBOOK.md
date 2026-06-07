# Cutter — Runbook

Operating guide for Cutter, the Midnight Mafia operations ledger & fair-split bot.
Architecture lives in [`DESIGN.md`](./DESIGN.md); this is how to **deploy, run, and fix** it.

---

## 1. What it is

A Discord bot that tracks every contribution to a drug op — what's farmed, funded, cooked, and
sold — and settles the haul the same fair way every time: **capital home first**, then profit split
by **work**, **rank**, and **selling risk**. Serverless on AWS (API Gateway → Lambda → DynamoDB),
TypeScript end to end.

---

## 2. Deploy & operate

Deploys with AWS CDK under your own AWS profile (set `AWS_PROFILE`, or pass `--profile`).

```bash
npm install
npm run build          # type-check shared + engine + bot
npm test               # run the engine test suite (golden batch must tie to the dollar)
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
6. In the server, run **`/setup officer:@<role>`**, then create/​map ranks (`scripts/setup-roles.ts` or `/rank map`).

**Redeploy** after code changes: `npm run deploy`. **Re-register** only when command shapes change: `npm run register`.

---

## 3. Command reference

### Anyone
| Command | What it does |
|---|---|
| `/job open name: product:` | Opens an op — **auto-creates its own channel** under *Operations* |
| `/job list` | List open jobs (with channel links) |
| `/deposit item: qty:` · `/deposit cash:` | Add materials or cash to the pool |
| `/process step: made:` | Log a craft — report what you **made** |
| `/withdraw item: qty:` · `/withdraw cash:` | Pull from the pool (docked from your cut) |
| `/sale qty: cash: [by:]` | Log a real-cash sale |
| `/status` | Live state: contributors, pool, on-hand, what's unaccounted |
| `/ledger` | Full chronological history |
| `/me` | Your standing in this channel's job |

### Opener **or** officer
| Command | What it does |
|---|---|
| `/job close` | Close + archive the channel without settling |
| `/settle` | Run the engine, post the payout, archive the channel |

### Officer only
| Command | What it does |
|---|---|
| `/setup` | First-run: seed defaults, set the officer role (needs Manage Server) |
| `/config view` · `/config panel` · `/config set` | Read / interactively tune / set the economy dials |
| `/catalog list` · `/catalog add` · `/catalog set` · `/catalog remove` | Manage items & prices (select-to-edit; intermediates auto-priced) |
| `/recipe …` | Define product lines & their chains |
| `/rank map` · `/rank weights` · `/rank list` · `/rank unmap` | Role→level & level→multiplier |
| `/void entry:` | Reverse a mistaken entry (appends a logged reversal) |
| `/job reopen` | Pull a settled job back to Operations for corrections |

> Every job-scoped command targets **the channel it's run in** — no `job:` argument. Run it in the op's channel.

---

## 4. Running an op (the flow)

1. **`/job open name:Tuesday product:Honey`** → Cutter makes **#tuesday-`<id>`** and drops you a welcome message.
2. In that channel, as the op runs: `/deposit` materials & cash, `/process` each cook step (report what you made), `/sale` each real-cash sale.
3. **`/status`** any time to see contributions and what's still unaccounted; **`/ledger`** for the blow-by-blow.
4. **`/settle`** when done → posts the payout + a full record (ledger · status · payout) and archives the channel read-only.

Concurrent ops each get their own channel, fully isolated — even two cooks of the same product.

---

## 5. How the split works

On `/settle`, in order:
1. **Capital home first** — everyone's fronted materials + cash returned off the top.
2. **Sell commission** — `commission %` of the cash each seller moved, paid to them (hazard pay).
3. **Distributable** = revenue − reimbursements − commission, split **work % / rank %**:
   - **Work pool** ∝ each member's contribution (materials fronted **+** labor = `laborRate × made`).
   - **Rank pool** ∝ rank multiplier (level read live from Discord roles; unmapped = Level V).
4. **Net** = reimbursed + commission + work + rank − withdrawals. Ties to revenue to the cent.

Edge cases: **losses** (revenue < capital) → commission unpaid, reimbursements pro-rata; **voided**
entries vanish from the math; **intermediates** are valued at build cost, **final product** at the
line's reference price.

---

## 6. Configuration

All economy values are data — nothing hardcoded, all editable in Discord (officers):
- **Dials** — `laborRate`, work/rank split, commission %, rank weights. Tune with **`/config panel`** (dropdown + ± buttons) or `/config set`.
- **Prices** — `/catalog add|set` (only base items are priced; intermediates derive their build cost live).
- **Product lines & recipes** — `/recipe`. Honey is seeded; add cocaine/moonshine/meth when you have the formulas.
- **Ranks** — `/rank map` (role→level) and `/rank weights` (level→multiplier).

---

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| `/setup` blocked | Needs **Manage Server**; run it as a server admin |
| "I couldn't create the channel" | Re-invite the app with **Manage Channels** |
| Commands don't appear | Re-invite with `applications.commands` scope; `npm run register` (guild-scoped = instant) |
| "interaction failed" | Check Lambda logs (`/aws/lambda/cutter-interactions`); usually a bad component payload |
| "the application did not respond" | The 3s window — `/settle` & `/job open` are deferred, so the work still completes; other commands should be instant |
| Endpoint won't verify in the portal | Confirm the `publicKey` in the `cutter/discord` secret matches the app |
| Deploy: `Token is expired` | Refresh SSO: `aws sso login --profile <name>` |
| A mistaken entry | Officer `/void entry:`; to fix a settled job, `/job reopen` → correct → `/settle` again |

Logs: CloudWatch `/aws/lambda/cutter-interactions`. Tests: `npm test` (and CI on every push).
