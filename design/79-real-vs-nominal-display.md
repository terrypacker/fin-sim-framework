# 79 — Real vs. Nominal value display (constant-dollar toggle)

> **Renumbered 2026-07-29**: this document was `60-real-vs-nominal-display.md` and
> collided with `60-cash-sleeve-money-market-yield.md` — two designs sharing a number,
> one IMPLEMENTED and one not, which made every "design 60" citation ambiguous. Every
> in-code `design 60` comment refers to the **cash sleeve** doc; this one is now **79**
> (a number never used). Cite it as design 79 from here on.
>
> **Second collision, unresolved.** Design 39 §13.13.4 and design 80 (§2.11, D4, P4)
> "reserve design 79" for a factored `Schedule` param type. That document was never
> written and 79 is this one. Those citations mean *"a future Schedule-type design"*,
> not this doc. They should get a fresh number when that design is written.

**Status**: **P1 BUILT 2026-09-27** (P2–P4 open) — drafted 2026-07-13, **revised
2026-09-27** against the code at `fd6ec9cc`. See §14 for what P1 shipped and where it
departed from the plan. Scope: an app-wide **value basis**
toggle, `Nominal` (the default, and what the app does today) vs. `Real (base-year \$)`,
held in `AppDisplaySettings` and set from the top bar. It is **display-only**, like the
display-currency and timezone settings (design 10). No simulation logic changes.

---

## 0. What the 2026-09-27 review changed

The draft is two and a half months old. Designs 82, 89, 97 and 103 have shipped
since, and they built most of the machinery this doc planned to build, or showed
that parts of the plan were wrong. The table below lists each finding. Every later
section is rewritten to match.

| # | Draft said | Code today | Consequence |
|---|---|---|---|
| R1 | Record `inflationAccumulator` as a new `RECORD_METRIC` series (§5A) | **Already recoverable.** `JournalPriceLevels` (`src/finance/journal-reporting/journal-price-levels.js`, design 89 §9.b.1) rebuilds the per-country price-level history from the journal's state diffs. It mirrors `JournalFxRates`: binary-search `levelAt(ts, cc)`, the opening level seeded from the first diff's `before`, and `null` rather than an invented level | The recorded-metric plan is **retired**. The journal report reuses `JournalPriceLevels`. The live chart reads the level from the snapshot it already receives (§5). |
| R2 | Put deflation inside `convertForDisplay` / `formatAmount` / `_toDisplayCurrency` so "every caller inherits it" (§3, §13 1.2) | **Unsafe.** 21 visualization files format money through those hops. They include the MC/Opt panels (`money-format.js` → `convertForDisplay`), which show **ensemble aggregates** with no single state; the journal report (`journal-report-plugin.js:105`), where every row has **its own date**; and the tax documents (`tax-document-modal.js:59`), which must stay nominal. The registry's `rateStateProvider` is `() => sim.state` (`workbench-app.js:818`), the live playback state, not the date of the value being formatted | Deflation becomes **opt-in per call**: the caller supplies the date or price level. A caller that supplies neither gets nominal, as today. The tax documents then stay nominal without any special exemption (§3). |
| R3 | Phase 4: deflate each value by its **native currency's** country (`AUD → AU`) (§7) | **Refuted.** Design 89 §5.6 and `expense-price-level.js` found that *"currency is not the axis"*: the right deflator is the economy the money was spent in. That can be a blend across properties that no currency can recover | Old Phase 4 is **retired**. §7 replaces it with a choice of deflator convention. |
| R4 | Assumed one deflator convention (US) | **Three conventions coexist:** US (`optimization-problem.js:510`, `spending-cube.js` `priceLevelCc='US'`, design 89 §9.b.1's decision); **residence** (`residencePriceLevel`, used by the MC sampler `mc-sampling.js:92`, design 97 §18, and the expense emitters); per-emitter **stamped** `priceLevel` (design 89 §5.6) | The lens takes the display currency's country (§7, decided Q-A). It is one denominator per screen, not per value. |
| R5 | Only "already-real" surfaces were the Die-With-Target objective and explicit bands | **Several more are real today.** The spending panel has its own `real \| nominal \| share` switch and defaults to real (`spending-plugin.js:72`, design 89 §9b). The MC results show **Real Cost** and the real net-liquidity trough and drawdown (`mc-results-panel.js:1204,1531`). The MPC cockpit shows spend bands as real alongside a nominal suffix (`cockpit-controller.js:97`). `terminalWealthTarget` is a real input | Opt-in (R2) prevents double-deflation, because an already-real figure never asks to be deflated. The spending panel's own switch needs a rule for how it relates to the global toggle (§8.1, Q-B). |
| R6 | MC/Opt panels: "audit for double-deflation" only | **Every MC path now carries its own `priceLevel`** in its yearly series (`mc-sampling.js:92,133`). Under stochastic inflation (design 103) the level differs from path to path | Real MC figures are possible, but each path must be deflated **before** the percentiles are taken (§9). This is a new phase, P4. |
| R7 | `scripts/run-scenario.mjs`; `intl-retirement-scenario.js:599`; `optimization-problem.js:489`; `chart-view.js:261,277` | The scripts moved to `scripts/scenario/run-scenario.mjs`. The objective's deflation now lives in `optimization-objectives.js:229` and `advice-signals.js:88`. Current lines: `optimization-problem.js:510`, `chart-view.js:339-360` | References updated throughout. |
| R8 | §1 quoted one scenario's terminal net worth, growth and inflation | Design docs are public; scenario values do not belong in them | §1 now uses arithmetic only. |
| R9 | Dash cards listed as a point-in-time money surface | `dash-cards-component.js` shows a date and execution counters. It shows no money | Dropped from scope. |

The draft's **user-facing decisions still stand**: a global toggle rather than one per
panel, the base year printed on the toggle label, R1 (per-row deflation) for the
journal, and tax documents always nominal. The **mechanism** under them is what
changes.

---

## 1. Motivation

Account balances compound at the nominal total return the plan sets (design 99).
Inflation raises expenses, wages and Social Security (`InflationAdjustReducer`) and
compounds `state.inflationAccumulator[cc]`. It is never subtracted from account
growth. So every net-worth figure in the app is in **nominal future dollars**, and
nothing on screen says so.

The size of the gap is plain arithmetic. At 3% inflation over a 44-year plan, the
terminal accumulator is 1.03⁴⁴ ≈ **3.67**. A nominal ending balance is therefore
about 3.7 times its value in base-year purchasing power. A user who reasons "10%
nominal − 3% inflation ≈ 7% real" sees the nominal figure and assumes a bug, because
they are thinking in real dollars and the display is in nominal ones. There is no bug,
only a missing lens. Design 89 §9b measured the same ~3.7× on the spending chart and
made real terms that chart's default. The rest of the app still has no way to show
real terms.

---

## 2. Semantics

```
real(nominal, t, cc) = nominal / level(t, cc)
```

- `level(t, cc)` is `inflationAccumulator[cc]` in force at instant `t`. It is `1.0` at
  sim start and compounds at each `*_PERIOD_ADVANCE`. It is a step function, so the
  nearest earlier sample is exact.
- **Base year = sim start.** The toggle label reads `Real (<simStart year> $)`, so a
  plan that starts in a year other than the current one never claims "today's
  dollars". Re-basing to another anchor year is out of scope.
- **It is a lens, not a recompute.** Deflation happens when a value is formatted, on
  numbers the sim already produced. No reducer, action or saved state changes, and
  flipping the toggle never re-runs anything.
- **A missing level means nominal, and the display says so.** This follows the
  contract `JournalPriceLevels.toReal` set: a nominal number shown under a real label
  is exactly the defect this lens exists to remove. When no level is available, the
  hop reports `basis: 'nominal'` and the caller shows that basis.

---

## 3. Where the transform lives (revised — R2)

1. **`AppDisplaySettings`** gains `valueBasis: 'nominal' | 'real'`. It is persisted
   and sent in `DISPLAY_SETTINGS_CHANGED` alongside currency, timezone and theme.

2. **`StateSchemaRegistry`** gains one hop that callers must opt into:

   ```js
   // → { value, code, symbol, basis: 'real' | 'nominal' }
   registry.presentForDisplay(value, nativeCode, { at, priceLevel, state })
   ```

   - It converts currency first, using the existing converter logic. Then it deflates,
     **only** when `valueBasis === 'real'` **and** the caller supplied a level:
     - `priceLevel` — an explicit number. Used by MC paths and by callers that already
       hold a level.
     - `at` — a timestamp or the string `'live'`, resolved through an injected
       `priceLevelSource.levelAt(ts, cc)`. `'live'` reads the live sim state, which is
       the same snapshot the FX conversion already uses.
   - **With no `at` and no `priceLevel`, the value stays nominal.** Every existing
     caller of `formatAmount`, `convertForDisplay` and `format` passes neither, so the
     feature is byte-identical until a surface opts in.
   - `formatAmount(value, code, opts)` and `format(path, value, opts)` pass `at` and
     `priceLevel` through to the new hop. `money-format.js` gains the same optional
     argument (`fmtWhole(v, code, { at })`).

3. **`priceLevelSource`** is a small adapter the workbench injects, alongside
   `rateStateProvider`:
   - `'live'`: `sim.state.inflationAccumulator[cc] ?? null`.
   - `ts`: a `JournalPriceLevels` built from `sim.journal`. It is rebuilt lazily when
     the journal has grown since it was last built, so it works during a live run as
     well as after one.

Why opt-in and not a blanket hop: see R2. Of the three kinds of caller the draft would
have deflated implicitly, two would be **wrong** and one **illegal** (the tax
documents). Opt-in also closes the double-deflation audit for free, because a figure
that is already real never asks to be deflated.

---

## 4. Point-in-time panels

A panel opts in only where **every value it deflates belongs to one instant**. Four
panels qualify:

| Panel | How it opts in |
|---|---|
| State panel — the rendered state tree's rows | `{ priceLevel: <rendered state>.inflationAccumulator }`. This is the snapshot the panel is drawing, which can lag `sim.state`. Passing a level rather than `state` leaves its FX source unchanged. |
| Watchlist — current values | `{ priceLevel: sim.state.inflationAccumulator }` |
| Holdings | `{ at: 'live' }` |
| Securities | `{ at: 'live' }`. Its money headers read `USD real` when the basis applied. |

Each of the four already re-rendered on `DISPLAY_SETTINGS_CHANGED`. A deflated
field row's hover text names the nominal amount and the level it was divided by.

**Deliberately NOT in P1**, because their money spans many dates. Deflating it by the
live level would be the R2 defect in miniature:
- the state panel's diffs, deltas and history statistics (min, max, net Δ);
- sparklines;
- allocation over time (design 82) and liquidity-pool history (design 97);
- the paycheque panel (dated months and years).

These take `{ at: <row date> }` in P3.

---

## 5. The chart: deflate each point by its own date

`chart-view.js:_displaySeriesData` applies **one** FX factor across the whole series
(line 356). That shortcut is tolerable for FX. For inflation it is not, because the
deflator runs from 1.0 to ~3.7 across the plan, and a single factor would warp the
curve's shape.

**Revised mechanism (R1).** There is no new recorded metric.
- **Live:** `ChartPresenter._doRender` already reads each `EXECUTION_END`
  `stateSnapshot`. It also takes `inflationAccumulator.US` and `.AU` and gives them to
  the view as **hidden** price-level tracks, keyed by the same timestamp. That is two
  numbers per snapshot. The display currency picks which track is used (§7), so a
  currency switch needs no re-capture.
- **Backfill:** `activatePath` backfills through `FieldSeriesStore.getOrBackfill`. The
  price-level tracks use that same call on `inflationAccumulator.US` and `.AU`, so a series
  activated after the run still gets a level for every point.
- **Deflate:** in `_displaySeriesData`, when `valueBasis === 'real'` and the series has
  currency kind, map each `[t, v]` to `[t, v × fx(t) / level(t, cc)]`, taking the
  nearest earlier sample. Where there is no level track at all, draw nominal and label
  the axis nominal, with no fallback to a single factor.
- **FX per point, in real mode (§7 consequence 2).** Real mode also converts each
  point at its own date's rate, using an `effectiveExchangeRates` track captured the
  same way. Nominal mode keeps the single current rate for now; retiring that
  everywhere is design 10's Phase 6.

---

## 6. The journal report and tax documents

- **Journal: R1, deflate each row by its own date.** The draft recommended this, and
  the table-stakes machinery now exists. `journal-report-plugin.js:105` passes
  `{ at: row.date }`, which resolves through the journal-backed `priceLevelSource`. In
  real mode the row also converts at that date's rate (`JournalFxRates`), not the live
  one (§7 consequence 2). The column then reads down the page in one unit.
- **R2, deflate every row to the slider date**, stays out of scope (Q-C).
- **Tax documents stay nominal**, and under opt-in this is **automatic**:
  `tax-document-modal.js` never passes `at`. It gains a `nominal` badge that is shown
  only while `valueBasis === 'real'`, so the mismatch is visible, not surprising.
- **CSV / clipboard export** always writes nominal values and puts the basis in the
  header row.

---

## 7. Which price level (decided 2026-09-27 — R3, R4, Q-A)

**Rule: deflate by the price level of the country whose currency is on screen.**
A value shown in USD is deflated by `inflationAccumulator.US`, and a value shown in AUD
by `inflationAccumulator.AU`. "Real" therefore means *base-year purchasing power in the
currency you are looking at*.

```
cc(shownCode) = shownCode === 'AUD' ? 'AU' : 'US'
real          = convert(nominal, native → shown, fx(t)) / level(t, cc(shownCode))
```

`shownCode` is the code the hop actually displays, not the display setting. When no
FX rate is available and the value is left in its native currency, it is deflated by
its native currency's level, so a value and its label always agree.

**Why this is not the retired per-native-currency rule (R3).** That rule deflated
each value by *its own* currency, so an AU super balance and a US brokerage account on
the same screen carried two different real units and no longer summed. This rule uses
**one denominator per screen**, because every value on screen is shown in the one
display currency. Totals still add, and a residence move never puts a step in the
axis. Those were the arguments for design 89's single US denominator, and this rule
keeps both. Where the display is USD, the result is identical to design 89 §9.b.1's
convention.

**Three consequences:**

1. **Switching currency changes the shape of a real curve, not just its scale.**
   Real AUD = real USD × fx(t) × level_US(t) / level_AU(t). That last ratio is the real
   exchange rate. Under a pinned FX rate with an inflation differential, the two real
   curves drift apart: purchasing power really does diverge. The toggle's help topic
   says so, because the first time you see it, it looks like a bug.
2. **FX must be read at the same date as the level.** Converting every point at
   today's rate and then deflating each point by its own date's AU level would be
   internally inconsistent. Wherever a surface deflates by a date `t`, it also converts
   at `fx(t)`, using `JournalFxRates` for history (§5, §6). Point-in-time panels get
   this for free, because both numbers come from the live state.
3. **Figures that are already real keep their own basis.** The optimizer objective
   and `terminalWealthTarget` are real USD. MC Real Cost and the real trough are real
   by residence (design 97 §18). They do not pass through the lens. While they sit on
   a screen whose lens basis differs, they carry a tag naming their basis
   (`real US` / `real residence`). `SpendingCube` already takes `priceLevelCc`, so
   the spending panel (§8.1) follows the lens by passing `cc(displayCurrency)`.

The country mapping is one exported function, `countryForCurrency(code)` in
`src/finance/country-codes.js`, the inverse of `currencyForCountry`. It is never
inlined.

---

## 8. Top-bar UI

This part is unchanged from the draft and still matches the code. Add a select after
`#displayCurrency` (`index.html:65`), wired in `workbench-app.js:_wireSimControls`
(line 1154) the same way as its neighbours:

```html
<select id="valueBasis" class="toolbar-select" title="Show money in nominal or real (base-year) dollars">
  <option value="nominal">Nominal $</option>
  <option value="real">Real $</option>   <!-- relabelled "Real (2026 $)" from simStart on scenario load -->
</select>
```

```js
$('valueBasis')?.addEventListener('change', () =>
  this.displaySettings.setValueBasis($('valueBasis').value));
if ($('valueBasis')) $('valueBasis').value = ds.valueBasis;
```

When a scenario loads, the `real` option's text is rewritten to
`Real (${simStart.getUTCFullYear()} $)`.

### 8.1 The spending panel's own switch (R5)

The spending panel already has `real | nominal | share` and defaults to real, which
design 89 made mandatory for that chart. **Decided 2026-09-27 (Q-B):**

- **The global toggle drives the panel's real/nominal choice** whenever it changes.
  Flipping the top bar to Nominal puts the spending chart in nominal as well, so
  nothing on screen disagrees with it.
- **The panel's local buttons stay** as a temporary override until the next global
  change. `share` is local only, because it has no basis.
- **The panel's first-load default stays `real`** whatever the global value, so
  design 89's rule is kept.

This is the one place a per-panel control survives. It already exists, and removing
it would reverse a design 89 decision.

---

## 9. Monte Carlo and optimizer panels (new — R6)

These panels show ensemble statistics: the P10/P50/P90 of terminal net worth, the fan
chart, and the grid cells. Each MC path's yearly series already carries its own
`priceLevel`. Because inflation is stochastic (design 103), levels differ between
paths. So:

```
real P50  =  P50 over paths of ( nominal_path / level_path )
          ≠  P50(nominal) / some level
```

- Real MC figures are computed **when the aggregate is built** (`mc-analysis.js` and
  the fan data), as parallel `*Real` fields next to the nominal ones. `Real Cost`
  already follows this pattern. The panel shows whichever set matches `valueBasis`
  and passes no `at` or `priceLevel` to the hop, because the value is already in the
  basis it claims.
- Figures that exist only as real (Real Cost, the real trough) show unchanged under
  both settings, labelled real. Figures that exist only as nominal show a `nominal`
  tag while the toggle is on Real, until they gain a real counterpart.
- Opt/MPC: `terminalPriceLevel` is already on every result (`optimization-problem.js:510`).
  The runs and results panels deflate terminal wealth by that result's own level.

This is phase **P4**. It is independent of P1–P3, and until it lands the MC and Opt
panels stay nominal with a tag.

---

## 10. Edge cases

- **No accumulator in state** (legacy or unwired): the hop returns `basis: 'nominal'`
  and the surface shows its tag. Values are never divided by an assumed 1.0.
- **Inflation turned off:** the accumulator stays at 1.0 and never diffs.
  `JournalPriceLevels` then finds no points, and its `fallbackLevel` (the live
  state's value, 1.0) makes real equal nominal. That result is correct, not a
  fallback.
- **Rewind or replay:** `priceLevelSource` rebuilds from the journal when the journal
  has shrunk as well as when it has grown.
- **Headless:** add `--real` to `scripts/scenario/run-scenario.mjs`. It divides the
  reported terminal values by the final `inflationAccumulator` of the reporting
  currency's country and prints the basis in the table header.

---

## 11. Phasing

| Phase | Scope | Depends on |
|---|---|---|
| **P1** ✅ | `valueBasis` setting; `presentForDisplay` opt-in hop and `priceLevelSource`; top-bar select and label; point-in-time panels (§4); `run-scenario --real` | — |
| **P2** | Chart: per-point level track, live and backfill (§5) | P1 |
| **P3** | Journal R1 (§6); allocation, pool history and paycheque panels by row date (§4); tax-document badge; export stamps the basis; spending panel follows the global toggle (§8.1) | P1 |
| **P4** | MC/Opt real aggregates computed per path (§9) | P1 |
| ~~old P4~~ | ~~per-native-currency deflator~~: **retired** (R3) | — |

P2, P3 and P4 are independent of one another once P1 lands.

---

## 12. Testing

- **Hop:** real equals `nominal / level`; currency is converted before deflation (an
  AUD-native value shown in USD); no `at` or `priceLevel` gives nominal with
  `basis: 'nominal'`; a missing level gives nominal with `basis: 'nominal'`, never a
  division by 1.
- **No-op invariant:** with `valueBasis === 'nominal'`, every surface renders
  byte-identically to today. With `'real'`, every surface that has **not** opted in
  also renders byte-identically, which is how R2's safety is tested.
- **Settings:** `valueBasis` round-trips through storage; an old v1 blob without the
  field loads as `'nominal'`.
- **Chart:** the point at t = sim start deflates by 1.0; the terminal point equals
  `nominal / final inflationAccumulator.US` in USD display, and
  `nominal × fx(end) / final .AU` in AUD display; a series activated after the run gets
  per-point levels through the backfill.
- **Country rule:** a USD-native value shown in AUD is deflated by AU; an AUD-native
  value left native because no rate is available is deflated by AU, not US; with the
  plan's two inflation rates set to differ, switching the display currency changes the
  real curve's shape by exactly the real-exchange-rate ratio.
- **Journal:** two rows with equal nominal amounts in years a and b deflate by
  different levels; the tax-document render ignores the toggle.
- **Cross-check:** a real terminal net worth from `run-scenario --real` equals the
  optimizer's `terminalPriceLevel`-deflated figure for the same run, so the two
  real-dollar paths agree. Assert on a golden-fixture run and never quote a scenario
  value in this doc.
- **MC (P4):** on a two-path fixture with different levels, the real P50 differs from
  the nominal P50 divided by the median level.

---

## 13. Decisions and open questions

**Resolved (2026-07-13, still standing):**

1. **Global, not per-panel.** There is one top-bar toggle. The spending panel's
   pre-existing local switch is the one exception (§8.1).
2. **Base year on the toggle label:** `Real (<simStart year> $)`.

**Resolved by the 2026-09-27 review:**

3. **Deflation is opt-in per call, never a blanket registry hop** (R2).
4. **No new recorded metric.** Use `JournalPriceLevels` and the chart's own snapshot
   feed (R1).
5. **Per-native-currency deflator retired** (R3).
6. **MC real figures are computed per path before the percentiles** (R6).
7. **Q-A: deflate by the display currency's country** (USD → US, AUD → AU), one
   denominator per screen (§7).
8. **Q-B: the global toggle drives the spending panel's real/nominal choice** (§8.1).
   Its local buttons are a temporary override, and its first-load default stays real.

**Open:**

- **Q-C.** R2 (deflate to the slider date) for the journal: ship R1 only and revisit
  on request.

---

## 14. Implementation plan

### P1 — setting, hop, top bar, point-in-time panels

**1.1 `src/visualization/app-display-settings.js`.** Add `valueBasis: 'nominal'` to
`#state`, plus `get valueBasis()` and `setValueBasis(v)`. `setValueBasis` rejects anything but
the two values, then calls `_set`. Include the field in `_loadFromStorage`,
`_persist` and the `_notify` payload. Keep `STORAGE_KEY` at `v1`: the field is
additive.

**1.2 `src/finance/services/state-schema-registry.js`.**
- `set priceLevelSource(src)`, next to `rateStateProvider` (line 944).
- `presentForDisplay(value, nativeCode, { at, priceLevel, state } = {})`, which returns
  `{ value, code, symbol, basis }`. The conversion is factored out of the duplicated
  bodies of `convertForDisplay` and `formatAmount` (lines 1025–1045 and 1047–1061
  repeat the same six lines), and both are then rebuilt on top of the new hop.
- `format()` and `_toDisplayCurrency`: pass `opts.at` and `opts.priceLevel` through.
  Note that `_toDisplayCurrency` returns `null` when native equals display (line 989),
  so deflation cannot go *inside* it. `format()` has to call the hop for every
  currency-kind value, including one already in the display currency.
- The country comes from `countryForCurrency(shownCode)` (§7), applied to the code the
  hop actually displays. It is never inlined.

**1.3 `src/visualization/money-format.js`.** Add an optional third argument to
`fmtCompact` and `fmtWhole` (`{ at, priceLevel }`), forwarded to the hop. Existing
callers are unchanged.

**1.4 `src/apps/workbench-app.js`.**
- Near line 818, inject `priceLevelSource`: `'live'` reads `this.scenario?.sim?.state`;
  a timestamp goes through a lazily rebuilt `JournalPriceLevels(sim.journal,
  { fallbackLevel })`, rebuilt when the journal length changes.
- `_wireSimControls` (line 1154) gets the select, as in §8. On scenario load it
  rewrites the `real` option's label from `simStart`.

**1.5 `index.html:65`.** Add the `#valueBasis` select after `#displayCurrency`.

**1.6 Point-in-time panels.** These are the four in §4's table: the state panel
(`_fmtLive` / `_liveBasisOpts`), watchlist, holdings (`_fmt`, `_compact`) and
securities (`_money` and the header). `FieldFormatter.format` and `valueTitle` forward
`at` and `priceLevel`.

**1.7 `scripts/scenario/run-scenario.mjs`.** Add a `--real` flag through `parseFlags`
(design 108), then `npm run help:build`.

**1.8 Help.** Add a `kind: panel` or `concept` topic, *"Nominal vs real dollars"*, from
`npm run help:gate -- --template concept`. Stamp it on `app-display-settings.js` and
the registry hop.

**P1 acceptance:** toggling to Real divides every §4 panel's money by its instant's
accumulator. Nominal is byte-identical to today. Journal, tax documents, chart and MC
stay nominal.

**P1 as built (2026-09-27).**
- `presentForDisplay` is the one money hop. `convertForDisplay` and `formatAmount` are
  now thin wrappers over it, which removed their duplicated conversion bodies, and
  both return `basis`.
- `liveJournalPriceLevels(getJournal)` in `journal-price-levels.js` is the dated
  source. It rebuilds only when the journal's length changes, and only when a dated
  value is asked for.
- `run-scenario --real` deflates each column by its own currency's country. Records
  the account service does not list (loans, properties) resolve their currency from
  the record. An unknown currency stays nominal rather than being assumed to be USD.
  `cumulativeDeficit` stays nominal, because it is a mixed-currency sum.
- Help: `help/concepts/real-vs-nominal.md`.
- Tests: `tests/unit/value-basis.test.mjs`, plus the settings round-trip cases in
  `tests/viz/app-display-settings.test.mjs`.
- Verified in the browser on the default scenario. The state panel's Net Worth equals
  nominal ÷ `inflationAccumulator.US`, and a `formatAmount` call with no instant stays
  nominal under Real.
- **Not done in P1:** a `nominal` tag on surfaces that ignore the toggle. It lands with
  each surface's own phase.

### P2 — chart
- `chart-presenter.js:_doRender`: read the level path from each snapshot and call
  `view.setPriceLevel(t, level)`. In `activatePath`, backfill the level track from
  `FieldSeriesStore.getOrBackfill` whenever it is empty.
- `chart-view.js:_displaySeriesData`: deflate each point (§5). `resetHistory` clears
  the track. The left axis's currency label gets a `real` suffix.
- Tooltip (`_fmtSeriesValue`): shows the value in the basis actually plotted.

### P3 — journal, tax documents, export, spending panel
- `journal-report-plugin.js:105`: `formatAmount(abs, code, { at: row.date })`.
- `tax-document-modal.js`: add the `nominal` badge while `valueBasis === 'real'`. The
  values themselves stay unchanged.
- Export: add a basis column or header.
- `spending-plugin.js`: subscribe to `valueBasis`, as described in §8.1.

### P4 — MC/Opt
- `mc-analysis.js`: add parallel `*Real` percentiles (terminal net worth, the fan
  series), each path deflated by its own `priceLevel` before the percentile is taken.
- `mc-results-panel.js` and `mc-runs-panel.js`: choose the field set by basis, and tag
  figures that exist only as nominal.
- `opt-results-panel.js` and `opt-runs-panel.js`: deflate terminal wealth by each
  result's own `terminalPriceLevel`.

### Cross-cutting
- **One deflator constant, one hop.** Design 89 §9.b counted four inline copies of
  "divide by the accumulator" in `src/`. This design adds **none**: every display
  deflation goes through `presentForDisplay`. The existing copies are in sim or
  optimizer logic, not display, and are out of scope.
