---
id: watchlist
kind: panel
title: Watchlist
panels: [watchlist]
design: [101-watchlists.md]
stamps:
  panel:watchlist: 8af97c
---

A named set of state fields you care about, with their current values, sparklines and
a chart — and the controls to build and maintain those sets.

[State](state-panel.md) shows everything and is where you go to find a field.
This is where a field goes once you have found it and want to keep watching it: the
set persists, so the same handful of numbers is in front of you across runs instead
of being re-found each time. Checking a field in the State panel adds it to the list
named in that panel's picker.

Each row is a field: charted or not, draggable to reorder, its label, a sparkline,
and the current value. Values are read from the live state, so they follow the run
and a scrub. A path that does not exist yet at the current date — a lot not yet
bought — is shown muted rather than as zero, which are different facts.

Open it to keep an eye on a few specific numbers while you change something else.

Needs a scenario built. Rows survive a running simulation: a drag or an open menu is
not interrupted when the step loop refreshes the values.

Lists can be renamed, duplicated and deleted from the bar at the top.
