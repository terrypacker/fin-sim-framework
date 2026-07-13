# 62 — Residency-change CGT fidelity (deemed-acquisition holding period + foreign real property)

**Status**: **PROPOSED** (no code). Gaps validated against the ATO guidance and the live
codebase via `scripts/probe-residency-cgt.mjs` (`npm run probe:residency-cgt`).

**Scope decision (locked with requester):** *plan* implementations for **Gap 1** (deemed-
acquisition holding period) and **Gap 3** (foreign real property AU assessment). *Document
only* — no implementation planned yet — for **Gap 2** (ceasing-residency deemed disposal /
CGT event I1), **Gap 4** (TAP-by-type), and **Gap 5** (pre-CGT assets).

**Source of truth (ATO):**
[How changing residency affects CGT](https://www.ato.gov.au/individuals-and-families/investments-and-assets/capital-gains-tax/foreign-residents-and-capital-gains-tax/how-changing-residency-affects-cgt),
[Taxable Australian property](https://www.ato.gov.au/individuals-and-families/investments-and-assets/capital-gains-tax/foreign-residents-and-capital-gains-tax/taxable-australian-property),
[CGT discount for foreign residents](https://www.ato.gov.au/individuals-and-families/investments-and-assets/capital-gains-tax/foreign-residents-and-capital-gains-tax/cgt-discount-for-foreign-residents).
Builds on `design/36` (dual cost base, s855-45 step-up) and `design/57` (FY2027 CGT reform +
per-lot indexation).

---

## 1. The ATO rules (sourced)

| Event | Rule |
|---|---|
| **Become an AU resident** | Non-TAP CGT assets (foreign shares, foreign real property, gold) are **deemed acquired at market value on the residency date** (ITAA97 s855-45). This resets the AU cost base. |
| **12-month CGT-discount clock** | The Division 115 50% discount requires the asset be held **≥ 12 months**, and after a deemed acquisition the clock **restarts at the residency date** — not the original purchase date. |
| **Taxable Australian Property (TAP)** | AU real estate + AU business assets are **excluded** from deemed acquisition: they keep their original cost base and acquisition date. |
| **Worldwide assessment** | An AU resident is assessable on **worldwide** capital gains, including *foreign* real property (which is non-TAP → gets the deemed-acquisition step-up, subject to the main-residence rules). |
| **Pre-CGT assets** | Assets acquired before 20 Sep 1985 are excluded from deemed acquisition. |
| **Cease AU residency** | CGT **event I1** — deemed disposal of non-TAP assets at market value on departure, gain in the final return; an individual may **elect to disregard/defer** (asset then treated as TAP, deferred until actual disposal or re-residency). |

---

## 2. What the framework already gets right (do not regress)

The premise that the sim "just resets the cost basis" as an oversimplification is **half
wrong**: the reset *is* the correct s855-45 rule for the inbound US→AU move, and it is
implemented faithfully.

- `ChangeResidencyApplyReducer` → `AccountService.recordResidencyChange` stamps
  `holding.costBaseByCountry.AU = marketValue` (market value at the move) per brokerage lot,
  and `acquisitionPriceLevel = cpiAccumulator.AU` for indexation. Gold mirrors via
  `CollectibleService.recordResidencyChange`.
- Genuine **dual cost base**: the universal `costBasis` (US, original, worldwide for the US
  citizen) is untouched; only the AU basis resets. `consumeHoldingsFifo` tallies
  `realizedBasisByCountry.AU`; sale reducers emit both `gain` (US) and `auGain` (AU stepped-
  up) and FTC is computed on `auGain` only (design 36 §12.2, design 52).
- **AU real property (the AU house) is TAP** and is *not* stepped up
  (`RealPropertyService.recordResidencyChange` snapshots value only). Correct.
- No move-date tax settlement — defensible for a US citizen taxed on full-year worldwide
  income (`ChangeResidencyHandler` header).

`scripts/probe-residency-cgt.mjs` CONTROL block confirms the step-up: AU basis = $300,000
(market at move), `acquisitionPriceLevel` = the AU CPI level at the move.

---

## 3. Gap inventory

| # | Gap | Bites reference scenario? | Plan |
|---|---|---|---|
| **1a** | 50% CGT discount applied with **no** holding-period gate | **Yes** (pre-2027 AU-resident sales) | **§4 — planned** |
| **1b** | Post-2027 indexation ≥12-month test keys off original `purchaseDate`, not the reset residency date | **Yes** (post-2027) | **§4 — planned** |
| **3** | Foreign (US) real property gets no AU deemed-acquisition basis and its sale is never AU-assessed | Conditional (US house sold while AU-resident) | **§5 — planned** |
| **2** | No ceasing-residency deemed disposal (CGT event I1) + disregard/defer election | Latent (needs bidirectional moves) | §6 — documented only |
| **4** | TAP decided by asset *type*, not a TAP test (no indirect-AU-real-property interests) | No | §6 — documented only |
| **5** | Pre-CGT (pre-20-Sep-1985) assets not modeled | No | §6 — documented only |

### Probe evidence (Gap 1)

`npm run probe:residency-cgt` — a lot bought 2020, deemed-acquired at the 2024 move, sold 6
months later (held **60 months** from purchase, **6 months** from deemed acquisition):

```
GAP 1b: consumeHoldingsFifo held12mo = true (uses purchaseDate); ATO-correct = false → MISMATCH
GAP 1a: 50% discount granted unconditionally → over-relief $4,800 on a $30,000 gain (16.0%)
```

The $4,800 is per this single small lot; the error scales with the AU gain on every lot
disposed within 12 months of the move (or, pre-2027, within 12 months of *any* acquisition —
the discount has literally no holding test today).

---

## 4. Gap 1 — deemed-acquisition holding period (PLANNED)

### 4.1 Root cause

Two coupled defects:

1. **The 12-month test uses the wrong date.** `consumeHoldingsFifo` (holdings-fifo.js:113)
   computes `held12mo = (asOfMs − purchaseTs(h)) ≥ 12mo`. The step-up deliberately leaves
   `purchaseDate` unchanged (design 57 kept it for the reform's own straddle test), so a lot
   deemed-acquired at the move still reads its pre-move purchase date.
2. **The discount has no holding test at all.** `AuTaxRatesBase._cgtRelief` (au-tax-rates-
   base.js:71) applies `auCapitalGainsYTD * 0.5` unconditionally. The gain arrives at the
   rates module as an **aggregate scalar** — there is no per-lot holding information at that
   point to gate on.

### 4.2 Design

**Introduce a per-country deemed-acquisition date on the lot**, then split the realized gain
into discount-eligible vs discount-ineligible at the sale reducer (where per-lot dates live),
carrying the split forward — mirroring the existing `auGain`/`auIndexedGain` plumbing.

**Step 1 — stamp the deemed-acquisition date.** Add `Holding.acquisitionDateByCountry`
(`{AU: <moveMs>}`, null default), stamped in `AccountService.recordResidencyChange` alongside
`costBaseByCountry.AU` and `acquisitionPriceLevel` (all gated on the same one-time step-up).
For gold, the same on `Collectible`. TAP property is untouched (no step-up path — see §5 for
foreign property, which is a *deliberate* new step-up).

> **Why a new field, not resetting `purchaseDate`:** `purchaseDate` is load-bearing for FIFO
> sort order and for design 57's straddle test; overwriting it would corrupt FIFO ordering and
> the reform's pre/post-2027 logic. A per-country deemed-acquisition date is additive and
> country-scoped, consistent with `costBaseByCountry`.

**Step 2 — the AU 12-month test reads the AU deemed-acquisition date.** In
`consumeHoldingsFifo`, when tallying for a country `c`, the effective acquisition timestamp is
`acquisitionDateByCountry[c] ?? purchaseTs(h)` (fall back to purchase date for lots never
stepped up). This fixes **1b** for the indexation test directly.

**Step 3 — split the realized gain by discount-eligibility.** In the AU-facing sale reducers
(`au-brokerage-classes`, the `account-service` auto-liquidation path, gold's
`CollectibleSaleApplyReducer`, and — from §5 — the foreign-house path), partition the realized
AU gain into:
- `auDiscountableGain` — from lots held ≥12 months measured from the **AU** acquisition date;
- `auNonDiscountableGain` — the remainder.

`consumeHoldingsFifo` already walks each lot with an `asOfMs`; extend its per-country tally to
return `realizedBasisByCountry`/`realizedProceedsByCountry` split by the ≥12-month AU test (a
small additive tally alongside the indexed one). The reducer emits the two components on the
`_TAX` action.

**Step 4 — `_cgtRelief` discounts only the eligible portion.** `AuTaxRatesBase._cgtRelief`
becomes: `reliefAmount = auDiscountableGain * _cgtDiscountRate` (falling back to the full
`auCapitalGainsYTD` when the split fields are absent, so old saves / FY-agnostic callers are
byte-identical). The classification module routes `auDiscountableGain`/`auNonDiscountableGain`
into YTD buckets the rates module reads.

FY2027+ (`AuTaxRates2027`) already removed the discount, so its `_cgtRelief` is unaffected —
but its **indexation** ≥12-month test now benefits from Step 2 (correct clock).

### 4.3 Phases

- **P1** — `Holding.acquisitionDateByCountry` + `Collectible` equivalent (constructor / toJSON
  / fromJSON / TypeRegistry round-trip); stamp it in both `recordResidencyChange` paths.
- **P2** — `consumeHoldingsFifo`: AU effective-acquisition date drives the ≥12-month test
  (fixes 1b); add the discountable/non-discountable per-country split (additive return keys).
- **P3** — sale reducers emit `auDiscountableGain`/`auNonDiscountableGain`; classification
  modules route to buckets; `AuTaxRatesBase._cgtRelief` discounts only the eligible portion
  (with full-gain fallback).
- **P4** — tests (§7) + regold. Reference scenario (moveYear 2031, all post-2027, discount
  already gone) should **not move** on the discount change; the **indexation clock** fix (Step
  2) only moves it if a lot is sold <12 months after the 2031 move — verify.

---

## 5. Gap 3 — foreign real property AU assessment (PLANNED)

### 5.1 Problem

An AU resident is taxable on worldwide capital gains, so a US-citizen AU-resident selling the
**US house** owes AU CGT on the gain measured from the s855-45 stepped-up base (market value at
the move). Today:
- `RealPropertyService.recordResidencyChange` (real-property-service.js:104) snapshots `value`
  only — **no** step-up, even for foreign (non-TAP) property.
- `US_HOUSE_SALE_APPLY` emits `US_HOUSE_SALE_TAX` with only a US `gain` (after the US
  $250k/$500k primary-home exemption). The handler already stamps `residency` on the action,
  but **no AU classifier consumes it** — `US_HOUSE_SALE_TAX` is classified in the US module
  only (design 57 §3 table row "US real property — US-only, no AU assessment").

`RealProperty` already carries `country` (`'US'`/`'AU'`) and `isPrimaryResidence` — the exact
discriminators needed.

### 5.2 Design

**Step 1 — step up foreign property on the move.** In
`RealPropertyService.recordResidencyChange`, when the destination country steps up
(`stepsUpCostBaseOnResidency(country)`) **and** the property is *foreign* to that country
(`property.country !== country` ⇒ non-TAP), stamp `property.costBaseByCountry[country] =
property.value` and `property.acquisitionPriceLevel = priceLevel`. AU-domestic property
(`property.country === 'AU'`) stays TAP — **no** step-up (unchanged; §2). Thread `country`,
`stepUp`, `priceLevel` into the signature (today it takes none) and pass them from
`ChangeResidencyApplyReducer` (it already computes all three).

**Step 2 — AU-assess the foreign-house sale.** Add an `AU_HOUSE_SALE_TAX`-style **AU
classification of `US_HOUSE_SALE_TAX`** (residency === 'AU'), mirroring the cross-border US-
brokerage pattern: route `auGain = max(0, proceeds − auSteppedBasis − auExemption)` into
`auCapitalGainsYTD` (and, FY2027+, `auRealCapitalGainsYTD` via `AuTaxModule2027`, indexed from
`acquisitionPriceLevel`), plus FTC. Compute `auGain` in `US_HOUSE_SALE_APPLY` from
`state[stateKey].costBaseByCountry.AU` and pass it on the action alongside the existing `gain`.
Register the AU reducer additively (`TaxEngine.registerDynamic` runs US + AU per action-type).

**Step 3 — main-residence exemption (DECISION, §8 Q1).** The US $250k/$500k exclusion is US-
only. Australia's main-residence exemption for a *foreign* dwelling has its own rules (and
foreign residents lost it from 2020, but here the seller is an AU *resident*). Options:
(a) treat the US house as fully AU-assessable from the stepped-up base (conservative, simplest);
(b) apply an AU main-residence exemption when `isPrimaryResidence` (needs the AU
proportional/absence rules). **Recommend (a) for v1**, flag (b) as a refinement — the stepped-up
base already removes pre-move gain, so over-taxation is bounded to post-move appreciation.

### 5.3 Phases

- **P1** — `RealProperty.costBaseByCountry` + `acquisitionPriceLevel` (constructor / toJSON /
  fromJSON / state projection / schema); step-up in `RealPropertyService.recordResidencyChange`
  for foreign property; thread the opts through `ChangeResidencyApplyReducer`.
- **P2** — `US_HOUSE_SALE_APPLY` computes `auGain`; new AU classifier for `US_HOUSE_SALE_TAX`
  routes it (2026 → `auCapitalGainsYTD`; 2027 → `auRealCapitalGainsYTD` indexed) + FTC.
- **P3** — main-residence treatment per §8 Q1; tests + regold.

---

## 6. Documented, not planned

### Gap 2 — ceasing-residency deemed disposal (CGT event I1)
Leaving AU triggers I1: deemed disposal of non-TAP assets at market value on departure, gain in
the final return, with an individual **election to disregard/defer** (asset then treated as TAP;
deferred until actual disposal or re-residency; a DTA may override). **Blocked**: the framework
models only a single one-directional US→AU `CHANGE_RESIDENCY` (`moveYear`, pinned to 1 Jul; see
`us-au-cross-border-toolset.js`). Implementing I1 needs (a) an outbound residency-change event
+ direction awareness, (b) a move-date CGT settlement action (currently `ChangeResidencyHandler`
deliberately emits none), and (c) an election flag with the TAP-reclassification + deferral
bookkeeping. Revisit when bidirectional / return moves land on the roadmap.

### Gap 4 — TAP by asset type, not a TAP test
TAP is currently structural: AU property = TAP (no step-up); US shares/gold = non-TAP (stepped
up). Correct for the modeled assets, but there is no handling of *indirect Australian real
property interests* (e.g. ≥10% holdings in land-rich entities) or business-use assets. Low
priority for a personal retirement scenario; capture as an explicit modeling assumption.

### Gap 5 — pre-CGT assets
Assets acquired before 20 Sep 1985 are excluded from deemed acquisition. Irrelevant to a
forward-looking retirement sim (no pre-1985 lots); note-only.

---

## 7. Testing plan

`tests/unit/evt-residency-cgt.test.mjs` (new, `EVT-*`):
- **Discount gate (1a):** AU-resident lot sold **<12 months** after the move ⇒ **no** 50%
  discount; sold **≥12 months** after ⇒ discount applies. Pre-2027 rates module.
- **Indexation clock (1b):** post-2027 lot sold <12 months after the move ⇒ `held12mo` false
  from the AU deemed-acquisition date (no indexation), even though purchase was years earlier.
- **Step-up preserved:** the CONTROL invariants from the probe (AU basis = market at move;
  `acquisitionDateByCountry.AU` = move date; `purchaseDate` unchanged; FIFO order intact).
- **Foreign house (Gap 3):** US house stepped up at the move; sold while AU-resident ⇒ AU gain
  from the stepped-up base routed to `auCapitalGainsYTD` (2026) / `auRealCapitalGainsYTD`
  (2027) + FTC; AU house (TAP) still **not** stepped up.
- **Fallback safety:** actions without the new split/deemed-date fields ⇒ byte-identical to
  today (old-save round-trip).
- Serializer round-trip for `acquisitionDateByCountry` + `RealProperty.costBaseByCountry`.

**Regression harness:** `npm run probe:residency-cgt` should flip GAP 1a/1b to `RESOLVED` after
P1–P3; keep it as the fast, code-path-exercising check. Re-run
`cross-border-relief-scenario.test.mjs` (moveYear 2031) — expect **no movement** from the
discount change; investigate any move (would indicate a <12mo post-2031 sale caught by the
indexation-clock fix). `npm run test:unit` + `npm run test:viz` + `npm run build:index`.

---

## 8. Open questions

1. **AU main-residence exemption for the foreign (US) house** (§5.3): v1 = fully assessable
   from stepped-up base (recommended), or model the AU main-residence rules? *Assumed (a).*
2. **Discount-split placement:** compute `auDiscountableGain` inside `consumeHoldingsFifo`
   (per-lot, most accurate — recommended) vs approximate in the rates module (loses per-lot
   dates). *Assumed the former, consistent with design 57 Option A.*
3. **New field naming:** `Holding.acquisitionDateByCountry` (parallels `costBaseByCountry`) vs a
   scalar `deemedAcquisitionMs`. *Assumed the per-country map for consistency + future multi-
   jurisdiction moves.*
