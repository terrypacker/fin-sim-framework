# 21 — Financial Shock & Economic Regime Framework

**Status**: Complete — Phase 1 + Phase 2 shipped (branch `wip/fx-service`)
**Scope**: Phases 1 + 2 of the original concept, scoped to mechanics this codebase actually models. Employment, credit-market, and correlation regimes are deferred until the underlying systems exist.
**Related**: `design/0-period-engine.md` (period model the reducer hooks into), `design/9-toolset-compiler.md` (where the new toolset plugs in), `design/19-type-registry.md` (action-type entries), `design/23-fx-exchange.md` (owns FX rate/fee composition — see §10).

---

## 1. Purpose

Today the simulation models the economic environment with **static, single-point inputs**: a `growthRate` baked into each earnings handler at construction time, a `state.inflationRates[cc]` map written once at scenario boot, an `interestRate` per savings handler, etc. There is no mechanism to:

- Drop a portfolio's value at a moment in time (a stock-market crash).
- Modify forward returns / interest / inflation during a defined window (a recession, an inflation spike).
- Compose multiple simultaneous environments (a recession layered on top of an inflation shock).
- Schedule a deterministic recovery curve back to baseline.

This design adds a **shock-and-regime** layer on top of the existing pipeline so the simulation can model crises **without rewriting any earnings or interest math**. Existing handlers stay the shape they are; a single new pre-process reducer materializes effective rates from a stack of active regimes, and handlers read those effective rates with a fallback to their constructor-time defaults.

---

## 2. Design Philosophy

> A financial crash is not a state change. A financial crash is a *generator* of state changes.

The simulation continues to operate through the standard `Event → Handler → Action → Reducer` pipeline. A shock produces two kinds of effects:

1. **Level effects** — instantaneous changes to balance-sheet values (stock balance drops, house re-values down). Modeled as one-shot `REVALUE_ASSET_APPLY` actions emitted at shock time.
2. **Flow effects** — changes to *forward* rates that handlers will read on subsequent periods. Modeled by adding an `EconomicRegime` to a stack on state; the regime stays until its end date or until a recovery curve fully neutralizes it.

Both the `ECONOMIC_SHOCK` one-off and its companion `ECONOMIC_RECOVERY_TICK` series are **pre-scheduled at toolset compile time** from the scenario's `shocks` parameter. No reducer ever pushes onto `sim.queue`; this keeps the existing reducer-purity contract and matches how `PERIOD_ADVANCE` / `TAX_SETTLE` already work.

A single new reducer — `RegimeApplyReducer` — walks the regime stack on each period boundary and writes `state.effectiveGrowthRates`, `state.effectiveInterestRates`, `state.effectiveInflationRates`, `state.effectiveAppreciationRates`, and `state.effectiveExchangeRates`. Every existing earnings/interest/appreciation/inflation handler swaps a single line: `this.growthRate` → `state.effectiveGrowthRates[rateKey] ?? this.growthRate`.

Single runs remain **fully deterministic**. Recovery curves are deterministic shape functions of time-since-shock. Volatility from the rough concept doc is reinterpreted as a Monte Carlo distribution parameter on shock severity, not a per-period draw inside one run — this keeps the engine's "same inputs ⇒ same outputs" contract intact.

---

## 3. In / Out of Scope

### In scope — these map to existing handlers/reducers the framework can perturb

| Concept | Today's home in the codebase |
|---|---|
| Level: equity revaluation | `state[usStockAccount / auStockAccount / iraAccount / k401Account / rothAccount / superAccount].balance` (incl. spouse twins) |
| Level: real estate revaluation | `RealProperty.value` (via `RealPropertyService`) |
| Level: collectible revaluation | `Collectible.value` |
| Flow: expected return | `IntlRothEarningsHandler`, `IntlIraEarningsHandler`, `IntlK401EarningsHandler`, `StockEarningsHandler` (US/AU), super earnings — all carry `growthRate` |
| Flow: fixed-income return | `FixedIncomeEarningsHandler.growthRate` |
| Flow: savings interest | `UsSavingsInterestMonthlyHandler.interestRate`, AU savings-interest handler |
| Flow: inflation, per-cc | `InflationAdjustReducer` reads `state.inflationRates[cc]` |
| Flow: real-estate appreciation | `RealProperty.appreciationRate` |
| Flow: FX | `state.effectiveExchangeRates.USD_AUD` (owned by design 23 — see §10) |
| Recovery | New `ECONOMIC_RECOVERY_TICK` `EventSeries` driven by the existing event queue |

### Out of scope — no underlying mechanic to perturb

| Concept | Why |
|---|---|
| Employment shocks (layoff, salary reduction, unemployment duration) | `Person.monthlyWage` is a fixed input + annual inflation. No employment/job-state model, no termination handler, no unemployment benefit. Adding these is a separate design. |
| Credit-market tightness / loan approvals | No loan origination, no refinancing, no HELOC, no credit-card debt. |
| Mortgage spread adjustments | `RealProperty.mortgagePayment` is static; no rate-driven repricing exists. |
| Bond duration sensitivity | `FixedIncomeAccount` is a single growth rate; no duration, no yield curve. |
| Correlation regimes | Returns are deterministic point estimates; no inter-asset correlation matrix exists. |
| Dividend-yield cuts | Equity shocks affect price only (`balance`); `DividendScheduledHandler`'s yield stays as configured. |

---

## 4. Core Concepts

### 4.1 `FinancialShock`

A high-level descriptor of an economic event. Lives as a **plain object** that the shock handler reads at the moment it fires; it is *not* stored on `sim.state` after its actions have been emitted.

```js
{
  shockId:    'us-equity-crash-2030',
  name:       'US Equity Crash (illustrative)',
  startDate:  Date,
  duration:   { months: 18 },             // total regime duration
  severity:   0.40,                       // 0–1 magnitude knob; consumed by levelEffects
  levelEffects: {                         // applied once at shockDate
    equityRevaluation: {
      rateKeys: ['EQUITY_US'],
      multiplier: -0.40,                  // -40% drop
    },
    realEstateRevaluation: {              // optional
      rateKeys: ['REAL_ESTATE_US'],
      multiplier: -0.20,
    },
  },
  regime: {                               // becomes the persistent EconomicRegime
    returnAdjustment:       { EQUITY_US: -0.03 },           // -3pp forward return
    interestRateAdjustment: { SAVINGS_US: -0.015 },         // Fed cuts
    inflationAdjustment:    { US: -0.01 },                  // disinflation
    appreciationAdjustment: { REAL_ESTATE_US: -0.02 },
    fxAdjustment:           null,                           // see §10
  },
  recovery: {
    profile:           'V',                                 // 'V' | 'U' | 'W' | 'L'
    durationMonths:    18,
    tickIntervalMonths: 1,
  },
}
```

A predefined library lives in `src/finance/economic-shocks/shock-library.js`: `MARKET_CRASH_2008_LITE`, `STAGFLATION_1970S_LITE`, `COVID_2020_LITE`, `CUSTOM_EQUITY_SHOCK_TEMPLATE`. They are **not** historical reproductions — they are illustrative shapes parameterized by `severity` so users can tune them.

### 4.2 `EconomicRegime`

A persistent modification to forward rates. **Lives on `sim.state`** as a plain object inside `state.activeRegimes`.

```js
{
  id:         'regime-us-equity-crash-2030',
  shockId:    'us-equity-crash-2030',
  startDate:  Date,                        // when the regime entered the stack
  endDate:    Date | null,                 // when it leaves; null = open-ended
  recoveryProfile: 'V' | 'U' | 'W' | 'L',
  durationMonths:  18,

  // Adjustments are rate-key-scoped (§5.1). null/undefined = no effect.
  returnAdjustment:       { EQUITY_US: -0.03, EQUITY_AU: -0.02 },
  interestRateAdjustment: { SAVINGS_US: -0.015 },
  inflationAdjustment:    { US: -0.01 },
  appreciationAdjustment: { REAL_ESTATE_US: -0.02 },
  fxAdjustment:           { USD_AUD: +0.05 },
}
```

A regime's adjustments are **scaled by its current recovery factor** (§7) before `RegimeApplyReducer` sums them.

### 4.3 Regime Stack

`state.activeRegimes: EconomicRegime[]`. Multiple regimes coexist; their per-rate-key adjustments **sum** (additively for returns / inflation / interest / FX, additively for appreciation). This matches the rough concept doc:

```
effectiveReturn[EQUITY_US] = baseReturn[EQUITY_US]
                           + Σ regime.returnAdjustment[EQUITY_US] × regime.currentFactor
```

`currentFactor` decays from `1.0` toward `0.0` along the recovery profile (§7). When a regime's factor reaches `0` *and* it is past `endDate`, the `RegimeApplyReducer` drops it from the stack.

---

## 5. Data Model Changes

### 5.1 Rate Keys

The pre-process reducer needs to know which effective field a given regime adjustment applies to. We introduce **rate keys** — short strings categorizing every rate-bearing handler. They live in a new module:

```js
// src/finance/economic-regimes/rate-keys.js
export const RATE_KEYS = Object.freeze({
  // Equity (forward returns)
  EQUITY_US:         'EQUITY_US',          // Roth, IRA, 401k earnings, US stock earnings
  EQUITY_AU:         'EQUITY_AU',          // AU stock, Super earnings

  // Fixed income
  FIXED_INCOME_US:   'FIXED_INCOME_US',    // FixedIncomeEarningsHandler

  // Savings interest
  SAVINGS_US:        'SAVINGS_US',
  SAVINGS_AU:        'SAVINGS_AU',

  // Real estate / collectibles
  REAL_ESTATE_US:    'REAL_ESTATE_US',
  REAL_ESTATE_AU:    'REAL_ESTATE_AU',
  COLLECTIBLE:       'COLLECTIBLE',
});

// Inflation uses country codes directly: 'US', 'AU'.
// FX uses currency pairs:                'USD_AUD'.
```

Each existing rate-bearing handler is updated to carry a `static rateKey` and (where relevant) accept a `rateKey` constructor argument so multi-jurisdiction or multi-owner instances can override. The handler-by-handler migration is listed in §11.

### 5.2 `InternationalRetirementFinancialState` additions

```js
// src/finance/state/intl-retirement-state.js
class InternationalRetirementFinancialState extends SimulationState {
  constructor({...} = {}) {
    super(rest);
    // ...existing fields...

    // ── Regime substrate (NEW) ─────────────────────────────────────────
    this.activeRegimes = [];                  // EconomicRegime[]

    // Baseline rate snapshots. Written once at scenario boot from toolset
    // params; read by RegimeApplyReducer to compute effective fields.
    this.baseGrowthRates       = {};          // { [rateKey]: number }
    this.baseInterestRates     = {};
    this.baseInflationRates    = { ...this.inflationRates };  // existing field
    this.baseAppreciationRates = {};
    // baseExchangeRates / baseFxFees / effectiveExchangeRates / effectiveFxFees
    // are owned by design 23 (FxService). They are introduced as part of that
    // design's Phase 1 and read/written by this design's RegimeApplyReducer.

    // Effective rates: regime-adjusted. RegimeApplyReducer writes them on
    // every PERIOD_ADVANCE / ADD_REGIME_APPLY / REMOVE_REGIME_APPLY.
    this.effectiveGrowthRates       = { ...this.baseGrowthRates };
    this.effectiveInterestRates     = { ...this.baseInterestRates };
    this.effectiveInflationRates    = { ...this.baseInflationRates };
    this.effectiveAppreciationRates = { ...this.baseAppreciationRates };
    // effectiveExchangeRates / effectiveFxFees: see design 23.
  }
}
```

`state.inflationRates` is retained as an alias for `state.baseInflationRates` until all callers migrate; once migrated, the deprecated field is removed (one PR, one cleanup commit). The FX-side `base*` / `effective*` field pair is owned by design 23 and not duplicated here.

### 5.3 Delete `FinancialState`

`src/finance/state/financial-state.js` is unused outside of `tests/unit/asset-rules.test.mjs` and the auto-generated `src/index.js` export. As part of this design:

1. Rewrite `asset-rules.test.mjs` to use a minimal inline test state (`new SimulationState({ checkingAccount: new Account(0) })` plus the asset-specific fields the test actually needs) or `InternationalRetirementFinancialState` if a full retirement state is cleaner.
2. Delete `src/finance/state/financial-state.js`.
3. Run `npm run build:index` to regenerate `src/index.js`.

This removes a dead abstraction and clarifies that `InternationalRetirementFinancialState` is the sole financial state class.

### 5.4 `StateSchemaRegistry` registrations

Register `ValueType` descriptors for the new state fields so the workbench's state panel, chart, and timeline format them correctly:

| Path | Type |
|---|---|
| `activeRegimes` | `ValueType.array()` |
| `effectiveGrowthRates.*` | `ValueType.rate()` |
| `effectiveInterestRates.*` | `ValueType.rate()` |
| `effectiveInflationRates.*` | `ValueType.rate()` |
| `effectiveAppreciationRates.*` | `ValueType.rate()` |
| `effectiveExchangeRates.USD_AUD` | `ValueType.number()` |
| (same paths under `base*`) | matching types |

Registered in `ECONOMIC_REGIMES.state(context)` (§9).

---

## 6. Event / Handler / Action / Reducer Architecture

### 6.1 Event types

| Event | Kind | Purpose |
|---|---|---|
| `ECONOMIC_SHOCK` | `OneOffEvent` | Fires once at `shock.startDate`. Carries the `FinancialShock` descriptor in `data.shock`. **Pre-scheduled at toolset compile time** (§9). |
| `ECONOMIC_RECOVERY_TICK` | `EventSeries` | Periodic tick (default monthly) that re-runs `RegimeApplyReducer` so recovery factors update between period boundaries. **Pre-scheduled at toolset compile time** alongside its corresponding `ECONOMIC_SHOCK`: one series per configured shock, anchored at `shock.startDate`, ending at `shock.startDate + recovery.durationMonths`. Existing convention — no reducer-to-queue coupling. |

### 6.2 Handlers

| Handler | Event | Emits |
|---|---|---|
| `EconomicShockHandler` | `ECONOMIC_SHOCK` | `ADD_REGIME_APPLY`, one `REVALUE_ASSET_APPLY` per `levelEffect`, and a trailing `RECOMPUTE_REGIMES` so effective rates pick up the new regime on the same simulation tick. Optionally a `RECORD_METRIC` for analytics. |
| `EconomicRecoveryTickHandler` | `ECONOMIC_RECOVERY_TICK` | `RECOMPUTE_REGIMES` (a no-op action whose only purpose is to invoke `RegimeApplyReducer` between period boundaries). When the recovery is complete *and* the regime's recovery factor has reached `0`, also emits `REMOVE_REGIME_APPLY`. |

### 6.3 Actions

All extend `Action` and register via the `TypeRegistry`. Each declares fields per design 19's `ActionTypeEntry` shape.

| Action | Fields | Reducer that consumes it |
|---|---|---|
| `ADD_REGIME_APPLY` | `regime: EconomicRegime` | `AddRegimeReducer` — pushes onto `state.activeRegimes`, then `RegimeApplyReducer` recomputes effective rates. |
| `REMOVE_REGIME_APPLY` | `regimeId: string` | `RemoveRegimeReducer` — drops the regime, then `RegimeApplyReducer` recomputes. |
| `REVALUE_ASSET_APPLY` | `rateKey: string`, `multiplier: number`, `targetStateKeys?: string[]` | `RevalueAssetReducer` — for each state-key whose owning asset is tagged with `rateKey`, multiplies `balance` (Account) or `value` (RealProperty/Collectible). |
| `RECOMPUTE_REGIMES` | (none) | `RegimeApplyReducer` (no-op action that exists only to trigger the reducer on the recovery tick and immediately after a regime is added or removed). |

The action-type entries live in the new toolset's `types.actions` array. Per-action `family` and `cc` are unset (these aren't tax-bearing actions) but `fields` is populated so the workbench's action-detail panel renders payloads correctly.

**No `SCHEDULE_RECOVERY` action.** Recovery ticks are pre-scheduled at toolset compile time alongside the shock that owns them. This matches the existing convention for `PERIOD_ADVANCE` / `TAX_SETTLE` (declarative `EventSeries` rather than reducer-driven scheduling) and keeps reducers pure (no `sim.queue` mutation from reducer code).

### 6.4 Reducers and their priorities

| Reducer | Priority | Trigger action(s) | Responsibility |
|---|---|---|---|
| `PeriodAdvanceReducer` (existing) | `PRE_PROCESS (10)` | `US_PERIOD_ADVANCE`, `AU_PERIOD_ADVANCE` | Updates `state.currentPeriods`. |
| **`RegimeApplyReducer` (NEW)** | `PRE_PROCESS + 1 (11)` | `US_PERIOD_ADVANCE`, `AU_PERIOD_ADVANCE`, `ADD_REGIME_APPLY`, `REMOVE_REGIME_APPLY`, `RECOMPUTE_REGIMES` | Recomputes recovery factors against `action.date`; sums regime adjustments into `state.effective*Rates`; drops fully-recovered regimes from the stack. |
| `InflationAdjustReducer` (MODIFIED) | `PRE_PROCESS + 2 (12)` | `US_PERIOD_ADVANCE`, `AU_PERIOD_ADVANCE` | Reads `state.effectiveInflationRates[cc]` (was `state.inflationRates[cc]`). Otherwise unchanged. |
| `AddRegimeReducer` (NEW) | `CASH_FLOW (20)` | `ADD_REGIME_APPLY` | Appends regime to `state.activeRegimes`. |
| `RemoveRegimeReducer` (NEW) | `CASH_FLOW (20)` | `REMOVE_REGIME_APPLY` | Removes regime from `state.activeRegimes`. |
| `RevalueAssetReducer` (NEW) | `POSITION_UPDATE (30)` | `REVALUE_ASSET_APPLY` | Applies the multiplier to every targeted balance / value. |

**Why `RegimeApplyReducer` sits at `PRE_PROCESS + 1`:** it must run *after* `PeriodAdvanceReducer` (so `currentPeriods` is up-to-date) and *before* `InflationAdjustReducer` (so the inflation reducer can read the effective rate). Same logic applies to earnings handlers — they read effective rates only when their event fires, which is always after pre-process reducers have run for the period.

**Why `AddRegimeReducer` runs at `CASH_FLOW` instead of `PRE_PROCESS`:** by the time the `ADD_REGIME_APPLY` action is being reduced, `RegimeApplyReducer` may have already run in the same step (for a period-advance). Pushing the new regime at `CASH_FLOW` ensures it's visible to *the same reducer running again* when the next action with `RECOMPUTE_REGIMES` semantics fires. In practice we also re-invoke `RegimeApplyReducer` via the same `reducedActionTypes` list, so a single `ADD_REGIME_APPLY` action will: (1) push to the stack at `CASH_FLOW`, and (2) recompute effective rates at the same step's `PRE_PROCESS+1` slot on the *next* action. To keep the same-tick semantics tight, `EconomicShockHandler` emits `RECOMPUTE_REGIMES` as the last action after `ADD_REGIME_APPLY`, guaranteeing a recompute on the same simulation tick.

---

## 7. Recovery Curves

Deterministic shape functions parameterized by months-since-shock. Each returns a **factor in `[0, 1]`** that scales the regime's adjustments. When the factor hits `0` and `now ≥ regime.endDate`, the regime is dropped.

```js
// src/finance/economic-regimes/recovery-curves.js
export const RecoveryCurves = {
  V: (t, durationMonths) => {
    if (t < 0) return 1;
    if (t >= durationMonths) return 0;
    return 1 - t / durationMonths;                          // linear fade
  },
  U: (t, durationMonths) => {
    if (t < 0) return 1;
    const stagnation = durationMonths * 0.5;
    if (t < stagnation) return 1;
    if (t >= durationMonths) return 0;
    return 1 - (t - stagnation) / (durationMonths - stagnation);
  },
  W: (t, durationMonths) => {
    if (t < 0) return 1;
    if (t >= durationMonths) return 0;
    const phase = (t / durationMonths) * 2 * Math.PI;
    return Math.max(0, (1 + Math.cos(phase)) / 2);          // damped cosine
  },
  L: (t, durationMonths) => {
    if (t < 0) return 1;
    if (t >= durationMonths) return 0;
    return 1;                                               // flat, then snap
  },
};
```

`RegimeApplyReducer` reads `regime.recoveryProfile` and `regime.startDate`, computes `t = monthsBetween(regime.startDate, action.date)`, and applies the factor. All four curves are pure functions of `(t, durationMonths)` — no randomness, no per-step state.

---

## 8. `RegimeApplyReducer` — Core Logic

```js
// src/finance/economic-regimes/regime-apply-reducer.js
import { Reducer, PRIORITY } from '../../simulation-framework/reducers.js';
import { RecoveryCurves }    from './recovery-curves.js';

export class RegimeApplyReducer extends Reducer {
  static type        = 'RegimeApplyReducer';
  static description = 'Recomputes state.effective*Rates from state.activeRegimes and the current recovery factor for each regime.';

  constructor() {
    super('Regime Apply', PRIORITY.PRE_PROCESS + 1);
    this.reducedActionTypes = [
      'US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE',
      'ADD_REGIME_APPLY', 'REMOVE_REGIME_APPLY',
      'RECOMPUTE_REGIMES',
    ];
  }

  reduce(state, action) {
    const now = action.date ?? state._currentDate;
    const live = [];

    // 1. Compute recovery factor for each active regime; drop fully recovered.
    for (const regime of state.activeRegimes ?? []) {
      const t       = monthsBetween(regime.startDate, now);
      const curve   = RecoveryCurves[regime.recoveryProfile] ?? RecoveryCurves.V;
      const factor  = curve(t, regime.durationMonths);
      if (factor <= 0 && now >= regime.endDate) continue;
      live.push({ ...regime, currentFactor: factor });
    }

    // 2. Sum scaled adjustments into effective fields.
    //    FX fields (effectiveExchangeRates/effectiveFxFees) only exist when
    //    design 23's FxService is loaded; spread defensively from base.
    const effective = {
      effectiveGrowthRates:       { ...state.baseGrowthRates },
      effectiveInterestRates:     { ...state.baseInterestRates },
      effectiveInflationRates:    { ...state.baseInflationRates },
      effectiveAppreciationRates: { ...state.baseAppreciationRates },
      ...(state.baseExchangeRates && { effectiveExchangeRates: { ...state.baseExchangeRates } }),
      ...(state.baseFxFees        && { effectiveFxFees:        { ...state.baseFxFees } }),
    };

    for (const r of live) {
      addScaled(effective.effectiveGrowthRates,       r.returnAdjustment,       r.currentFactor);
      addScaled(effective.effectiveInterestRates,     r.interestRateAdjustment, r.currentFactor);
      addScaled(effective.effectiveInflationRates,    r.inflationAdjustment,    r.currentFactor);
      addScaled(effective.effectiveAppreciationRates, r.appreciationAdjustment, r.currentFactor);
      if (effective.effectiveExchangeRates) {
        addScaled(effective.effectiveExchangeRates,   r.fxAdjustment,           r.currentFactor);
      }
    }

    return this.newState(state, { activeRegimes: live, ...effective });
  }
}

function addScaled(target, source, factor) {
  if (!source) return;
  for (const [k, v] of Object.entries(source)) {
    target[k] = (target[k] ?? 0) + v * factor;
  }
}
```

The reducer is pure; recovery state is implicit in `startDate + durationMonths` plus the current date. There is no "tick counter" to drift. Snapshots remain trivially serializable (plain objects).

---

## 9. Toolset: `ECONOMIC_REGIMES`

A new toolset, following the design 9 / 12 patterns. Ships in `src/scenarios/toolsets/economic-regimes-toolset.js`.

```js
export const ECONOMIC_REGIMES = {
  id: 'ECONOMIC_REGIMES',
  capabilities: ['economic-regimes'],
  dependencies: [],                       // none; this layer sits beneath everything

  types: {
    handlers: [EconomicShockHandler, EconomicRecoveryTickHandler],
    reducers: [
      RegimeApplyReducer,
      AddRegimeReducer, RemoveRegimeReducer,
      RevalueAssetReducer,
    ],
    actions: [
      { type: 'ADD_REGIME_APPLY',      fields: { regime: ValueType.any() } },
      { type: 'REMOVE_REGIME_APPLY',   fields: { regimeId: ValueType.text() } },
      { type: 'REVALUE_ASSET_APPLY',   fields: { rateKey: ValueType.text(), multiplier: ValueType.number(), targetStateKeys: ValueType.any() } },
      { type: 'RECOMPUTE_REGIMES',     fields: {} },
    ],
  },

  paramSchema(context) {
    return [
      { key: 'shocks', label: 'Economic Shocks', type: 'ShockList',
        group: 'Economic Shocks', defaultValue: [], description: '...' },
    ];
  },

  state(context) {
    // Snapshot base rates from sibling toolsets at boot.
    // baseExchangeRates / baseFxFees / effectiveExchangeRates / effectiveFxFees
    // are contributed by US_AU_CROSS_BORDER via FxService (design 23).
    return {
      activeRegimes: [],
      baseGrowthRates:       collectBaseGrowthRates(context),
      baseInterestRates:     collectBaseInterestRates(context),
      baseInflationRates:    { US: context.parameters.inflationRateUs ?? 0.03,
                               AU: context.parameters.inflationRateAu ?? 0.03 },
      baseAppreciationRates: collectBaseAppreciationRates(context),
      effectiveGrowthRates:       { /* mirrors base at boot */ },
      effectiveInterestRates:     { /* mirrors base at boot */ },
      effectiveInflationRates:    { /* mirrors base at boot */ },
      effectiveAppreciationRates: { /* mirrors base at boot */ },
    };
  },

  schedules(context) {
    // Two events per configured shock, both pre-scheduled here:
    //   1. ECONOMIC_SHOCK         — OneOffEvent at shock.startDate.
    //   2. ECONOMIC_RECOVERY_TICK — EventSeries, monthly, from startDate
    //                                to startDate + recovery.durationMonths.
    // No reducer ever pushes onto the event queue; recovery scheduling is
    // entirely declarative, matching the PERIOD_ADVANCE / TAX_SETTLE pattern.
    const events = [];
    for (const shock of (context.parameters.shocks ?? [])) {
      events.push(buildOneOffShockEvent(shock));
      events.push(buildRecoveryTickSeries(shock));
    }
    return events;
  },

  handlers(context) {
    return [new EconomicShockHandler(), new EconomicRecoveryTickHandler()];
  },

  reducers(context) {
    return [
      new RegimeApplyReducer(),
      new AddRegimeReducer(),
      new RemoveRegimeReducer(),
      new RevalueAssetReducer({ accountService: context.accountService,
                                realPropertyService: context.realPropertyService,
                                collectibleService: context.collectibleService }),
    ];
  },
};
```

`IntlRetirementScenario.getToolsets()` adds `'ECONOMIC_REGIMES'` to its list. Existing toolsets are unchanged — handlers within them migrate per §11 but those changes are local edits, not new wiring.

**`collectBaseGrowthRates(context)` / `collectBaseInterestRates(context)` / `collectBaseAppreciationRates(context)`** read the same scenario parameters the earnings/interest/appreciation handlers consume today (`rothGrowthRate`, `iraGrowthRate`, `usSavingsInterestRate`, etc.) and emit the rate-key map. The mapping table lives in §11.

---

## 10. FX — Owned by Design 23

FX rate/fee composition is owned by **`design/23-fx-exchange.md`** (the `FxService` + `FxEngine` extraction). The regime framework reads and writes `state.effectiveExchangeRates.USD_AUD` and `state.effectiveFxFees.USD_AUD` — the field shape comes from FX, the regime stack composes into it.

- The `state.baseExchangeRates` / `effectiveExchangeRates` (and matching `Fx fees`) fields are introduced by design 23.
- Design 23 ships an `FxRefreshReducer` (`PRE_PROCESS (10)`) that mirrors `base → effective` when this regime toolset is *not* loaded.
- When this regime toolset *is* loaded, `RegimeApplyReducer` at `PRE_PROCESS + 1 (11)` overwrites the effective fields with the regime-composed values; `FxRefreshReducer` becomes a no-op on the same tick.
- The legacy `state.exchangeRateUsdToAud` field exists as a getter during design 23's Phase 1 and is deleted in its Phase 2. No shim is required inside `RegimeApplyReducer`.

**Sequencing note**: this design ships behind design 23 Phase 1. Until FX lands, the FX-related state additions in §5.2 (`baseExchangeRates`, `effectiveExchangeRates`, `baseFxFees`, `effectiveFxFees`) and the `fxAdjustment` entry on `EconomicRegime` (§4.2) are inert — they exist on state, but no consumer reads them. As soon as design 23 Phase 1 lands, regime FX adjustments become live without any change here.

---

## 11. Handler Migration

Each rate-bearing handler gains a `static rateKey` and reads `state.effective*Rates[rateKey] ?? this.<rate>`. The migration is **purely local** — one constructor line, one `call()` line each.

| Handler | File | `rateKey` | State field |
|---|---|---|---|
| `IntlRothEarningsHandler` | `src/finance/handlers/earnings-handlers.js` | `EQUITY_US` | `effectiveGrowthRates.EQUITY_US` |
| `IntlIraEarningsHandler` | (same) | `EQUITY_US` | (same) |
| `IntlK401EarningsHandler` | (same) | `EQUITY_US` | (same) |
| `StockEarningsHandler` (US) | (same) | `EQUITY_US` | (same) |
| `StockEarningsHandler` (AU) | (same) | `EQUITY_AU` | `effectiveGrowthRates.EQUITY_AU` |
| Super earnings handler | `src/finance/account-rules/au/au-super-classes.js` | `EQUITY_AU` | (same) |
| `FixedIncomeEarningsHandler` | `src/finance/account-rules/us/us-brokerage-classes.js` | `FIXED_INCOME_US` | `effectiveGrowthRates.FIXED_INCOME_US` |
| `UsSavingsInterestMonthlyHandler` | `src/finance/handlers/us-savings-interest-handler.js` | `SAVINGS_US` | `effectiveInterestRates.SAVINGS_US` |
| AU savings interest handler | (corresponding file) | `SAVINGS_AU` | `effectiveInterestRates.SAVINGS_AU` |
| `RealPropertyService` (appreciation tick) | `src/finance/services/real-property-service.js` | per-property `REAL_ESTATE_US` / `REAL_ESTATE_AU` | `effectiveAppreciationRates.*` |
| Collectible appreciation | corresponding handler | `COLLECTIBLE` | `effectiveAppreciationRates.COLLECTIBLE` |
| `InflationAdjustReducer` | `src/finance/reducers/inflation-adjust-reducer.js` | n/a (uses `cc`) | `effectiveInflationRates[cc]` |

**Template change** (using `IntlRothEarningsHandler` as the example):

```diff
 export class IntlRothEarningsHandler extends HandlerEntry {
   static type      = 'IntlRothEarningsHandler';
   static eventType = 'INTL_ROTH_EARNINGS';
+  static rateKey   = 'EQUITY_US';

   constructor({ stateRegistry, role, ownerId = null, stateKey = null,
-                growthRate = 0.07 } = {}) {
+                growthRate = 0.07, rateKey = null } = {}) {
     super(null, 'Roth IRA Earnings');
     // ...
     this.growthRate = growthRate;
+    this.rateKey    = rateKey ?? new.target.rateKey;
   }

   call({ state }) {
     const stateKey = this._stateKeyFixed ?? this.stateRegistry.getStateKey(this.role, this.ownerId);
     const balance  = state[stateKey]?.balance ?? 0;
-    const amount   = +(balance * this.growthRate).toFixed(2);
+    const rate     = state.effectiveGrowthRates?.[this.rateKey] ?? this.growthRate;
+    const amount   = +(balance * rate).toFixed(2);
     // ...
   }
 }
```

The `?? this.growthRate` fallback means a scenario without `ECONOMIC_REGIMES` in its toolset list behaves **bit-for-bit identically to today**.

---

## 12. Monte Carlo Integration

The rough doc's `volatilityMultiplier` becomes a Monte Carlo distribution on shock severity. `IntlRetirementMcConfig` already supports per-param distributions (`mean`, `sigma`, etc.). New parameters that show up in `paramSchema`:

```js
{
  key: 'shocks[0].severity', type: 'Number',
  defaultValue: 0.40, group: 'Economic Shocks',
  mc: { distribution: 'normal', mean: 0.40, sigma: 0.10 },
  description: 'Magnitude of the equity revaluation shock; consumed by levelEffects.equityRevaluation.multiplier.',
},
{
  key: 'shocks[0].startDate', type: 'Date',
  defaultValue: '2030-01-01', group: 'Economic Shocks',
  mc: { distribution: 'uniform-date', start: '2028-01-01', end: '2035-01-01' },
},
```

Each MC draw rebuilds the scenario with a different `severity` / `startDate` and runs deterministically. Aggregate distributions then surface across runs in `ScenarioRunner.summarize()` — the existing pipeline needs no changes.

---

## 13. UI / Visualization

Three small additions, all dockable workbench plugins or existing-plugin extensions:

1. **Active-regimes banner** on the `dashboard` plugin. Reads `state.activeRegimes` and renders chips: "🇺🇸 Equity Crash 2030 (V, 18mo, 62% recovered)". Pure read; no new bus traffic.
2. **Shock markers on the chart**. The `chart` plugin gains a vertical-line series sourced from `RECORD_METRIC('economic_shock', shockId)` actions emitted by `EconomicShockHandler`. The recording action already exists.
3. **Effective-vs-base rate overlay in the state panel**. The `state-panel` plugin already supports nested-field diffs; registering `effective*` and `base*` paths via `StateSchemaRegistry` is enough to make them render with proper formatting. The diff between `base*` and `effective*` is what shows the regime's impact at a glance.

No new plugins are required. Out-of-scope for this design: a dedicated regime-editor plugin. Shocks are configured via the scenario param editor's `ShockList` field type (a new editor in `src/visualization/components/`).

---

## 14. Testing

EVT-X test files following the existing convention (`tests/unit/evt-*.test.mjs`):

| File | Coverage |
|---|---|
| `evt-economic-shock.test.mjs` | `ECONOMIC_SHOCK` event → handler emits `ADD_REGIME_APPLY` + `REVALUE_ASSET_APPLY` + `SCHEDULE_RECOVERY`. Regime appears on stack; level effect applied to all stock balances; no other state touched. |
| `evt-regime-stack.test.mjs` | Two regimes coexist; `effectiveGrowthRates.EQUITY_US` is the sum of both adjustments. Adding a third regime via `ADD_REGIME_APPLY` mid-year produces correct totals at the next period boundary. |
| `evt-recovery-v.test.mjs` | V-shaped recovery: factor decays linearly to 0; regime drops from stack on schedule. |
| `evt-recovery-u.test.mjs` | U-shaped recovery: factor flat for first half, then linear fade. |
| `evt-recovery-w.test.mjs` | W-shaped recovery: cosine produces the double-dip. |
| `evt-recovery-l.test.mjs` | L-shaped: factor stays at 1 then snaps to 0 at `durationMonths`. |
| `evt-shock-handler-migration.test.mjs` | Every migrated handler still produces today's result when `ECONOMIC_REGIMES` is not in the toolset list (regression test for the fallback). |
| `evt-shock-fx-regime.test.mjs` | With both `ECONOMIC_REGIMES` and `US_AU_CROSS_BORDER` loaded, an FX-bearing regime composes into `state.effectiveExchangeRates.USD_AUD` and a subsequent `FX_TRANSFER` uses the regime-adjusted rate. (Replaces the design-21-draft FX shim test now that design 23 owns FX.) |
| `evt-shock-mc.test.mjs` | `IntlRetirementMcRunner` over a normal-distribution severity draws different per-run outcomes; summarize() returns p10/p50/p90. |

Each test reuses the existing `Assert.datesEqual` helper and follows the journal-assertion patterns in `evt-401k.test.mjs` / `evt-ira.test.mjs`.

---

## 15. Phased Implementation

### Phase 1 — Regime substrate + level effects

Smallest shippable slice; equity-only shocks land here.

1. Add `RATE_KEYS` module and the new `state.activeRegimes` / `base*` / `effective*` fields.
2. Delete `FinancialState`; rewrite `asset-rules.test.mjs`; regen `src/index.js`.
3. Register schema types in `StateSchemaRegistry`.
4. Implement `RegimeApplyReducer`, `AddRegimeReducer`, `RemoveRegimeReducer`, `RevalueAssetReducer`.
5. Implement `EconomicShockHandler` and `EconomicRecoveryTickHandler`.
6. Wire `ECONOMIC_REGIMES` toolset (including the `buildOneOffShockEvent` + `buildRecoveryTickSeries` pre-scheduling helpers in `schedules()`); add to `ToolsetRegistry`; add to `IntlRetirementScenario.getToolsets()`.
7. Migrate the **equity** handlers (Roth/IRA/401k/US Stock/AU Stock/Super earnings).
8. Implement V + L recovery curves only.
9. Tests: `evt-economic-shock`, `evt-regime-stack`, `evt-recovery-v`, `evt-recovery-l`, `evt-shock-handler-migration`.
10. UI: active-regimes banner on `dashboard`; shock markers on `chart`.

**Exit criteria**: a `MARKET_CRASH_2008_LITE`-flavored shock can be added to a scenario, drops the equity balance ~40%, depresses forward equity returns for 18 months, and recovers to baseline along a V curve. Bit-for-bit identical results when the shock is removed.

### Phase 2 — Rate-flow regimes + recovery shapes + FX

Adds interest-rate / inflation / appreciation / FX adjustments and the remaining recovery shapes.

1. Migrate fixed-income, savings-interest, real-estate-appreciation, collectible-appreciation handlers.
2. Migrate `InflationAdjustReducer` to read `effectiveInflationRates`.
3. Add U and W recovery curves.
4. Wire the `fxAdjustment` regime field through `RegimeApplyReducer` (no shim — design 23 owns the effective-rate fields).
5. Tests: `evt-recovery-u`, `evt-recovery-w`, `evt-shock-fx-regime`.
6. Monte Carlo wiring per §12; test `evt-shock-mc`.
7. Shock library presets (`STAGFLATION_1970S_LITE`, `COVID_2020_LITE`).

**Exit criteria**: a stagflation regime simultaneously raises inflation, suppresses returns, and shifts FX; recovery is U-shaped; MC sweeps produce reasonable p10/p50/p90 distributions across severity draws.

---

## 16. Out of Scope / Future Work

These are explicit non-goals for this design but are worth naming so future authors can pick them up against a known baseline:

- **Employment regimes** (`layoffProbability`, `salaryReduction`, `unemploymentDuration`) — requires an employment / job-state model that does not exist today.
- **Credit-market regimes** — requires loan origination, refinancing, and credit-card mechanics that do not exist today.
- **Bond duration sensitivity** — requires extending `FixedIncomeAccount` with a duration / yield-curve model.
- **Correlation regimes** — requires moving from deterministic point returns to a (mean, covariance) model; out of scope while §3 keeps single runs deterministic.
- **Behavioral effects / panic selling** — requires a behavioral handler layer that overrides withdrawal/contribution rules under stress; not modeled today.
- **Dividend-yield cuts under stress** — could be added by giving regimes a `dividendAdjustment: { [rateKey]: number }` map and migrating `DividendScheduledHandler` the same way as the earnings handlers. Skipped for the initial cut to keep equity shocks "price-only" and the design tight.
- **Cost-basis tracking for tax-loss harvesting under shocks** — the rough doc's `Holding { marketValue, costBasis, unrealizedGainLoss }` model. Today cost basis lives on individual stock-withdrawal actions, not as a holding-level state field. Promoting it to first-class is its own design.
- **Per-asset-class allocation inside an account** (`AssetAllocation { equities, bonds, cash, realEstate, alternatives }`). Today every account has a single growth rate; shocks affect the whole balance. Allocation-aware shocks would let one shock affect only the equity slice of a balanced 401k.
- **FX service** (`design/23-fx-exchange.md`) — owns the effective-rate field shape this design composes into; lands as a prerequisite for the Phase 2 FX work.

---

## 17. Summary

The shock-and-regime framework adds three things on top of the existing engine:

1. **A regime stack on state** that materializes effective rates each period.
2. **A single new pre-process reducer** that owns all regime arithmetic.
3. **A toolset and event/handler/action set** that introduces shocks deterministically and recovers along a small set of named curves.

Every existing earnings/interest/inflation/appreciation handler changes by **one constructor line and one `call()` line**. The pre-existing fallback (`?? this.<rate>`) means scenarios without the regime toolset behave identically to today. Single runs remain deterministic; volatility lives in Monte Carlo over shock severity. The one external dependency is FX, owned by `design/23-fx-exchange.md` — `RegimeApplyReducer` composes into the effective-rate fields that design 23 introduces, with no shim required.
