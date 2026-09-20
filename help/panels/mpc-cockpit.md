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
happened, asks the controller for the next move, and draws a fan of candidate futures
with the recommendation highlighted.

The distinction that makes it useful: it is an **advisor, not an autopilot**. Apply the
recommendation or an override, then Advance "now" forward — at which point it re-plans
against the world as it then is. A plan optimised once at year zero assumes forty years
of foresight; this one only ever commits to the next decision.

Open it when the question is not "what is the best plan" but "what should I do this
year".

Budget and seed control how hard the controller searches. Lowering the budget walks
back toward a regime where it commits to worse moves, which is why the evaluation
readout ships beside the control.

Two ways out of a finished run. **Copy to scenario** squashes the moves into ordinary
settings — small, arguable, lossy. **Save run to plan** keeps the moves and plays them.
Reach for the first to explain a run, the second to keep it. Both refuse a plan that
runs out of money.

When the loaded plan is already playing a recording, a line above the controls says so.
The advisor is then standing on decisions somebody already made, and sees only those
dated before where you stand — so it never competes with its own future.

Needs a scenario loaded and a run stepped to the date you want to stand at.
