# 34 — US State Income Tax (Residency-Based, Pluggable by Year)

**Status**: Phases 1–2 implemented — design written 2026-06-19, Phases 1–2 landed 2026-06-19. Coverage fix landed (state classification now includes US/AU savings + AU fixed-income interest; reconciliation guard `EVT-STATE-4`). §13 tax-settle ordering fix landed (event-level `order` band; federal+state settles now see identical income — federal vs. state gross income reconcile exactly). NE/HI/SD engine + classification + settle + `US_STATE_TAX` toolset + `Person.residencyState` are live and tested (`state-tax-rates.test.mjs`, `evt-state-tax.test.mjs`). Implementation note: classification is realized as a single shared routing table (`state-income-classification.js`) rather than a per-state `StateTaxEngine` — US state taxable income conforms to the federal income events, so only the per-state-per-year *rates* modules vary; this keeps the same "pluggable by year" property with far less code (§3 alternative, adopted). Phases 2–3 (reporting, state move + MC/opt) remain open.
**Phase dependencies**: `US_TAX` toolset + the federal tax engine (`design/11-taxservice-declarative-refactor.md`, `design/19-type-registry.md`) — **hard dependency, ✅ complete**. The state layer is a *parallel* of the federal engine and reuses its period model (`YEAR_US`), its settle scheduling, and the income events it already classifies.
**Related**: `design/20-decouple-residency-from-citizenship.md` (residency is already first-class and per-person; this adds a US *sub-jurisdiction* to it), `design/0-period-engine.md` (state tax year = US calendar year), `design/16-journal-reporting-plugin.md` (a "State Tax by Year" report is the Phase 2 surface).

---

## 1. Purpose

The model computes **US federal** and **AU** income tax but ignores **US state** income tax entirely. For a retiree the choice of residency state is one of the largest controllable levers on lifetime tax: the spread between a high-tax state (Hawaii, top rate 11%) and a no-tax state (South Dakota, 0%) on a six-figure retirement income is tens of thousands of dollars per year, compounding over a multi-decade horizon. A cross-border plan that already models a US→AU move should also be able to answer "what if we establish residency in SD before drawing down the IRA?"

This design adds **US state income tax, driven by residency state**, built as a **parallel of the federal tax engine** so that:

- new **tax years** drop in as new per-state modules (the explicit ask — "pluggable like the tax engine so new years can be added"), and
- new **states** drop in as new per-state module families, registered once.

Initial states: **Nebraska (NE)**, **Hawaii (HI)**, **South Dakota (SD)**. SD has no individual income tax and is modeled as an **empty module** — which is the load-bearing test that the abstraction handles a zero-tax jurisdiction without special-casing.

**Simplifying assumption (per request):** both people share the same residency state. The field lives on `Person` (`Person.residencyState`, §4) for parity with the country `residency`, but the household's active state is **derived from the primary person**, so the spouse's value is not consulted in Phase 1. §9 reserves the per-person generalization and the move machinery.

---

## 2. Today

Grounded against the live code (2026-06-19):

- **Federal/AU tax is a two-engine, year-keyed design.**
  - **Classification** — `TaxEngine` (`src/finance/tax/tax-engine.js`) is a registry of `BaseTaxModule` keyed `${countryCode}_${year}`, with highest-year-≤ lookup. `TaxEngine.registerDynamic()` registers one `PRIORITY.TAX_CALC` reducer per action type that reads `state.currentPeriods[cc]` at runtime to pick the year's module. Each `BaseTaxModule.getReducerFns()` returns `Map<actionType, (state, action, date) => state>` that fold income events into **YTD accumulators** (`usOrdinaryIncomeYTD`, `usCapitalGainsYTD`, `usPenaltyYTD`, `ftcYTD`, …). See `us-tax-module-2026.js`.
  - **Rates** — `TaxSettleService` (`src/finance/tax-settle-service.js`) holds `BaseTaxRatesModule` instances keyed `${cc}_${year}`, resolves the year from `state.currentPeriods[cc]`, and `computeTax(state)` turns the YTD accumulators into a structured liability (`UsTaxRatesBase.computeTax`, `us-tax-rates-base.js`).
- **Settlement is a handler → apply → debit chain** (`tax-settle-classes.js`):
  - `UsTaxSettleHandler` fires on the annual `TAX_SETTLE_US` event (Dec 31), calls `TaxSettleService.computeUsTax(state)`, emits `US_TAX_SETTLE_APPLY`.
  - `UsTaxSettleApplyReducer` resets the US `YTD_FIELDS` and, when `tax > 0`, chains `US_TAX_PAYMENT_DEBIT`.
  - `UsTaxPaymentDebitReducer` debits `ACCOUNT_ROLES.US_SAVINGS`, replenishing from investment accounts when short.
- **Wiring is declarative.** `TaxService.getContributions(['US'], periodService, …)` (`tax-service.js`) returns `{ statePatches, events, handlers, reducers }` — period-advance series, settle series, and the dynamic per-action reducers. The `US_TAX` toolset (`src/scenarios/toolsets/us-tax-toolset.js`) is a thin shell that calls it, seeds the YTD state fields, and exposes the `usFilingSingle` param. Periods are built with `buildUsCalendarYear(y)` for every year in the sim.
- **Residency is first-class and mutable.** `Person.residency` is a country code (`'US'`/`'AU'`); `ChangeResidencyApplyReducer` flips every person to `'AU'` on the move (`change-residency-apply-reducer.js`). Income `*_TAX` actions already carry a `residency` field that the federal module branches on. **There is no notion of a US state anywhere in the model today.**
- **No state field exists on `Person` or in `state`.** Adding one is part of this design.

The federal design is the template. State tax is the same shape with three differences: (a) the jurisdiction key is a **state code** resolved from **residency**, not a fixed country; (b) the tax year is the **US calendar year** (`YEAR_US`) — states piggyback on the federal period; (c) state taxable income is **derived from the same income events** the federal engine already sees.

---

## 3. Design overview

A **parallel state-tax engine** mirroring the federal one, living under `src/finance/tax/state/`:

```
              primaryResidencyState(state) ('NE' | 'HI' | 'SD' | null)
                                     │  + currentPeriods.US (→ tax year)
                                     ▼
  income *_TAX actions ──► StateTaxEngine.registerDynamic ──► state*YTD accumulators
   (wages, IRA, cap gains,        (per (stateCode, year),         (stateOrdinaryIncomeYTD,
    SS, dividends, …)              dispatched at runtime)          statePensionIncomeYTD,
                                                                   stateSsIncomeYTD,
                                                                   stateCapitalGainsYTD)
                                     │
              TAX_SETTLE_STATE (Dec 31)
                                     ▼
   StateTaxSettleHandler ─► StateTaxSettleService.computeStateTax(state)
                                     │   (resolve BaseStateTaxRatesModule by
                                     │    residencyState + year)
                                     ▼
   STATE_TAX_SETTLE_APPLY ─► reset state*YTD ─► STATE_TAX_PAYMENT_DEBIT ─► debit US_SAVINGS
```

Why parallel-with-its-own-accumulators rather than "derive from the federal `us*YTD` at settle":

- **Separation.** State-specific quirks (Nebraska's Social-Security phase-out, Hawaii's pension exclusion and alternative capital-gains rate) live entirely in state modules. The federal modules never learn about states.
- **No settle-ordering coupling.** Both `TAX_SETTLE_US` and `TAX_SETTLE_STATE` fire Dec 31. Because the state layer keeps **its own** `state*YTD` accumulators, the order in which the two settlements reset their fields is irrelevant — there is no "read federal totals before federal resets them" hazard.
- **Consistency.** It is the exact two-engine shape (`Engine` for classification + `SettleService` for rates) the codebase already proves out, so it round-trips through the type registry, journal, and toolset compiler the same way.

The cost is a `BaseStateTaxModule` default classification (most state income *conforms* to federal). §6 keeps per-state code minimal by giving the base a "conforms to federal AGI" default; states override only what differs. (§10 records the rejected alternative.)

---

## 4. Residency state on `Person`, accumulators on `state`

**Residency state is a per-person field, with the active household state derived from the primary person at runtime.**

`Person` gains a `residencyState` field (`'NE'|'HI'|'SD'|null`) — a US *sub-jurisdiction* of the existing `residency` country (`design/20`). Putting it on `Person` (not a single household `state.residencyState`) is the load-bearing provision in this revision:

- it parallels how `residency` (country) already lives on `Person`, so the move machinery (§9) mutates the same record;
- it leaves the door open to per-person divergence (Phase 3) with **no data-model rework** — only the resolution helper changes.

Per §1 we assume both people share one state, so the household's active state is **derived from the primary person**:

```js
// finance/residency-utils.js — sibling of the existing getResidency()
export function primaryResidencyState(state) {
  const people = state.people ?? {};
  const primaryKey = Object.keys(people)[0];   // primary = first person (same convention as _primaryResidency)
  return people[primaryKey]?.residencyState ?? null;
}
```

The spouse's `residencyState` exists but is **not consulted** in Phase 1; config/UI defaults it to the primary's. (Phase 3 would switch the engine to per-person resolution.)

The household-level accumulators stay on `state` (both people share a state, so a single set of YTD buckets is correct):

| Field (on `state`) | Type | Meaning |
|---|---|---|
| `stateOrdinaryIncomeYTD` | currency (USD) | Wages, SE, bonus, interest, dividends — state ordinary income. |
| `statePensionIncomeYTD` | currency (USD) | IRA/401k/Roth-taxable distributions, RMDs, conversions — segregated so states with **retirement-income exclusions** (HI) can carve it out. |
| `stateSsIncomeYTD` | currency (USD) | **Gross** Social Security (not the 85% federal-taxable slice) — segregated so states that **exempt SS** (NE 2025+, HI) can exclude it cleanly. |
| `stateCapitalGainsYTD` | currency (USD) | Realized capital gains — segregated so states with a **preferential CG rate** (HI 7.25% alternative) can treat it separately; states that tax CG as ordinary (NE) just fold it in. |

All `state*YTD` fields reset to 0 in `STATE_TAX_SETTLE_APPLY`. `Person.residencyState` persists across settlements and round-trips via `Person.toJSON`/`fromJSON`.

`Person.residencyState` is set from config like any person field: a typed scenario parameter with a **node cascade** onto the primary person (mirrors how `birthDate`/`retirementDate` cascade in `design/13`/`design/32`): `{ key: 'residencyState', type: 'Enum', options: ['NE','HI','SD'], group: 'US Tax', node: { type: 'person', id: '<primary>', field: 'residencyState' } }`, with the spouse defaulted to the same value at build time. Register `Person.residencyState` (text) and the `state*YTD` fields (currency) in `StateSchemaRegistry`.

**Residency-country interaction.** The state classification reducers and the settle handler **gate on US residency**: an income action only contributes to `state*YTD` when its `residency === 'US'`, and `StateTaxSettleHandler` returns zero when the **primary** person's residency country is not `'US'`. So after the US→AU move, `Person.residencyState` lies dormant (no accumulation, zero settle) and re-activates if they move back — `ChangeResidencyApplyReducer` need not touch it.

---

## 5. The engine + settle services

### `StateTaxEngine` (`src/finance/tax/state/state-tax-engine.js`)

Mirror of `TaxEngine`, keyed `${stateCode}_${year}`, highest-year-≤ lookup. `registerDynamic(pipeline)` differs from the federal version in its resolution: each per-action reducer reads the active state from the **primary person** (which state) **and** `state.currentPeriods.US` (which year):

```js
const stateCode = primaryResidencyState(state);   // §4 helper — primary person's residencyState
if (!stateCode) return state;                     // no state configured
const taxYear = new Date(state.currentPeriods.US.startMs).getUTCFullYear();
const module  = engine.get(stateCode, taxYear);
const fn      = module.getReducerFns().get(action.type);
return fn ? fn(state, action, date) : state;
```

Because the state code is resolved **at runtime on every action** (not frozen at boot), a mid-sim `CHANGE_STATE_RESIDENCY` that mutates `Person.residencyState` (§9) takes effect immediately for all subsequent accrual — exactly like the country residency gate — with no engine changes.

Registered at `PRIORITY.TAX_CALC` alongside the federal dynamic reducers. SD's module contributes an empty `getReducerFns()` map, so for an SD household these reducers are no-ops and nothing accumulates.

### `BaseStateTaxModule` (`base-state-tax-module.js`)

Abstract: `get stateCode()`, `get year()`, `getReducerFns()`. Provides a **default "conforms to federal" classification** that routes the existing income `*_TAX` actions into the four `state*YTD` buckets (guarded by `residency === 'US'`):

| Action type(s) | Default state bucket |
|---|---|
| `WAGES_INCOME_TAX`, `SE_INCOME_US_TAX`, `BONUS_TAX`, `STOCK_DIVIDEND_TAX`, `FIXED_INCOME_EARNINGS_TAX` | `stateOrdinaryIncomeYTD` |
| `IRA_WITHDRAWAL_*_TAX`, `K401_WITHDRAWAL_TAX`, `K401_RMD_TAX`, `IRA_RMD_TAX`, `IRA_ROLLOVER_WITHDRAWAL_TAX`, `ROTH_CONVERSION_TAX` | `statePensionIncomeYTD` |
| `SS_INCOME_TAX` | `stateSsIncomeYTD` (gross `amount`) |
| `STOCK_WITHDRAWAL_TAX`, `US_HOUSE_SALE_TAX`, `COMPANY_SALE_TAX`, `COLLECTIBLE_SALE_TAX` | `stateCapitalGainsYTD` (`gain`) |

A per-state-per-year module subclasses this and overrides only the entries that differ (e.g., a year where NE still partially taxes SS would override `SS_INCOME_TAX`). SD subclasses and returns an empty map (or sets `hasIncomeTax = false`).

### `BaseStateTaxRatesModule` + `StateTaxSettleService`

`BaseStateTaxRatesModule.computeTax(state)` (mirror of `UsTaxRatesBase`) turns the `state*YTD` accumulators into a structured liability using the state's brackets, deductions, and treatment flags. `StateTaxSettleService` (mirror of `TaxSettleService`) holds the rates modules keyed `${stateCode}_${year}` and `computeStateTax(state)` resolves the module from `primaryResidencyState(state)` + `currentPeriods.US` year (highest-year-≤). Returns `{ netLiability: 0, … }` when no state is configured or the primary is abroad.

The result shape matches the federal `TaxComputationResult` (`lineItems`, `taxableIncome`, `netLiability`, `effectiveRate`, `marginalRate`, `taxYear`) so the journal-report and the (Phase 2) state tax document reuse the existing rendering.

### Settle classes (`state-tax-settle-classes.js`)

Direct analogs of `tax-settle-classes.js`:

- `StateTaxSettleHandler` — fires on `TAX_SETTLE_STATE` (Dec 31), calls `StateTaxSettleService.computeStateTax(state)`, emits `STATE_TAX_SETTLE_APPLY { tax, taxDetail }` + `RECORD_BALANCE`. Returns zero (emits no debit) when not US-resident or `residencyState` is null/SD.
- `StateTaxSettleApplyReducer` — resets the `state*YTD` fields; chains `STATE_TAX_PAYMENT_DEBIT` when `tax > 0`. (`PRIORITY.TAX_APPLY`.)
- `StateTaxPaymentDebitReducer` — debits `ACCOUNT_ROLES.US_SAVINGS` (state tax is paid from the US cash pool), replenishing via `replenishSavings` when short. (`PRIORITY.TAX_APPLY + 1`.)

Period: states use `YEAR_US`; no new period type. The `TAX_SETTLE_STATE` series is scheduled Dec 31 like `TAX_SETTLE_US`.

---

## 6. The three states (illustrative rules — exact tables live in the year modules)

Brackets/amounts below are the *shape* each rates module encodes; the implementer pins exact figures per tax year from the state revenue authority. The architecture is what this doc fixes.

- **Nebraska (NE)** — progressive (4 brackets; top rate **5.84%** for 2024, scheduled to step down toward a flat **3.99%** by 2027 under LB 754 → exactly the kind of year-over-year change the per-year modules exist for). **Social Security fully exempt from 2025** (phased out 2021–2025). Capital gains taxed as **ordinary income**. State standard deduction (MFJ). ⇒ `NeStateTaxModule20YY` + `NeStateTaxRates20YY`, taxable = ordinary + pension + CG − (SS if year ≥ 2025) − std deduction.
- **Hawaii (HI)** — progressive (up to **11%**, among the highest). **Social Security exempt**; **employer-funded pension / many retirement distributions excluded** (this is why `statePensionIncomeYTD` is segregated). **Alternative capital-gains rate of 7.25%** — CG taxed at `min(ordinaryMarginalTreatment, 7.25%)`. ⇒ `HiStateTaxModule20YY` + `HiStateTaxRates20YY` overriding CG treatment and the pension/SS exclusions.
- **South Dakota (SD)** — **no individual income tax**. `SdStateTaxModule20YY.getReducerFns()` returns an empty map (or `hasIncomeTax = false`); `SdStateTaxRates20YY.computeTax()` returns `netLiability: 0`. No accumulation, no settle debit. This is the proof the abstraction degrades to zero cleanly.

Each state ships `20YY` modules for the years the federal side supports (2024, 2025, 2026) so the highest-year-≤ fallback behaves identically.

---

## 7. Wiring: `StateTaxService` + `US_STATE_TAX` toolset

- `StateTaxService` (`src/finance/state-tax-service.js`) — mirror of `TaxService`: pre-registers every `(stateCode, year)` classification + rates module, and exposes `getContributions(periodService, startDate, accountService, stateRegistry)` returning `{ statePatches, events, handlers, reducers }`:
  - the `TAX_SETTLE_STATE` annual series + `StateTaxSettleHandler`,
  - `StateTaxSettleApplyReducer` + `StateTaxPaymentDebitReducer`,
  - the dynamic state-classification reducers (one per action type, via `StateTaxEngine.registerDynamic`),
  - `statePatches`: the `state*YTD` zero-seeds (no new period — reuses the US calendar year already built by `US_TAX`).
- `US_STATE_TAX` toolset (`src/scenarios/toolsets/us-state-tax-toolset.js`) — declarative shell: `dependencies: ['US_TAX']` (needs the US periods and the income `*_TAX` events to classify), `capabilities: ['state-taxation']`. Exposes the `residencyState` param; seeds the `state*YTD` fields and `residencyState` in `state()`; returns the service's events/handlers/reducers. Registered in `ScenarioLoader`'s production toolset set and added to `IntlRetirementScenario.getToolsets()`.
- **Type registry** (`design/19`): register `STATE_TAX_SETTLE_APPLY` (family `TAX_SETTLE_APPLY`, cc `US`) and `STATE_TAX_PAYMENT_DEBIT` (family `TAX_PAYMENT_DEBIT`, cc `US`) so the existing journal reports (`Tax Paid by Year`) and the action-detail panel pick them up with no report changes. `family: 'TAX_PAYMENT_DEBIT'` means the existing `tax-paid-by-year` report already sums state payments alongside federal.

---

## 8. Testing

Mirrors the federal tax test suites (`tax-rates.test.mjs`, `evt-*`):

1. **Rates modules (unit).** Per state, per year: bracket math at boundary incomes; NE SS-exemption on/off by year; HI pension exclusion + the 7.25% CG alternative (CG above the crossover taxed at 7.25%, below at the ordinary result); HI/NE standard deduction. `SdStateTaxRates*` returns exactly 0 for any input.
2. **Classification (EVT-style integration).** With `residencyState` set, drive each income event and assert the right `state*YTD` bucket moves (and that SS lands in `stateSsIncomeYTD` gross, not the 85% slice). SD: assert no `state*YTD` field ever becomes non-zero.
3. **Settle integration.** Accumulate a year, fire `TAX_SETTLE_STATE`, assert `STATE_TAX_PAYMENT_DEBIT` debits `US_SAVINGS` by the computed amount and the `state*YTD` fields reset. Independent of `TAX_SETTLE_US` ordering (run both orders).
4. **Residency gating.** An AU-resident year accrues no `state*YTD` and settles to 0 even with the primary's `residencyState` set; moving back to US resumes accrual.
5. **Year fallback.** A sim year beyond the highest registered state module uses the highest available (same as federal).
6. **Accounting integrity.** Extend `accounting-integrity.test.mjs`: net-worth still ties out with state tax flowing through `US_SAVINGS` (state tax is a debit from the US cash pool — no money created/destroyed).

---

## 9. Provisions for a state move + optimization (not built in Phase 1)

Phase 1 ships a **static** `Person.residencyState` set at config. We are **not** building a mid-sim state move now, but the model below is the explicit provision so it drops in later **without reworking the engine** — it mirrors the country move (`CHANGE_RESIDENCY` + optimizable `moveYear`) exactly.

**Why no engine rework is needed.** The state engine resolves `primaryResidencyState(state)` *at runtime on every classification action and at settle* (§5). So anything that mutates `Person.residencyState` mid-sim is immediately honored for subsequent accrual — the same property that makes the country residency gate work. The deferred pieces are therefore just (a) an event that performs the mutation and (b) params that schedule it.

### 9.1 Change-state-residency logic (deferred)

Direct analogs of the country-move classes (`change-residency-handler.js` / `change-residency-apply-reducer.js`):

- **`CHANGE_STATE_RESIDENCY` event** — fires on the configured move date.
- **`ChangeStateResidencyHandler`** → emits `CHANGE_STATE_RESIDENCY_APPLY` (+ `RECORD_BALANCE`).
- **`ChangeStateResidencyApplyReducer`** (`PRIORITY.PRE_PROCESS`) — sets `residencyState = destination` on every person in `state.people` (so primary-derivation keeps working and a future per-person model is already seeded). Citizenship/`residency` country untouched.

**Part-year apportionment is the one real piece of new logic.** Unlike the country move (pinned to the AU FY boundary Jul 1, so each FY settle sees a single residency), a state move *within* a US calendar year leaves one set of `state*YTD` accumulators that belong partly to the origin state and partly to the destination. Two options, both compatible with this design:

- **Simplest (recommended first cut): pin state moves to Jan 1.** A move effective Jan 1 means the whole calendar year is taxed by the destination state — no apportionment, no new settle logic. The `stateMoveDate` param (below) would snap/validate to Jan 1.
- **Full part-year:** split each `state*YTD` at the move date and run `computeStateTax` twice (origin pre-move, destination post-move). This needs the settle to know the split point; reserve a `stateMovePeriodMs` marker written by `CHANGE_STATE_RESIDENCY_APPLY` for the settle to read. Deferred to the same phase that generalizes AU part-year residency (§ Phasing Phase 3).

### 9.2 State move as MC / optimization parameters (deferred)

Reserve two typed params (mirrors `moveYear`, which is already an optimization axis — `intl-retirement-opt-config.js:107 paramKey: 'moveYear'`):

| Param | Type | MC | Opt | Drives |
|---|---|---|---|---|
| `stateMoveYear` (or `stateMoveDate`) | Number / Date | sweepable | axis | the `CHANGE_STATE_RESIDENCY` event date in `US_STATE_TAX.schedules()` |
| `stateMoveDestination` | Enum `['NE','HI','SD']` | categorical sweep | categorical axis | the `destination` carried on `CHANGE_STATE_RESIDENCY_APPLY` |

Wiring when built: `US_STATE_TAX.schedules()` reads `context.parameters.stateMoveYear`/`stateMoveDestination` and (when set) schedules the `CHANGE_STATE_RESIDENCY` event — structurally identical to how `us-au-cross-border-toolset.js` builds `CHANGE_RESIDENCY` from `moveYear`. Optimizer/MC then sweep "which state, and when to establish residency" — e.g. *establish SD residency the year before the large IRA drawdown* — which is the headline analysis this whole design unlocks. `stateMoveDestination` is categorical, so it uses the optimizer's enumerated-axis path (same shape as the residency/strategy categorical params) and an MC categorical distribution.

**Provision checklist (what Phase 1 must not preclude):**

- ✅ `residencyState` on `Person` (mutable record; move target).
- ✅ runtime resolution via `primaryResidencyState(state)` (no frozen boot value).
- ✅ `state*YTD` keyed at household level, reset by `STATE_TAX_SETTLE_APPLY` (a move mid-year just changes which rates module the settle uses — and, with apportionment, splits the buckets).
- ✅ reserved param keys `stateMoveYear` / `stateMoveDestination` and the `US_STATE_TAX.schedules()` seam to build the event.
- ✅ `CHANGE_STATE_RESIDENCY*` action/handler/reducer names reserved alongside the type-registry families in §7.

---

## 10. Phasing

- **Phase 1 — engine + NE/HI/SD (this design).** `Person.residencyState` (static, config-time) + the `residencyState` param cascade onto the primary; `StateTaxEngine`, base classes, the three states × {2024,2025,2026} classification + rates modules, settle classes, `StateTaxService`, `US_STATE_TAX` toolset, `state*YTD` fields, schema + type-registry registration, tests 1–6.
- **Phase 2 — reporting. ✅ landed 2026-06-19.** "US State Tax by Year" journal report (`StateTaxByYearDef`); `Tax Paid by Year` now notes its US total includes federal + state. State return surfaces in the timeline tax-document modal via a single generic `StateTaxDocumentReporter` (renders the rates module's `lineItems` — no per-state-per-year document modules needed). `residencyState` shows in the scenario panel automatically (it's a typed param). The state settle now skips emitting `STATE_TAX_SETTLE_APPLY` when no state is configured, keeping the default scenario's journal clean.
- **Phase 3 — state move + optimization (provisioned in §9).** `CHANGE_STATE_RESIDENCY` classes, `stateMoveYear`/`stateMoveDestination` params (MC + opt), and part-year apportionment (shared with AU part-year residency). No engine rework — only the event, params, and the split-at-settle logic.

---

## 11. Design decisions & alternatives

- **Parallel engine vs. derive-from-federal-at-settle (chosen: parallel).** The rejected alternative computes state tax in `UsTaxSettleHandler` from the federal `us*YTD` accumulators (no state classification reducers, fewer files). It was rejected because (a) it pushes state-only needs (a gross-SS accumulator, a retirement-distribution accumulator) **into the federal modules**, eroding the separation the two-engine design buys, and (b) it couples state tax to the federal settle's read/reset timing. The parallel engine keeps all state logic in `src/finance/tax/state/` and removes the ordering hazard at the cost of a small default-classification base.
- **Residency state on `Person`, household derived from primary (chosen).** Per §1 both people share a state, but the field lives on `Person` (not a household `state.residencyState`) so it parallels the country `residency`, gives the move machinery (§9) a record to mutate, and leaves per-person divergence (Phase 3) as a resolver swap rather than a data-model change. The household active value is `primaryResidencyState(state)`; the spouse's field is defaulted to the primary's and not consulted in Phase 1.
- **SD as an empty module, not a special case.** Modeling "no income tax" as a real (empty) module keeps the registry uniform and is the regression guard that the abstraction supports zero-tax jurisdictions — important because most no-tax states (TX, FL, WA, …) would be added the same way.
- **State tax paid from `US_SAVINGS`.** State and federal both debit the US cash pool via `replenishSavings`; reusing `family: 'TAX_PAYMENT_DEBIT'` means existing cash-flow and tax-paid reports include state tax with no report-side work.

---

## 12. Open questions

1. **Exact bracket tables / effective dates.** NE's LB 754 rate glide and HI's most recent brackets need pinning per year; the doc fixes structure, not figures.
2. **HI capital-gains alternative** — confirm the exact crossover semantics (alternative tax computation) for the year tables, and whether short-term vs long-term needs splitting (the model currently tracks a single `gain`).
3. **Standard deduction vs. itemized** — Phase 1 assumes the state standard deduction (MFJ). Itemized (e.g., state deduction of federal items) is deferred.
4. **State move granularity (when built, §9)** — Jan-1-pinned move (no apportionment) first, or full part-year split up front? Recommendation: Jan-1 first, full part-year when AU part-year residency is generalized.
5. **`Person.residencyState` while abroad** — gate-only (dormant, recommended) vs. explicitly clearing it in `ChangeResidencyApplyReducer` on the US→AU move. Gating is sufficient; clearing is cosmetic.

---

## 13. Tax-settle ordering — ✅ implemented 2026-06-19

**Landed.** Added an event-level `order` field (`BaseEvent`/`EventSeries`/`OneOffEvent`, serialized) and made the queue comparator total: `(a.date - b.date) || ((a.order ?? 0) - (b.order ?? 0))` (`simulation.js`). Income/earnings keep the default `0`; the federal/AU settles (`TaxService`) use `order: 100` and the state settle (`StateTaxService`) `order: 101`. Result: all year income is booked before any settlement, and federal settles immediately before state, so both jurisdictions see the identical income set every year. Verified: the HI-resident 2030 federal vs. state gross income now reconcile **exactly** (was an $18,837 straddle). Fallout was two RMD tests that had codified the old "year-end income escapes the settle" behavior — updated to assert the RMD is captured in the settlement (the corrected behavior). The original analysis below is retained for context.



**Symptom.** For a HI resident, 2030 state ordinary income came out **$18,837 higher** than the federal ordinary base because a **year-end stock dividend** landed in different years for the two settlements. Observed Dec-31-2030 sequence:

```
… → US_TAX_SETTLE_APPLY (federal, resets usOrdinaryIncomeYTD)
    → STOCK_DIVIDEND_TAX  (+$18,837 to both usOrdinaryIncomeYTD and stateOrdinaryIncomeYTD)
    → STATE_TAX_SETTLE_APPLY (state, resets state*YTD)
```

The federal settle runs **before** the year-end dividend (pushing it into 2031); the state settle runs **after** it (taxing it in 2030). The two jurisdictions disagree on the same year's income. (This is distinct from the **coverage** gap — state missing US/AU interest — which is fixed: §12's reconciliation `usOrdinaryIncomeYTD == stateOrdinaryIncomeYTD + statePensionIncomeYTD + 0.85·stateSsIncomeYTD` is now asserted by `evt-state-tax.test.mjs` EVT-STATE-4.)

**Root cause.** The event queue comparator is **date-only** — `new IndexedMinHeap((a, b) => a.date - b.date, …)` (`simulation.js:87`). `BaseEvent`/`EventSeries` carry **no priority/order field**, so the relative order of multiple events on the **same date** (year-end earnings/dividends, `TAX_SETTLE_US`, `TAX_SETTLE_STATE`) is an undefined artifact of heap internals — not something the model controls. The two settles are **separate events with separate handlers** (`TAX_SETTLE_US` → `UsTaxSettleHandler`, `TAX_SETTLE_STATE` → `StateTaxSettleHandler`; scheduled independently by `TaxService.getContributions` and `StateTaxService.getContributions`), so there is no shared anchor forcing them together or after income.

**Fix (recommended): make same-date order explicit and impossible to get wrong** — add an event-level `order` (priority) field and make the comparator total:

```js
new IndexedMinHeap((a, b) => (a.date - b.date) || ((a.order ?? 0) - (b.order ?? 0)), …)
```

Then assign bands so the invariant holds by construction:

| Band | `order` | Events |
|---|---|---|
| Income / earnings / dividends / interest | `0` (default) | all the `*_EARNINGS`, `*_DIVIDEND`, interest, RMD, withdrawal events |
| Tax settlements | `100` (federal), `101` (state) | `TAX_SETTLE_US`, `TAX_SETTLE_AU`, then `TAX_SETTLE_STATE` |

This guarantees (a) **all income for the year is booked before any settlement**, and (b) **federal settles, then state settles, adjacently** — so both jurisdictions see the identical income set every year. It is general: any future same-date coordination uses the same field instead of relying on insertion luck.

**Trade-off / decision.** Ordering settlements *after* year-end income also **corrects** a pre-existing federal quirk — today a year-end dividend can slip into the next tax year (the "Dec interest re-adds after settlement" behavior the federal settle tests document). Fixing the ordering moves that income into its proper year, which **shifts federal results** and requires updating those federal test expectations. Two paths:

1. **Recommended — fix it properly:** land the `order` field + settle band, accept the federal correction (year-end income taxed in its own year), and update the affected federal settle tests. One structural change removes the whole class of same-date ordering bugs.
2. **Narrow alternative (freezes federal behavior):** keep the income/settle boundary where it is and only guarantee the two settles are **adjacent** — e.g. chain `STATE_TAX_SETTLE` as an action emitted by the federal settle handler, or fold both into one `TAX_SETTLE` event with priority-ordered handlers (federal then state). State then captures exactly what federal captured, with no income event able to slip between them, without moving any federal result. This is smaller but leaves the underlying date-only comparator (and its latent fragility) in place.

Recommendation: do (1) — the `order` field is the "impossible to run out of order" fix the symptom calls for, and it is reusable. Treat the federal test-expectation updates as part of that change, not as breakage.
