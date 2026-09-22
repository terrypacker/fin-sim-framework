# 112 — Dated pool targets: a pool size the MPC can decide

**Status:** ACCEPTED — 21 Sep 2026, ready to build. Every §5 question is answered and folded
into §2–§4: Q1 is the factor plus two properties borrowed from authored levels (§5.1). The §6
review findings are all folded in, R11–R13 included. §7 is a follow-up outside this design's
scope. Nothing is built. Answers the last open item of design 39 §14.10:
`pool.<id>.targetScale` as an MPC control (design 110 §13.11).

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
liquidityTargetSchedule: [{ year, pool, scale, by? }]
```

One row sets pool `pool`'s target to `scale` × its authored target, from 1 January of `year`
until the next row for the same pool. A new authored param, `LiquidityTargetSchedule`, edited
as a flat typed row list (year · pool select · factor), not a JSON textarea. Absent or empty
means byte-identical to today, which every golden asserts.

`by` is provenance only (R12). An MPC actuate writes the session's id there, and a hand-written
row has none. The resolver ignores it, so it cannot change a run. The row editor shows it as a
mark on the row, so the author can see which rows the author wrote and which a session wrote.
An MPC upsert for a year that already has a hand-written row for that pool still replaces it,
as `POOL_SHAPE` does. The mark is what makes that visible afterwards.

**Why a factor rather than an absolute target.** It is mode-agnostic (`YEARS_OF_SPEND`,
`AMOUNT` and `PERCENT` all scale the same way), it shares units and range with the existing
axis (`POOL_TARGET_SCALE_RANGE`), and it survives an author retuning the base target. An
absolute value would silently override a later edit to the base graph.

**Why per pool, not per shape.** Design 110 §6.4 already decided that a pool id is the pool's
identity across shapes, so an axis keyed on the pool moves it in every shape containing it. A
row follows the same rule: it is about the pool, so it persists across a later shape switch for
as long as the pool exists. That is what "hold a bigger buffer from 2045" means. **Decided
(§5 Q2).** A row naming a pool that the shape in force does not contain does nothing while that
shape governs, and applies again if a later shape brings the pool id back. The id is the pool,
so the pool's absence is a gap in the pool, not the end of the row.

### 2.2 Resolution: more steps in the same step function

`resolveLiquidityGraphSchedule` already returns a sorted step function `[{fromMs, shapeId,
graph}]`, and every consumer (the shape reducer, both flow reducers, `liquidityStateAt`) selects
from it by date. Target rows become more steps. At each row's 1 January, a new entry repeats
the shape then in force, with the scaled targets of every pool that has a row in force applied
to a copy of its graph, normalized exactly as an authored graph is (design 110 §17.2: no second
validator, no clamp).

The rule has to hold at every step, not only the steps a row creates. The resolver merges
two sorted date lists, shape switches and target rows, into one. **Every** entry, whichever
list produced it, gets the shape in force at its date with the row scales in force at its date.
A shape switch after a row therefore carries the row's scale into the new shape (Q2). If each
row step stamped scales only on itself, the row would silently end at the next switch.

A row's factor is relative to the **authored** target, not to the previous row. A 1.5 row
followed by a 1.2 row means 1.2 × authored, not 1.8. The latest row per pool replaces the
earlier one (DPT-3), which is what makes the scaffold in §2.3 ("the factor already in force")
well defined.

One change is needed in the reducer. `PoolShapeScheduleReducer` restamps only when
`liquidityShapeId` changes, and a scale step keeps the same shape. Each entry therefore gets a
`stepKey` (shape id plus a signature of the scales in force), the reducer compares `stepKey`,
and `liquidityShapeId` is stamped exactly as today. A scenario with no target rows has one
`stepKey` per shape, so the reducer's behaviour, the journal and every golden are unchanged.

**A scale step is stamped where it can be read (R11).** Beside `liquidityShapeId`, the reducer
stamps `liquidityTargetScales: { <poolId>: factor }`, the row factors in force, excluding the
axis, which is constant for the run. The field is **absent** when no row is in force, not `{}`,
so a plan without rows has the same state and the goldens hold. A scale step then shows in the
journal as a small, named diff ("cash 1 → 1.5") instead of a graph-sized one with no readable
cause. The Pools panel marks the step on its timeline the way it marks a shape switch
(design 110's rule that a change to a pool must not look like nothing happened).

**Composition with the hidden axis.** Effective scale = axis factor × row factor. **Decided
(§5 Q4).** The axis stays what it is, a whole-run overlay for the optimizer, the MC grid and
design 100's lever grid, and a row is a dated decision on top of it. An MPC session's rows then
remain meaningful under an MC sweep of the axis. The cost is that the PERCENT ceiling becomes a
property of the product: a row that is valid at axis 1.0 can be refused in a cell that sweeps
the axis to 2.0. That is §17.2 working as designed (the cell fails loudly), and §2.5 says who
warns about it.

### 2.3 The MPC control: `POOL_TARGET`

Built on the `POOL_SHAPE` template (design 39 §14.9.9), which already solved the three hard
parts:

- **Variables: one per pool in a search list. Decided (§5 Q3).** The control's range config
  carries, besides the usual `{min, max, step}`, a `pools` list naming the pools to decide.
  Absent means every eligible pool. The cockpit edits it as a checkset over the eligible pools
  (row-list-editor, live options), so a session on a plan with many pools can be narrowed to the
  one or two that matter. A pool is **eligible** when its target is non-zero in some step that
  falls inside the rollout horizon from the decision date. That is narrower than
  `scalablePoolTargets`' "non-zero in some shape": a pool sized only in a shape that takes over
  after the horizon ends would be a variable whose every value prices identically, which is the
  design 110 §13.10 dead-axis defect again. A pool named in the list but ineligible at this epoch
  is skipped, and `describe` says so rather than dropping it silently. **Each list entry carries
  its own range** (§5.1): `pools: [{ pool, min?, max? }]`. A missing bound falls back to the
  control's `{min, max}`, then to `POOL_TARGET_SCALE_RANGE`, and `step` is control-wide. For a
  `PERCENT` pool the range is further capped at the factor the normalizer would refuse, which
  `poolAxisProblems` already computes, taken against the axis value the session runs at (Q4).
  The editor shows each bound in the pool's own units beside the factor (see "Legibility"
  below), so a bound is set as "1y–4y", not guessed as "0.5–2".
- **Legibility (§5.1).** Wherever a factor is shown, the resolved size in the pool's own mode
  comes first and the factor second: "cash 3y (×1.5)". That covers the search list, `describe`,
  the row editor and the Pools panel. It is resolved against the authored target in the shape
  in force at the row's year. Where a pool appears in several shapes it lists each one, as
  `describeAuthored` already does for the axis ("cash 3y / 6y (×1.5)"). A REMAINDER pool shows
  its resolved residual (§2.5). One formatter serves all four places, extended from
  `describeAuthored`, so the four cannot disagree.
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
- **Absolute targets in rows.** Discussed in §2.1 and §5.1.

### 2.5 What a factor does to the rest of the pool vocabulary

A pool's size is set by four target modes and bounded by four capacity modes. A factor touches
only `target.value`. Two of the target modes and three of the capacity modes then change what
the factor means, and neither design 110 nor the draft above said so. Everything in this
subsection applies equally to the existing axis. The row makes it matter more, because an MPC
variable that does less than its label claims gets searched every epoch.

- **A REMAINDER pool scales its aggregate, not its residual.** `YEARS_OF_SPEND_REMAINDER` is
  `max(0, value × spend − Σ contribution(after))`, and the factor multiplies `value`. On a 6-year
  aggregate behind 4 years of other pools, the residual is 2 years. A factor of 1.5 makes the
  aggregate 9 and the residual 5, which is 2.5× the residual. `describe` has to show the
  resolved residual, not "×1.5".
- **Scaling a pool that a REMAINDER pool sits behind moves the total by nothing.** A referenced
  pool that has a target and no real ceiling contributes its **target** to the remainder. So
  scaling it up shrinks the remainder one for one, and the aggregate reserve is unchanged
  until the remainder hits zero. The variable is then a **mix** lever (cash against bonds), not
  a **size** lever. That is a legitimate thing to search, but it is not what the label says. A
  referenced pool with a real ceiling contributes what it `utilised` instead, so scaling its
  target moves the remainder only through what the refills actually achieve. `describe` and the
  hygiene report name the REMAINDER pool that absorbs the change.
- **A capacity ceiling makes the top of the range flat.** `AMOUNT` and `YEARS_OF_SPEND`
  capacities are authored ceilings, and `OFFSET_CAP` is `min(cash, loan)`, which falls as the
  loan amortises. Scaling a target above its ceiling changes nothing: the pool is capped, so the
  search sees a plateau and picks arbitrarily across it. The factor does **not** scale capacity.
  A ceiling is a fact about the account (an offset cannot usefully hold more than the loan), not
  a size policy. The hygiene report flags a range whose top exceeds an authored static ceiling.
  For `OFFSET_CAP` it adds the sentence that the ceiling falls on the loan's schedule, so a factor
  that fits today may be flat in ten years.
- **The floor is left as authored.** A floor is a protection policy ("never take this pool below
  X"), not a size. A factor that takes the target below the floor produces a pool whose refills
  stop short of what it refuses to release. That is not refused, but it is reported.

These are four hygiene rows (design 110 §6.5 vocabulary: CONFOUNDED for the REMAINDER pair,
INERT for the plateau, REFUSES is already there for PERCENT) and one `describe` obligation.
None of them changes the engine.

## 3. Phasing

1. **Resolver + reducer.** Target rows become step-function entries; `stepKey` in the shape
   reducer, which also stamps `liquidityTargetScales` (R11). Acceptance: all goldens byte-identical with no rows. With rows, a t₀ compile applies
   each at its 1 January, and a PERCENT overflow is refused with the normalizer's sentence.
2. **Param + editor + help.** The typed row list (pool options from the live graph and shapes),
   with the `by` mark (R12). The display collapses consecutive rows for one pool that carry the
   same factor into one line ("cash ×1.5, 2031–2040") (R13). Storage keeps every row, so
   a replay is unchanged. The shared size-then-factor formatter (§2.3), the param description,
   and a `help/` topic line. The design 110 hygiene preflight
   (`poolAxisProblems`) also reports rows that would be refused, plus the four §2.5 rows, which
   apply to the existing axis too. The param goes in the toolset schema, not only in the
   registry. `forwardToolsetOverrides` drops non-schema bag keys, and MC and the optimizer
   build from the forwarded bag, so a registry-only param would be inert under both.
3. **The control.** `POOL_TARGET` in `COCKPIT_CONTROLS` + `LEVER_SCHEDULE` (gate, scaffold,
   variables with the per-pool-ranged `pools` search list, describe, actuate with `by`, fold), plus its `inertWhen` and
   a lever-hygiene row, the design 39 §14.8 pair every cockpit lever now carries.
   `lever-schedule.js` may import leaf modules only (design 81 §16.5), and
   `pool-target-scale.js` imports the gate and shape-year axis modules. So the fold takes
   the row list as data, or the scaling helpers move to a leaf, which should be decided when
   the phase starts.
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
| DPT-9 | a shape switch after a row carries the row's factor into the new shape; a row for a pool the in-force shape lacks is dormant, then applies when the pool returns |
| DPT-10 | the `pools` search list narrows the variables; absent ⇒ every eligible pool; a pool sized only beyond the rollout horizon gets no variable |
| DPT-11 | a REMAINDER pool's `describe` shows the resolved residual; scaling a referenced pool leaves the aggregate unchanged and the hygiene row names the absorbing pool |
| DPT-12 | hygiene flags a range whose top exceeds an `AMOUNT` / `YEARS_OF_SPEND` capacity, and a factor that takes a target below its floor |
| DPT-13 | a per-pool `{min, max}` bounds that pool's variable; missing bounds fall back control → `POOL_TARGET_SCALE_RANGE`; the PERCENT cap still applies inside it |
| DPT-14 | the formatter shows size-then-factor per shape ("3y / 6y (×1.5)") and the REMAINDER residual; `describe`, the editor and the panel use it |
| DPT-15 | `liquidityTargetScales` is absent with no rows in force (goldens hold) and is stamped on a scale step |
| DPT-16 | `by` never changes a run (a row with and without it resolves identically); an actuate writes it |
| DPT-17 | the editor collapses equal consecutive rows in display only; the saved param keeps every row |

## 5. Operator answers (21 Sep 2026)

1. **Factor or absolute value in a row?** Open. The operator's view is that the factor is the
   best candidate so far, because it has an upper and lower limit the controller can work with.
   The concern is that it adds another way to configure a pool's size on top of four capacity
   modes and four target modes. §5.1 laid out an alternative (authored levels). **Decided: the
   factor, plus two things borrowed from levels**, a per-pool range in the search list and
   size-first display (§2.3).
2. **Does a scale row persist across a later shape switch?** **Yes**, for as long as the pool id
   exists (§2.1, §2.2). The operator added a follow-up: shapes should be able to reference pools
   from an earlier shape instead of redefining them. That is outside this design and is recorded
   in §7.
3. **One variable per sized pool, or one pool chosen per session?** **Per sized pool, drawn from a
   "list of pools to search"**, so the UI can narrow the search (§2.3).
4. **Axis × row, or row replaces axis?** **Multiply** (§2.2).

### 5.1 Q1 — an alternative to the factor: authored target levels

**The idea.** The factor is the MPC inventing a new number. The alternative is the author
writing the few sizes a pool may take, in the pool's own units, and the MPC choosing among
them. A pool's target gains two optional companions, a `low` and a `high` value in the target's
own mode, beside the `value` that is the plan:

```
target: { mode: YEARS_OF_SPEND, value: 2, low: 1, high: 4 }
```

The control's variable per pool is then an enum of `low | plan | high` (the `POOL_SHAPE`
template exactly, with no numeric range). A row records the level name:
`{ year, pool, level: 'high' }`. Each shape that contains the pool resolves `high` to its own
`high`, so the bridge shape's 4-year buffer and the base graph's 2-year buffer can each have
their own high. The shape-to-shape profile is whatever the author wrote, not a ratio the factor
imposes.

**What it buys:**

- **No new vocabulary.** A level is a target value in the mode the author already chose. The
  panel reads "cash: high = 4 years", never "×1.25", and there is no fifth way of saying how big
  a pool is. The operator's objection to the factor goes away.
- **Bounds by construction, and the author sets them.** The controller still has a lower and
  upper limit, and they are the author's limits for this pool, not a global 0.5–2.
- **Validated at load, like shapes.** Every level is compiled beside its shape when the plan
  opens (design 109's rule). A `PERCENT` high above 1.0 fails when the plan is opened, not as a
  hole in a grid, and the §2.5 capacity and floor checks become load-time checks on known
  values. The whole REFUSES category disappears for this control.
- **A zero target can be searched.** `value: 0, high: 1` is a pool that holds nothing unless the
  controller decides otherwise. The factor cannot express that at all (design 110 §13.10).
- **Opt-in is the search list.** A pool with no `low`/`high` offers no levels and is not a
  variable. That is Q3's "list of pools to search", declared where the pool is defined.

**What it costs:**

- **Authoring.** Nothing is searchable until someone writes levels, in every shape the pool
  appears in (or the shape inherits them, which §7 would make easy). The factor works on every
  plan as it stands today.
- **Coarse.** Three sizes per pool. More levels fix that and cost more to write.
- **Two representations of one idea.** The hidden axis stays a factor (it has to: the optimizer
  and the MC grid want a continuous, un-authored sweep). Composition still works: the effective
  target is the axis factor × the chosen level's value. But the MPC and the grid describe a
  pool's size in different terms.
- **Edits move recorded decisions**, exactly as with the factor. Retuning `high` from 4 to 5
  changes what a recorded `high` replays as. That is a tie, not a point against either.

**Rejected variants, for the record.** An *additive* offset in years of spend (+1 year) is
mode-agnostic at runtime and can lift a zero target, but it has no natural upper bound, and in a
`PERCENT` pool it mixes two units. An *absolute* target in the row (the original Q1) is the
most legible option, but it flattens the shape profile after the row, and it is undefined for a
pool whose mode differs between shapes.

**Decided (21 Sep 2026): keep the factor, and take levels' two best properties.** The factor needs no
authoring, is the same object as the existing axis, and is continuous. What levels do better is
legibility and author-set bounds, and both can be had without a new target field:

1. The Q3 search list carries a per-pool `{min, max}` factor, defaulting to
   `POOL_TARGET_SCALE_RANGE`. That gives author-set bounds per pool.
2. Every place a factor is shown (the search list, `describe`, the row editor, the Pools panel)
   shows the resolved size in the pool's own mode first, with the factor second: "cash 3y
   (×1.5)". `describeAuthored` already does half of this for the axis. That is the legibility.

What the hybrid cannot do is search a zero-target pool. If that turns out to matter on the
author's plan (a bridge shape that holds nothing in the base graph and should be decidable), levels
are the way to get it, and they can be added later beside the factor without undoing anything.

## 6. Review pass (21 Sep 2026)

One read of the design against the code as it stands (`pool-target-scale.js`,
`pool-axis-hygiene.js`, `pool-metrics.js`, `liquidity-graph.js`, `cockpit-controller.js`,
`lever-schedule.js`, `pool-shape-schedule-reducer.js`). Folded into the body:

| # | finding | where |
|---|---|---|
| R1 | §2.2 created scaled entries only at row dates. A later shape switch would have dropped the scales, so a row would silently end at the next switch, contradicting Q2 | §2.2 |
| R2 | "Latest row wins" never said whether factors compound. They do not: each is relative to authored | §2.2 |
| R3 | "Non-zero target" as eligibility used `scalablePoolTargets`' any-shape test. A pool sized only after the rollout horizon would be a dead variable | §2.3 |
| R4 | REMAINDER targets: the factor scales the aggregate, not the residual, and scaling a pool behind a REMAINDER pool leaves total cover unchanged. That applies to the existing axis too | §2.5 |
| R5 | Capacity ceilings (`AMOUNT`, `YEARS_OF_SPEND`, `OFFSET_CAP`) make the top of a range a plateau. `poolAxisProblems` checks none of them | §2.5 |
| R6 | The floor is not scaled and nothing reports a target scaled below it | §2.5 |
| R7 | Under Q4 the PERCENT ceiling depends on the axis value too | §2.2, §2.3 |
| R8 | The new param must be in the toolset schema, or MC and the optimizer drop it (the pool-axis forwarding defect) | §3 |
| R9 | `POOL_TARGET` needs `inertWhen` + lever hygiene (design 39 §14.8) | §3 |
| R10 | `lever-schedule.js` is leaf-imports-only and `pool-target-scale.js` is not a leaf | §3 |

The operator agreed R11–R13 on 21 Sep 2026. They are folded into §2.1 (R12), §2.2 (R11) and §3
(R12, R13), and tested by DPT-15 to DPT-17. The findings as raised:

- **R11 — a scale step is hard to see.** A shape switch shows in the journal as a change of
  `liquidityShapeId`. A scale step keeps the id and changes only the stamped graph, so the diff
  is a graph-sized blob with no readable cause. Proposal: stamp the scales in force beside the
  id (`liquidityTargetScales: { <poolId>: factor }`, absent when empty so goldens hold) and have
  the Pools panel mark the step. That is cheap, and it matches design 110's rule that a change to
  a pool must not look like nothing happened.
- **R12 — the authored-row editor and the cockpit write the same param.** An author's
  hand-written 2045 row and an MPC upsert for 2045 collide, and the upsert wins (the same thing
  happens with `POOL_SHAPE` today). That is acceptable if the row editor marks rows written by
  an MPC session. Worth one line in phase 2.
- **R13 — rollout horizon vs. decision cadence.** A row decided at an epoch persists until the
  next row for that pool. If the MPC re-decides every year, the schedule accumulates a row per
  pool per year. That is correct and replayable, but the row editor should collapse runs of an
  equal factor when it displays them, not in storage, so the replay is unchanged.

## 7. Follow-up (not this design): shapes that reference pools

Raised by the operator with Q2. Today a shape is the whole graph (`liquidityShapes` help: "A shape
is the WHOLE graph, not one pool's settings"), so a pool carried unchanged into three shapes is
written three times, and an edit to it has to be made three times. Nothing checks that the
copies agree, and a copy edited in one shape only is how a pool silently diverges.

The follow-up is **reference by id at authoring time, whole graph at load**. A shape could write
`{ ref: 'cash' }` (or `{ ref: 'cash', from: '<shapeId>' }`) in its pool list, and the loader would
expand it into the full pool definition before normalizing. The whole-graph rule survives
intact: what is compiled, validated and cycle-checked is still one complete graph per shape. The
reference is sugar in the authored form, not a per-pool timeline, so the argument in design 109
(a per-pool timeline lets a combination that validates in 2030 and 2040 be invalid in 2035) does
not apply. Questions for that design: whether a reference may override fields
(`{ ref: 'cash', target: … }`), whether flows can be referenced too, and how the editor shows an
inherited pool against a local one. It would also make §5.1's levels cheap to author, if levels
are ever wanted. This belongs in its own design doc, numbered when it is picked up.
