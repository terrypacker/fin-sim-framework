---
id: real-vs-nominal
kind: concept
title: Real vs Nominal Dollars
panels: [state-panel, holdings, securities, watchlist, chart]
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
  src/visualization/app-display-settings.js: ec6c02
  src/finance/services/state-schema-registry.js: 120b19
---

Every balance the simulation books is **nominal**: money in the year it happens.
Inflation raises prices but is never subtracted from balances. At 3% for 44 years,
prices rise about 3.7 times, so a nominal ending balance looks almost four times
richer than its purchasing power. The numbers are right; the unit shrinks.

The **Real** option in the top bar changes the unit. It shows money in the purchasing
power of the plan's first year, and that year is printed on the option (`Real (2026 $)`).
Nothing is recalculated, and switching back restores the exact nominal figures.

**Which inflation.** The index belongs to the currency on screen. When you view USD,
values are divided by US inflation, and when you view AUD, by AU inflation, each
measured from the plan's start to the value's date. Every figure on one screen uses
the same index, so totals still add up and a move between countries does not put a
jump in the numbers. If the two countries' inflation differs while the exchange rate
is held, switching currency changes a real curve's *shape*, not just its scale. That
is correct: the two currencies' purchasing power really does drift apart.

**What follows the switch today.** The state panel's current values, holdings,
securities and watchlist values all come from a single instant, so each is divided
by that instant's price level. Their hover text shows the nominal amount and the
level it was divided by. The **chart** restates every point separately: it converts
the point at that date's exchange rate and divides by that date's price level. When
it does, the money axis is labelled `real`. If a series cannot be restated at every
point, it is drawn nominal and left unlabelled rather than half-converted.

**What does not, yet.** The journal report, allocation and pool history, paycheques,
and state-panel diffs and history statistics still need a price level for each
date. Monte Carlo and optimizer figures are
statistics across many runs, each with its own inflation path. All of these stay
nominal until each is converted properly. They are never divided by today's index as
a shortcut, because that produces a number that looks real and is not.

**Always nominal.** Tax documents are statutory figures, so they are never restated.
Figures that are already real by construction keep their own basis: the spending
panel's real view, Monte Carlo's Real Cost, and the terminal wealth target.
