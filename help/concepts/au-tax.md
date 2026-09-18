---
id: au-tax
kind: concept
title: AU Tax and PAYG Instalments
panels: [journal-report, paycheque]
params: [auBracketIndexSpread, auCpiRate, auGdpUplift, auNotionalTaxRate, auDeferredBasPayer, taxInstalmentsEnabled]
design: [107-retirement-paycheck-and-tax-instalments.md]
stamps:
  param:auBracketIndexSpread: a571d5
  param:auCpiRate: f8fbcf
  param:auGdpUplift: f4aa90
  param:auNotionalTaxRate: 7f3e30
  param:auDeferredBasPayer: 7e44a4
  param:taxInstalmentsEnabled: 28dcb9
  panel:journal-report: e88448
  panel:paycheque: f8d503
---

The Australian side of a cross-border plan's tax, and the machinery of paying it
during the year rather than at the end.

**Bracket indexation is a choice, not a fact.** Australian brackets are not
automatically indexed — they move when Parliament moves them. The spread here is
therefore an assumption about political behaviour over decades, and setting it to
zero is the assumption that brackets never change, which produces severe real bracket
creep. Both extremes are defensible; neither is neutral.

The capital-gains indexation rate follows AU inflation unless set, since it is a tax
rule tracking a published figure rather than an independent forecast.

**PAYG instalments** are the pay-as-you-go machinery. The Commissioner works out an
instalment from the prior year's income with an uplift applied, at a notional rate,
and the taxpayer pays across the year. Two details change the cash flow rather than
the total: the uplift itself, and whether the deferred due dates apply — a deferred
BAS payer gets later dates each quarter.

The reason any of this matters is timing, and it is the same argument as in
[Funding and Instalments](funding-and-instalments.md): paying across the year means
several market prices fund the bill instead of one. What is owed is unchanged; what
had to be sold to pay it is not.

Instalment calculations run on ordinary income and deliberately exclude capital
gains, which is why a big disposal does not automatically change next year's
instalments.
