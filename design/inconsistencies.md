# Inconsistencies, Rework Candidates, and Open Questions

A running list of structural friction in the codebase — places where two ways of doing the same thing coexist, layering breaks down, or design intent has drifted. The aim is to capture these in one place so they can be triaged, not to imply any of them are wrong today. Each item notes where it lives and a suggested direction.

> Living document. Add to it whenever something surprising shows up while reading the code; remove or update entries as they get resolved.

Last reviewed: 2026-06-01.

---

## 1. Naming and Structural Duplication

### ~~1.1 Two `Graph`-like recorders for execution data~~
- ~~`src/simulation-framework/simulation-event-graph.js` (`SimulationEventGraph`, `ActionNode`) — still exported from `src/index.js` but no in-tree caller imports it (only the test `simulation-event-graph.test.mjs` and the auto-generated `src/index.js`).~~
- **Deleted**: `SimulationEventGraph`

~~### 1.2 `ToolsetRegistry` vs. `ScenarioToolsetRegistry`~~

~~### 1.3 `bus` and `serviceBus` are the same EventBus~~

~~### 1.4 `params` vs. `parameters` vs. `paramSchema` (Git #350)~~
- **Resolved** by designs 13 + 15 + 17: `PrebuiltScenario` deleted; `loadPrebuilt()` eagerly builds a typed-array `cfg.params` from `getParamSchema()` on first registration and preserves it on re-calls. `buildDefaultConfig()` fires once at registration, not on every Rebuild. `_mergeParamSchema` in the loader handles schema drift. `cfg.parameters` remains a loader-internal derived field inside `_normalizeParams()` — the noise of renaming it to `_compiledParameters` is not worth the churn (design 13 §4 risk note). The serializer `//TODO Params vs parameters` comment is gone. See `design/13-prebuilt-scenario-parameters.md` (Complete) and `design/15-config-as-source-of-truth.md`.

### 1.5 `getAll()` aliasing on `Graph` (Git #351)
- `src/graph/graph.js` line 44–47:
  ```js
  getAll() { return this.getNodes(); }
  ```
- **Direction**: remove `getAll()` once consumers migrate to `getNodes()`. Search for the remaining callers.

### 1.6 `GraphQueryApi` duplicates a `_dataSource` (Git #352)
- `src/graph/graph-query-api.js` line 35: `this._graph = graph; //TODO This is also in the parent as _dataSource`.
- **Direction**: pick one of `_graph` / `_dataSource`. The parent class probably owns the canonical reference.

### ~~1.7 `_pickActionData` exists in two places (Git #202)~~
- **Resolved** by `design/19-type-registry.md`: `_pickActionData` deleted from `simulation.js`; `StateSchemaRegistry.pickActionData` deleted (had no callers). Replaced by `TypeRegistry.pickPayload(action)`, which consults per-type `fields` declarations registered in toolset manifests. Framework block-list (`FRAMEWORK_FIELDS` + `_*` prefix) is now exhaustive and finance-agnostic.

---

## 2. TODOs and Legacy Code

There are ~50 `TODO` markers in `src/`. The dense clusters are flagged below; see `grep -rn TODO src/` for the full set.

~~### 2.1 `BaseApp` carries stale scenario state pending issue #146~~
- Base app is gone now

### 2.1b `primaryAmountField` fallback chain in `JournalReportPlugin` (Git #202 follow-up)
- `src/finance/journal-reporting/journal-report-plugin.js` line ~565 resolves the display amount for a journal row via:
  ```js
  item.stateDelta ?? item.personTaxAmount ?? item.amount ?? item.proceeds
  ```
  This is the same family of hand-maintained allow-list problem as the now-resolved §1.7 / §4.6. Each new action type with a non-standard primary field silently falls through.
- Now tractable: `TypeRegistry.ActionTypeEntry` already supports arbitrary metadata fields. Adding `primaryAmountField: 'proceeds'` (or similar) to a type's entry gives the journal plugin a stable lookup rather than a hardcoded chain.
- **Direction**: add an optional `primaryAmountField` key to each `ActionTypeEntry` and replace the fallback chain with `entry.primaryAmountField ?? 'amount'`. Ride the existing registry without any new infrastructure.

### 2.2 RMD half-implementations (Git #304)
- `src/finance/account-rules/us/ira-rollover-classes.js` lines 151, 154, 158 and `us/k401-classes.js` lines 221–223 all carry the same three TODOs:
  - Support `delayFirstRmd=true` (April 1 grace period).
  - IRS basis should be prior December 31 balance, not current balance.
  - Enforce the 50% failure-to-withdraw penalty.
- **Direction**: these are documented in the memory note `project_ira_rmd.md`. Pull them into a single design doc and resolve as a batch.

### 2.3 Reducer payload contamination (Git #353)
- `src/simulation-framework/reducers.js` line 475: `...action, //TODO Need to strip out the _ base fields` — spreads the full action object including framework-internal fields.
- Line 541: `//TODO is this ok?` — unattributed self-doubt.
- **Direction**: define an `actionPayload(action)` helper that strips `_*` and framework fields before re-emission.

### 2.4 `state-panel-view.js` is huge (Git #354)
- Single file with at least one `//TODO Extract to shared UI class #139` at line 1341. The file likely needs to be split into smaller presenter classes.

### 2.5 `monthly-social-security-handler.js` — only FRA supported (Git #292)
- `src/finance/handlers/monthly-social-security-handler.js` line 47: `//TODO #292 Support Early or FRA, this is FRA only right now (Born 1960+ FRA is 67)`
- **Direction**: tracked in issue #292.

~~### 2.6 Scenario serializer hacks (Git #355)~~
- **Resolved**: Account constructors renamed positional param `initialValue` → `balance`; serializer emits `balance:`; deserializer falls back to `d.balance ?? d.initialValue` for backward compat with old JSON. `AccountBuilder.initialValue()` renamed to `balance()`. Param schema entries updated from `field: 'initialValue'` to `field: 'balance'`; translation shim in `base-scenario.applyParams` removed.

~~### 2.7 `Simulation` carries test-only baggage (Git #356)~~
- **Resolved**: backward-compat accessor shims removed from `simulation.js`. Tests now access `sim.history.snapshots`, `sim.history.snapshotCursor`, `sim.history.eventCounter` directly. Production code was already using the `sim.history.*` path.

### 2.8 `ScenarioStorage` API drift (Git #357)
- `src/scenarios/scenario-storage.js` line 54: `//TODO Clean this up to be in the constructor`.

~~### 2.9 Action service lacks a type index (Git #358)~~

### 2.10 Many graph-renderer TODOs (Git #347 and #348)
- `node-render-kit.js` line 13; GitIssue #347
- `graph-builder-controller.js` lines 73, 329 — all signal that the graph rendering layer has multiple unresolved seams (registering listeners, central UI dispatch, etc.). GitIssue: #348

### 2.11 Timezone is unfinished (Git #268)
- `src/visualization/scenario/scenario-tab-presenter.js` lines 88, 93 (`//TODO #268 Need to deal with timezone here`) and `scenario-tab-view.js` line 176 (`//TODO #268 this should be cleaned up to always be a date or UTC String`).
- **Direction**: complete the UTC normalization (issue #268). Memory notes the UTC vs local toggle in the header but the persistence path still passes through inconsistent types.

### 2.12 `intl-retirement-state.js` carries removal-marked code (Git #349)
- Lines 45, 73 — `//TODO Remove these this should not be needed.` / `//TODO Move to FX When available.` — implies a planned `FX` service. Git Issue #349

---

## 3. Leaky or Inverted Layer Boundaries

### ~~3.1 `simulation.js` reaches into finance-domain fields (Git #202)~~
- **Resolved** by `design/19-type-registry.md`: `_pickActionData()` deleted from `simulation.js`. The framework now calls `TypeRegistry.pickPayload(action)`, which is domain-agnostic — it consults per-type `fields` declarations that toolsets register. Finance fields are declared in toolset manifests, not hardcoded in the simulation engine.

### 3.2 `StateSchemaRegistry` lives in `src/finance/` but is used by the framework
- The schema registry holds finance-specific defaults (`usOrdinaryIncomeYTD`, `auCapitalGainsYTD`, `intlTransferFeeUsd`, …) but its `pickActionData` static is positioned as the "canonical public version" of a framework helper.
- **Partially resolved** by `design/19-type-registry.md`: `StateSchemaRegistry.pickActionData` deleted (picker dedup complete — `TypeRegistry.pickPayload` is the sole picker). The remaining issue — `StateSchemaRegistry` itself living in `src/finance/` despite being used by framework layers — is deferred. Full resolution (split into `JournalSchemaRegistry` + `FinanceStateSchemaRegistry`) is a follow-up design.
- **Direction** (remaining): split into a framework-level `JournalSchemaRegistry` for the formatter contract, and a finance-level overlay that registers domain defaults on top.

~~### 3.3 `ScenarioLoader` knows about both branches (Git #364)~~
- **Resolved**: `load()` is now a thin dispatcher (~10 lines). Logic extracted into four private helpers: `_normalizeParams(cfg)` (params↔parameters sync + node cascade), `_compileFromToolsets(cfg, services)` (compiler call + graph snapshot), `_mergeParamSchema(cfg, toolsetParamSchema)` (schema merge + drift guard), and `_restoreFromGraph(cfg, services)` (deserialize + state rehydration).

### 3.4 `WorkbenchApp` reaches into presenter internals (Git #363)
- `_replayMcRun`, `_applyOptCandidate`, `_showGraphEditTab` (in `base-app.js`) all rely on workbench-shell pane IDs (`activatePlugin('chart')` etc.) by hard-coded string. These coupling points live on the app, not on the runtime, and bypass the `WorkbenchRuntime` pub/sub.
- **Direction**: route through `WorkbenchRuntime` events instead.

### 3.5 `simulation-sync` only takes two of the services it's wired with (#362)
- `ServiceRegistry` constructs `SimulationSync` with `{ bus, simulationRegistry, eventService, handlerService, actionService, reducerService }`, but `SimulationSync`'s constructor signature accepts only `{ bus, simulationRegistry }`. The extra services are silently dropped.
- **Direction**: either consume them inside `SimulationSync` (currently it goes through the `SimulationAdapter`) or stop passing them in `service-registry.js` lines 75–82.

### ~~3.6 Action / handler / reducer pre-registration string sets in the serializer (Git #361)~~
- **Resolved** by `design/19-type-registry.md`: `_ACCOUNT_SERVICE_REDUCERS`, `_NO_ARG_HANDLERS`, and all ~70-name string sets deleted from `scenario-serializer.js`. The serializer now calls `services.typeRegistry.get(d.__type)` for all handler/reducer/action dispatch. Each class declares `static type` and `static fromJSON`; toolsets register their classes via `types: { handlers, reducers, actions }` blocks. Adding a new class only requires registering it in the owning toolset — no serializer edits needed.

### 3.7 `Person.isAuResident` is both stored and derived (Git #324)
- `src/finance/person.js` line 35 sets `this.isAuResident = opts.isAuResident ?? this.citizen.includes('AUS')`. Memory notes that residency was supposed to move into a derived `state.isAuResident` flag (the `ChangeResidencyApplyReducer` flow), but Person still carries it as an opt-in init.
- **Direction**: pick one. The handlers downstream of `ChangeResidencyApplyReducer` already trust `state.isAuResident`, so removing the Person field would be cleaner.


### 3.8 `_unused-import` accumulation in `intl-retirement-scenario.js`
- `src/scenarios/intl-retirement-scenario.js` imports `ScenarioSerializer`, `ToolsetRegistry`, `ScenarioCompiler`, all 15 toolsets, and `ACCOUNT_ROLES` even though `ScenarioLoader` now owns the resolution path. The scenario file likely only needs `BaseScenario`, parameter constants, and currency helpers.
- **Direction**: prune the unused imports; the dependency on individual toolset IDs should come from a single source (`scenario-loader.js`).

---

## 4. Open Architecture Questions

### 4.1 `ServiceRegistry` is a singleton (Git #360)
- Every test that needs a clean state calls `ServiceRegistry.reset()` (or `resetAll`), and many call sites assume `getInstance()` always returns the active one. Branching, parallel simulations, and worker-pool Monte Carlo (mentioned in `design/README.md`) will all want multiple isolated registries.
- **Direction**: keep `getInstance()` as a convenience but accept an explicit `ServiceRegistry` instance in constructors that currently use the singleton. Tests have shown the pattern is workable.

### ~~4.2 `ScenarioRegistry` persists across `reset()` deliberately~~
- ~~`service-registry.js` lines 47–69 keep a static `_scenarioRegistry` so user param edits survive a Rebuild. This is implicit state that escapes the otherwise clean reset cycle.~~
- **Resolved** by `design/17-scenario-as-graph-node.md`: `static _scenarioRegistry` hack removed; scenario nodes now live on `layer:'scenario'` in the shared `Graph`, which survives `ServiceRegistry.reset()` naturally. `resetAll()` is the explicit full teardown for tests.

### 4.3 Two parallel bus-message hierarchies (Git #355)
- `BusMessage` → `SimulationBusMessage` → `ExecutionBusMessage` / `BreakpointHitMessage`.
- `BusMessage` (separately) → `ServiceActionEvent` (via `services/`).
- The dual paths share a base class but carry quite different fields and consumers. The memory note `project_bus_unification_plan.md` (8 phases tracking #87/#88/#93/#127) is the ongoing plan to unify them.
- **Direction**: continue the plan in `project_bus_unification_plan.md`.

### 4.4 Single `Graph` with two layers vs. two graphs (Git #366)
- The codebase currently uses one `Graph` instance with config-layer and execution-layer nodes living side by side (`ExecutionGraph` is a thin wrapper). This is convenient for cross-layer queries (e.g. "which runtime nodes are instances of this handler?") but couples the lifetime of execution data to the config-graph.
- **Direction**: keep the design, but make the layer split first-class — `graph.byLayer('execution')` should be a typed query rather than a `filter(n => n.layer === 'execution')` callout.

### ~~4.5 Action ids default to `type` (Git #367)~~
⏺ The issue is already resolved. Here's what I found:
Current behavior (not what the note describes):
- Action constructor sets id = null (line 46 of actions.js)
- ActionService.register() assigns a generated id like a1, a2, etc. (base-service.js:113)
- id and type are fully independent

### ~~4.6 `_pickActionData` allow-list is a maintenance burden (Git #202)~~
- **Resolved** by `design/19-type-registry.md`: the allow-list is gone. Each action type declares its `fields` in the owning toolset's `types.actions` block. `TypeRegistry.pickPayload(action)` reads those declarations; unregistered types fall back to "all non-framework, non-underscore fields" with a dev-mode warning. The three hand-maintained literal lists in `report-definition-registry.js` (`WITHDRAWAL_ACTION_TYPES`, `REAL_PROPERTY_ACTION_TYPES`, inline capital-gains list) are also deleted — replaced by `api.familyTypes(family, { cc })` calls.

### 4.7 Workbench plugin/runtime boundary is loosely typed (Git #368)
- `WorkbenchRuntime` events (`scenarioReady`, `breakpointHit`) are called directly by `WorkbenchApp` rather than passing through the runtime as the only publisher. Plugins subscribe via the runtime's bus but the publishers vary.
- **Direction**: make `WorkbenchRuntime.publish(event, payload)` the only way the app signals plugins; type the event names with constants.

### 4.8 `chartSeries` is hard-coded in `SimulationWorkbench` (Git #312)
- `src/apps/simulation-workbench.js` lines 25–30 hard-code `usSavingsAccount.balance`, `auSavingsAccount.balance`, `superAccount.balance`, `stockAccount.balance` — these are state keys whose stability depends on the `IntlRetirementScenario`'s state shape. Once role-based state lookups are everywhere, these keys won't be canonical anymore.
- **Direction**: derive the chart series from registered `ACCOUNT_ROLES` instead of state-key strings.

### 4.9 `IntlRetirementScenario` is the only prebuilt (Git #280)
- The `PREBUILT_SCENARIOS` array contains one entry. The plumbing (factory + class + descriptor) implies more were planned.
- **Direction**: either commit to one canonical scenario and simplify the prebuilt path, or add the missing variants the workbench dropdown expects.

### 4.10 Four "Spouse … Growth Rate" params, three of which are wired to nothing

Found 2026-08-07 by perturbing each param and diffing the golden's full end state
(`tests/helpers/golden-harness.js`). Raising a param from 0.07 to 0.20 that moves
**zero** of 1,288 state fields is not a subtle scenario, it is a disconnected lever.

- `spouseRothGrowthRate`, `spouseIraGrowthRate`, `spouseK401GrowthRate` — declared in
  `IntlRetirementScenario.getParamSchema()` and in `INTL_RETIREMENT_DEFAULTS`, and
  read by nothing else. `collectBaseGrowthRates` (economic-regimes-toolset) keys
  growth off the account TYPE — `EQUITY_US_ROTH ← p.rothGrowthRate`,
  `EQUITY_US_IRA ← p.iraGrowthRate`, `EQUITY_US_K401 ← p.k401GrowthRate` — and those
  three param names are not in the schema at all. So there is one rate per wrapper
  type shared by both spouses, and the per-spouse params can never reach it.
- `spouseSuperGrowthRate` *is* live, but mislabelled: `EQUITY_AU_SUPER ←
  p.superGrowthRate ?? p.spouseSuperGrowthRate ?? 0.07`, and `superGrowthRate` is
  likewise absent from the schema. The param captioned "Spouse Super Growth Rate"
  therefore sets the growth rate for **both** people's super.
- All four are `enabled: true` Monte Carlo axes in `intl-retirement-mc-config.js`
  with `stdDev: 0.03`, so every MC run has been spending three of its sampling
  dimensions on parameters that cannot change the outcome. This understates the
  true dispersion of the axes that do work.
- Not to be confused with `primarySsClaimAge`, which is also inert but *knowingly* —
  see the comment on `INTL_RETIREMENT_DEFAULTS.primarySsClaimAge` (TODO #292).

**Direction**: expose the four type-level rates (`rothGrowthRate`, `iraGrowthRate`,
`k401GrowthRate`, `superGrowthRate`) as the real params, retire the three dead
spouse variants from both the schema and the MC config, and rename the fourth. If
per-person rates are actually wanted, that is a rate-key change, not a param one.

### 4.11 Two parallel brokerage-disposal paths, only one of which runs

`STOCK_WITHDRAWAL_TAX` fires 5,466 times in the live research scenario while
`STOCK_WITHDRAWAL_APPLY` fires **zero** times there, in the reference golden, or
anywhere outside isolated reducer tests. Two implementations of the same disposal
coexist: the service path (`AccountService.replenishSavings` → `consumeHoldings`,
which raises the tax action directly) and the event-driven path
(`StockWithdrawalHandler` → `StockWithdrawalApplyReducer`). Only the former runs in
production; `account-service.js:1270` even describes itself as mirroring the basis
handling of the reducer it has replaced. The same holds for
`COLLECTIBLE_SALE_APPLY` (0 fires, while `COLLECTIBLE_SALE_TAX` fires 147 times).

This is the shape flagged in the `*EarningsHandler` note — production-dormant
classes kept alive by their own tests, where the test is the only caller and so
cannot detect that the two paths have diverged.

**Direction**: decide which path is canonical. If the service path is, delete the
handler/reducer pair and its tests; if the reducer is meant to be reachable, wire a
golden through it. Do not leave both — the isolated tests currently certify a code
path the application never executes.

### 4.12 `computeAfterTaxNetWorth` silently omits company equity

`computeNetWorth` (`net-worth.js`) counts five kinds: accounts, loans (negative),
`real-property`, `collectible`, **and `company`**. `_sumAfterTax` (`after-tax.js`),
which backs both `computeAfterTaxNetWorth` and `computeAfterTaxNetLiquidity`,
handles the first four and has no `company` branch — the entry falls through the
closing `else { continue; }`. The word "company" appears nowhere in `after-tax.js`,
`net-liquidity.js`, or `offset-capacity.js`.

On the reference research plan the two metrics disagree by \$14.5M at 2070, of
which \$14.0M is dropped company equity and only \$0.46M is genuine embedded
liquidation tax. The comment at `after-tax.js:479` explicitly asserts the two must
not "hold different opinions about what a dollar is". The allocation cube
(`allocation-cube.js:221`) does have a company branch, and its Σ-rows ≡
`computeNetWorth` invariant holds to the cent, so after-tax is the outlier.

**Direction**: superseded by `design/88-speculative-assets.md` (D5), which resolves
this as part of a per-asset `speculative` flag rather than independently. Patching
`_sumAfterTax` on its own would force full recognition of exactly the high-risk
stakes that prompted the question — making the headline number worse while making
the code more consistent. Until 88 phase 1 lands, the two numbers should not be
quoted side by side without a footnote.

---

## 5. Smaller Annoyances

### 5.1 `INTERNAL_SCHEDULING_HANDLER_NAME` in `simulation.js`  (Git #369)
- is declared but its usages should be reviewed — internal sentinels like this often outlive the path that needs them.

### 5.2 Mixing cases
- Mixed casing on toolset IDs vs. capabilities (`US_RETIREMENT` ID, lowercase `'retirement'` capability) — pick one.

### 5.3 Header Block 
- The header comment block (Apache 2.0 boilerplate) is copy/pasted across every file. Consider a build-time injection or just trust `LICENSE`.

---

## Triage notes

When picking something up off this list:

1. Read the file before changing it — entries may be out of date.
2. If the fix is small and obvious, just do it and remove the entry.
3. If it's structural (sections 3 and 4), open a `design/N-*.md` doc first.
4. Treat 1.7 (`_pickActionData`), 3.1 (finance fields in framework), and 4.3 (bus unification) as the highest-leverage cleanups — they keep showing up downstream.
