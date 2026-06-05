# 25a — Monte Carlo Config: Nested Parameter Paths

**Status**: Ready for implementation (priority — lands before designs 26/27)
**Phase**: A — Substrate (per `design/24-financial-modeling-roadmap.md` §5; peer to `design/25-holding-level-state.md`)
**Driving consumer**: **Multi-shock MC sweeps.** The flat `shockSeverity` / `shockStartDate` overlay (a translation-era workaround) can only perturb `shocks[0]`. This design replaces that overlay with proper nested-path sweeping so a scenario carrying *N* shocks can sweep every shock's `severity` / `startDate` (and deeper fields) independently in one MC run.
**Related**: `design/21-financial-shock-and-regime-framework.md` §15 (flagged nested-path MC sweeps), `design/24-financial-modeling-roadmap.md` §4.4, `design/26-dynamic-spending-strategies.md` §12 (healthcare-MC consumer), `design/27-mortality-and-survivor-mechanics.md` (per-person lifespan draws), `design/25-holding-level-state.md` (peer substrate; no direct dependency).
**Author note**: Rescoped 2026-06-05. The original skeleton treated nested paths as future-proofing; the real, immediate need is fixing multi-shock MC. The runner section is corrected to match the actual two-stage param flow (`_resolveBaseParams` → `_perturb` → `createSimulation` merge), which the original pseudocode glossed over.

---

## 1. Purpose

`IntlRetirementMcConfig` sweeps **flat top-level scenario parameters**: every `paramKey` in `DEFAULT_MC_VARIABLE_CONFIGS` maps directly to a key in the scenario's `parameters` map (`rothGrowthRate`, `usInflationRate`, …). The MC runner's choke point is a direct assignment `perturbed[cfg.paramKey] = sample` (`intl-retirement-mc-runner.js:227`).

Two things don't fit the flat shape:

1. **Multi-shock sweeps (driving consumer).** A scenario carries `parameters.shocks: ShockEntry[]` (the `ShockList` param, `economic-regimes-toolset.js:196`). Today MC can only perturb the *first* shock, and only via two flat override keys (`shockSeverity`, `shockStartDate`) that `applyShockOverlay` maps onto `shocks[0]` (`economic-regimes-toolset.js:98-126`, `schedules()` line 259 — `if (i === 0)`). A scenario with two shocks (a 2030 equity crash *and* a 2035 rate spike) cannot sweep the second shock at all. **This is the feature that got mangled in translation and this design restores it.**
2. **Per-person / nested future consumers.** Mortality-MC (design 27) wants `people.primary.lifeExpectancy`; healthcare-MC (design 26) wants `healthcare.*`. These ride the same primitive once it exists.

A scoped extension of `IntlRetirementMcConfig` to understand **path-walking parameter keys** plus a **contributor hook** that generates one MC variable per shock-array entry solves the driving consumer and the future ones with the same primitive.

---

## 2. Today's shape (verified against code)

`DEFAULT_MC_VARIABLE_CONFIGS` is a flat array; each record maps a top-level key to a distribution. The runner consumes them in `_perturb`:

```js
// intl-retirement-mc-runner.js (current)
_perturb(baseParams, i) {
  const rng       = makeSeededRng(i + 1);
  const perturbed = { ...baseParams };          // ← shallow spread
  for (const cfg of this.variableConfigs) {
    if (cfg.enabled)               perturbed[cfg.paramKey] = createDistribution(cfg).sample(rng);
    else if (!(cfg.paramKey in baseParams)) perturbed[cfg.paramKey] = cfg.value ?? cfg.mean;
  }
  return perturbed;
}
```

Two facts that shape the design:

- **`baseParams` already carries structured values.** `monte-carlo-presenter._resolveBaseParams()` (line 97) flattens the scenario's `[{key,value}]` param array into `{ key: value }`. The `shocks` param is one such key, so **`baseParams.shocks` is the full `ShockEntry[]`** — the base tree for nested shock paths is already in hand; no need to reach into `cfgTemplate.parameters`.
- **The shallow spread is a latent mutation bug for nested writes.** `perturbed.shocks` is the *same array reference* as `baseParams.shocks` (and the live scenario's). A direct `perturbed[cfg.paramKey] = …` flat write is safe, but a nested `set(perturbed, 'shocks[0].severity', v)` would mutate the shared array — leaking iteration state across runs and back into the user's scenario. `structuredClone` per iteration (§4) closes this.

Downstream, `createSimulation(params)` shallow-merges `cfg.parameters = { ...cfg.parameters, ...params }` (`intl-retirement-mc-runner.js:151`). When `params.shocks` is a fully-perturbed array, the shallow merge replaces `cfg.parameters.shocks` wholesale — correct, because the perturbed array is complete.

---

## 3. Design

### 3.1 Path-walking `paramKey`

`paramKey` accepts a **path expression** addressing a value nested inside the params tree:

| Form | Example | Sets |
|---|---|---|
| Top-level (existing) | `rothGrowthRate` | `params.rothGrowthRate` |
| Dot path | `people.primary.lifeExpectancy` | `params.people.primary.lifeExpectancy` |
| Bracketed index | `shocks[0].severity` | `params.shocks[0].severity` |
| Mixed / deep | `shocks[1].recovery.durationMonths` | the second shock's recovery duration |

A small `mc-param-paths.js` module exports `get(obj, path)` and `set(obj, path, value)`. Both parse via one regex:

```js
const segments = path.split(/\.|\[(\d+)\]\.?/).filter(Boolean); // 'shocks[1].severity' → ['shocks','1','severity']
```

Numeric segments coerce to array indices. `set` walks the path and **only traverses segments that already exist** in the (cloned) source tree — no implicit shape inference. If an intermediate is missing, `set` is a no-op and `get` returns `undefined` (used by validation §5 to drop stale configs). Top-level paths degrade to direct key access, so every existing flat config keeps working unchanged.

### 3.2 Contributor hook + dynamic shock variables

`DEFAULT_MC_VARIABLE_CONFIGS` is hard-coded today. Add a contributor registry so a toolset can register MC variables computed from the live param tree:

```js
// intl-retirement-mc-config.js (extended)
export class IntlRetirementMcConfig {
  static contributors = [
    () => DEFAULT_MC_VARIABLE_CONFIGS,            // existing flat params
    ({ params }) => buildShockMcConfigs(params),  // NEW — one set of vars per configured shock
    // design 27: ({ params }) => buildMortalityMcConfigs(params),
  ];

  buildVariables(params) {
    return this.constructor.contributors
      .flatMap(fn => fn({ params }))
      .filter(cfg => get(params, cfg.paramKey) !== undefined)   // drop unresolvable (warn)
      .map(cfg => ({ ...cfg, defaultValue: get(params, cfg.paramKey) }));
  }
}
```

`buildShockMcConfigs(params)` reads `params.shocks ?? []` and emits, **per shock index `i`**, a small set of nested-path variables:

```js
function buildShockMcConfigs(params) {
  const shocks = params.shocks ?? [];
  return shocks.flatMap((entry, i) => {
    const label = entry.preset ?? entry.shockId ?? `Shock ${i + 1}`;
    return [
      { paramKey: `shocks[${i}].severity`,  label: `${label}: severity`,
        type: NORMAL,       mean: undefined /* resolveDefault */, stdDev: 0.10,
        group: 'Economic Shocks', enabled: false },
      { paramKey: `shocks[${i}].startDate`, label: `${label}: start date`,
        type: UNIFORM_DATE, min: '2028-01-01', max: '2035-01-01',
        group: 'Economic Shocks', enabled: false },
    ];
  });
}
```

A record that omits `mean`/`value` reads its center from `resolveDefault(paramKey) = get(params, paramKey)` — so "normal centered on whatever the scenario configured for this shock, stdDev 0.10" needs no baked-in value. This is the generalization of today's `D.rothGrowthRate` lookup. Deeper fields (`recovery.durationMonths`, `levelEffects.equityRevaluation.multiplier`) are addable to the per-shock set later without runner changes.

### 3.3 Runner change

```js
_perturb(baseParams, i) {
  const rng         = makeSeededRng(i + 1);
  const perturbed   = structuredClone(baseParams);          // (a) deep clone — nested writes can't leak
  for (const cfg of this.variables) {                       // (b) this.variables = buildVariables(baseParams)
    if (cfg.enabled)                       set(perturbed, cfg.paramKey, createDistribution(cfg).sample(rng));
    else if (get(baseParams, cfg.paramKey) === undefined) set(perturbed, cfg.paramKey, cfg.value ?? cfg.mean);
  }
  return perturbed;
}
```

Three changes from today: (a) `structuredClone(baseParams)` replaces the shallow spread; (b) `set(perturbed, cfg.paramKey, …)` replaces direct assignment; (c) the runner resolves `this.variables` once via `buildVariables(baseParams)` so dynamic shock variables exist. `createSimulation`'s shallow merge is unchanged — a perturbed `shocks` array replaces the template's wholesale (§2).

### 3.4 Shock-handling fix (remove the `shocks[0]`-only overlay)

The overlay derives `equityRevaluation.multiplier` from `severity` *only for shocks[0]* inside `applyShockOverrides`. To make a swept `shocks[i].severity` actually take effect for **any** `i`, move that derivation into shock **resolution**:

- **`resolveShockEntry(item)`** gains: when `item.severity != null`, set `severity` and derive `levelEffects.equityRevaluation.multiplier = -Math.abs(severity)` on the resolved shock. This makes `severity` the single canonical knob whether it came from the config or from an MC `set`.
- **`schedules()`** drops the `if (i === 0) applyShockOverrides(...)` special case (line 259) — every entry is resolved uniformly; the perturbed value is already in `params.shocks[i]`.
- **Delete** `applyShockOverrides`, and the flat `shockSeverity` / `shockStartDate` param-schema entries (`economic-regimes-toolset.js:206-227`).

### 3.5 UI

The `mc-config` workbench plugin renders one row per variable. Dynamic shock rows arrive through `buildVariables` like any other — label (`'MARKET_CRASH_2008_LITE: severity'`), group (`'Economic Shocks'`), enabled toggle, distribution type, and a **default value** shown from `resolveDefault`. No new components. The number of shock rows tracks the configured `shocks` array length automatically.

---

## 4. Migration & back-compat

- **Saved MC configs referencing `shockSeverity` / `shockStartDate`.** These paramKeys no longer resolve (`get(params,'shockSeverity') === undefined`) and would be silently dropped by §5 validation. Add a one-line migration in `buildVariables` (or config load): rewrite legacy `shockSeverity → shocks[0].severity`, `shockStartDate → shocks[0].startDate` before resolution, so an existing saved sweep keeps working against the first shock.
- **`IntlRetirementOptConfig`** (`intl-retirement-opt-config.js:91`) also references `shockSeverity`. Deleting the param breaks the optimizer. **In scope for this change:** migrate the opt-config's shock variable to the same nested path (`shocks[0].severity`) and give `IntlRetirementOptConfig` the same `get`/`set` treatment in its iteration loop, OR keep a thin deprecated `shockSeverity` alias resolving to `shocks[0]` until the opt migration (its own follow-up) lands. Pick one at implementation; the clean option is migrating opt now since the helper already exists.
- **No engine change.** `buildAndCompile` / `ScenarioLoader` already thread `parameters` through; only `IntlRetirementMcConfig`, the runner, and the regimes toolset change.

---

## 5. Validation

- **Path resolves on the base tree.** `buildVariables` drops any variable whose `get(baseParams, paramKey)` is `undefined`, with a `console.warn` (matches the "warn on duplicate EventSeries type" pattern). A stale shock-MC config from a scenario that no longer carries that shock can't poison the run.
- **No path-walker mutation outside the per-iteration clone.** `set` is called only inside `_perturb` on a `structuredClone(baseParams)`. The base tree and the live scenario are never mutated — preserves single-run determinism and prevents iteration-state leakage (the design 21 §15 footgun).
- **Type-agnostic walker.** Clamps (`severity ∈ [0,1]`, lifespan ∈ `[40,110]`) live in the distribution config, not the walker.

---

## 6. Out of scope

- **General JSONPath** (wildcards, recursive descent). The §3.1 grammar (dots, bracketed indices) is the closed surface.
- **Unifying with the `node:` cascade.** The scenario param schema cascades structured edits via `node: { type, id|stateKey, field }` (`scenario-loader.js:111-132`). That remains the mechanism for *fixed* person/account records (e.g. `primaryMonthlyWage → persons.primary.monthlyWage`); design 27 may use it for `lifeExpectancy` instead of a nested path. This design owns the *array-indexed* case (`shocks[N]`) the cascade can't express; the two surfaces coexist.
- **Per-shock deep fields beyond severity/startDate** (`recovery.curve`, multi-field `levelEffects`). The contributor can grow these later; MVP ships `severity` + `startDate` per shock.

---

## 7. Implementation tasks

1. **`src/finance/monte-carlo/mc-param-paths.js`** — `get(obj,path)`, `set(obj,path,value)`, path parser. Unit-tested standalone.
2. **`intl-retirement-mc-config.js`** — add `contributors` registry, `buildVariables(params)`, `resolveDefault`, `buildShockMcConfigs(params)`; legacy `shockSeverity`/`shockStartDate` rewrite.
3. **`intl-retirement-mc-runner.js`** — `structuredClone` in `_perturb`; resolve `this.variables = buildVariables(baseParams)` in `run()`; `set`-based writes.
4. **`economic-regimes-toolset.js`** — move severity→multiplier derivation into `resolveShockEntry`; drop the `i === 0` overlay in `schedules()`; delete `applyShockOverrides` + flat param entries.
5. **`intl-retirement-opt-config.js`** — migrate `shockSeverity → shocks[0].severity` (or alias; §4).
6. **Tests** (§8).

Sequence: 1 → 2/3 (parallel) → 4 → 5 → 6. Each step is independently testable.

---

## 8. Testing

- `tests/unit/mc-param-paths.test.mjs` — `get`/`set` for top-level, dot, bracketed, mixed, and deep paths; negative tests for malformed/missing paths; assert `set` never mutates a sibling.
- `tests/unit/intl-retirement-mc-config.test.mjs` — `buildShockMcConfigs` emits the right variable set for a 0-, 1-, and 2-shock scenario; `resolveDefault` returns configured values; legacy `shockSeverity` rewrite resolves to `shocks[0].severity`.
- `tests/unit/intl-retirement-mc-runner.test.mjs` — **multi-shock sweep**: a 2-shock base tree, both `shocks[0].severity` and `shocks[1].severity` enabled, asserts each iteration's `params.shocks[i].severity` holds the sampled value, the derived `equityRevaluation.multiplier` matches, **and `baseParams.shocks` is unmutated** after the full run.
- `tests/unit/evt-economic-shock.test.mjs` (or existing regime test) — confirm a swept `shocks[1]` actually schedules its `ECONOMIC_SHOCK` + recovery ticks and moves the regime, proving the overlay removal didn't regress single/first-shock behavior.
- Round-trip: `mc-config` UI state serializes/deserializes nested `paramKey` strings unchanged.

---

## 9. Summary

`paramKey` becomes a path expression; a contributor hook generates one MC variable per configured shock; the runner deep-clones per iteration and writes via `set`. The flat `shocks[0]`-only overlay is deleted and severity→multiplier derivation moves into shock resolution, so **every shock in a scenario is independently MC-sweepable**. Four source files change plus opt-config migration; no engine change; existing flat-key configs and (via a rewrite shim) saved shock sweeps keep working.

This lands first — it restores multi-shock MC (the driving feature) and leaves the nested-path substrate in place for design 26 (healthcare-MC) and design 27 (per-person lifespan) to consume.
