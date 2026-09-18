---
id: us-tax
kind: concept
title: US Tax
panels: [journal-report]
params: [residencyState, usFilingSingle, usFederalBracketIndexSpread, usStateBracketIndexSpread, usFicaWageBaseIndexSpread, usFeieCapIndexSpread, stateMoveYear, stateMoveDestination, primarySsClaimAge]
design: [71-tax-worksheet-csv-export.md]
stamps:
  param:residencyState: 188c33
  param:usFilingSingle: 06119d
  param:usFederalBracketIndexSpread: be5ae9
  param:usStateBracketIndexSpread: 7f550c
  param:usFicaWageBaseIndexSpread: a676c0
  param:usFeieCapIndexSpread: 277ceb
  param:stateMoveYear: cd47bc
  param:stateMoveDestination: 2f214c
  param:primarySsClaimAge: b186dd
  panel:journal-report: e88448
---

Filing status, state residency, and how the federal thresholds are projected forward.

**State residency is the lever people forget.** Federal tax is the same everywhere;
state tax is not, and a few modelled states differ enough that moving between them is
worth a run of its own. It can change mid-plan with its own move year and
destination, independently of any international move — retiring from a high-tax state
to a no-tax one is a common and material plan.

**The index spreads are the part worth understanding before trusting a long run.**
Brackets, the Social Security wage base and the exclusion cap all index upward over
time, and each spread says how fast that happens *relative to inflation*. They are
spreads, not rates: zero means the threshold keeps pace with inflation exactly, and a
positive value means it outruns it.

This matters over a forty-year plan more than it looks. A threshold indexed slower
than inflation drags real income into higher brackets year after year — decades of
quiet bracket creep — and a plan that assumes perfect indexation will understate its
own tax bill. Because the effect compounds, small differences in these spreads move
terminal outcomes by amounts worth checking.

Filing status changes the bracket widths and standard deduction, and survivorship
changes it mid-plan — see [Mortality](mortality.md).

The Social Security claim age is here because it decides when that income starts,
which shapes the bracket room available for [Roth conversions](roth-conversions.md).
Only full retirement age is currently modelled.
