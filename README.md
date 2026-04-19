# Financial Simulator Framework (fin-sim-framework)

A deterministic, event-driven simulation framework for modeling and replaying complex financial workflows over time. Supports recurring and one-off scheduled events, prioritized action chains, state snapshots for rewind/replay and branching, Monte Carlo scenario runs, and an interactive graph visualization.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────┐
│                     Simulation                        │
│  currentDate  queue(MinHeap)  state  rng              │
│                                                       │
│  scheduleAnnually / scheduleQuarterly / schedule      │
│  ──▶  queue.push(event)                               │
│                                                       │
│  stepTo(targetDate)                                   │
│    └─ dequeue events in date order                    │
│         └─ execute(event)                             │
│              ├─ EventBus.publish(SimulationBusMessage)│
│              │       ◀── subscribers                  │
│              └─ HandlerRegistry ──▶ Actions           │
│                   └─ ReducerPipeline                  │
│                        ├─ state mutation              │
│                        ├─ chained actions (next:[])   │
│                        ├─ Journal entry               │
│                        └─ ActionGraph node            │
│                             └─ EventBus.publish       │
│                               (DebugActionBusMessage) │
│                                                       │
│  ┌────────────────────────────────────────────────┐   │
│  │             SimulationHistory                  │   │
│  │  snapshots  snapshotCursor  eventCounter       │   │
│  │  takeSnapshot / rewind / rewindToDate          │   │
│  │  restoreSnapshot / replayTo / resetForReplay   │   │
│  └────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
```

### Core modules

#### Simulation Framework

| Module | File | Responsibility |
|---|---|---|
| `Simulation` | `simulation-framework/simulation.js` | Orchestrator. Owns the event queue, handler registry, reducer pipeline, state, journal and action graph. Delegates snapshot/rewind to `SimulationHistory`. |
| `SimulationHistory` | `simulation-framework/simulation-history.js` | Manages snapshots array and all rewind/replay/branching navigation. Holds `snapshotCursor` and `eventCounter`. |
| `EventBus` | `simulation-framework/event-bus.js` | Pub/sub with wildcard support. Keeps a full history for replay/debug. Receives typed `BusMessage` objects. |
| `BusMessage` / `SimulationBusMessage` / `DebugActionBusMessage` | `simulation-framework/bus-messages.js` | Typed message wrappers published to the `EventBus`. `SimulationBusMessage` carries the event or action payload; `DebugActionBusMessage` carries an `ActionNode` for the graph visualizer. |
| `Action` / `AmountAction` / `RecordMetricAction` / `RecordBalanceAction` | `simulation-framework/actions.js` | Base and concrete action classes returned by handlers and emitted via `next:[]`. |
| `HandlerEntry` / `HandlerRegistry` | `simulation-framework/handlers.js` | `HandlerEntry` wraps a handler function with a name. `HandlerRegistry` maps event types to ordered lists of `HandlerEntry` instances (`sim.handlers`). |
| `ReducerPipeline` | `simulation-framework/reducers.js` | Prioritized chain of pure reducer functions that mutate state and optionally emit child actions. Also exports reusable reducers: `MetricReducer`, `NoOpReducer`, `AccountTransactionReducer`. |
| `Journal` | `simulation-framework/journal.js` | Append-only log of every `(action, prevState, nextState)` tuple for audit and timeline queries. |
| `SimulationEventGraph` | `simulation-framework/simulation-event-graph.js` | Directed acyclic graph of all `ActionNode`s produced during a run, enabling causal tracing. |
| `MinHeap` | `simulation-framework/min-heap.js` | Priority queue keyed on event date. |
| `DateUtils` | `simulation-framework/date-utils.js` | Stateless date arithmetic (addDays, addMonths, addYears). |
| `ScenarioRunner` | `simulation-framework/scenario.js` | Batch and Monte Carlo runner plus a `summarize` helper (mean, p10/p50/p90). |

#### Finance Domain

| Module | File | Responsibility |
|---|---|---|
| `Account` / `AccountService` | `finance/account.js` | Simple ledger with credit/debit history. |
| `Asset` | `finance/asset.js` | Named asset with value and costBasis. |

#### Scenario Layer

| Module | File | Responsibility |
|---|---|---|
| `EventSeries` | `scenarios/event-series.js` | Configuration object for a recurring event series: id, label, event type, interval, enabled flag, startOffset, and color. |
| `BaseScenario` | `scenarios/base-scenario.js` | Base class for scenarios. Provides `_scheduleEvents()` which iterates `eventSeries` and calls `sim.scheduleRecurring` for each enabled series plus any one-off `customEvents`. |
| `FinancialScenario` | `scenarios/financial-scenario.js` | Concrete scenario wiring a salary/interest/asset-sale/tax simulation. Extends `BaseScenario`; registers all reducers and handlers against a `Simulation` instance. |
| `RetirementDrawdownScenario` | `scenarios/retirement-drawdown-scenario.js` | Concrete scenario modeling retirement drawdown cash flows. |

#### Application / Visualization Layer

| Module | File | Responsibility |
|---|---|---|
| `BaseApp` | `apps/base-app.js` | Base class for browser apps. Wires up `GraphView`, `BalanceChartView`, `TimelineView`, and `TimeControls`; handles tab switching, node detail panel, state diff display, and play/pause/slider animation. |
| `GraphView` | `visualization/graph-view.js` | Canvas renderer for the action DAG. |
| `BalanceChartView` | `visualization/balance-chart-view.js` | Canvas line chart of account balances over time. |
| `TimelineView` | `visualization/timeline-view.js` | Scrollable journal timeline rendered in a DOM container. |
| `TimeControls` | `visualization/time-controls.js` | Bridges the slider / step buttons to `sim.stepTo` and `sim.rewindToStart` + replay. Coordinates resets across `GraphView`, `BalanceChartView`, `TimelineView`, and the journal. |

---

## Key Concepts

### Events

Events are time-stamped messages placed on the queue via `sim.schedule(...)` or the convenience helpers. When `stepTo(date)` is called the simulation dequeues every event whose date ≤ target and calls `execute(event)`.

```js
// One-off
sim.schedule({ date: new Date(2025, 3, 15), type: 'BONUS_PAYMENT', data: { amount: 5000 } });

// Recurring helpers
sim.scheduleAnnually({ startDate, type, data, meta });
sim.scheduleQuarterly({ startDate, type, data, meta });

// Custom interval
sim.scheduleRecurring({ startDate, type, intervalFn: d => DateUtils.addMonths(d, 6), data, meta });
```

`scheduleRecurring` automatically registers a handler that re-queues the same event type for the next period, so the recurrence continues as long as `stepTo` advances time past each scheduled date.

### Handlers

Handlers are registered per event type via `sim.register(type, fn)` or `sim.register(type, new HandlerEntry(fn, name))`. They receive a context object and must return an array of action objects (or `null`/empty for no-ops). Multiple handlers can be registered for the same event type and all will be called.

```js
import { HandlerEntry } from './simulation-framework/handlers.js';
import { AmountAction, RecordMetricAction, RecordBalanceAction } from './simulation-framework/actions.js';

// Anonymous function style
sim.register('QUARTERLY_PL', ({ sim, date, data, meta, state }) => {
  const profit = sim.rng() * 10000;
  return [
    new AmountAction('ADD_CASH', profit),
    new RecordMetricAction('quarterly_profit', profit),
    new RecordBalanceAction()
  ];
});

// Named HandlerEntry style (name appears in debug output)
sim.register('MONTHLY_SALARY', new HandlerEntry(({ data }) => {
  return [new AmountAction('SALARY_CREDIT', data.amount)];
}, 'Monthly Salary'));
```

### Actions

`Action` is the base class for all objects returned by handlers and emitted via `next:[]`. Use the concrete subclasses where they fit, or return plain objects `{ type, ...fields }` for custom action shapes.

```js
new AmountAction('SALARY_CREDIT', 8000)       // { type, amount }
new RecordMetricAction('salary', 8000)         // { type: 'RECORD_METRIC', name, value }
new RecordBalanceAction()                      // { type: 'RECORD_BALANCE' } — no-op marker
```

### Reducers

Reducers consume actions and mutate state. They are pure functions `(state, action) => result` where result can be:

- **Simple state replacement**: return the new state object directly.
- **State + chained actions**: return `{ state: newState, next: [{ type, ...fields }] }`.

```js
sim.reducers.register(
  'REALIZE_GAIN',
  (state, action) => ({
    state: { ...state, realizedGains: state.realizedGains + action.amount },
    next: [{ type: 'CALCULATE_CAPITAL_GAINS_TAX', amount: action.amount }]
  }),
  PRIORITY.COST_BASIS,   // numeric priority; lower runs first
  'Gain Realizer'        // name shown in Journal / ActionGraph
);
```

#### Priority constants (`PRIORITY`)

| Constant | Value | Use |
|---|---|---|
| `PRE_PROCESS` | 10 | Validation, normalization |
| `CASH_FLOW` | 20 | Cash credits and debits |
| `POSITION_UPDATE` | 30 | Portfolio position changes |
| `COST_BASIS` | 40 | Cost basis calculations |
| `TAX_CALC` | 60 | Tax computation |
| `TAX_APPLY` | 70 | Tax payment / withholding |
| `METRICS` | 90 | Derived metrics / KPIs |
| `LOGGING` | 100 | Audit logging |

### Action Graph

Every action processed by the reducer pipeline is recorded as an `ActionNode` in a `SimulationEventGraph`. Child actions produced via `next:[]` are linked to their parent, forming a DAG that can be traversed for causal debugging:

```
Event: SELL_ASSET
└── REALIZE_GAIN (_id=0)
     └── CALCULATE_CAPITAL_GAINS_TAX (_id=1)
          └── RECORD_METRIC capital_gains_tax (_id=2)
```

Graph traversal methods:
- `actionGraph.traceActionChain(rootId)` — DFS from root to leaves.
- `actionGraph.traceActionsUp(id)` — walk parent chain to find root cause.
- `actionGraph.getRootActions()` — all top-level (parentless) actions.

### Snapshots, Rewind & Replay

Snapshot/rewind logic lives in `SimulationHistory` (`sim.history`). The simulation snapshots state (including RNG state and queue) after every N events (`snapshotInterval`, default 1). Convenience methods are forwarded from `Simulation` for backward compatibility.

```js
sim.stepTo(new Date(2030, 0, 1));   // run forward

sim.rewindToDate(new Date(2026, 0, 1));  // restore closest snapshot and step to target
sim.stepTo(new Date(2032, 0, 1));   // continue from rewound point
```

Other rewind methods: `rewind(steps)`, `rewindToStart()`, `restoreSnapshot(index)`.

`sim.history.resetForReplay()` clears the action graph and resets the action ID counter — called by `TimeControls` before replaying so the visualizer starts clean.

**Branching** clones state from the current snapshot cursor so two simulations can diverge from a common checkpoint:

```js
const simA = sim.branch();
const simB = sim.branch();
simA.register('INVEST', conservativeStrategy);
simB.register('INVEST', aggressiveStrategy);
simA.stepTo(end); simB.stepTo(end);
```

### Journal

The journal records every reducer execution:

```js
sim.journal.getActions('ADD_CASH');           // all ADD_CASH reducer entries
sim.journal.getStateTimeline('realizedGains'); // [{date, value}, ...]
sim.journal.traceEvent(new Date(2026, 0, 1)); // all entries on that date
```

### EventBus

Supports typed subscriptions and a wildcard. Published messages are typed `BusMessage` objects.

```js
sim.bus.subscribe('ANNUAL_TAX', handler);  // specific type
sim.bus.subscribe('*', handler);            // all events
sim.bus.getHistory();                       // full event log (for replay / debug)
```

**Two kinds of publishes** reach the bus:
1. **`SimulationBusMessage`** — published when a scheduled event fires (`execute()`) and after each action completes its reducer pipeline (`applyActions()`). Carries `{ type, date, sim, payload, stateSnapshot }`.
2. **`DebugActionBusMessage`** — published once per `ActionNode` added to the graph. Always has `type: 'DEBUG_ACTION'`. Carries `{ date, payload: ActionNode }`. Used by the graph visualizer. Wildcard subscribers should handle the absence of a standard `type` gracefully.

---

## Random Number Generation

`sim.rng()` returns a seeded pseudo-random number in `[0, 1)` using a fast integer hash. The seed is stored in `sim.rngState` and is captured/restored with each snapshot, guaranteeing reproducibility when rewinding or branching.

```js
const sim = new Simulation(startDate, { seed: 42 });
```

---

## Scenario Runner

`ScenarioRunner` wraps `Simulation` for batch and Monte Carlo usage.

```js
const runner = new ScenarioRunner({
  createSimulation: (params, seed) => { /* build and return a configured Simulation */ },
  evaluate: (sim) => { /* extract a result object from sim state/history */ }
});

// Single run
const result = runner.runScenario(params, seed);

// Monte Carlo — perturbs baseParams for each of n seeds
const results = runner.monteCarlo({ n: 1000, baseParams, perturb: (base, i) => ({ ...base }) });

// Statistical summary
const { mean, p10, p50, p90 } = runner.summarize(results, r => r.totalReturn);
```

---

## Finance Domain Objects

### `Account` / `AccountService`

```js
const account = new Account(0);        // initial balance
const svc = new AccountService();
svc.transaction(account, 500, date);   // credit (+) or debit (-)
// account.balance, account.credits[], account.debits[]
```

**Note**: `Account` instances held in simulation state must remain plain data objects — no methods — so that `structuredClone` (used for snapshots) works correctly.

### `Asset`

```js
const asset = new Asset('AAPL', 15000, 10000); // name, value, costBasis
const gain = asset.value - asset.costBasis;      // realized gain on sale
```

---

## Visualization

`index.html` is the home page listing available simulations. Each simulation has its own HTML file (e.g. `retirement-sim.html`).

Each app extends `BaseApp` (`apps/base-app.js`), which provides:
- A canvas-based action DAG via `GraphView`
- A canvas line chart of account balances over time via `BalanceChartView`
- A scrollable journal timeline via `TimelineView`
- Play/pause, step forward/back, reset, and a time slider wired through `TimeControls`
- A node detail panel showing action payload and state diff on click

`TimeControls` drives the simulation forward with `sim.stepTo(...)` and backward by calling `sim.history.resetForReplay()`, `sim.rewindToStart()`, then replaying to the target date.

---

## Building ESM

```text
npm install --save-dev rollup @rollup/plugin-terser
npm install --save-dev @babel/parser
```

```text
npm run build
```
---

## Testing

Tests are in `tests/` using the Node.js built-in `node:test` runner. No npm or build step required.

```sh
make setup   # once — installs Node.js via nvm or Homebrew
make test    # run all *.test.mjs files
```

Or directly:

```sh
node --test tests/simulation.test.mjs
node --test tests/scenario.test.mjs
```

### Test helper: `Assert`

`tests/helpers/assert.js` provides `Assert.datesEqual(d1, d2)` for comparing dates by year/month/day without time-of-day noise.

### Current test files

| File | Coverage |
|---|---|
| `tests/simulation.test.mjs` | Event scheduling (annual, quarterly), EventBus subscriptions (wildcard, typed), handler registration, reducer/action chaining, complex multi-event scenario |
| `tests/scenario.test.mjs` | `ScenarioRunner.monteCarlo`, `ScenarioRunner.summarize` |

### Adding tests

Follow the existing pattern — import from `node:test` and `node:assert/strict`, import framework modules directly as ES modules, and name the file `*.test.mjs`.

---

## Coding Conventions

- **State must be plain data.** No class instances with methods in `initialState` — `structuredClone` is used for snapshots. Use service objects (e.g. `AccountService`) outside state to operate on plain state data.
- **Handlers return actions; reducers return state.** Handlers are the bridge between events and the reducer pipeline. Reducers are pure (no side effects beyond state).
- **Chaining is via `next:[]`.** Reducers that need to trigger further state changes emit child actions through `next`, not by calling other reducers directly.
- **Use `Action` subclasses for typed actions.** Prefer `new AmountAction(...)`, `new RecordMetricAction(...)`, etc. over raw plain objects where a concrete class exists.
- **Imports are relative ES module paths.** No bundler; all files must use `.js` extensions in import statements (even from `.mjs` test files).
- **No external dependencies.** The framework and tests rely only on browser/Node built-ins.
