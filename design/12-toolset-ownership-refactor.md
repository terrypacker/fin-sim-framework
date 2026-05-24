# Design 12 — Toolset Ownership Refactor

**Status**: Draft  
**Branch**: wip/int-scenario-toolset  
**Problem**: Double-registration of handlers/reducers in the International Scenario causes each action (e.g. `WAGES_INCOME_APPLY`) to be reduced twice per person per month.

---

## 1. Root Cause Analysis

### 1.1 The Live Bug

`IntlRetirementScenario` loads these toolsets:

```
US_BANKING, US_TAX, US_BROKERAGE, US_INCOME, US_RETIREMENT, ...
```

`US_RETIREMENT` was built as a monolithic "everything for a US retirement sim" toolset before `US_INCOME` and `US_BROKERAGE` were extracted. It still contains:

| Category | Registered in `US_RETIREMENT` | Also in |
|---|---|---|
| Wages/SS/SE income handlers + reducers | ✓ (lines 417–485) | `US_INCOME` |
| Fixed income + stock brokerage handlers + reducers | ✓ (lines 422–543) | `US_BROKERAGE` |

When both toolsets are loaded, the `ScenarioCompiler` concatenates their contributions without deduplication → every overlapping handler/reducer fires twice.

### 1.2 Dead Code in Account Modules

`UsAccountModule2026.createHandlers()` and `createReducers()` (and their AU counterparts) return fully-formed handler and reducer lists but are **never called anywhere** in the codebase. They are dead code that was superseded by the toolset architecture but never removed.

---

## 2. Architectural Principle

> **Toolsets are the single and authoritative source of handler/reducer registration. Account modules are pure rule/hook providers.**

| Layer | Responsibility |
|---|---|
| **Account module** (`BaseAccountModule`) | Exposes query hooks: `getEarlyWithdrawalRules()`, `getContributionLimits()`, `getTaxBrackets()`, etc. No handler or reducer instantiation. |
| **Toolset** | Owns handler/reducer instantiation and registration. Declares explicit `dependencies[]` on other toolsets it needs rather than duplicating their work. |
| **ScenarioCompiler** | Resolves the dependency graph (topological sort), collects contributions from each toolset exactly once. |

### Dependency Hierarchy (target state)

```
US_RETIREMENT
  ├── US_BANKING        (savings interest)
  ├── US_TAX            (tax events + dynamic reducers)
  ├── US_INCOME  ←──── (wages, SS, SE, bonus, company sale)
  └── US_BROKERAGE ←── (fixed income, stock)

AU_RETIREMENT
  ├── AU_BANKING
  ├── AU_TAX
  └── AU_INCOME  ←──── (self-employment income)
```

Toolsets that appear as dependencies are registered by the compiler exactly once regardless of how many times they appear in the flat toolset list or as transitive dependencies.

---

## 3. Proposed Changes

### Phase 1 — Fix the live double-registration bug (US side)

**Files changed**: `us-retirement-toolset.js`

1. Add `'US_INCOME'` and `'US_BROKERAGE'` to `US_RETIREMENT.dependencies`.
2. Remove from `US_RETIREMENT.handlers()`:
   - Income handlers block (lines 417–420): `SsIncomeHandler`, `WagesIncomeHandler`, `WagesWithheldHandler`, `SeIncomeUsHandler`, `BonusHandler`, `CompanySaleHandler`
   - Brokerage handlers block (lines 422–428): `FixedIncomeContributionHandler`, `FixedIncomeWithdrawalHandler`, `FixedIncomeEarningsHandler`, `StockContributionHandler`, `StockDividendHandler`, `StockEarningsHandler`, `StockWithdrawalHandler`
3. Remove from `US_RETIREMENT.reducers()`:
   - Income reducers block (lines 480–485): `SsIncomeApplyReducer`, `WagesIncomeApplyReducer`, `WagesWithheldApplyReducer`, `SeIncomeUsApplyReducer`, `BonusApplyReducer`, `CompanySaleApplyReducer`
   - Brokerage reducers block (lines 504–514): all `FixedIncome*` and `Stock*` reducers

After this change `US_RETIREMENT` retains only what it exclusively owns:
- Lifecycle infrastructure: `MonthlyExpensesHandler`, `MonthlyWagesHandler`, `MonthlySocialSecurityHandler`, `OutOfFundsHandler`
- Retirement account mechanics: Roth IRA, Traditional IRA, 401(k) (no separate toolset exists for these)
- Inflation, out-of-funds, replenish-savings reducers

**No scenario files change** — the `ScenarioCompiler` already handles transitive dependencies; `US_INCOME` and `US_BROKERAGE` were already in the flat list.

**Verify**: Run the International Scenario and confirm `WAGES_INCOME_APPLY` is reduced once per person per month.

### Phase 2 — Fix AU side for consistency

**Files changed**: `au-retirement-toolset.js`

The AU side currently does not duplicate `AU_INCOME` content, but the dependency should be declared explicitly for architectural clarity:

1. Add `'AU_INCOME'` to `AU_RETIREMENT.dependencies`.
2. Audit `AU_RETIREMENT.handlers()` and `AU_RETIREMENT.reducers()` for any overlap with `AU_INCOME` or `AU_BROKERAGE` content; remove any duplicates found.

### Phase 3 — Delete dead code from account modules

**Files changed**:
- `src/finance/account-rules/us/us-account-module-2026.js`
- `src/finance/account-rules/au/au-account-module-2026.js`
- `src/finance/account-rules/base-account-module.js`

1. Delete `createHandlers()` and `createReducers()` from `UsAccountModule2026` (lines 99–186).
2. Delete `createHandlers()` and `createReducers()` from `AuAccountModule2026` (lines 58–102).
3. Remove the abstract method stubs from `BaseAccountModule` (lines 38–51) — the interface no longer requires these.
4. Update the `BaseAccountModule` JSDoc to reflect its new role as a hook provider only.

Year-specific subclasses (`UsAccountModule2024`, `UsAccountModule2025`, etc.) inherit from 2026 and have no overrides of these methods, so they need no changes.

**Verify**: `npm test` — no tests should reference `createHandlers`/`createReducers`.

### Phase 4 — Document the rule

Add a guard to `ScenarioCompiler` (or a README section in the toolsets directory) that codifies the invariant:

> A toolset that lists toolset X as a dependency MUST NOT register handlers or reducers that X also registers. The compiler resolves X exactly once.

Optionally, in dev/test mode, the compiler can detect duplicate handler class registrations and throw, making future violations immediately visible.

---

## 4. What Stays in Account Modules

Account modules (`BaseAccountModule` subclasses) remain in the codebase as **rule registries** accessed by the `AccountRulesEngine`. Their surviving API:

| Method | Purpose |
|---|---|
| `getEarlyWithdrawalRules(accountType)` | Returns `{ penaltyRate, ageThreshold }` or null |
| *(future)* `getContributionLimits(accountType)` | Returns annual contribution caps, year-adjusted |
| *(future)* `getRequiredMinimumDistributionAge()` | Returns RMD age for the given year |

These are called by toolset handlers/reducers (or by `TaxSettleService`) at runtime to get year-appropriate rules — the same pattern as `getEarlyWithdrawalRules` today.

---

## 5. Files Summary

| File | Change |
|---|---|
| `src/scenarios/toolsets/us-retirement-toolset.js` | Add deps, remove income + brokerage wiring |
| `src/scenarios/toolsets/au-retirement-toolset.js` | Add AU_INCOME dep, audit for overlaps |
| `src/finance/account-rules/us/us-account-module-2026.js` | Delete `createHandlers` + `createReducers` |
| `src/finance/account-rules/au/au-account-module-2026.js` | Delete `createHandlers` + `createReducers` |
| `src/finance/account-rules/base-account-module.js` | Remove abstract stubs, update JSDoc |

No scenario files, no compiler changes, no state changes.

---

## 6. Risk Notes

- **Roth/IRA/401k handlers in US_RETIREMENT**: These have no separate toolset and are not duplicated anywhere. They stay in `US_RETIREMENT` untouched.
- **ScenarioCompiler deduplication**: Already handled. `_resolveToolsets()` uses a `Map` keyed by toolset ID (line 93: `if (resolved.has(id)) return`) so each toolset is collected exactly once regardless of whether it appears both as a dependency and in the scenario's flat list. No compiler changes needed.
- **Test coverage**: `toolset-us-retirement.test.mjs` should be extended to assert that loading `[US_RETIREMENT, US_INCOME, US_BROKERAGE]` together does not produce duplicate reducers for the same action type.