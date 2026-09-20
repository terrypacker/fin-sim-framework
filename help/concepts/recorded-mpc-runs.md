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
ended up, committing one move each time. Forty-four years is forty-four dated moves.
The question this answers is what to *keep*.

The old answer was to squash them into something small — three age bands, one
allocation, one rung count. It reads well and does not work: squashing a solvent set of
moves produced a plan that ran out of money, every time, on errors as small as a dollar
of rounding. A plan aimed at spending its last dollar on the last day has no room for
any of them, and the yearly re-solve had been quietly paying for them.

So nothing is squashed. The moves are kept as moves — a dated table the simulation plays
back as the clock reaches each. What you tested is what you saved.

**Several at once, one in charge.** Recordings accumulate side by side and exactly one
drives the run. A separate switch stops it without forgetting which it was.

**Why a name, and not the table, is what you pick.** The rest of the app already treats
a name as a choice, which makes "which of these three plans survives a bad decade" an
ordinary ranking, crossable with any other question.

**Nothing points at a row number.** Each move names its control and the age or year it
applies to, so editing the spending table afterwards cannot change what it meant.

**It refuses rather than half-plays.** Switch off a mechanic a recording depends on and
loading stops and names the control, rather than dropping those moves and running
something else under the same name. A plan that will not load beats one that loads as a
different plan.

**And it will not pretend to measure.** Sweep a setting the recording decides and you
are told: it re-asserts its value as the clock passes each move, so the cells differ
without differing by what you swept. Sweep *which recording plays* instead.

**When a move bites.** Decisions land at period boundaries, so one dated in March holds
at the next — invisible yearly, up to six months half-yearly.

**What it does not tell you.** A recording traces one path through one future; for
robustness run it across seeds or promote it to Monte Carlo. Editing a row by hand is a
what-if under a frozen policy, not a re-plan.

See [MPC Cockpit](../panels/mpc-cockpit.md).
