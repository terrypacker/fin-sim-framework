---
id: liquidity-pools
kind: concept
title: Liquidity Pools
panels: [pools]
params: [liquidityGraph, liquidityGraphEnabled, poolFlowsEnabled, poolCashYears, poolBondYears, cashBucketDrawdownMinSeverity]
design: [97-liquidity-pools-and-drawdown-sequence.md]
stamps:
  param:liquidityGraph: ee7bae
  param:liquidityGraphEnabled: 2df3a6
  param:poolFlowsEnabled: 8b8123
  param:poolCashYears: 92629a
  param:poolBondYears: 13afb2
  param:cashBucketDrawdownMinSeverity: b361c8
  panel:pools: b2d1aa
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
