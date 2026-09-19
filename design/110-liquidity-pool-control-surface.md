# 110 — The liquidity pool control surface (design 97 §14, effort 2)

**Status:** **PHASES 1–3 AND 3b BUILT** (19 Sep 2026); 4–9 proposed. §10 records the first review
(18 Sep 2026): three of the five open questions decided, one closed, and one — the
shape-spanning axis — promoted from a labelling question to a **precondition of phase 6**
(§10.3), which §10.3 now answers. §13 records what the build changed.

Design 97 §14 is eleven lines and a seven-row table. It sketched effort 2 far enough to name
what effort 1 must not foreclose, and then four separate builds happened *against* that sketch
without revising it: the three flat tables (§17), the Liquidity Pools panel (§21), the
afforded/ask pair (§23.5–§23.6), the accessibility axis (§24) and the shape schedule
(design 109). The sketch is now the least accurate description of the control surface in the
repository, and the gap it names — "the optimizer/MPC surface that searches pool sizes and gate
thresholds" — is the only one of its three legs that is still entirely absent.

This document does three things: it **audits §14's constraint table against the code as built**,
it **re-states the three legs against what exists today**, and it **proposes what to build, in
order, with the arguments against each**.

---

## 1. §14, restated

> **What it is, roughly**: a direct-manipulation editor for the graph (drag nodes, draw edges,
> edit a pool's target inline), a pool panel showing years-of-cover and capacity over time with
> the flows as a sankey, and the optimizer/MPC surface that searches pool sizes and gate
> thresholds instead of the author guessing them.

Three legs, and they have diverged badly in maturity:

| leg | §14's sketch | today |
|---|---|---|
| **A — authoring** | drag nodes, draw edges, inline targets | three flat tables per graph, × N named shapes, plus a schedule table (§17, design 109 §11). No canvas. |
| **B — observation** | cover + capacity over time, flows as a sankey | four views, a series picker, a provenance strip, a fact-table CSV, replay-vs-live tie check (§21, §23.5–§23.6). No sankey, no topology. |
| **C — search** | optimizer/MPC over pool sizes and gate thresholds | **nothing**. `poolTarget::<poolId>` (§12.8) was never built; the whole-graph escape hatch (§16.2) lives in `scripts/lib/`, outside the app. |

Leg B overshot the sketch. Leg A took a different road on purpose and the road is longer than
it was. Leg C is untouched, and §2.4 below argues the reason it was blocked has since dissolved.

---

## 2. The audit — §14's constraints against the code as built

This is the section with a falsifiable claim in every row, and it is the reason to write the
document now rather than to start building.

| § | constraint | verdict |
|---|---|---|
| §11 | Pool and flow **ids are stable and authored**, never positional | **HELD for pools and flows. BROKEN for gate clauses** — see §2.1. Doubly load-bearing now: design 109 §9 makes the pool id the identity that survives a shape switch. |
| §11 | Nodes and edges carry an **opaque `ui` blob** the engine ignores and the serializer preserves | **HELD, and untested** — see §2.2. |
| §12.9 | The **telemetry cube is per-pool per-period** and records gated (non-)flows | **HELD and exceeded.** `firedFlows` (§21.4), `targetAfforded` (§23.5), `yearsOfCoverTarget` (§23.6), `accessible`/`locked`/`unlocksAt` (§24.3) all joined it. The cube is the healthiest thing in this feature. |
| §12.8 | Optimizable knobs are **flat `::` keys** generated from pool ids | **EXPIRED** — see §2.4. The rule was correct when written and the trap it avoids was fixed by other means. |
| §12.1 | **Capacity is derived** | **HELD.** |
| §12.8 | **`poolFlowsEnabled`** exists as an off switch for A/B | **HELD**, and joined by `liquidityGraphEnabled` (§23), which is a different switch and is documented as such. |
| §12.5 | **Cycles are legal** | **HELD.** |

Five of seven held. The two that did not are the two that matter for the remaining work.

### 2.1 The gate clause has no stable id, and that is why "search gate thresholds" is unreachable

§14's first constraint is the one everything else hangs off: *ids are stable and authored,
never positional*. It was written when a gate was a single object on a flow. §20.15 turned the
gate into a **composed condition** — a table of clause rows keyed by flow id and a branch
number — and the branch number is explicitly a **position**:

> *The OR # is a POSITION, not a label: `rowsToGate` emits one `anyOf` branch per distinct
> number in ascending order, so 1 and 3 save as — and reload as — 1 and 2*
> (`structured-param-editors.js`, `renumberBranches`)

The editor renumbers branches densely on every edit, which is the right behaviour for a table
and the wrong property for an axis. There is therefore **no address for a threshold**. An
optimizer axis on "the drawdown threshold of the harvest gate" would have to be written as
(flow, branch, ordinal), and the ordinal moves when the author adds a clause above it. An axis
that silently addresses a different clause after an unrelated edit is this repository's most
expensive recurring defect in a new costume (`legacy-alias-levers-inert-on-loaded-plan`,
`optimizer-param-key-dot-collision`).

This is the sharpest finding of the audit, and it has a cheap fix (§5.2 option A). It is also
worth noting *which* threshold this blocks: §20.13 measured **duration, not level**, as the
lever — `sustainedYears` — and §20.16 then measured a dwell sweep as a negative result. The
one knob the evidence points at is the one with no address.

### 2.2 The `ui` blob is preserved everywhere and written nowhere

`normalizeLiquidityGraph` carries `raw.ui` through on both pools and flows;
`buildLiquidityGraphEditor` reads it into its row model with a comment saying exactly why
(*"Dropping it here would silently discard a layout"*) and writes it back in `sync()`. The
constraint held. But **nothing produces a `ui` value**, one test fixture mentions the key, and
no test asserts that a graph carrying one survives an editor round trip *and* a serializer
round trip.

That is a promise, not a property. §12.9's own argument applies to it verbatim — *"a field that
is rebuilt from config on every load and silently drops is exactly how `mortgagePaymentSourceKey`
was inert for two study arms"*. Either the first thing Leg A builds asserts the round trip, or
the blob should be deleted and re-added when something writes it. **Proposed: assert it.** It
costs one test and it is the precondition for any layout-bearing view, including the read-only
one §6.2 proposes.

### 2.3 Validation is a refusal, and it short-circuits

`collectAuthoredGraphProblems` is good: it re-runs the compiler's own `sizeSpec` per field, so
the message an author sees is the sentence the compiler would have thrown, and it keeps
reporting while `liquidityGraphEnabled` is off so the switch cannot hide errors. Two
properties are worth arguing with:

1. **Field-local problems short-circuit the whole-graph pass and the shape pass.** `if
   (problems.length) return problems;` — so while any one base-graph cell is bad, every problem
   in every named shape is invisible. The stated rationale (an unlocalized re-report adds
   nothing) is right about the *whole-graph* pass on the *base* graph and does not extend to
   shapes, which are separate documents with separate cells.
2. **A shape's problems are not cell-local.** The design-109 leg catches one throw, regexes the
   shape id out of the message and reports `index: null, field: null`. So a bad percent in
   shape B is "shape B does not compile" while the same typo in the base graph highlights the
   cell. Design 109 §12 asked for localisation and got naming.

Both are small. Neither changes behaviour — only what the author is told, which is the whole
subject of this document.

### 2.4 The `::` rule expired, and the seam §16.2 named has dissolved

§12.8 mandated `poolTarget::<poolId>` with a reason: *dotted keys are silently dropped by the
optimizer's `set()`*. §16.2 then recorded why it was not built: *`BEHAVIORAL_STRATEGY_REGISTRY[k].paramSchema()`
takes no context, so it cannot see the authored pools*.

Both statements have been overtaken:

- **The dot trap was fixed for generated keys** by design 98 W0. `get`/`set` in `mc-param-paths`
  now read and write an own flat key verbatim, and write a *generated* key flat when it cannot
  be walked; the namespace list lives in `scenarios/params/generated-param-keys.js`. The `::`
  rule still stands for any **non-generated** multi-part key — which is precisely the choice
  §7.2 has to make.
- **A context-bearing generator already exists and is not `paramSchema()`.**
  `ScenarioParamGenerator.generate(cfg)` takes the whole config and emits one typed param per
  (record × template field), with a per-record cascade `node`, at Build/Rebuild time. It is how
  every per-account knob in the app exists. The obstacle §16.2 named — the strategy registry's
  context-free schema hook — is not the road any more.

So Leg C is no longer blocked on a seam. It is blocked on two decisions (§7.2, §7.3) and one
piece of hygiene (§7.5).

---

## 3. What is built, as a map

Written down because the alternative is re-deriving it, and because half of this document's
value is telling the next reader not to build these again.

| surface | where | what it is |
|---|---|---|
| Graph editor | `structured-param-editors.js` `buildLiquidityGraphEditor` | pools / claims / flows / gate-clauses as four flat tables, one graph |
| Shapes editor | same, `buildLiquidityShapesEditor` | named shapes, each expanding to the above |
| Schedule editor | same, `buildLiquidityGraphScheduleEditor` | `[{ year, shape }]`, base graph shown as the implicit opening row |
| Drawdown sequence | same, `buildDrawdownSequenceEditor` | the deprecated-but-honoured predecessor |
| Authoring validation | `liquidity-graph.js` `collectAuthoredGraphProblems`, surfaced by `scenario-tab-presenter` and `scenario-load-error-overlay` | a refusal at Load/Rebuild, listing every problem |
| Panel | `liquidity-pools-plugin.js` | cover / stock / flows / log, series picker, provenance strip, CSV |
| Cube replay | `pool-history.js` | journal-diff replay + `tiePoolHistory` (replay vs live, field for field) |
| Study generator | `scripts/lib/pool-graph.mjs` | a graph from a spec, Node only |
| Study arms | `scripts/lib/pool-arms.mjs` | shape × size × refill grid, hygiene, wealth-match assertion, Node only |

The last two rows are the ones to read before building Leg C: **the app has no equivalent of
either**, and the second one is mostly hygiene rather than mechanism (§7.5).

---

## 4. Leg A — authoring

### 4.1 The canvas question, re-asked

§14 wanted drag-nodes-draw-edges. §17.1 built three flat tables instead and gave an argument:
a pool holds a *list* of claims, splitting claims into their own table makes all three tables
flat, so all three are one shared component and none is bespoke — and *"a multi-account pool is
one more row"*, which in a nested editor would have been the awkward path.

**That argument has got stronger, not weaker, and the canvas should stay unbuilt as an editor.**
Design 109 multiplied the object: there is no longer *a* graph, there are 1 + N of them, and the
thing an author cannot see is no longer the topology of one graph but the **difference between
two shapes** — which is why design 109 §11 put a diff-against-previous line on each shape and
called it *"the single highest-value thing on the screen"*. A canvas answers a question
(what does this graph look like?) that the tables answer adequately, and does not answer the
question the author actually has (what changed in 2040, and did I rename a pool by accident?).

The honest objection: a canvas *would* make an edge's direction and a cycle legible at a glance,
and §12.5 deliberately made cycles legal. **Answer:** draw it, do not edit through it — §6.2.

### 4.2 Four things the tables cannot say, all of which are derived and read-only

None of these adds an authored field. All four are computed from values the editor already
holds, which is why they are proposed together.

1. **A pool's claims, next to the pool.** Today claims are a second table joined by id in the
   reader's head. A derived, non-editable summary cell on the Pools row — count plus a short
   rendering of the accounts and sleeves — is the join done once, correctly.
2. **What a claim would hold *today*** — **corrected, and it is the only one of the four that is
   not free.** The first draft said "the editor already receives the account list", which is true
   and not sufficient. `scenario-tab-presenter.js`'s `accountsProvider` projects each account to
   `{ stateKey, name, type, offsetsPropertyKey?, role? }`, and the projection is deliberately
   narrow — its comment explains that it carries *"every field `normalizeLiquidityGraph` READS"*,
   because `_graphProblems` validates against the same list and a missing `offsetsPropertyKey`
   there would read as "links to no property" and refuse a Rebuild the compiler is happy with.
   There is **no balance and there are no holdings** in it.

   Valuing a claim needs both. `pool-metrics.js#claimValueNative` is the authority and says why:
   *holdings are the authority when the account has any* — a sleeve-narrowed claim has no other
   reading, and a brokerage's `balance` can disagree with Σ lots (`holdings-balance-desync`). So
   the real cost is three things, not zero: export `claimValueNative`, widen the projection to
   carry `balance` plus each lot's `allocation` and `marketValue`, and decide what happens to a
   pool whose claims are in two currencies — `claimValueNative` returns the account's **own**
   currency and leaves conversion to the caller, and the editor has no rate.

   **So the readout moves.** Put it on the **Claims** row, in the claimed account's native
   currency, not as a summed figure on the Pools row. That sidesteps FX entirely, and it is
   closer to the mistake anyway: what goes wrong is per-claim — the wrong sleeve, or a claim that
   landed in the wrong pool (§22.5 trap 2, which shipped as a *default* fix precisely because
   nothing on screen said where the claim had gone). A pool-level total is the thing the panel
   already reports correctly, with FX and per-period, and it should not be approximated here.
3. **The compiled spend order, as a list.** `compileToDrawdownSequence` is pure and available.
   §22.5 trap 1 — a new pool defaulting to a `spendOrder` behind `growth`, so the author adds it,
   rebuilds, sees nothing and concludes the input is missing — was fixed by changing the
   *default*. That is prevention; it does not help the author who types 35 where they meant 15.
   Rendering the compiled order under the tables makes §3.1 rule 3 (what the sequence does not
   claim follows it in `drawdownPriority` order) visible instead of documented.
4. **A gate, as one sentence.** The clause table is honest and unreadable: a two-branch gate with
   a dwell is four cells across three rows, and the author has to assemble the meaning. One
   derived line per flow — the same rows, rendered as prose — costs nothing and is checkable
   against what the author meant. It also makes §12.4c's scope (SOURCE vs EDGE) legible, which
   is a distinction the panel reports on separately (`vetoed` vs `capped`) and the editor
   currently states only as a select.

**The argument against all four:** every derived display is a second derivation, and §23.6's
`_seriesSpecs` refactor exists because two derivations is the shape where one surface disagrees
with the other. **Answer:** items 1, 3 and 4 must derive from the *saved* value by calling the
same functions the compiler calls (`normalizeLiquidityGraph`, `compileToDrawdownSequence`,
and the gate renderer used by the panel's log), never from the row model. Item 2 reads balances
and is a reading of live accounts, which cannot drift from a compile because it is not one.

### 4.3 The two warnings that reach nobody

`_warnUnscheduledShapes` and `_warnResurrectedPools` are `console.warn`. Design 109 §12 rule 3
says of the first: *"an author who forgot to schedule the shape they just wrote is the common
case, and this is the only signal they get."* In the app that signal goes to the browser
console; in the CLI tools it goes nowhere at all
(`cli-tools-swallow-loader-warnings` — design 99's retired-rate warnings never printed from
`run-scenario` or `mc-run`).

**Proposed:** warnings join `collectAuthoredGraphProblems`'s return as a second severity
(`{ severity: 'warn' }`), rendered in the authoring surface and **not** blocking Rebuild. That
keeps one authority for "what is wrong with this graph" and makes the refusal path and the
advisory path the same code. A pool id that disappears and reappears (design 109 §12 rule 4)
is the case that most needs it: its symptom is a gate reading 0% below its high for one period,
which is invisible in every other surface.

---

## 5. Leg B — observation

### 5.1 What is already there, and should not be rebuilt

Four views, gated flows drawn on the zero line, the rebalance veto beside the gated flow, the
provenance strip separating "no graph" from "`poolFlowsEnabled: false`" from "a graph that never
fired", `tiePoolHistory` leading with a replay-vs-live check, a per-role series picker, and a
CSV fact table. §14 asked for cover and capacity; it got those plus the afforded clamp, the ask,
and the accessibility pair.

### 5.2 The sankey, re-argued — and a different object proposed

§21.6 deferred the topology and the sankey together, with one argument: *"neither shows a
non-event, and the non-event is what the three defects of §20 were."*

That argument is correct about a **sankey** and does not extend to a **topology diagram**.
A sankey encodes volume as ribbon width, and a flow that moved nothing has width zero — it is
structurally incapable of drawing the interesting event, which is the whole objection. A
topology diagram encodes *structure*, and an edge in it is present whether or not it fired; the
fired/gated/vetoed counts are a **label on the edge**, not its width. The panel already has all
three counts per edge in `hist.events`.

**Proposed:** a fifth view — the graph as nodes and edges, one node per pool sized by nothing
(a box, with its balance / target / cover as text), one edge per flow, each edge labelled
`fired n · gated m` and coloured by which dominates. It answers the one question the four
existing views cannot: *what is this policy, as a shape*. And it is the diagram Leg A declined
to build as an editor, built where a diagram belongs.

**The argument against:** it is the first view in this panel that is not a time series, so it
needs a period selector or it shows the last period only — and "the legend reads the LAST
period" is already a known defect shape here (§23.6's badge note). **Answer:** it draws
*run-total* counts by default, which is a statement about the whole run and needs no selector;
a period scrub is a later addition, not a precondition.

### 5.3 Shape boundaries are invisible on the chart

Design 109's panel half reads the live `state.liquidityShapeId` and names it in the provenance
strip, with the date it actually took over, and is careful for the right reason (the authored
year and the switch date differ by up to a cadence). But:

- the strip names the **last** shape only, so a run through three shapes reports the third;
- the charts draw a continuous line through every switch, and a shape switch is the largest
  structural discontinuity the graph can experience — a pool can be retired at one;
- `shapeId` rides `history.periods[].shapeId` and is **not a CSV column**, so the fact table
  cannot be grouped by shape.

Three small items, one theme. **Proposed:** a `markLine` per switch on every time-series view
labelled with the incoming shape id, `shape` as a CSV column, and the strip listing every shape
with its live-from date rather than the current one. The chart marker is the one that matters:
§23.6 already learned that a run-level statement belongs in the strip because the badge reads
the last period, and this is the same lesson applied to a different field.

### 5.4 The panel is read-only and the editor is three tabs away

Not proposed for this pass, and recorded so the next reader does not assume it was missed.
"Click the gated flow, land on its clause rows" is the natural affordance and it crosses a
boundary this app keeps deliberately: a panel reads a completed run, an editor writes a config,
and a run is not re-derived from the editor. The cheap 80% is that the panel's log names the
flow id and the clause table is keyed by flow id — the author can find it. Revisit if the
topology view lands and people start treating it as a map.

---

## 6. Leg C — search

The missing leg, and the one §14 was most specific about: *searches pool sizes and gate
thresholds instead of the author guessing them*.

### 6.1 What a pool axis would plug into

Nothing needs inventing downstream. Design 100 §7's multi-lever grid **harvests its axes from
the Opt harvest** (`buildOptVariables`), and design 98 W3 made that harvest take `{ cfg }` and
run against a loaded config. A pool lever that appears in the harvest is a grid axis, an MC
lever and an optimizer variable at once. That is the payoff and it is why this leg is worth
more than its size suggests.

### 6.2 The key form — decide once, for pools and shapes together

Two candidates, and the repository has a precedent for each.

**(A) `poolTarget::<poolId>`** — §12.8's original. `::` is not a path separator, so `set()`
writes it as one flat token. Safe today, safe before design 98, and it stays safe for
non-generated keys.

**(B) a generated `pool.<poolId>.<field>` namespace** — `ScenarioParamGenerator.generate(cfg)`
already walks a config and emits typed params with a cascade `node`; design 98 W0 made generated
dotted keys flat-safe in `get`/`set`; `generated-param-keys.js` is the namespace list.

**Proposed: (B), with (A)'s safety property obtained by joining the generated namespace rather
than by the separator.** The reason is not the separator, it is the *lifecycle*: a generated
param regenerates from the config at Build/Rebuild, which is exactly what a per-pool knob must
do when the author renames a pool or adds one. A hand-declared `poolTarget::` list cannot, and
a stale one is an axis pointing at a pool that no longer exists.

**And it must be an overlay, not a rewrite.** §12.2's one-authority rule says a lever must not
silently rewrite another; a sweep that edits `liquidityGraph.pools[i].target.value` in place
makes the graph disagree with the file it was loaded from. The precedent is exact and already
in this repo: `BALANCE_TARGET` is `hidden: true`, seeded from the record, honoured **only when
explicitly injected by the MC/Opt runner**, and kept out of the param editor *and* the persisted
`cfg.params` so it never round-trips as a stale value. A pool target axis should be the same
object: seeded from the authored graph, invisible in the editor, live only under a runner.

### 6.3 The gate threshold needs an address before it can be an axis

Per §2.1 there is none. Three options:

- **A — an optional authored `id` on a gate clause.** Absent means positional, exactly as today;
  present makes the clause addressable, and only id'd clauses generate an axis. Backward
  compatible, and an axis that cannot be addressed *fails to exist* rather than addressing the
  wrong clause.
- **B — promote one threshold per flow.** Simpler, and it re-imposes the single-clause gate that
  §20.15 spent a section removing.
- **C — sweep whole graphs** (§16.2's escape hatch). Works today, outside the app, and is what
  `scripts/lib/pool-graph.mjs` exists for. Verbose, and loses nothing except the ability to see
  the axis in the app.

**Proposed: A**, and **C stays supported** — it is the only route that can sweep a *structural*
change (a pool added, an edge re-pointed), which no scalar axis will ever reach.

### 6.4 The shape-switch year is the same mechanism

Design 109 Q1 wants *"what does moving the bridge shape two years earlier do"* and flags the
same trap: a dotted path into an object param is dropped, so *"the likely answer is a flat
scalar companion param rather than a path into the array."* That is §6.2's answer, arrived at
independently. **Proposed:** build the mechanism once, generate `pool.<id>.target` first, and
add the shape-year axis behind it — deferred per design 109 Q1, but no longer designed
separately.

Note the id space multiplies: with shapes, a pool id is only unique *within* a shape, and the
same id in two shapes is deliberately the same pool (design 109 §9). So the axis key is the
**pool id**, and a sweep of it moves that pool's target in *every* shape that contains it.
That is probably what an author means and it is certainly not obvious, so it is a thing the
harvest row's label has to say, not a thing the reader should infer.

### 6.5 Study hygiene is not optional and is currently not in the app

`scripts/lib/pool-arms.mjs` carries six pieces of hygiene that make pooled arms comparable:
the glidepath off, the legacy `poolCashYears`/`poolBondYears` off, any hand-authored
`drawdownSequence` off, manufactured shocks off, the strategy list identical across arms
(`LIQUIDITY_POOLS` selected even in the control, where it is inert), and a wealth-match
assertion before the grid. Every one of them applies to the **control** as well as the arms,
which is the entire point — *"an arm and a control that differ in two ways measure neither of
them."*

The app's grid applies none of it. A pool axis in the app would therefore produce a grid that
looks comparable and is not, which is worse than not having one.

**Proposed:** a `poolAxisProblems(cfg)` preflight in the same shape as
`collectAuthoredGraphProblems` — it **reports, never repairs** — run when a pool axis is enabled
and rendered beside the axis. Repairing silently would be the same class of mistake as a lever
rewriting another lever. Wealth-matching is not a config problem and stays where it is.

---

## 7. What this design deliberately does NOT do

- **No direct-manipulation editing.** §4.1. The tables stay the authoring surface; the diagram
  is drawn and not edited.
- **No sankey.** §5.2. Replaced by a labelled topology view, on the argument that a ribbon of
  width zero cannot draw a non-event.
- **No cost function on an edge.** Unchanged from §13 and §16.2, and still the optimizer's job
  rather than the graph's.
- **No solver, no MPC policy.** Leg C is an *axis surface* — it makes pool sizes searchable by
  the machinery that already exists (design 100's grid, the optimizer, MC). Posing the year's
  transfers as a convex program is still design 97 §13's "different project".
- **No click-through from panel to editor.** §5.4.
- **No second validator.** §17.2's rule is unchanged: the UI makes the vocabulary visible and
  never re-implements `normalizeLiquidityGraph`. Everything §4.2 proposes is derived by calling
  the compiler's own functions.

---

## 8. Phasing

Ordered so that each step is independently shippable, and so that the cheapest things that
prevent a wrong reading come first.

1. ~~**The `ui` round trip, asserted**~~ (§2.2) — **BUILT.** It did not confirm the constraint:
   `normalizeLiquidityGraph` carries `raw.ui` on pools *and* flows, and the editor carried it on
   pools only, so a layout authored on an EDGE was discarded by the first edit to any cell —
   silently, with the graph still loading and still running. Fixed; CTRL-1 covers pools, flows,
   a shape-nested graph, and `ScenarioSerializer`.
2. ~~**Authoring readouts**~~ (§4.2) — **BUILT**, with one placement changed by measuring in the
   running app: see §13.1. CTRL-2, CTRL-3, CTRL-15.
3. ~~**Warnings and shape-local problems**~~ (§2.3, §4.3) — **BUILT.**
   `collectAuthoredGraphProblems` gained `severity`, `blockingProblems` is the single filter
   every refusal site now goes through, the shape pass runs unconditionally and localizes to
   the cell, and the two `console.warn`s are rendered from the same collectors the advisory
   rows come from. CTRL-4, CTRL-5.
3b. ~~**The other four `console.warn`s**~~ (§13.2) — **BUILT.** `normalizeLiquidityGraph` takes
   an optional `opts.advisories` sink; the reporting path supplies one and the compile path
   does not, so all six advisories now reach the author by one route and no run changed.
   CTRL-4b.
4. **Shape boundaries on the panel** (§5.3) — `markLine` per switch, `shape` as a CSV column,
   every shape in the strip. Three small edits, one theme.
5. **The topology view** (§5.2) — the fifth view, labelled with run-to-date
   fired/gated/vetoed and **no period selector**: the app's own step/rewind already scrubs it
   (§10.1).
6. **Leg C mechanism** (§6.2) — a hidden, compile-only generated param on the `BALANCE_TARGET`
   pattern, joined to `generated-param-keys.js` and harvested. **Blocked on §10.3**: whether the
   key is an absolute target or a multiplier over every shape decides what the key MEANS, and
   that cannot be changed afterwards without changing the meaning of a live axis.
7. **Leg C hygiene** (§6.5) — `poolAxisProblems`, rendered beside the axis.
8. **Gate clause ids** (§6.3 option A), then the gate-threshold axis.
9. **The shape-year axis** (§6.4), deferred per design 109 Q1 until 6–8 are green.

Steps 1–5 cannot change a run. Step 6 is the first that can, and only under a runner.

---

## 9. Test plan

Numbered `CTRL-n`, and each is a property rather than a snapshot.

1. **CTRL-1 `ui` survives** — a graph carrying `ui` on a pool and on a flow round-trips through
   `buildLiquidityGraphEditor` and through `ScenarioSerializer` unchanged, including for a graph
   inside a named shape.
2. **CTRL-2 derived readouts call the compiler** — the compiled-order readout equals
   `compileToDrawdownSequence` on the saved value for a graph whose pools are multi-claim, and
   for one where a pool has no `spendOrder` (so the readout must show it as never spent from).
3. **CTRL-3 gate prose is reversible** — for every gate the clause table can draw, the rendered
   sentence names every clause, its basis, its scope and its dwell. A `rawGate` flow renders as
   "authored directly" and never as a partial sentence.
4. **CTRL-4 warnings do not block** — an unscheduled shape and a resurrected pool both appear as
   `severity: 'warn'` and Rebuild proceeds; a bad size spec still refuses.
5. **CTRL-5 shape problems are not suppressed** — a bad cell in the base graph and a bad cell in
   shape B report **both**, each localized to its own container.
6. **CTRL-6 shape markers** — a run with two switches draws two markers at the dates the switch
   actually took effect (not 1 January of the authored year), and the CSV's `shape` column
   changes on the same row.
7. **CTRL-7 topology counts tie to the log** — the per-edge fired/gated/vetoed totals on the
   topology view equal the row counts in the flow log for the same run. Two derivations of one
   number is the failure shape §23.6 named; this is the assertion that stops it.
8. **CTRL-8 the pool axis reaches a LOADED sim** — the design-100 `lever-reaches-loaded-sim`
   gate, on a pool target axis: two values produce different rollouts on a *loaded* config, not
   an authored one (`legacy-alias-levers-inert-on-loaded-plan`).
9. **CTRL-9 the axis does not round-trip** — a swept `pool.<id>.target` never appears in the
   persisted `cfg.params`, and a scenario saved during a sweep reloads with the authored target.
   This is `BALANCE_TARGET`'s own invariant and the reason that pattern was chosen.
10. **CTRL-10 a renamed pool takes its axis with it** — renaming a pool regenerates the axis
    under the new id and leaves no row pointing at the old one.
11. **CTRL-11 a clause without an id generates no axis**, and one with an id generates exactly
    one that survives a branch renumber above it (§2.1).
12. **CTRL-12 hygiene reports, never repairs** — a config with a live glidepath and a pool axis
    enabled produces a problem row and an unmodified config.
13. **CTRL-13 the topology view is consistent under stepping** — run to a mid-plan pause, read the
    per-edge counts, step forward, then rewind past the pause: the counts shrink to match the
    truncated journal. This is the assertion behind §10.1's "no scrub" — the view is only allowed
    to have no cursor of its own because it cannot show a future that has been un-run.
14. **CTRL-14 a shape-spanning axis preserves the authored profile** — a pool whose target is
    authored differently in two shapes, swept one step: both values move and their **ratio is
    unchanged**. The mistake this pins is §10.3's — an axis that flattens a 2-then-4 into 3-then-3
    still runs, still reports a number, and has deleted a policy.
15. **CTRL-15 the editor's provenance line names the state** — three cases (graph live,
    `liquidityGraphEnabled: false`, `poolFlowsEnabled: false`) render three distinct lines above
    the same readouts, and the readouts render in all three (§10.5).
16. **CTRL-16 identity** — with none of this used, a golden run is byte-identical. The whole-state
    fixtures are the assertion; the sim is bit-deterministic, so anything that moved would move one.

---

## 10. The five open questions, answered (18 Sep 2026)

Reviewed with the author. Three are **decided**, one is **decided against**, and one moved
**earlier in the phasing** than it was filed under — which is the substantive outcome of the
review, because it changes what step 6 has to get right.

### 10.1 Q1 — the topology view needs no period scrub, and probably never will

**Decided: no scrub. Build the view against run-to-date totals and revisit only on the trigger
in §10.1b.**

The author's argument was that if the view updates as the simulation runs, the simulation's own
stepping *is* the scrub. Checked against the code, and it holds on all four legs:

- the panel already subscribes to the sim bus at `EXECUTION_${END}` for `kind: EVENT` and
  re-renders (rAF-coalesced) — so every panel in the workbench is already a live view, not a
  post-run report;
- the workbench app owns `TimeControls` with play/pause, **step forward, step back**, reset and
  a position slider;
- `buildPoolHistory` replays the journal, and the journal accumulates as the run proceeds, so a
  paused mid-run panel shows exactly the periods that have happened;
- `rewindTo` and `reset` **truncate the journal to zero and replay from the start**
  (`time-controls.js`), so stepping backwards cannot leave the panel showing totals from a
  future that has been un-run.

That last one is what makes this more than a convenience. It means a panel-local period selector
would be a **second time cursor** in an app that already has one, and the two would disagree the
moment a user moved either — which is the failure shape §23.6 already paid for once
(`_seriesSpecs` exists because two derivations of one list is where a picker offers a line the
chart does not draw). So the scrub is not merely deferred for cost; there is a positive argument
against ever putting one in this panel.

**10.1b The trigger that would reopen it.** The common path is *load, run to the end, open the
panel* — and at the end of a completed run there is nothing to step. Seeing the topology as it
stood in an earlier year requires rewinding the whole app, which is a heavier action than the
question deserves and affects every other open panel. If that friction is what people actually
hit, the answer is still not a panel-local scrub: it is that the *edges* carry per-period counts
that the existing views can already chart, so the honest fix would be a small-multiples or a
"counts since" toggle, not a cursor. Record what the friction actually is before choosing.

### 10.2 Q2 — value only, within the authored mode

**Decided as proposed.** A `YEARS_OF_SPEND` 2 and a `PERCENT` 15 are not two points on one axis;
§9.1's whole argument is that they are different kinds of statement, and an axis that crossed
between them would be sweeping the *mode* while reporting a number. A mode change stays a
whole-graph arm (§6.3 option C), which is what `scripts/lib/pool-graph.mjs` is for.

### 10.3 Q3 — the shape-spanning axis, and the trap that moves it before step 6

**Not decided. It must be, before step 6 rather than before step 9** — the correction this
review produced.

The question was filed as a reporting nicety (how should a harvest row describe an axis on a
pool only some shapes contain?). It is not. Design 109 §9 makes the **pool id** the identity
that spans shapes, so one id can carry **several authored target values** — the base graph says
one thing, the bridge shape says another, and that difference is the entire reason shapes exist.
A scalar overlay keyed on the pool id therefore has to decide what it does to a profile it did
not write, and the obvious answer is the wrong one:

- **An absolute value flattens the author's own glide.** Sweeping `pool.<id>.target` to 3 sets
  every shape's target for that pool to 3, so an authored 2-then-4 becomes 3-then-3. The axis
  silently deletes a policy the author wrote, and reports a single number as if it were the
  policy. This is §12.2's one-authority rule broken by an axis rather than by a lever.

Three candidate answers:

- **(a) A multiplier — `pool.<id>.targetScale`, default 1.0**, applied to every shape's authored
  target for that pool. With no schedule it is exactly an absolute sweep re-parameterised
  (one authored value × the factor), and with a schedule it sweeps the *level* of the profile
  while preserving its shape. One rule, one meaning, no special case.
- **(b) Per-shape keys** — `pool.<shape>.<id>.target`. Finest control, and it duplicates the job
  shapes already do: "hold 4 years on the bridge and 2 after the gates open" is *already*
  expressible, by authoring two shapes. It also multiplies the axis space by the shape count and
  lets a solver author a discontinuity at a shape boundary that no human wrote.
- **(c) Refuse an axis on any pool that is not in every shape.** Safe, and it makes the most
  interesting pool in a scheduled plan — the bridge, which exists *because* it is temporary —
  the one thing that cannot be searched.

**Proposed: (a).** The cost is legibility: a solver reporting an optimum of 1.37 needs
translating before anyone can act on it, and a grid axis of 0.5 / 1.0 / 1.5 reads worse than
2y / 4y / 6y. That is a labelling problem — the harvest row can show the resolved values it
produces — and it is a smaller problem than an axis that quietly flattens an authored profile.

Either way this is now a **step 6 input**, because it decides the key's meaning. Building
`pool.<id>.target` as an absolute and discovering the multiplier later is not an extension, it
is a change to what an existing axis means, on the one surface where a silently-changed meaning
is most expensive.

**DECIDED (19 Sep 2026): (a), the multiplier.** The key is **`pool.<poolId>.targetScale`,
default `1.0`**, applied to that pool's authored target in **every** shape that contains it.
This unblocks step 6, and it fixes the meaning of three things that were otherwise open:

- **CTRL-14 is now the defining assertion of the axis, not a guard on it.** "Both values move
  and their ratio is unchanged" is the whole content of (a); if that test is deleted the key
  has no meaning left.
- **(c) does not arise.** A pool absent from some shape is not a special case under a
  multiplier — the factor applies to the shapes that contain the pool and there is nothing to
  apply it to in the shapes that do not. The bridge pool stays searchable, which was (c)'s
  entire cost.
- **The legibility cost is paid in the harvest row, as §10.3 says**, by showing the resolved
  values a factor produces (`0.5 → 1y / 2y`) rather than the factor alone. That is a label on
  a row; it is not a second authority and it does not touch the key.

What this does **not** license: `pool.<id>.target` as an absolute key **must not be added
later beside** the scale. Two keys writing one field is §12.2's one-authority rule broken by
exactly the mechanism §6.2 chose the `BALANCE_TARGET` overlay pattern to avoid, and a sweep
that set both would have no defined answer. An author who wants an absolute value writes it
in the graph; the axis only ever scales what is written.

### 10.4 Q4 — no. The editor does not simulate the draw

**Decided against.** §4.2 item 3 renders the compiled spend *order*, which is a pure function of
the graph — `compileToDrawdownSequence`, no balances, no time, no engine. "Which pool a spend
would actually reach" is a different object, and the list of what it needs says why: live
balances per claim, each pool's `floor`, each account's `minimumBalance`, the accessibility
slice (§24.3), the capacity rule (`OFFSET_CAP` needs the loan's outstanding balance), and the
period's spend amount — which is the spend line, and therefore inflation, the guardrail state
and the age bands. That is the engine, re-implemented, running on a config that has not been
built, and free to disagree with the real one. §17.2 drew this line already and drew it here:
*the UI makes the vocabulary visible and never re-implements the compiler.*

It is also the one question in this document that is already answered by something built. The
panel reports what the draw actually did, per period, with the flows that did **not** fire
beside the ones that did — a strictly better answer than a prediction, on real numbers. The real
complaint behind Q4 is not "the editor cannot predict", it is "I have to rebuild to find out",
which is latency, not knowledge.

**What covers the actual misauthoring** is already in the plan and is a lookup rather than a
simulation: §4.2 item 2 ("what this pool would hold today") catches the claim that names the
wrong sleeve or landed in the wrong pool, which is the mistake people make — §22.5 trap 2 is
exactly that mistake, and it shipped as a *default* fix because nothing on the screen said where
the claim had gone.

### 10.5 Q5 — the readouts render while the graph is switched off, behind a provenance line

**Decided as proposed, with the mechanism named**, and flagged for revision once something is
running.

The concrete risk: with `liquidityGraphEnabled: false`, `resolveLiquidityGraph` returns null and
the spend order falls back to `drawdownPriority` (or to an authored `drawdownSequence`, which
stops being a second authority once the graph is off). A compiled-order readout rendered in that
state describes an order the run will not use. Hiding it is worse — validation deliberately
keeps reporting while the switch is off, *"because the switch is a run-time 'ignore this', not
an authoring-time 'this is fine'"*, and readouts that vanish would make the switch a way to stop
seeing the graph you are editing.

The repository has already solved this exact problem one surface over. §21.3's provenance strip
exists because *"no graph authored"*, *"`poolFlowsEnabled: false`"* and *"a graph whose edges
never fired"* all look identical. **The editor gets the same thing**: one line above the
readouts naming which of three states is in force —

- the graph is live;
- `liquidityGraphEnabled: false` — these pools are authored and **this order will not be used**;
- `poolFlowsEnabled: false` — the order **is** used, the targets are live, and no refill edge
  will fire.

That is one line, it reuses the panel's own vocabulary so the two surfaces say the same words,
and it is the smallest thing that stops a readout from lying by omission. Revisit once step 2
is in someone's hands: whether the line is enough, or whether the readouts should also be
visually muted in the off states, is a question about reading and should be answered by
watching someone read it.

---

## 11. What the review changed

For the next reader, because a document whose open questions were answered elsewhere is a
document that is wrong in a way that is hard to see:

1. **Q3 moved from step 9 to step 6** (§10.3). It is a decision about what a key *means*, not
   about how a row is labelled, and step 6 is where the key is born.
2. **Q1's answer is a property, not a deferral** (§10.1). The sim's step/rewind already scrubs
   this view and truncates the journal when it goes backwards, so a panel-local cursor is a
   second time cursor rather than a missing feature.
3. **Q4 is closed** (§10.4), and the thing it was reaching for is covered by §4.2 item 2.
4. **Phasing step 6 now has an input** it did not have: answer §10.3 before writing the
   generator, not after.

---

## 12. Starting a session on this

Written for a session that opens this file cold, because the work is phased across several and
the expensive part of each one is finding the seam. Line numbers drift; the function names do not.

### 12.1 The seam for each phase

| phase | start here | tests |
|---|---|---|
| 1 — `ui` round trip | `structured-param-editors.js#buildLiquidityGraphEditor` (reads `p.ui`, writes it in `sync()`); `liquidity-graph.js#normalizeLiquidityGraph` carries `raw.ui` on both pools and flows | `tests/viz/structured-param-editors.test.mjs` already has a fixture carrying `ui` — it is not asserted on |
| 2 — readouts | same editor; derive by calling `liquidity-graph.js#compileToDrawdownSequence` and `#normalizeLiquidityGraph`. For the claims readout: `pool-metrics.js#claimValueNative` (**not exported today**) and `scenario-tab-presenter.js#accountsProvider` (**the projection to widen** — read §4.2 item 2 first) | `tests/viz/structured-param-editors.test.mjs` |
| 3 — problems + warnings | `liquidity-graph.js#collectAuthoredGraphProblems` (the short-circuit is the early `return problems`), `#_warnUnscheduledShapes`, `#_warnResurrectedPools`. Consumers: `scenario-tab-presenter.js#_graphProblems` → `reportInvalidPools`, and `scenario-load-error-overlay.js` (three call sites) | `tests/unit/evt-liquidity-pools.test.mjs`, `tests/unit/pool-shape-schedule.test.mjs` |
| 4 — shape boundaries | `liquidity-pools-plugin.js` `POOL_CSV_COLUMNS` and `#_shapeLiveSince`; `pool-history.js#poolHistoryRows` (the row builder that omits `shapeId`, which `history.periods[]` already carries) | `tests/unit/pool-history.test.mjs`, `tests/viz/liquidity-pools-plugin.test.mjs` |
| 5 — topology view | `liquidity-pools-plugin.js` — `this._view` is the view key, `_render` branches on it, `_seriesSpecs` is built in `_render` (not `_drawChart`, deliberately — §23.6) | `tests/viz/liquidity-pools-plugin.test.mjs` |
| 6 — the axis | `scenarios/params/scenario-param-generator.js#generate(cfg)`, `params/record-param-templates.js#BALANCE_TARGET` (the pattern to copy), `params/generated-param-keys.js` (the namespace list), `param-schema-utils.js#harvestSweepVariables` / `buildOptVariables({ cfg })` | `tests/unit/generated-key-param-paths.test.mjs` is the existing detector for the dot trap |
| 7 — hygiene | `scripts/lib/pool-arms.mjs` is the specification — its `base` block is the six-item list; port it as a reporter | new |
| 8 — clause ids | `structured-param-editors.js#gateToRows` / `rowsToGate` / `renumberBranches` | `tests/viz/structured-param-editors.test.mjs` |

### 12.2 Traps that will cost a session if forgotten

- **`npm test` runs `help:check` and `help:gate` first.** Editing any param `description` fails
  the gate until the topic that stamps it is re-read and `npm run help:restamp -- <topic-id>` is
  run. The pool topics are `help/concepts/liquidity-pools.md`,
  `help/concepts/pool-shapes-over-time.md` and `help/panels/pools.md`. Never hand-edit
  `help/REFERENCE.md`.
- **A liveness gate must be evaluated against a LOADED config**, never an authored one
  (`legacy-alias-levers-inert-on-loaded-plan`). This bites phase 6 directly: an axis that reads
  as live on a raw cfg and is inert on the loaded one is this repository's most expensive
  recurring defect.
- **The whole-state golden fixtures are the real assertion for phases 1–5.** The sim is
  bit-deterministic, so any of those phases moving a fixture means it changed a run, which none
  of them is allowed to do. No golden scenario authors a graph today, which is why design 109 and
  §24 both landed with every fixture byte-identical — that is a property to preserve, not a
  coincidence to rely on.
- **`cfg.params` rows are keyed by `name`, not `key`** (§12.10), and a param that never reaches
  `state` reads exactly like one that did nothing.
- **A CSS probe must carry the real ancestors** or it measures different rules — design 109 §15b
  paid for this with a button sized from an unstyled 30px natural width. Phases 2 and 5 both add
  DOM to an existing editor and an existing panel.
- **Verify in the running app, not only in jsdom.** Both of design 109's app defects (a control
  hidden behind its own precondition, a head overflowing to two rows) were invisible to the
  jsdom cases, which compute no layout and render one param at a time. §23.6 and §20.11 record
  the same lesson from the other direction: every gap in this feature so far was found by
  somebody trying to author a specific thing and then reading what it did.

### 12.3 The one thing to decide before writing phase 6 code

§10.3 — absolute target or multiplier. It is not a labelling choice and it cannot be deferred
into the build.


---

## 13. What the build changed (19 Sep 2026, phases 1–3)

Recorded because a design whose phases were built elsewhere is a design that is wrong in a way
that is hard to see — the same reason §11 exists.

### 13.1 §4.2 item 1 moved off the Pools row

§4.2 asked for the claims summary as "a derived, non-editable summary cell **on the Pools
row**". Built that way, then measured in the running app on a real plan (§12.2's last trap):
the params pane is ~550px, the Pools table already carries eleven columns, and a twelfth took
**~13% off every one of them** — `Id` from 39px to 34px, `Target` from 63px to 55px, on cells
that were already truncating a mode name to three characters. A derived readout that buys its
own legibility with the authoring surface's width has made the editor worse at the thing it is
for.

**It is rendered under the tables instead**, one line per pool. It costs no authoring width, and
the whole string fits rather than being hinted at behind a tooltip. §4.2's substance — *the join
done once, correctly* — is unchanged; only where it is drawn.

The **"Holds today"** readout (§4.2 item 2) stayed on the **Claims** row, where §4.2 put it: that
table has three columns and nothing in it clips.

This is the §10.5 revision loop working as described — "watch someone read it" — one phase early.

### 13.2 §4.3 named two `console.warn`s. There are six.

§4.3 enumerated `_warnUnscheduledShapes` and `_warnResurrectedPools`, and both are now advisory
rows. **Four more live inside `normalizeLiquidityGraph` itself** and were not named:

| where | what it says |
|---|---|
| `liquidity-graph.js` ~906 | a gate reads a market signal on a pool claiming only cash-like accounts — no lots, so its return index never moves off its high and the clause is effectively constant |
| ~981 | one pool is the source of several gated edges **whose gates differ** — a gate vetoes the sale of its SOURCE, so the strictest one wins and the others are not what they read as |
| ~1048 | a pool `target`s a class the **location policy fills somewhere else first**, so the pool reports less cover than the plan carries and the spend order walks past the rest |
| ~1074 | a REBALANCE edge whose pool claims an account **the rebalancer does not trade** |

The third one fires four times on the repository author's own live scenario, for `buffer` (BOND)
and `gold` (GOLD). That is a real, actionable statement about a real plan that has been going to
the browser console and nowhere else — precisely the defect §4.3 exists to remove, in the four
places §4.3 did not look.

### 13.3 Phase 3b, as built

`normalizeLiquidityGraph(graph, accounts, opts)` takes an optional **`opts.advisories`** array.
The four `warnX` functions became `collectX` functions returning rows; one block at the end of
the normalizer either pushes them into the sink or, when there is none, `console.warn`s each
message exactly as before.

**The sink is supplied only by the reporting path.** The compile path passes none, so every
compile behaves identically and no golden fixture moved — the property phase 3b had to preserve,
asserted directly by CTRL-4b ("with no sink the four advisories still go to the console,
unchanged").

Three things the build settled that the proposal did not state:

1. **A shape's advisory is stamped with its shape id** inside `_normalizeShapes`, so it lands on
   `liquidityShapes` and renders under *that* shape's tables. Unstamped, an advisory about
   `bridge` would render under the base graph and name a pool the reader is not looking at —
   design 109 §12's "the author repairs the wrong table" in a new place.
2. **`index`/`field` stay null.** These four are statements about a POOL or a FLOW and its
   relationship to the rest of the plan, not about one cell. There is no cell to highlight, and
   claiming one would point at the wrong thing.
3. **`_scheduleAdvisories` passes a DISCARDED sink.** It re-normalizes the base graph and every
   shape to build its entry list, and without one each of those calls re-printed all four —
   which is what made the placement warning appear four times in the browser console for one
   graph.

### 13.4 The eight console lines were false positives

Worth recording, because it is the opposite of what §13.2 assumed. Read in the running app, the
four duplicated `buffer`/`gold` placement warnings did **not** survive phase 3b — and the reason
is not that they were silenced. Under the scenario's real options they do not fire at all: its
`allocationLocationPolicy` already ranks the claimed roles first
(`BOND: [us-stock, au-stock, …]`, `GOLD: [us-stock]`), which is precisely the fix the message
recommends, and POOL-21b is the test that says so.

So something was calling `normalizeLiquidityGraph` with options that **lacked `locationPolicy`**,
and warning against the DEFAULT policy rather than the authored one. The advisory was telling the
author to fix something they had already fixed. That is worse than a warning nobody reads, and
it is the argument for §4.3's one-authority rule stated from the other end: a message emitted
from a call site with a different option set is not the same message.

It is gone now — the reporting path is silent and the editor's rows are produced under
`_graphOptsFrom`, which carries the policy. **The call site with the incomplete options was not
identified** and may still exist for other purposes; if a stray console advisory reappears, that
is where to look.

Verified live by pointing `allocationLocationPolicy.GOLD` at `ira` (an account the `gold` pool
does not claim): the advisory appeared in the editor, named both IRA accounts, listed the
claimed accounts, and refused nothing — the readouts rendered beside it.