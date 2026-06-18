# 20 — Decouple Residency from Citizenship; Per-Person, Country-Coded

Closes `inconsistencies.md` items **2.12** (`intl-retirement-state.js` carries `personBirthDate` / `isAuResident` marked for removal) and **3.7** (`Person.isAuResident` is both stored and derived).

Status: **Draft**.

---

## 1. Problem

Two separate concepts are conflated in the current code, and both are stored as
flat, single-valued state fields even though `state.people` is already a map of
N persons:

| Concept       | Today                                                                        | Issue                                                                                   |
|---------------|------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------|
| Citizenship   | `Person.citizen: string[]` (e.g. `['US']`, `['US','AUS']`)                   | Correct shape, but `ChangeResidencyApplyReducer` mutates it on a *move* event.          |
| Residency     | `state.isAuResident: boolean` + `Person.isAuResident: boolean` (derived)     | Boolean only supports US/AU; lives at household level even though tax is per-person.    |
| Age look-ups  | `state.personBirthDate: Date` (= `state.people.primary.birthDate`)           | Single field for primary only; ignores spouse / additional persons.                     |

Concrete bugs the current model encodes:

1. **`Person` constructor**: `this.isAuResident = opts.isAuResident ?? this.citizen.includes('AUS')`.
   Being an AU citizen does **not** make someone an AU tax resident — a dual
   citizen living in the US is a US resident.
2. **`ChangeResidencyApplyReducer`**: on a US→AU move it adds `'AUS'` to every
   person's `citizen` array. Moving does **not** grant citizenship.
3. **Single-valued state fields**: `state.isAuResident` and
   `state.personBirthDate` assume a household with one residency and one
   person-of-interest. The simulation already supports a `primary`+`spouse`
   pair and the data model imposes no cap.

Locations that read the single-valued state fields today (non-exhaustive):

- `AccountService.replenishSavings()` — `state.personBirthDate`, `state.isAuResident`
- `SuperWithdrawalEarningsHandler`, `SuperWithdrawalContributionsHandler` — `state.personBirthDate`
- `IraWithdrawalEarningsHandler`, `IraWithdrawalContributionsHandler` — `state.personBirthDate`
- `RothWithdrawalEarningsHandler`, `RothWithdrawalContributionsHandler` — `state.personBirthDate`
- `IraAnnualRmdHandler`, `K401AnnualRmdHandler` — `state.personBirthDate`
- `MonthlyExpensesHandler`, `ExpenseDebitReducer` — `state.isAuResident`
- `InflationAdjustReducer` — `state.isAuResident`
- `IntlAuStockDividendHandler`, `DividendScheduledHandler`, `AuSavingsInterestHandler`, `MonthlyWagesHandler`, `MonthlySocialSecurityHandler` — `state.isAuResident`
- All `*EarningsHandler` and account-rules `*Apply` reducers that chain `isAuResident` into the next action's payload
- `UsTaxModule2026`, `AuTaxModule2026`, `au-tax-rates-base.js` — branch on `isAuResident`
- `TaxDocumentRegistry` — `STOCK_WITHDRAWAL_TAX with isAuResident === true` discrimination

---

## 2. Concepts (target model)

| Concept        | Storage                                                       | Semantics                                                       |
|----------------|---------------------------------------------------------------|-----------------------------------------------------------------|
| Citizenship    | `Person.citizen: string[]` (unchanged)                        | Stable across time; multi-valued; never mutated by a move.       |
| Residency      | `Person.residency: string` + `state.people[key].residency`    | Per-person, single current country code (e.g. `'US'`, `'AUS'`). Mutable via `CHANGE_RESIDENCY`. |
| Birth date     | `Person.birthDate` + `state.people[key].birthDate` (existing) | Per-person; remove the global `state.personBirthDate` cache.    |

Residency is **country-coded** (string), not boolean. The country codes match
those already in use for `citizen[]` (`'US'`, `'AUS'`). This is what unlocks
adding more jurisdictions later without churning every call site.

> **A note on "household residency."** A handful of decisions today are
> genuinely household-wide (which savings account funds monthly expenses; which
> inflation accumulator drives the residence-cost-of-living curve). We do
> **not** introduce a `state.householdResidency` field. Instead, the toolset
> wires those handlers/reducers with an explicit `primaryPersonKey` and they
> read `state.people[primaryPersonKey].residency`. This keeps a single source
> of truth (the per-person map) and makes the "primary owns this decision"
> intent visible at wiring time.

---

## 3. Data Model Changes

### 3.1 `Person` (`src/finance/person.js`)

```diff
- this.isAuResident          = opts.isAuResident          ?? this.citizen.includes('AUS');
+ this.residency             = opts.residency             ?? this.citizen[0] ?? 'US';
```

- Remove `opts.isAuResident` entirely (no shim, no rename).
- Update the JSDoc `@param` block: drop `isAuResident`, add `residency` with
  the country-code-string contract.

### 3.2 `state.people[key]`

Each entry already mirrors a subset of `Person`. Add `residency`:

```js
state.people[key] = {
  id, name, birthDate, monthlyWage, retirementDate,
  socialSecurityMonthly, lifeExpectancy, citizen,
  residency,            // NEW
};
```

Toolset `state()` patches that build `people` (US_RETIREMENT, AU_RETIREMENT)
project `person.residency` (or `person.citizen[0]`) into this field.

### 3.3 `InternationalRetirementFinancialState`

```diff
- //TODO Remove these this should not be needed.
- this.personBirthDate = primary.birthDate;
- this.isAuResident = false;
```

Both fields are deleted. The `//TODO` markers in this file get to go too.

### 3.4 `state-schema-registry.js`

```diff
- this.register('isAuResident', ParameterValueType.boolean());
+ this.register('people.*.residency', ParameterValueType.text());
```

(`personBirthDate` was never registered; no change needed there.)

---

## 4. New Helpers — `src/finance/residency-utils.js`

A small, pure module. No service injection; takes plain state.

```js
/** Country code of the person identified by `personKey`. */
export function getResidency(state, personKey)            { … }

/** True iff that person's residency matches the given country code. */
export function isResident(state, personKey, country)     { … }

/** Array of personKeys whose residency is `country`. */
export function residentsOf(state, country)               { … }

/** Birth date of the given personKey (replaces state.personBirthDate). */
export function getBirthDate(state, personKey)            { … }
```

Co-locate with `ownership-utils.js`. Tests live in
`tests/unit/residency-utils.test.mjs`.

---

## 5. Action Payload Changes

Today many actions carry `isAuResident: boolean`. Going forward they carry
`residency: string` (country code). The value is **derived at emission time
from the account owner** (or, for household-wide actions, the primary person —
see §6.3).

### 5.1 Affected action types

In each owning toolset's `types.actions` block (e.g. `us-retirement-toolset.js`,
`us-income-toolset.js`, `au-banking-toolset.js`, `au-brokerage-toolset.js`,
`au-real-property-toolset.js`, etc.):

```diff
- { type: 'IRA_WITHDRAWAL_EARNINGS_TAX', fields: { …, isAuResident: ValueType.boolean() } },
+ { type: 'IRA_WITHDRAWAL_EARNINGS_TAX', fields: { …, residency:    ValueType.text() } },
```

Full list of action types to migrate (grep `isAuResident:` under
`src/scenarios/toolsets/`):

- US_RETIREMENT: `STOCK_DIVIDEND_CASH_APPLY`, `ROTH_WITHDRAWAL_EARNINGS_TAX`,
  `ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_TAX`, `IRA_WITHDRAWAL_EARNINGS_TAX`,
  `IRA_ROLLOVER_WITHDRAWAL_TAX`, `IRA_RMD_TAX`, `K401_RMD_TAX`
- US_INCOME: `SS_INCOME_APPLY`, `SS_INCOME_TAX`, `WAGES_INCOME_APPLY`,
  `WAGES_INCOME_TAX`, `SE_INCOME_US_APPLY`, `SE_INCOME_US_TAX`, `BONUS_APPLY`,
  `BONUS_TAX`, `COMPANY_SALE_APPLY`, `COMPANY_SALE_TAX`
- US_BROKERAGE: `FIXED_INCOME_EARNINGS_APPLY`, `STOCK_DIVIDEND_TAX`,
  `STOCK_WITHDRAWAL_TAX`, …
- US_ROTH_CONVERSION: `ROTH_CONVERSION_TAX`
- US_COLLECTIBLES: `COLLECTIBLE_SALE_TAX`
- AU_BANKING: `AU_SAVINGS_EARNINGS_APPLY`, `AU_SAVINGS_EARNINGS_TAX`,
  `AU_FIXED_INCOME_EARNINGS_APPLY`, `AU_FIXED_INCOME_EARNINGS_TAX`
- AU_INCOME: `AU_SE_INCOME_TAX`
- AU_BROKERAGE: `AU_STOCK_WITHDRAWAL_*` family
- AU_REAL_PROPERTY: `AU_HOUSE_SALE_TAX`

### 5.2 Tax modules

`UsTaxModule2026`, `AuTaxModule2026`, `au-tax-rates-base.js`:

```diff
- const { amount, isAuResident } = action;
- if (isAuResident) { … }
+ const { amount, residency } = action;
+ if (residency === 'AUS') { … }
```

`au-tax-rates-base.computeTax({ isAuResident, … })` gets renamed to
`computeTax({ residency, … })`. Per-person AU computation
(`computeAuTaxPerPerson`) iterates `state.people` and now reads
`person.residency` to decide whether to include a person in the AU pool at
all (non-residents are still classified as AU NR withholding via the action
payload, but a person who is no longer an AU resident shouldn't appear in the
resident-bracket per-person calc).

### 5.3 `TaxDocumentRegistry`

```diff
- const isAuResidentSale = t === 'STOCK_WITHDRAWAL_TAX' && d.isAuResident === true;
+ const isAuResidentSale = t === 'STOCK_WITHDRAWAL_TAX' && d.residency === 'AUS';
```

---

## 6. Handler / Reducer Migration

### 6.1 Handlers that read `state.personBirthDate`

Each gets an explicit `ownerId` (matching the account it serves) so it can
look up `state.people[ownerKey].birthDate` via `getBirthDate`.

Most account-rules handlers already accept an `ownerId` for `stateRegistry`
lookups (e.g. `IraAnnualRmdHandler`, `K401AnnualRmdHandler`). The
`*WithdrawalEarnings` / `*WithdrawalContributions` handlers do **not** today —
they have no constructor args at all. They need `{ stateRegistry, role, ownerId }`
plumbed in from the owning toolset, matching the pattern of
`IntlAuStockDividendHandler`. The handler resolves `personKey` from
`accountService.getOwnerPersonKey(account)` or, if `ownerId` is null, from the
first matching account's owner.

### 6.2 `AccountService.replenishSavings`

Currently reads `state.personBirthDate` and `state.isAuResident` directly.
Change the signature to take the relevant persona:

```diff
- replenishSavings(state, targetKey, deficit, date, earlyWithdrawalRulesFn)
+ replenishSavings(state, targetKey, deficit, date, opts = {})
+   // opts.personKey  → use state.people[personKey] for birthDate + residency
+   // opts.earlyWithdrawalRulesFn (unchanged)
```

The target savings account already has an `ownerId`; `personKey` defaults to
the owner of `state[targetKey]`. The tax actions emitted into
`pendingTaxActions` carry `residency: getResidency(state, personKey)` instead
of `isAuResident`.

### 6.3 Household-wide handlers (currently keyed off `state.isAuResident`)

These keep their two-account wiring but switch on the **primary person's
residency**:

| File                                  | Field today              | After                                                          |
|---------------------------------------|--------------------------|----------------------------------------------------------------|
| `monthly-expenses-handler.js`         | `state.isAuResident`     | `getResidency(state, this.primaryPersonKey) === 'AUS'`         |
| `expense-debit-reducer.js`            | `state.isAuResident`     | same                                                           |
| `inflation-adjust-reducer.js`         | `state.isAuResident`     | same                                                           |
| `dividend-scheduled-handler.js`       | `state.isAuResident`     | account-owner's residency (it's a per-account event)           |
| `earnings-handlers.IntlAuStockDividendHandler` | `state.isAuResident` | account-owner's residency                                  |
| `monthly-wages-handler.js`            | `state.isAuResident`     | the wage-earner's residency (handler is per-person already)    |
| `monthly-social-security-handler.js`  | `state.isAuResident`     | the SS recipient's residency                                   |

Where the handler already iterates per-person (wages, SS, ownership-aware
dividends) the change is mechanical. Where it represents a single
household-level decision (expenses, expense-debit, inflation-adjust), the
toolset wires it with an explicit `primaryPersonKey` and the handler reads
that person's residency.

### 6.4 `ChangeResidencyApplyReducer`

The reducer that today incorrectly mutates `citizen` is the centerpiece of the
fix:

```diff
- // 2. Add AU citizenship to every person in state.people
- for (const [key, p] of Object.entries(state.people)) {
-   updatedPeople[key] = { ...p, citizen: [...new Set([...p.citizen, 'AUS'])] };
- }
- // 3. Set isAuResident flag
- return this.newState({ ...state, people: updatedPeople, isAuResident: true });
+ // 2. Flip every person's residency to AU (citizenship is NOT touched).
+ for (const [key, p] of Object.entries(state.people)) {
+   updatedPeople[key] = { ...p, residency: 'AUS' };
+ }
+ return this.newState({ ...state, people: updatedPeople });
```

`balanceAtResidencyChange` snapshotting (step 1) is unchanged.

Header docstring updated: "Snapshots investment account balances at residency
change and switches every person's `residency` to `'AUS'`."

> **Scope note (per Q&A):** the move is household-wide; all persons flip
> together. A future per-person move would attach `personKey` /
> `toCountry` to the `CHANGE_RESIDENCY` event payload and have the reducer
> mutate only that person — additive change, no breakage.

### 6.5 The `US_AU_CROSS_BORDER` toolset param

```diff
- { key: 'isAuResident', label: 'Starts as AU Resident', type: 'Boolean', … }
+ { key: 'startingResidency', label: 'Starting Residency', type: 'Text', defaultValue: 'US', … }
```

`state(context)` projects the starting residency onto every person in
`state.people`, rather than writing a global `isAuResident`. `IntlRetirementScenario`'s
`buildDefaultConfig()` is updated to pass `startingResidency: 'US'` (or
whichever value `p.isAuResident` mapped to before).

---

## 7. Implementation Sequence

Land the change in one branch but as a small chain of commits so review can
follow the layering:

| # | Commit                                                          | Notes                                                                           |
|---|-----------------------------------------------------------------|---------------------------------------------------------------------------------|
| 1 | Add `Person.residency`; add `residency-utils.js` + tests         | Pure addition; nothing reads the new field yet. Person.isAuResident still present. |
| 2 | Project `residency` into `state.people[*]`                       | Update US_RETIREMENT, AU_RETIREMENT, US_AU_CROSS_BORDER `state()` patches.       |
| 3 | Migrate `state.personBirthDate` readers → `getBirthDate(state, personKey)` | Update handler ctor signatures to take `ownerId` where missing; rewire toolsets. |
| 4 | Migrate `state.isAuResident` readers → `getResidency(...)` and per-action `residency` payloads | One commit per concern area: tax modules, account-rules reducers, household handlers, tax-document-registry. |
| 5 | Fix `ChangeResidencyApplyReducer` (stop mutating `citizen`)      | Independently testable.                                                          |
| 6 | Delete `state.personBirthDate`, `state.isAuResident`, `Person.isAuResident` | Final cleanup commit; also drop the `isAuResident` registration in `state-schema-registry.js` and the schema entries in toolsets. |
| 7 | Update `inconsistencies.md` (close 2.12 + 3.7), README mentions of `isAuResident` | Docs.                                                                            |

Each commit keeps `npm test` green.

---

## 8. Test Plan

New tests:

- `tests/unit/residency-utils.test.mjs` — helpers.
- `tests/unit/change-residency.test.mjs` — confirm `CHANGE_RESIDENCY_APPLY`
  flips `state.people[*].residency` to `'AUS'` and does **not** mutate
  `citizen`. Verify a person with `citizen: ['US']` who moves stays
  `citizen: ['US']`.
- `tests/unit/person.test.mjs` — add: `Person` defaults `residency` to
  `citizen[0]`; `Person` with `citizen: ['US','AUS']` defaults to `'US'`
  unless explicitly overridden.

Updated tests: anywhere that asserts `state.isAuResident` / `Person.isAuResident`
or constructs an action with `isAuResident:` is migrated to `residency`.
Expect changes in:

- `evt-401k.test.mjs`, `evt-ira.test.mjs`, `evt-roth.test.mjs`, `evt-super.test.mjs`,
  `evt-au-savings.test.mjs`, `evt-us-brokerage.test.mjs`, `evt-au-brokerage.test.mjs`,
  `evt-real-property.test.mjs`, `evt-collectible.test.mjs`, `evt-income.test.mjs`
- `tax-rates.test.mjs`, `tax-documents.test.mjs`
- `toolset-cross-border.test.mjs`, `intl-retirement-scenario.test.mjs`
- `scenario-roundtrip.test.mjs`, `serializer-finance-roundtrip.test.mjs`

UI verification (per project convention): rebuild a cross-border scenario in
the workbench, scrub past the move date, and confirm:

- Timeline shows `residency: 'US'` on per-person rows before the move and
  `'AUS'` after.
- AU tax modal still attributes correctly (per-person tab is unchanged in
  shape; per-person residency is just sourced from the new field).
- Citizenship in the people editor is **not** modified by the move event.

---

## 9. Backwards Compatibility

No external consumers. No migration shim. Saved scenarios in `localStorage`
that carry `cfg.parameters.isAuResident` are mapped to `startingResidency` in
the loader's `_normalizeParams` (one-line guard, can be removed once we
clear local dev caches).

---

## 10. Open Questions

1. **Residency history.** Should `state.people[key].residency` keep a history
   (e.g. `[{ country, fromMs }]`) so prorating in the move year can be derived
   instead of relying on YTD-reset semantics at the move date? Current YTD-reset
   model is correct; history is only needed if we want pretty timelines.
   **Recommendation**: skip for now, file as a follow-up.

2. **Country-code spelling.** ~~Citizenship currently uses `'AUS'` (3-letter)
   alongside `'US'` (2-letter) — inconsistent. Residency adopts the same set
   for compatibility but we should normalize to ISO-3166-1 alpha-2 (`'US'`,
   `'AU'`) project-wide in a separate cleanup.~~ **RESOLVED.** All country-coded
   values (`citizen[]`, `residency`, `startingResidency`, tax/account `cc`,
   account/property `country`) are now ISO-3166-1 alpha-2. The residency
   namespace is identical to the tax `cc` namespace, so the `'AUS' ? 'AU' : 'US'`
   bridge shims in `InflationAdjustReducer` / `AgeBandedSpendingReducer` were
   removed, and the stray `'USA'` fallbacks in the behavioral layer collapsed to
   `'US'`. Canonical constants + helpers (`currencyForCountry`,
   `defaultCurrencyForCountry`, `normalizeCountryCode`) live in
   `src/finance/country-codes.js`; the duplicated per-editor currency helpers now
   delegate to it. `ScenarioLoader._normalizeCountryCodes` rewrites legacy
   spellings on persisted scenarios at load (back-compat shim, removable once dev
   caches clear).

3. **`primaryPersonKey` wiring.** The household-wide handlers
   (`MonthlyExpensesHandler`, `ExpenseDebitReducer`, `InflationAdjustReducer`)
   need to know who "primary" is. The toolset already derives a `primaryId`
   from the first US/AU savings account owner; pass that through as
   `primaryPersonKey`. Confirm no scenario currently has a household whose
   "primary" cannot be identified by owner of US/AU savings.
