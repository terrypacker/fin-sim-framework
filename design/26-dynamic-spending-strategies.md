# 26 — Dynamic Spending Strategies

**Status**: COMPLETE — both increments landed 2026-06-05
**Phase dependencies**: Phase A substrate must land first — both `design/25-holding-level-state.md` (✅ landed) **and** `design/25a-mc-nested-param-paths.md` (⚠️ not yet landed; required for the `HealthcareEventDriven` MC sweep — see §12). This design doesn't read holdings directly but ships after the substrate is stable.
**Related**: `design/24-financial-modeling-roadmap.md` §3.2, `design/21-financial-shock-and-regime-framework.md` (regime-aware strategies read `state.activeRegimes`), `design/23-fx-exchange.md` (Guardrail's portfolio sum is FX-converted to base currency), `design/15-config-as-source-of-truth.md` (strategy params live in the toolset param schema), `design/27-mortality-and-survivor-mechanics.md` (survivor + late-life-care multipliers write per-slice deltas onto the materialized `state.expenses`).
**Author note**: Section bodies finalized 2026-06-05 from the §10 open-question answers and the §11 follow-up list. The implementation decisions (monthlyExpenses-as-derived-getter, 25a-first sequencing, increment scope) are recorded in §12.

---

## 1. Purpose

`state.monthlyExpenses` is a scalar inflated annually by `InflationAdjustReducer`. There is no conditional logic, no regime awareness, no event-driven medical expense. A defensible retirement plan needs spending that **responds** — to portfolio drawdowns, to economic regimes, to one-off health events — without rewriting every consumer of `monthlyExpenses`.

This design introduces a **pluggable spending strategy layer**: the same handler/reducer pattern as everything else, with a toolset-selected strategy contributing the per-month spending adjustment. The load-bearing substrate change is **materializing the expense split into state** (`state.expenses = { essential, discretionary }`), which gives each strategy a place to carry slice-specific state across periods and avoids double-counting when multiple strategies adjust the same slice.

---

## 2. Today

The current model is a single scalar with one inflation knob:

- **`state.monthlyExpenses`** — scalar, seeded from the toolset/scenario param `monthlyExpenses` (default 6000).
- **`MonthlyExpensesHandler`** (`src/finance/handlers/monthly-expenses-handler.js`) reads `data?.amount ?? state.monthlyExpenses ?? this.monthlyExpenses` (line 86), picks the residence-appropriate savings account, prepends `REPLENISH_SAVINGS` if the debit would breach `minimumBalance`, then emits `EXPENSE_DEBIT` + metric/balance records. It does **not** read any slice or strategy.
- **`InflationAdjustReducer`** (`src/finance/reducers/inflation-adjust-reducer.js`, `PRE_PROCESS + 2`) inflates `state.monthlyExpenses` once per year, only when the advancing country matches the primary person's residence (line 71). Wages and SS inflate at the US rate.
- **Consumers of `monthlyExpenses`** (≈10 files): `intl-retirement-scenario.js`, `scenario-loader.js`, the US/AU retirement toolsets, `intl-retirement-opt-config.js`, `intl-retirement-state.js`, `monthly-expenses-handler.js`, `inflation-adjust-reducer.js`, `intl-retirement-mc-config.js`, `state-schema-registry.js`, `handler-service.js`.

No strategy selection; the inflation rate is the only knob. The migration in §12 keeps `state.monthlyExpenses` working for these consumers by making it a derived read of the new slices.

---

## 3. Strategies

Four strategies, composable. Each registers its own handler / reducer; ordering via `PRIORITY`. **All four operate on the materialized `state.expenses.{essential, discretionary}` slices (§4.2), not on the `monthlyExpenses` scalar.**

| Strategy | Behavior | Slice acted on |
|---|---|---|
| `FixedInflationAdjusted` (current) | The current behavior wrapped as one strategy. Inflates both slices annually (uniform rate at MVP; slice-specific rates are a future increment). Default. | both (essential + discretionary), uniform |
| `Guardrail` (Guyton-Klinger) | Reads portfolio value vs. a target band each year (anchored to the `RETIREMENT_DATE_REACHED` anniversary); if down > X%, cut spending by Y%; if up > Z%, raise by W%. | discretionary only |
| `RegimeAware` | Reads `state.activeRegimes`; if any active regime is tagged `ECONOMIC_STRESS`, multiplies the discretionary slice by a configurable cut factor (`regimeAwareCutPct`, default 0.15). Fires once regardless of how many tagged regimes are active. | discretionary only |
| `HealthcareEventDriven` | Adds one-off `HEALTHCARE_EXPENSE` `OneOffEvent`s (deterministic or MC-drawn) on top of any base strategy. Medical spend is treated as essential. | essential (or a configurable slice) |

Strategies compose: a scenario can run `FixedInflationAdjusted` + `Guardrail` + `RegimeAware` + `HealthcareEventDriven` simultaneously. Because each writes a slice-scoped delta against materialized state, two strategies touching the same slice add rather than clobber.

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

### 4.2 Discretionary vs. essential — materialized in state

The split is a **single number applied once at boot**, not a per-category breakdown and not an inline calc inside each reducer. New scenario param `discretionarySharePct` (default 0.30). At boot, state is materialized:

```js
state.expenses = {
  essential:     monthlyExpenses * (1 - discretionarySharePct),
  discretionary: monthlyExpenses * discretionarySharePct,
};
```

After boot the two slices live in `state.expenses` and are updated **independently**: `FixedInflationAdjusted` inflates both, `Guardrail` and `RegimeAware` adjust `discretionary`, `HealthcareEventDriven` adds to `essential`, and design 27's survivor / late-life-care multipliers write per-slice deltas. `state.monthlyExpenses` is kept as a **derived read** (`essential + discretionary`) for the existing ≈10 consumers — see §12 decision 1.

Per-person and per-period splits are intentionally deferred (§8) — they are future layers over the same materialized substrate. Materialization (not the share location) is the load-bearing decision.

### 4.3 Lifecycle events

`HealthcareEventDriven` and `Guardrail` interact with two new lifecycle events:

- **`HEALTHCARE_EXPENSE`** — one-off, deterministic or MC-scheduled (see `design/25a-mc-nested-param-paths.md`). Carries `amount`, `category`, `personId`. Adds to the essential slice.
- **`RETIREMENT_DATE_REACHED`** — already implicit at `Person.retirementDate`; this design makes it **explicit and is a hard precondition for `Guardrail`**. Without it, Guardrail cannot establish its `initialWithdrawalRate` baseline (it fires `GUARDRAIL_BASELINE_APPLY` on this event). Phase B must ship this event. If the scenario opens already post-retirement, the baseline is captured at sim start instead.

Both follow the `OneOffEvent` → handler → action → reducer pattern. No new framework infrastructure.

---

## 5. Event / Handler / Action / Reducer architecture

| Action | Fields | Reducer | Priority | Writes |
|---|---|---|---|---|
| `SPENDING_STRATEGY_APPLY` | `delta`, `reason`, `slice` (`'essential'\|'discretionary'`) | `SpendingStrategyApplyReducer` | `CASH_FLOW (20)` | `state.expenses[slice] += delta` |
| `HEALTHCARE_EXPENSE_APPLY` | `amount`, `category`, `personId` | `HealthcareExpenseApplyReducer` | `CASH_FLOW (20)` | `state.expenses.essential` (one-off debit + slice bump) |
| `GUARDRAIL_BASELINE_APPLY` | `initialWithdrawalRate`, `date` | `GuardrailBaselineApplyReducer` | `PRE_PROCESS (10)` | `state.guardrail.initialWithdrawalRate` |
| `GUARDRAIL_ADJUST_APPLY` | `multiplier`, `cause` | `GuardrailAdjustApplyReducer` | `PRE_PROCESS (10)` | `state.expenses.discretionary` only (so subsequent expense reducers see the adjusted slice) |

Notes:
- `GUARDRAIL_BASELINE_APPLY` fires once, off `RETIREMENT_DATE_REACHED` (or sim start if post-retirement).
- `GUARDRAIL_ADJUST_APPLY` and `RegimeAware`'s `SPENDING_STRATEGY_APPLY` both target the discretionary slice and **add** — they don't overwrite each other.
- `FixedInflationAdjusted` is the existing `InflationAdjustReducer` retargeted to inflate both slices instead of the scalar.

---

## 6. State additions

- `state.expenses = { essential, discretionary }` — **replaces `state.monthlyExpenses` as the source of truth.** Materialized at boot (§4.2). `state.monthlyExpenses` is retained as a derived read-only sum (`essential + discretionary`) for backward compatibility with existing consumers (§12 decision 1).
- `state.guardrail = { initialWithdrawalRate, lastAdjustmentDate, currentAdjustmentMultiplier, portfolioAccountIds: string[] | null }`.
- `state.healthcareEventsScheduled` — array; entries cleared as events fire.
- `state.discretionarySharePct` — scalar; retained for reference / re-materialization, though the slices in `state.expenses` are authoritative after boot.
- `state.regimeActions` — general regime-effect tracking map, keyed by action-type string. Each entry is `{ active: bool, appliedMultiplier: number|null, firedForShocks: string[] }`. Shared across all regime-driven strategies (spending, behavioral, etc.) so each strategy adds its own key rather than polluting top-level state. Initialized to `{}` at boot; each strategy lazily initializes its key. See §13 for the two patterns it supports (reversible-while-active vs. one-shot trigger).

The `Shock` schema and the regime object gain `tags: string[]` (§7). No other change to the `state.activeRegimes` shape beyond a read; the `ECONOMIC_STRESS` tag check is one lookup per period.

---

## 7. Interaction with existing designs

| Design | Interaction |
|---|---|
| **25 Holdings** | None direct. Spending acts on cash flow, not portfolio structure. Ships after 25 only because the roadmap commits to a single-threaded build order. Guardrail reads `account.balance` (already mark-to-market via holdings) — it does not walk holdings. |
| **25a MC paths** | `HealthcareEventDriven` schedules deterministic events in single runs; MC sweeps the count / severity via nested-path parameters under `parameters.healthcare.*`. **Hard dependency for the healthcare-MC sweep** — 25a must land first (§12 decision 2). |
| **21 Regimes** | `RegimeAware` reads `state.activeRegimes` and filters by tags. This design adds `tags: string[]` to the `Shock` schema (user-configurable) and propagates `shock.tags ?? []` onto the regime literal that `EconomicShockHandler` builds. A small change to design 21's data shape; **no change to its handlers or reducers**. Regimes deserialized without `tags` default to `[]` (no action). `REGIME_TAG` ships as a frozen const enum with initial value `{ ECONOMIC_STRESS }`. |
| **23 FX** | Guardrail's portfolio sum is FX-converted to the household's country-of-residence base currency via `FxService` before summing (the typical AU+US-resident couple uses AUD). Households with mixed-residency spouses need an explicit base-currency choice. |
| **27 Mortality** | The survivor multiplier and `lateLifeCareFactor` from design 27 write **per-slice** `SPENDING_STRATEGY_APPLY` deltas — which depends on the materialization landing here. Design 27 replaces its single `survivorMultiplier` with `survivorEssentialMultiplier` (0.85) + `survivorDiscretionaryMultiplier` (0.50); both ride the same additive substrate as Guardrail/RegimeAware. This design must ship materialized slices or 27 falls back to a scalar multiplier. |
| **15 Config** | Strategy selection and tuning knobs are toolset params, round-tripped via `cfg.params` per design 15. |

---

## 8. Out of scope

- Per-category essential / discretionary breakdowns (one scalar split is enough for Phase B).
- **Per-period or per-person `discretionarySharePct`** — future layer over the materialized slices.
- **Compounding multi-regime spending cuts** — MVP fires the discretionary cut once if any tagged regime is active; recovery curves already model severity.
- Coverage modeling (Medicare, Medicaid, AU PBS). `HEALTHCARE_EXPENSE` is gross spending; coverage offsets are a future design.
- Behavioral calibration of `Guardrail` thresholds against empirical data. This design ships configurable knobs; calibration is research, not engineering.
- Tags beyond `ECONOMIC_STRESS` — add a tag only when a strategy actually consumes it.

---

## 9. Testing sketch

- `tests/unit/spending-strategy-registry.test.mjs` — registry lookup, composition order.
- `tests/unit/spending-fixed.test.mjs`, `spending-guardrail.test.mjs`, `spending-regime-aware.test.mjs`, `spending-healthcare.test.mjs` — one per strategy.
- `tests/unit/spending-materialization.test.mjs` — round-trip correctness: `monthlyExpenses` ↔ sliced `state.expenses` through inflation and one round of strategy adjustments; assert `state.monthlyExpenses` derived sum stays consistent.
- `tests/unit/spending-guardrail-fx.test.mjs` — Guardrail's FX-converted multi-currency portfolio sum (USD + AUD accounts → AUD base).
- `evt-spending-composition.test.mjs` — end-to-end with two strategies active (RegimeAware + Guardrail both adjusting discretionary; assert additive, not clobbering).
- Extend `intl-retirement-mc-runner.test.mjs` with a healthcare-event MC sweep — **gated on 25a landing.**

---

## 10. Open questions — RESOLVED

All four kickoff questions are answered; retained here as the decision record. The doc bodies above (§3–§9) already reflect these.

- **Where does the discretionary-share split live?** Scenario-wide param (`discretionarySharePct`, default 0.30) **plus materialize the split in state** as `state.expenses = { essential, discretionary }`, written at boot. All strategies read and write the two slices directly. `state.monthlyExpenses` becomes a derived sum (§12 decision 1). Per-person and per-period deferred (§8). Materialization is the load-bearing decision.
- **Does `Guardrail` trigger off household net worth or a portfolio subset?** Configured portfolio subset, defaulted from existing data: portfolio = sum of `account.balance` where `drawdownPriority != null`, with optional `guardrailPortfolioAccountIds: string[]` override. Annual check anchored to the `RETIREMENT_DATE_REACHED` anniversary; `state.guardrail.initialWithdrawalRate` captured at that event (or sim start if post-retirement); uses `account.balance` directly (mark-to-market via design 25); FX-converted to base currency via design 23 before summing; `annualSpending = (state.expenses.essential + state.expenses.discretionary) * 12`.
- **Does `RegimeAware` use `regime.tags` or pattern-match `regime.id`?** Tags, declared at the shock level and propagated to the regime. Add `tags: string[]` to `Shock`; `EconomicShockHandler` copies `shock.tags ?? []` onto the regime; export `REGIME_TAG` frozen const (`{ ECONOMIC_STRESS }`). `RegimeAware` checks `state.activeRegimes.some(r => r.tags?.includes(REGIME_TAG.ECONOMIC_STRESS))`. MVP taxonomy is just `ECONOMIC_STRESS`; multiple tagged regimes do not compound; `regimeAwareCutPct` is a single number (default 0.15); regimes without `tags` default to `[]`.

---

## 11. Doc-body follow-ups — APPLIED

The §10 answers have been folded into the section bodies (2026-06-05):

- ✅ **§3** strategies table now states all four operate on materialized slices and names the slice each touches.
- ✅ **§4.2** rewritten for materialization (single split at boot; slices updated independently).
- ✅ **§4.3** `RETIREMENT_DATE_REACHED` marked as a Guardrail precondition.
- ✅ **§5** action table adds `GUARDRAIL_BASELINE_APPLY`; confirms `GUARDRAIL_ADJUST_APPLY` → discretionary only, healthcare → essential.
- ✅ **§6** `state.monthlyExpenses` scalar replaced by `state.expenses`; `state.guardrail` added; `tags` noted.
- ✅ **§7** Mortality / Regimes rows updated; FX row added.
- ✅ **§8** deferred items added (per-period/per-person share; compounding multi-regime cuts).
- ✅ **§9** materialization and Guardrail-FX tests added.

---

## 12. Implementation decisions & sequencing (2026-06-05)

Three load-bearing implementation choices, confirmed at finalization:

1. **`state.monthlyExpenses` → keep as a derived read-only getter**, not removed. `state.expenses = { essential, discretionary }` is the source of truth; `monthlyExpenses` is computed as the sum so the ≈10 existing consumers (§2) keep working unchanged. Lowest migration risk; a later cleanup PR can migrate consumers to read slices directly and drop the derived field.

2. **Land design 25a (MC nested param paths) before design 26.** 25a is now `Ready for implementation` and re-scoped (2026-06-05) around its real driving consumer: **restoring multi-shock MC sweeps**. The current flat `shockSeverity`/`shockStartDate` overlay can only perturb `shocks[0]`; 25a replaces it with nested-path sweeping so every configured shock is independently sweepable. The same path-walker substrate then serves `HealthcareEventDriven`'s MC sweep (§9) and design 27's mortality-MC. (Note: healthcare-MC could alternatively use flat keys, so 25a is not a *hard* blocker for 26's single-run strategies — but it is the chosen build-order priority and lands first.)

3. **Increment scope — materialization + `FixedInflationAdjusted` + `RegimeAware` first.** Land `state.expenses` materialization, `SPENDING_STRATEGY_REGISTRY`, `FixedInflationAdjusted` (wrapping current behavior — the retargeted `InflationAdjustReducer`), and `RegimeAware` (needs only the `tags` plumbing + a read of `state.activeRegimes`). Defer `Guardrail` (needs `RETIREMENT_DATE_REACHED`, FX portfolio sum, baseline capture) and `HealthcareEventDriven` (needs 25a for MC) to a second increment. This validates the materialization migration with the two lowest-risk strategies before adding the event-driven machinery.

**Build order:** `25a` → `26` increment 1 (materialization + Fixed + RegimeAware) → `26` increment 2 (Guardrail + Healthcare). Design 27 (Mortality) can interleave once increment 1's materialized slices land.

---

## 13. Step-by-step Implementation Plan (added 2026-06-05)

### Status legend
- [ ] not started  ✅ complete

---

### Increment 1 — Materialization + FixedInflationAdjusted + RegimeAware

**Step 1 — `REGIME_TAG` const** ✅
- Create `src/finance/economic-regimes/regime-tag.js`
- `export const REGIME_TAG = Object.freeze({ ECONOMIC_STRESS: 'ECONOMIC_STRESS' });`
- No other changes; just the vocabulary.

**Step 2 — Add `tags` to `EconomicShockHandler`** ✅
- `src/finance/economic-regimes/economic-shock-handler.js`: in the `regime` object literal built in `call()`, add `tags: shock.tags ?? []`.
- `AddRegimeReducer` passes the regime object through unchanged — no edits needed there.

**Step 3 — Materialize `state.expenses` in `InternationalRetirementFinancialState`** ✅
- `src/finance/state/intl-retirement-state.js`:
  - Add `discretionarySharePct` constructor param (default `0.30`); store as `this.discretionarySharePct`.
  - Compute and store `this.expenses = { essential: monthlyExpenses * (1 - pct), discretionary: monthlyExpenses * pct }`.
  - Add `this.regimeActions = {};` — general regime-effect tracking map shared by all regime-driven strategies; each strategy lazily initializes its own key.
  - Keep `this.monthlyExpenses` as a plain scalar — it stays in sync (not a JS getter; state is structuredClone-safe plain object). Every reducer that writes to `state.expenses` must also update `state.monthlyExpenses = essential + discretionary`.

**Step 4 — Retarget `InflationAdjustReducer` to inflate slices** ✅
- `src/finance/reducers/inflation-adjust-reducer.js`:
  - When `state.expenses` is defined: inflate `expenses.essential` and `expenses.discretionary` by `factor`; set `monthlyExpenses = essential + discretionary`.
  - When `state.expenses` is absent (legacy scenarios without the new state shape): fall back to inflating `monthlyExpenses` directly (backward-compatible no-op for old snapshots/tests).

**Step 5 — Create `SpendingStrategyApplyReducer`** ✅
- Create `src/finance/spending/spending-strategy-apply-reducer.js`
- Action type: `SPENDING_STRATEGY_APPLY`; priority: `CASH_FLOW (20)`.
- Payload: `{ delta, slice ('essential'|'discretionary'), reason }`.
- Logic: `expenses[slice] += delta`; then `monthlyExpenses = expenses.essential + expenses.discretionary`.

**Step 6 — Create `RegimeAwareSpendingReducer`** ✅
- Create `src/finance/spending/strategies/regime-aware-spending-reducer.js`
- Listens on `['US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE']`; priority `PRE_PROCESS + 3` (fires after `InflationAdjustReducer` at +2, so it sees already-inflated slices).
- Constructor param: `regimeAwareCutPct = 0.15`.
- State key: `state.regimeActions.spending_discretionary_cut = { active, appliedMultiplier, firedForShocks }` (lazily initialized).
- Each annual advance:
  - `isActive` = `state.activeRegimes.some(r => r.tags?.includes(REGIME_TAG.ECONOMIC_STRESS))`.
  - If `isActive && !entry.active`:  
    → `expenses.discretionary *= (1 - regimeAwareCutPct)`; store `appliedMultiplier = 1 - pct`; `active = true`.
  - If `!isActive && entry.active`:  
    → `expenses.discretionary /= entry.appliedMultiplier`; `active = false`; `appliedMultiplier = null`.
  - Always sync: `monthlyExpenses = expenses.essential + expenses.discretionary`.

**Step 7 — Create `SPENDING_STRATEGY_REGISTRY`** ✅
- Create `src/finance/spending/spending-strategy-registry.js`
- Exports `SPENDING_STRATEGY_REGISTRY` (plain object keyed by strategy id):
  ```js
  FIXED: {
    reducers: () => [],         // InflationAdjustReducer is wired directly by the toolset
    paramSchema: () => [],
  },
  REGIME_AWARE: {
    reducers: (context) => [new RegimeAwareSpendingReducer({ regimeAwareCutPct: context.parameters.regimeAwareCutPct ?? 0.15 })],
    paramSchema: () => [{ key: 'regimeAwareCutPct', ... }],
  },
  ```
- Increment 2 will add `GUARDRAIL` and `HEALTHCARE` entries.

**Step 8 — Add params + wire strategies in toolsets** ✅
- `src/scenarios/toolsets/us-retirement-toolset.js` and `au-retirement-toolset.js`:
  - `paramSchema()`: add `discretionarySharePct` (Number, default `0.30`, group `Spending`) and `regimeAwareCutPct` (Number, default `0.15`, group `Spending`).
  - `state()`: add `discretionarySharePct: p.discretionarySharePct ?? 0.30` to patches.
  - `reducers()`: always register `SpendingStrategyApplyReducer`; if `spendingStrategy` includes `'REGIME_AWARE'`, push `RegimeAwareSpendingReducer` from registry.
- Note: `spendingStrategy` selection param deferred until EnumMulti UI support lands; for now the registry wiring is gated by `p.regimeAwareCutPct !== undefined` or a simple boolean param `regimeAwareSpending`.

**Step 9 — Update `intl-retirement-scenario.js` defaults** ✅
- Add `discretionarySharePct: 0.30` to `INTL_RETIREMENT_DEFAULTS`.

**Step 10 — Update `state-schema-registry.js`** ✅
- Register `expenses.essential` and `expenses.discretionary` as `ParameterValueType.currency(...)` (or nested registration if the registry supports it).

**Step 11 — Unit tests** ✅
- `tests/unit/spending-materialization.test.mjs` — boot math; derived `monthlyExpenses` sum; inflation correctly inflates both slices.
- `tests/unit/spending-fixed.test.mjs` — existing inflation behavior unchanged; `monthlyExpenses` stays in sync.
- `tests/unit/spending-regime-aware.test.mjs` — cut applies at regime activation; does not compound; reverts at regime end.
- `tests/unit/spending-strategy-registry.test.mjs` — registry lookup for FIXED and REGIME_AWARE.

---

### Increment 2 — Guardrail + HealthcareEventDriven ✅

**Step 12 — Emit `RETIREMENT_DATE_REACHED` lifecycle event** ✅
- `RetirementDateHandler` (`src/finance/spending/strategies/retirement-date-handler.js`) handles `RETIREMENT_DATE_REACHED`.
- Toolset `schedules()` registers a `OneOffEvent` at each person's future `retirementDate`.
- If sim opens post-retirement, toolset `state()` pre-populates `state.guardrail.initialWithdrawalRate` from initial account balances.
- Handler computes portfolio value via `computeGuardrailPortfolioValue` (FX-aware) and emits `GUARDRAIL_BASELINE_APPLY`.

**Step 13 — `GuardrailBaselineApplyReducer`** ✅
- `src/finance/spending/strategies/guardrail-baseline-apply-reducer.js`; priority `PRE_PROCESS (10)`.
- Stores `initialWithdrawalRate`, `portfolioValue`, `annualSpending`, `baselineDate` in `state.guardrail`.
- Resets `currentAdjustmentMultiplier = 1.0` and clears last-adjustment fields.

**Step 14 — `GuardrailAdjustApplyReducer`** ✅
- `src/finance/spending/strategies/guardrail-adjust-apply-reducer.js`; priority `PRE_PROCESS (10)`.
- Payload: `{ multiplier, cause }`. Multiplies `state.expenses.discretionary`; syncs `monthlyExpenses`.
- Compounds `state.guardrail.currentAdjustmentMultiplier`.

**Step 15 — `GuardrailAnnualCheckReducer`** ✅
- `src/finance/spending/strategies/guardrail-annual-check-reducer.js`; priority `PRE_PROCESS + 3`.
- On each annual period advance: computes `currentRate = annualSpending / portfolioValue` (FX-converted).
- Emits `GUARDRAIL_ADJUST_APPLY` via `state.next` if cut or raise threshold is breached.
- Shared utility: `src/finance/spending/guardrail-portfolio-value.js`.

**Step 16 — `HealthcareEventDriven` strategy** ✅
- `HealthcareEventHandler` (`src/finance/spending/strategies/healthcare-event-handler.js`) handles `HEALTHCARE_EXPENSE` events; emits `EXPENSE_DEBIT` + `HEALTHCARE_EXPENSE_APPLY`.
- `HealthcareExpenseApplyReducer` (`src/finance/spending/strategies/healthcare-expense-apply-reducer.js`); priority `CASH_FLOW (20)`; accumulates `healthcareSpendingYTD` + `healthcareSpendingTotal` (does NOT modify `state.expenses.essential` permanently — healthcare is a one-off debit, not a recurring budget change).
- Deterministic `OneOffEvent`s scheduled from `parameters.healthcareEvents` array at toolset `schedules()` time.
- MC sweep via 25a nested-path params is deferred to a future increment.

**Step 17 — Tests for Increment 2** ✅
- `tests/unit/spending-guardrail.test.mjs` — 14 tests: baseline capture, band triggers, cut/raise, handler rate calc.
- `tests/unit/spending-guardrail-fx.test.mjs` — 7 tests: multi-currency portfolio sum, USD+AUD conversion.
- `tests/unit/spending-healthcare.test.mjs` — 10 tests: one-off event fires, EXPENSE_DEBIT emitted, REPLENISH_SAVINGS when needed, AU-resident routing.
- `tests/unit/spending-composition.test.mjs` — 4 tests: RegimeAware + Guardrail additive; Guardrail raise doesn't clobber regime cut.
