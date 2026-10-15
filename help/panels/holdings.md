---
id: holdings
kind: panel
title: Holdings
panels: [holdings]
design: [82-allocation-over-time-reporting.md]
stamps:
  panel:holdings: 962055
---

What one account holds right now, in three stacked views scoped to the account you
pick and the date the run has reached.

**Mix** is a donut of market value beside diverging bars of unrealised gain and loss,
over the same class rollup. Same order, same colours in both, so the pair reads as one
picture: what you hold, and how it has done.

**Snapshot** is the per-holding table — market value, cost basis, unrealised G/L —
read live, so it scrubs as the run advances.

**Activity** is the buy and sell ledger for the account, derived from the journal's
holdings diffs: sales, conversions and contributions, with market moves and dividends
behind a toggle because they otherwise drown the decisions.

Open it when the question is about one account. For the portfolio's shape over the
whole plan, use [Allocation](allocation.md); for one instrument across every account,
use [Securities](securities.md).

Needs a scenario built and stepped, with the journal recorded for the Activity view.

Units are the broker's share count only where the lot was given one, by an import or
the account editor's Shares field. Any other equity lot counts synthetic units that start
at \$100 each. Those keep the dollars right, but they are not shares.

It will not total the Units column, and that is deliberate: adding up counts of
different instruments produces a number that looks like a quantity and is not one.
