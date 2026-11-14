# 132 — The 1 July 2027 deemed sale: assets held across the CGT reform

**Status:** PHASES 1, 2a AND 2b BUILT (14 Nov 2026). Phase 1 covers brokerage lots, phase 2a
standalone collectibles and company equity (§4.5), and phase 2b real property (§7).

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

- **Mixed-residency co-owners** of a dwelling (§7.2): when one owner fails s112-155(1)(d) and
  another passes, the model stamps neither, so the passing owner's share loses its deferral.
  A per-owner deemed sale would need two cost bases on one dwelling.
- **s112-155(1)(d) for lots and scalar assets** is not tested. It only matters for an asset
  that keeps a pre-residency AU acquisition date. The s855-45 step-up moves that date for
  every non-TAP asset, so no plan in the suite reaches it.
- **The US dwelling's AU base ignores depreciation and improvements** made after the s855-45
  step-up. This gap predates design 132, and §7.3 keeps it.
- **A foreign resident at the sale** still gets no s115-115 discount on an AU dwelling (the
  design 62 TODO in the AU tax module). §7.5 builds the resident case only.
- **Collectable rules the model lacks**, which this design does not change: s118-5(a)
  disregards the gain on a car, and s118-10 a collectable costing \$500 or less; s108-10(1)
  quarantines collectable losses.
- **FITO:** the counterfactual removes no US-source deferred slice. A pre-2027 AU resident's
  deferred gain on US-source property stays in the limit's base. For personal property that
  case also needs §865(g)(2) to fail. A US dwelling (phase 2b) is US-source real property
  whatever §865 says, so its deferred gain always reaches this gap. The limit comes out low,
  which over-taxes.
- **The `min(gain, …)` cap on the AU dwelling's assessable gain** compares the post-2027 AU
  gain with the US gain over the whole holding. A dwelling whose value fell before 2027 and
  rose after it has a post-2027 gain larger than the whole one, so the cap cuts it while the
  deferred loss is still booked. That under-taxes, and no plan in the suite reaches it.
- **Scenarios that start after 1 July 2027** with assets acquired before it: the 30 June
  2027 market value is not known, so those assets keep the whole-gain treatment. That
  includes a dwelling's back-cast indexation, which §7.1 shows the Act does not support.
- **CGT event I1** on leaving Australia (s104-160) is not modelled, so a deferred gain is
  never realised by emigration.

## 7. Phase 2b: real property

### 7.1 Open question 4, settled from the Act

Brief item 4 asked whether a dwelling that is **not** deemed sold can still make a discount
gain from an event on or after 1 July 2027. The answer turns on indexation.

| Rule | Section |
|---|---|
| Indexation under s110-36(1A) is **not elective**. The s110-36(2) and s114-5(2) choices cover subsection (1) only | s110-36(1A), (2), Note 3; s114-5(2) |
| (1A) indexes only if the owner was neither a foreign nor a temporary resident at any time from the later of 1 July 2027 and acquisition, to the event | s114-25(2) |
| (1A) has an indexation factor only for expenditure **incurred on or after 1 July 2027** | s960-275(1B) |
| A gain worked out from a cost base calculated with reference to indexation is not a discount gain | s115-20(1)(a) |
| s115-100(c) (the s115-115 percentage) has no date limit, unlike (aa) | s115-100 |
| The 30% minimum tax covers residential and non-residential gains after the discount steps | s119-5(1)(a), (2) |

There are two cases for a dwelling that s112-155(1)(d) excludes (the owner was foreign at
some time after 8 May 2012 during the holding):

- **Case A.** The owner was foreign at some time after the later of 1 July 2027 and
  acquisition. For example, an AU house bought while living abroad, with the move to
  Australia after 2027. s114-25 fails, so there is no indexation, s115-20 is met, and the
  gain is a discount gain at the **s115-115 percentage**.
- **Case B.** The foreign period ended before 1 July 2027 and the owner was resident from
  then to the sale. (1A) applies, so s115-20 fails and the discount is **0%**. (1B) gives no
  factor for the pre-2027 purchase price, so that is **not indexed** either. The user chose
  this literal reading on 14 Nov 2026. The alternative was to treat the cost base as
  unindexed, because nothing in it is indexed, and give the s115-115 percentage.

So the Item B back-cast (`auIndexedCostBase` indexing a dwelling from its pre-2027
acquisition) has no footing for an excluded dwelling. It stays only where nothing is known:
a scenario that starts after 1 July 2027 (§6).

### 7.2 The stamp

`AuCgtDeemedSale2027Reducer` examines each `real-property` entry with a value at 1 July 2027
whose AU acquisition (`acquisitionDateByCountry.AU`, else `acquisitionDate`) is before that
date or unknown. A US dwelling is examined only when it carries the s855-45 AU base. The
reducer writes `auDeemedSale2027` on it:

- `applied`, and a `reason` when it is false;
- `value`, the dwelling's value at the date (the s112-155(3)(a) proceeds);
- `priceLevel`, the July 2027 AU CPI level (indexation of the new base starts here);
- `accumulatedDepreciation` and `capitalizedImprovements` at the date.

The record leaves the cost base unchanged. It is a record, not a rebase, because the sale may
still have to ignore it (below), and because the dwelling's base is built at the sale from
`costBasis`, depreciation and improvements anyway.

`applied` is true when **every** owner was an AU resident at the date and passes
s112-155(1)(d): `residencySinceMs` is unset, or is no later than the later of the acquisition
and 8 May 2012. An unknown acquisition passes only with `residencySinceMs` unset. The reasons
for `applied: false` are `not-au-resident`, `s115-105-applies` and `mixed-owner-residency`
(§6).

**At the sale** the same test runs again for each owner, with residency at the sale. If an
owner left Australia after 2027, or `residencySinceMs` moved past the date, (d) has failed for
the realisation event and the record is treated as `applied: false`.

### 7.3 The sale, when the deemed sale applies

- **The deferred gain** = (`value` − pre-2027 base) × the taxable fraction of the
  **pre-2027 days**. The AU dwelling's pre-2027 base is `costBasis` − the improvements added
  after the date − the depreciation taken by the date. The US dwelling's is its s855-45 AU
  base. The gain is signed, because s118-185 scales a loss as well. It is discount-eligible
  when held 12 months from the original acquisition, which an undated dwelling counts as.
- **The post-2027 gain** is measured from `value`, plus later improvements, minus later
  depreciation (US dwelling: `value` only, see §6), plus the selling costs. It is
  indexed from `priceLevel`. It takes the taxable fraction of the **post-2027 days**.
- **The exemption windows.** Each country's exempt interval is worked out over the whole
  ownership as before. For the AU dwelling this is `mainResidenceWindow`; for the US dwelling
  it is the first six years from the deemed acquisition when rented. The interval is then
  day-counted into the two windows. This keeps the total exempt days unchanged, and it never
  grants a second six-year absence because of the reacquisition. A main residence throughout
  is exempt in both windows.
- `auTaxableFraction` on the action is the post-2027 fraction. The downsizer gate keeps the
  whole-ownership exemption, since s292-102 asks about the dwelling, not the regime.
- The US side (`gain`, the §1222 terms, §121, §1250) does not change.

### 7.4 The sale, when the deemed sale does not apply

This covers a dwelling examined and excluded, or with a record the sale ignores, sold on or
after 1 July 2027. Its pre-2027 cost base is **not indexed** (s960-275(1B)), so
`auIndexedGain` equals the nominal gain. In Case B the discount is 0%, as it is today.

### 7.5 Case A: the s115-115 discount after 2027

`AuTaxModule2027` books Case A on `AU_HOUSE_SALE_TAX` for each owner who is resident at the
sale and has `residencySinceMs` later than both 1 July 2027 and the acquisition. It writes the
owner's share of the gain to `auPersonPost2027DiscountBaseYTD`, and that share ×
`cgtDiscountFraction` to `auPersonPost2027DiscountAllowanceYTD`. These buckets are created on
first use. In `AuTaxRates2027`, losses reach this base last inside the post-2027 gains
(s102-5 Step 1(c)–(d) and Note 3), and the allowance scales with what is left. The allowance
comes off the real gain, and also off the minimum-tax base, because s119-5(1)(a) takes the
gains after the discount steps.

### 7.6 The residential category

Recommendation 5 of the brief is adopted. A dwelling's deferred gain joins the single
deferred bucket rather than a separate deferred residential bucket (s102-6(4), s102-5
Step 1(b)). The two orders differ only when a deferred gain is not discount-eligible, which needs a
dwelling sold within 12 months of a purchase made before 1 July 2027.
