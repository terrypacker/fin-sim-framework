---
id: drawdown-order
kind: concept
title: Drawdown Order
panels: [pools, holdings]
params: [drawdownStrategy, drawdownOwnerOrdering, crossBorderDrawdown, withinTierDraw, drawdownSleeveOrder, drawdownLotStrategy, drawdownSecurityOrder, drawdownSequence, drawdownRebalanceWeight, customDrawdownStrategies, drawdownWeight::fixed-income, drawdownWeight::us-stock, drawdownWeight::ira, drawdownWeight::k401, drawdownWeight::roth-ira, drawdownWeight::au-fixed-income, drawdownWeight::au-stock, drawdownWeight::super, sleeveWeight::CASH, sleeveWeight::BOND, sleeveWeight::EQUITY, sleeveWeight::GOLD]
design: [44-cross-border-drawdown-actions.md, 65-allocation-aware-drawdown.md, 97-liquidity-pools-and-drawdown-sequence.md]
stamps:
  param:drawdownStrategy: 651f60
  param:drawdownOwnerOrdering: 92083b
  param:crossBorderDrawdown: 708272
  param:withinTierDraw: 6c01f9
  param:drawdownSleeveOrder: f4b262
  param:drawdownLotStrategy: 1ccf64
  param:drawdownSecurityOrder: 3c8884
  param:drawdownSequence: 706f92
  param:drawdownRebalanceWeight: 9c7b34
  param:customDrawdownStrategies: dca19c
  param:drawdownWeight::fixed-income: eebfcb
  param:drawdownWeight::us-stock: 9545c6
  param:drawdownWeight::ira: c64c57
  param:drawdownWeight::k401: ff2f4b
  param:drawdownWeight::roth-ira: 3f2857
  param:drawdownWeight::au-fixed-income: 20b929
  param:drawdownWeight::au-stock: d26e1c
  param:drawdownWeight::super: 97517d
  param:sleeveWeight::CASH: ec4782
  param:sleeveWeight::BOND: 2b17c9
  param:sleeveWeight::EQUITY: 955442
  param:sleeveWeight::GOLD: 2093fd
  panel:pools: b2d1aa
  panel:holdings: 359688
---

When the plan needs cash and no account is nominated, something has to decide where
it comes from. That decision is not one choice but **five nested ones**, and the
levers are separate because the questions are.

1. **Which account** — the strategy, plus how people's accounts interleave and how
   the country you do not live in is treated. `drawdownWeight::*` supplies the order
   when the strategy is weighted rather than named.
2. **Which member of a tier** — when accounts sit at equal priority, whether one is
   drained before the next or they are split.
3. **Which asset class inside the account** — the sleeve order, with `sleeveWeight::*`
   supplying it in the weighted case. Selling bonds first and selling equities first
   are different plans with the same net worth on day one.
4. **Which lots** — oldest, highest-basis, or losses first. This is where realised
   gains are decided, so it is where tax is decided.
5. **Which instrument** — an order over securities, for "sell the employer stock
   before the index fund".

`drawdownSequence` replaces the first three with one literal list of pools — and
*replaces* is exact: a pool spend order compiles that list, after which layers 1–3
decide nothing and are byte-identical at every value. Say it in the graph instead. The
MPC cockpit refuses those levers on a pooled plan for the same reason. Reach for a
sequence when the policy you want falls *between* the layers above — a rule that interleaves
two accounts around a single sleeve boundary cannot be expressed by tuning an account
order and a sleeve order separately, because each of those is blind to the other.

This matters more than most levers. Ordering is a large hidden effect on ending
wealth because it silently decides what gets taxed, what keeps compounding, and what
shape the portfolio is left in — see [Allocation](../panels/allocation.md), which
exists to show that last consequence.

Watch it happen in [Liquidity Pools](../panels/pools.md).
