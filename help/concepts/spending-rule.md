---
id: spending-rule
kind: concept
title: The Spending Rule
panels: [spending]
params: [monthlyExpenses, monthlyExpensesCurrency, inflationAdjust, discretionarySharePct, spendingStrategy, regimeAwareCutPct, guardrailCutThreshold, guardrailRaiseThreshold, guardrailCutPct, guardrailRaisePct, guardrailBaseCurrency, expenseEvents, spendingAgeBands, ageBandSpendingSlice, ageBandDeclineRate, spendingExpenseBands, crraGamma]
design: [89-spending-over-time-reporting.md]
stamps:
  param:monthlyExpenses: 82af26
  param:monthlyExpensesCurrency: 04de33
  param:inflationAdjust: 652e8c
  param:discretionarySharePct: 157c12
  param:spendingStrategy: 8fe45f
  param:regimeAwareCutPct: 71385d
  param:guardrailCutThreshold: 38a17f
  param:guardrailRaiseThreshold: 8afeb1
  param:guardrailCutPct: 661c8b
  param:guardrailRaisePct: 206297
  param:guardrailBaseCurrency: d52a28
  param:expenseEvents: 116819
  param:spendingAgeBands: c02dd1
  param:ageBandSpendingSlice: f610c6
  param:ageBandDeclineRate: 8017cb
  param:spendingExpenseBands: 52e666
  param:crraGamma: af8fb9
  panel:spending: f9f5c7
---

How much the household intends to spend each month, and what happens to that
intention when the plan comes under pressure.

The base is a monthly figure in a chosen currency, optionally growing with prices.
Everything else modifies it, and the modifiers **compose** — strategies are a set,
not a choice, so a plan can hold a fixed base, bend it by age, and still cut it
under stress.

The important split is **essential versus discretionary**. One fraction decides how
much of the monthly figure is treated as optional, and that fraction is what every
adaptive rule actually operates on. Set it to zero and the adaptive strategies have
nothing to work with; the plan will fail rather than flex.

Three kinds of adaptation, in rising order of how much they assume:

- **Age bands** — spending is not flat across retirement. A multiplier per band with
  a drift inside it models the go-go/slow-go shape, and you choose whether it bends
  only the optional part or all of it. The absolute variant states a monthly amount
  per band instead of a relative one, which is the form the optimizer searches.
- **Regime-aware** — a standing cut to the optional part while a stressed economic
  regime is running.
- **Guardrails** — the Guyton-Klinger rule: when the withdrawal rate drifts far
  enough above or below where it started, spending steps down or up.

A caution the reports exist for. Under any adaptive rule a plan almost always
"survives", because the rule is allowed to shrink what it promised. Read what was
actually paid out, not whether it ran out of money — that gap is the question
[Spending](../panels/spending.md) answers.

`crraGamma` prices that gap: it is how strongly smooth real consumption is preferred,
and is what the optimizer scores against rather than a lever on the run.
