---
id: allocation-and-rebalancing
kind: concept
title: Allocation and Rebalancing
panels: [allocation, holdings]
params: [allocationStrategy, allocationSchedule, allocationGlidepath, allocationRegimeTargets, allocationLocation, allocationLocationPolicy, allocWeight::EQUITY, allocWeight::BOND, allocWeight::CASH, rebalanceTargetAllocation, rebalanceDriftBand, rebalanceDriftBandTaxable, rebalanceDriftBandSheltered, assetLocationPolicy]
design: [61-holding-allocation-lever.md, 82-allocation-over-time-reporting.md]
stamps:
  param:allocationStrategy: 277063
  param:allocationSchedule: 0cbc83
  param:allocationGlidepath: e72d2f
  param:allocationRegimeTargets: b783d9
  param:allocationLocation: 6b72ba
  param:allocationLocationPolicy: 56c8c6
  param:allocWeight::EQUITY: b9be8c
  param:allocWeight::BOND: 310f34
  param:allocWeight::CASH: ef39a3
  param:rebalanceTargetAllocation: 856700
  param:rebalanceDriftBand: f8d8e6
  param:rebalanceDriftBandTaxable: 102a66
  param:rebalanceDriftBandSheltered: 960cb2
  param:assetLocationPolicy: f474e9
  panel:allocation: fc1993
  panel:holdings: 359688
---

Three separate questions that the phrase "asset allocation" runs together.

**What mix do you want?** Either a fixed target you state, or a mix synthesized from
continuous weights the optimizer can search. The second form exists so the mix can be
an *answer* rather than an input.

**How does it change over time?** It can hold still, glide between anchors by age, or
switch by economic regime. Gliding is the common case and the one most plans get
wrong by omission: a static mix means the portfolio is as aggressive at eighty as at
fifty, which nobody would choose deliberately.

**Where does each class live?** A whole-portfolio mix says nothing about which
account holds the bonds, and that placement is worth real money — putting the
tax-inefficient class in the sheltered account and letting equity compound where
gains are never taxed. The placement preference is soft: it spills when an account
is full rather than refusing, because an unfillable preference that silently fails
is worse than one that does its best.

**Rebalancing** is separate again, and the band is the lever. The taxable band
deliberately defaults *wider* than the sheltered one, because a rebalance in a
taxable account realises gains — and a wide band gives up very little tracking
accuracy for a large reduction in tax. Tight bands everywhere is a common and
expensive default.

Rebalancing also interacts with spending: a drawdown can be biased toward selling
whatever is overweight, so one sale does both jobs. See
[Drawdown Order](drawdown-order.md).

Watch the realised mix in [Allocation](../panels/allocation.md) — the shape you get
is not always the shape you asked for.
