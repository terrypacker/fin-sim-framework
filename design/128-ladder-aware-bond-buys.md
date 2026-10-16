# 128 — Ladder-aware bond buys (design 66 §10.5, Phase B)

**Status:** BUILT (16 Oct 2026; proposed 15 Oct, reviewed against the code 16 Oct, see §7–§8). The companion
design 66 §10.5 asked for ("its own companion if pursued"), raised now by a study flag: "a rebalance
BOND buy is a nominal bond until the next ladder pass, and then it becomes ONE rung".

**Related:** design 66 (bond fidelity: G8 ladders, §10.5 buy side, §10.6b fund absorption, §10.8 #2
the intent's home, §10.9 ladder-aware drawdown), design 61 (the allocation lever and its rebalance
buys), design 62 §9 (a buy is its own lot), design 93 §5 (lots, par per unit, compaction), design 97
§12.4a (pool-flow purchases), design 121 §8 (TIPS market real yield, `tipsCouponMode`), design 125
(TIPS expected inflation).

## 1. The problem

A plan with a bond ladder (`BOND_LADDER`, `BondLadderReducer`) and a target allocation rebalances
into bonds. The two do not know about each other:

1. **The buy is a nominal fund lot.** `RebalanceToTargetApplyReducer` buys BOND in a lot of its
   own (`_newSleeve`, design 62 §9; `_addProRata` is CASH only). The lot takes from the rungs only
   what they unanimously agree on (`_inheritedTraits`): the tax exemption carries over, but
   `duration` does not (every rung has a different one) and `inflationLinked` is not an inherited
   trait at all. So the lot is an undated bond FUND at the market's default duration, coupon locked
   at the nominal fund-tenor yield. On a TIPS ladder that money is a nominal bond.
2. **The ladder only looks at period advances.** `BondLadderReducer` reduces
   `US_PERIOD_ADVANCE` / `AU_PERIOD_ADVANCE` at `PRE_PROCESS + 5`. The rebalance is detected on the
   same advances at `PRE_PROCESS + 4`, but its `REBALANCE_TO_TARGET_APPLY` runs after the ladder
   pass, so the buy waits for the NEXT advance. In a two-country plan that is the other country's
   advance, six months later (a 1 January buy is absorbed on 1 July); in a one-country plan it is a
   full year. Measured on the study plan: the 1 January buy sat as a nominal fund until the 1 July
   AU advance.
3. **It becomes one rung.** `absorbAsTailRung` puts all of the new money into a single tail rung
   maturing `N × spacing` years out. A ladder that should spread a large purchase over N maturities
   instead gains one rung many times the size of the others. The roll keeps that lump intact
   forever, so the ladder's liquidity profile (one rung maturing each period) is lost. Two things
   make it worse:
   - The tail is dated from the absorbing advance, not from the ladder's own maturity grid. A rung
     absorbed on 1 July matures on 30 June while the materialized rungs mature on 31 December, so
     the ladder ends up on two calendars and their rungs never become the same bond after a roll
     (`_compactLadderLots` cannot merge them).
   - Under `drawdownLotStrategy: 'LADDER'` (nearest maturity first) the small original rungs are
     drawn first. On the study plan only the lump was left one year in.

The effect on a study: a TIPS lever that should protect against inflation is absent for the first
six to twelve months of the shock it was bought for, and afterwards most of the TIPS money matures
in one year of every ladder cycle.

## 2. What should happen

A bond buy into a laddered account is **a purchase of the ladder**: the same instrument (TIPS or
nominal, as the ladder is), at the market yield for each tenor, spread across the ladder's
maturities so every slot grows by the same amount. That is what a household buying "more of my
ladder" does.

This departs from design 66 §10.5's wording ("seed/extend the tail rung"). Putting new money in the
tail is how a ladder is maintained by its own roll, one rung at a time; a large lump bought at once
put in the tail is the defect in §1.3.

## 3. Proposal

### 3.1 A ladder-intent descriptor (design 66 §10.5, §10.8 #2)

`BondLadderReducer` stamps `account.bondLadderIntent` so other code can read the ladder's shape
without duplicating rung state. It is an intent, not a copy of the rungs. Design 66 §10.8 #2 named
`{ rungs, spacing, term, roll, taxExemption }`; buying the right instrument needs more:

| Field | Source |
|---|---|
| `rungs` | the rung count in force (`_targetRungsOf(state)`, so an MPC decision is honoured) |
| `spacingYears`, `roll`, `taxExemption` | the reducer's config |
| `anchorMs` | the materialization date: slot maturities are `anchorMs + m × spacing` (§3.2) |
| `inflationLinked`, `tipsCouponMode` | the reducer's config, mode resolved from AUTO (`_tipsMode()`) |
| `couponRate` | the pinned coupon, or null for the market yield |
| `rateKey` | `resolveRateKey(country, BOND)` |
| `inflationExpectation` | design 125's spec, needed for the TIPS real yield |
| `minSlotBuy` | `bondLadderMinSlotBuy` (§3.2) |

It is written on **every** ladder pass, including one that finds no bonds to ladder, so the first
buy into an account whose ladder has not yet materialized is routed too. `anchorMs` is set at
materialization and kept until the next re-materialization (a lever change of N re-anchors). The
existing `_bondLadderRungs` marker stays as it is.

The yield rule moves out of the instance method into an exported
`ladderSlotYield(state, intent, tenorYears)` (pinned coupon, else `tipsRealYield` for a TIPS ladder,
else `resolveYield`). `BondLadderReducer._marketYield` calls it too, so there is one rule.

### 3.2 Buy routing at the rebalance

`RebalanceToTargetApplyReducer`'s BOND buy leg, on an account with `bondLadderIntent`, calls a
shared `buyIntoLadder(holdings, amount, intent, { state, stateKey, purchaseMs, priceLevel })`
exported from `bond-ladder-reducer.js` instead of `_newSleeve`:

- **Slots.** The N slots are the next N dates on the ladder's grid, `anchorMs + m × spacing`, after
  the purchase date. They come from the intent alone, so they exist when drawdown has consumed every
  standing rung, and bought money always lands on the same maturity dates as the rungs.
- **Split.** `amount` is split equally over the N slots, the last slot taking the rounding
  remainder (the `materializeLadder` rule).
- **Small buys go to the tail slot only** (§5 Q2, decided). When a slot's share,
  `amount / N`, is below the per-slot floor `bondLadderMinSlotBuy` (a `BOND_LADDER` param in the
  account's currency, default \$1,000), the whole amount opens one lot on the longest slot:
  today's tail behaviour, on the grid date. The floor is read through the intent.
- **Lots.** Each share opens a new lot, `ladder-<key>-buy-<purchaseMs>-<m>`: issued at par today
  (`unitiseBond`), `costBasis` = the amount paid, `purchaseDate` = the rebalance date,
  `acquisitionPriceLevel` = today's AU level, the ladder's instrument (`inflationLinked`,
  `tipsCouponMode`, `taxExemption`), `rollAtMaturity` / `rollTermYears` from the intent, coupon
  `ladderSlotYield` at the slot's own remaining tenor.
- **No join.** A share does not merge into an existing lot. A slot is reached by purchases made
  in N different years, so a lot keyed on the slot would blend purchase dates (design 62 §9).
  Merging is left to `_compactLadderLots` (`LOT_POLICIES.LADDER`, seasoned lots only), which binds
  after a roll, when two lots on the same grid date re-issue as the same bond. The grid anchor is
  what makes that possible (§1.3).

This removes both the wait (the buy is the ladder's instrument in the same action) and the lump
(the money is spread).

### 3.3 The absorb fallback uses the same split

`absorbAsTailRung` stays for money that still reaches a laddered account as an undated BOND lot,
from a path that does not know about the ladder:

- `distributeHoldingsCredit` vintage lots (`reinvest-…`): reinvested coupons and dividends, wrapper
  deposits. These reach the study plan's ladder every year.
- Pool-flow BOND purchases (`AccountService._creditTarget` with `allocation: BOND`, design 97
  §12.4a), which also open a vintage lot, or a plain fund lot when the account has no bonds.

It changes from "one tail rung" to the §3.2 slot grid, equal split and small-amount floor (an
annual coupon vintage usually falls under the floor and goes to the tail slot), carrying the absorbed lots'
basis, per-country bases, latest dates and indexation level (`ladderCarryover`, split by
`_carrySplitter`), so there is one rule for how new money joins a ladder. Like §3.2 it opens a lot
per pass (`ladder-<key>-absorb-<asOfMs>-<m>`) rather than merging into an existing same-year lot.
Today's merge keeps the earlier lot's `purchaseDate`, so a 1 July absorption merged into a 1 January
one is credited six months it was not held; a lot per pass removes that.

A fund lot at load is NOT a fallback case: the first ladder pass re-materializes every bond lot
(`materializeLadder`), which already spreads them equally.

### 3.4 Sell side (not proposed)

Ladder-aware drawdown is already built: `drawdownLotStrategy: 'LADDER'` (design 66 §10.9, cash →
nearest maturity → funds and growth), gated by selecting it, not by the intent. Two sell-side
pieces remain and are out of scope here: the §10.9 point-3 "shorten from the tail" refinement, and
the rebalance BOND SELL leg on a laddered account, which takes rungs by the rebalance lot strategy
(`consumeHoldings`) and can sell mid-ladder rungs. Both could read the intent later.

## 4. What it changes

- Plans with `BOND_LADDER` and a target allocation that buys bonds: bond lots, coupons and
  maturities move. Plans with `BOND_LADDER` whose accounts receive reinvested coupons or pool-flow
  BOND purchases move through §3.3 even with no rebalance.
- State gains `bondLadderIntent` on every laddered account, so any whole-state fixture with a ladder
  moves. Fixtures that reference a ladder today: `golden-tips-ladder-conservation.json`,
  `golden-bond-par-conservation.json`. Regenerate and read them (diff against git).
- Plans without a ladder: unchanged (no descriptor, no routing). The default golden is unchanged.

## 5. Open questions

1. **Equal split or market-value weights?** Equal per slot keeps the ladder's shape (the point of a
   ladder). Weighting by the standing rungs' value would preserve any existing lopsidedness.
   Proposed: equal.
2. **Lot count. DECIDED 16 Oct 2026: a floor; below it the amount goes to the longest slot only.**
   A rebalance runs on both advances in a two-country plan, so it can open 2N lots a year, and they
   merge only after they roll onto the same grid date (seasoned lots, design 93 §5.4). Worst case
   is about N × (buys per ladder cycle) live lots, e.g. 50 for N = 5 with two buys a year. §3.3's
   inputs are mostly small (annual coupon vintages), which would make N tiny lots per pass. The
   floor is `bondLadderMinSlotBuy` (§3.2), default \$1,000 per slot; report lot counts on the study
   plan when it is built and revisit the default if they are large.
3. **Partial-period slot.** The shortest slot may mature within months. Buy it (it rolls at
   maturity into the tail), or skip it and split over N − 1? Proposed: buy it; that is what the
   ladder's own roll does.
4. **Other BOND buy paths into a laddered account. DECIDED 16 Oct 2026: only the rebalance is
   routed; the others wait for the next pass.** Checked 16 Oct 2026:
   - `RebalanceToTargetApplyReducer` — routed (§3.2).
   - `distributeHoldingsCredit` vintages and `_creditTarget` pool purchases — absorbed (§3.3), so
     they still wait for the next advance. Routing `_creditTarget(BOND)` directly is possible (it
     has the account and therefore the intent) but it needs state for the yield, so it stays on the
     fallback.
   - `OpportunisticRebalanceApplyReducer` (design 29) adds a BOND buy pro rata into the existing
     lots with `addValue`, so it grows rungs in place: no fund lot and the shape is roughly kept,
     but the bought money takes each rung's purchase date. That is the design 62 §9 defect on a
     path design 62 never reached, not a ladder question; flagged, not fixed here.

## 6. Test plan

- A 1 January rebalance BOND buy on a 5-rung TIPS ladder: the same day, five new inflation-linked
  lots, one per grid date, each a fifth, at that tenor's real yield; no nominal fund lot exists.
- The same buy after drawdown has consumed every rung: five lots on the grid dates, not on dates
  measured from the buy.
- A buy in a two-country plan on 1 July: lots on the ladder's grid dates, not 30 June dates.
- Two buys a year apart: separate lots, each keeping its own purchase date; after both roll onto
  the same grid date and season, `_compactLadderLots` merges them.
- `absorbAsTailRung` on a `reinvest-` lot: equal split across slots, basis, per-country bases,
  dates and level carried and conserved to the cent.
- An MPC change of N re-materializes and re-anchors; the next buy uses the new N.
- No ladder: the rebalance BOND buy is byte-identical to today.
- Roll: a bought lot rolls into the tail at maturity like any other rung.

## 7. Review notes (16 Oct 2026)

Corrections to the 15 Oct draft after reading the code and probing the study plan:

- §1.2: the wait is six months in a two-country plan, not a year; both reducers run on both
  advances.
- §1.3: added the off-grid tail date and the LADDER drawdown interaction.
- §3.1: the descriptor needs `anchorMs`, `rateKey`, the pinned coupon and the design 125 spec, and
  must be stamped on a pass with no bonds; `_marketYield` is an instance method, so the yield rule
  has to be shared.
- §3.2: slots come from the intent's grid, not "the standing rungs' maturity years" (there may be
  none); a lot keyed on the maturity year would have blended purchase dates.
- §3.3: the fallback's inputs are reinvest vintages and pool purchases, not "a fund lot at load"
  (the first pass rebuilds those); the existing same-year absorb merge back-dates a later absorption.
- §3.4: ladder-aware drawdown (`'LADDER'`, upper case) was built 17 Jul 2026; it is not future work.
- §4: named the fixtures that move and why (the stamp alone moves state).
- §5 Q4: answered with the paths that exist.

Decisions (author, 16 Oct 2026): Q2, a per-slot floor below which the amount goes to the longest
slot only; Q4, pool purchases and reinvest vintages wait for the next ladder pass.

## 8. Build notes (16 Oct 2026)

- Code: `bond-ladder-reducer.js` (`_intent`, `ladderMarketYield`, `ladderSlotYield`,
  `ladderSlots`, `buyIntoLadder`, `absorbIntoLadder`, which replaces `absorbAsTailRung`);
  `rebalance-to-target-apply-reducer.js` (the BOND buy leg); param `bondLadderMinSlotBuy`
  (default 1,000) on `BOND_LADDER`.
- **The roll now resets a ladder rung's `duration`** to the roll tenor
  (`bond-maturity-reducer.js`, rungs with `rollTermYears` only). It carried the issue duration
  for life, so a 1-year rung rolled into an N-year bond marked rates as a 1-year bond
  (`min(duration, ttm)`), and two rolled lots that are the same bond could never compact. A lone
  bond keeps its authored duration.
- Tests: `tests/unit/ladder-aware-bond-buys.test.mjs` (LB-1…LB-10); the absorb tests in
  `bond-ladder-reducer.test.mjs` rewritten for the split.
- Goldens: only the two ladder fixtures moved. Neither makes a rebalance BOND buy into a laddered
  account, so they move through §3.3 (coupon vintages above the floor now split), the intent
  stamp and the duration reset: cumulative tax −\$302 (bond-par) and +\$1,686 (TIPS). Live bond
  lots in the bond-par k401 go 12 → 31 by the end: same-slot lots from different passes differ
  in coupon and duration until they roll and season (§5 Q2's bound). The routing is exercised
  end to end on the study plan instead: the 1 January buy becomes N TIPS lots on the ladder's
  grid the same day, and seasoned lots on one slot compact into the rung.
- Not done: fully consumed rungs stay in `holdings` at zero value (compaction skips them). That
  predates this design, but the split makes more of them (bond-par IRA: 7 → 16).
