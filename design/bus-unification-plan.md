# Bus Unification Plan

**Issues**: #87, #88, #93, #127  
**Branch**: wip/bus-unification  
**Date**: 2026-05-14  
**Status**: Phase 4 complete

## Guiding Principles

| Layer | Purpose |
|-------|---------|
| Configuration Graph | Static topology |
| Execution Graph | Runtime causality (optional, derived, rebuildable) |
| Journal | Durable state history |

- Replay requires only: **initial state + journal**. The graph is never required for replay.
- The system is causal execution lineage, not strictly event-oriented.

---

## Execution Order

```
Phase 1 ✅ (Bus infra)
  ├── Phase 2 ✅ (Message classes)   ┐
  └── Phase 3 ✅ (Execution IDs)    ┘ parallel
        └── Phase 4 ✅ (Simulation rewrite)
              ├── Phase 5 ✅ (State snapshot) ┐
              ├── Phase 6 (ExecutionGraph)   ┤ parallel
              └── Phase 7 (classType)        ┘
                    └── Phase 8 (Subscription limiting + watcher removal)
```

---

## Phase 1 ✅ — Bus Unification + Filtered Subscription API (`#127`, `#93`)

**Complete.** Changes made:

### `EventBus` — filtered subscriptions

`subscribe()` accepts an optional filter object between the type and handler:

```javascript
// Existing callers unchanged:
bus.subscribe('EXECUTION_END', handler)

// New filtered forms:
bus.subscribe('EXECUTION_END', { kind: 'REDUCER' }, handler)
bus.subscribe('SERVICE_ACTION', { subtype: 'CREATE', instanceOf: Account }, handler)
```

Filter fields (all optional, combined with AND): `kind`, `subtype`, `instanceOf` (checks `msg.item instanceof X`).  
Internally stored as `{ predicate, fn }` pairs — `publish()` loop is unchanged.

### `BusMessage` — `subtype` and `kind` added

```javascript
export class BusMessage {
  constructor({ type, subtype = null, kind = null, date }) {
    this.type    = type;
    this.subtype = subtype;   // e.g. 'CREATE'|'UPDATE'|'DELETE' for SERVICE_ACTION
    this.kind    = kind;      // e.g. 'EVENT'|'HANDLER'|'ACTION'|'REDUCER' for EXECUTION_*
    this.date    = date;
  }
}
```

### `Simulation` — collapsed to single bus

```javascript
this.serviceBus = bus;
this.bus = bus;  // same reference — one bus, two names
```

Standalone sims (`new Simulation(date)`) get `new EventBus()` as the default, assigned to both names.

---

## Phase 2 — New Message Classes (`#87`, `#93`)

### Execution constants

```javascript
export const EXECUTION_KINDS = {
  EVENT: 'EVENT', HANDLER: 'HANDLER', ACTION: 'ACTION', REDUCER: 'REDUCER'
};

export const EXECUTION_PHASES = {
  BEGIN: 'BEGIN', END: 'END'
};
```

### `ExecutionBusMessage` — replaces 5 old execution message classes

```javascript
export class ExecutionBusMessage extends SimulationBusMessage {
  constructor({ phase, kind, executionId, parentId, nodeId, meta, data, date, sim, stateDiff }) {
    super({
      type: `EXECUTION_${phase}`,
      subtype: phase,          // 'BEGIN' | 'END'
      kind,                    // 'EVENT' | 'HANDLER' | 'ACTION' | 'REDUCER'
      date,
      sim,
      payload: { phase, kind, executionId, parentId, nodeId, meta, data },
      stateDiff
    });
    this.executionId = executionId;
    this.parentId    = parentId;
    this.nodeId      = nodeId;
  }
}
```

`SimulationBusMessage`: rename `stateSnapshot` → `stateDiff`.

### `BreakpointHitMessage` — thin control message, not routed through services

Breakpoints are separate from execution and are not tracked in the execution graph.

```javascript
export class BreakpointHitMessage extends BusMessage {
  constructor({ date, nodeId, kind, stage }) {
    super({ type: 'BREAKPOINT_HIT', date });
    this.nodeId = nodeId;
    this.kind   = kind;    // 'event' | 'handler' | 'action' | 'reducer'
    this.stage  = stage;   // 'event:start' | 'handler:before' | 'action' | 'reducer:before'
  }
}
```

UI subscribes to `BREAKPOINT_HIT` directly. `SimulationSync` ignores it. No service layer involvement.

### `ServiceActionEvent` — `actionType` → `subtype`, drop `classType`

```javascript
export class ServiceActionEvent extends BusMessage {
  constructor({ subtype, item, originalItem = null }) {
    super({ type: 'SERVICE_ACTION', subtype });
    this.item         = item;
    this.originalItem = originalItem;
  }
}
```

### `ServiceEdgeActionEvent` — new, replaces edge watcher

Published from `base-service._addEdge()` and `_removeEdge()` / `_removeEdgesForNode()`.

```javascript
export class ServiceEdgeActionEvent extends BusMessage {
  constructor({ subtype, edge = null, from = null, to = null, edgeType = null }) {
    super({ type: 'SERVICE_EDGE_ACTION', subtype });
    this.edge     = edge;      // Edge instance (on ADD)
    this.from     = from;      // source node id (on REMOVE)
    this.to       = to;        // target node id (on REMOVE)
    this.edgeType = edgeType;  // EDGE_TYPES value (on REMOVE)
  }
}
```

### Remove

`EventStartBusMessage`, `EventEndBusMessage`, `EventHandledMessage`,
`ActionInstanceMessage`, `ActionResultMessage`, `ReducerResultMessage`,
`BreakpointHitBusMessage`, `NodeDataBusMessage`.

Constants removed from `SIMULATION_BUS_MESSAGES`:
`EVENT_OCCURRENCE_START`, `EVENT_OCCURRENCE_END`, `HANDLED_EVENT`,
`ACTION_INSTANCE`, `ACTION_RESULT`, `REDUCER_RESULT`,
`NODE_DATA_CHANGED`, `BREAKPOINT_HIT`.

---

## Phase 3 — Hierarchical Execution IDs (`#87`)

### ID Format

Each segment: `{configNodeId}.{executionIndex}`  
Full path: colon-separated segments

```
e1.1                        ← event #e1, 1st execution
e1.1:h1.1                   ← handler #h1, 1st execution under that event
e1.1:h1.1:a1.1              ← action #a1, 1st execution under that handler
e1.1:h1.1:a1.1:r1.1         ← reducer #r1, 1st execution under that action
```

- `parentId` = full path minus last segment
- `nodeId` = config node ID only (`e1`, `h1`, `a1`, `r1`) — kept separately for performance

### Utilities

```javascript
// buildExecutionId('e1.1:h1.1', 'a1', 2) => 'e1.1:h1.1:a1.2'
export function buildExecutionId(parentId, nodeId, index) {
  const segment = `${nodeId}.${index}`;
  return parentId ? `${parentId}:${segment}` : segment;
}

export function parentIdOf(executionId) {
  const lastColon = executionId.lastIndexOf(':');
  return lastColon === -1 ? null : executionId.slice(0, lastColon);
}
```

### `Simulation` — replace four global counters

```javascript
// Before:
this.eventExecutions    = 0;
this.handlerExecutions  = 0;
this.actionExecutions   = 0;
this.reducerExecutions  = 0;

// After:
this._executionCounts = new Map(); // configNodeId → count
this._executionStack  = [];        // stack of executionIds (current ancestry path)
```

Helper methods:
- `_nextExecutionId(configNodeId)` — increments node counter, builds + pushes ID, returns it
- `_popExecutionId()` — pops and returns top ID
- `_currentExecutionId()` — peeks top

---

## Phase 4 — Rewrite Simulation Execution Pipeline (`#87`)

### Target shape in `execute()`

```javascript
const eventExecId = this._nextExecutionId(event.id);
this.bus.publish(new ExecutionBusMessage({
  phase: 'BEGIN', kind: 'EVENT', executionId: eventExecId, nodeId: event.id, ...
}));

for (const handler of handlers) {
  const handlerExecId = this._nextExecutionId(handler.id);
  this.bus.publish(new ExecutionBusMessage({
    phase: 'BEGIN', kind: 'HANDLER', executionId: handlerExecId,
    parentId: eventExecId, nodeId: handler.id, ...
  }));

  // handler runs, applyActions() called...

  this.bus.publish(new ExecutionBusMessage({
    phase: 'END', kind: 'HANDLER', executionId: handlerExecId, parentId: eventExecId, ...
  }));
  this._popExecutionId();
}

const stateDiff = diffStates(stateBefore, this.state);
this.bus.publish(new ExecutionBusMessage({
  phase: 'END', kind: 'EVENT', executionId: eventExecId, stateSnapshot, stateDiff, ...
}));
this._popExecutionId();
```

Similarly for `_processActionQueue()` and `_processReducers()`:
- `stateDiff` attached at `EXECUTION_END (REDUCER)` only
- `stateSnapshot` attached at `EXECUTION_END (EVENT)` only (see Phase 5)

### Breakpoints

Event-level breakpoints fire in `stepTo()` before `execute()` — publish `BreakpointHitMessage` and return:

```javascript
if (this._isBreakpointed(next)) {
  this.control.paused = true;
  this.control.breakpointHit = { stage: 'event:start', node: next };
  this.bus.publish(new BreakpointHitMessage({
    date: new Date(this.currentDate),
    nodeId: next.id,
    kind: next.kind ?? 'event',
    stage: 'event:start'
  }));
  return;
}
```

Handler/action/reducer breakpoints fire inside execute() via `BreakpointSignal`. Replace the existing `NODE_DATA_CHANGED` publish in the catch block with `BreakpointHitMessage`.

### `NODE_DATA_CHANGED` — fully removed

All `NODE_DATA_CHANGED` publications deleted from `simulation.js`.  
`SimulationSync._handleNodeDataMessage()` deleted — execution metadata no longer written to config nodes.  
`NodeDataBusMessage` class and `NODE_DATA_CHANGED` constant deleted (covered by Phase 2).

### Also removed in Phase 4

- All `ACTION_INSTANCE` / `ActionInstanceMessage` publishing — `EXECUTION_BEGIN (ACTION)` covers it.
- All `stateBefore = structuredClone(this.state)` at handler/action boundaries — only kept at event start (for event-end diff).
- `reason: 'execution'` guard in `SimulationSync` — no longer needed.

### `base-service` — publish `ServiceEdgeActionEvent`

```javascript
_addEdge(from, to, type) {
  const edge = new Edge({ from, to, type });
  this._graph.addEdge(edge);
  this._bus.publish(new ServiceEdgeActionEvent({ subtype: 'ADD', edge }));
}

_removeEdge(from, to, type) {
  this._graph.removeEdge(createEdgeId(from, to, type));
  this._bus.publish(new ServiceEdgeActionEvent({ subtype: 'REMOVE', from, to, edgeType: type }));
}

_removeEdgesForNode(nodeId) {
  // collect edges before removal, then publish REMOVE for each
  const edges = [...this._graph.getOutgoing(nodeId), ...this._graph.getIncoming(nodeId)];
  this._graph.removeEdges({ from: nodeId });
  this._graph.removeEdges({ to: nodeId });
  edges.forEach(e => this._bus.publish(new ServiceEdgeActionEvent({
    subtype: 'REMOVE', from: e.from, to: e.to, edgeType: e.type
  })));
}
```

---

## Phase 5 — State Snapshot at Event End Only (`#88`)

**Decision**: keep a full `structuredClone` state push at `EXECUTION_END (EVENT)` only.  
`stateDiff` (result of `diffStates`) attached at `EXECUTION_END (REDUCER)`.  
Future work: eliminate the full snapshot entirely once subscribers no longer need it.

### Changes

- Remove `stateBefore = structuredClone(this.state)` at handler/action boundaries.
- Only compute `stateSnapshot` at `EXECUTION_END (EVENT)`.
- Only compute `stateDiff` at `EXECUTION_END (REDUCER)`.
- Add structural sharing fast-path in `diffStates`:

```javascript
function walk(b, a, path, diffs) {
  if (b === a) return;  // structural sharing short-circuit
  // ... rest unchanged
}
```

### Subscriber impact

`SimulationAnimator` continues to read `stateSnapshot` from `EXECUTION_END (EVENT)` — no change to that logic.

---

## Phase 6 — ExecutionGraph + GraphRecorder (`#87`)

### Conceptual model

Two distinct graphs sharing one `Graph` instance:

| Graph | Layer | Nodes | Edges |
|-------|-------|-------|-------|
| Definition graph (existing) | `'config'` | EventDef, HandlerDef, … | config topology |
| Execution graph (new) | `'execution'` | UUID runtime nodes | typed execution edges |

`INSTANCE_OF` edges cross layers — runtime UUID node → config definition node.  
`parentId` on the node (UUID of parent execution node) is for tree navigation. Graph edges express semantic relationships. **These are intentionally separate.**

### Runtime node shape

```javascript
{
  id:           crypto.randomUUID(),   // execution identity — stable across graph accumulation
  path:         'e1.1:h1.1:a1.2',     // human breadcrumb (from Phase 3 execution IDs)
  definitionId: 'r1',                  // config-graph node id
  parentId:     '<uuid>',              // UUID of parent execution node (null for root events)
  kind:         'reducer',             // 'event' | 'handler' | 'action' | 'reducer'
  startTime:    Date.now(),
  endTime:      null,                  // set on EXECUTION_END
  metadata:     {}
}
```

### Edge types

```javascript
export const EXECUTION_EDGE_TYPES = {
  INSTANCE_OF: 'instance-of',   // runtime node → definition node (crosses layers)
  EXECUTES:    'executes',       // direct call chain: event→handler, handler→action, action→reducer
  EMITS:       'emits',          // reducer → child action (next:[...] provenance)
  SCHEDULES:   'schedules',      // execution node → future event execution (deferred resolution)
  // CAUSES deferred — derivable from EMITS + SCHEDULES once those are established
};
```

| Edge | Connects | Meaning |
|------|----------|---------|
| `instance-of` | runtime UUID → config node id | "this execution came from this definition" |
| `executes` | parent exec UUID → child exec UUID | direct runtime invocation |
| `emits` | reducer exec UUID → action exec UUID | reducer created this action via `next:[...]` |
| `schedules` | exec UUID → future event exec UUID | this execution queued a future event |

### `ExecutionGraph`

Wraps the shared singleton `Graph`. Accessed via `new ExecutionGraph(ServiceRegistry.getInstance().graph)`.

```javascript
export class ExecutionGraph {
  constructor(graph) {
    this._graph = graph;
  }

  addNode(node) {
    if (node.layer !== 'execution') throw new Error('ExecutionGraph only accepts execution nodes');
    this._graph.addNode(node);
  }

  addEdge({ from, to, type, metadata = null }) {
    this._graph.addEdge(new Edge({ from, to, type, metadata }));
  }

  resolveSchedule({ fromId, toId }) {
    // Replace pending schedule entry with a real SCHEDULES edge
    this.addEdge({ from: fromId, to: toId, type: EXECUTION_EDGE_TYPES.SCHEDULES });
  }
}
```

**Accumulation**: execution nodes are never cleared on rewind/replay — they accumulate across runs. The singleton graph's `layer` filter is used to query execution vs config nodes separately.

### SCHEDULES — deferred resolution

When `sim.schedule(event)` is called inside a handler or reducer body:

```javascript
// Store immediately (future event has no UUID yet)
graphRecorder.recordPendingSchedule({
  fromId:            graphRecorder.currentNodeId(),
  targetDefinitionId: event.id ?? event.type,
  scheduledFor:      event.date
});
```

When that event fires and its execution UUID is created:

```javascript
// Resolve: replace pending entry with real edge
graphRecorder.resolvePendingSchedules(targetDefinitionId, newEventUUID);
```

### `GraphRecorder`

File: `src/simulation-framework/graph-recorder.js`

Called **directly from `simulation.js`** — not via bus — because `SCHEDULES` and `EMITS` require internal context unavailable from bus messages.

```javascript
export class GraphRecorder {
  constructor(executionGraph) {
    this._graph          = executionGraph;
    this._nodeStack      = [];   // UUID stack (current ancestry)
    this._pendingSchedules = []; // { fromId, targetDefinitionId, scheduledFor }
  }

  beginNode({ path, definitionId, kind, metadata = {} }) {
    const parentId = this._nodeStack.at(-1) ?? null;
    const node = { id: crypto.randomUUID(), path, definitionId, parentId, kind,
                   startTime: Date.now(), endTime: null, layer: 'execution', metadata };
    this._graph.addNode(node);
    // instance-of: runtime → definition
    if (definitionId) {
      this._graph.addEdge({ from: node.id, to: definitionId, type: EXECUTION_EDGE_TYPES.INSTANCE_OF });
    }
    // executes: parent → this
    if (parentId) {
      this._graph.addEdge({ from: parentId, to: node.id, type: EXECUTION_EDGE_TYPES.EXECUTES });
    }
    this._nodeStack.push(node.id);
    return node.id;
  }

  endNode(uuid, { endTime = Date.now(), stateDiff = null } = {}) {
    const node = this._graph.getNode(uuid);
    if (node) { node.endTime = endTime; node.stateDiff = stateDiff; }
    this._nodeStack.pop();
  }

  recordEmit(reducerUUID, actionUUID) {
    this._graph.addEdge({ from: reducerUUID, to: actionUUID, type: EXECUTION_EDGE_TYPES.EMITS });
  }

  recordPendingSchedule({ fromId, targetDefinitionId, scheduledFor }) {
    this._pendingSchedules.push({ fromId, targetDefinitionId, scheduledFor });
  }

  resolvePendingSchedules(targetDefinitionId, toId) {
    this._pendingSchedules
      .filter(p => p.targetDefinitionId === targetDefinitionId)
      .forEach(p => this._graph.addEdge({ from: p.fromId, to: toId, type: EXECUTION_EDGE_TYPES.SCHEDULES }));
    this._pendingSchedules = this._pendingSchedules.filter(p => p.targetDefinitionId !== targetDefinitionId);
  }

  currentNodeId() { return this._nodeStack.at(-1) ?? null; }
}
```

**Silent mode**: all `GraphRecorder` calls are guarded by `if (!this.silent)` in `simulation.js`.

### Simulation wiring

```javascript
// Simulation constructor:
// Before:
this.actionGraph = new SimulationEventGraph();
// After:
this.graphRecorder = graph ? new GraphRecorder(new ExecutionGraph(graph)) : null;
```

`graph` is passed into `Simulation` from `ServiceRegistry` (similar to `bus`).

- `execute()`: `beginNode` on event start, `endNode` on event end
- Handler loop: `beginNode`/`endNode` per non-internal handler
- `_processActionQueue()`: `beginNode`/`endNode` per action; `recordPendingSchedule` when transform calls `sim.schedule()`
- `_processReducers()`: `beginNode`/`endNode` per reducer; `recordEmit` for each item in `result.next`
- `sim.schedule()`: calls `graphRecorder.resolvePendingSchedules()` when the event fires

### Remove

`SimulationEventGraph`, `ActionNode` from `simulation-event-graph.js` and `index.js` exports.  
`simulation-history.js` rewind: remove `this._sim.actionGraph = new SimulationEventGraph()` line (execution nodes accumulate — no reset needed).

---

## Phase 7 — `classType` → `instanceof` (`#93`)

### `base-service._publish()`

Drop `classType` parameter:

```javascript
// Before:
_publish(actionType, classType, item, originalItem = null) {
  this.bus.publish(new ServiceActionEvent({ actionType, classType, item, originalItem }));
}

// After:
_publish(subtype, item, originalItem = null) {
  this.bus.publish(new ServiceActionEvent({ subtype, item, originalItem }));
}
```

### Subscriber audit

| File | Current | New |
|------|---------|-----|
| `accounts-presenter.js:76` | `msg.classType === 'Account'` | `msg.item instanceof Account` |
| `people-presenter.js:66` | `msg.classType === 'Person'` | `msg.item instanceof Person` |
| `action-service.js:41` | string check | `instanceof HandlerEntry` / `instanceof Reducer` |
| `simulation-sync.js` | adapter already uses instanceof | no change |

Audit all `{}` plain-object creations published via `_publish()` — convert to class instances where needed.  
Do NOT use `item.constructor.name` — breaks in minified production builds.

### Tests

Comprehensive coverage of all `instanceof` dispatch paths.

---

## Phase 8 — Subscription Limiting + Watcher Removal (`#93`)

Two concerns unified: replacing if-chain subscriptions with typed/filtered bus subscriptions, and removing the `Graph` watcher mechanism entirely in favour of direct bus subscriptions.

### Remove from `Graph` class

Delete entirely:
- `nodeModifcationWatchers` list
- `addNodeModifcationWatcher(name, fn)`
- `removeNodeModificationWatcher(name, fn)`
- `notifyNodeModified()` (or equivalent internal trigger)
- `edgeModifcationWatchers` list
- `addEdgeModifcationWatcher(name, fn)`
- `removeEdgeModificationWatcher(name, fn)`
- All calls to the edge notifier in `addEdge()` / `removeEdge()`

### `GraphRenderer` — replace watchers with bus subscriptions

Remove `_nodeModificationWatcher` and `_edgeModificationWatcher` registration.

Subscribe to bus instead:

```javascript
// Config node changes → re-layout + re-render
bus.subscribe('SERVICE_ACTION', { instanceOf: BaseEvent },    () => this._onConfigChanged());
bus.subscribe('SERVICE_ACTION', { instanceOf: HandlerEntry }, () => this._onConfigChanged());
bus.subscribe('SERVICE_ACTION', { instanceOf: Action },       () => this._onConfigChanged());
bus.subscribe('SERVICE_ACTION', { instanceOf: Reducer },      () => this._onConfigChanged());

// Edge changes → re-render edges only (no relayout)
bus.subscribe('SERVICE_EDGE_ACTION', () => this._onEdgeChanged());

// Execution state → update local render state only, targeted re-render
bus.subscribe('EXECUTION_BEGIN', { kind: 'EVENT' },    msg => this._onNodeActive(msg.nodeId));
bus.subscribe('EXECUTION_END',   { kind: 'EVENT' },    msg => this._onNodeFired(msg.nodeId));
bus.subscribe('EXECUTION_BEGIN', { kind: 'HANDLER' },  msg => this._onNodeActive(msg.nodeId));
bus.subscribe('EXECUTION_END',   { kind: 'HANDLER' },  msg => this._onNodeFired(msg.nodeId));
bus.subscribe('EXECUTION_BEGIN', { kind: 'ACTION' },   msg => this._onNodeActive(msg.nodeId));
bus.subscribe('EXECUTION_END',   { kind: 'ACTION' },   msg => this._onNodeFired(msg.nodeId));
bus.subscribe('EXECUTION_BEGIN', { kind: 'REDUCER' },  msg => this._onNodeActive(msg.nodeId));
bus.subscribe('EXECUTION_END',   { kind: 'REDUCER' },  msg => this._onNodeFired(msg.nodeId));

// Breakpoints → flash the node
bus.subscribe('BREAKPOINT_HIT', msg => this._onBreakpointHit(msg.nodeId, msg.stage));
```

`GraphRenderer` maintains its own `_nodeRenderState: Map<configNodeId, {fired, active, paused}>` — never reads `node.data.fired` or `node.data.breakpointHit` from config nodes.

### `graph-builder-controller.resetForReplay()`

```javascript
// Before: calls service.updateAllData({ fired: false, breakpointHit: false, ... })
// After: clear GraphRenderer's local render state
resetForReplay() {
  this._renderer.clearRenderState();
}
```

`data.fired`, `data.breakpointHit`, `data.stateChanges` fields removed from config nodes entirely.

### `SimulationSync` — replace if-chain with typed subscriptions

```javascript
// Before — one handler, if-chain inside:
bus.subscribe('SERVICE_ACTION', msg => {
  if (actionType === 'CREATE') {
    if (item instanceof BaseEvent) { ... }
    else if (item instanceof HandlerEntry) { ... }
    else if (item instanceof Reducer) { ... }
  }
});

// After — one subscription per intent:
bus.subscribe('SERVICE_ACTION', { subtype: 'CREATE', instanceOf: BaseEvent },    msg => this.adapter.onCreate(msg.item));
bus.subscribe('SERVICE_ACTION', { subtype: 'CREATE', instanceOf: HandlerEntry }, msg => this.adapter.onCreate(msg.item));
bus.subscribe('SERVICE_ACTION', { subtype: 'CREATE', instanceOf: Reducer },      msg => this.adapter.onCreate(msg.item));
bus.subscribe('SERVICE_ACTION', { subtype: 'UPDATE', instanceOf: BaseEvent },    msg => this.adapter.onUpdate(msg.item));
// ... UPDATE / DELETE similarly
```

### `SimulationAnimator` — replace old message types

```javascript
// Before:
bus.subscribe(SIMULATION_BUS_MESSAGES.EVENT_OCCURRENCE_START, ...)
bus.subscribe(SIMULATION_BUS_MESSAGES.NODE_DATA_CHANGED, ...)
bus.subscribe(SIMULATION_BUS_MESSAGES.EVENT_OCCURRENCE_END, ...)

// After:
bus.subscribe('EXECUTION_BEGIN', { kind: 'EVENT' }, msg => { ... });
bus.subscribe('EXECUTION_END',   { kind: 'EVENT' }, msg => { ... });
bus.subscribe('BREAKPOINT_HIT',  msg => this.showBreakpointPaused(msg));
```

### Other subscribers updated

`accounts-presenter.js`, `people-presenter.js`, `base-app.js` — updated to filtered form.

---

## Message Migration Table

| Old Message | New Equivalent |
|-------------|----------------|
| `EVENT_OCCURRENCE_START` | `EXECUTION_BEGIN (EVENT)` |
| `EVENT_OCCURRENCE_END` | `EXECUTION_END (EVENT)` + `stateSnapshot` |
| `HANDLED_EVENT` | `EXECUTION_END (HANDLER)` |
| `ACTION_INSTANCE` | `EXECUTION_BEGIN (ACTION)` |
| `ACTION_RESULT` | `EXECUTION_END (ACTION)` |
| `REDUCER_RESULT` | `EXECUTION_END (REDUCER)` + `stateDiff` |
| `NODE_DATA_CHANGED (reason: execution)` | `EXECUTION_BEGIN/END` (nodeId + kind in payload) |
| `NODE_DATA_CHANGED (reason: breakpoint)` | `BREAKPOINT_HIT` |
| `NODE_DATA_CHANGED (reason: control)` | removed — toggleNodeBreakpoint only mutates local state |
| _(none)_ | `SERVICE_EDGE_ACTION` — replaces edge watcher |

---

## Key Risks

1. **`NODE_DATA_CHANGED` removal**: `SimulationSync` currently uses `reason: 'execution'` messages to push execution metadata into config nodes. After Phase 4, config nodes are never written during execution. Audit all reads of `node.data.fired` / `node.data.breakpointHit` / `node.data.stateChanges` — these must all migrate to `GraphRenderer._nodeRenderState` before the watcher is removed.

2. **Silent mode compatibility**: `GraphRecorder.withNode()` must fall through to `fn()` cleanly when `silent === true`. Needs explicit test coverage.

3. **Graph accumulation**: Execution nodes accumulate indefinitely by design. The singleton Graph's query API must filter correctly by `layer` when config and execution nodes coexist at scale. Future UI will expose run history and deletion.

4. **`stateSnapshot` at Event End**: full `structuredClone` remains at `EXECUTION_END (EVENT)`. Deferred — future work may eliminate it once subscribers no longer need the full state object.

5. **`ServiceEdgeActionEvent` and `_removeEdgesForNode`**: this method removes edges in bulk (all incoming + outgoing for a node). Must collect edges before removal to publish accurate REMOVE events — edges are gone from the graph by the time the loop runs otherwise.
