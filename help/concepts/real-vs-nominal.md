---
id: real-vs-nominal
kind: concept
title: Real vs Nominal Dollars
panels: [state-panel, holdings, securities, watchlist, chart, journal-report, allocation, pools, paycheque, spending]
params: []
actions: []
tools: []
design: [79-real-vs-nominal-display.md, 89-spending-over-time-reporting.md]
sources: [src/visualization/app-display-settings.js, src/finance/services/state-schema-registry.js]
stamps:
  panel:state-panel: 6b89e2
  panel:holdings: 359688
  panel:securities: 80facb
  panel:watchlist: 8af97c
  panel:chart: c05af4
  panel:journal-report: e88448
  panel:allocation: fc1993
  panel:pools: b2d1aa
  panel:paycheque: f8d503
  panel:spending: f9f5c7
  src/visualization/app-display-settings.js: ec6c02
  src/finance/services/state-schema-registry.js: 278bb8
---

Every balance the simulation books is **nominal**: money in the year it happens.
Inflation raises prices but is never subtracted from balances. At 3% for 44 years,
prices rise about 3.7 times, so a nominal ending balance looks almost four times
richer than its purchasing power. The numbers are right; the unit shrinks.

The **Real** option in the top bar changes the unit. It shows money in the purchasing
power of the plan's first year, and that year is printed on the option (`Real (2026 $)`).
Nothing is recalculated; switching back restores the exact nominal figures.

**Which inflation.** The index belongs to the currency on screen. When you view USD,
values are divided by US inflation, and when you view AUD, by AU inflation, each
measured from the plan's start to the value's date. Every figure on one screen uses
the same index, so totals still add up and a move between countries does not put a
jump in the numbers. If the two countries' inflation differs while the exchange rate
is held, switching currency changes a real curve's *shape*, not just its scale. That
is correct: the two currencies' purchasing power really does drift apart.

**Each value at its own date.** A value is converted at *its* date's exchange rate
and divided by *its* date's price level. The panels showing the current state
(state tree, holdings, securities, watchlist) use the current date. The chart, the
allocation and pool histories, a payslip, and state-panel diffs and history each use
the date of the point, month or row. The journal report restates every row *before*
summing, so a total over many years is a sum of real rows. Dividing a finished sum by
one year's level would not give the same answer. Min, max and net change are likewise
worked out from restated points. A series that cannot be restated at every point stays
nominal.

**Always nominal.** Tax documents, super contributions and cap tables are measured
against statutory amounts, so they stay nominal and are labelled that way. A CSV
export is always nominal. Monte Carlo and optimizer figures stay nominal for now:
each run has its own inflation path. Figures that are real by construction keep their
own basis: Monte Carlo's Real Cost and the terminal wealth target. The spending panel
follows this switch, while its own buttons can override it until you next flip the
switch.
