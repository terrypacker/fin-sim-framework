# 133 — Historical bootstrap: the history window and a pinned start year

**Status:** ACCEPTED (18 Nov 2026), rev 2. **Phases 1–3 BUILT** (§9.1–§9.3). Phase 4 not started.
All five questions are decided (§11). Rev 2 records the decisions (a 50-year window floor,
a 15-year shading threshold) and corrects §2 point 2 and flag F1. Rev 1 read post-war
history's variance ratios as the default Monte Carlo's, and the phase 1 probe showed they
aren't (§2.1).

**Related:** design 102 (the historical block bootstrap: algorithm §4.3, re-centring §4.2,
vol rescale §4.4, the AU replay §6, Q1–Q4), design 103 §5 (joint mode: inflation and the
10-year yield replay the bootstrap's year, and the POSTWAR window), design 131 §3.2 (gold
replay), design 107 §15.5 (year-keyed RNG substreams), design 100 (paired MC A/B and the
pairing record), design 98 (the sweepable parameter surface).

## 1. The problem

There are two things a user can't do with the historical bootstrap today, and they get
asked as one question ("why can't I pick a start year?"):

- **A. Choose which history is sampled.** The bootstrap draws from a window. Two windows
  exist (`HISTORICAL_BOOTSTRAP_WINDOWS` in `equity-return-tick-handler.js`): `FULL`
  (1871–2023) and `POSTWAR` (1951–2023). The toolset chooses between them with a rule the
  user can't see or change: `window: joint ? 'POSTWAR' : 'FULL'`
  (`economic-regimes-toolset.js`). Joint inflation is the Monte Carlo default whenever the MC
  equity process is the bootstrap (`mcInflationModel` = AUTO), **so the default MC samples
  1951–2023 only.** No parameter, panel or help topic says so.
- **B. Choose which history a path lives through.** Every block's start year is a uniform
  draw, including the first one. So a plan can't be asked "what if I retire into 1966?", or
  "into 1929?", or "into 2000?". These are the classic sequence-of-returns stress tests
  (Bengen's rolling-start method; cFIREsim and FIRECalc are built on it). Dated shocks
  (design 121) are this engine's stress tool, but a shock is a stylised leg. It isn't
  history's own run of years, with that era's inflation and yields alongside it.

These are different features with different value. A is a sensitivity control on how the
distribution is shaped. B is a named, explainable stress scenario. This design covers both
and keeps them separate.

## 2. What a window can change (measurement)

The bootstrap re-centres each window on its own mean and rescales its deviations to
`equityReturnVol` (design 102 §4.2, §4.4). So **a window can't change the mean or the
volatility a plan sees.** Those stay with the anchor and the vol parameter. All a window
changes is history's *shape*: whether neighbouring years are correlated, the multi-year
pull-back, and the crash tail. The table measures that shape on the bundled real S&P 500
series (`HISTORICAL_EQUITY_RETURNS`), for windows that start in the year shown and end in
2023. ac1 and the variance ratios are on simple returns here; skew and excess kurtosis are on
log returns. "Worst 10y" is the deepest 10-year run of
standardized, re-centred log deviations, in σ units.

| from | years | geo mean | sd | ac1 | VR5 | VR10 | skew | xkurt | worst 10y (start) |
|---|---|---|---|---|---|---|---|---|---|
| 1871 (`FULL`) | 153 | 6.9% | 0.178 | −0.00 | 0.85 | 0.77 | −0.63 | 0.47 | −6.5 (1999) |
| 1900 | 124 | 6.7% | 0.187 | 0.02 | 0.89 | 0.82 | −0.64 | 0.29 | −6.0 (1999) |
| 1926 | 98 | 7.1% | 0.191 | 0.01 | 0.76 | 0.71 | −0.67 | 0.37 | −6.1 (1999) |
| 1951 (`POSTWAR`) | 73 | 7.3% | 0.163 | −0.03 | 0.97 | 1.02 | −0.81 | 0.62 | −7.3 (1999) |
| 1970 | 54 | 6.5% | 0.166 | −0.03 | 0.96 | 0.85 | −0.97 | 0.44 | −6.5 (1999) |
| 1984 | 40 | 8.2% | 0.161 | −0.04 | 0.92 | 0.85 | −1.09 | 1.02 | −7.8 (1999) |

What this decides:

1. **A window is a shape lever, and a modest one.** Year-to-year independence (ac1 ≈ 0)
   holds in every window. What moves is the tail: log skew deepens from −0.63 (FULL) to
   about −1.0 for windows that start after 1970. The geo-mean column never reaches the plan,
   because re-centring removes it. **"Start in 1970" doesn't mean "lower returns."** The help
   text and the panel have to say this, or users will read the control as a pessimism dial.
2. **Post-war history shows no pull-back by VR, but the default MC still has one** (rev 2;
   rev 1 said the opposite, §2.1). POSTWAR's own VR5 is 0.97 and its VR10 is 1.02. That isn't
   independence. It's a negative lag-2 autocorrelation (−0.15) offset by positive lags 3 and
   4 (+0.13, +0.18). A 5-year block keeps lag 2 in 60% of year pairs and lag 4 in only 20%,
   so the bootstrap on POSTWAR keeps most of the negative part and little of the positive
   one. **Caveat:** with only 73 years, the sampling error of VR10 is about ±0.4 (VR5 about
   ±0.26), so none of these window differences is statistically distinguishable. The point
   is that design 103 moved the MC default onto POSTWAR without re-measuring it, and nobody
   chose that. It's flag F1 (§10).
3. **Short windows give fewer distinct sequences.** FULL has 124 complete 30-year
   sequences. POSTWAR has 44, and a window starting in 1984 has 11. The bootstrap breaks
   these into 5-year blocks, so it can still produce many paths. But the pool of distinct
   blocks shrinks to the window's length, so the tails come from a handful of episodes. A
   floor on window length is required (§3.2). The decided floor is 50 years (§11 Q2).
4. **The worst starting years cluster.** On FULL, the deepest 15-year runs, in standardized
   re-centred terms, start in 1906 (−7.5σ), 1964–68 (−5.8 to −6.6σ) and 1905. The best start
   in 1949–50 and 1985. This is the list B exists to replay. The 1929 crash comes out
   shallower over 15 years than 1966, because 1966's damage is a long real grind while
   1929's partly recovers inside the window.

### 2.1 What the engine replays from each window (phase 1, G-A3)

`node scripts/probes/probe-equity-process-fit.mjs --from <year>` (phase 1) runs the real
`EquityReturnTickHandler` on the window that starts in that year: 2000 paths, each as long as
the window, at the window's own anchor and sd. All the columns are on log returns. A VR
measured on a path this short is biased low even for independent years, so white noise on
the same path length is the yardstick, not 1.

| from | | sd | VR5 | VR10 | skew |
|---|---|---|---|---|---|
| 1871 | history | 0.172 | 0.86 | 0.78 | −0.63 |
| | bootstrap, block 5 | 0.171 | 0.86 | 0.78 | −0.62 |
| | white noise | 0.170 | 0.97 | 0.92 | −0.50 |
| 1926 | history | 0.185 | 0.78 | 0.75 | −0.67 |
| | bootstrap, block 5 | 0.183 | 0.86 | 0.73 | −0.65 |
| | white noise | 0.183 | 0.93 | 0.86 | −0.51 |
| 1951 | history | 0.159 | 0.99 | 1.07 | −0.81 |
| | bootstrap, block 5 | 0.158 | 0.84 | 0.75 | −0.78 |
| | white noise | 0.153 | 0.91 | 0.82 | −0.39 |
| 1970 | history | 0.166 | 0.99 | 0.89 | −0.97 |
| | bootstrap, block 5 | 0.163 | 0.81 | 0.67 | −0.93 |
| | white noise | 0.157 | 0.87 | 0.71 | −0.38 |

- **The tail is the window's own.** The bootstrap's skew is within 0.04 of every window's
  history, and white noise is far off. This is the shape a window choice really changes.
- **The pull-back is block length 5's, not the window's.** Measured against white noise at
  the same length, the default MC (1951) runs VR10 0.07 below independent years, about half
  of FULL's 0.14. It is not a world without pull-back, and it is not post-war history's VR
  either (above white noise). Block length 5 was fitted on FULL (design 102 §2) and nobody
  re-fitted it for POSTWAR. That's still within sampling error, so it's a note for phase 2,
  not a fix (§10 F1).

## 3. Part A: the history window

### 3.1 The parameter

`equityReturnBootstrapFromYear`: a year, blank by default. Blank keeps today's rule exactly
(FULL, or POSTWAR under joint mode), so every saved plan and every golden is unchanged. A
year Y builds the window Y–2023 with `bootstrapWindow(Y)`, which already takes any year.
Each window is re-centred and drag-compensated on its own statistics, and wraps within
itself (design 102 §4.3, unchanged).

There's no end year. Cutting the recent past out of the sample has no defensible use, and
one year is easier to explain than two. If one is needed later, `bootstrapWindow` gains a
`toYear` argument and nothing else changes.

### 3.2 Rules

- **Earliest 1871, latest 1974.** A window shorter than 50 years is refused at compile with
  a message that names the floor (§2 point 3, §11 Q2).
- **Joint mode needs 1951 or later.** Inflation and yield history start in 1951 (design 103
  §5.3). A joint run with Y < 1951 would replay pre-1951 equity years against Gaussian
  inflation, because `jointWindowIndex` returns −1 for those years and the inflation tick
  falls back to its normal draw. That quietly breaks the point of joint mode. So under joint
  mode the effective start is max(Y, 1951), and the loader warns when it clamps. A user who
  wants pre-war years sets the MC inflation process to GAUSSIAN, just as design 129 asks for
  the stock–bond ρ.
- **AU and gold coverage.** The AU replay starts in 1958 and gold replay in 1969. Earlier
  years draw from the model, as today. The param description says how much of the chosen
  window is AU-replayed and gold-replayed ("from 1926: 66 of 98 years carry AU history").
- **The pairing record carries the window.** `mcEquityModel` already goes into the pairing
  record (`mc-grid-runner.js`, `intl-retirement-mc-runner.js`). The resolved window's first
  year joins it as `equityWindow`. `mc-analysis.js` flags two batches with different windows
  as unpaired, just as it does for different equity processes.
- **Sweepable in MC (design 98):** yes, as a Monte Carlo **grid axis only** (§9.2). The
  sensitivity check is "rerun my plan on 1871, 1926, 1951 and 1970" as one paired grid. It's
  a discrete axis, and every value runs the same path seeds. It's never a per-path draw in a
  batch, because the pairing record holds one window per batch, and never an optimizer
  lever, because picking the best era is cherry-picking history.

### 3.3 Help and UI

The Monte Carlo panel shows the window in force next to the equity process, including when
it's automatic ("1951–2023, automatic: joint inflation"). This alone removes the hidden rule
from §1. The `stochastic-return-paths` help topic gains a section on what a window can and
can't change (§2 point 1) and gets restamped.

## 4. Part B: a pinned start year

### 4.1 Semantics

`equityReturnBootstrapStartYear`: a year, blank by default (blank = random, as today). When
it's set, the path's **first** block starts at that year. The years then replay **in order**
for `equityReturnBootstrapStartRun` years (blank by default = through to 2023). After the
run, the bootstrap goes back to ordinary random blocks drawn from the window.

- **No wrap.** A pinned run stops at the end of the series. It never wraps from 2023 back to
  the window's first year, because "1994, 1995, …, 2023, 1951" isn't a sequence that
  happened. The cursor's `remaining` is capped at `2023 − Y`.
- **The pinned run reads the whole series, not the window.** A pinned 1929 under a POSTWAR
  window still replays 1929. The window governs only the random blocks after the run.
  `_bootstrapStep`'s in-window check must not cut a pinned run short. The run's deviations
  are re-centred and rescaled with the **window's** mean and sd, so one centre holds for the
  whole run.
- **Joint mode follows the replayed year,** as it already does. A pinned 1966 brings the
  1970s inflation surprises and yield changes with it. That's the main reason B beats a dated
  shock. A pinned year before 1951 under joint mode replays its equity, and the inflation
  tick uses its Gaussian fallback for those years (§3.2). That's acceptable here, because
  the user picked the year by name. The loader warns once ("1929–1950 have no inflation
  history; inflation is drawn for those years").
- **AU and gold** replay the pinned year wherever they have data (1958+ / 1969+), as for any
  replayed year.
- **Re-centred, like every other replay.** A pinned 1966 is 1966's *pattern* around the
  plan's anchor, not 1966's actual returns. §6 covers the raw alternative.

### 4.2 Single runs and Monte Carlo

- **Single run** (with Stochastic Equity Returns on and the bootstrap model): one named
  historical sequence, deterministic once seeded. This is the stress test.
- **Monte Carlo:** the param passes through `perturbParams` like any other base param, so
  **every path shares the pinned prefix** and differs only after it. That's a conditional
  MC: "given my first 15 years are 1966–80, how does the rest go?". It's useful, and it's
  also a large change in meaning. The MC panel prints it in the run header, and the pairing
  record carries `equityStart` so a pinned batch never pairs with an unpinned one.
- **RNG:** the first block still draws (and discards) its uniform. On year-keyed substreams
  (design 107 §15.5) later draws are keyed by calendar year anyway. On the shared cursor,
  draw-and-discard keeps every other consumer's draws in the same place as the unpinned run.
- **Snapshots, MPC and optimizer rollouts** resume from `state.equityReturnBootstrap`, and
  that cursor already holds `remaining`. A pinned run is a block with a long `remaining`, so
  rollouts started mid-run continue it with no new state. The cursor gains one field,
  `pinned: true`, written only when the run is pinned. It lets the in-window check and the
  no-wrap cap know, and a watchlist can show it. Default runs never write it, so goldens stay
  byte-identical.

### 4.3 The rolling-start sweep

A single pinned year answers "what about 1966?". The classic rolling-start study answers
"which starting years does my plan survive?". It runs the plan once per start year and reports
by year. Build it as an MC sampling mode, not a new tool, because the MC already runs n
paths, summarises them and pairs them:

- `mcEquityBootstrapStarts`: `RANDOM` (default, today) or `ROLLING`. Under ROLLING, path i
  pins its start year to the window's first year + (i mod the number of start years). The run
  length is the plan's horizon, capped at 2023 as in §4.1. Each path stamps its start year
  onto its row, and the result panel adds a "by start year" strip: success, the worst year
  of funding, and terminal wealth for each start year.
- There is one start year per year of the window. Start years near 2023 get a short pinned run
  and then random blocks. The strip shades years whose pinned run is shorter
  than 15 years, so a reader can see where history stops carrying the result. 15 years is
  where sequence risk mostly lives (§11 Q4, decided).
- The CLI gets it for free through `mc-run` (`--equity-starts rolling`), since the mode is a
  param.

## 5. Interactions

- **Block length.** Part A doesn't change how it's used. In Part B it governs only the random
  blocks after the pinned run.
- **Dated shocks and regimes** stack on top of the pinned run exactly as on any bootstrap
  year. History already holds its crashes, so a dated crash on a pinned 2000 is a deliberate
  double stress.
- **Property** reuses `state.equityReturnMarketDev`, so it rides the pinned run too. That's
  the same approximation design 102 §4.5 documents.
- **Other equity processes.** Both params are ignored unless the bootstrap is the active
  process. As built (§9.2), `visibleWhen` hides the window param unless the single-run or the
  Monte Carlo equity process is the bootstrap, which keeps it off the grid's axis list too.
  It isn't registered with the lever-inertness machinery (design 114).

## 6. Raw history (refused, Q5)

The natural follow-up is "replay 1966's actual returns, not its pattern." That gets refused
as a mode, for two reasons:

- It's mostly reachable already. Raw history ≈ re-centred history with the anchor set to
  history's own mean and `equityReturnVol` set to the series sd (0.178 FULL, 0.163 POSTWAR).
  Re-centring subtracts the window mean, and the anchor puts a mean back. So the gap
  between the two is the gap between the anchor and the window mean.
- A raw mode would make the plan's forward mean the US's 1871–2023 real return, the
  century's best market, and design 102 §4.2 rejected that as survivorship bias. Using
  history's level should be a visible choice of anchor, not a side-effect of a replay
  switch.

The owner refused both the mode and a "Use history's level" button (Q5).

## 7. Parameters

| param | type, default | applies when |
|---|---|---|
| `equityReturnBootstrapFromYear` | year, blank (= automatic: FULL, or POSTWAR under joint) | bootstrap active; MC grid axis only |
| `equityReturnBootstrapStartYear` | year, blank (= random) | bootstrap active |
| `equityReturnBootstrapStartRun` | years, blank (= to 2023) | a start year is set |
| `mcEquityBootstrapStarts` | `RANDOM` \| `ROLLING`, `RANDOM` | MC, bootstrap active |

All four live in `ECONOMIC_REGIMES` next to `equityReturnBootstrapBlock`. The
start-year params are Numbers holding a calendar year, not Dates. A historical year is a row
of an annual series, not a day on the plan's calendar (design 117 is about plan dates, so it
doesn't apply).

## 8. How the choices are proved

- **G-A1 (blank is today):** with every new param blank, goldens and seeded MC fixtures are
  byte-identical (memory: the sim is bit-deterministic). **PASSED** in phases 1–2: the full
  suite is unchanged, and a blank year or 1871 runs byte-identical to the automatic window.
- **G-A2 (a window is shape only):** at an anchor equal to a window's own geometric mean,
  replaying that whole window returns that mean to 1e-9. That's design 102's existing
  exactness test, parameterised over 1871, 1926, 1951 and 1970. **PASSED** in phase 2.
- **G-A3 (the engine replays the window's shape):** `probe-equity-process-fit.mjs --from
  <year>`. The bootstrap's skew must match each window's history within simulation error.
  **PASSED** in phase 1 (§2.1: within 0.04 on all four windows). VR was in rev 1's gate. It's
  dropped, because a block-5 bootstrap reproduces only the lags inside a block, and on short
  windows the history VR is mostly lags 3–4 (§2 point 2).
- **G-B1 (a pinned run replays history in order):** a pinned 1966 run's first N stamped
  `equityReturnBootstrap.year` values are 1966…1966+N−1, with no wrap past 2023. Under joint
  mode the inflation tick reads the same years. **PASSED** in phase 3
  (`tests/unit/bootstrap-start.test.mjs`).
- **G-B2 (pinned is a stress):** on a reference plan, a pinned 1966 single run funds worse than
  the median MC path, and a pinned 1950 funds better. If it doesn't, either the re-centring
  or the pinned run is wrong. **PASSED** in phase 3. On the toolset's default plan (40 years,
  joint inflation, year-keyed RNG streams, a 15-year pinned run), terminal real net worth was
  ranked against 40 unpinned seeds. Across three seeds each, pinned 1966 ranked 0–3 of 40 and
  pinned 1950 ranked 33–40. Pinned 1929 ranked 17–30, near the median, as §2 point 4 expects.
- **G-B3 (rolling covers every start):** under ROLLING with n = the number of start years,
  each start year appears exactly once, and the by-year strip's success values match the
  per-path rows.

## 9. Phases

1. **Visibility (no new behaviour).** Show the window in force in the MC panel. Add the help
   section from §3.3. Extend the probe with `--from`. Ship this whatever happens to the rest,
   because the hidden POSTWAR default is the immediate problem. **BUILT** (§9.1).
2. **Part A:** `equityReturnBootstrapFromYear`, the rules in §3.2, the pairing field, the MC axis.
   **BUILT** (§9.2).
3. **Part B:** pinned start and run, cursor `pinned`, the joint-mode warning, the pairing
   field. **BUILT** (§9.3).
4. **Rolling-start sweep:** `mcEquityBootstrapStarts`, the per-path stamp, the by-start-year
   strip, the `mc-run` flag.

Each phase restamps `stochastic-return-paths` and regenerates `help/REFERENCE.md`.

### 9.1 As built (phase 1, 18 Nov 2026, branch `design-133-bootstrap-window`)

- **One rule, two readers.** `src/finance/economic-regimes/bootstrap-window.js`:
  `bootstrapWindowName(p)` is the rule the toolset builds the equity handler with (it was
  inline), and `describeBootstrapWindow(p)` returns `{ name, fromYear, toYear, automatic,
  reason }`, or null when the bootstrap isn't the running process. A test builds the handler
  through the toolset and checks that the two agree.
- **The Monte Carlo panel's return-paths line.** `mcReturnPaths(base)` (`mc-worker-core.js`)
  runs `applyMcPaths` on a copy and returns what every path will run. The presenter calls it
  on build and before every batch or grid run, with schema defaults under the plan.
  `McConfigPanel.setReturnPaths` renders it above the Run button. The default plan reads
  "Equity: historical bootstrap, 1951–2023 (automatic: joint inflation) · Inflation:
  historical, joint with equity".
- **Descriptions.** `mcEquityReturnModel`, `mcInflationModel` and `equityReturnModel` now say
  which years each mode samples. `mcEquityReturnModel` used to say 1871–2023, which is wrong
  for the default MC.
- **Probe.** `--from <year>`. The default output is byte-identical to before. For this,
  `EquityReturnTickHandler`'s `window` also accepts a first year
  (`bootstrapWindowFrom(year)`, memoised, throws outside the series). Nothing in the engine
  passes a year yet. That's phase 2, which adds the floor and the joint-mode clamp on top.

### 9.2 As built (phase 2, 18 Nov 2026)

- **The param is `equityReturnBootstrapFromYear`.** The draft's `equityReturnBootstrapFrom`
  was renamed. Toolset `mc` flags must be booleans, and the sweep machinery infers a year
  kind from a key that ends in `Year`. It's a Number, blank by default, shown when the
  single-run or the Monte Carlo equity process is the bootstrap.
- **Rules** (`bootstrap-window.js`):
  - `authoredBootstrapFrom` refuses anything but a whole year from 1871 to 1974, and the
    message names the 50-year floor. It only checks when the bootstrap runs, so a stale
    year can't fail a run that doesn't replay history.
  - Under joint inflation a pre-1951 year resolves to POSTWAR. The run is byte-identical
    to the automatic window (tested), and `bootstrapWindowWarning` explains it. The toolset
    prints the warning once per process, because every MC path compiles.
  - A year that equals a named window resolves to that name (1871 → FULL, 1951 →
    POSTWAR), so it's byte-identical to the automatic run.
- **Panel line.** An authored year shows as "1970–2023". A clamped one says why: "1951–2023
  (set to 1926; joint inflation starts in 1951)".
- **Pairing.** `mcEquityWindow(params)` (`mc-worker-core.js`) is the resolved first year, or
  null off the bootstrap. Batch records and each grid cell's record carry it as
  `equityWindow`. A grid cell's window is resolved from its own overrides, since the axis
  can be the window. `pairingMismatches` reports "bootstrap years from A vs B" when both
  records ran the same equity process. Records from before the field are never called
  mismatched. Turning the MC inflation path off now also reports 1951 vs 1871, which is
  correct (MPR-10 updated).
- **Grid only.** Two new schema fields:
  - `gridOnly: true` makes `mcRowFor` return no batch row.
  - `sweepRange: { min, max }` gives an unset year axis the range 1871–1974 rather than the
    plan's own calendar years (`optRowFor`), and bounds the ±5 range around a typed centre.
- **Not done:** re-fitting the block length per window (F1), and registering the param with
  lever-inertness (§5). The visibility rule covers the grid.

### 9.3 As built (phase 3, 18 Nov 2026)

- **Params.** `equityReturnBootstrapStartYear` takes any year 1871–2023. It isn't bound by
  the window or the 50-year floor, because the user names the year. It's neither an MC draw
  nor an optimizer lever, since phase 4's rolling mode is how start years get swept.
  `equityReturnBootstrapStartRun` is a whole number ≥ 1, blank = through 2023, cut at the
  series' end. Both are validated in `bootstrap-window.js` (`authoredBootstrapStart`), and
  only when the bootstrap runs.
- **Handler.** `EquityReturnTickHandler` takes `pinned: { startYear, years }`.
  - On the first tick (no cursor yet) it draws and discards the block's uniform, then
    replays the start year.
  - While the cursor is `pinned` with years left, it steps to the next series year. That
    skips the in-window check and can't wrap, because `remaining` is capped at 2023.
  - Each pinned year is `(series[i] − window.mean) × vol / window.sd`. Windows now carry
    `mean`. Inside the window this is exactly the deviation a random block would give
    (tested).
  - After the run, the cursor drops `pinned` and blocks are random again.
  - `pinned` is serialized only when set, so unpinned snapshots are byte-identical.
    `equityReturnBootstrap.pinned` is registered in the state schema.
- **Joint mode.** Inflation, the 10-year yield, gold and AU all read the cursor's year, so
  they follow the pinned run with no change. A pinned year before 1951 under joint
  inflation prints one warning naming the years whose inflation is drawn at random.
- **Monte Carlo.** The params pass through `perturbParams`, so every path shares the
  opening run (§11 Q3).
  - The panel line says "every path opens with 1966–1980 in order". The design asked for
    this in the run header; it's on the config panel's return-paths line instead.
  - `mcEquityStart` gives the pairing record `equityStart: '<year>+<years>'` for batches
    and grid cells. `pairingMismatches` reports "pinned start none vs 1966 for 15 years".

## 10. Flags raised by this design

- **F1. The default MC samples a window nobody chose, at a block length fitted to another.**
  It replays POSTWAR because of joint mode, and block length 5 was fitted on FULL. The MC's
  pull-back is about half of FULL's, and the window's crash tail is deeper (§2.1). All of it
  is within sampling error. Phase 1 makes the window visible, and §11 Q1 keeps it. Re-fitting
  the block length per window is a phase 2 question, not a defect.
- **F2. Joint mode outside its years fails silently.** A bootstrap year outside 1951–2023
  under joint mode gets Gaussian inflation with no message. Today that can't happen, because
  joint forces POSTWAR. Parts A and B make it possible, which is why §3.2 clamps and §4.1
  warns.

## 11. Questions for the owner

All five decided by the owner on 18 Nov 2026.

1. **Should the MC default window change?** **Decided: keep POSTWAR** under joint mode, and
   make it visible (phase 1). The VR difference is within sampling error, and a shared
   monetary era for equity, inflation and yields is worth more than a pull-back that 73 years
   can't measure.
2. **Is 40 years the right floor** for a custom window? **Decided: 50 years (latest start
   1974).** A toy bootstrap (40-year paths, block 5, every window rescaled to the
   same vol) shows that a short window keeps a normal-looking failure rate. What it loses is
   the *variety* of failures. The table gives the share of failing 30-year, 4%-withdrawal paths
   whose first 15 years pass through the window's single worst decade, against the share of all
   paths that do:

   | from | years | fail rate | fails through the worst decade | all paths through it |
   |---|---|---|---|---|
   | 1871 | 153 | 29% | 36% | 25% |
   | 1951 | 73 | 32% | 66% | 47% |
   | 1970 | 54 | 32% | 76% | 60% |
   | 1984 | 40 | 32% | 99% | 72% |
   | 1994 | 30 | 34% | 100% | 85% |

   From 1984 on, every failure is the 2000s. The MC would report a plausible percentage that
   rests on one episode. A 50-year floor keeps POSTWAR and a 1970 window, which still contain
   two different bad decades (the 1970s grind and the 2000s). It refuses the windows whose tail
   is a single story.
3. **Should a pinned start year be allowed in MC,** given it turns the MC into a conditional
   one (§4.2)? **Decided: yes,** labelled in the run header and the pairing record.
4. **Should the rolling strip's "short pinned run" threshold be 15 years?** **Decided: 15,
   shaded and not excluded.** On a toy 30-year, 4%-withdrawal bootstrap
   over FULL, the first k years' real return explains this share of whether the path fails:
   R² 0.28 at k = 5, 0.43 at 10, 0.50 at 15, 0.51 at 20 and 0.42 at 30. Failure is decided by
   about year 15. After that, more pinned history adds almost nothing to the answer the strip
   is for. So start years up to 2009 get a full 15-year pinned run (139 of 153), and 2010–2023
   are shaded. Shading rather than excluding keeps the most recent start years visible, and
   makes it obvious that history stops carrying the result there.
5. **Raw history:** **Decided: refused** (§6). No raw mode and no "Use history's level"
   button. A user who wants history's level edits the anchor and vol.
