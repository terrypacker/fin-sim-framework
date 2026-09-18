---
id: allocation
kind: panel
title: Allocation
panels: [allocation]
design: [82-allocation-over-time-reporting.md]
stamps:
  panel:allocation: fc1993
---

The realised asset mix across the whole plan, over time.

It exists to answer a question a net-worth line hides: **is the portfolio's shape
being chosen, or is it whatever the drawdown order left behind?** A plan that drifts
to ninety percent equities by 2050 because the bonds were spent first has a
retirement risk profile nobody picked, and only a shape-over-time view shows it.

[Holdings](holdings.md) is the point-in-time sibling, scoped to one account; this
crosses accounts and runs the length of the plan.

The run samples itself at year boundaries, and this panel reads those samples — it
never re-steps the simulation, so opening it cannot disturb playback. Every share
comes from the same module the headless allocation report uses, so the panel and
`npm run allocation-report` cannot disagree about a share.

Needs a scenario built and stepped.

It exports its underlying rows as CSV. Those columns are the fact table: a number on
the chart that is not traceable to a row is a number nobody can check, which is why
the column set is fixed rather than whatever the chart happened to need.
