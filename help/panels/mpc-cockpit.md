---
id: mpc-cockpit
kind: panel
title: MPC Cockpit
panels: [mpc-cockpit]
design: [39-mpc-financial-controller.md, 80-feasibility-preserving-harvest.md]
stamps:
  panel:mpc-cockpit: f4a842
---

The closed-loop advisor. It stands at the run's "now", snapshots what has actually
happened up to that point, asks the controller for the next move, and draws a fan of
candidate futures with the recommendation highlighted.

The distinction that makes it useful: it is an **advisor, not an autopilot**. You can
Apply the recommendation or an override of your own, then Advance "now" forward — at
which point it re-plans against the world as it then is. That loop is the whole idea.
A plan optimised once at year zero assumes forty years of foresight; this one only
ever commits to the next decision, and re-decides when the facts change.

Open it when the question is not "what is the best plan" but "what should I do this
year, given what has happened".

The budget and seed control how hard the controller searches, and feed all three
solve paths — manual advice, auto-advance and the harvest re-solve. Lowering the
budget walks back toward a regime where the controller commits to worse moves, which
is why the evaluation readout ships beside the control rather than behind it.

Needs a scenario loaded and a run stepped to the date you want to stand at.
