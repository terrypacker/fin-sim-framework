# 25a — Monte Carlo Config: Nested Parameter Paths

**Status**: Draft
**Phase**: A — Substrate (per `design/24-financial-modeling-roadmap.md` §5; peer to `design/25-holding-level-state.md`)
**Related**: `design/21-financial-shock-and-regime-framework.md` §15 (originally flagged the need for nested-path MC sweeps), `design/24-financial-modeling-roadmap.md` §4.4, `design/27-mortality-and-survivor-mechanics.md` (downstream consumer — per-person lifespan draws), `design/25-holding-level-state.md` (peer substrate piece; no direct dependency).
**Author note**: Small, contained, shippable independently of design 25. Lands as shared substrate so design 21 Phase 2 (shock-MC) and design 27 (mortality-MC) don't each invent their own version. Touch surface is `IntlRetirementMcConfig` + the MC UI; the simulation engine itself is unaffected.

---

## 1. Purpose

`IntlRetirementMcConfig` today only sweeps **flat top-level scenario parameters**: every `paramKey` in `DEFAULT_MC_VARIABLE_CONFIGS` is a string that maps directly to a key in the scenario's `parameters` map (`rothGrowthRate`, `usInflationRate`, `exchangeRateUsdToAud`, etc.). Two upcoming features need to sweep **structured** parameters that don't fit this flat-key shape:

- **Shock-MC (design 21 Phase 2).** A scenario carries `scenarioParams.shocks: FinancialShock[]`. MC needs to perturb `shocks[0].severity`, `shocks[0].recovery.durationMonths`, `shocks[1].levelEffects.equityRevaluation.multiplier`, etc. — addresses inside a structured array, not top-level keys.
- **Mortality-MC (design 27).** Each person on a scenario has a `lifeExpectancy` (and per-person actuarial draws are the whole point of MC mortality). MC needs to address `people.primary.lifeExpectancy`, `people.spouse.lifeExpectancy` independently and on a per-person basis.

A scoped extension of `IntlRetirementMcConfig` to understand **path-walking parameter keys** solves both consumers with the same primitive. This is the only design needed; `IntlRetirementOptConfig` follows the same path-walker once the contract is set, but its migration is its own follow-up.

---

## 2. Today's shape

`DEFAULT_MC_VARIABLE_CONFIGS` is a flat array of records. Each entry maps a top-level scenario param key to a distribution:

```js
// src/finance/monte-carlo/intl-retirement-mc-config.js (existing)
{
  paramKey: 'rothGrowthRate',
  label:    'Roth IRA Growth Rate',
  type:     DISTRIBUTION_TYPES.NORMAL,
  mean:     D.rothGrowthRate,
  stdDev:   0.03,
  group:    'US Account Rates',
  enabled:  true,
}
```

The MC runner consumes these via something like:

```js
// pseudocode inside IntlRetirementMcRunner
for (const cfg of variableConfigs) {
  const value = sampleDistribution(cfg, rng);
  params[cfg.paramKey] = value;
}
const cfg = IntlRetirementScenario.buildAndCompile({ params, … });
```

`params[cfg.paramKey] = value` is the choke point. It assumes `paramKey` is a top-level string key.

---

## 3. Design

### 3.1 Path-walking `paramKey`

`paramKey` is extended to accept a **path expression** addressing a value nested inside the scenario's parameters tree. Two surface forms are supported:

| Form | Example | Meaning |
|---|---|---|
| Top-level (existing) | `rothGrowthRate` | Sets `params.rothGrowthRate` |
| Dot path | `people.primary.lifeExpectancy` | Sets `params.people.primary.lifeExpectancy` |
| Bracketed index | `shocks[0].severity` | Sets `params.shocks[0].severity` |
| Mixed | `shocks[0].levelEffects.equityRevaluation.multiplier` | Sets the multiplier inside the first shock's equity-revaluation block |

A small `set(obj, path, value)` helper walks the path, creating intermediate objects/arrays only when the segment after them already exists in the source `params` (no implicit shape inference — the source must already carry the structure being addressed). The reverse `get(obj, path)` is used by the UI to display current default values and by the runner to read base values during sweeps.

Path parsing: `'people.primary.lifeExpectancy'.split(/\.|\[(\d+)\]\.?/).filter(Boolean)` yields `['people', 'primary', 'lifeExpectancy']`. Bracketed segments coerce to numeric array indices. A single regex covers the surface — no parser library, no recursive descent.

### 3.2 Backward compatibility

Every existing top-level `paramKey` continues to work unchanged — it's just a one-segment path. The `set`/`get` helpers degrade naturally to direct key writes on top-level paths. Nothing in `DEFAULT_MC_VARIABLE_CONFIGS` changes for the §2 entries; the new shape opens up additional entries that designs 21 / 27 will register through their own config-extension hooks (§3.4).

### 3.3 Per-iteration default tree resolution

For top-level params, `mean` / `value` in a `VariableConfig` reads from `INTL_RETIREMENT_DEFAULTS`. For nested params, the **default tree** also needs to come from somewhere structured:

- **Shocks** — the scenario's `parameters.shocks` array is the source; `shocks[0].severity` defaults to whatever the scenario configured.
- **People** — `parameters.people.primary.lifeExpectancy` defaults to the live `Person.lifeExpectancy` value at scenario-build time.

`IntlRetirementMcConfig` grows a `resolveDefault(paramKey)` method that takes a path and returns the current value from the **base scenario's parameters tree**, computed once per MC sweep (not per iteration — the base tree doesn't change inside a sweep). This is the same idea as today's `D.rothGrowthRate` lookup, generalized to paths.

```js
// pseudocode
resolveDefault(paramKey) {
  return get(this.baseParams, paramKey);
}
```

`VariableConfig` records that omit `mean` / `value` and only carry a distribution shape (`stdDev`, `min`, `max`) read the mean from `resolveDefault(paramKey)`. This keeps the UI declarative: a config record can describe "a normal centered on whatever the scenario currently has, with stdDev 2 years" without baking the center value into the record.

### 3.4 Config-extension hook

The current `DEFAULT_MC_VARIABLE_CONFIGS` is a hard-coded array; only `IntlRetirementScenario` contributes. Once shocks and mortality consumers exist, each wants to register their own MC variables. The hook is:

```js
// src/finance/monte-carlo/intl-retirement-mc-config.js (extended)
export class IntlRetirementMcConfig {
  static contributors = [
    () => DEFAULT_MC_VARIABLE_CONFIGS,   // existing top-level params
    // design 21 Phase 2 registers:
    //   ({ scenarioParams }) => buildShockMcConfigs(scenarioParams.shocks),
    // design 27 registers:
    //   ({ scenarioParams }) => buildMortalityMcConfigs(scenarioParams.people),
  ];

  buildVariables(scenarioParams) {
    return this.constructor.contributors
      .flatMap(fn => fn({ scenarioParams }))
      .map(cfg => ({
        ...cfg,
        defaultValue: get(scenarioParams, cfg.paramKey),
      }));
  }
}
```

Contributors are registered by the owning module at import time, the same pattern `TypeRegistry` uses. The contract: a contributor returns `VariableConfig[]`; each record's `paramKey` is a path the §3.1 helpers can walk.

### 3.5 Runner change

```js
// pseudocode inside IntlRetirementMcRunner
const variables = mcConfig.buildVariables(baseParams);
for (let i = 0; i < N; i++) {
  const iterParams = structuredClone(baseParams);
  for (const cfg of variables) {
    if (!cfg.enabled) continue;
    const value = sampleDistribution(cfg, rng);
    set(iterParams, cfg.paramKey, value);
  }
  const result = IntlRetirementScenario.buildAndCompile({ params: iterParams, … });
  // …record result…
}
```

Two surface changes from today: (a) `structuredClone(baseParams)` per iteration so nested writes don't mutate the base tree; (b) `set(iterParams, cfg.paramKey, value)` replaces the direct key assignment. `buildAndCompile` already accepts a `params` object and threads it through; no change there.

### 3.6 UI

The MC config plugin (`mc-config` in the workbench) renders one row per variable config. Today the label / group / enabled toggle / distribution-type selector / mean / stdDev are surfaced. For nested paths:

- **Label** continues to be the human-readable name (`'Primary lifeExpectancy (years)'`, `'Shock #1: severity'`).
- **Group** continues to be a flat string; nested paths can use natural groups like `'Mortality'`, `'Shocks'`.
- **Default value** displays `resolveDefault(paramKey)` so a user sees the base they're perturbing around.
- **Path** is **not** shown by default but is available in a tooltip / debug view so users can verify what they're sweeping.

No new UI components. The existing rows accept paths the moment the config records do.

---

## 4. Validation

- **Path resolves on the base tree.** `IntlRetirementMcConfig.buildVariables()` walks every contributor's variables once; any path that fails to resolve via `get(baseParams, paramKey)` is dropped with a `console.warn` (matches today's "warn on duplicate `EventSeries` types" pattern). This prevents a stale shock-MC config from poisoning the run when the scenario no longer carries that shock.
- **Distribution shape matches the target.** `lifeExpectancy` is a positive number; the `min` clamp (e.g. clamp to `[40, 110]`) is part of the distribution config, not enforced by the path walker. The path walker is type-agnostic.
- **No path-walker mutation outside the runner.** `set` is called only inside `IntlRetirementMcRunner`'s per-iteration loop, on a `structuredClone(baseParams)`. The base scenario tree is never mutated by MC. This keeps single-run determinism intact and avoids the design 21 §15 footgun of MC accidentally leaking iteration state into the next run.

---

## 5. Out of scope

- **`IntlRetirementOptConfig` migration.** Optimization follows the same pattern; once §3 lands, the optimizer's variable-iteration loop swaps the same way. Tracked as a follow-up — it's mechanical once the helper exists, but it doesn't need to ship in lock-step with the MC change.
- **General-purpose JSONPath support.** No wildcards, no recursive descent. The §3.1 grammar (dots, bracketed indices) is the closed surface. A future need for richer paths is a separate (small) design.
- **Path-walking in the scenario param schema itself.** Param-schema entries today don't use nested paths either — they cascade structured edits via `node: { type, id|stateKey, field }` declarations (per `scenario-loader.js`). That mechanism is fine for what it does; this design doesn't unify the two surfaces.
- **Path-walking for graph-node addressing.** `breakpointNodeIds` and the graph-query API use their own ID surface. Unrelated.

---

## 6. Testing

- `tests/unit/mc-nested-param-paths.test.mjs` — pure tests on `get` / `set` for every supported path shape (top-level, dot, bracketed, mixed); negative tests for malformed paths.
- `tests/unit/intl-retirement-mc-runner.test.mjs` — adds a fixture variable config addressing a nested path (a fake `people.primary.lifeExpectancy` while design 27 is pending), asserts the iteration's `params` tree has the sampled value at the addressed path and that the base tree is unchanged.
- `tests/unit/intl-retirement-mc-config.test.mjs` — `resolveDefault` returns the correct value for top-level and nested paths; missing paths warn and the variable is skipped.
- Round-trip: `mc-config` UI state serializes / deserializes per-variable `paramKey` strings unchanged. No backward-incompat for saved MC configs.

---

## 7. Sequencing

This design is **independent of design 25**. It can land before, after, or in parallel. The roadmap's Phase A groups them only because they're both "shared substrate"; they touch different files (`account.js` / handlers vs. `intl-retirement-mc-config.js` / `intl-retirement-mc-runner.js`).

Recommended sequencing: ship 25a first if the next user-facing feature is a shock-MC or mortality-MC variable, ship 25 first if the next feature is per-account allocation. Either order works.

---

## 8. Summary

`paramKey` becomes a path expression. `IntlRetirementMcConfig` grows a contributor hook so shocks and mortality can register their own MC variables. The MC runner uses `structuredClone` + `set` to keep the base tree pristine. Three small files change; no engine change; no breaking change to existing flat-key configs.

This unblocks design 21 Phase 2 (shock severity MC sweeps) and design 27 (per-person actuarial lifespan draws) without either of them needing to re-derive the substrate.
