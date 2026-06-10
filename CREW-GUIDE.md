# ⚜ Cutter — How We Run & Get Paid

*Midnight Mafia operations. Every cut accounted for.*

Cutter is our bookkeeper. It tracks every bit of work the crew puts in — farming, funding,
cooking, selling — and makes sure everyone gets paid right when we cash out. You run a few
simple commands as you work; Cutter keeps the tally. No arguing over who's owed what.

---

## The stash houses

Cutter mirrors our real stash houses, so the books match what's actually on the shelf:

- 🌿 **Raw House** — raw materials (poppy, acetone, chemicals, bought supplies)
- 🧪 **Product House** — anything we've cooked, from half-steps to finished product
- 💰 **Money House** — the cash

Each house is a channel. **You run commands in the house you're working in** — Cutter knows
which house you mean from the channel you're in.

---

## How you log your work

As you do things, log them. It takes a second and it's how you get paid.

**Bring in raw materials** — in 🌿 **#raw-house**:
```
/deposit item:Poppy qty:600
```
Farmed it yourself? That's your farm pay. **Holding it for someone who farmed it?** Credit them:
```
/deposit item:Poppy qty:600 credit:@Vinny
```
> 💡 This is the key to handoffs. If you flew in and someone handed you their poppy to bank,
> `credit:` makes sure the person who **actually farmed it** gets paid — not whoever's
> carrying it. Credit always follows the person who did the work.

**Bought supplies with your own cash** — in 🌿 **#raw-house**:
```
/buy item:Vial qty:200 cost:10000
```
You get that **$10,000 back** off the top when we settle — buying supplies is fronting capital,
not a donation.

**Cook a step** — in 🧪 **#product-house**:
```
/process step:refine made:480
```
Report what you **made**. Cutter pulls the right raw materials out, adds the product, and pays
you for the labor. Cooking for someone else? `credit:@who`.

**Move stuff between houses** — anywhere:
```
/transfer item:Cut heroin qty:400 to:#product-house
```
Just logistics — moving product around doesn't change anyone's pay.

**Sell the product** — in 💰 **#money-house**:
```
/sale qty:1700 cash:220000
```
The cash lands in the money house. Whoever sold it earns **commission** — hazard pay for
holding the heat. Someone else moved it? `by:@who`.

---

## How you get paid

Two parts. **You always get paid for the work you actually do**, then the **profit on top gets
split by rank.**

**① Paid for your work** — straight value, no matter your rank:
- **Capital back** — cash and bought supplies you fronted, reimbursed in full.
- **Farm pay** — the value of what you farmed.
- **Cook pay** — a set rate for every unit you process.
- **Commission** — a cut of every sale you make.

**② Rank cut of the fund** — after everyone's work is paid, whatever profit is left (the
**fund**) is split among everyone who pitched in this cycle, by **rank**:

| Rank | Who | Weight |
|---|---|---|
| **I** | Leadership — Don · Underboss | 5× |
| **II** | Consigliere — Captain · Soldier | 4× |
| **III** | Capos — Dealer · Supplier | 3× |
| **IV** | Enforcers — Goon · Hustler | 2× |
| **V** | Associates — Runners · Lookouts | 1× |

So: **everyone earns for the work they did**, and **the bosses earn a bigger slice of the
profit** — but you've got to be in the cycle to share the fund. Show up, put in work, get paid.

---

## The cycle & payday

The books run in **cycles**. Through a cycle, everyone's work piles up on their tab. When the
crew's ready to cash out, an officer runs:
```
/payout
```
That pays everyone their work **plus** their rank share of the fund, then **starts a fresh
cycle.** Inventory in the houses stays put — only the tally resets. It's payday.

**Worked payday** — one cycle, $80,000 sold:

| Member | Rank | Put in | Work pay | + Rank cut of $39,600 fund | **Take-home** |
|---|---|---|--:|--:|--:|
| Marco | I (5×) | fronted 200 vials | $10,000 capital | $15,231 | **$25,231** |
| Vinny | III (3×) | farmed 600 poppy | $12,000 farm | $9,138 | **$21,138** |
| Tony | IV (2×) | cooked 480 units | $12,000 labor | $6,092 | **$18,092** |
| Rico | III (3×) | sold $80,000 | $6,400 commission | $9,138 | **$15,538** |

Everyone's covered for their work; the $39,600 profit splits by rank.

---

## Need cash before payday?

You don't have to wait for the cycle to close. Tell an officer and they can front you an
**advance** against what you've already earned:
```
/advance @you amount:5000
```
Full or partial, whatever the money house can cover. It comes off your tab automatically at
the next `/payout`, so it all squares up. Check what you've got coming anytime:
```
/owed
```

---

## Keeping it straight

- **`/me`** — your standing this cycle: what you've put in and what you'll clear.
- **`/status`** — the whole treasury: what's in each house, cash on hand, the fund.
- **`/ledger`** — the full blow-by-blow history.
- **`/stash #raw-house`** — what Cutter thinks is in a house.
- **`/reconcile`** — officers tally the real house against the books to catch any shrinkage.
- **`/withdraw`** — taking product or cash for personal use; it's valued and comes off your tab.

Everything's logged, nothing's hidden. If a number looks off, the ledger shows exactly what
happened and who did it.

---

## Cheat sheet

| You're… | Run | Where |
|---|---|---|
| banking raw materials | `/deposit item: qty: [credit:@who]` | 🌿 raw |
| buying supplies | `/buy item: qty: cost:` | 🌿 raw |
| cooking | `/process step: made: [credit:@who]` | 🧪 product |
| moving stock | `/transfer item: qty: to:#house` | anywhere |
| selling | `/sale qty: cash: [by:@who]` | 💰 money |
| checking your cut | `/owed` · `/me` | 💰 money |
| needing cash now | ask an officer for `/advance` | 💰 money |
| cashing the crew out | `/payout` *(officer)* | 💰 money |

**Put in the work. Cutter pays you right.**
