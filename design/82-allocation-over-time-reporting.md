# 82 — Allocation over time: reporting the realized asset mix

**Status** (2026-08-05, `wip/allocation-reporting`): **COMPLETE — all questions closed.**

| phase | what | status |
|---|---|---|
| **1** | the cube, the shared pivot, a self-contained HTML lab report | **IMPLEMENTED** |
| **1b** | shared FX helper + year-boundary sampling (§5.1) | **IMPLEMENTED** (2026-07-29) |
| **2** | workbench plugin | **IMPLEMENTED** (2026-07-29) — never needed design 81 |
| **3** | target-vs-realized overlay | **IMPLEMENTED** (2026-07-29) — the payoff |
| **4** | Monte Carlo mix distribution | **IMPLEMENTED** (2026-07-30) |
| **5** | close-out: FX convergence, boundary decision, reference-plan MC (§5.3, §9.1) | **DONE** (2026-08-05) |

The 2026-08-05 close-out pass produced three things worth reading before the body: a **live FX
defect** found by converging the last duplicated copies (§5.3), a **correction to §5.2's
diagnosis** that dissolved the largest open question (§10 #9), and a **reference-plan Monte
Carlo** that retired §1's motivating finding and replaced it (§9.1).

Scope: answer "what is my asset allocation, and how does it change over the plan" — per
account, per country, and in total — and make the answer trustworthy enough to act on.

Written *after* the prototype rather than before it, deliberately: the open question was
never architectural, it was **taste** — does this report structure answer questions when you
look at it? A doc written first would have been guessing at the layout. What follows is what
the prototype settled, so Phase 2 can start cold.

Every open question is now answered, and the answers have moved into the sections they change
(§4 sampling, §5.1 the two cleanups, §5.3 the FX convergence, §6 Phase 2, §8 Phase 4, §9.1 the
reference-plan re-verification). **§10 is the decision record** — what was decided, and why, so
a closed fork stays closed.

---

## 1. Motivation

A net-worth line hides the shape of the plan. The reference plan ends at ~\$28m and looks
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
> `account` display kind**, so every loan silently vanished and the cube ran **\$218,710**
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
has a share/\$ toggle; Total has a net-worth checkbox, By country a domicile/exposure toggle,
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
**\$8.60m at 2069-12-31 and \$11.29m at 2070-01-01**. One day, +31%.

> ⚠ **Corrected 2026-08-05. The original diagnosis of that jump was wrong**, and it mattered,
> because the open question in §10 was posed on top of it. This section claimed "the annual
> investment family hangs off `PERIOD_ADVANCE_US`, which is dated 1 January" and concluded that
> every 31 December sample is read before the year's growth. Measured against the event
> calendar, the investment family is `interval: 'year-end'` — it is dated **31 December** and is
> fully inside the sample. See the correction below for what the +31% actually was.

**What the calendar really does.** The year boundary splits the annual cycle in two:

| dated **31 December** (`interval: 'year-end'`) | dated **1 January** |
|---|---|
| the whole investment family — account earnings, dividends, coupons, RMDs | real-asset **appreciation**: property, company equity, collectibles (`interval: 'annually'`) |
| the year's expenses and the tax settles | the `PERIOD_ADVANCE` cascade — **which is where the rebalance fires** |

So a 31 December sample carries a **complete** year of investment growth, spending and tax. The
+31% equity jump across that one day is **not growth at all** — it is the 1 January
**rebalance** selling bonds into equity. The aggregate confirms it: across 2069-12-31 →
2070-01-01 gross assets rise only 3.3% (the appreciation), while `BOND` goes 12.1% → 0.8% and
`EQUITY` 36.0% → 46.6%. Money moved between classes; almost none was created.

**The residual bias, correctly scoped.** One real lag survives the correction, and it is
narrower than the original claim: real assets appreciate on 1 January, so at 31 December year Y
financial assets carry a full year of growth and real assets carry **none of year Y's**
appreciation. Measured directly — with a 4% house, consecutive year-end samples step by exactly
one appreciation cycle, and the first sample shows the un-appreciated opening value. Two things
follow:

- Every mix therefore **understates the real-asset share** by about one appreciation cycle.
  Note the direction: that runs *against* §9's `REAL_ESTATE` finding rather than manufacturing
  it.
- Charts stay self-consistent (every point sits at the same place in the annual cycle), and the
  bias is a level effect, not a trend one.

The terminal sample is still **not** comparable with the others: it covers a partial year and
sits on the far side of the cascade. The lab page says so in Provenance rather than drawing it
silently; the Phase 2 panel does the same.

`tests/unit/sampler-year-boundary.test.mjs` now pins both halves of the table, because every
mix figure in this design means what it means only under that calendar — and a re-dating would
change all of them silently.

---

### 5.3 The four remaining FX copies, converged — and one of them was already wrong (2026-08-05)

Phase 1b extracted `toBaseCurrency`/`currencyOf` but wired only `computeNetWorth` and
`buildAllocationCube`, leaving four copies of the same six lines standing on purpose: each
belonged to a golden-locked metric, and re-verifying them was not a report's job. §10 D4
tracked them so the duplication would not be forgotten.

They are now all converged: `derived-metrics/net-liquidity.js`, `derived-metrics/after-tax.js`,
`spending/guardrail-portfolio-value.js`, and the MC runner's `computeHouseValueUsd`. No
valuation site outside `to-base-currency.js` reads `effectiveExchangeRates` any more.

**This was not a tidy-up. One of the five copies had already drifted, and it was wrong in
production.** `computeGuardrailPortfolioValue` read the account's currency as a bare string:

```js
const currency = val.currency ?? baseCurrency;   // ← a {code, symbol} DESCRIPTOR
if (currency === baseCurrency) { … }             // never matches
const pairId = `${baseCurrency}_${currency}`;    // "USD_[object Object]"
const rate   = state.effectiveExchangeRates?.[pairId] ?? 1;   // → 1
```

A runtime account carries `currency` as the `{code, symbol}` descriptor from `Account`, not a
code. So the base-currency short-circuit never fired, the pair id was garbage, the missing-rate
fallback returned 1 — and **every foreign drawdown account was summed at face value with no
conversion at all.** USD accounts came out right by accident, which is exactly why nothing ever
looked wrong.

Measured on the default plan at 2030: the guardrail portfolio read **\$2,305,025 against a true
\$2,084,588 — overstated 10.57%**, the AUD balances counted at 1.00 instead of 1.55. A guardrail
compares `spending / portfolio` against a threshold, so an overstated denominator **understates
the withdrawal rate**: cuts fire late, raises fire early, and the error grows with the AUD
share of the book. `RetirementDateHandler` reads the same function.

Three things this settles beyond the fix itself:

- **The unit tests could not have caught it.** Every fixture in `spending-guardrail-fx.test.mjs`
  built `currency` as a bare string — a shape no real run produces. The tests were green and
  the metric was wrong. Two tests now pin the descriptor shape specifically, and one asserts
  the guardrail agrees with `computeNetWorth` on the same accounts; both fail against the old
  implementation.
- **No published figure moves.** No committed scenario selects `GUARDRAIL` as its spending
  strategy (the reference plan runs `EXPLICIT_BANDS` + `FIXED`), and the reference plan's full
  account-by-account result is byte-identical before and after. The defect was latent — but it
  was latent in a lever the spend-ceiling work reaches for.
- **The argument for the module was the right one, and it under-sold itself.** §5.1(a) argued a
  comment is not a mechanism and a divergence would not throw. That was written as a
  hypothetical. It had already happened.

`to-base-currency.js`'s header now carries this as the reason not to add a sixth copy.

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
a way that still looks plausible — average a \$10k account with a \$10m one and the "portfolio
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

## 8. Phase 4 — the mix as a distribution (Monte Carlo) (IMPLEMENTED)

**A different question, not a different chart.** Phase 1 answers "on the central path, what
shape does this plan take?" Monte Carlo answers "**how often** does it take that shape?" —
and for the finding in §9 that is the more decision-relevant of the two. "Ends 90% house" is
alarming; "ends ≥60% house in 80% of paths" is actionable, and "in 8%" is noise.

```text
src/finance/allocation-reporting/mix-distribution.js   mixPoint / buildMixSeries /
                                                       mixBands / thresholdProbabilities /
                                                       mixByOutcome / outcomeGapAt
scripts/lib/mix-report-html.mjs                        the chart page
tests/unit/mix-distribution.test.mjs                   (16)
tests/unit/mc-mix-sampler.test.mjs                     (4)
```

```bash
node scripts/montecarlo/mc-run.mjs --arms <spec.json> --out <dir> -n 400 --paths --mix
node scripts/montecarlo/mc-report.mjs --dir <dir> --html <dir>/mix.html
node scripts/montecarlo/mc-report.mjs --dir <dir> --thresholds my-thresholds.json
```

### 8.1 What each iteration records

MC already runs with `telemetry: 'off'` plus a `sampler` (design 78 §4.5) — the exact seam
this needs. The sampler's record gains a mix vector:

```text
{ date, netWorthUsd, netLiquidity, houseValueUsd,      // existing
  grossAssetsUsd,                                      // the mix denominator
  mix: { EQUITY: 0.41, BOND: 0.12, … } }               // shares, summing to 1
```

built by `buildAllocationCube` → the shared pivot — **the same modules the lab page uses**, so
a share means the same thing in both places. ~9 numbers per year per iteration; still
numbers-only, still nothing retained from state.

**The denominator travels with the shares, and that is load-bearing.** A post-ruin sample is
all zeros, which is indistinguishable from a real mix unless `grossAssetsUsd` is read — so it
is recorded beside them and every consumer treats `gross <= 0` as *absent* rather than as a
mix of nothing (§8.2).

Rejected: keeping the **full cube** per iteration (~1.3m rows at n=1000). Maximally flexible
post-hoc and directly against design 78's lesson; the flexibility is not worth an artifact
nobody can open. Also rejected: **terminal mix only** — it answers the house question and
nothing about *when* the shape turns, which is where a lever could act.

**The matrix is per-path and raw in the arm file**, not pre-reduced to bands, because §8.2's
thresholds have to move without a re-run and the failure split needs the individual paths. It
is stored positionally — a `classes` header plus `shares[year][class]` — since the alternative
repeats the class name ~144,000 times at n=400 to say nothing more. `mc-run.mjs` splices it in
compactly so the surrounding arm record keeps its one-value-per-line formatting: about 1 MB
per arm at n=400 × 45 years, against ~10 MB if the bulk arrays were indented too. It stays
*inside* the arm file rather than beside it because `mc-report.mjs` globs the directory for
`*.json`, and a sibling `<arm>.mix.json` would silently join the next report as a nameless arm.

### 8.2 What the run reports

1. **Per-year share bands** — p10/p50/p90 of each class's share at each year index.
2. **Threshold probabilities** — the readouts worth quoting: `P(REAL_ESTATE ≥ 60% of gross
   assets at simEnd)`, `P(EQUITY share = 0 …)`, `P(illiquid ≥ 75% at any year)`.
   Thresholds live in config, not in code comments, so they can move without a re-run.
   `DEFAULT_MIX_THRESHOLDS` ships five, deliberately **horizon-relative** (offsets, not
   calendar years) so the same set means the same thing on a 15-year synthetic run and a
   45-year plan; `--thresholds <file.json>` replaces them wholesale.
3. **Mix conditioned on failure** — split (1) by `scenarioFailed`. If failing paths are the
   90%-house paths, the shape *is* the failure mechanism and Phase 3's overlay is where to
   intervene. If they are not, the shape is a bequest-composition question, not a solvency
   one. This is the number that decides which of those two conversations to have.

**Two honest constraints on the drawing.** Per-class percentile bands are **marginal**: the
p90 `EQUITY` band and the p90 `REAL_ESTATE` band come from different paths, so they do not sum
to 1. They must be drawn as separate bands per class — **never stacked**, which would assert a
mix no path ever held. (`MIX-8` pins this: five well-formed paths whose own shares each sum to
1 produce p90s summing to 1.4, so nobody "fixes" it later.) And a path with **zero gross
assets** (post-ruin) has no meaningful mix: `0/0`. Those are excluded from the share
percentiles and the excluded count is its own per-year series, or "90% house" silently absorbs
every ruined path.

Percentiles are **nearest-rank**, so every band value is a share some path actually held. That
matters more here than smoothness: the chart's whole purpose is to describe mixes that
occurred, and an interpolated p90 is a mix nobody had.

### 8.3 The cost, measured

**Compute: ~1.1%.** n=100 with stochastic paths, three runs each: 8.23/8.26/8.21s without
`--mix`, 8.27/8.31/8.34s with. Design 78's prediction held — ~45 cube builds are nothing
against ~1,800 events. It is nonetheless kept **opt-in behind `--mix`**, not defaulted on: the
cost that actually bites is the ~1 MB per arm of matrix in files that get archived and
re-reported, and an ordinary solvency run has no reader for it.

**The sampler is inert on the run, exactly.** It is handed *live* state, so a cube build that
wrote anything back would perturb the simulation it describes and every downstream MC number
would be measuring the measurement — silently. `MCMIX-1` asserts bit-identical terminal net
worth, `scenarioFailed` and `outOfFundsDate` with and without the mix sampler. Verified on the
reference plan too: `$30,938,309.238792058` either way.

**The cadence re-baseline, and a correction.** MC moved to §5.1(b)'s `'year-boundary'` cadence
— design 78 chose the event cadence for cheapness, and it lands the "yearly" point at whatever
event happened to be last in the year, which drifts with event volume. A *mix* is precisely
sensitive to whether the year-end rebalance has fired, so an arbitrary instant was not an
option, and having MC sample somewhere the lab page and the panel do not would defeat the
shared-modules argument entirely.

An earlier draft of this section predicted "year-end values sit slightly higher than mid-year
ones as growth compounds". **Measured, that is backwards on a decumulating plan.** On the
reference plan the year-boundary series is *lower* in 25 of 45 years and higher in 2 (mean
−0.10%, worst −1.17% in 2054, terminal +0.03%); on the synthetic default, lower in 7 of 16
(mean −0.04%). The mechanism is obvious in hindsight: within a year a retired plan is spending
faster than it compounds, so a mid-year reading sits *above* the year-end one. Magnitudes are
small either way.

What moves and what does not is sharper than "failure rates should barely move": the sampler
cannot affect the run, so `scenarioFailed`, `outOfFundsDate`, `cumulativeDeficit` and
`finalNetWorthUsd` are **unchanged exactly**. Only what is *recorded* moves — `timeSeries`,
and therefore `pathShape` (CAGR, worst-5yr, max drawdown, the decade split). Any arm JSON
produced before this change carries a `pathShape` from the old cadence; regenerate rather than
compare across the boundary.

The switch lives in the runner, so it reaches **every** MC caller — the lab arms, the
workbench MC panel (`monte-carlo-controller.js`) and the decision-graph runner. That is the
point of §4's "one policy": a mix quoted in the app and a mix quoted on a page must have been
read at the same instant. The panel's fan chart is unaffected visually, because
`extractYearlyTimeSeries` still re-stamps each sample to 1 January of its year — deliberately,
since the chart groups by exact timestamp and a per-path stamp would split one year into two
columns of one path each.

### 8.4 Re-running the decision documents

Per the standing rule, the code and the runner change ship without blocking on a 30–45 minute
re-run. To refresh a decision doc:

```bash
node scripts/montecarlo/mc-run.mjs --arms <spec.json> --out <dir> -n 400 --paths --mix
node scripts/montecarlo/mc-report.mjs --dir <dir> --html <dir>/mix.html
```

Two traps to respect. **Prune the arm directory first** — `mc-report.mjs` globs it, so a
renamed or dropped arm survives as stale JSON and silently joins the next report. (This fired
during verification: two arms from an earlier run rejoined a two-arm report as four.) And
**every arm in a batch must be run with the same flags**, `--mix` included, or the common
random numbers that make the paired view valid no longer line up.

### 8.5 What the verification run already showed

n=40, synthetic default, stochastic paths, two spend levels — enough to exercise the report,
not enough to quote. **Superseded for the reference plan by §9.1** (n=200), which reproduces
the failure-shape mechanism but on a different asset and retires the house finding entirely:

- At a **5% failure rate**, the failing paths sit at **94.8% `REAL_ESTATE`** at the horizon
  against **54.8%** for the survivors — a **+40 point gap**, with `EQUITY` at 0% versus 41.7%.
  At a 22.5% failure rate the gap is +30 points. So on this scenario the answer to §8.2's third
  question is unambiguous: **the shape is the failure mechanism**, and Phase 3's overlay is
  where a lever would act. That is the conversation §9's `REAL_ESTATE` finding was pointing at.
- `P(REAL_ESTATE ≥ 60% at the end)` moves **45% → 63%** between the two spend levels, which is
  the readout §8.2 exists to produce: it turns "the plan ends house-heavy" into a probability
  that responds to a lever.
- The **0/0 exclusion never fired.** A ruined path here still holds the house, so gross assets
  stay positive; the rule guards the case where *everything* is gone, which this model reaches
  rarely. Worth knowing before reading an `excluded` count of zero as "nothing failed".

---

## 9. What the report has already found

Phase 1 paid for itself before Phase 2 started. All of these were invisible in a net-worth
line:

> ⚠ **Re-verified 2026-08-05 against the current reference plan. The first bullet no longer
> reproduces, and the reason is instructive** — the plan itself has moved on (designs 75/86
> added the house-sale path, and the plan now sells a property), so the terminal shape is no
> longer house-dominated. A findings list dated against a scenario file that keeps changing
> goes stale silently; §9.1 records what was re-measured and what replaced it. The *machinery*
> is unaffected — this is the report doing its job twice.

- **~~`REAL_ESTATE` 16.3% → 90.2%~~ — STALE, and the direction reversed.** Re-measured, real
  estate goes **~40% → ~12%** of gross assets over the plan: it *falls*. `EQUITY` does not
  drain either — it ends the largest single class. See §9.1 for what the concentration finding
  became.
- **Gold drained by *drawdown*, not allocation** — grew substantially, then removed from the
  taxable brokerage at the 28% collectibles rate during depletion. **Still reproduces**: gold
  holds a double-digit share through the middle of the plan and is gone by the end.
- **A one-year gold round trip on a single glidepath anchor.** **Still reproduces, and it is
  wider than recorded here** — bonds go to zero with it, and it is one instance of a repeated
  pattern, not a one-off. Now filed where it belongs, as **design 61 §12.1 D5**; §9.1 has the
  measurement.
- **Four defects in design 61**, recorded as §12.1 D1–D4 there: the immortal \$0.01
  liquidation remnant (fixed), the drift band's blindness to a zero-target class, uncleaned
  pre-existing dust, and a baked SCHEDULE freezing its asset classes (closed by §12.2 Q3).
- **The US-retirement gold guard was modelling the wrong instrument** (§12 OQ4a, reversed),
  and its replacement location policy's *specified* ordering was then **refuted by
  measurement** (§12.2 Q4) — asset location depends on growth × tax treatment, not the rate
  alone.

---

### 9.1 Re-verified on the reference plan (2026-08-05) — n=200, `--paths --mix`

§8.5's numbers came from n=40 on the **synthetic default**, and §10 recorded "the reference
plan is where it needs to be run" as open. It has now been run: two spend arms, n=200,
stochastic paths, ~3 minutes per arm. Three results, in order of how much they change the
design's story.

**1. The house question is answered, and the answer is "no".** `P(REAL_ESTATE ≥ 60% of gross
assets at simEnd)` is **0% in both arms** — against 45%→63% on the synthetic default. The
motivating finding in §1 was real when written and is not a property of the current plan. This
is exactly the failure mode §8 was built to prevent in the other direction: a single central
path said "ends 90% house", and only a distribution could say how often. Here the distribution
says never.

**2. The concentration finding survives — it moved to the company stake.** The shape still
*is* the failure mechanism, which is §8.2's third question and the one that decides which
conversation to have:

| readout | lower spend | higher spend |
|---|---|---|
| illiquid (house + company + collectibles) ≥ 75% at simEnd | 13% | 39% |
| failing paths' median `PRIVATE_EQUITY` share at simEnd | 74.2% | 74.9% |
| surviving paths' median `PRIVATE_EQUITY` share at simEnd | 28.1% | 30.3% |
| gap | **+46.1 pts** | **+44.7 pts** |

with `EQUITY` at 0% in failing paths against ~56–58% in surviving ones. So the +40-point
failed-vs-survived gap §8.5 found on the synthetic default **reproduces on the reference plan
at +45 points** — but the illiquid asset carrying it is the **company equity**, not the house.
Same mechanism, different asset, and a different lever to reach for. Design 82's overlay
(Phase 3) is still where it would act.

**3. A threshold readout is being corrupted by design 61 D5.** `P(EQUITY share falls to zero
at any year)` comes back **100% in both arms**. That is not a drawdown finding — it is the
harvested-glidepath corner described in design 61 §12.1 D5: the plan spends three consecutive
years at exactly 0% equity in the middle of retirement, and because the glidepath is keyed on
**age**, it fires identically in every path. A probability that reads 100% for a structural
reason is worse than no probability, so:

> **Do not quote `P(EQUITY share = 0 …)` on a plan with a harvested glidepath** until D5 is
> resolved. The neighbouring readouts (`illiquid ≥ 75%`, the failure split) are unaffected —
> they are share-of-total questions that a corner moves only for the year it fires.

This is the second time this design has surfaced the same defect and the first time its size
has been visible: §9's original bullet saw one year of it on a central path, and it took the
distribution to show it firing in 100% of worlds.

**Reproduce:**

```bash
node scripts/montecarlo/mc-run.mjs --arms <spec.json> --scenario <plan.json> \
     --out <dir> -n 200 --paths --mix
node scripts/montecarlo/mc-report.mjs --dir <dir> --html <dir>/mix.html
```

A plan with more than one mortgaged property needs `spendTotalProperty` in the spec to use the
`spendTotal` lever at all (design 86) — the runner fails loudly rather than picking one.

## 10. Decision record (all questions answered; #6–#8 closed 2026-07-30)

Kept as a record rather than deleted: each of these was a live fork, and the *reason* a fork
closed the way it did is what stops it being reopened by accident.

| # | question | decision | lives in |
|---|---|---|---|
| 1 | **Real-terms restatement.** Figures are nominal; is the unitless 100% view enough? | **Deferred.** Opt into design 79's value-basis toggle when it lands, rather than growing a private deflator here. The 100% view is immune to both inflation and FX, which is why it leads the page — so nominal money charts are a labelling issue, not a wrong-answer issue. | design 79 |
| 2 | **Where does app-side sampling live?** | **The run's `sampler` hook — not a replay.** The premise that a plugin needed design 81 was wrong: design 78 already added a sampler to `buildSim`, so samples are collected as the run happens. Design 81 remains an upgrade (resample without re-running, exact dates), not a prerequisite. | §5.1(b), §6 |
| 3 | **Account labels** — `_baseLabel` renders a user-named "AU House" as **"AU AU House"**, and loans have no display record at all, falling back to `auHousePropertyLoan`. | **Won't fix here.** Pre-existing design-70 behaviour; renaming the accounts is a fine workaround and fixing the prefix moves labels app-wide. It wants its own decision, not a report's. | design 70 |
| 4 | **Share the FX conversion with `computeNetWorth`?** | **Yes** — extract one helper, wire net-worth + the cube only. The four other copies were tracked as a follow-up, deliberately out of this design's commit; **converged 2026-08-05 (#11), and one of them turned out to be already wrong.** | §5.1(a), §5.3 |
| 5 | **Does the cube belong to Monte Carlo?** | **Yes**, as Phase 4: a compact per-year mix vector per iteration, reported as per-class bands, threshold probabilities, and mix conditioned on failure. | §8 |
| 6 | **Raw per-path matrix in the arm file, or pre-reduced bands?** | **Raw**, positionally encoded and spliced in compactly (~1 MB/arm at n=400). §8.2 requires thresholds to move and the failure split to be re-cut without a re-run, and both need the individual paths. An arm is minutes; a report is milliseconds; the report is what gets rewritten. | §8.1 |
| 7 | **Should `--mix` be on by default?** | **No — opt-in**, despite the compute being ~1.1%. The cost that bites is a megabyte per arm in files that get archived and re-reported, and an ordinary solvency run has no reader for it. The measurement, not the assumption, is in §8.3. | §8.3 |
| 8 | **Terminal report or charts?** | **Both**, off one reduction. The terminal tables answer "how often", but "when does the shape turn" needs 45 columns, and a terminal cannot draw them. `mix-report-html.mjs` is to `mc-report.mjs` what `lib/grid-report.mjs` is to the terminal grid report. | §8.2 |

### Closed 2026-08-05

| # | question | resolution |
|---|---|---|
| 9 | **Should the sample boundary sit after the 1 January cascade?** (§5.2.) | **No — keep 31 December, and the premise was wrong.** The investment family is `interval: 'year-end'`, i.e. dated 31 December, so a year-boundary sample already carries the full year of growth, spending and tax; only real-asset appreciation and the rebalance land on 1 January. Moving the boundary would also **delete §7.3's finding**, since a post-rebalance sample reads 0.0% drift for every class by construction. The residual is a bounded level bias — real assets lag by one appreciation cycle — now stated in §5.2 and pinned by a test rather than left to a comment. |
| 10 | **The 2031 gold round trip** (§9). | **Filed as design 61 §12.1 D5**, which is where §9 said it belonged but where it had never actually landed. Re-measurement made it bigger: bonds go with the gold, it recurs at several ages, and §9.1(3) shows it firing in 100% of Monte Carlo paths and corrupting a §8.2 threshold readout. Still owned by 61/39's harvest, not here. |
| 11 | **Should the four remaining FX copies converge?** (§5.1(a).) | **Done — and one had already drifted.** All four now call the shared helper; `computeGuardrailPortfolioValue` was mis-valuing every foreign drawdown account by the FX rate. Full account in **§5.3**. No published figure moves (no committed scenario runs `GUARDRAIL`), and the reference plan is byte-identical. |
| 12 | **Stale `pathShape` across the cadence boundary** (§8.4). | **Made detectable instead of remembered.** Arm files now stamp `samplerCadence`, and `mc-report.mjs` warns loudly when a batch mixes cadences or when an arm is unstamped (⇒ pre-design-82). The re-run of the archived decision MCs is still deferred per the standing rule — but a stale comparison can no longer happen silently, which was the actual hazard. |
| 13 | **Mix distribution only exercised on the synthetic default** (§8.5). | **Run on the reference plan** at n=200 with `--paths --mix` — about 3 minutes per arm, well inside what is worth doing inline. Results and their consequences in **§9.1**; they revise §1's motivating finding, confirm the failure-shape mechanism at +45 points, and expose the D5 threshold corruption. |

### Still genuinely open

- **The real decision MCs have not been re-run** on the year-boundary cadence (§8.4). Deferred,
  not forgotten: the change is small, its direction is measured (§8.3), and the stale-cadence
  trap is now caught by the stamp (#12) rather than by memory. Regenerate before quoting a
  `pathShape` figure across that boundary.
- **Design 61 D5 is unsized.** §9.1(3) establishes that harvested glidepath corners fire in
  every path and corrupt a threshold readout; nobody has measured what the round-trip CGT
  actually costs. The counterfactual is cheap — re-run with the corners smoothed and diff
  terminal after-tax net worth — and it belongs to design 61, not here.
- **§9's findings are dated against a scenario file that keeps moving.** The first bullet went
  stale between 2026-07-30 and 2026-08-05 because the plan gained a house sale. Nothing in the
  machinery prevents that recurring; the only real mitigation is to re-verify a quoted finding
  before acting on it, which is what §9.1 is.

---

## 11. Relationship to other designs

| design | relationship |
|---|---|
| **61** (holding-allocation lever) | sets the target; this reports the realized mix. §12.1's defects D1–D5 were all found here. Phase 3 charts them together and made the reducer stamp `targetBand` (§7.4). **D5** (harvested glidepath corners) is the one still open, and §9.1(3) is the measurement that made its size visible. |
| **58 / 65** (drawdown, sleeve order) | the main *cause* of unintended drift — the report is how you see it, and §7.5 is what it looks like. `targetComposition` (design 65 §OQ1a) is what Phase 3 reads. |
| **78** (telemetry cost) | why the cube is not a per-event derived metric — **and** the origin of the `sampler` hook every later phase samples through (§4). |
| **74** (stochastic return paths) | the per-iteration seeding Phase 4's distribution is only meaningful under. Without `--paths` a single return is drawn per world and held, so the spread of *shapes* is narrower than reality — the mix page says so in its header. |
| **81** (replayable run artifact) | an upgrade to app-side sampling, no longer a prerequisite for it (D2). |
| **79** (real vs nominal) | owns the restatement this report declines (D1). **Renumbered from 60** — every in-code "design 60" means the cash-sleeve yield doc. |
| **70** (account display names) | supplies `displayNameFor`; D3 is its wart, left to it. |
| **89** (spending over time) | the **flow** sibling — this reports the stock, 89 reports what leaves. Reuses the sampler seam (§4), the palette discipline and the tie-out rule, and adds a cross-report invariant (89 §7b: opening + credits − debits === closing, read against these samples). It is also the "second chart-bearing report" §6 deferred abstracting for — and it lands as a `ReportDefinition` + chart, not as a second sibling hierarchy. |
