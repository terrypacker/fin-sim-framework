# 96 — Percent-of-wealth spending, and a configurable wealth basis

**Status** (2026-08-28): **PROPOSED**. Two decisions taken up front: the default basis is
`NET_LIQUIDITY` (§3 D3), and the floor/ceiling bands ship in phase 1 but **default to off**
(§3 D6).

**Start at §14.** Net liquidity was reported reading low against a hand calculation on the same
day this was written, and D3 makes it the denominator of every number this design produces. §14
is phase 0: reconcile it row by row before building anything on top of it. That phase can
change D3.

This design adds a spending strategy that sets each year's spend as a **percentage of current
wealth**, and — because "what counts as wealth" is the configurable part — it first builds the
single wealth measure the rest of the model has been keeping four private copies of.

The strategy is the small half. The wealth basis is the half that touches existing code, and
§9 is the half that changes what a Monte Carlo result *means*.

---

## 1. What this is not

It is not the 4% rule. Bengen's SWR is a **constant real dollar** draw sized off the *initial*
portfolio — which is exactly what `FIXED` + `InflationAdjustReducer` already does today. What
is being asked for here is the **constant-percentage / endowment rule**: re-derive the draw
from *current* wealth every year.

The two are opposite in their failure modes, and the difference is the reason this design needs
§9 at all:

| | constant real dollar (`FIXED`) | constant percentage (this design) |
|---|---|---|
| Can the plan run out of money? | Yes — that is the whole question | **No.** A percentage of a positive number is positive |
| Spending volatility | None by construction | Tracks the portfolio 1:1 |
| What a bad sequence costs you | Ruin | Standard of living |

So the strategy is named `PERCENT_OF_WEALTH`, not `SWR`. Calling it SWR would put two
incompatible meanings on one label in a param enum a user picks from.

---

## 2. What already exists

`spendingStrategy` is an `EnumMulti` and the registry composes strategies, so adding one is
mechanical (`finance/spending/spending-strategy-registry.js`). The valuation side is not.

There are **four** live opinions about what a portfolio is worth:

| where | scope rule | used by |
|---|---|---|
| `computeGuardrailPortfolioValue` | `drawdownPriority != null` | Guyton-Klinger check, retirement baseline |
| `computeNetLiquidity` | `drawdownPriority != null` **and** age-accessible | the declared control metric; MC/opt targets |
| `computeNetWorth` | everything: accounts, property equity, collectibles, company; loans negative; speculative at zero | reporting, `after-tax`, optimizer |
| `buildAllocationCube` | everything, **decomposed by `ASSET_CLASS`**, with a reconciliation row for holdings-vs-balance drift | the allocation report only |

Three of the four are the same traversal with a different predicate. They are separate
functions, and one of them has already drifted once in a way nobody could see: the guardrail
copy read `entry.currency` as a bare string when a runtime account carries a `{code, symbol}`
descriptor, so every foreign drawdown account was summed **unconverted** for as long as that
code existed. USD accounts were right by accident. Adding a fifth private copy for this feature
is how that happens again.

`computeNetWorth` already shows the right pattern in miniature — `_sumNetWorth(state, ccy,
{includeSpeculative})` is *one* traversal serving *two* published scopes, precisely so the two
cannot disagree about which rows are recognised. This design generalises that.

---

## 3. Decisions

**D1 — One traversal, many scopes.** `computeWealthBasis` is the single implementation.
`computeNetLiquidity`, `computeGuardrailPortfolioValue` and `computeNetWorth` become presets
over it and keep their names and signatures. Nothing outside the module learns a new API.

**D2 — Asset-class filtering is done on cube rows, not on state entries.** An account is not
one asset class; it is sleeves. "Exclude BOND" has to descend into `holdings[]`, resolve the
default allocation for holdings that lack one, and account for the fact that `account.balance`
and `Σ holdings` are known to drift apart. `buildAllocationCube` already does all three,
including emitting the residual as its own labelled row so the total always ties. A second
implementation of that logic would be a second chance to get it wrong.

**D3 — The default basis is `NET_LIQUIDITY`.** It is the pool a controller can actually steer:
no control can sell a house, find a buyer for a private stake, or unlock super early. A
percentage rule anchored on net worth would size this year's groceries off the appraised value
of the roof overhead, and would cut spending when a house is sold and the proceeds are spent —
a lower number for a household that just became *more* liquid.

**D4 — Include-list only; no exclude-list.** The class filter is one list, and exclusion is
absence from it. Offering both invites a config where a class appears in both lists, and
whichever precedence we pick is a rule the user has to remember.

**D5 — It sets a LEVEL, not a delta.** Every existing strategy nudges (`SPENDING_STRATEGY_APPLY`
adds a delta; the guardrail multiplies). This one computes the whole figure. It needs its own
action, `SPENDING_LEVEL_SET`, and must not be expressed as "a delta equal to the difference",
which would be the same thing written so that a missed fire looks like a small error rather
than a wrong level.

**D6 — Bands ship in phase 1, defaulting to off.** A pure percentage rule is unusable for most
households — spending falls 30% in the year the market does — but a band is a *policy* choice,
not a correction, and a default that quietly smooths the output would hide the strategy's
defining characteristic from the first person who runs it. So: built, tested, documented,
`null` by default.

**D7 — It is gated on a start date, defaulting to the primary person's retirement.** While
wages fund the household, resetting expenses to a percentage of wealth is not a spending
policy, it is a bug that happens to typecheck.

**D8 — Nominal in, nominal out.** Wealth is measured in nominal base currency and the resulting
spend is a nominal figure. Inflation is not applied on top: current wealth already carries it.
See §7 for what this means when `InflationAdjustReducer` runs first.

---

## 4. `finance/valuation/wealth-basis.js`

```js
computeWealthBasis(state, {
  basis            = 'NET_LIQUIDITY',   // preset, see below
  classes          = null,              // ASSET_CLASS[] include-list; null = the preset's default
  date             = null,              // required by the age gate
  baseCurrency     = 'USD',
  includeLiabilities,                   // preset default; overridable
  includeSpeculative = false,
}) -> number
```

### 4.1 Presets

| preset | entries | classes | liabilities |
|---|---|---|---|
| `NET_LIQUIDITY` | `drawdownPriority != null` + age-accessible | all | no (none are in scope) |
| `DRAWDOWN_POOL` | `drawdownPriority != null` | all | no |
| `NET_WORTH` | every recognised entry | all | **yes**, negative |
| `CUSTOM` | every recognised entry | user's list | user's flag |

A preset is a starting point, not a lock: `NET_LIQUIDITY` with `classes: [EQUITY, BOND]` is a
legitimate configuration meaning "the liquid pool, ignoring the cash buffer and the bullion",
and is the config that makes the strategy behave like a portfolio-only endowment rule while
still respecting the age gate.

### 4.2 The two invariants

```
computeWealthBasis(s, {basis:'NET_WORTH', classes:null, includeLiabilities:true})
    === computeNetWorth(s)

computeWealthBasis(s, {basis:'NET_LIQUIDITY', date:d})
    === computeNetLiquidity(s, d)
```

These are the whole safety argument for D1 and D2, and they are cheap: both sides are pure
functions of one state. A regression that re-scopes one path fails one of them immediately,
which localises the bug to a preset instead of to "spending looks wrong".

### 4.3 The cube stops being reporting-only

`allocation-cube.js` opens with "Nothing in the sim reads this file." After this design, the
simulation reads it once per simulated year. That is a real change in status and should be made
deliberately, not discovered later:

- **Perf**: one cube build per year boundary, on one state. Against a run that already builds
  the cube per sample for the allocation report, this is noise. It is *not* noise if someone
  later moves the strategy to a monthly cadence — see §13 Q2.
- **Coupling**: the cube's degrade-don't-throw posture is right for a report and wrong for the
  sim. An `UNKNOWN` bucket in a report is an honest band on a chart; an `UNKNOWN` bucket
  silently included in (or excluded from) a spending denominator is a wrong number. So the
  wealth basis **must decide explicitly** what `UNKNOWN` does — see §13 Q1 — rather than
  inheriting the cube's answer by default.
- The class-filtered path is the only one that needs the cube. The unfiltered presets stay on
  the plain state traversal, so `computeNetLiquidity` gains no new dependency at all.

---

## 5. The strategy

### 5.1 `PercentOfWealthSpendingReducer`

Fires on `US_PERIOD_ADVANCE` / `AU_PERIOD_ADVANCE`, at its **own priority slot** after
`PRE_PROCESS + 3`. Ordering matters here and the existing mechanism is too weak for it: the
guardrail check and the regime-aware cut already share `PRE_PROCESS + 3`, where ties resolve by
*registration order*. A strategy that overwrites the level rather than nudging it cannot depend
on that.

```
if (date < startDate) return unchanged            // D7
wealth  = computeWealthBasis(state, {...})         // nominal, base currency
target  = rate * wealth / 12                       // monthly, nominal, base currency
target  = applyBands(target, state.percentOfWealth.lastTarget)   // §6, optional
emit SPENDING_LEVEL_SET { monthly: target, slice, cause }
```

### 5.2 `SpendingLevelSetReducer`

Writes `state.expenses.{essential,discretionary}` and keeps `state.monthlyExpenses` as their
sum, exactly as `SpendingStrategyApplyReducer` does. Two slice modes:

- `discretionary` (default) — essential is held where inflation left it and discretionary
  absorbs the whole adjustment, flooring at zero. This is the behaviour that matches how the
  rest of the model treats the two slices, and it means a bad market year cannot take the
  household below its essential floor by arithmetic alone.
- `both` — the level is split by `discretionarySharePct`. Purer, and the honest choice for
  studying the unconstrained rule.

Note the consequence of `discretionary`: once discretionary hits zero the strategy stops being
a percentage rule and becomes `FIXED` at the essential level, and the plan **can** run out of
money again. That is a feature (it is what an essential floor *is*) but it means §9's "cannot
fail" claim is scoped to `both` / unfloored configurations.

### 5.3 Where the baseline comes from

Nowhere. Unlike the guardrail, this strategy holds no baseline withdrawal rate and needs no
`RETIREMENT_DATE_REACHED` capture — the rate is authored, not measured. The only carried state
is `state.percentOfWealth.lastTarget`, and only when bands are on.

---

## 6. Bands and smoothing (optional, off by default)

Three independent limiters, applied in this order:

1. **Smoothing** (`wealthSpendSmoothing`, 0–1) — the Yale/Tobin rule:
   `target = w * lastTargetInflated + (1 - w) * rate * wealth`. `0` = pure; `~0.7` = the
   endowment convention. One number, and it is the cheapest way to make the rule usable.
2. **Bands** (`wealthSpendCeilingPct` / `wealthSpendFloorPct`) — cap the **real** year-on-year
   change against last year's target, Vanguard's dynamic-spending formulation. Asymmetric
   defaults are the standard shape when they are turned on (a small ceiling, a larger floor):
   most households will take a raise slowly and resist a cut hard.
3. **Absolute real floor** (`wealthSpendRealFloor`) — a base-year figure below which the target
   never falls, inflated by the residence price level. Distinct from the band floor, which
   limits the *rate of descent* and therefore still reaches zero eventually.

All three are `null`/`0` by default (D6), and each is separately testable: with one on and the
others off, the output is a closed-form function of the wealth path.

---

## 7. Currency, inflation, and the one subtlety

`state.monthlyExpenses` is a **base-currency** figure. `MonthlyExpensesHandler` re-bases it into
the residence currency at the **anchor** rate — deliberately not spot — so the household's
standard of living does not wander with the exchange rate.

So the reducer writes a base-currency figure and needs no FX of its own. But the wealth it
reads *is* spot-converted (`effectiveExchangeRates`, via the shared `toBaseCurrency`), and that
asymmetry is a genuine modelling statement, not an artifact:

> Under `PERCENT_OF_WEALTH`, an FX move changes spending. A fall in AUD lowers the USD value
> of AUD-domiciled assets, which lowers the draw, which — after the anchor re-base — lowers
> real consumption in the residence country.

That is the correct behaviour for a percentage rule (the assets really are worth less) and it
is the opposite of `FIXED`'s deliberate FX insulation. It must be documented in the param
description, because a user comparing the two strategies on an FX-pinned run will see the
effect vanish and conclude the wrong thing.

**Inflation**: `InflationAdjustReducer` (PRE_PROCESS + 2) inflates `monthlyExpenses` before this
reducer overwrites it. That is harmless — the write is a level — but it makes the inflated value
dead on this path, and the interaction is worth stating: with `PERCENT_OF_WEALTH` active,
`FIXED`'s inflation adjustment has no effect on the level, only on the essential slice under
slice mode `discretionary`.

---

## 8. Composition

`spendingStrategy` is multi-select, so every combination is reachable and each needs an answer.

| combined with | result |
|---|---|
| `GUARDRAIL` | **Mutually exclusive.** Both set the same variable from the same input; the guardrail's baseline rate is measured against a level this strategy overwrites, so the bands fire against noise. Reject at load with a clear message rather than producing a number. |
| `FIXED` | Compatible; inflation is inert on the level (§7). |
| `AGE_BANDED` | Compatible **if the age factor applies after** — the smile then bends a percentage-derived level, which is the intended reading. The priority slot in §5.1 is what makes this true rather than incidental. |
| `EXPLICIT_BANDS` | **Mutually exclusive.** It also sets an absolute level. Last writer wins is not a policy. |
| `REGIME_AWARE` | Compatible; the regime cut applies to discretionary after the level is set. |
| `EXPENSE_EVENTS` | Orthogonal — dated one-offs, not the recurring level. |

The exclusivity checks belong at scenario load, next to the existing strategy validation, and
each needs a test — a silently-wrong combination here produces a plausible-looking number.

---

## 9. What this does to Monte Carlo and the optimizer

This is the section to read before running any study with the strategy on.

**Ruin probability stops being the metric.** With `slice: both` and no essential floor, the
draw is a fraction of a positive balance and the portfolio is never exhausted. `OUT_OF_FUNDS`
stops firing. Success rate goes to ~100% and stays there for *every* parameter setting, which
means:

- Any optimizer objective scored on success rate becomes flat, and the search returns noise.
- D80's feasibility gate is trivially satisfied, so a harvest that would have been rejected as
  infeasible is admitted.
- A side-by-side of `FIXED` and `PERCENT_OF_WEALTH` on success rate is meaningless — it compares
  a strategy that can fail against one that cannot, and reports the tautology.

**The comparison has to move to the consumption distribution.** The CRRA accumulator and the
D89 spending cube already measure the right thing: what was actually consumed, in real terms,
year by year. `PERCENT_OF_WEALTH` trades ruin risk for consumption variance, and CRRA is the
instrument that prices that trade — a high-γ household should prefer the floored/smoothed
configurations, and the study should show it doing so.

**The rate is a good optimizer lever** — better-conditioned than the guardrail's four bands,
which interact. One monotone knob against a utility objective.

None of this is a defect in the strategy. It is the strategy working, and the risk is that a
study built on the old metrics reports a spectacular result that means nothing.

---

## 10. Parameters

All `group: 'Spending'`, all gated `visibleWhen: { param: 'spendingStrategy', includes:
'PERCENT_OF_WEALTH' }`.

| key | type | default | mc | opt | notes |
|---|---|---|---|---|---|
| `wealthSpendRate` | Number | 0.04 | yes | yes | the lever |
| `wealthSpendBasis` | Enum | `NET_LIQUIDITY` | no | yes | D3; `NET_WORTH`, `DRAWDOWN_POOL`, `CUSTOM` |
| `wealthSpendClasses` | EnumMulti | `null` (= all) | no | no | `ASSET_CLASS` include-list, D4 |
| `wealthSpendSlice` | Enum | `discretionary` | no | yes | or `both` — §5.2 |
| `wealthSpendStart` | Date | `null` (= primary retirement) | no | yes | D7 |
| `wealthSpendSmoothing` | Number | 0 | no | yes | §6.1 |
| `wealthSpendCeilingPct` | Number | `null` | no | yes | §6.2 |
| `wealthSpendFloorPct` | Number | `null` | no | yes | §6.2 |
| `wealthSpendRealFloor` | Number | `null` | no | yes | §6.3, base-year |
| `wealthSpendBaseCurrency` | Text | run base currency | no | no | §7 |

`spendingStrategy`'s `options` gains `PERCENT_OF_WEALTH` in both retirement toolsets, and
`harvest-apply.js` already treats the key as `EnumMulti`, so MPC harvest needs no change.

---

## 11. Phases

1. **`wealth-basis.js` + presets.** Re-express the three existing metrics over it. Invariant
   tests (§4.2). No behaviour change — this phase should be byte-identical on a golden run,
   and that is the acceptance criterion.
2. **Class filtering** via the cube, incl. the `UNKNOWN` decision (§13 Q1) and a test that a
   full include-list equals the unfiltered basis to the cent.
3. **Reducer + `SPENDING_LEVEL_SET` + registry entry + params.** Register the action in the
   toolset payload manifest — the journal payload is gated on it, and an unregistered type
   degrades to a heuristic payload rather than failing.
4. **Bands and smoothing** (§6), each independently tested, all defaulting off.
5. **Composition rules** (§8) — load-time validation and its tests.
6. **A study**: `FIXED` vs `GUARDRAIL` vs `PERCENT_OF_WEALTH` (pure, smoothed, floored) scored
   on the consumption distribution, not success rate (§9).

Phase 1 is the one with blast radius; phases 3–4 are additive.

---

## 12. Tests worth naming

- The two invariants of §4.2, on real states (with a foreign-currency account, so the
  descriptor bug of §2 cannot come back unnoticed).
- Class filter: `classes: [everything]` === no filter; excluding a class equals the total minus
  that class's cube rows; an account whose holdings do not sum to its balance is handled via the
  reconciliation row rather than silently under-counted.
- Level, not delta: two consecutive years with the same wealth produce the same level, and a
  skipped fire produces a visibly wrong level rather than a small drift.
- The start gate: no spending change before `wealthSpendStart`.
- Each band alone, against a hand-computed wealth path.
- Each exclusivity rule from §8 rejects at load.
- A run with `slice: both`, no floor, and a deliberately punishing return path **never** fires
  `OUT_OF_FUNDS` — the §9 claim, pinned.

---

## 13. Open questions

**Q1 — What does an `UNKNOWN` class do in a filtered basis?** Include (risk: a
misclassification silently inflates spending), exclude (risk: it silently cuts it), or throw
(risk: the sim refuses to run over a reporting-taxonomy gap). Leaning **throw when the class
filter is active** — if the user is filtering by class, an unclassifiable asset is exactly the
case they need to know about — and include when it is not.

**Q2 — Annual only, or configurable cadence?** Annual matches every other spending strategy and
the endowment convention. A monthly re-derivation would track the market so closely it is not a
plausible household policy, and it multiplies the cube cost by twelve. Proposing annual, with
the reducer written so cadence is not baked into it.

**Q3 — Should `NET_WORTH` as a basis warn?** It is a legitimate configuration (an owner who
genuinely intends to draw the house down via a reverse mortgage or a planned sale) but the
common case is a user picking the biggest number without meaning to. A param description is
probably enough; a load-time warning may be over-reach.

---

## 14. Phase 0 — validate `computeNetLiquidity` before building on it

Reported 28 Aug 2026: net liquidity **reads low against a hand calculation**. Since D3 makes it
the default denominator of every spending decision this design produces, it has to be settled
first — a percentage rule on a denominator that is 20% low is a 20% spending error that looks
like a modelling result. This becomes **phase 0**, ahead of the refactor in §11.

### 14.1 Why this is the right moment

The instrument needed to answer it is the one §4 builds anyway. The allocation cube already
ties to net worth to the cent (its stated invariant) and decomposes by account and asset class.
Diffing the cube's rows against `computeNetLiquidity`'s per-entry contributions gives a
**row-level reconciliation**: not "the total is low", but "these three accounts are in one and
not the other, for this reason". That reconciliation is worth building as a script under
`scripts/` regardless of what it finds, because it is also the acceptance test for phase 1.

### 14.2 What is already established, from reading the code

Four properties are confirmed by inspection and are **candidate explanations, most of which are
"working as designed" rather than defects**. The hand calculation and the function may simply be
computing different quantities — which is itself a finding, and points at the docstring rather
than the arithmetic.

1. **`drawdownPriority` defaults to `null`, and `null` means excluded.** Both toolsets project
   `account.drawdownPriority ?? null`. So *every account the author did not explicitly put in
   the drawdown queue is absent from net liquidity* — including the transaction/checking
   account the household actually spends from, and any offset account (which is deliberately
   kept out of the queue so it is not drained against all spending). This is the single most
   likely source of a low reading, and it is a definitional gap, not a bug: cash you can spend
   tomorrow is liquid by any ordinary meaning of the word.

2. **The age gate legitimately removes retirement wealth.** Super at `minimumAge: 60` with
   `allowsEarlyWithdrawal: false` contributes **zero** until the owner turns 60. On a plan
   where super is a large share of assets, this alone can account for the whole discrepancy.
   Correct by design (the docstring is explicit) and easy to forget when totalling by hand.

3. **`minimumAge` is projected onto state only inside the `contributionBasis !== undefined`
   branch** of `_accountToStatePlain`, in both toolsets. Any age-gated account that carries no
   basis ledger reaches the simulation with `minimumAge` absent, and `isAccessible` short-
   circuits to `true` on `minimumAge == null`. That error runs the *other* way — it makes net
   liquidity read **high** — so it does not explain this report, but it is a latent hole in the
   gate and phase 0 should confirm whether any account in a real plan lands in it.

4. **Neither `minimumBalance` nor liabilities are subtracted.** An account contributes its full
   balance even though the drawdown chain can only take what is above `minimumBalance`, and no
   loan reduces the figure. Both push the number **up**, so again not this report — but "net"
   in the name promises a subtraction the function does not perform, and that mismatch is
   exactly the kind of thing a hand calculation trips over in the opposite direction.

Note that (1) and (2) push down while (3) and (4) push up. A total that is *net* low can still
contain all four, which is why a total-vs-total comparison cannot resolve this and a row-level
reconciliation can.

### 14.3 Candidates that need measurement, not reading

- **Holdings vs `balance` drift.** Net liquidity reads `account.balance`. Holdings are known to
  drift from it (a balance edit does not rescale holdings; `transaction()` syncs single-holding
  accounts only), which is why the cube emits a reconciliation row at all. Growth handlers do
  move both together, so this is not the default expectation — but if Σ holdings exceeds
  `balance` on a multi-holding account, net liquidity is low by exactly that residual, and the
  cube will name the account.
- **FX.** A missing pair in `effectiveExchangeRates` makes `toBaseCurrency` fall back to a rate
  of 1. Depending on direction that is a large error either way, and it is the failure mode this
  exact function has had before (§2). The reconciliation should print each account's local
  amount, rate and converted amount so a wrong rate is visible rather than inferred.
- **Hardcoded `USD` in `deriveNetLiquidity`.** It calls `computeNetLiquidity(state, date)` with
  no base currency, taking the `'USD'` default, and `state.metrics.netLiquidity` is registered
  as `currency('USD')`. Consistent today, but any AUD-based run will find the metric and the
  displayed base currency disagreeing — worth confirming against how the value is being read by
  hand.

### 14.4 Procedure

1. Build `scripts/` reconciliation: for one state, emit every entry with its balance,
   `drawdownPriority`, `minimumAge`, `allowsEarlyWithdrawal`, resolved owner age, currency, FX
   rate, converted value, and **the reason it was included or excluded**. Foot it to
   `computeNetLiquidity`, and separately to the cube total and `computeNetWorth`.
2. Run it on the plan the hand calculation was done against, at the same date, and diff the two
   lists. The answer is whichever rows disagree.
3. Classify each disagreement as *definition* (the function means something narrower than the
   hand calc) or *defect* (the function means what it says and computes it wrongly).
4. Definitions get fixed in the **docstring and the param description**, and — where the
   narrower meaning is not the useful one for spending — in the **preset**: §4.1 already lets
   `wealthSpendBasis` name a scope that includes the transaction account, and that may turn out
   to be the honest default rather than bare `NET_LIQUIDITY`.
5. Defects get a failing test first, then a fix, then phase 1 proceeds on a foundation that has
   been measured rather than assumed.

**This phase can change D3.** If (1) turns out to be the explanation, then "net liquidity"
excludes the household's own cash, and the right default basis for a spending rule is
`NET_LIQUIDITY` *plus the transaction account* — a new preset, not a re-definition of an
existing metric that a dozen other callers depend on.
