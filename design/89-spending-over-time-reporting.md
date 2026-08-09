# 89 — Spending over time: what the plan actually costs

**Status** (2026-08-09): **PROPOSED.** No code written. Section 3 is a measurement, not a
proposal — it was taken before the design and is what the design is shaped around.

The ask: a chart like design 82's allocation band, but for **spending** — categories stacked,
over the plan. The proposed first cut was "spending is every debit from every account,
categorised as tax / monthly expenses / property expenses / other".

**That definition does not survive contact with the journal, and the categories are not
currently recoverable.** Measured on a real plan, roughly **two fifths of all account debits
are not spending at all**, one action type is journaled **three times** so the obvious sum
triple-counts, and the three expense categories the ask names are emitted as **one
indistinguishable action type**. None of that is a reason not to build it. All of it is a
reason to write down the definition before the chart, which is what this doc is.

Design 82 is the **stock** side of this question — what you own, over time. This is the
**flow** side. They are siblings, not phases: 82 samples state, this reads the journal, and
§7 is the invariant that makes them agree.

---

## 1. Why this is worth building

A net-worth line hides the shape of the plan (82 §1). A spending line hides something
different and more actionable: **where the money goes, and how that mix moves.**

Three questions this answers that nothing today does:

- **What fraction of lifetime outflow is tax?** The optimiser scores after-tax net worth, and
  the tax designs (52, 77, 83, 84) each move a lever, but nobody can point at a chart and say
  "tax is N% of everything this plan spends, and it peaks in year Y".
- **When does the cost of the plan change shape?** Housing costs, care costs and tax do not
  move together. A plan whose spending is 30% tax at 60 and 55% tax at 75 is a different plan
  from one that is flat, and the levers that fix it are different.
- **Did the household actually get what it was budgeted?** §5 — the realized debit is capped
  at the account balance, so a plan in trouble draws as *spending less*, not as *going short*.
  That is precisely backwards, and it is the single most decision-relevant thing on the chart.

---

## 2. The definition: outflow that crosses the household boundary

> **Spending is money that leaves the household balance sheet.** Not "a debit".

A debit is a *movement*; spending is a *departure*. The difference is the whole design. Moving
cash from a brokerage to a savings pool debits the brokerage and is not spending by any
definition a person would recognise — and it is the single largest category of debit in a
decumulating plan, because that is what decumulation *is*.

The operational test, and why it is a cross-check rather than the definition:

**Netting test** — a transfer has a matching credit inside the same journal entry; a spend
does not. This self-classifies the transfer families correctly and costs nothing to compute.
It is not sufficient, because two things pass it and are still not spending:

- **Revaluation.** A market mark-down is a lone negative balance delta with no credit anywhere
  (§3, `REVALUE_ASSET_APPLY`). It is not a cash flow at all. Under the netting test alone **a
  market crash renders as a spending spike**, which is the worst failure this chart could have.
- **Debt principal.** A mortgage payment debits cash *and* debits the loan (§4). Both legs are
  negative, so netting keeps both, and the payment is double-counted — while the part of it
  that is genuinely spending (interest) is a minority of one leg.

So: **classification is an explicit allowlist of action types, and the netting test is the
audit that catches an action type nobody classified.** That split is deliberate — the
allowlist is what the chart means, the audit is what stops the chart going quietly wrong when
a future design adds an action type. §7 makes the audit an invariant.

---

## 3. What "all debits" actually contains — measured

Every negative balance delta on a real multi-country plan, by action type, as a share of the
naive total. Figures are **shares of the debit total**, not amounts, and are reproduced by the
probe in §10.

| action type | share | is it spending? |
|---|---:|---|
| `EXPENSE_DEBIT` | 30.0% | **yes** — but it is four categories in a trench coat (§6) |
| `AU_TAX_PAYMENT_DEBIT` | 26.4% | **yes** |
| `REPLENISH_SAVINGS` | 18.6% | **no** — internal transfer, drawdown filling the cash pool |
| `HOLDING_TRANSACT` | 13.4% | **no** — internal, debits and credits tie to the cent |
| `US_TAX_PAYMENT_DEBIT` | 4.9% | **yes** |
| `REVALUE_ASSET_APPLY` | 1.9% | **no** — a market mark, not a cash flow |
| `LOAN_PAYMENT_APPLY` | 1.7% | **partly** — see §4; ~93% of it is not spending |
| `US_HOUSE_SALE_APPLY` | 1.0% | **no** — the mortgage extinguished from sale proceeds |
| `IRA_RMD_APPLY` | 1.0% | **no** — internal; the tax on it is a separate action |
| `K401_TO_IRA_CONVERSION_APPLY` | 0.7% | **no** — internal |
| `ROTH_CONVERSION_APPLY` | 0.3% | **no** — internal; the tax is separate |
| `STATE_TAX_PAYMENT_DEBIT` | 0.1% | **yes** |
| `REBALANCE_TO_TARGET_APPLY` | 0.0% | **no** — rounding dust (design 61 D1) |

**Genuine household outflow is ~61.5% of the naive total. The naive definition overstates
spending by about 63%.** The breakdown of the missing 38.5%: internal transfers 34.0%,
revaluation 1.9%, debt principal ~1.8%, dust ~0%.

Three things in that table are worth more than their share:

- **`REPLENISH_SAVINGS` + `HOLDING_TRANSACT` = 34%** and both are pure internal movement.
  `HOLDING_TRANSACT`'s debits and credits agree to the cent, which is a useful smoke test that
  the netting audit is working at all.
- **`REVALUE_ASSET_APPLY` at 1.9%** is the one that would embarrass the chart. It is small in
  aggregate and arbitrarily large in the year a shock lands — which is exactly the year someone
  will screenshot.
- **`AU_TAX_PAYMENT_DEBIT` is largely paid out of a US-domiciled brokerage.** So *whose tax it
  is* and *which country's account paid it* are different facts. **Category must come from the
  action; currency must come from the account.** Reading either off the other is wrong.

---

## 4. The mortgage double-count

`LOAN_PAYMENT_APPLY` writes two negative deltas in one entry: the cash account falls by the
payment, and the loan account falls by the principal retired. Loan accounts carry a **positive
balance that counts negative in net worth** (design 54), so "the debt got smaller" is recorded
as a debit.

Both legs are negative, so any rule that sums negative deltas counts the payment roughly
twice. Measured across the plan's whole loan history, `LOAN_PAYMENT_APPLY`'s debit total splits
about **52% cash leg / 48% loan leg** — and within the cash leg, **interest is ~6.9%**, the
rest being principal.

So of everything `LOAN_PAYMENT_APPLY` contributes to the naive total, **only about 3.6% is
spending.** The rest is either a balance-sheet transfer (cash → home equity) or a duplicate of
it.

> This is not an argument that debt service is cheap. It is an argument that **the interest is
> the expense and the principal is savings**, and a chart that says otherwise will make a
> leveraged plan look like it is spending far more than it is — directly against design 86's
> finding that the loan is a cheap option worth holding.

An interest-offset arrangement makes this sharper: with the offset filled, the interest leg
goes to zero and the entire payment is principal, so **100% of the debit is non-spending**
while the chart would draw it as the household's second-largest cost.

---

## 5. Intent vs realized, and why realized alone lies

`ExpenseDebitReducer` debits `Math.min(action.amount, max(0, account.balance))` — **the debit
is capped at what is there.** When the plan is short, the realized delta is quietly smaller
than the amount asked for, and the gap is the deficit that feeds `cumulativeDeficit` and
`OUT_OF_FUNDS`.

Consequence for the chart, and it is severe: **a failing plan renders as a household that
chose to spend less.** The bands shrink; nothing says why. It is the flow-side twin of design
82 §8.1's post-ruin sample, where a mix of all-zeros is indistinguishable from a real mix
unless the denominator travels beside it.

**Decision: the chart carries both series.** Realized as the stacked bands, **intent as a line
over the top**, and the gap between them shaded and labelled as unmet. A year where they
diverge is the most important year on the chart and it must not require arithmetic to notice.

The same reducer property means an adaptive strategy is legible here in a way it is not
elsewhere: a guardrail plan cannot fail (`scripts/lab/spending-trace.mjs`'s premise), and this
chart shows the standard of living it passed at, per category, without a separate tool.

---

## 6. The blocking problem: the categories do not exist yet

The ask names *monthly expenses* and *property expenses* as separate categories. **They are
the same action type with the same payload.**

Four handlers emit `EXPENSE_DEBIT`, each as `{ type, amount, targetKey }` and nothing else:

| emitter | what it is | category the ask wants |
|---|---|---|
| `MonthlyExpensesHandler` | household living costs | monthly expenses |
| `HouseRunningCostHandler` (design 75 §5.1) | rates, insurance, utilities, body corporate | property expenses |
| `RealPropertyRepairTickHandler` (design 75 §5.2) | lumpy repairs | property expenses (or capex) |
| `ExpenseEventHandler` | one-off planned expenses | other |

Late-life care (design's `LATE_LIFE_CARE_APPLY`) does not debit at all — it scales
`monthlyExpenses`, so it lands invisibly inside the first row.

Nothing on the action distinguishes them. `targetKey` does not: all four resolve the same
residence-appropriate cash pool. Amount does not. Date does not.

### 6.1 Two ways to fix it, and the recommendation

**(A) Stamp `category` on the action at emit time. — Recommended.**

One field, set by the handler that knows the answer. This is exactly design 82 §2's argument
applied to the flow side: *emit the tuple, decide the grouping in the consumer*. The tuple is
currently missing a column, and every consumer that tries to reconstruct it will reconstruct it
slightly differently.

Cost: one field on four emitters, a `ValueType` on the action's schema entry, and a golden
re-gold if the action shape is asserted anywhere. It is inert for every existing consumer.

**(B) Join to the companion `RECORD_METRIC`.** Each handler already emits a metric —
`monthly_expenses`, `house_running_cost`, `house_repair_expenses` — so the categories could be
read off that channel with no sim change at all. **Rejected**, for three reasons and the third
is fatal:

1. It is a parallel channel that can silently drift from the debit it describes. Design 82
   §5.1(a) is the cautionary tale — a duplicated six lines stayed correct only by comment, and
   §5.3 found it had already stopped being correct.
2. It cannot attribute the residual. "Living expenses = total − the metrics I know about" is
   correct only until a fifth emitter appears, at which point it is wrong and nothing fires.
3. **The metric is in a different currency from the debit.** `MonthlyExpensesHandler` records
   `monthly_expenses` in the *native expenses currency* on purpose, then emits the debit in the
   *target account's* currency after `convertExpenseToAccount`. Joining them silently mixes two
   currencies inside one category.

> **Hard rule, whichever is chosen: the category is emitted, never inferred.** Inferring it
> from `targetKey`, amount, cadence or emitter identity is the trap design 82 §2 exists to
> prevent, and it fails silently rather than loudly.

---

## 7. THE INVARIANT

Design 82 §3 pins the cube to net worth. The flow analogue has to pin two things, because a
flow report can be wrong in two directions.

**(a) Classification is total.**

```text
Σ spending + Σ internal + Σ balanceSheet + Σ revaluation + Σ UNCLASSIFIED
  === Σ (every negative balance delta in the journal)
```

Every debit lands in exactly one bucket. An action type nobody classified goes to
`UNCLASSIFIED` and **is drawn** — 82 §2.4's rule, and for the same reason: refusing to render
leaves the operator with nothing, while an honest band leaves them looking straight at the
anomaly. A new action type from a future design therefore appears as a visible band on its
first run instead of vanishing from a total.

**(b) The flow ties to the stock.** Per account, per year:

```text
openingBalance + Σ credits − Σ debits === closingBalance
```

read against design 82's year-boundary samples. This is the invariant worth the most, because
it is what makes the two reports one picture rather than two plausible ones. If it holds, the
spending chart and the allocation chart are the same run described twice; if it does not, one
of them is wrong and the identity says which account to look at.

Both are cheap. Both should fail loudly in a test and degrade visibly in the report.

---

## 8. Categories — the proposed taxonomy

Two tiers, because the second tier is not spending but must be present for §7(a) to hold and
for the chart to be auditable.

### Tier 1 — spending (drawn)

| category | source | notes |
|---|---|---|
| `LIVING` | `EXPENSE_DEBIT` ← `MonthlyExpensesHandler` | the ask's "monthly expenses" |
| `HOUSING_RUNNING` | `EXPENSE_DEBIT` ← `HouseRunningCostHandler` | design 75 §5.1 |
| `HOUSING_REPAIR` | `EXPENSE_DEBIT` ← `RealPropertyRepairTickHandler` | lumpy; see §8.1 on capex |
| `DISCRETIONARY` | `EXPENSE_DEBIT` ← `ExpenseEventHandler` | one-off planned events |
| `CARE` | `EXPENSE_DEBIT` while `lateLifeCare` is active | needs its own flag, not just a factor |
| `TAX_US_FEDERAL` | `US_TAX_PAYMENT_DEBIT` | |
| `TAX_US_STATE` | `STATE_TAX_PAYMENT_DEBIT` | kept separate — design 59/state work reads it |
| `TAX_AU` | `AU_TAX_PAYMENT_DEBIT` | |
| `INTEREST` | the interest portion of `LOAN_PAYMENT_APPLY` | §4 — the portion, not the payment |
| `FX_COST` | FX fees on `INTL_TRANSFER_APPLY` | small, and the only pure friction cost modelled |

### Tier 2 — not spending (drawn, but below the axis or in a separate strip)

| category | source | why it must appear |
|---|---|---|
| `INTERNAL` | `REPLENISH_SAVINGS`, `HOLDING_TRANSACT`, RMDs, conversions, rollovers | 34% of debits; its absence would be unexplainable |
| `DEBT_PRINCIPAL` | the principal leg + the loan-account leg of `LOAN_PAYMENT_APPLY`, sale payoffs | §4 |
| `REVALUATION` | `REVALUE_ASSET_APPLY` and other marks | not a cash flow; must never sit in a spending band |
| `ASSET_PURCHASE` | `PROPERTY_PURCHASE_APPLY` and similar | a spend by the netting test, an investment by intent |
| `UNCLASSIFIED` | anything else | §7(a) |

### 8.1 Three decisions inside the taxonomy

- **Is a repair spending or capex?** Design 75 §5.2 already splits it: `capitalizeRepairs`
  fraction lifts `costBasis`, the rest is maintenance. **Follow that split** rather than
  inventing a second one — the capitalised part belongs in `DEBT_PRINCIPAL`'s spirit (wealth
  moved, not consumed) and the rest in `HOUSING_REPAIR`.
- **Does the AU super fund tax count?** Design 77 established it is withheld in-fund and never
  touches a member's cash, yet it rides along in `cumulativeTaxesPaid`. It is unambiguously a
  cost of the plan and unambiguously not a debit from an account the household spends from.
  **Proposal: draw it, hatched, and say so** — the same treatment as any figure that is true
  but not comparable with its neighbours.
- **Is a property purchase spending?** No, and the netting test cannot tell. It is the clearest
  case for the allowlist being an allowlist.

---

## 9. The chart, and the two places it must differ from design 82

Reuse is the default: the sampler seam (82 §4), `allocation-palette.js`'s discipline of one
hue per category shared between the lab page and the panel (82 §6.7), the tie-out-above-the-
chart rule (82 §6.5), and the page skeleton in `scripts/lab/`. Two things must be different.

**(a) Bars, not areas.** A flow is a quantity *per period*; a stacked area asserts continuity
between year-ends that a flow does not have, and it invites reading the slope of a band as
meaningful when only its height is. Stacked bars per year, categories stacked, intent as a line
across the tops (§5).

**(b) Real terms are mandatory, not deferred.** Design 82 deferred real-vs-nominal to design 79
(D1) and could afford to, because its headline view is a **share** and shares are unitless. **A
spending chart has no unitless escape** — its entire subject is the level. Drawn nominally over
45 years, inflation alone makes every band rise ~3%/yr and the chart tells a story that is the
opposite of true.

So: **real base-year dollars are the default view**, deflated by the country inflation
accumulator exactly as `scripts/lab/spending-trace.mjs` already does, with nominal available
as a toggle and never as the default. This makes design 79 a dependency rather than a
follow-up.

A share view (what fraction of outflow is tax) is worth having as a secondary tab, and it *is*
unitless, so it is immune to both of the above — same reason 82's 100% view leads its page.

### 9.1 FX: the journal does not carry a rate

Design 82 converts at each sample date through the shared `toBaseCurrency` helper. **The
journal has no equivalent** — only the tax settle actions stamp an `fxRate` (design 71/73);
`EXPENSE_DEBIT`, `REPLENISH_SAVINGS` and the rest carry none.

This is not academic. On a plan whose household has moved, the great majority of the expense
line can sit in one currency and the tax line in another, both summed at face value into a
number that means nothing. That is the same defect design 82 §5.3 found in
`computeGuardrailPortfolioValue` (a 10.57% overstatement, silent because USD accounts came out
right by accident) and the same one recorded for the tax-paid report.

**Proposal: sample `state.effectiveExchangeRates` through design 82's existing year-boundary
sampler and convert each year's flows at that year's rate**, through `toBaseCurrency` — not a
sixth private copy. One sampler seam then serves both reports, which is §7(b)'s whole point.

Two honest limitations to state on the page: a rate sampled at the year boundary is not the
rate at each intra-year debit, and design 87's §988 pools mean the *tax* consequence of holding
foreign currency is a separate question this chart does not answer.

---

## 10. Reproducing §3 and §4

The measurements above came from a throwaway probe, deliberately not committed. To reproduce:
run any scenario with `telemetry: 'full'` via `scripts/lib/run.mjs`'s `openSim`, walk
`sim.journal.journal`, and for every entry sum `stateDiff` entries whose `field` ends in
`.balance` and whose `delta` is negative, grouped by `entry.action.type`. Group again by
`(type, field)` and read each account's currency off `state[key].currency` — remembering it is
a `{code, symbol}` **descriptor**, not a string (82 §5.3).

**The trap that makes this worth writing down.** `EXPENSE_DEBIT` appears in the journal **three
times per month, with identical `amount` and `targetKey`**, because three reducers consume it
— `ExpenseDebitReducer` plus the two consumption accumulators — and the journal records one
entry per reducer application. Only the first moves money; the other two touch
`cumulativeConsumption*` only.

> **Summing `action.data.amount` over journal entries therefore returns exactly 3× the truth.**
> Measured, and exactly 3.000×, which is the kind of ratio that looks like a unit error and is
> not.

The report must sum the **realized `stateDelta`** — `JournalDataSource`'s `perDiff: true`
projection, which every existing cash-flow `ReportDefinition` already uses. This is the flow
analogue of design 82 §2.1's "buckets, not holdings": the natural-looking field is the wrong
one, and the wrongness is invisible because the result is plausible.

---

## 11. Where it lives

The existing `ReportDefinition` registry already has `DebitsFromAccountDef`,
`CashFlowByAccountDef` and `RealPropertyCashFlowDef` — all `perDiff`, all journal-derived, all
table-only. **This report is genuinely one of those, plus a chart**, which is the opposite of
design 82 §6's situation (state-sampled, so a *sibling* of `ReportDefinition` rather than a
subclass).

That resolves 82's deferred question — "one chart-bearing report is not enough evidence to
abstract over; revisit at the second" — because **this is the second.** But it resolves it in
the direction 82 did not anticipate: the natural home is `buildQuery` + a chart renderer, not a
new parallel hierarchy. Proposal:

```text
src/finance/spending-reporting/
  spending-classification.js   action type + category → bucket; the allowlist and the audit
  spending-cube.js             journal → rows[]  (date, category, tier, stateKey, currency,
                               amountLocal, amount, intent, realized, source)
  spending-grouping.js         the shared pivot — same role as allocation-grouping.js
scripts/lab/spending-report.mjs
src/visualization/workbench/plugins/finance/spending-plugin.js
```

with the same non-negotiable as 82 §5: **the pivot lives in `src/`**, and the page ships
precomputed series rather than the grouping logic, so the lab page and the panel cannot
disagree about a share.

### 11.1 Suggested phasing

| phase | what | why first |
|---|---|---|
| **0** | `category` on the four `EXPENSE_DEBIT` emitters (§6.1 A) | nothing below is buildable without it |
| **1** | classification module + cube + §7(a) invariant test | the definition, testable, no UI |
| **2** | lab HTML page, real-terms default, intent line | the taste question, same as 82 |
| **3** | §7(b) flow-ties-to-stock invariant against 82's samples | where the two reports become one picture |
| **4** | workbench panel | reads the run's samples; no re-stepping |
| **5** | Monte Carlo — spending as a distribution | "how often is tax >N% of outflow" |

Phases 0–1 are the ones that decide whether the chart means anything; 2–5 are 82's playbook
applied again.

---

## 12. Open questions

| # | question | leaning |
|---|---|---|
| 1 | Category on the action (§6.1 A) or a handler-id field the consumer maps? | **On the action.** A handler id is an implementation detail that would leak into the report's vocabulary and break when a handler is split. |
| 2 | Does `CARE` need its own flag, or is "expenses while care is active" enough? | Own flag. The factor is applied upstream of the debit, so the derived version cannot separate a care-inflated living expense from a large one. |
| 3 | Draw tier 2 below the axis, in a separate strip, or behind a toggle? | Separate strip. Below-axis reads as negative spending; a toggle hides the audit, and the audit is the point (§7a). |
| 4 | Gross-up for taxes withheld at source (wages) — spending or never-received income? | **Never-received income**, so out of scope here — but it means the tax band understates lifetime tax, which the page must say. |
| 5 | Should the AU super fund tax be drawn (§8.1)? | Yes, hatched and labelled. |
| 6 | Year-boundary FX (§9.1) or stamp a rate on every cash-moving action? | Year-boundary first — it reuses 82's seam and needs no action-shape change. Revisit if intra-year FX moves prove material under design 87. |
| 7 | Does this subsume `scripts/lab/spending-trace.mjs`? | Probably, eventually. Not in phase 2 — that tool is load-bearing for the adaptive-strategy question and should not be replaced by an unproven one. |

---

## 13. Relationship to other designs

| design | relationship |
|---|---|
| **82** (allocation over time) | the **stock** sibling. Shares the sampler seam, the palette discipline, the tie-out rule and the "emit the tuple" argument. §7(b) is the invariant that makes the two agree. This design is also the "second chart-bearing report" 82 §6 deferred abstracting for. |
| **79** (real vs nominal) | a **dependency**, not a follow-up. 82 could defer it because shares are unitless; a spending level cannot (§9b). |
| **75** (house costs) | supplies the two housing categories and the `capitalizeRepairs` split that §8.1 reuses rather than re-deciding. |
| **86** (leveraged property) | why §4 matters: a chart that counts principal as spending contradicts 86's finding that the loan is a cheap option. |
| **77** (AU super fund tax) | the one cost that is real and never debits a member account (§8.1). |
| **54** (loan accounts) | loans carry a positive balance that counts negative in net worth — the mechanism behind the double-count. |
| **59 / 83 / 84** (tax) | consumers of the tax bands; the US federal / US state / AU split exists so their levers are visible separately. |
| **87** (§988 currency pools) | out of scope for the chart, but the reason §9.1 states its FX limitation rather than implying precision. |
| **71 / 73** (tax export) | the only actions that stamp an `fxRate` today; the precedent if OQ6 goes the other way. |
