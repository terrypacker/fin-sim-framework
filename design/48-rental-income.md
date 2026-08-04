# 48 — Rental Income on Real Property (dual-country, occupancy-driven, tax-aware)

**Status**: **Implemented.** All ten checklist items (§10) landed; product decisions per §2.1. Rent is **inflation-indexed** to the effective (regime-adjusted) inflation path (§4.6). `evt-rental-income.test.mjs` (EVT-RENT-1..9) + isolated reducer postconditions green; full unit suite passes; production build clean; editor round-trip browser-verified. Deferred: US §1250 recapture *rate* (§9.1), rent inflation *pass-through* knob (partial indexing), multi-owner attribution.

**Builds on**:
- `design/28-time-varying-appreciation-and-bond-duration.md` — the `RealProperty` node and its per-property annual appreciation series are the sibling mechanic; rental income is a *new monthly series* on the same node.
- The existing US/AU real-property toolsets (`src/scenarios/toolsets/us-real-property-toolset.js`, `au-real-property-toolset.js`), which already conditionally emit a monthly `*_MORTGAGE_PAYMENT` series + handler + reducer per property. Rental income is a direct parallel of that machinery.
- The income → tax two-stage pattern in `src/finance/account-rules/us/us-income-classes.js` (an `*_APPLY` reducer credits cash and *chains* a `*_TAX` action; the per-country tax module accumulates it into `usOrdinaryIncomeYTD` / `auOrdinaryIncomeYTD` / `ftcYTD`).

**Author note**: Net rental income is **ordinary income in both jurisdictions**, so the entire "both countries' tax treatment" requirement is satisfied by dropping the taxable figure into the *same* YTD accumulators wages/SE income already use — the tax modules need one new per-action-type reducer fn each, not a new tax pathway. The only genuinely new mechanics are (a) an occupancy-scaled monthly cash credit and (b) a **non-cash** deduction wedge (depreciation + mortgage interest) that makes the *taxable* number diverge from the *cash* number. The two-stage APPLY/TAX pattern models that divergence for free: the APPLY reducer carries the cash net, the chained TAX action carries the (smaller, possibly negative) taxable net.

---

## 1. Problem

`RealProperty` today models value, appreciation, a mortgage, and a planned sale. It has **no income stream**. A retiree holding an investment property — whether a long-term-leased house or a short-term/AirBnB unit — produces monthly rent, incurs deductible expenses, and pays ordinary income tax on the net in whichever country(ies) tax them. None of that is representable.

Requirements (from the design conversation):

1. **Augment the existing `RealProperty` node** with *optional* rental fields — do not introduce a new asset type. Rental off by default ⇒ every existing scenario is bit-for-bit unchanged.
2. **Full-house rental only.** No fractional / room rental. One property = one rental unit.
3. **Monthly rent** is the income granularity.
4. **Occupancy rate** as the single knob that spans use cases: `monthlyRent` is the *fully-occupied potential*, and `occupancyRate ∈ [0,1]` scales it. A 12-month lease sets occupancy ≈ 0.95 (vacancy between tenants); an AirBnB sets `monthlyRent` = fully-booked potential and occupancy ≈ 0.5–0.65. **No structural difference between short- and long-term** — the same two knobs (occupancy + expense ratio) flex both.
5. **Capture rental income, its tax effect, and both countries' treatment** as the primary goals.
6. **Simple but flexible.** Small input surface, sensible defaults, but the tax figure must be honest (interest + depreciation deductions, negative-gearing losses).

---

## 2. Goals & Non-Goals

### Goals

- Add optional rental fields to `RealProperty` (§3), defaulting to "no rental."
- A per-country **monthly `*_RENTAL_INCOME` `EventSeries`**, emitted only for properties with rental enabled, mirroring the existing mortgage series (§5).
- A **cash credit** each month of `effectiveRent − cashOpex` to the property's country cash pool.
- A **taxable-income accrual** each month of `effectiveRent − cashOpex − deductibleInterest − depreciation`, chained as a `*_RENTAL_INCOME_TAX` action into the existing ordinary-income accumulators (§6). This may be **negative** (a loss).
- **Both-country tax**: US-property rent is US ordinary income (+ AU ordinary income + FTC when AU-resident); AU-property rent is AU ordinary income when resident and always US ordinary income (worldwide). Mirrors the wages / AU-SE conventions already in the tax modules.
- **Depreciation** modeled as a non-cash deduction (US 27.5-yr straight-line on building basis; AU capital-works ~2.5%/yr), lowering taxable rental income (§4.3).
- **Negative gearing / loss offset**: a net rental loss reduces other ordinary income that year (§4.4).
- **Inflation-indexed rent**: `monthlyRent` is a base-year nominal figure that is scaled each period by the property country's cumulative *effective* (regime-adjusted) inflation factor, so rent rises through inflationary regimes and flattens / falls under deflationary ones (§4.6).

### Non-Goals (deferred — see §9)

- **US §1250 recapture *rate*** (taxing the recaptured slice at up to 25% ordinary instead of the LTCG rate). v1 **does** reduce basis by accumulated depreciation at sale (§4.5) — so the extra gain is taxed — but taxes it at the ordinary capital-gains rate. Only the US-specific 25% rate differential is deferred. (Appreciation itself never touches `costBasis` — `AssetAppreciateReducer` is mark-to-market on `value` only — so there is no basis-inflation interaction; depreciation is the *only* thing that moves basis, and it moves it **down**.)
- **Fractional / per-room rental**, multiple tenancies, or lease-term scheduling. One unit, one occupancy scalar.
- **Rent inflation *pass-through* / real growth.** Rent tracks effective inflation **1:1** (§4.6). A configurable pass-through (`rentInflationPassThrough < 1` for sticky rents) or a real-growth premium on top of inflation is a clean Phase 2 (§9). *(Note: nominal-fixed rent — the original v1 non-goal — was superseded; rent is now inflation-indexed.)*
- **US passive-activity-loss (PAL) limitation nuance.** We take the simple "loss offsets ordinary income" model (approximating the §469 \$25k active-participation allowance) rather than a full PAL carryforward engine.
- **Ownership-split attribution of rental income across `owners[]`.** v1 attributes to the primary `ownerId` (per-person maps) or the shared accumulator; multi-owner split mirrors the house-sale `accumulateByOwnership` path as Phase 2.
- **State-level (US state) rental income tax.** Follows whatever `design/34` state-income classification already does for ordinary income; no rental-specific state rule.

### 2.1 Locked product decisions

| Decision | Choice |
|---|---|
| Expense model | **Ratio + interest**: effective gross rent, minus one operating-expense ratio (mgmt/maintenance/insurance/rates), minus deductible mortgage interest. |
| Depreciation | **Modeled** (US 27.5-yr; AU ~2.5% capital works), non-cash, tax-only. |
| Net rental loss | **Offsets other ordinary income** that year (negative gearing). |

---

## 3. Data model — new optional fields on `RealProperty`

Added to `src/finance/assets/real-property.js` (all optional, all defaulting to the "no rental / neutral" value so existing scenarios are unchanged):

| Field | Type | Default | Meaning |
|---|---|---|---|
| `rentalEnabled` | boolean | `false` | Master switch. Everything below is inert when false. |
| `monthlyRent` | number | `0` | Gross **fully-occupied** monthly rent, in the property's currency. |
| `occupancyRate` | number | `0.95` | Fraction of potential realized. `effectiveRent = monthlyRent × occupancyRate`. |
| `rentalExpenseRatio` | number | `0.25` | Deductible **cash** operating expenses as a fraction of effective gross rent (management, maintenance, insurance, rates/HOA). |
| `mortgageInterestRate` | number | `0` | Annual mortgage interest rate. Deductible interest = `mortgageBalance × rate / 12`, computed against the **live** balance each month. Only relevant when mortgaged. |
| `landValueRatio` | number | `0.2` | Non-depreciable land fraction of `costBasis`. Depreciable (building) basis = `costBasis × (1 − landValueRatio)`. |
| `annualDepreciationOverride` | number \| null | `null` | Explicit annual depreciation dollar amount; when set, overrides the per-country derivation (§4.3). Flexibility escape hatch. |

**Why a ratio, not itemized dollars?** Management, maintenance, insurance, and rates all scale roughly with rent and with property size; one ratio captures the headline effect with one field. The escape hatch for people who want precision is to set the ratio to their computed blended figure. This is the "simple but flexible" middle the design conversation selected.

**Mirror the field list in five places** (the node's fields are enumerated, not spread, in each — this is the existing pattern and the checklist that keeps them in sync):

1. `RealProperty` constructor — `src/finance/assets/real-property.js`.
2. Serializer round-trip — `ScenarioSerializer._serializeRealProperty` **and** `_makeRealProperty` (`src/scenarios/scenario-serializer.js`).
3. State projection — `_propertyToStatePlain()` in **both** toolsets (so the fields land in `sim.state[stateKey]` for the handler to read).
4. Editor form — `real-property-editor.js` `render()` + `_readForm()`, and the `tpl-real-property-editor` template in `index.html` (a collapsible "Rental" fieldset).
5. Schema registry — `StateSchemaRegistry.registerAsset()` for the new money/rate state paths (§7).

---

## 4. The math (per property, per month)

Let `P = state[stateKey]` be the property's plain state.

### 4.1 Effective rent and cash flow (the APPLY side)

```
indexedRent   = P.monthlyRent × state.inflationAccumulator[cc]   // §4.6
effectiveRent = indexedRent × P.occupancyRate
cashOpex      = effectiveRent × P.rentalExpenseRatio
netCash       = effectiveRent − cashOpex                 // credited to the cash pool
```

`netCash` is credited to the property's country cash pool (`usSavingsAccount`/`auSavingsAccount`, falling back to `checkingAccount` — same resolution the mortgage/income classes use). **Mortgage principal + interest is NOT subtracted here** — the existing monthly `*_MORTGAGE_PAYMENT` series already debits the full mortgage payment from the same cash pool. Subtracting it here would double-count. Rental cash and mortgage cash are independent debits/credits on the pool.

### 4.2 Deductible interest (tax-only wedge #1)

```
deductibleInterest = P.mortgageBalance × P.mortgageInterestRate / 12
```

Computed against the **current** `mortgageBalance`, so the deduction shrinks as the loan amortizes — an honest approximation without needing a full amortization schedule (the mortgage machinery treats `monthlyMortgage` as a flat payment and does not itself split principal/interest; this design derives interest independently rather than refactoring that).

### 4.3 Depreciation (tax-only wedge #2, non-cash)

```
buildingBasis      = P.costBasis × (1 − P.landValueRatio)
annualDepreciation = P.annualDepreciationOverride
                     ?? (country === 'US' ? buildingBasis / 27.5      // MACRS residential SL
                                          : buildingBasis × 0.025)     // AU Div 43 capital works ~2.5%
monthlyDepreciation = annualDepreciation / 12
```

Depreciation is **non-cash**: it appears only in the taxable figure (§4.4), never in `netCash` (§4.1). Each month the handler also increments `P.accumulatedDepreciation += monthlyDepreciation` (a running state field) — used *now* at sale to reduce basis (§4.5), and available for the US recapture-rate phase (§9).

### 4.4 Taxable rental income (the TAX side)

```
taxableRental = effectiveRent − cashOpex − deductibleInterest − monthlyDepreciation
```

This is the `amount` carried by the chained `*_RENTAL_INCOME_TAX` action. **It can be negative** — a leveraged, depreciating property commonly runs a taxable loss even while cash-flow-positive. Because the tax module adds `taxableRental` directly to `usOrdinaryIncomeYTD` / `auOrdinaryIncomeYTD`, a negative value **naturally reduces** the accumulator and offsets other income (the locked "negative gearing" behavior) — no special-casing needed. The only guard: FTC must not go negative in a loss year (`ftcYTD += max(0, taxableRental)`).

### 4.5 At sale: basis reduction by accumulated depreciation

Depreciation deducted during the hold is not free — it lowers the property's tax basis, so the disposal gain is larger. Without this, modeling depreciation would grant a permanent tax cut where reality gives (mostly) a deferral. The existing `Us/AuHouseSaleApplyReducer` already carry `costBasis` and can read `state[stateKey].accumulatedDepreciation`; the change is to compute an adjusted basis:

```
adjustedBasis = max(0, costBasis − (P.accumulatedDepreciation ?? 0))
gain          = max(0, salePrice − adjustedBasis)        // was: salePrice − costBasis
```

- **AU — fully correct.** Div 43 capital-works deductions reduce the CGT cost base; the larger `gain` flows through `AU_HOUSE_SALE_TAX` and the 50% CGT discount / existing per-owner path unchanged. No separate recapture regime exists in AU, so nothing else is needed.
- **US — mostly correct, one deferral.** The larger `gain` is taxed via `US_HOUSE_SALE_TAX` (after the \$500K primary-residence exemption, which rental properties won't qualify for). The only simplification vs. the IRC is that the recaptured slice (min(gain, accumulatedDepreciation)) is taxed at the ordinary **capital-gains** rate rather than the up-to-25% unrecaptured-§1250 rate. That rate differential is the sole deferred item (§9.1) — the *dollars* are captured now.

Both sale reducers already zero the property `value`/`mortgageBalance`; `accumulatedDepreciation` can be left as-is (property is disposed) or zeroed — cosmetic.

### 4.6 Inflation-indexed rent (effective, regime-aware)

`monthlyRent` is a **base-year nominal** input — the same convention `person.monthlyWage` uses. Each month the handler scales it by the property country's cumulative inflation factor before any other arithmetic:

```
indexedRent = P.monthlyRent × (state.inflationAccumulator[cc] ?? 1)
```

- **Why `inflationAccumulator[cc]` and not a fresh compounding?** `InflationAdjustReducer` already maintains `state.inflationAccumulator[cc]` — a running factor seeded at `1.0` and multiplied by `1 + state.effectiveInflationRates[cc]` on each annual `*_PERIOD_ADVANCE`. That effective rate is the **regime-adjusted** inflation from design 21 (`effectiveInflationRates` falls back to `inflationRates` when no regime is active). So the accumulator already integrates the *effective* inflation path over time — reading it is the whole mechanism. No new plumbing into the regime stack, no separate rent-growth series.
- **Regime asymmetry falls out for free.** An inflationary regime (`inflationAdjustment[cc] > 0`) lifts the effective rate, so the accumulator compounds faster and rent rises. A deflationary regime can push `effectiveInflationRates[cc]` **negative**, making the annual factor `< 1`, so the accumulator (and rent) **flatten or fall** — exactly the requested behavior.
- **Only rent is indexed.** `cashOpex` is a ratio of the already-indexed `effectiveRent`, so it scales automatically. `deductibleInterest` is derived from the live `mortgageBalance`. Depreciation is on the **historical** `costBasis` and must *not* inflate (basis is fixed at acquisition). So indexing `monthlyRent` alone keeps every downstream figure consistent.
- **Read-time scaling, no mutation.** Unlike wages (which `InflationAdjustReducer` mutates in `state.people`), rent is indexed at read time inside `computeRentalMonth(p, propState, cc, inflationFactor)`. The stored `monthlyRent` stays the base-year figure, so serialize round-trips and the editor always show the user's entered value; nothing double-counts at sale (basis is untouched by rent indexing).
- **Determinism & back-compat.** `inflationAccumulator[cc]` is `1.0` until the first annual advance, so month-1 behavior is unchanged. A scenario with zero inflation and no regime keeps the accumulator at `1.0` forever — rent is nominal-flat, identical to the pre-indexing behavior.

**Pass-through is 1:1 in v1.** Real-world rents are sticky and often lag CPI; a `rentInflationPassThrough ∈ [0,1]` knob (scaling `inflationFactor` toward `1.0`) is the natural Phase 2 refinement (§9) but is out of scope here — the locked decision is full pass-through.

---

## 5. Scheduling & wiring (toolset changes)

Both `US_REAL_PROPERTY` and `AU_REAL_PROPERTY` toolsets gain a rental branch, structurally identical to their existing mortgage branch.

**`schedules(context)`** — add, per country:

```js
const rentalProps = countryProps.filter(p => p.rentalEnabled && (p.monthlyRent ?? 0) > 0);
if (rentalProps.length > 0) {
  schedules.push(new EventSeries({
    name: 'US Rental Income', type: 'US_RENTAL_INCOME',
    interval: 'month-end', order: 0,          // income before the mortgage debit (order 0 vs default)
    enabled: true, color: '#2E7D32',
  }));
}
```

`order: 0` (income) sequences ahead of same-date expense debits so the cash credit lands before the mortgage payment tries to draw the pool (consistent with the event-queue date-only ordering rule — income order 0, settles 100/101).

**`handlers(context)`** — add a `UsRentalIncomeHandler` / `AuRentalIncomeHandler` carrying the per-property rental params (list of `{ stateKey, monthlyRent, occupancyRate, rentalExpenseRatio, mortgageInterestRate, landValueRatio, annualDepreciationOverride }`), exactly like `UsMortgagePaymentHandler` carries `{ stateKey, monthlyMortgage }`.

**`reducers(context)`** — add the matching `*RentalIncomeApplyReducer` (guarded on `rentalProps.length > 0`).

**`types.actions`** — register the two new action types (§6) for the type registry / serializer.

---

## 6. New classes and tax hooks

### 6.1 `src/finance/account-rules/rental-income-classes.js` (US + AU in one file)

Follows `mortgage-payment-classes.js` (both countries colocated).

- **`UsRentalIncomeHandler` / `AuRentalIncomeHandler`** (`extends HandlerEntry`, `eventType 'US_RENTAL_INCOME'` / `'AU_RENTAL_INCOME'`): iterate `this.properties`; for each with `state[stateKey]` present and `monthlyRent > 0`, compute the §4 figures and emit:
  - `{ type: 'US_RENTAL_INCOME_APPLY', stateKey, netCash, taxableRental, monthlyDepreciation, residency, personKey }`
  - a `RecordBalanceAction` on the cash pool.
  - `generatedActionTypes = ['US_RENTAL_INCOME_APPLY', 'RECORD_BALANCE']`.
- **`UsRentalIncomeApplyReducer` / `AuRentalIncomeApplyReducer`** (`extends AccountServiceReducer`, `PRIORITY.CASH_FLOW`): credit the cash pool by `netCash`, increment `state[stateKey].accumulatedDepreciation`, and chain `{ type: 'US_RENTAL_INCOME_TAX', amount: taxableRental, residency, personKey }`. `generatedActionTypes = ['US_RENTAL_INCOME_TAX']`.

`residency` and `personKey` are resolved from `state.people` the same way the income handlers do (primary person for v1).

### 6.2 Tax module reducer fns

Add a `_rentalReducerFns()` to the US and AU tax modules and include it in `getReducerFns()`. **Register in all active years' modules** (2024/2025/2026) — the dynamic tax reducer (`TaxEngine.registerDynamic`) picks the highest year ≤ current period, so a fn present only on 2026 would silently skip rental tax for earlier years.

US module (`US_RENTAL_INCOME_TAX`) — mirror of `WAGES_INCOME_TAX` (US-sourced):
```js
['US_RENTAL_INCOME_TAX', (state, action) => {
  const { amount, residency } = action;           // amount may be negative (loss)
  let next = { ...state, usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount };
  if (residency === 'AU') {
    next = { ...next,
      auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + amount,
      ftcYTD: state.ftcYTD + Math.max(0, amount) };  // no negative FTC
  }
  return next;
}]
```

AU module (`AU_RENTAL_INCOME_TAX`) — mirror of `AU_SE_INCOME_TAX` (AU-sourced, always US ordinary income for worldwide reporting):
```js
['AU_RENTAL_INCOME_TAX', (state, action) => {
  const { amount, residency } = action;
  let next = { ...state, usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount };
  if (residency === 'AU') {
    next = { ...next,
      auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + amount,
      ftcYTD: state.ftcYTD + Math.max(0, amount) };
  }
  return next;
}]
```

(Per-person attribution via `auPersonOrdinaryIncomeYTD[personKey]` can follow the wages/AU-SE `usePerPerson` fallback if per-person maps are present; v1 may ship the shared-accumulator form and add per-person in the same PR if cheap.)

---

## 7. Display / schema registration

`StateSchemaRegistry.registerAsset()` gains money-typed paths for the new state fields so the chart / state-panel / timeline format them in the property's native currency:

```
${stateKey}.monthlyRent, ${stateKey}.accumulatedDepreciation   → currency(code)
${stateKey}.occupancyRate, ${stateKey}.rentalExpenseRatio,
${stateKey}.mortgageInterestRate, ${stateKey}.landValueRatio     → rate()/percentage()
```

The `*_RENTAL_INCOME_APPLY` / `*_RENTAL_INCOME_TAX` action fields register their `ValueType`s in the toolset `types.actions` block (currency for `netCash`/`amount`, number for the rest), exactly like the income and mortgage action definitions.

No change to net-worth or after-tax derived metrics: rental cash lands in the cash pool (already counted) and rental tax lands in the ordinary-income accumulators (already flow into the annual settle). The design deliberately reuses those seams.

---

## 8. Testing (`tests/unit/evt-rental-income.test.mjs`, `EVT-X` convention)

- **EVT-RENT-1 (US, cash):** enabled US property, `monthlyRent 3000`, `occupancy 0.9`, `expenseRatio 0.25`, no mortgage → cash pool credited `3000×0.9×0.75 = 2025`/mo; `usOrdinaryIncomeYTD` accrues `effectiveRent − opex − depreciation` (12×).
- **EVT-RENT-2 (US, negative gearing):** high `mortgageInterestRate` + depreciation drives `taxableRental < 0` while `netCash > 0`; assert `usOrdinaryIncomeYTD` *decreases* and `ftcYTD` does not go negative.
- **EVT-RENT-3 (AU, resident):** AU property, AU resident → both `auOrdinaryIncomeYTD` and `usOrdinaryIncomeYTD` accrue; `ftcYTD` tracks the positive part.
- **EVT-RENT-4 (occupancy spans STR/LTR):** same `monthlyRent`, occupancy 0.55 vs 0.95 → proportional cash + taxable.
- **EVT-RENT-5 (off by default):** `rentalEnabled` unset ⇒ no `*_RENTAL_INCOME` series scheduled, byte-identical state vs. a pre-feature baseline.
- **EVT-RENT-6 (round-trip):** serialize → deserialize a rental property; all seven fields survive.
- **EVT-RENT-7 (depreciation accrual):** `accumulatedDepreciation` grows by `annualDepreciation/12` each month and matches `annualDepreciation` after 12 months.
- **EVT-RENT-8 (basis reduction at sale):** hold a rental property N years then sell; assert `US_HOUSE_SALE_TAX.gain` uses `costBasis − accumulatedDepreciation` (larger than the no-depreciation gain by exactly the accumulated amount, pre-exemption). AU variant asserts the same on `AU_HOUSE_SALE_TAX.gain`.
- **EVT-RENT-9 (inflation-indexed rent):** with a nonzero inflation rate, step past an annual `*_PERIOD_ADVANCE`; assert the monthly `netCash` credited scales by `inflationAccumulator[cc]` (rent > month-1 rent), and that month-1 (accumulator `1.0`) matches the un-indexed figure (§4.6).

Run `npm run test:unit` + `npm run requirements`, then browser-verify the editor's new Rental fieldset and a rental scenario end-to-end (README convention: UI changes need browser verification).

---

## 9. Future enhancements (explicitly deferred)

1. **US §1250 recapture rate** — v1 already reduces basis by `accumulatedDepreciation` at sale (§4.5), so the extra gain is taxed; this phase only splits that recaptured slice out to the up-to-25% unrecaptured-§1250 rate (new tax accumulator + rate handling in the capital-gains calc) instead of the ordinary LTCG rate. Bounded rate differential, not a missing-dollars gap.
2. **Rent inflation pass-through / real growth** — rent already tracks *effective* inflation 1:1 (§4.6). This phase adds a `rentInflationPassThrough ∈ [0,1]` (sticky-rent lag) and/or a real-growth premium layered on top of the inflation factor.
3. **Multi-owner attribution** — split rental income across `owners[]` via the house-sale `accumulateByOwnership` helper.
4. **US passive-activity-loss carryforward** — replace the simple loss-offset with a §469 suspended-loss engine.
5. **Vacancy stochasticity** — drive `occupancyRate` off `sim.rng` / a regime for MC (parallels design 47's approach).

---

## 10. Implementation checklist (in dependency order)

1. `RealProperty` constructor: 7 new fields (§3).
2. `ScenarioSerializer._serializeRealProperty` + `_makeRealProperty`: same 7 fields + `accumulatedDepreciation`.
3. `rental-income-classes.js`: US + AU handler/reducer pairs (§6.1).
4. Tax modules 2024/2025/2026 (US + AU): `_rentalReducerFns()` (§6.2).
5. Both real-property toolsets: `_propertyToStatePlain` fields, `schedules()`/`handlers()`/`reducers()` rental branch, `types.actions` (§5).
6. `Us/AuHouseSaleApplyReducer`: subtract `accumulatedDepreciation` from basis before computing gain (§4.5) — small edit to the two existing reducers.
7. `StateSchemaRegistry.registerAsset()`: new paths (§7).
8. Editor + `index.html` template: collapsible Rental fieldset (§3).
9. `evt-rental-income.test.mjs` (§8); `npm run build:index`; browser-verify.
</invoke>
