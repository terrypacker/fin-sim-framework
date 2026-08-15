# 89 — Spending over time: what the plan actually costs

**Status** (2026-08-15): **PHASE 0 DONE. The §5.1 A–E thread is CLOSED — code shipped.
Phases 1–6 of the chart itself are still proposed; §15 is where the next session starts.**

Section 3 is a measurement, not a proposal — it is what the design is shaped around, and it is
now reproducible (`scripts/probes/probe-spending-composition.mjs`) rather than quoted.

> **Revised 2026-08-15**, after designs 86, 87, 90 and 91 landed. §3 and §4 were re-measured
> against the same reference plan on today's `main`; §14 is the diff. The headline changes:
> **§9.1's FX proposal is obsolete and was superseded by something better** (`report-currency.js`),
> **design 79 is no longer a dependency** (§9b), **§6's blocking problem is half-solved** by
> design 87's `section988` stamp, and **§3's mix moved** enough to change the headline number.
> §11.1's phasing changed as a result.
>
> **The review also found a live defect in the optimiser** and fixed it end to end (§5.1–§5.6):
> the consumption accumulators booked *intended* spending rather than what the household could
> actually fund. No chart was built this session; that work is §15.

The ask: a chart like design 82's allocation band, but for **spending** — categories stacked,
over the plan. The proposed first cut was "spending is every debit from every account,
categorised as tax / monthly expenses / property expenses / other".

**That definition does not survive contact with the journal, and the categories are not
currently recoverable.** Measured on a real plan, **just under half of all account debits are
not spending at all**, one action type is journaled **three times** so the obvious sum
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

**Re-measured 2026-08-15** on today's `main`, same reference plan, by
`scripts/probes/probe-spending-composition.mjs` (§10). Three columns:

- **conv** — converted to USD at the run's own rate, **per row, on the row's own date**, through
  the shipped `reportCurrency` machinery (§9.1). **This is the column that means something.**
- **raw** — the same cut summed at face value across both currencies, as originally taken. Kept
  only so the correction is visible.
- **orig** — the 2026-08-09 reading, kept because the *movement* is part of the argument.

| action type | conv | raw | orig | is it spending? |
|---|---:|---:|---:|---|
| `HOLDING_TRANSACT` | **25.8%** | 22.7% | 13.4% | **no** — internal, debits and credits tie to the cent |
| `AU_TAX_PAYMENT_DEBIT` | **23.8%** | 21.0% | 26.4% | **yes** |
| `EXPENSE_DEBIT` | **20.6%** | 27.4% | 30.0% | **yes** — but it is four categories in a trench coat (§6) |
| `REPLENISH_SAVINGS` | **18.6%** | 17.0% | 18.6% | **no** — internal transfer, drawdown filling the cash pool |
| `US_TAX_PAYMENT_DEBIT` | **6.4%** | 5.7% | 4.9% | **yes** |
| `REVALUE_ASSET_APPLY` | **2.0%** | 1.7% | 1.9% | **no** — a market mark, not a cash flow |
| `IRA_RMD_APPLY` | **1.0%** | 0.9% | 1.0% | **no** — internal; the tax on it is a separate action |
| `K401_TO_IRA_CONVERSION_APPLY` | **0.7%** | 0.6% | 0.7% | **no** — internal |
| `LOAN_PAYMENT_APPLY` | **0.6%** | 1.6% | 1.7% | **partly** — see §4; ~93% of it is not spending |
| `ROTH_CONVERSION_APPLY` | **0.4%** | 0.3% | 0.3% | **no** — internal; the tax is separate |
| `STATE_TAX_PAYMENT_DEBIT` | **0.1%** | 0.1% | 0.1% | **yes** |
| `REBALANCE_TO_TARGET_APPLY` | **0.0%** | 0.0% | 0.0% | **no** — rounding dust (design 61 D1) |
| `US_HOUSE_SALE_APPLY` | *out of scope* | 1.0% | 1.0% | **no** — the mortgage extinguished from sale proceeds |

**Genuine household outflow is ~51.0% of the total — the naive definition overstates spending by
about 96%.** It very nearly doubles it. (Face value said 54.3% / 84%; the original draft said
61.5% / 63%.)

**`EXPENSE_DEBIT` is the line the conversion moves, and it moves the wrong way for the chart:
27.4% → 20.6%, down 6.8 points.** Every other line rises. That is not arbitrary — it is §3's
fourth bullet arriving as arithmetic. The household's expenses are largely paid from **AUD**
pools, so converting deflates them; AU *tax* is largely paid from a **USD**-domiciled brokerage,
so converting leaves it alone and its share rises. **Whose cost it is and which currency paid it
are independent**, and a face-value chart gets the single most important band wrong by a third.

The true FX effect is larger than 6.8 points. The two columns are not the same universe — the
converted pass loses 1.7% of the raw total to scope (§3.1) — and dropping keys from a denominator
pushes every surviving share *up*. `EXPENSE_DEBIT` fell against that headwind.

**Cross-checked on the synthetic default**, which shares no balances, horizon or account set with
the reference plan: `EXPENSE_DEBIT` −7.4 points, converted outflow 49.9%. The effect is
structural, not a property of one plan.

### 3.1 What the shipped reports cannot see  (found in phase 0)

Running the cut through `runReport` rather than a private walk surfaced something a private walk
would have hidden. The shipped definitions scope to `api.accountBalanceKeys()` — whatever
`StateSchemaRegistry` registered — and **the loan accounts are not registered**:

| out-of-scope key | debited by | share of raw |
|---|---|---:|
| `auHousePropertyLoan.balance` | `LOAN_PAYMENT_APPLY` | 0.70% |
| `usHousePropertyLoan.balance` | `US_HOUSE_SALE_APPLY`, `LOAN_PAYMENT_APPLY` | 1.01% |

Read the *types* before concluding this is harmless. Those two keys are **exactly the two legs §2
named as the netting test's failures**: the mortgage double-count (§4) and the sale payoff. The
shipped scope already drops both.

> **So the report is right about the double-count for a reason that has nothing to do with the
> double-count.** Nobody scoped it out; the loan accounts simply were never registered as
> account balances. Register them — for a design 54 net-worth view, or a design 70 display
> name — and **the double-count silently returns** to every `perDiff` report at once.

Two consequences, and they point in opposite directions, which is why this is in §3 and not a
footnote:

1. **The allowlist must not lean on the scope.** §7(a)'s classification has to reject
   `DEBT_PRINCIPAL` explicitly, so the answer stays right when the scope changes.
2. **`ASSET_PURCHASE` and the loan legs are unreachable today.** A tier-2 category the report
   structurally cannot see must be drawn as *absent*, not as zero — the same rule §7(a) applies
   to `UNCLASSIFIED`, for the same reason.

**No new action type appeared** in thirteen months of designs — the taxonomy's *membership* was
stable across 86, 87, 88, 90 and 91. What moved is the *mix*: `HOLDING_TRANSACT` nearly doubled
its share and `AU_TAX_PAYMENT_DEBIT` gave up five points. That is the useful lesson. A
classification built once stays complete far longer than a set of shares stays true, which is
the argument for §7(a)'s audit and against quoting any share on the page without the run behind
it. It is also why §11.1 re-measures rather than trusting this table.

Where the rejected 49.0% goes: internal transfers **46.5%**, revaluation 2.0%, debt principal
~0.6%, dust ~0% — plus whatever §3.1's scope is hiding.

Three more things in that table are worth more than their share:

- **`REPLENISH_SAVINGS` + `HOLDING_TRANSACT` = 44.4%** and both are pure internal movement.
  `HOLDING_TRANSACT`'s debits and credits agree to the cent, which is a useful smoke test that
  the netting audit is working at all. It is also the single largest line on the chart's
  *rejected* side, and it grew — a decumulating plan does more of this over time, not less.
  On the converted basis it is now the **largest line in the table**, ahead of both tax and
  spending, which is worth knowing before anyone screenshots a "where the money goes" chart.
- **`REVALUE_ASSET_APPLY` at 2.0%** is the one that would embarrass the chart. It is small in
  aggregate and arbitrarily large in the year a shock lands — which is exactly the year someone
  will screenshot.
- **`AU_TAX_PAYMENT_DEBIT` is largely paid out of a US-domiciled brokerage.** So *whose tax it
  is* and *which country's account paid it* are different facts. **Category must come from the
  action; currency must come from the account.** Reading either off the other is wrong. This is
  the same two-axes error [[residency-and-source-are-two-axes]] records on the tax side — and
  the `conv`/`raw` split above is what it costs when you get it wrong: AU tax rises on
  conversion while AU-funded *expenses* fall, from the same journal, in the same run.

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
it. Both figures reproduce unchanged on the 2026-08-15 re-measurement.

> This is not an argument that debt service is cheap. It is an argument that **the interest is
> the expense and the principal is savings**, and a chart that says otherwise will make a
> leveraged plan look like it is spending far more than it is — directly against design 86's
> finding that the loan is a cheap option worth holding.

### 4.1 The offset case is not hypothetical — it is the reference plan  (measured 2026-08-15)

The original draft ended §4 with an aside: with an interest-offset filled, the interest leg goes
to zero, the entire payment is principal, and **100% of the debit is non-spending** while the
chart would draw it as the household's second-largest cost.

That is now the plan's actual state. Splitting `LOAN_PAYMENT_APPLY`'s debits by field:

| field | share of the type |
|---|---:|
| `auOffsetAccount.balance` (cash leg, AU) | 44.3% |
| `auHousePropertyLoan.balance` (loan leg, AU) | 44.3% |
| `usSavings2Account.balance` (cash leg, US) | 7.5% |
| `usHousePropertyLoan.balance` (loan leg, US) | 3.9% |

The two AU legs are equal **to the cent**, which is the signature of a zero-interest payment:
the offset is full, so design 86's arrangement is doing exactly what 86 said it does. **88.6% of
this action type's debits are the AU loan and every cent of them is principal.** The entire
interest figure in §4 belongs to the US loan.

So the aside is the base case, not the corner case, and the naive chart's error on this row is
total rather than partial.

**This costs nothing to get right.** `LOAN_PAYMENT_APPLY`'s declared payload is already
`{ loanKey, payment, interest, cashDue, section988 }` — `interest` is on the action and gated
into the journal by the design 91 manifest. §8's `INTEREST` category needs **no emitter
change**, which makes it the one tier-1 category buildable before §6 is resolved.

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

### 5.1 The same gap is already inside the optimiser's objective  (found 2026-08-15)

`AccumulateConsumptionReducer` — which builds `state.cumulativeConsumption`, the quantity the
`consumption` and `DIE_WITH_TARGET` objectives maximize — reads **`action.amount`**:

```text
reduce(state, action) {
  const amount = action.amount ?? 0;      // INTENT — the cap has not been applied yet
```

`ExpenseDebitReducer` caps the money at the balance *afterwards*. Both reducers see the same
dispatched action, so on a short plan the accumulator books consumption the household never
received. `cumulativeDeficit` is a **separate penalty term** in the objective, not a netting of
this one, so whether the two offset or compound depends on their weighting.

This is not a claim that the optimiser is wrong — it is a claim that **§5's intent/realized
distinction already has a consumer, and that consumer picked intent silently.** Two consequences
for this design:

1. It is direct evidence for §5's decision to carry **both** series. The gap is not a display
   nicety; something load-bearing already fell into it.
2. Phase 1 must not reuse this reducer as the cube's amount source without deciding which
   series it is producing.

**Decision (2026-08-15): measure before touching it — but it does get fixed.** Changing the
accumulator reprices every optimiser and MPC result on record, so it is not a drive-by edit. It
is also not something to leave sitting: a scored quantity that counts money the household never
received is wrong in the direction that flatters a failing plan, which is the same defect §5
exists to fix on the chart.

**The plan, in order:**

| # | step | gate to the next |
|---|---|---|
| **A** ✅ | **Size it** — `scripts/probes/probe-consumption-intent-gap.mjs`. **DONE 2026-08-15; §5.2 has the result.** | Gate met: zero on the solvent plan, so B is cheap and safe. |
| **B** ✅ | **Pin the current behaviour with a test** — `tests/unit/consumption-intent-gap.test.mjs`. **DONE 2026-08-15; §5.3 has the result.** | Gate met: verified by mutation to fail on the fix, so step D's change will be visible rather than assumed. |
| **C** ✅ | **Decide intent vs realized on the merits, once.** **DECIDED 2026-08-15: realized, deficit term untouched — §5.4 has the reasoning and the exposure map.** The deciding fact was not the one the leaning rested on: `MAX_CRRA_UTILITY` has *no* deficit penalty and `feasibilityFirst` defaults to `false`, so on that objective nothing at all opposes the overstatement. | Gate met: recorded in §5.4, including what "realized" means mechanically (§5.4.4) and what is deliberately not changed (§5.4.3). |
| **D** ✅ | **DONE 2026-08-15 — §5.5 has the result, and the CRRA gradient was *inverted*, not merely unopposed.** **Change BOTH accumulators** — `AccumulateConsumptionReducer` *and* `AccumulateConsumptionUtilityReducer` carry the same `action.amount` line (§5.3), so a one-file fix leaves the `crra` objective still scoring intent. Then re-run the arms that depend on them — `DIE_WITH_TARGET`, `consumption`, `crra`, and any MPC result quoted in a design. Report the shift rather than absorbing it. | §5.3's five `[INVERTED BY STEP D]` tests must fail and be rewritten to their realized-side form. [[defer-long-mc-reruns]] applies: ship the code and tooling, do not block on the re-runs. |
| **E** ✅ | **DONE 2026-08-15 — §5.6.** And the premise was wrong: "same file, same test" is not possible. The deflator axis is **residence** for living costs but **`prop.country`** for property costs, and one action can blend two levels, so it had to become a stamped `priceLevel` on all four emitters — the same answer design 87 and step D reached for the same reason. | Inert on the reference plan (0.00%, even at 5% AU inflation), because the old code was right by an agreement between two handlers rather than by construction. |

**C must be decided before phase 3 draws an intent line**, because the chart and the objective
should not disagree about what "intent" means. This is not left as an open question — OQ9
records the sequencing, and §14 lists it as owed work.

### 5.2 Step A: measured  (2026-08-15)

```bash
node scripts/probes/probe-consumption-intent-gap.mjs --scenario <plan.json> [--stress <x>]
```

The probe replicates the reducer's own arithmetic — FX-convert, then deflate — over each
distinct `EXPENSE_DEBIT` **dispatch**, and cross-checks its intent-side total against the run's
`state.cumulativeConsumption`. On the reference plan the two agree to **0.000%**, so the
realized-side figure is measuring the reducer rather than a second bug.

**On the solvent reference plan the gap is exactly zero.** 552 dispatches, none capped. The cap
only binds when the account is short, so on a plan that never runs short the defect is **latent,
not live** — which is the gate step B needed.

**Under stress it is not merely live, it is unbounded.** Scaling monthly expenses to force the
cap to bite, in the objective's own units (real base-year USD):

| stress | dispatches capped | booked (intent) | received (realized) | overstatement |
|---:|---:|---:|---:|---:|
| 1× | 0 / 552 | — | — | **0.00%** |
| 2× | 209 / 552 | 1.00× | 1.00× | **53.5%** |
| 4× | 360 / 552 | 2.00× | 0.82× | **275.9%** |
| 8× | 397 / 552 | 3.99× | 0.81× | **660.0%** |

(Booked and received are indexed to the 2× run so the shape is readable without quoting plan
balances.)

**Read the two middle columns against each other — that is the finding.** Booked consumption
tracks the stress multiplier almost exactly: double the expense assumption, double the score.
Received consumption *falls*, because the accounts are already empty and there is no more money
to spend. So:

> **On a broken plan, `cumulativeConsumption` is the expense assumption, not an outcome.** It
> reports what the strategy asked for, nearly independent of what the household actually got.

That is a stronger claim than "it over-counts", and it is the one that matters for an optimiser.
A search maximizing `consumption` or `DIE_WITH_TARGET` sees booked consumption rise without
bound as it raises the spending assumption, while the money actually spent saturates. **The
gradient points at insolvency.** The only thing opposing it is the separate `cumulativeDeficit`
penalty.

**And that penalty cannot cleanly oppose it, for a reason step A was not looking for.** The two
terms are in **different units**:

| term | built by | unit |
|---|---|---|
| `cumulativeConsumption` | `AccumulateConsumptionReducer` | FX-converted, deflated — **real base-year USD** |
| `cumulativeDeficit` | `AccumulateDeficitReducer` | `action.amount` added raw — **nominal, mixed USD + AUD** |

`AccumulateDeficitReducer` sums the deficit amount as dispatched, and the out-of-funds events
fire in both currencies on the same run, so `cumulativeDeficit` is a face-value cross-currency
total in nominal dollars — the same class of defect §9.1 and design 91 §8 exist to close, sitting
inside the objective. Whether the penalty outweighs the overstatement is therefore not a
weighting question that can be reasoned about; the two numbers are not commensurable.

**What this changes about the plan.** Nothing about the ordering, and one thing about the scope:

- Steps B–E stand as written. B is now cheap and safe — the solvent plan is unaffected, so a
  characterisation test needs a stressed fixture and touches nothing else.
- **Step C's leaning is now a recommendation.** Realized. The argument was "the deficit already
  penalises the shortfall, so counting intent double-books it"; the measurement says the deficit
  cannot be relied on to do that job at all, because it is in the wrong unit. Counting realized
  makes the consumption term correct on its own terms rather than correct-by-cancellation.
- **The `cumulativeDeficit` unit defect is new scope**, not part of this design. It belongs with
  the objective work, and it is recorded here because step A found it. It should not be fixed
  quietly inside a spending-chart change.

### 5.3 Step B: the characterisation test  (2026-08-15)

`tests/unit/consumption-intent-gap.test.mjs` — 10 tests, reducer-level, no scenario run.

It dispatches one `EXPENSE_DEBIT` through all three consuming reducers **in the engine's own
priority order** (`CASH_FLOW` debit, then the two `METRICS` accumulators) and reports what each
booked. Running the accumulators last is load-bearing rather than incidental: by then the
balance is already zero and the shortfall is sitting in state. They book intent anyway, because
they read the action. **That rules out re-sequencing as a fix** and is pinned as its own test.

The draft's step B said "assert `cumulativeConsumption` exceeds the realized debits **by exactly
the deficit**". Step A had already disproved that — the deficit is raised elsewhere, in another
unit — so the test asserts what is actually true instead: the overstatement is exactly the
**capped-away money**, `(amount − balance)` in the accumulator's own units. Writing the test
against the draft's guess would have pinned a coincidence.

Three groups:

- **CONTROL** (2) — a solvent debit, USD and AUD. Realized equals intent, so the gap is zero.
  Without these, every assertion below would also pass against an accumulator that returned
  zero, and the file would prove nothing ([[offset-earns-no-yield]]).
- **THE GAP** (6) — the divergence, its exact size, that it survives FX conversion and
  deflation, that ordering does not cause it, and that
  **`AccumulateConsumptionUtilityReducer` has the identical defect**. That last one matters for
  step D's scope: the `crra` objective reads a second accumulator with the same
  `action.amount` line, so a fix touching only its sibling leaves half the problem in place.
- **UNITS** (2) — §5.2's finding, pinned: `AccumulateDeficitReducer` accumulates raw, so the
  same nominal AUD amount enters consumption as one number and the deficit as another.

**The labels are verified, not asserted.** A characterisation test that cannot fail is
worthless, so the file was run against a mutated engine — both accumulators changed to read the
capped amount, a stand-in for step D. **5 failed, 5 passed, and the split was exactly the
labelling**: every `[INVERTED BY STEP D]` test failed, every `[PINNED]` test and both controls
passed untouched. The controls are therefore insensitive to the fix rather than merely agreeing
with it today.

That run also corrected the file. Two assertions were originally labelled `[PINNED]` and turned
out to flip. **The mutation found the mislabelling that reasoning about it had missed**, which
is the argument for running it rather than declaring the labels correct.

Step D now has a gate it cannot pass silently: it must make exactly those five tests fail, and
rewriting them to their realized-side form is the visible record of the change.

### 5.4 Step C: the decision — **realized**  (2026-08-15)

> **Decided: both accumulators book the realized debit, not `action.amount`. The deficit term
> is left exactly as it is.** The rest of this section is the reasoning, because step C's gate
> was "a decision recorded here, not in a commit message".

Two readings were defensible in the abstract — realized is what the household consumed, intent
is what the strategy asked for. The abstract argument does not survive looking at the consumers.

#### 5.4.1 Where the overstatement is actually reachable

`OptimizationProblem` takes `feasibilityFirst` (design 80 U2), which ranks every infeasible
candidate strictly below every feasible one and orders the infeasible band **by shortfall
alone** — discarding the base score, consumption included. It defaults to **`false`**. Only the
MPC cockpit turns it on; `IntlRetirementOptimizer` and the workbench's optimize controller both
construct the problem without it.

| consumer | `feasibilityFirst` | opposing term | is the overstatement reachable? |
|---|---|---|---|
| MPC cockpit | `true` | μ·deficit | **No.** Feasible ⇒ gap is zero (§5.2). Infeasible ⇒ consumption is not in the score at all. |
| `DIE_WITH_TARGET` family via the optimize panel / `IntlRetirementOptimizer` | `false` | μ·deficit | **Yes**, among infeasible candidates — `reward − λ·|terminal − target| − μ·deficit` with the inflated reward live. |
| **`MAX_CRRA_UTILITY`** via the same paths | `false` | **none** | **Yes, with nothing opposing it.** |

That last row is the finding. `MAX_CRRA_UTILITY` is a bare `maximize Σ u(cₜ)` — no deficit
penalty, no terminal anchor, and by default no feasibility gate. **An optimiser running it today
has no term anywhere that falls when the plan runs out of money**, because the only running
quantity it reads is the one that books what was asked for.

How much does that matter? `AccumulateConsumptionUtilityReducer` uses γ=1.5 and `floor = 1`, so
per period `u(c) = 2 − 2/√c` on `[0, 2)`. The per-dispatch overstatement is `2/√realized −
2/√intent`: about **0.04 utils** on a mild shortfall, rising to about **1.96** — nearly the
entire range of the function — in a month where the account is empty and realized consumption
clamps to the floor. Summed over hundreds of months, in an objective with no opposing term.

> **Switching to realized gives `MAX_CRRA_UTILITY` the only ruin signal it has.** Under intent,
> a household with an empty account scores the same utility as one that actually spent the
> money. Under realized, the empty month scores ≈0 against ≈2. That is not a refinement; it is
> the difference between an objective that can see ruin and one that cannot.

#### 5.4.2 The four reasons, in order of strength

1. **`MAX_CRRA_UTILITY` is unopposed** (§5.4.1). No calibration protects it, because there is
   nothing to calibrate.
2. **It is free where the answers come from.** Step A: the gap is **exactly zero** on solvent
   plans. Every feasible optimum, every Monte Carlo percentile drawn from a solvent path, every
   result quoted from a plan that did not run short — unchanged. Step D's repricing risk is
   confined to infeasible candidates, which is a small and identifiable blast radius for a
   change to a scored quantity.
3. **It removes a phantom the calibration is currently paying for.** `DEFAULT_DEFICIT_PENALTY`
   is 100, and its own comment justifies the size as exceeding "the marginal reward of a deficit
   dollar (1 from consumption + at most λ from approaching the target)". **That parenthesis is
   this defect, priced rather than removed** — the codebase already knew a deficit dollar earns
   reward from consumption and chose to swamp it. With realized, a deficit dollar earns *zero*,
   and μ stops being load-bearing for correctness.
4. **It attacks a cause of the problem design 80 U2 worked around.** U2's own rationale says
   that under the plain score, infeasible candidates are ordered by a mixture "that includes
   consumption — so CEM's elite set fills with *expensively infeasible* points". An expensively
   infeasible point is precisely one whose **booked** consumption is high because it asked to
   spend a lot while the money never moved. U2 stays — a structural guarantee that holds at any
   μ is worth more than a numeric one, and §5.2's units finding is a second reason not to trust
   calibration — but it should not have to carry a defect that can simply be fixed.

#### 5.4.3 What is deliberately NOT changed

- **The deficit term stays as it is.** μ is not re-tuned, and `cumulativeDeficit`'s
  mixed-currency nominal unit (§5.2) is not fixed here. Two reasons: changing the reward and the
  penalty in one pass destroys step D's measurement, and the unit defect belongs to the
  objective work rather than to a spending-chart design. It is also **conservative** in the
  meantime — a nominal AUD deficit contributes *more* penalty per real USD of shortfall than a
  USD one, and a late-plan deficit dollar earns only ~1/3.7 of a real unit of reward against a
  full unit of penalty, so the term never under-penalises.
- **`feasibilityFirst`'s default stays `false`.** Flipping it is a separate decision with its
  own blast radius, and §5.4.1 is an argument for fixing the reward, not for hiding it behind a
  gate.

#### 5.4.4 What "realized" means, for step D

Three mechanisms, and the choice matters:

| | mechanism | verdict |
|---|---|---|
| (a) | accumulators read the post-debit balance delta | **No.** They run at `METRICS`, after the balance has already moved; the pre-state is gone. |
| (b) | `ExpenseDebitReducer` stamps the realized amount on the action; accumulators read it | **Yes.** One field, and that reducer *already* writes back to the action — it stamps `action.section988.accountKey` for exactly this reason (design 87). |
| (c) | reorder so the accumulators run first and each computes `min(amount, balance)` | **No.** Three copies of the cap rule instead of one. |

**Take (b).** One hazard to name, because it is the kind that returns silently: reading a
stamped field makes the accumulators **order-dependent**, where today they are not. If a future
change ever moves `ExpenseDebitReducer` after `PRIORITY.METRICS`, a `?? action.amount` fallback
would quietly restore the present behaviour. Mitigation: step D adds a test asserting
`ExpenseDebitReducer`'s priority is strictly earlier than both accumulators', so the ordering
that makes the fix correct is itself pinned — §5.3 already pins that ordering is *not* a
sufficient fix, and this pins that it is a *necessary* precondition.

**A convergence worth taking.** If the stamped field is declared in both toolsets' manifests
(design 91 — `EXPENSE_DEBIT` is a shared type and the static emitter scan will require it), the
journal then carries intent and realized side by side on every dispatch. That is phase 3's
intent line (§5) readable straight off the payload, rather than reconstructed by pairing
`action.data.amount` against `stateDelta` while dodging the 3× trap. Step D should declare it.

### 5.5 Step D: built, and the gradient was worse than §5.4 argued  (2026-08-15)

**What changed.** `ExpenseDebitReducer` now stamps `action.realizedAmount = debit` — always,
including `0`, because a month the household could not fund is consumption of zero, not an
absence. Both accumulators read `action.realizedAmount ?? action.amount ?? 0`. The field is
declared `ValueType.number()` in **both** retirement toolsets, matching `amount`: this type
spans both currencies (the pool is picked by residency), so a fixed per-type code would be the
design 91 §8.1 error, and money reports read `stateDelta` anyway (§9.1).

**Verified in the journal.** `EXPENSE_DEBIT` payloads now carry
`{ amount, realizedAmount, targetKey, section988 }` on every entry, so phase 3's intent line is
readable straight off the payload rather than reconstructed around the 3× trap. The design 91
manifest gate and drift detector both accept it.

**The blast radius is what step A predicted.** On the solvent reference plan
`cumulativeConsumption` is **byte-identical** to its pre-fix value, and the whole golden set is
unchanged — which is a stronger statement than it looks, since `cumulativeConsumption` is one of
the fields those whole-state fixtures pin. Full suite green with no re-gold.

Under stress, in real base-year USD:

| stress | before (intent) | after (realized) | change |
|---:|---:|---:|---:|
| 1× | 4,659,420 | 4,659,420 | **0.00%** |
| 2× | 9,289,677 | 6,050,504 | −34.9% |
| 4× | 18,550,192 | 4,935,565 | −73.4% |
| 8× | 37,071,222 | 4,877,695 | −86.8% |

The shape matters more than the sizes. Before, the reward scaled with the expense *assumption*;
after, it is roughly flat across 2×–8× because that is all the money there was to spend.

#### 5.5.1 The CRRA measurement, which is worse than §5.4.1 predicted

§5.4.1 argued that `MAX_CRRA_UTILITY` had **nothing opposing** the overstatement. Measured, that
understates it. Lifetime CRRA utility on the same four runs, computed from both sources:

| stress | from INTENT (old) | from REALIZED (new) |
|---:|---:|---:|
| 1× | 1091.3 | 1091.3 |
| 2× | 1094.6 | 1029.1 |
| 4× | 1097.0 | 954.6 |
| 8× | 1098.6 | 921.1 |

**The old column rises, monotonically, as the plan is driven further into ruin.** `u` is
increasing in `c`, and under intent `c` was the expense assumption, so asking to spend more
scored higher no matter how little money existed. On an objective with no deficit penalty and
`feasibilityFirst` defaulting to `false`, that is not an absent ruin signal — **it is an
inverted one.** An optimiser maximizing `MAX_CRRA_UTILITY` had a gradient pointing at
insolvency.

The new column falls monotonically. **Step D reverses the sign of that gradient.**

Two honest limits on this measurement: it is one lever (expense level) on one plan, and the
differences along the old column are small in absolute terms (+0.7% end to end, because `u` is
bounded on `[0, 2)` and saturates). Neither weakens the conclusion — with no opposing term, the
*sign* of the gradient is the whole of the behaviour, and it was positive.

#### 5.5.2 What is left

- **Step E** — the currency→residency conflation in the same reducer (§5.1) is still open. It is
  now the only thing left in this thread.
- **The dependent arms are not re-run.** [[defer-long-mc-reruns]] applies: the code and the
  tooling ship, the 30–45 minute Monte Carlo and optimiser re-runs do not block. The cheap
  checks that *were* run — solvent plan byte-identical, whole golden set unchanged — are the
  substantive evidence that no feasible result moves, because §5.2 established the gap is
  exactly zero wherever a plan stays solvent.
- **`cumulativeDeficit`'s unit defect** (§5.2, §5.4.3) is untouched and still belongs to the
  objective work.
- **`probe-consumption-intent-gap.mjs` is now a regression detector.** It reports which source
  the engine matched; a run that starts matching INTENT again means the accumulators regressed
  *or* `realizedAmount` stopped being stamped — which look identical from outside, and both
  restore the old behaviour silently.

### 5.6 Step E: the deflator axis — and why "same file, same test" was wrong  (2026-08-15)

Step E was scoped as a tidy-up: *"the reducer picks its deflator country from account currency.
Same file, same test, and leaving it would mean touching this reducer twice."*

**The same-file fix does not exist.** Investigating it turned up three facts:

1. **The intended fix is residence.** `InflationAdjustReducer` inflates `state.monthlyExpenses`
   at the **residence** country's rate — deliberately and with its own comment, driving expenses
   off the always-annual US advance so a mid-year move cannot drop an increment. So for
   `MonthlyExpensesHandler`, residence is the index and account currency is not.
2. **But the property handlers use a different axis again.** `HouseRunningCostHandler` indexes
   each property's costs at **`prop.country`**'s accumulator — and then sums several properties
   into **one** `EXPENSE_DEBIT`. A single action can carry two price levels at once.
3. **So switching `cc` to residence would have fixed one emitter and broken two others**, in a
   plan whose household is AU-resident holding US property. It trades one wrong axis for a
   different wrong axis on a different subset — not an improvement worth defending.

This is the third time these four emitters have hit the same wall. Design 87 needed §988(e)(3)'s
"to the extent" fraction blended across a mixed tick and answered it with
`blendExpenseBusinessFraction`; step D needed the capped amount and answered it with
`realizedAmount`. **The price index is the same shape of problem and gets the same answer: the
emitter knows, the accumulator cannot infer, so it is stamped.**

**What was built.** `src/finance/spending/expense-price-level.js` — `residencePriceLevel()` and
`blendExpensePriceLevel()` — plus a `priceLevel` stamp on all four emitters, declared
`ValueType.number()` in both toolsets. Both accumulators now read
`action.priceLevel ?? state.inflationAccumulator[cc] ?? 1`. **Currency is still read off the
account**, because that genuinely is the account's axis — `amount` is denominated in it. The two
are now independent, which is the whole point.

**The blend is the harmonic mean, not the arithmetic one.** The accumulators compute
`debit / priceLevel`, so the level that makes a blended debit exact satisfies
`totalDebit / blend === Σ(debitᵢ / priceLevelᵢ)`. On a 60/40 split across levels 2 and 4 the
arithmetic mean gives 2.8 against a correct 2.5 — a **10.7% understatement of real consumption**,
and invisible to any test that uses one property. Pinned by test.

#### 5.6.1 Measured: inert, and the reason is the uncomfortable part

On the reference plan the old and new deflators agree to **0.00%** — and still 0.00% with AU
inflation forced to 5% against the US rate, which drives the two accumulators to 8.56 versus
3.67. `cumulativeConsumption` and `cumulativeConsumptionUtility` are unchanged to four decimals;
the whole golden set is unchanged.

The reason is not that currency is a good proxy. It is that **`MonthlyExpensesHandler` picks the
target account BY residence**, so the account's currency happened to equal the residence
currency. The old code was right through an agreement between two handlers rather than by
construction — the arrangement that breaks silently the moment one of them changes, and exactly
what [[residency-and-source-are-two-axes]] records on the tax side.

The blended-property path is bounded on this plan too: by their `RECORD_METRIC` companions,
`monthly_expenses` is **99.69%** of expense flow, `house_running_cost` **0.31%**, and
`house_repair_expenses` never fires. So the correctness argument here is structural, not
numerical — which is worth saying plainly rather than dressing a 0.00% result as a win.

#### 5.6.2 Two things noted, not fixed

- **Repairs are never indexed.** `_drawRepair` reads `prop.repairMedian` (a fixed nominal
  parameter) or `repairValuePct × prop.value` (which rides appreciation, not CPI), so repair
  costs shrink in real terms across a 44-year plan. The stamp is still correct — `prop.country`'s
  level converts nominal-at-t to base-year real however the nominal figure arose — but whether
  repairs *should* be indexed is a design 75 modelling question, left alone.
- **This converges with phase 1.** `category` lands on the same four emitters and the same two
  manifest declarations. Phase 1 is now one more key alongside `priceLevel` and `realizedAmount`
  rather than a third pass over the same files.

**A second defect in the same reducer, noted for whoever touches it:** it picks its deflator's
country from the *account currency* —

```text
const cc = currency === 'AUD' ? 'AU' : 'US';
```

— which is exactly the conflation §3's fourth bullet and [[residency-and-source-are-two-axes]]
warn against. Fix or fence it before reusing; do not copy it.

---

## 6. The blocking problem: the categories do not exist yet

The ask names *monthly expenses* and *property expenses* as separate categories. **They are
the same action type with the same payload.**

Four handlers emit `EXPENSE_DEBIT`, and as of the original draft each emitted
`{ type, amount, targetKey }` and nothing else:

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

### 6.0 Half of this is already solved — design 87 got there first  (2026-08-15)

The paragraph above was true when written and is no longer. Design 87 §14.4 item 2 needed the
same thing this design needs, for a different reason: spending foreign currency is a §988
disposition, and its *character* depends on which handler spent it. So it stamped a field on
**all four emitters**:

```text
{ type: 'EXPENSE_DEBIT', amount, targetKey,
  section988: { kind: 'DISPOSE', businessFraction } }
```

declared `section988: ValueType.any()` in **both** retirement toolsets, with a comment on each
declaration saying it exists "for JOURNAL visibility rather than for the mechanism".

Three things follow, and they change §6.1 from an argument into a pattern-match:

1. **The recommendation below is no longer a proposal to weigh — it is the shape that already
   shipped on the same four emitters, for a nearly identical reason.** The debate in §6.1 is
   settled by precedent.
2. **The emitters demonstrably know more than the payload carried.**
   `blendExpenseBusinessFraction` already separates a rental's costs from a home's *inside*
   `HouseRunningCostHandler` and `RealPropertyRepairTickHandler`, and re-reads it per tick so a
   property that stops renting flips. That is finer-grained than the `HOUSING_RUNNING` /
   `HOUSING_REPAIR` split §8 asks for.
3. **`section988` is not a substitute.** It answers "what is the tax character of the currency
   disposed", not "what did the household buy". A home's running costs and a month's groceries
   are both `businessFraction: 0`; `MonthlyExpensesHandler` and `HouseRunningCostHandler` are
   still indistinguishable through it. Inferring `category` from `businessFraction` would be
   §6's own hard rule violated with extra steps.

### 6.1 Two ways to fix it, and the recommendation

**(A) Stamp `category` on the action at emit time. — Recommended, and now precedented (§6.0).**

One field, set by the handler that knows the answer. This is exactly design 82 §2's argument
applied to the flow side: *emit the tuple, decide the grouping in the consumer*. The tuple is
currently missing a column, and every consumer that tries to reconstruct it will reconstruct it
slightly differently.

Cost, restated against today's tree — one item cheaper than the draft assumed and one item more
constrained:

- **Two fields on four emitters**, as siblings of `section988`, not folded into it. They answer
  different questions (§6.0 item 3) and have different consumers. `spendCategory` is the
  category; `capitalFraction` is §8.1's split, carried at the same time because the emitters
  are already open and the blend it needs is the shape `businessFraction` established.
  **Named `spendCategory`, not `category`** — see OQ10: `EXPENSE_EVENT_APPLY` already
  declares a free-text `category` and the same handler emits both in one tick.
- **A `ValueType` in the schema entry of *both* toolsets, identical.** `EXPENSE_DEBIT` is a
  shared type declared in `us-retirement-toolset.js` and `au-retirement-toolset.js`, and
  `registerActionType` is last-writer-wins. `tests/unit/action-payload-schema.test.mjs` has a
  test — *"shared action types declare identical fields in every toolset"* — that fails if they
  drift.
- **No golden re-gold.** `tests/fixtures/golden-*.json` are terminal-**state** fixtures with no
  journal in them, so an action-payload field is inert to the whole golden set. The draft's
  worry here was unfounded.
- **A new gate that did not exist when this was drafted, and it is on our side.** Design 91 §7
  wired the manifest onto the product path, and the same test file's *static emitter scan*
  parses every action literal under `src/` and fails on an emitted-but-undeclared field. So
  forgetting the declaration is now a loud test failure rather than a silently blank column —
  which is precisely the failure mode §6.1(B) was rejected for.

It remains inert for every existing consumer.

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

**BUILT 2026-08-15 — and it needed a SECOND check the draft did not name.** See §18: the
identity alone would still pass if every diff were internally consistent and collectively
wrong, so `account-flow-tie.js` also checks **continuity** — that consecutive journal diffs on
one balance chain `after` to `before`. That is the check protecting the spending totals,
because a break means money moved with no journal entry saying so, and the cube is built
entirely from those diffs.

Both are cheap. Both should fail loudly in a test and degrade visibly in the report.

---

## 8. Categories — the proposed taxonomy

Two tiers, because the second tier is not spending but must be present for §7(a) to hold and
for the chart to be auditable.

### Tier 1 — spending (drawn)

| category | source | notes |
|---|---|---|
| `LIVING` | `EXPENSE_DEBIT` `spendCategory: LIVING` ← `MonthlyExpensesHandler` | the ask's "monthly expenses" |
| `HOUSING_RUNNING` | `EXPENSE_DEBIT` `spendCategory: HOUSING_RUNNING` ← `HouseRunningCostHandler` | design 75 §5.1 |
| `HOUSING_REPAIR` | `EXPENSE_DEBIT` `spendCategory: HOUSING_REPAIR` ← `RealPropertyRepairTickHandler` | lumpy; net of `capitalFraction` — see §8.1 |
| `DISCRETIONARY` | `EXPENSE_DEBIT` `spendCategory: DISCRETIONARY` ← `ExpenseEventHandler` | one-off planned events, net of `capitalFraction` |
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
| `ASSET_PURCHASE` | `PROPERTY_PURCHASE_APPLY`, `COLLECTIBLE_*` acquisitions | a spend by the netting test, an investment by intent |
| `ASSET_IMPROVEMENT` | the `capitalFraction` share of any `EXPENSE_DEBIT` | §8.1's split, kept apart from `ASSET_PURCHASE` — see §16.2 |
| `UNCLASSIFIED` | anything else | §7(a) |

### 8.0 Types the reference plan does not fire  (2026-08-15)

§3's re-measurement found no *new* action type in the debit total — but that is a property of
the plan measured, not of the codebase. These exist today and would land in `UNCLASSIFIED` on
their first run if the allowlist is written only from §3:

| action type | design | where it belongs |
|---|---|---|
| `PROPERTY_PURCHASE_APPLY` | 86 | `ASSET_PURCHASE` |
| `COLLECTIBLE_SALE_APPLY` | 91 §8.9 | `INTERNAL` (proceeds in) / the tax is separate |
| `COLLECTIBLE_VALUE_CHANGE_APPLY` | 91 §4.2 | `REVALUATION` — a mark, and the §2 failure mode |
| capital-loss / §904 family | 90 §4.5 | not a debit; no balance leg |

`SECTION_988_GAIN` (design 87) is worth naming explicitly because it looks like it belongs and
does not: verified on the reference run, 65 action types appear in the journal, 29 touch a
`.balance`, and `SECTION_988_GAIN` is **not** among them. It records character, not money.

This is the case §7(a) was written for, arriving on schedule. Classify these now, and keep
`UNCLASSIFIED` drawn anyway — the point of the band is the type nobody thought of, and this list
is the proof that they keep appearing.

### 8.1 Three decisions inside the taxonomy

- **Is a repair spending or capex?** Design 75 §5.2 already splits it: `capitalizeRepairs`
  fraction lifts `costBasis`, the rest is maintenance. **Follow that split** rather than
  inventing a second one — the capitalised part belongs in `DEBT_PRINCIPAL`'s spirit (wealth
  moved, not consumed) and the rest in `HOUSING_REPAIR`.
  **BUILT (2026-08-15).** The emitter stamps `capitalFraction`, debit-weighted across the
  properties one tick can repair, read from the *same* expression `HOUSE_REPAIR_APPLY` carries
  so the debit and the basis lift cannot disagree. It generalised past repairs on the way:
  `ExpenseEventHandler`'s `capitalize` (design 86 G8) is the identical question, and an
  authored capital improvement stamped wholly `DISCRETIONARY` would have counted an
  investment as a cost. The classification routes the share to `ASSET_IMPROVEMENT`.
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

Measured on the reference plan, the terminal `inflationAccumulator` is **~3.7×**. So the last
bar of a nominal chart is nearly four times the first for *identical* real spending. This is not
a subtlety to caveat; it is the chart's dominant visual signal if left alone.

So: **real base-year dollars are the default view**, with nominal available as a toggle and
never as the default.

A share view (what fraction of outflow is tax) is worth having as a secondary tab, and it *is*
unitless, so it is immune to both of the above — same reason 82's 100% view leads its page.

#### 9.b.1 Design 79 is not a dependency after all  (2026-08-15)

The draft called design 79 "a dependency rather than a follow-up". Re-checked: **79 is still
status `DESIGN`, and this report does not need it.**

`state.inflationAccumulator.US` and `.AU` are **diffed into the journal** — 88 diffs on the
reference run, twice a year per country. So the price-level history is recoverable from a
finished journal by exactly the machinery `JournalFxRates` already uses for the exchange rate
(§9.1). A `JournalPriceLevels` in that same shape is a small, well-precedented class with no
dependency on 79 at all.

79 remains the dependency for an **app-wide** value-basis toggle. It is not the dependency for
*this page*, and conflating the two would have parked phase 2 behind an unstarted design.

**BUILT 2026-08-15** — `src/finance/journal-reporting/journal-price-levels.js`, deliberately a
mirror of `JournalFxRates` (same construction from state diffs, same binary search, same
opening-value seed, same refusal to invent a level it does not have). Measured terminal level on
the reference plan: **3.67×**, and the like-for-like real/nominal ratio on total spending is
**2.30×**. See §17.2 for what that ratio changed.

**Which price level  (decided 2026-08-15).** Convert to USD first (§9.1), then deflate
everything by **`inflationAccumulator.US`** — one denominator for the whole chart. The bands
then add up, the stack total is a real quantity, and it matches the basis the optimiser already
scores in. Deflating each debit by the residence-at-the-time price level is truer to purchasing
power but changes the denominator mid-chart, so a move year would draw a step that is an artefact
of the axis rather than of the plan. On the reference plan the two accumulators are currently
**identical**, so this decision is inert today — which is exactly why it should be written down
now rather than discovered later, given [[au-inflation-differential-pinned-fx]].

**The duplication trap, and it is already four deep.** There is no shared deflator in `src/`.
`optimization-problem.js`, `optimization-objectives.js`, `cockpit-controller.js` and
`AccumulateConsumptionReducer` each divide by an accumulator inline, and
`scripts/lab/spending-trace.mjs` is a fifth. That is design 82 §5.1's duplicated-six-lines
pattern already well underway. **Phase 2 lands a shared deflator alongside the report; it does
not add a sixth copy.**

### 9.1 FX — the draft's proposal is obsolete, and what replaced it is better  (2026-08-15)

> **The original §9.1 said the journal carries no rate and proposed sampling
> `state.effectiveExchangeRates` at design 82's year boundaries. Do not build that.** It is now
> both unnecessary and *coarser* than what shipped in the meantime.

`src/finance/journal-reporting/report-currency.js` landed with design 91 §8 (and the tax-paid
currency fix before it). It provides:

- **`JournalFxRates`** — the run's own USD/AUD history, recovered from a finished journal, from
  `effectiveExchangeRates.USD_AUD` **state diffs**, falling back to the `fxRate` stamped on tax
  settlements for a static-FX run that never diffs the rate, and to live state beyond that. It
  returns `null` rather than a silent `1.0` when no rate is known, so the caller must drop the
  row instead of summing two currencies as one.
- **`ReportDefinition.reportCurrency(params)`** — a report declares the currency its totals are
  in; every summed field is converted **per row, at the row's own date**, into a derived field,
  leaving the drill-down showing the native amount.
- **`STATE_VALUED_FIELDS`**, which includes **`stateDelta`** — its unit comes from the state
  schema (the account's own currency) rather than from the action payload. That is precisely
  the field §10 says this report must sum.

So the seam this design needed already exists, is shared, and resolves at diff granularity
rather than at a year boundary. Three of the draft's paragraphs collapse into one line: **give
the report a `reportCurrency` and sum `stateDelta`.** `CashFlowByAccountDef`,
`DebitsFromAccountDef` and `MoneyMovedByActionDef` all already do exactly this.

The underlying problem was real and is now sized: on the reference plan the debit total splits
**USD 70.2% / AUD 29.8%** by the debited account's currency. Summed raw, that is a number in no
currency — the same defect design 82 §5.3 found in `computeGuardrailPortfolioValue` (a 10.57%
overstatement, silent because USD accounts came out right by accident), and the one design 91
§8.7 measured at a 16.3% overstatement on a disposal-proceeds column.

**Limitations to state on the page**, replacing the draft's two:

- **The unit comes from `StateSchemaRegistry`, and one build path does not populate it.**
  `buildAndCompile` registers zero accounts ([[state-schema-registry-unregistered-on-compiler-path]]),
  so on that path `stateDelta` has no currency and conversion silently degrades. The report must
  detect an unregistered schema and say so rather than render.
- Design 87's §988 pools mean the *tax* consequence of holding foreign currency is a separate
  question this chart does not answer.
- The rates are the run's own modelled path. Design 92 (PROPOSED) would let that path be a
  published series instead; nothing here changes if it lands, which is the point of reading the
  rate out of the journal rather than inventing one.

---

## 10. Reproducing §3 and §4

```bash
node scripts/probes/probe-spending-composition.mjs --scenario <plan.json>
node scripts/probes/probe-spending-composition.mjs          # synthetic default, smoke test
```

The original measurement came from a throwaway probe, deliberately not committed — and by the
time this design was reviewed it had gone stale enough to change the headline (§14). **Shares go
stale; the classification does not.** So the probe is now committed:
§3 is something anyone can re-run, not something this document asserts.

It makes two passes, and the comparison between them is the point:

- **RAW** — walk `sim.journal.journal` under `telemetry: 'full'`, sum every `stateDiff` whose
  `field` ends in `.balance` and whose `delta` is negative, grouped by `entry.action.type` and
  again by `(type, field)`. Account currency comes off `state[key].currency` — remembering it is
  a `{code, symbol}` **descriptor**, not a string (82 §5.3).
- **CONVERTED** — the same cut through `runReport` with a `reportCurrency`, composing the two
  shipped definitions (`money-moved-by-action`'s group-by-`actionType` and
  `debits-from-account`'s `stateDelta < 0`) rather than reimplementing either.

Composing the shipped defs is deliberate. §9.1's whole finding is that this design nearly built
a private FX path next to one that already existed; a probe that measured a private copy would
have proved nothing about the report. It is also what surfaced §3.1 — the report's own scope —
which a private walk would have hidden by construction.

**The trap that makes this worth writing down.** `EXPENSE_DEBIT` appears in the journal **three
times per month, with identical `amount` and `targetKey`**, because three reducers consume it
— `ExpenseDebitReducer` plus the two consumption accumulators — and the journal records one
entry per reducer application. Only the first moves money; the other two touch
`cumulativeConsumption*` only.

> **Summing `action.data.amount` over journal entries therefore returns exactly 3× the truth.**
> Measured, and exactly 3.000×, which is the kind of ratio that looks like a unit error and is
> not.

**Re-verified 2026-08-15: still exactly 3.0000**, still three reducers
(`ExpenseDebitReducer`, `AccumulateConsumptionReducer`, `AccumulateConsumptionUtilityReducer`).
It survived designs 86, 87, 88, 90 and 91 unchanged. Worth recording, because the fix implied by
"divide by three" is the fragile one: **a fourth `EXPENSE_DEBIT` reducer would silently make it
÷4 and no test would notice.** §5's intent series must therefore be built by taking one value
per dispatch (the first entry of the group, or a distinct count), never by dividing by a
constant.

The report must sum the **realized `stateDelta`** — `JournalDataSource`'s `perDiff: true`
projection, which every existing cash-flow `ReportDefinition` already uses. This is the flow
analogue of design 82 §2.1's "buckets, not holdings": the natural-looking field is the wrong
one, and the wrongness is invisible because the result is plausible. It is also, per §9.1, the
field whose currency the conversion layer already knows.

---

## 11. Where it lives

The existing `ReportDefinition` registry already has `DebitsFromAccountDef`,
`CashFlowByAccountDef` and `RealPropertyCashFlowDef` — all `perDiff`, all journal-derived, all
table-only. **This report is genuinely one of those, plus a chart**, which is the opposite of
design 82 §6's situation (state-sampled, so a *sibling* of `ReportDefinition` rather than a
subclass).

> **2026-08-15: the registry gained `MoneyMovedByActionDef`** — `perDiff`, grouped by
> `actionType`, summing `absStateDelta` (gross) and `stateDelta` (net), with a `reportCurrency`.
> That is **§3's probe, already shipped as a report.** Phase 1's cube is therefore a
> *classification layer over that query*, not a second journal walk — and §3 itself is now
> reproducible from the app rather than from a throwaway script (§10 stands as the description
> of the mechanism, not as the only way to run it).
>
> Still true: **no chart-bearing `ReportDefinition` exists.** `allocation-plugin.js` remains
> standalone, so §11's "this is the second" claim is intact and the abstraction question 82
> deferred is still the one to answer here.

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

### 11.1 Phasing  (revised 2026-08-15)

| phase | what | why first |
|---|---|---|
| **0** ✅ | **re-measure §3 and §4 in converted dollars** — `scripts/probes/probe-spending-composition.mjs` | **DONE 2026-08-15.** Every share in §3 was a face-value USD/AUD mix; the taxonomy is now argued from converted numbers. Found §3.1 as a bonus. |
| **1** ✅ | `spendCategory` + `capitalFraction` on the four `EXPENSE_DEBIT` emitters (§6.1 A), siblings of `section988` | **DONE 2026-08-15.** Nothing below was buildable without it. Named `spendCategory` (OQ10) and carrying §8.1's split in the same pass (OQ11). |
| **2** ✅ | classification module + cube + §7(a) invariant test | **DONE 2026-08-15.** `src/finance/spending-reporting/`. §7(a) holds on the reference plan with **zero** `UNCLASSIFIED`; genuine outflow **50.1%**. |
| **3** ✅ | lab HTML page: real-terms default (`JournalPriceLevels`, §9.b.1), shared deflator, intent line | **DONE 2026-08-15.** `scripts/lab/spending-report.mjs` + `spending-grouping.js`, `spending-palette.js`, `journal-price-levels.js`. Real is the default; nominal and share are toggles. |
| **4** ✅ | §7(b) flow-ties-to-stock invariant against 82's samples | **DONE 2026-08-15.** `account-flow-tie.js`. Holds exactly on the reference plan: 945 account-years, 8,464 balance movements, **0** breaks. |
| **5** ✅ | workbench panel | **DONE 2026-08-15.** `spending-plugin.js` + `spending.css`. Reads the run's journal and samples; never re-steps. Verified in the running app: `✓ classification total · ✓ ties across 945 account-years`. |
| **6** ✅ | Monte Carlo — spending as a distribution | **DONE 2026-08-15.** `spending-distribution.js` + `scripts/lab/spending-mc.mjs`, opt-in on the MC runner. Measured on the reference plan: **P(tax > 50% of what the plan costs) = 57%**. |

**What changed from the draft's phasing, and why.**

- **A new phase 0.** The draft opened with the emitter change. But §9.1's machinery already
  exists and §3's numbers are currently mixed-currency, so converting first is cheap, needs no
  sim change at all, and is the only way the taxonomy argument rests on real shares. It also
  smoke-tests `reportCurrency` on this journal before anything depends on it.
- **`CARE` is deferred, not built in phase 1.** OQ2's answer stands — care needs its own flag,
  because `LATE_LIFE_CARE_APPLY` scales `monthlyExpenses` upstream of the debit and the derived
  version cannot separate a care-inflated living expense from a large one. But that is a change
  in the care path, not a stamp on an emitter, and holding phase 1 for it would hold up the
  field everything else depends on. Ship `category` with the four known values; add `CARE` as
  its own step, before the page claims to show the cost of care.
- **The §5.1 measurement is its own item**, sequenced before phase 3 because it is the same
  number as "how visible will the unmet band be".

Phases 0–2 are the ones that decide whether the chart means anything; 3–6 are 82's playbook
applied again.

---

## 12. Questions — answered 2026-08-15

| # | question | answer |
|---|---|---|
| 1 | Category on the action (§6.1 A) or a handler-id field the consumer maps? | **On the action** — and no longer a judgement call: design 87 already stamped a per-emitter field on these same four handlers (§6.0). A handler id is an implementation detail that would leak into the report's vocabulary and break when a handler is split. |
| 2 | Does `CARE` need its own flag, or is "expenses while care is active" enough? | **Own flag, deferred to its own step.** The factor is applied upstream of the debit, so the derived version cannot separate a care-inflated living expense from a large one — but it is a change in the care path, not an emitter stamp, and phase 1 must not wait on it (§11.1). |
| 3 | Draw tier 2 below the axis, in a separate strip, or behind a toggle? | **Separate strip.** Below-axis reads as negative spending; a toggle hides the audit, and the audit is the point (§7a). |
| 4 | Gross-up for taxes withheld at source (wages) — spending or never-received income? | **Never-received income**, so out of scope here — but it means the tax band understates lifetime tax, which the page must say. |
| 5 | Should the AU super fund tax be drawn (§8.1)? | **Yes**, hatched and labelled. |
| 6 | Year-boundary FX (§9.1) or stamp a rate on every cash-moving action? | **Neither — the question is moot.** `report-currency.js` / `JournalFxRates` shipped with design 91 §8 and converts per row at the row's own date, finer than the year boundary and requiring no action-shape change. See the rewritten §9.1. |
| 7 | Does this subsume `scripts/lab/spending-trace.mjs`? | Probably, eventually. Not in phase 3 — that tool is load-bearing for the adaptive-strategy question and should not be replaced by an unproven one. |
| 8 | Which price level deflates a chart mixing USD and AUD debits? | **Single US base-year**, after converting to USD. One denominator, so the bands add and the stack total means something; matches the optimiser's basis. Inert on the reference plan today (§9.b.1). |
| 9 | Fix `AccumulateConsumptionReducer`'s intent/realized gap here (§5.1)? | **CLOSED — all five steps A–E done (§5.2–§5.6).** Booked as realized; the deflator axis is stamped by the emitter. The deficit term is untouched, and `cumulativeDeficit`'s mixed-currency nominal unit is recorded as separate scope belonging to the objective work. |
| 10 | Call the new `EXPENSE_DEBIT` field `category`, as §6.1 and §8 assumed? | **No — `spendCategory`.** Found while building phase 1: `EXPENSE_EVENT_APPLY` already declares a `category` (free text, authored in the scenario — `'travel'`, `'other'`), and `ExpenseEventHandler` emits both actions in the *same tick*. Two fields named `category` in one journal, one a closed reporting vocabulary and the other the author's prose, is a join waiting to be made by accident. Distinct names make the mistake impossible rather than merely unlikely. §6.1/§8 now read `spendCategory`. |
| 11 | Does phase 1 stamp a flat category per emitter (§15.3) or carry §8.1's capitalized split? | **Both, in one pass.** §15.3 said flat; §8.1 said follow design 75's `capitalizeRepairs` split. Building the flat version first and reopening the same four emitters later is the more expensive order, and the blend pattern was already there — `capitalFraction` is a third sibling of `businessFraction` and `priceLevel`, accumulated debit-weighted in the same loop. See §8.1 and §16.2. |

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
| **87** (§988 currency pools) | **the precedent for §6.1(A)** — it already stamped `section988` on all four `EXPENSE_DEBIT` emitters (§6.0). Also the reason §9.1 states an FX limitation rather than implying precision. |
| **71 / 73** (tax export) | the actions that stamp an `fxRate`; now the *fallback* source inside `JournalFxRates` for a static-FX run rather than the whole answer. |
| **91** (journal payload manifest) | **what makes "emit the tuple" enforceable.** §7 wired the manifest onto the product path, §8 shipped `report-currency.js` (which obsoletes §9.1's proposal), and its static emitter scan is the gate that fails when phase 1's `category` is emitted but undeclared. |
| **90** (equity fidelity, capital losses) | changed what the tax bands are made of; its §4.5 family is one of §8.0's unfired types. |
| **92** (FX observation overlay) | PROPOSED. Would make §9.1's rates observed rather than modelled. Nothing here changes if it lands — which is the payoff of reading the rate out of the journal. |
| **86** (leveraged property) | also supplies §4.1's offset account: the reference plan's AU loan now pays **zero** interest, so the mortgage double-count is total on that row rather than partial. |

---

## 14. What the 2026-08-15 review changed

For anyone holding the original in their head. Every item was measured on today's `main`
against the same reference plan, not reasoned about.

| § | change |
|---|---|
| **3** | table re-measured **and converted** (phase 0). Genuine outflow 61.5% → **51.0%**; the overstatement is **96%**, not 63% — it nearly doubles. `EXPENSE_DEBIT` falls 27.4% → 20.6% on conversion while every other line rises, because expenses are AUD-funded and AU tax is USD-funded. `HOLDING_TRANSACT` is now the largest line in the table. No new action type appeared. Cross-checked on the synthetic default. |
| **3.1** | **new, and unplanned.** The shipped reports scope to `accountBalanceKeys()`, and the loan accounts are not registered — so they already drop the mortgage double-count and the sale payoff, *by accident*. Registering them for any other reason silently brings the double-count back. |
| **4** | both figures reproduce. New §4.1: the offset case is the reference plan's actual state, 88.6% of the type's debits are 100% principal, and `interest` is already on the declared payload. |
| **5** | new §5.1 — `AccumulateConsumptionReducer` books **intent**, so the optimiser's own consumption metric already fell into §5's gap. Plus a currency→residency conflation in the same reducer. Carries an ordered A–E plan, step C due before phase 3. |
| **5.6** | **step E BUILT, and its premise was wrong.** The "same file, same test" fix does not exist: the deflator is **residence** for living costs, **`prop.country`** for property costs, and `HouseRunningCostHandler` blends several properties into ONE debit. So `priceLevel` is now stamped by all four emitters (harmonic-mean blend — the arithmetic mean understates real consumption by 10.7% on a 60/40 split) and declared in both toolsets. Measured inert (0.00%) — because the old code was right by an agreement between two handlers, not by construction. Converges with phase 1, which touches the same four emitters. |
| **5.5** | **step D BUILT.** `ExpenseDebitReducer` stamps `realizedAmount`; both accumulators read it; declared in both toolsets so the journal carries intent and realized side by side (phase 3's intent line, free). Solvent plan **byte-identical**, whole golden set unchanged, no re-gold. Measured: the CRRA utility gradient was **rising** with ruin under the old code — an *inverted* signal, not an absent one — and step D reverses its sign. |
| **5.4** | **step C decided: realized.** The exposure map is the reason — `feasibilityFirst` defaults to **false** outside MPC, and `MAX_CRRA_UTILITY` carries **no deficit penalty at all**, so on that objective nothing opposes the overstatement and switching to realized is what gives it a ruin signal. Also found: `DEFAULT_DEFICIT_PENALTY`'s own comment prices "1 from consumption" per deficit dollar — the defect was known and swamped rather than fixed. Mechanism chosen (§5.4.4): the debit reducer stamps the realized amount, as it already does for `section988.accountKey`. |
| **5.3** | **step B built** — `tests/unit/consumption-intent-gap.test.mjs`, verified by mutation (5 fail / 5 pass, split exactly on the labels; the mutation corrected two of them). Found: `AccumulateConsumptionUtilityReducer` has the identical defect, so step D's scope is **two** accumulators. Also pinned: reducer order is not the cause. |
| **5.2** | **step A measured.** Zero on the solvent plan (latent), but under stress `cumulativeConsumption` tracks the *expense assumption* while realized spending saturates — 53% → 276% → 660% overstatement at 2/4/8× — so **the optimiser's gradient points at insolvency**. Found unlooked-for: `cumulativeDeficit` is a **nominal mixed-currency** sum while `cumulativeConsumption` is **real USD**, so the penalty term cannot cleanly oppose it. Step C's leaning is now a recommendation: realized. |
| **6** | new §6.0 — design 87 already stamps a per-emitter field on all four emitters. §6.1's cost corrected: **no golden re-gold**, but a new static-scan gate and a both-toolsets-identical test. |
| **8** | new §8.0 — four action types exist that the reference plan never fires; `SECTION_988_GAIN` touches no balance. |
| **9b** | **design 79 is not a dependency.** `inflationAccumulator` is diffed into the journal, so `JournalPriceLevels` mirrors `JournalFxRates`. Terminal price level ~3.7×. Decided: single US base-year. Flagged: four private deflators already exist. |
| **9.1** | **rewritten.** The year-boundary sampling proposal is obsolete — `report-currency.js` / `JournalFxRates` converts per row at the row's own date. New limitation: the compiler path registers no accounts, so the unit degrades there. |
| **10** | 3.0000× re-verified. Added: never fix it by dividing by a constant. The probe is now **committed** (`scripts/probes/probe-spending-composition.mjs`) rather than throwaway — §3 is re-runnable, not quoted. |
| **11** | `MoneyMovedByActionDef` is §3's probe already shipped as a report. Still no chart-bearing `ReportDefinition`, so "this is the second" stands. |
| **11.1** | new phase 0 (FX-normalise §3 first); `CARE` deferred out of the emitter phase. |
| **12** | OQ6 moot, OQ1 settled by precedent, OQ2 refined; OQ8 and OQ9 added and answered. |

---

## 15. Where this stands, and where to pick it up

Written at the close of the 2026-08-15 session. Read this first; §14 is the diff against the
original draft, and everything below it is detail.

### 15.1 What shipped

| | what | files |
|---|---|---|
| **Phase 0** | §3 and §4 re-measured **in converted dollars**, through the shipped `reportCurrency` machinery rather than a private walk. Found §3.1. | `scripts/probes/probe-spending-composition.mjs` |
| **§5.1 A–E** | The consumption accumulators booked **intent**; they now book **realized**, and the deflator axis is stamped by the emitter rather than guessed from the account's currency. | `expense-debit-reducer.js`, both `accumulate-consumption*` reducers, all four `EXPENSE_DEBIT` emitters, both retirement toolsets, new `src/finance/spending/expense-price-level.js` |
| | Characterisation + regression tests, verified by mutation. | `tests/unit/consumption-intent-gap.test.mjs` (22 tests) |
| | Sizing tool, now a permanent regression detector. | `scripts/probes/probe-consumption-intent-gap.mjs` |

Full suite green throughout, **no re-gold at any step**. Solvent runs are byte-identical, which
is the evidence that the optimiser fix cannot have moved a feasible result.

**No chart was built.** Phases 1–6 are untouched.

### 15.2 The three things worth remembering

- **A later design had already built the seam this one specified.** §9.1 proposed sampling FX at
  design 82's year boundaries; `report-currency.js` had shipped with design 91 §8 and does it per
  row at the row's own date. Design 79 was likewise dropped as a dependency once
  `inflationAccumulator` turned out to be journaled. **Before building anything else here, grep
  for the seam first** — designs 87 and 91 kept building reporting plumbing that other designs
  were about to specify.
- **Three findings came from running the shipped code rather than a private copy.** §3.1 (the
  reports cannot see the loan accounts) only appeared because phase 0 composed real
  `ReportDefinition`s. The intent gap's true size only appeared because the probe cross-checked
  itself against `state.cumulativeConsumption` — a check that caught a 3× error *in the probe*.
- **Two of the five A–E steps overturned their own premise.** Step B's assertion ("the gap equals
  the deficit") was false; step E's scope ("same file, same test") was impossible. Both were
  written before the measurement existed. Treat the remaining phases' details the same way.

### 15.3 Start here next session — **phase 1**

Stamp `category` on the four `EXPENSE_DEBIT` emitters (§6.1 A). It is the one thing nothing else
can proceed without, and it is now **materially cheaper than the draft assumed**:

- **Three of its four costs are already paid.** Those same four emitters now stamp `section988`
  (design 87), `realizedAmount` (§5.5) and `priceLevel` (§5.6), each declared in both toolsets.
  `category` is one more key in a block that already exists — not a new pattern to argue for.
- **No golden re-gold.** The fixtures are terminal-state JSON with no journal, so an action
  payload field is inert to them. Verified three times this session.
- **The gate is on your side.** `tests/unit/action-payload-schema.test.mjs` fails on an
  emitted-but-undeclared field and on the two toolsets drifting apart. Declare it in **both**,
  identically.
- **Values:** `LIVING`, `HOUSING_RUNNING`, `HOUSING_REPAIR`, `DISCRETIONARY` — one per emitter
  (§8 tier 1). **`CARE` is deliberately out of phase 1** (§11.1): it needs a change in the
  `LATE_LIFE_CARE_APPLY` path, not an emitter stamp, and holding phase 1 for it blocks
  everything.

Do **not** infer the category from `businessFraction`, `targetKey`, amount or cadence. §6's hard
rule, and §6.0 item 3 records why `section988` in particular looks like it would work and does
not: a home's running costs and a month's groceries are both `businessFraction: 0`.

### 15.4 Open items this session created, deliberately left

| item | why it is not ours | where |
|---|---|---|
| `cumulativeDeficit` is a **nominal mixed-currency** sum while `cumulativeConsumption` is real USD, so the penalty cannot cleanly oppose the reward | belongs with the objective work; fixing it inside a spending-chart change would have destroyed step D's measurement | §5.2, §5.4.3 |
| The dependent MC / optimiser arms are **not re-run** | [[defer-long-mc-reruns]]; the cheap checks (solvent byte-identical, goldens unchanged) are the substantive evidence | §5.5.2 |
| Repairs are **never indexed**, so they shrink in real terms over a long plan | a design 75 modelling question, not a deflator bug | §5.6.2 |
| The shipped reports **cannot see the loan accounts**, so they drop the mortgage double-count *by accident* | registering them for any unrelated reason silently brings it back; phase 2's allowlist must reject `DEBT_PRINCIPAL` explicitly rather than lean on the scope | §3.1 |

---

## 16. Phases 1 and 2 — what shipped  (2026-08-15, second session)

§15 is the previous session's close and stands as written. This section replaces §15.3
as the "start here" pointer.

### 16.1 What shipped

| | what | files |
|---|---|---|
| **Phase 1** | `spendCategory` + `capitalFraction` stamped by all four `EXPENSE_DEBIT` emitters, declared identically in both retirement toolsets. | `spend-category.js` (new), the four emitters, both toolsets |
| | 11 tests, verified by mutation (4 mutations, each failing exactly its own tests and nothing else). | `tests/unit/spend-category.test.mjs` |
| **Phase 2** | The allowlist, the cube, and §7(a). | `src/finance/spending-reporting/spending-classification.js`, `spending-cube.js` (both new) |
| | 19 tests, verified by mutation (6 mutations, same discipline). | `tests/unit/spending-cube.test.mjs` |

Full suite green throughout — 5077 unit + 1023 viz — and **no re-gold at any step**, as
§15.3 predicted: the golden fixtures are terminal-state JSON with no journal, so an
action-payload field is inert to them.

**Measured on the reference plan.** §7(a) holds to a relative drift of 2.5e-7 with **zero
`UNCLASSIFIED`**; genuine outflow is **50.1%**, so a chart of "all debits" overstates the
cost of the plan by **99%**. That is §3's headline, now computed by the shipped
classification rather than by an inline allowlist inside a probe.

**Still no chart.** Phases 3–6 are untouched.

### 16.2 The four things worth remembering

- **The field could not be called `category`.** `EXPENSE_EVENT_APPLY` already declares one
  — free text, authored in the scenario — and `ExpenseEventHandler` emits both actions in
  the same tick. §6.1 and §8 had assumed the name was free. It was not, and nothing in the
  design would have caught it: the collision only appears when you open the emitter. OQ10.
- **§8.1's capex split generalised past repairs before it was built.** The design framed it
  as a repair question. `ExpenseEventHandler`'s `capitalize` (design 86 G8) is the identical
  question, so an authored capital improvement would have been stamped wholly
  `DISCRETIONARY` — an investment counted as a cost, which is §8.1's own complaint. Both
  emitters now carry the fraction. Building it in phase 1 rather than later cost about three
  lines, because the debit-weighted blend was already the established shape.
- **The default test scenario has no loan and no property.** Measured, after the first draft
  of the phase-2 tests passed: `DEBT_PRINCIPAL`, `INTEREST`, both housing categories and
  `ASSET_IMPROVEMENT` never fire on `scenario-harness.js`'s scenario, so every assertion
  about the split rules — the rules most worth proving — was passing over an empty set.
  `spending-cube.test.mjs` now builds its own property-and-mortgage plan and opens with a
  test that the fixture still fires all eight categories.
- **The loan balances declare a currency KIND with a null CODE.** `usHousePropertyLoan.balance`
  resolves to `{ kind: 'currency', currencyCode: null }`. `normalizeAggregateCurrency` treats
  an undeclared unit as already-in-target, which for an AUD loan would understate the
  principal by the exchange rate — silently, since the reports drop these keys by scope
  today (§3.1) and nothing converts them. The cube resolves the schema first and falls back
  to the account's own `currency.code`. This is §3.1's warning arriving from a second
  direction: the accidental drop hides a unit bug as well as a double-count.

### 16.3 Two decisions inside phase 2

- **The cube's domain is the RAW universe, not the report scope.** §11 said phase 2 would be
  "a classification layer over that query", and it is for the conversion and the rate
  history — but not for the scope. `_appendAccountBalanceScope` narrows to
  `accountBalanceKeys()`, which §3.1 measured does not contain the loan accounts, so scoping
  the cube to it would make §7(a) vacuous over exactly the legs §4 is about. The registered
  set is reported as `coverage` — an annotation, not a filter — and `SC7-2` is the test that
  pins the difference.
- **`ASSET_IMPROVEMENT` is one category more than §8 proposed.** §8.1 rules that a
  capitalized repair belongs "in `DEBT_PRINCIPAL`'s spirit", which places it in tier 2, but
  folding it into `ASSET_PURCHASE` would say a re-roofing and buying a second house are the
  same event. Merging two categories later is a line in the consumer; splitting one that was
  never recorded apart means re-running.

### 16.4 Start here next session — **phase 3**  *(done — see §17)*

The lab HTML page (§9): bars not areas, real-terms by default, tier 2 in a separate strip
(OQ3), and the tie-out line above the chart. `spendingSummary()` and
`checkClassificationTotal()` exist to feed that line — the page should print the §7(a) drift
and the coverage list rather than assert them silently.

Before writing the page, **grep for the seam** (§15.2's rule, which paid off twice this
session). Specifically: `JournalPriceLevels` is named in §9.b.1 but **does not exist on
disk** — only `JournalFxRates` shipped. Phase 3's real-terms axis needs it, and the
`priceLevel` now stamped on every `EXPENSE_DEBIT` (§5.6) may make it unnecessary for the
spending bands while still being needed for the tax ones.

> **Resolved in §17.** `JournalPriceLevels` was built, as a mirror of `JournalFxRates`. The
> stamped `priceLevel` did **not** turn out to substitute for it: it is per-emitter and
> per-economy, which is what the consumption accumulators need, whereas the chart needs ONE
> denominator across every category including the taxes (§9.b.1's decision). The two coexist
> and answer different questions.

### 16.5 Open items this session created, deliberately left

| item | why it is not ours | where |
|---|---|---|
| `CARE` still unbuilt | unchanged from §15.3 — it needs a change in the `LATE_LIFE_CARE_APPLY` path, not an emitter stamp | §11.1, OQ2 |
| `FX_COST` (§8 tier 1) is classified nowhere | no action carries a separable fee field, and differencing two converted amounts to infer one is the inference §6 forbids | §8 |
| The AU super-fund tax (§8.1, OQ5) is not in the cube | it never debits a member account, so it is not a negative balance delta at all — it has to be *added* by the page, hatched, not classified here | §8.1 |
| `DEBT_PRINCIPAL` is deliberately double-counted | both the cash leg's principal share and the loan account's own leg are real negative deltas, so §7(a) needs both; tier 2 is what keeps them out of the spending total | §4, `CLS-5` |

---

## 17. Phase 3 — the page  (2026-08-15)

### 17.1 What shipped

| | what | files |
|---|---|---|
| deflator | `JournalPriceLevels` — the run's own inflation history, recovered from `inflationAccumulator` state diffs. Mirrors `JournalFxRates` exactly. | `src/finance/journal-reporting/journal-price-levels.js` |
| cube | Every row gained `amountReal` and, where a debit can be capped, `intent` / `intentReal`. | `spending-cube.js` |
| pivot | Per-year series, the two tier strips on one axis, and the intent line. | `spending-grouping.js` |
| palette | One hue per category, shared with the eventual panel. Tier 1 chromatic, tier 2 desaturated, `UNCLASSIFIED` deliberately loud. | `spending-palette.js` |
| page | Bars not areas, real by default, nominal + share toggles, tie-out above the chart. | `scripts/lab/spending-report.mjs` |
| tests | 21, mutation-verified (8 mutations). | `tests/unit/spending-grouping.test.mjs` |

Rendered and inspected in a browser on the reference plan and on the synthetic default.
Full suite green: 5098 unit + 1023 viz.

### 17.2 Real terms changed a conclusion, not just an axis

§9(b) argued for real terms on the grounds that a nominal chart's bands all rise with
inflation. Measured, it does more than that: **the largest single cost of the reference
plan is different in the two units.**

| | nominal | real |
|---|---|---|
| total spending | \$23.3M | \$10.1M (2.30×) |
| largest cost | `TAX_AU` | `LIVING` |
| tax as a share of spending | 59% | 53% |

`TAX_AU`'s two big events land late, where the deflator is largest, so nominal
attribution overstates them against the flat real living cost that ran for 45 years. A
nominal chart would have named the wrong thing as the plan's biggest expense. §9(b) was
right for a weaker reason than the one that turned out to matter.

### 17.3 Three defects the browser found that the tests did not

- **Two headline cards, two different quantities.** The first draft paired nominal
  *spending* (\$23.3M) against real *all-debits* (\$22.6M). They land 3% apart on this
  plan by coincidence, so the card read "inflation barely matters here" while the
  like-for-like ratio was 2.30×. Every totality and unit test passed throughout — the
  defect was entirely in which two numbers were placed side by side. Fixed by making
  `spendingSummary` report both units of the *same* quantity, and `categoriesByValue`
  carry both per category.
- **`Number(null)` is `0`, and `0` is finite.** `intentVsRealized` guarded with
  `Number.isFinite(Number(row.intentReal))`, so every tax row — which has no intent, by
  design — was counted as *intending nothing*. The intent line sat permanently below the
  stack, drawing a chronic shortfall on a plan that never missed a payment. Found by
  printing the series, not by a test; the regression is now `INT-1`.
- **Two vacuous fixtures, one after the other.** The phase-3 broke-plan fixture had a
  single cash account, so it produced **no tier-2 rows at all** and every real-vs-nominal
  tier assertion was passing over an empty set. Caught only because `UNIT-1` asserts its
  own fixture is non-empty first. Same failure as §16.2's third item, one session later —
  see [[harness-scenario-has-no-loan-or-property]].

Two of the eight mutations initially failed *nothing*, which is the same lesson from the
other side: a relational assertion (`real ≤ nominal`, ordering monotone) is satisfied by a
bug that copies the nominal figure into the real field. Both tests now compute the
expected value independently rather than checking a relationship between two outputs.

### 17.4 Start here next session — **phase 4**  *(done — see §18)*

§7(b), the flow-ties-to-stock invariant: `openingBalance + Σcredits − Σdebits === closingBalance`
per account per year, read against design 82's year-boundary samples. It is the invariant
worth the most, because it is what makes the spending chart and the allocation chart one
picture rather than two plausible ones — and the cube already carries `stateKey` and `year`
on every row, so the debit side needs no new machinery. The credit side does: this cube is
debits-only by construction.

Then phase 5 (workbench panel — `spending-grouping.js` and `spending-palette.js` exist so it
reads the run's samples rather than re-deriving anything) and phase 6 (Monte Carlo).

### 17.5 Open items

| item | why it is not ours | where |
|---|---|---|
| The four private deflators are still four | §9.b.1 asked for a shared one "alongside the report"; `JournalPriceLevels` is journal-derived and the existing four divide by live state mid-run. They are a different seam, and folding them in is design 79's app-wide toggle, not this page | §9.b.1 |
| `CARE`, `FX_COST`, the AU super fund tax | unchanged from §16.5 | §16.5 |
| The page does not detect design 79's basis toggle | it does not exist yet; the page states its own basis instead | §9.b.1 |

---

## 18. Phase 4 — the flow ties to the stock  (2026-08-15)

### 18.1 What shipped

`src/finance/spending-reporting/account-flow-tie.js` and 18 mutation-verified tests in
`tests/unit/account-flow-tie.test.mjs`, plus a **Flow ties to stock** section on the lab
page and a verdict line in the provenance block. Full suite green: 5116 unit + 1023 viz.

**It holds, exactly.** On the reference plan: 945 account-years across 21 accounts and 45
years, 8,464 balance movements, **zero** failures at a one-cent absolute tolerance and
**zero** continuity breaks. On the synthetic default: 224 account-years, 2,003 movements,
zero. The spending chart and design 82's allocation chart are the same run described twice.

### 18.2 §7(b) needed a second check the draft did not name

The identity as written compares journalled flows against sampled balances. That is a real
cross-check, but it has a blind spot: **it would still pass if every diff were internally
consistent and collectively wrong.** So the module checks two things, and the second is the
one actually protecting this page's totals:

| check | what it asks | what a failure means |
|---|---|---|
| **continuity** | do consecutive diffs on one `<key>.balance` chain, `after` to `before`? | money moved with **no journal entry saying so** — money no band on this page could ever contain, because the cube *is* those diffs |
| **the tie** | `opening + credits − debits === closing`, journal against live-state samples | two independent readings of one quantity disagree |

Continuity needs no sampler and no state: it asks whether the journal is a complete account
of itself. It is cheap, it is the stronger guarantee for a *flow* report, and it was not in
the draft.

### 18.3 Four decisions

- **The first year is checked, not skipped.** It has no prior boundary sample, so its
  opening comes from the journal's first `before` per key — the same seed idea
  `JournalPriceLevels` uses (§17). Skipping it would leave the plan's opening year, often
  its largest, as the one year nothing checks. `TIE-2` pins it, and a mutation that skips
  the year fails only that test.
- **The tolerance is one cent ABSOLUTE, never relative.** A relative band passes a \$50
  break on a \$10m account — which is the account it matters on. `TIE-6` is the pair: the
  \$50 break fails, a sub-cent rounding difference passes.
- **No samples is `unchecked`, not `ok`.** A green tick over an empty set is the failure
  mode design 82 §3 and `action-payload-schema.test.mjs` both grew explicit guards for.
  `checkFlowInvariant` returns `ok: false` with "not checked" rather than passing.
- **Balances stay in each account's own currency, unconverted.** The identity is an
  accounting statement *within* one account; converting it would introduce an FX error into
  the one check whose entire value is being exact. Stated on the page.

### 18.4 Why this does not reuse the spending cube

The cube is debits-only by construction — §7(a) is about where money *goes*, and a credit
has no category in that taxonomy. The identity needs both sides, unclassified, including
the movements the classification would route to `UNCLASSIFIED`. Building it on the cube
would make the invariant depend on the thing it is supposed to be checking.

### 18.5 Start here next session — **phase 5**  *(done — see §19)*

The workbench panel. `spending-grouping.js` and `spending-palette.js` exist precisely so it
reads the run's samples rather than re-deriving anything, and §11's non-negotiable applies:
the pivot lives in `src/` and the panel ships precomputed series. Note that the panel will
need the balance sampler wired the same way the page wires it, or its §7(b) line degrades
to "not checked".

Then phase 6, Monte Carlo — spending as a distribution ("how often is tax > N% of outflow").

### 18.6 Open items

| item | why it is not ours | where |
|---|---|---|
| The tie is not run in CI against the reference plan | it is run against a purpose-built fixture; the reference plan is the user's private scenario and cannot be a test input | [[design-docs-are-public]] |
| Continuity assumes journal `seq` order per key | true today for every path measured; a parallel or reordered execution model would need a per-key sort first | §18.2 |
| `CARE`, `FX_COST`, the AU super fund tax | unchanged from §16.5 / §17.5 | §16.5 |

---

## 19. Phase 5 — the workbench panel  (2026-08-15)

### 19.1 What shipped

`src/visualization/workbench/plugins/finance/spending-plugin.js`,
`assets/css/plugins/spending.css`, registration in `finance-plugin-package.js` (id
`spending`, center pane, next to `allocation`), and 15 mutation-verified tests in
`tests/viz/spending-plugin.test.mjs`. Full suite green: 5116 unit + 1038 viz.

Verified **in the running app** on the reference scenario, not only in jsdom: the panel
reports `✓ classification total · ✓ ties across 945 account-years · cost \$10,128,468 real
of \$22,646,651 moved · "all debits" overstates by 99%`, and its 945 matches the lab page's
exactly. The tab appeared without any layout surgery, confirming
[[workbench-new-tab-invisible]]'s fix still holds.

Three views: **What it cost** (tier 1, bars, intent line), **What it merely moved**
(tier 2), **Flow ties to stock** (the §7 b grid). Real / nominal / share, with real the
default and the switch hidden on the tie grid where it means nothing.

### 19.2 One sampler slot, two designs

`buildSim` takes **exactly one** sampler and design 82's `createAllocationSampler` owns it
in `workbench-app`. The alternative — having this panel reconstruct closing balances from
the journal — would have made §7(b) compare the journal against itself, which is precisely
the blind spot §18.2's continuity check exists to cover.

So the two designs share one sampler, via `withBalances(createAllocationSampler(…))` at the
single call site. Written as a decorator rather than folded into design 82's module, so the
coupling lives in the design that introduced it. A side benefit worth naming: the two
panels now read **the same instant**, which is stronger than the two lab pages, each of
which runs its own sim.

A run whose sampler was never wrapped — a test harness, an older saved session — degrades
to "not checked" and says so.

### 19.3 The bug the panel had that no module did

`checkFlowInvariant` returns `ok: false` for both "the flow does not tie" and "there was
nothing to tie against" — deliberately, per §18.3, because a green tick over an empty set
is worse than a warning. The panel's first draft branched on `!tie.ok` alone and painted
**"The flow does not tie to the stock"** in red for any run without balance samples. That
tells the reader their data is broken when it is not, which is the one thing a provenance
strip must never do. The distinction is now explicit, and a mutation restoring the
conflation fails two tests.

Also caught, in the test fixture rather than the code: a stub journal whose entries each
restated the opening balance is a **continuity break**, and the panel correctly refused to
draw. Real journals chain; a fixture that does not is testing against a journal that could
not exist. The helper now keeps a running ledger per key.

### 19.4 Start here next session — **phase 6**  *(done — see §20)*

Monte Carlo: spending as a distribution rather than a path — "how often is tax more than
N% of outflow", "what is the p10 real cost of the plan". The cube is per-run, so the work
is an aggregation layer over N cubes, and the natural seam is the MC runner's existing
per-iteration result rather than anything in this design.

Two cautions carried forward: [[defer-long-mc-reruns]] — ship the code and the tooling,
do not block on a 30–45 minute sweep; and the cube is a full journal walk (~9 ms on a
45-year run), so an MC of 1,000 iterations is ~9 seconds of pure classification. Measure
before assuming that is acceptable, and consider classifying inside the run instead.

### 19.5 Open items

| item | why it is not ours | where |
|---|---|---|
| The panel re-walks the whole journal on a signature change | measured at ~9 ms and cached; a per-run incremental cube is a phase 6 concern if MC needs it | §19.4 |
| `CARE`, `FX_COST`, the AU super fund tax | unchanged from §16.5 / §17.5 | §16.5 |
| The panel has no account filter | the lab page has none either, and the tie grid already breaks out per account; add it when someone asks a per-account spending question | — |

---

## 20. Phase 6 — spending as a distribution  (2026-08-15).  **Design complete.**

### 20.1 What shipped

`src/finance/spending-reporting/spending-distribution.js`, `scripts/lab/spending-mc.mjs`,
an opt-in `spending` flag on `IntlRetirementMcRunner` and `runArm` (mirroring `mix`), and
19 mutation-verified tests in `tests/unit/spending-distribution.test.mjs`. Full suite
green: 5135 unit + 1038 viz.

With phase 6 closed, **every phase 0–6 in §11.1 is built.**

### 20.2 §19.4's plan was not buildable, and the measurement says why

§19.4 proposed "an aggregation layer over N cubes". Measured, that is impossible at the MC
default and the reason is structural:

| telemetry | run | journal entries | cube total |
|---|---|---|---|
| `off` (the MC default) | 530 ms | 0 | — |
| `journal` | 719 ms | 38,808 | **\$0** |
| `full` | 3,963 ms | 38,808 | \$22,648,181 |

**A `journal`-level run yields a perfectly well-formed journal whose cube totals zero.**
`silent` mode skips the state clone, so every entry's `stateDiff` is null — and the cube is
built entirely from `stateDiff`. `simulation.js` says so in a comment; nothing enforces it.
Only `full` works, at **7.5x**.

That is the asymmetry with design 82 §8.1, which put allocation into MC cheaply: an
allocation is a **stock**, readable from live state at an instant with no journal at all.
Spending is a **flow** — nothing in state at a year boundary says what the year cost. So
spending-in-MC is opt-in and priced, exactly as `mix` is, and the header of the study
script tells you to budget ~4 seconds per path before you choose an n.

### 20.3 The free shortcut is wrong by 22 points

`state.cumulativeTaxesPaid` and `state.cumulativeConsumption` are both available at
`telemetry: 'off'` and look like they answer the headline question for nothing.

| | from the accumulators | correct (real) | correct (nominal) |
|---|---|---|---|
| tax as a share of spending | **74.9%** | 53.1% | 59.4% |

Two defects compound. `cumulativeTaxesPaid` is **nominal** and includes the AU super fund
tax — withheld in-fund, never a debit from any account the household spends from (design
77, §8.1, OQ5) — worth \$31k here. `cumulativeConsumption` is **real** and covers
`EXPENSE_DEBIT` only. Dividing one by the other adds nominal to real *and* uses two
different definitions of spending. It is §5.2's mixed-unit defect surfacing in a new place,
and it would have been a very tempting phase-6 shortcut.

### 20.4 The sweep found a real gap in the allowlist

`UNCLASSIFIED` fired on 13% of perturbed paths, and the aggregate names the types:
`STOCK_EARNINGS_APPLY`, `AU_STOCK_EARNINGS_APPLY`, `SUPER_EARNINGS_APPLY`,
`ROTH_EARNINGS_APPLY`.

They are the **growth family**: every one credits an account in a good year and *debits it
in a bad one*, which is the only reason a debit report ever sees them. The 45-year
reference plan showed zero because its sampled returns never go negative. §8.0 predicted
that types which exist but never fire would keep appearing; this is the mechanism that
finds them, and it found them by perturbation rather than by reading the codebase.

All are now `REVALUATION`, together with their siblings — classifying only the four
observed would leave the identical bug for whichever wrapper has the bad year next. The
`*_WITHDRAWAL_*` / `*_ROLLOVER_*` earnings legs are listed too, as `INTERNAL`: same naming,
different thing, and the likeliest mis-add.

The summary carries `unclassifiedTypes` for exactly this reason — **an alarm with no
address is not actionable.**

### 20.5 What the reference plan actually costs, as a distribution

30 paths, real base-year USD. (The scenario is the user's; the shape is what matters.)

- **Tax is the majority of the plan's cost more often than not.** P(tax > 50% of cost) =
  **56.7%**; P(> 40%) = 60.0%; P(> 60%) = 33.3%. The share runs from 17.9% at p10 to 80.2%
  at p90 — by far the most variable component.
- **The cost of the plan spans ~5x**: p10 \$6.1M, p50 \$9.7M, p90 \$29.8M real. The p50
  agrees with the single reference path (\$10.1M).
- **§3's overstatement is structural, not a property of one path.** "All debits" overstates
  the cost by 90% / 102% / 110% at p10 / p50 / p90 — a tight band across wildly different
  worlds.
- **The intent line and the solvency flag agree exactly.** `wentShort` fires on 6.7% of
  paths and the solvency failure rate is 6.7%. Two independent mechanisms — §5's per-year
  capped-debit detector and `scenarioFailed` — identify the same paths, which is the best
  evidence yet that the intent apparatus works.
- Stochastic repairs fire on 10% of paths, so `HOUSING_REPAIR` and `ASSET_IMPROVEMENT` show
  p50 = 0 and a non-zero p90 — the shape a lumpy cost should have.

### 20.6 A pre-existing bug this surfaced, deliberately not fixed here

A perturbed path trips `§904 limitation invariant violated` (design 83 §8) and, under
`JOURNAL_STRICT`, throws. **Verified not ours**: the same path throws with identical
figures whether `spending` is on or off, which also confirms telemetry is observation-only.
The study run above used `FTC_LIMITATION_STRICT=off`. It belongs with the design 83 tax
work, and a sweep that reaches it should be treated as a tax-model finding rather than a
reporting one.

### 20.7 Open items

| item | why it is not ours | where |
|---|---|---|
| The §904 invariant violation on perturbed paths | design 83 §8's territory; measured to be independent of anything here | §20.6 |
| Spending is not persisted into arm JSON, so `mc-report.mjs` cannot read it | `mc-report` globs the arm directory and a new key would need its own care ([[mc-report-globs-arm-dir]]); the study script reports directly instead | — |
| An in-state per-category accumulator would make this work at `telemetry: 'off'` | it is a sim-model change — new state, a new reducer, and a golden re-gold — and it duplicates the classification into the run. Worth it only if MC spending becomes routine | §20.2 |
| `CARE`, `FX_COST`, the AU super fund tax | unchanged since §16.5 — the three things the taxonomy still cannot see | §16.5 |
