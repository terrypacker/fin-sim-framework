---
id: early-withdrawal
kind: concept
title: Early Withdrawal
panels: [journal-report]
params: [earlyWithdrawalEnabled, earlyWithdrawalOwner, earlyWithdrawalMonth, earlyWithdrawalDay, earlyWithdrawalBeforeBrokerage, earlyWithdrawalStartYear, earlyWithdrawalEndYear, earlyWithdrawalSchedule]
stamps:
  param:earlyWithdrawalEnabled: d3cd3d
  param:earlyWithdrawalOwner: 6e3a9f
  param:earlyWithdrawalMonth: 422a2a
  param:earlyWithdrawalDay: fb12d3
  param:earlyWithdrawalBeforeBrokerage: cee05d
  param:earlyWithdrawalStartYear: 5049e5
  param:earlyWithdrawalEndYear: 89f1d7
  param:earlyWithdrawalSchedule: 0267f3
  panel:journal-report: e88448
---

Taking money out of a retirement wrapper before the age at which that is free, and
paying the penalty on purpose.

It sounds like something to avoid, and usually is. The case where it is not: a plan
with a large tax-deferred balance and a long early-retirement gap can find the
penalty cheaper than the alternative — which is realising a lifetime of capital gains
in a taxable account, or letting the deferred balance grow until required
distributions force it out at a higher rate.

One switch decides whether it is a genuine strategy or a last resort. By default
early withdrawal sits at the end of the [drawdown order](drawdown-order.md) and only
fires when nothing else is left. Moving it ahead of taxable brokerage makes it a
deliberate choice: pay a known penalty rather than realise unknown capital gains.
Which is better depends on the gain embedded in the brokerage account and cannot be
answered in general — it is a thing to run both ways.

The window is a start and end year, so the strategy can be confined to the gap it
exists for rather than left running.

As with conversions, there is a scheduled form: per-year gross amounts in real
base-year dollars, routed to a destination, which is what a solver produces. Use the
window for a policy; use the schedule when the amounts are an answer.
