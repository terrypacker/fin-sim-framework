# 131 — Gold's return drivers: inflation, real rates and replayed history

**Status:** COMPLETE (12 Nov 2026), rev 2. **Phases 1–2 BUILT** (§3.1.1 G1, §3.2.1 G2: both passed); **phase 4 (G4) RUN** 12 Nov (§5); **phase 3 NOT BUILT: G3 failed** (§4.1). The measurement step (§2) is done and reproducible
(`scripts/lab/gold-correlation.mjs`). Phase 3 is closed by its gate. The author decided Q1–Q6 the same day
(§7). Q1 came with a change: **the default volatility is history's, 29%**. Rev 2 writes that
into §3.2 and §3.5. Rev 1 was the proposal.

**Related:** design 121 §5–6 (the stagflation gold leg; gold's correlated draw, today's whole
gold model), design 102 §6 (the AU replay, the pattern §3.2 copies), design 103 §5 (joint mode:
inflation and yields replay the bootstrap's year; the equity inflation pass-through), design 129
(stock–bond ρ: a measurement-first design whose regime half failed its gate), design 125 (the
TIPS market real yield), design 56 §7 (the one `GOLD` rate key), design 61 Q4 (gold's location).

## 1. The problem

A household holds gold for what it does in bad worlds: inflation that bonds don't cover, real
rates that go negative, a falling dollar. Its expected return is below equity's, so with no bad
worlds gold always loses. The question "is gold worth holding" therefore turns entirely on
whether the model gives gold its bad-world behaviour. Today it mostly doesn't:

| what | today (confirmed in code, 12 Nov 2026) |
|---|---|
| Gold's stochastic part | `EquityReturnTickHandler` (design 121 §6.2): `z_gold = ρ·z_market + √(1 − ρ²)·ε`, `dev[GOLD] = goldReturnVol·z_gold`, around a fixed nominal `goldGrowthRate`. ρ = `goldEquityCorrelation`, default 0. |
| Gold and inflation | **No link in any mode.** In joint mode (the MC default whenever equity uses the bootstrap, design 129 §1) `InflationStepReducer` writes `equityInflationPassThrough` for `EQUITY_SLEEVES` only (`inflation-step-reducer.js:45`). Equity's nominal return rises with the replayed year's inflation; gold's doesn't. So when the default MC replays 1974 or 1979, gold earns its 5% nominal against 11–14% CPI, which is a real loss in the years gold is held for. **In the default MC gold is an inflation anti-hedge.** |
| Gold and real rates | No link. Nothing reads the yield curve, the inflation path or the TIPS real yield. |
| Gold in regimes | Only the stagflation preset moves gold (`returnAdjustment.GOLD` +5pp on `inflation`, +1.5pp on `inflationUsTail`). No crash preset carries a gold leg. |
| Deterministic runs | Gold grows at exactly `goldGrowthRate` (design 121 Q7). Not in scope here. |

So every MC result about a gold allocation so far measured a 2%-real, 15%-vol asset
uncorrelated with everything, except inside the stagflation shock, plus the
anti-hedge in high-inflation bootstrap years.

## 2. What history says

`node scripts/lab/gold-correlation.mjs` (add `--json <file>` for every number below). All series
are on the bootstrap's own convention: a year is January to January on monthly averages
(design 102 §4.1), so a gold row measured here is the row a replay would hand the engine.
Inputs are on disk: World Bank CMO gold (monthly, 1960–), FRED CPI-U, GS10, `FII10` (new, the
10-year TIPS yield, 2003–), the trade-weighted dollar (1973–2019), DEXUSAL, and the packaged
Shiller equity and joint-mode inflation residuals. Gold was pegged at \$35 until the two-tier
market of March 1968, so no window starts before 1969.

### 2.1 Gold's own distribution

| window | n | real geometric | real sd | nominal geometric |
|---|--:|--:|--:|--:|
| 1969–2024 (free market) | 56 | +3.6% | 29.3% | +7.7% |
| 1973–1982 (stagflation) | 10 | +12.4% | 59.5% | +22.1% |
| 1983–1999 (disinflation) | 17 | −6.1% | 13.0% | −3.0% |
| 1985–2023 | 39 | +2.2% | 14.3% | +5.0% |
| 2000–2023 | 24 | +5.8% | 14.7% | +8.5% |

One year dominates the tail: **1979 is +161% real**. Without it the 1969– sd is 20.6%. The
next largest are 1973 (+81%) and 1972 (+37%); the worst are 1981 (−36%), 1975 (−30%) and
2013 (−27%). (MEASUREMENTS §12c's Dec/Dec figures are lower, 22%, because Jan/Jan averaging
puts all of 1979's run inside one year.)

### 2.2 Correlation of gold's real return with each driver

Pearson ρ [Fisher 95% interval]. Blank = the driver's data doesn't cover the window.

| driver | 1969–2023 (n 55) | 1973–82 (10) | 1983–99 (17) | 1985–2023 (39) | 2000–20 (21) |
|---|--:|--:|--:|--:|--:|
| US equity real TR | −0.13 [−0.4, +0.1] | −0.24 | +0.06 | −0.02 [−0.3, +0.3] | +0.12 |
| AU equity real price | +0.14 | +0.31 | +0.16 | +0.17 | +0.19 |
| US CPI (level) | +0.35 [+0.1, +0.6] | +0.50 | −0.25 | −0.06 | +0.48 |
| US inflation surprise (joint mode's AR(1) residual) | +0.49 [+0.3, +0.7] | +0.75 | −0.06 | +0.05 | +0.36 |
| Δ US 10-year (nominal) | −0.01 | +0.07 | −0.34 | −0.20 | −0.17 |
| Δ real 10-year (GS10 − trailing CPI) | **−0.48 [−0.7, −0.2]** | −0.80 | −0.40 | −0.22 | −0.40 |
| Δ 10-year TIPS yield (2003–20: −0.70; 2003–23: −0.64 [−0.8, −0.3]) | | | | | −0.70 |
| Δ trade-weighted USD (to 2019) | | −0.33 | −0.77 | | −0.64 |

**Rank correlations (Spearman) split the drivers in two.** The real rate (−0.5 over 1969–2023)
and the dollar (−0.6) hold under ranks. The inflation measures don't: the CPI level falls from
+0.35 to 0.0 and the surprise from +0.49 to +0.2. A few extreme years carry the inflation link
(1973, 1974, 1979; §2.1), not the typical year.

### 2.3 The years the hedge claims are about (1969–2023)

| condition | n | gold real mean | gold up |
|---|--:|--:|--:|
| all years | 55 | +6.2% | 53% |
| equity real < −10% | 9 | +10.0% | 56% |
| equity real < −10%, since 1985 (2001, 2002, 2008, 2022) | 4 | +5.8% | 50% |
| inflation surprise > +1 sd | 8 | +35.9% | 75% |
| real 10-year < 0 at January | 11 | +13.0% | 45% |
| real 10-year > 3% at January | 18 | −1.8% | 39% |

### 2.4 Is the real-rate link stable?

OLS `gold real = a + b·Δreal10`, fitted on one half and scored on the other:

| fitted on | b | the other half's own b | out-of-sample R² |
|---|--:|--:|--:|
| 1969–1996 | −10.5 | −1.5 | −1.71 |
| 1997–2023 | −1.5 | −10.5 | +0.10 |

The **sign holds in both halves and in every era of §2.2, but the slope does not**: a 7×
difference, and the 1970s slope over-predicts the later half badly. Part of that is the measure.
The ex-post real rate subtracts trailing CPI, which is noisy (2021–22) and attenuates the slope.
On the market real yield (TIPS, 2003–2023) the fit is `b = −12.6` with R² 0.41 and residual sd
12%. The four-term fit (equity, surprise, Δreal) gives R² 0.28 over 1969–2023 and 0.10 over
1985–2023, and its inflation-surprise slope flips sign between them (+4.0, −3.2).

### 2.5 Forward-looking cross-check (J.P. Morgan LTCMA 2026, USD matrix on disk)

Gold: compound 5.5%, volatility 16.7%. Correlations: US large cap +0.03, US inflation −0.01,
TIPS +0.46, intermediate Treasuries +0.36, commodities +0.34. These agree with §2.2's since-1985
column: about zero with equity and with the inflation level, and strongly tied to real rates (a
TIPS price rises when its yield falls).

### 2.6 What the measurement decides

1. **Keep ρ(gold, equity) at 0.** Every interval includes 0, and JPM says +0.03.
2. **Gold is not a reliable crash hedge.** In crash years it is a coin flip (50–56% up). The
   +10% mean comes from 1973–74. **Don't add gold legs to crash presets.**
3. **The robust driver is the real rate.** The sign is negative in every era and in both halves.
   The size is not stable enough to hard-code one slope (§2.4).
4. **Inflation matters through surprises, only in some eras, and only in the extreme years.**
   +0.75 in the 1970s, about 0 since 1985, and +0.2 by rank across 1969–2023 (§2.2). The neutral baseline is that gold's nominal return moves one-for-one with
   inflation, as equity's already does in joint mode. History paid more in the 1970s, and that
   is what a replay would carry.
5. **Gold in A\$ is nearly gold in US\$ at annual horizon** (ρ 0.93; sd 33.5% vs 34.3%). Its
   correlation with AU equity is +0.09. The existing FX overlay on AU-held gold (design 121 §6.1)
   is enough.
6. **The only mechanism that reproduces history's joint behaviour exactly is to replay it.**
   That matters because the joint behaviour is unstable across eras.

## 3. The design

### 3.1 Gold inflation pass-through in joint mode (phase 1)

Add `GOLD` to the joint-mode pass-through: `InflationStepReducer` writes the US inflation
deviation for `GOLD` beside the equity sleeves, and `EquityReturnReducer` adds it to gold's
nominal rate the way it does for equity (design 103 §5.2). Gold is USD-priced, so US inflation
is the reference, the same rule as the stagflation leg (design 121 §5).

- This makes gold a **real** asset in joint mode: its real return no longer falls when a
  high-inflation year replays. It's the neutral one-for-one baseline of §2.6 (4), and it removes
  the anti-hedge in §1.
- It is independent of §3.2 and worth having even if the replay is rejected.
- Blast radius: every joint-mode MC of a plan holding gold. Deterministic runs and the
  Gaussian modes are unchanged, since pass-through only exists in joint mode.

#### 3.1.1 As built (phase 1, 12 Nov 2026, branch `design-131-gold-return-drivers`)

- **One writer change.** `InflationStepReducer` adds `GOLD: deviation.US` to
  `equityInflationPassThrough` (`GOLD_INFLATION_COUNTRY = 'US'`). `EquityReturnReducer`
  needed nothing: its `FOLDED_KEYS` already listed `GOLD` and already read `pass[GOLD]`.
  Nothing ever wrote that entry. The fold also reaches every `GOLD::<stateKey>` variant, and it
  applies when there is no gold draw at all (`goldReturnVol` 0).
- **G1 passed.** `tests/unit/evt-gold-inflation-pass-through.test.mjs` GIP-5: joint mode, 4
  seeds × 42 years (168 path-years, US inflation up to 26%), `goldReturnVol` 0 so gold's own
  noise is out. Slope of log real gold on log(1 + inflation): **−1.000 before** (read off the
  same runs as nominal minus the pass-through), **−0.018 after**. The residual is the
  `log(1.05 + d) − log(1.03 + d)` curvature. The gate is measured in logs because the
  counterfactual `1.05 / (1 + i)` is only linear there; in levels it read −0.88 on the same
  paths, because the 1970s rows sit on the flat part of the curve.
- GIP-1..4: the reducer writes US, never AU; the fold adds it (including the per-account
  variants and the no-draw case); e2e joint mode carries it; WHITE_NOISE equity gets none.
- Help: `stochastic-return-paths` says it in one sentence, and the paragraph was tightened to
  stay inside the 400-word budget.

### 3.2 Gold replay in historical years (phase 2)

When the equity bootstrap replays a year that has a gold row (1969–2023), gold takes **that
year's** real deviation instead of the `ρ·z + ε` draw:

    dev[GOLD] = (g_y − ḡ_window) · s,      s = goldReturnVol / sd_window   (Q1)

- `g_y` is gold's real Jan/Jan return for the replayed year, packaged by
  `build-historical-equity-returns.mjs` beside the AU series, and `ḡ_window`/`sd_window` are
  its mean and sd over the gold window (Q2).
- With §3.1 on, the model adds that year's replayed inflation on top. So in joint mode gold,
  equity, inflation and the 10-year all come from the **same historical year**, and every
  cross-correlation in §2.2 (real rate, surprise, dollar, equity) is history's by construction.
  None of it needs a fitted coefficient, so none of it is exposed to §2.4's instability.
- This is design 102 §6's AU replay applied to gold: re-centred so `goldGrowthRate` stays the
  anchor, and rescaled so `goldReturnVol` stays the dial. The GEOMETRIC σ²/2 compensation uses
  the series' measured drag, as for equity.
- **The default is history's own scale (Q1, rev 2).** `goldReturnVol` defaults to the 1969–
  window's measured sd, **0.29** (29.3% real, §2.1), so out of the box `s = 1` and a replay year
  is exactly history's year: 1979 is 1979. An explicit value rescales. 0.15, the since-1985
  figure and design 121's default, is the "calmer gold" setting. §3.5 has the parameter
  change.
- **Coverage.** The joint window (POSTWAR, 1951–) has 73 years, 55 with gold. The FULL window
  (1871–), the bootstrap's own default when joint mode is off, has 153, of which 55 are gold
  years. The other years fall back (§3.3). Replay runs in any bootstrap year with a gold row (Q6).
- Draws: a replay year takes no `ε`. The gold stream is keyed (`keyedRng('gold', year)`), so
  skipping it shifts nothing else. That's the AU replay's rule, which skips the idio draw.

#### 3.2.1 As built (phase 2, 12 Nov 2026)

- **The series** is `src/finance/economic-regimes/historical-gold.js`
  (`HISTORICAL_GOLD_RETURNS`, 1969–2023, 55 rows). It's generated by
  `build-historical-equity-returns.mjs` from the World Bank monthly gold, deflated by **Shiller's**
  CPI over the same January-to-January months, the CPI joint mode replays. (The §2 script
  deflates by CPI-U from FRED, so its figures differ in the third digit. 1979 is +160.8% here.)
  Re-running the generator leaves the two existing modules byte-identical.
- **The handler.** `HISTORICAL_GOLD_SERIES` (re-centred, sd 0.2939, dragVar 0.0606) and
  `DEFAULT_GOLD_RETURN_VOL` = the sd rounded to the percent, **0.29**, both exported from
  `equity-return-tick-handler.js`. `gold.replay` picks the branch: `dev = row · vol/sd`, with
  drift `s²·dragVar/2` (3.0 points at the default, against 4.2 for a 0.29 Gaussian draw, because
  history's skew makes its geometric drag smaller than σ²/2). No ε is drawn.
- **Params** (§3.5): `goldReturnVol` defaults to `DEFAULT_GOLD_RETURN_VOL` (and the MC row is
  re-centred on 0.29, sd 0.05, still disabled); `goldReplay` Boolean, default true, shown under
  the bootstrap. The description says 29% is history's figure, that 0.15 is the calm since-1985
  figure, and what 29% means for a bad year.
- **G2 passed** (`node scripts/lab/gold-model-check.mjs --seeds 40`, the synthetic plan in joint
  mode with `rngStreams`, 1,680 path-years). The model's own rates, on the 1,321 gold-row years:

  | | ρ(equity) | ρ(inflation) | ρ(Δ real rate) | real sd |
  |---|--:|--:|--:|--:|
  | history 1969–2023 (§2.2) | −0.13 [−0.4, +0.1] | +0.35 [+0.1, +0.6] | −0.48 [−0.7, −0.2] | 29.3% |
  | model, replay on | −0.15 | +0.33 | −0.60 | 27.9% |
  | model, replay off (`--no-replay`) | +0.01 | +0.04 | +0.02 | 28.3% |

  Every replay correlation is inside history's interval, and the realised sd is within 1.1 points
  of the 0.29 target. Replay off loses all three links, which is the gap this design exists to
  close. The 359 pre-1969 rows are **identical in both arms**, confirming that skipping ε in replay
  years moves no other draw. (Model Δ real rate = this year's `FIXED_INCOME_US` minus US
  inflation, less last year's.)
- Tests: `tests/unit/evt-gold-replay.test.mjs` GRP-1..7 (the series against the CSVs; re-centring
  and the default; the replay branch draws no ε; fallback in pre-1969 years, with replay off and
  under WHITE_NOISE; the drift; the params reaching the replay end to end; the defaults end to end).
- Help: `stochastic-return-paths` rewritten for the replay and restamped; `goldReplay` cited.
- **Goldens.** Only `two-security-concentration` (the one stochastic golden, which holds no gold)
  moved: 29 fields, every one a GOLD key (`equityReturnDev`, its drift, the month shape,
  `effectiveGrowthRates.GOLD`). The deviation scales by exactly 0.29/0.15. Regolded; no balance
  moved. The suite is green (7,829 unit + 1,855 viz).

### 3.3 Fallback years and Gaussian modes (phase 3, gated)

In a year with no gold row, and in every non-bootstrap run, gold keeps today's draw. The
proposal is an optional real-rate term, behind its own gate (§4 G3):

    z_gold = ρ_eq·z_eq + ρ_r·z_real + √(1 − ρ_eq² − ρ_r²)·ε

- `z_real` is the year's standardised innovation in the model's own US real yield: the yield
  tick's level change minus the inflation tick's change in deviation, both already drawn on
  31 Dec. (design 125's `tipsRealYield` is a level, not an innovation, but it gives the same
  sign.)
- It's stated as a **correlation** (`goldRealRateCorrelation`, default 0 = today), not a slope.
  A correlation keeps `goldReturnVol` exact whatever the yield vol is, and the measured
  correlations are steadier than the slopes (−0.22 to −0.80 against slopes of −1.5 to −10.5).
- Ordering: the gold draw must follow the yield and inflation ticks. That means moving it out of
  the equity tick into its own year-end handler with an explicit order after both (the event
  queue orders by `(date, order, instanceId)`). An unordered handler would read last year's
  innovations.
- With `yieldCurveStochastic` or `inflationStochastic` off, `z_real` is 0, and the term must
  then draw nothing, so the run is byte-identical (design 74 §4's rule).
- In joint mode's fallback years the yields and inflation are history's anyway, so the same
  term gives a link that is consistent with the replay years around them.

### 3.4 Regimes

- **No crash-preset gold legs** (§2.6 (2)).
- The stagflation leg stays. It moves gold's *centre* in deterministic runs, which neither §3.1
  nor §3.2 touches. In MC it composes with the replay: the leg sets the centre, history the
  noise. It doesn't double count, because the replay is re-centred on its own mean.
- §3.3's real-rate term reads innovations only, never a regime's deterministic rate legs (Q4).

### 3.5 Parameters (rev 2)

| param | change |
|---|---|
| `goldReturnVol` | Default **0.15 → 0.29**, the measured 1969– real sd, rounded. The description must say so in words: "29% is gold's measured volatility since 1969 and the default. In historical years it replays history unscaled. 0.15 is the calmer since-1985 figure." It applies to replay years (as the rescale target) and to every other year's draw (as its vol), so a path's volatility doesn't change between replay and fallback years. Its MC row stays `enabled: false`. |
| `goldReplay` (new, ECONOMIC_REGIMES, Boolean, default **true**, shown when `equityReturnModel` is `HISTORICAL_BOOTSTRAP`) | Off = today's `ρ·z + ε` draw in every year, for A/B work (Q5). |

- **Saved plans keep their own value.** An export stores every param it saw, so a plan saved
  before rev 2 carries `goldReturnVol: 0.15` explicitly, and the new default never reaches it.
  That is correct (a stored value is the owner's), but it means existing plans stay at the calm
  setting until someone changes it. The editor should show the default beside the field. (Not
  built: the Scenario editor's rows don't carry schema defaults, so this is a general editor
  feature for every param, not a gold one. Today the default shows in the `?` help panel and in
  `goldReturnVol`'s description.) G4's
  arms set it explicitly so the study isn't measuring a stale value.
- **The drift compensation grows.** At 0.29 the GEOMETRIC σ²/2 term is about 4.2 points, so the
  arithmetic mean gold return sits that far above `goldGrowthRate` to keep the CAGR at the
  anchor. (Under the replay it is the series' measured drag instead, 3.0 points, §3.2.) The
  anchor doesn't move. The spread does, a lot: at 29% a one-in-ten bad year loses about a
  quarter of gold's value (ln 1.05 − 1.28 × 0.29 ≈ −0.32 in logs, −27%). History agrees: the
  5th and 6th worst of 55 years are −26%. (Rev 2 first said "half", which was wrong.) That is
  the point of the default, and the help topic must say it.
- **Blast radius of the default:** new plans, and any plan that never stored the param. Every
  stochastic run of such a plan that holds gold gets a wider gold distribution. Deterministic
  runs are unchanged (design 121 Q7).

## 4. How the choices are proved

Each gate is a script run, and its output gets written into this doc before the next phase starts.

| gate | test | pass |
|---|---|---|
| **G0** measurement | `gold-correlation.mjs` reproduces §2 from the files on disk | identical tables (the JSON is the record) |
| **G1** pass-through (phase 1) | in-model, joint-mode MC paths (≥ 2,000 path-years, synthetic plan): correlation of gold's **real** model return with the model's US inflation deviation | the slope of gold's real return on the inflation deviation goes from ≈ −1 (today: nominal fixed, so real falls one-for-one) to ≈ 0; deterministic goldens byte-identical; stochastic goldens move only `GOLD` keys |
| **G2** replay (phase 2) | the same paths, the statistics of §2.2 recomputed on the **model's** gold, equity, inflation and 10-year | every replayed-year correlation inside §2.2's 95% interval for 1969–2023, and the realised gold sd within 1 point of `goldReturnVol` |
| **G3** real-rate term (phase 3) | split-sample: fit ρ_r on 1969–1996, score on 1997–2023 and the reverse, on the model's own real-yield innovation | sign holds both ways **and** out-of-sample R² > 0 both ways; otherwise phase 3 is not built (design 129's precedent) |
| **G4** decision | a paired MC study (`rngStreams`, n ≥ 400) of gold 0% / 5% / 10% across calm, crash and inflation regimes, before and after | the study's result, not this doc, decides the allocation |

G3 is a real risk. §2.4 already fails a slope version of it on the ex-post real rate. If it
fails, the replay plus pass-through carries the real-rate link in joint mode (the MC default),
and the Gaussian modes keep today's draw.

### 4.1 G3 result (12 Nov 2026): FAILED, phase 3 not built

`gold-correlation.mjs` section 8 scores the term exactly as §3.3 would apply it: a mean-zero
`ρ_r · vol · z_real`, vol 0.29, `z_real` the half's Δ real 10-year standardised by its own sd.
The rule was written into the script before the run.

| fitted on | ρ_r fitted | the other half's own ρ | out-of-sample R² (vol 0.29) | at the test half's own sd |
|---|--:|--:|--:|--:|
| 1969–1996 | −0.63 | −0.22 | **−0.94** | −0.11 |
| 1997–2023 | −0.22 | −0.63 | +0.18 | +0.23 |

The sign holds both ways, but the 1970s–80s link is three times the later one. Fitted on the
early half, it predicts the later half worse than the later half's own mean does. The
correlation form fails like §2.4's slope form, just less badly. So the replay (§3.2) stays the
only real-rate mechanism. It covers bootstrap years from 1969, which is the MC default. Gaussian
modes and pre-1969 bootstrap years keep the `ρ·z + ε` draw. `goldRealRateCorrelation` is not
added, and the §3.3 handler move is not needed.

## 5. Phases

0. **Measurement.** Done: the script, `FRED-FII10` fetched and recorded in
   `docs/economic-shocks/SOURCES.md` and `fetch-sources.sh`.
1. **Pass-through** (§3.1) + G1. Small, independent.
2. **Replay** (§3.2) + the §3.5 params (`goldReturnVol` 0.29, `goldReplay`): package the gold series in `build-historical-equity-returns.mjs`, the
   replay branch, G2, a help topic update (`stochastic-return-paths`).
3. **Real-rate term** (§3.3), only if G3 passes. **Closed 12 Nov: G3 failed (§4.1), not built.**
4. **G4**, the decision study. Run 12 Nov on the author's plan, before phase 3 (the private study
   holds the numbers). Gold's sleeve lowered the failure rate in every one of eleven calm, crash and
   inflation regimes, under both the old and the new draw, and with gold's return anchor cut by
   2pp. The anchor decides only whether gold also wins the median in calm worlds. Running it
   found a product bug: an authored `pool.<id>.targetScale` was overwritten by its generated 1.0
   centre in MC, optimizer and grid bases (fixed, `withLiquidityAxisCenters`). Phase 3 stays gated
   on G3.

## 6. Out of scope

- `goldGrowthRate`'s default (5% nominal; JPM 5.5%; 1985–2023 history 5.0%). That's a separate
  question about sources.
- Gold's month shape under MONTHLY earnings. The World Bank monthly series could supply
  history's months the way the equity rows do (design 127 §4.7). Today's Brownian bridge stays.
- Deterministic gold volatility (design 121 Q7 stands).

## 7. Decisions (12 Nov 2026)

All six decided by the author on 12 Nov 2026.

- **Q1. Rescale the replay to `goldReturnVol`.** The dial and the MC axis stay, along with
  history's sign, rank and co-movement. **Rev 2: the default is history's 29%**, so the default
  replay is unscaled (§3.2, §3.5). Rev 1 recommended keeping 0.15.
- **Q2. The gold window is 1969–** for the rows, the re-centring mean and the sd. It keeps the
  1970s, the years the hedge is about. The post-Bretton Woods re-pricing that design 121 §5
  kept out of the stagflation *leg* is in the *replay* on purpose: it is one historical year
  among 55, drawn like any other.
- **Q3. Pass-through is one-for-one** (§3.1). The 1970s' extra inflation response arrives through
  the replay, and the fitted betas flip sign (§2.4).
- **Q4. §3.3's real-rate term reads innovations only**, not regime rate legs. Deterministic
  runs stay unchanged, and the stagflation gold leg stays the only regime effect on gold.
- **Q5. The replay is always on with the bootstrap**, like `auReplay`, with `goldReplay`
  (default true) to switch it off for A/B work (§3.5).
- **Q6. Replay in any bootstrap year with a gold row**, joint mode or not. The help topic says
  that the replayed year is paired with its own inflation only in joint mode (the MC default).
  Outside it, the replayed real return sits on the model's own inflation path.
