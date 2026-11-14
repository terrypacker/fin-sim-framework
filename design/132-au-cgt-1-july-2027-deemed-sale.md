# 132 — The 1 July 2027 deemed sale: assets held across the CGT reform

**Status:** PHASES 1 AND 2a BUILT (14 Nov 2026). Phase 1 covers brokerage lots and phase 2a
covers standalone collectibles and company equity (§4.5). Phase 2b, real property, is open (§6).

**Related:** design 57 Part 2 Item B (the decision this reverses), design 57 §6.3 (indexation),
design 62 §4 (the 12-month discount test), design 36 §12.2 (the s855-45 residency step-up),
design 90 §5 (capital-loss netting).

## 1. The problem

Design 57 Part 2 Item B (locked 11 Jul 2026) taxed a lot held across 1 July 2027 under the
FY2027+ regime on its **whole** gain: no discount, indexation from acquisition, and the 30%
minimum tax on all of it. It was a stated simplification. The reform's legislation was not on
disk, and §1 of design 57 recorded the opposite reading from secondary sources: "Pre-portion
keeps the 50% discount; post-portion uses indexation + 30% min."

ITAA 1997 compilation 266 (1 Jul 2026, `docs/au-tax/ITAA-1997/`) contains the enacted
transition, and it agrees with design 57 §1, not with Item B.

## 2. What the Act says

| Rule | Section |
|---|---|
| An individual who acquired a non-pre-CGT asset before 1 July 2027, held it through 30 June 2027 and still holds it at a realisation event on or after 1 July 2027 is taken to have **sold it just before 1 July 2027 and reacquired it** for the same amount | s112-155(1), (2) |
| That amount is the asset's **market value just before 1 July 2027**, unless the taxpayer chooses an apportioning method the Minister determines | s112-155(3), s112-185 |
| The gain (or loss) on the deemed sale is **disregarded until the realisation event**, then treated as made in that year | s112-160(2)–(4) |
| The deferred gain counts as made "for the CGT event" of the deemed sale, which happens before 1 July 2027, so it can be a discount capital gain at **50%** | s112-160(3)(a), s115-100(aa) |
| Its 12-month test runs from the **original acquisition to the realisation date** | s112-160(3)(c), s112-160(5), s115-25(1) |
| Indexation runs only from **1 July 2027**; the 12-month indexation test ignores the deemed sale | s110-36(1A) Note 4, s960-275(1B), s114-10(9) |
| A gain from the deemed sale is a **deferred** capital gain | s102-6(3)–(5) |
| The 30% minimum tax covers residential and non-residential capital gains **only**, so it does not reach a deferred gain | s119-5(2) |
| Capital losses reduce **deferred non-residential gains first**, then deferred residential, then the rest | s102-5(1) Step 1(a)–(d) |

## 3. Decision

Follow the Act (user rule: the Act on disk decides). The market-value method is the default,
and the only one built. No Ministerial determination under s112-185 is on disk, so there is no
apportioning method to implement.

## 4. Mechanism (phase 1: brokerage lots)

1. **The stamp.** `AuCgtDeemedSale2027Reducer` runs on the AU period advance that opens FY2027
   (1 July 2027), after `InflationAdjustReducer` has moved `cpiAccumulator.AU`. It stamps every
   non-cash lot that meets three conditions: the lot is in a brokerage account, an AU-resident
   person owns the account, and the lot's AU acquisition (`acquisitionDateByCountry.AU`, else
   `purchaseDate`) is before 1 July 2027. The stamp makes three changes:
   - `costBaseByCountry.AU_PRE2027` ← the AU cost base before the stamp (the deferred gain's base);
   - `costBaseByCountry.AU` ← the lot's market value (the deemed reacquisition cost);
   - `acquisitionPriceLevel` ← the AU CPI level at 1 July 2027 (indexation starts here).

   The acquisition dates are left unchanged, because both 12-month tests run from them.
   The pre-2027 base sits **inside `costBaseByCountry`** on purpose: every path that splits,
   scales, merges or adds to a lot already handles every key of that map (FIFO partials,
   `scaleByCountry`, the merge sum, `_addToCountryBases`). So the deferred gain is carried
   through all of them without new code. A purchase added to a stamped lot raises both bases
   by its cost, leaving the deferred gain unchanged, which is what the Act requires.
   There is one exception. The LADDER compaction policy sums country bases across rungs, so
   an unstamped rung that joins a stamped one contributes its AU base as its pre-2027 base.
   Its deferred gain is therefore zero. Other compaction policies keep `costBaseByCountry`
   in the fungibility key, so a stamped lot and an unstamped vintage never merge.
2. **At a disposal.** The existing code now measures the post-2027 gain, from the deemed
   base and indexed from the July 2027 level. `consumeHoldings` additionally tallies, per lot
   with an `AU_PRE2027` base, `deferred = AU share − AU_PRE2027 share` (signed). The
   discount-eligible part is the positive deferred gain of lots held 12 months or more from
   the original acquisition. It reports this separately for the gold (collectible) slice.
3. **Booking.** Emitters stamp `auDeferredGain` and `auDeferredDiscountableGain` on the
   disposal, and only when a stamped lot was sold. AU-resident classifiers book them into
   `auDeferredCapitalGainsYTD` and `auDeferredDiscountableGainsYTD`, plus per-person maps.
   These buckets are created on first use, so a plan with no lot held across 1 July 2027 is
   byte-identical.
4. **The return (FY2027+).** Losses are netted against the deferred gain first (§2). The
   deferred gain then enters net capital gain with 50% off its discount-eligible part,
   un-indexed. The 30% minimum tax applies to the post-2027 (real) gain only.

### 4.5 Phase 2a: standalone collectibles and company equity

Both are scalar assets: one `value`, one cost base, no lots. The stamp makes the same three
changes as for a lot, measured on `value`: `AU_PRE2027` ← the AU base (the s855-45 step-up when
there is one, else `costBasis`), `AU` ← `value`, `acquisitionPriceLevel` ← the 1 July 2027 level.
The sale reducers (`CollectibleSaleApplyReducer`, `CompanySaleApplyReducer`) then measure the
post-2027 gain from the deemed base without new code, and add `scalarDeferredGainFields`. Its
12-month test runs from `acquisitionDateByCountry.AU`, and an asset with no date counts as long
held, as the term split already treats it. The US module's `COLLECTIBLE_SALE_TAX` and
`COMPANY_SALE_TAX` classifiers book the deferred gain.

s112-155 reaches every non-pre-CGT asset, so a true collectable (not bullion) is stamped too. Its
post-2027 gain is still not indexed (design 57 Part 2 Q3).

## 5. Who is affected

Only AU residents who hold a lot on 30 June 2027 that was acquired (for AU purposes) before
that date. A US→AU mover after 1 July 2027 is not affected: s855-45 deems their assets
acquired at the move, so s112-155(1)(b) is not met.

## 6. Open

- **Phase 2b: real property** still takes the Item B treatment. Brief for the next pass, from
  the Act on disk:
  1. **Split the main-residence exemption at the date.** The deemed sale is a CGT event whose
     ownership period ends on 30 June 2027 (s112-155(2), Note 1), and the reacquired dwelling's
     starts on 1 July 2027. Subdiv 118-B is in Part 3-1, which s112-155(2) covers. So the
     deferred gain is (market value at 30 June 2027 − pre-2027 base) × the taxable fraction of
     the pre-2027 days, and the post-2027 gain uses the post-2027 days. Both property reducers
     need a windowed exemption: `auMainResidenceExemption` for the AU dwelling, and the 6-year
     absence fraction (`auMainResidenceExemptFraction`) for the US one.
  2. **Depreciation.** `AuHouseSaleApplyReducer` reduces the base by the whole
     `accumulatedDepreciation`, but it ignores depreciation once `costBaseByCountry.AU` is set.
     The stamp has to record the depreciation taken by 30 June 2027 (the pre-2027 base is net of
     it), and the post-2027 base must be net of only the later deductions.
  3. **s112-155(1)(d).** It is tested as if a discount gain were made at the realisation event.
     An AU dwelling is taxable Australian property (no s855-45 reset), so an owner who was a
     foreign resident after 8 May 2012 at any time between acquisition and sale makes
     s115-105 apply. That dwelling is not deemed sold. The stamp can test `residencySinceMs`
     against the acquisition. The sale also has to ignore the stamp when residency was broken
     after 2027.
  4. **Open question to settle first.** For that excluded dwelling, s115-100(c) gives the
     s115-115 apportioned percentage, and s115-115 has no date limit. Whether a gain from a
     post-2027 event can still be a discount capital gain turns on s115-5 to s115-25, which
     have not been read yet. Today the model gives it 0%.
  5. **The residential category.** s102-6(4) makes a dwelling's deferred gain a deferred
     residential gain, which losses reach after deferred non-residential gains (s102-5 Step
     1(b)). Lumping both into one deferred bucket changes the tax only when the two categories
     differ in discount eligibility, which needs a sub-12-month deferred gain. Recommended:
     lump them, and state this.
- **Collectable rules the model lacks**, which this design does not change: s118-5(a)
  disregards the gain on a car, and s118-10 a collectable costing \$500 or less; s108-10(1)
  quarantines collectable losses.
- **FITO:** the counterfactual removes no US-source deferred slice. A pre-2027 AU resident's
  deferred gain on US-source property stays in the limit's base. That case also needs
  §865(g)(2) to fail.
- **Scenarios that start after 1 July 2027** with lots acquired before it: the 30 June 2027
  market value is not known, so those lots keep the whole-gain treatment.
- **CGT event I1** on leaving Australia (s104-160) is not modelled, so a deferred gain is
  never realised by emigration.
