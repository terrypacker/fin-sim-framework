# 107 — The retirement paycheck, and paying tax in instalments

**Status:** proposed, and **fully specified** — §15 records the four design decisions that
were open when this was first written (16 Sep 2026), so nothing here is waiting on an answer.
Phase 1 (the spending pools) is config-only and moves no golden. Phases 2–4 add scheduled
events and therefore re-resolve every event-queue tie in the run: budget a full re-gold, and
read design 100 §9 on why "adding one event" is never local.

## 1. The ask

*"Where do I get my monthly spending from, for forty years?"* is the least-modelled question
in retirement planning and the most-lived one. The literature is almost entirely about how
big the withdrawal may be — safe rates, guardrails, percent-of-wealth, all of which this
repo already has (designs 89, 96) — and almost silent on the operational half: which account
the money actually leaves, on what day, having been raised by selling what, and how the tax
bill on all of it gets paid without a forced sale at the worst possible moment.

Two things are asked for here:

1. **A spending pool** — cash earmarked for living costs, structurally separate from the
   cash/buffer/offset shock-absorber mechanics, refilled on a schedule rather than on a
   deficit. A plan with no other pools at all still wants this one.
2. **Quarterly tax payments** in both countries, sized so they do not attract a penalty —
   which means the statutory safe harbours, not a plausible-looking fraction.

## 2. What the model does today

Measured, not assumed.

| fact | where |
|---|---|
| `MONTHLY_EXPENSES` debits the **residency's** flagged transaction account | `src/finance/handlers/monthly-expenses-handler.js:157-186` |
| If the debit would breach that account's `minimumBalance`, it prepends `REPLENISH_SAVINGS` **for exactly the deficit** — never to a target | `monthly-expenses-handler.js:199-204` |
| `REPLENISH_SAVINGS` walks the drawdown sequence the pool graph compiles to, selling as it goes | `src/finance/services/account-service.js:832` |
| So the household's spending float is **the authored floor, and twelve just-in-time liquidations a year** | (the two rows above, together) |
| `minimumBalance` is a floor, not a band: the top-up restores exactly the floor, so the next month breaches it again | `account-service.js:30-36`, `monthly-expenses-handler.js:201` |
| Pool refill flows implement a real (s, S) band — `trigger.below` is `s`, `amount.toTarget` is `S` | `src/finance/pools/pool-flow-reducer.js:341-356` |
| …but they are evaluated **only on `US_PERIOD_ADVANCE` and `AU_PERIOD_ADVANCE`** — twice a year | `pool-flow-reducer.js:78` |
| …and `FLOW_CADENCE` is `{PERIOD, ANNUAL}`, so a monthly or quarterly band cannot be authored | `src/finance/pools/liquidity-graph.js:108` |
| A flow's credit lands in the destination pool's **first cash-like claim** | `src/finance/pools/pool-flow-apply-reducer.js:75-78` |
| Tax is **one lump on the settle date** — `TAX_SETTLE_US` (31 Dec), `TAX_SETTLE_AU` (30 Jun) | `src/finance/tax/tax-settle-classes.js:222,396` |
| The debit funds itself by `replenishSavings` **on that same date**, for the whole shortfall | `tax-settle-classes.js:1084-1098` |
| The gains realised *funding* the bill are deliberately deferred into the next tax year (the alternative is circular) | `tax-settle-classes.js:1071-1084` |
| There is no withholding, no instalment, no estimated payment, anywhere in the model | (absence; `grep -r "INSTALMENT\|WITHHOLD" src/finance/tax` is empty of payment machinery) |
| Lifetime tax is accumulated, but **last year's liability is not retained in state** | `src/finance/reducers/accumulate-taxes-paid-reducer.js:58` |

### 2.1 The three defects, stated separately

**(a) There is no paycheck cadence.** Nobody funds retirement by selling assets twelve times
a year in the exact amount of the month's groceries. The modelled behaviour is
perfectly time-diversified liquidation — which is not conservative or aggressive, it is
simply not a policy any household runs, and it quietly averages away the very timing
question a sequence-risk study is trying to price.

**(b) The spending float and the reserve are the same pool.** When the cash pool's claims
include the transaction account, its cover metric always contains next month's living costs,
and a crash-year draw on the reserve is indistinguishable in the telemetry from an ordinary
Tuesday. Designs 97 §18–§20 spent a long time trying to score a reserve whose balance was
partly payroll. Separating them is a measurement fix before it is a realism fix.

> **Measured after phase 1 landed, and it is weaker than stated — for a reason that
> strengthens (a).** On the reference plan the split moved the reserve's cover-years by
> essentially nothing, because **the float is empty**: the flagged transaction account has a
> `minimumBalance` of zero, the just-in-time top-up restores exactly that, and the account
> therefore holds zero at every sample across the whole run. There is no contamination to
> remove. Defect (b) is unobservable *because* of defect (a) — the value of the split is that
> it gives the plan somewhere to state its float, and the first reading it states is
> `0.00 years`. Phase 1 buys the instrument; phase 2 puts a number on it.

**(c) Tax is a single forced sale on a fixed date.** One date's market price sets what the
household must liquidate to pay a bill computed on the *previous* twelve months. A crash
that lands in December is met by selling at the bottom, in every path, by construction.
Real taxpayers in both countries pay in instalments across the year, and the law tells them
exactly how much to pay to avoid a penalty.

## 3. The shape

Four layers. Only the first two are new; the rest is the existing graph.

| layer | holds | refilled by | cadence |
|---|---|---|---|
| 0. Transaction float | one paycheck period of spend | the paycheck | drains monthly |
| 1. **Spending pool** (one per country) | the coming year's spend + the coming year's instalments | yield, then rebalancing-overweight sales, then the reserve | annual (quarterly option) |
| 2. Reserve / buffer / offset | as authored | as authored | as authored |
| 3. Growth | as authored | — | — |

The tax provision is deliberately **not** a fifth layer. An earlier sketch had a `taxReserve`
pool accruing monthly and released at settle; the instalment design in §6–§8 makes it
redundant, because with instalments the money genuinely leaves the household four times a
year and the only thing that needs to hold it is the spending pool, for a few weeks. One
mechanism, not two.

## 4. Two spending pools, not one pool with two claims

### 4.0 What the spending pool IS — both readings are correct

Worth stating flatly, because the natural reading of §3's table is that the spending pool is
a new container that money sits in, and it is not.

**A pool in this engine is not a balance. It is a named view over `(account, sleeves)`
claims.** `poolMetrics` derives `balance` every period by walking the claims and summing what
a draw would actually find — holdings market value where the account has lots,
`Math.max(0, account.balance)` for a cash-like account
(`src/finance/pools/pool-metrics.js:97-111`, and the §12.1 header above it: *"a pool is not a
balance"*). Nothing is stored on the pool. Nothing can be.

So both readings are true at once, and the apparent tension dissolves:

- **It is a real node** in `liquidityGraph.pools` — authored, serialized, validated, and
  visible in the pool editor like any other.
- **Its balance IS the transaction account's balance**, by definition, because the
  transaction account is its only claim. `SPENDING_REFILL` does not fill "the pool"; it
  credits the transaction account, and the pool's balance is that number read back.

What the pool node *adds* is exactly four things, and it is worth knowing it is only four:

| the node gives you | which buys |
|---|---|
| `spendOrder: 0` | a position in the compiled drawdown sequence — the float is drawn first |
| `target` | a number for `shortfall`, which is what a `toTarget` refill moves |
| an id | something for flow edges to name as `from` / `to` |
| a cube entry | `state.liquidityPools.spendingAu` — balance, target, cover-years, separately from the reserve's (§2.1 defect (b)) |

That is the whole of it. If you deleted the two pool nodes and kept everything else, the
household would behave identically except that the refill edges would have nothing to point
at and the reserve's cover-years would silently re-absorb the grocery money.

### 4.1 Why two, and not one pool with two claims

The household spends from **the transaction account of the country it lives in** — that is
already what `MonthlyExpensesHandler` does (`:160-172`), resolving residency and then the
flagged transaction account. So the pool that funds it should be country-shaped too:

```
spendingUs   spendOrder 0   claims: [ the US transaction account ]
spendingAu   spendOrder 0   claims: [ the AU transaction account ]
```

Why two and not one pool with both claims:

- **The cover metric becomes readable.** One pool holding both currencies reports a number
  that is true of neither. Post-move, `spendingUs` should read ~0 and `spendingAu` should
  read a year; a single pool reads "a year" throughout and hides the entire transition.
- **The refill is a decision, and it is currency-specific.** Funding AUD living costs from a
  USD portfolio is an FX decision with a cost and a timing. Two pools make that edge
  explicit (`growth → spendingAu` is a cross-border flow; `growth → spendingUs` is not) and
  therefore measurable. One pool makes it an implementation detail of `depositKeyFor`.
- **It is the shape that already caught a bug.** `intl-transfer-round-trip` (design 100 §9)
  was a top-up that drained the destination currency to fund itself. A pool per currency is
  the structure in which that is a visible flow rather than a net-zero non-event.

Both carry `spendOrder: 0` — the spending pool is always drawn first, which is what makes it
the float. Neither is a rebalanceable sleeve, so neither participates in executor 1.

### 4.2 The floor moves down, not up

It is tempting to implement the float by simply raising `minimumBalance` to a year of spend.
That does not work, and the reason is §2's second row: the top-up restores the floor exactly,
so a bigger floor buys a bigger *idle balance* and still liquidates every single month. The
float has to come from a scheduled credit (§5), and the floor should then be set **low** —
one month or less — so that it reverts to what it actually is: the tripwire that says the
paycheck failed.

That makes `REPLENISH_SAVINGS` firing a first-class signal. Today it fires every month and
means nothing. After this change, each firing is "the planned funding missed and an
unplanned sale happened", which is a far better reserve-adequacy metric than cover-years
because it counts events instead of stocks.

## 5. The paycheck

### 5.1 Why it is an event, and not just three flow edges

The first thing to try is no new machinery at all: author the refill as ordinary pool flows
with `cadence: ANNUAL`, and let the existing `PoolFlowReducer` fire them. The annual paycheck
dates even coincide with the period advances — 1 January is `PERIOD_ADVANCE_US`, 1 July is
`PERIOD_ADVANCE_AU`.

**It does not work, and the reason is precise.** `cadence: ANNUAL` is keyed on the *calendar
year*: `if (flow.cadence === 'ANNUAL' && prior[flow.to]?.lastFired?.[flow.id] === yearOf)
continue` (`pool-flow-reducer.js:411`). The reducer fires on **both** advances
(`:78`), so an `ANNUAL` edge into `spendingAu` fires at whichever advance comes first in the
calendar year — **1 January, the US one** — and is then suppressed on 1 July. An AU-calendar
annual paycheck is not authorable today. Quarterly is not authorable at all: `FLOW_CADENCE` is
`{PERIOD, ANNUAL}` (`liquidity-graph.js:108`).

So `SPENDING_REFILL` is a real scheduled event. But it needs **no second evaluator**:

1. add `SPENDING_REFILL` to `PoolFlowReducer.reducedActionTypes` (`:78`);
2. add a cadence value `PAYCHECK`, which fires only on that action and is skipped on a
   period advance.

Everything else — the (s, S) demand, the gate vocabulary, the shortfall sharing, the scoped
draw, the FX and §988 handling — is reused unchanged. This is the smallest change that makes
the calendar authorable, and it keeps one evaluator, which matters because a second one would
have to re-derive `poolContext`, the return indices and the gate streaks, and two derivations
of one decision is how they come to disagree.

### 5.2 Cadence, date, amount

**Cadence.** `ANNUAL` (default) or `QUARTERLY` — the event's schedule, not a flow property.

**Date.** The start of the residency country's income year: 1 January while US-resident,
1 July while AU-resident. Quarterly subdivides that year, not the calendar.

**Amount.** The event carries no amount. It sets the pool's `target` and lets the edges fill
to it — `amount.toTarget: true` makes the demand `m.shortfall` (`pool-flow-reducer.js:355`),
which is the (s, S) band's upper edge `S`:

```
target(spendingXx)  =  (spend for the coming period)
                     + (instalments scheduled in the coming period)   [if paycheckIncludesTax]
                     + margin
```

Expressed as `YEARS_OF_SPEND` for the first term, so it tracks the live spend line through
the age bands and inflation rather than freezing an authored dollar figure.

### 5.3 The source: three legs, and only two are authored

This is the part §5 previously hand-waved. The three legs are not three flow edges.

**Leg 0 — the sweep, and it is NOT optional. Found by measurement, phase 2.**

Before any of the three legs below, the paycheck must empty the float the household is *not*
living out of. The reason is a job the just-in-time cascade was silently doing: because the
transaction account sits first in the drawdown sequence, every monthly top-up incidentally
swept whatever had landed in it — and income keeps arriving in the country the household has
left. On the reference plan that is Social Security, which pays into the US transaction
account for the entire run, decades after the move to Australia.

Replace the funding job without the sweeping job and that income simply piles up at the
savings rate. Measured on the first working paycheck: **\$1.0M idle at the horizon**, against
\$75k once the sweep edge existed.

So the non-resident float carries `target: AMOUNT 0` and an edge into the resident one at a
priority AHEAD of every other leg — cash that has already arrived funds the year before
anything is sold. §15.3 treats this as a one-off at the residency change; it is not. It is
needed every year, for as long as any income is denominated in the country left behind.

**Leg 1 — yield. Free, and requires no configuration whatsoever.**

When dividend reinvestment is off, `StockDividendCashApplyReducer` already credits the cash
**to the country's transaction account** (`stock-dividend-cash-apply-reducer.js:55-62`; design
106 §2). The transaction account is the spending pool's only claim. **So yield does not need
an edge — it lands *inside* the pool and reduces `shortfall` directly.** A year of dividends
arriving through the year means the next paycheck's `toTarget` demand is automatically net of
them, and no sale is made for money that already arrived.

That is the entire "spend the natural yield first" strategy, obtained for nothing, and it is
worth saying explicitly because the obvious implementation — an edge from a `yield` pool — is
both unnecessary and wrong (there is no pool to source it from; the cash is already here).

Corollary worth carrying into design 106: **turning DRIP off makes the paycheck cheaper**, and
the two designs interact through exactly this line.

**Leg 2 — the sale, and "sell what's overweight" is *not* a flow.**

When the shortfall survives leg 1, the refill edge raises cash through the scoped
`replenishSavings` draw (`pool-flow-apply-reducer.js:98`). *Which sleeve that draw sells* is
not a pool-graph decision at all — it is `drawdownRebalanceWeight`, design 65 Lever C:

> `score(class) = taxRankNorm(class) − wMix · (actualFrac − targetFrac)`, sorted ascending, so
> an **over-weight** sleeve scores lower and is sold first
> (`holdings-selection.js:190-240`).

So "fund the paycheck by selling what is above target" is one scalar, already wired, currently
**`drawdownRebalanceWeight: 0`** in the reference scenario — i.e. off.

> **MEASURED 17 Sep 2026, and this paragraph was wrong.** It called the scalar "the single
> highest-leverage existing knob for this design". It is not a knob at all here: swept over
> 0 / 0.5 / 1 / 2, with and without the paycheck, every run came back **byte-identical**.
>
> The cause is structural, and it is the graph. **A liquidity graph compiles the drawdown
> into PER-SLEEVE entries** — `usStockAccount[BOND]`, `[GOLD]`, `[EQUITY]` are separate
> steps — so `withSleeveInclude` narrows every draw to a single ALLOCATION class before the
> sleeve ranker runs. Lever C reorders sleeves *within* one draw, and there is never more
> than one sleeve in a draw. The control proves the lever itself is alive: with
> `liquidityGraphEnabled: false`, where draws are whole-account, weight 2 moves terminal
> wealth by **−1.19M**.
>
> So in a pool-graph plan **`spendOrder` IS the sleeve policy**, and design 65 Lever C is
> dead alongside it. That is arguably correct — two mechanisms for one decision is what
> §12.3 warns against — but it must be stated, because the parameter is visible, authorable
> and silently inert. If the paycheck should prefer the over-weight class, it has to be said
> in the graph: one source pool claiming several sleeves, not a second lever.

It is not a pool edge; putting it in the graph would be modelling the same decision twice.

**Leg 3 — the reserve edges, and the waterfall is emergent.**

Two authored edges into each spending pool, e.g.:

```
buffer → spendingAu   priority 10   cadence PAYCHECK   amount.toTarget
growth → spendingAu   priority 20   cadence PAYCHECK   amount.toTarget   gate: {...}
```

The ordering and the sharing are already implemented and need no new logic. Flows are sorted
by *destination `spendOrder`, then edge `priority`, then id* (`pool-flow-reducer.js:404-408`),
and each edge's demand is recomputed against what earlier edges already promised:

```js
const promised = inflow[flow.to] ?? 0;
const destNow  = { ...dest, shortfall: Math.max(0, dest.shortfall - promised) };
```

(`:419-420`) — *"two sources into one pool must SHARE the shortfall, not each fill it."* So
priority 10 takes what it can (capped by its own `available = balance − floor`), priority 20
sees only what is left, and a third edge would see the remainder. The waterfall is the
existing mechanism read in the right order, not a feature to build.

### 5.4 The skip rule — yes, it is the same gate, with three constraints

The direct answer: **it is exactly the existing `gate` vocabulary**, the same object that
already sits on `growth-to-buffer` and `growth-to-offset` in the reference scenario, evaluated
by the same `_gateOpen` / `_leafClauses` (`pool-flow-reducer.js:125`, `:202-270`). Nothing new is authored.

But three things about it are not obvious, and each has already caused a defect:

**(a) A gate needs a market to read, and a cash pool has none.** `poolMarketReturn` walks the
claims' *rated lots* (`pool-metrics.js:66-82`). The spending pool claims a savings account,
which holds none, so its reading is `null` — and the two return clauses treat absent readings
asymmetrically by design: `sourceReturnOver` stays **open**, `targetReturnUnder` stays **shut**
(`pool-flow-reducer.js:257-267`). A gate clause written against the spending pool is therefore
a **constant**, not a condition: inert in one direction, permanently closed in the other. The
gate has to read the **source**, and the source has to be a market pool. `growth → spendingAu`
can carry a real gate; `buffer → spendingAu` carries one only to the extent the buffer holds
rated bond lots; a cash-sourced edge cannot carry one at all.

**(b) `gate.scope` is the decision, and the default is the aggressive one.** `SOURCE` (the
default) does not merely stop the edge — `_applyVeto` pins the target of every ALLOCATION
class the **source pool** claims, so the rebalancer may not sell those sleeves either. That is
deliberate (§12.4b: otherwise the drift band launders the same sale through a bond target),
and it is also the lever measured to **stop crash-year equity sales perfectly while raising
failure by ~6 points**. For the paycheck's skip rule the intent is narrower — *take this
year's money from the reserve instead* — which is `scope: EDGE`: cap the destination, leave
the source's own rebalancing alone.

**(c) A `SOURCE`-scoped gate here would silently re-govern the edges already in the
scenario.** §12.4b: *"the tightest gate on any edge out of a source pool is that source's
effective gate, and every looser one is unreachable"* — narrowed by §12.4c to mean the **veto**
is pool-wide while each edge still fires on its own gate. The reference scenario already has
two gated edges out of `growth` at `sourceDrawdownUnder: 0.2`. Adding a third out of the same
pool at a different threshold, `SOURCE`-scoped, changes the effective veto for **all three**,
and the §12.4b warning records what that did on a real plan: an authored multi-year bond
reserve driven to a bond target of **exactly zero, for years**, while the cube went on
reporting the target it wanted.

So the skip rule is authored as: an `EDGE`-scoped gate, on the `growth`-sourced paycheck edge
only, reading `sourceDrawdownUnder` with `drawdownBasis: INDEX` — the flow-neutral series,
because a `BALANCE` basis in decumulation confounds "the market fell" with "we have been
spending this pool", and latches shut forever after the first crash (§20.14). Default **off**;
§15.1 prices it.

**The move year.** The paycheck follows residency, with no lookahead: a full year on the old
calendar, then a sweep-and-top-up triggered by the residency change itself, then the new
calendar. §15.3.

## 6. Paying tax in instalments — the common machinery

Both countries get the same three pieces, differing only in calendar and arithmetic:

1. **`TAX_INSTALMENT_<CC>` events** on the statutory due dates.
2. **A required-payment basis carried in state**, stamped at each settle, because both
   regimes size the instalment from *last year's* return.
3. **A credit at settle**: the settle pays (or refunds) only the true-up, not the whole bill.

The debit reuses `TaxPaymentDebitReducerBase` (`tax-settle-classes.js:1022`) unchanged. That
matters more than it looks: that class already funds a shortfall through `replenishSavings`,
already emits the drawdown tax actions so that selling to pay tax is itself taxed
(`DRAWDOWN_TAX_ACTION_TYPES`, `:1012`), already handles the cross-border escalation, and
already stamps the §988 disposition for paying a bill out of a foreign-currency deposit
(`:1129-1135`). A new debit path that bypassed any of that would produce a believable
untaxed number — which this repo has now found three separate times.

**New state**, written by the settle apply reducers:

```
state.taxBasis[cc] = {
  year,                 // the year settled
  tax,                  // net liability as assessed  (US: after credits, §6654(f))
  agi,                  // US only — selects the 100% / 110% safe harbour
  instalmentBase,       // AU only — adjusted taxable income EXCLUDING net capital gain
}
state.taxInstalmentsPaid[cc]   // reset at each settle, credited against it
```

`taxBasis` is a genuinely new multi-year accumulator, and the trap that applies to it is the
one design 95 §9.3 already hit with the super caps ring: it must **survive** the per-year
field reset, not be zeroed with the YTD buckets.

## 7. United States — §6654

Source on disk: `docs/us-tax/USCODE-2024-title26-subtitleF-chap68-subchapA-partI-sec6654.txt`
(plus `…-sec6621.txt` for the rate and `…-subtitleC-chap24-sec3405.txt` for withholding).

### 7.1 The required annual payment

§6654(d)(1)(A): each of the four required instalments is **25 percent of the required annual
payment**. §6654(d)(1)(B) defines that as *the lesser of*:

- **(i) 90 percent** of the tax shown on the return for the taxable year; or
- **(ii) 100 percent** of the tax shown on the return for the **preceding** taxable year.

§6654(d)(1)(C)(i): if the AGI shown on the preceding year's return exceeds **\$150,000**,
clause (ii) is applied by substituting **110 percent** for 100 percent. (\$75,000 for a
married individual filing separately — §6654(d)(1)(C)(ii).)

This is the "safe harbour": pay 110% of last year's tax in four equal instalments and no
penalty can arise no matter how large this year's liability turns out to be. For a retiree
whose income is portfolio-driven and therefore unknowable in April, the prior-year branch is
the only one that can actually be computed in advance — which is exactly why real people use
it, and why `state.taxBasis.US` is the whole implementation.

### 7.2 Due dates — §6654(c)(2)

| instalment | due |
|---|---|
| 1st | April 15 |
| 2nd | June 15 |
| 3rd | September 15 |
| 4th | January 15 of the following taxable year |

Note the asymmetry: the fourth instalment for year *Y* falls in January of *Y+1*, i.e. two
weeks **after** the `TAX_SETTLE_US` that closes year *Y*. The settle must therefore credit
three paid instalments plus one scheduled-but-unpaid one, or model the fourth as landing
before the settle. The former is correct; the latter is a shortcut that will silently
misstate the December cash position by a quarter of the year's tax.

§6654(h) is the escape from the fourth instalment: file and pay in full by **January 31** and
no addition to tax arises on the 4th required instalment. Worth an authored option, because
it is a real choice a retiree makes.

### 7.3 "Tax" means tax after credits — and that includes the FTC

§6654(f): "tax" is chapter 1 + chapter 2 + chapter 2A **minus** the credits against tax in
part IV of subchapter A of chapter 1, other than §31 (wage withholding). The foreign tax
credit is in that part. For a US citizen resident in Australia this is decisive — the
required annual payment is computed on the liability **net of FTC**, which is the figure the
model already computes as `taxDetail.netLiability` (`tax-settle-classes.js:374`). Sizing
instalments on the gross US tax would have the household paying instalments against a
liability the treaty already extinguishes.

### 7.4 Exceptions worth wiring, and one worth knowing about

- **§6654(e)(1)** — no addition to tax if the year's tax, reduced by the §31 credit, is under
  **\$1,000**. This is the "don't bother" threshold and belongs in the model as a floor below
  which no instalment event fires at all.
- **§6654(e)(2)** — no addition to tax where the preceding year was a full 12 months, the
  individual had **no** liability for it, and was a US citizen or resident throughout.
- **§6654(e)(3)(B)** — the Commissioner may waive the addition for an individual who
  **retired after attaining age 62** in the year or the preceding year, where the
  underpayment was due to reasonable cause. Discretionary, so it cannot be modelled as an
  entitlement, but it is the single most relevant provision to a newly-retired taxpayer and
  it should be noted in the UI rather than silently assumed either way.
- **§6654(d)(2)** — the annualised-income instalment, letting a taxpayer whose income is
  back-loaded pay less early. It is the right answer for a household realising a large gain
  in Q4, and it is explicitly **out of scope** for this design (§13).

### 7.5 The penalty, if it is modelled at all

§6654(a): the addition is the **§6621 underpayment rate** applied to the underpayment for the
period of the underpayment (§6654(b)(2): from the due date to the earlier of April 15 or the
date paid). §6621(a)(2): that rate is the **federal short-term rate plus 3 percentage
points**. The model has no federal short-term rate; the honest mapping is the simulated US
short rate + 3pp, flagged as an approximation in the code comment that uses it.

### 7.6 Withholding is the other way to do this — §3405 + §6654(g)

§6654(g)(1) is the provision that makes withholding special: the §31 credit is **deemed a
payment of estimated tax, an equal part deemed paid on each due date**, unless the taxpayer
establishes the actual dates. So tax withheld from a December IRA distribution is treated as
having been paid evenly across all four quarters, and can cure an underpayment that already
happened.

§3405 supplies the withholding itself: `(a)(1)` periodic payments are withheld as if wages;
`(b)(1)` non-periodic distributions at **10 percent**, electable out under `(b)(2)`;
`(c)(1)(B)` eligible rollover distributions at a mandatory **20 percent**.

Together these are a genuinely better strategy than instalments for a household with a
tax-deferred wrapper: take one distribution late in the year, withhold most of it, owe no
penalty. This design does **not** build it (§13) — but the two provisions are on disk and
cited here because whoever builds the instalment path will be asked "why not withhold?"
within a week, and the answer is "it is better, it is harder, and it needs §3405 wired into
the wrapper distribution path first".

## 8. Australia — Schedule 1, Division 45

Source on disk: `docs/au-tax/TAA-1953/C2026C00393VOL02.txt` (Division 45) and
`…/C2026C00393VOL01.txt` (s 8AAD, the GIC rate). Compilation No. 226, 27 August 2026.

### 8.1 A retiree is, by default, a quarterly payer on GDP-adjusted notional tax

s 45-130(1)(a): *"You are a **quarterly payer who pays on the basis of GDP-adjusted notional
tax** if, at the end of the starting instalment quarter in an income year: (a) you are an
individual who is not an annual payer, a monthly payer or a quarterly payer who pays on the
basis of instalment income."* That is the retiree. The alternative — quarterly instalments
computed as `instalment rate × instalment income` under s 45-110 — is a **choice** the
taxpayer makes (s 45-125(1)(b)), not the default.

Liability itself arises from the Commissioner giving an instalment rate: s 45-15(1)–(2).
The entry and exit thresholds the ATO administers below that (the notional-tax and
instalment-income screens) are **administrative, not statutory**, and are not modelled here —
if they are ever wanted, they need an ATO source fetched by hand first, because `ato.gov.au`
403s every automated fetch (`docs/au-tax/SOURCES.md`).

### 8.2 The amount — s 45-400, and the GDP uplift in s 45-405

s 45-400(2) table: the instalment is **25% / 50% / 75% / 100%** of GDP-adjusted notional tax,
each reduced by the instalments already paid for earlier quarters that year. Four equal
quarters in the ordinary case, and self-correcting when an earlier quarter was worked out on
a different basis.

s 45-405(1)–(3): GDP-adjusted notional tax is notional tax (s 45-325: adjusted tax on
adjusted taxable income for the base year) with the base year's adjusted taxable income
**increased by `1 + GDP adjustment`**, the GDP adjustment being nominal GDP growth over two
calendar years, rounded to a whole percent and **floored at 0%** (s 45-405(3)(b)).

The model has no ABS national accounts series and should not pretend to. **Decided (§15.2):
author it** as `auGdpUplift`, a single scalar, and do not sweep it — the uplift moves only the
*timing* of cash, because the settle trues up exactly (s 45-30), so precision here buys
nothing. Deriving it is not actually available: the model has AU CPI and no real-GDP series,
so a derived figure is CPI plus an authored constant with a new state dependency attached.

**The figure is now sourced: 5% for the 2026-27 income year** (4% for 2025-26), from two ATO
publications captured 16 Sep 2026 — `docs/au-tax/ato-rates/ato-gdp-adjustment-2026-27.txt`
and `…/ato-payg-instalment-calculation-2026.txt` (QC 68098). So `auGdpUplift` defaults to
`0.05` and is no longer a placeholder.

**And one thing that page establishes which the Act does not say out loud:** the GDP
adjustment *"does not affect you if you work out your own instalments (using the rate method)
or pay annually"*. It is an input to the **Commissioner's notified amount** only. That is a
constraint on §10's parameters, not a footnote: when `auInstalmentCadence` is `ANNUAL`, or if
the instalment-rate method of s 45-110 is ever built, `auGdpUplift` must be **inert**.
Applying it there would inflate a figure the ATO never uplifts.

Two statutory overrides exist and both are historical: 2% for 2022-23 (s 45-405(9)) and 6%
for 2023-24 (s 45-405(10)). They are not modelled; they are noted so nobody re-derives them
from a half-remembered news article.

### 8.3 Due dates — s 45-61

s 45-60 defines the instalment quarters as the 1st–3rd, 4th–6th, 7th–9th and 10th–12th months
of the income year. s 45-61(1): the instalment is due **on or before the 21st day of the
month after the end of that quarter** — so for a 30 June income year, 21 October, 21 January,
21 April, 21 July.

s 45-61(2): a **deferred BAS payer** instead has the 28th of that month, except that where
any part of December falls in the quarter's last month the date is the next **28 February**.
That yields the 28 Oct / 28 Feb / 28 Apr / 28 Jul calendar most individuals actually
experience. Author which one applies (`auDeferredBasPayer`, default true for an individual
lodging through an agent) rather than hard-coding either.

An annual instalment is also available — s 45-140(1)(c) requires the most recent notified
notional tax to be **under \$8,000** and the taxpayer to be outside the GST system; it is due
21 October for a 30 June year (s 45-70(2)). Worth supporting as the "small" case, not as the
default.

### 8.4 The structural under-payment: capital gains are not in the base

**s 45-330(1)(a): adjusted taxable income is total assessable income for the base assessment
reduced by "any net capital gain included in that assessable income".** s 45-5(3) states the
same policy in the object clause: the total of the instalments is to be as close as possible
to the year's liabilities *"except so far as the amounts of those liabilities are
attributable to a net capital gain."*

This is not an edge case for this model — it is the central AU cash-flow fact. A retiree
funding spending by realising gains pays instalments computed on a base that **excludes** the
very income that generates most of the liability, and then meets a large balancing payment at
assessment. Modelling the instalments without modelling this exclusion would produce a
smooth, wrong answer that looks better than reality. The exclusion is, in effect, the reason
the AU side still needs a lump at settle and the US side mostly does not.

### 8.5 Varying, and the 85% rule

A taxpayer may choose a varied instalment rate (Subdiv 45-F, s 45-205) or estimate benchmark
tax (s 45-112(1)(b)). Both carry a penalty for guessing low:

s 45-232(1)(b): GIC is payable where **the estimate used is less than 85% of benchmark tax**
for the income year, on the shortfall between the *acceptable amount* (s 45-232(3): the lower
of what the Commissioner would have notified and the cumulative 25/50/75/100% of benchmark
tax) and the actual amount paid.

s 8AAD(1): the GIC rate for a day is the **base interest rate plus 7 percentage points**,
divided by the days in the calendar year; s 8AAD(2) sets the base as the RBA's monthly
average 90-day Bank Accepted Bill yield, on a one-quarter lag table. If the penalty is
modelled, that is the arithmetic, and the simulated AU short rate + 7pp is the honest
substitute for the BAB series.

**The model should not author a variation.** The 85% test compares an estimate against an
outcome the household cannot know, and a simulator that varies optimally every year is
modelling clairvoyance, not a taxpayer. Pay the Commissioner's amount; take the balancing
payment at assessment. If a variation arm is ever built, it must be scored with the GIC on,
or it is free money.

## 9. One mechanism, two calendars

| | US | AU |
|---|---|---|
| basis | prior-year **tax** (§6654(d)(1)(B)(ii)) | prior-year **income excluding net capital gain** (s 45-330(1)(a)), re-taxed |
| uplift | 100%, or 110% above \$150k prior AGI (§6654(d)(1)(C)) | `1 + GDP adjustment`, floored at 0% (s 45-405(3)) |
| schedule | 25% × 4, Apr 15 / Jun 15 / Sep 15 / Jan 15 (§6654(c)(2), (d)(1)(A)) | 25/50/75/100% cumulative, 21st (or 28th) after each quarter (s 45-400(2), s 45-61) |
| credited at | the settle two weeks **before** the last instalment | the settle |
| de minimis | \$1,000 (§6654(e)(1)) | notional tax; annual-payer option under \$8,000 (s 45-140(1)(c)) |
| penalty rate | §6621: short-term + 3pp | s 8AAD: base + 7pp |
| capital gains in base? | **yes** — the basis is last year's whole tax | **no** — s 45-330(1)(a) |

The last row is the substantive difference and it is worth stating plainly: the US
prior-year safe harbour is a *complete* answer (pay 110% of last year and you are safe
however big this year's gain), while the AU instalment regime deliberately leaves capital
gains out and expects a balancing payment. A cross-border household experiences both.

## 10. Parameters

All on the toolset, all sweepable (design 98) — flat keys, no dots (see the optimizer
key-collision trap).

| key | default | meaning |
|---|---|---|
| `spendingPoolEnabled` | `false` | build `spendingUs` / `spendingAu` and the paycheck. Off = today's behaviour, byte-identical. |
| `paycheckCadence` | `ANNUAL` | `ANNUAL` \| `QUARTERLY` |
| `paycheckMarginFraction` | `0` | extra fraction of the period's need |
| `paycheckIncludesTax` | `true` | size the paycheck to cover scheduled instalments too (§5.2) |
| `paycheckGateScope` | `EDGE` | §5.4(b) — `EDGE` caps the destination; `SOURCE` also vetoes the source's rebalancing, and re-governs every other edge out of that pool (§5.4(c)) |

Two knobs this design depends on already exist and are **off** in the reference scenario —
they are not new parameters, but leaving them where they are would hollow out the paycheck:

| existing key | reference value | why §5 needs it |
|---|---|---|
| `drawdownRebalanceWeight` | `0` | §5.3 leg 2 — the whole of "fund the paycheck by selling what is over target". Needs design-61 `targetComposition` stamped or it silently no-ops. |
| `dividendReinvest` | per design 106 | §5.3 leg 1 — with DRIP off, yield lands in the spending pool and the paycheck is cheaper by that much, with no sale and no configuration. |
| `taxInstalmentsEnabled` | `false` | master switch for §6–§8 |
| `usInstalmentBasis` | `PRIOR_YEAR` | `PRIOR_YEAR` \| `NONE`. The 90%-of-current branch is not modelled (§13). |
| `usJanuary31Election` | `false` | §6654(h): file and pay by 31 Jan, skip the 4th instalment |
| `auInstalmentCadence` | `QUARTERLY` | `QUARTERLY` \| `ANNUAL` (s 45-140 conditions are the author's to assert) |
| `auDeferredBasPayer` | `true` | s 45-61(2) due dates rather than s 45-61(1) |
| `auGdpUplift` | `0.05` | s 45-405 GDP adjustment — the ATO's 2026-27 figure (§8.2, §15.2). **Inert** when `auInstalmentCadence` is `ANNUAL`. |
| ~~`taxPenaltyModelled`~~ | — | **withdrawn.** Paying to the safe harbour means no underpayment exists to charge; see build order item 5. |
| `auGdpUplift` | `0.05` | s 45-405 GDP adjustment (§8.2, §15.2), in STATE as well as params |
| `auNotionalTaxRate` | `0.25` | the flat rate the base year's income is re-taxed at for s 45-325 notional tax — a stated simplification, absorbed by the balancing payment |
| `auDeferredBasPayer` | `true` | s 45-61(2) dates (28th) rather than s 45-61(1)'s 21st |

Both master switches default **off**, and with both off not one cent moves. That is the
condition for landing phase 1 without a re-gold.

## 11. State, telemetry, journal

- `state.taxBasis[cc]`, `state.taxInstalmentsPaid[cc]` — §6.
- `state.liquidityPools.spendingUs / spendingAu` — the ordinary pool cube, so cover-years
  for the float appear next to cover-years for the reserve rather than inside them.
- New actions: `US_TAX_INSTALMENT_DEBIT`, `AU_TAX_INSTALMENT_DEBIT` (family
  `TAX_PAYMENT_DEBIT`, so the existing "Tax Paid by Year" report picks them up with no
  change), `SPENDING_REFILL_APPLY`.
- **One entry per reducer**: `AU_TAX_SETTLE_APPLY` is already double-counted by
  `getActions(type)` because two reducers consume it. Any new report over these actions must
  filter on `entry.reducer` before summing.
- The metric that justifies the whole design: **count of `REPLENISH_SAVINGS` firings per
  year**, which after §4.1 means "unplanned sales", and should fall to ~0 in good years.

## 12. Test plan

Unit:

1. Paycheck fills to `S` and the float then drains monthly with **no** `REPLENISH_SAVINGS`
   in between; assert on the absence, with a working-detector control (a scenario where the
   paycheck is deliberately too small must still fire it) — the absence-test trap from the
   offset study.
2. `S` includes the period's scheduled instalments when `paycheckIncludesTax` is on.
3. US: prior-year tax \$X with prior AGI under and over \$150k ⇒ four instalments of
   `0.25X` and `0.275X` (§6654(d)(1)(B)(ii), (C)(i)).
4. US: the 4th instalment falls in January **after** the settle, and the settle credits three
   (§7.2). This is the one most likely to be got wrong.
5. US: instalments are computed on the FTC-net liability, not the gross (§7.3).
6. US: prior-year tax under \$1,000 ⇒ no instalment events at all (§6654(e)(1)).
7. AU: the base excludes the prior year's net capital gain (s 45-330(1)(a)) — a scenario
   with a large realised gain must show instalments unchanged and the settle payment large.
   This is the AU test that matters.
8. AU: the 25/50/75/100% cumulative table (s 45-400(2)) and both due-date sets (s 45-61(1)
   vs (2), including the December→28 February rule).
9. Both: settle debits only the true-up; an over-payment refunds to the transaction account.
10. Move year (§15.3): a mid-year residency change sweeps the residual spending pool across
    the border, tops the new pool to target, fires **no** `REPLENISH_SAVINGS`, and does not
    double-fund — total cash raised in the move year is ~one year of spend, not two.
11. First AU year (§15.4): no prior-year AU basis ⇒ zero instalments and the whole year's AU
    tax at the first AU settle. Asserting the lump is the point; it is the law, not a defect.
12. Death (§15.4): `taxBasis.US` **survives** and the survivor's next instalments are computed
    from it; `taxBasis.AU`'s dead key is **dropped**, not zeroed (design 68 Gap 5's predicate).
13. Last survivor: a scheduled-but-unfired instalment is not credited by
    `_flushTerminalTaxSettles`.
14. Both off ⇒ the golden fixtures are byte-identical.

Whole-state goldens: a new fixture per cadence arm. Expect the phase-2 re-gold to move every
existing fixture, because adding events re-resolves queue ties everywhere (design 100 §9
measured \$391k of movement from a change with no economic content).

## 13. What this deliberately does not do

- **The annualised-income instalment**, §6654(d)(2), and its 22.5/45/67.5/90% schedule. It
  is the right tool for a Q4 realisation and it needs a within-year running tax computation
  the model does not have.
- **Withholding at source**, §3405 + §6654(g) (§7.6). Better than instalments for most
  households with a wrapper; strictly more work; cited so the next reader does not have to
  find it.
- **Varying an AU instalment** (Subdiv 45-F). §8.5 explains why an optimally-varying
  taxpayer is clairvoyance, not modelling.
- **State estimated tax.** `STATE_TAX_SETTLE_APPLY` keeps its lump. Every state has its own
  rules and none of them are on disk.
- **ATO administrative entry/exit thresholds** (§8.1) — not statutory, not sourced.
- **Choosing the paycheck size.** Guardrails, percent-of-wealth and the spending bands
  (designs 89, 96) decide *how much*; this design only decides *from where and on what day*.

## 14. Build order

1. **Spending pools** — config-only, both switches off. Lands with no golden movement.
   **Done (16 Sep 2026).** It does not deliver what defect (b) promised — see the note in
   §2.1 — but it lands the instrument and costs essentially nothing. Two things it surfaced,
   both of which govern every later phase:
   - **Claims are exclusive** (`liquidity-graph.js:625`), so the transaction accounts must
     *leave* `cash`; they cannot be claimed twice. Give the two pools distinct `spendOrder`s
     (0 and 1) — equal ones are a tie, and a compiled drawdown order settled by a tie is the
     event-queue hazard in another costume.
   - **A single run of a stochastic plan is not an A/B.** See §14.1.
2. **`SPENDING_REFILL`** — the paycheck. **Done (17 Sep 2026)**, and it needed no re-gold:
   the schedule is gated on `paycheckEnabled`, which defaults off, so a plan that has not
   opted in gains no event and no queue tie moves. 6641 unit tests pass; PAY-1..PAY-9 cover
   the new seam. Three things the build changed from what §5.1 assumed:
   - **The cube write-back had to be narrowed.** Reusing the one evaluator is right, but the
     cube carries four per-calendar-year series — the market observation, the compounded
     return index and its peak, the trailing balance high, and the gate dwell streaks — and
     restamping any of them on a paycheck date hands a later year's gate a mid-year sample
     of the year it is deciding in. That is §20.2's clairvoyance defect by a new road. A
     paycheck now carries those forward and writes only the live metrics plus its own flow
     record, accumulating rather than replacing (a US paycheck shares 1 January with the US
     advance).
   - **The event and the action need different names** (`PAYCHECK` → `SPENDING_REFILL`). The
     design-71 payload scan reads any `{ type: 'X', ... }` literal as an emission of action
     X, so one name makes an `EventSeries`' `interval`/`month`/`order` read as undeclared
     fields of the action. The repo's own convention already separates them
     (`PERIOD_ADVANCE_US` → `US_PERIOD_ADVANCE`).
   - **`EventBuilder` could not say "1 July".** `SimulationAdapter` has always honoured
     `month`/`day` on an `EventSeries`, but the builder exposed no accessor, so the only
     reachable anchors were the interval snaps — all of which land on period ENDS, and an
     income year starts. Two one-line accessors.

   Fixes (a) in the years the calendar applies to; the pre-move years wait on §15.3.

2b. **Residency-following — done the same day.** §15.3's note above has what was built.
   Measured against an honest control (the phase-1 structure, no float targets — the
   phase-2a control was confounded, see below): `REPLENISH_SAVINGS` **537 → 81**, pre-move
   13.5/yr → 3.0, post-move 12.0 → 3.7, terminal wealth **+10.4%**.

   **Do not quote that +10.4% as the value of a paycheck.** Attribution: tax is *higher* in
   the paycheck arm and FX fees are a flat \$15, so neither explains it. The difference is
   almost entirely superannuation, and the direct count says why — the control makes **49**
   `SUPER_WITHDRAWAL_EARNINGS_TAX` withdrawals and the paycheck arm makes **zero**. A
   paycheck executes as a pool flow, and a pool flow's draw is SCOPED to the source pool's
   claims; the just-in-time top-up walks the whole compiled sequence and falls through into
   the wrappers whenever the earlier pools are dry. **The arms differ in what may be sold,
   not only in when.** That is the confound §18.6 warns every pool study about. A cadence
   measurement needs a control whose draw is scoped the same way, or the wrapper raid
   dominates it.
   ~~*Before* measuring anything, turn on `drawdownRebalanceWeight`~~ — **withdrawn.** It is
   inert in any plan with a sleeve-narrowed graph (§5.3 leg 2), so there is nothing to turn
   on. The sleeve policy is `spendOrder`.
3. **`state.taxBasis` + the settle stamp** — **Done.** No behaviour change: the goldens moved
   by exactly nine new bookkeeping fields and not one balance. Two things it surfaced:
   - **The refund had to be capped at the instalments paid.** A settle that refunds
     `tax − withheld − instalments` whenever that is negative also starts refunding
     over-WITHHOLDING, which an earlier decision deliberately clamps to zero (the comment at
     the debit chain says so). Uncapped, it moved a golden's terminal wealth by **+\$316k** —
     caught because the first regold was compared against git rather than accepted. Capping
     the refund at the instalment portion keeps every existing scenario byte-identical and
     leaves the withholding clamp to its own future decision.
   - The AU basis is **per person** and the US one is **one household record**, so they take
     opposite paths on death (§15.4).

4. **Instalment events, both countries.** **Done.** Two defects found only by running it:
   - **`ScenarioCompiler` de-duplicates `EventSeries` by TYPE.** Four quarterly series sharing
     one type collapse to one, and only the last survives — measured, it put every US
     instalment on 15 January. Each quarter needs its own event type. A single series with a
     `quarterly` interval cannot express either calendar anyway: neither is evenly spaced
     (US Apr→Jun is two months, AU Oct→Feb is four).
   - **The fourth instalment falls after the settle that resets the counter**, in both
     regimes — 15 January for a 31 December US year, 28 July for a 30 June AU one. Fired
     there it reads the NEW year's basis against a zeroed running total and pays a full year
     at once. The fix is the one the statute already provides: **§6654(h)** discharges the
     fourth instalment when the return is filed and paid in full by 31 January, which is what
     a 31 December settle does. Three in-year instalments keep their exact statutory
     amounts (25/50/75 of the required annual payment) and the settle trues up the rest.
   Fixes (c).
5. ~~**Penalties** (§7.5, §8.5)~~ — **CLOSED, not built (17 Sep 2026).** Building it would be
   dead code, and the reason is the design itself:

   - **US.** §6654(a) is an addition to tax on an *underpayment of a required instalment*.
     This model computes every instalment from §6654(d)(1)(B)(ii)'s prior-year branch and pays
     it in full — that IS the safe harbour, so by construction no underpayment exists. The only
     way to miss one is to run out of cash, and that already fires `OUT_OF_FUNDS`, which is a
     larger event than a penalty and is modelled properly.
   - **US, the fourth instalment.** §6654(h) discharges it when the return is filed and paid in
     full by 31 January, which is what a 31 December settle does (see the build-order note on
     item 4). No addition arises on it either.
   - **AU.** The GIC provisions reachable here are s 45-230 and s 45-232, and **both are about
     VARYING** — a varied instalment rate, or an estimate of benchmark tax below 85% of the
     real figure. §8.5 decided not to author a variation, on the ground that a simulator which
     varies optimally every year is modelling clairvoyance. With no variation there is no
     shortfall for the charge to attach to. s 45-80's charge is for paying LATE, which this
     model cannot do: it pays, or it is insolvent.

   So the penalty machinery would be reachable only in states the model already reports more
   severely. `taxPenaltyModelled` is withdrawn from §10 rather than shipped as a switch that
   turns on nothing. If a variation arm is ever built (§8.5), the GIC must be built with it —
   an unvaried-vs-varied comparison with the charge switched off is free money, and that is the
   one place this reasoning stops holding.

### 14.1 Every A/B on a stochastic plan needs the stochastics off, or common random numbers

Found the hard way in phase 1, and it will bite every later phase the same way.

A plan authored with `randomSeed: null` and `equityReturnStochastic` /
`inflationStochastic` / `propertyReturnStochastic` / `yieldCurveStochastic` all on is **one
random path per run**. Any change that alters the number or order of RNG draws lands the run
in a different world, and the terminal spread swamps anything this design does: phase 1's
first before/after read as a **6.5× change in terminal net worth**, which was entirely path
divergence. The tell was that the two runs did not share a spend line — their monthly
expense levels at the horizon differed by two-thirds, i.e. two different inflation paths.

So: switch the four flags off for a mechanism A/B, or go through the design 100 paired
machinery with common random numbers. And run the two controls first — the same file twice,
and an unmodified JSON round-trip — so the harness is cleared before the variant is blamed.

After phase 2, run the §15.1 grid (A monthly-JIT / B annual-ungated / C annual-gated) before
committing to a default cadence. Phase 2 is the first phase whose *direction* is unknown —
1–4 are all strictly more realistic, while annual-vs-monthly has a measured sign only after
that grid.

## 15. Decisions (all four questions answered, 16 Sep 2026)

### 15.1 The skip rule is authored, defaults off, and is priced by a three-arm grid

The question was framed as "does the skip rule pay". That is the wrong frame, and the right
one only became visible once the paycheck existed:

**An annual paycheck taken on 1 January of a crash year raises a full year of spending at the
bottom, in one transaction.** Twelve just-in-time sales average across the year; one annual
sale does not. So annual cadence *without* a skip rule is a genuine risk increase over
today's behaviour, and the skip rule is what pays for it. The two questions are not
separable.

Designs 97 §19/§20 closed the gate question three ways, and the reason they were right is
better understood now: the crash-year equity seller is **the rebalancer, not the spend walk**,
and a rebalance veto stops crash-year equity sales perfectly while raising failure ~6 points
(it spends the reserve instead). Changing the paycheck's cadence does not change who sells.

So: **author the gate** — it is zero new code, the existing `gate` on a flow edge — default it
**off**, and price it with one paired grid (design 100):

| arm | cadence | reserve-sourced edge |
|---|---|---|
| A | monthly JIT (today's behaviour) | n/a |
| B | `ANNUAL` | ungated |
| C | `ANNUAL` | gated on `sourceDrawdownUnder`, `drawdownBasis: INDEX` |

If C ≈ B, annual cadence is a free realism fix and the gate stays off forever. If B is worse
than A and C is not, the gate is load-bearing here in a way it was not in §19/§20 — because
there was no single funding moment for it to attach to. Either result is worth having, and it
is one run, not a programme.

### 15.2 `auGdpUplift` is authored — and it matters far less than it looks

The uplift (s 45-405(3)) is nominal GDP growth over two calendar years, whole percent, floored
at 0%. The two statutory overrides on disk give the scale: 2% for 2022-23 (s 45-405(9)), 6%
for 2023-24 (s 45-405(10)).

Deriving it is not available: the model carries AU **CPI** (`cpiAccumulator.AU`) and no
real-GDP series at all, so a "derived" uplift is CPI plus an authored real-growth constant —
an authored number wearing a costume, with a new state dependency for nothing.

**The decisive point: the uplift affects only the TIMING of cash, never the total tax.** The
settle trues up exactly — s 45-30 credits the instalments and the balancing payment is the
remainder — so a two-point error shifts a few thousand dollars between quarters and the
assessment, and nothing else. `auGdpUplift` is therefore a single authored scalar and is
**not** a sweep axis. Anyone who puts it on a grid is measuring rounding.

**Sourced and closed, 16 Sep 2026.** `auGdpUplift` defaults to **0.05** — the ATO's GDP
adjustment for the 2026-27 income year, with 4% for 2025-26. Two independent ATO publications
agree, both on disk: the Software Developers statement of formula
(`docs/au-tax/ato-rates/ato-gdp-adjustment-2026-27.txt`, transcribed — that page has almost no
body text and hangs on fetch) and QC 68098
(`…/ato-payg-instalment-calculation-2026.txt`, OCR of a hand-saved PDF kept beside it, because
the print-to-PDF carries no text layer). The substituted-accounting-period split in the first
source does not bite: this household's AU income year is the ordinary 1 July – 30 June.

The same capture added a constraint the Act does not state — the uplift applies to the
Commissioner's notified **amount** only, never to the rate method or to an annual payer
(§8.2). `auGdpUplift` must be inert when `auInstalmentCadence` is `ANNUAL`.

### 15.3 The move year: full year on the old calendar, then sweep-and-top-up at the move

The paycheck follows **residency** (§5). Three candidate rules for the move year:

- *A full year on each calendar* raises roughly two years of spending inside one year, selling
  a year early and idling the proceeds in two currencies. Rejected on cost.
- *A part-year US paycheck* requires the 1 January paycheck to know the move date, i.e. to
  read a scheduled event ahead of time. Workable, but it is the exact shape that has already
  produced a defect here — a config field read at build time, before `ScenarioLoader.load()`
  has run. Rejected on fragility.
- **Adopted:** no lookahead at all.

  1. **1 January of the move year** — the US paycheck fires normally, for a full year.
  2. **At the residency change** — sweep the residual US spending pool into AUD **and top the
     AU pool up to its full target**. One off-cycle paycheck, triggered by the move rather
     than by the calendar.
  3. **The following 1 July** — the normal AU annual paycheck, and every year after.

This is also what households actually do: you move your cash when you move. The only cost is
an FX round trip on the few months of USD that got swept — real, small, and already modelled
correctly, because the sweep is an `INTL_TRANSFER` and realises its §988 disposition.

> **Built 17 Sep 2026, and it needed no move-year trigger at all.** Two things replaced it,
> and both are simpler than what this section proposed:
>
> - **`whenResident` on a pool's size spec.** The float a cross-border household needs is a
>   fact about where it lives — a year of AUD in Australia, nothing in the account left
>   behind — and no other mode could say it, because every one of them resolves to the same
>   number for the whole run. It resolves to **0**, never null, when not resident: null means
>   "sizes nothing" and would leave the sweep with no demand to read, while 0 is a real
>   instruction to hold nothing here. That one primitive makes "which float wants money"
>   something the graph states rather than something the author guesses, and the sweep,
>   the top-up and the hand-over all fall out of it.
> - **`order: 1` on the paycheck series.** `CHANGE_RESIDENCY` is order 0 on 1 July; the
>   paycheck at order 1 runs after it, sees the new residency, and fires. The "off-cycle
>   paycheck triggered by the residency change" and the first ordinary AU paycheck are the
>   same firing. Being after an order-0 event is a strict comparison, not a tie-break, so it
>   does not lean on the queue's ordering of equal keys. It also puts the paycheck after the
>   advance has inflated the spend line, so a `YEARS_OF_SPEND` target sizes the year AHEAD.
>
> `paycheckCalendar` is retired: both income-year starts are scheduled and each handler
> answers only its own residency, so the pair hands over by itself.
>
> **A move that does not land on an income-year start** leaves the new float waiting until the
> next one. Left open deliberately — it cannot happen on a 1 July move, and closing it
> speculatively means a second trigger whose only test is a scenario nobody runs.

It also closes a trap the part-year rule would open. A September move funded Jan–Dec leaves
~4 months of money and 10 months until 1 July: the shortfall fires `REPLENISH_SAVINGS`, which
§4.2 has just promoted into the "the plan failed" signal. Manufacturing that signal out of a
bookkeeping choice would poison the one metric this design adds.

### 15.4 Residency needs no rule; death needs two, and they point opposite ways

**Residency change — nothing to decide.** The US settle suppresses only on
`state.usPersonHousehold === false` (`tax-settle-classes.js:265`), never on residency. For a
US-citizen household the US return is filed for life, so the 4th instalment for year *Y*,
due 15 January of *Y+1*, survives a move intact.

The real consequence is on the AU side and it is a feature, not a defect: **in the first AU
year there is no prior-year AU basis, so instalments are zero and the whole first AU year's
tax arrives as one lump at the first AU settle.** That is the law — liability arises only when
the Commissioner gives an instalment rate (s 45-15(1)–(2)), and he cannot until there has been
an assessment. Consequence for this design: **the move year carries the single largest tax
cash-flow event in the run**, and §5's paycheck must be sized for it. Do not "fix" it.

**Death — the two countries diverge, because the model assesses them differently.**

- `taxBasis.US` is **one household record**: US tax is assessed MFJ and stamped once per
  settle (`tax-settle-service.js:344`, `:150`). It must **SURVIVE** a death and be re-based at the
  next settle, which will be a single-filer return (`usFilingSingle` flips once
  `state.deceased` is non-empty — `period-advance-classes.js:54`). Dropping it would leave the
  survivor with no basis, hence no instalments, for a whole year.
- `taxBasis.AU` is **per person**: **drop** the dead key, with design 68 Gap 5's predicate
  exactly — in `state.deceased` and absent from `state.people`
  (`tax-settle-classes.js:479-497`). Zeroing rather than dropping is the specific bug Gap 5
  fixed, and a lingering `{deadKey: 0}` can resurrect a spurious return.
- **Last survivor:** Gap 2's `_flushTerminalTaxSettles` closes the final year's settles. A
  scheduled-but-unfired instalment must **not** be credited by that flush — it was never
  paid. This is the one place where "instalments scheduled" and "instalments paid" must not be
  allowed to collapse into one number, which is why §6 carries `taxInstalmentsPaid` rather
  than deriving it.

### 15.5 Paired RNG streams — BUILT, and §15.1 is answered (17 Sep 2026)

§15.1's grid could not be run by seed-matching, and the diagnosis is sharper than "the arms get
different random numbers". Tracing every draw in both arms: **the same values, in the same
order** — 1,862 of them on seed 1 — and still divergent, because from draw 484 the same value
lands on a different DATE. A z that is 2035's equity shock in one arm is 2036's in the other.
Where the arms reach different years at all, even the counts part company. The failure is one
of ALIGNMENT, invisible to any check that compares values.

**`sim.rngStream(label, year)`** removes the coupling by construction: the generator's state is
a hash of (seed, label, year), so a draw is a pure function of those three and nothing another
process does can shift it. All six drawing processes are wired to it — equity,
equity-bootstrap, inflation, property, fx, yield.

Off by default (`rngStreams`). Turning it on changes the path a given seed produces, so it is a
property of a STUDY, not a better setting: on for every arm of a comparison, or none. With it
off nothing moves — every golden is unchanged.

Verified: the same two arms now share an inflation path identical to four decimals for 44
years, where before they read 4.87 against 6.37 at the horizon.

**The grid, 12 truly-paired paths:**

| arm | mean | median | failures |
|---|---|---|---|
| A monthly JIT | 25.7M | 9.6M | 2/12 |
| B annual, ungated | 29.7M | **16.2M** | 3/12 |
| C annual, gated | 29.7M | 16.2M | 3/12 |

B beats A in **8/12**, asymmetrically — wins of +15.6M, +14.3M, +8.1M, +6.3M against losses no
larger than 566k.

**§15.1 is answered, and the answer is no.** Arms C and B are identical in 11 of 12 paths. The
structural difference this design hoped might revive the skip rule — a single funding moment
for the gate to attach to — does not revive it. Designs 97 §19/§20 stand, now on this design's
own evidence.

What remains is the tail: the paycheck wins the middle (median +6.6M, two-thirds of paths) and
costs one extra failure in twelve. 3 against 2 is not a significant difference; it is the right
question to take to a real Monte Carlo, which is now possible because the arms can finally be
paired.

## 16. Still open

Nothing blocking. Two things deferred by decision, recorded so they are not rediscovered as
questions:

1. ~~Whether arm C of §15.1 changes the §19/§20 conclusion.~~ **Answered, §15.5: it does not**
   — C and B are identical in 11 of 12 paired paths.
2. **The scope-matched result stands, and is the strongest evidence so far.** Given paycheck
   edges mirroring the whole spend walk — the same permission to sell the same accounts in the
   same order — the paycheck still takes 1 superannuation withdrawal against the cascade's 49,
   pays *less* tax, and ends **+9.8%**. The mechanism is timing: one annual draw taken just
   after the refill flows have topped up the early pools finds money there, where twelve
   monthly draws exhaust them and fall through. That is a real claim about cadence and it
   deserves the tail measurement §15.5 is waiting on.

(The `auGdpUplift` source, open when §15 was written, was closed the same day — see §15.2.)

**A standing maintenance item, not an open question:** `auGdpUplift` is a *per-income-year*
figure the ATO re-publishes every June. A run spanning forty years applies one authored
constant to all of them, which is the right simplification — the settle trues up, so the
error is timing-only (§15.2) — but the default should be refreshed when the scenario's start
year moves, and the source note in `docs/au-tax/ato-rates/` records which year it came from
for exactly that reason.
