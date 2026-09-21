# 110 — The liquidity pool control surface (design 97 §14, effort 2)

**Status:** **PHASES 1–5 BUILT** (19 Sep 2026, including 3b); 6–9 proposed, and 6 is
unblocked — §10.3 is decided. §10 records the first review
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
4. ~~**Shape boundaries on the panel**~~ (§5.3) — **BUILT.** One shared derivation
   (`poolShapeSpans`) feeds all three: a `markLine` per switch on every time-series view, a
   `shape` CSV column, and a strip that names every shape with its own live-from date.
   CTRL-6, HIST-9. See §13.5.
5. ~~**The topology view**~~ (§5.2) — **BUILT.** The fifth view, run-to-date counts, no period
   selector. CTRL-7, CTRL-13. See §13.6.
6. ~~**Leg C mechanism**~~ (§6.2) — **BUILT.** `pool.<poolId>.targetScale`, a hidden
   generated param on the `BALANCE_TARGET` pattern, `'pool.'` joined to
   `generated-param-keys.js`, offered as a curated Opt/grid row rather than harvested, and
   applied where the graph is RESOLVED rather than by a loader cascade. §10.3's multiplier
   decision is what unblocked it. CTRL-8, CTRL-9, CTRL-10, CTRL-14, CTRL-16. See §13.7.
7. ~~**Leg C hygiene**~~ (§6.5) — **BUILT.** `poolAxisProblems` reports five things and
   deliberately restates none of the three `pool-arms` items that are already refusals; the
   presenter carries them on the axis rows and the panel draws them beside the axis, tagged
   INERT or CONFOUNDED. CTRL-12. See §13.8.
8. ~~**Gate clause ids**~~ (§6.3 option A) **and the gate-threshold axis** — **BUILT.** An
   optional authored `id` on any gate node, unique per graph, plus `gate.<id>.threshold` and
   `gate.<id>.dwell`. CTRL-11, and CTRL-8/9/16 again on the new key. See §13.9.
9. ~~**The shape-year axis**~~ (§6.4, design 109 Q1) — **BUILT.**
   `shape.<shapeId>.yearShift`, a SHIFT for §10.3's reason rather than an absolute year.
   See §13.10. **Leg C is complete.**

Steps 1–5 cannot change a run. Step 6 is the first that can, and only under a runner. Steps 6–9
are the three axis families (a pool size, a gate clause, a shape switch) plus the hygiene that
makes a grid of any of them worth reading; all four went in at one seam, and the seam is the
graph RESOLVER rather than the loader cascade (§13.7).

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
| 6 — the axis | `scenarios/params/scenario-param-generator.js#generate(cfg)`, `scenarios/params/record-param-templates.js#BALANCE_TARGET` (the pattern to copy), `scenarios/params/generated-param-keys.js#GENERATED_KEY_PREFIXES` (**`'pool.'` must be added here or the key is dead on arrival** — see §12.2), `finance/param-schema-utils.js#harvestSweepVariables` / `intl-retirement-opt-config.js#buildOptVariables({ cfg })` | `tests/unit/generated-key-param-paths.test.mjs` is the existing detector for the dot trap |
| 7 — hygiene | `scripts/lib/pool-arms.mjs` is the specification — its `base` block is the six-item list; port it as a reporter | new |
| 8 — clause ids | `structured-param-editors.js#gateToRows` / `rowsToGate` / `renumberBranches` | `tests/viz/structured-param-editors.test.mjs` |

### 12.2 Traps that will cost a session if forgotten

- **`npm test` runs `help:check` and `help:gate` first.** Editing any param `description` fails
  the gate until the topic that stamps it is re-read and `npm run help:restamp -- <topic-id>` is
  run. The pool topics are `help/concepts/liquidity-pools.md`,
  `help/concepts/pool-shapes-over-time.md` and `help/panels/pools.md`. Never hand-edit
  `help/REFERENCE.md`.
- **`'pool.'` is not yet a generated namespace.** `set()` in `mc-param-paths.js` writes a
  dotted key flat ONLY when `isGeneratedParamKey(path)` says so, and the list is
  `acct. person. prop. coll. equity. bequest. raAsset.` — verified 19 Sep 2026. A
  `pool.<id>.targetScale` axis added without touching `GENERATED_KEY_PREFIXES` will pass
  every hand-written flat-`cfg.parameters` test and be **inert in a real solve**, which is
  this trap's whole signature (`optimizer-param-key-dot-collision`).
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

### 13.5 Phase 4, as built

The three items of §5.3 are three renderings of one fact, so the build starts with the fact:
**`poolShapeSpans(history)`** in `pool-history.js`, returning one entry per shape the run passed
through with the date it took over. §23.6's `_seriesSpecs` refactor is the precedent — two
derivations of one list is where a picker starts offering a line the chart does not draw — and
the panel-local `_shapeLiveSince` it replaces was already the second derivation waiting to
happen. It is deleted rather than left unused.

Two things the reducer forced, neither of them in §5.3:

1. **The opening span is reconstructed, not read.** `PoolShapeScheduleReducer` writes
   `liquidityShapeId` only on a CHANGE, and `stamped = state.liquidityShapeId ?? null` means a
   run that begins on the base graph emits **no diff at all** for that stretch. So the periods
   before the first switch carry no field, and a strip built only from what was recorded would
   begin its story at the first switch — describing a 43-year run by its last 27 years.
2. **A span that begins at the run's first period is not a switch** (`opening: true`). It takes
   no chart marker, because a marker on the first category has nothing to its left to separate
   it from. This also covers the case §5.3 did not consider: a schedule whose first row is
   already live at the start stamps on period 0 and has no base-graph stretch at all.

The `shape` CSV column is `''` before the first switch, not `'base'` — the base graph is not a
named shape, and writing a name that appears in no scenario file into the fact table would
invent one.

Verified on a real 39,568-entry run of the `D109 wrappers-last from 2043` scenario: two spans
(`base graph` from 2027-01-01, `wrapLast` since 2043-01-01), one marker, drawn on all three
time-series views in both themes, and landing exactly on the regime change visible in two of the
cover lines. The date is the one the switch LANDED on, which is the property §5.3 cared about
and the one design 109 §7 makes easy to get wrong.

**Superseded:** design 109 §14 step 6's two strip tests. The strip named only the LIVE shape, so
a run through three shapes reported the third; the assertions were rewritten against every-shape
wording, keeping the date property unchanged.

### 13.6 Phase 5, as built

**It renders as inline SVG into the grid element, not through ECharts.** Not a style
preference: `_drawChart` no-ops without a canvas — which is jsdom *and* a docked panel before
its first activation — and this panel had already moved the series picker out of it because *"a
control that silently does not exist in those states is a control the reader cannot find"*
(§23.6). A whole VIEW that silently did not exist would be that mistake at full size, and it
would make CTRL-7 and CTRL-13 unassertable.

**Edges come from the GRAPH, counts from the events.** This is the mechanical expression of
§5.2's argument against the sankey, and it is the one thing in this view that must not be
reversed: deriving edges from the events would rebuild the ribbon-of-width-zero blind spot in a
new costume, because the edge that never fired is exactly the one the author is looking for. On
the author's own plan the view immediately showed one — `growth-to-offset · 0f 0g` — an authored
refill edge that has never fired in 43 simulated years, invisible on every other surface.

**A veto belongs to the POOL, not the edge.** `POOL_EVENT_KIND.VETOED` carries no flow id
(§12.4c): it names the pool that may not be sold, or the one that may not be grown. Attributing
it to an edge would invent a fact the run never recorded, so it renders as a badge on the node
(`32 veto` on the author's `growth`).

**Layout is deterministic — pools in spend order, edges arcing beside them.** A force-directed
layout that rearranged itself between two renders of the same run would make "did this change?"
unanswerable, and §14's `ui` blob, where an author-placed layout would live, is still written by
nothing (§2.2). Spend order also makes §18.6's corollary legible for free: a pool placed after
one that never empties is not low-priority, it is UNCLAIMED — on this view, a box near the
bottom with no inflow.

**One defect found in the app and fixed** (§12.2's last trap, again): the first build sized the
diagram on a fixed lane width, so `growth-to-offset · 0f 0g` rendered as `gro` and
`paycheck-sweep-us-to-au` as `paycheck-sw`. The viewBox now derives its width from the longest
label. jsdom computes no layout, but the geometry is arithmetic, so the regression IS assertable
and is asserted — the half of the "verify in the app" lesson that can be pinned in a test.

Verified on the author's 39,568-entry run: 9 nodes, 7 edges, per-edge counts summing to exactly
the 174 fired / 41 gated the provenance strip reports, with zero per-edge mismatches against the
flow log.

### 13.7 Phase 6, as built

**The seam is the RESOLVER, not the loader cascade.** §6.2 chose the `BALANCE_TARGET` pattern
and §12.1 named `ScenarioLoader` as the place it lands, which is right for every other
generated param and wrong for this one. Every `acct.` / `prop.` / `person.` key cascades onto a
cfg RECORD; a pool is not a record, it is a value inside the `liquidityGraph` param, and that
param is read from the params bag when `buildSim()` builds the reducers — **before**
`ScenarioLoader.load()` runs at all (`config-field-in-state-is-not-read`). A cascade branch
would have written the scale onto a graph nothing reads. So the factor is applied in
`resolveLiquidityGraph` / `resolveLiquidityGraphSchedule`, in front of `normalizeLiquidityGraph`,
on a copy. `pool` is therefore deliberately ABSENT from `PREFIX_TO_NODE_TYPE`, so
`decodeGeneratedParamKey` returns null for the key and the loader's third pass skips it.

That placement turns out to be better than the one the design named, for two reasons that were
not in the argument when it was written:

- **§6.2's "an overlay, not a rewrite" becomes true by construction.** The authored param object
  is never written to, so CTRL-9 is not a property the code has to maintain — there is no code
  path that could break it. `ScenarioSerializer` writes `cfg.params` and not `cfg.parameters`,
  so a scenario saved mid-sweep reloads at the author's own targets because the swept value was
  never in the store that gets saved.
- **A multiplier is not idempotent, and now nothing can apply it twice.** `BALANCE_TARGET`
  rescales holdings to an ABSOLUTE figure, so applying it to its own output is harmless; ×0.5
  applied twice is ×0.25. Resolving from the authored value every time removes the whole class
  of bug rather than guarding against it.

**A curated Opt row, not a harvest row.** §6.1's payoff ("a pool lever that appears in the
harvest is a grid axis, an MC lever and an optimizer variable at once") is real but arrives by a
different route: `harvestSweepVariables` skips `hidden` entries *by design* (that is how
`BALANCE_TARGET` stays out of the editor and the panel both), and a factor centred on 1.0 has no
sensible harvested range — `optRowFor`'s `rate` kind would offer 0.98 … 1.02, three
near-identical rollouts wearing a lever's clothes. So `buildPoolOptConfigs` joins
`buildShockOptConfigs` / `buildInheritedRaOptConfigs` as a dynamic contributor, with a range in
units of the authored target (half it to double it, quarter steps). `buildGridAxes` builds on
`buildOptVariables`, so the grid axis comes free; `mc: false` is deliberate per design 98 W2 —
how many years of reserve to hold is CHOSEN, not uncertain.

**`controllable` is deliberately not set.** The graph is resolved once, when the reducers are
built, so an MPC controller re-deciding the factor between periods would change nothing. A
control that cannot actuate is the same defect as an inert lever, one surface over.

**Two traps were live and both would have been silent.** §12.2 named the first and it was real:
`'pool.'` had to join `GENERATED_KEY_PREFIXES` or `set()` writes a nested `pool` object nothing
reads. The second is not in §12.2 and cost the longer half of the session to see —
`forwardToolsetOverrides` drops any bag key that is not a toolset schema key, so the axis was
being discarded on the way into `buildDefaultConfig`, which is the path **every** MC iteration,
grid cell and optimizer rollout takes (`mc-worker-core`, `optimization-problem` and the workbench
all construct the scenario from the bag). It is `legacy-alias-levers-inert-on-loaded-plan`
exactly: live on the panel, inert in the run, every cell identical. CTRL-8 asserts the arrival
(`cfg.parameters[key]`) separately from the effect, because those are two different failures.

**The centre had to be supplied by hand, three times.** A hidden generated param is absent from
`cfg.params` AND from `paramSchemaDefaults` (both exclude `hidden`), so nothing in any lever base
carried the axis's plan value and a grid on a pool would have had no reference cell —
`harvest never synthesizes a center`, and rightly. `resolvePoolTargetScaleCenters` is the
`resolveBalanceCenters` / `resolveAliasCenters` of this axis and is merged at the same three
sites (`IntlRetirementMcRunner._prepare`, `OptimizationProblem._resolveBase`,
`MonteCarloPresenter._resolveBaseParams`).

**No second validator, and a PERCENT target can be swept out of range.** §17.2 holds: the scaled
spec goes through `normalizeLiquidityGraph` exactly as an authored one does, so a factor of 2 on
a `PERCENT` target of 0.6 is REFUSED with the normalizer's own sentence rather than clamped.
That is the honest behaviour — a clamp would run a target nobody chose — but it means a grid
whose axis brackets a PERCENT pool near the top of its range will have failing cells, and the
range is 0.5 … 2. Worth a line in phase 7's `poolAxisProblems`, which is the surface that
already exists to say this kind of thing before a grid is launched.

**The legibility cost is paid in one place.** `poolTargetScaleLabel` renders both obligations
§10.3 and §6.4 imposed — the authored values the factor multiplies (`base 2y, bridge 4y`) and
the fact that one factor moves every shape (`one factor, 2 shapes`) — and the generated schema
entry, the Opt row and the grid row all take their label from it, so the three surfaces cannot
come to disagree about what the axis does.

**Still open, and unchanged by this:** phase 7's `poolAxisProblems` (§6.5) is the next step and
this axis is dangerous without it — `scripts/lib/pool-arms.mjs`'s six hygiene items apply to the
control as much as the arms, and a grid that looks comparable and is not is worse than no grid.
Phase 8's gate-clause ids and phase 9's shape-year axis are untouched; §6.4's note that the
shape-year axis is "the same mechanism" is now concrete — it is another dynamic contributor over
a flat companion key, applied at the same resolver seam.

### 13.8 Phase 7, as built

**Three of `pool-arms`' six are already refusals, so the port is FIVE rows and not six.**
`normalizeLiquidityGraph` already throws on the legacy `poolCashYears`/`poolBondYears` beside a
pool `target` (§12.2), on a hand-authored `drawdownSequence`, and on `drawdownMode:
PROPORTIONAL`. Restating them as hygiene rows would be two derivations of one sentence — §23.6's
failure shape and the thing §17.2 forbids — so `poolAxisProblems` names them in its header and
CTRL-12's sibling (PTS-12) asserts the premise that lets them be left out: each one still
refuses, so it cannot reach a grid at all. The legacy-pair refusal has exactly one gap,
`hasRebalancer: false`, and there the axis has no reader whatsoever, which is reported in its own
right and is a stronger statement.

**The sixth item needed translating, and the translation is the sharpest row.** *"The strategy
list identical across arms"* has no in-app form as written — a grid sweeps one config, so the
list is identical by construction. Its substance is whether the axis has a READER, and that does
bite: a pool `target` is realised by the TARGET_ALLOCATION rebalancer and the refill edges by
LIQUIDITY_POOLS' reducers, so with either deselected, or with `liquidityGraphEnabled: false`, the
factor is swept and nothing reads it. Every cell returns the plan and a flat grid reads as a null
result rather than as a misconfiguration.

**Two kinds, not one severity.** An INERT axis and a CONFOUNDED one are different failures and
conflating them would cost a session: the first reports "the reserve size does not matter", the
second reports an effect larger than the lever has. `POOL_AXIS_PROBLEM_KIND` is that
distinction, the INERT rows are reported first (there is no point telling an author their
glidepath confounds a comparison that is not happening), and the panel's tag is the shortest way
to say which. Every row is `severity: 'warn'`: none of these makes a plan illegal, so none may
stop a Rebuild.

**Absent is not "none selected".** `behavioralStrategies` missing from a params bag takes the
permissive reading, exactly as `hasTargetAllocation` does — without that rule every partial
config and every test bag reports two problems it does not have.

**It reports and never repairs, and the panel has no control that could.** A "fix this for me"
button would be the app rewriting the author's plan behind a grid: §12.2's one-authority rule
broken by a convenience, and a grid nobody can reproduce. Each row names the param to change so
the author changes it in the Parameters list, where the change is visible and is saved with the
scenario. One jest case asserts the absence — `querySelectorAll('button, input, select')` is
empty inside the hygiene block — because "we did not add a button" is not a property a reader
can check by looking.

**Not built, and deliberately:** wealth-matching (§6.5 — not a config problem; nothing a pool
axis does moves money, so `assertArmsWealthMatched` stays on a built state) and any statement
about the RUN config. Whether a stochastic grid is seed-paired is the same class of mistake
(`single-stochastic-run-is-not-an-ab`, `seed-matching-is-not-crn`) and belongs to design 100, not
to a function that takes a cfg.

### 13.9 Phase 8, as built

**The id is on the NODE, and that one decision settles four questions.** An id addresses the node
it is authored on; that node's threshold is its single numeric clause, and its dwell is its own
`sustainedYears`. From that: a node with two numeric clauses gets a dwell axis and no threshold
axis (no unique threshold, and inventing a winner is what a multi-class pool `target` is refused
for); a negated row resolves its threshold one level through the `not`, because the editor's row
model is exactly `{ not: clause }` with the dwell on the `not`; ids on both sides of a `not` are
two addresses for one row, which the table cannot draw, so such a gate goes to `rawGate`
verbatim rather than losing one of them; and an id on a node with no condition is REFUSED, since
it would generate an axis that writes onto a node nothing reads.

**The dwell axis was built too, and §2.1 is the reason.** The phasing says "the gate-threshold
axis", but §2.1 says the knob the evidence points at is the DURATION — §20.13 measured the three
trailing-high thresholds landing within \$13k of each other on a \$5m plan while the same gate
family differing only in how long it stays shut spread by \$460k — and that *"the one knob the
evidence points at is the one with no address"*. The addressing work is identical for both, so
shipping only the threshold would have done all of it and left the evidence-backed lever
unreachable. §20.16's dwell sweep was a negative result on one plan, which is a reason to be able
to re-run it, not to delete it.

**Absolute ranges, which is the opposite of the pool axis's choice.** A pool target is a level
whose shape across shapes must be preserved, so it is swept as a factor (§10.3). A gate threshold
is one number on one clause and the interesting span is wide: §20.13 swept 1 %, 5 % and 10 %, a
factor of ten, which a ±50 % band around an authored 0.05 reaches at neither end. So
`GATE_THRESHOLD_RANGES` is a per-kind absolute table, and the dwell is an INTEGER axis in years —
never periods, since this reducer fires on both US_ and AU_PERIOD_ADVANCE and a dwell counted in
evaluations would mean two different policies in a US-only and a cross-border plan (§20.15).

**Uniqueness is within a graph and never across shapes**, because a clause id follows the pool
id's rule (design 109 §9): the same id in the base graph and in a shape is the same clause and
one sweep moves both. A duplicate WITHIN a graph is refused rather than warned — a warning would
leave a live axis whose meaning nobody can state, which is the defect the id exists to prevent
one level up.

**The overlay works on gates the editor cannot draw.** Because the seam is the raw tree in front
of the normalizer (§13.7), an id'd clause inside an OR-under-an-AND — a `rawGate` case — is still
addressable. The axis is not limited to the DNF subset the clause table renders, which was not an
argument for the seam when it was chosen and is now one of its better properties.

**A clause id is stricter than a pool id**: `[A-Za-z0-9_-]+`. A pool id may be any non-empty
string and that cannot be narrowed retroactively; a clause id is new, exists only to be an
address, and an address that needs quoting is not one.

**The description and the help topic were the last of the work, not an afterthought.** An
authoring field nobody can discover is half-built, so `liquidityGraph`'s description names the
`id` and what it generates. That failed `help:gate` (expected — the stamp), and restamping then
put `help/concepts/liquidity-pools.md` 215 words over the concept budget, which is the gate
telling the truth: this is a separate concept. It is now `help/concepts/searching-pool-levers.md`,
with a one-line pointer from the pools topic.

**What remains open:** phase 9, the shape-year axis (§6.4), which is now concrete rather than
sketched — another dynamic contributor over a flat companion key, applied at the same resolver
seam. §6.3's option C (`scripts/lib/pool-graph.mjs`, sweeping whole graphs) stays supported and
is still the only route to a STRUCTURAL sweep, which no scalar axis will ever reach.

### 13.10 Phase 9, as built — and leg C closed

**A shift, not a year, and §10.3 decided it before the question was asked.** Design 109 Q1 wants
*"what does moving the bridge shape two years earlier do"*, and the obvious key is
`shape.<id>.year`. It does not survive contact with the data structure: `_normalizeSchedule`
refuses two rows in one YEAR and says nothing about one SHAPE appearing in two rows, so
`[{2035, bridge}, {2045, late}, {2055, bridge}]` is a legal plan in which `bridge` is scheduled
twice on purpose. An absolute key swept to 2040 would set both of those rows to 2040 — which is
not merely wrong, it is the refusal, so the axis would turn a legal plan into a failing one at
every cell but its own. `shape.<shapeId>.yearShift`, default 0, moves every row selecting that
shape and preserves the gap between them, which is §10.3's argument one object over: the
schedule's spacing is a profile and a scalar key must not flatten it. It is also the more direct
reading of Q1 — *"two years earlier"* IS `-2`, and a grid of 2033/2035/2037 means different
distances on two different plans.

**Q1's own trap was already closed.** Q1 named it — a nested path into the array is dropped by
`set()` — and proposed *"a flat scalar companion param rather than a path into the array"*.
That is §6.2's answer, so phase 9 inherited it: `'shape.'` joins `GENERATED_KEY_PREFIXES` and
nothing else about the key form had to be decided.

**Only SCHEDULED shapes get an axis**, which is PTS-13's rule applied before it could bite twice:
a shape no row selects governs nothing, so an axis on it would move nothing at every value. The
base graph gets none either — the period before the first row is the `liquidityGraph` param and
is deliberately not a named shape, so the way to move when it ends is to shift the first row's
shape. There is nothing else to address.

**Three reads, one overlay.** `p.liquidityGraphSchedule` is read by the resolver, by
`collectAuthoredGraphProblems` and by `_scheduleAdvisories`. All three now go through
`_overlayRawSchedule`, because an advisory computed on the authored schedule while the run uses a
shifted one would describe a plan nobody is running — §21.3's whole subject, in a new place.

**A third hygiene kind, and the two rows it was owed.** §13.7 and §13.9 both left a debt: §17.2
means the overlay never clamps, so a factor that pushes a PERCENT target past 1.0 and a shift
that lands one switch on another's year are both REFUSED with the normalizer's own sentence.
That is the right behaviour and it is not INERT and not CONFOUNDED — it is a third sentence, a
grid that comes back with holes. `POOL_AXIS_PROBLEM_KIND.REFUSES` says it, and
`poolAxisProblems` now computes both cases up front: it names the factor above which a PERCENT
pool fails, and the gap between the two closest switches. `POOL_TARGET_SCALE_RANGE` moved out of
the Opt contributor so the warning and the row it warns about cannot disagree about the span.

**Leg C is complete**, and §14's original ask — *"searches pool sizes and gate thresholds instead
of the author guessing them"* — is answered for three families rather than two, each of them an
optimizer variable, an MC-grid axis and a hidden compile-only overlay at once. What is NOT built
and is not a gap: §6.3's option C, sweeping whole graphs through `scripts/lib/pool-graph.mjs`,
which remains the only route to a STRUCTURAL sweep (a pool added, an edge re-pointed) that no
scalar axis will ever reach.

**One defect this design shipped and then fixed, worth carrying forward.** Phase 6 generated an
axis for a pool whose target was authored `AMOUNT 0`; a factor cannot lift a target off zero, so
it read as a lever, swept as a lever and returned byte-identical rollouts. Every test passed. It
was found in about five minutes by running the axis list against a plan the author had actually
written — §12.2's last trap, proving itself again on the phase that was most confident it did
not need the check.

### 13.11 The MPC portion, built as a shape lever (design 39 §14.9.9, 20 Sep 2026)

§13.7 left `controllable` unset on `pool.<id>.targetScale` because the graph was resolved once, at
reducer build, so a controller re-deciding it between periods would change nothing. Design 39
§14.10 step 3 took that up, and it is answered differently than the axis surface suggested:
**the MPC control is the SHAPE, not the scale.** `POOL_SHAPE` decides which design 109 shape
governs from a year on, and saves the decision as a `liquidityGraphSchedule` row. That route
gives it a rollout that sees the candidate (design 39's `derivedStateAt`), a live actuation (the
constructor-held schedules are updated in place), and a design 81 replay that folds the same row
at compile, with no mid-run mutation of a graph anywhere.

`targetScale` stays uncontrollable, and the reason sharpened. A rollout WOULD see a candidate
factor now: the gate's `POOL_TARGET` probe reaches, because the candidate's compile resolves the
scaled graph and `derivedStateAt` stamps it. What is missing is persistence. The factor is a
hidden runner-only overlay that never enters `cfg.params` (§13.7's CTRL-9 property), so a live
decision would have nowhere to be saved that a Rebuild or a replay reads. To make it
controllable, give it a saved form first. An author who wants a different buffer from 2045 can
already say so as a shape with that target and let the lever choose it.

