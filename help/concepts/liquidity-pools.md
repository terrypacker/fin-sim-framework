---
id: liquidity-pools
kind: concept
title: Liquidity Pools
panels: [pools]
params: [liquidityGraph, liquidityGraphEnabled, poolFlowsEnabled, poolCashYears, poolBondYears, poolYearsMaxFraction, cashBucketDrawdownMinSeverity]
design: [97-liquidity-pools-and-drawdown-sequence.md]
stamps:
  param:liquidityGraph: 346c4e
  param:liquidityGraphEnabled: 2df3a6
  param:poolFlowsEnabled: 8b8123
  param:poolCashYears: 92629a
  param:poolBondYears: 13afb2
  param:poolYearsMaxFraction: 46cd41
  param:cashBucketDrawdownMinSeverity: b361c8
  panel:pools: 78458e
---

A bucket strategy, modelled explicitly: named pools that hold claims on real
accounts, sized against a target, connected by flows that refill one from another.

It answers a problem [Drawdown Order](drawdown-order.md) alone cannot. An order says
what to sell *when you need money*. A pool says what should be *sitting there before*
you need it — a couple of years of spending in cash so a downturn is not met by
selling equities at the bottom.

A pool sized in **years of spending** rather than as a percentage is the point. Years
resolve against the live, inflated spend line every period, so the buffer keeps its
meaning as the plan ages; a percentage of a portfolio that has halved buys half as
much time exactly when time matters most.

The same property cuts the other way late in a plan. The spend line keeps rising while the
portfolio is drawn down, so a reserve of many years can come to ask for more than the whole
portfolio holds; its class then crowds every other one out of the mix, and the plan ends up
almost all bonds without anyone choosing that. A target can carry a ceiling for this — "this
many years, but never more than this share of the portfolio" — set as **Max of book** in the
bucket table; the older pool years outside the graph take one for both together.

Three switches, which are not the same switch:

- The graph's own off switch, which stops everything.
- A topology-only mode that keeps the pools, targets and draw order live while the
  refill flows stay silent. That is the control arm a study of the refill rule needs —
  deleting the flows instead would also change the draw order, confounding the result.
- Dropping the whole strategy from the behavioural set, which stops only the refills:
  the draw order and the rebalancer read the graph directly and never consult that
  list.

The interesting event is usually a refill that did **not** happen, and nothing else in
the run records a non-event. [Liquidity Pools](../panels/pools.md) exists for that:
it marks gated, vetoed and capped flows rather than leaving a blocked refill looking
identical to one never configured.


How much to hold, and how patient a refill rule should be, are the two questions this
feature raises and cannot answer by itself. Both can be searched rather than guessed —
see [Searching Pool Levers](searching-pool-levers.md).
