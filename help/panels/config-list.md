---
id: config-list
kind: panel
title: Nodes
panels: [config-list]
stamps:
  panel:config-list: 786f94
---

The scenario's structural records, filtered by kind: people, accounts, properties,
loans, securities and the rest. A kind dropdown, a text filter, the list itself and
an Add button.

This is where a plan's *contents* live, as opposed to its settings. An account with
a balance and a tax treatment is a record; the rate it earns is a parameter. If you
are looking for something and it is not in [Parameters](parameters.md), it is
probably here.

Clicking a row opens it in [Edit](inspector.md). Adding one creates a record of the
selected kind and opens the same editor.

Needs a scenario loaded. The list is queried from the config graph by kind, so it
shows what the plan actually registered — with one deliberate exception: securities
are scenario data rather than graph records, so they are handed to the list
directly. That is why a security behaves slightly differently from an account here.

Most rows also appear as nodes in [Graph](config-graph.md), which is the same
information arranged by what depends on what rather than by kind.
