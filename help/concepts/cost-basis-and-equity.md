---
id: cost-basis-and-equity
kind: concept
title: Cost Basis and Company Equity
panels: [securities, holdings]
params: [stockBasisUS, stockBasisIntl, stockSplitRatio, companySaleYear]
design: [94-equity-as-security-positions.md, 72-company-equity-sale-fixes.md]
stamps:
  param:stockBasisUS: 8496f4
  param:stockBasisIntl: b32aae
  param:stockSplitRatio: 1c3adb
  param:companySaleYear: ce4b0c
  panel:securities: 80facb
  panel:holdings: 359688
---

The opening facts about what a position cost, and the date a private stake turns into
money.

**Cost basis is an input, not an output.** The simulation can track basis forward
perfectly once a run starts, but it cannot know what you paid before it began. These
seed the taxable equity holdings, and getting them wrong quietly corrupts every
disposal downstream — unrealised gain, realised gain, the tax on a sale, and anything
that depends on which lot is cheapest to sell. A plan modelled with a basis equal to
market value will never show a gain and will look considerably more tax-efficient than
it is.

Note one default that is deliberately artificial: the seeded domestic basis sits
*above* market value, so a loss exists from the first day and
[tax-loss harvesting](tax-harvesting.md) fires immediately when switched on. That is
a testing convenience, not a realistic starting position — set a real figure before
drawing conclusions about harvesting.

A split ratio restates units and per-unit basis together, leaving the position's value
unchanged. It is bookkeeping, and it matters only because unit counts appear in
[Securities](../panels/securities.md).

**Company equity** is the illiquid case: a private stake with no market price, which
does nothing at all until its sale year arrives and then converts to cash in one
event. That lumpiness is the interesting part — one year's tax bill, one year's
reinvestment decision, and a large sensitivity to which year you assume. Leave the
year unset for a stake that is never sold.
