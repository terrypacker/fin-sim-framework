# 64 — Attention Mechanisms for the MPC Solver

**Status**: Proposed (2026-07-15)
**Related**: `design/38-optimization-solver-framework.md` (solver framework + `OptimizationProblem`), `design/39-mpc-financial-controller.md` (the cockpit/controller), `design/41-windowed-prediction-horizon.md` (sliding horizon), `design/46-mpc-performance.md` (surrogate + parallelism). Code: `src/finance/optimization/solvers/cem-solver.js`, `src/finance/optimization/solvers/solver-support.js` (`EvalLedger`), `src/finance/optimization/optimization-objectives.js` (Die-With-Target family), `src/finance/mpc/cockpit-controller.js` (warm-start, `advise`, `autoRun`).

**Dependency on design 46:** None. All three mechanisms (§3–§5) are independently shippable. The only shared surface is the `CrossEpochStore` (§4.5), which design 64 creates and design 46's surrogate (Phase 4) will consume later. The store is inert when no consumers register, so design 64 lands cleanly without design 46. **Recommended order: design 64 first**, then design 46 Phase 4 registers as a second consumer when it lands.

---

## 1. Purpose

The MPC solver currently treats all information uniformly: every sample in a CEM generation is equally weighted (or hard-truncated), warm-start carries forward one point, and objective penalty weights are fixed scalars. **Attention** — the machine-learning concept of context-dependent weighting — can improve all three.

This design introduces three orthogonal attention mechanisms into the MPC solver, each independently valuable:

1. **Sample attention** (§3): Replace CEM's hard elite cut with soft, score-weighted refit — weight every sample by relevance, not just the top few. This is the MPPI-style refinement already noted as deferred in `cem-solver.js:48`.
2. **Cross-epoch memory** (§4): Replace the single-point warm-start with a relevance-weighted memory bank of past solutions — generalize warm-start from "carry the last answer" to "carry a distribution of past answers weighted by similarity to the current state."
3. **Objective attention** (§5): Make the Die-With-Target penalty weights `λ` and `μ` state-dependent — the objective's emphasis shifts automatically as the portfolio ages and depletes, rather than staying fixed.

All three share a common principle: **weight by relevance, don't hard-select.** They are independent — each can ship alone — but they compose naturally: sample attention improves the quality of the memory bank entries; the memory bank improves warm-start quality; objective attention reshapes the score surface the solver navigates.

---

## 2. Today

Grounded against the live code (2026-07-15):

- **CEM uses hard elitism.** `cem-solver.js:136-142`: sort by score, take the top `nElite`, compute their mean/std, discard the rest. With `population=32` and `eliteFrac=0.25`, the Gaussian is refit from just 8 samples. Multimodal score surfaces are collapsed.
- **Warm-start carries one point.** `CockpitController.advise()` passes `start: prevCandidate` to the solver. The solver uses it as the initial mean (`cem-solver.js:105-107`). No information about *diversity* or *regime* is carried.
- **Objective weights are fixed.** `optimization-objectives.js:30,47`: `DEFAULT_TERMINAL_WEALTH_PENALTY = 10`, `DEFAULT_DEFICIT_PENALTY = 100`. The `evaluate` function reads `result.terminalWealthTargetPenalty ?? _defaultLambda(...)` and `result.deficitPenalty ?? DEFAULT_DEFICIT_PENALTY` — both static scalars. The penalty structure does not adapt to the plan's current health.
- **The solver UI select** (`solver-registry.js`) presents one entry per solver class. A new solver class = a new item in the dropdown. No checkbox needed.

---

## 3. Sample Attention — Soft CEM (MPPI-style Refit)

### 3.1 The idea

Instead of the hard elite cut:

```
scored.sort(descending)
elite = scored.slice(0, nElite)
mean[k] = mean(elite.map(e => e.vec[k]))
```

use soft, exponential weighting over the **entire population**:

```
weights[i] = exp(score[i] / temperature) / Z   // softmax
mean[k]   = Σ_i  weights[i] · scored[i].vec[k]
std[k]    = sqrt( Σ_i  weights[i] · (scored[i].vec[k] - mean[k])² )
```

where `temperature` is a tuning knob (high = uniform weighting, low = approaches hard elitism). This is the **MPPI** (Model Predictive Path Integral) formulation — a well-known variant of CEM from the control literature.

### 3.2 Why it helps

- **Multimodal preservation**: Hard elitism with 8 elites from a 32-sample population can split across modes if the top scores straddle two basins. Soft weighting gives higher weight to samples *within* each basin while retaining non-zero weight from the other basin, preserving mode information longer.
- **Smoother Gaussian refit**: The weighted mean/std is a smooth function of all scores, not a discontinuous function of the elite cutoff boundary. This reduces oscillation across generations.
- **Temperature as a knob**: Temperature controls the exploration/exploitation tradeoff directly — high temperature = explore broadly (all samples matter), low temperature = exploit greedily (only the best matter). This is more interpretable than `eliteFrac`.

### 3.3 Implementation

**New class: `CemSoftSolver`** in `src/finance/optimization/solvers/cem-soft-solver.js`.

Extends `CemSolver`. Overrides only the refit step (lines 135-146 of `cem-solver.js`). All other mechanics (population generation, sigma management, budget enforcement, dedup) are inherited unchanged.

```
CemSoftSolver extends CemSolver {
  static key   = 'CEM_SOFT';
  static label = 'Cross-Entropy Method — soft weighting (MPPI)';

  constructor({ temperature = 5.0, ...rest } = {}) {
    super(rest);
    this.temperature = temperature;
  }

  // Override only the refit step inside solve()
  _refit(scored, m, sigma, bounds, range) {
    const T = this.temperature;
    const scores = scored.map(s => s.score);
    const maxScore = Math.max(...scores);

    // Numerically stable softmax
    const weights = scored.map(s => Math.exp((s.score - maxScore) / T));
    const Z = weights.reduce((a, b) => a + b, 0);
    const w = weights.map(wi => wi / Z);

    const n = m.length;
    const newMean  = new Array(n).fill(0);
    const newStd   = new Array(n).fill(0);

    for (let k = 0; k < n; k++) {
      for (let i = 0; i < scored.length; i++) {
        newMean[k] += w[i] * scored[i].vec[k];
      }
      for (let i = 0; i < scored.length; i++) {
        newStd[k] += w[i] * (scored[i].vec[k] - newMean[k]) ** 2;
      }
      newStd[k] = Math.max(Math.sqrt(newStd[k]), sigmaFloor * range[k]);
    }

    return { mean: newMean, std: newStd };
  }
}
```

Register in `SOLVER_REGISTRY`:

```js
CEM_SOFT: {
  label: 'Cross-Entropy Method — soft (MPPI)',
  factory: (opts) => new CemSoftSolver(opts),
  optionSchema: [
    ...CEM_BASE_OPTIONS,              // budget, seed, population, sigma0, smoothing, sigmaFloor
    { key: 'temperature', label: 'Temperature', type: 'number', default: 5.0, min: 0.1, max: 100 },
  ],
}
```

The solver `<select>` in the cockpit UI gets one new entry: "Cross-Entropy Method — soft (MPPI)." No checkbox, no clutter.

### 3.4 Relationship to design 46

The surrogate (design 46) reduces rollout count by fitting a cheap model to input/output samples. Soft CEM is orthogonal — it changes *how* samples are weighted, not *how many* rollouts are run. They compose: soft CEM + surrogate means fewer rollouts *and* better weighting of the ones you do run. Soft CEM is also simpler and independently valuable without the surrogate.

---

## 4. Cross-Epoch Memory (Attention over Past Solutions)

### 4.1 The idea

Currently, each MPC epoch's solver is warm-started with the previous epoch's single best solution. This assumes the current state is close to the previous state — which breaks across **regime boundaries** (e.g., before vs. after age 59.5 early-withdrawal eligibility, before vs. after 72 RMDs, or a large portfolio drawdown event).

The cross-epoch memory bank generalizes warm-start:

1. **Accumulate**: after each epoch's solve, store the best solution (or a diverse subset of the population) in a bounded memory bank.
2. **Query**: at the start of the next epoch, compute the current state vector (portfolio value, age, account balances, tax bracket).
3. **Attention**: weight each memory entry by its similarity to the current state. Use the weighted combination as the solver's initial mean and (optionally) initial sigma.

```
// Pseudocode for the warm-start computation
stateNow       = extractState(snapshot)                    // current state vector
similarities   = memory.map(entry => similarity(stateNow, entry.state))
attentionWts   = softmax(similarities / temperature_mem)   // attention weights
initialMean    = Σ attentionWt_i · memory_i.solution       // weighted solution
initialSigma   = weightedStd(memory, attentionWts)         // diversity of relevant past
```

### 4.2 Why it helps

- **Regime robustness**: When the solver crosses a regime boundary (e.g., early-withdrawal eligibility), the previous epoch's solution may be in a very different part of the search space. The memory bank retains solutions from past similar regimes and can warm-start from them instead.
- **Diversity preservation**: A weighted initial sigma (not just the previous solution's value) tells the solver "there's uncertainty here" — encouraging exploration when the state is novel and exploitation when the state is familiar.
- **Graceful degradation**: If the memory is empty or no past entry is similar, the attention weights are uniform — equivalent to the current behavior. The feature is zero-cost when unhelpful.

### 4.3 Similarity metric

The similarity function is the key design choice. We support pluggable metrics with a default:

- **Default: full-state Euclidean distance.** Extract a fixed set of scalar fields from the snapshot state (age, total portfolio value, per-account balances, tax bracket index, cumulative deficit, cumulative consumption). Normalize each to [0,1] over a reasonable range. Compute Euclidean distance; convert to similarity via `exp(-distance² / 2σ²)`.
- **Extension point: regime-aware metric.** A custom similarity function could weight regime indicators (age brackets, account eligibility flags) more heavily than continuous values (exact portfolio balance). This is a future enhancement.

### 4.4 Implementation

**Memory bank in `CockpitController`** (`cockpit-controller.js`):

```js
class CockpitController {
  constructor() {
    ...
    this._memoryBank = [];           // [{ state: number[], solution: object, score: number }]
    this._memorySize = 16;           // bounded; FIFO eviction when full
    this._similarityFn = defaultStateSimilarity;  // pluggable
  }
}
```

In `advise()`, after the solve completes:

```js
// Store this epoch's result in the memory bank
const stateVec = extractStateVector(snapshot);
this._memoryBank.push({ state: stateVec, solution: best.candidate, score: best.score });
if (this._memoryBank.length > this._memorySize) this._memoryBank.shift();
```

In the solver warm-start computation, before `solve()`:

```js
const start = attentionWarmStart(
  extractStateVector(snapshot),
  this._memoryBank,
  this._similarityFn,
  { temperature: 1.0, memorySize: this._memorySize }
);
// start = { mean: number[], sigma: number[] } or null (fallback to box center)
```

**`extractStateVector(snapshot)`** extracts a fixed-size numeric vector from the snapshot state. The field list is a constant array — easy to extend:

```js
const STATE_FIELDS = [
  'age',                          // normalized to [0, 1] over [50, 100]
  'totalPortfolioValue',          // log-scaled, normalized
  'cumulativeDeficit',            // normalized
  'cumulativeConsumption',        // normalized
  // Per-account balances are included dynamically from _presentRolesFromState
];
```

**`defaultStateSimilarity(vecA, vecB)`**: normalized Euclidean distance → Gaussian kernel. Simple, fast, well-understood.

### 4.5 Cross-epoch persistence — shared `CrossEpochStore`

The memory bank and design 46's surrogate (§8) share the same lifecycle: bounded storage, regime-change reset, and stale-entry decay. Rather than duplicating this logic, both register as consumers of a shared `CrossEpochStore`:

```js
// src/finance/optimization/cross-epoch-store.js
class CrossEpochStore {
  constructor({ maxSize = 32, onRegimeChange = null } = {}) {
    this._consumers = new Map();   // consumerKey → { entries: [], maxSize, evictionFn }
    this._maxSize   = maxSize;
    this._onRegimeChange = onRegimeChange;  // cold-restart trigger
  }

  /** Register a consumer (memory bank, surrogate, etc.) with its own entry schema. */
  register(key, { maxSize, eviction = 'fifo' } = {}) { ... }

  /** Add an entry to a consumer's store. */
  push(consumerKey, entry) { ... }    // entry includes { timestamp, regimeId, ... }

  /** Retrieve a consumer's entries, decayed and sorted by relevance. */
  query(consumerKey, { stateVector, similarityFn, limit } = {}) { ... }

  /** Cold-restart: clear a consumer's entries on regime change. */
  reset(consumerKey) { ... }

  /** Inert when no consumers registered — no allocation unless opted in. */
}
```

**Backward compatibility:** when no consumer registers, the store is never allocated. The existing `CockpitController` warm-start (single-point `start`) and `CemSolver` (no persistence) continue to work unchanged. The store is opt-in: consumers register on construction, and the controller only instantiates the store if at least one consumer is present.

**Entry lifecycle:** each entry carries `{ timestamp, regimeId, data }`. On `query`, entries are filtered by regime (discard entries from incompatible regimes unless no same-regime entries exist), decayed by recency (older entries get lower similarity weight), and returned sorted by combined relevance score. Eviction is pluggable per consumer — FIFO default, score-weighted or diversity-maximizing later.

**Design 46 integration:** when the surrogate (design 46 Phase 4) lands, it registers as a second consumer with its own `maxSize` and eviction policy (decay-by-trust-region-distance). The memory bank and surrogate share the store's regime-change trigger but maintain independent entry pools.

### 4.6 Memory size and eviction

Default memory bank size is 16 entries with FIFO eviction. This keeps the attention computation O(16) per epoch — negligible compared to the solve. The `CrossEpochStore` default `maxSize` is 32 (shared across all consumers). A more sophisticated eviction policy (e.g., diversity-maximizing, or score-weighted) is a future enhancement.

---

## 5. Objective Attention — Adaptive Penalty Weights

### 5.1 The idea

The Die-With-Target objective formula is:

```
score = reward − λ · |terminal − target| − μ · cumulativeDeficit
```

Currently `λ` and `μ` are fixed scalars (defaults: 10 and 100). This design makes them **state-dependent functions**:

```
score = reward − λ(state) · |terminal − target| − μ(state) · cumulativeDeficit
```

The weights adapt automatically to the plan's current health:

- **When the portfolio is healthy** (high net worth relative to target): `λ` is moderate — the solver explores freely, trading spending against terminal wealth.
- **When insolvency approaches** (cumulative deficit growing, portfolio depleting): `μ` spikes — the solver is strongly penalized for plans that go broke, tightening the feasible region.
- **Near the end of the horizon** (few years remaining): `λ` increases — the solver pays more attention to hitting the terminal target, because there's less time to recover.

### 5.2 Why this over multi-objective rebalancing

Two approaches were considered:

- **(a) Adaptive penalty weights** (this design): The formula stays structurally identical. Only `λ` and `μ` become functions of state. Minimal code surface, easy to reason about, backward-compatible (fixed weights remain the default).
- **(b) Multi-objective rebalancing**: Dynamically reweight the decomposition (consumption vs. terminal wealth vs. deficit) based on state. More expressive but requires defining a weighting policy across multiple objectives, and the score surface becomes harder to reason about.

Approach (a) is preferred because:
1. It's a natural extension of the existing architecture — `evaluate` already receives `result + snapshot`, and the penalty weights are already overridable via scenario params.
2. The Die-With-Target formula is well-understood; changing only `λ` and `μ` is a small, testable perturbation.
3. It's backward-compatible: the fixed defaults remain the default behavior. Adaptive weights are opt-in via a scenario flag.

Approach (b) is noted as a future enhancement (§8 Q3).

### 5.3 Adaptive weight functions

```js
/**
 * Adaptive λ: increases as the horizon shortens.
 * Early in the plan, small spending changes compound over decades —
 * λ is low, allowing exploration. Near the end, precision matters more.
 *
 * λ(t) = λ_base · (1 + α · (1 − t_remaining / H))
 *
 * where t_remaining = years left in horizon, H = total horizon length.
 * α controls the adaptation strength (default 1.0 = doubling at the end).
 */
function adaptiveLambda(baseLambda, { snapshot, simEnd, now }) {
  const remaining = (simEnd - now) / (365.25 * 86400000);  // years
  const total     = (simEnd - snapshot?.date ?? now) / (365.25 * 86400000);
  const fraction  = total > 0 ? remaining / total : 1;
  const alpha     = 1.0;  // tunable
  return baseLambda * (1 + alpha * (1 - fraction));
}

/**
 * Adaptive μ: increases as the plan's solvency deteriorates.
 * When cumulativeDeficit is zero (solvent), μ = μ_base (no perturbation).
 * As deficit grows, μ rises — penalizing insolvency more aggressively
 * when the plan is already under stress.
 *
 * μ(state) = μ_base · (1 + β · deficitRatio)
 *
 * where deficitRatio = cumulativeDeficit / (totalPortfolioValue + 1),
 * clamped to [0, 1]. β controls adaptation strength (default 2.0).
 */
function adaptiveMu(baseMu, result) {
  const deficit       = result.cumulativeDeficit ?? 0;
  const portfolio     = result.totalPortfolioValue ?? 1;
  const deficitRatio  = Math.min(1, deficit / (portfolio + 1));
  const beta          = 2.0;  // tunable
  return baseMu * (1 + beta * deficitRatio);
}
```

### 5.4 Implementation

Changes are confined to `optimization-objectives.js` — specifically the `makeDieWithTarget` factory and `_deficitPenalty`:

```js
// In makeDieWithTarget.evaluate():
const lambda = result.terminalWealthTargetPenalty
  ?? (adaptiveEnabled ? adaptiveLambda(_defaultLambda(running, result), ctx) : _defaultLambda(running, result));
```

```js
// In _deficitPenalty():
const mu = result.deficitPenalty
  ?? (adaptiveEnabled ? adaptiveMu(DEFAULT_DEFICIT_PENALTY, result) : DEFAULT_DEFICIT_PENALTY);
```

The `adaptiveEnabled` flag is a scenario-level param (default `false` for backward compatibility). When `false`, behavior is identical to today.

The adaptive functions receive `result` and `snapshot` — both already available in the `evaluate` call. No new data plumbing needed.

### 5.5 What changes for the solver

Nothing. The solver calls `problem.evaluate(candidate)` exactly as before. The adaptive weights are purely inside the objective's `evaluate` function. The solver sees a scalar score and ranks by it — it has no awareness of how `λ` and `μ` were computed. This is the benefit of the existing architecture: the objective is a black box to the solver.

What *does* change is the **shape of the score surface**: with adaptive `λ`, the objective penalizes terminal miss more heavily near the end of the horizon, which shifts the optimizer's tradeoff between spending and saving over time. This is the intended effect — the solver navigates a more contextually appropriate landscape.

---

## 6. Composition and Interactions

The three mechanisms are independent and compose:

| Combination | Effect |
|---|---|
| Sample attention alone | Smoother CEM refit, better multimodal handling |
| Cross-epoch memory alone | Better warm-start across regime boundaries |
| Objective attention alone | Score surface adapts to plan health |
| Sample + cross-epoch | Memory entries are higher-quality (soft CEM finds better solutions) |
| Sample + objective | CEM navigates a more contextually shaped landscape |
| All three | Full attention stack: adaptive objective + adaptive search + adaptive warm-start |

The implementation order is:

1. **Sample attention** (§3) — smallest change, immediately testable, no dependencies
2. **Objective attention** (§5) — independent of §3, confined to `optimization-objectives.js`
3. **Cross-epoch memory** (§4) — builds on a working solver; the memory bank feeds from solved epochs

---

## 7. Testing sketch

- **`cem-soft-solver.test.mjs`** — Toy quadratic `OptimizationProblem` (2 continuous vars): confirm `CEM_SOFT` converges to the known optimum within tolerance, compare evaluation count vs `CEM` for same budget. Confirm temperature=very-high ≈ random sampling, temperature=very-low ≈ hard elitism.
- **`cem-soft-multimodal.test.mjs`** — Construct a 1D score surface with two modes (e.g., `max(sin(x), cos(x))`). Confirm `CEM_SOFT` maintains population diversity across modes longer than `CEM` with hard elitism.
- **`objective-adaptive.test.mjs`** — Confirm Die-With-Target with `adaptiveEnabled: true` produces different scores than fixed-weight for the same candidate when `cumulativeDeficit > 0`. Confirm `adaptiveEnabled: false` (default) is identical to current behavior.
- **`cross-epoch-memory.test.mjs`** — Simulate 3 MPC epochs with regime shift (e.g., age crosses 59.5). Confirm the memory bank stores entries, the warm-start selects the relevant past entry, and the solver converges faster than single-point warm-start.
- **`cockpit-controller-memory.test.mjs`** — Integration: confirm `advise()` populates the memory bank and `autoRun()` accumulates entries across epochs.

---

## 8. Open questions

- **Q1 — Temperature calibration for soft CEM.** What is a good default `temperature`? The literature suggests scaling by the score range: `temperature = c · range(scores)` where `c` is a constant (~0.1–0.5). Should this be auto-calibrated per generation, or a fixed scenario param?
- **Q2 — Memory bank similarity metric.** The default full-state Euclidean distance treats all state fields equally. Should regime indicators (age, eligibility flags) be weighted more heavily than continuous values (exact balance)? This is a future enhancement — the pluggable metric interface supports it without changing the memory bank.
- **Q3 — Multi-objective rebalancing (future).** Approach (b) from §5.2 — dynamically reweighting the objective decomposition (consumption vs. terminal vs. deficit) based on state. More expressive than adaptive penalty weights. Deferred to a follow-up design.
- **Q4 — Memory bank eviction policy.** FIFO is simple but may discard diverse old solutions. Score-weighted eviction (keep the best historical solutions) or diversity-maximizing eviction (keep the most spread-out solutions) are options. FIFO is the right default for the first cut.
- **Q5 — Cross-epoch memory vs. design 46 surrogate persistence.** Design 46 §8 describes persisting surrogate surfaces + decayed `EvalLedger` samples across epochs. The memory bank (§4) stores `{ state, solution, score }` tuples. Different data, but same lifecycle: both need bounded storage, regime-change triggers, and decay/eviction. **Decision: share a single persistence layer.** Both consumers store their entries in a unified `CrossEpochStore` that owns: (a) bounded entry count with pluggable eviction (FIFO default, score-weighted or diversity-maximizing later); (b) a regime-change reset hook (cold-restart trigger on age threshold, move year, or portfolio drawdown event); (c) per-entry recency metadata for decay. The memory bank and the surrogate each register as consumers of the store with their own entry schema. This avoids duplicating the bounded-storage + eviction + reset logic, and gives both consumers a consistent lifecycle. **Compatibility requirement:** the store must be inert when no consumers are registered — the existing `CockpitController` warm-start (single-point `start`) and the existing `CemSolver` (no persistence) continue to work unchanged. The store is opt-in: consumers register on construction; if no consumer registers, no store is allocated.

---

## 9. Step-by-step implementation plan

### Status legend
- [ ] not started · [x] done

**Step 1 — Soft CEM solver** [ ]
- Create `src/finance/optimization/solvers/cem-soft-solver.js`: subclass `CemSolver`, override refit with softmax-weighted mean/std.
- Register in `solver-registry.js` as `CEM_SOFT` with `temperature` option.
- Write `cem-soft-solver.test.mjs`: toy quadratic convergence, temperature limits, comparison with `CEM`.
- Write `cem-soft-multimodal.test.mjs`: two-mode 1D surface, diversity preservation.

**Step 2 — Adaptive penalty weights** [ ]
- Add `adaptiveLambda(state, ctx)` and adaptiveMu(result)` to `optimization-objectives.js`.
- Add `adaptiveEnabled` flag to `makeDieWithTarget` factory (default `false`).
- Wire adaptive weights into `evaluate` behind the flag.
- Write `objective-adaptive.test.mjs`: confirm fixed-weight backward compat, confirm adaptive behavior under deficit.
- Browser verification: run cockpit Advise with `DIE_WITH_TARGET` + `adaptiveEnabled: true`, confirm score surface looks reasonable.

**Step 3 — Cross-epoch memory bank** [ ]
- Create `src/finance/optimization/cross-epoch-store.js`: shared `CrossEpochStore` with bounded storage, pluggable eviction, regime-change reset hook, per-entry recency metadata. Inert when no consumers registered — no allocation unless opted in.
- Add `_memoryBank`, `_memorySize`, `_similarityFn`, `_crossEpochStore` to `CockpitController`. Register the memory bank as a consumer of the store on construction.
- Implement `extractStateVector(snapshot)` and `defaultStateSimilarity`.
- Implement `attentionWarmStart` utility.
- Wire memory accumulation into `advise()` post-solve (via store), warm-start pre-solve.
- Write `cross-epoch-store.test.mjs`: bounded storage, eviction, regime-change reset, inert-when-empty.
- Write `cross-epoch-memory.test.mjs`: 3-epoch simulation with regime shift.
- Write `cockpit-controller-memory.test.mjs`: integration test with `autoRun()`.
- **Compatibility:** confirm existing `CockpitController` without `_crossEpochStore` (default path) behaves identically to today — no store allocated, single-point warm-start unchanged.

**Step 4 — Browser verification** [ ]
- Run dev server; confirm `CEM_SOFT` solver appears in solver select.
- Confirm `CEM_SOFT` converges on the expense-band problem.
- Confirm cross-epoch memory populates across manual `advise` calls.
- Confirm `adaptiveEnabled: true` changes behavior under high-deficit scenario.

### Out of this plan (tracked elsewhere)
- Surrogate as a second `CrossEpochStore` consumer (design 46 Phase 4) — the store is ready; the surrogate registers when it lands.
- Multi-objective rebalancing (§8 Q3) — future design.
- Regime-aware similarity metric (§8 Q2) — future enhancement.
- Score-weighted / diversity-maximizing eviction (§8 Q4) — future enhancement.
