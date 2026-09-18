---
id: securities
kind: panel
title: Securities
panels: [securities]
design: [94-equity-as-security-positions.md]
stamps:
  panel:securities: 80facb
---

What the plan owns by instrument, across every account.

It answers a question neither of the other two portfolio panels can.
[Holdings](holdings.md) is scoped to one account. [Allocation](allocation.md) crosses
accounts but charts shares, so it says how concentrated you are, not how many you
hold and where. *How many shares of this do I own?* had no answer on a plan holding
one instrument in three wrappers — which is the ordinary case for employer stock.

So the grouping is by security, and a unit count totals **within** a security and
never across securities. Every row carries a unit total; the footer carries none,
deliberately, for the same reason [Holdings](holdings.md) refuses to sum its Units
column.

Open it for concentration questions, for vesting and employer-stock exposure, or
whenever the same ticker lives in more than one account and you need the whole
position.

Needs a scenario built and stepped.

The numbers come from the same allocation cube the other panels read, at the current
date — not a second walk of the state. A second walk would be a second answer with no
way to tell which one is right.
