# 🔪 CUTTER — Midnight Mafia Cut Tracker

*A Discord bot that keeps the books on every operation, so the split is fair, automatic, and impossible to argue with.*

---

## The problem
We run multi-step product ops. People front ingredients, people do the cooking, people put in cash, people pull stuff out. By the time it sells, **nobody agrees on who's owed what.** Cutter ends that.

## How it works
Every op is a **Job**. Cutter logs four things to the books:

| Event | What it means |
|---|---|
| 💰 **Deposit** | You put in ingredients, product, or raw cash — credited at the crew price list |
| ⚗️ **Process** | You run a cook step — Cutter checks the inputs exist, consumes them, and **pays you for the labor** |
| 📤 **Withdraw** | You pull product or cash out — anytime; it's docked from your final cut |
| 💵 **Sale** | Product sells — the cash hits the pot |

When the job closes, Cutter runs the **settle** and posts the payout table. Receipts for everything. No more "I swear I put in more leaf than that."

---

## The split — three ways to earn

**1. Get your money back first.** Everyone is reimbursed for the ingredients and cash they fronted *before any profit is touched.* Bankroll the op without fear of losing your stake.

**2. Profit rewards the work (70%).** Split by what you actually did — materials fronted **and** cook steps you ran. Suppliers and cooks both eat.

**3. Rank takes its cut (30%).** The rest splits by your **level in the chain** — higher up, bigger slice, even if you just oversaw. Cutter reads your Discord roles automatically, so a promotion instantly bumps your cut. *(The 70/30 dial is adjustable.)*

| Level | Tier | Weight |
|---|---|---|
| **I** | Leadership (Don, Underboss) | **5×** |
| **II** | Consigliere (Captain, Soldier, Warlord) | **4×** |
| **III** | Capos (Ambassador, Corner Boss, Street Soldier, Dealer, Supplier) | **3×** |
| **IV** | Enforcers (Hittaz, Goon, Hustler) | **2×** |
| **V** | Associates (Runners, Lookouts) | **1×** |

> ⚠️ **And if a job goes bad** (sold low, got robbed, cops): the loss is **rank-weighted** — leadership carries more of the risk, same as it takes more of the reward.

---

## What a payout looks like

> Job: *Tuesday cook* — 100 product sold for **$500,000**

| Member | Rank | Put in | Did | **Takes home** |
|---|---|---|---|---|
| Alice | Supplier (III) | 500 leaf | — | **$199,829** |
| Bob | Goon (IV) | 100 baggies | ran the refine | **$142,686** |
| Carol | Captain (II) | $10k cash | — | **$107,771** |
| Dave | **Don (I)** | nothing | oversaw | **$49,714** |

Alice fronted the most material → biggest cut. Bob got paid for the cook. Dave the Don still walks with rank money — but **can't touch Alice's ingredient stake.** Everybody's square.

> 📝 *Numbers are an example to show how the split works — actual prices and the 70/30 dial get locked in once the crew approves the model.*

---

## Why you'll trust it
- 🔒 **Every entry is logged** — any payout can be re-checked, line by line
- 🛡️ **Officers only** edit prices, ranks, and confirm sales
- ⚖️ **Same rules every job** — the math doesn't play favorites

---

## 🗳️ CREW — SOUND OFF
React to approve, or drop notes on what to change before we build:

- ✅ **Ship it** — build Cutter as described
- 🔧 **Mostly good** — tweak the dials (rank %, multipliers, prices)
- ❌ **Rethink it** — the split model needs work

*Once we get a green light, next step is the full design + the price list and rank multipliers.*
