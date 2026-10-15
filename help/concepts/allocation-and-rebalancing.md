---
id: allocation-and-rebalancing
kind: concept
title: Allocation and Rebalancing
panels: [allocation, holdings]
params: [allocationStrategy, allocationSchedule, allocationGlidepath, allocationRegimeTargets, allocationLocation, allocationLocationPolicy, allocWeight::EQUITY, allocWeight::BOND, allocWeight::CASH, rebalanceTargetAllocation, rebalanceDriftBand, rebalanceDriftBandTaxable, rebalanceDriftBandSheltered, rebalanceLotStrategy, rebalanceIntlShareUs, rebalanceIntlShareAu, allocationClassRestrictions]
design: [61-holding-allocation-lever.md, 82-allocation-over-time-reporting.md, 115-asset-class-restrictions.md]
stamps:
  param:allocationStrategy: 277063
  param:allocationSchedule: 0cbc83
  param:allocationGlidepath: e72d2f
  param:allocationRegimeTargets: b783d9
  param:allocationLocation: c92532
  param:allocationLocationPolicy: e9f8cf
  param:allocWeight::EQUITY: b9be8c
  param:allocWeight::BOND: 310f34
  param:allocWeight::CASH: ef39a3
  param:rebalanceTargetAllocation: 856700
  param:rebalanceDriftBand: f8d8e6
  param:rebalanceDriftBandTaxable: 102a66
  param:rebalanceDriftBandSheltered: 960cb2
  param:rebalanceLotStrategy: cf4f95
  param:rebalanceIntlShareUs: 7edf07
  param:rebalanceIntlShareAu: 017138
  param:allocationClassRestrictions: e61dbe
  panel:allocation: 762dd9
  panel:holdings: 962055
---

Three separate questions that the phrase "asset allocation" runs together.

**What mix do you want?** Either a fixed target you state, or a mix synthesized from
continuous weights the optimizer can search. The second form exists so the mix can be
an *answer* rather than an input.

**How does it change over time?** It can hold still, glide between anchors by age, or
switch by economic regime. Gliding is the common case: a static mix means the portfolio
is as aggressive at eighty as at fifty, which nobody would choose deliberately.

**Where does each class live?** A whole-portfolio mix says nothing about which
account holds the bonds, and that placement is worth real money — putting the
tax-inefficient class in the sheltered account and letting equity compound where
gains are never taxed. The placement preference is soft: it spills when an account
is full rather than refusing. Inside equity, the home/international split can carry its
own target; without one it is whatever the holdings happen to be.

Some placements are things you cannot do. Gold in Australian super is the motivating
case: for a US citizen it usually means a self-managed fund, which the US is likely to
treat as a foreign grantor trust. Class restrictions never bend, so when every permitted
account is full the model holds less of that class, and the shortfall shows in the
realised mix. A restriction can name one account as well as a kind (a TreasuryDirect
account can never own a share fund). Nothing is restricted unless you say so; a plan
where a US citizen owns super gets a warning until you decide.

**Rebalancing** is separate again, and the band is the lever. The taxable band
defaults *wider* than the sheltered one, because a taxable rebalance realises gains,
and a wide band gives up little tracking accuracy for a large saving in tax.

*Which* lots go matters as much: the same sale from a decade-old fund or from last
year's purchase can differ tenfold in realised gain, for the same final mix.

Rebalancing also interacts with spending: a drawdown can be biased toward selling
whatever is overweight, so one sale does both jobs. See
[Drawdown Order](drawdown-order.md).

Watch the realised mix in [Allocation](../panels/allocation.md) — the shape you get
is not always the shape you asked for.
