---
id: cross-border-residency
kind: concept
title: Cross-Border Residency
panels: [journal-report, scenario-compare]
params: [moveYear, startingResidency, usFeieElected, intlTransferFeeUsd]
design: [36-au-move-tax-effect-analysis.md, 52-true-foreign-tax-credit.md]
stamps:
  param:moveYear: f6feaa
  param:startingResidency: 598a5f
  param:usFeieElected: 00dd02
  param:intlTransferFeeUsd: e53b1e
  panel:journal-report: e88448
  panel:scenario-compare: b960fb
---

Where the household is tax-resident, and when that changes.

This is the single most consequential setting in a cross-border plan, because
residency decides which country taxes what — and the two regimes disagree about
nearly everything that matters. Capital gains discounts, retirement wrapper
treatment, what counts as income at all: moving the year of the move shifts the whole
plan onto different rules from that date.

The move is a year, on a fixed mid-year date. Before it the starting residency
applies; after it the other. That sounds simple and the consequences are not: assets
held across the boundary may be deemed disposed or may carry over, a wrapper that was
tax-free may stop being so, and a credit that relieved double taxation on one side
may have no counterpart on the other.

The foreign earned income exclusion is a US election on foreign-source earned income.
It is off by default and worth treating carefully — it is not free to turn on and off,
because electing it binds you for several years.

Transfer costs are the small, real friction of running a two-currency household: a
fixed fee per international wire. Small per event, and a plan that moves money
frequently pays it often.

Rates and currency are a separate concern — see [FX](fx.md). Residency decides the
rules; FX decides what a number in one currency is worth in the other.

Compare a moved and an unmoved plan in [Scenario Compare](../panels/scenario-compare.md).
