---
id: recorded-mpc-runs
kind: concept
title: Recorded MPC Runs
panels: [mpc-cockpit]
params: [mpcRuns, mpcActiveRun, mpcRunEnabled]
design: [81-run-as-replayable-artifact.md, 80-feasibility-preserving-harvest.md]
stamps:
  param:mpcRuns: ee13fc
  param:mpcActiveRun: 85cd45
  param:mpcRunEnabled: 25cbb4
  panel:mpc-cockpit: f4a842
---

The cockpit re-solves your plan every year or so from wherever the portfolio actually
ended up, committing one move each time. Forty-four years of that is forty-four moves,
each with a date. The question this answers is what to *keep*.

The old answer was to squash them into something small — three age bands, one
allocation, one rung count. It reads well and it does not work. Squashing a solvent
set of moves produced a plan that ran out of money, every time it was tried, and the
errors doing it were tiny: a dollar of rounding, a boundary landing a year early. A
plan aimed at spending its last dollar on the last day has no room for any of them,
and the yearly re-solve had quietly been paying for them all along.

So nothing is squashed. The moves are kept as moves — a dated table the simulation
plays back as the clock reaches each one. Press Play and the plan unfolds the way the
cockpit decided it, with no second engine in between. What you tested is what you
saved.

**Several at once, one in charge.** Recordings are the cheapest thing the cockpit
makes and the thing you most want two of, so they accumulate side by side and exactly
one drives the run. A separate switch stops the selected one without making you forget
which it was — flipping a plan against its own baseline is the commonest thing to do.

**Why a name, and not the table, is what you pick.** A single name is something the
rest of the app can already treat as a choice, which makes "which of these three plans
survives a bad decade" an ordinary ranking — the same machinery that weighs a
retirement age, and crossable with it for free.

**Nothing points at a row number.** Each move names the control and the age or year it
applies to, so editing the spending table afterwards cannot change what it meant.

**When a move bites.** Decisions are taken at period boundaries, so one dated in March
holds at the next boundary — invisible yearly, up to six months half-yearly.

**What it does not tell you.** A recording traces one path through one future; for
robustness, run it across seeds or promote it to a Monte Carlo study. Editing a row by
hand is a what-if under a frozen policy, not a re-plan.

See [MPC Cockpit](../panels/mpc-cockpit.md).
