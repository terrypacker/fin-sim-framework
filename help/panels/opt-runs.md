---
id: opt-runs
kind: panel
title: OPT Runs
panels: [opt-runs]
stamps:
  panel:opt-runs: 5eb969
---

The top candidates from a search, each with an Apply button that replays the scenario
with that candidate's parameter overrides.

This is where an optimisation result becomes something you can actually look at.
A score in [OPT Results](opt-results.md) is a number; applying the candidate makes it
the live run, so [Chart](chart.md), [Timeline](timeline.md) and the report panels all
describe that plan and you can see what it does rather than what it scored.

Worth doing for the runner-up as well as the winner. Two candidates a fraction apart
in score can be very different plans, and the one you would actually live in is not
always the one at the top.

Applying sets parameter overrides on the run; it does not silently rewrite your saved
scenario. If you decide to keep it, save from [Scenario](scenario.md).

Needs a completed [Optimize](opt-config.md) run.
