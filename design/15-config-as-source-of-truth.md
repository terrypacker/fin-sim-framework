# Design 15 — Config as Source of Truth (Defaults as Bootstrap Only)

**Status**: Draft
**Problem**: A loaded/edited scenario configuration is silently clobbered by `buildDefaultConfig()` on every Rebuild, and Monte Carlo / Optimization always re-derive their config from defaults — so any user edits to non-param fields (e.g. `RealProperty.plannedSaleYear`, `Person.lifeExpectancy`, account `drawdownPriority`, custom graph nodes) are discarded.

This design makes the active `cfg` the single authoritative description of a scenario. `buildDefaultConfig()` is repositioned as a **one-time bootstrap factory**, fired only when a prebuilt is first registered, never again.

Builds on Design 13 (Prebuilt Scenario Parameter Editing), which already established that registry entries should be uniformly populated up-front rather than lazily reconstructed at Rebuild time.

---

## 1. Current State

### 1.1 The two leak points

**Leak A — `BaseApp.initScenario()` (`src/apps/base-app.js:354–362`)**

```js
const activeConfig = registry.scenarioService.getActive();
const ScenarioCls = this.scenario.constructor;
const declaredToolsets = ScenarioCls.getToolsets?.() ?? [];
if (declaredToolsets.length > 0 && !activeConfig?.toolsets?.length) {
  const defaultCfg = ScenarioCls.buildDefaultConfig(
    this.scenario.params, this.scenario.simStart, this.scenario.simEnd
  );
  if (defaultCfg && activeConfig) Object.assign(activeConfig, defaultCfg);
}
new ScenarioLoader().load(activeConfig, registry);
```

The guard `!activeConfig?.toolsets?.length` was intended to mean "this is a fresh shell, fill it in." But:

- It fires whenever `cfg.toolsets` happens to be empty — including for partially-restored JSON loads, or any path that constructs a cfg without explicitly carrying the toolset array.
- The `Object.assign(activeConfig, defaultCfg)` is shallow but covers every top-level key in `defaultCfg`: `toolsets`, `parameters`, `persons`, `accounts`, `realProperties`, `collectibles`, `simStart`, `simEnd`. Whatever the user had at those keys is replaced wholesale.

The result is a `cfg` that *says* it was loaded but whose contents are the prebuilt defaults.

**Leak B — `IntlRetirementScenario.buildAndCompile()` (`src/scenarios/intl-retirement-scenario.js:674–714`)**

```js
static buildAndCompile({ params = {}, simStart, simEnd } = {}) {
  const registry = ServiceRegistry.getInstance();
  const scenario = new IntlRetirementScenario({...});
  scenario.buildSim();

  const cfg = IntlRetirementScenario.buildDefaultConfig(params, ...);
  // …deserialize persons/accounts, compile toolsets…
}
```

Called by:
- `src/finance/monte-carlo/intl-retirement-mc-runner.js:124`
- `src/finance/optimization/intl-retirement-optimizer.js:119`

`buildAndCompile` accepts a `params` map. Anything *outside* that map — every field of every Person / Account / RealProperty / Collectible that isn't wired through the typed param schema — is restored to defaults on every iteration. MC and Optimization therefore cannot reflect user edits to those fields.

The concrete example: `RealProperty.plannedSaleYear` has no entry in `INTL_RETIREMENT_PARAM_SCHEMA` (and shouldn't — it's a property attribute, not a tuning knob). Setting it in the editor updates the live `RealPropertyService`. Saving the scenario writes it into `cfg.realProperties`. But the next MC run calls `buildDefaultConfig(params)`, which constructs the property record from `INTL_RETIREMENT_DEFAULTS`, and `plannedSaleYear` is gone.

### 1.2 What "config" already contains

`ScenarioLoader.load()` (`src/scenarios/scenario-loader.js:75–158`) already treats `cfg` as the authoritative description:

- `cfg.persons`, `cfg.accounts`, `cfg.realProperties`, `cfg.collectibles` → `ScenarioSerializer.deserializePersonsAccounts(cfg, services)` populates the services.
- `cfg.params` → cascaded into `cfg.parameters` and into `cfg.persons[*]` / `cfg.accounts[*]` via the `node:` mapping declarations (lines 81–107).
- `cfg.toolsets` → `ScenarioCompiler` synthesizes events / handlers / reducers, reading the just-populated persons/accounts back from services.
- Compiled graph and post-compile state are snapshotted back into `cfg.events/handlers/actions/reducers` and `cfg.initialState` for round-tripping.

So the load pipeline is already config-driven. The brokenness is purely upstream — in *who decides what `cfg` looks like* at load time. Today the answer is "sometimes the saved cfg, sometimes whatever `buildDefaultConfig` returns." It should always be the saved cfg.

### 1.3 What `buildDefaultConfig` is actually for

Two genuine needs:

1. **Seed a freshly-registered prebuilt** with persons / accounts / realProperties / collectibles / parameter values — i.e. the data shape a user scenario already carries in localStorage. Without this, a brand-new install has nothing to compile.
2. **Programmatic "give me a clean reference scenario"** — used by tests, and conceptually useful as a "Reset to Defaults" UI affordance.

Neither need requires `buildDefaultConfig` to run during Rebuild or during MC/Opt iterations.

---

## 2. Proposed Solution

A single architectural rule: **the registry's stored cfg is the source of truth.** `buildDefaultConfig` produces the *initial* cfg for a newly-registered prebuilt and is never read again.

Three concrete shifts to implement that rule:

### 2.1 Materialize defaults at registration (one shot)

In `ScenarioRegistry.loadPrebuilt()` (`src/scenarios/scenario-registry.js:50–79`), when a prebuilt is added for the first time, invoke `buildDefaultConfig(defaultParams, simStart, simEnd)` once and merge the result onto the registry entry alongside the typed-array `params` already produced there.

After this step, a prebuilt's registry record carries the same fields as any saved user scenario:

```
{
  id, name, prebuilt: true, order,
  simStart, simEnd, scenarioClass, factory,
  params: TypedArray,           // already populated per Design 13
  toolsets, parameters,         // new — from buildDefaultConfig
  persons, accounts,            // new — from buildDefaultConfig
  realProperties, collectibles  // new — from buildDefaultConfig
}
```

Existing logic (`if (this._scenarios.has(id)) return;` at line 55) already prevents re-overwriting on subsequent calls, so this only fires once per process per prebuilt.

`defaultParams` for the bootstrap call: derive from `getParamSchema()` defaults (which is what `loadPrebuilt` already builds the typed `params` array from at lines 56–61).

### 2.2 Delete the merge in `initScenario`

Once 2.1 lands, every registry entry is fully populated by the time `BaseApp.initScenario()` reads it. Lines 354–362 collapse to:

```js
const activeConfig = registry.scenarioService.getActive();
new ScenarioLoader().load(activeConfig, registry);
```

No defaults logic in `BaseApp`. No `Object.assign`. No domain-specific "what to preserve" reasoning. Rebuild always reflects the cfg as it stands.

### 2.3 MC and Optimization take the active cfg as their template

The runners stop calling `IntlRetirementScenario.buildAndCompile({ params })`. Instead they receive (or fetch) the current active cfg from `scenarioService.getActive()` once when the user clicks Run, and use it as a per-iteration template:

```js
// per iteration in MC runner / optimizer
ServiceRegistry.reset();
const scenario = new IntlRetirementScenario({ context, params, simStart, simEnd });
scenario.buildSim();

const cfg = structuredClone(cfgTemplate);

// Apply iteration param overrides through the existing typed-array cfg.params
// (the .node cascade inside ScenarioLoader.load propagates these to
// cfg.persons / cfg.accounts before the compiler runs).
for (const p of cfg.params) {
  if (params[p.name] !== undefined) p.value = params[p.name];
}

new ScenarioLoader().load(cfg, registry);
```

`buildAndCompile` is retained but reframed as a thin convenience for tests / programmatic callers that genuinely want a from-scratch run. Production MC and Opt do not use it.

Implications:
- Edits to `RealProperty.plannedSaleYear`, `Person.lifeExpectancy`, `Account.drawdownPriority`, custom graph nodes — all preserved across MC/Opt iterations.
- The `cfg.params` typed array remains the only knob MC/Opt are allowed to perturb; everything else is template state.
- `ServiceRegistry.reset()` semantics are unchanged.

### 2.4 A "Reset to Defaults" affordance

Once defaults stop firing automatically, users still need a path to "throw out my edits and start over." Two new pieces:

- `ScenarioService.resetToDefaults(scenario)` — calls `scenario.scenarioClass.buildDefaultConfig(defaultParams, ...)` and overwrites the registry entry's top-level cfg fields (persons, accounts, realProperties, collectibles, toolsets, parameters). Also resets `params[*].value` to schema defaults (today's `resetParamsFromSchema`).
- UI hook: a "Reset to Defaults" button on the Scenario tab, visible for prebuilts and for user scenarios with a `scenarioId` referencing a prebuilt. Pressing it followed by Rebuild brings back the clean reference scenario.

Design 13 §2.4 had a similar discussion ("Load via dropdown re-selection resets to defaults"). Now that defaults are a one-time event rather than implicit-on-every-Rebuild, the dropdown re-selection behavior should change too: re-selecting the same prebuilt should *not* silently reset — it should keep current edits. Reset is explicit.

### 2.5 Schema drift on stored prebuilts

If a code change to `buildDefaultConfig` adds a new person/account/property, existing in-memory registry entries (and existing user scenarios derived from them) won't pick it up automatically.

Today this is handled for the typed `params` array in `ScenarioLoader.load()` (lines 140–149: a missing-entry merge from the schema). We extend the same idea: when loading a cfg that targets a known prebuilt, run a *drift merge* that appends any persons/accounts/realProperties/collectibles whose `stateKey` (or `id` for persons) is present in `buildDefaultConfig()` but absent from `cfg`. Removals stay until the user explicitly resets.

This keeps the "defaults are bootstrap only" rule intact while staying tolerant of code-side schema additions.

---

## 3. Files Affected

| File | Change |
|---|---|
| `src/scenarios/scenario-registry.js` | `loadPrebuilt`: when adding a new prebuilt entry, also invoke `pb.scenarioClass.buildDefaultConfig(defaultParams, pb.simStart, pb.simEnd)` and merge the result onto the entry. No-op for entries that already exist. |
| `src/apps/base-app.js` | Delete the `buildDefaultConfig` + `Object.assign` block (`initScenario` lines 354–362). `activeConfig` flows straight into `ScenarioLoader.load`. |
| `src/scenarios/intl-retirement-scenario.js` | Leave `buildAndCompile` in place as a convenience for tests, but it is no longer called by MC/Opt. Add a doc comment marking it as test/programmatic-only. |
| `src/finance/monte-carlo/intl-retirement-mc-runner.js` | Accept (or read) a `cfgTemplate` from the active scenario at run start. Replace `buildAndCompile({ params })` with the template-clone + param-override + `ScenarioLoader.load` flow in §2.3. |
| `src/finance/optimization/intl-retirement-optimizer.js` | Same change as MC runner. |
| `src/services/scenario-service.js` | Add `resetToDefaults(scenario)` that calls `scenario.scenarioClass.buildDefaultConfig(...)` and overwrites the cfg fields. Extend `resetParamsFromSchema` or fold it into the new method. |
| `src/visualization/scenario/scenario-tab-view.js` | New "Reset to Defaults" button, visible for prebuilts and user scenarios with a `scenarioId` parent. |
| `src/visualization/scenario/scenario-tab-presenter.js` | Wire the new button to `scenarioService.resetToDefaults` followed by `_initScenario()`. Remove the "re-select dropdown resets to defaults" behavior added in Design 13 §2.4 — Load now means "load as stored," and Reset is its own action. |
| `src/scenarios/scenario-loader.js` | Extend the existing param drift-merge (lines 140–149) with a parallel drift-merge for persons / accounts / realProperties / collectibles (§2.5). |

Existing serialization format is unchanged — all the data that needs to round-trip already does.

---

## 4. Migration

- **In-memory prebuilts**: 2.1 fires on first `loadPrebuilt` of a session. No localStorage migration needed; the registry is rebuilt per-session.
- **Existing user scenarios in localStorage**: already carry the full set of persons/accounts/realProperties/collectibles. They continue to load through `ScenarioLoader.load` unchanged.
- **MC runs in flight at deploy**: not applicable — runs are per-session.

No backwards-compatibility shims required.

---

## 5. Risk Notes

- **`buildAndCompile` test callers.** Tests under `tests/unit/intl-retirement-*.test.mjs` use `buildAndCompile` directly. They continue to work because `buildAndCompile`'s behavior is unchanged — it's just no longer the path production MC/Opt take. Verify no test asserts that MC/Opt go through it.
- **MC/Opt "warmup" cost.** The first iteration cloning the cfg template is slightly heavier than today's `buildDefaultConfig` because the template includes the full serialized graph from a prior compile. `structuredClone` is fast but measure on a long scenario before committing. If it regresses, hold only the persons/accounts/realProperties/collectibles slice as the template and let the compiler rebuild events/handlers per iteration.
- **Drift merge correctness.** §2.5's merge logic must be conservative: only append, never replace, never reorder. If a user has renamed or deleted a default account, drift merge should *not* re-add it. Use `stateKey` (accounts, properties, collectibles) and `id` (persons) as the absence-test key; if either matches an existing entry, skip.
- **"Reset to Defaults" semantics for user scenarios.** Calling reset on a user scenario that descends from a prebuilt overwrites the user's edits but preserves the scenario record itself (id, name, parent reference). Document this clearly in the button's tooltip so users don't expect it to delete the scenario.
- **`_replayParams` side channel.** `base-app.js:342` still exists from Design 13. Once §2.3 lands and MC replays apply params through the same template-clone path, that channel is redundant. Remove in the same PR or follow-up.

---

## 6. Out of Scope

- Removing `PrebuiltScenario` in favor of a direct scenario-class registry (the broader Design 13 §2.5 / `inconsistencies.md:51–52` direction). This design assumes the current registration model.
- Persisting prebuilts to localStorage (Design 13 §2.5, deferred).
- New parameter or override mechanisms beyond `cfg.params[].node` cascading.
- Per-MC-iteration variation of non-param cfg fields (e.g. randomized planned sale years) — that would require extending the param schema or introducing a new override channel; not in scope here.
