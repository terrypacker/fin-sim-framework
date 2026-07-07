# 52 — True Foreign Tax Credit (tax-paid, §904-limited, with carryforward)

**Status**: **Proposed** (design only). Follow-up to
`design/51-tax-bucket-fx-normalization.md`, which normalized `ftcYTD` into USD but
explicitly left its *semantics* untouched: it still accumulates foreign-source
**income** and is credited dollar-for-dollar against US tax. This design replaces
that with a credit for the **foreign tax actually paid**, limited by IRC §904.

**Builds on**:
- The annual settle machinery in `src/finance/tax/tax-settle-classes.js`
  (`UsTaxSettleHandler` / `AuTaxSettleHandler` → `*_TAX_SETTLE_APPLY` → reset YTD +
  chain `*_TAX_PAYMENT_DEBIT`) and the rate computations
  `us-tax-rates-base.js` (`credits = min(ftcYTD, grossTax)`) and
  `au-tax-rates-base.js` (resident/non-resident, franking offset only).
- `AccumulateTaxesPaidReducer` (`src/finance/reducers/accumulate-taxes-paid-reducer.js`),
  which **already** converts each settle's `tax` (AU in AUD) into USD
  (`usd = tax / effectiveExchangeRates.USD_AUD`). This is the exact precedent for
  moving *actual tax paid* between the two returns in one currency.
- `design/51` `tax-fx.js` (`toUSD`/`toAUD`) — every cross-currency figure here routes
  through the same seam.

**Author note**: Today `ftcYTD` is a misnomer — it holds foreign-source *income*, and
`min(ftcYTD, grossTax)` means "foreign income wipes US tax up to the whole bill."
That is wrong in two directions. If the foreign (AU) rate is **lower** than the US
rate, the model still erases the entire US liability, so the US collects nothing on
income it should top up. If the AU rate is **higher**, the excess AU tax vanishes
instead of carrying forward. A real FTC credits the *tax paid*, capped at the US tax
*attributable to the foreign income* (§904), with the unused remainder carried
forward. This design makes that real, and (Phase 2) makes it bilateral.

---

## 1. Problem

Three defects in the current single-line model (`us-tax-rates-base.js:85`):

1. **Credits income, not tax.** `min(ftcYTD, grossTax)` treats every foreign-source
   dollar as if fully creditable. Example: A US-resident spouse earns A$50k of
   AU-source wages taxed by AU at ~15% (≈ A$7.5k ≈ US$4.8k of *tax*). The US should
   credit ~US$4.8k. The current model credits up to the *income* (~US$32k) — capped
   only by US gross tax — so it can zero a US liability many times larger than the
   AU tax actually paid.
2. **No §904 limitation.** Even a true tax-paid credit must be capped at
   `usTax × foreignSourceTaxableIncome / totalTaxableIncome`. Without it, foreign tax
   on lightly-US-taxed income can shelter US tax on US-source income.
3. **Unilateral + no carryforward.** The AU return grants **no** credit for US tax
   (`au-tax-rates-base` only offsets franking credits), so an AU resident with
   US-source income (IRA/401k withdrawals) is **double-taxed** in the model. And
   excess foreign tax in a high-foreign-rate year is simply lost rather than carried
   to a year with headroom.

---

## 2. Goals & Non-Goals

### Goals
- **Phase 1 — true US FTC.** Credit the **actual AU tax paid** on foreign-source
  income (USD), limited by the §904 fraction, with a **carryforward pool** for the
  unused remainder. (This is the core ask.)
- **Phase 2 — bilateral AU FITO.** A symmetric Foreign Income Tax Offset on the AU
  return for US tax paid on US-source income, so an AU resident is not double-taxed.
- Preserve `design/51`'s canonical-currency invariant: the credit pool is **USD**;
  the AU offset pool is **AUD**; all crossings go through `tax-fx.js`.
- A **sourcing rule** (§4.1) that assigns each income dollar to exactly one
  *source* country, so the two credits never double-relieve the same tax.

### Non-Goals (deferred)
- **§904 baskets** (general vs passive vs GILTI). One combined basket.
- **Carryback** (the real §904(c) 1-year carryback). Carryforward only; a 10-year
  cap is optional (§7).
- **Exact FY↔CY alignment.** AU FY (Jul–Jun) and US CY (Jan–Dec) differ; the pool
  handoff introduces a bounded, documented timing lag (§5).
- **Treaty re-sourcing subtleties** beyond the single sourcing rule (§4.1) — e.g.
  the US-citizen "re-sourced by treaty" article that lets the US credit AU tax on
  otherwise-US-source income. Modeled as an assumption, not a per-article engine.
- **State (US-state) FTC.** US states largely don't grant FTC; unchanged.

---

## 3. State model

Rename for honesty and add the pools (all reset semantics in §5):

| Field | Currency | Meaning | Reset |
|---|---|---|---|
| `foreignSourceIncomeYTD` (was `ftcYTD`) | USD | §904 numerator: foreign-source taxable income for the US year. | at US settle |
| `foreignTaxCreditPoolUSD` | USD | Unused foreign tax available to credit US tax (carryforward). Funded by the AU settle. | **carries forward** (never zeroed at settle; only drawn down) |
| `usSourceIncomeAudYTD` *(Phase 2)* | AUD | FITO numerator: US-source taxable income for the AU year. | at AU settle |
| `usTaxOffsetPoolAUD` *(Phase 2)* | AUD | Unused US tax available to offset AU tax. Funded by the US settle. | carries forward |

`ftcYTD` → `foreignSourceIncomeYTD` is a mechanical rename across the ~30 reducer
writes that `design/51` just touched, plus the `YTD_FIELDS.US` reset list
(`tax-settle-classes.js:19`) and the drill/report field references. A back-compat
shim (read `ftcYTD` when `foreignSourceIncomeYTD` absent on a loaded snapshot) covers
pre-52 saves for one release. *(If the rename churn is unwanted, the field name can
stay `ftcYTD` with a doc comment; the semantics change either way.)*

---

## 4. Mechanism

### 4.1 Sourcing rule (the anti-double-credit invariant)

Every taxable dollar is **sourced** to exactly one country:

- **US-source**: US wages/SE, IRA/401k/Roth distributions, US brokerage
  interest/dividends/gains, US property. (The existing `US_*`/US-account `*_TAX`
  reducers.)
- **AU-source**: AU wages/SE, super, AU brokerage, AU property, AU interest.
  (The `AU_*` reducers.)

**Direction of relief follows source:** the *source* country taxes the income in full;
the *other* country (taxing it because its taxpayer is a resident/citizen) grants the
credit. So:
- AU-source income → **US grants FTC** for the AU tax (Phase 1).
- US-source income → **AU grants FITO** for the US tax (Phase 2).

This one rule guarantees each dollar's tax is relieved on exactly one return, so the
two credits cannot stack. `foreignSourceIncomeYTD` = the AU-source slice (from the AU
module reducers); `usSourceIncomeAudYTD` = the US-source slice (from the US module
reducers). Both are already produced today (they are what feeds `ftcYTD` / the AU
buckets); this design just tracks them as *income bases* and pairs them with a
*tax-paid pool*.

### 4.2 Funding the pool (AU settle → US FTC)

`AuTaxSettleHandler`/`AuTaxSettleApplyReducer` already compute the AU `netLiability`
(AUD) and know the AU return's composition. Add: the AU tax attributable to
**AU-source income that is also US-taxable** (for a US citizen, that is essentially
all of it) is converted to USD and **added** to `foreignTaxCreditPoolUSD`:

```
auTaxOnForeignSource = auNetLiability × (auSourceTaxableIncome / auTotalTaxableIncome)
foreignTaxCreditPoolUSD += toUSD(auTaxOnForeignSource, 'AUD', state)   // design 51 seam
```

For the common case (all AU income is foreign-source to the US taxpayer) the fraction
is 1 and the whole AU tax funds the pool — matching `AccumulateTaxesPaidReducer`'s
existing AUD→USD conversion. The apportionment fraction only matters if an AU return
ever contains US-source income (it does not today; the sourcing rule keeps US-source
income out of the AU ordinary buckets except via Phase 2's FITO path).

### 4.3 Applying the credit (US settle, §904-limited)

Replace `us-tax-rates-base.js` Step 6 (`credits = min(ftcYTD, grossTax)`):

```
const foreignFrac = totalTaxableIncome > 0
  ? Math.min(1, Math.max(0, foreignSourceIncomeYTD / totalTaxableIncome)) : 0;
const ftcLimit   = grossTax * foreignFrac;                 // §904 limitation
const credit     = Math.min(foreignTaxCreditPoolUSD, ftcLimit);
const netLiability = Math.max(0, grossTax - credit);
```

where `totalTaxableIncome = taxableOrdinary + max(0, usCapitalGains) + collectibles`
(the bases already in `computeTax`). The settle then **draws down the pool** by the
credit used (§5), carrying the remainder forward.

### 4.4 Phase 2 — AU FITO (symmetric)

Mirror image on the AU return (`au-tax-rates-base.js`), gated to AU residents:

```
fitoLimit = auGrossTax × (usSourceTaxableIncomeAUD / auTotalTaxableIncome)
fito      = min(usTaxOffsetPoolAUD, fitoLimit)
auNetLiability = max(0, auGrossTax − frankingOffset − fito) + superTax + nrWithholdingTax
```

funded by the US settle: `usTaxOffsetPoolAUD += toAUD(usTaxOnUsSource, 'USD', state)`.
Phase 2 is what removes the current double-taxation of US-source income for AU
residents. It is separable from Phase 1 and can ship later.

---

## 5. Timing, ordering & reset semantics

- **Settle order within a calendar year.** The AU FY settle fires **Jun 30**, the US
  CY settle **Dec 31** — so within calendar year *N* the AU return (FY *N-1→N*)
  funds `foreignTaxCreditPoolUSD` *before* the US return (CY *N*) consumes it. The
  pool is a natural buffer for the FY↔CY offset: AU tax from the FY ending mid-year
  is available to the US return closing that December.
- **Reset asymmetry (the crux).** `foreignSourceIncomeYTD` is a **per-US-year** §904
  input and resets at the US settle (it is in `YTD_FIELDS.US`). The
  `foreignTaxCreditPoolUSD` **must NOT be in the reset list** — it is drawn down by
  the credit used and the remainder **carries forward**. Concretely, the US settle
  computes `credit`, then writes `foreignTaxCreditPoolUSD -= credit` (never below 0)
  and resets `foreignSourceIncomeYTD`. This is the single most important departure
  from the current all-fields-reset settle reducer.
- **First/last year.** Year 1 may have an unfunded pool if the US settle precedes the
  first AU settle (e.g. simStart mid-year); the credit is then 0 that year and the
  AU tax funds the *next* year's pool — a documented one-year lag, not a leak (the
  tax is still credited, just a year later, exactly as a real carryforward behaves).
- **Optional carryforward cap.** Real §904(c) is 10 years. A `pool age` ledger is
  possible but heavy; v1 uses an **uncapped** carryforward (simplest, conservative —
  never loses a credit). A cap is a clean Phase 3.

---

## 6. Display / reporting

- US tax document FTC line changes from an income figure to **"Foreign Tax Credit
  (§904-limited)"** = `credit`, plus a **"FTC carryforward"** line =
  `foreignTaxCreditPoolUSD` after draw-down. The `foreign-tax-credit-detail` drill (if
  present) shows pool funded / limit / used / carried.
- AU document gains a **"Foreign Income Tax Offset"** line (Phase 2).
- `AccumulateTaxesPaidReducer` is unaffected (it sums each settle's `tax`); but
  because `netLiability` now reflects a real (usually smaller-than-today) credit, US
  `cumulativeTaxesPaid`, after-tax net worth, and any MIN_LIFETIME_TAXES objective
  **shift**. This is the intended correctness change and the main regold surface.

---

## 7. Testing

- **New `tax-ftc.test.mjs`**:
  - **FTC-1 (tax-paid, not income):** AU-source income taxed at a low AU rate → US
    credit equals the AU *tax* (USD), not the income; residual US tax is collected.
  - **FTC-2 (§904 cap):** high foreign tax on a small foreign-income share → credit
    capped at `grossTax × foreignFrac`, remainder to the pool.
  - **FTC-3 (carryforward):** a high-foreign-rate year overflows the limit; the excess
    credits a later year with headroom; pool draws down correctly.
  - **FTC-4 (reset asymmetry):** `foreignSourceIncomeYTD` zeroes at the US settle;
    `foreignTaxCreditPoolUSD` persists across it.
  - **FTC-5 (no double-credit / sourcing):** with both Phase 1 + Phase 2 active, a
    US-source dollar is relieved only by the AU FITO and an AU-source dollar only by
    the US FTC — total tax on each ≈ the higher of the two rates, never < either.
  - **FITO-1 (Phase 2):** AU resident with US-source IRA withdrawal is no longer
    double-taxed; AU tax drops by the US tax paid, limited by AU tax on that income.
- **Regold:** the cross-border evt/tax goldens that assert `ftcYTD > 0` or a specific
  post-credit `netLiability` (they encode the old income-credit); scenario-level
  lifetime-tax / net-worth goldens shift. Expect a broad, directional diff (US tax up
  where AU rate < US rate; AU tax down under Phase 2).
- Requirements gate + build; browser-verify a post-move retiree's US & AU returns show
  a limited FTC + carryforward and no double taxation.

---

## 8. Risks

- **Circular settle dependency (Phase 2).** US FTC needs AU tax paid; AU FITO needs US
  tax paid. The **sourcing rule (§4.1) breaks the cycle**: the US FTC only credits AU
  tax on *AU-source* income; the AU FITO only offsets US tax on *US-source* income —
  disjoint sets, so neither credit feeds the other's input. No fixpoint iteration.
- **Pool never resetting = state growth / stale credit.** Mitigated by draw-down each
  settle and the optional 10-year cap (§5).
- **Apportionment when a return is mixed-source.** Today AU returns are ~100%
  AU-source and US returns mix both; the §904 fraction and the FITO fraction handle
  the mix. Guard tests (FTC-2/FITO-1) pin the fractions.
- **Behavioral shift is large.** This changes headline outputs (lifetime tax, ending
  wealth) for every cross-border scenario — call it out in the PR; it is a
  correctness fix, not a regression.

---

## 9. Implementation checklist

1. Rename `ftcYTD` → `foreignSourceIncomeYTD` (or keep name + doc); add
   `foreignTaxCreditPoolUSD` to tax state schema; add back-compat read shim.
2. `tax-settle-classes.js`: **remove the pool from `YTD_FIELDS.US`**; in
   `UsTaxSettleApplyReducer` draw down the pool by the credit used and reset
   `foreignSourceIncomeYTD` only.
3. `AuTaxSettleApplyReducer` (or handler): fund `foreignTaxCreditPoolUSD +=
   toUSD(auTaxOnForeignSource)` (§4.2).
4. `us-tax-rates-base.js`: §904-limited `credit = min(pool, grossTax × foreignFrac)`
   (§4.3); expose FTC + carryforward line items.
5. `tax-ftc.test.mjs` (FTC-1..5); regold cross-border evt/tax + lifetime-tax/net-worth
   goldens; `npm run test:unit`, `requirements`, build; browser-verify.
6. **Phase 2** (separable): `usTaxOffsetPoolAUD` + `usSourceIncomeAudYTD`,
   US settle funds it, `au-tax-rates-base.js` applies the FITO (§4.4); FITO-1 test.
7. Update `design/51` §2 non-goal + the `currency-display-phases` memory to point here
   as the FTC resolution.
