# 47 — Time-Varying FX Rates (regime-driven, seeded, snapshot-cheap)

**Status**: **Phases 1–2 implemented.** Phase 1 (substrate + all four process models off `sim.rng`, regime-decoupled) browser-verified by the author. Phase 2 (regime → FX drift via existing `fxAdjustment`, and multiplicative volatility coupling via new `regime.fxVolAdjustment`; GFC/COVID presets seed drift+vol, stagflation seeds vol-only) implemented. Phase 3 (chart per-point + FX metric) not started. Full unit suite green (3060) + production build clean.

> **Fixed after Phase 2 (anchor-lag bug):** `FxProcessReducer` originally recaptured the pristine anchor (`fxAnchorRates`) only on `US/AU_PERIOD_ADVANCE`. Those period advances are **annual** (US Jan 1, AU Jul 1 fiscal), but regimes decay **monthly** via `RECOMPUTE_REGIMES` recovery ticks — so regime FX drift lagged up to ~6 months into the composed rate and raced the shock on its start date (making two identical shocks look different). Fix: `FxProcessReducer` now also triggers on `ADD_REGIME_APPLY`/`REMOVE_REGIME_APPLY`/`RECOMPUTE_REGIMES` (where `RegimeApplyReducer` freshly rewrites the anchor at priority 11), recapturing `fxAnchorRates` each time. Regression-locked by `evt-fx-regime-vol.test.mjs` EVT-FXRV-5.
**Implements**: `design/10-display-settings-service.md` **Phase 6** ("Time-varying exchange rates — deferred, seam-ready"), which reserved this exact swap: *"Replace the static mirror in `FxRefreshReducer` with a rate-curve lookup … No display-layer change required."*
**Builds on**: `design/23-fx-exchange.md` (the `FxService` / `FxEngine` / `effectiveExchangeRates` substrate this varies), `design/21-financial-shock-and-regime-framework.md` (the regime stack + `RegimeApplyReducer` that will drive the FX drift/volatility), `design/28-time-varying-appreciation-and-bond-duration.md` (the sibling "time-varying rate" pattern — deterministic **schedules** there, stochastic **regime-noise** here; §3 of that doc explicitly names the split).
**Author note**: The point of this design is a stochastic-but-reproducible FX path that costs O(1) state (one scalar per pair, no path array) and rides the simulation's **already-repeatable seeded RNG** rather than inventing a parallel seed mechanism. The RNG audit in §4 is load-bearing — read it before touching the pipeline.

---

## 1. Problem

`state.effectiveExchangeRates.USD_AUD` is a single scalar written each period by `FxRefreshReducer` (mirror `base → effective`) and, when the regime toolset is loaded, overwritten by `RegimeApplyReducer` (`base + Σ fxAdjustment × recoveryFactor`). Absent a regime it is **flat for the entire run**. Every FX consumer already reads this one field:

- `UsdAudPair.rate(state, …)` — the transfer/conversion rate (design 23).
- `CurrencyConverter.convert(…, state)` — the display layer (design 10 Phase 4), which converts **at each snapshot's recorded rate**.
- `IntlRetirementMcRunner.computeNetWorthUsd` — MC net-worth aggregation.

So the plumbing to *consume* a time-varying rate already exists end-to-end — display, transfers, and MC all read `effectiveExchangeRates`. What's missing is a **generator** that moves it over time.

Requirements (from the design conversation):

1. **A state value for the pair rate, ingested by the system.** Already present: `effectiveExchangeRates.USD_AUD`. This design makes it move; it does not add a new read surface.
2. **No path array on state.** Storing every historical rate would grow the snapshot linearly and blow up `structuredClone` cost (snapshots are `structuredClone`d every ~12 events, `simulation-history.js`). The moving rate must cost **O(1)** state.
3. **Repeatable.** The same scenario + seed must reproduce the same FX path, including under snapshot rewind/replay.
4. **First driver = Economic Regime.** The initial way the rate varies is coupled to the regime stack (design 21): regimes push the rate directionally and/or make it choppier.
5. **Selectable, off by default.** The process model is a choosable strategy — one option being "do nothing, leave as a single value." Default off ⇒ every existing scenario is bit-for-bit unchanged.
6. **Variation only under control (MC).** FX must not silently vary run-to-run except through the same seed mechanism everything else uses; a user who wants FX pinned across MC runs, or deliberately varied, controls it the same way they control every other seeded quantity.

---

## 2. Goals & Non-Goals

### Goals

- Move `effectiveExchangeRates.USD_AUD` over the run as a **stochastic, mean-reverting-capable** path, computed from a **single stored deviation scalar** per pair — O(1) state, no array.
- Make the FX process a **selectable strategy** (`NONE` / `MEAN_REVERTING` / `RANDOM_WALK` / `WHITE_NOISE`), `NONE` by default.
- Drive drift and volatility from the **regime stack**: reuse `regime.fxAdjustment` for directional drift (already wired in `RegimeApplyReducer`), add `regime.fxVolAdjustment` for choppiness.
- Source randomness from the simulation's existing **seeded, snapshot-safe `sim.rng`** (see §4), consumed in a **handler** so reducers stay pure.
- Preserve **bit-for-bit determinism** vs. today when the model is `NONE` (no tick scheduled, no `rng` draw).

### Non-Goals (deferred)

- **Live / historical FX feed.** No network rates. Same non-goal as design 10 — display converts only what the sim recorded.
- **Currencies beyond USD/AUD.** The mechanism is pair-generic (keyed by pair id); only `USD_AUD` ships.
- **Correlating FX with equity/interest regimes analytically.** A regime can move FX *and* equity independently via its adjustment maps, but there is no cross-asset covariance model (same boundary design 21 §3 draws).
- **Per-concern independent RNG sub-streams.** FX shares the single `sim.rng` stream (§4.4 caveat). Giving each stochastic concern its own snapshot-tracked stream is a future refactor, explicitly out of scope per the design conversation ("don't fix an RNG problem that doesn't exist yet").
- **Deterministic FX schedules.** A known stepped rate path (analogous to design 28's `appreciationSchedule`) is a reasonable future `FX_SCHEDULE` model; not shipping now.

---

## 3. Model: anchor × stochastic deviation

The effective rate is composed from two independent pieces so the deterministic regime layer and the stochastic layer never clobber each other:

```
effectiveRate(t)  =  anchor(t)  ×  exp( deviation(t) )

anchor(t)     = baseExchangeRates[pair] + Σ regime.fxAdjustment[pair] × recoveryFactor     (deterministic; already computed by RegimeApplyReducer)
deviation(t)  = a mean-0 stochastic process in log-space, walked one step per FX tick        (the new piece — one stored scalar)
sigma(t)      = baseFxVol[pair] × Π (1 + regime.fxVolAdjustment[pair] × recoveryFactor)      (regime-modulated step volatility)
```

- **Multiplicative / log-space** keeps the rate strictly positive and makes "a 5% FX move" mean the same thing at any level.
- `anchor(t)` is exactly what `RegimeApplyReducer` already writes into `effectiveExchangeRates` today — this design treats that as the *anchor*, then multiplies by `exp(deviation)`.
- `deviation(t)` is the **only new state**: `state.fxDeviation = { USD_AUD: <number> }`. One scalar per pair. When the model is `NONE`, it stays `0` and `effectiveRate == anchor` (today's behavior).

### 3.1 Selectable process models

Each model is a pure step function `step(prevDeviation, sigma, dt, z) → nextDeviation`, where `z` is a standard-normal draw (§4.3):

| Model | `step` | Character |
|---|---|---|
| `NONE` (default) | returns `0` (tick not even scheduled) | Flat: `effectiveRate == anchor`. Bit-for-bit identical to today. |
| `MEAN_REVERTING` | `prev·e^(−k·dt) + sigma·√dt·z` (Ornstein-Uhlenbeck, long-run mean 0) | Wanders but is pulled back toward the anchor; bounded over decades. **Recommended default when varying.** |
| `RANDOM_WALK` | `prev + sigma·√dt·z` | Log-random-walk, no anchor pull; can drift far over a long horizon. |
| `WHITE_NOISE` | `sigma·z` (ignores `prev`) | Memoryless jitter around the anchor; jagged, no trends. |

`k` (reversion speed, `MEAN_REVERTING` only), `dt` (tick interval in years, e.g. `1/12`), and the model id are **compile-time constants** from scenario params — passed to the tick handler's constructor, not stored on state (they don't change over the run and aren't regime-modulated).

`sigma(t)` **is** stored (`baseFxVol` / `effectiveFxVol`) because the regime modulates it per period (§5).

### 3.2 Why a walking scalar and not a closed-form pure function

An OU/random-walk path's value at time `t` is a cumulative sum of independent draws — as a *stateless* pure function it would re-sum `t` draws on every evaluation. The simulation already gives us a cheaper, idiomatic tool: a seeded generator whose state is snapshotted. We draw **one** step per tick in a handler, store the running deviation (one scalar), and get O(1) evaluation with exact replay for free (§4). This is the same handler-generates / reducer-applies split design 21 uses for shocks.

---

## 4. The RNG — audit and contract (load-bearing)

The design conversation's key correction: **use the simulation's existing seeded RNG; it was built to be repeatable.** An audit of the current code confirms this is the right tool and that FX can adopt it with zero disruption.

### 4.1 What the audit found

- **`sim.rng` has no in-loop consumers today.** Nothing in `src/finance/{handlers,reducers,account-rules,economic-regimes,fx}` draws from `sim.rng`. It is created (`simulation.js:102`), its `rngState` is snapshotted (`simulation-history.js:34`) and restored (`:46`), but **no handler or reducer currently draws from it during a run.** FX will be the **first** in-loop consumer.
- **MC variation is a separate stream.** `IntlRetirementMcRunner._perturb` samples parameters with a *standalone* `makeSeededRng(i+1)` (`intl-retirement-mc-runner.js:214`), used **before** the sim runs to perturb params. It never touches `sim.rng`. → Adding FX draws to `sim.rng` **cannot perturb existing MC param sampling or any existing result.**
- **Per-run seeding already exists.** Batch/MC builds each sim with `seed: i + 1` (`scenario.js:50`). A normal single run defaults to `seed = 1` (`Simulation` constructor).
- **Handlers can reach it; reducers cannot.** The handler call context passes `sim` (`simulation.js:420` — `entry.call({ sim: this, date, data, meta, state })`). Reducers get only `reduce(state, action, date)` and must stay pure. → The random draw **must** live in a handler.

### 4.2 Replay safety (why this is repeatable under rewind)

`takeSnapshot()` stores `rngState` alongside `state`; `restoreSnapshot()` restores both together (`simulation-history.js`). On rewind to a snapshot, `rngState` resets to its value at that snapshot and `state.fxDeviation` resets with it. Replaying the same events in the same order redraws the identical `z` sequence and reproduces the identical walk. The `(fxDeviation, rngState)` pair is snapshotted as a unit, so the process is exactly reproducible across rewind/step/replay — the property design 42 depends on for lever-rollout fidelity.

### 4.3 Drawing a normal from `sim.rng`

`sim.rng()` returns uniform `[0,1)`. Reuse the Box-Muller construction already in `distributions.js` (`NormalDistribution.sample`) to turn two uniforms into a standard normal `z`:

```js
function gaussianFrom(rng) {
  const u1 = Math.max(rng(), 1e-10);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
```

(Factor this into a shared helper so the FX handler and `NormalDistribution` share one implementation.)

### 4.4 MC behavior and the one documented caveat

- **Single run (seed 1):** `sim.rng` yields the same sequence every time ⇒ **identical FX path on every re-run.** Deterministic, as required.
- **MC (seed i+1):** each run's `sim.rng` differs ⇒ **FX path differs per run**, automatically, via the *same* seed mechanism MC already uses for params. The design conversation accepted this: FX varies per run only through the seed, i.e. "under control." To **pin** FX across MC runs, pin the model to `NONE` (or the scenario seed); to **deliberately** vary the drift/vol channel, put a regime param (start date / severity) under MC variation.
- **Default off ⇒ no draw.** When `fxProcessModel === 'NONE'`, the FX tick is **not scheduled** (§6), so `sim.rng` is never advanced and `rngState` is untouched. Existing scenarios remain bit-for-bit identical.
- **Caveat (documented, not fixed):** FX shares the single `sim.rng` stream. If a *future* feature also draws in-loop, the two interleave and FX paths shift relative to today. Acceptable now — FX is the only in-loop consumer. A per-concern sub-stream (seed derived from `sim.seed`, its cursor snapshotted on state) is the future fix if/when a second consumer lands.

---

## 5. Data-model changes

### 5.1 New state fields (`InternationalRetirementFinancialState`)

```js
// ── FX stochastic layer (NEW) ──────────────────────────────────────────
this.fxDeviation   = {};                    // { [pairId]: number } log-space deviation, mean 0. O(1) per pair.
this.baseFxVol     = {};                    // { [pairId]: number } base per-step volatility (from param), 0 when model NONE
this.effectiveFxVol = { ...this.baseFxVol };// regime-modulated volatility; written by RegimeApplyReducer
this.fxAnchorRates = { ...this.baseExchangeRates }; // pristine anchor (base + regime drift) captured each
                                            // period advance, so FxProcessReducer can recompose idempotently
                                            // on a mid-period FX_STEP_APPLY without double-applying exp(dev).
```

All three are small scalar maps (one entry per registered pair). No arrays; snapshot cost is constant.

`baseExchangeRates` / `effectiveExchangeRates` / `baseFxFees` / `effectiveFxFees` already exist (design 23) and are unchanged in shape — `effectiveExchangeRates` simply becomes time-varying.

### 5.2 `FxService.getContributions` seeds the new fields

Extend the `statePatches` block (`fx-service.js:94`) to seed `baseFxVol` / `effectiveFxVol` from a new `fxVolatility` param and initialise `fxDeviation` to 0:

```js
const baseVol = {};
for (const pair of pairs) {
  const pairId = pair.constructor.id;
  if (pairId === 'USD_AUD') {
    baseVol[pairId] = (parameters?.fxProcessModel && parameters.fxProcessModel !== 'NONE')
      ? (parameters?.fxVolatility ?? 0.06) : 0;
  }
}
const statePatches = {
  baseExchangeRates, baseFxFees,
  effectiveExchangeRates: { ...baseRates },
  effectiveFxFees:        { ...baseFees },
  baseFxVol:      baseVol,
  effectiveFxVol: { ...baseVol },
  fxDeviation:    Object.fromEntries(pairs.map(p => [p.constructor.id, 0])),
};
```

The FX **process config** (`fxProcessModel`, `fxReversionSpeed`, `fxSeed`-not-needed, `dt`) rides on the tick handler's constructor (§6), not state.

### 5.3 New regime field: `fxVolAdjustment`

`EconomicRegime` gains an optional `fxVolAdjustment: { [pairId]: number }` map (parallel to the existing `fxAdjustment`). A crisis regime that "just makes FX choppier" sets `fxVolAdjustment` and leaves `fxAdjustment` null; a directional regime sets `fxAdjustment`; a full crisis sets both. Round-tripped by the shock serializer exactly like `fxAdjustment` / `dividendAdjustment` (design 28 §7 precedent).

### 5.4 `StateSchemaRegistry` registrations (workbench formatting)

| Path | Type |
|---|---|
| `fxDeviation.*` | `ValueType.number()` (unitless log-deviation) |
| `baseFxVol.*` | `ValueType.number()` |
| `effectiveFxVol.*` | `ValueType.number()` |

Registered where the other FX fields are (design 23 §4.4, in `US_AU_CROSS_BORDER.state`). `effectiveExchangeRates.*` is already registered.

---

## 6. Pipeline: events / handler / actions / reducers

The generator is one pre-scheduled tick + one handler (draws the step) + two pure reducers (apply the step, compose the rate). Ordering is the crux — the stochastic layer must compose **after** the regime layer has written the anchor.

### 6.1 Events

| Event | Kind | Purpose |
|---|---|---|
| `FX_TICK` | `EventSeries` | Periodic (default monthly) FX step. **Pre-scheduled at toolset compile time** in `US_AU_CROSS_BORDER.schedules()`, anchored at scenario start over the full horizon — same declarative pattern as `ECONOMIC_RECOVERY_TICK` (design 21) and `PERIOD_ADVANCE`. **Scheduled only when `fxProcessModel !== 'NONE'`** so default scenarios draw no randomness. |

### 6.2 Handler

| Handler | Event | Emits |
|---|---|---|
| `FxTickHandler` | `FX_TICK` | One `FX_STEP_APPLY { pair, deviation }` per registered pair. **This is the only place `sim.rng` is drawn.** |

```js
class FxTickHandler extends HandlerEntry {
  static type = 'FxTickHandler';
  static eventType = 'FX_TICK';
  constructor({ model = 'MEAN_REVERTING', reversionSpeed = 0.5, dt = 1/12, pairs = ['USD_AUD'] } = {}) {
    super(null, 'FX Tick');
    this.model = model; this.k = reversionSpeed; this.dt = dt; this.pairs = pairs;
  }
  call({ sim, state }) {
    const stepFn = FX_PROCESS_MODELS[this.model];           // pure step function (§3.1)
    return this.pairs.map((pair) => {
      const prev  = state.fxDeviation?.[pair] ?? 0;
      const sigma = state.effectiveFxVol?.[pair] ?? 0;
      const z     = gaussianFrom(sim.rng);                  // ← the seeded, snapshot-safe draw
      const next  = stepFn(prev, sigma, this.dt, this.k, z);
      return { type: 'FX_STEP_APPLY', pair, deviation: next };
    });
  }
}
```

### 6.3 Actions

| Action | Fields | Consumed by |
|---|---|---|
| `FX_STEP_APPLY` | `pair: string, deviation: number` | `FxStepApplyReducer` — pure write of `state.fxDeviation[pair]`. No `rng`, no math. |

Registered in `US_AU_CROSS_BORDER.types.actions` with `fields: { pair: ValueType.text(), deviation: ValueType.number() }` so the action-detail panel renders it.

### 6.4 Reducers and priorities

| Reducer | Priority | Trigger | Responsibility |
|---|---|---|---|
| `FxRefreshReducer` (existing, unchanged) | `PRE_PROCESS (10)` | `US/AU_PERIOD_ADVANCE` | Mirror `base → effective` for rates/fees/**vol** (adds `baseFxVol → effectiveFxVol`). Fallback when no regime. |
| `RegimeApplyReducer` (existing, +1 line) | `PRE_PROCESS + 1 (11)` | period advance + regime mutations | Already sums `fxAdjustment` into `effectiveExchangeRates` (the anchor). **Add:** compose `effectiveFxVol[pair] = baseFxVol[pair] × Π(1 + fxVolAdjustment[pair] × factor)`. |
| **`FxProcessReducer` (NEW)** | `PRE_PROCESS + 2 (12)` | `US/AU_PERIOD_ADVANCE`, `FX_STEP_APPLY` | Compose the final rate: `effectiveExchangeRates[pair] = anchor[pair] × exp(fxDeviation[pair])`, reading the anchor that RegimeApplyReducer (or FxRefreshReducer) just wrote. Pure. |
| `FxStepApplyReducer` (NEW) | `CASH_FLOW (20)` | `FX_STEP_APPLY` | `state.fxDeviation[pair] = action.deviation`. Pure. |

**Why `FxProcessReducer` at `PRE_PROCESS + 2`:** it must read the anchor **after** `RegimeApplyReducer` (11) has written regime drift into `effectiveExchangeRates`, and before the period's earnings/transfer handlers read the rate — the same slot and reasoning as design 28's `BondPriceAdjustReducer`. It also runs on `FX_STEP_APPLY` so a mid-period tick re-composes immediately.

**Ordering within a month:** `FX_TICK` (draws + walks `fxDeviation`) and `PERIOD_ADVANCE` (recomputes anchor, re-composes) both fire; because `fxDeviation` persists on state, `FxProcessReducer` always composes with the latest walked deviation regardless of intra-month event order. The event-queue comparator (design 34 §13) orders same-date events by `order`; give `FX_TICK` an `order` that sequences it deterministically relative to period advance (recommend firing the tick *before* the period advance so the period reads the freshly-walked deviation).

### 6.5 Diagram

```
FX_TICK (monthly, only if model≠NONE)
  └─ FxTickHandler.call({sim})           ← draws z = gaussianFrom(sim.rng)   [ONLY rng consumer]
       └─ FX_STEP_APPLY {pair, deviation}
            └─ FxStepApplyReducer (20)     state.fxDeviation[pair] = deviation

US/AU_PERIOD_ADVANCE
  ├─ FxRefreshReducer      (10)  base→effective (rate, fee, vol)
  ├─ RegimeApplyReducer    (11)  effectiveExchangeRates += Σ fxAdjustment·f   (anchor)
  │                              effectiveFxVol         = baseFxVol · Π(1+fxVolAdjustment·f)
  └─ FxProcessReducer      (12)  effectiveExchangeRates[pair] = anchor · exp(fxDeviation[pair])
                                  ↑ everyone downstream (transfers, display, MC) reads this
```

---

## 7. Toolset wiring (`US_AU_CROSS_BORDER`)

The FX process rides the existing cross-border toolset (design 23), so it is available exactly when the `USD_AUD` pair is. Add via `FxService.getContributions` so the service stays the one owner:

- **`paramSchema`** — new params in the `FX` group:
  - `fxProcessModel` — `Select` of `NONE | MEAN_REVERTING | RANDOM_WALK | WHITE_NOISE`, default `NONE`.
  - `fxVolatility` — `Number`, default `0.06` (annualized log-vol), `mc: true` (a user *can* sweep it).
  - `fxReversionSpeed` — `Number`, default `0.5` (per year), shown only for `MEAN_REVERTING`.
- **`schedules`** — when `fxProcessModel !== 'NONE'`, append the `FX_TICK` `EventSeries` (monthly, full horizon) returned from `getContributions(...).events`.
- **`handlers`** — `getContributions` returns `FxTickHandler` (constructed with the model/k/dt) **only** when the model ≠ `NONE`.
- **`reducers`** — `getContributions` always returns `FxProcessReducer` + `FxStepApplyReducer` (harmless no-ops when `fxDeviation` stays 0), plus the existing `FxRefreshReducer` / `FxTransferApplyReducer`.

`getContributions` gains the process config from `parameters` and threads it into the handler; the service already receives `parameters` (`fx-service.js:80`).

---

## 8. Display / chart follow-up (design 10 Phase 6 close-out)

Design 10 Phase 4 converts every money surface at the snapshot's recorded `effectiveExchangeRates`, so a **varying** rate needs **no converter change** — each snapshot already carries its own rate. Two loose ends design 10 explicitly deferred to "Phase 6" become real once the rate moves:

1. **Chart per-point conversion.** `chart-view._displaySeriesData()` currently converts a whole series at the *single current* rate (design 10 Phase 4 note: "Per-point historical rates are a Phase 6 swap"). Zip each value point with the `effectiveExchangeRates.<pair>` value **as of that point** so a series converts at its historical rate. Requires the rate to be charted per-point — see (2).
2. **Record the rate as a metric each period** so it is itself chartable and available per-point: emit `RecordMetricAction('fx_rate_USD_AUD', effectiveRate)` (or a `RECORD_BALANCE`-style capture) from `FxProcessReducer`, typed `ValueType.number()`. This gives the chart both an FX line series and the per-point conversion key.

Both are display-only and can land in a follow-up phase; the sim-side rate is correct without them.

---

## 9. Interaction with existing designs

- **Design 23 (FxService):** unchanged ownership. `effectiveExchangeRates` stays the single read path; this design adds a producer (`FxProcessReducer`) downstream of the regime producer. `UsdAudPair.rate()` needs no change — it already reads `effectiveExchangeRates[id]`.
- **Design 21 (regimes):** `RegimeApplyReducer` gains one composition (`effectiveFxVol`) and `EconomicRegime` gains `fxVolAdjustment`. The existing `fxAdjustment` drift is untouched and becomes the *anchor* drift the deviation multiplies around.
- **Design 10 (currency display):** this **is** its Phase 6. Closes the deferred chart per-point swap (§8).
- **Design 28 (time-varying appreciation):** complementary. That design does deterministic **schedules** ("known to step rather than be regime-noise"); this does the **regime-noise** side for FX. A future `FX_SCHEDULE` model (§2 non-goal) would reuse design 28's schedule-lookup shape.
- **Design 42 (snapshot/rollout fidelity):** relies on `(state, rngState)` snapshotting together — §4.2 preserves that invariant, so lever rollouts over a stochastic-FX scenario stay faithful.

---

## 10. Phased implementation

### Phase 1 — Substrate + `NONE`/`WHITE_NOISE`/`RANDOM_WALK`, regime-decoupled

Smallest shippable slice: the process runs off `sim.rng` with a flat (non-regime) volatility, proving the O(1)-state + repeatability contract before wiring regime coupling.

1. Add `state.fxDeviation` / `baseFxVol` / `effectiveFxVol` to `InternationalRetirementFinancialState`; seed in `FxService.getContributions`.
2. Add `FX_PROCESS_MODELS` step functions (`NONE`, `WHITE_NOISE`, `RANDOM_WALK`, `MEAN_REVERTING`) + the shared `gaussianFrom` helper (factor out of `NormalDistribution`).
3. Add `FxTickHandler` (draws `sim.rng`), `FX_STEP_APPLY` action, `FxStepApplyReducer`, `FxProcessReducer`.
4. Extend `FxRefreshReducer` to mirror `baseFxVol → effectiveFxVol`.
5. Wire `US_AU_CROSS_BORDER`: params (`fxProcessModel`, `fxVolatility`, `fxReversionSpeed`), conditional `FX_TICK` schedule, conditional handler, always-on reducers.
6. `StateSchemaRegistry` registrations (§5.4).
7. Tests (§11): default-off determinism, repeatability under seed, snapshot-rewind reproduction, O(1)-state assertion.

**Exit criteria:** with `fxProcessModel: 'NONE'` a scenario is byte-identical to today (no `rng` advance). With `'MEAN_REVERTING'` + seed 1, `effectiveExchangeRates.USD_AUD` moves each period, is identical across re-runs, and is reproduced exactly after a snapshot rewind+replay. Snapshot size does not grow with run length.

### Phase 2 — Regime coupling ✅ IMPLEMENTED

1. ✅ Added `fxVolAdjustment` to the regime object (`economic-shock-handler.js`); rides the same `...shock`/`ADD_REGIME_APPLY(regime: any)` round-trip as `fxAdjustment`/`dividendAdjustment`.
2. ✅ `RegimeApplyReducer` composes `effectiveFxVol` from `baseFxVol` **multiplicatively**: `baseFxVol × Π(1 + fxVolAdjustment × recoveryFactor)` (new `_mulScaled` helper; a zero base stays zero, so vol coupling is inert when no FX process is active).
3. ✅ Anchor drift confirmed: `RegimeApplyReducer` writes `base + Σ fxAdjustment × factor` into `effectiveExchangeRates` at PRE_PROCESS+1; `FxProcessReducer` captures it as `fxAnchorRates` and composes `anchor × exp(dev)` at +2.
4. ✅ Presets: `MARKET_CRASH_2008_LITE` / `COVID_2020_LITE` seed risk-off `fxAdjustment` (AUD depreciation) + `fxVolAdjustment`; `STAGFLATION_1970S_LITE` seeds `fxVolAdjustment` only (vol-only example).
5. ✅ Tests: `evt-fx-regime-vol.test.mjs` (multiplicative amplification; vol-only leaves anchor at base; V-recovery decays vol to baseline; full-crisis drifts anchor + raises vol). Existing `evt-shock-fx-regime.test.mjs` continues to lock the drift path.

**Exit criteria met:** a crisis regime simultaneously moves the anchor and roughens the path; recovery returns both anchor and volatility to baseline along the regime's recovery curve.

### Phase 3 — Display close-out (design 10 Phase 6)

1. `FxProcessReducer` records `fx_rate_USD_AUD` metric per period.
2. Chart per-point conversion using the recorded rate series; FX line series available in the chart.

**Exit criteria:** switching display currency converts each chart point at its own historical rate; the FX rate is itself chartable.

---

## 11. Testing

EVT-X files under `tests/unit/`, following `evt-fx-transfer-*.test.mjs` / `evt-economic-shock.test.mjs` journal-assertion patterns:

| File | Coverage |
|---|---|
| `evt-fx-process-off.test.mjs` | `fxProcessModel: 'NONE'` ⇒ no `FX_TICK` scheduled, `rngState` never advances, `effectiveExchangeRates` flat == base. Bit-for-bit vs. a no-FX-process run. |
| `evt-fx-process-repeatable.test.mjs` | Two runs, same seed ⇒ identical `effectiveExchangeRates` path. Different seed ⇒ different path. |
| `evt-fx-process-rewind.test.mjs` | Run to mid-horizon, snapshot, rewind, replay ⇒ identical `fxDeviation` + rate sequence (the §4.2 invariant). |
| `evt-fx-process-state-size.test.mjs` | Snapshot `structuredClone` size independent of run length (guards the "no array" requirement). |
| `evt-fx-process-models.test.mjs` | `WHITE_NOISE` memoryless; `RANDOM_WALK` accumulates; `MEAN_REVERTING` pulls a displaced deviation back toward 0. |
| `evt-fx-regime-drift.test.mjs` | Regime `fxAdjustment` shifts the anchor; path tracks it (Phase 2). |
| `evt-fx-regime-vol.test.mjs` | Regime `fxVolAdjustment` raises step volatility with no directional drift (Phase 2). |
| `evt-fx-mc-controlled.test.mjs` | MC over `n` runs: FX varies per run via seed; pinning model to `NONE` (or fixing seed) pins the path (requirement §1.6). |

---

## 12. Open decisions

1. **Tick cadence.** Monthly `FX_TICK` (recommended, matches period cadence) vs. annual. Monthly gives a smoother path and more `rng` draws; annual is cheaper. `dt` scales the step either way. → **Recommend monthly.**
2. **Volatility units.** `fxVolatility` as an **annualized** log-vol scaled by `√dt` per step (standard, recommended) vs. a raw per-step number. → **Recommend annualized.**
3. **`WHITE_NOISE` storing state.** It ignores `prev`, so `fxDeviation` is technically unnecessary for it — but keeping the field uniform across models avoids branching in `FxProcessReducer`. → **Keep uniform.**
4. **Default `fxVolatility` / `fxReversionSpeed`.** `0.06` / `0.5` are placeholders; calibrate against a plausible AUD/USD annual range before Phase 2 ships.
5. **Anchor for `MEAN_REVERTING`.** Deviation mean-reverts to **0** (i.e. the rate reverts to the current *anchor*, which itself drifts with regimes). Alternative: revert to the *base* rate ignoring regime drift. → **Recommend revert-to-anchor** so regime drift genuinely relocates the long-run level.
