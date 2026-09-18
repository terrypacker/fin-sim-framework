---
id: chart
kind: panel
title: Chart
panels: [chart]
stamps:
  panel:chart: c05af4
---

The run plotted over time: pick fields with the chip strip above the plot and they
are drawn as the simulation advances.

The fastest way to see the *shape* of a run rather than its end point. A net-worth
line that arrives at the right number by an alarming route is a thing only a chart
shows, and it is the usual reason to open this before any of the report panels.

Fields come from the same state paths [State](state-panel.md) lists, so anything you
can see there you can plot here. For a set of fields you want to keep across runs,
build a [Watchlist](watchlist.md) instead — this panel's selection is per session.

A failure banner appears above the plot when the run did not survive, rather than
leaving you to infer it from a line reaching zero.

Needs a scenario built. The plot's container belongs to the workbench runtime, not
to this panel, so a layout with this tab closed at load still gets a working chart
when the tab is opened — an earlier version minted the element here, and a reader
whose layout had the tab closed got a chart that was silently dead for the whole
session.
