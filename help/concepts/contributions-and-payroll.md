---
id: contributions-and-payroll
kind: concept
title: Contributions and Payroll
panels: [paycheque]
params: [k401DeferralPct, k401EmployerMatchPct, k401MatchTiers, k401NonElectivePct, k401AnnualCap, iraAnnualContribution, rothAnnualContribution, superGuaranteePct, superGuaranteeAnnualCap, superSalarySacrificePct, superPersonalDeductibleContribution, superNonConcessionalContribution, withholdingMethod]
design: [95-wage-logic-and-payroll-contributions.md]
stamps:
  param:k401DeferralPct: 49b331
  param:k401EmployerMatchPct: 0c0146
  param:k401MatchTiers: 0f24a1
  param:k401NonElectivePct: dfc69f
  param:k401AnnualCap: 807aca
  param:iraAnnualContribution: 975554
  param:rothAnnualContribution: e5aea6
  param:superGuaranteePct: d3fd95
  param:superGuaranteeAnnualCap: 8f912e
  param:superSalarySacrificePct: 2f161d
  param:superPersonalDeductibleContribution: d0d910
  param:superNonConcessionalContribution: 7ef963
  param:withholdingMethod: ab93c2
  panel:paycheque: f8d503
---

Money going *into* retirement wrappers while someone is still earning, on both sides
of the Pacific.

Every one of these is a **household default that a person can override**. Set the
deferral once and everyone uses it; give one person their own election and theirs
wins. An explicit zero on a person opts them out rather than falling back to the
default, which is the distinction that makes "my spouse does not contribute"
expressible at all.

The tax treatment is what separates otherwise similar-looking levers, and it is the
thing to get right:

- **US.** Employee deferral is pre-tax and the employer match sits on top of it.
  Caps apply to the deferral and the match separately.
- **AU.** The Superannuation Guarantee is employer-funded and rides above the quoted
  salary. Salary sacrifice is diverted *before* pay, so it reduces taxable income.
  A personal deductible contribution comes from after-tax cash and is claimed back on
  the return. A non-concessional contribution comes from after-tax cash and stays
  after-tax, arriving in the fund in full.

Those four Australian routes move money to the same place by four different tax
paths, and swapping one for another changes the tax bill without changing the
balance.

Withholding decides how much of a US paycheque the household actually sees during the
year, which matters for cash flow and for whether a refund or a bill lands at settle.

Caps bite silently. [Paycheque](../panels/paycheque.md) shows the clamps as a column
for that reason.
