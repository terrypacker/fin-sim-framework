---
id: help
kind: panel
title: Help
panels: [help]
design: [108-help-system.md]
stamps:
  panel:help: b35a2b
---

This panel. It follows whichever tab you are on and shows that panel's page, so help
arrives without being asked for.

Three ways in. Click a tab and the page here changes with it. Click the **?** beside a
parameter and you get that parameter's full text — the complete description, which the
hover tooltip truncates, alongside its default, its range, whether Monte Carlo and the
optimizer can sweep it, and which toolset contributed it. Click the **?** on a parameter
group header and you get its parameters as a list, with the pages that explain the
mechanics behind them.

Links between pages navigate in place, and **←** returns. Following a tab does not push
history: back goes to what you were reading, not through the tabs you passed.

Everything here is generated. The pages are the files under `help/`, and the parameter
facts are read out of the live schema at build time, so a parameter added to a toolset
appears here with nobody having remembered anything. No page may restate a parameter
description — that is the copy that drifts, and a check refuses it.

When a page is not enough, it names the design document that carries the full argument.

Needs nothing loaded. If the panel says there is no index, run `npm run help:build`;
the index is a build artifact and is not committed.
