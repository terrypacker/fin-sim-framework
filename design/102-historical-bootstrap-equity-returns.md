# 102 — Historical block bootstrap for equity returns

**Status: BUILT (13 Sep 2026), Phase 1 (equity only).** Answers design 74 §8 Q3
("historical bootstrap as a Phase 5 model id? — yes"). Also relabels the equity process
dropdown, because the analysis that motivated the bootstrap showed `MEAN_REVERTING` does
the opposite of what its name says for a return (§2, §3).

Measurement: `scripts/probes/probe-equity-process-fit.mjs`. Data generator:
`scripts/dev/build-historical-equity-returns.mjs`. Tests:
`tests/unit/equity-return-bootstrap.test.mjs`.

---

## 1. The question

A user comparing the two equity processes saw `MEAN_REVERTING` inflate a single run and cut
a Monte Carlo success rate sharply, and asked which process is "more realistic", and
whether the engine should offer a process that can be tuned to reproduce history.

"Realistic" has to be measured on the statistics that drive a plan's success rate:

- **lag-1 autocorrelation:** does one year's return predict the next?
- **variance ratios** VR(k) = Var(k-year sum) / (k · Var(1-year)). 1 means independent
  years, above 1 means momentum, and below 1 means prices pull back over time.
- **the spread of 30-year annualized returns.** This is what an MC failure rate responds to.
- **the tail:** skew and excess kurtosis.

## 2. What history shows

Shiller S&P 500 total return, January to January, 1871–2024 (153 annual returns, log).
Everything below comes from the probe.

| | Real | Nominal |
|---|---|---|
| mean / sd | +6.7% / 17.2% | +8.8% / 17.1% |
| skew / excess kurtosis | −0.63 / +0.47 | −0.73 / +1.13 |
| lag-1 autocorrelation | **+0.01** | +0.04 |
| VR5 / VR10 / VR20 | 0.86 / 0.78 / 0.51 | 0.87 / 0.71 / 0.58 |
| years below −25% | 3.9% | 2.0% |

**Is the VR < 1 real?** In a permutation test (the same 153 years shuffled 5000 times),
the observed ratios land at one-sided p = 0.26 (VR5), 0.28 (VR10) and 0.15 (VR20), and ac1
at p = 0.56. History *leans* toward mild price pull-back, but 153 years can't distinguish
it from independent years.

**Valuation:** starting CAPE10 against the next 10 years' real return gives corr −0.52, but
from only about 13 independent decades. The engine's anchor comes from forward-looking
capital market assumptions (design 99), which already price today's valuation, so the
return process should carry only the *shape* of the risk, not a second valuation view.

**The engine's processes on the same yardstick.** Each runs through the real
`EquityReturnTickHandler`: 2000 paths × 153 years, anchor = history's real geometric mean
(+6.9%), vol = history's simple-return sd (0.178), idiosyncratic vol off.

| process | ac1 | VR5 | VR10 | VR20 | skew | 30y p5 .. p95 | geo mean |
|---|---|---|---|---|---|---|---|
| history (rolling, overlapping) | +0.01 | 0.86 | 0.78 | 0.51 | −0.63 | +3.9% .. +9.1%* | +6.9% |
| `WHITE_NOISE` | −0.01 | 0.97 | 0.92 | 0.80 | −0.50 | +1.6% .. +12.9% | +7.0% |
| `MEAN_REVERTING` k=0.3 | **+0.70** | **3.11** | **4.10** | **4.36** | −0.72 | **−13.8% .. +24.8%** | **+5.1%** |
| `MEAN_REVERTING` k=0.5 | +0.58 | 2.53 | 3.00 | 2.94 | −0.61 | −7.5% .. +20.8% | +6.2% |
| `HISTORICAL_BOOTSTRAP` block 1 | −0.01 | 0.96 | 0.91 | 0.79 | −0.64 | +1.3% .. +12.8% | +7.0% |
| **`HISTORICAL_BOOTSTRAP` block 5** | −0.01 | **0.86** | **0.78** | 0.68 | **−0.62** | +1.9% .. +11.9% | +7.0% |
| `HISTORICAL_BOOTSTRAP` block 10 | −0.00 | 0.85 | 0.74 | 0.62 | −0.62 | +2.4% .. +11.7% | +6.9% |

\*Only about five non-overlapping 30-year windows, all from one market that turned out to
be the century's best. This range understates forward risk, so it is not a target.

Three findings:

1. **`MEAN_REVERTING` is momentum, not mean reversion.** It shares the FX process library,
   whose OU step mean-reverts a *level*. Applied to a *return*, it makes the return persist
   at e^(−k) (design 97 §20.9 found this first). At the default k=0.3, 30-year outcomes are
   3.4× wider than `WHITE_NOISE`, and 5 of 306,000 simulated years fell below −100%, which is
   impossible for a real asset. GEOMETRIC drift compensation also misses by 1.8 points (5.1%
   realized against a 6.9% anchor), because its stationary variance is far above σ². It is
   not a pessimistic-but-plausible world.
2. **`WHITE_NOISE` is realistic year to year**, but it misses the crash tail (log skew −0.50
   vs −0.63) and has none of history's multi-year pull-back.
3. **A 5-year block bootstrap reproduces history on every measure but VR20**, with no fitted
   parameter. It has the skew, VR5 and VR10 exactly, and keeps 30-year spread between
   white noise and history's own understated range.

Why not fit a price-reversion parameter to VR20 instead? The effect isn't significant, and
it *narrows* long-run outcomes, so an over-fit parameter would make every projection more
optimistic. That's the wrong direction for an estimation error in a retirement plan.

## 3. Relabel (not remove) the process dropdown

The ids stay, because saved scenarios, scripts (`scripts/lab/sequence-risk/arms.mjs`) and
design 97's studies store them. What the dropdown *shows* changes. `optionLabels` is a new
schema-owned param field: `ScenarioLoader` carries it into new entries and re-syncs it onto
saved ones (like `options`), and the Enum editor renders `optionLabels[id] ?? id`.

| id | label |
|---|---|
| `WHITE_NOISE` | White noise — independent years (default) |
| `HISTORICAL_BOOTSTRAP` | Historical bootstrap — replay US years 1871–2023 in blocks |
| `MEAN_REVERTING` | Persistent returns (momentum) — stress test only |
| `RANDOM_WALK` | Random walk of the return — unbounded, not for equities |
| `NONE` | None — no deviation (the anchor every year) |

`equityReturnReversionSpeed` now shows only when the model is `MEAN_REVERTING`, and the new
block length only under `HISTORICAL_BOOTSTRAP`.

## 4. The bootstrap

### 4.1 Data

`src/finance/economic-regimes/historical-equity-returns.js` is **generated** from
`docs/economic-shocks/data/Shiller-SP500-monthly.csv` and committed. The engine runs in the
browser with no runtime dependencies and can't read `docs/`. It holds 153 simple annual real
total returns (dividends reinvested), each from January of year *y* to January of *y + 1*,
1871–2023. A unit test re-derives every value from the CSV, so the two can't drift.

Shiller's prices are monthly averages, so each return is slightly smoothed relative to
month-end prices, and the deepest crashes are a little shallower than intraday figures.

### 4.2 Real, re-centred

- **Real, not nominal.** Inflation is its own process in the engine (sampled per MC path).
  Nominal returns would import historical inflation noise into equity without the matching
  inflation path. Phase 2 (§6) samples them together.
- **Re-centred.** The series mean is subtracted once at load, so each deviation is mean-0 and
  the scenario's anchor (the CMA total return, plus the MC's sampled Equity Return Shift)
  stays the centre. Replaying raw history would silently import 1871–2023 US returns as the
  forward mean, which is survivorship bias.

### 4.3 Algorithm: circular block bootstrap

Each annual tick either continues the current block with the next consecutive historical
year, or, when the block is exhausted, draws **one** uniform from `sim.rng` for a new start
year and begins a block of `equityReturnBootstrapBlock` years (default 5). The series wraps
from 2023 to 1871.

- **Cursor in state.** `state.equityReturnBootstrap = { index, year, remaining }` is the year
  just replayed and the years left in its block. It's written by `EquityReturnStepReducer`
  from the action's `bootstrap` field, so snapshots, replays and MPC/optimizer rollouts
  resume the same block. `year` also lets a watchlist show which historical year a path is
  living through.
- **RNG cursor.** The bootstrap consumes one uniform per block instead of one Gaussian (two
  uniforms) per year, so switching models re-orders every later draw in the shared stream
  (FX, yield curve, property repairs). That's expected: every stochastic consumer shares one
  stream, so a given seed is a given world only while the set of consumers is unchanged.
- **Nothing is seeded in `state()`.** The cursor key appears only when the model runs, and
  the other models' actions carry no `bootstrap` field. Default runs and every golden are
  byte-identical.
- **Block length 5** is the usual n^(1/3) rule for n = 153, and in §2 it's the setting that
  matches VR5 and VR10. Fixed blocks were chosen over the stationary (random-length)
  bootstrap because they are simpler to explain and to inspect in state. Open question 2.

### 4.4 Vol scaling and drift compensation

- **`equityReturnVol` rescales the deviations** by vol / sd(series). This keeps
  `equityReturnVol` a live MC variable (it is `mc: true`; ignoring it under the bootstrap
  would leave an inert lever), and keeps the property path's betas meaning the same thing.
  The series' own simple-return sd is 0.178, and the default vol is 0.18, so at the default
  the bootstrap replays history at 1.01× its size. Open question 1.
- **GEOMETRIC compensation** uses the series' measured drag, `dragVar = 2 × (arithmetic −
  geometric mean)`, scaled by (vol / sd)², in place of σ². It is **exact on history
  itself**: at an anchor equal to history's geometric mean, replaying the whole series
  returns exactly that mean (tested to 1e-9). At a 10% anchor it is within 0.3 points. On
  this series the measured drag is about 4% below the Gaussian σ², so the two are close.

### 4.5 Interactions

- **Monte Carlo:** `perturbParams` forces `equityReturnStochastic` on for every path unless
  `mcSequenceRisk` is false, and the model comes from the scenario. So setting the
  scenario's model to `HISTORICAL_BOOTSTRAP` makes every MC path a different sequence of
  historical blocks, seeded by path index. Paired A/B comparisons still hold, because path
  *i* draws the same blocks in both arms.
- **Other equity markets:** there is only a US series. AU and international markets load on
  the bootstrapped US market factor through their betas, plus their own Gaussian
  idiosyncratic vol (design 90 §7.4). Their idiosyncratic part is still Gaussian (§6).
- **Property:** with the equity path on, the property path reuses
  `state.equityReturnMarketDev`, which is now the bootstrapped deviation, so property rides
  history too. Its own drift compensation still uses the Gaussian `marketVol²`, a small
  approximation. With the equity path off, the property path falls back to white noise for
  this model id.
- **Dated shocks** stack on top of the bootstrap exactly as on white noise. History already
  contains its crashes, so a dated crash on a bootstrap path is a deliberate stress test.

## 5. What it doesn't do

- It can't produce an economy history hasn't seen. The worst 10-year real stretch it can
  replay is 1871–2023's.
- It carries US history only, from the market that did best.
- It has no valuation conditioning. The anchor carries that (§2).
- Inflation, bonds and equity are still sampled independently of each other (§6).

## 6. Phase 2 (not built)

- **Joint years.** Sample equity, CPI inflation and the 10-year yield *by the same
  historical year*, so stagflation, or equity falling while bonds rally, arrives together.
  This needs an inflation path (design 74 §8 Q4 deferred it to design 75), and a yield-curve
  process that can accept a sampled level instead of its OU walk.
- **An AU series** (OECD `SPASTT01AUM661N` is price-only from 1958) for AU-market
  idiosyncratic deviations, instead of Gaussian.

## 7. Open questions (for owner review)

1. **Rescale to `equityReturnVol`, or replay history at its own size?** Built as rescale, to
   keep the MC vol lever live. At the default vol the difference is 1%.
2. **Fixed or stationary blocks?** Fixed is built. The stationary bootstrap avoids a slight
   bias at block joins but makes the cursor a random length.
3. **Should MC default to `HISTORICAL_BOOTSTRAP`?** It matches history better than white
   noise on every measure in §2. It is not the default yet, because every existing MC
   result would move.
4. **Retire `MEAN_REVERTING` for equities?** Relabelled rather than removed, to keep saved
   studies loading. A later step could hide it behind an "advanced" flag.
