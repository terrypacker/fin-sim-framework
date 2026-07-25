# 76 — AU per-person income attribution

**Status: P1 IMPLEMENTED (Gap C); P2–P5 proposed.** §7's four questions are answered and settled.
P1 landed **inert on the golden as designed** — net worth 4,810,931, cumulative deficit 4,563,500 and
lifetime tax 1,831,460 are byte-identical before and after, and every per-person accumulator is
unchanged, because attribution still falls through to the even split until Gap A lands in P2. Suite:
3,966 unit (+18 new) / 910 viz green. See §4 for the per-phase record, and §0 for an unrelated
taxed-by-neither-country defect fixed in passing.

Australia has no joint assessment. Every individual lodges their own return, and every dollar of
assessable income belongs to exactly one taxpayer — or, for a jointly held asset, to each owner in
proportion to their legal interest. The model does not do this. It computes most AU-assessable
income into household scalars and then divides them by the number of residents at settle time.

That divisor is the bug. It is not a modelling simplification with a small error term: it is
applied to income that is not shared, at a magnitude that dominates the income that *is* correctly
attributed, through a progressive rate schedule where the split changes the answer.

**Measured sensitivity.** Re-allocating the shared pool from 50/50 to 100/0 in
`computeAuTaxPerPerson` — changing nothing else — moves lifetime tax on
`scenarios/fin-sim-scenarios.json` from **$1,831,460 to $2,024,926**, a swing of **$193,466
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

This is the user's reported symptom exactly. Super balances of $51,360 (Terry) and $343,470
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
  different entitlements ($2,000/mo and $1,000/mo). It is split 50/50.
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
savings accounts — Terry's `auSavingsAccount` ($50,000) and Jeanne's `spouseAuSavingsAccount`
($119,000) — and *all* interest from both is attributed through Terry's account object. The same
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
| **P2** | Gap A — carry `ownershipType` + `owners` through both `_accountToStatePlain` functions. | Per-person values move to true ownership. **Totals barely move** (~$17 lifetime) — see §5. Safe only because P1 landed first. |
| **P3** | Gap B — migrate the 20 action types. Largest phase; split by family (retirement accounts / brokerage+bond / income / capital gains) so each lands testable. Carries Gap D's first three scalars along with it. | **This is where the money is.** Expect movement inside the ±$193k band. |
| **P4** | Gap D — apportion `usTaxPaidOnUsSourceAud` by each person's US-source share. | Second-order; changes FITO relief, not assessable income. |
| **P5** | Delete the `/ numResidents` fallback in `computeAuTaxPerPerson`, or convert it to a dev-mode assertion that fires if any AU household scalar is non-zero at settle. | None if P3 is complete — and that is the test. |

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

P5 is the one that makes this stick. As long as the silent even-split fallback exists, the next
income type added will quietly acquire the same bug. Turning it into a loud failure is what
converts "migrated" from an assertion into something the suite can check.

---

## 5. What to expect from the golden — and why the totals lie

**A flat tax is split-invariant.** Super tax is a flat 15% added *outside* the bracket computation
(`au-tax-rates-base.js:237`: `grossTax = ... + auSuperTaxYTD + minTaxTopUp`), and non-resident
withholding is flat at the treaty caps (10% interest, 15% unfranked dividends). Splitting a flat-rate
amount differently between two people cannot change its total. This is why fixing Gap A — which
visibly corrects super tax from 1,937/1,937 to 504/3,371 — moves lifetime taxes by **$17**.

So the headline totals will *not* validate P1 and P2. Only the progressive machinery is
split-sensitive: the resident marginal brackets, the tax-free threshold, the Medicare levy, the CGT
discount, and design 57's 30% CGT minimum tax. All of those act on `auOrdinaryIncomeYTD` and
`auCapitalGainsYTD` — Gap B's fields. That is both why P3 carries the entire measurable value and
why P1/P2 need per-person assertions rather than golden locks to be tested at all.

Corollary for review: **a P1 or P2 change that moves the lifetime total significantly is a
regression, not a success.** Only P3 should move it.

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
  $51k/$343k super is a good template.
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
