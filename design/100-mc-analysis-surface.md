# 100 — The Monte Carlo analysis surface (in-app)

**Status: Steps 1–4 BUILT (11 Sep 2026). Step 5, ranking grid cells by a chosen
criterion, DESIGNED 12 Sep 2026 (§10); phase 1 BUILT 12 Sep 2026 (§10.9); phase 2
BUILT 12 Sep 2026 (§10.10, §10.11). In-app checks and the end-of-design review are open. Start at §9 when picking
this up.**

## 1. Problem

The MC tab shows three things: the success rate with P10/P50/P90, a fan chart, and a
histogram of terminal values. The runner computes a great deal more, and the lab tools
(`scripts/montecarlo/mc-report.mjs`) turn it into the readouts that actually decide
things. Those tools live outside the app, so a question the app raises has to be
re-asked on the command line. The mix report, the paired view and the return-band table
have all found things on real plans that the MC tab cannot show.

What exists and is not displayed:

| Readout | Computed by | Displayed |
|---|---|---|
| Path shape: median NW CAGR, worst 5-yr, max drawdown, failure after a below/above-median first decade, real-liquidity trough, house CAGR/drawdown, repair spend | runner (`summary.pathShape`, per-run `pathShape`) | nowhere |
| Failure rate by return band, failure drivers | `scripts/lib/mc-analysis.mjs` | lab only |
| Asset mix as a distribution (design 82 §8) | runner `mix: true` + `finance/allocation-reporting/mix-distribution.js` | lab only (HTML page) |
| Paired arm comparison (rescues / reverse rescues, paired money delta) | `mc-analysis.mjs` | lab only |
| 2-D lever grid | `scripts/lib/grid.mjs`, `lab/variant-grid.mjs` (Node only) | nowhere |

## 2. Decisions

1. **One analysis module, shared.** `mc-analysis` moves to
   `src/finance/monte-carlo/mc-analysis.js`; `scripts/lib/mc-analysis.mjs` re-exports it.
   It has no imports, so the move changes nothing for the scripts. The app and the lab
   must compute a band or a rescue count the same way, or a number quoted from one will
   not match the other.
2. **The rules the lab report already enforces carry over unchanged.**
   - Never show a mean of terminal wealth, only medians and percentiles.
   - Mix bands are marginal: one band per class, never stacked (design 82 §8.2).
   - Paired views require verified pairing (§6), not assumed pairing.
3. **Band on realized growth, not the sampled mean.** Since design 98 M3 every MC run
   draws a year-by-year path, so the sampled long-run mean no longer explains which paths
   fail. The band key is each run's realized net-worth CAGR (`pathShape.netWorthCagr`),
   which is what `mc-report` already uses when paths are on.
4. **Adapters, not a second row shape.** The lab works on arm rows (`failed`, `oof`); the
   runner returns `runs` (`scenarioFailed`, `outOfFundsDate`, nested `pathShape`). A small
   `runsToRows(runs)` adapter in the shared module maps one to the other, so the analysis
   functions stay single-shaped.
5. **Build order:** path shape + return bands → mix (+ spending) → paired A/B → grid.
   Each step is independently useful. Paired A/B benefits from the first two (more to
   compare), and the grid needs its own engine and a separate design pass (§7).

## 3. Step 1 — path shape and failure by return band

A new section in `McResultsPanel`, below the histogram:

- **Path shape** badges from `summary.pathShape`: median NW CAGR, median worst 5-yr CAGR,
  median max drawdown, and the failure rate after a below-median vs above-median first
  decade (the sequence-risk readout, design 74 §5.2). Then the real net-liquidity trough
  (median and p10, design 97 §18). House CAGR and drawdown appear only when the plan has
  a house (non-null); repair spend only when any path spent on repairs.
- **Failure by realized return** table: the `mc-report` bands (0–4%, 4–5%, … 12%+), each
  cell showing the failure rate and the path count. Empty bands are omitted. A note says
  what the table is for: it turns "N% fail" into a return threshold.
- **What separates a failing path**: failed vs survived on realized CAGR, worst 5-yr and
  max drawdown, plus the median and earliest out-of-funds year. Omitted when nothing
  failed.

Numbers only, no new charts; the data is already on the result. Restored results
(`restoreResult`) and older results without `pathShape` render the section as absent,
not as zeros.

**Step 1 BUILT (11 Sep 2026).**
- `src/finance/monte-carlo/mc-analysis.js` holds the analysis, plus `runsToRows` and
  `RETURN_BAND_EDGES`. `scripts/lib/mc-analysis.mjs` re-exports it.
- `McResultsPanel._buildPathShapeSection` renders the badges, the band table and the
  failing-path contrast. CSS: `.mc-shape-*`.
- Tests: `tests/unit/mc-analysis-shared.test.mjs` (MCA-1…4) and
  `tests/viz/mc-results-path-shape.test.mjs`.

**The lab's band table silently dropped the worst paths.** Its edges started at 0%, so a
path whose net worth shrank over the plan fell into no band, and those are mostly failed
paths. On a real plan the dropped paths were a large share of all failures, which made
"every failure sits in the lowest band" look true when it was not. `RETURN_BAND_EDGES`
opens with a "below 0%" band, and `mc-report` now uses the same edges. Paths with no
computable CAGR (net worth reached zero) are counted and named in a note rather than
banded.

## 4. Step 2 — the mix as a distribution (and spending)

The config panel gains **Record asset mix** and **Record spending** options. They are
the runner's existing `mix` and `spending` flags, built together as design 89 §21
recommends. Both are off by default:
- mix costs about 1% of compute (design 82 §8.3);
- spending forces full telemetry at about 7.5x (design 89 §20), acceptable only now that
  MC runs on the worker pool.

Results, from `mix-distribution.js`, coloured with the allocation palette:
- per-class share bands over time, one small chart per class, p10/p50/p90, never stacked;
- threshold probabilities (`DEFAULT_MIX_THRESHOLDS`), with each tested-path count;
- the mix on failing vs surviving paths at the horizon, sorted by gap.

That last view is the design 82 §8.2 question: whether the shape IS the failure
mechanism. Thresholds start as the defaults. Editing them later uses a typed row editor,
never a JSON text area.

**Step 2 BUILT (11 Sep 2026).**
- **Options:** `McConfigPanel` has an "extra telemetry" group, `.mc-opt-mix` and
  `.mc-opt-spending`, with the cost on each label. `getConfig()` returns `mix` and
  `spending`, and the presenter and controller pass both to the runner.
- **Shared conversion:** `mixSeriesFromRuns(runs)` in `mix-distribution.js`. The panel and
  `scripts/lib/mc.mjs` both use it; the lab's inline copy is gone.
- **Mix section** (`_buildMixSection`):
  - one class at a time, chosen by chips coloured from the allocation palette; classes no
    path held are dropped;
  - a P10–P90 band and P50 line, with the failed paths' median as a dashed line;
  - the `DEFAULT_MIX_THRESHOLDS` table and the failed-vs-survived table at the horizon,
    sorted by gap.
  - **Decision:** one class at a time rather than a chart per class. Six marginal bands
    side by side were too much for a results pane, and the chips keep the "never stacked"
    rule obvious.
- **Spending section** (`_buildSpendingSection`), built on design 89's
  `aggregateSpendingRuns`:
  - the `describeSpendingDistribution` header;
  - badges for real cost P50, tax over 50% of spending, and "went short" beside the failure
    rate (design 89 §21.4's cross-check);
  - an unclassified-types banner;
  - a per-category P10/P50/P90 table with each category's fired rate.
  - It is a table, not §21.4's stacked percentile bar: the same numbers, with the bar left
    as an option.
- **Tests:** `tests/viz/mc-telemetry-options.test.mjs`,
  `tests/viz/mc-results-mix-spending.test.mjs` and
  `tests/unit/mix-series-from-runs.test.mjs` (MSR-1…3).

## 5. Step 3 — paired A/B

Iteration i is seeded by index, so path i is the same world in two runs of the same
config. The presenter gains a **baseline slot**: "Keep as baseline" pins the current
result, and the next run is shown against it:
- rescues and reverse rescues (`pairedRescues`), with reverse rescues as the headline
  risk signal;
- the paired after-tax NW delta (`pairedMetric`): win/loss counts and p10/p50/p90 of the
  difference;
- both arms' failure rates and percentiles side by side.

**Pairing guard.** The paired view renders only when:
- n matches;
- the seed lists match;
- the sampled-variable key sets match;
- `mcSequenceRisk` matches.

Any mismatch shows an unpaired side-by-side with a banner naming the mismatch. A lever
that changes WHICH variables are sampled silently breaks common random numbers, so the
guard is what makes the view trustworthy. The baseline lives in memory for the session,
like the existing result carry. Persisting it is a later decision.

**Step 3 BUILT (11 Sep 2026).**
- **The pairing record lives on the result**, not with the caller as §9 first proposed.
  The runner stamps `summary.pairing = { n, seeds, sampled, mcSequenceRisk }`, so it
  travels with the result across a rebuild and nothing has to rebuild what a batch ran
  with. `sampled` is `samplingSignature(ctx.variables)` in `mc-worker-core.js`, next to
  `perturbParams`, which defines the stream.
- **The guard compares draws, not just keys** (§6): `pairingMismatches(a, b)` in
  `mc-analysis.js` returns a list of reasons, empty when the batches are paired. A record
  missing on either side counts as a mismatch.
- **Baseline slot:** `MonteCarloPresenter.keepBaseline / clearBaseline / getBaseline /
  restoreBaseline`. `WorkbenchApp._mcBaselineCarry` carries it across a rebuild, keyed to
  the scenario id (§8 Q1).
- **Panel:** a header button ("Keep as baseline" / "Replace baseline" / a pressed
  "Baseline ✕") and `_buildBaselineSection`, placed under the badges because a comparison
  is the headline when one exists:
  - rescue badges, reverse rescues first, with a one-line reading below them;
  - paired after-tax NW: ahead/behind counts and P10/P50/P90 of the per-world difference;
  - a side-by-side table (failure rate, P10/P50/P90 NW, median CAGR, liquidity trough P10)
    with the change coloured better or worse;
  - on a mismatch, a banner naming it, and the side-by-side table only.
- **Tests:** `tests/unit/mc-analysis-shared.test.mjs` (MCA-5…8),
  `tests/unit/mc-pairing-record.test.mjs` (MPR-1…3), `tests/viz/mc-results-paired.test.mjs`,
  and baseline cases in `tests/viz/monte-carlo-presenter.test.mjs`.

## 6. Pairing — why it is checked, not assumed

`mc-run` and `mc-report` rely on "same flags, same n" discipline by convention. In the app
the two runs are separated by arbitrary UI edits, so the convention cannot be relied on.
The guard compares the facts that define the random stream. A config edit that enables
one more MC variable changes every subsequent draw index, and the paired counts would
then describe noise.

**The sampled-key set is not enough (found while building step 3).** Every enabled
variable draws from one shared stream, in order, and the number of random numbers a
variable takes depends on its distribution, not its key:
- a Normal takes two;
- a Uniform takes one;
- a Normal with a zero spread takes none (`NormalDistribution.sample` returns the mean
  early).

Setting one lever's sd to 0, a natural "remove this uncertainty" edit, keeps the key set
identical and shifts every variable drawn after it. The guard therefore compares the
ordered list of `{ key, draws }`. The counts come from sampling each distribution once
with a counting stream, so a distribution added later is covered without a table to keep
up to date.

## 7. Step 4 — multi-lever grid (DESIGNED 11 Sep 2026)

**Decided with the user (11 Sep 2026):** the grid lives in the **MC tab**, and the first
build covers **both modes** (deterministic and MC cells). §7.3 records the options that
were weighed.

The app has no 2-D grid. `GridSearchSolver` enumerates optimizer variables but scores
each cell with one deterministic run, serially on the main thread, and ranks them in a
top-20 bar chart; `sweep-scenario` varies one param on the command line.

### 7.1 What exists to build on

| Piece | What it gives the grid | Gap |
|---|---|---|
| `McWorkerPool` + `mc-worker-core` | one broadcast context, index-seeded tasks, bit-identical to serial | a task is only an index `i`, so one context = one cell |
| `IntlRetirementMcRunner._prepare` | the resolved base world (schema defaults → plan → balances → overrides) and variable list | none |
| Opt harvest (`buildOptVariables`) | lever rows with value lists: ENUM `values`, INTEGER/CONTINUOUS `min/max/step` via `valuesForConfig` | none |
| `summary.pairing`, `pairingMismatches`, `pairedRescues`, `pairedMetric` (step 3) | the paired reading of one cell against another | none |
| `rollout-worker-pool` (optimizer) | a pool for deterministic rollouts | used only by the MPC cockpit, not the Opt tab |

### 7.2 Proposed decisions

1. **One engine, not two.** A grid is the MC worker pool with a task of `{ cell, i }`
   instead of `i`. The context carries the base world once plus a small per-cell override
   list, so the whole grid shards across workers in one pass and a slow cell does not
   leave cores idle.
   - **A deterministic cell is the same run with nothing sampled**: no enabled variables,
     `mcSequenceRisk: false`, one path. It needs no second engine, and a deterministic cell
     and an MC cell cannot disagree about how a lever is applied.
   - **Invariant, tested:** the cell at the plan's own values reproduces the single run
     (deterministic mode) and the MC tab's batch (MC mode, same n and config), exactly.
     The sim is bit-deterministic, so an exact match is the test.
2. **Axes come from the Opt harvest; noise comes from the MC config.** A lever is a list
   of values to try, and that is what an Opt row already is. What varies inside a cell is
   what the MC panel samples. Two rows are picked as axes, each with its value list.
3. **Common random numbers by construction.** Every cell runs paths `0…n−1` from the same
   variable list, so path i is the same world in every cell and any two cells are paired.
   - **Trap:** an axis that is also an enabled MC variable would be overwritten by the
     draw, and the axis would be inert. Axis keys are removed from sampling for the whole
     grid, the same way in every cell (so pairing holds), and the header names them.
   - Every cell gets a `summary.pairing`, and `pairingMismatches` runs against the
     reference cell anyway, as a check the construction held.
4. **Results: a heatmap plus a reference cell.**
   - Deterministic mode colours by after-tax NW, with failed cells marked.
   - MC mode colours by failure rate. Each cell shows its rate and path count.
   - A reference cell (default: the cell at, or nearest to, the plan's values) is chosen
     by clicking. Each cell's tooltip shows rescues, reverse rescues and the paired
     after-tax delta against it, exactly as step 3 renders them.
   - Never a mean of terminal wealth (§2.2).
5. **A cell keeps rows, not time series.** `runsToRows` output per path (seed, failed,
   NW, after-tax NW, CAGR, worst 5-yr, drawdown) is everything the heatmap and the paired
   readout use. Keeping each path's ~45-point series for 25 cells × 200 paths is the
   memory problem step 2 already hit. Mix and spending telemetry are never on in a grid.
6. **Cost is shown before launch, then corrected live.**
   - Before launch: cells × paths = runs, and a time estimate from a measured rate: the
     last MC batch's paths per second on this plan if there is one, otherwise "measured
     after the first runs".
   - During the run: the ETA is re-estimated from completed tasks.
   - Order of magnitude: about 0.5 s per path per core, so 5 × 5 cells × 200 paths is
     about 5 minutes on 8 workers. Deterministic 5 × 5 is seconds.
7. **Scanned, not searched.** Every cell runs. Pass/fail is not monotone along these axes
   (tax-year, residency and age-gate interactions; `variant-grid.mjs` header), and a
   non-monotone boundary is what a grid is for seeing.
8. **Relation to the baseline slot:** none in the first cut. The grid has its own
   reference cell, paired by construction. Pinning a grid cell as the MC tab's baseline
   is a possible later link.

### 7.3 For the user to decide

- **Which tab.** Recommended: **the MC tab**, as a Grid mode beside the batch run. The
  engine, the noise config, the pairing machinery and the paired readout all live there.
  The Opt tab answers a different question ("the best candidate by a score"), and hosting
  the grid there would mean the Opt tab reading the MC panel's config across tabs.
  - Alternative: the Opt tab, where GRID with exactly two enabled axes already enumerates
    the cells. That path gets a deterministic heatmap nearly free, but MC cells would
    still need the MC config.
- **First-cut scope.** Recommended: both modes in one build, since deterministic is MC
  mode with n = 1 and nothing sampled. The alternative is deterministic only, then MC.

### 7.4 Build order (once 7.3 is settled)

1. `mc-worker-core`: a grid context (base + cell overrides + variables with the axis keys
   disabled) and a `{ cell, i }` task. Unit tests: the plan-values cell equals the plain
   batch, bit for bit, serial and sharded.
2. A `McGridRunner` beside `IntlRetirementMcRunner`, reusing `_prepare`. It returns
   `{ axes, cells: [{ values, rows, summary }] }`.
3. The panel: two axis pickers (from the Opt harvest, each with an editable value list),
   mode (deterministic / MC with n), the cost line, Run.
4. The heatmap and the reference-cell tooltip. Viz tests in the style of
   `mc-results-paired.test.mjs`.

### 7.5 Step 4 BUILT (11 Sep 2026)

- **Engine.**
  - `mc-worker-core.js`: `gridCellParams(ctx, cell, i)` writes the cell's lever values
    onto the base (the optimizer's `set`), then perturbs. `runGridTask` reduces the path
    to a `runsToRows` row inside the worker.
  - `runMcIteration(payload)` takes an index (a batch) or `{ cell, i }` (a grid), so
    neither worker shell changed.
  - `computePathShape` moved into `mc-sampling.js` so the worker core can use it without
    importing the runner; the runner re-exports it.
- **`mc-grid.js`** (pure): `GRID_MODES`, `MAX_AXIS_VALUES` (15), `nearestIndex`,
  `cellIndexOf` (row-major, as `cartesianProduct`), `referenceCellOf`, and
  `summarizeGridCell` (batch-shaped summary plus `pairing`).
- **`McGridRunner`** extends `IntlRetirementMcRunner` and reuses `_prepare`.
  - Deterministic mode disables every variable, sets `mcSequenceRisk: false`, and runs
    one path.
  - MC mode disables only axis keys and reports them as `removedFromSampling`.
  - Mix and spending are forced off. `MonteCarloController.runGrid` runs it on the tab's
    pool.
- **Panel (MC tab).**
  - A Batch / Grid toggle. Grid mode offers:
    - axis pickers from the Opt harvest, grouped as the Opt panel groups them;
    - typed value editors (a checkbox per ENUM value; min / max / step for numbers);
    - the plan value under each picker;
    - a cells mode select.
  - The cost line reads "cells × paths = runs", with a time estimate from the last run's
    measured ms per path (spending runs excluded). It also names axes that will leave
    sampling. The same line shows what stops a run.
  - During a run the status line shows a live ETA.
- **Results.** `McResultsPanel.showGrid`:
  - the heatmap is a table, one hue, and every cell prints its value;
  - the plan's values are marked in the headers, and the reference cell is outlined;
  - hover shows paired counts against the reference;
  - clicking a cell reads it against the reference with step 3's paired blocks and
    side-by-side table (worded "the reference" / "this cell");
  - "Make reference" moves the outline.
- **Tests:** `tests/unit/mc-grid-runner.test.mjs` (MGR-1…6):
  - the plan-values cell equals the MC batch (MC mode) and the single run
    (deterministic), bit for bit;
  - a sampled axis leaves sampling, stays live, and cells stay paired;
  - sharded equals serial.

  Also `tests/viz/mc-grid.test.mjs` (config panel, heatmap, presenter wiring).

**Found while building:**
- **An Opt lever can have no plan value.** `rothConversionStartYear` is null on the
  default plan. The first grid tests used it and passed with `undefined` and `NaN` as
  axis values, so an inert axis did not fail anything. The tests now require a plan
  value. In the app, such a lever shows no plan marker and the reference is "nearest"
  rather than exact.
- **ENUM plan values compared by `===`.** `spendingStrategy`'s value is an array, so no
  cell matches the plan exactly. The panel says the reference is the nearest cell.
  Harmless, but a list-valued lever cannot be marked as the plan's value yet.

**Not in the first cut:**
- the grid is not carried across a rebuild (the batch result and baseline are);
- no cell-to-baseline link (§7.2.8);
- no frontier readout (`variant-grid`'s `last-passing`).

## 8. Open questions

1. **REVIEW AT THE END**, once the user has used the step 3 UI. Does the baseline slot
   survive a scenario switch? **Built as: no** (step 3). It is
   keyed to the scenario id, like the result carry. A lever tried as a copy of the plan
   therefore cannot be compared against the original in the app yet. If that is wanted,
   the guard already makes it safe; only the label would need to name both scenarios.
2. Should the path-shape section be collapsible so the fan chart stays above the fold?
3. Mix bands in MC Results, or a mode of the Allocation tab? **Resolved: MC Results**
   (step 2). The Allocation tab is a single-run view, and mixing the two would blur which
   world is shown.

## 9. Where to pick up

**Step 3 is built (§5). Not yet exercised on a real plan in the app.** First check: keep
a baseline, change one lever's centre (not its spread), and run again. The section should
render paired. Then set that lever's sd to 0 and run: the banner should name it.

**Steps 1–4 are built (§3, §4, §5, §7.5). Neither step 3 nor step 4 has been exercised on
a real plan in the app yet.** First checks:
- **Step 3:** keep a baseline, change one lever's centre, and run: paired. Set its sd to
  0 and run: the banner names it.
- **Step 4:** a deterministic 3 × 3 grid on two levers, then the same grid in MC mode
  at small n. The cell at the plan's values should match a plain batch at the same n,
  and the cost line's estimate should be close to the real time.

**Step 5 phase 1 is built (§10.9), not yet exercised on a real plan in the app.** First
check: an MC grid at small n, ranked on the P10 real net-liquidity trough. Cells with 10%
or more failures should read "fails" and rank last; survivors-only should give them
values. Then switch to Δ vs reference and move the reference. Phase 2 is built
(§10.11): add "failure rate ≤ 10%", check the greyed cells against the list's Meets
column, and sort the list on a column. F and G (§10.8) are not designed.

**Review at the end of design 100** (after the user has used the UI):
- §8 Q1: should the baseline survive a scenario switch, so a copy of the plan can be
  compared against the original?

**What step 2 found on a real plan (11 Sep 2026, in the app, 40 paths, mix + spending):**
- **Design 89's classification list was behind. FIXED 11 Sep 2026.** The unclassified
  banner named `US_PERIOD_ADVANCE`, `AU_PERIOD_ADVANCE` and `POOL_FLOW_APPLY` on every
  path, and UNCLASSIFIED was the largest category. Measured on one path of the pools
  plan, by reducer:
  - **~80%: `PoolFlowReducer` stamping `state.liquidityPools[id].balance`.** It is a
    per-pool readout of accounts the cube already counts, so its falls were the same money
    counted twice. `spending-cube.js` now skips `liquidityPools.*`
    (`DERIVED_BALANCE_PREFIXES`).
  - **~17%: `POOL_FLOW_APPLY` debiting brokerage accounts.** Now INTERNAL.
  - **The rest: debits made directly on the period advance.** These are now classified
    by the journal entry's reducer: Bond Price Adjust and Equity Return are REVALUATION;
    Bond Maturity and Bond Ladder are INTERNAL. An unlisted reducer still lands in
    UNCLASSIFIED.

  After the fix the same path has nothing in UNCLASSIFIED, and the §7(a) totality check
  holds. None of this money was tier 1, so the spending totals were right before the fix.
  Tests: `tests/unit/spending-cube.test.mjs` CLS-8, CLS-9, CUBE-7.
- **"Went short" and the failure rate disagreed** by one path (25% vs 22.5%). Design 89
  §20.5 found them identical on its reference plan. The panel now shows the gap.
  **TRACED 11 Sep 2026 — a funding round trip, not a recovery.** Reproduced headless
  (`mc-run --spending`, same 40 seeds: 9 failed, 10 short, one discordant path). On that
  path, in the plan's last months:
  1. `REPLENISH_SAVINGS` on the AU transaction account escalates to `INTL_TRANSFER_APPLY`
     (US → AU).
  2. `IntlTransferApplyReducer` finds the US source short and calls
     `accountService.replenishSavings(usKey, …)`.
  3. That walk excludes only its own target. `isCashRole` makes savings drawable across
     the border even under LOCAL_FIRST, so it **draws the AU destination account** to top
     up the US source.
  4. The transfer then converts the money back, AU is credited the full `targetDeficit`,
     and `audShortfall ≤ 0.01`, so no `OUT_OF_FUNDS`. The destination nets only the part
     that did not come from itself, less two FX fees.
  5. `ExpenseDebitReducer` caps the debit silently. The path goes short and never fails.

  So the failure flag undercounted. **FIXED 11 Sep 2026.**
  - `IntlTransferApplyReducer` now passes `excludeCurrency` (the destination's currency) to
    the source top-up, and `replenishSavings` skips every account in that currency.
    Drawing destination-currency money to fund a transfer into that currency is always a
    round trip, not only when the account is the destination itself.
  - The uncovered remainder now chains `OUT_OF_FUNDS`.
  - The same 40 seeds now give 10 failed and 10 short, with no discordant path.
  - All 6,311 unit tests pass and the goldens did not move.
  - Test: `reducer-postconditions-finance.test.mjs` ("no round trip"), which fails
    without the fix. See design 89 §21.7.
- **Spending is expensive in the browser**: 40 paths took about 10 minutes and the page
  process held about 4 GB. Keep it opt-in and keep n small. Design 89 §20.7's in-state
  accumulator is what would remove the cost.
- **The spending table carries a Tier column**, because non-spending rows (INTERNAL,
  REVALUATION, UNCLASSIFIED) were reading as cost next to a header that excludes them.

**Known follow-ups, not part of this design:**
- **Gold-pool warning:** `liquidityGraph`'s location-policy warning fires once per MC
  iteration. Log it once per run.
- **CLI warnings:** `run-scenario.mjs` and `scripts/lib/run.mjs` silence `console.warn`
  during load, so design 99 retired-rate warnings never print from the CLI.
- **`run-scenario --params`** diffs numeric params only; it missed `liquidityGraphEnabled`.
- **Step 2 wishlist:** a threshold editor (typed rows) and §21.4's stacked percentile bar.

## 10. Step 5 — rank grid cells by a chosen criterion (DESIGNED 12 Sep 2026)

**Agreed with the user (12 Sep 2026):**
- **Phase 1** covers options A (a metric selector), B (wider rows) and D (paired ranking).
- **Phase 2** covers C (a ranked list) and E (a constraint, then an objective).
- F (a frontier readout) and G (a headless MC grid) are noted in §10.8 and left to be
  designed later.

### 10.1 Problem

A grid cell shows one fixed number: the failure rate in MC mode, and median after-tax net
worth in deterministic mode (`McResultsPanel._buildGridTable`). Many questions are not
about failure. A liquidity-reserve study ranks its arms on the real net-liquidity trough
(design 97 §18). A wrapper question ranks on after-tax NW (design 84 §6.4a). A tax
question ranks on lifetime tax. The lab already asks all of these through
`mc-report --metric` and `variant-grid`'s `report.metric`; the in-app grid can ask none of
them, and it never orders the cells at all.

### 10.2 What exists to build on

| Piece | What it gives | Gap |
|---|---|---|
| Grid cell `rows` (`runsToRows`) | per path: `failed`, `oof`, `nw`, `afterTaxNW`, `netWorthCagr`, `worst5yrCagr`, `maxDrawdown`, `troughRealNetLiq`, `repairSpend` | no end net liquidity, lifetime tax, deficit, whole-path floor or trough drawdown |
| Worker `evaluate()` (`parallel/mc-worker-core.js`) | already computes `finalNetLiquidity`, `cumulativeTaxesPaid`, `cumulativeDeficit` and `deficitMonths` for every path; the batch runner's `runs` carry them | `runGridTask` drops them, and `gridCellRuns` hard-codes `finalNetLiquidity: null` |
| `pairedMetric(a, b, key)` | the paired difference on any row field | used for `afterTaxNW` only in the app |
| `grid-report.mjs` `MONEY_METRICS` | the lab's allowlist: `netWorth`, `netLiq`, `afterTaxNW`, `taxPaid`, `deficit` | lab only, and in the lab's row shape (`netWorth`, `oofDate`) |
| `mc-report --metric`, `--floor` | a paired MC readout on any row field; the trough vs whole-path floor distinction | lab only |

### 10.3 Decisions

1. **One metric registry, in `src`.** A new `src/finance/monte-carlo/mc-grid-metrics.js`
   holds one entry per rankable criterion:
   - `id`, `label` and the row `field`;
   - `better`: `'higher'` or `'lower'`;
   - `unit`: `money`, `rate` or `count`, which chooses the formatter;
   - `zeroOnFailure`: true when a failed path sits at about zero by construction (§10.3.4);
   - `caveat`: one line the panel prints whenever the metric is selected, or null.

   The registry is an allowlist, as `MONEY_METRICS` is. A misspelled field would otherwise
   render a plausible table of nulls.

2. **Computed from rows on demand, not stored in the summary.** Cells already keep their
   rows, and a percentile across 225 cells × a few hundred paths is instant. Changing the
   metric is a re-render, never a re-run. `summarizeGridCell` does not grow a field per
   metric. A grid whose rows predate a field shows that metric as unavailable, not as zero.
   - **Invariant, tested:** the registry's P50 after-tax NW equals
     `summary.medianAfterTaxNW`, and its P10 trough equals
     `summary.pathShape.p10TroughRealNetLiquidity`, for every cell. That rules out two
     percentile formulas; the registry uses `mc-grid.js`'s `percentile`.

3. **Three controls: metric, statistic, reading.**
   - **Metric:** any registry entry.
   - **Statistic:** in MC mode, P10, P50 or P90 across the cell's paths. The failure rate
     takes no statistic. Deterministic mode has one path and hides the control.
   - **Reading:** level, or paired Δ vs the reference cell (§10.3.6). MC mode only. In
     deterministic mode Δ against a fixed reference ranks exactly as the level does.
   - **Defaults:** MC mode opens on the failure rate and deterministic mode on after-tax
     NW, which is what each shows today. A first render of an existing grid is unchanged
     apart from the rank marks.

4. **Failed paths in a "zero on failure" metric.** A path that ran out of funds has a real
   net-liquidity trough of about zero by construction (`computePathShape`'s header). A cell
   whose failure rate is at least p therefore has a Pp trough of about zero, and every such
   cell ties at zero. Ranking on that number ranks on noise.
   - **Default: the percentile is taken over all paths, and a degenerate cell is flagged.**
     For a `zeroOnFailure` metric, a cell whose failure rate is at least the chosen
     percentile shows "fails" instead of a value and ranks after every non-degenerate cell,
     ordered among themselves by failure rate.
   - **Option: survivors only.** A toggle takes the statistic over the surviving paths and
     prints the survivor count in each cell. It answers "how deep is the trough when the
     plan survives". The count is shown because a cell with three survivors is not
     comparable with one that has two hundred.
   - **This refines the "failure first" ordering discussed on 12 Sep.** Ranking every
     metric failure-first would reduce the metric to a tie-break, and in MC mode almost no
     two cells share a failure rate. Failure takes precedence only where the metric cannot
     tell failed paths apart.
   - `zeroOnFailure` entries: end net liquidity, the post-peak trough and the whole-path
     floor.

5. **Rank is shown, not only implied by shade.**
   - Dense ranking in the metric's `better` direction. Tied cells share a rank; degenerate
     and missing cells rank last, in that order.
   - Each cell prints its value and a small rank mark (`#1`, `#2` …). The best cell gets
     an extra outline, distinct from the reference outline.
   - **Shading: darker is better, for every metric.** Today a darker MC cell means a
     higher failure rate, which is worse, while a darker deterministic cell means more
     wealth, which is better. A ranked view should make the best cell stand out whatever
     the metric. Level shading spans the grid's own range. The panel's note sentence
     changes to match.
   - Paired Δ shades on a diverging scale: two hues around zero, with the reference cell
     neutral, because a Δ has a sign and a one-hue ramp would hide it.
   - Colour is never the only encoding (§7.5): the value and the rank are printed.

6. **Paired reading (option D).** Every cell runs the same worlds (§7.2.3), so a cell can
   be ranked on its difference from the reference, world by world.
   - **Money and ratio metrics:** the statistic is taken over the paired Δ distribution
     (`pairedMetric` on the metric's field). The statistic control gains a **win rate**
     choice: the share of worlds where this cell beats the reference.
   - **Failure rate:** the paired reading ranks exactly as the level does, because
     rescues − reverse rescues is the difference in failure counts. It is still worth
     showing: each cell prints `+rescues / −reverse`, and a cell with reverse rescues
     carries the state-dependent-harm mark that step 3 uses.
   - **Moving the reference re-ranks the grid.** The header names the reference, so a
     ranking is never read without it.
   - `pairingMismatches` against the reference already runs (§7.2.3). A mismatch hides
     the paired reading and names the reason, as the baseline section does.

7. **The lab's rules carry over.**
   - Never a mean of terminal wealth. The statistics are percentiles only.
   - Selecting nominal net worth prints `mc-report`'s warning: it prices a pre-tax dollar
     at par with a Roth dollar, so use after-tax NW for any question about where wealth
     sits.
   - Lifetime tax prints: lower is not always better, because a conversion pays tax now to
     pay less later. Read it with after-tax NW.
   - The whole-path floor prints: on a plan still accumulating at t0 it is the opening
     balance, which no lever can change, so prefer the post-peak trough (the reason
     `mc-report --floor` is not the default).
   - The header prints n. At small n a gap of one or two paths is noise; the paired
     reading is the honest comparison for small effects.

8. **The selection lives in the presenter**, beside the reference cell, so a re-render,
   a click or a reference move keeps it.

### 10.4 The registry, phase 1

| Metric | Row field | Better | Zero on failure | Caveat |
|---|---|---|---|---|
| Failure rate | `failed` | lower | — | — |
| After-tax net worth | `afterTaxNW` | higher | no | — |
| Net worth (nominal) | `nw` | higher | no | wrapper warning |
| Net liquidity at the horizon (nominal) | `netLiq` (new) | higher | yes | — |
| Real net-liquidity trough, post-peak | `troughRealNetLiq` | higher | yes | read with the failure rate |
| Real net-liquidity floor, whole path | `minRealNetLiq` (new) | higher | yes | opening-balance warning |
| Trough drawdown | `troughRealDrawdown` (new) | lower | no | — |
| Realized NW CAGR | `netWorthCagr` | higher | no | — |
| Worst 5-year CAGR | `worst5yrCagr` | higher | no | — |
| Max drawdown | `maxDrawdown` | lower | no | counts the house |
| Lifetime tax | `taxPaid` (new) | lower | no | tax-timing warning |
| Cumulative shortfall | `deficit` (new) | lower | no | — |
| Months short | `deficitMonths` (new) | lower | no | — |

`repairSpend` stays on the row but is not a ranking criterion: it describes a draw, not
a decision.

### 10.5 Rows (option B)

`runsToRows` gains `netLiq`, `taxPaid`, `deficit`, `deficitMonths`, `minRealNetLiq` and
`troughRealDrawdown`. The batch runner's `runs` already carry the sources.
`runGridTask` passes the four `evaluate()` fields it drops today, and `gridCellRuns` maps
`netLiq` back to `finalNetLiquidity` instead of null.
- The change is additive, and it touches rows, not state, so the goldens do not move.
- A row is about fifteen numbers, so a 15 × 15 × 200 grid stays small (§7.2.5).
- The field names match the lab's MC rows (`scripts/lib/mc.mjs`), so a metric id means
  the same thing in both places. The deterministic lab rows (`scripts/lib/run.mjs`) say
  `netWorth` and `oofDate`; reconciling those is §10.8 G.

### 10.6 Phase 1 build order

1. **Rows.** Widen `runsToRows`, `runGridTask` and `gridCellRuns`. Tests: the new fields
   are present and finite on a plan-values cell, and that cell's rows still equal the
   batch's bit for bit (extend MGR-1).
2. **Registry and pure ranking.** `mc-grid-metrics.js`: `GRID_METRICS`,
   `gridCellMetric(cell, { metric, stat, reading, refRows, survivorsOnly })` returning
   `{ value, text, degenerate, n }`, and `rankCells(values, better)`. Unit tests:
   - the two §10.3.2 invariants against `summarizeGridCell`;
   - a `zeroOnFailure` cell at a failure rate of p or more is degenerate, and ranks after
     every valid cell;
   - survivors-only takes the percentile over survivors and reports their count;
   - ties share a rank;
   - the paired Δ equals `pairedMetric`'s p10/p50/p90 and win rate;
   - the paired failure reading's net rescues equal the difference in failure counts;
   - a field missing from old rows gives "unavailable", not zero.
3. **Panel.** Metric, statistic, reading and survivors-only controls above the heatmap.
   Direction-aware shading, rank marks, the best-cell outline, the caveat line, and the
   tooltip carrying the metric. The presenter holds the selection. Viz tests: changing a
   control re-renders without re-running; the default render still shows the failure rate
   (MC) and after-tax NW (deterministic); a degenerate cell prints "fails".
4. **Paired reading.** The diverging shade, the `+rescues / −reverse` failure cells, the
   harm mark, re-ranking on a reference move, and the mismatch banner. Viz tests in the
   style of `mc-results-paired.test.mjs`.

### 10.7 Phase 2 — a ranked list and a constraint

- **C, the ranked list.** A sortable table under the heatmap with one row per cell. Its
  columns are the phase 1 selection plus a chosen set of other metrics (default: failure
  rate, P50 after-tax NW, P10 trough). A header click sorts; the reference row is marked;
  clicking a row selects the cell, as a heatmap click does. It lets several criteria be
  read at once, and it reads a one-axis grid better than a one-column heatmap does.
- **E, constraint then objective.** "Among the cells where failure ≤ x% and P10 trough
  ≥ \$y, rank by z." Constraints are typed rows (metric, statistic, comparison,
  threshold) built from the row-list editor, never a JSON text area. Cells that miss a
  constraint are greyed out and unranked, and the header says how many of the cells
  qualify. It uses the same registry and `gridCellMetric`, so a constraint and a ranking
  cannot disagree about a number.
- The design pass is §10.10.

### 10.8 Later — noted, not yet designed

- **F, a frontier readout.** Port `grid-report`'s `last-passing` reduction: for each row,
  the last column that passes, with the off-grid markers (`<lo`, a trailing `+`) and the
  non-monotone flip warning. In MC mode, "passes" needs a threshold (failure ≤ x%). The
  in-app grid has at most two axes, so this is a one-dimensional frontier per row, not
  `variant-grid`'s reduction along a third axis. Open questions: more than two axes in
  the app, and whether the frontier takes E's constraint as its pass test.
- **G, a headless MC grid and one shared registry.** A `scripts/montecarlo/mc-grid.mjs
  --spec` that runs `McGridRunner` in Node, writes its cells' rows to a file, and
  re-reports them with the same registry. It would make an in-app grid reproducible and
  re-reportable on the command line, as `mc-run` and `mc-report` are for a batch. It
  needs the lab's deterministic row names (`netWorth`, `oofDate`) reconciled with the MC
  names, or an adapter, before `grid-report` can share the registry.

### 10.9 Phase 1 BUILT (12 Sep 2026)

- **Rows (B).**
  - `runsToRows` gained `netLiq`, `taxPaid`, `deficit`, `deficitMonths`,
    `troughRealDrawdown` and `minRealNetLiq`.
  - `runGridTask` passes on the four `evaluate()` fields it used to drop.
  - `gridCellRuns` maps them back to run records, so `finalNetLiquidity` is no longer null.
- **Registry and ranking (A).** `mc-grid-metrics.js` holds `GRID_METRICS` (the 13 entries
  of §10.4), `normalizeGridReading`, `gridCellMetric` and `rankCells`. `mc-grid.js` now
  exports `percentile`, so the ranking and the cell summary share one formula.
- **Panel.**
  - "Rank by" controls above the heatmap: `.mc-grid-metric`, and in MC mode also
    `.mc-grid-stat`, `.mc-grid-reading` and `.mc-grid-survivors`.
  - Each cell prints its value (`.mc-grid-val`), its rank (`.mc-grid-rank`) and, when
    survivors-only is on, the survivor count (`.mc-grid-sub`).
  - The best cell's rank mark is drawn in the theme accent (`--accent-primary`).
  - Level shading uses one hue, and darker is better. A paired Δ shades green or red.
    The tint is scaled to at most 36% of the hue, so the text reads over the darkest cell.
  - The metric's caveat line sits above the table, and the tooltip gains a
    "metric · rank #k of N" line.
- **Paired reading (D).**
  - The reference cell prints "ref".
  - A failure cell prints `+rescues / −reverse`, with ⚠ and `.mc-grid-cell--harm` when it
    makes a world worse.
  - If any cell is not paired with the reference, a banner names the reason and the
    cells show levels.
- **Presenter.** The ranking lives in `_gridView.rank`. It is carried across a rebuild
  (`getGridState` / `restoreGrid`) and onto the next grid of the same mode.
- **Tests:**
  - `tests/unit/mc-grid-metrics.test.mjs` (MGM-1…10);
  - MCA-2, extended with the new fields;
  - MGR-3: the new fields are on every grid row, and they equal the batch's;
  - `tests/viz/mc-grid.test.mjs`: five ranking tests, plus the existing ones updated for
    darker = better and the rank marks.

  All unit and viz tests pass.

**Decided while building:**
- **A grid where every cell ties** shades blank and outlines no best cell, because nothing
  there stands out. Before, a deterministic grid shaded every cell dark in that case.
- **Survivors-only in the paired reading** keeps only the worlds where both cells survive.
- **The win rate of a lower-is-better metric** is the share of worlds where the value
  falls. It always ranks higher-is-better.
- **A new grid keeps the ranking** only when its mode matches the last grid's. A
  deterministic grid ranked on the failure rate would be pass/fail, which ✗ already shows.

**Polished after use in the app (12 Sep 2026):**
- **The best cell is not ringed in green.** In the paired failure reading, every cell that
  ties the reference ranks #1, so a green ring marked 12 of 16 cells. It made "no
  different" read as "better", in the same hue as a gain. The #1 mark is now drawn in the
  theme accent instead.
- **Harm is a warning-coloured border**, not warning-coloured text: orange text over a red
  loss fill did not read.
- **A zero count or difference has no sign.** Tied cells read `0 / 0`, not `+0 / −0`.

### 10.10 Phase 2 design (12 Sep 2026)

**Decided with the user:**
- **List columns:** the ranking column, then failure rate, P50 after-tax NW and P10
  trough, with any duplicate of the ranking column dropped. The user can add, remove and
  reorder columns.
- **Constraints are session state.** They live in `_gridView.rank`, beside the ranking,
  and travel with it across a rebuild and onto the next grid of the same mode. The grid's
  axes and results are not saved with the scenario, so a saved constraint would have no
  grid to apply to.
- **Constraints read levels only.** A constraint is the cell's own value, so moving the
  reference never changes which cells qualify. The objective can still rank on Δ.
- **The list sits under the heatmap**, always shown, between the heatmap and the cell
  detail.

**E, constraints.**
- A constraint is `{ metric, stat, op, threshold }`, edited as typed rows in the
  row-list editor: a metric, a statistic (P10, P50 or P90; hidden for the failure rate and
  in deterministic mode), `≥` or `≤`, and a threshold.
- **The threshold is typed in the unit the panel prints:** dollars, a percentage (10 means
  10%) or a count. One helper converts it, so a percentage constraint cannot be compared
  with a fraction by mistake.
- A new row starts as "failure rate ≤ 10%". Picking a metric sets `op` to its better
  direction (`≥` for higher-is-better); the user can flip it.
- **A row with a blank threshold is inactive.** It stays in the editor, so a half-typed
  row is not lost, and it does not count.
- **What a constraint reads:**
  - It is taken over all of the cell's paths. Survivors-only is a way of viewing the
    ranking, not part of the test.
  - A degenerate value (§10.3.4) is still a number, about zero, so "P10 trough ≥ \$y"
    fails it on its own; there is no special case.
  - An unavailable metric fails the constraint, and the reason says so.
- **In the heatmap:** a cell that misses any active constraint is greyed, unshaded and
  unranked, and its tooltip lists what it missed. Ranks, shading and the best mark are
  computed over the qualifying cells only. A line above the table reads "k of N cells meet
  the constraints". If none qualify it says so, and nothing is ranked.
- `rankCells(results, eligible)` takes the qualifying mask. `gridConstraintCheck(rows,
  constraints, mode)` returns `{ meets, misses }` from `gridCellMetric`, so a constraint
  and a column cannot disagree about a number.

**C, the ranked list.**
- A table with one row per cell: rank, the cell's axis values, the ranking column (on the
  current reading, Δ included), then the chosen columns. The chosen columns read levels,
  each at its own statistic.
- When constraints are active, a "Meets" column shows ✓, or ✗ with what the cell missed.
- **Order:** by rank by default, with unranked cells last. A header click sorts on that
  column, and a second click reverses it. The sort is kept in the view state.
- The reference row is marked and the selected row is highlighted. A row click selects
  the cell, as a heatmap click does.
- The columns are a reorderable row-list of `{ metric, stat }`; its "+ Add" appends P50
  after-tax NW.
- The constraints and columns editors are collapsible sections. The constraints section
  opens when any constraint is set.

**Build order:**
1. **Pure.** Add `normalizeGridConstraints`, `normalizeGridColumns`,
   `gridConstraintCheck`, and the `eligible` mask on `rankCells`, to `mc-grid-metrics.js`.
   `normalizeGridReading` carries `constraints`, `columns` and `listSort`. Unit tests:
   `op` and units, a blank row is inactive, unavailable fails, the failure rate ignores
   `stat`, deterministic mode forces P50, and ranks cover the eligible cells only.
2. **Constraints in the heatmap.** The editor, the greyed cells, the count line, and
   ranks over the qualifiers. Viz tests.
3. **The list.** The table, the sort, row selection and the columns editor. Viz tests,
   plus a presenter test that the constraints survive `getGridState` / `restoreGrid`.

### 10.11 Phase 2 BUILT (12 Sep 2026)

- **Pure (`mc-grid-metrics.js`).**
  - New: `GRID_CONSTRAINT_OPS`, `DEFAULT_GRID_COLUMNS`, `betterOp`,
    `normalizeGridConstraints`, `activeConstraints`, `normalizeGridColumns`,
    `constraintThreshold` and `gridConstraintCheck(rows, constraints)`.
  - `rankCells(results, eligible)` ranks only the eligible cells.
  - `normalizeGridReading` carries `constraints`, `columns` and `listSort` in both modes.
- **Panel.**
  - A collapsible "Constraints" section (`.mc-grid-constraints`) below the "Rank by"
    controls. A cell that misses a constraint gets `.mc-grid-cell--excluded`, and its
    tooltip gains a "misses: …" line. The `.mc-grid-qualify` line gives the count.
  - The list (`.mc-grid-list`, "Cells, ranked") sits between the heatmap note and the
    cell detail, with a collapsible "Columns" editor (`.mc-grid-columns`).
  - `_setGridRank` and `_selectGridCell` are now shared by the heatmap, the editors and
    the list.
- **Tests:**
  - MGM-11…15;
  - four viz tests in `tests/viz/mc-grid.test.mjs`: a constraint greys and re-ranks;
    better direction and none qualifying; the list's sort and selection; the columns;
  - the presenter round trip now carries a constraint.

  All unit and viz tests pass.

**Decided while building:**
- **`gridConstraintCheck` takes no mode.** The constraints are normalized per mode, so a
  deterministic constraint already reads P50.
- **The ranking column sorts by rank, not by its raw value.** Rank already places
  degenerate and ineligible cells, and a paired Δ and a win rate sort correctly without a
  case of their own.
- **A boundary value meets its constraint** (a 1e-9 tolerance), so a typed "20" admits a
  cell at exactly 20%.

**Polished after a first look on a real plan (12 Sep 2026, 4 × 4 house-sale-year grid):**
- **The list names the axes once.** The header reads "AU House Sale Year · US House Sale
  Year" and each row shows "2027 · 2028", with the full label on hover. Repeating the full
  label on every row pushed the value columns and Meets off the pane.
- **The editors take the grid's 10px size.** The shared row-list editor is sized for the
  scenario forms, and among the grid controls it was the largest thing on the pane. The
  override is scoped to `.mc-grid-section`.
