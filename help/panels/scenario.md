---
id: scenario
kind: panel
title: Scenario
panels: [scenario]
stamps:
  panel:scenario: 38d131
---

Which plan you are looking at, and the facts that are true of the whole run: its
name, the start and end dates the simulation covers, and the save/load/export
controls for the scenario as a document.

Open it first. Nothing else in the workbench means anything until a scenario is
selected — the run has no horizon, the panels have no state to read, and the
parameter list has nothing to list.

The parameter list deliberately is **not** here; it lives in [Parameters](parameters.md),
which was split out so the list could use a wide centre pane. The two are driven by
the same view and presenter, so a change made in one is visible in the other
immediately. This panel is the identity and the envelope; that one is the contents.

Exporting from here writes the whole scenario, including its `initialState` — the
persisted balances, holdings and per-account overrides that a parameter bag alone
cannot reproduce. That is the file the headless tools take: `npm run scenario --
<file.json>` runs exactly what this panel saved. A scenario exported here and a
scenario built by `buildDefaultConfig()` are not interchangeable, and a study run
against the wrong one answers a different question than the one asked.
