---
id: dashboard
kind: panel
title: Dashboard
panels: [dashboard]
stamps:
  panel:dashboard: 7928b7
---

Five counters across the bottom of the workbench: the date the run has reached, and
the running totals of events, handlers, actions and reducers executed.

It is an *is anything happening* readout, not an analysis. The numbers are execution
counts, not money, and they exist to answer the question you ask when a run looks
frozen or a change seems to have done nothing: is the simulation actually doing work,
and is it doing more or less of it than before.

That makes it most useful next to a change you just made. A plan whose action count
jumps by a factor of ten after a one-line edit is telling you something that no
financial panel will show, because the money may be identical.

The current date is the same cursor the rest of the workbench follows, so it is also
the quickest confirmation of where a scrub actually landed.

Needs a scenario built; the counters fill as the run steps and reset when a new
scenario is loaded.

For where the time is going rather than how much is happening, use
[Performance](perf.md).
