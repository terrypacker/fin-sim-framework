---
id: bonds
kind: panel
title: Bonds
panels: [bonds]
design: [130-bonds-panel.md, 66-bond-fidelity.md]
sources: [src/finance/allocation-reporting/bond-rollup.js]
stamps:
  panel:bonds: 68776c
  src/finance/allocation-reporting/bond-rollup.js: f95fa7
---

Every bond the plan holds, sorted by kind, then account, then lot, plus a chart of
when the bonds mature.

Open it to see which account holds the TIPS and which holds the munis, or to see the
shape of a ladder. [Securities](securities.md) can't show this: a ladder rung names no
instrument, and "muni" is a tax treatment, not an instrument.

**The kind is the coupon's tax treatment**, worked out by the same rules the tax uses.
So a muni reads as state-exempt only while you live in its issuing state. When no US
state is set, a muni is just "Muni". A US exemption on an AU-market bond raises a
warning. Usually it is a ladder's tax treatment.

**A bond fund is not a kind of its own.** A muni fund is a muni. It appears as a lot with
no maturity date and therefore no principal. For that reason the principal footer covers
dated bonds only, and says so.

Unlike [Securities](securities.md), the footer does add up principal, because repaid
money in one currency adds up correctly.

The chart shows principal maturing each year, with every year present so gaps in a
ladder are visible. Rungs that roll into new rungs are hatched; spend-down rungs, which
turn into cash, are solid. Funds don't appear on it. Click a year to open its lots. The chart shows the book as of the current date, not a projection.

See [Bond Ladders](../concepts/bond-ladders.md). Needs a scenario built and stepped.
