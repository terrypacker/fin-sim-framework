---
id: funding-and-instalments
kind: concept
title: Funding and Instalments
panels: [paycheque, pools]
params: [paycheckEnabled, paycheckCadence, taxInstalmentsEnabled]
design: [107-retirement-paycheck-and-tax-instalments.md]
stamps:
  param:paycheckEnabled: e5c315
  param:paycheckCadence: b40249
  param:taxInstalmentsEnabled: 28dcb9
  panel:paycheque: f8d503
  panel:pools: b2d1aa
---

*When* money is raised, as opposed to where it is raised from. Two switches, both off
by default, both changing the timing of sales rather than their total.

**The paycheck.** By default the plan is funded just in time: a debit that would
breach the transaction account's minimum triggers a liquidation, so selling happens
whenever spending happens. Turning the paycheck on replaces that with a scheduled
transfer into the spending float — a decision made on a cadence instead of a reflex
fired by a low balance.

The cadence is the interesting part, because it decides how many funding *decisions*
the year contains. An annual transfer makes the year's funding one choice, which is
the only arrangement in which "take this year from the reserve rather than selling
growth" is a decision there is anywhere to make. More frequent cadences spread the
market timing and remove that opportunity.

**Tax instalments.** By default a year's liability lands as a single debit on the
settle date, funded by a draw on that same date — so one day's market price decides
what has to be sold to pay a whole year of tax. Paying across the year on the
statutory dates spreads that exposure.

Neither changes what is owed or what is spent. They change which prices the plan
transacts at, which is a real effect and one that only shows up across many paths —
[Monte Carlo](../panels/mc-config.md) rather than a single run.

See [Paycheque](../panels/paycheque.md) for the resulting cash flow month by month.
