# Financial Simulator Framework (fin-sim-framework)

A deterministic, event-driven simulation framework for modeling complex financial workflows over time. It is purpose-built around the **International Retirement** scenario (US + AU cross-border retirement) and exposes those mechanics through a pluggable workbench UI, declarative scenario composition (toolsets), Monte Carlo, and parameter optimization.

> **Audience**: this README is the orientation guide for anyone (human or AI) joining the codebase. It documents the **current architecture** and how to extend it. Deeper, per-feature designs live in `design/*.md`. Known inconsistencies and rework candidates are tracked in [`design/inconsistencies.md`](design/inconsistencies.md).

---

## Quickstart

```sh
npm install
npm run dev          # vite dev server on http://localhost:5173
npm run build        # production app build → dist/
npm run build:lib    # library build → dist-lib/ (ESM)
npm run build:all    # both
npm run build:index  # regenerate src/index.js (auto-generated)

npm run test:unit    # node --test on tests/unit/**/*.test.mjs
npm run test:viz     # jest + jsdom on tests/viz/
npm test             # both

npm run requirements # check coverage against JP Spec requirements
```

The dev server entry point is `index.html` → `src/main.js` → `SimulationWorkbench`.

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                Browser App                                  │
│  index.html → main.js → SimulationWorkbench → WorkbenchApp → BaseApp        │
│                                                                             │
│  ┌──────────────────────── WorkbenchShell ─────────────────────────────┐    │
│  │   Dockable plugins:                                                 │    │
│  │   scenario · mc-config · opt-config · config-list · inspector       │    │
│  │   config-graph · timeline · chart · mc-results · opt-results        │    │
│  │   state-panel · action-detail · mc-runs · opt-runs · exec-history   │    │
│  │   lineage · dashboard · perf                                        │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                              ▲   reads/edits                                │
│                              │                                              │
│  ┌─────────────────────── ServiceRegistry ─────────────────────────────┐    │
│  │   bus (EventBus) ─ SERVICE_ACTION ─► SimulationSync (re-wires sim)  │    │
│  │   graph (Graph, single)                                             │    │
│  │     config layer   → events, handlers, actions, reducers,           │    │
│  │                       persons, accounts, real-properties, …         │    │
│  │     execution layer → runtime instances added during stepTo()       │    │
│  │   graphQueryApi · stateRegistry · schemaRegistry                    │    │
│  │   personService · accountService · realPropertyService · …          │    │
│  │   eventService · handlerService · actionService · reducerService    │    │
│  │   scenarioRegistry · scenarioService · simulationRegistry           │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                              ▲                                              │
│  ┌────────────────────────── Simulation ───────────────────────────────┐    │
│  │   IndexedMinHeap (event queue) · state · journal                    │    │
│  │   HandlerRegistry · ReducerPipeline                                 │    │
│  │   ExecutionGraph (records runtime nodes/edges into the same Graph) │    │
│  │   SimulationHistory (snapshots, rewind, branch)                    │    │
│  │   control { paused, breakpointNodeIds, pendingExecution, … }       │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                              ▲                                              │
│  ┌──────────────────────── ScenarioLoader ─────────────────────────────┐    │
│  │   if cfg.toolsets:       ScenarioCompiler.compile(cfg, services)   │    │
│  │   else if cfg has graph: ScenarioSerializer.deserializeGraph(…)    │    │
│  │   persons/accounts: ScenarioSerializer.deserializePersonsAccounts  │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                              ▲                                              │
│  ┌─────────────────────── BaseScenario ────────────────────────────────┐    │
│  │   static getParamSchema() · static getToolsets()                    │    │
│  │   static buildDefaultConfig(params, simStart, simEnd)               │    │
│  │   IntlRetirementScenario — the production scenario subclass         │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Three layers, top to bottom:**

1. **Simulation engine** (`src/simulation-framework/`) — pure, deterministic. Owns the event queue, action/reducer pipeline, journal, history, and execution-graph recorder. No DOM, no domain knowledge.
2. **Finance + service domain** (`src/finance/`, `src/services/`, `src/scenarios/`) — domain types (persons, accounts, real property, collectibles), per-year **tax** and **account-rules** modules, declarative **toolsets**, and the services that own them. Domain logic plugs into the engine via handlers and reducers.
3. **Visualization + apps** (`src/visualization/`, `src/apps/`) — the workbench shell, plugins, editors, charts, timelines, and Monte Carlo / optimization UIs. Reads everything from the services; mutations always flow back through them.

---

## Build & Tooling

- **Vite** is the build tool. Two configs:
  - `vite.config.js` — production app build (entry: `index.html` → `src/main.js`).
  - `vite.lib.config.js` — library build for consumers (`@terrypacker/financial-sim`).
- Output dirs are `dist/` (app) and `dist-lib/` (library, ESM-only).
- `src/index.js` is **auto-generated** by `scripts/dev/build-index.js` from the directory tree. Regenerate after adding/removing exported modules: `npm run build:index`. Do not edit `src/index.js` manually.
- **No runtime dependencies.** Dev-only deps: `vite`, `jest`, `jest-environment-jsdom`, `@babel/parser`, `echarts` (used by the graph renderer in the workbench UI).

History note: the project previously used Rollup; see `design/14-vite-migration.md`.

---

## Simulation Engine (`src/simulation-framework/`)

| Module | File | Responsibility |
|---|---|---|
| `Simulation` | `simulation.js` | Orchestrator. Owns the event queue, state, journal, handler registry, reducer pipeline, breakpoint control, and `ExecutionGraph`. `stepTo(date)` dequeues events in date order and runs them through the pipeline. |
| `SimulationHistory` | `simulation-history.js` | Snapshot array, rewind, replay, branching. `snapshotCursor`, `eventCounter`. |
| `SimulationState` | `simulation-state.js` | Helpers for assigning stable `stateKey` slots to accounts/people inside `sim.state`. |
| `ExecutionGraph` | `execution-graph.js` | Records runtime execution into the **same** singleton `Graph` as the config layer. Edge types: `INSTANCE_OF`, `EXECUTES`, `EMITS`, `SCHEDULES`. |
| `GraphRecorder` | `graph-recorder.js` | Subscribes to `EXECUTION_BEGIN`/`EXECUTION_END` and writes nodes/edges via `ExecutionGraph`. |
| `EventBus` | `event-bus.js` | Pub/sub with wildcard support. Keeps a full message history for replay/debug. Used both for `SERVICE_ACTION` and for execution telemetry. |
| Bus messages | `bus-messages.js` | `BusMessage`, `SimulationBusMessage`, `ExecutionBusMessage`, `BreakpointHitMessage`. Discriminators: `type` / `subtype` / `kind` (`EVENT`/`HANDLER`/`ACTION`/`REDUCER`). Hierarchical `executionId` (e.g. `e1.1:h1.1:a1.1`). |
| `Action` and subclasses | `actions.js` | `Action`, `FieldAction`, `FieldValueAction`, `AmountAction`, `RecordBalanceAction`, `ScriptedAction`, `RecordMetricAction`, `RecordArrayMetricAction`, `RecordNumericSumMetricAction`, `RecordMultiplicativeMetricAction`. All extend `SimGraphNode` (kind: `'action'`, layer: `'config'`). Each subclass declares a `static type` discriminator used for `TypeRegistry` lookup and serialization round-trips. |
| `ActionDefinition` | `actions.js` | Template that handlers carry in `generatedActionDefinitions`. `instantiate(ctx)` builds a fresh runtime `Action` with a UUID `instanceId`. |
| `HandlerEntry` / `HandlerRegistry` | `handlers.js` | A `HandlerEntry` wraps a function with `handledEvents`, `generatedActionTypes` (for graph edges), and `generatedActionDefinitions` (for runtime instantiation). |
| `Reducer` + subclasses + `ReducerPipeline` | `reducers.js` | Priority-ordered reducer chain keyed by action type. Subclasses: `Reducer`, `AccountTransactionReducer`, `ArrayReducer`, `NumericSumReducer`, `MultiplicativeReducer`, `FieldReducer`, `FieldValueReducer`, `NoOpReducer`, `RepeatingReducer`, `ScriptedReducer`. |
| `Journal` / `JournalEntry` | `journal.js` | Append-only `(action, prevState, nextState)` log; supports filtering, timelines, and traces. |
| `BaseEvent` / `EventSeries` / `OneOffEvent` | `events/` | Recurring vs one-off scheduled events. Series intervals: `monthly`, `quarterly`, `annually`, `month-end`, `year-end`, plus `month/day`-anchored `data.periods` events (see `design/0-period-engine.md`). |
| `MinHeap` / `IndexedMinHeap` | `min-heap.js` / `indexed-min-heap.js` | Priority queues keyed on event date. Indexed variant supports removal by `instanceId` + `type`. |
| `DateUtils` | `date-utils.js` | Stateless date arithmetic. |
| `Distributions` | `distributions.js` | Seeded RNG distributions (uniform, normal, lognormal, beta) for Monte Carlo. |
| `ScenarioRunner` | `scenario.js` | Batch and Monte Carlo runner; `summarize()` returns mean / p10 / p50 / p90 / success rate. |

### Priorities (`PRIORITY`)

| Constant | Value | Purpose |
|---|---|---|
| `PRE_PROCESS` | 10 | Validation, normalization |
| `CASH_FLOW` | 20 | Cash credits / debits |
| `POSITION_UPDATE` | 30 | Portfolio position changes |
| `COST_BASIS` | 40 | Cost-basis math |
| `TAX_CALC` | 60 | Tax computation |
| `TAX_APPLY` | 70 | Tax payment / withholding |
| `METRICS` | 90 | Derived metrics / KPIs |
| `LOGGING` | 100 | Audit logging |

### Execution telemetry

Every execution unit (event / handler / action / reducer) publishes paired `EXECUTION_BEGIN` + `EXECUTION_END` messages with a hierarchical `executionId`. `GraphRecorder` consumes them to build the runtime execution graph in the same singleton `Graph` as the config layer. UI plugins (`exec-history`, `lineage`, `perf`) read from `graphQueryApi`.

### Breakpoints

`sim.control.breakpointNodeIds` is a `Set<string>` of **config-graph node IDs**. Before each handler / action / reducer call, the simulation checks the set, snapshots a `pendingExecution` resume context, and throws an internal `BreakpointSignal` caught inside `stepTo()`. The paused node has **not** executed yet — `sim.state` reflects the state immediately before it.

Resume paths inside `_resumeFromPendingExecution()`:

| `pendingExecution.type` | Resume entry point |
|---|---|
| `handler` | `execute(event, { startHandlerIdx: i })` |
| `action`  | `_processActionQueue([pausedAction, ...rest])` then remaining handlers |
| `reducer` | `_processReducers(action, j, …)` then remaining actions, then remaining handlers |

`control.breakpointsEnabled` is forced off during rewind/replay so snapshot restoration cannot trip a breakpoint.

### Fluent builders (`src/simulation-framework/builders/`)

When you do build wiring by hand (most scenarios should use **toolsets** — see below), prefer the fluent builders over raw constructors:

```js
ActionBuilder.amount().type('SALARY').name('Monthly Salary').value(8000).build();
ReducerBuilder.metric('salary').name('Record Salary').build();
HandlerBuilder.fn(ctx => [...this.generatedActions])
  .name('Salary Handler').handledEvent(monthEnd).generatedAction(salary).build();
EventBuilder.series().type('MONTH_END').interval('month-end').build();
EventBuilder.oneOff().type('BONUS').date(new Date(...)).build();
```

---

## Service Layer (`src/services/`, `src/finance/services/`)

### `ServiceRegistry`

The central singleton. **Reset on every scenario rebuild** via `ServiceRegistry.reset()`. Holds:

- `bus` — the shared `EventBus`.
- `graph` — the single `Graph` instance carrying both config and execution layers.
- `graphQueryApi` — read-only query facade over `graph`.
- Domain services: `personService`, `accountService`, `realPropertyService`, `collectibleService`.
- Wiring services: `eventService`, `handlerService`, `actionService`, `reducerService`.
- `scenarioService`, `scenarioRegistry`, `simulationRegistry`, `simulationSync`.
- `stateRegistry` (semantic state lookups) and `schemaRegistry` (state-field formatting).
- `simulationContext` — a bundled prop bag passed to scenarios.

`ScenarioRegistry` is intentionally preserved across `reset()` so the user's in-memory param edits and active-scenario selection survive a Rebuild. Use `ServiceRegistry.resetAll()` in tests to wipe it too.

### Service contract

All "wiring" services extend `BaseService` and own a `Map<id, item>`. Each domain item is also a `SimGraphNode` and lives in the shared `Graph`. Mutations follow:

```
UI edit → service.update(id, changes)
            ├── update map + graph
            └── publish SERVICE_ACTION on bus
                    └── SimulationSync re-wires the active Simulation
                          (re-schedules events, re-registers reducers, …)
```

`ConfigGraphView` and the workbench panels are display-only — they read through `graphQueryApi`. The graph is **not** a source of truth on its own; the service maps are.

ID prefixes: `EventService` → `e`, `HandlerService` → `h`, `ActionService` → `a` (Action ids default to the action `type` string), `ReducerService` → `r`. Domain objects start with `id = null` and the service assigns the id on `register()` / `create()`.

### `StateRegistry` and `ACCOUNT_ROLES`

Look up state objects by **semantic role** + optional `ownerId` rather than hard-coded `state.xxxAccount` keys. Roles live in `src/finance/state/account-roles.js`:

```js
ACCOUNT_ROLES.ROTH, ACCOUNT_ROLES.IRA, ACCOUNT_ROLES.K401,
ACCOUNT_ROLES.US_SAVINGS, ACCOUNT_ROLES.US_STOCK, ACCOUNT_ROLES.FIXED_INCOME,
ACCOUNT_ROLES.AU_SAVINGS, ACCOUNT_ROLES.AU_STOCK, ACCOUNT_ROLES.SUPER,

const rothState = stateRegistry.getAccount(state, ACCOUNT_ROLES.ROTH, primary.id);
const stateKey  = stateRegistry.getStateKey(ACCOUNT_ROLES.ROTH, primary.id);
```

This is the prerequisite for spouse accounts and multi-person households — handlers no longer assume a specific key shape.

### `StateSchemaRegistry`

Maps state field paths → `ValueType` descriptors (`currency('USD')`, `rate()`, `percentage()`, …) so the UI can format raw journal values consistently. Resolution order: exact path → first glob match → `unknown`. `registerAccount(stateKey, account)` stamps exact paths from a registered Account, overriding glob matches.

---

## Scenarios, Toolsets, and the Compiler

A **scenario** declares (a) the persons / accounts it operates on and (b) the **toolsets** that contribute schedules, handlers, and reducers. The `ScenarioCompiler` consumes that declarative input and registers everything with the simulation services.

### `BaseScenario` (`src/scenarios/base-scenario.js`)

Thin coordinator. Subclasses override three statics:

```js
class IntlRetirementScenario extends BaseScenario {
  static getParamSchema()                              { /* typed param entries */ }
  static getToolsets()                                 { /* ['US_RETIREMENT', 'AU_RETIREMENT', …] */ }
  static buildDefaultConfig(params, simStart, simEnd)  { /* persons + accounts + toolsets */ }
}
```

`buildDefaultConfig()` returns:

```js
{
  toolsets: [...],         // toolset IDs (strings)
  parameters: { ... },     // key → value (flat map)
  params: [ ... ],         // typed UI form: { name, label, type, group, value, node? }
  persons: [ ... ],
  accounts: [ ... ],
  realProperties: [ ... ],
  collectibles: [ ... ]
}
```

### `ScenarioLoader` and the compile-vs-deserialize fork

Single entry point for populating services from a serialized scenario:

- If `cfg.toolsets?.length > 0` → run `ScenarioCompiler.compile(cfg, services)`. The compiler mutates `sim.state` and registers schedules/handlers/reducers. The resulting state is snapshotted back into `cfg.initialState` and the compiled graph is snapshotted into `cfg.events/handlers/actions/reducers` so the next save/load can round-trip.
- Else if the cfg has a saved graph → restore via `ScenarioSerializer.deserializeGraph(cfg, services)`. Used for hand-built scenarios that don't declare toolsets.

Persons / accounts / real-properties / collectibles are restored via `ScenarioSerializer.deserializePersonsAccounts()` **before** the compile step, so the toolset compiler can read them.

`cfg.params` is also param→node-cascaded: any param schema entry with a `node` declaration (e.g. `{ type: 'person', id: …, field: 'birthDate' }`) drives a field update on the matching `cfg.persons` / `cfg.accounts` record before compilation, so edited UI params propagate into the compiled scenario.

### Adding a scenario parameter

There are two ways a parameter enters the surface — pick by whether it is **per-record** or **global**:

1. **Per-record fields → the template-driven path (preferred; design 55).** Balance, growth/dividend/interest rate, contribution basis, wage, retirement date, property value/appreciation/sale-year, the `isTransactionAccount` flag, … are **generated from the live records** at Build/Rebuild, one param per (record × template-field). To expose a new per-record field, add a one-line entry to the relevant template in `src/scenarios/params/record-param-templates.js` (`{ field, label, type, mc, opt, money?, nullable? }`) — nothing else. `ScenarioParamGenerator.generate(cfg)` emits a namespaced, node-carrying entry (`acct.<stateKey>.<field>`, `person.<id>.<field>`, `prop.<stateKey>.<field>`, `coll.…`, `equity.…`) that seeds from the record and cascades back onto it, so account/person/property **counts and types stay flexible without touching any schema**. The collectible / company-equity templates ship empty but are already wired, so a field added there auto-generates params too. The generated key carries its own `node`, so the existing cascade + the design-32 **harvest-on-Rebuild** rule (record→param before param→record) protect a direct domain edit from being clobbered.

2. **Global / optimization / cross-border params → static schema entries.** Keys that are not per-record (`inflationRate`, `moveYear`, `monthlyExpenses`, global fallback rates like `iraGrowthRate`, optimizer targets) stay hand-authored in a toolset's `paramSchema(context)` or the scenario class's `getParamSchema()`. A per-account rate override *shadows* its global fallback once set — the global remains the default seed for newly-added accounts.

Retiring a former per-record static key: add it to the scenario class's `getParamAliases()` map (`{ legacyKey: 'acct.<stateKey>.<field>' }`) so saved scenarios and MC/Opt configs rewrite to the generated key on load. See `design/55-configuration-driven-parameters.md`, `design/13-prebuilt-scenario-parameters.md` (typed param round-tripping), and `design/32-param-field-linking.md` (linked fields + harvest-on-Rebuild).

### Toolsets (`src/scenarios/toolsets/`)

A toolset is a plain object:

```js
export const US_RETIREMENT = {
  id: 'US_RETIREMENT',
  capabilities: ['retirement'],
  dependencies: ['US_BANKING', 'US_TAX', 'US_INCOME', 'US_BROKERAGE'],

  paramSchema(context) { return [ /* typed param entries */ ]; },
  state(context)       { return { /* state patches */ }; },
  schedules(context)   { return [ /* EventSeries / OneOff */ ]; },
  handlers(context)    { return [ /* HandlerEntry */ ]; },
  reducers(context)    { return [ /* Reducer */ ]; },
};
```

`ToolsetRegistry` maps IDs → toolset objects. `ScenarioLoader` ships with the production set: `US_BANKING`, `US_TAX`, `US_RETIREMENT`, `US_INCOME`, `US_BROKERAGE`, `US_REAL_PROPERTY`, `US_COLLECTIBLES`, `US_ROTH_CONVERSION`, `AU_BANKING`, `AU_TAX`, `AU_RETIREMENT`, `AU_INCOME`, `AU_BROKERAGE`, `AU_REAL_PROPERTY`, `US_AU_CROSS_BORDER`.

`ScenarioCompiler.compile()`:
1. Resolves the toolset dependency graph (DFS, no duplicates).
2. Builds a `context` object with `parameters`, `paramSchema`, `services`, `persons`, `accounts`, etc.
3. Collects state patches, schedules, handlers, reducers from each toolset (in dependency order).
4. Warns on duplicate `EventSeries` types.
5. Patches `sim.state` (via `structuredClone`), then registers everything with the services.

### `IntlRetirementScenario`

The production scenario. Combines all US + AU + cross-border toolsets, exposes ~50 typed parameters via `getParamSchema()`, and seeds defaults in `INTL_RETIREMENT_DEFAULTS`. See `src/scenarios/intl-retirement-scenario.js`.

### Serialization

`ScenarioSerializer`:

- `_serializeEvent/_serializeHandler/_serializeReducer/_serializePerson/_serializeAccount/_serializeRealProperty/_serializeCollectible` — per-type serializers; each class's `toJSON` / `static fromJSON` carries its own fields.
- `deserializeGraph(cfg, services)` — reconstructs graph nodes via `TypeRegistry` lookup (`services.typeRegistry.get(d.__type)`).
- `deserializePersonsAccounts(cfg, services)` — domain objects only.
- `hasSerializedGraph(cfg)` — guard for the fallback branch.

`ScenarioStorage` wraps `localStorage` (a separate `InMemoryStorage` exists at `src/storage/` for tests).

---

## Finance Domain (`src/finance/`)

### People and assets (`src/finance/assets/`, `src/finance/person.js`)

- `Person` — `birthDate`, `lifeExpectancy`, `citizen` (array of ISO-3166-1 alpha-2 codes, e.g. `['US']` or `['US','AU']`), `residency` (current alpha-2 country of tax residency), `monthlyWage`, `socialSecurityMonthly`, `retirementDate`. Country codes are alpha-2 (`'US'`, `'AU'`) project-wide and share the tax `cc` namespace — canonical constants and helpers live in `src/finance/country-codes.js`.
- `Account` / `CheckingAccount` / `SavingsAccount` / `InvestmentAccount` / `BrokerageAccount` / `FourOhOneKAccount` / `RothAccount` / `TraditionalIRAAccount` / `SuperannuationAccount`.
- `RealProperty` and `Collectible` — appreciation, planned sale year, primary-residence handling.
- Each account is stamped at registration with: `stateKey` (slot in `sim.state`), `currency` (`USD` / `AUD`), `role` (`ACCOUNT_ROLES` value), and ownership (`ownerId`, `ownershipType`).

### Tax engine (`src/finance/tax/`)

`TaxEngine` is a per-country, per-year registry of `BaseTaxModule` instances.

- `get(countryCode, year)` returns the highest registered year `<= year`, falling back to the earliest year if none qualifies.
- `registerDynamic(pipeline, countryCodes)` — registers **per-action-type** wrapper reducers at `PRIORITY.TAX_CALC` that read `state.currentPeriods[cc]` at runtime to determine which year's module to delegate to. This is what makes multi-year simulations honor year-over-year rule changes.

Production modules: `UsTaxModule2024/2025/2026`, `AuTaxModule2024/2025/2026`, with rate tables in `*-rates-*.js` and per-year forms in `*-tax-document-*.js` registered via `TaxDocumentRegistry`.

### Account-rules engine (`src/finance/account-rules/`)

Same registry pattern as `TaxEngine`. Per-year `UsAccountModule2024/2025/2026` and `AuAccountModule2024/2025/2026` encode contribution limits, RMD rules, super preservation, early-withdrawal penalties, etc. Handler+reducer pairs for each account type live in dedicated files (`ira-classes.js`, `k401-classes.js`, `roth-classes.js`, `roth-rollover-classes.js`, `ira-rollover-classes.js`, `roth-conversion-classes.js`, `au-super-classes.js`, `au-brokerage-classes.js`, `us-brokerage-classes.js`, `us-rmd-uniform-table.js`, etc.).

### Periods (`src/finance/period/`)

`PeriodService` + builders (`buildUsCalendarYear`, `buildAuFiscalYear`) define fiscal/calendar periods. `state.currentPeriods[cc]` is the per-country current-period pointer the dynamic tax reducers consult. `PERIOD_ADVANCE` and `TAX_SETTLE` are now single `EventSeries` instances driven by `data.periods` rather than N one-off events per year.

### Handlers / reducers

- `src/finance/handlers/` — high-level event handlers (`MonthlyWagesHandler`, `MonthlySocialSecurityHandler`, `MonthlyExpensesHandler`, `OutOfFundsHandler`, `DividendScheduledHandler`, `ChangeResidencyHandler`, `IntlTransferHandlers`, `*EarningsHandler`, ...). Account-module-specific handlers (e.g. `RothContributionHandler`, `K401AnnualRmdHandler`) are colocated with their reducers under `account-rules/`.
- `src/finance/reducers/` — top-level reducers (`ExpenseDebitReducer`, `ReplenishSavingsReducer`, `OutOfFundsReducer`, `AccumulateDeficitReducer`, `SetOutOfFundsDateReducer`, `InflationAdjustReducer`, `ChangeResidencyApplyReducer`, ...).
- `state.scenarioFailed` is set when funds run out; `ScenarioRunner.summarize()` reports a success rate alongside p10/p50/p90.

### Monte Carlo (`src/finance/monte-carlo/`)

- `IntlRetirementMcConfig` — declarative MC config (per-param distribution).
- `IntlRetirementMcRunner` — runs N simulations, evaluates objectives, returns per-run results + summary.

### Optimization (`src/finance/optimization/`)

- `IntlRetirementOptConfig`, `IntlRetirementOptimizer`, `OptimizationObjectives`.
- Iterates parameter space toward a configured objective (max final balance, min cumulative deficit, etc.).

---

## Visualization & Apps

### Workbench shell (`src/visualization/workbench/`)

Dockable, plugin-based UI. Composition:

- `WorkbenchShell` — assembles the layout (outer vertical split: main / bottom; inner horizontal split: left / center / right, with optional nested center-a / center-b split).
- `WorkbenchLayoutModel` — persisted layout (per-storage-key) + saved-template management.
- `TabGroup`, `SplitPane`, `WorkbenchComponent` — the dock primitives.
- `PluginRegistry`, `WorkbenchRuntime` — plugin descriptor registry and shared event bus for plugins (`SCENARIO_READY`, `BREAKPOINT_HIT`, etc.).
- `plugin-sdk.js` exports `definePlugin()` plus `PLUGIN_CATEGORIES` / `PLUGIN_PANES`.

### Finance plugin package (`src/visualization/workbench/plugins/finance/`)

The current finance plugin set, exported as `FINANCE_PLUGINS` + `FINANCE_DEFAULT_LAYOUT`:

| Plugin ID | Title | Purpose |
|---|---|---|
| `scenario` | Scenario | Scenario picker + param editor + Rebuild / Load Defaults / Save |
| `mc-config` / `mc-results` / `mc-runs` | Monte Carlo | Configure, run, and inspect MC sweeps |
| `opt-config` / `opt-results` / `opt-runs` | Optimize | Same triad for optimization |
| `config-list` | Nodes | Flat list of all graph nodes (search + add) |
| `inspector` | Edit | Selected-node editor (mounts the right `*-editor.js`) |
| `config-graph` | Graph | The dockable SVG/echarts node-and-edge canvas |
| `timeline` | Timeline | Journal timeline with filters + CSV download |
| `chart` | Chart | Time-series chart (ECharts) of any numeric `sim.state` path; grouped filter + multi-axis |
| `state-panel` | State | Live state inspector + per-node state-change diffs; click any numeric row to chart/promote it |
| `action-detail` | Action Detail | Selected journal-entry details + payload + before/after |
| `exec-history` | Node History | Per-node execution history (uses ExecutionGraph) |
| `lineage` | Lineage | Upstream/downstream causal tracing for a selected execution node |
| `dashboard` | Dashboard | Headline KPI cards |
| `perf` | Performance | Sim-loop performance telemetry |

`WorkbenchApp` (`src/apps/workbench-app.js`) instantiates the shell with these plugins and offers built-in workspace templates: **Default**, **Analysis**, **Debugging**, **Review**. Users can save their own templates per `storageKey` (`sim-workbench-layout-prod`).

### Editors and config UIs (`src/visualization/`)

- `accounts/`, `people/`, `assets/` — domain editors mounted by the **Configuration List** (`configuration/configuration-list.js`) and the **Node Edit Modal** (`components/node-edit-modal.js`).
- `graph-builder/` — `ConfigGraphView`, `GraphBuilderPresenter`, the orthogonal edge router, collision detection, column layout, the graph inspector panel, exec history, lineage.
- `components/` — base editors (`event-editor`, `handler-editor`, `action-editor`, `reducer-editor`), node-edit modal, multi-select chips, the ECharts graph renderer + node-renderer registry.
- `chart/`, `timeline/`, `simulation/`, `monte-carlo/`, `optimization/`, `scenario/` — Presenter/View/Controller triads for each plugin's content.

### App layer (`src/apps/`)

- `BaseApp` (`base-app.js`) — composition root. Instantiates presenters / views / controllers, wires the scenario lifecycle (`initScenario` / `destroyScenario`), and bridges sim-bus events to the workbench runtime.
- `WorkbenchApp` (`workbench-app.js`) — replaces the legacy static DOM with `WorkbenchShell`-based layout; adds workspace-template handling and bus-bridging.
- `SimulationWorkbench` (`simulation-workbench.js`) — the production entry point. Registers prebuilt scenarios (currently just `IntlRetirementScenario`) and the chart series.

---

## Library Packaging

`src/index.js` is the library entry point and is **auto-generated** by `scripts/dev/build-index.js`. Run `npm run build:index` whenever you add or remove an exported class. The library build (`vite.lib.config.js`, `npm run build:lib`) emits ESM only into `dist-lib/`.

```json
"exports": { ".": { "import": "./dist-lib/index.esm.js" } }
```

Exported namespaces include `Core` (simulation engine + builders + actions + reducers + journal + `PRIORITY` + `ScenarioRunner`), `Finance` (accounts, persons, periods, `TaxEngine`, `AccountRulesEngine`, jurisdiction modules), `Misc` (`BaseApp`, `BaseScenario`), and `Visualization`. The exact surface follows whatever `build-index.js` discovers under `src/` — re-run it after structural changes.

---

## Testing

```sh
npm run test:unit    # node --test  tests/unit/**/*.test.mjs   (~77 unit files)
npm run test:viz     # jest + jsdom tests/viz/
npm test             # both
```

Tests import directly from `src/` (no build step), so all imports use explicit `.js` extensions. The `tests/helpers/assert.js` helper provides `Assert.datesEqual` for time-of-day-tolerant date checks. Mocks live in `tests/__mocks__/`.

Notable suites:

| Category | Where |
|---|---|
| Simulation core | `simulation.test.mjs`, `simulation-history.test.mjs`, `simulation-breakpoints.test.mjs`, `simulation-event-graph.test.mjs`, `journal.test.mjs`, `event-bus.test.mjs` |
| Builders / domain | `action-builder.test.mjs`, `reducer-builder.test.mjs`, `handler-builder.test.mjs`, `event-builder.test.mjs`, `reducers.test.mjs`, `action-definition.test.mjs` |
| Finance domain | `account.test.mjs`, `asset.test.mjs`, `investment-account.test.mjs`, `person.test.mjs`, `period-service.test.mjs`, `asset-rules.test.mjs` |
| Per-event scenarios (`EVT-X` convention) | `evt-401k.test.mjs`, `evt-ira.test.mjs`, `evt-roth.test.mjs`, `evt-roth-conversion.test.mjs`, `evt-us-brokerage.test.mjs`, `evt-au-brokerage.test.mjs`, `evt-real-property.test.mjs`, `evt-collectible.test.mjs`, `evt-super.test.mjs`, `evt-au-savings.test.mjs`, `evt-income.test.mjs`, `early-withdrawal.test.mjs`, `inflation.test.mjs` |
| Tax | `tax-rates.test.mjs`, `tax-documents.test.mjs` |
| Toolsets / scenarios | `toolset-compiler.test.mjs`, `toolset-us-retirement.test.mjs`, `toolset-au-retirement.test.mjs`, `toolset-cross-border.test.mjs`, `toolset-joe-retirement.test.mjs`, `toolset-mortgage-payment.test.mjs`, `intl-retirement-scenario.test.mjs`, `intl-retirement-mc-runner.test.mjs`, `intl-retirement-optimizer.test.mjs` |
| Services / serialization | `service-registry.test.mjs`, `base-scenario.test.mjs`, `scenario-loader.test.mjs`, `scenario-serializer.test.mjs`, `scenario-roundtrip.test.mjs`, `serializer-finance-roundtrip.test.mjs`, `serializer-framework-execution.test.mjs`, `state-registry.test.mjs`, `type-registries.test.mjs` |
| Graph / viz | `graph-geometry.test.mjs`, `graph-query-api.test.mjs`, `orthogonal-edge-router.test.mjs`, `column-layout.test.mjs`, `collision-detector.test.mjs`, `simulation-animator.test.mjs` |

`scripts/dev/check-requirements.js` (`npm run requirements`) cross-references the JP Spec xlsx against `EVT-X:` test names.

---

## Coding Conventions

- **State is plain data.** No class instances with methods inside `sim.state`. `structuredClone` is used for snapshots. Use service objects (`AccountService`, `StateRegistry`, …) outside the state to operate on plain state data. Re-stamping happens at deserialization.
- **Handlers return actions; reducers return state.** Handlers bridge events to the reducer pipeline; reducers must be pure.
- **IDs are owned by services.** Domain objects start with `id = null` (except `Action`, which sets `id = type` in its constructor). Never assign IDs manually outside a service.
- **All UI mutations flow through services.** Editors call `service.updateX(id, changes)`; they never mutate domain objects in place. The bus + `SimulationSync` re-wires the active sim.
- **Look up state by role, not by stateKey string.** Use `stateRegistry.getAccount(state, ACCOUNT_ROLES.ROTH, ownerId)` instead of `state.rothAccount`. This is what makes multi-person households work.
- **Format state for display via `StateSchemaRegistry`.** Register exact paths or patterns when adding new state fields so the chart/state-panel/timeline render correct currency / precision.
- **`RECORD_METRIC` is for derived/synthetic values only.** Any numeric field already in `sim.state` is directly chartable (design 31) — you do not need a `RECORD_METRIC` action to make it visible. Use `RECORD_METRIC` only for values that are computed from multiple sources and not naturally present as a single state field (e.g. cumulative income-flow accumulators, out-of-funds deficits, cross-account KPIs). `metrics.*` is one curated group among many in the chart filter.
- **Prefer the toolset path over hand-built scenarios.** Add a new toolset when you need new domain mechanics; only fall back to hand-built `loadDefaults`/`ScenarioSerializer` shapes for one-offs.
- **Imports use explicit `.js` extensions** (even from `.mjs` test files). Tests import directly from `src/`.
- **`src/index.js` is auto-generated.** Run `npm run build:index` after restructuring exports.
- **No inline styles for structural layout.** Use CSS classes (`assets/css/...`). Only truly dynamic runtime values (drag positions, computed heights) belong inline.
- **No runtime dependencies.** Keep `dependencies` empty; everything user-facing must work in the browser without a bundler at consumer-time.
- **UI changes need browser verification.** Type checks / unit tests prove correctness but not feature behavior — start the dev server and exercise the feature path before reporting done.

---

## How to Extend

### Add a new financial mechanic

1. Decide which toolset owns it (`US_RETIREMENT`, `AU_BROKERAGE`, …) or create a new toolset under `src/scenarios/toolsets/`.
2. Add handler + reducer pair under `src/finance/handlers/` and `src/finance/reducers/` (or colocate inside `account-rules/<cc>/<account>-classes.js` if it belongs to an account module).
3. Wire it into the toolset's `schedules()` / `handlers()` / `reducers()`.
4. Add an `evt-<feature>.test.mjs` under `tests/unit/` following the `EVT-X:` naming convention (used by `npm run requirements`).
5. If it touches new state fields, register their `ValueType` in `StateSchemaRegistry`.

### Add a tax-year update

1. Drop a new `Us|AuTaxModule20XX` under `src/finance/tax/us|au/`, extending `BaseTaxModule`.
2. Add a matching `*-tax-rates-20XX.js` and (if applicable) `*-tax-document-20XX.js`.
3. Register in the relevant toolset's `state()` step (`taxEngine.register(...)`) and `TaxDocumentRegistry` if you added a document.
4. The dynamic per-year reducer (`TaxEngine.registerDynamic`) automatically picks up the new year — no caller-side dispatch needed.

### Add a workbench plugin

1. Subclass `WorkbenchComponent` (`src/visualization/workbench/component.js`).
2. Construct a descriptor with `definePlugin({ id, title, component, category, defaultPane })`.
3. Add it to `FINANCE_PLUGINS` in `src/visualization/workbench/plugins/finance/finance-plugin-package.js`, and to whichever workspace templates should include it by default.
4. The plugin gets the `WorkbenchRuntime` in its constructor — subscribe to runtime events (`SCENARIO_READY`, `BREAKPOINT_HIT`, …) and read services via `ServiceRegistry.getInstance()`.

### Add a scenario parameter

1. Add a typed entry to the owning toolset's `paramSchema(context)` (key, label, type, group, defaultValue, `mc`, `opt`).
2. Reference it in the toolset's `state()` / `schedules()` / `handlers()` via `context.parameters.<key>`.
3. If the param should drive a person/account field, add a `node: { type, id|stateKey, field }` declaration so `ScenarioLoader`'s cascade applies it before compile.

---

## Design Documents

Architecture decisions and forward-looking proposals live in `design/`:

- `0-period-engine.md` — UTC-ms period model.
- `1-adjustment-entry-system.md` — manual ledger adjustments.
- `2-unified-event-schema.md` — single event stream proposal.
- `3-branching-event-streams.md` / `4-branch-diff-insight-engine.md` / `5-branch-merge-reconciliation.md` — branching simulations.
- `6-workbench-ui.md`, `7-workbench-ui-plan.md` — workbench overhaul (implemented).
- `8-serialization-test-plan.md`.
- `9-toolset-compiler.md` — toolset architecture (implemented).
- `10-display-settings-service.md`.
- `11-taxservice-declarative-refactor.md`.
- `12-toolset-ownership-refactor.md`.
- `13-prebuilt-scenario-parameters.md` — typed param round-tripping (implemented).
- `14-vite-migration.md`.
- `15-config-as-source-of-truth.md` — config-as-bootstrap, defaults and state ownership (draft).
- `16-journal-reporting-plugin.md` — journal reporting plugin design (draft).
- `17-scenario-as-graph-node.md` — scenario as graph node; `ScenarioRegistry` graph-backed (implemented).
- `18-performance-enhancements.md` — simulation performance enhancements (Phase 1 complete).
- `19-type-registry.md` — `TypeRegistry`, action-type families, per-country tax split, serializer rewrite (implemented).

Known structural issues, leaky boundaries, and rework candidates: **[`design/inconsistencies.md`](design/inconsistencies.md)**.

---

## License

Apache 2.0. See `LICENSE`.
