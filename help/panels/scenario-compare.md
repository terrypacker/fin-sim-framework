---
id: scenario-compare
kind: panel
title: Scenario Compare
panels: [scenario-compare]
stamps:
  panel:scenario-compare: b960fb
---

Two scenarios side by side: a KPI strip, a table of state fields that differ, and an
overlay of their journals.

Pick two from the selector bar and press Compare. The KPI strip is the headline — did
this end up better — and the state diff is the useful part, because it says *which*
fields diverged rather than only by how much in total. A pair that differ by $300k at
the end usually differ in three places, and the diff names them.

Open it whenever you have changed one thing and want to know what that change did.
That includes changes you did not make by hand: a leaf of a
[Decision Graph](dg-results.md) run has a Compare button that opens it here against
its base, which is how a branch's ranking becomes an explanation.

Needs two scenarios available to compare.

Two cautions worth holding. A comparison between runs that used different random
draws measures the draws as much as the change, so compare deterministic runs or
seeded pairs. And ordering among same-date events is decided by a tie rule, so adding
an event anywhere can shuffle unrelated same-day actions — a diff with entries you did
not expect is not automatically a bug in your change.
