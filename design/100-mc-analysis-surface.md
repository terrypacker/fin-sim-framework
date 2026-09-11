# 100 — The Monte Carlo analysis surface (in-app)

**Status: PROPOSED (11 Sep 2026). Step 1 BUILT (11 Sep 2026); steps 2–4 not started.**

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

## 6. Pairing — why it is checked, not assumed

`mc-run` and `mc-report` rely on "same flags, same n" discipline by convention. In the app
the two runs are separated by arbitrary UI edits, so the convention cannot be relied on.
The guard compares the facts that define the random stream. A config edit that enables
one more MC variable changes every subsequent draw index, and the paired counts would
then describe noise.

## 7. Step 4 — multi-lever grid (to be designed)

The app has no 2-D grid. `GridSearchSolver` enumerates optimizer variables but scores
each cell with one deterministic run; `sweep-scenario` varies one param on the command
line. Sketch, to be refined before building:

- **Axes** come from the design 98 sweep surface (harvested rows), two at a time, each
  with a value list.
- **Deterministic cells first**: one run per cell on the worker pool, heatmap of end NW,
  after-tax NW or failed/not. Fast, and it shows the shape (the sweep-scenario question,
  in two dimensions).
- **MC cells second**: small n per cell with common random numbers across cells, so
  neighbouring cells are paired. The heatmap shows failure rate, and a cell's tooltip
  shows the paired rescue counts against a chosen reference cell. The cost is roughly
  cells × n × seconds-per-path ÷ worker speed-up, which must be shown before launching.

Open: whether the grid lives in the MC tab or the Optimize tab, and how its runs relate
to the baseline slot.

## 8. Open questions

1. Does the baseline slot survive a scenario switch? Proposed: no; it is keyed to the
   scenario id, like the result carry.
2. Should the path-shape section be collapsible so the fan chart stays above the fold?
3. Mix bands in MC Results, or a mode of the Allocation tab? Proposed: MC Results, since
   the Allocation tab is a single-run view and mixing the two would blur which world is
   shown.
