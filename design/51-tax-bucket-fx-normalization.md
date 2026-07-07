# 51 — Tax-bucket FX normalization (single canonical currency per accumulator)

**Status**: **Implemented.** `src/finance/tax/tax-fx.js` (`toCcy`/`toUSD`/`toAUD`)
normalizes every cross-currency write in the US and AU tax modules and the state
income classifier into each accumulator's canonical currency at the event rate.
The `ordinary-income-by-source` drill now sums the FX-normalized `usOrdinaryIncomeYTD`
stateDelta (per-diff) rather than the native `amount`, so it still matches the Form
1040 gross line. Full unit suite green (3094 + new `tax-fx-normalization.test.mjs`,
8 cases), viz 831, requirements 84/84, build clean; the cross-border evt/tax goldens
were regolded to the converted figures (each reads the rate from
`sim.state.effectiveExchangeRates.USD_AUD`); browser-verified a US+AU scenario end to
end (no console errors). Follow-up to `design/50-au-source-wages.md` §2/§7.

**Builds on**:
- `design/10` currency infrastructure — `CurrencyConverter` (`src/finance/fx/currency-converter.js`)
  already converts an amount between currency codes using a state snapshot's
  `state.effectiveExchangeRates`. This is the exact seam we accrue through.
- `design/47` time-varying FX — `effectiveExchangeRates.USD_AUD` is refreshed each
  period, so accruing at "the rate as-of the income event" tracks the varying path
  for free.
- `src/finance/fx/expense-fx.js` `convertExpenseToAccount()` — the established
  precedent for "convert a native figure into a target currency at the run's recorded
  rate, fall back to native when no rate." We generalize the same move to tax buckets.

**Author note**: The bug that motivated design 50 (an AUD wage booked as USD) was one
symptom of a deeper invariant violation: **the year-to-date tax accumulators are
currency-agnostic bags of numbers, but the tax computations that consume them assume
a single currency.** `usOrdinaryIncomeYTD` is spent in USD (`UsTaxRatesBase.computeTax`);
`auOrdinaryIncomeYTD` is spent in AUD (`AuTaxRatesBase.computeTax`). Yet the income
reducers add **native** amounts from *both* countries into *both* sides. This design
does not touch the tax math or the FTC model — it only guarantees every number
entering a bucket is first expressed in that bucket's canonical currency.

---

## 1. Problem

The mixing is **bidirectional**. Two concrete leaks, both live today:

**(a) AU-source income (AUD) → US buckets (USD).** Every `AU_*_TAX` reducer adds its
native AUD `amount` straight into `usOrdinaryIncomeYTD` (worldwide income) and
`ftcYTD`. Example: `AU_WAGES_INCOME_TAX` with `amount = 2000` (A$) does
`usOrdinaryIncomeYTD += 2000`, treating A$2,000 as US$2,000. At the default rate
1.55, the correct figure is **US$1,290**. US ordinary income is overstated ~55%.

**(b) US-source income (USD) → AU buckets (AUD).** Every US-source reducer, in its
`isAuResident` branch, adds its native USD `amount` into `auOrdinaryIncomeYTD` /
`auPersonOrdinaryIncomeYTD`. Example: `WAGES_INCOME_TAX` with `amount = 8000` (US$)
does `auPersonOrdinaryIncomeYTD[key] += 8000`, treating US$8,000 as A$8,000. Correct
is **A$12,400**. AU ordinary income is understated ~35%.

`ftcYTD` is a third victim: it is consumed as a **USD** credit
(`credits = min(ftcYTD, grossTax)` in `us-tax-rates-base.js:85`) but accreted from
both USD (`taxable`, correct) and AUD (`amount`, wrong) sources.

Because `effectiveExchangeRates.USD_AUD` is seeded from `exchangeRateUsdToAud`
(default **1.55**) at scenario start **regardless of the FX process model** — even
`fxProcessModel: NONE` — the rate is never 1:1 in a cross-border scenario. So this is
a real, always-on error in every US+AU scenario's tax bill, not an edge case.

---

## 2. Goals & Non-Goals

### Goals
- **Invariant**: every YTD tax accumulator has exactly one *canonical currency*, and
  every write into it is expressed in that currency (§3).
- Convert cross-currency income at the **rate as-of the income event**
  (`state.effectiveExchangeRates` at the moment the `*_TAX` reducer runs), via
  `CurrencyConverter` — the same seam expense FX uses.
- **Fall back to native** when no rate/pair is recorded (never silently assume 1:1) —
  matching `convertExpenseToAccount` / the converter's `null` contract.
- Zero behavior change when source == target currency, when the rate is 1.0, or when
  no pair is registered (single-country scenarios are byte-identical).

### Non-Goals (deferred)
- **The FTC model itself.** `ftcYTD` accumulates *income* and is credited as a dollar
  amount (`min(ftcYTD, grossTax)`) — an "AU tax fully relieves US tax up to gross"
  simplification. This design only guarantees `ftcYTD` is in **USD**; it does not
  replace the income-as-credit approximation with a true foreign-tax-paid credit.
- **Rate convention nuance.** Real returns use an annual average (or spot at each
  accrual) FX rate. We accrue at **monthly spot** (the rate live when the income
  event fires). Averaging is a possible refinement, not part of this.
- **Retroactive re-valuation of a saved mid-year state.** YTD buckets reset at the
  annual settle (§7), so a persisted snapshot only carries an in-flight partial year;
  we do not re-translate already-accrued figures at a later rate.

---

## 3. Canonical currency per bucket

| Bucket | Canonical | Consumed by |
|---|---|---|
| `usOrdinaryIncomeYTD`, `usNegativeIncomeYTD` | **USD** | `UsTaxRatesBase.computeTax` |
| `usCapitalGainsYTD`, `usCollectibleGainsYTD`, `usPenaltyYTD` | **USD** | " |
| `ftcYTD` | **USD** | `min(ftcYTD, grossTax)` in US calc |
| `auOrdinaryIncomeYTD`, `auPersonOrdinaryIncomeYTD` | **AUD** | `AuTaxRatesBase.computeTax` |
| `auNonResidentWithholdingYTD`, `auPersonNonResidentWithholdingYTD` | **AUD** | " |
| `auCapitalGainsYTD`, `auPersonCapitalGainsYTD` | **AUD** | " |
| `auFrankingCreditYTD`, `auPersonFrankingCreditYTD` | **AUD** (inherently) | " |
| `auSuperTaxYTD`, `auPersonSuperTaxYTD` | **AUD** (computed in AUD) | " |
| `stateOrdinaryIncomeYTD`, `stateCapitalGainsYTD`, `stateSsIncomeYTD`, `statePensionIncomeYTD` | **USD** | `state-tax-*` |

Franking, super-tax, and NR-withholding buckets are only ever written from AU-source
(AUD) reducers, so they already hold AUD — no conversion needed, but they are listed
so the invariant is total.

---

## 4. Mechanism

### 4.1 Key observation — source currency is known per module

The cross-currency writes fall on a clean module boundary:

- **US tax module reducers** (`WAGES_INCOME_TAX`, `SS_INCOME_TAX`, `SE_INCOME_US_TAX`,
  `BONUS_TAX`, US CGT) process **US-source** income → `amount` is **USD**. They write
  USD-native to US buckets and (AU-resident branch) need **USD→AUD** for AU buckets.
- **AU tax module reducers** (`AU_WAGES_INCOME_TAX`, `AU_SE_INCOME_TAX`,
  `AU_SAVINGS_EARNINGS_TAX`, `AU_FIXED_INCOME_EARNINGS_TAX`, `AU_RENTAL_INCOME_TAX`,
  AU dividends, AU CGT) process **AU-source** income → `amount` is **AUD**. They write
  AUD-native to AU buckets and need **AUD→USD** for `usOrdinaryIncomeYTD` / `ftcYTD`.

So each reducer's source currency is a **compile-time constant of the module it lives
in** — no need to thread a `sourceCurrency` field onto every action.

### 4.2 Shared helper

A single stateless module — `src/finance/tax/tax-fx.js` — wrapping the existing
converter:

```js
import { CurrencyConverter } from '../fx/currency-converter.js';
const _c = new CurrencyConverter();

/** Convert `amount` from `fromCcy` into `toCcy` at the state's recorded rate;
 *  returns the native amount when the currencies match or no rate exists. */
export function toCcy(amount, fromCcy, toCcy_, state) {
  if (amount == null || fromCcy === toCcy_) return amount;
  const v = _c.convert(amount, fromCcy, toCcy_, state);
  return v == null ? amount : v;
}
export const toUSD = (amount, from, state) => toCcy(amount, from, 'USD', state);
export const toAUD = (amount, from, state) => toCcy(amount, from, 'AUD', state);
```

### 4.3 Reducer edits (illustrative)

AU module, AU-source (`amount` is AUD) — e.g. `AU_WAGES_INCOME_TAX`:

```js
const usd = toUSD(amount, 'AUD', state);            // convert once for USD buckets
let next = { ...state, usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + usd };
// AU buckets stay native AUD:
if (isAuResident) next = { ...next, auPersonOrdinaryIncomeYTD: {…+ amount}, ftcYTD: state.ftcYTD + usd };
else              next = { ...next, auPersonNonResidentWithholdingYTD: {…+ amount}, ftcYTD: state.ftcYTD + usd };
```

US module, US-source (`amount` is USD) — e.g. `WAGES_INCOME_TAX`:

```js
let next = { ...state, usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount };  // USD native
if (isAuResident) {
  const aud = toAUD(amount, 'USD', state);          // convert for AU bucket
  next = { ...next, auPersonOrdinaryIncomeYTD: {…+ aud}, ftcYTD: state.ftcYTD + amount };  // ftc USD native
}
```

Note `ftcYTD` takes the **USD** figure in both modules (native in the US module, the
`toUSD` result in the AU module). `SS_INCOME_TAX` keeps its `taxable = amount*0.85`
shaping, converting `taxable` (not `amount`) for the AU/US crossings.

### 4.4 Full list of reducers to touch

- **US module** (`us-tax-module-2026.js`, inherited by 2025/2024): `SS_INCOME_TAX`,
  `WAGES_INCOME_TAX`, `SE_INCOME_US_TAX`, `BONUS_TAX`, and any US capital-gains
  reducer that writes `auCapitalGainsYTD` on the AU-resident branch
  (`US_HOUSE_SALE_TAX`, US stock/collectible CGT, `COMPANY_SALE_TAX`).
- **AU module** (`au-tax-module-2026.js`): `AU_SAVINGS_EARNINGS_TAX`,
  `AU_FIXED_INCOME_EARNINGS_TAX`, `AU_SE_INCOME_TAX`, `AU_WAGES_INCOME_TAX`,
  `AU_RENTAL_INCOME_TAX`, the four AU dividend reducers, and AU CGT
  (`AU_HOUSE_SALE_TAX`, AU stock CGT) for their `usOrdinaryIncomeYTD` /
  `usCapitalGainsYTD` / `ftcYTD` writes.
- **State income classification** (`state/state-income-classification.js` +
  `StateIncomeClassificationReducer`): state buckets are **USD**; any AU-source amount
  routed there must be `toUSD`-converted. Audit which action types it maps.

Each edit is mechanical and local; the helper keeps it to one or two `toUSD`/`toAUD`
calls per reducer.

---

## 5. Rate timing & determinism

- **Accrual rate = event rate.** The `*_TAX` reducer reads `state.effectiveExchangeRates`
  as it runs, i.e. the rate in force the month the income lands. Under design 47's
  time-varying path, each month's income is locked at that month's rate; the annual
  settle then sums already-normalized figures (it does **not** re-translate).
- **Back-compat.** With no USD_AUD pair, or an unrecorded rate, `toCcy` returns the
  native amount → single-country scenarios and any rate-less path are byte-identical
  to today. When source == target it is a no-op.
- **This DOES change cross-border outputs.** Because the rate is seeded to ~1.55 even
  under `fxProcessModel: NONE`, every existing US+AU scenario's tax numbers shift. See
  §6 for the regold scope — this is the main cost of the change and is expected/correct.

---

## 6. Testing & the regold

The behavioral change is intentional and broad, so the test plan is mostly re-baselining:

- **New unit — `tests/unit/tax-fx-normalization.test.mjs`**:
  - AUD-source income into `usOrdinaryIncomeYTD`/`ftcYTD` is divided by the rate
    (A$2000 @1.55 → US$1290.32), AU buckets stay A$2000.
  - USD-source income (AU-resident) into `auOrdinaryIncomeYTD` is multiplied
    (US$8000 @1.55 → A$12400), US buckets stay US$8000.
  - Rate-less state (`effectiveExchangeRates` absent) → native fallback, no throw.
  - Same-currency single-country reducer path is unchanged.
- **Regold the cross-border evt/tax suites**: the `evt-income`, `evt-*` AU income,
  `reducer-postconditions-tax`/`-au`, cross-border toolset, and any golden-number tax
  assertions that encode the old mixed figures. Expect a large, mechanical diff of
  expected values; verify each shifted number moves in the direction §1 predicts
  (US ordinary down for AUD income, AU ordinary up for USD income).
- **Requirements gate + build**; **browser-verify** a US+AU scenario's tax report:
  US doc totals and AU doc totals should now each be internally single-currency.

### Display interaction (verify, don't double-count)
The tax-report modal is a design-10 Phase-4 display surface: it converts figures to
the active display currency. After normalization the US tax document is wholly USD and
the AU document wholly AUD — so the display stamping must treat US-doc line items as
USD and AU-doc line items as AUD (it should already; confirm no line item is
double-converted). This design makes the display *more* correct, since today it
converts a mixed-currency `usOrdinaryIncomeYTD` as if all-USD.

---

## 7. Risks & migration

- **Saved-state continuity.** YTD buckets are reset by the annual settle reducers, so a
  loaded snapshot only ever holds a partial in-flight year. A scenario resumed
  mid-year keeps whatever (old-convention) partials it saved until the next settle;
  acceptable, and identical to how any tax-logic change lands. No migration code.
- **Missed reducer = silent leak.** The invariant is only as good as its coverage. Add
  a **guard test** that scans each tax module's reducer fns for writes to a bucket
  whose canonical currency differs from the reducer's declared source currency without
  a `toCcy` call — or, more simply, assert per-reducer golden currency behavior for
  every `*_TAX` type so a new unconverted reducer fails a test. (Mirrors the
  reducer-coverage-gate philosophy in design 37.)
- **FTC dimensional caveat stays.** Even normalized to USD, `ftcYTD` remains
  income-as-credit, not tax-paid (§2 non-goal). Flag in the code comment so a future
  FTC redesign (a natural design 52) knows the seam.

---

## 8. Implementation checklist

1. `src/finance/tax/tax-fx.js`: `toCcy` / `toUSD` / `toAUD` over `CurrencyConverter` (§4.2).
2. US module `_incomeReducerFns` + CGT reducers: `toAUD` on AU-resident-branch AU-bucket writes (§4.3/§4.4).
3. AU module reducer fns: `toUSD` on `usOrdinaryIncomeYTD` / `usCapitalGainsYTD` / `ftcYTD` writes (§4.3/§4.4).
4. State income classification: `toUSD` on AU-source amounts into state buckets (§4.4).
5. `tax-fx-normalization.test.mjs` + per-`*_TAX`-type currency guard test (§6/§7).
6. Regold affected evt/tax golden suites; `npm run test:unit`, `npm run requirements`, build.
7. Verify tax-report display currency stamping (§6); browser-verify a US+AU scenario.
8. Update `design/50` §2/§7 and the `currency-display-phases` note to point here as the resolution.
