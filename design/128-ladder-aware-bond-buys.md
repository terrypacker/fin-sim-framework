# 128 — Ladder-aware bond buys (design 66 §10.5, Phase B)

**Status:** PROPOSED (15 Oct 2026). The companion design 66 §10.5 asked for ("its own companion if
pursued"), raised now by a study flag: "a rebalance BOND buy is a nominal bond until the year-end
ladder pass, and then it becomes ONE rung".

**Related:** design 66 (bond fidelity: G8 ladders, §10.5 buy side, §10.9 ladder-aware drawdown),
design 61 (the allocation lever and its rebalance buys), design 62 §9 (a buy is its own lot), design
93 §5 (lots, par per unit), design 121 §8 (TIPS market real yield, `tipsCouponMode`).

## 1. The problem

A plan with a bond ladder (`BOND_LADDER`, `BondLadderReducer`) and a target allocation rebalances
into bonds. The two do not know about each other:

1. **The buy is a nominal fund lot.** `RebalanceToTargetApplyReducer` buys BOND in a lot of its
   own (`_newSleeve`, design 62 §9; `_addProRata` is CASH only), built from the market's default
   bond rather than from the ladder. On a TIPS ladder that money is a nominal bond, priced at the
   nominal yield, until the ladder reducer next runs.
2. **The ladder only looks at period advances.** `BondLadderReducer` reduces
   `US_PERIOD_ADVANCE` / `AU_PERIOD_ADVANCE` at `PRE_PROCESS + 5`. A rebalance applied after the
   advance waits for the next one. A study saw a large 1 January rebalance buy sit as a nominal
   5-year bond for the whole year.
3. **It becomes one rung.** `absorbAsTailRung` puts all of the new money into a single tail rung
   maturing `N × spacing` years out. A ladder that should spread a large purchase over N maturities
   instead gains one rung many times the size of the others. The roll then keeps that lump
   intact forever, so the ladder's liquidity profile (one rung maturing each year) is lost.

The effect on a study: a TIPS lever that should protect against inflation is absent for the
first year of the shock it was bought for, and afterwards most of the TIPS money matures in one
year in every ladder cycle.

## 2. What should happen

A bond buy into a laddered account is **a purchase of the ladder**: the same instrument (TIPS or
nominal, as the ladder is), at the market yield for each tenor, spread across the ladder's
maturities so every rung grows by the same share. That is what a household buying "more of my
ladder" does.

## 3. Proposal

### 3.1 A ladder-intent descriptor (design 66 §10.5)

`BondLadderReducer` already knows the ladder's shape (`targetRungs`, `spacingYears`, `roll`,
`inflationLinked`, `tipsCouponMode`, `taxExemption`). It stamps it on the account as
`bondLadderIntent` when it materializes, so other reducers can read the intent without
duplicating rung state. It is an intent, not a copy of the rungs.

### 3.2 Buy routing at the rebalance

`RebalanceToTargetApplyReducer`'s BOND buy leg, on an account with `bondLadderIntent`, calls a
shared `buyIntoLadder(account, amount, intent, state)` instead of `_newSleeve`:

- split `amount` equally over the ladder's N maturity slots (the standing rungs' maturity years;
  the tail slot when one is missing), the last slot taking the remainder;
- each share opens (or joins, within a vintage) a lot `ladder-<key>-buy-<maturityYear>` dated
  today, issued at par, with the ladder's instrument: inflation-linked when the ladder is, coupon
  at that slot's tenor (`tipsRealYield` or `_marketYield`), `tipsCouponMode`, roll term.

This removes both the wait (it happens in the same action) and the lump (the money is spread).

### 3.3 Keep the absorb as the fallback

`absorbAsTailRung` stays for money that still reaches the account as a fund lot (a path that does
not know about the ladder: a deposit, a pre-existing fund lot at load). It changes from "one tail
rung" to the same equal split as §3.2, so there is one rule for how new money joins a ladder.

### 3.4 Sell side (optional, design 66 §10.9)

Ladder-aware drawdown (`drawdownLotStrategy: 'ladder'`: matured cash, then nearest maturity,
then tail) is the twin of this and shares the descriptor. Not proposed here; noted so the
descriptor is shaped for it.

## 4. What it changes

- Plans with `BOND_LADDER` and a target allocation that buys bonds: bond lots, coupons and
  maturities move. Goldens with a ladder will move; regenerate and read them.
- Plans without a ladder: unchanged (no descriptor, no routing).
- A ladder whose rebalance never buys bonds: unchanged.

## 5. Open questions

1. **Equal split or market-value weights?** Equal per slot keeps the ladder's shape (the point of a
   ladder). Weighting by the standing rungs' value would preserve any existing lopsidedness.
   Proposed: equal.
2. **Very small buys.** A rebalance that buys a few hundred dollars would open N tiny lots. A
   minimum (below which the buy joins the tail slot only) keeps lot counts bounded. Proposed:
   the drift band already limits rebalance frequency; add a floor only if lot counts grow.
3. **Partial-year slot.** The shortest slot may mature within months. Buy it (it rolls at
   maturity into the tail), or skip it and split over N − 1? Proposed: buy it; that is what the
   ladder's own roll does.
4. **The study's first-year gap** also needs the rebalance to buy TIPS directly. §3.2 does that;
   confirm no other path (a pool flow purchase, `_creditTarget`) buys BOND into a laddered account,
   or route it too.

## 6. Test plan (to be written with the code)

- A 1 January rebalance BOND buy on a 5-rung TIPS ladder: the same day, five new inflation-linked
  lots, one per maturity, each a fifth, at that tenor's real yield; no nominal fund lot exists.
- `absorbAsTailRung` on a fund lot: equal split across slots, basis and vintage carried.
- No ladder: the rebalance BOND buy is byte-identical to today.
- Roll: a bought slot rolls into the tail at maturity like any other rung.
