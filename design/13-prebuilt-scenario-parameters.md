# Design 13 — Prebuilt Scenario Parameter Editing

**Status**: Complete
**Problem**: A prebuilt scenario cannot be re-run with different parameter values from the UI. Its parameter inputs are not displayed, and even when they are populated indirectly by the loader they are clobbered on every Rebuild. The only workaround is to create a new user scenario from the prebuilt and edit there.

---

## 1. Current State

### 1.1 Data shapes for "scenario"

Two storage shapes coexist under the same `getActive()` / `_scenarios` map in `ScenarioRegistry`:

| Source | Stored where | `params` shape on first load | Other carriers |
|---|---|---|---|
| **Prebuilt** (`PrebuiltScenario`) | In-memory only, defined in `simulation-workbench.js:38–55` | `{}` (object, set in constructor `prebuilt-scenario.js:53`) | `factory`, `scenarioClass`, `simStart`, `simEnd` |
| **User scenario** | `localStorage` via `ScenarioStorage` | `[ { name, label, type, group, value, node? } ]` (typed array) | full serialized graph + persons/accounts |

These two shapes flow through the same code paths (`createActiveScenario`, `ScenarioLoader.load`, `_populateScenarioForm`) but disagree on the type of `params`.

### 1.2 Three things called "params"

| Symbol | Lives on | Shape | Owner |
|---|---|---|---|
| `ScenarioCls.getParamSchema()` | Scenario class (static) | `[{ key, label, type, group, defaultValue, description, node? }]` | Scenario class |
| `scenario.params` (registry entry) | Active scenario in `ScenarioRegistry` | `{}` for prebuilt, or typed array after loader runs | Mutated by `ScenarioLoader.load()` and the param UI |
| `cfg.parameters` | Same `cfg` object, derived field | Plain `{ key: value }` map | Computed inside `ScenarioLoader.load()` (lines 79–86) from `cfg.params` for the compiler to read |

The names `params`, `parameters`, and `getParamSchema` collide. Nothing in code or docs distinguishes "the schema definition" from "the current values" from "the plain map the compiler consumes."

### 1.3 Why prebuilt params don't render

The dropdown selection flow runs in this order on every rebuild:

1. `base-app.js:130 initScenario()` → `scenarioRegistry.loadPrebuilt(this._prebuiltScenarios)`
2. `scenario-registry.js:57` does `this._scenarios.set(id, { ...pb, id, factory, scenarioClass })` — spreading from the original `PrebuiltScenario` constant defined once in `simulation-workbench.js`. `pb.params` is `{}` (the constructor default), so the registry entry's params are reset to `{}` here.
3. `scenarioTabPresenter._refresh()` calls `_populateScenarioForm(active)` → `_renderParamsList(scenario)` (`scenario-tab-view.js:202`). Guard at line 206: `if (!scenario?.params?.length) return;` — `{}` has no `.length` → renders **nothing**.
4. Only after the UI has already drawn does `ScenarioLoader.load()` (`scenario-loader.js:132–139`) overwrite `cfg.params` with a typed array derived from `scenarioClass.getParamSchema()`. The UI is never re-rendered with the new array.

The user-scenario path works because the array shape is written into `localStorage` and the loader skips the normalization branch.

### 1.4 Why Rebuild loses param edits

Even if a user edits values on a typed-array `scenario.params` (e.g. on a user scenario, or after a hand-patched prebuilt), clicking **Rebuild Simulation** triggers `scenario-tab-presenter.js:62 onRebuild → _initScenario`. `initScenario` calls `loadPrebuilt()` first thing, which clobbers the registry entry back to `{ ...pb }` with `params = {}`. The schema-default normalization in the loader then re-runs, restoring **defaults**, not the user's edits.

Net effect: a prebuilt with toolsets effectively re-derives params from defaults on every Rebuild. There is no path for "Rebuild with these edited values."

### 1.5 What Monte Carlo got right

`MonteCarloPresenter` already proves the data flow exists. It:

1. Reads `scenario.params` (typed array) and converts to a plain object (`baseParams`).
2. Per iteration calls `scenarioFactory(perturbedParams, ...)` and `ScenarioLoader.load()`.
3. On replay (`base-app.js:514 _replayMcRun`) sets `this._replayParams = run.params`, then re-enters `destroyScenario(); initScenario()`. Inside `initScenario`, line 342: `if (this._replayParams) this.scenario.params = this._replayParams;`.

So the engine supports param injection — but only via this `_replayParams` side channel, set just-in-time before `buildSim()`. The UI param editor cannot use it because the prebuilt's params field is empty by the time the user sees it.

---

## 2. Proposed Solution

Eliminate the prebuilt-as-separate-shape distinction. Treat every scenario in the registry uniformly: schema is defined by `scenarioClass.getParamSchema()` (static, derivable any time), and `params` is always a typed-array of current values. Distinguish **Load Defaults** from **Rebuild** explicitly in the UI.

### 2.1 Rename the three "params" concepts

| Current name | New name | Lives where |
|---|---|---|
| `ScenarioCls.getParamSchema()` | unchanged — `getParamSchema()` returns the **schema** | scenario class (static) |
| `PrebuiltScenario.params` (`{}`) | `defaultParameterValues` — derived once from schema at registry-load time | registry entry |
| `scenario.params` (typed array) | unchanged — `params` is the **current values** | registry entry, serialized as-is |
| `cfg.parameters` | `cfg._compiledParameters` — internal, computed at load time by `ScenarioLoader` | transient, do not serialize |

Renames are mechanical but valuable: they make `params` mean exactly one thing, and call out the schema-vs-defaults-vs-current-values distinction.

### 2.2 Make the registry entry shape uniform

Treat every entry — prebuilt or user — as `{ id, name, prebuilt, scenarioId, simStart, simEnd, params: TypedArray, persons, accounts, …, scenarioClass, factory }`. The only structural difference is the `prebuilt` flag (controls whether Delete is allowed, what optgroup it shows in, and whether localStorage persists it).

Specifically, drop the `params = {}` default in `PrebuiltScenario`. Instead, populate the typed array eagerly the first time a prebuilt enters the registry:

```js
// in ScenarioRegistry.loadPrebuilt(), when adding a prebuilt entry:
const schema = pb.scenarioClass?.getParamSchema?.() ?? [];
const params = schema.map(s => ({
  name: s.key, label: s.label, type: s.type, group: s.group,
  value: s.defaultValue, ...(s.node ? { node: s.node } : {})
}));
this._scenarios.set(id, { ...pb, id, params, factory: pb.factory, scenarioClass: pb.scenarioClass });
```

The loader-side normalization at `scenario-loader.js:132–139` becomes a fallback for older user-saved cfgs that predate the typed array; it is no longer the only writer.

### 2.3 Persist param edits across Rebuild

`loadPrebuilt` currently re-clones from `pb` every time, throwing away in-memory edits. Two options:

- **Option A (recommended)**: In `loadPrebuilt`, do not overwrite an entry that already exists. If `this._scenarios.has(id)`, leave it alone (preserves prior runtime mutations including `params`). Newly-discovered prebuilts still get added.
- **Option B**: Before each `loadPrebuilt` re-set, snapshot `existing.params` and carry it onto the new entry. Slightly more defensive — survives schema-change rebuilds — but adds branching.

Option A is cleaner. The only "I want the original defaults back" use case is solved explicitly by the new **Load Defaults** action below.

### 2.4 Two actions: Load (dropdown) vs Rebuild (button)

The scenario dropdown is the implicit **Load** action; the **Rebuild Simulation** button is the explicit one. Today, the dropdown's `onOpen` handler (`scenario-tab-presenter.js:55–60`) only updates the form and *doesn't* trigger a simulation rebuild — that's a pre-existing UX bug worth fixing as part of this work.

| Action | Trigger | Behavior |
|---|---|---|
| **Load** | Dropdown selection (`onOpen`) | For a prebuilt: reset `scenario.params[*].value` to `schema[*].defaultValue`. For a user scenario: take the stored typed-array values as-is. Then auto-rebuild (`destroyScenario(); initScenario()`). |
| **Rebuild** | "Rebuild Simulation" button | Use current `scenario.params` as the user edited them in the form. Re-run `destroyScenario(); initScenario()`. |

This means there is no separate "Load Defaults" button. The recovery path for "discard my edits and start over" is **reselect the scenario in the dropdown**.

For user scenarios, Load takes stored values (not schema defaults) because the user explicitly saved those. A user scenario's "Load Defaults" equivalent — if anyone ever asks for it — would be to delete-and-recreate from the parent prebuilt, which is already supported.

The presenter changes:

```js
// scenario-tab-presenter.js
this._view.onOpen = (id) => {
  this._controller.setActiveById(id);
  this._activeScenario = this._controller.getActiveScenario();
  if (this._activeScenario?.prebuilt) {
    // Reset params from schema before rebuild.
    this._controller.resetParamsFromSchema(this._activeScenario);
  }
  this._view._populateScenarioForm(this._activeScenario);
  this._initScenario();   // new — was previously only on the Rebuild button
};
```

`resetParamsFromSchema` is a new `ScenarioService` method that overwrites each param's `value` with the schema's `defaultValue` for that key. Param entries not in the schema are left alone (so user-added custom params survive a Load).

### 2.5 Persisting prebuilts on first load (deferred)

The user raised an open question: should prebuilts be written to localStorage on first load, so all scenarios in storage share one shape, with a "reset defaults" hook to re-seed from code?

This is a bigger change than 2.1–2.4 require and has migration implications (existing localStorage already has a `lastUsed: 'p:<id>'` referencing in-memory prebuilts). **Defer**. The renames and registry-entry uniformity in 2.1–2.4 already deliver the UX win, without changing storage semantics.

If we revisit this later, the path would be:
- On first page load, write each prebuilt into `_scenarioData.scenarios` with `prebuilt: true`, never letting code "ship" a new prebuilt without an explicit migration step.
- "Restore prebuilts" becomes a user-facing button that deletes `prebuilt: true` entries and re-seeds from code.

---

## 3. Files Affected

| File | Change |
|---|---|
| `src/scenarios/prebuilt-scenario.js` | Drop `this.params = {}` default; document the new "params is a typed array, written by the registry" contract |
| `src/scenarios/scenario-registry.js` | `loadPrebuilt`: derive typed-array `params` from `scenarioClass.getParamSchema()` when first adding an entry; preserve existing entries on re-call (Option A from 2.3) |
| `src/scenarios/scenario-loader.js` | Keep the typed-array normalization at 132–139 as a fallback only; rename internal `cfg.parameters` → `cfg._compiledParameters` for clarity (or keep `parameters` if the rename ripples too far — the public-facing rename in 2.1 is on the schema/registry side, not the loader-internal map) |
| `src/services/scenario-service.js` | Add `resetParamsFromSchema(scenario)` that overwrites `params[*].value` from `scenarioClass.getParamSchema()[*].defaultValue` for entries present in the schema; leaves user-added params untouched |
| `src/visualization/scenario/scenario-tab-view.js` | No new button; with 2.2's eager population `_renderParamsList` will have a non-empty array to draw |
| `src/visualization/scenario/scenario-tab-presenter.js` | Extend `onOpen` (dropdown selection) to call `resetParamsFromSchema` for prebuilts and then `_initScenario()`, so Load happens as one action |
| `src/apps/base-app.js` | No structural change. The existing `_replayParams` side channel can be deleted once 2.2 is in place — params live on the registry entry, which `createActiveScenario()` already reads from |

No serialization format changes; existing user-saved scenarios still load correctly because their typed-array `params` is already in the target shape.

---

## 4. Risk Notes

- **Schema drift on existing user scenarios.** A user scenario saved with N params is loaded later when the prebuilt schema has gained an (N+1)th param. The current loader normalization runs only when `cfg.params` is not an array; once the array is present it is preserved as-is. We should extend the loader to **merge** schema entries that are missing from `cfg.params` (using their defaults) so a schema addition propagates to old user scenarios without forcing a re-save. Schema removals (entries no longer in the schema) can stay until the user re-saves — harmless.
- **Renames are noisy.** The `parameters` field is used in `ScenarioLoader.load()` and in `ScenarioCompiler` reads. If we rename to `_compiledParameters`, update both. If the noise is not worth it, keep the loader-internal name as `parameters` and rely on a comment plus the registry-level rename (`defaultParameterValues` → goes away in favor of just the schema). Decide before implementation.
- **`loadPrebuilt` preservation semantics.** Skipping re-set when an entry exists means a code change to the `PrebuiltScenario` definition (label, factory, simStart, etc.) will *not* propagate to an existing registry entry until the page is reloaded with a fresh registry. Acceptable because the registry is per-session; localStorage carries only the `lastUsed` ID and user scenarios, not prebuilt definitions.
- **Monte Carlo replay path.** The `_replayParams` side channel in `base-app.js:342` becomes redundant once params live on the registry entry. Replace `_replayMcRun(run)` with: set `activeScenario.params = run.params` directly, then call the existing rebuild hook. Verify MC and Optimization candidates still apply correctly.

---

## 5. Out of Scope

- Prebuilt-in-localStorage migration (2.5) — deferred.
- New parameter types beyond `Number | String | Boolean | Date`.
- Cross-scenario param sharing (e.g. "use this primary retirement date everywhere").
- Validation rules (min/max, required) on the schema.
