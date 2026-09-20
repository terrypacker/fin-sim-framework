---
id: person
kind: node
title: Person
node: person
panels: [config-list, config-graph, paycheque]
design: [34-us-state-income-tax.md, 95-wage-logic-and-payroll-contributions.md, 83-us-au-tax-treaty-intricacies.md]
stamps:
  panel:config-list: 786f94
  panel:config-graph: bbebb1
  panel:paycheque: f8d503
  node:person: ad138c
---

A member of the household: who they are, what they earn, when they stop, and what
their pay does on the way to the bank. Almost everything in a plan hangs off a person
— wages, payroll contributions, Social Security, mortality, the marginal rate a
capital gain is taxed at, and which country taxes it at all. See
[Cross-Border Residency](../concepts/cross-border-residency.md) and
[Contributions and Payroll](../concepts/contributions-and-payroll.md).

The form is in two halves. The top is identity and income. Below it, the **payroll
elections** — one block per country, shown for both regardless of where this person
lives, because an election is gated on the currency the wage is paid in rather than
on residency, and a cross-border household needs both editable in one place.

**Blank is not zero in the elections.** An empty box inherits the household default,
shown greyed behind it; a typed 0 elects nothing. That distinction is the difference
between "use the plan's rate" and "this person contributes nothing", and the two
produce very different runs.

Several fields here are also scenario parameters — they carry a link badge, edits
write the parameter rather than the record, and their full description lives with the
parameter. That is deliberate: a parameter is what a sweep or the optimizer can move,
and the record would otherwise be overwritten by the cascade on the next rebuild.

## Fields

- `name` — What this person is called throughout the app. Free text, but it is also how you will pick them out in every owner dropdown and every per-person chart.
- `birthDate` — Date of birth, and one of the most load-bearing numbers in a plan. Age gates almost every retirement rule modelled here — early-withdrawal penalties, required distributions, Social Security claiming, the Australian preservation age and the over-55 concessions — so an approximate birth date quietly moves several cliffs at once.
- `citizen` — Citizenship, and more than one may be selected. It is not residency: a US citizen is taxed by the US on worldwide income wherever they live, which is the whole reason a cross-border plan is hard. Residency is a scenario parameter that changes over the run; this does not.
- `residencyState` — US state of residency, for state income tax. Blank means no state of residency — a military base, or a person living outside the US — and so no state tax. The household's active state is the primary person's.
- `lifeExpectancy` — The age this person is assumed to die at, in the deterministic run. Under stochastic mortality it is the anchor a draw is taken around rather than a fixed date. It ends wages and Social Security, triggers any bequest, and sets the horizon the plan is judged over.
- `socialSecurityMonthly` — The monthly benefit this person receives once claiming begins, in today's money. Modelled as an authored amount rather than derived from an earnings record, so it is an input to check rather than an output to trust; claiming age and the spousal rules live in the scenario parameters.
- `ssCurrency` — The currency the Social Security benefit is paid in. It follows the paying country, not where the person lives, so an AU-resident US retiree collects USD and takes the exchange-rate risk that comes with it.
- `selfEmployed` — Treat this person's wage as self-employment income — a sole trader, or 1099 work. It incurs US self-employment tax, which is both halves of FICA rather than the employee half, and that is a materially different number from the same wage as an employee.
- `wageCurrency` — The currency this person is paid in. It gates the payroll elections: a 401(k) deferral out of an AUD wage would debit dollars this person was never paid, so the elections that apply are chosen by this field rather than by residency.
- `workCountry` — Where the work is physically performed, which decides whether the income is US- or AU-sourced for tax purposes — not the wage currency, and not residency. Leave it as "same as residency" unless modelling a cross-border commuter or someone remote-working for a foreign employer.
- `wageSplits` — Where this person's net pay lands. Fixed amounts are taken first, in list order, then percentages of the original net pay; whatever remains goes to their transaction account. Cash routing only — it has no tax consequence, and it cannot be used to make a contribution.
- `k401MatchTiers` — The employer match as tiers consumed in order, e.g. 100% of the first 3% then 50% of the next 2% — the safe-harbor basic match. Someone deferring less than the full band is matched only on what they actually deferred. Set, this supersedes the flat match rate for this person.
- `superSalarySacrificePct` — Pre-tax share of pay sacrificed into superannuation. It never reaches the member's cash, reduces PAYG withholding but not the Super Guarantee, and is taxed at 15% inside the fund. The concessional cap applies to it together with the SG.
- `superPersonalDeductibleContribution` — An annual after-tax contribution claimed as a deduction on the return. Paid from cash, taxed 15% in the fund, and the deduction is capped at assessable income less other deductions — the excess is lost rather than carried forward, which makes an oversized election quietly wasteful.
- `superNonConcessionalContribution` — An annual after-tax contribution with no deduction and no 15% fund tax. It buys a tax-sheltered location rather than a deduction, and is bound by the non-concessional cap and its bring-forward rule.
