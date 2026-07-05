# 33 — Age-Banded Spending

**Status**: Implemented — design written 2026-06-15, landed 2026-06-16. Steps 1–7 complete (Step 8 browser verification pending).
**Phase dependencies**: Design 26 (`design/26-dynamic-spending-strategies.md`) — **hard dependency, ✅ complete**. This design is a new entry in 26's `SPENDING_STRATEGY_REGISTRY` and operates entirely on the materialized `state.expenses = { essential, discretionary }` slices it introduced. No new framework infrastructure.
**Related**: `design/27-mortality-and-survivor-mechanics.md` (late-life-care factor and survivor multipliers also write per-slice deltas — §7 reconciles the overlap so the no-go health spike is not double-counted), `design/24-financial-modeling-roadmap.md` §3.2 (spending realism), `design/15-config-as-source-of-truth.md` (the band table is a round-tripped toolset param).

---

## 1. Purpose

Today the retirement plan models lifetime spending as **one scalar that only ever grows with inflation** (`FixedInflationAdjusted`, the default strategy — `InflationAdjustReducer` multiplies both expense slices by `1 + rate` each year and nothing else touches them). That assumes a retiree consumes the same *real* basket at 90 as at 65. Decades of consumption research say otherwise: **real spending declines through most of retirement and then ticks back up at the very end** — the "retirement spending smile."

This design adds an `AGE_BANDED` spending strategy: a small, deterministic reducer that layers an **age-driven real multiplier** on top of inflation, so the plan can model the empirically-observed glide (go-go → slow-go → no-go) instead of a flat real line. The load-bearing decision is that it reuses design 26's materialized slices and the `RegimeAwareSpendingReducer` apply/revert idempotency pattern exactly — it adds **one reducer, one tiny state field, and a research-backed default band table**, nothing more.

The behavioral payoff: assuming flat real spending is the single biggest reason naïve plans **oversave by 10–20%** (Blanchett). Modeling the decline materially changes success rates, safe-withdrawal estimates, and the optimizer's recommended retirement date — so it belongs in the toolbox alongside `Guardrail` and `RegimeAware`.

---

## 2. Today

Grounded against the live code (2026-06-15):

- **Spending is materialized into slices** (design 26, ✅): `state.expenses = { essential, discretionary }`, seeded at boot from `monthlyExpenses × discretionarySharePct` (default 0.30). `state.monthlyExpenses` is a derived sum kept in sync by every reducer that writes a slice.
- **Only inflation moves it.** `InflationAdjustReducer` (`src/finance/reducers/inflation-adjust-reducer.js`, `PRE_PROCESS + 2`) inflates `expenses.essential` and `expenses.discretionary` by `factor = 1 + rate` once per year, and only when the advancing country matches the primary person's residence (lines 66–82). No other strategy is active by default.
- **The strategy substrate already exists.** `SPENDING_STRATEGY_REGISTRY` (`src/finance/spending/spending-strategy-registry.js`) holds `FIXED`, `REGIME_AWARE`, `GUARDRAIL`, `HEALTHCARE`. Each entry exposes `reducers(context)` + `paramSchema()`; the retirement toolsets `flatMap` the selected strategies. **Adding `AGE_BANDED` is a one-entry change to this object.**
- **The apply/revert pattern is established.** `RegimeAwareSpendingReducer` (`src/finance/spending/strategies/regime-aware-spending-reducer.js`) listens on `['US_PERIOD_ADVANCE','AU_PERIOD_ADVANCE']` at `PRE_PROCESS + 3`, computes a target multiplier, multiplies `discretionary` in, stores `appliedMultiplier` in a shared map, and divides it back out when the trigger clears — so a sustained condition never compounds year over year. **This design mirrors that pattern**, with "age" replacing "regime active" as the trigger and a continuous factor replacing the boolean.
- **Age is readable in any period reducer.** `state.people[key].birthDate` is present in state (the RMD handlers read `person.birthDate`, `k401-classes.js:285`), and reducers get the current sim date via `action.date`. Age-gated finance code already computes age this way (`_getAge`, `k401-classes.js:424`). So an age-driven reducer needs **no new state plumbing** to know how old the spender is.

---

## 3. Research basis

The user asked that this design reference the literature; the default band table (§5) is calibrated to it.

- **The "retirement spending smile" (David Blanchett, *Estimating the True Cost of Retirement*, 2014).** Real household spending in retirement does **not** stay flat. It declines through most of retirement — roughly **~1% per year in real terms** — then curves up late as health costs rise, tracing a shallow smile. By ~age 84 the average retiree spends about **26% less** (inflation-adjusted) than at 65. Assuming flat real spending overstates the required nest egg by **10–20%**. ([Kitces summary](https://www.kitces.com/blog/estimating-changes-in-retirement-expenditures-and-the-retirement-spending-smile/), [Blanchett paper PDF](https://static.twentyoverten.com/58fa971131d0d277e8275836/ms5wAiRgcWV/The-Retirement-Spending-Smile-Estimating-Changes-in-Retirement-Expenditures.pdf), [Retirement Researcher](https://retirementresearcher.com/retirement-spending-smile/))
- **BLS Consumer Expenditure Survey (2024).** Total average annual expenditures for households age **75+ run ~15% below age 65–74**; the 65+ cohort spends meaningfully less than the 45–54 peak-earning/peak-spending cohort. This is the population-level confirmation of the same decline. ([BLS CE 2024](https://www.bls.gov/news.release/cesan.nr0.htm), [BLS "Consumer expenditures vary by age"](https://www.bls.gov/opub/btn/volume-4/pdf/consumer-expenditures-vary-by-age.pdf))
- **The three-phase ("go-go / slow-go / no-go") framing** (Michael Stein, *The Prosperous Retirement*; widely used by planners). Maps cleanly onto discrete bands:
  - **Go-go (≈65–74):** most active; travel, hobbies, home projects — discretionary spending near its peak, beginning a gentle real decline.
  - **Slow-go (≈75–84):** activity moderates; discretionary spending steps down materially.
  - **No-go (≈85+):** mobility-limited; discretionary spending is low, but **health/long-term-care costs rise** and create the upturn of the smile.

  ([Corebridge three-phase overview](https://www.corebridgefinancial.com/insights-education/retirement-spending-insights), [Bogleheads — Surveys of retirement spending](https://www.bogleheads.org/wiki/Surveys_of_retirement_spending))

**Modeling stance taken from the research:** the *decline* is a discretionary-slice phenomenon; the *late-life upturn* is an essential/health phenomenon. This design therefore acts on the **discretionary slice** by default and leaves the no-go health spike to the `HEALTHCARE` strategy (design 26 §3) and the late-life-care factor (design 27 §3) — see §7. The band table encodes the discretionary glide; the smile's upturn emerges from the composition, not from forcing it into this one reducer.

---

## 4. Strategy

One new composable strategy, slotting into design 26's table:

| Strategy | Behavior | Slice acted on |
|---|---|---|
| `AgeBanded` (this design) | Applies a deterministic **real** multiplier to spending as a function of the spender's age, drawn from a configurable band table (`spendingAgeBands`). Each band carries a step multiplier (the go-go/slow-go/no-go drop) and an optional intra-band annual real drift (Blanchett's ~1%/yr glide). Composes on top of inflation. | discretionary (default; `'both'` configurable) |

It composes with every other spending strategy because, like them, it writes a **slice-scoped, reconciled** adjustment rather than overwriting the slice (§6). A scenario can run `FixedInflationAdjusted` + `AgeBanded` + `Guardrail` + `RegimeAware` together: inflation grows the nominal slice, age-banding bends the real trajectory, and the portfolio-reactive strategies cut/raise on top.

---

## 5. Mechanism

### 5.1 The age factor (pure function)

The core is one deterministic, monotone-friendly function `ageSpendingFactor(age, bands) → number`, where `1.0` means "baseline real spending." Given a sorted `bands` array of `{ startAge, multiplier, annualRealDrift }`:

1. **Precompute cumulative step factors** once: band *i*'s base factor is the product of `multiplier` for all bands `≤ i`. (So `multiplier` is the *relative* drop entering that band, and the cumulative product is the absolute level.)
2. At runtime, find the band `b` whose `[startAge, nextStartAge)` contains `age`.
3. Return `b.cumulativeBase × (1 + b.annualRealDrift) ** (age − b.startAge)`.

Ages below the first band's `startAge` return `1.0` (pre-retirement baseline). The step multipliers express the discrete three-phase drops; the per-band drift expresses the continuous within-phase glide. Setting all `multiplier: 1.0` and one `annualRealDrift: -0.01` reproduces Blanchett's pure ~1%/yr smooth decline; setting `annualRealDrift: 0` everywhere reproduces a pure step model. Both extremes — and anything between — fall out of the same function.

**Default band table** (research-calibrated; every value is a tunable param):

```js
spendingAgeBands: [
  { startAge: 0,  multiplier: 1.00, annualRealDrift:  0.000 }, // pre-retirement: baseline
  { startAge: 65, multiplier: 1.00, annualRealDrift: -0.010 }, // go-go:   gentle real decline (~1%/yr)
  { startAge: 75, multiplier: 0.90, annualRealDrift: -0.015 }, // slow-go: step down, faster decline
  { startAge: 85, multiplier: 0.90, annualRealDrift:  0.000 }, // no-go:   plateau (health spike handled by HEALTHCARE / design 27)
]
```

This yields roughly a **−25% real** discretionary level by the mid-80s relative to age 65 — in line with Blanchett's 26%-by-84 figure — while leaving the smile's terminal upturn to the dedicated essential-slice mechanisms (§7). A planner who wants the upturn *inside* this strategy can give the no-go band `multiplier > 1` and/or positive drift and set `ageBandSpendingSlice: 'both'`.

### 5.2 The reducer (apply/revert, mirrors `RegimeAwareSpendingReducer`)

`AgeBandedSpendingReducer` — listens on `['US_PERIOD_ADVANCE','AU_PERIOD_ADVANCE']`, priority `PRE_PROCESS + 4` (after `InflationAdjustReducer` at +2 and `RegimeAwareSpendingReducer` at +3, so it operates on the already-inflated, already-regime-adjusted slice for the new year). Each annual advance:

1. Read the primary person's age from `state.people[primaryKey].birthDate` and `action.date` (same computation as the RMD handlers).
2. `target = ageSpendingFactor(age, bands)`.
3. Reconcile the slice by dividing out the previously applied factor and multiplying in the new one — this is what prevents year-over-year compounding (exactly `RegimeAwareSpendingReducer`'s `*= multiplier` / `/= appliedMultiplier` trick, generalized to a continuous factor):

   ```js
   const applied = state.ageBandSpending?.appliedFactor ?? 1.0;
   slice = slice / applied * target;          // slice = expenses.discretionary (or both)
   ```
4. Write back `state.expenses`, sync `state.monthlyExpenses = essential + discretionary`, and store `state.ageBandSpending = { appliedFactor: target, currentBandStartAge }`.

Because step 3 divides out the prior factor first, the reducer is **idempotent within a year and stable across years**: inflation (+2) compounds the nominal level, and this reducer re-pins the *real* age multiplier on top without ratcheting. Acting only on the country-of-residence advance (the same gate `InflationAdjustReducer` uses) avoids applying the factor twice for a US+AU couple.

---

## 6. Event / Handler / Action / Reducer architecture

No new event, handler, or action type. The strategy is a single reducer that fires on the existing annual `*_PERIOD_ADVANCE` actions and writes state directly — identical in shape to `RegimeAwareSpendingReducer`, `GuardrailAnnualCheckReducer`, and `InflationAdjustReducer`.

| Reducer | Listens on | Priority | Writes |
|---|---|---|---|
| `AgeBandedSpendingReducer` | `US_PERIOD_ADVANCE`, `AU_PERIOD_ADVANCE` | `PRE_PROCESS + 4` | `state.expenses[slice]`, `state.monthlyExpenses`, `state.ageBandSpending` |

(For auditability it can optionally emit a `SPENDING_STRATEGY_APPLY { delta, slice, reason: 'AGE_BAND' }` — design 26 §5 — instead of writing the slice in place, so the adjustment shows up in the journal/timeline. Recommended as a follow-up once the in-place version is validated; the in-place write is simpler and matches `RegimeAwareSpendingReducer`. See §10 Q3.)

---

## 7. Interaction with existing designs

| Design | Interaction |
|---|---|
| **26 Spending** | This *is* a design-26 strategy. Shares the materialized slices and the registry. Composes with `RegimeAware`/`Guardrail` on the discretionary slice: each strategy maintains its own reconciled factor (`appliedMultiplier` / `appliedFactor` / `currentAdjustmentMultiplier`), so they multiply together rather than clobber. Defined order: inflation (+2) → regime (+3) → age band (+4) → guardrail annual check (+3, but a distinct trigger). |
| **27 Mortality / late-life care** | **The one real overlap — reconciled to avoid double-counting.** Design 27's `lateLifeCareFactor` multiplies **both** slices during the final N months before death (the terminal-care spike), and its survivor multipliers cut both slices on a death. The no-go band here deliberately **plateaus** (default `multiplier 0.90`, `drift 0`) rather than spiking, so the smile's terminal upturn comes from design 27's care window / the `HEALTHCARE` strategy, not from this reducer. The two layers are orthogonal: age-banding models the *typical* real decline; design 27 models the *terminal* care event. A planner must not encode the health spike in both at once (documented in §8 and §10 Q2). |
| **26 `HEALTHCARE`** | Complementary. Discretionary decline (here) + lumpy essential health events (`HEALTHCARE`) together reproduce the full smile. No coordination needed — different slices. |
| **15 Config** | `spendingAgeBands`, `ageBandSpendingSlice`, and the `AGE_BANDED` selection are round-tripped toolset params (the band table is an `Array` param like `healthcareEvents`). |
| **MC / Opt** | Per-band `multiplier` / `annualRealDrift` are sweepable in principle; sweeping values *inside* the `Array` param needs design 25a nested-path params (same constraint as `HEALTHCARE`'s MC sweep). Flat scalar knobs (`ageBandDeclineRate`, see §10 Q4) are MC/opt-able immediately. |
| **23 FX / 25 Holdings / 29 Behavioral / 21 Regimes** | None direct. Age-banding is pure cash-flow shaping on the expense slices. |

---

## 8. Out of scope

- **Per-person age bands.** The factor is driven by the **primary person's** age (the expense owner, consistent with `InflationAdjustReducer`'s primary-residence gate). Household-level age-banding with two diverging ages (e.g. drive off the younger spouse, or blend) is a future layer over the same function. (§10 Q1)
- **Per-category bands.** One discretionary multiplier, not a travel/dining/utilities breakdown. The single-slice split from design 26 is the granularity ceiling here.
- **The terminal health spike inside this strategy** — left to design 27 / `HEALTHCARE` by default to prevent double-counting (§7). The no-go band can opt into it, but the default does not.
- **Empirical re-calibration of the default table.** The defaults track Blanchett / BLS at a coarse grain; fitting them to a specific cohort, country, or income decile is research, not engineering. Every number is a param.
- **Currency-specific decline rates.** AU vs US retirees may glide differently; MVP uses one table for the residence-currency slice.

---

## 9. Testing sketch

- `tests/unit/spending-age-banded.test.mjs`:
  - `ageSpendingFactor` — pure-function table: pre-band age → 1.0; band-boundary step; intra-band drift compounding; pure-drift config (all `multiplier 1.0`) reproduces ~1%/yr; pure-step config (all `drift 0`) reproduces flat-within-band.
  - reducer applies the target factor on a period advance; **divides out the prior factor so it does not compound** across consecutive years (the key correctness assertion, mirroring `spending-regime-aware`'s no-compound test).
  - composes with inflation: after N years the *nominal* slice = inflation-compounded × age-factor; the *real* slice = age-factor only.
  - discretionary-only by default; `'both'` touches essential too.
  - `state.monthlyExpenses` derived sum stays consistent after each advance.
  - residence-gate: a US+AU couple does not get the factor applied twice per year.
- `tests/unit/spending-strategy-registry.test.mjs` — extend: `AGE_BANDED` lookup returns the reducer + param schema.
- `tests/unit/spending-composition.test.mjs` — extend: `AgeBanded` + `RegimeAware` both adjust discretionary and compose multiplicatively (neither clobbers).
- Extend `intl-retirement-scenario.test.mjs` — a long run with `AGE_BANDED` on shows lower real terminal spending and higher final balance than the `FIXED`-only baseline (the oversaving-correction the research predicts).

---

## 10. Open questions

- **Q1 — Whose age drives the factor in a two-person household?** **Recommended: the primary person's age** (the expense owner; matches `InflationAdjustReducer`'s primary-residence gate). Simplest, and the household's spending decline tracks the head of household reasonably. Per-person / eldest / blended is a documented future layer (§8). *Confirm before implementing — this is the one genuinely household-shaped choice.*
- **Q2 — Does the no-go band model the health-cost upturn, or defer it to design 27 / `HEALTHCARE`?** **Recommended: defer** — default no-go band plateaus; the upturn comes from the essential-slice mechanisms, so it isn't double-counted (§7). Opt-in via a positive no-go `multiplier`/`drift` + `ageBandSpendingSlice: 'both'`.
- **Q3 — Write the slice in place, or emit `SPENDING_STRATEGY_APPLY` for journal visibility?** **Recommended: in place at MVP** (matches `RegimeAwareSpendingReducer`, simplest); promote to an emitted action in a follow-up if the adjustment needs to be individually auditable in the timeline (§6).
- **Q4 — Expose the full band table, or a simplified scalar?** **Recommended: ship both.** The `spendingAgeBands` array is the full control; also expose a convenience `ageBandDeclineRate` (single real %/yr from a `retirementAge` anchor) that, when set, synthesizes a one-band table — so a user gets Blanchett's smile from one number and MC/opt can sweep it without 25a (§7).
- **Q5 — Default `AGE_BANDED` on or off?** **Recommended: off** (opt-in, like every non-`FIXED` strategy), but surfaced prominently in the Spending param group since it is the highest-impact realism upgrade for most plans.

---

## 11. Step-by-step implementation plan

Mirrors design 26 increment 1 — additive, no framework change, gated behind strategy selection so an un-selected run is bit-for-bit unchanged.

### Status legend
- [x] done · [ ] not started

**Step 1 — `ageSpendingFactor` pure util** [x]
- `src/finance/spending/age-spending-factor.js` — `ageSpendingFactor(age, bands)` per §5.1 (cumulative step factors via `bandIndexForAge`; piecewise drift). Also exports `ageBandStartAge(age, bands)` for the state's audit field. Fully unit-testable in isolation.

**Step 2 — `AgeBandedSpendingReducer`** [x]
- `src/finance/spending/strategies/age-banded-spending-reducer.js`, extends `Reducer`, `PRIORITY.PRE_PROCESS + 4`, `reducedActionTypes = ['US_PERIOD_ADVANCE','AU_PERIOD_ADVANCE']`. Constructor opts `{ bands, slice = 'discretionary' }`. Apply/revert via `state.ageBandSpending.appliedFactor` (§5.2). Residence gate identical to `InflationAdjustReducer`. **Date source:** the period-advance action carries no `date`; the as-of date is read from `state.currentPeriods[cc].startMs` (updated by `PeriodAdvanceReducer` before this reducer), with `action.date` as a unit-test fallback.

**Step 3 — State init** [x]
- `src/finance/state/intl-retirement-state.js`: added `this.ageBandSpending = { appliedFactor: 1.0, currentBandStartAge: null };`. The reducer also guards with `?? 1.0` so toolset-compiled state (which seeds via patches, not the constructor) is safe.

**Step 4 — Registry entry** [x]
- `src/finance/spending/spending-strategy-registry.js`: added `AGE_BANDED` with `reducers`/`paramSchema`. `DEFAULT_AGE_BANDS` (the §5.1 table) is exported from the reducer module. The convenience `ageBandDeclineRate` synthesizes a one-band glide anchored at the primary person's retirement age (§10 Q4) via the `_ageBands(context)` helper.

**Step 5 — Params + toolset wiring** [x]
- `us-retirement-toolset.js` + `au-retirement-toolset.js`: `spendingStrategy` EnumMulti gains the `AGE_BANDED` option; `paramSchema()` spreads `SPENDING_STRATEGY_REGISTRY.AGE_BANDED.paramSchema()` (`spendingAgeBands`, `ageBandSpendingSlice`, `ageBandDeclineRate`). Selection is the existing generic loop over `spendingStrategy` — no per-strategy gate needed.
- `INTL_RETIREMENT_DEFAULTS`: added `spendingAgeBands: DEFAULT_AGE_BANDS`, `ageBandSpendingSlice: 'discretionary'`, `ageBandDeclineRate: null`.

**Step 6 — `state-schema-registry.js`** [x]
- Registered `ageBandSpending.appliedFactor` as `decimal(4)` (mirrors `inflationAccumulator`) so the state panel / CSV render it.

**Step 7 — Tests** [x]
- `tests/unit/spending-age-banded.test.mjs` (factor table + reducer no-compound/compose/residence-gate), `spending-strategy-registry.test.mjs` (AGE_BANDED lookup + decline-rate synthesis), `spending-composition.test.mjs` (AgeBanded + RegimeAware compose multiplicatively), and `intl-retirement-scenario.test.mjs` AGE-BAND-1 (end-to-end: lower real discretionary vs FIXED baseline).

**Step 8 — Browser verification** [ ]
- Per CLAUDE.md: run the dev server, enable `AGE_BANDED`, chart `expenses.discretionary` over a multi-decade run, confirm the real glide is visible and the nominal line still reflects inflation.

### Out of this plan (tracked elsewhere)
- Per-person / household-blended age (§8, §10 Q1).
- Per-category bands (§8).
- Emitted-action journal visibility (§10 Q3) — follow-up.
- MC sweep of in-array band values — gated on design 25a nested-path params (§7); the scalar `ageBandDeclineRate` is sweepable now.
