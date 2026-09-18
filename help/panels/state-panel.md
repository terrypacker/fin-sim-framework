---
id: state-panel
kind: panel
title: State
panels: [state-panel]
stamps:
  panel:state-panel: 6b89e2
---

Every field of the simulation's current state, filtered, at the date the run has
reached.

This is the ground truth the other panels are views of. When a report disagrees with
your expectation, this is where you check what the number actually is — balances,
market values, tax accumulators, FX rates, the lot.

The filter matches field names, so `marketValue`, `balance` or `USD_AUD` narrows
thousands of paths to the handful you care about. Text fields — ids, symbols, labels
and anything else that does not change during a run — are hidden by default, because
they are noise when you are watching numbers move; a filter that matches one shows it
anyway.

Checking a field adds it to the watchlist named in the picker at the top, which is how
a field you found here becomes something [Watchlist](watchlist.md) tracks and charts
across runs.

Needs a scenario built; it fills as the run steps and follows a scrub.

For *how* a field got to its current value rather than what it is, use
[Field × Action](cross-action-query.md), which shows every action type that has ever
moved it.
