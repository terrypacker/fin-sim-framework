---
id: inspector
kind: panel
title: Edit
panels: [inspector]
stamps:
  panel:inspector: 79c913
---

The editor for one record, rendered in place in the left column rather than in a
modal over the top of everything.

It opens when you click a row in [Nodes](config-list.md) or a node in
[Graph](config-graph.md), and shows the fields for whatever kind that record is —
an account editor for an account, a property editor for a property. The form is
built per kind, so the fields you see are the fields that record actually has.

Open it when you need to change a structural fact of the plan: an account's opening
balance, a property's sale year, a person's retirement date. For the settings those
records run under, use [Parameters](parameters.md) instead.

With nothing selected it shows a placeholder. It follows selection rather than
holding its own, so it always reflects the last node you clicked — which is worth
remembering when two panels can both change the selection.

Editing a record changes the scenario document, not just the view, so a run after
an edit is a run of a different plan. Save or export from [Scenario](scenario.md)
if you want to keep it.
