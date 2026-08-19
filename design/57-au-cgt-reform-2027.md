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
  indexation is deferred **to the §6.4 work** — house gains route into the real bucket
  un-indexed for now, so the discount-removal + 30% floor still apply. *(That deferral
  outlived its plan by two phases: Part 2 Item B deleted the §6.4 deemed reset without
  revisiting property, and the code comment hardened into "property is never indexed."
  Closed by **Part 4** below.)*
- **Phase 4 (done)** — activates the reform: the **1 July 2027 deemed cost base reset**
  (`AuCgtBasisResetReducer` + `AuCgtBasisResetHandler`, scheduled by the `AU_TAX` toolset
  only when the sim spans the date) restamps each AU_STOCK lot's `costBaseByCountry.AU` to
  market value and `acquisitionPriceLevel` to the July-2027 level (keeping `purchaseDate` for
  the 12-month test); and the **Age Pension / JobSeeker exemption** (`Person.incomeSupportRecipient`
  → projected into `state.people` → `computeAuTaxPerPerson` stamps `auMinTaxExempt` →
  `AuTaxRates2027._cgtRelief` zeroes `minTaxRate`). New classes are registered in the
  serializer's framework-class list and the reducer coverage manifest. **Reference scenario
  net worth moves \$10,978,107 → \$10,914,370** — the reform now bites on post-2027 AU-resident
  gains (exemption of pre-2027 gains, offset by discount removal + 30% floor).
- **Part 3 (done, 2026-08-04)** — the 30% top-up was added *outside* the offset clamp, so no
  franking credit or FITO could reach it and the printed return did not foot. Reported as
  design 84 G10 and misfiled there as a per-person attribution defect. See **Part 3** below.

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
(not undefined), `??` never falls back → assesses **0** → **100% relief, AU CGT ≈ \$0**.

**Interaction:** Bug 1 *masked* Bug 2. With the wrapper reverting to the 50% discount on the
(populated) gross bucket, drawdown-path gains were at least taxed at 50%. "Fixing" Bug 1 alone
(delegating the CGT hooks) switches assessment to the empty real bucket → CGT drops to 0. Both
must be fixed together. Observed on the design-52 golden: wrapper-fix-alone swung lifetime tax
**−18%** (that was CGT being *zeroed*, initially mis-read as "legitimate indexation").

**Status: reverted to a clean baseline pending a proper fix.** The wrapper delegation and the
design-52 regold were both backed out; only the safe report changes remain (`AuTaxDocument2027`
registered; "Tax on Income" ordinary-vs-CGT breakdown sub-rows). The Phase-4 reference figures
(§ −\$63.7k, "reform bites") were measured **under Bug 1+2** and are **not trustworthy**.

**Full inventory of AU-resident capital-gain paths (verified 2026-07-11):**

| Path | Action type | Classified in | Real-bucket routed? |
|---|---|---|---|
| AU brokerage sale | `AU_STOCK_WITHDRAWAL_TAX` | AU module | ✅ indexed (`auIndexedGain`) |
| AU property sale | `AU_HOUSE_SALE_TAX` | AU module | ✅ raw gain (indexation deferred §6.4 — now indexed, **Part 4**) |
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
| AU property | raw gain, indexation deferred — *superseded by **Part 4**: indexed like every other AU CGT asset* |
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

### ✅ COMPLETE (2026-07-11) — both coupled bugs fixed

The 7-point checklist below is **done**; `npm run test:unit` (3318) + `test:viz` (864) are
GREEN. The AU CGT reform now applies to inflation-adjusted post-2027 years for AU residents:

- **Bug 1 fixed** — `InflationAdjustedAuTaxRates` now stores `this._base` and delegates
  `_cgtRelief` / `_cgtReliefLabel` (and copies `_cgtDiscountRate`), so wrapping FY2027 no
  longer reverts to the base 50% discount.
- **Bug 2 fixed** — the US-module cross-border CGT actions (`STOCK_WITHDRAWAL_TAX`,
  `COMPANY_SALE_TAX`, `COLLECTIBLE_SALE_TAX`) now feed the reform real bucket via **additive**
  `AuTaxModule2027` reducers (DynamicTaxReducer registers per (country, action-type), so the
  US + AU reducers both run), so `auRealCapitalGainsYTD` is populated in lockstep with the
  gross bucket — no more present-zero → 100% relief. `_cgtRelief` reads the bucket directly
  (`'auRealCapitalGainsYTD' in state`), gross fallback only for truly-absent synthetic states.
- **Indexation wiring** — residency step-up stamps `acquisitionPriceLevel` (= AU price level at
  the move) alongside the s855-45 cost-base step-up; the US-brokerage sale reducer computes
  `auIndexedGain` (equity + gold sleeve, `isGold` marker); `consumeHoldingsFifo` returns the
  collectible slice's un-indexed + indexed AU basis so bullion indexes while true collectibles
  don't.

**Verified (reference `IntlRetirementScenario`, moveYear 2031, simEnd 2050):** the only
AU-assessed capital gain is the 2033 company-equity sale (correctly full-gain / un-indexed).
Post-fix headline: **lifetime tax ~1,068,129** (was 895,088 with the buggy 50% discount),
**ending net worth ~11,563,957**. Per-person FY2032 settle shows label
`CGT Discount Removed (FY2027+)`, relief 0, real gain assessed (not zeroed), FITO applied.
`cross-border-relief-scenario.test.mjs` re-golded to these figures. Indexation of
US-brokerage stock / gold is **not** exercised by this scenario (no such AU-resident sales); it
is covered by `evt-au-cgt-reform.test.mjs` unit tests instead.

**Not built (deferred, unchanged from below):** Method-2 apportionment, new-build election,
dedicated ATO CPI series, standalone-`Collectible` (non-sleeve) gold indexation (needs AU-basis
tracking on `Collectible`), and the FY2027 FITO-limit "without" pass reducing the real bucket
(immaterial here — the limit doesn't bind when US tax paid < AU marginal tax on the gain).
**See PART 2 plan below.**

---

### ✅ PART 2 — ACCURACY PASS (COMPLETE 2026-07-12)

**All four items (A CPI · D FITO · C standalone gold · B remove reset) implemented + green:
3327 unit + 864 viz.** The reference golden (`cross-border-relief-scenario.test.mjs`, moveYear
2031) did **NOT move** — exactly as predicted (CPI defaults to inflation, byte-identical; FITO
limit doesn't bind; standalone gold isn't sold). Runtime-verified: `cpiAccumulator.AU ===
inflationAccumulator.AU` end-to-end, and the reference Gold collectible is stepped up at the 2031
move (AU basis + acquisition CPI level stamped).

What landed:
- **A (CPI):** `state.cpiRates` + `state.cpiAccumulator`, compounded in `InflationAdjustReducer`
  (falls back to the effective inflation rate when a country's CPI is unset → no golden movement).
  All indexation reads (`us-/au-brokerage`, residency step-up, gold sale) switched to
  `cpiAccumulator.AU ?? inflationAccumulator.AU ?? 1`. New `auCpiRate` param (AU_TAX toolset);
  registered in `StateSchemaRegistry` + shallow-merge keys; round-trips.
- **D (FITO):** `usSourceRealCapGainsAudYTD` populated by the 3 AU-2027 cross-border reducers;
  the FY2027 FITO "without" pass now reduces `auRealCapitalGainsYTD` by it (the CG slice of the
  limit tracks the real gain). Init/YTD-reset/schema/per-person-split all wired.
- **C (standalone gold):** `Collectible.isGold/costBaseByCountry/acquisitionPriceLevel`;
  `CollectibleService.recordResidencyChange` steps up gold at the AU move (via a new collectibles
  loop in `ChangeResidencyApplyReducer` — `collectibleService` threaded through the compiler
  context + reducer fromJSON); `CollectibleSaleApplyReducer` computes `auGain`/`auIndexedGain`/
  `isGold` on `COLLECTIBLE_SALE_TAX`. Serializer + state-projection carry the fields.
- **B (remove reset):** deleted `au-cgt-reset-classes.js` + `AU_CGT_BASIS_RESET*` wiring from
  `AU_TAX`; removed the dead EVT-CGT-RESET tests + coverage-manifest entry. A straddling lot now
  keeps its residency-step-up AU basis and applies the new regime to its **whole** gain (no
  apportionment, no pre-2027 carve-out) — covered by the new STRADDLE unit test.

---

### ✅ Part 3 (2026-08-04) — the top-up sat OUTSIDE the offsets

Reported as **design 84 G10** ("the spouse's AU return does not foot in nine years") and filed
there against design 76/77 per-person attribution. **That diagnosis was wrong**, and how it went
wrong is the transferable part: the violation appeared on one filer and not the other, and a
per-person defect is the obvious reading of a per-person symptom. It is a design 57 defect, and
the split was a red herring — the spouse is simply the low-ordinary-income filer, the only one
whose liability the 30% floor ever dominates. The primary's top-up is **0.00 in every year of
the run**, because their ordinary income pushes every gain into the ≥30% brackets, which is the
floor working as designed. One filer showing a defect is not evidence the defect is about
filers.

**The defect.** `netLiability` added the minimum-tax top-up *after* the offset clamp:

```js
netLiability = Math.max(0, baseTax + medicareLevy - frankingOffset - fito) + minTaxTopUp;
```

so the top-up was a levy no offset could reach. A return whose whole liability was the top-up
paid it in full while its Foreign Income Tax Offset was clamped away against a zero `baseTax`
and silently lost. The same shape sat in `netLiabilityPreFito`.

Three things were mutually inconsistent, so the code was wrong under *either* reading of the
reform:

1. The **document** has always printed the top-up inside `Gross Tax`, with the Credits section
   beneath it — i.e. as offsettable.
2. The **§770-75 limit** is a difference of two `netLiabilityPreFito` values, both of which
   include the top-up — so the offset was *sized* as though the top-up were offsettable.
3. The **net** then applied it as though it were not.

Resolved in favour of offsettable. §6.3 already defines the top-up as an incremental floor on
the *gain's own marginal tax* and explicitly rejects whole-liability `max()` semantics; it
floors the rate applied to the gain against the bracket schedule, and nothing in §1's sourced
material makes it an anti-offset levy. So:

```js
netLiability = baseTax + medicareLevy + minTaxTopUp - frankingOffset - fito;
```

**A second, smaller defect fell out of it.** The A\$1,000 de-minimis shortcut skips the limit
calculation entirely, so it could hand over more offset than the return had liability to absorb
— which the old `Math.max(0, …)` swallowed silently. `fito` is now capped at the pre-FITO
liability, so it means "offset actually **taken**", which is what the Credits line states and
what the worksheet's "excess forfeited" row subtracts. A wasted de-minimis offset now shows as
forfeited instead of vanishing.

With both caps in place the net is a plain subtraction with no clamp, which is what makes
design 71 §6's `Gross Tax + credits = Net Tax Liability` hold **by construction** rather than
by luck.

**Franking credits cannot trigger this** — `frankingOffset` is capped at `baseTax`, so it can
never exceed `baseTax + medicareLevy` and never reached the clamp. Every observed violation
showed zero franking credits. That cap is a separate, pre-2027 fidelity question (real franking
credits are refundable and apply against the whole liability including the Medicare levy); it
foots either way, so it is **not** part of this fix and is left open deliberately rather than
widened in passing.

**Inert except where it bites.** For FY≤2026 `minTaxTopUp` is 0 and the new formula collapses
to the old one exactly. For FY2027+ it differs only when the offsets exceed `baseTax +
medicareLevy` — the ordinary-income-dominated return, which is most of them, is untouched. The
golden did not move and no baseline was re-taken. That is the same signature as design 84 G12:
nothing in the committed corpus exercised the path, which is why 4,367 green tests and a
passing golden coexisted with a return that did not add up.

7 tests in `tests/unit/au-min-tax-topup-offsets.test.mjs`, 5 of which fail against the pre-fix
code (the two that pass are the inertness assertions, which must pass both ways or they are
testing nothing).

---

### ✅ Part 4 (2026-08-18) — real property finally gets the indexation half

Found by the `au-house-sale` study (F2). A dwelling sold post-2027 was taking the reform's
**penalty** — Division 115's 50% discount removed, the 30% minimum-tax floor applied — and
none of its **relief**: `AU_HOUSE_SALE_TAX` booked the RAW gain into `auRealCapitalGainsYTD`,
which is the bucket `AuTaxRates2027._cgtRelief` actually assesses. Every other AU CGT asset in
the model was already indexed (brokerage lots per lot in `consumeHoldingsFifo`; bullion and
company equity from the level stamped at the s855-45 step-up), so the asymmetry was visible
*inside a single return*: share disposals printed a cost-base indexation relief line while the
house printed none.

**This was never a decision — it was a stale comment.** §10 Phase 3 said "property indexation
deferred to §6.4", meaning the §6.4 deemed-reset work would deliver it. Phase 4 built the reset
for AU_STOCK lots only, Part 2 Item B then **deleted the deemed reset outright**, and nobody
revisited property. The comment in `au-tax-module-2027.js` had meanwhile hardened into a flat
"property cost-base indexation is deferred", which is not what any section of this design says.
Item B's own rationale makes the gap self-contradictory: it taxes the **whole** gain of an asset
held across 1 July 2027 precisely because "cost-base indexation already relieves the inflationary
part of the whole holding period" — which was false for the one asset class that never indexed.

**Built:**

1. **`auIndexedCostBase()` in `holdings/holding-period.js`** — the scalar-asset analogue of the
   per-lot factor `consumeHoldingsFifo` computes. Same module, and for the same stated reason:
   this is a per-asset fact that reaches several emitters, and it drifts if each one re-inlines
   it. Alongside it, `auCpiLevel(state)` / `auCpiRate(state)` read the dedicated ATO series with
   exactly `InflationAdjustReducer`'s fallback order, so the stamp and the sale index off the
   same series (Item A).
2. **`auIndexedGain` on `AU_HOUSE_SALE_TAX`** (`au-real-property-classes.js`) — the indexed
   analogue of `AuTaxModule2026.auAssessableHouseGain`: same `min` against the US-basis gain,
   same s118-185 fraction. It must be the *assessable* figure, because that is what the rates
   module taxes — emitting the pre-exemption gain here would re-open the phantom-assessable-income
   defect the un-indexed path already had to fix.
3. **`auIndexedGain` on `US_HOUSE_SALE_TAX`** (`us-real-property-classes.js`) — the AU resident's
   assessment of a foreign dwelling, indexed from the level stamped at the move, exemption applied
   after. `AuTaxModule2027` now reads it in preference to the nominal `auGain`.
4. **`PropertyPurchaseApplyReducer` stamps `acquisitionPriceLevel`** — a dwelling bought during
   the run is acquired at a known price level, so record it exactly rather than back-casting it.
5. **AU real-property state projection carries `acquisitionPriceLevel`** when the author sets one
   (projected only when set, so an unstated plan's state stays byte-identical). The sale reducer
   reads the STATE entry, not the record — design 76 Gap A — so without this the author's field
   would be silently inert.

**The back-cast, and why it is the interesting decision.** An AU-situs dwelling is *taxable
Australian property*: it never receives the s855-45 residency step-up, so nothing ever stamps its
`acquisitionPriceLevel`. A house the plan already owned at t0 therefore has a real acquisition
date and no price level — the accumulator is 1.0 at sim start and knows nothing about the years
before it. `auIndexedCostBase` compounds the run's own CPI rate from `acquisitionDate` to the
disposal to recover the missing factor. The pre-run CPI is not observed; the run's rate stands in
for it, the same proxy §6.3 already accepts for the forward series. An author who knows the real
figure sets `acquisitionPriceLevel` on the property and takes the exact ratio instead.

**Where relief still does not reach:** a property with **no `acquisitionDate` at all** is not
indexed. §6.3's sentence "lots bootstrapped from the scenario get the sim-start level (1.0)"
would instead index it from t0 — but `consumeHoldingsFifo` has never done that (a lot with no
level indexes at factor 1), and making property the one asset class that grants relief off a
missing field would be worse than the inconsistency it fixes. Relief follows a *stated*
acquisition, which is also what the ATO requires. The return prints a zero indexation-relief line
when this bites, so it is visible rather than silent. **Note the reference scenario's AU House
states no `acquisitionDate`** — which is why no golden moved on this change.

**Measured** on the `au-house-sale` v3 study (AU dwelling acquired 2016-07-01, sold 2032-01-15,
AU CPI 3%): the FY2031-32 AU liability falls by **~54%**, entirely from the indexation relief
line, and the indexed cost base is ~1.58× the nominal one. `--check` footing invariants pass on
all nine settled years. `test:unit` 5190 + `test:viz` 1038 GREEN, with a new
`tests/unit/evt-au-cgt-property-indexation.test.mjs` (13 tests) covering the factor, the 12-month
gate, the no-downward-ratchet rule, the assessable-gain composition, the loss case, both dwelling
paths, and the purchase stamp.

**Still open after this:** F5 (the indexation-relief line prints as a negative) — **read as a
presentation question here, and that reading was wrong; see Part 5** — and the un-gated 12-month
test on the *company equity* and *bullion* scalar paths, which compute their factor inline and
never check the Division 115 clock. Both are independent of this change.

---

### ✅ Part 5 (2026-08-18) — the two CGT buckets were partitions of different quantities

Found by the `au-house-sale` study (F5). An AU-resident FY2031-32 return printed an indexed
(real) gain *larger* than the gross nominal gain it derives from, so `reliefAmount = gross − real`
came out **negative** and the "Cost-Base Indexation Relief" line **added** assessable income. Part
4 filed this as a presentation defect. It is not: indexation raises the cost base, so the real
gain is a slice of the nominal one and can never exceed it. A negative relief line is a partition
violation surfacing, not a sign convention.

**The cause.** `COLLECTIBLE_SALE_TAX` is classified **twice** — `UsTaxModule2026` books the AU
*nominal* buckets (§6.5's cross-border lockstep), `AuTaxModule2027` books the *real* one. The two
measured the same disposal with different rulers:

| | booked | measured from |
|---|---|---|
| `UsTaxModule2026` | `auCapitalGainsYTD`, `auDiscountableGainsYTD` | `action.gain` — the **US** gain, from the original basis |
| `AuTaxModule2027` | `auRealCapitalGainsYTD` | `action.auIndexedGain ?? auGain` — the **AU** gain, from the s855-45 step-up |

Bullion held through a move has a *higher* AU gain than US gain, because Australia's basis is the
step-up at the move rather than the original cost. So the real bucket outgrew the nominal one on
every gold disposal, by the difference between the two bases. Every sibling classifier already
derived `const auGainUsd = action.auGain ?? gain;` first — `STOCK_WITHDRAWAL_TAX`,
`COMPANY_SALE_TAX`, `US_HOUSE_SALE_TAX`, and the tax-document registry all do. Only the
collectible one read the US gain, and it did so in *three* places at once: the character split,
the nominal booking, and `usSourceCapGainsAudYTD` — the Art. 22(2) removal set that must be the
same measure as the bucket it is subtracted from.

**A second symptom from the same line.** `characterizeAuCapitalGain` derives the discount-eligible
slice as `long = auTaxableGain − short`. With `auTaxableGain` the US gain and `short` the stamped
**AU** short-term slice, the subtraction crossed rulers and `long` came out **negative** — a gold
disposal *reduced* the household's Division 115 base. Under FY2027+ that bucket is not assessed,
so it cost nothing here; under FY2026 rates it is a straight understatement of the discount.

**Cash effect: none, in the measured run.** FY2027+ assesses the *real* bucket, and the real
bucket was already right — only the nominal one (a display figure, plus the FITO removal set's
denominator) was wrong. The defect's whole cost was a return that did not foot.

**Built:**

1. **`us-tax-module-2026.js` `COLLECTIBLE_SALE_TAX`** derives `auGainUsd` and measures the AU
   character split, the AU nominal booking, and the AUD US-source slice on it.
2. **The invariant, asserted** — `AuTaxRates2027._cgtRelief` now refuses a real gain that exceeds
   the nominal gain it is a slice of. Strict (throw) in dev/test, `AU_INDEXATION_STRICT=off` or a
   production build downgrades it to a warning plus a clamp to the nominal gain, so a user's run
   survives with a zero relief line rather than a negative one and the return still foots.
3. **Not enforced on the FITO counterfactual.** `computeTax` stamps `_fitoCounterfactual` on the
   "without US-source" state. That pass subtracts `usSourceCapGainsAudYTD` from one bucket and
   `usSourceRealCapGainsAudYTD` from the other; when a classifier fails to stamp the real slice,
   the counterfactual's real bucket stays whole while its nominal one empties and the limit's CG
   component collapses. That collapse is the **detector** for Part 2 Item D (`FITO-D`) — clamping
   it would hide the missing signal, which is exactly what the `_applyCapitalLosses` comment on
   the real bucket already refuses to do for the same reason.
4. **A static reader-side rule** in `disposal-tax-payload-parity.test.mjs`: every
   `characterizeAuCapitalGain(action, …)` call site must measure on an AU gain. The existing tests
   in that file check emitters *stamp* `auGain`; this checks the tax modules then *use* it.

**Why the aggregate assertion is not enough on its own, and the static rule is the real guard.**
The violation is per-disposal, but `_cgtRelief` only ever sees a year's totals. In the study run
the house sale's genuine indexation relief was far larger than the gold disposals' excess, so the
*sum* stayed the right way round and the assertion never fired — the negative relief only surfaced
on an arm where the two happened to be close. An invariant checked on a sum catches a defect only
once it grows big enough to flip the sum; the static scan catches it at the line. Both are kept:
the assertion is the backstop for a classifier the scan does not know about.

**Verified:** `test:unit` 5195 + `test:viz` 1038 GREEN; no golden moved (the reference plan has no
AU-resident collectible disposal, which is why this survived to be found by a study). Reverting the
one-line measure change makes the static rule fail, naming the file and line.

---

### ✅ Part 6 (2026-08-18) — a capital LOSS reached the two buckets differently

Part 5 left a note about a suspected double count in `_applyCapitalLosses`. It is real, and
chasing it turned up a **larger** defect with the same root cause: the nominal and real buckets
did not agree on whether a capital loss exists.

**ITAA97 s960-275 — indexation can neither create nor increase a capital loss.** So a loss carries
no relief at all: it must reduce `auRealCapitalGainsYTD` by exactly what it reduces
`auCapitalGainsYTD` by. Two conventions were in the tree at once:

- **Five emitters floor it** — `auIndexedGain = Math.max(0, proceeds − indexedBasis)`. That does
  not express "no indexation on a loss"; it means the loss **never reaches the real bucket**.
- **`AU_HOUSE_SALE_TAX` signs it** — `auSignedIndexedGain = auSignedGain <= 0 ? auSignedGain : …`,
  citing s960-275 in as many words. Correct, and the odd one out.

`_applyCapitalLosses` was written against the first convention: it re-derives the year's
current-year losses from a *bucket* that came out negative and subtracts that from the real gain.
Which produces the wrong answer for both conventions, in opposite directions:

| | what happens | effect on the FY2027 assessment |
|---|---|---|
| floored emitter, loss beside a larger gain **in the same bucket** | no bucket goes negative, so nothing is reconstructed and nothing is subtracted — and the loss was never in the real bucket either | the loss is **silently dropped**; a A\$1,000 gain indexed to A\$600 sold beside a A\$400 loss assessed **A\$600 instead of A\$200** |
| signed emitter (AU house), loss in a bucket that **does** go negative | the loss is inside the real bucket *and* reconstructed and subtracted again | assessed gain understated by the loss, **counted twice** |

The nominal side was right throughout — `nettedTotal` re-applies the reconstructed loss to the
floored positives, which reproduces the figure the signed accumulator already held. Only the real
bucket, which is not re-derived that way, took it twice or not at all.

**Built:**

1. **`auRealCapitalGain(nominal, indexed)`** in `capital-gain-character.js` — the per-disposal
   rule, in one place: s960-275 for a loss (take the signed nominal), and `real ≤ nominal` for a
   gain. The second half enforces the **Part 5 invariant per disposal**, which is what turns
   `_cgtRelief`'s year-total assertion into a genuine backstop rather than the only check.
2. **`signedAuCapitalGain(action, auGain)`** beside it — the exact figure
   `characterizeAuCapitalGain`'s caller books into the nominal bucket, *derived from the split
   rather than restated*. `AuTaxModule2027._realGain` measures the real amount against that, so
   the pair cannot drift the way Part 5 found them drifted. `AU_HOUSE_SALE_TAX` supplies its own
   nominal (`auAssessableHouseGain`, exemption-applied) and calls the rule directly.
3. **`_applyCapitalLosses` subtracts only the PRIOR-YEAR pool from the real bucket.** With the
   real accumulator signed, the current-year loss is already inside it; the reconstruction above
   is not new information. The carried-forward pool genuinely lives outside the year's
   accumulators, so it still comes off both — at face value, since the Act gives a carried-forward
   loss no indexation either. The nominal worksheet still reports both s102-5 steps in `applied`.

**Measured: no cash effect anywhere in the suite or the study.** Neither the reference plan nor
any `au-house-sale` arm books an AU-resident disposal at a loss — under design 90 §4 all equity
sleeves are one draw × beta, so a loss is structurally unreachable — which is exactly why both
defects survived. The fix is latent until equity fidelity makes losses reachable, and it is worth
having in place before that rather than after.

**Verified:** `test:unit` 5200 + `test:viz` 1038 GREEN, no golden moved. Three new tests in
`evt-au-cgt-reform.test.mjs`: a table-driven pass asserting every one of the six disposal types
moves both buckets identically on a loss; the same-bucket case; and the prior-year pool. Reverting
either half of the fix fails them — the module rule fails all three, the `pyApplied` change fails
the pool test with the double-counted figure.

---

#### 📋 Original Part 2 plan (kept for provenance)

**Part 1 (the two coupled bugs) is committed on a branch.** Part 2 makes the reform *accurate*:
four deferred items. **Decisions are LOCKED** (asked & answered 2026-07-11):

- **CPI model = separate rate + accumulator.** Decouple the indexation index from household
  wage/expense inflation via a per-country `cpiRates.{cc}` param (default = the inflation rate,
  so byte-identical until a distinct CPI is set) compounded into a new `cpiAccumulator.{cc}`.
- **Transition = new rule on the full gain (no apportionment / no election).** A lot straddling
  1 Jul 2027 applies the FY2027+ regime (no 50% discount, cost-base indexation, 30% floor) to its
  **whole** AU gain — do NOT carve out a pre-2027 portion. Simpler than apportionment and it still
  fixes today's over-relief (the deemed 2027 reset currently **exempts** pre-2027 gains).
  Mechanically this means **remove the deemed cost-base reset** (Part 1's `AuCgtBasisResetReducer`)
  so a straddling lot keeps its original / residency-step-up AU basis + acquisition level and flows
  through the new-regime indexation path already built in Part 1. **No** `auPre2027CapitalGainsYTD`
  bucket, **no** Method-1/Method-2 split, **no** two-component `_cgtRelief`, **no** election.

Suggested order: **A (CPI) → D (FITO) → C (standalone gold) → B (remove reset)** — A sets the index
everything else reads; B is now a small deletion + test.

Note on the reference scenario: moveYear is **2031 (> 2027)**, so its lots are all
post-2027 (no straddle) ⇒ straddling-lot handling isn't exercised there and the golden should
**NOT move** (CPI defaults to inflation; FITO limit doesn't bind; standalone gold isn't sold).
Cover the straddle path with a **new** unit/fixture where the person is AU-resident *before*
1 Jul 2027.

---

#### Item A — Dedicated ATO CPI series (separate rate + accumulator)

1. **State:** add `state.cpiRates` (`{AU: <rate>}`) and `state.cpiAccumulator` (`{}`, lazily
   1.0). Init in `au-tax-toolset.js` + `intl-retirement-state.js`; default `cpiRates.AU` = the
   AU inflation rate so nothing moves until a distinct CPI is chosen.
2. **Compound:** in `InflationAdjustReducer.reduce` (`src/finance/reducers/inflation-adjust-reducer.js`)
   also do `cpiAccumulator[cc] *= (1 + (state.cpiRates?.[cc] ?? rate))` on each `*_PERIOD_ADVANCE`
   (mirror `inflationAccumulator`). Keep it static for now (no `effectiveCpiRates` MC variant yet).
3. **Read sites** — switch every *indexation* level read from `inflationAccumulator.AU` to
   `cpiAccumulator.AU ?? inflationAccumulator.AU ?? 1` (fallback keeps old saves working). Both
   the *stamp* and the *sale* must read the same accumulator so the ratio is consistent:
   - `us-brokerage-classes.js` (`auLevel`), `au-brokerage-classes.js` (`auLevel`),
   - `au-cgt-reset-classes.js` (the reset-level stamp) — skip if you do Item B first, which
     deletes this file,
   - `change-residency-apply-reducer.js` (`priceLevel`).
4. **Scenario param:** add an `auCpiRate` param (design-55 config-driven style) defaulting to the
   AU inflation rate; expose in `intl-retirement-scenario.js`.
5. **Schema/serialize:** register `cpiAccumulator.*` + `cpiRates.*` in `StateSchemaRegistry`;
   round-trip in `intl-retirement-state.js` toJSON/fromJSON + a serializer test.
6. **Tests:** cpiAccumulator compounds independently of inflationAccumulator; indexation uses
   CPI; default (CPI == inflation) ⇒ figures unchanged.

#### Item D — FITO "without"-pass real-bucket reduction (small, self-contained)

Today `au-tax-rates-base.js` `computeTax` builds the FITO "without US-source" pass by reducing
`auCapitalGainsYTD`, but FY2027 `_cgtRelief` reads `auRealCapitalGainsYTD` (unreduced) ⇒ the CG
slice of the FITO limit is ~0. Immaterial in the reference (limit doesn't bind) but wrong.

1. **State:** add `usSourceRealCapGainsAudYTD` (household scalar) — toolset init, YTD reset in
   `tax-settle-classes.js` (`YTD_FIELDS.AU`), schema (AUD), serializer.
2. **Populate:** in the 3 AU-2027 cross-border reducers (`STOCK_WITHDRAWAL_TAX`,
   `COMPANY_SALE_TAX`, `COLLECTIBLE_SALE_TAX` in `au-tax-module-2027.js`), add the same AUD real
   gain to `usSourceRealCapGainsAudYTD` (all three are US-source). AU-native `AU_STOCK`/`AU_HOUSE`
   are AU-source ⇒ do NOT add.
3. **Use:** in the `_assessResidentPreFito({...state, ...})` "without" override add
   `auRealCapitalGainsYTD: (state.auRealCapitalGainsYTD ?? 0) - (state.usSourceRealCapGainsAudYTD ?? 0)`.
   (`_cgtRelief`'s `'auRealCapitalGainsYTD' in state` check stays true ⇒ reads the reduced value.)
4. **Per-person:** in `computeAuTaxPerPerson` split `usSourceRealCapGainsAudYTD` evenly like
   `usSourceCapGainsAudYTD`.
5. **Test:** a FY2027 resident whose CG is entirely US-source ⇒ the FITO limit's CG slice tracks
   the real (indexed) gain.

#### Item C — Standalone `Collectible` gold indexation (self-contained)

Standalone gold is a `Collectible` (scalar `value` + event `costBasis`), sold via
`us-collectible-classes.js` → `COLLECTIBLE_SALE_TAX` with only `{gain, residency}` (no
`auGain`/`auIndexedGain`/`isGold`). `CollectibleService.recordResidencyChange` snapshots `value`
only. The AU-2027 `COLLECTIBLE_SALE_TAX` reducer already indexes when `isGold` + `auIndexedGain`
are present — so just feed it those.

1. **Collectible fields:** add `isGold` (mark the reference "Gold" collectible true; others
   false), `costBaseByCountry`, `acquisitionPriceLevel` (+ constructor/toJSON/fromJSON).
2. **Step-up:** `CollectibleService.recordResidencyChange` — for a gold collectible, stamp
   `costBaseByCountry.AU = value` and `acquisitionPriceLevel = cpiAccumulator.AU` at the move
   (thread the level through like `AccountService.recordResidencyChange` in Part 1; confirm the
   `ChangeResidencyApplyReducer` loop reaches collectibles — it iterates
   `stateRegistry.getAccounts`, so add a parallel collectibles loop if they aren't included).
3. **2027 reset:** extend the reset to gold collectibles too (use the Item-B non-destructive
   fields for consistency), or reset `costBaseByCountry.AU` + level if not straddle-eligible.
4. **Sale reducer:** `CollectibleSaleApplyReducer` — compute `auGain` (from AU basis) and
   `auIndexedGain` (indexed from the stamped level to `cpiAccumulator.AU` at sale), set
   `isGold`, pass all on `COLLECTIBLE_SALE_TAX`. Non-gold collectibles stay un-indexed.
5. **Tests:** standalone gold sale as AU resident post-2027 ⇒ indexed real gain; non-gold ⇒
   un-indexed.

#### Item B — Straddling lots apply the new regime to the full gain (remove the deemed reset)

**Decision: holdings crossing 1 Jul 2027 default to the FY2027+ rule on their whole AU gain** — no
50% discount, cost-base indexation, 30% floor. No apportionment, no pre-2027 carve-out, no
election. Simpler than Method-1/2 and it removes the current over-relief (the deemed reset
**exempts** pre-2027 gains today). Only lot-based holdings held across the date are in question;
company sales (basis-0) and standalone collectibles already route their full gain to the real
bucket.

1. **Remove the deemed 2027 cost-base reset.** Delete / neutralize `AuCgtBasisResetReducer` +
   `AuCgtBasisResetHandler` (`src/finance/account-rules/au/au-cgt-reset-classes.js`) and unwire the
   `AU_CGT_BASIS_RESET` schedule/handler/reducer/types from the `AU_TAX` toolset. With no reset, a
   straddling lot keeps its **original / residency-step-up** `costBaseByCountry.AU` and its
   `acquisitionPriceLevel`, so its **whole** gain (proceeds − AU basis) is realized and indexed
   from the acquisition/residency level to the sale CPI — the exact new-regime path Part 1 already
   built. Pre-2027 appreciation is therefore taxed under the new rule (no longer exempt).
2. **No new buckets or rate-module changes.** The existing `auRealCapitalGainsYTD` +
   `AuTaxRates2027._cgtRelief` already tax the full indexed gain at the 30% floor. Do NOT add
   `auPre2027CapitalGainsYTD` or a two-component `_cgtRelief`.
3. **Remove the now-dead reset tests** in `evt-au-cgt-reform.test.mjs` (`EVT-CGT-RESET: …`) and any
   `Holding.acquisitionPriceLevel`-reset assertions that depended on the 2027 reset. Keep the
   residency-step-up stamping tests (those still drive indexation).
4. **New test (needs a pre-2027 AU-resident fixture):** an AU resident before 1 Jul 2027 holding a
   lot across the date, sold after 2027 ⇒ the FULL AU gain (incl. pre-2027 appreciation) is
   assessed with no 50% discount, indexed from the acquisition level, with the 30% floor applied —
   and pre-2027 gain is NOT exempt.

> Rationale for the simplification: cost-base indexation already relieves the *inflationary* part
> of the whole holding period, and the 30% floor caps the effective rate, so taxing the full gain
> under the new regime is a defensible, conservative treatment without the per-lot apportionment +
> election machinery. If exact pre/post apportionment is ever wanted, it is re-addable behind a
> straddle flag (the removed Method-1/2 design is preserved in git history + §6.4).

#### Cross-cutting close-out

- **Regold:** re-run `cross-border-relief-scenario.test.mjs` — expect **no change** (move 2031).
  If it moves, something leaked into the post-2027-only path; investigate before re-golding.
- `npm run test:unit` + `test:viz` + `npm run build:index` (new exported classes, if any).
- Update the "✅ COMPLETE" note above + memory [[inflation-wrapper-drops-cgt-reform]] when done.
- **New state fields to register everywhere (toolset init · StateSchemaRegistry · YTD reset in
  `tax-settle-classes.js` · serializer round-trip):** `cpiRates.{cc}`, `cpiAccumulator.{cc}`
  (unitless), `usSourceRealCapGainsAudYTD` (AUD). **New Collectible fields:** `isGold`,
  `costBaseByCountry`, `acquisitionPriceLevel`. (Item B adds **no** new fields — it removes the
  reset; `auPre2027CapitalGainsYTD` and the `Holding.cgtReset*` fields are **not** needed.)

---

### 📋 ORIGINAL SESSION HANDOFF (2026-07-11) — kept for provenance

**All decisions are locked. Gold = INDEXED (confirmed).** Nothing below needs re-litigating.

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
2. **FY2026-27 bracket cut**: the **\$18,201–\$45,000 rate drops 16% → 15%** (legislated
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
**\$18,201–\$45,000 band from 16% → 15%**:

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
the **\$18,201–\$45,000 band 15% → 14%** — *confirm*) and overrides `_cgtRelief`:

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
  deferred to §6.4 (delivered by **Part 4**). Behavior-neutral until Phase 4 stamps
  acquisition levels.
- **Phase 4 ✅ done** — 1 July 2027 deemed cost base reset (Method 1: restamps
  `costBaseByCountry.AU` + `acquisitionPriceLevel`, scheduled only when the sim spans the
  date) + the Age Pension / JobSeeker exemption flag (§6.6). This activates indexation and
  moves the reference scenario's ending net worth (−\$63.7k).
- **Phase 5 (deferred)** — apportionment Method 2 election, new-build election, dedicated
  ATO CPI series.

---

## 11. Resolved questions

All six review questions are resolved — see **Decisions locked** at the top. Summary:

1. Operative year = `2027`; `year=2026` unchanged. ✅
2. FY2026-27 moves the \$18,201–\$45,000 band 16% → 15% (and 15% → 14% at FY2027-28); CGT is
   the only CGT change. `AuTaxRates2026` sets 15% explicitly (2025's 19% flagged, not fixed). ✅
3. Age Pension / JobSeeker exemption — **in scope** (Phase 4). ✅
4. Indexation via Option A (per-lot in sale reducers). ✅
5. Method 1 (deemed reset) only; Method 2 documented as the more-accurate deferred
   alternative. ✅
6. `inflationAccumulator.AU` as CPI proxy; dedicated ATO index deferred (modeling approach
   unsettled). ✅

Remaining **confirm-only** item: the FY2027-28 lowest-band rate of **14%** (§6.3) — assumed
from the same legislated cut package; correct if the intended figure differs.
