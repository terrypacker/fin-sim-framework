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

### 4.1 The floor moves down, not up

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

A new scheduled event, `SPENDING_REFILL`, authored alongside `MONTHLY_EXPENSES` in the
toolset schedule list (`src/scenarios/toolsets/us-retirement-toolset.js:748-757`).

**Cadence.** `ANNUAL` (default) or `QUARTERLY`. Annual is what advisors actually run and it
maximises the option value of the skip rule below; quarterly halves the idle cash and is
closer to what most people tolerate. Both are one parameter, and the pair is the natural A/B
arm (§12).

**Date.** The start of the residency country's income year, so the paycheck and the tax
calendar share a boundary: 1 January while US-resident, 1 July while AU-resident. On a
residency change the schedule follows the residency — the household's year is the year it is
taxed on.

**Amount.** Fill the spending pool to its target `S`, where

```
S  =  (spend for the coming period)  +  (instalments scheduled in the coming period)  +  margin
```

with `margin` an authored fraction (default 0). This is the whole point of building the
paycheck and the instalments together: the retiree who transfers a year's money once a year
transfers the tax with it, and a paycheck sized on living costs alone would guarantee a
second, unplanned sale every quarter.

**Source.** The existing flow machinery, in priority order, all of it already expressible:

1. accumulated cash yield (dividends and coupons not reinvested — design 106 decides which
   those are; if `dividendReinvest` is off, this leg is free and happens with no sale at all);
2. rebalancing-overweight sales (executor 1 — sell what is above target, which is how
   "sell high" stays emergent rather than being a timing rule);
3. the reserve/buffer pools, in `spendOrder`.

**The skip rule.** A `gate` on the reserve-sourced edge — the same `sourceDrawdownUnder` /
`drawdownBasis: INDEX` shape already in use — lets the plan say *this year I take the paycheck
from the reserve instead of from the portfolio*. Authored, defaulting **off**. It is not
optional scaffolding: an annual paycheck concentrates a year of selling into one day, so
`ANNUAL` without a skip rule is a risk increase over today's twelve averaged sales, and the
gate is what pays for it. §15.1 has the reasoning and the three-arm grid that prices it.

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
| `paycheckIncludesTax` | `true` | size the paycheck to cover scheduled instalments too (§5) |
| `taxInstalmentsEnabled` | `false` | master switch for §6–§8 |
| `usInstalmentBasis` | `PRIOR_YEAR` | `PRIOR_YEAR` \| `NONE`. The 90%-of-current branch is not modelled (§13). |
| `usJanuary31Election` | `false` | §6654(h): file and pay by 31 Jan, skip the 4th instalment |
| `auInstalmentCadence` | `QUARTERLY` | `QUARTERLY` \| `ANNUAL` (s 45-140 conditions are the author's to assert) |
| `auDeferredBasPayer` | `true` | s 45-61(2) due dates rather than s 45-61(1) |
| `auGdpUplift` | `0.05` | s 45-405 GDP adjustment — the ATO's 2026-27 figure (§8.2, §15.2). **Inert** when `auInstalmentCadence` is `ANNUAL`. |
| `taxPenaltyModelled` | `false` | §6621 / s 8AAD charges on any shortfall |

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

1. **Spending pools** — config-only, both switches off. Lands with no golden movement and
   immediately fixes defect (b): the reserve's cover stops including groceries.
2. **`SPENDING_REFILL`** — the paycheck, annual and quarterly, plus dropping the floor.
   First re-gold. Fixes (a).
3. **`state.taxBasis` + the settle stamp** — no behaviour change, no instalments yet; it
   only starts remembering. Landing this alone means step 4 has a year of basis by the time
   it runs.
4. **Instalment events, both countries.** Fixes (c).
5. **Penalties** (§7.5, §8.5), off by default, only if a study needs them.

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

It also closes a trap the part-year rule would open. A September move funded Jan–Dec leaves
~4 months of money and 10 months until 1 July: the shortfall fires `REPLENISH_SAVINGS`, which
§4.1 has just promoted into the "the plan failed" signal. Manufacturing that signal out of a
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

## 16. Still open

Nothing blocking. Two things deferred by decision, recorded so they are not rediscovered as
questions:

1. Whether arm C of §15.1 changes the §19/§20 conclusion. That is a measurement, scheduled
   after phase 2, not a design question.

(The `auGdpUplift` source, open when §15 was written, was closed the same day — see §15.2.)

**A standing maintenance item, not an open question:** `auGdpUplift` is a *per-income-year*
figure the ATO re-publishes every June. A run spanning forty years applies one authored
constant to all of them, which is the right simplification — the settle trues up, so the
error is timing-only (§15.2) — but the default should be refreshed when the scenario's start
year moves, and the source note in `docs/au-tax/ato-rates/` records which year it came from
for exactly that reason.
