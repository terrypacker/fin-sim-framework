# 130 — Bonds panel: holdings by bond type, and the maturity ladder

**Status:** BUILT (2 Nov 2026; proposed and built the same day, see §9). Display only: no
state field, no reducer and no golden changes.

**Related:** design 94 (securities as positions; step 10 is the Securities panel this one
takes its style from), design 66 (bond fidelity: G2 tax exemption, G4 dated bonds, G5 TIPS,
G6 zeros, G8 ladders), design 93 §5b (bond units at a par of 100), design 128 (ladder-aware
buys, the maturity grid), design 79 (real vs nominal display), design 108/111 (help topics).

## 1. The problem

A plan can hold TIPS, Treasuries, municipal bonds (in-state and out-of-state), taxable bonds
and bond funds, across several accounts, as ladders or as single lots. No panel answers
*which account holds which kind of bond, and when does it mature?*

- **The Securities panel shows no bonds from a ladder.** `rollupBySecurity` skips any cube
  row with no `securityId`. Ladder rungs (`bond-ladder-reducer.js` `_slotLot`) and bond-fund
  lots have none, and `syntheticSecurityId` is limited to the four equity markets. Bonds
  appear only when the author created them as securities.
- **The allocation cube merges the rungs on purpose.** It buckets by
  `(allocation, rateKey, securityId)`, which is what folds a ladder into one BOND row. That's
  right for allocation, but it hides the rungs.
- **Holdings is limited to one account** and shows bond fields as columns of raw lots, not
  as a breakdown by type.

### 1.1 Why not extend the Securities panel

Considered first and rejected:

1. **The bond facts are on the lot, not on a security.** `taxExemption`, `issuingState`,
   `inflationLinked`, `maturityDate`, `faceValue`, `couponRate`, `duration` and `zeroCoupon`
   are position fields (or instrument fields reached through `instrumentOf`). "Muni" and
   "TIPS" are categories derived from those fields, not instruments.
2. **The Securities panel adds units only within one instrument.** Each rung is a separate
   instrument with its own maturity. Bonds as securities would give either one row per rung
   or a made-up "ladder security" whose unit total means nothing.
3. **Giving bond lots a `securityId` is a model change.** It changes the serialised state
   (every whole-state golden fixture would need regolding) and widens a design 94 rule
   (`syntheticSecurityId` bounded by `EQUITY_SLEEVES`) that is deliberately equity-only.

So this design adds a separate panel with the Securities panel's style: the same table,
expandable rows, CSV export and currency/basis headers, grouped by bond type.

## 2. What the panel answers

1. How much of each bond type the plan holds, and in which accounts.
2. When the dated bonds mature: the ladder's shape over the coming years, by account.
3. For each type and account: principal, market value, basis, unrealized gain, coupon and
   duration.

## 3. The data: `bond-rollup.js`

A new module next to `security-rollup.js` in `src/finance/allocation-reporting/`. It is a
pure function of `(state, { date, baseCurrency })`, with no side effects.

### 3.1 What it walks

Every lot with `allocation === ALLOCATION.BOND` in every account the allocation cube
reads, using the cube's own account list (exported from `allocation-cube.js` if it isn't
already) so the two can't disagree about which accounts exist. Each lot is read through
`instrumentOf(h, state.securities)`, so an authored bond security gives its instrument
fields the same way it does for tax and maturity.

A lot whose market value is 0.005 or less is skipped, the same drained-lot rule
`bond-maturity-reducer.js` uses.

### 3.2 The tie to the cube

The Securities panel's header gives the rule: a second walk of the state is a second answer
with no way to tell which one is right. The cube can't serve the rung-level rows, so this
module walks the lots itself and **a test makes the totals agree**: for each account, Σ
market value over its bond lots equals the cube's BOND rows for that `stateKey`, at the same
date and base currency. The test runs over the golden scenarios that hold bonds
(`intl-retirement-scenario.js` already has Treasury, muni and taxable sleeves in a taxable
account, plus ladders).

Money is converted with the cube's `toBaseCurrency` (`src/finance/fx/to-base-currency.js`),
one call per lot, so a US and an AU position add up the way they do in the cube.

### 3.3 Bond type

Each lot gets exactly one type, checked in this order:

| # | Test (on the instrument view) | Type |
|---|---|---|
| 1 | `inflationLinked` | **TIPS** (US market) / **Inflation-linked** (AU market) |
| 2 | `couponFederalExempt(inst)` and `couponStateExempt(inst, residentState)` | **Muni — state-exempt** |
| 3 | `couponFederalExempt(inst)` | **Muni — state-taxable** |
| 4 | `taxExemption === 'state'` | **Treasury** |
| 5 | otherwise | **Taxable** (US) / **Nominal** (AU) |

- The country is the market's: `FIXED_INCOME_US` vs `FIXED_INCOME_AU`. US exemptions don't
  apply to an AU-market lot, and one that carries an exemption raises a warning (§8 Q1).
- With no US state residence (`residentState` null), rows 2 and 3 collapse to plain
  **Muni** (§8 Q2).
- `couponFederalExempt` / `couponStateExempt` come from `holdings-earnings.js`, and
  `residentState` from `primaryResidencyState(state)`: the same functions the coupon tax
  uses. So **the label always matches how the coupon is actually taxed**, including after a
  move changes the residency state partway through a run. The labels name the tax effect
  ("state-exempt"), not "in-state", because `'both'` is state-exempt whatever the issuer.
- A bond fund (no `maturityDate`) is not a separate type. A muni fund is still a muni. Being
  a fund is a property of the row: it shows as a lot row with maturity "fund" and no
  principal.

### 3.4 Row shape

```
BondTypeRow   { type, country, principal|null, marketValue, costBasis|null, unrealized|null,
                couponRate|null, couponReal:boolean, duration|null, nextMaturity|null,
                share, lotCount, accounts: BondAccountRow[] }
BondAccountRow{ stateKey, name, …same money/rate fields…, lots: BondLotRow[] }
BondLotRow    { id, label, maturityDate|null, rolls:boolean, zeroCoupon:boolean,
                principal|null, marketValue, costBasis|null, couponRate|null, duration|null }
```

- **Principal** is what the lot redeems for at today's index ratio. A unitised lot uses
  `indexedRedemptionValue(h, securities)` (units × par, × the CPI index ratio for TIPS, with
  the deflation floor). A scalar dated lot falls back to `faceValue`, or `max(marketValue,
  faceValue)` for scalar TIPS, matching the private `redemptionValue` in
  `bond-maturity-reducer.js`. That function is exported and reused rather than copied, so
  the panel and the maturity reducer can never disagree on proceeds. A fund has `null`. The
  units route comes first because `faceValue` is a parallel field that not every
  value-changing path keeps up to date.
- **Coupon** is weighted by principal (by market value for funds). It is `couponReal: true`
  for TIPS, and the column says "real" for those rows. A zero coupon shows "zero", not 0%.
- **Duration** is weighted by market value and uses the lot's current `duration`, which
  shortens towards maturity (design 66 G4).
- Rollups follow the null rule from `security-rollup.js`: principal and basis are `null` for
  a group if any contributing lot has `null`. One exception: a fund's `null` principal is
  expected, so a group's principal is the sum over its dated lots, with a
  `principalCoversAll: false` flag the UI shows (§4.2).

## 4. The panel

`src/visualization/workbench/plugins/finance/bonds-plugin.js`, registered in
`finance-plugin-package.js` as `{ id: 'bonds', title: 'Bonds', category: C.PORTFOLIO }` and
added to the centre tab lists next to `securities`. It uses the Securities panel's binding
pattern: `SCENARIO_READY`, `DISPLAY_SETTINGS_CHANGED`, the sim bus's
`EXECUTION_END` (EVENT) coalesced into one rAF render, a late-mount bind to the primary sim,
and a cache keyed on `(currentDate, eventExecutions)`.

### 4.1 Layout

```
┌ toolbar ─────────────────────────────────────────────────────────────────┐
│ [chart: by account | by type]  [▾ hide chart]          as of …   ⬇ CSV   │
├ maturity ladder (§5) ────────────────────────────────────────────────────┤
│  ▇▇ ▇▇ ▇▇ ▇▇ ▇▇ ▇▇ ▇▇ ▇▇ ▇▇ ▇▇        undated (funds): \$… not shown   │
├ table ───────────────────────────────────────────────────────────────────┤
│ Type ▸ Account ▸ Lot │ Principal │ Mkt value │ Basis │ Unreal. │ Coupon │ │
│                      │ Duration  │ Next maturity │ Share │ Lots          │
└──────────────────────────────────────────────────────────────────────────┘
```

Three expandable levels: type, then account, then lot. Expanded state is kept per key, as
`_expanded` in the Securities panel, with a delegated click listener on the tbody.

### 4.2 Headers and totals

- The money headers name the display currency and basis
  (`schemaRegistry.presentForDisplay(…).basis`, design 79), exactly as the Securities panel
  does, so a real-dollar display is labelled as real.
- **The footer totals principal**, unlike the Securities panel, which refuses to total
  units. Principal is money that will be repaid, in one currency after conversion, so adding
  it across types is valid. When any fund is held, the principal footer says "dated bonds
  only" in a tooltip, because funds have no principal to add.
- Coupon and duration in the footer are weighted the same way as in the rows.

### 4.3 CSV

One row per lot, plus `ACCOUNT` and `TYPE` total rows, with a `scope` column, as the
Securities export does with `TOTAL` / `ACCOUNT`. Every figure on screen can be traced back
to the lots it came from.

### 4.4 Empty states

- No sim: "Run a simulation to populate bonds."
- Sim with no BOND lots: "This plan holds no bonds." Not an error.

## 5. The maturity ladder chart

ECharts, as `allocation-plugin.js` and `liquidity-pools-plugin.js` already use.

- **x:** maturity year, from the current year to the latest maturity held. Years with
  nothing maturing still appear, so gaps in the ladder are visible.
- **y:** principal maturing in that year (§3.4), in display currency and basis.
- **Stacked** by account (default) or by type (toolbar toggle). Colours stay stable per
  series across steps, so a rung doesn't change colour as the sim moves forward.
- **Rolling rungs** (`rollAtMaturity`) are drawn with an ECharts decal pattern, and the
  tooltip says "rolls into a new N-year rung". A rolling ladder replaces itself while a
  spend-down ladder turns into cash (the `bondLadderRoll` distinction in the Bond Ladders
  help topic), and the chart has to show which is which.
- **Funds** have no maturity and are left off the chart. The amount is shown as a caption
  ("undated (funds): …"), so the chart's total and the table's total differ by a stated
  figure, not a hidden one.
- **Click a bar** to expand and highlight the table's lot rows that mature in that year.
- The chart shows the ladder **as at the panel's current date**: it changes as the sim
  steps and as rungs mature or roll. It isn't a projection.

## 6. What changes

| Area | Change |
|---|---|
| `src/finance/allocation-reporting/bond-rollup.js` | new: §3 |
| `allocation-cube.js` | export the account enumeration, if not already exported |
| `holding-utils.js` / `bond-maturity-reducer.js` | `redemptionValue` moves to the leaf module and is exported (no behaviour change) |
| `plugins/finance/bonds-plugin.js` + CSS | new: §4–§5 |
| `finance-plugin-package.js` | register `bonds`; add to centre tab lists |
| `help/panels/bonds.md` | new panel topic from `npm run help:gate -- --template panel`; `help:build` regenerates REFERENCE |
| Securities panel help | one line pointing to the Bonds panel for ladders and funds |

No state, reducer, loader or serialiser changes, so no fixture should move. A golden diff
would mean the build touched something it shouldn't have.

## 7. Phases and tests

1. **Rollup.** `tests/unit/bond-rollup.test.mjs`: the order of the type checks in §3.3
   (a TIPS that is also `'state'` is TIPS; `'both'` is state-exempt whatever the issuer;
   a `'federal'` muni flips from state-taxable to state-exempt when `residencyState` matches
   `issuingState`); principal for unitised, scalar, TIPS (indexed and floored), zero and
   fund lots; the null rules; the drained-lot skip; and the cube tie (§3.2) on the golden
   scenarios that hold bonds.
2. **Panel table + CSV.** `tests/viz/bonds-plugin.test.mjs`, following
   `securities-plugin.test.mjs`: empty states, three-level expansion, currency and basis
   headers, principal footer with and without funds, CSV scopes.
3. **Maturity chart.** Series built by a pure helper (year buckets, stacking, roll flag,
   fund caption total) that is unit-tested without ECharts; the plugin test checks the
   option object it passes to ECharts.
4. **Help.** Panel topic, `help:gate` clean, and the Securities topic restamped after its
   one-line pointer is added.

## 8. Decisions (2 Nov 2026)

- **Q1. US exemptions on an AU-market lot: warn.** The type ignores the exemption (the lot
  reads AU nominal or AU inflation-linked). The panel shows a collapsed warning, one line
  per (account, exemption), because US exemptions are for US Treasury and US state/local
  bonds. Whether any tax path reads the exemption depends on the account: the US coupon
  handlers are wired per US role, so an AU super rung's exemption may be inert. Not traced
  (§10).
- **Q2. No US state residence: plain Muni.** Both muni rows collapse to **Muni**.
- **Q3. Coupon cash-flow overlay: not built.** The chart stays a snapshot.
- **Q4. Watch stars: not built.**

## 9. Build notes (2 Nov 2026)

- `redemptionValue` went to `holding-utils.js` (next to `indexedRedemptionValue`), not an
  export of the reducer: `allocation-reporting/` importing a reducer module would pull the
  reducer framework into a reporting leaf. The reducer imports it from there.
- `allocation-cube.js` exports `isCubeAccount(entry)` (non-loan, numeric balance), the
  predicate its own loop applies. The rollup walks with it.
- The tie test (§3.2) compares against the cube's `HOLDING`-source BOND rows only. A legacy
  account with no holdings gets an inferred BOND row from the cube, and an MSBS employer
  benefit can carry a BOND part. Neither has lots, so neither appears in this panel.
- Ladder colours are keyed `bond:<key>` through `colorForSeriesKey`, so a type keeps its
  palette slot (fixed type order) as money moves between types.
- Tests: `tests/unit/bond-rollup.test.mjs` (21, including the cube tie on the default
  scenario and on a 5-rung TIPS ladder stepped to mid-2031) and
  `tests/viz/bonds-plugin.test.mjs` (9).
- **Fix (2 Nov 2026): a long warning hid the table.** Only the table scrolled, so a laddered
  AU super account (9 rungs, one warning each) plus the chart squeezed it to 0px in a short
  pane. Warning, chart and table now share one scroll body (the sticky header still
  sticks), and the warning folds to a collapsed `<details>` grouped by account, which stays
  open or closed across steps.

## 10. Open: the ladder stamps a US tax treatment on AU accounts

`BOND_LADDER` takes one `bondLadderTaxTreatment` (default `'state'`) and applies it to every
account `bondLadderRole` selects, including AU super. An AU-market rung should be `'none'`.
Not fixed here, because it changes rung lots in state (golden-visible). Open questions: does
any tax path read the exemption on an AU account (it may be cosmetic), and should the
reducer force `'none'` for an AU-market intent or take the treatment per account?
