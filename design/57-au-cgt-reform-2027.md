# 57 — AU CGT reform: indexation + 30% minimum tax (from 1 July 2027)

**Status**: **IN PROGRESS** — Phases 1–4 implemented and green (3272 unit + 864 viz;
reference scenario runs clean to 2070). Phase 5 (deferred refinements) is optional. Scope,
fidelity, and the §11 questions are resolved (see **Decisions locked** below).

- **Phase 1 (done)** — `_cgtRelief` hook on `AuTaxRatesBase` + `AuTaxRates2026` (band 16%→15%).
- **Phase 2 (done)** — `AuTaxRates2027`: 50% discount removed + 30% minimum tax (un-indexed
  gains) + band 15%→14%. Min-tax is an **incremental** floor on the gain's own marginal tax
  (see §6.1/§6.3 — refined from the initial whole-liability `max()` sketch).
- **Phase 3 (done)** — per-lot cost-base indexation: `Holding.acquisitionPriceLevel`,
  indexed AU basis in `consumeHoldingsFifo`, `auIndexedGain` on the AU stock sale action,
  `AuTaxModule2027` → `auRealCapitalGainsYTD` (+ per-person map, YTD reset, per-person
  slicing, schema), and `AuTaxRates2027._cgtRelief` taxing the indexed gain. **Additive /
  behavior-neutral until Phase 4**: no lot carries an acquisition level yet, so
  `auIndexedGain === auGain` and the reference scenario is unchanged. Property (house)
  indexation is intentionally deferred (§6.4) — house gains route into the real bucket
  un-indexed, so the discount-removal + 30% floor still apply.
- **Phase 4 (done)** — activates the reform: the **1 July 2027 deemed cost base reset**
  (`AuCgtBasisResetReducer` + `AuCgtBasisResetHandler`, scheduled by the `AU_TAX` toolset
  only when the sim spans the date) restamps each AU_STOCK lot's `costBaseByCountry.AU` to
  market value and `acquisitionPriceLevel` to the July-2027 level (keeping `purchaseDate` for
  the 12-month test); and the **Age Pension / JobSeeker exemption** (`Person.incomeSupportRecipient`
  → projected into `state.people` → `computeAuTaxPerPerson` stamps `auMinTaxExempt` →
  `AuTaxRates2027._cgtRelief` zeroes `minTaxRate`). New classes are registered in the
  serializer's framework-class list and the reducer coverage manifest. **Reference scenario
  net worth moves $10,978,107 → $10,914,370** — the reform now bites on post-2027 AU-resident
  gains (exemption of pre-2027 gains, offset by discount removal + 30% floor).

### ⚠️ Post-implementation correction — TWO COUPLED BUGS zero out AU CGT (2026-07-11, OPEN)

Investigating a real run (US→AU retiree, sim to 2070) surfaced two bugs that together mean
**the AU CGT reform is not taxing AU-resident capital gains at all** in the reference scenario.

**Bug 1 — inflation wrapper drops the reform.** `InflationAdjustedAuTaxRates`
(`inflation-adjusted-tax-rates.js`) `extends AuTaxRatesBase`, not the resolved year module,
and copies only bracket/Medicare thresholds. `TaxSettleService._getModule` wraps the rates
module with it whenever `state.inflationAccumulator.AU > 1` — **essentially every year after
sim start** — so `this._cgtRelief` resolves to the **base 50% discount**, discarding
`AuTaxRates2027._cgtRelief` (indexation + 30% floor). In isolation this reverts the reform to
"50% discount on the nominal gain."

**Bug 2 — the real-gain bucket is never populated for the drawdown path.** AU-resident
capital gains in the reference scenario are realized via the **generic `STOCK_WITHDRAWAL_TAX`**
action (replenish-savings drawdowns), which carries `auGain` but **no `auIndexedGain`**.
`AuTaxModule2027.getReducerFns()` only overrides `AU_STOCK_WITHDRAWAL_TAX` /
`AU_HOUSE_SALE_TAX` to fill `auRealCapitalGainsYTD` — **not** the generic type. So the
real-gain bucket stays **0** while the gross bucket fills. `AuTaxRates2027._cgtRelief` then
does `realGain = auRealCapitalGainsYTD ?? gross`; because the bucket is **present-and-zero**
(not undefined), `??` never falls back → assesses **0** → **100% relief, AU CGT ≈ $0**.

**Interaction:** Bug 1 *masked* Bug 2. With the wrapper reverting to the 50% discount on the
(populated) gross bucket, drawdown-path gains were at least taxed at 50%. "Fixing" Bug 1 alone
(delegating the CGT hooks) switches assessment to the empty real bucket → CGT drops to 0. Both
must be fixed together. Observed on the design-52 golden: wrapper-fix-alone swung lifetime tax
**−18%** (that was CGT being *zeroed*, initially mis-read as "legitimate indexation").

**Status: reverted to a clean baseline pending a proper fix.** The wrapper delegation and the
design-52 regold were both backed out; only the safe report changes remain (`AuTaxDocument2027`
registered; "Tax on Income" ordinary-vs-CGT breakdown sub-rows). The Phase-4 reference figures
(§ −$63.7k, "reform bites") were measured **under Bug 1+2** and are **not trustworthy**.

**Full inventory of AU-resident capital-gain paths (verified 2026-07-11):**

| Path | Action type | Classified in | Real-bucket routed? |
|---|---|---|---|
| AU brokerage sale | `AU_STOCK_WITHDRAWAL_TAX` | AU module | ✅ indexed (`auIndexedGain`) |
| AU property sale | `AU_HOUSE_SALE_TAX` | AU module | ✅ raw gain (indexation deferred §6.4) |
| US brokerage drawdown / TLH | `STOCK_WITHDRAWAL_TAX` | **US module** | ❌ leaks |
| US company/equity sale | `COMPANY_SALE_TAX` | **US module** | ❌ leaks |
| US collectible / **Gold** sale | `COLLECTIBLE_SALE_TAX` | **US module** | ❌ leaks (gold too — design 56 §7.2) |
| US real property | `US_HOUSE_SALE_TAX` | US module | n/a — US-only, no AU assessment |
| wages/bonus/SS/SE/rental/dividends/retirement | various | both | n/a — ordinary income, not CGT-relieved |

The three leaking paths are cross-border US-source gains classified in the **US module** (it
stamps `auCapitalGainsYTD` for AU residents); `AuTaxModule2027` never sees them. Note **Gold**
(design 56) disposes via `COLLECTIBLE_SALE_TAX` for the US 28% rate, but **AU taxes gold
bullion as an ordinary CGT asset** (ATO — investment bullion is not a collectible), so on the
AU side it must be *indexed*, unlike true collectibles.

**Finalized treatment (decisions locked 2026-07-11):**

| Path | AU assessed (real) gain |
|---|---|
| AU brokerage | indexed (`auIndexedGain`) — unchanged |
| AU property | raw gain, indexation deferred — unchanged |
| US brokerage / TLH | **indexed**; deemed acquisition = **AU residency date** (Q1) |
| US company | **0 basis ⇒ full proceeds taxed, un-indexed** (Q2) |
| US true collectibles | **un-indexed** raw gain (Q3) |
| Gold sleeve | **indexed** (ordinary AU CGT / bullion); deemed acquisition = residency date |

**Implementation plan (one accurate landing — no throwaway interim number):**
1. **Routing (structural).** `AuTaxModule2027.getReducerFns()` adds `STOCK_WITHDRAWAL_TAX`,
   `COMPANY_SALE_TAX`, `COLLECTIBLE_SALE_TAX` (residency=AU) → `_recordRealGain` into
   `auRealCapitalGainsYTD`. `TaxEngine.registerDynamic` registers pipeline reducers per
   (country, action-type) independently, so the AU reducer runs **alongside** the US one (US
   stamps gross, AU stamps real) — the same additive pattern as the existing AU-action
   overrides. Older AU modules don't handle these types (`if (!fn) return state`), so pre-2027
   is untouched.
2. **Assessed gain per path** per the table above. US brokerage + gold need `auIndexedGain`
   on the action, computed from a per-lot `acquisitionPriceLevel` set at the **residency
   date** — extend the residency cost-base step-up (`residency-cost-base-policy.js`) to also
   stamp `acquisitionPriceLevel = inflationAccumulator.AU` at the residency change (mirrors how
   it already stamps `costBaseByCountry.AU`). Company = full gain (basis 0); true collectibles
   = un-indexed `auGain`.
3. **Gold vs. true collectibles share `COLLECTIBLE_SALE_TAX`** — the action must carry a gold
   marker (gold holdings are tagged `taxClass:'COLLECTIBLE'`; add e.g. `isGold`/`allocation`)
   so the AU reducer indexes gold but not true collectibles.
4. **Fix the present-zero trap.** With every path now populating the bucket, `_cgtRelief`
   should read the real bucket directly (or gate on a "populated" flag) rather than
   `auRealCapitalGainsYTD ?? gross`, so a legitimately-zero real gain ≠ "never populated".
5. **Re-apply the Bug-1 wrapper delegation**, then regold design 52 once, to the accurate figure.

---

### 📋 SESSION HANDOFF — resume here (2026-07-11)

**All decisions are locked. Gold = INDEXED (confirmed).** Nothing below needs re-litigating;
this is ready to implement in a fresh session.

**Working-tree state (uncommitted on `main`; 3272-ish → now 3309 unit + 864 viz GREEN):**

- ✅ **DONE & kept (the report deliverables):**
  - `src/finance/tax/au/au-tax-document-2027.js` (NEW) — reform-correct ITR formatter, registered.
  - `au-tax-document-2026.js` — extracted `_residentIncomeSection` / `_residentTaxComputationSection`
    + `_taxOnIncomeSubRows` (ordinary-vs-CGT breakdown, shown when `discountedCapitalGains > 0`).
  - `au-tax-rates-base.js` — exposes `ordinaryIncomeTax` / `capitalGainsTax` on the resident result
    (`baseTax` split = `brackets(ord+gain) − brackets(ord)`; the two sum to `baseTax`).
  - `tax-document-registry.js` + `src/index.js` — register/export the 2027 doc.
  - `tax-document-modal.js` + `assets/css/plugins/modals.css` — render `sub:true` rows (`.tax-doc-line--sub`).
  - `tests/unit/tax-documents.test.mjs` — 2027 doc + sub-row coverage.
- ↩️ **REVERTED to baseline (do NOT assume these are done):**
  - `inflation-adjusted-tax-rates.js` — Bug-1 wrapper delegation was backed out (no diff vs HEAD).
  - `tests/unit/cross-border-relief-scenario.test.mjs` — golden restored to **895,088 / 11,852,976**
    (with a note that these reflect the *buggy* 50%-discount behaviour).
- ⚠️ **Therefore AU CGT is still wrong today:** post-2027 AU-resident gains are taxed at the base
  50% discount (Bug 1 masking Bug 2). The fix below is the remaining work.

**Next-session checklist (implement — everything is decided):**

1. `AuTaxModule2027.getReducerFns()` — ADD `STOCK_WITHDRAWAL_TAX`, `COMPANY_SALE_TAX`,
   `COLLECTIBLE_SALE_TAX` (residency=AU) → `_recordRealGain` into `auRealCapitalGainsYTD`.
   (Additive to the US module's gross-bucket stamping — verified via `TaxEngine.registerDynamic`,
   which registers per (country, action-type), so both run. Older AU modules `return state`.)
2. Assessed (real) gain per path: **US brokerage/TLH → indexed** (`auIndexedGain`, deemed
   acquisition = residency date); **company → full gain** (basis 0); **true collectibles →
   un-indexed** `auGain`; **gold → indexed** (ordinary AU CGT / bullion, deemed acquisition =
   residency date).
3. Indexation basis: extend the residency cost-base step-up (`residency-cost-base-policy.js`) to
   also stamp `acquisitionPriceLevel = inflationAccumulator.AU` at the residency change, for
   US-brokerage equity + gold sleeves. Compute `auIndexedGain` in their sale reducers.
4. Gold vs. true collectibles share `COLLECTIBLE_SALE_TAX` → add a gold marker on the action
   (gold holdings are `taxClass:'COLLECTIBLE'`; add e.g. `isGold`/`allocation`) so the AU reducer
   indexes gold but not true collectibles.
5. Fix the present-zero trap in `AuTaxRates2027._cgtRelief`: read the real bucket directly / gate
   on a "populated" flag instead of `auRealCapitalGainsYTD ?? gross`.
6. Re-apply the Bug-1 wrapper delegation in `inflation-adjusted-tax-rates.js` (store `this._base`,
   delegate `_cgtRelief`/`_cgtReliefLabel`).
7. Verify: `npm run test:unit` + `test:viz`; re-run the reference scenario in-browser (Chrome
   session; `window.__app.scenario.sim.journal.journal` → inspect a post-2027 `AU_TAX_SETTLE_APPLY`
   `personTaxDetails[].taxDetail`); then **regold `cross-border-relief-scenario.test.mjs`** to the
   accurate figure and update the note there.

ATO source for gold treatment (bullion = ordinary CGT asset, not a collectible):
[H&R Block — CGT on gold & silver](https://www.hrblock.com.au/tax-academy/capital-gains-tax-gold-silver-investments).

### Decisions locked (review, 2026-07-10)

1. **Operative year = `2027`** (FY2027-28). `year=2026` keeps the 50% discount. (§2)
2. **FY2026-27 bracket cut**: the **$18,201–$45,000 rate drops 16% → 15%** (legislated
   personal tax cuts; CGT is the only *CGT* change). ⚠️ The existing `AuTaxRates2025`
   carries **19%** on this band (`au-tax-rates-2025.js:32`), not 16% — so `AuTaxRates2026`
   sets 15% **explicitly** rather than inheriting. The 2025=19% figure looks like a
   pre-existing inaccuracy (Stage-3 set it to 16% from FY2024-25); **flagged, not fixed
   here** (out of scope). The same package cuts this band again to **14% from 1 July 2027**,
   so `AuTaxRates2027` should carry 14% — *confirm* (§6.2, §6.3).
3. **Age Pension / JobSeeker minimum-tax exemption is in scope** (Phase 3/4, §6.6).
4. **Indexation via Option A** — per-lot in the sale reducers. (§6.3)
5. **Apportionment: Method 1 (deemed reset) only for now.** Method 2 (time-apportionment) is
   the **more accurate alternative** and is documented as a future option, not built. (§6.4)
6. **CPI proxy = `inflationAccumulator.AU`** for now. A dedicated ATO indexation index is a
   documented future refinement; the modeling approach for a real ATO series is **not yet
   determined** (open). (§4, §6.3)

Model the Australian capital-gains-tax reform legislated in the 2026-27 Federal Budget
(*Treasury Laws Amendment (Tax Reform No. 1) Bill 2026*, Royal Assent 26 June 2026). For
CGT events on or after **1 July 2027** the flat **50% CGT discount** (Div 115) is
**removed** for individuals, trusts, and partnerships and replaced with **cost-base
indexation** (CPI), plus a **30% minimum effective tax rate** on real (post-indexation)
net capital gains. Pre-existing assets get a **deemed cost base reset** to market value at
1 July 2027 (or an ATO time-apportionment formula), so only the post-2027 portion of a gain
falls under the new regime.

Today the codebase applies a hardcoded flat 50% discount to `auCapitalGainsYTD` at
settle time (`au-tax-rates-base.js:69`) and has no notion of holding-period indexation,
a minimum-rate floor, or a 1 July 2027 basis reset. This design adds those mechanics as a
new `year=2027` rates module while leaving FY2026-27 and earlier untouched.

---

## 1. The reform (sourced)

| Element | Rule |
|---|---|
| **Effective date** | CGT events (disposals) on/after **1 July 2027** = **FY2027-28**. |
| **50% discount** | **Removed** for individuals/trusts/partnerships. |
| **Replacement** | **Cost-base indexation** by CPI over the holding period; asset held **≥ 12 months**; indexation **cannot create or increase a capital loss**. Indexes cost-base elements *except* the 3rd element (ownership costs). |
| **Minimum tax** | **30%** effective floor on the **real (indexed) net capital gain**. If the taxpayer's marginal-rate tax on the indexed gain is already ≥ 30%, no top-up. Exempt: means-tested income-support recipients (Age Pension, JobSeeker) who receive a payment in that FY. |
| **Pre-CGT assets** | Lose their blanket exemption from 1 July 2027; post-2027 gains become assessable. |
| **Transition (assets held across 1 Jul 2027)** | Gain split pre/post via **(a)** market value at 1 July 2027 (deemed cost base reset) or **(b)** ATO time-apportionment `pre = totalGain × daysBefore / totalDays`. Pre-portion keeps the 50% discount; post-portion uses indexation + 30% min. Taxpayer elects. |
| **New residential builds** | May **elect** to keep the 50% discount instead of the new regime. |
| **Non-residents** | Foreign residents already get no discount (post-2012); interaction of indexation with the foreign-resident regime is unsettled. |
| **Super** | Unaffected (its own 15% / one-third-discount regime; not modeled here). |

Sources:
- [ATO — Reforming negative gearing and capital gains tax](https://www.ato.gov.au/about-ato/new-legislation/in-detail/individuals/tax-reform-boosting-home-ownership-reforming-negative-gearing-and-capital-gains-tax)
- [Budget 2026-27 — Tax reform](https://budget.gov.au/content/04-tax-reform.htm)
- [Treasury — Budget 2026-27 tax system changes](https://treasury.gov.au/policy-topics/taxation/budget2026-27)
- [Parliament — Treasury Laws Amendment (Tax Reform No.1) Bill 2026 digest](https://www.aph.gov.au/Parliamentary_Business/Bills_Legislation/bd/bd2526/26bd067)
- [H&R Block — Proposed CGT changes](https://www.hrblock.com.au/tax-academy/proposed-capital-gains-tax-changes-australia)
- [Andersen Australia — CGT changes 2026](https://au.andersen.com/capital-gains-tax-changes-2026/)

---

## 2. ⚠️ Year mapping — this lands in `year=2027`, not `year=2026`

The codebase numbers AU modules by **financial-year start**: `year=2025` = FY2025-26
(begins July 2025), per `au-tax-rates-base.js:31` and `tax-settle-service.js:75`.

The reform's *budget* is the "2026-27 Budget" and the law passed **during FY2026-27**, but
its CGT mechanics apply only to disposals **on/after 1 July 2027** — i.e. **FY2027-28 =
codebase `year=2027`**. Therefore:

- **`year=2026` (FY2026-27)** — the 50% discount is **unchanged**. There is currently no
  `AuTaxRates2026`; FY2026-27 silently falls back to `AuTaxRates2025`. We add an explicit
  `AuTaxRates2026` for clarity/audit, but it carries the same CGT treatment (see §6.2).
- **`year=2027` (FY2027-28)** — the **new regime** (indexation + 30% min) begins. This is
  the substantive module (§6.3).

The "2026-2027 AU tax year" phrasing in the request maps to `year=2026`, which is the year
the reform was *legislated* but not yet *operative* for CGT. Confirm we want the operative
module at `year=2027` (this design assumes yes) — see §11 Q1.

---

## 3. What exists today

- **Classification** (`au-tax-module-YYYY.js`, registered in `tax-service.js`) — Stage-2
  reducers sort each disposal's proceeds into YTD buckets. `AU_STOCK_WITHDRAWAL_TAX` /
  `AU_HOUSE_SALE_TAX` add `gain`/`auGain` into `auCapitalGainsYTD` (or the per-person map)
  and `ftcYTD`. `AuTaxModule2026` already exists; 2025/2024 extend it. **No 2027 yet.**
- **Rate computation** (`au-tax-rates-YYYY.js`, registered in `tax-settle-service.js`) —
  `AuTaxRatesBase.computeTax(state)` applies the **flat 50% discount** (`* 0.5`,
  line 69), stacks the discounted gain onto marginal brackets, adds Medicare, offsets
  franking credits. Registered years stop at **`AuTaxRates2025`**; FY2026+ falls back to it.
- **Gain computation** (`au-brokerage-classes.js`, `au-real-property-classes.js`) — sale
  reducers FIFO-consume `holdings`, compute `gain = proceeds − realizedBasis` and
  `auGain = proceeds − realizedAuBasis` (the AU stepped-up basis), and emit the `_TAX`
  action. **Gain arrives at the rates module already netted; no per-lot detail survives.**

## 4. Primitives we build on (already present)

- **`Holding.purchaseDate`** (`holding.js:39`) — acquisition date ⇒ the 12-month test and
  the indexation start date, per lot.
- **`Holding.costBaseByCountry`** (`holding.js:33`) — per-country cost-base override, the
  **exact field** the AU s855-45 residency step-up writes. A **1 July 2027 deemed cost
  base reset** is the same operation triggered by a date instead of a residency change.
- **Residency step-up machinery** — `RESIDENCY_COST_BASE_STEP_UP`
  (`residency-cost-base-policy.js`), `AccountService.recordResidencyChange`,
  `consumeHoldingsFifo`. Country-agnostic; reusable for the date-triggered reset.
- **`state.inflationAccumulator.AU`** — a per-country cumulative price level from sim start,
  compounded on each `AU_PERIOD_ADVANCE` (`inflation-adjust-reducer.js`). Our **CPI proxy**:
  indexed basis = `costBase × accumulator(disposal) / accumulator(acquisition)`. The
  `_inflationWrap` in `tax-settle-service.js` already scales *brackets* by this factor.
- **`_getModule` year resolution** in both `TaxEngine` and `TaxSettleService` — "highest
  registered year ≤ period year", so adding `year=2027` modules auto-selects for FY2027-28+
  with **no caller changes**.

---

## 5. Design overview

Three moving parts, from smallest to largest:

1. **Make the CGT relief a per-year hook** on the rates module (replaces the hardcoded
   `* 0.5`). FY≤2026 returns the 50% discount; FY2027 returns the indexation + 30%-floor
   computation. *(Refactor, no behavior change for existing years.)*
2. **Carry indexation inputs to the point of computation.** The flat-discount model needs
   only a scalar gain; indexation needs, per realized lot, the **cost base**, **acquisition
   price level**, and **whether held ≥12 months**. Two placement options (§6.3) — decide
   in review.
3. **Deemed cost base reset at 1 July 2027** + apportionment, so assets straddling the date
   only expose their post-2027 portion to the new regime (§6.4).

The 30% minimum-tax floor is small and self-contained; indexation + apportionment is the
bulk of the work and the main fidelity decision.

### 6.1 Lift the CGT discount to an overridable hook

**As built.** In `AuTaxRatesBase`, the inline `auCapitalGainsYTD * 0.5` became a protected
hook returning the net taxable gain, the display relief amount, and a **minimum-tax rate**:

```js
_cgtDiscountRate = 0.5;                       // FY≤2026 flat Div 115 discount
_cgtRelief(state, auCapitalGainsYTD) {
  const reliefAmount   = auCapitalGainsYTD * this._cgtDiscountRate;
  const netTaxableGain = auCapitalGainsYTD - reliefAmount;
  return { netTaxableGain, reliefAmount, minTaxRate: 0 };   // 0 = no floor
}
_cgtReliefLabel() { return 'CGT 50% Discount'; }   // FY2027 overrides the label
```

`computeTax` adds `netTaxableGain` to assessable income and, when `minTaxRate > 0`, applies
an **incremental** minimum-tax top-up (§6.3) — *not* a floor on the whole liability. For
FY≤2026, `minTaxRate = 0` ⇒ byte-identical output (the existing `au-tax-rates` /
`tax-documents` tests stay green).

> **Refinement vs. the original sketch.** The first draft floored the *entire* net liability
> at `minTaxRate × gain` (`max(grossTax, minTaxFloor)`). That over-taxes whenever the
> taxpayer has meaningful ordinary income (ordinary tax alone can already exceed the floor,
> suppressing a top-up the gain should still get) and mismatches the reform, which floors the
> tax **on the gain**. The built version computes the gain's own marginal tax and tops *that*
> up — see §6.3.

### 6.2 `AuTaxRates2026` (FY2026-27) — bracket cut, no CGT change

New `au-tax-rates-2026.js extends AuTaxRatesBase` (**not** `AuTaxRates2025` — see below).
CGT treatment is unchanged (flat 50% discount), but the personal tax cut moves the
**$18,201–$45,000 band from 16% → 15%**:

```js
this._brackets = [
  [       0, 0.00],
  [  18_200, 0.15],  // 16% → 15% (FY2026-27 legislated cut)
  [  45_000, 0.30],
  [ 135_000, 0.37],
  [ 190_000, 0.45],
];
```

⚠️ **Do not `extends AuTaxRates2025`**: that module sets this band to **19%**
(`au-tax-rates-2025.js:32`), not the Stage-3 16%. The 19% looks like a pre-existing
inaccuracy (Stage-3 cuts set FY2024-25 to 16%); correcting 2025 is **out of scope** for this
design — set 2026 explicitly and flag 2025 separately. Non-resident brackets and Medicare
carry forward unchanged. Register in `tax-settle-service.js`.

### 6.3 `AuTaxRates2027` (FY2027-28) — the new regime

`AuTaxRates2027 extends AuTaxRatesBase` sets the FY2027-28 brackets (the same package cuts
the **$18,201–$45,000 band 15% → 14%** — *confirm*) and overrides `_cgtRelief`:

- **Indexation**: the discountable gain becomes the **real gain** = `Σ over lots max(0,
  proceeds_lot − indexedBase_lot)` where `indexedBase = costBase × idx(disposal)/idx(acq)`
  for lots held ≥12 months (un-indexed cost base otherwise), never below the raw gain of 0
  (indexation can't create a loss). No 50% discount.
- **30% floor (as built, incremental)**: `computeTax` derives the gain's own marginal tax as
  `taxOnGain = brackets(ordinary + netTaxableGain) − brackets(ordinary)`, then adds a top-up
  `max(0, 0.30 × netTaxableGain − taxOnGain)`. The floor therefore bites **only** when the
  gain's marginal rate is below 30%, and vanishes once ordinary income pushes the gain into
  the ≥30% brackets — matching the reform. Exposed as `result.cgtMinimumTaxTopUp` and a
  `CGT Minimum Tax Top-up (30%)` line item. (For non-exempt taxpayers; the Age Pension /
  JobSeeker exemption in §6.6 sets `minTaxRate` to 0.)

**Placement decision — where is the indexed gain computed?**

- **Option A (compute in the account-rules sale reducers).** `au-brokerage-classes` /
  `au-real-property-classes` already FIFO-consume lots and know each lot's `costBasis`,
  `costBaseByCountry.AU`, and `purchaseDate`. Have them also compute the **indexed** AU gain
  (using `state.inflationAccumulator.AU` and a stamped acquisition price level) and pass it
  on the `_TAX` action as a new `auIndexedGain` field, alongside the existing `auGain`. The
  classification module routes it into a new `auRealCapitalGainsYTD` bucket. The rates
  module then chooses discount-vs-indexed by year. *Pro:* per-lot fidelity, dates available.
  *Con:* touches the sale reducers and the action schema.
- **Option B (approximate in the rates module).** Keep passing only `auGain`; in
  `_cgtRelief` approximate indexation with a single portfolio-level factor. *Pro:* localized.
  *Con:* loses per-lot 12-month and acquisition-date accuracy; can't do apportionment well.

**Decision: Option A (locked).** The lot detail exists exactly where the gain is realized,
and apportionment (§6.4) needs per-lot dates anyway. It's the "realistic within reason" path.

To index, each lot needs the price level **at acquisition**. Rather than reconstruct it from
`purchaseDate`, stamp **`Holding.acquisitionPriceLevel`** (= `state.inflationAccumulator.AU`
at purchase) when a lot is created — mirroring how `costBaseByCountry` is stamped. Lots
bootstrapped from the scenario (no purchase event) get the sim-start level (1.0) or a
seeded value.

**CPI proxy (locked, with a documented upgrade path).** `inflationAccumulator.AU` is a
household price-level series driven by the scenario's AU inflation rate — a *reasonable
stand-in* for the ATO indexation factor, and it costs nothing (already in state). A more
accurate model would drive indexation from a **dedicated ATO CPI series** distinct from the
inflation rate used to escalate wages/expenses (they are not the same index in reality). We
**do not build that now** — and note the modeling approach is unsettled: it would need a
CPI-per-quarter series as scenario input (or an MC-drawn series), plus a way to align a
lot's `purchaseDate` to the right CPI reading. Isolating indexation behind
`idx(disposal)/idx(acq)` keeps this swappable later without touching the tax logic.

### 6.4 Deemed cost base reset at 1 July 2027 + apportionment

For a lot acquired **before** 1 July 2027 and sold after, only the post-2027 gain is under
the new regime. Two supported methods (taxpayer elects the better):

- **Method 1 — deemed reset.** On 1 July 2027, reset each AU-taxable lot's
  `costBaseByCountry.AU` to market value and its `acquisitionPriceLevel` to that date's
  level. Implement as a one-off scheduled `AU_CGT_BASIS_RESET` event in `AU_TAX`'s
  `schedules()` (only when `simEnd ≥ 2027-07`), reusing the residency-step-up reducer path
  (it already overwrites `costBaseByCountry` per lot). The pre-2027 gain then never enters
  the AU YTD buckets — it's exempt, matching "gains before 1 July 2027 remain exempt". *This
  is the cleanest fit and reuses existing machinery.*
- **Method 2 — time-apportionment.** `preGain = totalGain × daysBefore(1 Jul 2027) /
  totalDaysHeld`; `preGain` keeps the 50% discount, `postGain` uses the new regime. Requires
  splitting one disposal across two treatments in the classification module.

**Decision: Method 1 only for now (locked).** The deemed reset gives correct "only post-2027
gains taxed" behavior by reusing existing step-up machinery, with the least new code.

> **Method 2 is the more accurate alternative — documented, not built.** Method 1's deemed
> reset uses the *market value at 1 July 2027* as the pre/post split point. That is exact
> only if you actually know each asset's 1 July 2027 value; the model derives it from the
> holding's simulated market value on that date, which is itself an approximation. Method 2's
> ATO time-apportionment (`preGain = totalGain × daysBefore / totalDaysHeld`) is the
> legislated fallback and, for assets whose appreciation is *not* uniform over time, can
> differ materially from the market-value split — the real regime lets taxpayers **elect the
> better of the two**. Building Method 2 later means splitting one disposal into a
> 50%-discount pre-portion and a new-regime post-portion in the classification module, and
> exposing an election flag. Left as a future refinement (Phase 5).

### 6.5 `AuTaxModule2027` (classification)

New `au-tax-module-2027.js extends AuTaxModule2026`, overriding the two CGT reducers
(`AU_STOCK_WITHDRAWAL_TAX`, `AU_HOUSE_SALE_TAX`) to route the indexed gain into a new
**`auRealCapitalGainsYTD`** bucket (resident path) while still writing `usCapitalGainsYTD`
(US unaffected) and `ftcYTD`. Register in `tax-service.js`. FY≤2026 keeps using
`auCapitalGainsYTD` ⇒ old modules unchanged.

### 6.6 Minimum-tax exemption (Age Pension / JobSeeker) — in scope

Model as a per-person boolean `Person.incomeSupportRecipient` (or derive from an existing
pension / Social-Security flag if one cleanly signals income-support receipt). When set,
`AuTaxRates2027` skips the 30% floor **for that person only** — per-person tax already exists
via `computeAuTaxPerPerson`, so the floor is applied in the per-person path and the flag
gates it there. The whole-household `computeAuTax` path applies the floor unless *all*
residents are exempt. Real rule: the exemption applies when the person receives a qualifying
payment in the FY the gain is realized; the boolean is a per-year simplification (a
time-varying flag is a later refinement if needed).

### 6.7 Out of scope (flag, don't build now)

- **New residential build election** — a per-asset "keep 50% discount" flag. Rare in the
  retirement scenario; add only if needed.
- **Non-resident indexation** — legally unsettled; keep the current no-discount
  non-resident path unchanged.
- **Super / one-third super CGT discount** — unaffected by the reform.

---

## 7. State & schema additions

| Field | Where | Purpose |
|---|---|---|
| `auRealCapitalGainsYTD` (+ `auPersonRealCapitalGainsYTD: {}`) | `AU_TAX` toolset `state()` | Post-indexation AU gains for FY2027+; initialized to 0/`{}`. |
| `Holding.acquisitionPriceLevel` | `holding.js` (constructor + toJSON/fromJSON) | AU price level at acquisition for indexation. |
| `Person.incomeSupportRecipient` (optional, §6.6) | `person.js` | 30%-floor exemption. |

Register `auRealCapitalGainsYTD` in `StateSchemaRegistry` (currency AUD) so it charts/formats.
`acquisitionPriceLevel` needs `TypeRegistry` round-trip coverage (serializer tests).

## 8. Registration checklist (per README "Add a tax-year update")

1. `src/finance/tax/au/au-tax-rates-2026.js` + `au-tax-rates-2027.js`.
2. `src/finance/tax/au/au-tax-module-2027.js`.
3. Register rates in `tax-settle-service.js` constructor; register the classification module
   in `tax-service.js` (`_taxEngine.register(new AuTaxModule2027())`), and — if account
   rules change (they don't here) — the account module.
4. `AU_CGT_BASIS_RESET` one-off event + handler/reducer (reuse residency-step-up reducer),
   wired into `AU_TAX` `schedules()`/`handlers()`/`reducers()` and `types`.
5. **`src/finance/tax/au/au-tax-document-2027.js`** — the ITR *formatter*. Without it,
   `TaxDocumentRegistry` falls back to `AuTaxDocument2026`, which hardcodes the
   `CGT 50% Discount` label and omits the 30% min-tax top-up, so the Tax Report *displays*
   the removed discount (mislabeling the indexation relief) and its Tax Computation section
   fails to reconcile to Gross Tax — even though the tax actually charged by `AuTaxRates2027`
   is correct. Register it in `tax-document-registry.js`. (⚠️ Originally missed — the rates
   and classification modules were registered but the document module was not; added later.)
6. `npm run build:index` (new exported classes).

## 9. Testing plan

- `tests/unit/evt-au-cgt-reform.test.mjs` (`EVT-*` naming):
  - FY2026 disposal ⇒ 50% discount unchanged (regression).
  - FY2027 disposal, lot held ≥12 mo ⇒ indexed gain < raw gain; tax = max(marginal, 30%).
  - FY2027 disposal, marginal already ≥30% ⇒ no top-up.
  - Lot held <12 mo ⇒ no indexation.
  - Indexation never turns a gain into a loss.
  - Lot acquired pre-2027, sold post-2027 with reset ⇒ only post-2027 gain taxed.
  - Exempt person (if §6.6 built) ⇒ no 30% floor.
- Extend `tax-rates.test.mjs` with `AuTaxRates2026`/`2027` bracket + floor cases.
- Serializer round-trip for `acquisitionPriceLevel`.
- End-to-end: run `scripts/run-scenario.mjs` on the reference scenario across 2027 and
  confirm no crash + plausible AU CGT line items in the journal.

## 10. Phased rollout

- **Phase 1 ✅ done** — §6.1 hook refactor + `AuTaxRates2026` (band 16%→15%). Regression-safe.
- **Phase 2 ✅ done** — `AuTaxRates2027`: 50% discount removed + incremental 30% minimum-tax
  floor on the un-indexed gain + band 15%→14%. Tested (`AU-2027` suite).
- **Phase 3 ✅ done** — indexation: `Holding.acquisitionPriceLevel` + Option-A per-lot indexed
  gain (`consumeHoldingsFifo` + AU stock sale reducer) + `auRealCapitalGainsYTD` +
  `AuTaxModule2027` + `AuTaxRates2027._cgtRelief` taxing the indexed gain. Property indexation
  deferred to §6.4. Behavior-neutral until Phase 4 stamps acquisition levels.
- **Phase 4 ✅ done** — 1 July 2027 deemed cost base reset (Method 1: restamps
  `costBaseByCountry.AU` + `acquisitionPriceLevel`, scheduled only when the sim spans the
  date) + the Age Pension / JobSeeker exemption flag (§6.6). This activates indexation and
  moves the reference scenario's ending net worth (−$63.7k).
- **Phase 5 (deferred)** — apportionment Method 2 election, new-build election, dedicated
  ATO CPI series.

---

## 11. Resolved questions

All six review questions are resolved — see **Decisions locked** at the top. Summary:

1. Operative year = `2027`; `year=2026` unchanged. ✅
2. FY2026-27 moves the $18,201–$45,000 band 16% → 15% (and 15% → 14% at FY2027-28); CGT is
   the only CGT change. `AuTaxRates2026` sets 15% explicitly (2025's 19% flagged, not fixed). ✅
3. Age Pension / JobSeeker exemption — **in scope** (Phase 4). ✅
4. Indexation via Option A (per-lot in sale reducers). ✅
5. Method 1 (deemed reset) only; Method 2 documented as the more-accurate deferred
   alternative. ✅
6. `inflationAccumulator.AU` as CPI proxy; dedicated ATO index deferred (modeling approach
   unsettled). ✅

Remaining **confirm-only** item: the FY2027-28 lowest-band rate of **14%** (§6.3) — assumed
from the same legislated cut package; correct if the intended figure differs.
