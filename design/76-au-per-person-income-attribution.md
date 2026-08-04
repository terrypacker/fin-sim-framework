# 76 — AU per-person income attribution

**Status: COMPLETE — P1–P5 implemented (Gaps A, B, C, D).** §7's four questions are answered and settled.
P1 landed bit-for-bit inert on both scenarios, as its phase contract required. P2 then moved
attribution onto true ownership: **+\$2** on the reference scenario (where all re-attributed AU income
is flat-rate or joint) but **+2.15%** on the design 52 default (where a solely-owned account pays
franked dividends into progressive brackets) — the correct removal of a phantom income split, since
Australia has no joint assessment. **That second figure disproved a claim in §5, which now carries a
correction.** P3 then migrated the remaining ~18 income types plus their FITO removal set: on the reference
scenario **every AU household scalar drains to zero**, so nothing reaches the even-split divisor at
all. P4 apportioned the last FITO input, and P5 added the residue check that keeps it that way.
Suite: 4,017 unit (+69 new) / 910 viz green.

**Two of the four defects this design fixed were found by an invariant test, not by a golden**
(FTC-US-9, both times). Totals are structurally blind here: an unattributed dollar is divided by
headcount and the parts sum back, so lifetime tax barely moves while every person's return is wrong.
That is the single most transferable lesson in this document. See §4 for the per-phase record, and §0 for an
unrelated taxed-by-neither-country defect fixed in passing.

Australia has no joint assessment. Every individual lodges their own return, and every dollar of
assessable income belongs to exactly one taxpayer — or, for a jointly held asset, to each owner in
proportion to their legal interest. The model does not do this. It computes most AU-assessable
income into household scalars and then divides them by the number of residents at settle time.

That divisor is the bug. It is not a modelling simplification with a small error term: it is
applied to income that is not shared, at a magnitude that dominates the income that *is* correctly
attributed, through a progressive rate schedule where the split changes the answer.

**Measured sensitivity.** Re-allocating the shared pool from 50/50 to 100/0 in
`computeAuTaxPerPerson` — changing nothing else — moves lifetime tax on
`scenarios/fin-sim-scenarios.json` from **\$1,831,460 to \$2,024,926**, a swing of **\$193,466
(+10.6%)**. That is the size of the quantity currently being decided by a headcount divisor rather
than by ownership. The true answer is somewhere inside that band and is not knowable without doing
the attribution properly.

Every figure in this document was taken from a live run of `scenarios/fin-sim-scenarios.json`
(gitignored; figures reproduced inline so this document stands alone).

**Relates to:**
- **`design/52` (cross-border relief)** — introduced `computeAuTaxPerPerson` and the
  per-person/shared-pool hybrid this document finishes. Owns the FITO scalars in Gap D.
- **`design/55` (config-driven parameters)** — introduced multi-account-per-role households, which
  is what makes Gap C's hardcoded canonical state keys wrong.
- **`design/73` (cross-border source)** — same diagnostic method (read a real multi-year run rather
  than trust a passing test), and established `accumulateByOwnership` as the attribution seam.
- **`design/68` (year-of-death tax)** — owns the resident-of-the-year set in
  `computeAuTaxPerPerson` that Gap B's fix must not disturb.
- **`design/71` (tax worksheet CSV export)** — the per-person AU return lines it exports are
  currently wrong for reasons A and C even where the total is right.

---

## 0. Fixed in passing — EVT-27 was taxed by neither country  ✅ DONE

Surfaced while auditing which AU reducers chain a tax action, during P1. Not an attribution defect
and not otherwise part of this document, but it lives in the files P1 touched.

`AuDividendFrankedNonResidentApplyReducer` (EVT-27, a franked dividend received while a **non**-resident
of Australia) chained **no tax action at all**. Its three siblings — franked/resident,
unfranked/resident, unfranked/non-resident — all book `usOrdinaryIncomeYTD`. This one booked nothing
anywhere, so a US citizen living in the US and holding ASX shares paid tax on franked dividends in
**neither country**.

The Australian half was always right and is unchanged: ITAA 1936 s128B(3)(ga)(i) excludes the franked
part of a dividend from withholding tax for a foreign resident, s128D keeps it out of assessable
income, and ss207-20 / 207-70 deny the franking offset to non-residents. No AU tax, no franking
credit, and — since no foreign tax is paid — no FTC.

What was missing is that Australia's exemption does not reach the United States. A US citizen is
taxed on worldwide income wherever resident (IRC §61, §1), so the dividend is US ordinary income and
NII for the §1411 surtax, exactly as on the other three branches. Being AU-source it also belongs in
the §904 passive basket numerator; no foreign tax accompanies it, but the numerator sizes the
*limitation*, not the credit, so genuinely foreign-source income raising the passive limit is §904
working as intended. (Contrast design 73's warning, which was about *US*-source income being fed
into a basket numerator — a different and improper thing.)

This was a known, documented gap rather than a new discovery, which is why it was safe to close
quickly:

- `docs/requirements.md:63` already specifies EVT-27 as US **Ordinary Income** / AU **N** / FTC **N**
  — and marked it ✅ even though the US half was never built.
- `tests/unit/evt-au-brokerage.test.mjs` carried an explicit
  `TODO (EVT-27): US tax treatment ... is unresolved (CSV: "Ordinary Income??")`. The "??" was
  uncertainty about the *US* side only; the AU side was never in doubt. **TODO now closed.**

New `AU_DIVIDEND_FRANKED_NONRESIDENT_TAX` action type + reducer fn, chained from the apply reducer
and declared in `au-brokerage-toolset.js`. Two new tests, mutation-verified (both fail without the
chained action; the two pre-existing EVT-27 tests still pass, confirming the AU treatment is
untouched). **Golden unmoved** — the reference scenario has no `au-stock` account, so the entire AU
brokerage family is dormant there; this changes any scenario holding AU shares while non-resident.

**Checked and deliberately NOT changed:** `AuStockEarningsApplyReducer` (EVT-30) also chains no tax
action, and that is correct. It books *unrealized* appreciation; its exact US sibling
`StockEarningsApplyReducer` is identically tax-free, and `docs/requirements.md:66` specifies N/N/N.
Neither country taxes unrealized gain — AU CGT event A1 fires on disposal, the US taxes on
realization — and the gain is captured at sale by `AU_STOCK_WITHDRAWAL_TAX` from the FIFO basis.
Chaining a tax action there would double-count: once as it accrues, again as capital gain at sale.

---

## 1. The tax principle

The user's stated rule is correct and is the whole specification:

> the only shared income / taxable gains would come from shared assets (joint account, property
> that is owned jointly...)

Stated precisely, for Australian individual income tax:

| Income type | Attributed to |
|---|---|
| Employment / personal services income | the person who performed the work — always, never apportionable |
| Self-employment / business income | the person carrying on the business |
| Social Security / age pension / annuity | the recipient |
| Superannuation earnings and contributions tax | the **member**. Super is a member account; it is never shared, and a spouse has no interest in it |
| Interest, dividends, rent | the owner(s) of the account or asset, by ownership share |
| Capital gains | the owner(s) of the CGT asset, by ownership share |

"Shared" is not a category of income. It is the special case of an asset with more than one owner,
where the income follows the ownership fractions — joint tenants take equal shares, tenants in
common take their respective interests. A 50/50 split is the *correct answer* for a jointly held
asset owned equally by two people, and the *wrong answer* for everything else. Today the model
applies it to everything.

Two consequences worth stating because they explain the fix's shape:

1. **There is no household aggregation step to preserve.** Unlike the US return (MFJ, correctly
   modelled as a household), the AU return has no joint concept to fall back on. The per-person
   map is not an optimisation over the scalar — it is the only correct representation, and the
   scalar is the thing that should not exist.
2. **The US side is unaffected.** US federal tax is filed MFJ and its household accumulators are
   right. This document touches only the AU accumulators and the FITO handoff in Gap D.

*Out of scope, noted:* a handful of AU provisions genuinely do test income at family level — the
Medicare levy surcharge thresholds, the seniors and pensioners tax offset, private health rebate
tiers. Those are family *thresholds* applied to individually-assessed income, not joint assessment,
and none are modelled today. Attributing income per person is a prerequisite for ever modelling
them, not a conflict with them.

---

## 2. Why this was not caught

`computeAuTaxPerPerson` (`src/finance/tax-settle-service.js:136`) was written for design 52 with an
explicit incremental-migration contract, documented in its own header:

```
personValue = auPersonXYTD[key] + auXYTD / numResidents
```

> This lets each income type migrate incrementally: once an event writes directly to the per-person
> map its shared-pool contribution drops to 0, while un-migrated types continue to split evenly
> from the shared pool.

The design is sound. The migration simply never finished, and — because the fallback is silent and
always produces a plausible-looking number — nothing ever failed to signal that. Worse, the two
mechanisms that *were* built to do the attribution are both inert (Gaps A and C), so even the types
recorded as migrated are still splitting evenly. Totals stay correct throughout, which is why
totals-based tests and the golden net-worth lock never moved.

---

## 3. The four gaps

### Gap A — `ownershipType` never reaches runtime state, so *all* ownership attribution is inert

`ownershipFractions()` (`src/finance/ownership-utils.js:37`) resolves in three steps: an `owners[]`
array, else `ownershipType === 'sole'` with a matching `ownerId`, else **split evenly across all
people**.

Both account→state projections drop `ownershipType`. `_accountToStatePlain` in
`src/scenarios/toolsets/au-retirement-toolset.js:690` and
`src/scenarios/toolsets/us-retirement-toolset.js:90` each carry `ownerId` but neither carries
`ownershipType` or `owners`:

```text
    role:                  account.role                  ?? null,
    ownerId:               account.ownerId               ?? null,     // ← carried
    minimumBalance:        account.minimumBalance        ?? 0,        // ← ownershipType absent
```

The scenario declares ownership correctly (`ownershipType: 'sole', ownerId: 'spouse'` on Jeanne's
super), and `Asset` sets the field, but it is filtered out on the way into state. So the `sole`
branch can never fire, and every `accumulateByOwnership` call in the AU module falls through to the
even split. Probed directly:

```
superAccount        { ownershipType: undefined, ownerId: 'primary', owners: undefined }
   fractions: [ { primary, 0.5 }, { spouse, 0.5 } ]
spouseSuperAccount  { ownershipType: undefined, ownerId: 'spouse',  owners: undefined }
   fractions: [ { primary, 0.5 }, { spouse, 0.5 } ]
```

This is the user's reported symptom exactly. Super balances of \$51,360 (Terry) and \$343,470
(Jeanne) — a 7× difference — produce identical super tax:

```
FY2027  super: T=51,360  J=343,470
  auPersonSuperTaxYTD: primary=1,937  spouse=1,937
```

Carrying the two fields through both projections is a four-line change, and it works — the same
year becomes `primary=504  spouse=3,371`, a 13/87 split matching the balances.

**Fix:** add `ownershipType` and `owners` to both `_accountToStatePlain` functions. **Do not land
this alone — see §4.**

### Gap B — most AU-assessable income never reaches the per-person maps at all

Twenty action types in `src/finance/tax/us/us-tax-module-2026.js` write AU household scalars on
their `isAuResident` branch. Only two have any per-person path:

| Action type | Household field(s) written | Per-person path |
|---|---|---|
| `IRA_WITHDRAWAL_EARNINGS_TAX` | `auOrdinaryIncomeYTD` | — |
| `IRA_RMD_TAX` | `auOrdinaryIncomeYTD` | — |
| `IRA_ROLLOVER_WITHDRAWAL_TAX` | `auOrdinaryIncomeYTD` | — |
| `K401_RMD_TAX` | `auOrdinaryIncomeYTD` | — |
| `ROTH_WITHDRAWAL_EARNINGS_TAX` | `auOrdinaryIncomeYTD` | — |
| `ROTH_ROLLOVER_WITHDRAWAL_CONTRIB_TAX` | `auOrdinaryIncomeYTD` | — |
| `ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_TAX` | `auOrdinaryIncomeYTD` | — |
| `INHERITED_RA_DISTRIBUTION_TAX` | `auOrdinaryIncomeYTD` | — |
| `STOCK_DIVIDEND_TAX` | `auOrdinaryIncomeYTD` | — |
| `BOND_COUPON_TAX` | `auOrdinaryIncomeYTD` | — |
| `FIXED_INCOME_EARNINGS_TAX` | `auOrdinaryIncomeYTD` | — |
| `US_RENTAL_INCOME_TAX` | `auOrdinaryIncomeYTD` | — |
| `SS_INCOME_TAX` | `auOrdinaryIncomeYTD` | — |
| `BONUS_TAX` | `auOrdinaryIncomeYTD` | — |
| `STOCK_WITHDRAWAL_TAX` | `auCapitalGainsYTD`, `auDiscountableGainsYTD` | — |
| `US_HOUSE_SALE_TAX` | `auCapitalGainsYTD`, `auDiscountableGainsYTD` | — |
| `COMPANY_SALE_TAX` | `auCapitalGainsYTD`, `auDiscountableGainsYTD` | — |
| `COLLECTIBLE_SALE_TAX` | `auCapitalGainsYTD`, `auDiscountableGainsYTD` | — |
| `WAGES_INCOME_TAX` | `auOrdinaryIncomeYTD` | `auPersonOrdinaryIncomeYTD` ✅ |
| `SE_INCOME_US_TAX` | `auOrdinaryIncomeYTD` | `auPersonOrdinaryIncomeYTD` ✅ |

These are US-source items assessable in Australia on a resident's worldwide return, and they are
the bulk of the household's retirement income. Once the reference scenario moves to AU residency in
FY2032 they swamp everything that *is* attributed:

```
FY2032  auPersonOrdinaryIncomeYTD: primary=2,982  spouse=2,982
        SHARED: auOrdinaryIncomeYTD=33,019   auCapitalGainsYTD=9,523
FY2036  auPersonOrdinaryIncomeYTD: primary=4,711  spouse=4,711
        SHARED: auOrdinaryIncomeYTD=31,468   auCapitalGainsYTD=99,099
FY2055  auPersonOrdinaryIncomeYTD: primary=17,817 spouse=17,817
        SHARED: auOrdinaryIncomeYTD=141,351  auCapitalGainsYTD=430,095
FY2060  auPersonOrdinaryIncomeYTD: primary=23,189 spouse=23,189
        SHARED: auOrdinaryIncomeYTD=141,771  auCapitalGainsYTD=557,463
```

Two of these are worth calling out because their misattribution is flagrant rather than merely
imprecise:

- **`SS_INCOME_TAX`** — Social Security is definitionally per-recipient, and the two people have
  different entitlements (\$2,000/mo and \$1,000/mo). It is split 50/50.
- **The retirement-account family** (IRA, 401k, Roth, inherited IRA) — these are individual
  accounts by statute. A distribution from Terry's 401k is Terry's income. There is no reading
  under which half of it is Jeanne's.

**The threading problem.** None of these actions carry the information needed to attribute them.
Spot-checked emit sites:

```js
[{ type: 'STOCK_DIVIDEND_TAX', amount, residency }]                            // us-brokerage-classes.js:157
[{ type: 'IRA_WITHDRAWAL_EARNINGS_TAX', amount, penaltyAmount, residency }]    // ira-classes.js:138
[{ type: 'SS_INCOME_TAX', amount, residency }]                                 // us-income-classes.js:53
```

No `stateKey`, no `ownerId`, no `personKey`. Several have multiple emit sites (`BOND_COUPON_TAX`
has four; `IRA_WITHDRAWAL_EARNINGS_TAX` has three, two of them inside `account-service.js`). And
per the `pickPayload` rule, an action field that is not **declared** in its toolset schema is
dropped in transit — so each new field is a change at the emit site *and* in the toolset's action
declaration. This is the bulk of the work and the main reason this is a design doc rather than a
one-off.

### Gap C — the AU module attributes via hardcoded canonical state keys

Where the AU module *does* attribute by ownership, it mostly resolves the account from a hardcoded
canonical key rather than from the action:

```js
// au-tax-module-2026.js:243 — AU_SAVINGS_EARNINGS_TAX
accumulateByOwnership(state.auPersonOrdinaryIncomeYTD ?? {}, state.auSavingsAccount, amount, state.people)
```

`AU_SAVINGS_EARNINGS_TAX` is emitted from five call sites (`au-savings-classes.js`,
`cash-sleeve-interest-apply-reducer.js`, `bond-sleeve-coupon-apply-reducer.js`,
`bond-accretion-apply-reducer.js`) carrying only `{ amount, residency }`. The household has two AU
savings accounts — Terry's `auSavingsAccount` (\$50,000) and Jeanne's `spouseAuSavingsAccount`
(\$119,000) — and *all* interest from both is attributed through Terry's account object. The same
pattern applies to `state.auStockAccount`, `state.auFixedIncomeAccount`, and
`SUPER_CONTRIBUTION_TAX`'s `state.superAccount`.

`SUPER_EARNINGS_TAX` is the one that does it right — it reads `action.stateKey ?? 'superAccount'`
and resolves the real account — and is the pattern the rest should follow.

**This gap is why Gap A must not be fixed alone.** While `ownershipFractions` falls through to the
even split, the hardcoded key is harmless — every account resolves to 50/50 anyway. Fix A on its
own and the hardcoded key starts being believed. Measured, fixing A alone:

```
                                     before          after A alone
auPersonNrWithholdingInterestYTD     1,684 / 1,684   3,367 / 0
```

100% of Jeanne's AU interest attributed to Terry — a *worse* error than the even split it replaced.

### Gap D — the FITO scalars are split evenly and must track the same attribution

`computeAuTaxPerPerson` also divides four cross-border scalars by `numResidents`
(`tax-settle-service.js:193-196`): `usSourceOrdinaryAudYTD`, `usSourceCapGainsAudYTD`,
`usSourceRealCapGainsAudYTD`, and `usTaxPaidOnUsSourceAud`.

The first three are written at exactly the same call sites as Gap B's household scalars — the same
`isAuResident` branches — and so migrate with them for free. They must, or the FITO removal set
will not match the income it is meant to offset, and each person's with/without limit will be
computed against the wrong base.

`usTaxPaidOnUsSourceAud` is different and needs a decision. It is a single joint number — US tax is
assessed MFJ and stamped once per US settle (`tax-settle-classes.js:105`) — so there is no
per-person value to migrate to. It has to be **apportioned**. The natural rule, and the one this
document proposes, is to apportion it in proportion to each person's share of the US-source income
Australia is also taxing, which is exactly what the migrated first three scalars now give us. That
keeps the offset proportionate to the income it relieves and degrades to today's even split when
the two shares are equal.

---

## 4. Sequencing

The gaps are not independent, and the order matters more than usual because two of them are
individually harmful.

| Phase | Work | Golden impact |
|---|---|---|
| **P1** ✅ **DONE** | Gap C — resolve the account from `action.stateKey` in the AU module; thread `stateKey` onto `AU_SAVINGS_EARNINGS_TAX` (5 sites), `AU_FIXED_INCOME_EARNINGS_TAX`, the AU brokerage actions and `SUPER_CONTRIBUTION_TAX`, with the toolset field declarations. Follow `SUPER_EARNINGS_TAX`. | **Inert — confirmed.** Golden byte-identical; per-person accumulators unchanged. This is the point: it lands the plumbing under a fallback that masks it. |
| **P2** ✅ **DONE** | Gap A — carry `ownershipType` through both `_accountToStatePlain` functions (accounts have no `owners[]`; that field is RealProperty-only), and carry `owners[]` through the four *asset* projections, which dropped it. | Per-person values move to true ownership. Totals move **+\$2** on the reference scenario but **+2.15%** on the design 52 default — this row originally predicted "~\$17, barely moves", which was wrong and is corrected in §5. Safe only because P1 landed first. |
| **P3** ✅ **DONE** | Gap B — migrate the 20 action types. Largest phase; split by family (retirement accounts / brokerage+bond / income / capital gains) so each lands testable. Carries Gap D's first three scalars along with it. | **This is where the money is.** Expect movement inside the ±\$193k band. |
| **P4** ✅ **DONE** | Gap D *(remainder)* — apportion `usTaxPaidOnUsSourceAud` by each person's US-source share. The other three FITO scalars shipped with P3, which proved they could not be deferred. | Second-order; changes FITO relief, not assessable income. |
| **P5** ✅ **DONE** | Delete the `/ numResidents` fallback in `computeAuTaxPerPerson`, or convert it to a dev-mode assertion that fires if any AU household scalar is non-zero at settle. | None if P3 is complete — and that is the test. |

### P1 implementation record

New seam: `resolveAttributionAsset(state, action, canonicalKey)` in `ownership-utils.js` — stamped
key wins, falling back to the canonical key both when nothing is stamped (legacy dispatchers,
pre-`stateKey` saves) and when a stamped key no longer resolves. That second fallback is deliberate:
it is the same absent-but-non-null trap that `resolveDestinationCashKey` was added to close on the
sale path, where a deleted account produced a `reading 'balance' of undefined` crash.

All eight hardcoded canonical-key reads in `au-tax-module-2026.js` now route through it, plus the
`state.auStockAccount` read in `au-tax-module-2027.js:59` — that one matters because the 2027 real
(post-indexation) CGT bucket must slice *identically* to the parent's gross bucket, as its own
`_recordRealGain` doc comment requires. Emitters stamp the key they credited: the five
`AU_SAVINGS_EARNINGS_TAX` sites, `AU_FIXED_INCOME_EARNINGS_TAX`, `SUPER_CONTRIBUTION_TAX`, the three
AU dividend reducers, `AU_STOCK_WITHDRAWAL_TAX`, and the rebalance reducer's `_sellTax` AU leg.
`SuperContributionApplyReducer` and the AU brokerage reducers also gained the
`action.stateKey ?? canonical` resolution their siblings already had — inert today (no handler
stamps those APPLY actions) and correct when P3 does.

Tests: `tests/unit/design-76-attribution-statekey.test.mjs`, 16 cases. They use explicit `owners[]`
arrays rather than `ownershipType: 'sole'` — `owners[]` is the first branch of `ownershipFractions`
and works today, so P1's plumbing is provable while Gap A is still open, and the file becomes the
regression guard for P2. Fixtures are deliberately lopsided (100/0): equal shares cannot distinguish
correct attribution from the even-split fallback, which is precisely how this survived. **Mutation-
verified** — 9 of 16 fail against the pre-P1 module; the 7 that pass are the new helper's own unit
tests, `SUPER_EARNINGS_TAX` (already the correct reference pattern), and the back-compat fallback.

Two things deliberately left alone, both design-55 per-account concerns rather than attribution:
`AuDividendFrankedNonResidentApplyReducer` and `AuStockEarningsApplyReducer` still read
`state.auStockAccount` directly — they chain no tax action, and rewiring them would move cash flows
and break P1's inertness.

Noted in passing, not fixed: `auDiscountableGain` is emitted on `AU_STOCK_WITHDRAWAL_TAX` and read
by the tax module but never declared in `au-brokerage-toolset.js`. `_pickPayload` filters only the
*journal* record (`simulation.js:849`), not reducer dispatch, so the CGT discount is computed
correctly — the field is merely invisible to the journal and the design 71 exports. A reporting gap
worth closing when someone is next in that file.

### P2 implementation record

`ownershipType` added to both `_accountToStatePlain` functions. Accounts carry no `owners[]` — that
field lives on `RealProperty`, not `Asset` — so projecting it there would have been dead weight.

While auditing the projections, the same defect turned up one level out: **real property,
collectibles and company equity all carried `ownershipType` + `ownerId` but dropped `owners[]`** — the
first and most precise branch of `ownershipFractions`, which outranks sole/joint. The field is
serialized and round-tripped, and `rental-income-classes.js:264` reads it off `propState` to attribute
rent, so design 73's rental attribution could never see anything finer than the coarse sole/joint
split. Added to all four projections. Inert on both reference scenarios (every asset there has
`owners: []`), but it is the same bug and P3's collectible/company-equity attribution needs it.

Measured impact, by scenario — the two differ, and the difference is the point:

| | reference scenario | design 52 default |
|---|---|---|
| lifetime tax | 4,563,500 → 4,563,517 deficit; tax **+\$2** | 700,352 → 715,426 (**+2.15%**) |
| why | all re-attributed income is flat-rate or joint | `auStockAccount` is solely owned and pays franked dividends into progressive brackets |

The design 52 lock was re-pinned (698,420 → 715,426; net worth 12,273,473 → 12,268,463) with the full
derivation in the test comment. **This contradicted §5's original claim and that section now carries a
correction** — see the callout there.

One hypothesis checked and disproved rather than assumed: `frankingOffset = Math.min(credit, baseTax)`
treats franking credits as non-refundable, so concentrating them on one owner *could* have wasted them
and manufactured the rise artificially. Measured, the cap binds **less** after P2 (7,148 → 4,137),
because credits now land on the high-income owner who can absorb them instead of half-wasting against
the low-income spouse; with a refundable offset P2's delta would be *larger* (+18,085 vs +15,074). The
rise is the income-splitting removal, not an artifact. Separately: resident franking credits have been
refundable since the 2000 Ralph reforms (ITAA 1997 Div 67), so that cap is a genuine fidelity gap worth
~4,137 lifetime here — noted, out of scope for an attribution change.

Tests: `tests/unit/design-76-ownership-projection.test.mjs`, 7 cases, all resolving ownership **out of
`sim.state`** rather than off the `Asset` instance — the `Asset` always had `ownershipType`, and
asserting against it is precisely the blind spot that let this live. Includes the §6 sole-ownership
regression guard, a joint-account control, an unresolvable-owner fallback, and an end-to-end
unequal-super-balance assertion (the originally reported symptom). **Mutation-verified** — 5 of 7 fail
against the pre-P2 projections; the 2 that pass are the joint split and the unresolved-owner fallback,
both correct before and after.

### P3 implementation record

All 18 remaining action types migrated, plus two writers found outside the tax modules
(`us-savings-interest-credit-reducer.js`, `cash-sleeve-interest-apply-reducer.js`) that were booking
US savings / cash-sleeve interest straight onto the household scalar. Shared seam:
`resolveAttributionFractions(state, action, canonicalKey)` in `ownership-utils.js`, resolving
`personKey` → `stateKey` → inline ownership per §7's decision, and `bookAuResident()` in the US module,
which pairs each AU field with its per-person twin.

**Result on the reference scenario: every AU household scalar drains to zero.** FY2032 ordinary income
went from `primary=2,982 spouse=2,982` (an even split of \$33k) to `primary=33,403 spouse=5,581`, and
capital gains from a \$9,523 shared scalar to 100% on the owner of the brokerage account. Nothing
reaches `computeAuTaxPerPerson`'s divisor any more, so P5's assertion would pass today.

| | reference scenario | design 52 default |
|---|---|---|
| lifetime tax | 1,831,460 → 1,846,043 (**+0.80%**) | 715,426 → 722,339 (**+0.97%**) |
| also | out-of-funds 2060-06-30 → 2060-01-31; deficit +345k | net worth 12,268,463 → 12,256,784 |

Both move UP, which is the income-splitting removal doing what P2 started — now on the whole income
base rather than just franking credits.

**Gap D could not be deferred, and the measurement is the argument.** §3 claimed the US-source removal
set "migrates for free" with the income. It does not migrate for free; it migrates *compulsorily*. The
FITO limit is sized by re-running the assessment with each person's US-source slice subtracted from
their own income, so attributing the income while leaving the removal set on an even split gives every
person a limit computed off a base they do not have. Measured on the design 52 scenario: income-only
migration lands at **949,884 (+32.8%)** versus **699,756** with the removal set aligned — a \$250k
swing, and in the wrong direction. The two halves of P3 are one change.

**P3 tripped an invariant test, and that is the part worth remembering.** FTC-US-9 asserts that AU tax
on US-source income never enters the US creditable base. `_auTaxOnUsSourceIncome`'s de-minimis fallback
apportions the AU liability by US-source *share*, reading `usSourceOrdinaryAudYTD` and
`auOrdinaryIncomeYTD` — household scalars that P3 had just drained to zero. With a 0 share it declared
the entire AU liability to be AU-source tax, leaking ~88k back into the creditable base. Fixed by
summing the per-person maps alongside the scalars, the same `_sumMap` treatment `superTax` already had
one line above. **The golden did not catch this** — it was inside the ±1% band at the time. The
invariant test did. Any future phase that drains a scalar should grep for every reader of that scalar
before assuming the drain is safe.

Tests: `tests/unit/design-76-gap-b-migration.test.mjs`, 28 cases — per-account attribution for 8
ordinary-income types, person-derived (SS/wages), capital gains with their discountable slice, four
Gap D pairing assertions, a non-resident control for each type, and an explicit check that an
unattributable action still books to the *visible* household scalar rather than a silent even split.
Every case also asserts the household scalars stay at 0. **Mutation-verified** — 18 of 28 fail against
the pre-P3 module; the 10 that pass are the non-resident controls and the fallback case, correct
either way.

Existing tests updated rather than weakened: the EVT suites now assert the owner's slice via new
`auOrdinaryFor` / `auGainsFor` helpers (strictly stronger than the old household assertion), and
`assertNoAuIncome` checks the per-person maps too — a scalar-only "is zero" check would now pass even
if income leaked into a map.

**Known limitation:** `BONUS_TAX` still books to the household scalar. A bonus is W-2 wages and belongs
wholly to the earner, but the BONUS event carries no person. The `personKey` path is plumbed so it works
the moment the event grows one; it is deliberately not defaulted to the primary earner, which would be
a guess dressed as a fact.

### P4 implementation record

`usTaxPaidOnUsSourceAud` is now apportioned by each person's share of the US-source income Australia
is taxing, using the maps P3 created. Impact: **−0.33%** (design 52) and **−0.26%** (reference), and
DOWN is the right direction — FITO has no carryforward, so an offset handed to a spouse whose own
limit cannot absorb it is simply lost. Matching the offset to the income share wastes less of it.
Zero household US-source income falls back to the even split rather than dividing by zero.

**P4 exposed a second latent defect, again caught by FTC-US-9 and again invisible to the golden.**
The A\$1,000 FITO de-minimis test is *per person*, but the fallback in `_auTaxOnUsSourceIncome` that
handles it was all-or-nothing across the household: the apportionment branch fired only when EVERY
person's `fitoLimit` was null. A mixed household — one spouse over the threshold with a computed
limit, one under with a null one — contributed **zero** for the under-threshold spouse, declaring
their entire AU liability to be AU-source and therefore creditable against US tax. Roughly 24k of
leak in the reference run.

It had been latent for as long as the even split kept both spouses on the same side of the A\$1,000
threshold. P4's income-share apportionment is exactly what pushes them apart, so the fix ships with
it: the fallback is now applied per detail, using each person's own US-source share (surfaced as
`inputs.usSourceOrdinary` / `usSourceCapGains`). Peak current-year passive foreign tax fell from
13,515 to **154** — two orders of magnitude below FTC-US-9's bound and consistent with that test's
own statement that this household's genuine AU-source tax is very small.

Tests: `tests/unit/design-76-fito-apportionment.test.mjs`, 5 cases — 90/10 apportionment with a
conservation check, degradation to the even split at equal shares, the zero-US-source divide-by-zero
guard, per-person US-source exposure, and the mixed de-minimis shape.

### P5 implementation record

Two parts, one durable and one advisory.

**The enforcing check** is `tests/unit/design-76-no-household-residue.test.mjs`: run the full
multi-decade scenario and assert that no migrated household scalar carries a balance *into* any AU
settle. It does not enumerate income types — it watches the negative space — so it is the test that
fails when someone adds a twenty-first income type and forgets to attribute it.

It has to read the journal's `stateDiff.before`, not final state, because the settle's apply reducer
zeroes these buckets: end-of-run state is 0 whether or not attribution works. **The first version of
this test did read final state and was therefore vacuous — it passed against the pre-migration
module.** Mutation-checking against `34dc682` is what caught that; the corrected version reports 39
residues there, including \$189k of capital gains and \$283k of US-source ordinary income in single
years. A second, weaker case guards against a wholesale revert to the even split.

**The advisory part** is a one-warning-per-field `console.warn` in `computeAuTaxPerPerson` naming any
scalar that reached settle unattributed, gated to dev/test (`AU_ATTRIBUTION_WARN=off` to silence).
Deliberately a warning, not a throw: the scalar is still correct in total, and taking down a user's
run over an accuracy regression is the wrong trade.

**§7 Q3 (deleting the scalars) — now done.** The blocker was `BONUS_TAX`, the last income type with
no owner. `BonusHandler.resolveBonusEarner` now resolves one: an explicit `data.personId`, else the
only person still drawing wages on that date, else the highest earner (deterministic, and warned
about). A bonus is W-2 wages and Australia assesses it wholly to the earner, so there was never a
defensible household reading — only missing data. The residency stamped on the action is now the
*earner's* too, which decides whether Australia assesses it at all.

With that closed, an unattributed household scalar is a **hard error in dev/test**
(`AU_ATTRIBUTION_STRICT`, on by default outside production builds) naming the offending field.
Production still computes: the scalar is correct in TOTAL, so a headline figure stays usable, and
taking down someone's simulation over a split-accuracy regression is the wrong trade. That is the
"hard failure instead of a silent even split" Q3 asked for, placed where the failure is actionable —
at the point a new income type is introduced.

Two tests deliberately exercise the legacy shared-pool split (design 68's YOD-3 and design 52's
equal-split case). Both opt out of the escalation explicitly rather than being rewritten, because the
fallback they cover is still the production path.

**A hole this close-out found, that the suite could not.** Running the user's live scenario through
the new warning surfaced `auRealCapitalGainsYTD` = 10,998.61 reaching settle unattributed: the FY2027
CGT-reform *real* buckets in `au-tax-module-2027.js` still wrote household scalars on the four
US-source paths, carrying an explicit "no per-person split" note that the Gap B migration never
revisited. They are the Gap D pairing all over again — the FY2027 FITO pass subtracts
`usSourceRealCapGainsAudYTD` from `auRealCapitalGainsYTD` — so both now attribute through
`resolveAttributionFractions`.

The residue test had missed it because its own field list omitted the two real buckets. Both are now
listed. Worth stating plainly: **the test could not see the bug because I wrote the list, and the
runtime warning could, because it enumerates the same constant the code uses.** A checked-in scenario
exercising FY2027+ realisations would have caught it too.

**On §7 Q4 (saved states):** the household scalars are still read and still summed everywhere that
matters, so existing saves load and settle correctly — their residue simply flows through the
even-split fallback as before, and now warns. No migration or version gate is needed while the
scalars remain. One live scenario in the Chrome debug session will want re-saving to pick up the
per-person maps; nothing breaks if it is not. As long as the silent even-split fallback exists, the next
income type added will quietly acquire the same bug. Turning it into a loud failure is what
converts "migrated" from an assertion into something the suite can check.

---

## 5. What to expect from the golden — and why the totals lie

**A flat tax is split-invariant.** Super tax is a flat 15% added *outside* the bracket computation
(`au-tax-rates-base.js:237`: `grossTax = ... + auSuperTaxYTD + minTaxTopUp`), and non-resident
withholding is flat at the treaty caps (10% interest, 15% unfranked dividends). Splitting a flat-rate
amount differently between two people cannot change its total. This is why fixing Gap A — which
visibly corrects super tax from 1,937/1,937 to 504/3,371 — moves lifetime taxes by **\$17**.

So the headline totals will *not* validate P1 and P2. Only the progressive machinery is
split-sensitive: the resident marginal brackets, the tax-free threshold, the Medicare levy, the CGT
discount, and design 57's 30% CGT minimum tax. That is why P1/P2 need per-person assertions rather
than golden locks to be tested at all.

> ### ⚠️ Correction (written during P2 — the original claim here was wrong)
>
> This section first concluded: *"a P1 or P2 change that moves the lifetime total significantly is a
> regression, not a success. Only P3 should move it."* **That is false, and P2 disproved it.**
>
> The error was generalising from one scenario. On the *reference* scenario
> (`fin-sim-scenarios.json`) every AU-taxed dollar that P2 re-attributes is either flat-rate (super
> at 15%, NR withholding at the treaty caps) or genuinely joint (rent from a jointly-owned house), so
> P2 moved it by **+\$2** — and the flat-tax-invariance reasoning above held perfectly.
>
> But the split-sensitive machinery does **not** only act on Gap B's fields. `auPersonFrankingCreditYTD`
> and the per-person ordinary/gains maps already feed the progressive brackets today. On the design 52
> default scenario — where `auStockAccount` is *solely* owned and pays franked dividends into
> progressive brackets — P2 moved lifetime tax **+2.15%** (700,352 → 715,426), because franking
> credits stopped being halved onto a spouse who never owned the shares (4,517/4,517 → 9,035/0).
>
> That rise is correct: Australia has no joint assessment and no income splitting. The original claim
> would have led a reviewer to read a genuine correction as a regression.
>
> **The rule that actually holds:** a phase moves the total exactly insofar as it re-attributes
> *progressively-taxed* income in a scenario where ownership is *unequal*. Judge each phase against
> that, not against a blanket "P1/P2 must be inert." P1 remains inert by construction — it changes
> which account is read, not how income is split — and was measured bit-for-bit inert on both
> scenarios.

Note also that on the reference scenario the extra tax from the 100/0 probe was absorbed by the
existing deficit — net worth stayed at 4,810,931 in both runs because the scenario already goes
out-of-funds in 2060. Sensitivity analysis on this change must read `cumulativeTaxesPaid` and
`cumulativeDeficit`, not `netWorth`.

---

## 6. Testing

- **Per-person assertions, not totals.** A test that asserts only the household total will pass
  under every wrong split. Each migrated income type needs a test asserting the *shape* of
  `auPersonXYTD` for a two-person household with deliberately unequal accounts.
- **Unequal-by-construction fixtures.** Two people with equal balances cannot distinguish a correct
  attribution from the even-split fallback. Fixtures must be lopsided — the real scenario's
  \$51k/\$343k super is a good template.
- **A sole-ownership regression guard for Gap A.** Assert `ownershipFractions()` returns
  `[{ personKey: 'spouse', fraction: 1.0 }]` for a sole-owned account read *out of runtime state*,
  not off the `Asset` instance. Testing the `Asset` is what let this bug live.
- **A no-household-residue check.** After a full run, assert every AU household scalar is 0 at each
  AU settle. This is P5's assertion and the only durable proof the migration is complete.
- **Crossfoot.** `npm run crossfoot` and the design 71 multi-year drill export are the instruments
  that make per-person mis-attribution visible; per memory, report bugs of this shape are invisible
  one-year-at-a-time.

---

## 7. Open questions

1. **Threading style for Gap B.** `stateKey` (resolve the account at the reducer, matching
   `SUPER_EARNINGS_TAX` and Gap C's fix) or `ownerId`/`owners` stamped directly on the action
   (matching `AU_RENTAL_INCOME_TAX` and `AU_HOUSE_SALE_TAX`)? `stateKey` is narrower to thread and
   keeps ownership resolution in one place; the stamped form survives an account being deleted or
   re-keyed mid-run. Recommend `stateKey` for account-derived income and `personKey` for
   person-derived income (Social Security, wages), which is what each source naturally has to hand. Answer: recommended approach is good
2. **Income with no account.** `SS_INCOME_TAX` needs `personKey`, not `stateKey`. `BONUS_TAX` and
   `COMPANY_SALE_TAX` need to resolve to the equity holder. `COLLECTIBLE_SALE_TAX` has ownership on
   the collectible. Each needs its own answer; none should fall back to the even split. Answer: suggested answers fine, if you need more lets discuss
3. **Should `auOrdinaryIncomeYTD` and friends be deleted outright** once P3 lands, rather than kept
   as a fallback? Deleting them makes an un-migrated income type a hard failure instead of a silent
   even split. Recommend yes, after P5 has run clean for a release. Answer: yes
4. **Saved-state compatibility.** Existing saved states carry non-zero household scalars. P5's
   assertion needs either a migration that redistributes them by ownership at load, or an explicit
   version gate.  Answer: Either is fine, but we will need to upgrade one scenario that is currently loaded in the chrome debug session.
