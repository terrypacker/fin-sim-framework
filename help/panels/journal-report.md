---
id: journal-report
kind: panel
title: Journal Report
panels: [journal-report]
design: [16-journal-reporting-plugin.md]
stamps:
  panel:journal-report: e88448
---

Named aggregate reports built over the journal: pick a report, narrow it with the
facets it offers, and read grouped rows that expand to the individual entries behind
them.

This is the panel for *how much, in total, of what kind* — tax by source, income by
category, gains by disposal. Because every report is defined over journal entries
rather than over balances, the total and the entries that make it up are the same
data, which is why any row can be expanded to the actions underneath it and why the
two can never disagree.

Facets come from each report's own definition, so the filters offered are the ones
that report actually supports rather than a generic set.

Open it when you want a number you could put in a return or a summary, and then open
the rows when you want to know what is in it.

The rollup bar carries the grand total and a CSV export.

Needs a run with the journal recorded. A run made with reduced telemetry has no
journal to report over.

For one field across every action type instead of one report's aggregate, use
[Field × Action](cross-action-query.md).
