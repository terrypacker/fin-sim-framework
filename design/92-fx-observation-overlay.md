# 92 — The FX observation overlay: driving the simulation from a published rate feed

**Status** (2026-08-18): **STEPS 1–2 BUILT.** §14's decisions are locked (see §14). The
packaged series and the calibration tool exist and are tested; the overlay modes (§3, §4,
steps 3–7) are **not built** and are deliberately deferred until the calibrated
`MEAN_REVERTING` has been used in anger. `HISTORICAL_SAMPLED` is **cut** — see §14 Q4.

This is design 87 §13.6 **step 2** ("published FX overlay") promoted out of sketch
altitude into a specification, plus the extrapolation question 87 §13 deliberately left
alone.

Design 87 closed everything except §13, the observed-data overlay. Its own conclusion was
that FX is the cheapest possible first overlay, because `effectiveExchangeRates.USD_AUD`
is already a single choke point every consumer reads and `rates/DEXUSAL-daily.csv` is
already a pinned published series with a documented carry-forward rule. This document
takes that claim seriously and works out what actually has to change.

**Scope.** One new family of values on the existing `fxProcessModel` parameter, the data
packaging that makes a published series readable from the browser bundle as well as from
node, and the calibration tooling that lets the *existing* stochastic models be
parameterised from history rather than from a guess.

**Out of scope, named so they are not assumed in:**

- Seeding opening `fxBasisRate` / lot ledgers from the §988 ingest tool — that is 87
  §13.6 **step 1**, a sibling, and independent of everything here.
- The backtest — 87 §13.6 **step 3**. It *consumes* this document's output and is the
  deliverable that justifies it, but it is a separate build.
- Any endogenous overlay (wages, spending, transfers) — 87 §13.6 step 4, and 87 §13.2
  explains why it is last.
- Any currency pair other than USD/AUD. The machinery is per-pair from the start; only
  one pair has a packaged series.

> **Naming.** 87 §13 flagged the collision with [[design-81-run-as-replayable-artifact]],
> which already uses *replay* for re-running a simulation's own recorded output. This
> codebase has been bitten by a duplicated name before
> ([[design-60-collision-renumbered-79]]). The split adopted here: **playback** is design
> 81 (a run replaying itself), **observation overlay** is this (external data substituted
> for what the model would have generated). Inside the overlay, *replay* is fine as the
> name of one specific mapping mode, because there it is unambiguous.

---

## 1. Two rate sources, two altitudes, one file

There are already two FX "rates" in this repo and they must never be swapped
(`rates/README.md` says so in bold, and 87 §12 explains why):

| | `rates/DEXUSAL-daily.csv` | `state.effectiveExchangeRates.USD_AUD` |
|---|---|---|
| what it is | H.10 published observations, daily | a simulated path the engine composes |
| direction | **USD per AUD** (~0.70) | **AUD per USD** (~1.42) |
| used by | `scripts/tax/section988-*` — anything reconciling to a filed return | every in-engine consumer |
| gaps | holidays carry forward; post-last-observation resolves to `null` | never has a gap |
| revises? | yes — FRED restates history | no |

This document does **not** merge them. It adds a third thing: a **packaged monthly
series, derived from the daily file by a committed generator**, that the engine can read.
The daily file stays the source of truth for tax reconciliation, and the derived monthly
file is the source of truth for the engine.

**Why monthly, not daily.** The engine's FX tick is monthly (`FX_TICK_DT = 1/12`), so a
daily series would be downsampled at read time anyway — and doing it at read time means
the downsampling rule lives in the engine where it cannot be reviewed against
`rates/README.md`. Doing it in a generator makes the rule a diffable artifact. Size is a
secondary argument but a real one: ~660 monthly rows against ~14,500 daily.

**The downsample rule is the existing carry-forward rule, not an average.** For month
*m*, take the most recent published observation at or before the last calendar day of
*m* — exactly `FxRateTable.resolve()`'s convention, reused rather than reinvented. A
monthly *average* would be a second convention, and `§1.988-1(d)(2)` wants one source
consistently applied. (Averages are also specifically unavailable to a household pool —
`§1.988-1(d)(3)`'s convention relief is confined to trade payables and receivables. That
argument binds the tax path, not the projection path, but there is no reason to hold two
conventions when one will do.)

**The generator inverts once.** `DEXUSAL` is USD per AUD; the engine's `USD_AUD` is AUD
per USD. The generated module exports `audPerUsd` and nothing else, so no consumer is
ever in a position to guess. Silently swapping these inverts every gain and no test of a
zero case would notice — the reason `scripts/lib/fx-rates.mjs` already states its
direction in every function name.

---

## 2. The seam: attach to the deviation, not to the rate

The engine composes the effective rate in one place, `FxProcessReducer`:

```text
effectiveExchangeRates[pair] = fxAnchorRates[pair] × exp(fxDeviation[pair])
```

where the anchor is `exchangeRateUsdToAud` plus regime FX drift, recaptured on every
period advance and regime recompute. `FxTickHandler` walks `fxDeviation` one step per
month using a pure step function from `FX_PROCESS_MODELS`, drawing `z` from `sim.rng`,
and emits `FX_STEP_APPLY` for a pure reducer to store.

**The overlay attaches by writing `fxDeviation`, not by writing
`effectiveExchangeRates`.** This is the single most load-bearing decision in the
document, and it buys four things at once:

1. No new reducer, no new state field, no second composition path. `FxProcessReducer`,
   `FxStepApplyReducer` and `FxRefreshReducer` are untouched.
2. The overlay is automatically snapshot- and serialization-safe, because
   `fxDeviation[pair]` already is.
3. Absence changes nothing (87 §13.1): with no overlay configured, `fxDeviation` stays 0,
   `exp(0) === 1`, and the run is bit-identical to today.
4. Every existing consumer — `to-base-currency.js`, the §988 pool observer, the transfer
   handler, the reports — reads the overlaid rate without knowing an overlay exists.

Writing `effectiveExchangeRates` directly would fork the composition, and the fork would
be silently overwritten on the next period advance by `FxRefreshReducer`. That is not a
hypothetical: it is what the `fxAnchorRates` recapture in `FxProcessReducer` exists to
prevent.

### 2.1 The step-function signature is *almost* right

`FX_PROCESS_MODELS` entries are `step(prev, { sigma, dt, k, z }) → next`. A series-driven
step needs to know *when* it is, which the context does not carry. Extend the context
with `{ date, tick, anchor }`; every existing model ignores the new fields and is
bit-for-bit unchanged. Keeping the new modes inside `FX_PROCESS_MODELS` matters because
`FX_PROCESS_MODEL_IDS = Object.keys(FX_PROCESS_MODELS)` is what the param schema
enumerates — one registration, and the workbench dropdown, validation and serialization
all follow. (This is the registration gotcha [[design-67-bond-yield-curve]] paid for.)

`tick` is the integer count of FX ticks since simulation start. Derive it from
`ctx.date` rather than counting in the handler: handlers are serialized and restored, and
a counter on the handler is a second piece of state that `fxDeviation` does not need.

### 2.2 The series must not be serialized into the handler

`FxTickHandler.toJSON()` writes its whole configuration. A packaged series must be
referenced by **id** (`series: 'USD_AUD.H10.monthly'`), resolved at `call()` time from a
module-level registry, never embedded. 660 floats in every snapshot would bloat the
journal and — worse — a restored handler would carry a *stale copy* of a file that
revises (§7). The id is the reproducibility anchor; the data is looked up.

---

## 3. The main decision: mapping simulation time onto historical time

This is the question the whole feature turns on. Four modes, and they are genuinely
different things rather than variations:

| mode | mapping | deterministic? | what it is for |
|---|---|---|---|
| `HISTORICAL_REPLAY` | sim month *i* → series month `start + i` | yes | "what if the next 30 years look like 1985–2015?" |
| `HISTORICAL_LOOP` | sim month *i* → series month `start + (i mod N)` over a window of N | yes | a horizon longer than the window, without inventing data |
| ~~`HISTORICAL_SAMPLED`~~ | as `HISTORICAL_REPLAY`, but the start offset is drawn per MC iteration | no | **CUT — §14 Q4.** Too few independent paths at a retirement horizon |
| `HISTORICAL_BOOTSTRAP` | resample blocks of historical monthly log-returns | no | historical *character* (fat tails, vol clustering) on an unlimited horizon |

`HISTORICAL_SAMPLED` looked like the cheap bridge between replay and bootstrap — it is
`HISTORICAL_REPLAY` with `fxReplayStart` drawn instead of authored, producing genuinely
observed paths with no resampling artifacts. **It was cut once the count was actually
computed** (§14 Q4): the post-float window yields 91 distinct starts at a 35-year horizon
and adjacent starts share 419 of 420 months, so the effective number of independent paths
is ~1. It would look like a working MC axis and report near-zero dispersion.

### 3.1 `HISTORICAL_LOOP` and the seam

Looping a window creates a discontinuity where the end of the window meets its start.
The fix falls out of §4: **index the increments, not the levels, and take the index
modulo N−1 so the seam increment is never crossed.** The path then repeats the window's
*shape* forever without a cliff. In level anchoring (§4) there is no such fix — the level
genuinely jumps — which is why looping is permitted only in returns anchoring.

Note what looping means economically: it repeats the window's realised drift once per
cycle. A 20-year window that saw the AUD fall 30% becomes a model in which the AUD falls
30% every 20 years, forever. See §5.

---

## 4. The second decision, which is easy to miss: level vs returns

Given a mapped historical observation, there are two ways to turn it into a deviation:

**`LEVEL`** — the effective rate *is* the observed rate:

```text
fxDeviation[pair] = ln( observed(t) / fxAnchorRates[pair] )
```

**`RETURNS`** — the observed *path shape* is applied to the scenario's own anchor:

```text
fxDeviation[pair] += ln( observed(t) / observed(t−1) )
```

They are not close to equivalent, and the difference shows up on the first tick.

- `LEVEL` **cancels the anchor**, by construction. `exchangeRateUsdToAud` becomes inert,
  and so does any regime `fxAdjustment` drift — the regime's FX lever silently stops
  working. It also produces a **step discontinuity at simulation start** whenever the
  authored anchor differs from the mapped observation, which it generally will. That
  discontinuity is exactly the historical/projection boundary failure 87 §13.4 warns
  about, arriving on tick one.
- `RETURNS` **preserves the anchor and the regime lever**, and is continuous at
  simulation start by construction. It is also, structurally, `RANDOM_WALK` with the
  increments read from a file instead of drawn from the RNG — which means it drops into
  the existing step signature with no special-casing at all.

**Recommendation: `RETURNS` is the default, and the only mode permitted with
`HISTORICAL_LOOP`.** `LEVEL` stays available because the backtest (87 §13.6 step 3) wants
it: when you are checking the model against a known window, you want the actual rates,
not a shape grafted onto an authored anchor. Make the backtest opt into the
discontinuity, rather than making every projection eat it.

`LEVEL` needs one guard: assert at tick zero that the mapped observation and the authored
anchor are within a stated tolerance, and fail loudly otherwise. A silent 10% level jump
at simulation start would move every cross-border figure and look like a modelling result.

---

## 5. Replay is a directional bet, not a neutral randomisation

The finding most likely to be discovered late and painfully.

`DEXUSAL` starts at roughly 1.11 USD per AUD in January 1971 and ends near 0.70 in July
2026 — the AUD lost about a third of its USD value over the series, a drift on the order
of −0.8%/yr sustained for 55 years. Any window inherits its own realised drift, and:

- `HISTORICAL_REPLAY` / `HISTORICAL_LOOP` in `RETURNS` mode express the window's drift in
  full, once per pass.
- `HISTORICAL_BOOTSTRAP` inherits the **sample mean** of the window's log-returns unless
  it is explicitly demeaned.
- Only `LEVEL` replay over a window that returns to its starting level is drift-free, and
  that is a coincidence rather than a property.

For a US/AU cross-border retirement model this is first-order, not a detail. The FX drift
sits directly on top of the AU-versus-US inflation differential
([[au-inflation-differential-pinned-fx]]), which is already known to move real spending
substantially over a long horizon. Selecting a replay window is therefore **choosing a
currency view**, and the UI and any study report have to say so — an arm labelled
"historical FX" reads as neutral and is not.

Two consequences for the parameter set:

1. `fxBootstrapDemean` (default **on**) — resample the *shape* without importing the
   window's mean drift, leaving drift to be authored explicitly through the anchor and
   the regime lever, where it is visible.
2. Whatever window is chosen, its annualised drift is **computed and surfaced** at
   configuration time, not left for a reader to infer. A number on the screen is the only
   thing that reliably stops "historical" from being read as "assumption-free".

**Related: the 1983 float.** The AUD was pegged and then managed before December 1983;
pre-float returns are not draws from the same process. The default calibration and
bootstrap window should start **1984-01**, with earlier data available but not the
default. A window spanning the float mixes two regimes and will produce a volatility
estimate that describes neither.

---

## 6. RNG discipline, and the MC trap

### 6.1 Consume and discard

87 §13.4 states it and it is the subtlest thing here: `sim.rng` is shared by every
stochastic consumer ([[rng-shared-by-all-stochastic-consumers]]). If a deterministic
overlay stops FX from *drawing*, every downstream draw in the run shifts, and the overlay
arm is no longer comparable with its stochastic control — the difference between the arms
is contaminated by re-sequencing rather than caused by the data.

So: **`HISTORICAL_REPLAY` and `HISTORICAL_LOOP` still call `gaussianFrom(sim.rng)` and
throw the value away.** Two uniforms per tick per pair, exactly as `MEAN_REVERTING`
consumes, so the draw ledger is identical.

This does not make the overlay comparable to `NONE`, and cannot: `NONE` schedules no
`FX_TICK` series at all and therefore draws nothing. That asymmetry already exists today
between `NONE` and `MEAN_REVERTING`, and the right response is a test that pins the
draw count per model rather than an attempt to paper over it.

`HISTORICAL_BOOTSTRAP` draws in-loop by design. Budget a **fixed two uniforms per tick**
and discard the unused one, rather than the "one uniform per block boundary" this document
first proposed: a variable draw count per tick desynchronises the ledger between seeds,
which is the very contamination §6.1 exists to prevent.

### 6.2 A deterministic overlay collapses the FX dimension in Monte Carlo

Run `HISTORICAL_REPLAY` under MC and every iteration gets the *same* FX path. The output
will show FX contributing zero dispersion, which is true of the arm and false of the
world, and it is precisely the failure mode of an inert parameter that looks live
([[mpc-lever-tests-scenario-shaped]], [[dead-spouse-growth-params]]).

Two defences, both cheap:

- The MC runner **warns** when a deterministic FX mode is active with more than one
  iteration, naming `HISTORICAL_BOOTSTRAP` as the alternative.
- `fxVolatility` and `fxReversionSpeed` are gated `visibleWhen` a stochastic model is
  selected ([[visiblewhen-composable-dsl]]), and are refused as MC/optimizer axes under
  replay modes. `fxVolatility` is currently `mc: true`; sampling it under replay would be
  a silently inert axis, which the harness has been burned by before.

---

## 7. Packaging the series into the app

The engine runs in the browser (workbench) and in node (tests, MC, scripts).
`scripts/lib/fx-rates.mjs` uses `node:fs` and cannot be imported by the bundle, so the
packaged series is a **generated ES module** under `src/finance/fx/data/`.

```text
scripts/dev/build-fx-series.mjs        # generator, committed
  reads   rates/DEXUSAL-daily.csv      # via scripts/lib/fx-rates.mjs — one resolver
  writes  src/finance/fx/data/usd-aud-h10-monthly.js
```

The generated module exports, alongside the data:

| field | why it is not optional |
|---|---|
| `id` | `'USD_AUD.H10.monthly'` — what the handler serializes (§2.2) |
| `direction` | `'audPerUsd'` — stated, not implied |
| `firstMonth` / `lastMonth` | the coverage window, which every mode must consult |
| `retrievedAt` | the daily file's retrieval date, carried through |
| `sourceSha256` | hash of the daily CSV the module was generated from |

**Reproducibility.** 87 §13.4: real data revises, and FRED restates recent observations.
Once a run's output is a function of a file that changes underneath it, the one property
[[sim-is-bit-deterministic]] guarantees is gone unless the version is pinned in the
output. So: a run using an overlay stamps `{ id, sourceSha256, retrievedAt }` into its
result metadata, and a test asserts the generated module is in sync with the CSV on disk
(regenerate-and-diff, the same shape as the existing `--check` mode of
`fetch-fx-rates.mjs`). Generated files that drift from their source are a known failure
here ([[build-index-reexport-duplicate]]).

Both the CSV and the generated module are committed. Derived-but-pinned is the right
category: the derivation is reviewable and the result is stable.

---

## 8. Extrapolation — and why two of the three ideas are not process models

The brief asked for "a way to extrapolate new rates out of historical data". Three things
wear that description and only one of them is a new model.

### 8.1 Calibration is a tool, not a model — and it is the highest value per unit of work

`fxVolatility` defaulted to 0.06 and `fxReversionSpeed` to 0.5. Both were guesses, and
both were wrong in a way that mattered — the measured values are 0.1133 and 0.296, so the
shipped volatility was about **half** the observed figure. The series on disk replaces
both with estimates:

```text
σ̂  = sd( monthly log returns ) × √12
k̂  = −12 · ln( ρ̂₁ )        from an AR(1) fit of log deviation about its window mean
μ̂  = mean( monthly log returns ) × 12          # reported, never silently applied
```

> **SUPERSEDED (18 Aug 2026) — the k̂ estimator above is wrong for this purpose.**
> `−12·ln(ρ̂₁)` is the MLE *if the series really is an OU*. FX is not, and under that
> misspecification the lag-1 statistic is the worst available target: most sensitive to
> month-to-month noise, least informative about the multi-year behaviour a retirement
> projection exists to model. On the post-float window it returns k=0.296 (half-life
> 2.3y), which reproduces the observed 1-year dispersion and then flattens — understating
> 10-year dispersion by a third and 44-year dispersion by ~40%.
>
> What shipped instead is `fitFxTermStructure`, which fits (σ, k) to the observed **term
> structure of dispersion** across horizons with ≥4 non-overlapping windows: post-float
> σ=0.1142, **k=0.114**, half-life 6.1 years. The variance ratio agrees (at 10y: history
> 0.650, term-structure fit 0.634, lag-1 fit 0.370). σ̂ and μ̂ above are unaffected — only
> k̂ moves. See `scenarios/fx-study/fx-study.md` §5.

This adds **no** enum value, **no** new code path in the loop, and **no** new failure
mode. It makes the two knobs that already exist honest, and it is the cheapest way to get
most of the value of this whole document. Ship it as `scripts/lab/calibrate-fx.mjs` plus
a workbench affordance that writes the estimates into the parameters, showing the window
and the estimate together so a reader can see which window produced which number.

**Build this first**, before any overlay mode. It is independently useful, it validates
the packaged series end to end, and if it turns out that a calibrated `MEAN_REVERTING`
answers the questions being asked, some of §3 may not be needed at all.

### 8.2 Bootstrap is a genuine new model

A stationary block bootstrap over historical monthly log-returns is the one thing here
that OU cannot imitate: it preserves volatility clustering and fat tails, which a
Gaussian OU process cannot produce at any parameterisation. Mechanics:

- draw a block start uniformly from the window; consume returns sequentially;
- at each step, end the block with probability `1/L` (geometric block length, mean `L`),
  which keeps the process stationary — a fixed block length does not;
- `fxBootstrapBlockMonths` (`L`, default 12) is the knob; `L = 1` degenerates to an IID
  bootstrap and destroys the clustering that motivates the feature;
- demean per §5 unless explicitly told not to.

### 8.3 What is deliberately *not* proposed

- **Fitting a richer process** (GARCH, jump-diffusion, regime-switching FX). The regime
  system already modulates `effectiveFxVol` multiplicatively, so clustering has a
  cheaper existing home.
- **Forward-curve or interest-parity projection.** It would require a second data series
  and pins the drift to a market view that this model has no other use for.
- **Anything that makes an overlay the default.** 87 §13.5: if an overlay becomes the
  normal way to run the model, the model has acquired a dependency on packaged data and
  the synthetic path stops being exercised. `NONE` stays the default; golden fixtures
  stay data-free ([[golden-fixture-harness]]).

---

## 9. Parameters

All in the existing `FX` group on `us-au-cross-border-toolset`.

| key | type | default | notes |
|---|---|---|---|
| `fxProcessModel` | Enum | `NONE` | gains `HISTORICAL_REPLAY`, `HISTORICAL_LOOP`, `HISTORICAL_BOOTSTRAP` (`HISTORICAL_SAMPLED` cut, §14 Q4) |
| `fxSeriesId` | Enum | `USD_AUD.H10.monthly` | one option today; exists so a second pair is additive |
| `fxReplayAnchoring` | Enum | `RETURNS` | `RETURNS` \| `LEVEL`; `LEVEL` forbidden with `HISTORICAL_LOOP` (§4) |
| `fxReplayStart` | Date | `1984-01` | first mapped month; the float boundary (§5) |
| `fxReplayEnd` | Date | *null* | window end; `HISTORICAL_LOOP` requires it |
| `fxReplayExhausted` | Enum | `ERROR` | `ERROR` \| `HOLD` \| `MODEL` (§9.1) |
| `fxReplayFallbackModel` | Enum | `MEAN_REVERTING` | only read when `fxReplayExhausted = MODEL` |
| `fxBootstrapBlockMonths` | Number | 12 | mean geometric block length |
| `fxBootstrapDemean` | Boolean | true | §5 |
| `fxVolatility` | Number | **0.1133** | calibrated post-float (§14 Q6, BUILT). **gate** `visibleWhen` a stochastic model; refuse as an MC axis under replay |
| `fxReversionSpeed` | Number | **0.296** | calibrated post-float (§14 Q6, BUILT); same gating |

`mc`/`opt` flags: the replay window fields are `mc: false, opt: false`. A window is a
scenario-authoring choice, and an optimizer allowed to search over historical start dates
will find the window that flatters the strategy — which is not a finding.

### 9.1 Out-of-window behaviour must be explicit

87 §13.1: an overlay with no coverage for a date must not silently mean zero. This is §7
trap 5 wearing new clothes, and it is how the §988 debt leg was mis-verified once already
([[section-988-two-legged-position]]). So the behaviour past `fxReplayEnd` (or past
`lastMonth`) is a required, recorded choice:

- **`ERROR`** *(default)* — throw, naming the mode, the window and the date that fell
  outside. Loud is right: the repo's recurring bug shape is an absent value read as a
  benign one ([[destination-key-absent-guard]], [[config-field-in-state-is-not-read]]).
  With a 1984-start window there is over 40 years of coverage, so most realistic
  horizons never see this. **The check runs at CONFIG time**, in
  `FxService.getContributions()` against `context.startDate`/`endDate` — not on the tick
  that falls off the end, which would surface deep inside an MC iteration (§14 Q2).
- **`HOLD`** — freeze `fxDeviation` at its last overlaid value. Honest only if the run
  reports it; a frozen FX rate for the back half of a horizon is a material assumption.
- **`MODEL`** — hand over to `fxReplayFallbackModel` and continue stochastically. The
  most useful for long projections and the one that most needs the handover invariant:
  the deviation is continuous across the boundary by construction (the fallback starts
  from the current `fxDeviation`), and a test asserts it.

Whichever is chosen, the run records that the boundary was crossed and when. A mixed run
whose output does not say which part was observed is uninterpretable, and someone will
quote the modelled half as though it were measured (87 §13.3).

---

## 10. Provenance in the journal

87 §13.3 notes the journal already carries per-action payloads, so marking overlaid values
costs almost nothing. `FX_STEP_APPLY` gains two declared fields:

```text
observed:   boolean   — this deviation came from a series, not a draw
seriesDate: string    — the historical month it was read from
```

Declared in the toolset's payload manifest, or `TypeRegistry.pickPayload` drops them and
they never reach the journal — the gate is authoritative now ([[payload-manifest-gate-unwired]],
design 91 §7). `seriesDate` is what makes a mixed run auditable: a report can state which
months were observed and which were modelled, and the `MODEL` handover in §9.1 becomes
visible in the journal rather than inferred from a parameter.

---

## 11. Traps, collected

1. **Direction.** `DEXUSAL` is USD per AUD; the engine is AUD per USD. Invert once, in the
   generator. A test asserts the packaged value for a known month against the engine's
   convention explicitly.
2. **The RNG ledger.** Consume and discard (§6.1), or every overlay-versus-control
   comparison is contaminated and nothing will look wrong.
3. **Deterministic MC.** Zero FX dispersion is an arm property, not a world property (§6.2).
4. **Drift is not neutral** (§5). Surface it.
5. **`LEVEL` cancels the anchor and the regime FX lever** (§4). If a study varies
   `fxAdjustment` under `LEVEL` replay it is varying a dead parameter.
6. **The boundary** (§9.1). Continuity of `fxDeviation` across the handover is an
   invariant worth asserting, not an expectation.
7. **Revision** (§7). Pin the hash in the output or the run is not reproducible.
8. **Serialization** (§2.2). Series by id, never by value.
9. **Granularity.** The engine overlay is monthly and is **not** a §988 rate source. A
   monthly rate applied to a disposition changes the §988 answer, because each disposition
   carries its own rate, its own holding period and its own \$200 test — none of which
   survive being aggregated (87 §13.4). The daily table stays the tax path's source, and
   the two must not be crossed.

---

## 12. Test plan

Unit, all data-free by construction except the ones that read the packaged module (which
is committed, so they are hermetic):

- **Absence** — with `fxProcessModel = NONE`, state and journal are byte-identical to the
  pre-change baseline. The whole-state golden harness already does this.
- **Known window** — `HISTORICAL_REPLAY` + `LEVEL` over a hand-checked window reproduces
  published rates at the composed `effectiveExchangeRates.USD_AUD`, to the inversion.
- **Returns continuity** — `RETURNS` mode's tick-zero rate equals the authored anchor
  exactly; `LEVEL` mode's does not (and the guard fires when the gap exceeds tolerance).
- **Loop seam** — a window looped twice has no return larger than the window's own
  maximum return; the seam increment is never taken.
- **Draw ledger** — tick count and uniform-draw count are identical between
  `MEAN_REVERTING`, `HISTORICAL_REPLAY` and `HISTORICAL_LOOP` over the same horizon.
- **Exhaustion** — each of `ERROR` / `HOLD` / `MODEL` does exactly what it says; `MODEL`
  hands over with a continuous `fxDeviation`.
- **Working-detector control** (87 §13.1) — every overlay test has an otherwise identical
  `NONE` arm proving the overlay moved something. An overlay arm with no control is not
  evidence, which [[offset-earns-no-yield]] is the standing example of.
- **Generator sync** — regenerating from the CSV produces the committed module byte for
  byte.
- **Bootstrap statistics** — over many seeds, the resampled series' annualised σ matches
  the window's within tolerance, and the demeaned variant's drift is ~0.

---

## 13. Build order

1. **Package the series** (§7) — generator, module, sync test, direction test. No engine
   change at all. Independently verifiable.
2. **Calibration tool** (§8.1) — estimates for σ and k from a chosen window. Still no
   engine change. **Highest value per unit of work in this document**, and it may reduce
   the demand for the rest.
3. **`HISTORICAL_REPLAY` + `RETURNS`** — the minimum honest overlay: step-function
   context extension, discard-the-draw, exhaustion handling, provenance fields.
4. **`LEVEL` anchoring + the tick-zero guard** — unlocks the backtest.
5. **`HISTORICAL_LOOP`** — the seam rule, returns-only.
6. ~~**`HISTORICAL_SAMPLED`**~~ — **cut** (§14 Q4).
7. **`HISTORICAL_BOOTSTRAP`** — the only genuinely new stochastic process, and now the
   only historical MC mode.

Steps 1–2 are worth doing regardless of whether 3–7 are ever built. **They are done**
(§15); 3–7 are deferred pending experience with the calibrated `MEAN_REVERTING`.

---

## 14. Decisions — LOCKED 2026-08-18

1. **Default window: post-float, 1984-01→.** Confirmed. It costs 13 years of data and is
   the defensible choice: σ̂ barely moves across windows (0.109 whole-series, 0.113
   post-float, 0.119 post-2000) but k̂ **halves** when the managed float is included
   (0.296 → 0.111, a half-life of 2.3 years against 6.2). A pegged currency is not a draw
   from the same process, and the estimate says so.

2. **Exhaustion default: `ERROR`, checked at CONFIG time.** Keeps the repo's
   loud-absence pattern, but the doc as first written threw on tick ~400, inside an MC
   iteration — an expensive place to learn a window is too short. `context.startDate` /
   `context.endDate` already reach the toolsets (`au-tax-toolset.js:170` uses them), so
   the window-versus-horizon check belongs in `FxService.getContributions()` and fails
   before the run starts. With a 1984 window there is 42 years of coverage, so a
   realistic horizon rarely reaches the boundary at all.

3. **`LEVEL` waits for the backtest.** Deferred with steps 3–7; the surface shrinks
   materially in the meantime. Revisit when 87 §13.6 step 3 is actually imminent.

4. **`HISTORICAL_SAMPLED` is CUT.** The numbers decide this rather than taste. The
   post-float window is 511 months, so distinct start offsets are 511 − horizon: **151**
   at a 30-year horizon, **91** at 35 years, **31** at 40 years — and adjacent starts
   share 419 of 420 months. That is on the order of *one* effectively independent path.
   It would present as a working MC axis and report near-zero FX dispersion, which is
   exactly the inert-lever failure §6.2 warns about
   ([[mpc-lever-tests-scenario-shaped]], [[dead-spouse-growth-params]]). If historical
   dispersion is wanted, `HISTORICAL_BOOTSTRAP` is the only mode that supplies it.
   A handful of authored "era" arms is just `HISTORICAL_REPLAY` with a chosen start and
   needs no enum value of its own.

5. **`fxSeriesId` stays.** More pairs are planned, so the indirection is kept from the
   start rather than retrofitted. One option exists today.

6. **The shipped defaults are now calibrated, not guessed.** `fxVolatility` 0.06 →
   **0.1133** and `fxReversionSpeed` 0.5 → **0.296**. This was not in the original
   document and is the largest behavioural change in steps 1–2: the old default ran the
   currency at roughly **half** its observed volatility, and every `MEAN_REVERTING`
   scenario inherited that. Golden fixtures use `NONE` and did not move; any scenario
   setting the values explicitly is unaffected.

---

## 15. What was built (steps 1–2)

| file | what it is |
|---|---|
| `scripts/dev/build-fx-series.mjs` | generator; `--check` re-renders and diffs (`npm run build:fx-series`) |
| `src/finance/fx/data/usd-aud-h10-monthly.js` | generated, committed: 667 months 1971-01 → 2026-07, `audPerUsd` |
| `scripts/lib/fx-calibration.mjs` | the estimator, pure over arrays so it can be verified against a synthetic path |
| `scripts/lab/calibrate-fx.mjs` | window selection + presentation (`npm run calibrate:fx -- --compare`) |
| `tests/unit/fx-series-package.test.mjs` | FXS-1…6: generator sync, direction, contiguity, provenance, downsample rule, no invented trailing month |
| `tests/unit/fx-calibration.test.mjs` | FXC-1…6: parameter recovery, working detector, drift isolation, refusal, defaults-in-sync |

**No engine change.** `FX_PROCESS_MODELS`, `FxTickHandler`, `FxProcessReducer` and the
step-function signature are untouched, so §2.1's context extension and §10's provenance
fields remain unbuilt and unneeded. The full suite passes (5212 tests).

### 15.1 Two things worth carrying into step 3

- **A plausibility band cannot test the direction.** The obvious guard — assert every
  packaged value looks like ~1.42 rather than ~0.70 — does not work for this pair. The
  AUD has traded on both sides of parity (1.4875 USD in 1974, 0.4881 in 2001), so the
  true `audPerUsd` range 0.67–2.05 overlaps the inverted range 0.49–1.49 almost entirely.
  Only hand-transcribed fixed points discriminate, and they must straddle parity so no
  single global flip satisfies them all. FXS-2 does this; the first draft of it did not,
  and passed for the wrong reason until a 1971 value failed the band.

- **An estimator only ever run on real data is unverified.** It returns a
  plausible-looking number for any input. The calibration is therefore split: the
  estimator is pure over arrays (`scripts/lib/fx-calibration.mjs`) so FXC-1 can drive it
  with a synthetic OU path of known σ and k — built from *the engine's own* step function
  — and check recovery. FXC-2 is the working-detector control that stops FXC-1 passing
  for an estimator that returns a near-constant.

### 15.2 What the FX study changed (18 Aug 2026)

A spending study on a real 44-year cross-border plan (`scenarios/fx-study/`) revisited
this document's step 3–7 question and answered **no**, with two corrections to what
steps 1–2 shipped:

- **`fxReversionSpeed` 0.296 → 0.114** (§8.1 note above). The k estimator this document
  specified was the wrong fit target.
- **`fxVolatility` 0.1133 → 0.1142** — the same number to within noise; σ was always fine.

On steps 3–7: over horizons the data can speak to (≤10y) a correctly-fitted OU fits about
as well as the best block bootstrap (RMSE 0.037 vs 0.028), and beyond 10 years neither is
validatable — the post-float window holds 0–1 independent 44-year observations.
`HISTORICAL_REPLAY` additionally cannot cover a 528-month horizon from a 511-month
window. §5's warning that a replay window is a currency view was confirmed and is if
anything understated: the drift lever outweighs the entire volatility process on that plan.

The study's own largest finding was **not** about design 92 at all — it was that
`monthlyExpensesCurrency` defaults to USD, which makes real consumption FX-invariant by
construction for a household living in Australia on a USD portfolio (0% spending
dispersion against 36% once the target is denominated in AUD).

### 15.3 The refresh obligation

`rates/README.md` now documents it: a FRED refresh means update the retrieval date,
`npm run build:fx-series`, then `npm run calibrate:fx` and **decide**. FXS-1 fails while
the generated module is stale; FXC-6 fails when a revision moves σ̂ or k̂ outside tolerance
of the shipped defaults. The second failure is the point — it forces a deliberate
re-decision instead of letting a default quietly stop describing its own source.
