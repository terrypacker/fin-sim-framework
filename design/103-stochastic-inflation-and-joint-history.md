# 103 — A stochastic inflation path, and history's years sampled jointly

**Status: BUILT (13 Sep 2026), all phases (A1, A2, B1, B2).** Owner decisions are
recorded in §8, and what was built in §9.

This is design 102 §6's "Phase 2", and it absorbs the inflation path that design 74 §8 Q4
and design 75 §8 Q1 both deferred to a "design 76" that was never written. (Number 76 went
to AU per-person income attribution.) Joint sampling can't be built without an inflation
path, so the path comes first: Part A, then Part B.

Measurement: `scripts/probes/probe-inflation-joint.mjs` (the CSVs in
`docs/economic-shocks/data`).

---

## 1. What the engine does today

Inflation is **one constant rate per country per path**. `inflationRates[cc]` is seeded from
`inflationRate` / `auInflationRate`, regimes can add an `inflationAdjustment` for a window,
and `InflationAdjustReducer` compounds `inflationAccumulator[cc]` once a year from
`effectiveInflationRates[cc]`. Monte Carlo samples each country's rate once per path
(NORMAL, sd 1 point) and holds it for the whole run.

That one seam feeds everything priced in today's money: expenses, wages, Social Security,
tax-bracket projection (`bracketIndexAccumulator`), the AU CGT index (`cpiAccumulator`,
unless `cpiRates` is set), TIPS accretion, and house running costs (design 75 §5.1). A path
through `effectiveInflationRates` reaches all of them without touching any consumer.

## 2. What history shows

**US annual inflation by era:**

| era | mean | sd | persistence (ac1) | half-life |
|---|---|---|---|---|
| 1871–1913 gold standard | −0.3% | 7.3% | −0.13 | — |
| 1914–1950 wars + depression | +2.8% | 7.5% | +0.59 | 1.3 y |
| **1951–2023 post-war** | **+3.5%** | **2.8%** | **+0.72** | **2.1 y** |
| 1983–2023 after Volcker | +2.9% | 1.6% | +0.30 | 0.6 y |

**AU** (OECD CPI, Q4 year-on-year): 1951–2024 mean 4.8%, sd 4.4%, persistence +0.63; since
1993 (inflation targeting) 2.7% / 1.5% / +0.28. US–AU correlation since 1951: **+0.62** in
levels and **+0.35** in year-on-year changes. The two are related, but they aren't one
process.

**Cross-asset, same calendar year, 1951–2023:**

- Real equity against inflation: corr **−0.35**. In years with inflation above 5%, real
  equity averaged **−1.9%**, against **+11.3%** in the others (15 vs 58 years).
- Over rolling 10-year windows: corr(annualized inflation, annualized real equity) **−0.49**.
  10-year inflation ranged from 1.2% to 8.7%.
- Nominal equity against inflation: slope −1.1 (1951–2023), +0.06 (1983–2023). Stocks do
  **not** hedge inflation within the year.
- The 10-year yield change against inflation: corr +0.35.

What this means for the design:

1. **Persistence is the missing piece.** A constant per-path rate can't produce a high-
   inflation decade. The post-war half-life of about 2 years is an OU process on the
   inflation **level**. That's the correct use of `MEAN_REVERTING`; the equity misuse
   (design 102 §2) was applying it to a rate of change.
2. **The stagflation link is the one that hurts a retiree.** High inflation raises every
   expense while real equity returns fall. Two independent processes would miss the
   co-movement.
3. **Pre-1914 inflation is a different monetary world.** Joint sampling should draw from
   1951 onward (73 years), not the equity series' full 1871–2023.

## 3. Goals / non-goals

**Goals:** year-to-year inflation with realistic persistence, per country and correlated;
the equity–inflation–yield co-movement of real years; default runs byte-identical (every
path flag-gated and lazily scheduled, as in designs 67/74/102); Monte Carlo gets it by
default through an `mc*` switch, like `mcSequenceRisk`.

**Non-goals:** a macro model (output gap, policy rule); regime-switching Markov inflation;
separate wage or medical inflation series; linking the prime rate to inflation (design 56's
prime path is separate; see §8 Q6).

## 4. Part A — the inflation path

### 4.1 Process

Per country `cc`, an annual deviation `inflationDev[cc]` from the anchor
(`inflationRates[cc]`, i.e. the per-path MC draw):

    dev_t[cc] = e^(−k)·dev_{t−1}[cc] + σ[cc]·√(1 − e^(−2k))·z_t[cc]

Here `z_US` and `z_AU` are standard normals with correlation ρ. The `√(1 − e^(−2k))` scaling
makes σ the **stationary** sd, so the knob means "how far inflation wanders" whatever k is.
That fixes the reason the equity OU's σ was so easy to misread.

Proposed defaults, post-war calibrated (§8 Q1):

| | US | AU |
|---|---|---|
| stationary sd σ | 2.8% | 3.0% (post-war 4.4% includes the 1970s–80s AU spike; see Q1) |
| k (from ac1 0.72) | 0.33 | 0.33 (shared; AU measured 0.63 → k 0.46; see Q2) |
| correlation ρ of innovations | 0.35 (the year-on-year change corr) | |

The MC anchor draw (sd 1 point) stays. It's now "where inflation centres for this path",
and the path supplies the wandering around it, like `equityAnchorShift` plus the equity path.

### 4.2 Wiring — the equity/yield-curve template

- `InflationTickHandler` (annual, `INFLATION_TICK`), scheduled **only** when
  `inflationStochastic` is on. It draws from `sim.rng` and emits
  `INFLATION_STEP_APPLY { deviation: { US, AU } }`.
- `InflationStepReducer` (@CASH_FLOW) stores `state.inflationDev`.
- A fold, @PRE_PROCESS + 1.5 after RegimeApplyReducer, adds `inflationDev[cc]` onto
  `effectiveInflationRates[cc]`. That's where the equity and yield-curve deviations fold
  too, so regimes and the path compose. **Ordering check needed:** `InflationAdjustReducer`
  runs @PRE_PROCESS + 2 on the period advance, so the fold must have run by then on the
  same action. The design 67 yield-curve fold shows the pattern.
- **Floor:** the effective rate is clamped at a deflation floor (proposed −5%/yr) so a
  Gaussian tail can't produce a price level collapse no modern economy has seen (Q3).

No state key is seeded in `state()`; the cursor-free Gaussian needs only `inflationDev`,
written lazily. Goldens are byte-identical.

### 4.3 What moves when it's on

Every consumer in §1, with no consumer changes. Two need a look:

- **TIPS / I-bond accretion** reads `effectiveInflationRates`, so it now follows the path.
  That's correct, and it's the point of holding TIPS.
- **Tax brackets** index at CPI plus a spread, so a high-inflation path indexes brackets
  faster. That's correct for US (chained CPI) and AU (their own rules).

## 5. Part B — history's years, jointly

### 5.1 One historical year drives several processes

Joint sampling means that in simulated year t, **every** historical-mode process takes its
shock from the **same** historical year. That's what carries the co-movement. The equity
bootstrap already owns a block cursor (`state.equityReturnBootstrap`, design 102 §4.3).
Part B makes the other processes read it, the way the property path already reuses the
equity market factor (design 75 `shareMarketFactor`):

- **Equity:** unchanged, except that in joint mode its blocks start only in 1951–2023 (a
  `historicalWindow` of `POSTWAR` rather than `FULL`).
- **Inflation:** the handler fires after the equity tick (`order: 1`, as the property tick
  does). It reads the cursor's historical year and uses that year's **innovation** instead
  of a Gaussian z:

      dev_t[cc] = e^(−k)·dev_{t−1}[cc] + ε_hist[cc](year)

  `ε_hist` is the residual of the AR(1) fit to that country's post-war series, re-centred.
  Innovations rather than levels, because a block join would otherwise jump from a 1974
  level to a 1998 level in one year. With innovations, persistence stays continuous across
  joins, and inside a block the historical path is reproduced exactly (same φ, same
  residuals). US and AU innovations from the same year keep their measured correlation, so
  ρ isn't a parameter in this mode.
- **Yield level (optional, Q5):** `ΔGS10(year)` as the yield-curve OU's innovation, which
  brings the +0.35 inflation–yield link and the bond losses of 1970s-style years.

### 5.2 Nominal vs real equity

The engine's equity anchor is a **nominal** total return (design 99), and the bootstrap
supplies a **real** deviation. In joint mode, the equity deviation becomes
`realDev(year) + inflationDev_t[US]`, so a path's nominal return rebuilds history's
nominal return while the anchor stays the centre. Stagflation then shows up as both high
inflation and a low real return, as in 1973–74.

Outside joint mode (Gaussian inflation, any equity process), inflation doesn't pass through
to nominal equity. Real returns are then independent of inflation, which is a known
optimism (§2's −0.35 is lost). The joint mode is what fixes it (Q4).

### 5.3 Data

A second generated module, `historical-inflation.js`, built by extending
`scripts/dev/build-historical-equity-returns.mjs`: US CPI (Shiller, Jan→Jan, so its years
line up with the equity series), AU CPI (OECD, Q4 year-on-year, 1951–), GS10 change
(Shiller), and the fitted φ plus residuals per country. A test re-derives everything from
the CSVs, as design 102's does.

## 6. Monte Carlo

- `mcInflationPath` (Boolean, default **true**) turns Part A on in every path, exactly as
  `mcSequenceRisk` does for equity. It's a separate switch for the same loader reason.
- When `mcEquityReturnModel` is `HISTORICAL_BOOTSTRAP` and the inflation path is on,
  inflation runs in joint mode by default (Q4).
- The pairing record gains the inflation mode, so a before/after comparison across this
  change is flagged as unpaired rather than silently compared.

**This moves every MC result.** A persistent inflation path widens the spending
distribution, and the joint mode adds the stagflation co-movement on top. Both push failure
rates up. Plan a before/after run on a real plan before trusting either number.

## 7. Phases

1. **A1:** Gaussian inflation path (handler, reducers, fold, floor, params, state schema,
   tests), single-run flag, default off. Golden-neutral.
2. **A2:** MC default on (`mcInflationPath`), pairing record, before/after measurement.
3. **B1:** inflation data module + joint mode (inflation reads the equity cursor, POSTWAR
   window, innovation-driven), nominal pass-through in joint mode.
4. **B2 (optional):** yield level from `ΔGS10` innovations.

## 8. Decisions (owner, 13 Sep 2026)

1. **Calibration era: post-war.** US σ 2.8%, k 0.33. AU σ keeps the proposed 3.0% (its
   measured 4.4% is dominated by the 1970s–80s wage spiral and the 1951 wool boom).
2. **Two k's, same default.** `inflationReversionSpeedUs` / `…Au`, both 0.33. AU's own
   measurement (0.46) is noted in its description.
3. **Floor: yes,** −5%/yr (`inflationPathFloor`). It's applied in the fold, so it covers
   both modes; joint mode's real innovations never reach it.
4. **Joint is the MC default** whenever the MC equity process is the historical bootstrap
   (`mcInflationModel: AUTO`). Gaussian mode has no pass-through to nominal equity, as
   proposed.
5. **Bond yield link: included** (B2).
6. **Prime / cash rates:** first accepted as independent of inflation, then revisited: the
   owner had misread the question. **Superseded by design 104**: an optional "follows
   inflation" prime mode (either/or with the Prime Rate Schedule), on by default in Monte
   Carlo.

## 9. What was built

- **Data:** `historical-macro.js`, generated by the same script as the equity series
  (`scripts/dev/build-historical-equity-returns.mjs`) and re-derived from the CSVs in its
  test. It holds US inflation, AU inflation and US 10-year yield changes, 1950–2023.
- **Part A:** `InflationTickHandler` (annual `INFLATION_TICK`, order 2),
  `InflationStepReducer` (@CASH_FLOW), and `InflationPathReducer` (@PRE_PROCESS + 1.5, on
  RegimeApplyReducer's triggers, clamped at `state.inflationFloor`). Gaussian mode takes
  exactly four uniforms a year whatever ρ is. Params: `inflationStochastic`,
  `inflationModel`, `inflationPathVolUs/Au`, `inflationReversionSpeedUs/Au`,
  `inflationPathCorrelation`, `inflationPathFloor`.
- **Joint mode** (`jointInflationActive(p)`: inflation HISTORICAL_JOINT **and** the equity
  path on with HISTORICAL_BOOTSTRAP; otherwise it runs as Gaussian):
  - The equity bootstrap draws from a `POSTWAR` window (1951–2023, re-centred and
    drag-compensated on its own statistics).
  - Inflation takes the AR(1) residual of the cursor's year, rescaled to the model's
    innovation sd, with no RNG draw.
  - `equityInflationPassThrough` adds each market's local inflation deviation to its
    nominal return (`EQUITY_SLEEVE_COUNTRY`: US and ex-US take US inflation; AU and ex-AU
    take AU inflation).
  - With the yield curve stochastic, its tick fires after equity (order 3) and takes that
    year's ΔGS10, rescaled to `yieldCurveVol`, as its shock. AU takes the same-year US
    change, since there is no AU 10-year series before 1969.
  - A missing cursor, or a year outside 1951–2023, falls back to Gaussian for that year.
- **Monte Carlo:** `mcInflationPath` (default on) and `mcInflationModel` (`AUTO` /
  `SCENARIO` / `GAUSSIAN` / `HISTORICAL_JOINT`). `perturbParams` writes
  `inflationStochastic` and the resolved `inflationModel` into every path. Pairing records
  carry `inflationModel`, and the deterministic grid turns the path off.
- **Engine check** (`probe-inflation-joint.mjs` §4; 2000 paths × 40 years, POSTWAR equity
  bootstrap, US anchor at its post-war mean):

  | | persistence | sd | 10y inflation p5 .. p95 | real equity, inflation > 5% minus ≤ 5% |
  |---|---|---|---|---|
  | Gaussian | +0.63 | 2.5% | +0.8% .. +6.4% | +0.0 pts |
  | Historical joint | +0.65 | 2.6% | +1.0% .. +6.6% | **−11.4 pts** |
  | history 1951–2023 | +0.72 | 2.8% | +1.2% .. +8.7% (rolling) | **−13.2 pts** |

  Persistence and sd come out a little under history's because they are measured on
  40-year paths, which biases both down. Joint mode reproduces most of the stagflation gap;
  Gaussian mode, as designed, has none.
- **Not built:** the before/after MC measurement on a real plan (§6). It's a long run to
  schedule separately.
