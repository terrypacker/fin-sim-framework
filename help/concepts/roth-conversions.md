---
id: roth-conversions
kind: concept
title: Roth Conversions
panels: [paycheque, journal-report]
params: [rothConversionEnabled, rothConversionStartYear, rothConversionEndYear, rothConversionMaxBracket, rothConversionOwner, rothConversionMonth, rothConversionDay, rothConversionSchedule, k401ToIraConversionEnabled, k401ToIraConversionMonth, k401ToIraConversionDay, k401ToIraConversionYear]
design: [29-behavioral-layer.md]
stamps:
  param:rothConversionEnabled: dd5059
  param:rothConversionStartYear: 3e889c
  param:rothConversionEndYear: 673c75
  param:rothConversionMaxBracket: 811862
  param:rothConversionOwner: 9b12f2
  param:rothConversionMonth: 8df28e
  param:rothConversionDay: 60869a
  param:rothConversionSchedule: 508923
  param:k401ToIraConversionEnabled: 6b2a99
  param:k401ToIraConversionMonth: d27d49
  param:k401ToIraConversionDay: b8b57a
  param:k401ToIraConversionYear: c9e861
  panel:paycheque: f8d503
  panel:journal-report: e88448
---

Moving money from tax-deferred to Roth, paying the tax now so that it and its growth
are never taxed again.

The whole decision is *when*. Conversion is worth doing in years when your marginal
rate is unusually low, and for most plans those years are a specific, closing window:
after earnings stop and before Social Security and required distributions start
filling the brackets on their own.

Two ways to express it. **Bracket filling** converts as much as fits below a marginal
bracket ceiling each year — the standard rule, and it adapts automatically as other
income moves. **A schedule** states an income target per year, in real base-year
dollars compounded to nominal, which is what the closed-loop controller produces and
what you want when the amounts came out of a solve rather than a rule.

Conversions interact with more than they look like they should. Converted income
raises the year's taxable income, which can change bracket-dependent decisions
elsewhere — [tax harvesting](tax-harvesting.md) most obviously, since the zero-rate
gain ceiling is measured against the same income.

Rolling a 401(k) into an IRA at retirement is a different operation with no tax
consequence, and it is here because it usually has to happen first: it consolidates
the balance that conversions then draw from.

For a cross-border plan, check what the destination country does with a Roth before
assuming the conversion is settled — a wrapper that is tax-free in one jurisdiction
is not automatically tax-free in the other.
