# Inconsistencies, Rework Candidates, and Open Questions

A running list of structural friction in the codebase — places where two ways of doing the same thing coexist, layering breaks down, or design intent has drifted. The aim is to capture these in one place so they can be triaged, not to imply any of them are wrong today. Each item notes where it lives and a suggested direction.

> Living document. Add to it whenever something surprising shows up while reading the code; remove or update entries as they get resolved.

Last reviewed: 2026-05-26.

---

## 1. Naming and Structural Duplication

### ~~1.1 Two `Graph`-like recorders for execution data~~
- ~~`src/simulation-framework/simulation-event-graph.js` (`SimulationEventGraph`, `ActionNode`) — still exported from `src/index.js` but no in-tree caller imports it (only the test `simulation-event-graph.test.mjs` and the auto-generated `src/index.js`).~~
- **Deleted**: `SimulationEventGraph`

### 1.2 `ToolsetRegistry` vs. `ScenarioToolsetRegistry`
- The header comment in `src/scenarios/toolsets/toolset-registry.js` references a `ScenarioToolsetRegistry` ("Unlike ScenarioToolsetRegistry…") that no longer exists in `src/`.
- **Direction**: trim the comment or restore the second registry if it's still wanted. The comment is the only evidence it ever existed.

### 1.3 `bus` and `serviceBus` are the same EventBus
- `src/simulation-framework/simulation.js` lines 99–100: `this.serviceBus = bus; this.bus = bus;` — same reference under two names.
- **Direction**: pick one name. If the future intent is two buses (e.g. service vs. execution), make that real; otherwise drop `serviceBus`.

### 1.4 `params` vs. `parameters` vs. `paramSchema`
- The scenario config carries three overlapping concepts:
  - `cfg.params` — typed UI form (`{ name, label, type, group, value, node? }[]`).
  - `cfg.parameters` — flat `{ key: value }` map the compiler reads.
  - `BaseScenario.getParamSchema()` — typed schema source-of-truth.
- `ScenarioLoader` syncs `params` → `parameters` on each load. `ScenarioSerializer` has a `//TODO Params vs parameters` note (line 146).
- **Direction**: collapse to one canonical name and derive the others. The plan in `design/13-prebuilt-scenario-parameters.md` describes this.

### 1.5 `getAll()` aliasing on `Graph`
- `src/graph/graph.js` line 44–47:
  ```js
  //TODO Remove once we get Rid of ConfigGraph as a data source
  getAll() { return this.getNodes(); }
  ```
- **Direction**: remove `getAll()` once consumers migrate to `getNodes()`. Search for the remaining callers.

### 1.6 `GraphQueryApi` duplicates a `_dataSource`
- `src/graph/graph-query-api.js` line 35: `this._graph = graph; //TODO This is also in the parent as _dataSource`.
- **Direction**: pick one of `_graph` / `_dataSource`. The parent class probably owns the canonical reference.

### 1.7 `_pickActionData` exists in two places
- `src/simulation-framework/simulation.js` line 45 — module-local helper, called from `simulation.js`.
- `src/finance/services/state-schema-registry.js` line 223 — `StateSchemaRegistry.pickActionData()` static method, labelled "Canonical public version" with a comment that `simulation.js` keeps a copy "to avoid cross-layer imports."
- **Direction**: extract the canonical picker into a shared, dependency-free location (`src/simulation-framework/action-data.js` or similar) so both layers reference the same thing. The state-schema layer importing a finance-aware copy from `src/finance/` is the wrong dependency direction.

### 1.8 `prebuilt-scenario.js` overlap with `BaseScenario`
- `src/scenarios/prebuilt-scenario.js` is a thin descriptor wrapper used only by `SimulationWorkbench.PREBUILT_SCENARIOS`. Its `factory` arg duplicates information `BaseScenario.buildDefaultConfig()` could derive.
- **Direction**: replace `PrebuiltScenario` with a typed array of scenario classes once `buildDefaultConfig` is the single source of construction info.

### 1.9 `config-graph.js` no longer exists; `ConfigGraphView` does
- README and many in-code comments reference `ConfigGraph` as a class. The actual file is `src/visualization/graph-builder/config-graph-view.js` (`ConfigGraphView`). There's no `config-graph.js`.
- **Direction**: scrub stale "ConfigGraph" references in comments to read `ConfigGraphView`.

---

## 2. TODOs and Legacy Code

There are ~50 `TODO` markers in `src/`. The dense clusters are flagged below; see `grep -rn TODO src/` for the full set.

### 2.1 `BaseApp` carries stale scenario state pending issue #146
- `src/apps/base-app.js` line 91: `this.scenario = null; //TODO Remove for #146`
- Line 131: `//TODO Clean up for #146`
- Lines 571, 580: `//TODO Really build scenario?`
- Line 610: `//TODO Need to have a central location to reset the sim See #135`
- Lines 817–818: `TODO Refactor to remove these, they should be in the views. / TODO Extract to shared UI class #139`
- **Direction**: open issues #135, #139, #146 should be triaged together — the BaseApp is currently both a composition root and a holder of state that arguably belongs to controllers.

### 2.2 RMD half-implementations
- `src/finance/account-rules/us/ira-rollover-classes.js` lines 151, 154, 158 and `us/k401-classes.js` lines 221–223 all carry the same three TODOs:
  - Support `delayFirstRmd=true` (April 1 grace period).
  - IRS basis should be prior December 31 balance, not current balance.
  - Enforce the 50% failure-to-withdraw penalty.
- **Direction**: these are documented in the memory note `project_ira_rmd.md`. Pull them into a single design doc and resolve as a batch.

### 2.3 Reducer payload contamination
- `src/simulation-framework/reducers.js` line 475: `...action, //TODO Need to strip out the _ base fields` — spreads the full action object including framework-internal fields.
- Line 541: `//TODO is this ok?` — unattributed self-doubt.
- **Direction**: define an `actionPayload(action)` helper that strips `_*` and framework fields before re-emission.

### 2.4 `state-panel-view.js` is huge
- Single file with at least one `//TODO Extract to shared UI class #139` at line 1341. The file likely needs to be split into smaller presenter classes.

### 2.5 `monthly-social-security-handler.js` — only FRA supported
- `src/finance/handlers/monthly-social-security-handler.js` line 47: `//TODO #292 Support Early or FRA, this is FRA only right now (Born 1960+ FRA is 67)`
- **Direction**: tracked in issue #292.

### 2.6 Scenario serializer hacks
- `src/scenarios/scenario-serializer.js`:
  - Lines 144–146: `//TODO Clean up API / Support toolsets export here? / Params vs parameters`.
  - Line 360: `initialValue: account.balance ?? account.initialValue, //TODO Hack here since the field name is not the same as the constructor`.
- **Direction**: rename `initialValue` to `balance` on the constructor side (or pick one canonical name) so the serializer doesn't have to translate.

### 2.7 `Simulation` carries test-only baggage
- `src/simulation-framework/simulation.js` line 160: `//TODO Remove these and fix the tests`.
- **Direction**: chase the offending tests and remove the workaround.

### 2.8 `ScenarioStorage` API drift
- `src/scenarios/scenario-storage.js` line 54: `//TODO Clean this up to be in the constructor`.

### 2.9 Action service lacks a type index
- `src/services/action-service.js` line 48: `//TODO Need a type index for this`.

### 2.10 Many graph-renderer TODOs
- `src/visualization/components/graph-renderer.js` line 115; `echarts-graph-renderer.js` line 80; `node-render-kit.js` line 13; `graph-builder-controller.js` lines 73, 329 — all signal that the graph rendering layer has multiple unresolved seams (registering listeners, central UI dispatch, etc.).

### 2.11 Timezone is unfinished
- `src/visualization/scenario/scenario-tab-presenter.js` lines 88, 93 (`//TODO #268 Need to deal with timezone here`) and `scenario-tab-view.js` line 176 (`//TODO #268 this should be cleaned up to always be a date or UTC String`).
- **Direction**: complete the UTC normalization (issue #268). Memory notes the UTC vs local toggle in the header but the persistence path still passes through inconsistent types.

### 2.12 `intl-retirement-state.js` carries removal-marked code
- Lines 45, 73 — `//TODO Remove these this should not be needed.` / `//TODO Move to FX When available.` — implies a planned `FX` service.

### 2.13 Five UI prototype HTMLs in `design/ui-prototypes/`
- `sim-workbench-v1.html`…`sim-workbench-v5.html` — design references, fine to keep, but should be flagged as not-buildable and not part of the dev server. They are currently easy to mistake for runnable entry points.

---

## 3. Leaky or Inverted Layer Boundaries

### 3.1 `simulation.js` reaches into finance-domain fields
- `_pickActionData()` in `simulation-framework/simulation.js` lines 45–61 knows about finance-specific fields (`tax`, `taxDetail`, `personTaxDetails`, `gain`, `proceeds`, `costBasis`, `cc`, `isLongTerm`, `isAuResident`, …).
- The simulation framework is supposed to be domain-agnostic; this couples it directly to US/AU tax modelling.
- **Direction**: invert the dependency — let actions opt in via a `toJournalPayload()` method or have the finance domain register field extractors with the framework at startup.

### 3.2 `StateSchemaRegistry` lives in `src/finance/` but is used by the framework
- The schema registry holds finance-specific defaults (`usOrdinaryIncomeYTD`, `auCapitalGainsYTD`, `intlTransferFeeUsd`, …) but its `pickActionData` static is positioned as the "canonical public version" of a framework helper.
- **Direction**: split into two: a framework-level `JournalSchemaRegistry` for the picker contract, and a finance-level `FinanceStateSchemaRegistry` that registers the domain defaults on top.

### 3.3 `ScenarioLoader` knows about both branches
- `src/scenarios/scenario-loader.js` dispatches between toolset-compile and graph-deserialize. The branch logic is mixed with per-param node-cascade rules — a single 80-line method (`load`) that does I/O normalization, dispatch, and snapshot-back. It also mutates `cfg.params` / `cfg.parameters` / `cfg.events` / `cfg.handlers` / `cfg.actions` / `cfg.reducers` / `cfg.initialState` in place.
- **Direction**: extract three pure helpers (`normalizeParams(cfg)`, `compileFromToolsets(cfg, services)`, `restoreFromGraph(cfg, services)`) and keep `load()` as a thin dispatcher.

### 3.4 `BaseApp` reaches into presenter internals
- `_replayMcRun`, `_applyOptCandidate`, `_showGraphEditTab` (in `base-app.js`) all rely on workbench-shell pane IDs (`activatePlugin('chart')` etc.) by hard-coded string. These coupling points live on the app, not on the runtime, and bypass the `WorkbenchRuntime` pub/sub.
- **Direction**: route through `WorkbenchRuntime` events instead.

### 3.5 `simulation-sync` only takes two of the services it's wired with
- `ServiceRegistry` constructs `SimulationSync` with `{ bus, simulationRegistry, eventService, handlerService, actionService, reducerService }`, but `SimulationSync`'s constructor signature accepts only `{ bus, simulationRegistry }`. The extra services are silently dropped.
- **Direction**: either consume them inside `SimulationSync` (currently it goes through the `SimulationAdapter`) or stop passing them in `service-registry.js` lines 75–82.

### 3.6 Action / handler / reducer pre-registration string sets in the serializer
- `src/scenarios/scenario-serializer.js` keeps three manually-maintained sets (`_ACCOUNT_SERVICE_REDUCERS`, `_NO_ARG_HANDLERS`, … ~70 class names total). Every new account-module class has to be remembered to be added here, or it silently fails to deserialize.
- **Direction**: replace string sets with a self-registering `ClassRegistry.register(MyReducerClass)` so a new class type is registered alongside its definition. Same pattern would let us drop `actionClass`/`reducerType`/`handlerClass` constructor-name preservation, since the registry would carry the discriminator.

### 3.7 `Person.isAuResident` is both stored and derived
- `src/finance/person.js` line 35 sets `this.isAuResident = opts.isAuResident ?? this.citizen.includes('AUS')`. Memory notes that residency was supposed to move into a derived `state.isAuResident` flag (the `ChangeResidencyApplyReducer` flow), but Person still carries it as an opt-in init.
- **Direction**: pick one. The handlers downstream of `ChangeResidencyApplyReducer` already trust `state.isAuResident`, so removing the Person field would be cleaner.

### 3.8 `_unused-import` accumulation in `intl-retirement-scenario.js`
- `src/scenarios/intl-retirement-scenario.js` imports `ScenarioSerializer`, `ToolsetRegistry`, `ScenarioCompiler`, all 15 toolsets, and `ACCOUNT_ROLES` even though `ScenarioLoader` now owns the resolution path. The scenario file likely only needs `BaseScenario`, parameter constants, and currency helpers.
- **Direction**: prune the unused imports; the dependency on individual toolset IDs should come from a single source (`scenario-loader.js`).

---

## 4. Open Architecture Questions

### 4.1 `ServiceRegistry` is a singleton
- Every test that needs a clean state calls `ServiceRegistry.reset()` (or `resetAll`), and many call sites assume `getInstance()` always returns the active one. Branching, parallel simulations, and worker-pool Monte Carlo (mentioned in `design/README.md`) will all want multiple isolated registries.
- **Direction**: keep `getInstance()` as a convenience but accept an explicit `ServiceRegistry` instance in constructors that currently use the singleton. Tests have shown the pattern is workable.

### 4.2 `ScenarioRegistry` persists across `reset()` deliberately
- `service-registry.js` lines 47–69 keep a static `_scenarioRegistry` so user param edits survive a Rebuild. This is implicit state that escapes the otherwise clean reset cycle.
- **Direction**: confirm this is the desired behavior, or make it explicit (e.g. require callers to pass the prior `ScenarioRegistry` into `ServiceRegistry.reset(prev)`).

### 4.3 Two parallel bus-message hierarchies
- `BusMessage` → `SimulationBusMessage` → `ExecutionBusMessage` / `BreakpointHitMessage`.
- `BusMessage` (separately) → `ServiceActionEvent` (via `services/`).
- The dual paths share a base class but carry quite different fields and consumers. The memory note `project_bus_unification_plan.md` (8 phases tracking #87/#88/#93/#127) is the ongoing plan to unify them.
- **Direction**: continue the plan in `project_bus_unification_plan.md`.

### 4.4 Single `Graph` with two layers vs. two graphs
- The codebase currently uses one `Graph` instance with config-layer and execution-layer nodes living side by side (`ExecutionGraph` is a thin wrapper). This is convenient for cross-layer queries (e.g. "which runtime nodes are instances of this handler?") but couples the lifetime of execution data to the config-graph.
- **Direction**: keep the design, but make the layer split first-class — `graph.byLayer('execution')` should be a typed query rather than a `filter(n => n.layer === 'execution')` callout.

### 4.5 Action ids default to `type`
- `Action` sets `id = type` so action lookup by id and lookup by type are the same. This works fine for built-in actions but is a footgun when two distinct action **definitions** want the same `type` discriminator (e.g. two versions of `WAGES_INCOME` in different toolsets).
- **Direction**: confirm there's no risk of collisions across toolsets, or generate `id = ${toolsetId}:${type}`.

### 4.6 `_pickActionData` allow-list is a maintenance burden
- Every new action field that the timeline needs to display has to be added to the picker (currently 12 fields, scattered between simulation.js and StateSchemaRegistry). A reducer that emits a new field will see it dropped silently.
- **Direction**: invert — let each action class declare its journal fields (or default to "all enumerable non-`_` fields"), with the picker as fallback only.

### 4.7 Workbench plugin/runtime boundary is loosely typed
- `WorkbenchRuntime` events (`scenarioReady`, `breakpointHit`) are called directly by `WorkbenchApp` rather than passing through the runtime as the only publisher. Plugins subscribe via the runtime's bus but the publishers vary.
- **Direction**: make `WorkbenchRuntime.publish(event, payload)` the only way the app signals plugins; type the event names with constants.

### 4.8 `chartSeries` is hard-coded in `SimulationWorkbench`
- `src/apps/simulation-workbench.js` lines 25–30 hard-code `usSavingsAccount.balance`, `auSavingsAccount.balance`, `superAccount.balance`, `stockAccount.balance` — these are state keys whose stability depends on the `IntlRetirementScenario`'s state shape. Once role-based state lookups are everywhere, these keys won't be canonical anymore.
- **Direction**: derive the chart series from registered `ACCOUNT_ROLES` instead of state-key strings.

### 4.9 `IntlRetirementScenario` is the only prebuilt
- The `PREBUILT_SCENARIOS` array contains one entry. The plumbing (factory + class + descriptor) implies more were planned.
- **Direction**: either commit to one canonical scenario and simplify the prebuilt path, or add the missing variants the workbench dropdown expects.

---

## 5. Smaller Annoyances

- `console.log` in production code paths (e.g. `tax-engine.js` and `account-rules-engine.js` log every module registration). Replace with a project-wide `log()` that can be toggled off in builds.
- Mixed casing on toolset IDs vs. capabilities (`US_RETIREMENT` ID, lowercase `'retirement'` capability) — pick one.
- The header comment block (Apache 2.0 boilerplate) is copy/pasted across every file. Consider a build-time injection or just trust `LICENSE`.
- `chart.js`, `chartjs-plugin-annotation`, `chartjs-plugin-zoom` are still referenced in some comments but are not in `package.json`; `echarts` is the actual chart library now.
- `INTERNAL_SCHEDULING_HANDLER_NAME` in `simulation.js` is declared but its usages should be reviewed — internal sentinels like this often outlive the path that needs them.

---

## Triage notes

When picking something up off this list:

1. Read the file before changing it — entries may be out of date.
2. If the fix is small and obvious, just do it and remove the entry.
3. If it's structural (sections 3 and 4), open a `design/N-*.md` doc first.
4. Treat 1.7 (`_pickActionData`), 3.1 (finance fields in framework), and 4.3 (bus unification) as the highest-leverage cleanups — they keep showing up downstream.
