# 109 — Time-varying pool shapes: named shapes, and a schedule that selects one

**Status:** **BUILT** — all six phases, 18 Sep 2026 (§16). Design 97 built a liquidity graph
that is authored once and holds for the whole run. This design makes the *shape* of that graph a function of time — the same
authoring move `yieldCurveSchedule` and `allocationGlidepath` already make for a value — and
its whole difficulty is that a pool graph is not a value: four live objects are **built from
it** at t=0 and never ask again.

Companion: design 97 §22 (the accessibility axis) and §24 (its corrected build plan). The two
are independent and can be built in either order, but §24 lands first in the phasing here
because a schedule that switches between wrapper-claiming shapes is unreadable until the cover
figure is honest.

## 1. The ask

> We should be able to define the pool shape over time. Much like the glidepath where you
> select a year and then choose the shape. This implies that we can create multiple pool
> shapes and then select them + assign them to a start year when they take effect; only one
> shape can be active for the same pool at the same time.

The financial content behind it is the reason design 97 exists at all. A plan does not want
one reserve policy for forty years:

- **Accumulation** wants almost no reserve. Cash is a drag, the paycheck covers the spend, and
  the growth pool is the whole book.
- **The early-retirement bridge** wants the largest reserve it will ever hold, because it is
  the stretch with no wage, no Social Security and — until §22's gates open — no wrapper.
- **Post-gate** wants a different *composition*, not merely a different size: the wrappers
  become claimable (design 97 §22.2), so the pool that was "sell taxable equity" becomes
  "spend the 401(k) while it is accessible".
- **Post-mortality / post-house-sale** wants the graph re-plumbed: a pool whose claims name an
  account that no longer exists is not a smaller pool, it is a different graph.

Today each of those is a **separate scenario file**, and comparing them is a study rather than
a plan. That is the gap.

## 2. What the graph is today: resolved once, at build

Measured, because the whole design turns on it.

`resolveLiquidityGraph(params, accounts)` (`src/finance/pools/liquidity-graph.js:1083`) is the
one normalizer, and it has exactly four callers. Every one of them runs at **build time** and
keeps the result:

| # | site | what it freezes | read at runtime from |
|---|---|---|---|
| 1 | `us-retirement-toolset.js:689` — the state projection | `state.liquidityGraph`, and `state.drawdownSequence` via `compileToDrawdownSequence` | `state.drawdownSequence` **is** read live, by `AccountService._applyDrawdownSequence` |
| 2 | `behavioral-strategy-registry.js:264` — `TARGET_ALLOCATION` | `RebalanceToTargetReducer#poolGraph` | the instance field |
| 3 | `behavioral-strategy-registry.js:611` — `LIQUIDITY_POOLS` | `PoolFlowReducer#graph` | the instance field (`this.graph.pools` at 6 sites) |
| 4 | same | `PoolFlowApplyReducer#graph` | the instance field |

And one measured negative that decides §8:

> **`state.liquidityGraph` is written by nobody but the projection and read by nothing in
> `src/`.** A repo-wide grep finds readers only in `scripts/lib/pool-arms.mjs:329`, which uses
> it as a *liveness witness* ("no `liquidityGraph` reached state — the axis is INERT").

So the state copy is a witness, not a read path. The only compiled artefact the engine
actually consults each period is `state.drawdownSequence`. That asymmetry is the single most
important fact in this design: **re-stamping `state.liquidityGraph` alone would change
nothing, and would look like it changed everything.** It is the
`config-field-in-state-is-not-read` shape exactly, and this design would walk into it by
default.

## 3. Why the existing schedule params are not a precedent

The repo has four "per-year path" params — `allocationGlidepath`, `yieldCurveSchedule`,
`primeSchedule`, `rothConversionSchedule`. All four schedule a **value** that a live reducer
reads each period (a mix, a curve, a rate, a target). None of them schedules a **structure**
that objects are constructed from.

`primeSchedule` is the closest, and it takes the route this design must not: it *compiles into
scheduled events*. Adding events to this engine re-resolves tie order everywhere else on the
queue — a measured, repo-wide effect — so a shape switch must **not** be an event. §8.

## 4. The data structure

Two params, beside the existing `liquidityGraph`:

```
liquidityShapes:         { <shapeId>: { pools: [...], flows: [...] } }
liquidityGraphSchedule:  [ { year: <int>, shape: <shapeId> }, ... ]
```

- Each shape's payload is **exactly today's `liquidityGraph` value** — same pools, same
  claims, same flows, same validator. A shape is not a new vocabulary; it is the existing one,
  named.
- The schedule is a sorted step function: the row with the greatest `year <= Y` governs year
  `Y`. Before the first row, the **`liquidityGraph` param** governs — so an existing scenario
  with no schedule is byte-identical, and a scenario that adds a schedule keeps its authored
  graph as the opening shape rather than needing it copied into a shape.
- **Absent is absent.** No `liquidityGraphSchedule` ⇒ no new state key, no new reducer, no
  golden moves.

### Q1 — whole-graph shapes, not per-pool timelines (decided)

The ask can be read two ways, and they are not equivalent:

- **(R1) A shape is the whole graph.** One timeline; each row swaps every pool and flow at
  once.
- **(R2) A shape is one pool's settings.** One timeline per pool; pools change independently.

**R1, and the reason is referential integrity, not taste.** A flow names a `from` and a `to`
pool; `YEARS_OF_SPEND_REMAINDER` names the pools it sits behind (`spec.after`); `assignExecutors`
classifies an edge by the *types on both ends*; `assertNoUnconditionalCycle` is a property of
the whole edge set. Every one of those is a whole-graph invariant that `normalizeLiquidityGraph`
checks in one pass. Under R2 the set of live pools is a cross-product of independent timelines,
so a graph that validates in 2030 and 2040 can be invalid in 2035 — a flow into a pool that
has not started, a remainder pool naming one that has ended — and the only honest way to check
it is to enumerate every switch date and validate the composition at each. That enumeration is
R1 with the shapes derived instead of authored, and derived shapes cannot be named, diffed,
re-used between scenarios, or shown in an editor.

R1 also answers *"only one shape active for the same pool"* by construction: one timeline, one
active shape, so no two shapes can ever govern the same pool at once. Under R2 that sentence
is a validation rule somebody has to write and can get wrong.

The cost of R1 is real and should be stated: changing one pool's target in 2040 means
authoring a whole second shape. §11 pays that down with **"duplicate shape"** in the editor
rather than with a partial-override syntax, because an override layer is R2 wearing a hat —
it reintroduces exactly the cross-product the validator cannot see.

## 5. The compile: every shape, at build

`resolveLiquidityGraph` grows a sibling:

```
resolveLiquidityGraphSchedule(params, accounts)
  → null                                   // no schedule authored, or liquidityGraphEnabled === false
  → [ { fromMs, shapeId, graph }, ... ]     // sorted ascending by fromMs; entry 0 is the base graph
```

Three rules, each of which is a way this goes wrong if left implicit:

1. **Every shape normalizes at build, not on first use.** A shape that takes effect in 2045
   and does not compile must fail the scenario **now**, at load, beside the shape that does.
   Discovering it nineteen simulated years in — as a throw from inside a period advance — is
   the failure this repo names `config-field-in-state-is-not-read` one level up: the error
   arrives somewhere the author cannot associate with the thing they typed.
2. **Every shape validates against the same `accounts` list.** Claims name accounts; a shape
   that claims an account the scenario does not hold is rejected like any other bad claim.
   An account that only *exists* later (an inherited wrapper, a promoted record) is not a
   reason to defer validation — it is a reason for the claim to be legal and the pool to be
   empty, which is already how a zero-balance claim behaves.
3. **The `liquidityGraphEnabled` master switch stays in front of all of it** (§23). Off ⇒ the
   schedule resolves to `null` and every line of this design is inert, exactly as the graph is.
   `collectAuthoredGraphProblems` keeps reporting problems in **every shape** while the switch
   is off, for the reason it already does so for the graph: the switch is a run-time "ignore
   this", not an authoring-time "this is fine". Its report needs a `shape` field beside
   `pool`, or a bad cell in shape B is reported as a bad cell in shape A.

## 6. The four freeze points, one at a time

### 6.1 The two flow reducers (`PoolFlowReducer`, `PoolFlowApplyReducer`)

These hold `this.graph` and read `this.graph.pools` / `.flows` on every evaluation. The change
is mechanical and should stay mechanical: they take the **schedule** and resolve the active
graph once per evaluation, off the `asOfMs` they already compute
(`pool-flow-reducer.js:372`):

```
const graph = this.schedule ? activeGraphAt(this.schedule, asOfMs) : this.graph;
```

`PoolFlowApplyReducer` has no date of its own — it reads `from`/`to` off the action. It must
**not** re-resolve: the plan it is applying was computed by `PoolFlowReducer` under a specific
shape, and a reducer pair that disagrees about which shape is live is the `journal-entry-per-reducer`
class of defect with money in it. The plan action carries the `shapeId` and the apply side
resolves *that*, or refuses. This is the one place where the obvious change is wrong.

### 6.2 The rebalancer (`RebalanceToTargetReducer#poolGraph`)

Same shape, one extra consequence: the rebalancer *sizes* the classes its pools claim. A shape
change therefore changes the target mix on the next rebalance, which is the intended
behaviour and is also the largest observable effect of this whole feature. §10.

### 6.3 `state.drawdownSequence` — the one that actually moves money

`AccountService` reads it from state, live. Nothing in the pools layer re-stamps it. So the
switch needs a stamp, and §8 is that stamp.

### 6.4 `state.liquidityGraph`

Re-stamp it too, for the liveness witness and for the panel. It must be re-stamped **in the
same reducer, in the same patch, as the sequence** — not in a second place. Two writers on the
two halves of one compiled artefact is how the witness comes to say a shape the engine is not
running.

## 7. `activeGraphAt` — one selector, exported, and the year boundary

```
activeGraphAt(schedule, asOfMs) → { shapeId, graph }
```

A row's `year` means **the first instant of 1 January of that year, UTC**, and the entry
governs from there until the next row. A calendar year and not a period index, because that is
what the author types and what every sibling schedule param already means.

One selector, exported, called by all four consumers — the same rule `resolveLiquidityGraph`
follows and for the same reason recorded there: *"normalizing it three times with three
slightly different option sets is how the same object comes to mean three things."*

## 8. The switch is a reducer, not an event

**`PoolShapeScheduleReducer`**, registered in `US_RETIREMENT.reducers(context)`
(`us-retirement-toolset.js:1449`) — the same toolset whose projection compiled the opening
sequence, so the compile and the re-compile are owned by one authority.

- Fires on `US_PERIOD_ADVANCE` and `AU_PERIOD_ADVANCE`, like `PoolFlowReducer`.
- Resolves `activeGraphAt(schedule, asOfMs)`. If the `shapeId` equals the one already stamped
  on state, it emits **no patch at all** — so in every period of every run but the handful
  that switch, this reducer costs one map lookup and writes nothing, and the journal carries
  no diff.
- On a change it emits one patch: `{ liquidityGraph, drawdownSequence, liquidityShapeId }`.
- It is registered **only when a schedule is authored**, so a scenario without one has an
  identical reducer list and an identical journal.

**Why not an event.** A `POOL_SHAPE_CHANGED` event on the queue would be the natural-looking
design and is the one to refuse. This engine's event queue is not a total order: adding any
event re-resolves tie-breaks among events already scheduled on the same instant, which is a
measured, whole-portfolio effect and not a local one. A feature whose job is to change a
*policy* must not perturb the ordering of the *transactions*, or every A/B between two
schedules is confounded by an ordering change it did not ask for. A reducer on an advance that
already exists adds nothing to the queue.

**The consequence to state rather than discover**: a shape takes effect at the first period
advance on or after 1 January of its year, not at the instant of the new year. On a
semi-annual advance cadence that is up to six months of lag, deterministically. It is the
honest reading — the graph governs *decisions*, and decisions are taken at advances — but it
means a schedule row and a calendar year are not the same thing, and the panel should say the
date the shape actually became live, not the year that was typed.

## 9. Pool identity across a switch — the part that will bite

A pool is not only a config node. It carries **per-pool run state** on `state.liquidityPools[id]`,
and two fields of it are **history**, not a restatement of the config:

| field | what it is | what a switch does to it |
|---|---|---|
| `high` | the monotone trailing balance high, updated before the gates read it (`pool-flow-reducer.js:389`) | a drawdown gate reads `1 − balance/high`. A pool id that appears fresh has `high = 0` and **every drawdown gate on it reads 0% below**, i.e. wide open |
| `spendHistory` | the trailing spend window a `TRAILING` size spec averages | a fresh id falls back to `ctx.annualSpend`, silently reverting a `TRAILING` pool to `LIVE` for its first N years |
| `returnIndexHigh` | the same for the return-index gate variant | same |

So **pool identity across shapes is a semantic decision, and the `id` is the only handle for
it**:

- **Same `id` in the old and new shape ⇒ the same pool, continuing.** Its `high` and
  `spendHistory` carry over. This is what an author means by "the bond pool gets bigger in
  2040", and it must be the default.
- **An `id` present only in the new shape ⇒ a new pool**, starting cold. Correct, and the
  `high = 0` consequence above is the honest one: a pool that has never held anything has no
  drawdown from a high.
- **An `id` present only in the old shape ⇒ retired.** Its state entry must be **dropped**
  from `state.liquidityPools`, not carried as a stale row, or the panel and the CSV keep
  plotting a pool that no longer exists, at its last value, forever.

**This is the rule that makes `id` load-bearing across shapes, and the editor must say so.**
Renaming a pool between two shapes is a *different* pool with the same claims — an easy thing
to do by accident and an invisible thing to have done, because the new pool behaves correctly
in every respect except that its gates open wide for one period. `npm run help:gate`-style
prose is not enough here; §12 makes it a validation warning.

`pool-history.js` reconstructs the cube from journal diffs and carries the last value forward
for any field that did not change. A retired id must therefore be dropped as an explicit diff
(the key removed), or the carry-forward rule will resurrect it. That is a real edge in
`recordPoolPeriod`, not a theoretical one.

## 10. What a switch must NOT do

**No money moves on a shape change.** The patch in §8 contains a graph, a sequence and an id.
It contains no transfer, no sale, no rebalance. The new shape's targets are honoured by the
executors that already exist, at the cadence they already run: the rebalancer sizes to the new
target on its next pass, the flows fire on their next evaluation, and the draw walks the new
order on the next draw.

This is worth stating because the tempting alternative — "switch to the new shape and
immediately rebalance into it" — would make a shape change a *transaction* whose size depends
on how far the book had drifted, emitted outside the rebalancer's own gates, vetoes and
market-drawdown logic. Design 97 §20 is an extended record of what it costs to have one path
that sells without asking the gates. There must not be a second.

The observable consequence is that a shape change is gradual, and that is correct: a plan that
wants three years of cash by 2040 authors the shape that takes effect in 2037.

## 11. The editor

`buildLiquidityGraphEditor` (`structured-param-editors.js:933`) already renders the three flat
tables (pools, claims, flows) for one graph. The schedule editor is the
`buildYieldCurveScheduleEditor` pattern (`:504`) one level up — a year band whose payload is
the existing editor rather than a nested shape table:

- A **shape list**: named shapes, each row expanding to the existing three-table editor.
  `+ Duplicate` beside `+ Add`, because §4's Q1 makes duplication the intended way to express
  "the same graph with one number changed", and re-typing four tables is how ids drift (§9).
- A **schedule table**: `[{ year, shape }]`, shape a select over the shape ids, sorted by year,
  with the base `liquidityGraph` shown as the implicit row 0 so the author can see what governs
  before the first switch.
- On each shape, a **diff-against-previous** line: pools added, pools retired, pools continued.
  This is the §9 rule made visible at the moment of authoring, and it is the single highest-value
  thing on the screen. A renamed pool shows up as one retired and one added, which is exactly
  the mistake it exists to catch.

Design 97 §22.5's two default traps apply unchanged to a new shape's pools and are fixed there.

## 12. Validation

Beyond "every shape compiles" (§5):

1. **Duplicate `year` in the schedule** ⇒ reject. Two rows cannot both start a year, and
   last-writer-wins would be a silent choice.
2. **Unknown `shape` id** ⇒ reject, naming the row.
3. **A shape no row selects** ⇒ *warn*, not reject. An author keeping an unused shape around
   is normal; an author who forgot to schedule the shape they just wrote is the common case,
   and this is the only signal they get.
4. **A pool id that disappears and later reappears** ⇒ *warn*. Under §9 that is a retirement
   followed by a cold restart, which is almost never what was meant, and its symptom (a gate
   reading 0% below its high for one period) is invisible.
5. **The two-authorities rule extends to the schedule.** Authoring both a graph-or-schedule and
   a hand-written `drawdownSequence` already throws (§6); the schedule is the same authority
   and throws the same way.
6. **A claim on an account no shape holds** is already caught per shape (§5 rule 2).

All of these go through `collectAuthoredGraphProblems`, which needs the `shape` field from
§5 rule 3 to localise them.

## 13. Test plan

1. **Absent ⇒ byte-identical.** No `liquidityGraphSchedule`: no new state key, no reducer in
   the list, every golden fixture unchanged. This is the gate on the whole design and is
   checked with the existing whole-state fixtures, not with a new assertion.
2. **A schedule whose every row names the same shape as the base graph** also produces a
   byte-identical run — the reducer fires, finds no change and writes nothing. This separates
   "the reducer exists" from "the reducer moves something".
3. **`activeGraphAt` unit cases**: before row 0, exactly on a boundary, between rows, after the
   last row, empty schedule, single row.
4. **The switch lands at the first advance on or after the boundary** (§8), for both a US and
   an AU advance cadence, asserted on the stamped `liquidityShapeId`.
5. **`state.drawdownSequence` actually changes** and a draw taken after the switch follows the
   new order. Asserted on the *draw*, not on the stamp — §2's measured negative is precisely
   that stamping a field nothing reads proves nothing.
6. **Pool identity (§9)**: a continued id keeps its `high` and `spendHistory`; a new id starts
   cold; a retired id is removed from `state.liquidityPools` and stops appearing in
   `poolHistory`.
7. **`PoolFlowApplyReducer` resolves the plan's `shapeId`** (§6.1), including the case where a
   plan is applied across a switch boundary.
8. **A bad shape scheduled for 2045 fails at load**, with the shape named.
9. **Validation §12 1–4**, each as its own case.
10. **`liquidityGraphEnabled: false`** makes the schedule inert while
    `collectAuthoredGraphProblems` still reports a bad cell in shape B, localised to shape B.

## 14. Phasing

1. **Design 97 §24** — the accessibility fix. Not strictly a dependency, but the first thing
   anybody will schedule is a pre-gate shape and a post-gate shape (§1), and until `accessible`
   is honest the two arms cannot be compared. Build it first.
2. **`liquidityShapes` + `liquidityGraphSchedule` + `resolveLiquidityGraphSchedule` +
   `activeGraphAt`**, with validation. No consumer changes. Authorable, inert, and every shape
   is already proven to compile. **BUILT (18 Sep 2026)**: 6864 unit (23 new, PSS-1..8) + 1550
   viz green; no consumer reads any of it, so nothing can have moved.

   `_graphOptsFrom` was split out of `_normalizeFromParams` so every shape normalizes under the
   IDENTICAL option set as the base graph — otherwise two shapes in one scenario would mean
   different things, which is the failure `resolveLiquidityGraph`'s own doc comment records for
   three call sites and this would have reintroduced for N shapes. That is also what makes §12
   rule 5 free: PSS-8 shows the two-authorities throw reaching a shape.

   `collectAuthoredGraphProblems` reports shape and schedule problems with a `shape` field, and
   `_normalizeShapes` re-throws each shape's error with the shape named — without it, a bad cell
   in shape B carries the identical message to the same cell in shape A and the author repairs
   the wrong table.

   Two things the tests found, both about the QUALITY of a message rather than a result:
   - A `liquidityShapes` authored as an array was reported as a row naming a shape *"which is
     not in `liquidityShapes` (which is empty)"* — true, and useless: it points at the row the
     author got right rather than the container they got wrong. The container check moved into
     one `_shapesObject` guard both paths call, since `_normalizeSchedule` runs first.
   - The first draft of the help topic ran 693 words against a 400-word concept budget. It
     became its own topic (`help/concepts/pool-shapes-over-time.md`) rather than being cut —
     shapes-over-time is a distinct mechanic from the pools themselves, and the budget was
     right to say so.
3. **`PoolShapeScheduleReducer`** and the `drawdownSequence` re-stamp (§6.3, §6.4, §8, §9).
   This is the step that moves money, and it moves it through the draw order alone.
   **BUILT (18 Sep 2026)**: 6883 unit (42 in `pool-shape-schedule.test.mjs`) + 1550 viz green.

   Registered in `US_RETIREMENT.reducers(context)` — the toolset whose projection compiled the
   opening sequence, so the compile and every re-compile are owned by one authority — and
   **only when a schedule is authored**, so a scenario without one has an identical reducer
   list, an identical journal and an identical run. Deliberately NOT gated on the
   `LIQUIDITY_POOLS` strategy: the projection compiles the spend order whatever the strategy
   list says (§23's whole point), so a switch that fired only under that strategy would freeze
   the order on the opening shape in exactly the configuration where nothing else would say so.

   It runs at `PRE_PROCESS + 1`, ahead of `PoolFlowReducer` (+3) and the rebalancer (+4), so a
   switching period evaluates its flows on the shape that has just taken over rather than on
   the one it is leaving — a one-period error on a date the author chose deliberately is the
   worst place to have one.

   Two details that are the difference between working and looking like it works:
   - The no-change path goes through `newState(state)` and adds no field, so `diffStates`
     emits nothing. A schedule that has not yet fired is invisible in the journal (PSS-9).
   - Both `stamped` and `active.shapeId` are read with `?? null`, because the OPENING entry's
     id genuinely is `null` (it is the base graph, not a named shape) while an unstamped state
     has no field at all. Without the coalesce the first advance of every scheduled run would
     emit a patch that changed nothing (PSS-9c).

   PSS-13a–e run it through a real scenario load, which is the seam the unit cases cannot
   reach: PSS-13e asserts that a shape scheduled for 2099 fails the LOAD rather than a period
   seventy years in.
4. **The three instance-held consumers** (§6.1, §6.2) — flows and the rebalancer follow the
   active shape. **BUILT (18 Sep 2026)**: 6892 unit (51 in `pool-shape-schedule.test.mjs`) +
   1550 viz green; all 15 golden fixtures byte-identical.

   **`PoolFlowReducer`** resolves the live graph ONCE per evaluation, off the instant it is
   already deciding at, and threads it as a parameter — a second resolution inside a helper
   could see a different answer and the period would evaluate half its edges on each shape.
   `_vetoable` / `_cappable` moved from the constructor to a per-graph memo, because a veto set
   derived from the opening shape would go on vetoing pools a later shape does not have.

   **`PoolFlowApplyReducer`** does NOT re-resolve, per §6.1. The plan carries the `shapeId` it
   was computed under and the apply side looks that up; a shape it cannot find applies NOTHING
   rather than falling back, because a refill applied against the wrong pool's claims draws
   from accounts the author never put in that pool.

   **The rebalancer took a better route than §6.2 specified.** The design proposed the same
   instance-field threading as the flow reducer. It instead reads `state.liquidityGraph`, with
   its own field as the fallback for a hand-built state. It runs at `PRE_PROCESS + 4` and the
   shape switch at `+1`, so the field is already current — and this turns §2's measured
   finding, that `state.liquidityGraph` was written by the projection and read by nothing in
   `src/`, from a liveness witness into a real read path. Threading instead would have left the
   witness decorative and given the schedule a second place to be interpreted. It also fixes a
   case threading could not: a plan whose pools only BEGIN at a later shape has a null
   `poolGraph` at build, which an instance-field reading would have left permanently
   pool-blind (PSS-16b).

   The flow-reducer registration now runs when EITHER a graph or a schedule resolves, for the
   same reason.
5. **The editor** (§11). **BUILT (18 Sep 2026)**: `buildLiquidityShapesEditor` and
   `buildLiquidityGraphScheduleEditor`, 10 new viz cases.

   Each shape holds the EXISTING three-table graph editor over its own value — one vocabulary,
   not two, or the shape editor and the base editor would drift. `+ Duplicate` sits beside
   `+ Add` rather than in a menu, because §4 Q1's cost is that a one-number change means a
   whole second graph, and re-typing four tables is how a pool id drifts — which §9 makes a
   silent retirement. The diff line (`N carried · added X · retired Y`) renders §9's rule at
   the moment of authoring, and a RENAMED pool shows up there as one retired and one added,
   which is exactly the mistake it exists to catch.

   The schedule table draws the base graph as an explicit row 0. Without it the table says
   "the bridge starts in 2035" and leaves the years before it looking unauthored, when
   `liquidityGraph` governs them. The shape cell is a select over live ids, and a row pointing
   at a deleted shape keeps its value and is marked rather than silently re-pointed.

6. **The panel**: the shape id and its effective date on the pool cube, and the cube's handling
   of retired ids. **BUILT (18 Sep 2026)**: 6892 unit + 1563 viz green, all 15 goldens
   byte-identical.

   `pool-history.js` replays `liquidityShapeId` off the ordinary diff path, so the first period
   carrying a new value IS the period the switch landed on, and the strip reports **that date,
   never the authored year**. §8's lag is real — up to six months on a semi-annual cadence —
   and a strip showing the year next to a run that had not switched yet would be the clearest
   possible way to misread it. A run with no schedule adds no key and the strip is unchanged.

---

## 16. Status

**All six steps built, 18 Sep 2026.** 6892 unit + 1563 viz green; all 15 whole-state golden
fixtures byte-identical, which is the assertion that matters — the sim is bit-deterministic, so
a scenario without a schedule that moved at all would have moved a fixture.

The three open questions in §15 are unchanged and none was answered speculatively: Q1 (the
switch year as an MC/optimiser lever) is still deferred, Q2 (event-selected shapes) is still
deliberately unanswered, and Q3 (an empty shape) falls out of the data structure — a shape with
no pools is legal today and compiles to no spend order, which `PoolShapeScheduleReducer` stamps
as a null sequence rather than leaving a stale one standing (PSS-11b). Whether that SHOULD be
legal is the sentence §15 asks for and it has not been written.

Steps 2 and 3 are separately shippable and separately verifiable, which is the point of the
split: step 2 cannot change a run, and step 3 changes exactly one thing.

## 15. Open questions

- **Q1 — the switch year as a lever.** The obvious sweep is *"what does moving the bridge shape
  two years earlier do"*, which wants `liquidityGraphSchedule[i].year` as an MC/optimiser axis.
  Nested paths into an object param are the known trap here — a dotted key is dropped by the
  param `set()`, and an axis that reads as authored and is inert is this repo's most expensive
  recurring defect. The likely answer is a flat scalar companion param rather than a path into
  the array, and any liveness gate for it must be evaluated against a **loaded** config, not
  an authored one. Deferred until §14 step 4 is green; not built speculatively.
- **Q2 — mortality and the house sale.** §1 names "the graph is re-plumbed when an account
  disappears" as a motivating case, but a shape schedule is keyed on a *year*, and a death is
  keyed on an *event*. A shape whose claims name an account that no longer exists is legal and
  empty (§5 rule 2), so nothing breaks — but nothing adapts either. Whether shapes should be
  selectable by a condition as well as a year is a real question and is deliberately **not**
  answered here: a conditional shape re-introduces the "which shape is live" ambiguity that §4
  Q1 spent its whole argument removing, and it should be argued on its own evidence.
- **Q3 — does a shape need to be able to say "no pools at all"?** An empty shape would mean
  "stop running the graph from 2050", which today is only expressible by turning
  `liquidityGraphEnabled` off for the whole run. It falls out of the data structure for free
  and costs one validator decision (is `{ pools: [] }` a graph or an error?), but the
  interaction with the remainder rule — everything unclaimed falls back to `drawdownPriority`
  order — deserves a sentence before it is allowed rather than after.
