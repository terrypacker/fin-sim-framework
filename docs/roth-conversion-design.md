# Roth Conversion: Design & TODO

**Status**: Design — decisions resolved, ready to implement  
**Created**: 2026-05-16  
**Related Requirements**: EVT-42, EVT-43, EVT-44 (downstream rollover events — already implemented)

---

## Context & Existing Foundation

EVT-42/43/44 cover what happens *after* a conversion is complete (earnings, contribution
withdrawals, earnings withdrawals from within the Roth rollover bucket).  What is missing
is the **conversion event itself** — the atomic act of moving money from a Traditional IRA
into a Roth IRA and recording the resulting taxable income.

Today, a caller could fire `IRA_ROLLOVER_WITHDRAWAL` (EVT-35) and then
`ROTH_ROLLOVER_CONTRIBUTION` (EVT-41) as two separate events, but that:

1. Leaves a gap in the event graph (the two events are not linked)
2. Incorrectly routes money through the cash pool (IRA → cash → Roth)
3. Gives the optimizer no single knob to control

A dedicated **Roth Conversion** event solves all three.

**Important constraint**: A Roth conversion is an in-kind rollover — the full gross amount
must move directly from the Traditional IRA to the Roth IRA.  There is no withholding.
The income tax that results from the conversion must be paid from a separate source (e.g.,
`usSavingsAccount` or `checkingAccount`) outside the simulation of the conversion itself.
The tax engine handles this naturally via `usOrdinaryIncomeYTD`.

---

## Architectural Fit

The framework uses a four-layer pipeline:

```
Event  →  Handler  →  Action(s)  →  Reducer(s)
```

Files live in `src/finance/account-rules/us/`.  
Tax effects are recorded by incrementing `state.usOrdinaryIncomeYTD` (and
`state.auOrdinaryIncomeYTD` for AU residents) inside a chained `*_TAX` action handled
by `src/finance/tax/us/us-tax-module-2026.js`.

The conversion follows the same reducer pattern as `IRA_ROLLOVER_WITHDRAWAL` (EVT-35) +
`ROTH_ROLLOVER_CONTRIBUTION` (EVT-41), combined into one atomic event:

- The IRA debit and Roth credit never pass through the cash pool
- A single action chain ties all side effects together in the event graph
- Supports both primary and spouse IRA/Roth account pairs

---

## Proposed New File

```
src/finance/account-rules/us/roth-conversion-classes.js
```

Follows the style of `ira-rollover-classes.js` and `roth-rollover-classes.js`.

---

## Event

### `ROTH_CONVERSION`

This event is not scheduled manually.  It is emitted by `RothConversionPolicyHandler`
(see Scheduling section below).

**Event data payload:**

```js
{
  // Required
  amount:  number,           // Full conversion amount — goes entirely into Roth, no withholding

  // Spouse vs. primary
  owner:   'primary' | 'spouse',

  // Optimization metadata (passed through to journal/graph)
  strategyId: string | null,  // e.g. 'bracket-fill-22pct'
}
```

**Account routing by owner:**

| owner | IRA source | Roth destination |
|---|---|---|
| `'primary'` | `state.iraAccount` | `state.rothAccount` |
| `'spouse'` | `state.spouseIraAccount` | `state.spouseRothAccount` |

---

## Handler

### `RothConversionHandler`

`static eventType = 'ROTH_CONVERSION'`

**Responsibilities:**

1. Resolve source/destination accounts from `data.owner`
2. Validate sufficient IRA balance (throw if `amount > iraAccount.balance`)
3. Emit actions

**Emitted action sequence:**

```
ROTH_CONVERSION_APPLY      ← debit IRA, credit Roth rolloverContribBasis (direct, no cash pool)
  └─ chains ROTH_CONVERSION_TAX   ← ordinary income (US + AU if resident)
RECORD_FIELD_VALUE          ← journal metric ('roth_conversion')
RECORD_BALANCE (iraKey)     ← balance snapshot
RECORD_BALANCE (rothKey)    ← balance snapshot
```

**Handler call signature:**

```js
call({ state, data }) {
  const { iraKey, rothKey } = resolveOwnerKeys(data.owner);
  // validate, emit actions
}
```

Where `resolveOwnerKeys('primary')` → `{ iraKey: 'iraAccount', rothKey: 'rothAccount' }`  
and `resolveOwnerKeys('spouse')` → `{ iraKey: 'spouseIraAccount', rothKey: 'spouseRothAccount' }`.

---

## Actions & Reducers

### 1. `ROTH_CONVERSION_APPLY`

**Priority:** `PRIORITY.CASH_FLOW` (20)

**Action fields:**

```js
{
  type: 'ROTH_CONVERSION_APPLY',
  amount,       // Full amount — same value enters Roth (no withholding)
  iraKey,       // 'iraAccount' or 'spouseIraAccount'
  rothKey,      // 'rothAccount' or 'spouseRothAccount'
  isAuResident,
}
```

**Reducer effect:**

- Debit `state[iraKey]` by `amount` (draws from `contributionBasis` first then `earningsBasis`,
  same `debitIra()` logic as `ira-rollover-classes.js`)
- Credit `state[rothKey].rolloverContribBasis` by `amount`
- Credit `state[rothKey].balance` by `amount`
- **No cash pool touch** — direct IRA → Roth transfer
- Chain → `ROTH_CONVERSION_TAX` with `{ amount, isAuResident }`

---

### 2. `ROTH_CONVERSION_TAX`

**Priority:** `PRIORITY.TAX_CALC` (60) — handled inside `us-tax-module-2026.js`

**Reducer effect:**

- Increment `state.usOrdinaryIncomeYTD` by `amount` (full gross; same pattern as
  `IRA_ROLLOVER_WITHDRAWAL_TAX`)
- If `isAuResident`: also increment `state.auOrdinaryIncomeYTD` and compute `state.ftcYTD`
  (same AU branch as `IRA_ROLLOVER_WITHDRAWAL_TAX` in `us-tax-module-2026.js`)

Note: US ordinary income applies regardless of `owner` — household income is tracked in a
single `usOrdinaryIncomeYTD` field.  AU treatment mirrors EVT-35 (ordinary income if resident).

---

## State Changes

No new state fields are required.

- `rothAccount.rolloverContribBasis` (and `spouseRothAccount.rolloverContribBasis`) already
  exist and track post-conversion Roth basis.
- `usOrdinaryIncomeYTD` and `auOrdinaryIncomeYTD` are already present.

---

## Scheduling: Bracket-Fill Policy (Option B)

Rather than generating static `ROTH_CONVERSION` events up front, the scenario injects
**annual policy evaluation events** that fire late in each calendar year.  The policy
handler reads live state to decide how much to convert.

### New event: `ROTH_CONVERSION_POLICY_EVALUATE`

Scheduled once per year (e.g., December 1) for each year in the conversion window.

**Event data payload:**

```js
{
  owner:             'primary' | 'spouse',
  targetIncome:      number,   // Pre-computed dollar ceiling for the target bracket
                               //   e.g. top of the 22% bracket for this year
  iraKey:            string,   // 'iraAccount' or 'spouseIraAccount'
  rothKey:           string,   // 'rothAccount' or 'spouseRothAccount'
}
```

`targetIncome` is computed once at scenario build time from the `rothConversionMaxBracket`
rate and the bracket thresholds in the tax module for the given year.

### New handler: `RothConversionPolicyHandler`

`static eventType = 'ROTH_CONVERSION_POLICY_EVALUATE'`

**Logic:**

```js
call({ state, data, date }) {
  const { owner, targetIncome, iraKey, rothKey } = data;
  const currentIncome = state.usOrdinaryIncomeYTD;
  const room          = Math.max(0, targetIncome - currentIncome);
  const iraBalance    = state[iraKey].balance;
  const amount        = Math.min(room, iraBalance);

  if (amount <= 0) return [];  // No room or no funds

  return [
    {
      type: 'ROTH_CONVERSION_APPLY',
      amount,
      iraKey,
      rothKey,
      isAuResident: state.isAuResident,
    },
    new FieldValueAction('roth_conversion', 'Roth Conversion', amount),
    new RecordBalanceAction(`${iraKey}.balance`,  iraKey),
    new RecordBalanceAction(`${rothKey}.balance`, rothKey),
  ];
}
```

**Why reads `usOrdinaryIncomeYTD` rather than pre-computing amount:**  
By December the simulation has already processed wages, dividends, RMDs, and other income
for the year.  Reading live state gives the correct remaining bracket room.

---

## Scenario Params for Optimization

Add to `INTL_RETIREMENT_DEFAULTS` in `src/scenarios/intl-retirement-scenario.js`:

```js
// Roth conversion strategy — bracket-fill mode
rothConversionEnabled:          false,  // Master switch
rothConversionStartYear:        null,   // null = retirement year
rothConversionEndYear:          null,   // null = RMD start age - 1
rothConversionMaxBracket:       0.22,   // Fill to top of this marginal bracket
rothConversionOwner:            'primary',  // 'primary' | 'spouse' | 'both'
rothConversionDayOfYear:        { month: 12, day: 1 },  // When in year the policy fires
```

Add corresponding `PARAM_SCHEMA` entries:

| key | type | label |
|---|---|---|
| `rothConversionEnabled` | `boolean` | Roth Conversion Enabled |
| `rothConversionStartYear` | `number` | Roth Conversion Start Year |
| `rothConversionEndYear` | `number` | Roth Conversion End Year |
| `rothConversionMaxBracket` | `number` | Roth Conversion Max Bracket Rate |
| `rothConversionOwner` | `select` | Roth Conversion Owner |
| `rothConversionMonth` | `number` | Roth Conversion Month (1–12) |
| `rothConversionDay` | `number` | Roth Conversion Day of Month |

### Optimization levers

| Param | Range | Role in optimizer |
|---|---|---|
| `rothConversionMaxBracket` | `0.10 .. 0.35` | Primary knob — controls how aggressively to convert |
| `rothConversionStartYear` | `retirementYear .. RMD age - 1` | Window start |
| `rothConversionEndYear` | `startYear .. RMD age - 1` | Window end |
| `rothConversionOwner` | `primary / spouse / both` | Whose IRA to convert |

### Scheduling policy events at build time

In `IntlRetirementScenario.buildSim()`, when `rothConversionEnabled`:

```js
// Pseudo-code
const owners = params.rothConversionOwner === 'both'
  ? ['primary', 'spouse']
  : [params.rothConversionOwner];

for (let year = startYear; year <= endYear; year++) {
  // bracketCeiling() is exported from us-tax-module-2026.js — bracket data in one place
  const targetIncome = bracketCeiling(params.rothConversionMaxBracket, year);
  for (const owner of owners) {
    sim.addEvent({
      date: LocalDate.of(year, params.rothConversionMonth, params.rothConversionDay),
      type: 'ROTH_CONVERSION_POLICY_EVALUATE',
      data: { owner, targetIncome, iraKey: iraKeyFor(owner), rothKey: rothKeyFor(owner) },
    });
  }
}
```

When `owner === 'both'`, two independent `ROTH_CONVERSION_POLICY_EVALUATE` events are
scheduled on the same date — one for primary, one for spouse.  They fire in order, so
the second event's policy sees `usOrdinaryIncomeYTD` already incremented by the first
conversion.  This correctly fills the bracket across both conversions combined.

---

## Requirements to Add

Add to `docs/requirements.md`:

| ID | Module | Description | Balance Effect | US Tax | AU Tax | Penalty |
|---|---|---|---|---|---|---|
| EVT-52 | Roth Conversion | IRA → Roth Conversion | −IRA, +Roth rollover contribs | Ordinary Income | Ordinary Income if resident | N |

---

## Test File

Add to `tests/unit/evt-roth-conversion.test.mjs`:

```
EVT-52: Roth Conversion — primary IRA debited, Roth rolloverContribBasis credited
EVT-52: Roth Conversion — amount does NOT flow through cash pool
EVT-52: Roth Conversion — US ordinary income recorded in usOrdinaryIncomeYTD
EVT-52: Roth Conversion — AU ordinary income recorded when isAuResident
EVT-52: Roth Conversion — no AU income when not resident
EVT-52: Roth Conversion — spouse IRA debited, spouse Roth credited
EVT-52: Roth Conversion — throws when IRA balance insufficient
EVT-52: Roth Conversion — zero amount is a no-op (policy produces nothing when already at bracket)
Bracket-fill policy — converts nothing when usOrdinaryIncomeYTD >= targetIncome
Bracket-fill policy — converts exactly the bracket room when IRA has enough
Bracket-fill policy — converts IRA balance when less than bracket room
Bracket-fill policy — spouse conversion uses spouseIraAccount
```

---

## TODO Checklist

### Phase 1 — Core Simulation Mechanics

- [ ] Create `src/finance/account-rules/us/roth-conversion-classes.js`
  - [ ] Export `debitIra()` from `ira-rollover-classes.js` and import it here
  - [ ] `RothConversionApplyReducer` — direct IRA→Roth, chains `ROTH_CONVERSION_TAX`
  - [ ] `RothConversionHandler` — validates balance, resolves owner keys, emits actions
  - [ ] `RothConversionPolicyHandler` — bracket-fill logic, emits `ROTH_CONVERSION_APPLY`
- [ ] Add `ROTH_CONVERSION_TAX` reducer in `src/finance/tax/us/us-tax-module-2026.js`
  - [ ] US ordinary income branch
  - [ ] AU ordinary income + FTC branch (same pattern as `IRA_ROLLOVER_WITHDRAWAL_TAX`)
- [ ] Register handler + reducers in the account module / tax module
- [ ] Add tests in `tests/unit/evt-roth-conversion.test.mjs`
- [ ] Add EVT-52 to `docs/requirements.md`

### Phase 2 — Scenario Params & Scheduling

- [ ] Export `bracketCeiling(rate, year)` from `us-tax-module-2026.js`
- [ ] Add `rothConversion*` params to `INTL_RETIREMENT_DEFAULTS`
- [ ] Add `PARAM_SCHEMA` entries for all new params
- [ ] Inject `ROTH_CONVERSION_POLICY_EVALUATE` events in `IntlRetirementScenario.buildSim()`
      (two events per year when `owner === 'both'`, same date, primary first)
- [ ] Integration test: full scenario with bracket-fill conversions, verify YTD income, balances

### Phase 3 — Monte Carlo & Optimization

- [ ] Add conversion params to `IntlRetirementMcRunner` distribution config
  - Perturb: `rothConversionMaxBracket`, `rothConversionStartYear`, `rothConversionEndYear`
- [ ] Design optimization loop (grid search vs. gradient-free vs. manual sweep)
- [ ] Add outcome metrics: `totalConverted`, `conversionTaxCost`, `rothFinalBalance`
- [ ] UI: show `ROTH_CONVERSION` events in timeline and journal

---

## Resolved Decisions

| # | Question | Decision |
|---|---|---|
| Q1 | AU ordinary income for IRA→Roth conversion when resident? | **Yes** — same as EVT-35 |
| Q2 | Withholding? | **No withholding** — full amount goes IRA→Roth; tax paid from external source |
| Q3 | Spouse support in Phase 1? | **Yes** — `owner: 'primary' \| 'spouse'` field; routes to spouse accounts |
| Q4 | EVT numbering | **EVT-52** (one event; no withholding variant needed) |
| Q5 | Strategy mode | **Bracket-fill (Option B)** — policy handler reads live `usOrdinaryIncomeYTD` |
| Q6 | `bracketCeiling` implementation | **Export from `us-tax-module-2026.js`** — bracket data in one place |
| Q7 | Conversion date configurable? | **Yes** — `rothConversionMonth` + `rothConversionDay` params |
| Q8 | `'both'` owner scheduling | **Two independent events, same date** — second sees YTD from first |
| Q9 | `debitIra()` sharing | **Export from `ira-rollover-classes.js`** and import in conversion file |
