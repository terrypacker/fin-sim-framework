# 17 — Scenario as Graph Node

**Status**: Implemented (Phases 1–6 complete, 2026-05-29)
**Resolves**: `inconsistencies.md` §1.8 (`PrebuiltScenario` overlap with `BaseScenario`); §4.2 (`ScenarioRegistry` persists across reset deliberately)
**Related**: `design/3-branching-event-streams.md`, `design/4-branch-diff-insight-engine.md`, `design/5-branch-merge-reconciliation.md`, `design/13-prebuilt-scenario-parameters.md`, `design/15-config-as-source-of-truth.md`
**Author note**: Folds `PrebuiltScenario` into `BaseScenario`, makes scenarios first-class `SimGraphNode`s, and stores them in the shared `Graph`. Introduces **layer-scoped reset** (`graph.clearLayer(layer)`) so the `Graph` instance survives `ServiceRegistry.reset()` — scenarios live on `layer:'scenario'` which is never auto-cleared. This is the prerequisite for branch/merge persistence (designs 3–5) where each branch is a scenario node and the parent relationship is a graph edge.

---

## 1. Problem

`src/scenarios/prebuilt-scenario.js` is a thin descriptor wrapper that extends `BaseScenario` only to add `label`, `order`, `prebuilt`, `active`, `factory`, and `scenarioClass`. Three issues follow:

1. **`factory` duplicates `BaseScenario` knowledge.** `factory = (params, _initialState, simStart, simEnd) => new IntlRetirementScenario({...})` is information the subclass already owns. Today it lives in `simulation-workbench.js:38–55` as a closure passed to the registry.
2. **The registry stores "records", not scenarios.** `ScenarioRegistry.loadPrebuilt` spreads `{...pb, ...defaultCfg, params, simStart, simEnd, active, factory, scenarioClass}` into the map (`scenario-registry.js:97`). The stored thing is shaped like a `PrebuiltScenario` but is no longer one — it carries materialized `persons`, `accounts`, `realProperties`, `collectibles`, etc. The live `BaseScenario` instance is constructed lazily by `ScenarioService.createActiveScenario` (`services/scenario-service.js:159`).
3. **There is no first-class home for scenarios in the graph.** Branch/merge plans (designs 3–5) want each branch to be a node with a parent edge. Today scenarios are records in a `Map`, parented implicitly via a `scenarioId` string field on user-saved entries.

The result is three forms of "scenario" coexisting:

| Form | Where | Shape |
|---|---|---|
| `PrebuiltScenario` descriptor | `simulation-workbench.js:38–55` | `{id, label, order, factory, scenarioClass, simStart, simEnd, ...}` |
| Registry record | `ScenarioRegistry._scenarios` | `{...pb, ...defaultCfg, params, persons, accounts, ...}` |
| Live `BaseScenario` instance | created on demand | `new IntlRetirementScenario({context, params, simStart, simEnd})` |

This design collapses (1) and (2) into a single `BaseScenario` graph node, and replaces the `factory` closure with a `static instantiate()` method on the scenario subclass.

---

## 2. Goals & Non-Goals

### Goals

- Delete `src/scenarios/prebuilt-scenario.js`.
- `BaseScenario extends SimGraphNode` with `kind: 'scenario'`, `layer: 'scenario'` (a new layer, see §3.8).
- Each prebuilt and each user save becomes a `BaseScenario` node in the shared `Graph` (the one held by `ServiceRegistry`).
- Parent linkage (user save → prebuilt; branch → base) becomes a typed `Edge` (`EDGE_TYPES.DERIVES_FROM`).
- Subclasses (`IntlRetirementScenario`, future scenarios) expose `static instantiate(params, simStart, simEnd)` to produce a runnable instance from a node.
- `ScenarioRegistry` becomes a stateless façade over `graph.byLayer('scenario')` — no parallel `Map`, no `static _scenarioRegistry` survival hack.
- Introduce layer-scoped reset (`graph.clearLayer(layer)`); `ServiceRegistry.reset()` keeps the `Graph` instance alive and only tears down execution-tier services + the SimulationRegistry.
- Redefine `Rebuild`: clear execution layer + re-apply params to existing config nodes + construct a fresh `Simulation`. (See §3.8 for the contract and follow-up work.)

### Non-Goals

These are real follow-ups, explicitly out of scope for this doc:

- **§1.4** Params vs. parameters vs. paramSchema consolidation. Design 13 owns this. This doc keeps the existing `params: [{name, label, type, group, value}]` array as-is on the scenario node.
- **§4.9** Adding scenarios beyond `IntlRetirementScenario`. The plumbing this design produces makes adding them trivial, but no new prebuilts ship here.
- **§4.4** Making `graph.byLayer(...)` a first-class typed query rather than a filter. Useful, can ride this design, but is not blocking.
- **Branch/merge UX (designs 3–5).** This doc lays the storage substrate (scenario nodes + DERIVES_FROM edges). The actual branch UI, merge resolver, and diff engine are subsequent designs.
- **Removing the `prebuilt: true` flag** (e.g., distinguishing via `kind: 'prebuilt-scenario'` vs `'user-scenario'`). The flag stays as a node property — see §3.4.

---

## 3. Proposed Model

### 3.1 `BaseScenario extends SimGraphNode`

```js
import { SimGraphNode } from '../graph/sim-graph-node.js';

export class BaseScenario extends SimGraphNode {
  static getParamSchema() { return []; }
  static getToolsets()    { return []; }
  static buildDefaultConfig(_params, _simStart, _simEnd) { return null; }

  /**
   * Construct a runnable scenario instance from typed inputs.
   * Subclasses override to wire in their constructor.
   */
  static instantiate(_params, _simStart, _simEnd) {
    throw new Error(`${this.name} must implement static instantiate()`);
  }

  constructor({
    id,
    name,              // human-readable identifier (e.g. "International Retirement")
    label,             // dropdown label; usually === name today
    order = 100,
    prebuilt = false,
    active = false,
    simStart,
    simEnd,
    params = [],
    initialState = {},
    context = null,
    // ...optional cfg materialization fields populated by buildDefaultConfig:
    persons, accounts, realProperties, collectibles, toolsets,
  } = {}) {
    super({
      id,
      name,
      kind:  'scenario',
      layer: 'scenario',   // new layer, survives ServiceRegistry.reset(); see §3.8
    });

    // Identity + display
    this.label    = label ?? name;
    this.order    = order;
    this.prebuilt = prebuilt;
    this.active   = active;

    // Configuration (top-level for ergonomic access; see §3.3)
    this.simStart     = simStart;
    this.simEnd       = simEnd;
    this.params       = params;
    this.initialState = initialState;

    // Materialized cfg (present once buildDefaultConfig has run)
    if (persons)         this.persons         = persons;
    if (accounts)        this.accounts        = accounts;
    if (realProperties)  this.realProperties  = realProperties;
    if (collectibles)    this.collectibles    = collectibles;
    if (toolsets)        this.toolsets        = toolsets;

    // Runtime-only; never serialized
    this.context = context;

    if (!this._isDate(simStart)) throw new Error('Must supply simStart Date');
    if (!this._isDate(simEnd))   throw new Error('Must supply simEnd Date');
  }

  getParamSchema() { return this.constructor.getParamSchema(); }
  getToolsets()    { return this.constructor.getToolsets(); }

  // buildSim() / buildDefaultInitialState() / sim getter unchanged from today.
}
```

**Why identity fields go through `super()` but configuration stays top-level:** `SimGraphNode`'s top-level slots (`definitionId`, `timestamp`, `stateBefore`, `stateAfter`) are top-level too — they're "well-known" runtime fields. Scenario configuration (`simStart`, `params`, etc.) is well-known for scenarios, so it deserves the same treatment. We reserve `data` / `meta` for free-form extension. (Earlier sketch put these in `data` — see §6 Alternative B.)

### 3.2 `IntlRetirementScenario` exposes `static instantiate()`

```js
export class IntlRetirementScenario extends BaseScenario {
  static getParamSchema() { /* unchanged */ }
  static getToolsets()    { /* unchanged */ }
  static buildDefaultConfig(params, simStart, simEnd) { /* unchanged */ }

  static instantiate(params, simStart, simEnd) {
    return new IntlRetirementScenario({
      context:  ServiceRegistry.getInstance().simulationContext,
      params,
      simStart,
      simEnd,
    });
  }

  // existing instance methods (buildDefaultInitialState, etc.) unchanged
}
```

This replaces the `factory:` closure in `simulation-workbench.js` and the `factory:` field on registry records. `ScenarioService.createActiveScenario` becomes:

```js
createActiveScenario() {
  const active = this.getActive();
  const cls = active.scenarioClass
    ?? this._registry.get(active.scenarioId)?.scenarioClass
    ?? this._registry.getPrebuiltScenarios()[0]?.scenarioClass;
  if (!cls) throw new Error('No scenario class available');
  return cls.instantiate(
    this._getParams(active),
    new Date(active.simStart),
    new Date(active.simEnd),
  );
}
```

`scenarioClass` stays on the node so the lookup works for user saves derived from a prebuilt. It is *not* serialized — see §3.5.

### 3.3 `SimulationWorkbench` registration becomes class-only

```js
// simulation-workbench.js
import { IntlRetirementScenario } from '../scenarios/intl-retirement-scenario.js';

const PREBUILT_SCENARIOS = [
  { cls: IntlRetirementScenario, order: 1, active: true,
    simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd:   new Date(Date.UTC(2041, 0, 1)) },
];
```

`PrebuiltScenario` is gone. The registry's `loadPrebuilt(entries)` now reads each `{cls, order, active, simStart, simEnd}` and constructs a `cls`-typed scenario node:

```js
loadPrebuilt(entries = []) {
  entries.forEach(({ cls, order, active, simStart, simEnd }) => {
    const id     = 'p:' + cls.scenarioId();  // see §3.4 on id strategy
    if (this._graph.getNode(id)) return;      // preserve param edits across rebuilds

    const schema       = cls.getParamSchema();
    const params       = this._materializeParams(schema);
    const defaultParms = Object.fromEntries(schema.map(s => [s.key, s.defaultValue]));
    const defaultCfg   = cls.buildDefaultConfig(defaultParms,
                                                ScenarioSerializer.toDateStr(simStart),
                                                ScenarioSerializer.toDateStr(simEnd)) ?? {};

    const node = new cls({
      id,
      name:    cls.scenarioName(),  // static accessor; replaces `label` from descriptor
      label:   cls.scenarioName(),
      order,
      prebuilt: true,
      active:  this.getActive() ? false : active,
      simStart: ScenarioSerializer.toDateStr(simStart),
      simEnd:   ScenarioSerializer.toDateStr(simEnd),
      params,
      ...defaultCfg,
    });
    node.scenarioClass = cls;  // runtime-only convenience for the lookup in §3.2

    this._graph.addNode(node);
  });
  // ...existing active-resolution logic, but iterating graph.byLayer('scenario')
}
```

### 3.4 `id` strategy and the `prebuilt` flag

We keep today's id convention:

- `p:<scenarioId>` for prebuilts (e.g. `p:intl-retirement`).
- `u:<N>` for user saves (sequential, assigned at storage load time).

`prebuilt: true | false` stays as a node property. It is *not* part of `kind` — `kind` stays `'scenario'` for both. Rationale: a user can clone a prebuilt into a user save and the *kind* of thing it is doesn't change; only its provenance does. Provenance is a flag; identity is a `kind`.

A separate static `scenarioId()` accessor on each subclass (`'intl-retirement'`) replaces the magic string in `PrebuiltScenario({ id: 'intl-retirement' })`. Same for `scenarioName()` replacing `label`.

### 3.5 What gets serialized

`SimGraphNode` has `data` and `meta` buckets that everything else ignores. For scenarios:

- **Persisted** (to `localStorage` / Download JSON): `id`, `name`, `label`, `order`, `prebuilt`, `simStart`, `simEnd`, `params`, `initialState`, plus materialized `persons`/`accounts`/`realProperties`/`collectibles`/`toolsets`.
- **Not persisted** (runtime-only): `context`, `scenarioClass`, `active`, `sim`.
- **`kind`/`layer`** are persisted but constants — round-trip safely.

`ScenarioSerializer.snapshotServices()` and `ScenarioSerializer.toJSON()` already filter to a known field list. We add the new fields and drop `factory` from any allowlist.

### 3.6 Graph storage

Scenarios live in the same `Graph` instance held by `ServiceRegistry.getInstance().graph`. The `Graph` instance now **survives `ServiceRegistry.reset()`** (see §3.8); the static `_scenarioRegistry` survival hack goes away. `ScenarioRegistry` becomes a stateless façade:

```js
class ScenarioRegistry {
  constructor(scenarioStorage, graph) {
    this._storage = scenarioStorage;
    this._graph   = graph;
    this._init();   // hydrates user scenarios from localStorage into graph if absent
  }
  getAll()               { return this._byLayer().sort((a,b) => a.order - b.order); }
  get(id)                { return this._graph.getNode(id); }
  getActive()            { return this.getAll().find(s => s.active); }
  getPrebuiltScenarios() { return this.getAll().filter(s => s.prebuilt); }
  getUserScenarios()     { return this.getAll().filter(s => !s.prebuilt); }
  _byLayer()             { return this._graph.getNodes().filter(n => n.layer === 'scenario'); }
  // save(), delete(), loadPrebuilt(), etc. delegate to _graph.addNode / updateNode / removeNode
}
```

Promoting `_byLayer` to a real typed query (`graph.byLayer('scenario')`) is `inconsistencies.md §4.4` and stays out of scope.

**Lifecycle:**

- Prebuilts: added to `_graph` once on `loadPrebuilt()`. `loadPrebuilt` is idempotent — re-running it on a graph that already has the node is a no-op (matches today's "preserve param edits" semantics in `scenario-registry.js:70`).
- User saves: added on `save()`, updated on subsequent `save()` of the same `id`, removed on `delete()`.
- All scenario node CRUD goes through `Graph.addNode` / `updateNode` / `removeNode`, so existing graph subscribers / queries observe them uniformly.
- `ServiceRegistry.reset()` does **not** remove scenario nodes — `layer:'scenario'` is outside its reset scope (§3.8).

### 3.7 Parent linkage via `DERIVES_FROM` edge

Today user scenarios carry a `scenarioId` string referencing the prebuilt they descend from (`scenario-service.js:168`). Replace with a typed `Edge`:

```js
// edge.js
export const EDGE_TYPES = {
  HANDLED_BY:       'HANDLED_BY',
  GENERATES_ACTION: 'GENERATES_ACTION',
  REDUCES_ACTION:   'REDUCES_ACTION',
  DERIVES_FROM:     'DERIVES_FROM',  // new
};
```

Direction: child → parent. `from: 'u:0'`, `to: 'p:intl-retirement'`, `type: 'DERIVES_FROM'`.

Lookup helpers:

- `scenario.parent()`: `graph.getOutgoing(this.id, 'DERIVES_FROM')[0]?.to`.
- `scenario.children()`: `graph.getIncoming(this.id, 'DERIVES_FROM').map(e => e.from)`.

For branch/merge (designs 3–5), the same edge type carries any branch chain: `branch-3 → branch-2 → branch-1 → p:intl-retirement`. No schema change needed when branches land.

**Migration of existing `scenarioId` fields**: drop the field; on load, if a stored user scenario has a `scenarioId`, create a `DERIVES_FROM` edge to that target and discard the field. One-time conversion, lives in `ScenarioRegistry._init()`.

### 3.8 Reset semantics: layer-scoped, not singleton-scoped

Today `ServiceRegistry.reset()` destroys the entire singleton (graph, bus, all services). `ScenarioRegistry` only survives because it's pinned to a `static _scenarioRegistry` field outside the singleton (`service-registry.js:50`). This is a hack the design closes.

#### Layers

| Layer       | Contents                                                                | Cleared by |
|-------------|-------------------------------------------------------------------------|-----------|
| `scenario`  | `BaseScenario` nodes; `DERIVES_FROM` edges                              | nothing automatic; explicit `delete()` only |
| `config`    | persons, accounts, real properties, collectibles, events, handlers, actions, reducers — i.e. everything `ScenarioLoader` materializes from a scenario's cfg | `graph.clearLayer('config')` on scenario *switch*; not touched by `Rebuild` |
| `execution` | journal entries, instance nodes, fired-event records                    | `graph.clearLayer('execution')` on every `Rebuild` and on scenario switch |

The names match the existing `SimGraphNode.layer` taxonomy (`'config' | 'event'`) extended with the new `'scenario'` value. (The current `'event'` layer maps to what this table calls `'execution'` — see §7 Open Question #4 for the rename decision.)

#### `Graph.clearLayer(layer)`

New primitive on `Graph`:

```js
clearLayer(layer) {
  for (const node of [...this.nodes.values()]) {
    if (node.layer === layer) this.removeNode(node.id);   // also removes incident edges
  }
}
```

#### `ServiceRegistry.reset()` rewritten

```js
static reset() {
  const inst = ServiceRegistry._instance;
  if (!inst) return;
  // Keep the Graph instance; clear execution layer only.
  inst.graph.clearLayer('execution');
  // Drop SimulationRegistry contents; bus subscriptions to execution-tier topics
  // are torn down by individual services on receipt of a 'reset' event.
  inst.simulationRegistry.clear();
  inst.bus.emit('execution:reset');
}

/** Full teardown for tests. Discards the Graph too. */
static resetAll() {
  ServiceRegistry._instance = null;
}
```

The singleton itself stays alive. Services that hold execution-layer state (e.g. `SimulationSync`'s scheduled-event tracking) subscribe to `'execution:reset'` and drop their per-run state.

#### `Rebuild` contract

`Rebuild` (`WorkbenchApp.initScenario` after the user clicks Rebuild, or after a param edit) means:

1. `ServiceRegistry.reset()` — execution layer cleared, simulation registry emptied, fresh bus topic for execution.
2. **Re-apply params to existing config nodes** (`scenario.applyParams(currentParams)`). This refreshes parameter-derived fields like starting balances, birth dates, retirement dates — without removing or recreating the config nodes themselves. Field-by-field "what is param-derived" is owned by the scenario subclass.
3. Construct a fresh `Simulation`, register as primary.

This is significantly cheaper than today's "destroy and re-derive" because the config layer doesn't churn between Rebuilds. Subscribers to config-layer changes don't have to re-subscribe.

**Scenario switching** (`onOpen` in `scenario-tab-presenter.js`) is the heavier operation:

1. `graph.clearLayer('config')` — drops the previous scenario's persons/accounts/handlers/etc.
2. Set new active scenario.
3. `ScenarioLoader.load(newScenario)` — materializes the new scenario's cfg into `layer:'config'` (toolset compile or graph-deserialize, as today).
4. `Rebuild` (steps 1–3 above) on the new scenario.

#### Follow-up work: `BaseScenario.applyParams()`

The Rebuild contract above leans on a method that doesn't exist yet:

```js
class BaseScenario {
  /**
   * Apply the typed params object to this scenario's existing config-layer nodes.
   * Default implementation calls buildDefaultConfig() and updates matching nodes
   * in-place. Subclasses can override for finer control.
   */
  applyParams(params) { /* ... */ }
}
```

This unification (`buildDefaultConfig` becomes the special "from scratch" case of `applyParams` against an empty config layer) is **non-blocking** for the storage / node-shape part of this design. Phase 1–4 of the migration (§5) can ship with today's "Rebuild → ScenarioLoader.load" path against the new graph-backed registry; `applyParams` arrives in Phase 5 to deliver the simplification. Until it lands, Rebuild's step 2 falls back to `clearLayer('config')` + `ScenarioLoader.load()` — i.e. matches today's behavior, just with scenario nodes safely on a different layer.

---

## 4. Impact / Files Affected

| File | Change |
|---|---|
| `src/scenarios/prebuilt-scenario.js` | **delete** |
| `src/index.js` | drop `PrebuiltScenario` export |
| `src/scenarios/base-scenario.js` | extends `SimGraphNode`; add static `instantiate`, `scenarioId`, `scenarioName` contract; accept new constructor fields |
| `src/scenarios/intl-retirement-scenario.js` | add `static instantiate`, `static scenarioId`, `static scenarioName`; prune unused imports (also fixes §3.8) |
| `src/scenarios/scenario-registry.js` | construct over `Graph`; replace internal `Map` with `graph.byLayer`-style filter; rewrite `loadPrebuilt` to take `{cls, ...}` entries; convert legacy `scenarioId` → `DERIVES_FROM` edge on `_init`; drop all `_scenarios` map state |
| `src/services/scenario-service.js` | resolve `scenarioClass` from node or parent edge; use `cls.instantiate(...)` instead of `factory(...)` |
| `src/services/service-registry.js` | **drop `static _scenarioRegistry`**; rewrite `reset()` to keep singleton alive and call `graph.clearLayer('execution')` + `simulationRegistry.clear()` + emit `'execution:reset'`; `resetAll()` discards the singleton (for tests) |
| `src/graph/graph.js` | add `clearLayer(layer)` primitive that removes nodes whose `node.layer === layer` (and their incident edges via existing `removeNode`) |
| `src/graph/edge.js` | add `DERIVES_FROM` to `EDGE_TYPES` |
| `src/graph/sim-graph-node.js` | extend `layer` enum doc-comment to include `'scenario'` (and resolve `'event'` vs `'execution'` rename — §7 Q4) |
| `src/apps/simulation-workbench.js` | replace `new PrebuiltScenario({...})` with `{cls, order, active, simStart, simEnd}` |
| `src/apps/workbench-app.js` | rename `prebuiltScenarios` option (descriptor → class entry); `destroyScenario()` becomes a thin wrapper that calls `ServiceRegistry.reset()` (no more "tear down everything"); scenario switching now calls `graph.clearLayer('config')` before `initScenario` |
| `src/scenarios/scenario-serializer.js` | drop `factory`/`scenarioClass` from serialization, add `kind`/`layer`/`label`; one-time edge conversion for legacy `scenarioId` |
| `src/visualization/scenario/scenario-tab-presenter.js` | reads `scenario.label` (same field name; comment update only) |
| `design/inconsistencies.md` | strike §1.8 and §4.2 (resolved); note §3.8 (`_unused-import` accumulation) is partially addressed by pruned IntlRetirementScenario imports |
| tests | `scenario-registry`, `scenario-service`, and any test that calls `ServiceRegistry.reset()` to wipe the graph — switch to `resetAll()` if they need a fully fresh graph |

---

## 5. Migration Phasing

Each phase keeps tests green.

**Phase 1 — `BaseScenario` shape change.** Make `BaseScenario extends SimGraphNode`. Add `label`, `prebuilt`, `active` as top-level fields, kept optional. Add static `instantiate`, `scenarioId`, `scenarioName` with throwing defaults. `IntlRetirementScenario` implements them. No behavior change — `PrebuiltScenario` still wraps a node-shaped `BaseScenario`. Tests: existing scenario-registry tests pass as-is.

**Phase 2 — Drop `factory` from the path.** `ScenarioService.createActiveScenario` calls `cls.instantiate()` instead of `factory()`. Workbench still constructs `PrebuiltScenario` but the `factory:` closure is unused. Confirm with logs / test that no caller reads `.factory`.

**Phase 3 — Delete `PrebuiltScenario`.** `SimulationWorkbench` switches to `{cls, order, active, simStart, simEnd}` entries. `ScenarioRegistry.loadPrebuilt` reads class entries directly and constructs `BaseScenario` subclass nodes. `prebuilt-scenario.js` deleted.

**Phase 4 — Graph-backed storage + layer-scoped reset.** Two coupled changes:

- `Graph.clearLayer(layer)` lands. `ServiceRegistry.reset()` is rewritten to keep the singleton alive and clear the execution layer; `resetAll()` becomes the test-only full teardown. Services that hold execution-layer state subscribe to `'execution:reset'`.
- `ScenarioRegistry` switches from `_scenarios: Map` + `static _scenarioRegistry` to `graph.byLayer('scenario')`. User scenarios from `localStorage` are added as nodes. Legacy `scenarioId` is converted to `DERIVES_FROM` edges on `_init`.

These ship together because (a) dropping the static is only safe once the graph survives reset, and (b) survival of the graph is the whole point of storing scenarios there. Tests that previously relied on `reset()` wiping the graph switch to `resetAll()`.

**Phase 5 — `applyParams` simplification (optional, can defer).** Add `BaseScenario.applyParams(params)`; rewire Rebuild to call it instead of `clearLayer('config')` + `ScenarioLoader.load`. Delivers the cheap-Rebuild win promised in §3.8. Not blocking — earlier phases are valuable on their own.

**Phase 6 — Cleanup.** Strike §1.8 and §4.2 from `inconsistencies.md`. Update comments referencing `PrebuiltScenario`. Memory note: project memory `project_state_registry_plan` may want a cross-reference if branch/merge ramps after this.

Each phase is independently reviewable; phases 1–3 can ship in one PR if small enough. Phase 4 should be its own PR — the reset-semantics change is the highest-risk piece and benefits from being reviewed in isolation.

---

## 6. Alternatives Considered

**A. Keep `PrebuiltScenario` but make it not extend `BaseScenario`.** Treat it purely as a descriptor record. Smaller change, but doesn't address the "scenario isn't a graph citizen" half — and the original inconsistency note specifically wanted to remove the wrapper.

**B. Put scenario configuration in `SimGraphNode.data` rather than top-level.** Matches the early sketch literally (`data: {label, order, simStart, simEnd, params, initialState}`). Costs: every reader (`scenario.simStart` → `scenario.data.simStart`) has to migrate; serializer paths get longer. Benefit: keeps `SimGraphNode` shape lean. Rejected because configuration fields are *well-known*, not free-form — matching the pattern set by `definitionId`, `timestamp`, `stateBefore`.

**C. Per-class node only (no per-user-save nodes).** Each scenario class is one node; user saves stay as plain records. Smaller blast radius, but defeats the branch/merge motivation — branches need to be addressable, edge-connected entities.

**D. Replace `scenarioId` field with `parentId` on `node.data` instead of an edge.** Simpler now, queries are manual (`graph.getNodes().filter(n => n.data.parentId === x)`). Doesn't compose with the rest of the graph's edge-typed model and would have to be migrated when branch/merge lands. Rejected on the grounds that the migration cost is the same now vs. later.

---

## 7. Open Questions

1. **`name` vs. `label`.** Today `PrebuiltScenario.label` is the dropdown display string. `SimGraphNode.name` is "structural identity." For scenarios these are the same string today (`"International Retirement"`). Question: do we want them to *stay* the same (drop `label` entirely, render `name`), or keep both for future flexibility (e.g., rename a user save without changing its identity)? **Tentative**: keep both — `name` stable, `label` user-editable on user scenarios. **Answer**: Just use name, remove label

2. **`active` as node property vs. registry-level state.** `active: true` on a node is "this scenario is currently selected." It's really registry state (a pointer), not scenario state. Storing it on the node is convenient today; a follow-up could move it to a `ScenarioRegistry._activeId` pointer. Not blocking.

3. **`scenarioClass` on the node.** It has to be there at runtime for `ScenarioService` to find the right `cls` for a user save. It can't be serialized. Question: do we instead resolve via the `DERIVES_FROM` edge to the prebuilt, look up the prebuilt's `scenarioClass`, and skip storing it on the user node? **Tentative**: yes — the edge already encodes the relationship; storing the class on the user node duplicates that. Spelled out in §3.2's lookup if we commit.  **Answer**: Yes edge is a good idea

4. **`'event'` vs `'execution'` layer name.** Today `SimGraphNode.layer` is documented as `'config' | 'event'`. This design introduces `'scenario'`; we should also decide whether the execution-tier layer should be renamed `'event'` → `'execution'` for consistency with the reset model (which calls it `'execution'` throughout §3.8). Tentative: rename to `'execution'` as part of Phase 4. Low-cost, single grep. **Answer**: go ahead and change 'event' to 'execution'

5. **Edge id collisions.** `createEdgeId(from, to, type)` uses `${from}|${type}|${to}`. With per-instance scenario nodes (`u:0` derives from `p:intl-retirement`), this gives `u:0|DERIVES_FROM|p:intl-retirement` — unambiguous, no collision risk identified. Confirming for the record.

6. **What re-emits `'execution:reset'` listeners need.** Phase 4 rewrites `ServiceRegistry.reset()` to emit a bus event so per-run service state (e.g. `SimulationSync`'s scheduled-event tracking) can drop itself. Need an inventory of which services hold execution-tier state today so each gets a listener wired in the same PR. Initial candidates: `SimulationSync`, `SimulationRegistry`, anything subscribed to `journal:append`-style topics. Worth a survey before Phase 4 starts.
