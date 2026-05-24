# Financial Simulator Framework (fin-sim-framework)

A deterministic, event-driven simulation framework for modeling complex financial workflows over time. Supports recurring and one-off scheduled events, prioritized action/reducer chains, state snapshots for rewind and replay, Monte Carlo scenario runs, and an interactive visual builder for constructing simulation graphs.

The library is packaged as **FinSimLib** (`financial-sim` on npm) and ships three build formats — ESM, CJS, and UMD — built with Rollup into the `dist/` directory. The demo web app is bundled alongside the library so the same directory can be deployed as a static site.

---

## Application Entry Point

The primary application flow is:

```
index.html
  └── assets/js/custom-app.js        (CustomApp extends BaseApp)
        └── assets/js/scenarios/custom-scenario.js  (CustomScenario extends BaseScenario)
```

`index.html` bootstraps the app, loading the UMD build (`FinSimLib`) and initialising a `CustomApp`. `CustomApp` handles UI wiring and save/load; `CustomScenario` defines the events, handlers, actions, and reducers for the simulation.

Other top-level HTML files and apps in `assets/js/` are legacy — only the `index.html` / `custom-app` flow is actively maintained.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Browser Application                           │
│                                                                      │
│   index.html → CustomApp (extends BaseApp)                           │
│                   │                                                   │
│         ┌─────────┴──────────┐                                       │
│         │   EventScheduler   │  Visual graph builder (nodes + edges) │
│         │  (ConfigGraphBuilder)  SVG drag-and-drop canvas            │
│         └─────────┬──────────┘                                       │
│                   │  creation / click events                         │
│                   ▼                                                   │
│   CustomScenario (extends BaseScenario)                              │
│         │                                                             │
│         │  registerHandler / registerReducer / scheduleEvent         │
│         ▼                                                             │
│   ServiceRegistry (singleton per scenario build)                     │
│     ├── EventBus  ◀── ServiceActionEvents (CREATE / UPDATE / DELETE) │
│     ├── EventService                                                  │
│     ├── HandlerService                                                │
│     ├── ActionService                                                 │
│     ├── ReducerService                                                │
│     └── SimulationRegistry                                           │
│                   │                                                   │
│                   ▼                                                   │
│   ┌───────────────────────────────────────────────────────┐          │
│   │                     Simulation                         │          │
│   │  queue(MinHeap)  state  handlers  reducers  journal    │          │
│   │  stepTo(date)  →  execute(event)  →  applyActions()   │          │
│   │         └── HandlerRegistry  →  ReducerPipeline        │          │
│   │                   └── state mutation + chained actions │          │
│   └───────────────────────────────────────────────────────┘          │
│                   │                                                   │
│         ┌─────────┴──────────┐                                       │
│         │     ChartView      │  Chart.js powered time-series chart    │
│         │     TimelineView   │  Scrollable journal log                │
│         │     TimeControls   │  Play/pause/step/rewind slider         │
│         └────────────────────┘                                       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Layer Reference

### Simulation Framework (`src/simulation-framework/`)

The core simulation engine. Unchanged in structure from earlier versions.

| Module | File | Responsibility |
|---|---|---|
| `Simulation` | `simulation.js` | Orchestrator. Owns the event queue, handler registry, reducer pipeline, state, journal, and action graph. Delegates snapshot/rewind to `SimulationHistory`. |
| `SimulationHistory` | `simulation-history.js` | Manages snapshot array; all rewind/replay/branching navigation. Holds `snapshotCursor` and `eventCounter`. |
| `EventBus` | `event-bus.js` | Pub/sub with wildcard support. Keeps a full message history for replay and debug. Receives typed `BusMessage` objects. |
| `BusMessage` / `SimulationBusMessage` / `DebugActionBusMessage` / `ServiceActionEvent` | `bus-messages.js` | Typed message wrappers. `ServiceActionEvent` is new — published by services on CREATE / UPDATE / DELETE so the sim and graph stay in sync. |
| `Action` / `AmountAction` / `RecordMetricAction` / `RecordArrayMetricAction` / `RecordNumericSumMetricAction` / `RecordMultiplicativeMetricAction` / `RecordBalanceAction` | `actions.js` | Base and concrete action classes. **All actions now default `id = type`** — set in the constructor so services never need to assign it manually. |
| `HandlerEntry` / `HandlerRegistry` | `handlers.js` | `HandlerEntry` wraps a handler function with a name, `handledEvents`, and `generatedActions` arrays. Defaults `id = null` — assigned by `HandlerService`. |
| Reducer classes / `ReducerPipeline` / `PRIORITY` | `reducers.js` | Prioritized reducer chain. All reducer subclasses now default `id = null` — assigned by `ReducerService`. Built-in: `MetricReducer`, `ArrayMetricReducer`, `NumericSumMetricReducer`, `MultiplicativeMetricReducer`, `FieldReducer`, `StateFieldReducer`, `NoOpReducer`. |
| `EventSeries` / `OneOffEvent` / `BaseEvent` | `events/` | Configuration objects for recurring and one-off events. Default `id = null` — assigned by `EventService`. |
| `Journal` | `journal.js` | Append-only log of every `(action, prevState, nextState)` tuple. |
| `SimulationEventGraph` | `simulation-event-graph.js` | DAG of all `ActionNode`s produced during a run for causal tracing. |
| `MinHeap` / `IndexedMinHeap` | `min-heap.js`, `indexed-min-heap.js` | Priority queues keyed on event date. |
| `DateUtils` | `date-utils.js` | Stateless date arithmetic (`addDays`, `addMonths`, `addYears`, `endOfMonth`, `endOfYear`). |
| `ScenarioRunner` | `scenario.js` | Batch and Monte Carlo runner plus a `summarize` helper (mean, p10/p50/p90). |

#### Fluent Builders (`src/simulation-framework/builders/`)

Every domain type has a fluent builder so scenarios read as configuration rather than imperative code:

```js
// Actions
ActionBuilder.amount().type('SALARY').name('Monthly Salary').value(8000).build()
ActionBuilder.recordMetric().name('Record Salary').fieldName('salary').build()
ActionBuilder.recordNumericSum().name('Accumulate').fieldName('totalSalary').build()
ActionBuilder.recordBalance().build()

// Reducers
ReducerBuilder.metric('salary').name('Salary Reducer').build()
ReducerBuilder.numericSum('totalSalary').name('Total Salary').build()
ReducerBuilder.arrayMetric('deposits').name('Deposit Log').build()
ReducerBuilder.noOp().name('Debug').build()

// Handlers
HandlerBuilder.fn(({ data, date, state }) => [...this.generatedActions])
  .name('Salary Handler')
  .handledEvent(salaryEvent)
  .generatedAction(salaryAction)
  .build()

// Events
EventBuilder.series().type('MONTH_END').name('Month End').interval('month-end').build()
EventBuilder.oneOff().type('BONUS').name('Bonus').date(new Date(...)).build()
```

---

### Service Layer (`src/services/`)

The service layer is the **authoritative source of truth** for all configuration items. All UI edits flow through services; the simulation is kept in sync via bus events — not by direct mutation.

```
UI change → service.updateX(id, changes) → ServiceActionEvent on bus
                                              └── BaseScenario subscriber re-wires sim
Save      → ScenarioSerializer.serialize(ServiceRegistry.getInstance(), ...)
                                    └── reads from service.getAll()
```

#### `ServiceRegistry`

Singleton reset on each scenario rebuild. Holds the shared `EventBus` and all four services.

```js
const { eventService, handlerService, actionService, reducerService, simulationRegistry }
  = ServiceRegistry.getInstance();

ServiceRegistry.reset(); // called by BaseApp.buildScenario() before each rebuild
```

#### `BaseService`

Base class for all four services. Owns a `Map<id, item>` as source of truth.

- `get(id)` / `getAll()` — read items
- `load(item)` — register an externally-created item (no bus event); auto-assigns `id` if `null`
- `_generateId(prefix)` — generates `prefix + N` IDs; counter auto-advances on `load()`
- `_publish(actionType, classType, item)` — emits a `ServiceActionEvent` on the bus

#### The Four Services

| Service | ID prefix | Managed type |
|---|---|---|
| `EventService` | `e` | `EventSeries`, `OneOffEvent` |
| `HandlerService` | `h` | `HandlerEntry` |
| `ActionService` | `a` | All `Action` subclasses (id = type string) |
| `ReducerService` | `r` | All `Reducer` subclasses |

Each service exposes `createX(...)`, `updateX(id, changes)`, and `deleteX(id)` methods. Every mutating call publishes a `ServiceActionEvent` (`CREATE` / `UPDATE` / `DELETE`) on the shared bus.

**ID assignment is owned entirely by the services.** Domain objects (`Action`, `HandlerEntry`, `Reducer`, `BaseEvent`) all start with `id = null` (except `Action` which sets `id = type` in its constructor). Services assign IDs either via `createX()` or `load()`.

---

### Scenario Layer (`src/scenarios/`)

#### `BaseScenario`

Base class for all simulation scenarios. Wires together the `EventScheduler` UI, the `ServiceRegistry`, and the `Simulation`.

**Construction listeners** (EventScheduler `+` buttons) remain registered in the constructor. Creation of new nodes goes: button click → `BaseScenario.xCreationRequested()` → `service.createX()` → bus event → graph re-renders.

**Change / delete listeners** have been removed. Instead, `BaseScenario` subscribes to `SERVICE_ACTION` events on the bus and dispatches to internal `_apply*` methods:

```
service.updateX() → ServiceActionEvent(UPDATE) → _applyEventChange / _applyHandlerChange / ...
service.deleteX() → ServiceActionEvent(DELETE) → _applyEventDelete / _applyHandlerDelete / ...
```

Key methods:

```js
scenario.scheduleEvent(event)       // schedule into sim + load into eventService
scenario.registerHandler(handler)   // wire to sim + load into handlerService
scenario.registerReducer(reducer)   // wire to sim + load into reducerService
scenario.registerAction(action)     // load into actionService + add to graph
```

All four methods call `service.load(item)` if the item is not already tracked, ensuring fluent-built or deserialized objects are findable by the editor.

#### `ScenarioSerializer`

Serialize and deserialize scenario configuration to/from plain JSON (for `localStorage`).

```js
// Serialize — reads from service maps (not the graph)
const config = ScenarioSerializer.serialize(
  ServiceRegistry.getInstance(),
  name, simStart, simEnd, initialState, params
);

// Deserialize — reconstructs domain objects and registers them with the scenario
ScenarioSerializer.deserialize(config, scenario);
```

`ScenarioStorage` wraps `localStorage` to load/save the list of scenario configs.

---

### Application Layer (`src/apps/`)

#### `BaseApp`

Base class for browser apps. Owns the top-level UI orchestration:

- Builds `ConfigGraphBuilder` (the draggable SVG node graph) and `EventScheduler` (editor panel + `+` buttons)
- Builds `ChartView` (Chart.js time-series chart), `TimelineView` (scrollable journal), and `TimeControls` (play/pause/step slider)
- Handles scenario save/load via `ScenarioStorage` and `ScenarioSerializer`
- Calls `ServiceRegistry.reset()` then `newScenario(ui)` on each rebuild so the service maps, bus, and simulation start clean

**Save flow:**
```
_saveCurrentScenario()
  → ScenarioSerializer.serialize(ServiceRegistry.getInstance(), ...)
  → ScenarioStorage.save(config)
```

---

### Visualization Layer (`src/visualization/`)

| Module | File | Responsibility |
|---|---|---|
| `EventScheduler` | `event-scheduler.js` | Wraps `ConfigGraphBuilder`; renders node editors (event / handler / action / reducer) in a side panel; subscribes to the service bus to re-render the graph on any change. All editor inputs call `service.updateX(id, changes)` directly. |
| `ConfigGraphBuilder` | `graph-builder.js` | SVG drag-and-drop node/edge canvas for the simulation configuration graph. **Display only** — not a source of truth. Nodes are keyed by domain object `id`. |
| `ChartView` | `chart-view.js` | Chart.js-backed time-series chart. Series discovered automatically from data snapshot keys. Supports `chartjs-plugin-annotation` and `chartjs-plugin-zoom`. |
| `TimelineView` | `timeline-view.js` | Scrollable DOM journal timeline. |
| `TimeControls` | `time-controls.js` | Bridges the play/pause/step/slider UI to `sim.stepTo`, `sim.rewindToStart`, and replay. |
| `GraphView` | `graph-view.js` | Canvas renderer for the simulation action DAG (runtime execution graph). |

---

## Key Concepts

### Events

Events are time-stamped messages placed on the queue. The simulation dequeues events in date order when `stepTo(date)` is called.

```js
// One-off event object (id defaults to null; assigned by EventService or BaseScenario.scheduleEvent)
const event = EventBuilder.oneOff().type('BONUS').name('Year-End Bonus')
  .date(new Date(Date.UTC(2027, 11, 31))).enabled(true).build();

// Recurring series
const series = EventBuilder.series().type('MONTH_END').name('Month End')
  .interval('month-end').enabled(true).build();
```

Supported intervals: `monthly`, `quarterly`, `annually`, `month-end`, `year-end`.

### Handlers

Handlers receive a context object and return an array of `Action` instances. A `HandlerEntry` holds the function, a display name, the `handledEvents` it responds to, and the `generatedActions` it may emit.

```js
const handler = HandlerBuilder
  .fn(function({ data, date, state }) { return [...this.generatedActions]; })
  .name('Salary Handler')
  .handledEvent(monthEndEvent)
  .generatedAction(salaryAction)
  .build();

scenario.registerHandler(handler);
```

Multiple handlers can be registered for the same event type and all will fire.

### Actions

`Action` is the base class. All concrete subclasses set `id = type` in the constructor so the type string doubles as the stable identity key used by services.

```js
ActionBuilder.amount().type('SALARY').name('Monthly Salary').value(8000).build()
// → AmountAction { id: 'SALARY', type: 'SALARY', name: 'Monthly Salary', value: 8000 }
```

| Builder | Class | Description |
|---|---|---|
| `ActionBuilder.amount()` | `AmountAction` | Cash credit or debit by amount |
| `ActionBuilder.recordMetric()` | `RecordMetricAction` | Set a metrics field to a value |
| `ActionBuilder.recordNumericSum()` | `RecordNumericSumMetricAction` | Accumulate a running numeric sum |
| `ActionBuilder.recordArrayMetric()` | `RecordArrayMetricAction` | Append a value to a metrics array |
| `ActionBuilder.recordMultiplicative()` | `RecordMultiplicativeMetricAction` | Apply a multiplicative factor |
| `ActionBuilder.recordBalance()` | `RecordBalanceAction` | Record the current balance as a snapshot |

### Reducers

Reducers consume actions and mutate state. They are registered against one or more action types via `reducer.registerWith(sim.reducers, actionType)`.

```js
const reducer = ReducerBuilder.metric('salary').name('Record Salary').build();
reducer.reducedActions.push(salaryAction);
scenario.registerReducer(reducer);
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

### EventBus and ServiceActionEvent

Two distinct buses exist:

1. **Simulation `EventBus`** — carries `SimulationBusMessage` (event fires) and `DebugActionBusMessage` (action graph node added). Lives on `sim.bus`.
2. **Service `EventBus`** — shared across all services via `ServiceRegistry`. Carries `ServiceActionEvent` with `{ actionType: 'CREATE'|'UPDATE'|'DELETE', classType, item, originalItem }`. `BaseScenario` and `EventScheduler` both subscribe to re-wire the sim and re-render the graph respectively.

### Snapshots, Rewind & Replay

`SimulationHistory` (`sim.history`) manages all snapshot/rewind/branch logic.

```js
sim.stepTo(new Date(2030, 0, 1));
sim.rewindToDate(new Date(2027, 0, 1));   // restore nearest snapshot + step forward
sim.stepTo(new Date(2032, 0, 1));         // continue from rewound point

const branch = sim.branch();              // clone from current snapshot cursor
```

### Journal

```js
sim.journal.getActions('SALARY');              // all SALARY reducer entries
sim.journal.getStateTimeline('metrics.salary'); // [{date, value}, ...]
sim.journal.traceEvent(new Date(2027, 0, 1));  // all entries on that date
```

---

## Finance Domain (`src/finance/`)

### Account / Asset / Person

| Module | File | Responsibility |
|---|---|---|
| `Account` / `AccountService` | `account.js` | Simple ledger with credit/debit history. State must be plain data (no methods) for `structuredClone` compatibility. |
| `InvestmentAccount` | `investment-account.js` | Investment account with holdings and cost-basis tracking. |
| `Asset` / `AssetService` | `asset.js`, `asset-service.js` | Named asset with value and costBasis; service for asset transactions. |
| `Person` / `PersonService` | `person.js` | Person model (age, income, filing status) used by tax and account modules. |

### Period

`PeriodService` and the builder helpers (`buildUsCalendarYear`, `buildAuFiscalYear`) define fiscal / calendar periods used for tax settlement and periodic rule evaluation.

### Tax Engine

`TaxEngine` is a year-keyed registry. Register one module per jurisdiction per year:

```js
const taxEngine = new TaxEngine();
taxEngine.register(2026, new UsTaxModule2026(UsTaxRates2026));
const result = taxEngine.calculate(person, income, date);
```

US (`UsTaxModule*`) and Australian (`AuTaxModule*`) modules are available for 2024–2026.

### Account Rules Engine

`AccountRulesEngine` follows the same registry pattern, encoding contribution limits and eligibility rules:

```js
const rulesEngine = new AccountRulesEngine();
rulesEngine.register(2026, new UsAccountModule2026());
const limit = rulesEngine.getContributionLimit('401k', person, date);
```

---

## Scenario Runner (Monte Carlo)

```js
const runner = new ScenarioRunner({
  createSimulation: (params, seed) => { /* build and return a configured Simulation */ },
  evaluate: (sim) => { /* extract a result from sim state/history */ }
});

const results = runner.monteCarlo({ n: 1000, baseParams, perturb: (base, i) => ({ ...base }) });
const { mean, p10, p50, p90 } = runner.summarize(results, r => r.totalReturn);
```

---

## Library Packaging

The library entry point is `src/index.js` (auto-generated — do not edit). Built by Rollup into `dist/`:

| Output | Format | Use case |
|---|---|---|
| `dist/index.esm.js` | ESM | Modern bundlers |
| `dist/index.cjs.js` | CJS | Node.js `require()` |
| `dist/index.umd.min.js` | UMD | `<script>` tag → `window.FinSimLib` |

### Exports

```js
// ESM / bundler
import { Core, Finance } from 'financial-sim';

// Browser UMD
const { Core, Finance } = window.FinSimLib;
```

| Export | Contents |
|---|---|
| `Core` | Simulation engine: `Simulation`, action/handler/reducer/event classes and builders, `EventBus`, `Journal`, `PRIORITY`, `ScenarioRunner`, etc. |
| `Finance` | Finance domain: accounts, assets, person, periods, `TaxEngine`, `AccountRulesEngine`, jurisdiction modules and rate tables |
| `Misc` | `BaseApp`, `BaseScenario` |
| `Visualization` | `GraphView`, `ChartView`, `TimelineView`, `TimeControls` |

Regenerate `src/index.js` after adding or removing exported modules:

```sh
npm run build:index
```

### Build commands

```sh
npm install          # install devDependencies
npm run build        # build → dist/
npm run dev          # build + watch + live-server on :8080
npm start            # live-server only (dist/ must be already built)
npm run test         # run all unit tests
npm run test:viz     # run viz tests (jest + jsdom)
```

---

## Testing

Tests use the Node.js built-in `node:test` runner. No build step required.

```sh
node --test tests/unit/*.test.mjs    # all unit tests
node --test tests/unit/simulation.test.mjs  # specific file
```

Visualization tests (`tests/viz/`) use Jest with jsdom — see `jest.config.cjs`.

### Test structure

```
tests/
  unit/        Node-only tests. No DOM, no FinSimLib global required.
  viz/         Browser-environment tests via Jest + jsdom.
```

| Category | Examples |
|---|---|
| Simulation engine | `simulation.test.mjs`, `simulation-history.test.mjs`, `journal.test.mjs`, `event-bus.test.mjs` |
| Domain objects | `reducers.test.mjs`, `action-builder.test.mjs`, `reducer-builder.test.mjs`, `handler-builder.test.mjs`, `event-builder.test.mjs` |
| Finance domain | `account.test.mjs`, `asset.test.mjs`, `investment-account.test.mjs`, `person.test.mjs`, `period-service.test.mjs`, `asset-rules.test.mjs` |
| Tax / account event scenarios | `evt-401k.test.mjs`, `evt-ira.test.mjs`, `evt-roth.test.mjs`, `evt-us-brokerage.test.mjs`, `evt-au-brokerage.test.mjs`, `evt-real-property.test.mjs`, `evt-super.test.mjs`, `evt-au-savings.test.mjs` |
| Service layer | `service-registry.test.mjs`, `base-scenario.test.mjs`, `scenario-serializer.test.mjs` |
| Visualization | `base-app.test.mjs`, `graph-builder.test.mjs`, `balance-chart-view.test.mjs`, `timeline-view.test.mjs`, `time-controls.test.mjs` |

### Test helper

`tests/helpers/assert.js` provides `Assert.datesEqual(d1, d2)` for date comparisons without time-of-day noise.

---

## Coding Conventions

- **State must be plain data.** No class instances with methods in `initialState` — `structuredClone` is used for snapshots. Use service objects (e.g. `AccountService`) outside state to operate on plain state data.
- **Handlers return actions; reducers return state.** Handlers bridge events to the reducer pipeline. Reducers are pure (no side effects beyond state).
- **Use builders.** Prefer `ActionBuilder`, `ReducerBuilder`, `HandlerBuilder`, `EventBuilder` over constructing domain objects directly.
- **IDs are assigned by services.** Domain objects start with `id = null` (except `Action` which sets `id = type`). Never assign IDs manually outside a service.
- **All mutations go through services.** UI editors call `service.updateX(id, changes)`; they never mutate domain objects directly. The service publishes a `ServiceActionEvent` and the sim re-wires itself via the bus subscriber in `BaseScenario`.
- **`ConfigGraphBuilder` is display-only.** It is not a source of truth. `ScenarioSerializer` reads from `ServiceRegistry` service maps, not from the graph.
- **Imports use `.js` extensions.** All `src/` files must use explicit `.js` extensions in ES module import paths (even from `.mjs` test files). Tests import directly from `src/` — they do not go through `dist/`.
- **`src/index.js` is auto-generated.** Run `npm run build:index` after adding or removing exported classes; do not edit it manually.
- **No external runtime dependencies.** The framework and tests rely only on browser/Node built-ins. Dev tools are `devDependencies` only.
