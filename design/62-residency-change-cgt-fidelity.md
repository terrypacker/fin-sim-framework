# 62 — Residency-change CGT fidelity (deemed-acquisition holding period + foreign real property)

**Status**: **Gaps 1 & 3 IMPLEMENTED + green** (3376 unit + 865 viz). Gap 1 (`npm run
probe:residency-cgt`) committed on `main`; Gap 3 (`npm run probe:foreign-property-cgt`)
uncommitted. Gaps 2/4/5 documented only. Gaps validated against the ATO guidance and the live
codebase via the two probes.

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

### 4.3 Phases — ALL DONE (green: 3371 unit + 865 viz)

- **P1 ✅** — `Holding.acquisitionDateByCountry` (+ `Collectible` equivalent): constructor /
  toJSON / fromJSON / serializer + state-projection carry sites. Stamped in both
  `AccountService.recordResidencyChange` and `CollectibleService.recordResidencyChange`
  (move date threaded from `ChangeResidencyApplyReducer` as `asOfMs`). `purchaseDate` is left
  unchanged.
- **P2 ✅** — `consumeHoldingsFifo`: the AU ≥12-month test now runs from
  `acquisitionDateByCountry[c] ?? purchaseDate` (fixes 1b for indexation too); added
  `realizedDiscountableGainByCountry` (equity/bond lots held ≥12mo from the deemed-acquisition
  date, per-lot floored). The `level`-less `{ asOfMs, country }` form lets the auto-liquidation
  drawdown path compute the split without triggering indexation. The auto-liquidation path
  passes the AU context **only for AU residents**, so US-only runs are byte-identical.
- **P3 ✅** — the two brokerage sale paths (`au-brokerage-classes` AU_STOCK_WITHDRAWAL_TAX and
  `AccountService._drawPenaltyFree` STOCK_WITHDRAWAL_TAX) emit `auDiscountableGain =
  min(auGain, realizedDiscountableGainByCountry.AU)`. Classification modules route it into a new
  `auDiscountableGainsYTD` (+ `auPersonDiscountableGainsYTD`) bucket, in lockstep with
  `auCapitalGainsYTD`. `AuTaxRatesBase._cgtRelief` discounts only `min(gain,
  auDiscountableGainsYTD)`, with a full-gain fallback when the field is absent (old saves /
  synthetic states). Wired through: AU_TAX state init, YTD reset (`tax-settle-classes`),
  per-person slice (`computeAuTaxPerPerson`), `StateSchemaRegistry`, `intl-retirement-state`.
- **P4 ✅** — `tests/unit/evt-residency-cgt.test.mjs` (8 cases, EVT-62); `probe-residency-cgt.mjs`
  reworked into a pass/fail regression check (Lot A <12mo denied, Lot B ≥12mo allowed, over-
  relief $4,800 recovered on a $30k gain). Reference golden (`cross-border-relief-scenario`,
  moveYear 2031) did **not move** — post-2027 (discount already gone) and no <12-month post-move
  sale trips the indexation-clock fix, exactly as predicted.

> **Scope note — non-residency holding-period gating (company / collectible / TAP property).**
> The residency deemed-acquisition gate targets **brokerage lots**, the assets s855-45 steps up.
> The other AU-capital-gain paths (`COMPANY_SALE_TAX`, `COLLECTIBLE_SALE_TAX`, `AU_HOUSE_SALE_TAX`)
> carry no per-lot 12-month tracking here, so they default their **full** gain into
> `auDiscountableGainsYTD` — preserving today's behavior (they keep the 50% discount). Gating
> those on their own acquisition-vs-sale holding period is a separate, non-residency refinement,
> deliberately **out of Gap 1's scope** (and it does not touch the reference scenario, whose only
> such sale is the post-2027 company-equity disposal where the discount is already removed).

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
proportional/absence rules). **DECIDED: (b) — model the AU main-residence rules** (§8.1). The
stepped-up base removes pre-move gain; the AU main-residence proportional exemption + 6-year
absence rule then apply to the post-move gain on the dwelling.

### 5.3 Phases — ALL DONE (green: 3376 unit + 865 viz; `npm run probe:foreign-property-cgt`)

- **P1 ✅** — `RealProperty.costBaseByCountry` + `acquisitionPriceLevel` +
  `acquisitionDateByCountry` (constructor / serializer serialize+make / US state projection).
  `RealPropertyService.recordResidencyChange` steps up **foreign** property only
  (`property.country !== country` ⇒ non-TAP); domestic AU property is snapshotted but not
  stepped up. `ChangeResidencyApplyReducer` gained a copy-on-write real-property loop
  (threading `country/stepUp/priceLevel/asOfMs`). **Runtime wiring fix:** the compiler
  `_buildContext` did not expose `realPropertyService` — added (the end-to-end probe caught
  this; unit tests could not).
- **P2 ✅** — `US_HOUSE_SALE_APPLY` computes `auGain` from `state[stateKey].costBaseByCountry.AU`
  and emits `auGain`/`auDiscountableGain`/`residency` on `US_HOUSE_SALE_TAX`. The US module's
  `US_HOUSE_SALE_TAX` classifier gained an AU-resident branch (→ `auCapitalGainsYTD` +
  `auDiscountableGainsYTD` + the FITO removal set `usSourceCapGains*`, US-source so no foreign-
  passive entry). `AuTaxModule2027` routes it into `auRealCapitalGainsYTD` **un-indexed**
  (property indexation deferred, design 57 §6.4 — same as `AU_HOUSE_SALE_TAX`).
- **P3 ✅** — `auMainResidenceExemptFraction` models ITAA97 s118-145: investment property ⇒ 0
  (fully assessable); main residence not income-producing ⇒ 1 (indefinite absence); main
  residence income-producing ⇒ the **6-year absence rule** applied proportionally
  (`min(6y, ownership)/ownership` from the move to sale). The non-exempt slice is discount-gated
  on ≥12 months from the deemed acquisition (Gap 1 §4). Simplification: assumes the foreign
  dwelling retains the exemption — a competing AU main-residence claim would reduce it (not
  modeled). Tests: `tests/unit/evt-foreign-property-cgt.test.mjs` (5 cases) + the runtime probe
  (Run A primary-not-rented ⇒ auGain 0; Run B investment ⇒ auGain $206,659 on a $1.42M sale).
  Reference golden unchanged (the default US house is never sold).

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

## 8. Resolved decisions

1. **AU main-residence exemption for the foreign (US) house** (§5.3): **model the AU main-
   residence rules** (not the fully-assessable simplification). Gap 3 / §5.3 option (b). The AU
   proportional main-residence exemption + absence rule apply to the foreign dwelling; the US
   $250k/$500k exclusion stays US-side only.
2. **Discount-split placement:** compute `auDiscountableGain` inside `consumeHoldingsFifo` (per-
   lot, most accurate), consistent with design 57 Option A. **Confirmed.**
3. **New field naming:** `Holding.acquisitionDateByCountry` (parallels `costBaseByCountry`), a
   per-country map for consistency + future multi-jurisdiction moves. **Confirmed.**
