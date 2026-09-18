---
id: opt-config
kind: panel
title: Optimize
panels: [opt-config]
stamps:
  panel:opt-config: e04ce5
---

The optimizer's setup: what it is trying to maximise, which parameters it may move
and within what bounds, which solver runs the search, and how many candidates to try.

The search-space table is built from the scenario's own optimisable surface, grouped,
with a range per row. A parameter left unchecked is held at the plan's value — the
search is over what you enable, so enabling everything is rarely what you want. The
narrower the space, the more the candidate budget buys.

The objective is the part worth thinking about hardest, because the optimizer will
answer exactly the question you asked. "Maximise ending wealth" and "die with a
target" produce genuinely different plans, and a result that looks perverse is
usually a correct answer to an objective you did not mean.

Solver options appear under the solver you pick, so the knobs shown belong to the
search actually running.

Needs a scenario loaded. Results land in [OPT Results](opt-results.md) and the
ranked candidates in [OPT Runs](opt-runs.md).

Every candidate is a full simulation run, so cost scales with the candidate count
the same way Monte Carlo scales with iterations.
