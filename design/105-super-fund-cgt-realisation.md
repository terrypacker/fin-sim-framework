# 105 — Super fund CGT on realisation

**Status** (2026-09-15): **BUILT**, including §8 (bond income, and a correction to §3.2 for
bonds). Decisions in §4 and §8.3, results in §6 and §8.5, open items in §7.

## 1. The gap

Before this design, `SuperEarningsHandler` withheld the fund's 15% from super's **whole**
yearly return in accumulation phase: dividends, which is correct, and price growth, which is
not. The rebalancer then treated a super sell as a free "sheltered sell", so the yearly 15%
was the only tax super ever paid on growth.

On the default APRA mix (design 99 P5c) the blended price growth is 4.93% of the balance a
year (AU 6.7% total − 3.43% yield; ex-AU 7.5% − 1.47%), so the yearly charge overstated fund
tax by up to **0.74% of the balance a year**, in accumulation only. Pension phase was already
0%.

## 2. The law (ITAA 1997, on disk)

| Provision | Effect for super |
|---|---|
| s295-85 | CGT is the primary code for a complying fund's gains: taxed **when realised** |
| s102-5(1) | net capital gain: Step 1 this year's losses reduce gains, Step 2 carried net capital losses reduce what is left, Step 5 the discount applies to what remains (Steps 3–4 quarantine residential amounts, which a fund's shares never are) |
| s102-5(1) Step 1, Note 3 | within a category, the taxpayer chooses the order in which gains are reduced |
| s102-10, s102-15 | a year's net capital loss is losses over gains; carried losses apply in the order made |
| s115-25 | discount only on an asset acquired **at least 12 months** before the CGT event |
| s115-100(b) | a complying superannuation entity's discount is **33⅓%**, so 15% becomes an effective **10%** |
| s118-320 | a gain **or loss** on a segregated current pension asset is **disregarded** |
| s295-390 | an unsegregated fund exempts a proportion of its statutory income (net capital gain included) by pension liabilities over total liabilities |
| Div 296 (s296-60) | even the large-balance tax starts from the fund's **taxable income**, and Note 3 disregards deferred notional gains |

Nothing on disk taxes a fund on unrealised growth.

## 3. Design

### 3.1 Income, yearly

`SuperEarningsHandler` now splits each lot's return in two:

- **Income:** the dividend the lot pays (the same yield resolver and regime cut as
  `computeHoldingsDividends`), plus the franking credit on an AU lot (design 90 §8.4). The
  fund pays `t` on (dividend + credit) and the credit offsets the tax, refundably. The rest
  is reinvested as **new units carrying cost base** (`VALUE_KIND.UNITS`,
  `costBasisDelta = amount`), since that money bought units rather than appreciating.
- **Price:** growth less the dividend, as a `PRICE` move with no cost base and no tax.

`computeFundIncome` (`holdings-earnings.js`) replaces design 90 §8.4's credit-only helper.
`SUPER_EARNINGS_APPLY.grossAmount` is now the **income** base the classifier levies `t` on.

A loss year is no longer a special case. Design 84 G12's loss branch withheld nothing, which
left the dividends paid in a down year untaxed. Now a price fall is simply unrealised, and
the year's dividends are income like any other.

### 3.2 Capital gains, on realisation

- **Where a super lot is sold:** only the rebalancer. A super withdrawal is blocked before 60
  (EVT-21/22), so under the model's age-60 pension proxy every withdrawal falls in pension
  phase, where s118-320 disregards the gain. No withdrawal path is needed.
- **The rebalancer** (`rebalance-to-target-apply-reducer.js`): on a super sell it works each
  lot's gain on the pro-rata slice sold. It splits discountable from other by `isLongTerm('AU',
  …)` on the lot's `purchaseDate`, keeps losses (the design 84 `shelteredGain` beside it floors
  them), and emits `SUPER_CAPITAL_GAIN { discountableGain, otherGain, capitalLoss }`.
- **`SuperCapitalGainApplyReducer`** (`au-super-classes.js`) keeps an income-year tally on the
  account, `capitalGainsYTD { fy, discountableGain, otherGain, capitalLoss, carriedLoss,
  netGain }`. It re-works the year's net capital gain with `superNetCapitalGain` (s102-5
  netting, losses against non-discount gains first, then the ⅓ discount) and withholds 15% of
  the **change** from the fund. A later loss in the same year therefore gives back tax an
  earlier gain drew. The fund pays from fund assets (design 77 §5.1): the balance and holdings
  fall pro rata via `scaleHoldings`, and the tax comes off earnings first.
- **Rollover** is lazy: the first disposal in a new AU income year carries forward the old
  year's unused loss (s102-10).
- **Pension phase** (member ≥ 60): the gain and the loss are disregarded, and nothing is
  recorded.

## 4. Decisions (user, 15 Sep 2026)

1. **Realisation basis**, because it is the Act (§2). Pooled-fund unit-pricing practice
   (provisioning for tax on unrealised gains) is how a fund shares out its own liability,
   not a tax the Act imposes, so it does not set the model.
2. **Carry the loss balance** per fund, across income years.
3. **Withdrawals sell pro rata.** This is moot today (§3.2), and it matches the rebalancer's
   pro-rata sale.
4. **Book through fund tax.** The change in tax rides `SUPER_EARNINGS_TAX` into
   `auPersonSuperTaxYTD`, then `fundTax`, then `cumulativeTaxesPaid`, with the rest of the
   fund's tax.
5. **Div 296: noted, not built.** Its threshold is 3,000,000 (s296-30, indexed from 2027-28),
   its rate is in an Imposition Act that is not on disk, and the highest super balance any
   golden reaches after this build is 2,292,065.

## 5. Simplifications

- **Money into an existing lot inherits its date.** Reinvested income and contributions
  (`AccountService.transaction`) are added to existing lots and take their `purchaseDate`.
  Design 93 would open a vintage lot instead. The effect: a lot sold within 12 months of
  receiving new money reads that money's gain as discountable. It is small, because new money
  is a few percent of a lot a year and a rebalance sells only the drift.
- **Bootstrap lots** carry cost = value at load and no date. They read as oldest, which is
  `_purchaseTs`' existing convention, so they count as held ≥ 12 months.
- **One tally per super account**, with the member's age from the account's owner (the same
  age-60 proxy as the earnings handler).
- **A death benefit paid before 60** does not realise the fund's gains.
- **Configs without ECONOMIC_REGIMES** apply the handler's AU fallback yield to every lot, as
  the fallback growth rate always has.

## 6. Results

**Tests:** `tests/unit/super-cgt-realisation.test.mjs` (9: netting, 10% vs 15%, same-year
give-back, carry-forward across years, pension disregard, the rebalancer's per-lot split, an
IRA emitting nothing). Rewritten for income-only tax: `super-franking.test.mjs` (7), EVT-23 in
`evt-super.test.mjs` (plus a new price-growth-is-untaxed test), and design 84's two G12 super
tests. Precondition changes where fund tax may now be a net refund: D76 P2's attribution test
(non-zero, unequal by magnitude) and the report e2e (`fundTaxUsd !== 0`). The market-total
guard now undoes the fund's arithmetic to recover super's pre-tax return.

**Goldens: 12 of 13 re-golded** (every one with super), measured against the design 90 §8.4
fixtures:

| golden | net worth | lifetime tax | super balance |
|---|---|---|---|
| au-single-homeowner | +13.84% | −13.02% | +53.67% |
| au-super-streams | +2.39% | −7.64% | +4.06% |
| cross-border-reference | +1.02% | −5.75% | +8.52% |
| cross-border-disposals | +0.63% | −3.76% | +8.61% |
| two-security-concentration | +0.49% | −4.39% | +9.94% |
| speculative-stake | +0.33% | −5.33% | +4.23% |
| speculative-conversion | +0.29% | −3.26% | +4.23% |
| tips-ladder-conservation | +0.21% | −1.59% | +1.83% |
| bond-par-conservation | +0.20% | −1.52% | +1.59% |
| payroll-limits | +0.19% | −1.14% | +4.23% |
| wash-sale-harvest | +0.18% | −0.77% | +2.60% |
| wash-sale-two-books | +0.10% | −0.58% | +0.88% |

- **The fund-tax identity closes to 0.00 in all 13 goldens:** Σ classifier accrual, less the
  final year's unsettled YTD, equals the settled `fundTax`. CGT tax reaches fund tax through
  the same path as the rest.
- **Four goldens realise super gains in accumulation:** `bond-par-conservation` and
  `tips-ladder-conservation` (6 sales each), `wash-sale-harvest` (6, including 3,870 of
  losses) and `wash-sale-two-books` (8, including 1,872 of losses). The rest never sell a
  super lot before 60, so their whole move is the yearly 15% on price growth coming off.
- **Nothing leaks out of super.** `cross-border-reference` changes zero fixture leaves outside
  super, fund tax and the aggregate metrics. `au-single-homeowner` changes only
  `usOrdinaryIncomeYTD` / `foreignGeneralIncomeYTD` (+43,803): the same withdrawals draw on a
  larger `earningsBasis`, which EVT-22 counts as US ordinary income, and that plan has no US
  person to pay it.
- **The design 52 lock-in** was re-based to 678,972 / 12,148,274.

## 7. Still not modelled

- ~~**Bond coupons inside super are untaxed.**~~ **BUILT as §8**, with accretion and the
  revenue treatment of bond gains.
- **A fund's TOFA fair-value election** (Div 230), which would tax unrealised bond price
  moves yearly. It is an election, not the default.
- ~~**A super bond redeemed at maturity**~~ **BUILT as §8.6.**
- **Div 296** (§4.5).
- **The transfer balance cap.** The whole balance is treated as exempt from 60 (design 77
  §4.2).
- **Foreign tax offsets** on the fund's ex-AU dividends.
- **The 45-day qualified-person rule** (design 90 §2.3).

## 8. Bond income inside super  ✅ BUILT (15 Sep 2026)

### 8.1 The gaps

Three, found together:

1. **Coupons.** `au-retirement-toolset` wired super's `BondSleeveCouponHandler` with
   `taxMode: 'deferred'`, meaning credited and reinvested with no tax.
2. **Accretion** (a zero-coupon discount accruing, TIPS indexation). The same `'deferred'`
   wiring.
3. **A §3.2 error.** The rebalancer's super sells treated a BOND lot's gain as a capital gain:
   discounted to 10% when held 12 months, with its loss quarantined as a capital loss.

### 8.2 What the Act says (on disk)

| Provision | Effect |
|---|---|
| s6-5, s295-385/390 | a coupon, and accretion, is the fund's ordinary income: 15% in accumulation, exempt in pension phase |
| **s295-85(3)(b)(i)** | the CGT-first rule of s295-85(2) gives way when the asset is *"debenture stock, a bond, debenture … or other security"*, so s6-5 and s8-1 apply to a fund's gain or loss on a bond |
| s8-1 | a bond loss is a deduction against the fund's assessable income |
| s230-455(2), s230-15 | TOFA exempts a super fund only while its assets are **under 100 million**, so every MySuper fund is in Div 230 for its bonds, where gains are assessable and losses deductible (taxed on disposal unless the fund elects fair value) |

Either route gives the same model: bond gains are ordinary income with **no discount**, and
bond losses reduce the fund's income generally.

### 8.3 Decisions (user, 15 Sep 2026)

1. **A revenue loss is refunded at 15% immediately**, rather than carried as a Div 36 tax
   loss. A MySuper fund always has other income to absorb it.
2. **Accretion is included** with coupons: the same wiring and the same law.
3. **§3.2 is corrected for bonds** in the same build.

### 8.4 Design

- **`taxMode: 'super'`** on super's coupon and accretion handlers. The apply reducers take
  the member's rate from `superFundTaxRateOn(state, account, date)` (the age-60 proxy, from
  the reduce date) and book `SUPER_EARNINGS_TAX` into fund tax.
  - Coupon: each reinvest bucket shrinks by `(1 − t)`, so the fund's vintage lots are
    unchanged in kind and only smaller.
  - Accretion: non-cash, and the handler steps the accreting lots up afterwards, so the tax
    comes off the fund's existing holdings pro rata (`scaleHoldings`). A negative accretion
    (TIPS deflation) refunds at the same rate.
- **Bond disposals:** the rebalancer's super BOND lots report a signed `revenueGain` on
  `SUPER_CAPITAL_GAIN`. `SuperCapitalGainApplyReducer` taxes
  `netCapitalGain + revenueGain`, withholding 15% of the change. `netCapitalGain` is floored
  at 0 first, so a capital loss never shelters a bond gain, while a bond loss does reduce a
  capital gain. Revenue does not carry forward; it is settled in the year. In pension phase
  both are disregarded.
- `'deferred'` is unchanged for 401(k), IRA and Roth.

### 8.5 Results

**Tests:** `tests/unit/super-bond-income.test.mjs` (6: the rate helper, coupon and
accretion in accumulation and pension, `'deferred'` untouched) and four more in
`super-cgt-realisation.test.mjs` (a bond gain at 15%, a bond loss refunded, capital vs
revenue netting, the rebalancer's bond leg).

**Goldens:** only the four with super bonds moved; the other eight are identical to §6. Net
worth and lifetime tax are shown against §6:

| golden | super coupons | bond gain reclassified | net worth | lifetime tax |
|---|---|---|---|---|
| bond-par-conservation | 46,130 | 0 (bonds sold at cost) | −5,078 | +3,910 |
| tips-ladder-conservation | 45,499 | 0 (no bond sells) | −4,965 | +3,871 |
| wash-sale-harvest | 61,895 | 41,394 | −7,077 | +6,642 |
| wash-sale-two-books | 76,541 | 33,150 | −7,647 | +7,865 |

- The fund-tax identity still closes to 0.00 in every golden.
- No golden accretes a super bond, so accretion is covered by unit tests only.
- The design 52 lock-in is unchanged: its super holds no bonds.

### 8.6 Maturity  ✅ BUILT (15 Sep 2026)

A super bond's maturity is a disposal on revenue account, like its sale (§8.2). Before
§8.6, `BondMaturityReducer` treated every account alike. It redeemed to cash at par,
stepping a below-par basis up untaxed, and it rolled a bond with its old basis carried
forward. Both deferrals exist for design 66 §G9 and are right to keep for the other
wrappers, but not for a fund whose bond gains are income as realised.

- For an account with `role: 'super'`, each matured lot's gain (redemption value − cost
  basis) is summed and emitted as SUPER_CAPITAL_GAIN `{ revenueGain }`.
  SuperCapitalGainApplyReducer taxes it at 15% with no discount, refunds a loss at once,
  and disregards both in pension phase (§8.3).
- The redemption value comes from a new shared `redemptionValue()`, so the gain and the
  cash `redeem()` pays can never disagree. That includes the TIPS deflation floor and
  indexed principal.
- A super **roll** is a redemption and a fresh purchase: once its gain is booked, the rolled
  bond's `costBasis` is its par.
- A drained lot (value ≤ 0.005) realises nothing, matching `redeem()`'s own guard.

No golden holds a maturing super bond, so no fixture moves. Tests:
`super-bond-income.test.mjs` +3 (redeem, roll re-based at par, an IRA keeping the
deferral).
