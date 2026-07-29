# 82 — Allocation over time: reporting the realized asset mix

**Status** (2026-07-29, `wip/allocation-reporting`):

| phase | what | status |
|---|---|---|
| **1** | the cube, the shared pivot, a self-contained HTML lab report | **IMPLEMENTED** |
| **1b** | shared FX helper + year-boundary sampling (§5.1) | **IMPLEMENTED** (2026-07-29) |
| **2** | workbench plugin | **IMPLEMENTED** (2026-07-29) — never needed design 81 |
| **3** | target-vs-realized overlay | **IMPLEMENTED** (2026-07-29) — the payoff |
| **4** | Monte Carlo mix distribution | **PROPOSED** |

Scope: answer "what is my asset allocation, and how does it change over the plan" — per
account, per country, and in total — and make the answer trustworthy enough to act on.

Written *after* the prototype rather than before it, deliberately: the open question was
never architectural, it was **taste** — does this report structure answer questions when you
look at it? A doc written first would have been guessing at the layout. What follows is what
the prototype settled, so Phase 2 can start cold.

Every open question is now answered, and the answers have moved into the sections they change
(§4 sampling, §5.1 the two cleanups, §6 Phase 2, §8 Phase 4). **§10 is the decision record** —
what was decided, and why, so a closed fork stays closed.

---

## 1. Motivation

A net-worth line hides the shape of the plan. The reference plan ends at ~$28m and looks
healthy the whole way; the allocation view shows `REAL_ESTATE` going **16.3% → 90.2%** of
gross assets while `EQUITY` drains to zero, and gold making a ~94% round trip in a single
year. None of that is visible in a total, and all of it is decision-relevant.

The sharper question the view exists to answer: in retirement, **is the portfolio's shape
being chosen, or is it whatever the drawdown order left behind?** Design 58 sequences the
draws and design 65 orders the sleeves; neither surfaces the resulting mix over time.

---

## 2. The decision that matters: one fact table, grouped in the view

The three asks — per account, per country, per total — are **not three features**. They are
three `GROUP BY`s over one fact table.

Committing to a grouping at emit time was the only decision here that would have forced a
rewrite, because every later question ("by wrapper?", "by return series?") would have needed
a new emitter. So the cube emits the **tuple** and every grouping, denominator and share is
decided by the consumer.

| ask | how |
|---|---|
| total over time | `by: ['assetClass']` |
| per country over time | `by: ['domicileCountry', 'assetClass']` |
| per account over time | `filter: r => r.stateKey === k` |
| *(free)* by return series | `by: ['rateKey']` |
| *(free)* by wrapper | `by: ['role']` |

### 2.1 The row

One row per `(stateKey, allocation, rateKey)` bucket per sample date:

```text
date, stateKey, name, source, kind, role, type,
domicileCountry, exposureCountry, currency,
assetClass, allocation, rateKey, holdingCount,
marketValueLocal, marketValue, costBasisLocal, costBasis, inferred
```

**Buckets, not holdings.** A 30-rung bond ladder collapses to one `BOND` row carrying
`holdingCount: 30` — which is what an allocation view wants, and it keeps a 45-year cube in
the low thousands of rows (1,310 on the reference plan).

**`source` is the provenance column** and earns its place: `holding` (read from
`holdings[]`), `account-balance` (synthesized for a tier-2 account with no holdings),
`asset` (real property / company / collectible), `liability` (a loan), `reconciliation` (the
holdings-vs-balance residual). A view can show *how much of the picture is being assumed*.

### 2.2 Two country columns, not one

`domicileCountry` is the wrapper's jurisdiction (the tax view). `exposureCountry` comes from
the holding's `rateKey` (the risk view). They legitimately disagree when a US wrapper holds
an `EQUITY_AU` sleeve, so picking one and calling it "country" would be a lie. Emitting both
costs one field each.

On the reference plan they are **byte-identical** — no sleeve is held outside its home
market. The report detects that and says so rather than offering a toggle that changes
nothing.

### 2.3 `ASSET_CLASS` is report-only, and must stay that way

`ALLOCATION` is a closed four-value enum *because it is load-bearing*: every value must be
handled by the rebalancer, the drawdown sleeve order, shock revaluation and rateKey
resolution, and a value none of them recognise is silently excluded from all four
(`holdings/allocation.js`). Adding `REAL_ESTATE` to it would oblige us to answer "does the
rebalancer sell my house?".

But a report showing only account holdings answers a narrower question than the one asked —
a plan that is 90% one house is not a 60/40 portfolio, and a chart that says it is lies by
omission. So `ASSET_CLASS` is a **purely descriptive superset** that exists only in
reporting: the four allocations mapped 1:1, plus `REAL_ESTATE`, `PRIVATE_EQUITY`,
`COLLECTIBLE`, `LIABILITY`, `UNKNOWN`. Nothing in the sim reads it.

### 2.4 A report never refuses to draw

Inside the sim an unrecognised allocation is a load-time error, and that is right — a
holding no consumer recognises is silently skipped, so failing loudly is the only way it gets
noticed. **A report inverts that.** Refusing to render leaves the operator with nothing;
rendering an honest `UNKNOWN` band leaves them looking straight at the anomaly. So every
classification failure degrades to a visible bucket, and `resolveDefaultAllocation`'s throw
is caught rather than propagated.

The same instinct drives `reconcileToBalance`: holdings and the denormalized
`account.balance` are known to drift, so the residual is emitted as its own labelled row.
The cube's total therefore always ties to the balance and the drift shows up as a band
instead of a silent error. (It has never fired on a real plan — that is the good outcome.)

---

## 3. THE INVARIANT

```text
Σ rows.marketValue === computeNetWorth(state, baseCurrency)
```

with every `include*` option on. This is not a nicety. **A denominator that omits an asset
misstates every slice, not just the missing one.**

It is therefore load-bearing that inclusion uses net worth's *own* rule — a numeric
`balance`, or a recognised asset `kind` — and never a narrower one.

> ⚠ An earlier draft scoped accounts to `StateSchemaRegistry#accountBalanceKeys()`, which
> looks more precise and is strictly worse: **loan accounts do not register under the
> `account` display kind**, so every loan silently vanished and the cube ran **$218,710**
> above net worth on a real plan, decaying to zero as the mortgages amortized. The synthetic
> default scenario has no loans and tied perfectly throughout, so only a real plan exposed
> it. `type === 'loan'` is now tested first and on its own.

Verified: **0 drift across 147 year-ends spanning four scenarios.**

Liabilities are carried **negative**, so a group-by summing `marketValue` nets
automatically while filtering the class out gives the gross-asset denominator a mix needs.
One table serves both questions.

---

## 4. Sampling: one policy, at the year boundary

Three consumers need samples — the lab script, the plugin, Monte Carlo — and **they must all
sample the same way**, or the same scenario reports a different mix in the app than on the
page and there is no way to tell which is right. That is the same argument that put the pivot
in `src/` (§5); it applies to the x-axis too.

**The committed policy: one sample per calendar year, taken at the year boundary, delivered
through the run's `sampler` hook.**

Three candidate cadences and why this one:

| cadence | verdict |
|---|---|
| every **N events** (`snapshotInterval`, default 12) | **No.** Nearly free, but sample dates drift with event volume and differ between scenarios, so two runs cannot be laid side by side. |
| last sample **within** each calendar year | **No.** Comparable by year label, but it lands at an arbitrary event — possibly *before* the year-end rebalance. A net-worth line barely notices; a **mix** chart is precisely sensitive to whether the rebalance has fired, so this would make the rebalancer's effect appear and disappear with event volume. |
| **at the year boundary** — the state after the last event dated in year Y | **Yes.** Post-rebalance, post-settle, comparable across runs, ~45 samples. |

The third is also *exactly* what Phase 1's `stepTo(31 December)` produces: events are the only
thing that changes state, so "after all events dated ≤ 31 Dec Y" and "after the last event
dated in year Y" are the same state. **Converting the lab script to the sampler therefore
changes no published number** — §9's figures stay valid.

`Simulation` already carried the hook this needs — `buildSim({ sampler })`, added by design 78
§4.5 so MC could collect a yearly series without deep-cloning state — but it fired only on the
*event-count* cadence, which is the row this section rejects. Phase 1b added
`samplerCadence: 'year-boundary'` beside it (§5.1b), and the lab script now samples through it.

One caveat this exposed, in §5.2: the annual investment family is dated **1 January**, so a
31 December sample reads *before* that year's growth is credited. Pre-existing, self-consistent,
and now written down rather than assumed.

**Why a hook and not `state.metrics.*`.** Do not write the cube into state per event: ~70
numbers in every stateDiff and every snapshot, and design 78 established that telemetry, not
sim math, is the cost. The sampler is the shape design 78 arrived at for exactly this — it
receives live state, returns plain numbers, and retains nothing.

**FX**: converted per sample date on `computeNetWorth`'s convention (pair `${base}_${quote}`,
divide) so the two cannot disagree about what a dollar is — Phase 1b makes that literal by
sharing one helper (§5.1). Consequence to hold: figures are **nominal base-currency**, so a
flat AUD sleeve shrinks as USD strengthens, and a 2070 dollar is not a 2026 dollar. The 100%
view is immune to both, which is why it leads the page.

---

## 5. What shipped (Phase 1)

```text
src/finance/allocation-reporting/
  allocation-cube.js       buildAllocationCube(state, opts) → rows[]
  asset-class.js           ASSET_CLASS + rateKey → exposure country
  allocation-grouping.js   buildAllocationSeries / mixAt → {dates, keys, series}
src/finance/fx/to-base-currency.js       the shared valuation FX helper (Phase 1b a)
scripts/lab/allocation-report.mjs        one self-contained HTML page
tests/unit/allocation-cube.test.mjs          (27)
tests/unit/allocation-grouping.test.mjs      (16)
tests/unit/sampler-year-boundary.test.mjs    (5, Phase 1b b)
```

```bash
node scripts/lab/allocation-report.mjs \
  --scenario scenarios/fin-sim-scenarios.json \
  --out scenarios/allocation-report.html --csv
```

**The pivot lives in `src/`, not in the script.** The prototype page and the eventual plugin
must not each grow their own pivot: the moment they do, they can disagree about a share and
there is no way to tell which is right. Same reasoning as `lib/grid-report.mjs` being shared
between the terminal report and `study-report.mjs`.

**The page ships precomputed series, never the grouping logic.** Every pivot is computed in
node through the shared module; the browser only picks which precomputed object to display.

Sections: Provenance (tie-out first — the page is not quotable until the cube ties),
Headlines, Total, By country, By account, By return series, Year-end mix table. Every chart
has a share/$ toggle; Total has a net-worth checkbox, By country a domicile/exposure toggle,
By account a picker. ECharts is inlined from `node_modules` (~1.2 MB, offline).

### 5.1 Phase 1b — the two cleanups Phase 1 deferred (IMPLEMENTED 2026-07-29)

Both are prerequisites for Phases 2 and 4, and both are pure refactors, so the acceptance test
is the same for each: **the lab report's numbers must not move** — regenerate against
`scenarios/fin-sim-scenarios.json` and diff the CSV. **Result: rows 1–1,310 byte-identical**,
4,212 unit + 958 viz tests green. The only difference is one *added* sample, discussed in
§5.2.

**(a) One FX conversion, shared.** Phase 1 duplicated `computeNetWorth`'s conversion into a
private `_toBase` with a comment promising they stay in step. A comment is not a mechanism,
and the invariant in §3 is *exactly* the thing a divergence would break — silently, because
both sides would still be self-consistent.

- `toBaseCurrency(amount, currency, baseCurrency, state)` + `currencyOf(entry, fallback)` now
  live in `src/finance/fx/to-base-currency.js` — a sibling of `fx-conversion.js`, which owns
  the *transfer* math (rate + fee, design 44) and is a different question from *valuation*.
  `currencyOf` came along because the `{code}` object vs bare string duality is part of the
  same trap and every valuation site has to get it right.
- `computeNetWorth` and `buildAllocationCube` both call it; nothing else changed.
- **Scoped to those two on purpose.** The same six lines also appear in `net-liquidity.js`,
  `after-tax.js`, `guardrail-portfolio-value.js` and the MC runner's `computeHouseValueUsd`.
  Those are four more golden-locked metrics; converting them is right, but it is not this
  design's change and it does not belong in a commit whose subject is a report. Tracked in §10
  so the duplication is not forgotten.

**(b) Year-boundary sampling (§4).** The cadence now lives on `Simulation`'s existing
`sampler` hook, and the lab script samples through it instead of driving its own `stepTo` loop.

- `samplerCadence: 'interval' | 'year-boundary'`, threaded through `buildSim` and `openSim`,
  **defaulting to `'interval'`** so design 78's MC series is bit-identical and nothing
  existing re-baselines.
- `'year-boundary'` fires from `stepTo`, where the *next* event's date is visible: when that
  date's year is beyond the clock's, every intervening year is complete, so each is sampled
  before the event lands. A gap year (events jumping 2040 → 2042) still gets its sample,
  carrying the 2040 state — because that *is* the state throughout 2041, and a hole in an
  x-axis whose purpose is comparability is worse than a flat segment.
- Each sample is stamped at **the last year-end instant at which the state is still
  unchanged**: 31 December of the completed year, or the horizon when the run ends mid-year.
  One rule covers the boundary case and the terminal flush.
- **The terminal flush** records where the clock stopped, or the end of the plan — the
  most-quoted point on any chart — is the one that is missing, since no later event ever
  arrives to trigger its boundary.
- **Playback safety: samples upsert on their year.** Scrubbing to mid-2040 files a partial
  2040 sample; stepping on through 2041 replaces it with the completed one. Without the upsert
  the partial reading would win permanently — one bad point on a chart, with nothing to
  indicate it.
- Cost: one integer compare per event (~1,800), a cube built ~45 times. Cheap enough that no
  gating is needed — which is why Phase 2 needs no "enable sampling" toggle.
- `tests/unit/sampler-year-boundary.test.mjs` (5) pins the contract, including the load-bearing
  one: **a year-boundary sample equals what `stepTo(31 December)` leaves behind.** That is what
  lets the lab page and the plugin sample through different mechanisms and still quote the same
  number.

### 5.2 What the conversion exposed: the 1 January cascade

The one new row group is a sample at **2070-01-01** — the reference plan's `simEnd`. The old
loop dropped it (`if (at > end) break` skipped a 31 December it could not reach), so the report
had never shown the terminal state at all.

It is worth more than a footnote, because of *how much* it differs: equity in one account reads
**$8.60m at 2069-12-31 and $11.29m at 2070-01-01**. One day, +31%. The cause is that the
annual investment family hangs off `PERIOD_ADVANCE_US`, which is dated **1 January**, together
with the appreciation events for property, company equity and collectibles. So:

> **Every 31 December sample is read *before* the year's investment growth and appreciation are
> credited.** The mix labelled "2069" reflects growth credited through 1 January 2069.

This is **pre-existing** — Phase 1's `stepTo(31 Dec)` loop had exactly the same property, which
is why the numbers are byte-identical — but it is precisely the class of error §4 rejects the
event-count cadence over, so it cannot be left implicit:

- Charts are self-consistent (every point sits at the same place in the annual cycle) and the
  year *labels* lag the growth they are named for.
- The terminal sample is **not** comparable with the others: it covers a partial year and sits
  on the far side of the cascade. The lab page now says so in Provenance rather than drawing it
  silently; any Phase 2 panel must do the same.
- Whether the boundary should instead sit *after* the 1 January cascade — "the start of year
  Y+1, once the period advance has run" — is a real question and deliberately **not** settled
  here, because it would move every published figure. Recorded in §10.

---

## 6. Phase 2 — workbench plugin (proposed)

**It is a new kind of report, and that matters.** Every `ReportDefinition` in the registry
today is **journal-derived and table-only**: `buildQuery(params, api)` compiling an AST over
journal rows, rendered as grouped rows with aggregates and CSV. No charts anywhere in
`journal-report-plugin.js`.

An allocation report is different on both axes — **state-sampled**, not journal-derived
(holdings are a state shape; the journal carries only their *diffs*), and chart-first. So it
should be a **sibling of `ReportDefinition`, not a subclass**. Do not force it through
`buildQuery`; that means fighting the journal abstraction to reconstruct a balance you can
read directly.

Worth stealing: the facet / groupBy / aggregate *vocabulary* — facets for `country` and
`stateKey`, a groupBy toggle for `assetClass` vs `rateKey` vs `role`. Same mental model,
different source. **Recommendation: stay parallel for now.** One chart-bearing report is not
enough evidence to abstract over; revisit at the second.

**It never needed design 81.** An earlier draft assumed app-side sampling had to wait for a
replayable run, because a plugin cannot re-`stepTo` the primary sim without disturbing
playback. It doesn't have to: the run already accepts a `sampler`, so the samples are
collected **as the run happens** and the plugin only reads what was recorded — which is how
this shipped. Design 81 stays a genuine upgrade (resample or re-cut without re-running,
exact-date sampling for anything the year boundary is too coarse for), not a prerequisite.

What shipped:

```text
src/visualization/workbench/plugins/finance/allocation-plugin.js   the panel
src/finance/allocation-reporting/allocation-sampler.js            the record, shared
src/finance/allocation-reporting/allocation-palette.js            which hue means which class
assets/css/plugins/allocation.css
tests/viz/allocation-plugin.test.mjs          (9)
tests/viz/workbench-layout-new-tabs.test.mjs  (4)
```

1. **The plugin sits beside `holdings-plugin.js`** — that panel is the per-account snapshot at
   the scrubbed date; this is its over-time sibling, and it reads `sim.samples` rather than
   sampling anything itself.
2. **The sampler is the only integration point**, installed in `workbench-app.js` on the
   `'year-boundary'` cadence. No re-stepping, no second sim, no playback interference; the
   panel fills in *as the run advances*.
3. **Sampled unconditionally.** An "enable allocation sampling" toggle was considered and
   rejected: ~45 cube builds per run is not worth a mode the user can be in the wrong half of,
   and a panel whose empty state reads "re-run with sampling on" is a panel people stop
   opening.
4. **The sample RECORD is shared, not just the pivot** (`allocation-sampler.js`). §4 binds
   every consumer to one sample instant; this binds them to one set of fields, including the
   tie-out — computed at the instant the rows are built, because a tie-out measured against a
   net worth read at a different moment is not a check of anything.
5. **The tie-out is stated above the chart**, and turns loud on failure ("do not quote any
   share here"). Same rule as the lab page, and it matters more here: nobody diffs a panel
   against a CSV.
6. **One legend, not two.** The ECharts legend and the mix strip said nearly the same thing and
   together ate a third of a docked pane's height, so the legend is off and the strip does both
   jobs: swatch, name, *and* the band's share at the latest sample — ordered like the bands,
   clickable to hide one. A band at 0.0% keeps its row; "equity is gone by now" is a finding.
7. Colours come from `allocation-palette.js`, shared with the lab page, so the purple band is
   the house in both. Light and dark tunings of the same assignment — the page is light, the
   workbench dark.

Two defects this phase found and fixed, both invisible to unit tests and obvious on screen:

- **A newly registered panel was invisible to anyone with a saved layout.** `WorkbenchLayoutModel`
  backfilled only top-level keys, so `center.tabs` never gained the new id — the plugin loaded,
  worked, and had no tab, which reads as "the feature is broken". Now default tabs the saved
  layout has never seen are placed, while a tab the user *closed* stays closed via an explicit
  `closedTabs` record. This was a latent trap for every future plugin, not just this one.
- **The ECharts canvas never resized.** It sizes once at init, and this panel's height changes
  with no window resize (the provenance strip appears with the first sample, the legend strip
  with the first series), so the x-axis labels drew on top of the strip below. A `ResizeObserver`
  on the chart box, torn down with the chart.

---

## 7. Phase 3 — the overlay that makes it decision-grade (IMPLEMENTED)

The realized mix against the **intended** one: solid line what the plan holds, dashed what it
was aiming at, per class, over the whole plan. `RebalanceToTargetReducer` already stamps
`account.targetComposition` every period even when no rebalance fires (design 65 §OQ1a), so
the target was already in reach at zero extra cost.

```text
src/finance/allocation-reporting/target-cube.js   buildTargetCube / targetedStateKeys / driftAgainstTarget
tests/unit/target-cube.test.mjs                   (8)
```

Both consumers render it: a **Target vs realized** section on the lab page and a
**Target vs actual** view in the panel, off the same module.

### 7.1 Target rows carry dollars, not weights

`targetComposition` is fractions **of each account's own holdings total**. Fractions of
different denominators cannot be summed, so emitting them raw makes every aggregate wrong in
a way that still looks plausible — average a $10k account with a $10m one and the "portfolio
target" is fiction. Each row therefore carries `marketValue = weight × that account's holdings
total`, FX-converted. Dollars add up, so **the ordinary group-by produces the aggregate
target** and normalizing it gives the target share: one pivot, both tables.

### 7.2 The comparison set is the whole difficulty

A target exists only for accounts the rebalancer manages. Measuring it against a book that
also holds a house, a company stake and collectibles reports a "drift" that is really two
different questions side by side — and on the reference plan that fake drift would be tens of
points, swamping the real thing. `targetedStateKeys()` exists so both sides are held to the
same accounts, and both views say so on screen ("both sides cover the same 12 rebalanced
accounts").

Under design 61's LOCATED mode, per-account targets are *deliberately* extreme — a 401k
targeted 100% GOLD, an IRA 98% BOND. One account at a time therefore looks alarming and means
nothing; the **aggregate** is the portfolio target the user actually set. So the aggregate is
the headline and per-account is the *location* diagnostic ("is the class where the plan wants
it?"), not a second opinion on the mix.

### 7.3 Two instants, and only one of them is honest

The rebalance fires on the **1 January** period advance. Two consequences, both load-bearing:

- A 31 December sample is read *just before* the correction, so it shows **how far the band
  actually let the book move** over that year. That is the number worth reporting.
- A run whose horizon is 1 January produces a terminal sample taken *immediately after* a
  rebalance, which reads drift of **exactly 0.0% for every class**. Quoting it would tell the
  reader the book is perfectly on policy at the one instant it cannot be otherwise. Both views
  therefore read the drift table at the last **year-end** (`lastYearEndIndex`) and say which
  instant they used. This was caught by looking at the rendered page, not by a test.

### 7.4 Small things that carry weight

- **The reducer now stamps `targetBand`** beside the composition — the band it just
  drift-checked against. A report re-deriving it from params plus a taxable/sheltered role
  split would be a second source of truth that can silently disagree with `TAXABLE_ROLES`.
- **A drained account's stale target is ignored.** The reducer stamps only accounts with a
  positive holdings total and never *clears* a stamp, so a fully drawn-down account keeps its
  last target forever; skipping zero-total accounts uses the reducer's own rule.
- **Realized uses `source === 'holding'`** — the reducer's own basis. Letting a reconciliation
  residual in would show drift the rebalancer was never looking at.
- **Lines, not two stacked areas.** Comparing stacked bands by eye means judging thicknesses
  at different offsets; the question is per-class distance from a target, which is what a solid
  line against a dashed one shows.
- **Both sides of a gap are flagged.** 10 points over-weight equity *is* 10 points under-weight
  bonds; flagging one would hide half the story. A class held but never targeted counts too —
  design 61 §12.1 D2 was exactly the drift check being blind to a zero-target class.

### 7.5 What it found immediately

On the reference plan at **2069-12-31**: **+10.2 points equity, −11.6 points bonds, both far
outside the ±2.0% sheltered band.** A year of growth and drawdown moves the book roughly five
times the band, and nothing corrects it until the next 1 January — so "rebalanced to a 2%
band" describes the *instant after* the rebalance, not the year the money is actually invested
in. The chart also shows realized tracking target closely until ~2053 and then both going
wild together as accounts drain: after that point the target itself is being re-planned around
what is left, which is design 58/65's drawdown re-shaping the plan rather than a policy choice.

---

## 8. Phase 4 — the mix as a distribution (Monte Carlo)

**A different question, not a different chart.** Phase 1 answers "on the central path, what
shape does this plan take?" Monte Carlo answers "**how often** does it take that shape?" —
and for the finding in §9 that is the more decision-relevant of the two. "Ends 90% house" is
alarming; "ends ≥60% house in 80% of paths" is actionable, and "in 8%" is noise.

### 8.1 What each iteration records

MC already runs with `telemetry: 'off'` plus a `sampler` (design 78 §4.5) — the exact seam
this needs. Extend the sampler's record with a mix vector:

```text
{ date, netWorthUsd, netLiquidity, houseValueUsd,      // existing
  grossAssetsUsd,                                      // the mix denominator
  mix: { EQUITY: 0.41, BOND: 0.12, … } }               // shares, summing to 1
```

built by `buildAllocationCube` → `mixAt` — **the same shared modules the lab page uses**, so
a share means the same thing in both places. ~10 numbers per year per iteration; still
numbers-only, still nothing retained from state.

Rejected: keeping the **full cube** per iteration (~1.3m rows at n=1000). Maximally flexible
post-hoc and directly against design 78's lesson; the flexibility is not worth an artifact
nobody can open. Also rejected: **terminal mix only** — it answers the house question and
nothing about *when* the shape turns, which is where a lever could act.

### 8.2 What the run reports

1. **Per-year share bands** — p10/p50/p90 of each class's share at each year index.
2. **Threshold probabilities** — the readouts worth quoting: `P(REAL_ESTATE ≥ 60% of gross
   assets at simEnd)`, `P(EQUITY share = 0 before age 80)`, `P(illiquid ≥ 75% at any year)`.
   Thresholds live in config, not in code comments, so they can move without a re-run.
3. **Mix conditioned on failure** — split (1) by `scenarioFailed`. If failing paths are the
   90%-house paths, the shape *is* the failure mechanism and Phase 3's overlay is where to
   intervene. If they are not, the shape is a bequest-composition question, not a solvency
   one. This is the number that decides which of those two conversations to have.

**Two honest constraints on the drawing.** Per-class percentile bands are **marginal**: the
p90 `EQUITY` band and the p90 `REAL_ESTATE` band come from different paths, so they do not sum
to 1. They must be drawn as separate bands per class — **never stacked**, which would assert a
mix no path ever held. And a path with **zero gross assets** (post-ruin) has no meaningful mix:
`0/0`. Exclude those from the share percentiles and report the excluded count as its own
series per year, or "90% house" silently absorbs every ruined path.

### 8.3 The cost this phase must budget for

Switching MC to §5.1(b)'s `'year-boundary'` cadence **moves MC's existing yearly `netWorth`
series** — today it is the last sample *within* each year, which is mid-something. That is a
fidelity improvement (design 78 chose the event cadence for cheapness, not for correctness),
but it re-baselines every MC output, and MC outputs are the decision documents. Accept it
deliberately, in one commit, with the direction stated: year-end values sit slightly higher
than mid-year ones as growth compounds, while failure rates should barely move.

Per design 78's own finding, the added compute (~45 cube builds per iteration) should be
small against ~1,800 events — but **measure it before it goes on by default**, and follow the
standing rule about long MC re-runs: ship the code and the runner change, write the re-run
instructions into the decision doc, and do not block the phase on a 30–45 minute re-run.
Report surface is `scripts/montecarlo/mc-report.mjs`; note that it globs the arm directory, so
adding keys means pruning stale arm JSON or the next report silently mixes generations.

---

## 9. What the report has already found

Phase 1 paid for itself before Phase 2 started. All of these were invisible in a net-worth
line:

- **`REAL_ESTATE` 16.3% → 90.2%** of gross assets by 2069 while `EQUITY` drains to zero
  (~2063). Terminal net worth still looks fine; the shape becomes a single illiquid asset.
- **Gold drained by *drawdown*, not allocation** — grew to $1.85m, then removed from the
  taxable brokerage at the 28% collectibles rate during depletion.
- **A ~94% one-year gold round trip in 2031** (Terry age 53): $200k → $12k → $277k, caused by
  a single glidepath anchor of `{EQUITY: 1, GOLD: 0}`. Almost certainly MPC harvest noise
  (the step-faithful `age`/`age.99` pairs), and it lands on `moveYear` — so it realizes
  collectibles CGT at the residency cost-base step-up (design 57 straddle territory).
  **Still open** — see §10.
- **Four defects in design 61**, recorded as §12.1 D1–D4 there: the immortal $0.01
  liquidation remnant (fixed), the drift band's blindness to a zero-target class, uncleaned
  pre-existing dust, and a baked SCHEDULE freezing its asset classes (closed by §12.2 Q3).
- **The US-retirement gold guard was modelling the wrong instrument** (§12 OQ4a, reversed),
  and its replacement location policy's *specified* ordering was then **refuted by
  measurement** (§12.2 Q4) — asset location depends on growth × tax treatment, not the rate
  alone.

---

## 10. Decision record (all questions answered 2026-07-29)

Kept as a record rather than deleted: each of these was a live fork, and the *reason* a fork
closed the way it did is what stops it being reopened by accident.

| # | question | decision | lives in |
|---|---|---|---|
| 1 | **Real-terms restatement.** Figures are nominal; is the unitless 100% view enough? | **Deferred.** Opt into design 79's value-basis toggle when it lands, rather than growing a private deflator here. The 100% view is immune to both inflation and FX, which is why it leads the page — so nominal money charts are a labelling issue, not a wrong-answer issue. | design 79 |
| 2 | **Where does app-side sampling live?** | **The run's `sampler` hook — not a replay.** The premise that a plugin needed design 81 was wrong: design 78 already added a sampler to `buildSim`, so samples are collected as the run happens. Design 81 remains an upgrade (resample without re-running, exact dates), not a prerequisite. | §5.1(b), §6 |
| 3 | **Account labels** — `_baseLabel` renders a user-named "AU House" as **"AU AU House"**, and loans have no display record at all, falling back to `auHousePropertyLoan`. | **Won't fix here.** Pre-existing design-70 behaviour; renaming the accounts is a fine workaround and fixing the prefix moves labels app-wide. It wants its own decision, not a report's. | design 70 |
| 4 | **Share the FX conversion with `computeNetWorth`?** | **Yes** — extract one helper, wire net-worth + the cube only. The four other copies are tracked as a follow-up, deliberately out of this design's commit. | §5.1(a) |
| 5 | **Does the cube belong to Monte Carlo?** | **Yes**, as Phase 4: a compact per-year mix vector per iteration, reported as per-class bands, threshold probabilities, and mix conditioned on failure. | §8 |

### Still genuinely open

- **Should the sample boundary sit after the 1 January cascade?** (§5.2.) Today a "2069" sample
  is read before 2069's investment growth is credited, because the annual family hangs off the
  1 January `PERIOD_ADVANCE`. Self-consistent, but the year labels lag the growth they name.
  Moving the boundary would move every figure on the page, so it is a decision, not a fix.
- **The 2031 gold round trip** (§9): $200k → $12k → $277k in one year off a single
  `{EQUITY: 1, GOLD: 0}` glidepath anchor, landing on `moveYear`. Almost certainly MPC harvest
  noise, but it realizes collectibles CGT at a residency cost-base step-up, so it is not
  cosmetic. **Belongs to design 61 / 39's harvest, not here** — this report is how it was
  found, not where it gets fixed.
- **Should the four remaining FX copies converge?** (§5.1(a).) Yes on the merits; needs an
  owner willing to re-verify four golden-locked metrics: `net-liquidity.js`, `after-tax.js`,
  `guardrail-portfolio-value.js`, `computeHouseValueUsd`.

---

## 11. Relationship to other designs

| design | relationship |
|---|---|
| **61** (holding-allocation lever) | sets the target; this reports the realized mix. §12.1's defects were all found here. Phase 3 charts them together and made the reducer stamp `targetBand` (§7.4). |
| **58 / 65** (drawdown, sleeve order) | the main *cause* of unintended drift — the report is how you see it, and §7.5 is what it looks like. `targetComposition` (design 65 §OQ1a) is what Phase 3 reads. |
| **78** (telemetry cost) | why the cube is not a per-event derived metric — **and** the origin of the `sampler` hook every later phase samples through (§4). |
| **74** (stochastic return paths) | the per-iteration seeding Phase 4's distribution is only meaningful under. |
| **81** (replayable run artifact) | an upgrade to app-side sampling, no longer a prerequisite for it (D2). |
| **79** (real vs nominal) | owns the restatement this report declines (D1). **Renumbered from 60** — every in-code "design 60" means the cash-sleeve yield doc. |
| **70** (account display names) | supplies `displayNameFor`; D3 is its wart, left to it. |
