# Financial Simulator Framework (fin-sim-framework)

A deterministic, event-driven simulation framework for modelling and replaying complex financial workflows over time. Supports recurring and one-off scheduled events, prioritized action chains, state snapshots for rewind/replay, Monte Carlo scenario runs, and an interactive graph visualization.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────┐
│                     Simulation                        │
│  currentDate  queue(MinHeap)  state  rng  snapshots  │
│                                                       │
│  scheduleAnnually / scheduleQuarterly / schedule      │
│  ──▶  queue.push(event)                               │
│                                                       │
│  stepTo(targetDate)                                   │
│    └─ dequeue events in date order                    │
│         └─ execute(event)                             │
│              ├─ EventBus.publish  ◀── subscribers     │
│              └─ Handlers ──▶ Actions                  │
│                   └─ ReducerPipeline                  │
│                        ├─ state mutation              │
│                        ├─ chained actions (next:[])   │
│                        ├─ Journal entry               │
│                        └─ ActionGraph node            │
└──────────────────────────────────────────────────────┘
```

### Core modules

| Module | File | Responsibility |
|---|---|---|
| `Simulation` | `simulation-framework/simulation.js` | Orchestrator. Owns the event queue, handlers, reducer pipeline, state, snapshots, journal and action graph. |
| `EventBus` | `simulation-framework/event-bus.js` | Pub/sub with wildcard support. Keeps a full history for replay/debug. |
| `ReducerPipeline` | `simulation-framework/reducers.js` | Prioritized chain of pure reducer functions that mutate state and optionally emit child actions. |
| `Journal` | `simulation-framework/journal.js` | Append-only log of every `(action, prevState, nextState)` tuple for audit and timeline queries. |
| `SimulationEventGraph` | `simulation-framework/simulation-event-graph.js` | Directed acyclic graph of all `ActionNode`s produced during a run, enabling causal tracing. |
| `MinHeap` | `simulation-framework/min-heap.js` | Priority queue keyed on event date. |
| `DateUtils` | `simulation-framework/date-utils.js` | Stateless date arithmetic (addDays, addMonths, addYears). |
| `ScenarioRunner` | `simulation-framework/scenario.js` | Batch and Monte Carlo runner plus a `summarize` helper (mean, p10/p50/p90). |
| `Account` / `AccountService` | `finance/account.js` | Simple ledger with credit/debit history. |
| `Asset` | `finance/asset.js` | Named asset with value and costBasis. |

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

Handlers are registered per event type and receive a context object:

```js
sim.register('QUARTERLY_PL', ({ sim, date, data, meta, state }) => {
  const profit = sim.rng() * 10000;
  return [
    { type: 'ADD_CASH', amount: profit },
    { type: 'RECORD_METRIC', name: 'quarterly_profit', value: profit }
  ];
});
```

Handlers **must return** an array of action objects (or `null`/empty array for no-ops). Multiple handlers can be registered for the same event type and all will be called.

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

The simulation snapshots state (including RNG state and queue) after every N events (`snapshotInterval`, default 1). This allows:

```js
sim.stepTo(new Date(2030, 0, 1));   // run forward

sim.rewindToDate(new Date(2026, 0, 1));  // restore closest snapshot and step to target
sim.stepTo(new Date(2032, 0, 1));   // continue from rewound point
```

Other rewind methods: `rewind(steps)`, `rewindToStart()`, `restoreSnapshot(index)`.

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

Supports typed subscriptions and a wildcard:

```js
sim.bus.subscribe('ANNUAL_TAX', handler);  // specific type
sim.bus.subscribe('*', handler);            // all events
sim.bus.getHistory();                       // full event log (for replay / debug)
```

**Important**: the bus receives two kinds of publishes:
1. The **event** itself (type = event type, e.g. `QUARTERLY_PL`) — always has `date`.
2. **`DEBUG_ACTION`** events emitted per reducer execution — used by the graph visualizer. These have `payload` as an `ActionNode` but may lack `date`. Wildcard subscribers should handle this gracefully.

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

## Visualization (`index.html`)

`index.html` loads `app.js` which wires up a `GraphView` over the `SimpleProfitLoss` simulation. The UI shows:

- A canvas rendering action nodes and edges as an animated DAG.
- A right-hand panel with node details on click.
- Time controls: play/pause, step forward, step back, reset, and a slider.

`GraphView` calls `sim.stepTo(...)` and `sim.rewindToDate(...)` to drive the visualizer forward and backward through the simulation's snapshot chain.

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
- **Imports are relative ES module paths.** No bundler; all files must use `.js` extensions in import statements (even from `.mjs` test files).
- **No external dependencies.** The framework and tests rely only on browser/Node built-ins.
