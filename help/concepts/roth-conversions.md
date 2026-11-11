---
id: roth-conversions
kind: concept
title: Roth Conversions
panels: [paycheque, journal-report]
params: [rothConversionEnabled, rothConversionStartYear, rothConversionEndYear, rothConversionMaxBracket, rothConversionOwner, rothConversionLtcgAware, rothConversionSchedule, rothConversionScheduleMode, k401ToIraConversionEnabled]
design: [29-behavioral-layer.md]
stamps:
  param:rothConversionEnabled: dd5059
  param:rothConversionStartYear: 3e889c
  param:rothConversionEndYear: 80bcca
  param:rothConversionMaxBracket: 811862
  param:rothConversionOwner: 9b12f2
  param:rothConversionLtcgAware: bbe047
  param:rothConversionSchedule: b17ede
  param:rothConversionScheduleMode: ab7ce6
  param:k401ToIraConversionEnabled: 7a93d4
  panel:paycheque: d4e25c
  panel:journal-report: b2eedb
---

Moving money from tax-deferred to Roth, paying the tax now so that it and its growth
are never taxed again.

The whole decision is *when*. Conversion is worth doing in years when your marginal
rate is unusually low, and for most plans those years are a specific, closing window:
after earnings stop and before Social Security and required distributions start
filling the brackets on their own.

Two ways to express it. **Bracket filling** converts as much as fits below a marginal
bracket ceiling each year — the standard rule, and it adapts automatically as other
income moves. It can only count income already booked, so it always runs last thing
on New Year's Eve, after that day's TIPS and zero-coupon uplift; the date is not a
setting, and a plan saved with an earlier one is moved, with a note. **A schedule** states an income target per year, in real base-year
dollars compounded to nominal, which is what the closed-loop controller produces and
what you want when the amounts came out of a solve rather than a rule. The two also
combine: a schedule can override single years of the bracket-filling window and leave the
rest to the rule, which is how a year-at-a-time controller's decisions are saved.

Converted income raises the year's taxable income, which moves bracket-dependent
decisions elsewhere — [tax harvesting](tax-harvesting.md) most obviously, since the
zero-rate gain ceiling is measured against the same income.

The sharpest is with your own gains. When rebalancing sells appreciated shares, each
converted dollar lifts a dollar of gain out of the zero-rate band, a cost the bracket
ceiling cannot see. The gain-aware switch shrinks those years, wherever they land —
which a fixed list of years to skip cannot do.

Rolling a 401(k) into an IRA at retirement is a different operation with no tax
consequence, and it is here because it usually has to happen first: it consolidates
the balance that conversions then draw from. When it happens is set on each person, in
[People](../nodes/person.md), because it follows that person's own separation from work.

For a cross-border plan, check what the destination country does with a Roth before
assuming the conversion is settled — a wrapper that is tax-free in one jurisdiction
is not automatically tax-free in the other.
