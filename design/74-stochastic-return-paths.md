# 74 — Stochastic return paths: from one constant rate per run to sequence-of-returns risk

**Status**: **PHASES 1–3 IMPLEMENTED** (2026-07-21). Phase 1 (§5.1) + Phase 2 (§5.2 MC,
both committed) + Phase 3 (§5.3 drift compensation) built + green (3863 unit / 906 viz,
JOURNAL_STRICT on) on `wip/stochastic-return-modeling`. Only Phase 4 (decision re-run)
remains PROPOSED.

**Phase 3 surface**: new `equityReturnDriftComp` param (`Enum` GEOMETRIC | NONE, default
**GEOMETRIC** per §8 Q2). The handler emits a per-sleeve deterministic `driftComp` term
**separate** from the mean-0 `deviation` — under GEOMETRIC `driftComp = ((β·σ)² + σ_idio²)/2`
(the sleeve's annualized return variance ÷ 2), under NONE it is 0. It is config-only (draws
no RNG). `EquityReturnStepReducer` stores `state.equityReturnDriftComp`; `EquityReturnReducer`
folds `deviation + driftComp` together. Keeping comp separate leaves `equityReturnDev` pure
mean-0 (telemetry + Phase-1 tests unchanged). Validated (§6 test 6): at anchor 10% / σ 18%,
realized geometric mean is **10.07%** under GEOMETRIC vs **8.43%** under NONE (≈ anchor − σ²/2);
`driftComp` is exactly σ²/2 = 0.0162. End-to-end MC (24-yr): GEOMETRIC median net worth
$23.8M vs NONE $20.3M. Exact for WHITE_NOISE; slightly over-compensates for MEAN_REVERTING
(lower stationary variance) — documented, accepted. Tests: 6 added to
`equity-return-paths.test.mjs`.

⚠️ **§5.2 correction — the per-iteration seed did NOT already vary.** The design's Phase-2
premise ("the per-path seed already varies by iteration … no runner change") was **false**:
`BaseScenario.buildSim()` constructed `new Simulation(…)` with no seed (→ default `seed=1`)
and the MC runner's `createSimulation: (params) =>` closure **dropped** the `seed` argument
`ScenarioRunner` passed it. Proven empirically: with the flag ON and all scalar MC variables
off, all iterations returned the *identical* net worth — every path drew the same return
sequence, collapsing sequence-of-returns risk to one ordering. **Phase 2 fixes this**:
`buildSim({ seed })` threads the seed into `Simulation`, and the runner passes the iteration
index. Single runs (seed defaults to 1) and flag-off MC (no `sim.rng` consumers) are
unchanged; golden untouched (3857/906 green). This was the load-bearing part of Phase 2.

**Phase 2 surface**: seed threading (`base-scenario.js`, `intl-retirement-mc-runner.js`);
`equityReturnVol` exposed as an opt-in MC variable (`mc:true` on the schema param, new
'Return Paths' MC group so the shock-row count tests stay meaningful); `computePathShape()`
per-run diagnostics (netWorthCagr / worst5yrCagr / maxDrawdown / decadeNetWorthUsd) +
`summary.pathShape` sequence-risk readout (failure rate split by below-/above-median first
decade). Tests: `tests/unit/equity-return-mc.test.mjs` (12).

**Decisions locked** (owner, 2026-07-21): representation **Option B** (one market factor +
per-sleeve beta + optional idio); per-sleeve behaviour shipped via **default non-unity betas**
on a single market vol (US 1.0 / AU stock 0.9 / super 0.7 — §8 Q1); annual ticks (§8 Q5);
drift compensation default **GEOMETRIC** (§8 Q2) — *deferred to Phase 3*, so Phase 1 treats
the anchor as an arithmetic mean and turning the flag on shows the ≈σ²/2 volatility drag;
inflation path **deferred to design 75** (§8 Q4); historical bootstrap accepted as a future
Phase 5 model id (§8 Q3).

**Phase 1 surface**: `EquityReturnTickHandler` + `EquityReturnStepReducer` +
`EquityReturnReducer` (`src/finance/economic-regimes/`), the `EQUITY_RETURN_TICK` series and
`equityReturn*` params in the ECONOMIC_REGIMES toolset, `EQUITY_SLEEVES` / `DEFAULT_EQUITY_BETA`
in `rate-keys.js`, registrations in `index.js` + `scenario-serializer.js`, and
`tests/unit/equity-return-paths.test.mjs` (20 tests: §6 items 1,2,4,5,7 + fold + round-trip).
The market factor is single/global across US+AU (rank-1, per Option B); its OU state persists as
`state.equityReturnMarketDev` for `MEAN_REVERTING`. **Open for Phase 2**: §8 Q6 (common random
numbers across MPC/optimizer candidate rollouts) — reducer-resident dev + snapshot-safe `sim.rng`
should reproduce without a `_seededSim` shim (cf. designs 65/61), but CRN-across-candidates needs
an explicit regression before MC lands.

**Scope**: give the simulation a *return path* — a different equity return each year, drawn
from a seeded, snapshot-safe process — so that Monte Carlo measures **sequence-of-returns
risk** rather than only uncertainty about the long-run average.

**One-line problem statement**: today every MC iteration draws one growth rate and holds it
constant for 44 years, so a 10% average with a catastrophic first decade is indistinguishable
from a steady 10%. For a decumulating portfolio those are not remotely the same scenario, and
the difference is precisely the risk a retirement plan exists to manage.

---

## 1. Motivation

### 1.1 Every failure rate the model reports today is a floor

The tranche B/C decision analysis (`scenarios/company-equity-decision.md`) ran 2,400 MC paths
and reported a **2–4% failure rate** at $10,000/month. That number is not wrong so much as
**structurally optimistic**, and the reason is visible in one line of
`IntlRetirementMcRunner._perturb()`:

```js
set(perturbed, cfg.paramKey, createDistribution(cfg).sample(rng));   // ONE draw per iteration
```

The sampled `brokerageGrowthRate` is written into `cfg.parameters` and then applies unchanged
to all 44 years. Within an iteration the portfolio compounds perfectly smoothly.

**What that misses.** A retiree drawing a fixed real income is exposed to the *order* of
returns, not just their average. Withdrawing during a drawdown sells more units at depressed
prices and permanently impairs the base — the classic sequence-of-returns problem. Two paths
with an identical 44-year geometric mean can differ by decades of solvency depending on
whether the bad years came first.

The current design can express "the average might be 6% instead of 10%". It cannot express
"the average is 10% but the first eight years are −15%, −3%, +2%, …".

### 1.2 Volatility drag is also absent, and it is not small

A constant-rate model does not merely mis-order returns — it **overstates compounding
outright**. For a multiplicatively-applied return, the geometric mean sits below the
arithmetic mean by roughly `σ²/2`:

```
arithmetic 10%, σ = 18%   ⇒   geometric ≈ 10% − 0.18²/2 ≈ 8.4%
```

**Today's model compounds at the arithmetic mean.** Every long-horizon result in the codebase
is therefore biased upward by ~1.6pp/yr of return, which over 44 years is a factor of ~2 on
terminal wealth. This is a real, well-understood effect and it is currently missing entirely.

§5.3 treats this as the design's single most consequential decision, because it determines
whether turning the feature on *should* move results.

### 1.3 It is a prerequisite for modelling correlated risks

The same analysis identified the **US house sale as the binding risk** — worth ~3× tranche B.
Modelling house sale price properly requires correlating it with market conditions: a bad
equity market and a soft housing market co-occur, and it is exactly that conjunction that
breaks a plan.

**There is nothing to correlate against until a return path exists.** A single constant rate
per run offers no time-varying market state. This design is therefore a structural
prerequisite for the house-price work, not merely convenient ordering.

---

## 2. What exists today

Most of the machinery is already built. This design is largely a third consumer of an
established pattern.

| Need | Existing primitive | Design |
|---|---|---|
| Seeded, snapshot-safe RNG | `sim.rng` — cursor captured/restored in every history snapshot | — |
| In-loop RNG consumer precedent | `FxTickHandler` (1st), `YieldCurveTickHandler` (2nd) | 47, 67 |
| Stochastic process models | `FX_PROCESS_MODELS`: `NONE` / `WHITE_NOISE` / `RANDOM_WALK` / `MEAN_REVERTING` | 47 |
| Standard-normal draw | `gaussianFrom(rng)` — Box-Muller, shares construction with `NormalDistribution.sample()` | 47 |
| A per-period rate the whole engine already reads | `state.effectiveGrowthRates[<family>]` and `<family>::<stateKey>` | 55 |
| A deviation folded onto an anchor each period | `YieldCurveReducer` folds `yieldCurveLevelDev` onto `effectiveInterestRates` | 67 |
| Discrete market crashes | `SHOCK_LIBRARY` + `shocks[]`, one event at one date | — |
| Regime-driven rate changes | ECONOMIC_REGIMES toolset | — |

**The gap is narrow and specific**: `effectiveGrowthRates` is recomputed each period from
regime state, but has **no stochastic term**. Bonds got one in design 67; equities never did.

### 2.1 Why the existing shock mechanism is not enough

`shocks[]` can place a market crash at a date (and MC can sample severity and timing — both
ship `enabled: false`, which cost an entire MC run to discover). But:

- It is **one discrete event**, not a distribution of paths. Real damage often comes from a
  grinding decade, not a single crash.
- Between shocks the path is perfectly smooth, so volatility drag is still absent.
- Sampling one crash date gives a bimodal, lumpy risk profile rather than a realistic
  spread.

It is a useful stress test. It is not a return path.

---

## 3. Goals / non-goals

**Goals**

1. Each simulated year draws its own equity return from a seeded process.
2. Sleeves move **together** — a market factor, not independent per-account noise.
3. Default-off and **bit-for-bit inert** when off (the design 67 discipline).
4. Reproducible: identical seed ⇒ identical path, including MPC/optimizer forward rollouts.
5. MC exposes volatility as a sampled/configurable input.

**Non-goals**

- Fat tails, volatility clustering, GARCH. Gaussian is a large enough step; revisit later.
- Historical bootstrap / block resampling (see §8 open question 3).
- Bond return paths — design 67 already covers the fixed-income level.
- Correlating property appreciation — **deliberately deferred to the house design**, which
  this one unblocks (§7).

---

## 4. The representation decision

Three candidates for how the per-year deviation is structured.

| Option | Model | Verdict |
|---|---|---|
| **A. Independent per sleeve** | each of `EQUITY_US_*`, `EQUITY_AU_*`, super draws its own `z` | ✗ **Wrong.** Independent draws diversify away the systematic risk the whole exercise is about. With ~6 sleeves the portfolio-level vol collapses by ~√6 and the model would report a *falsely reassuring* answer — worse than today. |
| **B. One market factor + per-sleeve beta + idiosyncratic** | `dev_s = β_s · z_market + σ_idio,s · z_s` | ✓ **Recommended.** One draw drives everything, so systematic risk survives aggregation; betas let AU equity and super respond differently; idiosyncratic terms are optional and default to 0. |
| **C. Full covariance matrix** | Cholesky over all sleeves | ✗ Overkill. Needs a calibrated covariance matrix nobody has, for accuracy the decision does not need. Option B is the rank-1 approximation and captures nearly all of it. |

**Decision: Option B.** It is the minimum structure that does not lie about diversification,
and it degrades gracefully — with all betas at 1 and idiosyncratic vol 0, it is a single
common shock, which is the honest default.

```js
// One standard normal per year, shared across all sleeves:
const zMarket = gaussianFrom(sim.rng);
// Per sleeve:
dev[sleeve] = beta[sleeve] * sigmaMarket * Math.sqrt(dt) * zMarket
            + (sigmaIdio[sleeve] ?? 0) * Math.sqrt(dt) * gaussianFrom(sim.rng);
```

⚠️ **RNG-cursor ordering matters.** Idiosyncratic draws consume additional uniforms, so
enabling them changes every subsequent draw. Sleeve iteration order must be **deterministic
and stable** (sort by rate key), and the idiosyncratic draw must be **skipped entirely** —
not drawn-and-multiplied-by-zero — when `sigmaIdio` is 0, or the zero case will not reproduce
the market-only path.

---

## 5. Phases

### 5.1 Phase 1 — the tick handler and the fold (flag-gated, golden-neutral)

Mirrors design 67 §6 almost exactly.

**New: `EquityReturnTickHandler`** (`src/finance/economic-regimes/equity-return-tick-handler.js`)

- Fires on a new annual `EQUITY_RETURN_TICK` EventSeries.
- **Only scheduled when `equityReturnStochastic` is on** — default scenarios draw no
  randomness and stay bit-for-bit identical.
- Draws `zMarket`, computes a deviation per sleeve, emits `EQUITY_RETURN_STEP_APPLY`.

**New: `EquityReturnStepApplyReducer`** — pure; stores `state.equityReturnDev[<rateKey>]`.

**Extend `RegimeApplyReducer` / the growth-rate composition site** — fold
`equityReturnDev[k]` onto `effectiveGrowthRates[k]` after regime adjustment, exactly as
`YieldCurveReducer` folds `yieldCurveLevelDev` onto `effectiveInterestRates`. Per-account
`<family>::<stateKey>` keys inherit their family's deviation unless separately keyed.

**Process model**: default `WHITE_NOISE`. Equity returns are close to IID; `MEAN_REVERTING`
is offered for a valuation-based view but is **not** the default, because OU on the *level*
would impose a degree of predictability the evidence does not support.

**Params**

| Param | Default | Meaning |
|---|---|---|
| `equityReturnStochastic` | `false` | Master flag. Off ⇒ no event scheduled, no draws. |
| `equityReturnVol` | `0.18` | Annualized market-factor sd, in rate units. |
| `equityReturnModel` | `WHITE_NOISE` | One of `FX_PROCESS_MODEL_IDS`. |
| `equityReturnBeta` | `{}` | Optional per-rate-key beta; absent ⇒ 1.0. |
| `equityReturnIdioVol` | `{}` | Optional per-rate-key idiosyncratic sd; absent ⇒ 0. |
| `equityReturnDriftComp` | `NONE` | See §5.3. |

**Exit criteria**: flag off ⇒ golden byte-identical. Flag on ⇒ reproducible across identical
runs, and across snapshot/restore (JOURNAL_STRICT green).

### 5.2 Phase 2 — MC integration

- Expose `equityReturnVol` as an MC variable (and make sure it is **not** silently centred on
  a library default). ✅ Done — the MC config centres on the live scenario value
  (`mean: defaultValue ?? cfg.mean`), disabled by default; `mc:true` on the schema param.
- ~~The per-path seed already varies by iteration, so turning the flag on gives every MC path
  its own return sequence with no runner change.~~ **WRONG — see the status-header correction.**
  The seed was fixed at 1 for every iteration; `buildSim({ seed })` now threads the
  iteration index so each path draws its own sequence. This was the real work of Phase 2.
- Add path-shape diagnostics to the MC result: realized geometric mean, worst 5-year window,
  drawdown depth, and **whether the first decade was below median** — the last is the direct
  sequence-risk readout and the one worth reporting. ✅ `computePathShape()` +
  `summary.pathShape` (see status header). NOTE: only meaningful once the flag is ON and
  (Phase 3) drift is decided; on the smooth default accumulation scenario `maxDrawdown` is
  legitimately ~0 because yearly net worth still rises even through negative equity years.

### 5.3 Phase 3 — the drift decision ⚠️

**This is the design's most consequential choice and it needs an explicit answer.**

Adding a mean-0 shock to a multiplicatively-applied rate *lowers* the realized geometric
return by ≈ `σ²/2`. At `σ = 0.18` that is **−1.6pp/yr**. So switching the flag on will make
every scenario markedly poorer, and users will reasonably ask whether that is a bug.

Three options:

| Option | Behaviour | Argument |
|---|---|---|
| **NONE** (no compensation) | anchor 10% ⇒ realized geometric ≈ 8.4% | The anchor is interpreted as an **arithmetic** mean. Volatility drag is real and currently missing; this is a *correction*, not a regression. |
| **GEOMETRIC** | add `σ²/2` to the anchor so realized geometric ≈ 10% | The anchor is interpreted as the **geometric/CAGR** return the user believes they will earn. Turning volatility on then changes only the *spread*, not the centre. |
| **DOCUMENTED** | no compensation, but surface realized geometric mean in the UI/MC output | Honest, but leaves the user to reconcile the shift. |

**✅ IMPLEMENTED: `GEOMETRIC` default, `NONE` available** (`equityReturnDriftComp` param).
Realized geometric mean at anchor 10% / σ 18% = 10.07% (GEOMETRIC) vs 8.43% (NONE). The comp
is emitted per sleeve as a deterministic term separate from the stochastic deviation and folds
alongside it; it is exact for WHITE_NOISE and slightly over-compensates for MEAN_REVERTING.

**Recommendation: `GEOMETRIC` as the default, `NONE` available.** Rationale: when a user
types "10%" into a growth-rate field they almost certainly mean "I expect to earn 10% a
year", which is a CAGR claim, not an arithmetic-mean claim. Defaulting to `GEOMETRIC`
preserves that intent and keeps the flag's effect interpretable — **spread changes, centre
does not**. `NONE` remains for users who deliberately supply arithmetic inputs.

Whichever is chosen must be **stated in the param description**, because the two differ by a
factor of ~2 on 44-year terminal wealth and the difference is otherwise invisible.
---

## 6. Testing plan

1. **Inertness** — flag off: golden byte-identical; no `EQUITY_RETURN_TICK` scheduled; RNG
   cursor unadvanced (assert directly — the cheapest guard against accidental draws).
2. **Determinism** — same seed twice ⇒ identical `equityReturnDev` series.
3. **Snapshot safety** — snapshot mid-run, restore, continue ⇒ identical to uninterrupted.
   This is the property `sim.rng` exists to provide; JOURNAL_STRICT on.
4. **Statistical calibration** — over ~10,000 simulated years, the realized market-factor sd
   is within tolerance of `equityReturnVol`, and mean deviation ≈ 0.
5. **Correlation** — with betas at 1 and idio 0, all sleeves move in lockstep (correlation
   1.0). This is the direct regression test against Option A's diversification bug.
6. **Drift** — under `GEOMETRIC`, realized geometric mean over a long horizon ≈ the anchor;
   under `NONE`, ≈ anchor − σ²/2.
7. **RNG-cursor ordering** — enabling idio vol for one sleeve must not change another
   sleeve's *market* component; and idio 0 must reproduce the market-only path exactly.
8. **No double-count** — a scenario with both a configured shock and stochastic paths on
   applies each once (regression against folding the deviation at two sites).

---

## 7. Relationship to the house-price design

This design is the **prerequisite**. The house work needs:

- a per-year market state to correlate against (this design's `zMarket`);
- a shared factor so a soft housing market co-occurs with a weak equity market.

The natural extension once this lands is to give `RealProperty.appreciationRate` the same
treatment with its own beta on the same `zMarket` — a small increment on top of Phase 1,
versus a from-scratch stochastic layer if the house is done first.

**Doing the house first means measuring it with an instrument known to understate risk, then
re-measuring after this lands.**

---

## 8. Open questions (for owner review)

1. **Default `equityReturnVol` = 0.18?** Roughly US large-cap. AU equity and a diversified
   super balance are lower; should the *default* be per-sleeve rather than one market number
   with betas? Answer: Per sleeve would give better modeling ability.
2. **Drift compensation default** — §5.3. `GEOMETRIC` recommended; needs an owner decision
   because it changes every long-horizon result the moment the flag is on. Answer: `GEOMETRIC`
3. **Historical bootstrap instead of Gaussian?** Block-resampling actual return sequences
   would capture fat tails and volatility clustering for free, and is arguably *more*
   defensible than Gaussian for a 44-year retirement question. It needs a bundled return
   series and makes "vol" non-parametric (no longer an MC-sampleable scalar). Worth it as a
   Phase 5 alternative model id? Answer: yes
4. **Should inflation get a path too?** Correlated real-return risk is the honest framing, and
   a 4% inflation path with 10% nominal returns is a very different world from 2%/8%. Bigger
   scope; possibly design 75. Answer: if we can roll it in here then do it, if not 75
5. **Annual ticks, or monthly?** Growth applies monthly in places. Annual matches design 67
   and keeps RNG consumption low; monthly is more realistic intra-year but 12× the draws and
   changes nothing at the decision level. Annual proposed. Answer: Annual
6. **Does the MPC/optimizer forward rollout need the path frozen?** Design 58 needed a
   `_seededSim` capture/re-stamp shim for exactly this class of problem. If a rollout re-draws
   its own path, candidate comparisons become noise-dominated — common random numbers across
   candidates are essential. 

---

## 9. Relationship to other designs

- **47 (FX time-varying rates)** — established `sim.rng` as a seeded, snapshot-safe in-loop
  source and the `FX_PROCESS_MODELS` vocabulary. This design is the third consumer.
- **67 (bond yield curve)** — the direct structural template: flag-gated tick handler, pure
  apply-reducer, deviation folded onto an effective-rate map, inert by default. Follow it
  closely.
- **55 (config-driven params)** — per-account `<family>::<stateKey>` rate keys are the seam
  the deviation must respect.
- **58 / 65 (drawdown levers)** — sequence risk interacts directly with drawdown ordering.
  Once paths exist, the allocation-aware drawdown levers can finally be evaluated against the
  risk they were designed to manage; today the sequencing is smooth so they are under-tested.
- **39 (MPC spending)** — a guardrail spending rule is a *response* to sequence risk.
  Deterministic and constant-rate runs systematically flatter adaptive strategies because the
  trigger fires after damage that never actually varies. This design is what makes guardrail
  evaluation meaningful.
