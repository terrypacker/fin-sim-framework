# 11 — TaxService Declarative Refactor

## Overview

`TaxService` is the only remaining imperative service in the simulation layer. It calls
`services.handlerService.register()` and `services.reducerService.register()` directly
instead of returning contribution objects to the `ScenarioCompiler`.  The `US_TAX` and
`AU_TAX` toolsets paper over this with a "fake sim / capture services" pattern — they
create throwaway objects to intercept what `TaxService` would register, then hand the
captured arrays back to the compiler.

This document describes how to eliminate that workaround and make the entire toolset
pipeline uniformly declarative.

---

## Current Architecture

```
ScenarioCompiler
  └─ for each toolset:
       toolset.state()     → { key: value, … }
       toolset.schedules() → EventSeries[]
       toolset.handlers()  → HandlerEntry[]
       toolset.reducers()  → Reducer[]

US_TAX.handlers() / reducers()
  └─ _getCapture(context)          ← runs once, cached on context
       ├─ fakeSim = { state: {} }
       ├─ TaxService.setup(fakeSim, ['US'], periodService)
       │    └─ writes fakeSim.state.currentPeriods           (captured as statePatches)
       ├─ captureServices = { eventService, handlerService, reducerService, … }
       └─ TaxService.registerHandlersAndReducers(captureServices, ['US'])
            ├─ creates PERIOD_ADVANCE EventSeries  → capturedEvents
            ├─ creates TAX_SETTLE EventSeries      → capturedEvents
            ├─ AccountModule.createReducers()      → capturedReducers  ← all account mechanics
            ├─ AccountModule.createHandlers()      → capturedHandlers  ← all account handlers
            ├─ DynamicTaxReducer per action type   → capturedReducers
            ├─ TaxSettleApplyReducer               → capturedReducers
            ├─ TaxPaymentDebitReducer              → capturedReducers
            ├─ ArrayReducer (RECORD_ARRAY_METRIC)  → capturedReducers
            └─ BalanceSnapshotReducer (RECORD_BALANCE) → capturedReducers
```

### Problems with this approach

1. **Leaky abstraction** — `US_TAX` and `AU_TAX` appear declarative but hide an imperative
   engine behind a capture indirection.  New contributors must understand the fake-sim trick
   to reason about what gets registered.

2. **Account mechanics bundled with tax** — `TaxService.registerHandlersAndReducers` calls
   `AccountModule.createHandlers()` / `createReducers()`, which register *all* account
   mechanics (IRA, 401k, brokerage, collectibles, …) regardless of which capabilities the
   scenario actually uses.  This is how `CollectibleValueChangeHandler` ended up registered
   for scenarios that have no collectibles.

3. **No guard conditions** — the account module registers every handler unconditionally.
   Toolsets can guard with `if (collectibles.length === 0) return []`; the account module
   cannot because it has no context object.

4. **Two registration paths** — non-toolset callers (legacy `IntlRetirementScenario`,
   unit tests) invoke `TaxService` directly; toolset callers go through the fake capture.
   Keeping both paths in sync is error-prone.

---

## Goal

Eliminate `_getCapture()` and the fake-sim/capture-services pattern.  After this refactor:

- `US_TAX` and `AU_TAX` own their own contribution logic directly.
- `TaxService` either becomes a pure computation helper (no side effects) or is dissolved
  into the toolsets entirely.
- Every account-type capability (Roth, IRA, 401k, brokerage, collectibles, real-property)
  is registered by its own toolset, not bundled into a catch-all account module.

---

## Phased Plan

### Phase 1 — Move asset-specific handlers/reducers to their toolsets  *(complete)*

Move handlers and reducers that belong to a specific capability toolset out of the account
module so they are only registered when that capability is declared.

| Class | From | To | Guard |
|---|---|---|---|
| `CollectibleSaleHandler` / `CollectibleSaleApplyReducer` | *(was never in account module)* | `US_COLLECTIBLES` | `collectibles.length > 0` |
| `CollectibleValueChangeHandler` / `CollectibleValueChangeApplyReducer` | `us-account-module-2026.js` | `US_COLLECTIBLES` | `collectibles.length > 0` |

**Status:** Done in this session.  `us-account-module-2026.js` no longer imports or registers
either collectible class.

**Future items in this phase** (not yet done):

| Class | From | To | Guard |
|---|---|---|---|
| `UsHouseSaleHandler` / `UsHouseSaleApplyReducer` | `us-account-module-2026.js` | `US_REAL_PROPERTY` | `realProperties.filter(US).length > 0` |

The AU equivalents (`AuHouseSaleHandler` / `AuHouseSaleApplyReducer`) should be verified to
already live in `AU_REAL_PROPERTY` (they do — the AU account module never included them).

---

### Phase 2 — Add a declarative API to TaxService

Introduce a new method that returns contributions as plain data rather than calling services:

```javascript
// New API (returns data, no side effects)
TaxService.getContributions(countries, periodService, startDate, accountService, stateRegistry)
→ {
    statePatches: { currentPeriods: { US: period, … } },
    events:       [ PERIOD_ADVANCE_US EventSeries, TAX_SETTLE_US EventSeries, … ],
    handlers:     [ PeriodAdvanceHandler, TaxSettleHandler ],
    reducers:     [ PeriodAdvanceReducer, DynamicTaxReducer×N, TaxSettleApplyReducer,
                    TaxPaymentDebitReducer, ArrayReducer, BalanceSnapshotReducer ],
  }
```

The account module handlers/reducers are intentionally **excluded** from this return value.
They migrate to their respective toolsets in Phase 3.

**Changes required:**
- `TaxService`: add `getContributions()` alongside the existing `setup()` /
  `registerHandlersAndReducers()` for backward compatibility.
- `US_TAX` toolset: replace `_getCapture()` with a direct call to
  `TaxService.getContributions(['US'], …)`.
- `AU_TAX` toolset: same for `['AU']`.

After this phase the fake-sim / capture-services pattern is gone.  The old imperative API
(`setup()` / `registerHandlersAndReducers()`) stays for legacy callers (unit tests that
construct `TaxService` manually) until Phase 4.

---

### Phase 3 — Migrate remaining account module handlers to toolsets

Move the remaining handlers/reducers out of `UsAccountModule2026` (and `AuAccountModule2026`)
into purpose-specific toolsets.  Each group maps to an existing or new toolset.

#### US account module → toolset mapping

| Handler/Reducer group | Current module | Target toolset | Notes |
|---|---|---|---|
| Roth IRA (EVT-1–4) | `UsAccountModule2026` | `US_RETIREMENT` | guard: has Roth account |
| Traditional IRA (EVT-5–8) | `UsAccountModule2026` | `US_RETIREMENT` | guard: has IRA account |
| 401k (EVT-24/25) | `UsAccountModule2026` | `US_RETIREMENT` | guard: has 401k account |
| IRA Rollover + RMD (EVT-35/40) | `UsAccountModule2026` | `US_RETIREMENT` | guard: has IRA-rollover account |
| Roth Rollover (EVT-41–44) | `UsAccountModule2026` | `US_RETIREMENT` | guard: has Roth-rollover account |
| Roth Conversion (EVT-52) | `UsAccountModule2026` | `US_ROTH_CONVERSION` | already a toolset |
| US Brokerage (EVT-9–15) | `UsAccountModule2026` | new `US_BROKERAGE` toolset | guard: `ACCOUNT_ROLES.FIXED_INCOME` or `ACCOUNT_ROLES.US_STOCK` present |
| US House Sale (EVT-34) | `UsAccountModule2026` | `US_REAL_PROPERTY` | guard: has US real-property |
| Income – SS/Wages/SE/Bonus/Co-sale | `UsAccountModule2026` | `US_INCOME` | guard: person has wages/SS |

`US_RETIREMENT` must declare `US_BROKERAGE` as a dependency so brokerage handlers/reducers are
always registered for retirement scenarios that include brokerage accounts.  Role constants
(`FIXED_INCOME`, `US_STOCK`) remain in `account-roles.js`; `US_BROKERAGE` imports them for its
guard logic.

#### AU account module → toolset mapping

| Handler/Reducer group | Current module | Target toolset | Notes |
|---|---|---|---|
| AU Super (EVT-26–29) | `AuAccountModule2026` | `AU_RETIREMENT` | guard: has super account |
| AU Brokerage dividends | `AuAccountModule2026` | new `AU_BROKERAGE` toolset | guard: `ACCOUNT_ROLES.AU_STOCK` present |
| AU Savings (EVT-30–32) | `AuAccountModule2026` | `AU_BANKING` | guard: has AU savings account |
| AU House Sale (EVT-33) | `AuAccountModule2026` | `AU_REAL_PROPERTY` | guard: has AU real-property |
| AU Income (SE, wages) | `AuAccountModule2026` | `AU_INCOME` | guard: person has wages |

`AU_RETIREMENT` must declare `AU_BROKERAGE` as a dependency for the same reason.  The role
constant (`AU_STOCK`) stays in `account-roles.js`; `AU_BROKERAGE` imports it for its guard logic.

Once all groups are migrated the account module classes become thin or empty and can be
removed.

---

### Phase 4 — Remove legacy TaxService imperative API

After Phases 2–3 are complete:

- `TaxService.registerHandlersAndReducers()` is no longer called anywhere.
- `TaxService.setup()` is no longer called anywhere.
- Remove both methods (or keep a thin shim that throws with a migration message).
- Update unit tests that construct `TaxService` manually to use the toolset path instead.

---

### Phase 5 (optional) — Inline TaxService into toolsets

`TaxService.getContributions()` (Phase 2) is still an external dependency.  Optionally,
inline the period-advance and tax-settle schedule construction directly into `US_TAX` and
`AU_TAX` so the toolsets have zero dependency on `TaxService`.

`TaxEngine` and `AccountRulesEngine` can remain as internal helpers used by the tax
toolsets — they are already registry-style and fit the declarative model.

---

## Key Invariants to Preserve

1. **PERIOD_ADVANCE and TAX_SETTLE events fire at exactly the right dates.**  The
   period-service lookup that finds `startMs` must survive refactoring unchanged.

2. **DynamicTaxReducer is instantiated once per (country, actionType).**  If a toolset
   is registered multiple times (via dependency de-dup) this must still hold.

3. **`_getCapture` is cached on context.**  The Phase 2 replacement must also cache so
   `state()`, `schedules()`, `handlers()`, `reducers()` — called separately by the compiler
   — share one computation.

4. **Legacy callers keep working until Phase 4.**  `IntlRetirementScenario` and direct
   `TaxService` unit tests must not break until the imperative API is explicitly removed.

---

## Files Affected (by phase)

| Phase | Files changed |
|---|---|
| 1 (done) | `us-account-module-2026.js`, `us-collectibles-toolset.js` |
| 2 | `finance/tax-service.js`, `toolsets/us-tax-toolset.js`, `toolsets/au-tax-toolset.js` |
| 3 | `us-account-module-2026.js`, `au-account-module-2026.js`, multiple toolsets, possibly new `us-brokerage-toolset.js` / `au-brokerage-toolset.js` |
| 4 | `finance/tax-service.js`, all direct `TaxService` test consumers |
| 5 (opt) | `toolsets/us-tax-toolset.js`, `toolsets/au-tax-toolset.js`, `finance/tax-service.js` |

---

## Acceptance Criteria

- All 581+ backend tests pass after each phase.
- `US_TAX` and `AU_TAX` toolsets contain no fake-sim or capture-services code (Phase 2).
- `CollectibleValueChangeHandler` is not registered for scenarios that declare no
  `US_COLLECTIBLES` toolset (Phase 1 — already enforced).
- `TaxService.registerHandlersAndReducers` is unreferenced (Phase 4).
