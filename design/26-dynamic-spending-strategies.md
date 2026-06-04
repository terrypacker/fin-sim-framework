# 26 — Dynamic Spending Strategies

**Status**: Skeleton (Phase B per `design/24-financial-modeling-roadmap.md` §5)
**Phase dependencies**: Phase A (`design/25-holding-level-state.md`) lands first. This design doesn't read holdings directly but ships after substrate is stable.
**Related**: `design/24-financial-modeling-roadmap.md` §3.2, `design/21-financial-shock-and-regime-framework.md` (regime-aware strategies read `state.activeRegimes`), `design/15-config-as-source-of-truth.md` (strategy params live in the toolset param schema).
**Author note**: Skeleton document. Section bodies are placeholders to be filled when Phase B opens. The shape captured here is what the roadmap commits to in §3.2 + §4.3.

---

## 1. Purpose

`state.monthlyExpenses` is a scalar inflated annually by `InflationAdjustReducer`. There is no conditional logic, no regime awareness, no event-driven medical expense. A defensible retirement plan needs spending that **responds** — to portfolio drawdowns, to economic regimes, to one-off health events — without rewriting every consumer of `monthlyExpenses`.

This design introduces a **pluggable spending strategy layer**: the same handler/reducer pattern as everything else, with a toolset-selected strategy contributing the per-month spending adjustment.

---

## 2. Today

> *To populate when Phase B opens.*

Pointer: `state.monthlyExpenses` is read by `MonthlyExpensesHandler` (`src/finance/handlers/monthly-expenses-handler.js`), inflated annually by `InflationAdjustReducer` (`src/finance/reducers/inflation-adjust-reducer.js`). No strategy selection; the inflation rate is the only knob.

---

## 3. Strategies

Four strategies, composable. Each registers its own handler / reducer; ordering via `PRIORITY`.

| Strategy | Behavior |
|---|---|
| `FixedInflationAdjusted` (current) | Scalar `monthlyExpenses`, inflated annually. Default. The current behavior wrapped as one strategy in the new framework. |
| `Guardrail` (Guyton-Klinger) | Reads portfolio value vs. a target band each year; if down > X%, cut spending by Y%; if up > Z%, raise by W%. |
| `RegimeAware` | Reads `state.activeRegimes`; under any regime tagged `economicStress`, multiplies the discretionary slice of spending by a configurable cut factor. |
| `HealthcareEventDriven` | Adds one-off `HEALTHCARE_EXPENSE` `OneOffEvent`s (deterministic or MC-drawn) on top of any base strategy. |

Strategies compose: a scenario can run `FixedInflationAdjusted` + `Guardrail` + `RegimeAware` + `HealthcareEventDriven` simultaneously.

---

## 4. Substrate

### 4.1 Param-driven strategy selection

```js
// Toolset paramSchema:
{ key: 'spendingStrategy', type: 'EnumMulti', options: ['FIXED', 'GUARDRAIL', 'REGIME_AWARE', 'HEALTHCARE'] }

// Toolset handlers(context):
const strats = context.parameters.spendingStrategy;       // string[]
return strats.flatMap(s => SPENDING_STRATEGY_REGISTRY[s].handlers(context));
```

`SPENDING_STRATEGY_REGISTRY` lives at `src/finance/spending/spending-strategy-registry.js`. Each entry exposes `handlers(context)`, `reducers(context)`, `state(context)`, `paramSchema(context)` — same shape as a toolset but scoped to one mechanism.

### 4.2 Discretionary vs. essential

`RegimeAware` and `Guardrail` both need to know which slice of spending is cuttable. New scenario param `discretionarySharePct` (default 0.30) splits `monthlyExpenses` into essential and discretionary. The split is one number, not a per-category breakdown; per-category breakdowns are out of scope.

### 4.3 Lifecycle events

`HealthcareEventDriven` and `Guardrail` interact with two new lifecycle events:

- `HEALTHCARE_EXPENSE` — one-off, deterministic or MC-scheduled (see `design/25a-mc-nested-param-paths.md`). Carries `amount` and `category`.
- `RETIREMENT_DATE_REACHED` — already implicit at `Person.retirementDate`; this design makes it explicit so `Guardrail` can swap from accumulation- to drawdown-mode rules.

Both follow the `OneOffEvent` → handler → action → reducer pattern. No new framework infrastructure.

---

## 5. Event / Handler / Action / Reducer architecture

> *Tables to populate when Phase B opens. Following the design-21 / design-25 template.*

Action sketch:

| Action | Fields | Reducer | Priority |
|---|---|---|---|
| `SPENDING_STRATEGY_APPLY` | `delta`, `reason`, `category` | `SpendingStrategyApplyReducer` | `CASH_FLOW (20)` |
| `HEALTHCARE_EXPENSE_APPLY` | `amount`, `category`, `personId` | `HealthcareExpenseApplyReducer` | `CASH_FLOW (20)` |
| `GUARDRAIL_ADJUST_APPLY` | `multiplier`, `cause` | `GuardrailAdjustApplyReducer` | `PRE_PROCESS (10)` (so subsequent expense reducers see the adjusted rate) |

---

## 6. State additions

> *To populate.*

Sketch:

- `state.spendingStrategy` — `{ active: string[], guardrailBand: {…}, regimeAwareCutPct: number, … }`
- `state.discretionarySharePct` — scalar.
- `state.healthcareEventsScheduled` — array; cleared as events fire.

No interaction with `state.activeRegimes` shape beyond a read; the `economicStress` tag check is one lookup per period.

---

## 7. Interaction with existing designs

| Design | Interaction |
|---|---|
| **25 Holdings** | None direct. Spending acts on cash flow, not portfolio structure. Ships after 25 only because the roadmap commits to a single-threaded build order. |
| **21 Regimes** | `RegimeAware` reads `state.activeRegimes`. No change to the regime data model. |
| **27 Mortality** | Survivor multiplier (e.g. 70% of joint expenses post-`PERSON_DIED`) and `lateLifeCareFactor` live in design 27; they interoperate with whichever spending strategies are active via additive `SPENDING_STRATEGY_APPLY` deltas. |
| **15 Config** | Strategy selection and tuning knobs are toolset params, round-tripped via `cfg.params` per design 15. |
| **25a MC paths** | `HealthcareEventDriven` schedules deterministic events in single runs; MC sweeps the count / severity via nested-path parameters under `parameters.healthcare.*`. |

---

## 8. Out of scope

- Per-category essential / discretionary breakdowns (one scalar split is enough for Phase B).
- Coverage modeling (Medicare, Medicaid, AU PBS). `HEALTHCARE_EXPENSE` is gross spending; coverage offsets are a future design.
- Behavioral calibration of `Guardrail` thresholds against empirical data. This design ships configurable knobs; calibration is research, not engineering.

---

## 9. Testing sketch

- `tests/unit/spending-strategy-registry.test.mjs` — registry lookup, composition order.
- `tests/unit/spending-fixed.test.mjs`, `spending-guardrail.test.mjs`, `spending-regime-aware.test.mjs`, `spending-healthcare.test.mjs` — one per strategy.
- `evt-spending-composition.test.mjs` — end-to-end with two strategies active.
- Extend `intl-retirement-mc-runner.test.mjs` with a healthcare-event MC sweep.

---

## 10. Open questions

> *Capture during Phase B kickoff. Initial seed:*

- Where does the discretionary-share split live: scenario-wide param, per-person, or per-period? **Answer:** Scenario-wide param (`discretionarySharePct`, default 0.30) **plus materialize the split in state** as `state.expenses = { essential, discretionary }`, written at boot from `monthlyExpenses * (1 - share)` and `monthlyExpenses * share`. All strategies (Guardrail, RegimeAware, survivor multiplier from design 27, late-life-care, healthcare events) read and write the two slices directly. `state.monthlyExpenses` becomes a derived sum (or is removed). Per-person and per-period are intentionally deferred — they are future layers over the same substrate. Materialization (not the share location) is the load-bearing decision: it gives each strategy a place to carry slice-specific state across periods and avoids double-counting when multiple strategies adjust the same slice.
- Does `Guardrail` trigger off household net worth, or off a configured "portfolio" subset of accounts? **Answer:** Configured portfolio subset, defaulted from existing data. Specifically: portfolio = sum of `account.balance` for all accounts where `drawdownPriority != null` (reusing the existing field whose stated purpose is "Liquidation order; null = exclude from drawdown"). Optional override param `guardrailPortfolioAccountIds: string[]` for users who want to exclude a drawdown account from the guardrail signal. Sub-decisions: **annual check** anchored to `RETIREMENT_DATE_REACHED` anniversary; **`state.guardrail.initialWithdrawalRate`** captured at `RETIREMENT_DATE_REACHED` (or sim start if scenario opens post-retirement); use **`account.balance`** directly (already mark-to-market via design 25 holdings, no need to walk holdings); **FX-convert to country-of-residence currency** via design 23 `FxService` before summing; **`annualSpending = (state.expenses.essential + state.expenses.discretionary) * 12`** using the materialized slices from Q1. Households where spouses have different residencies need an explicit base-currency choice; the typical AU+US-resident-couple scenario uses AUD.
- Should `RegimeAware` look at `regime.tags` (a new field on `EconomicRegime`) or pattern-match on `regime.id`? **Answer:** Tags, declared at the shock level and propagated to the regime. Concretely: add `tags: string[]` to the `Shock` schema (user-configurable); `EconomicShockHandler` copies `shock.tags ?? []` onto the regime literal it builds (alongside the existing adjustment fields); export `REGIME_TAG` as a frozen const enum from the framework with initial value `{ ECONOMIC_STRESS }`. `RegimeAware` checks `state.activeRegimes.some(r => r.tags?.includes(REGIME_TAG.ECONOMIC_STRESS))`. Sub-decisions: **MVP taxonomy is just `ECONOMIC_STRESS`** (add tags only when a strategy actually consumes them); **multiple tagged regimes do not compound** — cut fires once if any tagged regime is active (recovery curves already model severity); **`regimeAwareCutPct` is a single number** at MVP (default 0.15, cuts discretionary 15%); **backward compat:** regimes deserialized without `tags` default to `[]`, treated as "no action."

---

## 11. Doc-body follow-ups (from §10 answers)

Sections to update before implementation begins:

- **§3 strategies table:** clarify that all four strategies operate on the materialized `state.expenses.{essential,discretionary}` slices, not on a `monthlyExpenses` scalar. `Guardrail` and `RegimeAware` adjust the discretionary slice; `HealthcareEventDriven` adds to essential (medical = essential category); `FixedInflationAdjusted` inflates both slices uniformly (or with slice-specific rates if a future increment wants it).
- **§4.2 discretionary vs. essential:** rewrite to specify materialization. Replace "is one number, not a per-category breakdown" with "is a single split applied once at boot; the resulting two slices live in `state.expenses` and are updated independently thereafter."
- **§4.3 lifecycle events:** `RETIREMENT_DATE_REACHED` is now a **precondition for Guardrail**, not just a convenience. Without it, Guardrail can't establish its `initialWithdrawalRate` baseline. Phase B must ship this event.
- **§5 action table:** add `GUARDRAIL_BASELINE_APPLY` (fires at `RETIREMENT_DATE_REACHED`, writes `state.guardrail.initialWithdrawalRate`). Confirm `GUARDRAIL_ADJUST_APPLY` writes to `state.expenses.discretionary` only. Healthcare action writes to `state.expenses.essential` (or a configurable slice).
- **§6 state additions:** replace `state.monthlyExpenses` (scalar) with `state.expenses = { essential, discretionary }`. Add `state.guardrail = { initialWithdrawalRate, lastAdjustmentDate, currentAdjustmentMultiplier, portfolioAccountIds: string[] | null }`. Note that the `Shock` schema and regime object gain `tags: string[]`.
- **§7 interaction table:** **27 Mortality** row gains a note that survivor multiplier from design 27 writes per-slice deltas, which depends on materialization landing in this design. **21 Regimes** row updates to "RegimeAware reads `state.activeRegimes` and filters by tags; this design adds `tags: string[]` to the regime/shock schema (small change to design 21's data shape, but no change to handlers or reducers)." Add a row pointing to **23 FX** for currency conversion in Guardrail's portfolio sum.
- **§8 out of scope:** explicitly add "Per-period or per-person `discretionarySharePct` (future layer over materialized slices)" and "Compounding multi-regime spending cuts (MVP fires once)."
- **§9 testing sketch:** add a test for materialization correctness (round-trip `monthlyExpenses` ↔ sliced state through inflation and one round of strategy adjustments), and a test for Guardrail's FX-converted multi-currency portfolio sum.
