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
| ~~Dividend-yield cuts~~ | **No longer true.** `dividendAdjustment` ships: it multiplies the payout (`-0.22` = pay 22 % less) and `DividendScheduledHandler` reads it via `state.effectiveDividendAdjustments`. Calibrated against S&P 500 dividends per share — see §20 and `docs/economic-shocks/README.md` §2. |

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

---

## 18. Library addendum — `DOTCOM_2000_LITE` and asymmetric level effects

**Status**: Built (2026-08-29). Tests: `tests/unit/evt-shock-dotcom.test.mjs` (5).
**Motivation**: `scenarios/offset-bond-pool/STUDY.md` — a bond/offset reserve study needs a
crash whose defining property is **duration**, not depth.

### 18.1 Why the existing library could not express it

Every equity preset in §4.1's library is a **fast, deep, global** shock: −40 % / −30 % applied
identically to `EQUITY_US` and `EQUITY_AU`, faded over 6–18 months on a V. A two-year bond
bucket survives all of them, because the bucket only has to bridge to the recovery. The
dot-com bust is the opposite shape and is therefore the binding test for a reserve:

| | GFC preset | dot-com |
|---|---|---|
| peak-to-trough | fast (V, 18 mo) | **30 months of grind** |
| US vs AU | same multiplier | S&P −49 %, **ASX −22 %** |
| bonds | untouched | **rallied** (Fed 6.5 % → 1.0 %, 10y 6.5 % → 3.6 %) |
| inflation | none | **mild disinflation** (CPI 3.4 % → 1.6 %) |
| dividends | −40 % | roughly held (damage was in non-payers) |
| back to prior peak | — | **~7.5 years** (Mar 2000 → Oct 2007) |

### 18.2 The one framework change: `equityRevaluation` may be an ARRAY

`levelEffects.equityRevaluation` accepted a single `{ rateKeys, multiplier }`, so a preset
could only say *one crash, everywhere*. It now also accepts an **array** of such entries, each
emitted as its own `REVALUE_ASSET_APPLY`; the reducer path is unchanged. This is what lets a
preset state a **US-led** bust — −35 % on `EQUITY_US` / `EQUITY_INTL_EX_AU`, −32 % on
`EQUITY_INTL_EX_US`, −18 % on `EQUITY_AU` — instead of averaging the asymmetry away.

`applySeverity` (the MC/opt knob) re-scales an array **proportionally**, taking the deepest
market as the headline: `severity: 0.50` deepens the US leg to −50 % and the AU leg to
−0.18 × (0.50/0.35). Setting every entry to −severity would have quietly converted a US-led
bust into a uniform global one at every point of an MC sweep — the asymmetry is the preset.

The object form is untouched and byte-identical (full suite 5,739 pass / 0 fail).

### 18.3 How the 30-month grind is composed

The framework applies a level effect **once**, at `startDate`; a slow decline therefore has to
be *level break + sustained forward-return drag*, with the drag's persistence carried by the
recovery profile. `U / 36 months` holds the drag at full strength for 18 months, then fades it
linearly — flat-then-fade being exactly the shape a bucket has to outlast.

Measured (`scenarios/offset-bond-pool/probe-dotcom-path.mjs`, 7 % base return, no spending):

| month | 3 | 12 | **24–33** | 48 | 72 |
|---|---|---|---|---|---|
| US equity vs t0 | −35 % | −43.5 % | **−47.7 %** (trough) | −35.9 % | −26.6 % |
| GFC preset, same axis | −40 % | −36.5 % | −32.1 % | −22.2 % | −10.9 % |

−47.7 % at month 30 against a real −49 % at month 30. The recovery is a *fade back to
baseline growth*, never a rebound overshoot — which matches the actual 2003–2007 grind back
and is all the framework can express (§7: curves scale a regime toward zero, they cannot
add a positive adjustment).

### 18.4 The rates side, and one convention worth stating

- **Bonds gain.** `returnAdjustment` + `interestRateAdjustment` both move
  `FIXED_INCOME_US −2.0pp / FIXED_INCOME_AU −1.2pp`: the level falls, `BondPriceAdjustReducer`
  marks duration up. Layered on top is a **bull-steepener `yieldCurveTwist`**, stated
  *relative to that level move* because the 5-year point is the curve's anchor (spread 0):
  short −1.5pp further, long +0.8/+1.3pp back. Total effect: 1y ≈ −3.5pp, 30y ≈ −0.7pp.
- **The policy cut lands on `PRIME_*` only, never on `SAVINGS_*`.** `PrimeRelinkReducer`
  *adds* the Prime delta onto each linked account's `SAVINGS_*::<stateKey>` key (design 56 §5),
  so moving both keys would cut a Prime-linked account twice. An account authored with a fixed
  savings rate opted out of the policy link and correctly does not move. **This is a library
  convention, not a dot-com detail** — any future preset that cuts or hikes policy rates should
  do the same.
- Because Prime also prices variable loans, the cut lowers the mortgage rate — so in this
  preset an offset account's implicit yield *falls* at the same time the bond sleeve *gains*.
  That divergence is the whole reason the preset belongs in the bond/offset study.

### 18.5 Known gap, deliberately not closed here

`MARKET_CRASH_2008_LITE`, `COVID_2020_LITE` and `MILD_CORRECTION` name only `EQUITY_US` /
`EQUITY_AU` and so **miss the two international sleeves entirely** (`EQUITY_INTL_EX_US`,
`EQUITY_INTL_EX_AU`, added by design 90 §7.2). A household holding an international sleeve
takes no level hit from those presets. Fixing it moves goldens and is out of scope for this
addendum; `DOTCOM_2000_LITE` names all four.

---

## 19. Multi-leg shocks — `shock.legs` (design 21 §18.6)

**Status**: Built (2026-08-29). Test: `evt-shock-dotcom.test.mjs` DOTCOM-6.

### 19.1 The defect

§7 gives a regime ONE recovery curve, so every part of a shock decays at the same speed. Real
episodes do not. In the dot-com bust the equity leg ground down for ~30 months while the
monetary easing that answered it ran for years — the funds rate was at 1 % into 2004 and the
10-year had still not recovered by 2006.

Sharing a 36-month curve made the rate cut **round-trip by construction**:
`FIXED_INCOME_US` ran 4.00 → 2.00 (2027) → 2.56 → 3.89 → 4.00 (2030). The bond sleeve was
marked up at the shock and handed the whole gain back in year two — the framework deleting, as
a modelling convention, exactly the protection the episode is famous for.

### 19.2 The change

A shock may declare `legs`, each with its own `regime` and `recovery`:

```js
DOTCOM_2000_LITE: {
  levelEffects: { … },                 // still shock-level: a level effect is instantaneous
  legs: [
    { id: 'equity', regime: { returnAdjustment: {EQUITY_*}, dividendAdjustment, fx… },
      recovery: { profile: 'U', durationMonths: 36 } },
    { id: 'rates',  regime: { interestRateAdjustment: {PRIME_*, FIXED_INCOME_*}, yieldCurveTwist… },
      recovery: { profile: 'U', durationMonths: 84 } },
  ],
  recovery: { profile: 'U', durationMonths: 36 },   // what a single-leg reader sees
}
```

`EconomicShockHandler` emits one `ADD_REGIME_APPLY` per leg, id'd `regime-<shockId>-<legId>`.
**Nothing downstream changed**: `state.activeRegimes` is already a stack whose per-rate-key
adjustments sum (§4.3), so two legs at different recovery factors compose exactly as two
unrelated shocks would. This is the framework's own composition mechanism rather than a second
one beside it — the alternative, per-adjustment-family recovery curves inside one regime, would
have duplicated the stack's arithmetic in `RegimeApplyReducer`.

Two details that matter:

- **Leg ids must be distinct.** `RegimeApplyReducer` keys the live stack by `id`; two legs
  sharing one would collapse into a single regime carrying whichever adjustments landed last.
- **Recovery ticks span the LONGEST leg** (`scheduleShock`). Ticks stopping at the equity leg's
  horizon would leave the slow leg's factor recomputed only at period boundaries — it would
  still decay, in yearly steps, which is the resolution the tick series exists to avoid.

Absent `legs`, a shock is its own single leg and the behaviour is byte-identical (full suite
5,753 pass / 0 fail).

### 19.3 What it changed, and the direction is the interesting part

Re-running the dot-com column: **almost nothing, and slightly AGAINST bonds** at the reference
plan's 3-rung ladder (a 6-year bond reserve went from −19.8 % to −22.1 % vs equity-only).

That is not a bug, it is the mechanism finally being modelled. A sustained easing does two
opposing things to a bond holder:

| | effect | scales with |
|---|---|---|
| price marked up | **one-off** gain | DURATION |
| coupons reinvested lower, for years | **compounding** loss | how fast the ladder ROLLS |

A 3-rung, 1-year ladder is the structure that captures the least of the first and the most of
the second — it rolls its whole book at 2 % for seven years. Making the easing persist made
short bonds correctly worse, which is what happened to real short-duration holders in 2003.

Lengthening the ladder inverts it. Cost of a 6-year bond reserve in the dot-com column:

| ladder | before the fix | **after** |
|---|---|---|
| 3 rungs × 1y (the plan) | −19.8 % | **−22.1 %** |
| 5 rungs × 1y | −15.3 % | −13.8 % |
| 10 rungs × 1y | −10.9 % | −7.9 % |
| **10 rungs × 2y** | −9.0 % | **−2.4 %** |
| 15 rungs × 2y | −11.4 % | −2.1 % |

And it moves the boundary of §9.5's crossover a long way: with a 10 × 2y ladder the reserve
beats equity-only at **9 % equity in an early crash and 8 % at any crash date**, against ~6.5 %
for the 3-rung ladder. The fix did not make bonds better; it made **duration** matter, which is
what the episode was always about.

---

## 20. Calibration provenance — `docs/economic-shocks/`

**Status**: Built (2026-08-29).

Sections 1–19 above specify the *mechanism*. They do not say where a number like
`−40 %`, `18 months` or `PRIME_US: -0.045` came from, and until now nothing did — the
library's figures were asserted in JSDoc and could not be checked without re-deriving them
by hand. That is the same failure mode design 94 §8.1 closed for tax law
(*never quote a rule that is not on disk*), applied to empirical calibration.

`docs/economic-shocks/` closes it the same way:

| file | what |
|---|---|
| `README.md` | **The user-facing document.** What each preset does to a scenario, the units and consumer of every regime field, why each recovery profile was chosen, and a preset-by-preset justification of shape / behaviour / duration citing the measurements. Written to be liftable into a UI help panel. |
| `SOURCES.md` | Provenance for every series — the route, the gotchas, and what each one calibrates. Follows `docs/us-tax/SOURCES.md`. |
| `MEASUREMENTS.md` | Generated. Drawdown depths and durations, dividend cuts, CPI paths, policy-rate moves, per-tenor curve twists, FX drift and realized FX volatility, real-estate drawdowns. |
| `fetch-sources.sh` | Re-fetches everything into `data/` (FRED, RBA, NBER, Shiller). All scripted. |
| `scripts/probes/measure-shock-history.mjs` | Reduces `data/` to `MEASUREMENTS.md`. `--write` to regenerate. |

Three things the exercise turned up that are worth stating here rather than only there.

### 20.1 The presets are not uniformly conservative

`README.md` §5 lists every place the library and the record disagree. The pattern is not a
consistent bias, which is why it matters: the GFC preset's **level effect is ~10 points too
shallow** (−40 % against a measured −50.8 % on the S&P and −53.3 % on the broad index)
while its **dividend cut is roughly twice too deep** (−40 % against a measured −22.3 % fall
in S&P dividends per share). The COVID preset's dividend cut is −30 % against a measured
−2.3 %. A study that leans on distribution income is therefore being told a much harsher
story than a study that leans on the book value, from the same preset.

`STAGFLATION_1970S_LITE` carries **no level effect at all**, while the S&P fell 43.4 %
nominal and 59.6 % real across 1973–74. That is defensible as a division of labour —
compose it with a crash preset — but it is not obvious from the preset's name, and a run of
it alone understates the decade badly.

### 20.2 Two calibration claims rest on series that cannot support them

- **The 1970s FX leg.** `STAGFLATION_1970S_LITE` sets `USD_AUD: -0.10` for "broad USD
  weakness". The AUD **floated on 12 December 1983**; every pre-1984 USD/AUD observation is
  an administered rate. The claim is real but it is *trade-weighted* — the major-currencies
  dollar index fell 10.7 % over 1973–1980 — so the sign is supported and the magnitude is
  an assertion. `SOURCES.md` records this so the next person does not "verify" it against
  `DEXUSAL` and conclude the sign is backwards.
- **`fxVolAdjustment` in general.** It only bites when `fxProcessModel ≠ NONE`. Measured
  realized USD/AUD volatility went to ×2.87 of baseline in the GFC and ×1.57 in COVID; the
  presets say ×1.5 and ×2.0 respectively — i.e. the two are ranked the wrong way round.

### 20.3 The framework cannot express a rebound, and that is directional

§7's curves scale a regime toward zero; they cannot add a positive adjustment. So every
preset's aftermath is "baseline growth resumes", where the historical record repeatedly
delivered a violent snap-back (COVID regained its prior peak in four months on the Nasdaq).
Combined with §20.1, this means shock results in this framework are **conservative about
the recovery and unreliable about the depth**, in that order. A study comparing two
strategies through a shock is on much firmer ground than one quoting an absolute outcome.

---

## 21. What `durationMonths` means, and how a preset is calibrated

**Status**: Built (2026-08-30). Probe: `scripts/probes/shock-path-engine.mjs`.
Output: `docs/economic-shocks/CALIBRATION.md`.

The recurring question about this framework is what `durationMonths` is *for*: is it
peak→trough, or peak→trough→back-to-peak? It is neither, and the confusion was doing real
damage to the library, so this section fixes the semantics.

### 21.1 The three quantities, and which of them is settable

`durationMonths` is **the life of the depressed-return regime** — how long the adjustments
stay on the stack before the recovery curve retires them. The two quantities a reader
actually cares about are both *emergent*:

| quantity | what determines it | settable? |
|---|---|---|
| **peak → trough** | where `base + drag × recoveryFactor(t)` crosses zero | indirectly, via (level, drag, profile, duration) |
| **trough depth** | the level break compounded with the drag up to that crossing | indirectly, same four |
| **trough → back to peak** | whatever compounding does afterwards | **no** — see §22 |

So a preset cannot *declare* a −50 % drawdown. It declares four things that compose to
one, and the composition has to be measured. That is what the probe is for.

### 21.2 The resolution limit nobody had written down

**Equity growth is applied once a year.** `INTL_STOCK_EARNINGS` / `INTL_ROTH_EARNINGS` and
their siblings are `interval: 'year-end'` EventSeries, and `computeHoldingsGrowth` applies
`balance × rate × factor` with `factor = 1`. `ECONOMIC_RECOVERY_TICK` recomputes the
recovery factor every month, but **for equity that factor is only ever SAMPLED on
31 December**.

Three consequences, none of them obvious from §7:

1. **A decline is only expressible in whole years.** A 17-month slide becomes "two
   year-ends". The GFC preset bottoms at 24 months against a measured 17 and cannot do
   better.
2. **Most of a short curve is invisible to equity.** A `V/18` regime is sampled exactly
   once, at `f(11.5) = 0.36`. Its remaining 17 months of area never touch an equity
   balance. This is why the old presets' drags were decorative.
3. **Interest and dividends are NOT affected the same way** — savings and fixed-income
   handlers pass `factor: 1/12` and so do see the monthly curve. A single preset therefore
   has one time resolution for equity and another for cash. Worth remembering before
   reading a bond-vs-equity result too closely.

### 21.3 The finding that forced the recalibration

Running every shipped preset through the engine (`shock-path-engine.mjs`), **five of six
had their trough at month 1**: the level effect was the entire drawdown and the
`returnAdjustment` contributed nothing to it. `DOTCOM_2000_LITE` was the only preset that
composed a path at all, and only because §18.3 had tuned it by hand.

That is the wrong shape, and wrongest for exactly the study this framework gets used for.
A cash or bond reserve exists to avoid selling into a decline. If the decline is
instantaneous there is nothing to bridge, and the reserve is being asked to prove itself
against a world where its whole purpose has been deleted.

### 21.4 The rule the library now follows

Measured from the source data (`MEASUREMENTS.md`), the fraction of each episode's fall that
happened in its first three months:

| episode | fall in 3 months | shape |
|---|---|---|
| GFC | **8 %** | a grind |
| dot-com | **17 %** | a grind |
| stagflation 1973-74 | **16 %** | a grind |
| COVID | **82 %** | a break |
| 2018 correction | **100 %** | a break |

So: **the level effect is the front-loaded part of the fall; the drag carries the rest.**
Fast episodes are level breaks whose drag exists only to set the recovery speed. Slow ones
are mostly drag, and their level break is small. That is why the numbers in the library now
look so different from one preset to the next — the shapes really are different.

Calibration targets, in order: **(trough depth, trough year)** first, since both are
settable and both bear directly on a spending plan; then **back-to-peak** and the ten-year
cumulative as checks. `CALIBRATION.md` prints all four against the measured episode on every
regeneration.

### 21.5 `severity` had to change with it

`applySeverity` used to overwrite the level multiplier with `−severity`, which was fine
while the level *was* the drawdown. Now that the trough is composed, it scales **the level
and every leg's `returnAdjustment` together**, by the ratio of the requested severity to the
preset's own headline depth. Scaling only the level would have swept a preset toward its old
instant-break shape at one end of an MC range and away from it at the other — a change of
*shape* disguised as a change of magnitude. Each preset's `severity` is now its measured
trough depth, so the knob stays readable.

---

## 22. Recovery that can overshoot — `V_REBOUND` / `U_REBOUND`

**Status**: Built (2026-08-30). Tests: `tests/unit/evt-recovery-rebound.test.mjs` (6).

### 22.1 The gap

§7's curves scale a regime's adjustments toward zero. They cannot go past it, so the best
outcome a shock can produce is *baseline growth resumes*. History does not work that way:
the S&P regained its 2007 peak in **65 months**, and compounding a −50.8 % hole at 7 % needs
about **140**. The same gap appears everywhere — COVID round-tripped in 7 months against a
model floor of 12, the dot-com bust in 81 against 133.

The consequence was not a rounding error, it was a **structural conflict in the calibration**:
a preset could match the measured trough or the measured recovery, never both. A shape search
over every (profile, duration) candidate with (level, drag) solved to hit the trough exactly
found the best back-to-peak error was still **75 months** for the GFC and 34–47 for COVID.
No shape could express the episode.

### 22.2 The change

The framework already tolerated the fix. `RegimeApplyReducer` keeps a regime while
`factor <= 0 && now >= endDate` is false, and nothing anywhere clamps the factor or the
resulting effective rate. A curve returning a **negative** factor multiplies a negative
`returnAdjustment` into a **positive** one — an above-baseline tailwind — and everything
downstream already handles it.

So two profiles were added, and nothing else:

```js
V_REBOUND: 1 → 0 over `reboundStart` of the window, then a half-sine to −`reboundPeak` and back to 0
U_REBOUND: flat, then fade, then the same excursion
```

`reboundStart` (default 0.5) is the fraction of `durationMonths` at which the drag is spent;
`reboundPeak` (default 0.5) is how far below zero the factor swings, as a fraction of the
original adjustment — 0.5 against a −20 pp drag is a +10 pp tailwind at its peak. Both are
read off the regime, so a preset tunes the shape per leg rather than needing a new profile
per episode. `RegimeApplyReducer` now passes the regime as a third argument to the curve;
V/U/W/L ignore it and are byte-identical.

### 22.3 What it bought

| preset | back to peak, before | after | measured |
|---|---|---|---|
| `MARKET_CRASH_2008_LITE` | 96 mo | **72 mo** | 65 mo |
| `COVID_2020_LITE` | 72 mo | **24 mo** | 7 mo |
| `MILD_CORRECTION` | 36 mo | **12 mo** | 7 mo |
| `DOTCOM_2000_LITE` | 144 mo | **84 mo** | 81 mo |

The residual on the two fast presets is the annual-sampling floor from §21.2, not the curve.

**One interaction to know about.** `fxVolAdjustment` composes multiplicatively
(`baseVol × (1 + adj × factor)`), so a negative factor pushes volatility *below* baseline.
That is arguably right — markets do calm after a crisis — but it is a side effect, not a
decision. Every shipped preset keeps its FX and dividend adjustments on a separate non-rebound
leg for this reason.

---

## 23. What this framework still cannot express

The user-facing version of this list is `docs/economic-shocks/README.md` §5. This is the
engineering one: each item says what would have to change.

### 23.1 Hard limits — a preset simply cannot say it

| gap | what it costs | what it would take |
|---|---|---|
| **A leg cannot start late.** Every leg begins at the shock date. | COVID's real inflation arrived ~18 months after the crash. The preset models the disinflation that came *with* the crash and leaves the inflation to a second shock you schedule yourself. | A `startOffsetMonths` on a leg, applied in `scheduleShock` when computing `startDate` and the tick span. Small, contained, and the highest-value item here. |
| **A shock cannot ramp up.** The factor starts at 1 and only decays. | The 1970s built to a peak over ~24 months and had a second wave at ~87. The preset flattens both into one sustained level (the L profile at the decade's *average* excess). | A profile whose factor rises before it falls — or better, `W` used properly with a phase offset. |
| **Equity resolution is one year** (§21.2). | A 17-month slide can only bottom at 12 or 24 months. Fast recoveries have a 12-month floor. | Move equity earnings to a monthly or quarterly series. Large blast radius: it changes every scenario's compounding, not just shocked ones. |
| **No equity volatility.** A return is a rate the shock shifts, not a distribution whose *shape* it changes. | VIX averaged 40 through the GFC against 13.7 in 2004-06; none of that is expressible. Design 74's stochastic path is a separate axis and shocks do not modulate its variance. | A `returnVolAdjustment` alongside `fxVolAdjustment`, consumed by design 74's draw. |
| **No correlation regime.** Sleeves move by one draw × beta. | "Everything correlates to 1 in a crash" cannot be modelled; nor can the dot-com case where bonds rallied *because* equity fell. Presets fake it by moving both keys by hand. | A correlation matrix in the return model. Explicitly out of scope since §3. |
| **Rebound shape is per LEG, not per market.** | `DOTCOM_2000_LITE` needs a separate `equity-au` leg purely because the ASX recovered on a different clock. Workable, but it does not scale past a handful of markets. | Per-rate-key recovery specs inside one regime — which §19.2 deliberately rejected, because it would duplicate the stack's arithmetic in `RegimeApplyReducer`. |

### 23.2 Soft limits — expressible, but nothing on disk supports the number

- **AU dividend cuts.** There is no free scripted AU dividend series (the RBA path that
  would carry it 404s — see `SOURCES.md`). Every AU `dividendAdjustment` in the library is
  the US figure, flagged in place. The COVID case is the one where this is likely to be
  materially wrong in a known direction: APRA's 2020 capital guidance cut bank payouts hard,
  and banks are a much larger share of the ASX than of the S&P.
- **Pre-1984 USD/AUD.** The AUD floated on 12 December 1983, so the 1970s FX leg cannot be
  calibrated against `DEXUSAL` at all. It rests on the trade-weighted dollar (−10.7 % over
  1973-80) — right sign, asserted magnitude.
- **Intra-month troughs.** Depths are calibrated to monthly averages, because the model has
  no finer resolution. COVID's daily peak-to-trough was −33.9 % against the −19.1 % monthly
  figure the preset uses. Reach for `severity` if the harsher case is the point.

### 23.3 Not a limit, but the thing most likely to mislead

Every preset is now calibrated to a **single historical episode**, and says so. That makes
the numbers checkable, and it also makes them specific in a way a forecast is not. Two
presets composed together do not produce "a worse crash" so much as an arithmetic sum of two
particular decades. The framework's honest use is **comparing strategies across a shared set
of shock arms**, not quoting an absolute outcome from any one of them.
