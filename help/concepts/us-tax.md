---
id: us-tax
kind: concept
title: US Tax
panels: [journal-report]
params: [residencyState, usFilingSingle, usFederalBracketIndexSpread, usStateBracketIndexSpread, usFicaWageBaseIndexSpread, usFeieCapIndexSpread, stateMoveDate, stateMoveDestination]
design: [71-tax-worksheet-csv-export.md]
stamps:
  param:residencyState: 188c33
  param:usFilingSingle: 06119d
  param:usFederalBracketIndexSpread: 4c8208
  param:usStateBracketIndexSpread: 7f550c
  param:usFicaWageBaseIndexSpread: 75ca9f
  param:usFeieCapIndexSpread: 576ada
  param:stateMoveDate: ef6579
  param:stateMoveDestination: 2f214c
  panel:journal-report: b2eedb
---

Filing status, state residency, and how the federal thresholds are projected forward.

**State residency is the lever people forget.** Federal tax is the same everywhere;
state tax is not, and a few modelled states differ enough that moving between them is
worth a run of its own. It can change mid-plan with its own move date — always a
1 January, so the new state taxes the whole year — and destination, independently of
any international move — retiring from a high-tax state
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

The shipped defaults are not zero, because the law does not index to the inflation
the plan assumes. The federal thresholds follow the chained index, which has lagged
ordinary CPI in almost every year since 2002, so by default they creep. The wage base
follows average pay, which has beaten prices since the early 1990s, so by default it
climbs faster. Both figures were measured from published data; the trail is in
`docs/us-tax/SOURCES.md`. Set a spread to 0 to go back to plain CPI tracking.

Filing status changes the bracket widths and standard deduction, and survivorship
changes it mid-plan — see [Mortality](mortality.md).

Each person's Social Security claim age decides when that income starts, and so the
bracket room left for [Roth conversions](roth-conversions.md) in the years between
stopping work and claiming. It is set on the [Person](../nodes/person.md).
