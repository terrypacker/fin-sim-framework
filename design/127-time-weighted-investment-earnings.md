# 127 — Time-weighted investment earnings

**Status:** PROPOSED (15 Oct 2026). Raised by a study flag: "year-end earnings pay a full year's
return on the 31-Dec balance".

**Related:** design 25 §5.4 (holdings as the substrate), design 62 §9 (rebalance buys get their
own lot), design 84 G12 (losses are applied), design 99 §2 (price return = total − yield, the
dividend paid separately), design 106 (dividend reinvestment), design 107 (spending as twelve
just-in-time sales a year), design 78/82 (MC samples at the year boundary).

## 1. The problem

Equity growth and dividends are each one event a year, on 31 December
(`INTL_STOCK_EARNINGS`, `DIVIDEND_SCHEDULED`, `interval('year-end')`). The handler
(`IntlUsStockEarningsHandler` and its siblings, through `computeHoldingsGrowth`) credits
**the balance on that day × the annual rate**. Nothing weights by how long the money was there.

The error runs both ways:

- **Money that arrives mid-year earns a full year.** A property sale credited in late October
  earned a full year's equity return on its equity share two months later. The first year of
  every run is a stub (a plan that starts in September), so the whole book earns twelve months
  for four.
- **Money that leaves mid-year earns nothing for the months it was invested.** Design 107 funds
  spending with twelve sales a year; each sale leaves before 31 December and takes none of the
  year's return with it, so a drawn-down account earns `rate × closing balance` instead of
  `rate × average balance`. For a retiree drawing a steady W a year that understates earnings by
  about `rate × W / 2` every year.
- **Prices do not move within a year.** A sale in June sells at January's price, so a June
  rebalance, a June JIT sale and a June purchase all trade at a price that is up to a year stale.

Every arm of a comparison shares the second and third effects, but any comparison of **when**
money is invested or withdrawn (sale timing, a lump-sum deployment, a mid-year rebalance) is
biased by all three.

Interest on savings and fixed-income accounts is already monthly (`factor: 1/12`); bond coupons
are semi-annual. Only equity growth and dividends are annual.

## 2. Options

**A. Monthly growth.** Fire equity earnings monthly at the geometric monthly rate
`(1 + r)^(1/12) − 1` of the year's drawn annual return, so twelve months compound to exactly
the annual rate and the year's total is unchanged for a buy-and-hold lot.
- Fixes all three effects to within a month: arrivals earn from the month after they land,
  withdrawals earn until they leave, and a mid-year sale trades at a price that has moved.
- The stub year falls out naturally (four monthly credits for four months).
- Dividends can follow monthly or quarterly at `yield / n`, which is how most funds pay.
- Cost: about twelve times the earnings events per equity account. Measure it (MC runs are the
  budget); `telemetry: 'off'` runs pay only the reducer work.
- Every golden with equity moves.

**B. Midpoint (Modified Dietz-lite).** Keep the annual event; credit
`rate × (opening balance + closing balance) / 2`, per lot. Cheap (one stored opening value per
lot), but a lot bought in November is treated as if held half the year, prices still do not move
within the year, and per-lot opening values add state to every fixture.

**C. Exact time-weighting.** Record each dated flow into or out of an account and credit
`rate × (opening balance + Σ wᵢ · flowᵢ)` with wᵢ the fraction of the year remaining after flow
i. Exact for balances, but it needs a hook on every balance-changing path (transactions,
holding transacts, rebalances, transfers, taxes paid from the account), each one a place for a
silent omission. Prices still do not move within the year.

**D. Fix the stub year only.** Prorate the first year by its length (`factor` already exists on
`computeHoldingsGrowth`). Small and safe, but it leaves the mid-year inflow and outflow bias.

## 3. Proposal

**A, monthly growth, with D as its first step.**

1. **Stub year (D).** Prorate the first year-end credit by the fraction of the year the run
   covers. Small, independently testable, and it removes the largest single error on every plan
   that does not start on 1 January.
2. **Monthly equity growth (A).** A monthly `INTL_STOCK_EARNINGS` (and the AU and wrapper
   equivalents) at the geometric monthly rate. The year's drawn return is still drawn once a
   year (design 102's annual tick); only its crediting is spread. Level effects (shock
   revaluations) stay instantaneous.
3. **Dividends** follow at the fund's own cadence (quarterly by default), at `yield / 4`, with
   reinvestment as today.

Behind a parameter for the transition (`equityEarningsCadence: ANNUAL | MONTHLY`), defaulting to
MONTHLY once the goldens are regenerated and read, so an earlier study can be reproduced.

## 4. What it touches

- `computeHoldingsGrowth`: a cadence-aware factor (`(1 + r)^(1/n) − 1`, not `r / n`). Today's
  savings path uses `r / 12`, simple; leave it, since that is how bank interest is quoted.
- Schedules in the US, AU and wrapper toolsets (`interval('year-end')` → `'month-end'`).
- Tax: unrealised growth is untaxed, so monthly crediting does not change tax timing. Dividends
  taxed per payment add up to the same annual figure; check the AU franking and US qualified
  splits still aggregate by year.
- MC: the year-boundary sampler (design 82) is unaffected; the yearly series moves because the
  path inside the year is now smooth.
- Super and MSBS earnings (`SUPER_EARNINGS_APPLY`) are annual too and need the same treatment;
  super earnings tax is assessed on the year's earnings, so the aggregation must hold.

## 5. Open questions

1. **Monthly or quarterly?** Monthly matches design 107's twelve JIT sales; quarterly is a third
   of the events. Proposed: monthly, after a cost measurement.
2. **Default switch.** Changing the default moves every equity golden and every earlier study
   result. Proposed: land the code at ANNUAL, regenerate and read the goldens under MONTHLY in a
   separate commit, then switch.
3. **Bond sleeves and gold.** Bond prices move on yield changes (`BondPriceAdjustReducer`); gold
   is on the growth path. Does gold go monthly with equity? Proposed: yes, it is the same path.

## 6. Test plan (to be written with the code)

- Stub year: a run starting 1 September credits a third of the year's return at its first
  year-end, and a full year thereafter.
- Monthly: a buy-and-hold lot ends the year at exactly `(1 + r)` (geometric monthly rate); a
  lot bought on 1 November ends at `(1 + r)^(2/12)`; a lot sold on 30 June took `(1 + r)^(6/12)`
  with it.
- A drawn-down account earns more under MONTHLY than ANNUAL by about `rate × W / 2`.
- ANNUAL is byte-identical to today.
