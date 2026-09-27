---
id: real-vs-nominal
kind: concept
title: Real vs Nominal Dollars
panels: [state-panel, holdings, securities, watchlist]
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
  src/visualization/app-display-settings.js: ec6c02
  src/finance/services/state-schema-registry.js: 743d00
---

Every balance the simulation books is **nominal**, meaning money in the year it
happens. Accounts grow at a nominal return, and inflation raises prices without ever
being subtracted from balances. Over a long plan the gap is large: at 3% for 44 years,
prices rise about 3.7 times. A nominal ending balance therefore looks almost four
times richer than it is in purchasing power. The numbers are right; they are just
counted in a unit that shrinks.

The **Real** option in the top bar changes the unit. It shows money in the purchasing
power of the plan's first year, and that year is printed on the option (`Real (2026 $)`).
It is a way of reading the numbers, not a different run: nothing is recalculated, and
switching back restores the exact nominal figures.

**Which inflation.** The index belongs to the currency on screen. When you view USD,
values are divided by US inflation, and when you view AUD, by AU inflation, each
measured from the plan's start to the value's date. Every figure on one screen uses
the same index, so totals still add up and a move between countries does not put a
jump in the numbers. One effect surprises people: if the two countries' inflation
differs while the exchange rate is held, switching currency changes the *shape* of a
real curve, not just its scale. That is correct. Purchasing power in the two
currencies really does drift apart.

**What follows the switch today.** The state panel's current values, holdings,
securities and watchlist values all come from a single instant, so each is divided
by that instant's price level. Their hover text shows the nominal amount and the
level it was divided by.

**What does not, yet.** Anything spanning many dates needs a separate price level
for each date: the chart, the journal report, allocation and pool history, paycheques,
and state-panel diffs and history statistics. Monte Carlo and optimizer figures are
statistics across many runs, each with its own inflation path. All of these stay
nominal until each is converted properly. They are never divided by today's index as
a shortcut, because that produces a number that looks real and is not.

**Always nominal.** Tax documents are statutory figures, so they are never restated.
Figures that are already real by construction keep their own basis: the spending
panel's real view, Monte Carlo's Real Cost, and the terminal wealth target.
