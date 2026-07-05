# 50 — AU-source Wages (currency-routed, residency-aware tax)

**Status**: **Implemented.** `MonthlyWagesHandler` routes each person's wage by
`wageCurrency`; a new `AU_WAGES_INCOME_APPLY` / `AU_WAGES_INCOME_TAX` chain deposits
AUD wages into the AUD account and taxes them AU-source. Full unit suite green
(3094 tests, incl. new `AuWagesIncome` postcondition + coverage-manifest row);
requirements 84/84; production build clean; browser-verified against the
"Terry Jeanne Evaluation" cross-border scenario (US-resident spouse paid in AUD).

**Builds on**:
- `design/10` currency work (Phases 4/5): `person.wageCurrency` already exists and
  is stamped into the schema registry for **display** conversion. This design wires
  that same field into the **runtime deposit + tax** path, which it never touched.
- The income → tax two-stage pattern in `src/finance/account-rules/us/us-income-classes.js`
  (an `*_APPLY` reducer credits cash and *chains* a `*_TAX` action; the per-country
  tax module accumulates it into the YTD buckets).
- The existing AU-source income reducers (`AU_SAVINGS_EARNINGS_TAX`,
  `AU_FIXED_INCOME_EARNINGS_TAX` in `au-tax-module-2026.js`), which already model the
  resident-vs-non-resident split (AU ordinary income vs AU non-resident withholding,
  both + FTC). Wages were the one income type that never got this treatment.

**Author note**: The bug report was "a spouse's AUD wage was recorded as USD in a US
account." Root cause: `wageCurrency` was a **display-only** annotation. The wage
pipeline — `MonthlyWagesHandler` → `WAGES_INCOME_APPLY` → `WagesIncomeApplyReducer`
→ `WAGES_INCOME_TAX` — was entirely currency-blind: it always routed to the US cash
pool, deposited the raw number as USD, and taxed it as US wages. The fix has two
independent axes that the old code conflated: **`wageCurrency` is the source /
denomination** (AUD ⇒ AU-source), **`residency` is who earns it** (a US-resident
spouse). Decoupling them is the whole design.

---

## 1. Problem

A person can be paid in a currency other than their residence country's. The
motivating case: a **US-resident** spouse drawing an **AUD** salary from an AU
employer. Requirements from the report:

1. An AUD wage must be **recorded and deposited into the AUD account** (native AUD),
   not coerced into USD in the US savings pool.
2. Tax treatment must be correct **for a US-resident earner of AU-source income** —
   i.e. the AU **non-resident** path, not the AU-resident path, while still being
   US worldwide income with a foreign tax credit.

Before this design, `wageCurrency` fed only `StateSchemaRegistry.registerPerson()`
(display formatting). Nothing in the runtime read it.

---

## 2. Goals & Non-Goals

### Goals
- Route each person's monthly wage by `wageCurrency`: `USD` → US cash pool
  (unchanged); `AUD` → AU cash pool as **native AUD**.
- A new `AU_WAGES_INCOME_APPLY` / `AU_WAGES_INCOME_TAX` chain mirroring the AU-SE /
  AU-savings income machinery.
- **Residency-aware AU tax**: earner is AU resident → AU ordinary income + FTC;
  earner is a non-resident (e.g. US-resident spouse) → AU **non-resident
  withholding** + FTC; **always** US ordinary income (worldwide).
- Attribute the wage to the **earner** (`personKey`), like `AU_SE_INCOME_TAX` — not
  to the AU account's owner.
- Inflate an AUD wage at the **AU** CPI path, a USD wage at the **US** path (§5).
- Zero behavior change for existing (USD-wage) scenarios.

### Non-Goals (deferred)
- **Currencies beyond USD/AUD.** The model is a US/AU two-country world; routing is
  `wageCurrency === 'AUD' ? AU : US`. A third currency needs a general currency→pool
  resolver (the `FxService.settlement(currency)` map is the natural seam).
- **Tax-bucket FX normalization.** The AU-source reducers (this one included) add the
  native AUD `amount` straight into the USD `usOrdinaryIncomeYTD` bucket without FX
  conversion — the existing tax engine treats the YTD buckets as 1:1. This design
  **matches that existing convention** rather than introducing a lone conversion.
  Normalizing every AU-source amount into USD at tax time is a separate, larger
  design touching every `AU_*_TAX` reducer, not just wages.
- **Per-employer / mid-year currency switch, FX withholding, treaty rate tables.**
  Non-resident withholding uses the existing flat AU NR rate.

---

## 3. Routing — `MonthlyWagesHandler` (`src/finance/handlers/monthly-wages-handler.js`)

Per person with `monthlyWage > 0` and before `retirementDate`:

```js
const isAud = person.wageCurrency === 'AUD';
actions.push(isAud
  ? { type: 'AU_WAGES_INCOME_APPLY', amount: wage, residency: person.residency ?? null, personKey: key }
  : { type: 'WAGES_INCOME_APPLY',    amount: wage, residency: person.residency ?? null, personKey: key });
touched.add(isAud ? auCashKey : usCashKey);   // us/au SAVINGS state keys via stateRegistry
```

A `RecordBalanceAction` is emitted **once per cash pool actually credited** (a `Set`),
so a mixed-currency household (USD primary + AUD spouse) records both balances.
`generatedActionTypes` gains `AU_WAGES_INCOME_APPLY`. The deposit is the **native**
wage figure — no FX coercion (that was the reported bug).

---

## 4. New classes and tax hook

### 4.1 `AuWagesIncomeApplyReducer` (`src/finance/account-rules/au/au-income-classes.js`)

Mirror of `AuSeIncomeApplyReducer` (`extends AccountServiceReducer`, `PRIORITY.CASH_FLOW`):
credits `auCash(state)` by the native `amount` and chains
`{ type: 'AU_WAGES_INCOME_TAX', amount, residency, personKey }`.
`actionType 'AU_WAGES_INCOME_APPLY'`, `generatedActionTypes ['AU_WAGES_INCOME_TAX']`.

### 4.2 `AU_WAGES_INCOME_TAX` reducer fn (`au-tax-module-2026.js`, `_auWagesReducerFns()`)

Included in `getReducerFns()`; inherited by the 2025/2024 subclasses (they don't
override it), so all active years are covered. Mirror of `AU_SAVINGS_EARNINGS_TAX`
but attributed by **`personKey`** (the earner) rather than by account ownership:

```js
['AU_WAGES_INCOME_TAX', (state, action) => {
  const { amount, residency, personKey } = action;
  const isAuResident = residency === 'AU';
  let next = { ...state, usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount };  // worldwide
  if (isAuResident) {
    const perPerson = personKey != null && state.auPersonOrdinaryIncomeYTD != null;
    next = { ...next,
      ...(perPerson
        ? { auPersonOrdinaryIncomeYTD: { ...state.auPersonOrdinaryIncomeYTD, [personKey]: (state.auPersonOrdinaryIncomeYTD[personKey] ?? 0) + amount } }
        : { auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + amount }),
      ftcYTD: state.ftcYTD + amount };
  } else {
    const perPerson = personKey != null && state.auPersonNonResidentWithholdingYTD != null;
    next = { ...next,
      ...(perPerson
        ? { auPersonNonResidentWithholdingYTD: { ...state.auPersonNonResidentWithholdingYTD, [personKey]: (state.auPersonNonResidentWithholdingYTD[personKey] ?? 0) + amount } }
        : { auNonResidentWithholdingYTD: state.auNonResidentWithholdingYTD + amount }),
      ftcYTD: state.ftcYTD + amount };
  }
  return next;
}]
```

**This is where the "US-resident, not AU-resident" requirement is satisfied**: the
earner's `residency` (`'US'`) drives `isAuResident === false`, so the wage books AU
**non-resident withholding** + FTC and **no** AU resident ordinary income. An
AU-resident earner takes the ordinary-income branch. No new tax pathway — reuses the
`auOrdinaryIncomeYTD` / `auNonResidentWithholdingYTD` / `ftcYTD` accumulators (and
their per-person maps) that already flow into `au-tax-document-2026.js` (the
"Non-Resident Withholding Income" line, resident § 15% NR tax).

### 4.3 Wiring

- `au-income-toolset.js` (`AU_INCOME`): register `AuWagesIncomeApplyReducer` in
  `types.reducers` + `reducers()`; add `AU_WAGES_INCOME_APPLY` / `AU_WAGES_INCOME_TAX`
  action `ValueType`s (`currency('AUD')`, `text`, `text`). The apply action is
  dispatched by `MonthlyWagesHandler` (owned by the retirement toolsets), so any
  cross-border scenario that includes `AU_INCOME` has the reducer.
- `scenario-serializer.js`: import + add `AuWagesIncomeApplyReducer` to `_ALL_CLASSES`.

---

## 5. Wage inflation by currency (`inflation-adjust-reducer.js`)

`InflationAdjustReducer` previously inflated **every** person's `monthlyWage` at the
US rate (the "wages are USD" assumption). An AUD wage should track AU CPI. The fix,
still driven off the always-annual US advance (so it fires every year regardless of a
mid-year move), picks the rate by the wage's currency country:

```js
const rateFor = (code) => {
  const wcc = code === 'AUD' ? 'AU' : 'US';
  return state.effectiveInflationRates?.[wcc] ?? state.inflationRates?.[wcc] ?? 0;
};
// per person: monthlyWage *= 1 + rateFor(person.wageCurrency)
```

Social Security stays US-rate. With equal US/AU inflation (or zero), behavior is
unchanged — existing scenarios are unaffected.

---

## 6. Testing

- **Unit — `reducer-postconditions-au.test.mjs`**: `AuWagesIncome` postcondition —
  credits `auSavingsAccount` by native AUD (§4.4 cash invariant); added to the
  `reducer-coverage-manifest.js` COVERED list.
- **Handler routing (verified in dev)**: two-person state (USD primary + AUD spouse)
  → primary emits `WAGES_INCOME_APPLY`, spouse emits `AU_WAGES_INCOME_APPLY`; the AU
  reducer credits `auSavingsAccount` (50000 → 52000), not the US pool.
- **Tax branching (verified in dev)**: `AU_WAGES_INCOME_TAX` with `residency:'US'`
  → `usOrdinaryIncomeYTD += amount`, `auPersonNonResidentWithholdingYTD[earner] += amount`,
  `ftcYTD += amount`, `auOrdinaryIncomeYTD == 0`. With `residency:'AU'` → ordinary-income branch.
- **Regression**: full `npm run test:unit` (3094) + `npm run requirements` (84/84) green.
- **Browser**: ran the cross-border scenario end-to-end; AUD spouse wage flows to the
  AUD account.

---

## 7. Future enhancements (deferred)

1. **General currency→pool routing** for a third currency (via `FxService.settlement`).
2. **Tax-bucket FX normalization** — convert every AU-source amount into USD at tax
   time across all `AU_*_TAX` reducers (removes the 1:1 bucket simplification, §2).
3. **Withholding on the AUD wage itself** (PAYG) — a `AU_WAGES_WITHHELD` sibling to the
   US `WAGES_WITHHELD` path.
4. **UI**: surface `wageCurrency` prominently in the person editor with a note that it
   drives the deposit account, not just display.

---

## 8. Implementation checklist

1. `au-income-classes.js`: `AuWagesIncomeApplyReducer` (§4.1).
2. `monthly-wages-handler.js`: route by `wageCurrency`, per-pool `RecordBalance` (§3).
3. `au-tax-module-2026.js`: `_auWagesReducerFns()` + include in `getReducerFns()` (§4.2).
4. `au-income-toolset.js`: register reducer + action types (§4.3).
5. `scenario-serializer.js`: import + `_ALL_CLASSES` (§4.3).
6. `inflation-adjust-reducer.js`: per-currency wage inflation (§5).
7. `reducer-postconditions-au.test.mjs` + `reducer-coverage-manifest.js` (§6).
