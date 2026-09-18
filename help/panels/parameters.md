---
id: parameters
kind: panel
title: Parameters
panels: [parameters]
design: [98-sweepable-parameter-surface.md]
stamps:
  panel:parameters: b4df31
---

Every lever the scenario exposes, with its current value, plus the filter and the
parameter-level import/export controls.

The filter searches parameter **descriptions** by default, not names — so looking
for "the thing that decides which account pays first" finds it without knowing it
is called `drawdownSequence`. That is usually the fastest way in when you know the
behaviour you want and not the key.

Open it when you want to change what the plan assumes rather than what it contains.
Structural facts — accounts, people, properties, securities — are records, and live
in [Nodes](config-list.md) and [Edit](inspector.md); parameters are the settings
those records are run under.

Needs a scenario loaded. The list is the scenario's own merged schema, so a plan
that never authored a lever still shows it at its default, and setting it there
makes it real.

The same surface is what the headless tools sweep and what Monte Carlo and the
optimizer search, so a key you can set here is a key `npm run sweep` can vary and
[Monte Carlo](mc-config.md) can randomise. `help/REFERENCE.md` lists all of them
with their groups, types, defaults and which toolset contributed each one.
