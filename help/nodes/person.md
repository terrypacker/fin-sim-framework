---
id: person
kind: node
title: Person
node: person
panels: [config-list, config-graph, paycheque]
design: [116-employment-spells.md, 34-us-state-income-tax.md, 95-wage-logic-and-payroll-contributions.md, 83-us-au-tax-treaty-intricacies.md]
stamps:
  panel:config-list: 786f94
  panel:config-graph: bbebb1
  panel:paycheque: f8d503
  node:person: 357ff1
---

A member of the household: who they are, what they earn, when they stop, and what
their pay does on the way to the bank. Wages, payroll contributions, Social Security,
mortality and the marginal rate on a capital gain all hang off a person. See
[Cross-Border Residency](../concepts/cross-border-residency.md) and
[Contributions and Payroll](../concepts/contributions-and-payroll.md).

**One job or several.** The wage, currency, work country, self-employed and retire-date
fields describe one job for the whole plan. For a raise, a gap or a job abroad, add rows
to the **Jobs** table ([Job](job.md)); those fields then lock.

The **payroll elections** below are shown for both countries regardless of residency,
because an election is gated on the currency the wage is paid in.

**Blank is not zero in the elections.** An empty box inherits the household default,
shown greyed behind it; a typed 0 elects nothing.

**Social Security is claimed once**; the first month's factor holds for life. A
spouse with under half the other's benefit gets the difference from the later claim; a
widow(er), the larger of their own and the survivor benefit ([details](../concepts/social-security.md)).

Fields with a link badge are also scenario parameters: edits write the parameter, which
a sweep or the optimizer can move, and its description lives there.

## Fields

- `name` — What this person is called throughout the app. Free text, but it is also how you will pick them out in every owner dropdown and every per-person chart.
- `birthDate` — Date of birth, and one of the most load-bearing numbers in a plan. Age gates almost every retirement rule modelled here — early-withdrawal penalties, required distributions, Social Security claiming, the Australian preservation age and the over-55 concessions — so an approximate birth date quietly moves several cliffs at once.
- `citizen` — Citizenship, and more than one may be selected. It is not residency: a US citizen is taxed by the US on worldwide income wherever they live, which is the whole reason a cross-border plan is hard. Residency is a scenario parameter that changes over the run; this does not.
- `residencyState` — US state of residency, for state income tax. Blank means no state of residency — a military base, or a person living outside the US — and so no state tax. The household's active state is the primary person's.
- `lifeExpectancy` — The age this person is assumed to die at, in the deterministic run. Under stochastic mortality it is the anchor a draw is taken around rather than a fixed date. It ends wages and Social Security, triggers any bequest, and sets the horizon the plan is judged over.
- `socialSecurityMonthly` — The primary insurance amount: the monthly benefit at full retirement age, in today's money, as an SSA statement quotes it. What is actually paid is scaled from it by the claim age below. Authored rather than derived from an earnings record, so it is an input to check rather than an output to trust.
- `ssCurrency` — The currency the Social Security benefit is paid in. It follows the paying country, not where the person lives, so an AU-resident US retiree collects USD and takes the exchange-rate risk that comes with it.
- `selfEmployed` — Treat this person's wage as self-employment income — a sole trader, or 1099 work. It incurs US self-employment tax, which is both halves of FICA rather than the employee half, and that is a materially different number from the same wage as an employee.
- `wageCurrency` — The currency this person is paid in. It gates the payroll elections: a 401(k) deferral out of an AUD wage would debit dollars this person was never paid, so the elections that apply are chosen by this field rather than by residency.
- `workCountry` — Where the work is physically performed, which decides whether the income is US- or AU-sourced for tax purposes — not the wage currency, and not residency. Leave it as "same as residency" unless modelling a cross-border commuter or someone remote-working for a foreign employer.
- `wageSplits` — Where this person's net pay lands. Fixed amounts are taken first, in list order, then percentages of the original net pay; whatever remains goes to their transaction account. Cash routing only — it has no tax consequence, and it cannot be used to make a contribution.
- `k401MatchTiers` — The employer match as tiers consumed in order, e.g. 100% of the first 3% then 50% of the next 2% — the safe-harbor basic match. Someone deferring less than the full band is matched only on what they actually deferred. Set, this supersedes the flat match rate for this person.
- `superSalarySacrificePct` — Pre-tax share of pay sacrificed into superannuation. It never reaches the member's cash, reduces PAYG withholding but not the Super Guarantee, and is taxed at 15% inside the fund. The concessional cap applies to it together with the SG.
- `superPersonalDeductibleContribution` — An annual after-tax contribution claimed as a deduction on the return. Paid from cash, taxed 15% in the fund, and the deduction is capped at assessable income less other deductions — the excess is lost rather than carried forward, which makes an oversized election quietly wasteful.
- `superNonConcessionalContribution` — An annual after-tax contribution with no deduction and no 15% fund tax. It buys a tax-sheltered location rather than a deduction, and is bound by the non-concessional cap and its bring-forward rule.
