# 112 — Dated pool targets: a pool size the MPC can decide

**Status:** PROPOSED — 20 Sep 2026, for review. Nothing is built. Answers the last open item of
design 39 §14.10: `pool.<id>.targetScale` as an MPC control (design 110 §13.11).

## 1. The ask, and why the existing axis cannot simply be switched on

Design 110 leg C made pool sizes searchable: `pool.<id>.targetScale` multiplies a pool's
authored target, and it is an optimizer variable, an MC-grid axis and a hidden compile-only
overlay at once. Design 110 §13.7 left `controllable` unset on it, and design 39 §14.9.9 then
built the MPC's pool control as a *shape* lever instead. A rollout WOULD now see a candidate
factor: the gate's `POOL_TARGET` probe reaches, because the candidate's compile resolves the
scaled graph and `derivedStateAt` stamps it. What the axis cannot do is the other half of a
control:

- **It has no saved form.** The factor is a runner-only overlay that never enters `cfg.params`.
  That is design 110's CTRL-9 property: a scenario saved mid-sweep reloads at the author's own
  targets. So a live decision has nowhere to go that a Rebuild or a design 81 replay reads.
- **It is undated.** A scalar applies from t₀. An MPC decision is "from next year on", and a
  replay that applied the factor from t₀ would rewrite the realized past.
- **It cannot actuate a running sim.** The flow reducers and the shape reducer hold the resolved
  graph and schedule from their constructors (design 39 §14.9.9), so changing a param changes
  nothing until a recompile.

"Promote the factor to an authored param" fixes the first and breaks the second and CTRL-9. The
fix has to be a dated, authored form that the engine resolves through machinery that already
exists.

## 2. Proposal: a dated target schedule, resolved into design 109's step function

### 2.1 The param

```
liquidityTargetSchedule: [{ year, pool, scale }]
```

One row sets pool `pool`'s target to `scale` × its authored target, from 1 January of `year`
until the next row for the same pool. A new authored param, `LiquidityTargetSchedule`, edited
as a flat typed row list (year · pool select · factor), not a JSON textarea. Absent or empty
means byte-identical to today, which every golden asserts.

**Why a factor rather than an absolute target.** It is mode-agnostic (`YEARS_OF_SPEND`,
`AMOUNT` and `PERCENT` all scale the same way), it shares units and range with the existing
axis (`POOL_TARGET_SCALE_RANGE`), and it survives an author retuning the base target. An
absolute value would silently override a later edit to the base graph.

**Why per pool, not per shape.** Design 110 §6.4 already decided that a pool id is the pool's
identity across shapes, so an axis keyed on the pool moves it in every shape containing it. A
row follows the same rule: it is about the pool, so it persists across a later shape switch for
as long as the pool exists. That is what "hold a bigger buffer from 2045" means, and it is the
open question in §5 if the operator disagrees.

### 2.2 Resolution: more steps in the same step function

`resolveLiquidityGraphSchedule` already returns a sorted step function `[{fromMs, shapeId,
graph}]`, and every consumer (the shape reducer, both flow reducers, `liquidityStateAt`) selects
from it by date. Target rows become more steps. At each row's 1 January, a new entry repeats
the shape then in force, with the scaled targets of every pool that has a row in force applied
to a copy of its graph, normalized exactly as an authored graph is (design 110 §17.2: no second
validator, no clamp).

One change is needed in the reducer. `PoolShapeScheduleReducer` restamps only when
`liquidityShapeId` changes, and a scale step keeps the same shape. Each entry therefore gets a
`stepKey` (shape id plus a signature of the scales in force), the reducer compares `stepKey`,
and `liquidityShapeId` is stamped exactly as today. A scenario with no target rows has one
`stepKey` per shape, so the reducer's behaviour, the journal and every golden are unchanged.

**Composition with the hidden axis.** Effective scale = axis factor × row factor. The axis stays
what it is, a whole-run overlay for the optimizer, the MC grid and design 100's lever grid, and
a row is a dated decision on top of it. An MPC session's rows then remain meaningful under an
MC sweep of the axis.

### 2.3 The MPC control: `POOL_TARGET`

Built on the `POOL_SHAPE` template (design 39 §14.9.9), which already solved the three hard
parts:

- **Variables.** One per sized pool: a pool with a target whose value is non-zero. A zero target
  cannot be scaled (the design 110 §13.10 dead-axis defect), so such pools get no variable. The
  range is the axis range, capped for `PERCENT` pools at the factor the normalizer would
  refuse, the bound `poolAxisProblems` already computes.
- **Scaffold.** `prepareBaseParams` adds, for each pool, a row at the next 1 January carrying
  the factor **already in force** there. The unchanged candidate is then the plan (the §14.9.6
  lesson, applied from the start).
- **Rollout.** Nothing new. The candidate's compile resolves the extra step, and
  `derivedStateAt` asks the schedule at the last period advance, so a 1-January decision applies
  on the spot and any other applies at its row.
- **Actuate.** The row is upserted into `scenario.params`, the running sim's shape and flow
  reducers get the re-resolved schedule (registering the shape reducer if absent), and state is
  restamped at now. This is `POOL_SHAPE.actuate`'s code path with a different param.
- **Replay.** `foldsAtCompile` into `liquidityTargetSchedule`, like ROTH and POOL_SHAPE. No
  `applyAt`, and no mid-run mutation of a graph anywhere.
- **Gate.** A graph (or schedule) with at least one sized pool, and `liquidityGraphEnabled` on.

### 2.4 What is deliberately not proposed

- **Mutating the graph mid-run from `MpcDecisionScheduleReducer.applyAt`.** Rejected: the flow
  reducers read constructor-held graphs, and the shape reducer would overwrite the stamp at its
  next switch. That is two writers on one compiled artefact, the shape design 109 §8 refuses.
  The schedule is the single authority.
- **Auto-generated scaled shapes** (let `POOL_SHAPE` choose between the base graph and derived
  ×0.5 / ×2 copies). Combinatorial in pools × factors, and it would put machine-made shapes into
  the author's `liquidityShapes`.
- **Absolute targets in rows.** Discussed in §2.1.

## 3. Phasing

1. **Resolver + reducer.** Target rows become step-function entries; `stepKey` in the shape
   reducer. Acceptance: all goldens byte-identical with no rows. With rows, a t₀ compile applies
   each at its 1 January, and a PERCENT overflow is refused with the normalizer's sentence.
2. **Param + editor + help.** The typed row list (pool options from the live graph and shapes),
   the param description, and a `help/` topic line. The design 110 hygiene preflight
   (`poolAxisProblems`) also reports rows that would be refused.
3. **The control.** `POOL_TARGET` in `COCKPIT_CONTROLS` + `LEVER_SCHEDULE` (gate, scaffold,
   variables, describe, actuate, fold).
4. **Proof on a real plan.** Gate test cases (a row decided at an epoch reaches the rollout;
   KNOWN_BROKEN stays empty), PSL-style no-op exactness and live-actuate ≡ compile of the saved
   schedule, and the design 39 gap lab (A′ ≡ B with the control active) on the author's plan.

## 4. Test plan (to be written with the code)

| id | asserts |
|---|---|
| DPT-1 | no rows ⇒ the resolved step function, the reducer list and the journal are identical |
| DPT-2 | a row scales the named pool from its 1 January, in every shape containing the pool |
| DPT-3 | the latest row per pool wins; rows for different pools compose |
| DPT-4 | axis × row composition; a zero-target pool gets no variable |
| DPT-5 | a PERCENT row past 1.0 is refused with the normalizer's own sentence |
| DPT-6 | a step with the same shape but new scales restamps (the `stepKey` change) |
| DPT-7 | the no-op candidate prices exactly the plan; the live actuate matches a t₀ compile of the saved rows |
| DPT-8 | the design 81 fold applies recorded rows at compile; the gate refuses a plan with no sized pool |

## 5. Open questions for the operator

1. **Factor or absolute value in a row?** Proposed: factor (§2.1).
2. **Does a scale row persist across a later shape switch?** Proposed: yes, for as long as the
   pool id exists (§2.1). The alternative is that a switch resets the pool to the new shape's
   authored target, which makes a row mean "until the next shape change".
3. **One variable per sized pool, or one pool chosen per session?** Proposed: one per sized pool.
   On a plan with many sized pools that widens the search. The cockpit's control-range config
   could instead name the pool(s) to decide.
4. **Axis × row, or row replaces axis?** Proposed: multiply (§2.2).
