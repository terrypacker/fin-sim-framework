# 60 — Real vs. Nominal value display (constant-dollar toggle)

**Status**: **DESIGN** (2026-07-13). Scope: add an app-wide **value basis**
toggle — `Nominal` (default, today's behaviour) vs. `Real (today's $)` — to
`AppDisplaySettings` and the top bar, so every money value in the UI can be
rendered either in future/nominal dollars or deflated to constant base-year
dollars. This is a **display-only** transform: it changes no simulation logic,
exactly like the display-currency and timezone settings (design 10).

---

## 1. Motivation

Account balances compound at the **nominal** growth rate the user sets. Inflation
is applied only to the spending/income side (`InflationAdjustReducer` inflates
expenses, wages, and Social Security and accumulates `state.inflationAccumulator`);
it is never subtracted from account growth. The net-worth number shown in every
panel and chart is therefore **nominal future dollars**, and nothing in the UI
says so.

This is a genuine source of confusion. In the reference scenario (2026→2070, 44
years, US equity growth 10%, US inflation 3%):

| Basis | Ending net worth |
|---|---|
| Nominal (what the UI shows today) | **$190.5M** |
| Real, deflated by `inflationAccumulator.US` (÷ 1.03⁴⁴ ≈ 3.67) | **~$51.9M** |

A user who mentally models "10% nominal − 3% inflation ≈ 7% real" sees $190M and
assumes a bug, because their intuition is in real dollars while the display is
nominal. The same $190M in today's purchasing power (~$52M) matches the intuition
exactly. There is no bug — only a missing lens.

The deflator we need **already exists in state** (`inflationAccumulator[cc]`,
registered as `decimal(4)`, present at every step, per country) and is already
used for real-terms math throughout the model — `explicit-bands-spending-reducer`,
`accumulate-consumption-reducer`, `optimization-problem` (`terminalPriceLevel`),
CGT indexation, etc. This design surfaces that same deflator as a **display lens**.

---

## 2. Concept & precise semantics

### 2.1 What "Real (today's $)" means

`inflationAccumulator[cc]` starts at `1.0` at **sim start** and compounds by the
effective inflation rate at each `*_PERIOD_ADVANCE`. Define the display transform:

```
realValue(nominalValue, cc, atState) = nominalValue / (atState.inflationAccumulator[cc] ?? 1)
```

- **Base year = sim start.** In the reference scenario sim start (2026-01-01) ≈
  "today", so "real" == "today's dollars". If a scenario's `simStart` is not the
  present, the label should read **"Real (base-year $)"** — the base year is
  whenever the accumulator was seeded to 1.0, not the wall-clock present. (A
  future refinement could re-base to an arbitrary anchor year; out of scope here.)

- **Which country's accumulator (`cc`)?** Net worth is a **USD-base aggregate**.
  The default deflator is `inflationAccumulator.US`, matching the existing
  precedent in `optimization-problem.js:489`
  (`terminalPriceLevel: state.inflationAccumulator?.US`). See §7 for the
  currency-interaction subtlety (AU-denominated values shown in AUD).

### 2.2 It is a lens, not a recompute

Like display currency, the transform is applied **at format time** to values the
simulation already produced. No reducer, action, or saved state changes. Toggling
the basis never re-runs the sim.

---

## 3. Where the transform lives

Two clean insertion points, mirroring the design-10 currency pipeline:

1. **`AppDisplaySettings`** gains a fourth setting, `valueBasis: 'nominal' |
   'real'` (persisted, notified over the app bus alongside currency/timezone/theme).

2. **`StateSchemaRegistry`** — already the single hop through which currency
   conversion happens (`convertForDisplay`, `formatAmount`, `_toDisplayCurrency`)
   — gains a parallel **deflation step**. It already holds `_displaySettings` and
   `_rateStateProvider` (a `() => state` for the currently stepped-to state). The
   deflator reads `_displaySettings.valueBasis` and, when `'real'`, divides by
   `providedState.inflationAccumulator[cc]`.

This means **every panel that already routes money through the registry inherits
the toggle for free** — no per-plugin change beyond re-rendering on the settings
event (which plugins already do for currency; see
`holdings-plugin.js:104`, `journal-report-plugin.js:153`).

### 3.1 Order of operations

Convert currency **first**, then deflate:

```
displayed = deflate( convertCurrency( nativeValue ) )
```

The deflator (a pure price-level ratio) is currency-agnostic, so order only
matters for which accumulator is chosen (§7). Fold both into a single
`registry.presentForDisplay(value, nativeCode, { state })` that returns
`{ value, code, symbol, basis }`, and have `fmtWhole`/`fmtCompact`/`formatAmount`
call it. Keep `convertForDisplay` as a thin wrapper for back-compat.

---

## 4. Point-in-time surfaces (the easy 90%)

Panels that render **one instant** — the state panel, dash cards, holdings panel,
account balances, MPC cockpit — read the **stepped-to state** (the state at the
timeline slider position, already supplied via `rateStateProvider` /
`timeline-controller`). For these, the deflator is simply
`state.inflationAccumulator[cc]` of that same stepped-to state. Correct by
construction: the value and its deflator come from the same instant.

**Work:** route these panels' money formatting through the shared
`presentForDisplay` hop (most already do for currency), and add a
`DISPLAY_SETTINGS_CHANGED` re-render subscription where missing.

---

## 5. Time-series surfaces (the hard part) — charts

A net-worth-over-time chart plots values at **many different dates**, each needing
**its own deflator**. This is where a naïve implementation goes wrong.

`chart-view.js:_displaySeriesData` today applies **a single current FX rate across
the whole series** (an acknowledged Phase-6 shortcut, `chart-view.js:261`). For
currency that is a small error — FX is roughly flat. **For inflation it is a large
error**: the deflator ranges from 1.0 at sim start to ~3.67 at year 44. Applying
one factor would either flatten a real curve that should still rise, or crush the
early years. **A single-factor deflator is not acceptable for the chart.**

The chart needs a **per-point price-level series**. Options:

- **(A, recommended) Record a deflator series.** Snapshot
  `inflationAccumulator.US` (and `.AU`) into the recorded metric stream each
  period — the same `RECORD_METRIC` mechanism the earnings handlers already use.
  Then deflate point-by-point: `real[t] = nominal[t] / accum_series[t]`, aligning
  by timestamp. Robust to time-varying / regime inflation because it stores the
  actual realized path, not an assumed constant rate.

- **(B) Reconstruct analytically** from a constant inflation rate and elapsed
  years. Simpler, but **wrong** under regime shocks, `effectiveInflationRates`
  moves, or a mid-sim country move (residence-rate expense inflation). Rejected —
  it would silently disagree with the point-in-time panels, which use the real
  accumulator.

Implementation for (A): expose the recorded `inflationAccumulator.US` history as a
first-class series (it is already registered as `decimal(4)`), and in
`_displaySeriesData`, when `valueBasis === 'real'` and the series is currency-kind,
map each `[t, v]` through the accumulator value at `t` (nearest-prior sample; the
accumulator is a step function that changes only at year boundaries). This also
retires the "single current rate" caveat for the real path specifically.

---

## 6. Reports & the journal (the user's question)

The journal/report is **inherently multi-date**: each row is an event at its own
timestamp. The user's instinct — "always show values in relation to the date the
slider is on" — is one of two coherent policies; they answer different questions:

- **Policy R1 — per-row real (recommended).** Deflate each row by the price level
  **at that row's own date**. A $10k expense in 2050 and a $10k expense in 2026
  both display as their real base-year magnitude, so the column is comparable
  down the page. This is the honest "constant-dollar report" and it needs the
  same recorded accumulator series from §5, keyed by row date. Every journal row
  already carries a date, so this is well-defined.

- **Policy R2 — deflate-to-slider.** Express every row in the price level at the
  **current slider date**. Answers "what is this historical flow worth as of where
  I'm standing now?" Re-renders on every slider step. More surprising (the same
  row changes value as you scrub) and rarely what a report reader wants.

**Recommendation: R1** for the journal and any dated report. It matches how the
point-in-time panels behave (value and deflator share a date) and needs no
slider coupling. Reserve R2, if ever, as an explicit separate mode — do not make
it the default. Tax documents (`tax-document-modal`) are statutory nominal-dollar
artifacts and should **stay nominal regardless of the toggle**, with a small
"nominal" badge; deflating a 1040 line would misrepresent the filing.

---

## 7. Interaction with display currency

Net worth is a USD-base aggregate; the natural deflator is `inflationAccumulator.US`.
The subtlety is an **AUD-native value displayed in AUD** (e.g. an AU super balance
with display currency = AUD): its "real" basis should arguably use
`inflationAccumulator.AU` (4% here), not US (3%).

- **Phase 1 (ship first): single deflator = residence/base country (US).** Deflate
  every value by `inflationAccumulator.US`, regardless of native or display
  currency. Simple, matches the optimizer precedent, and is correct for the
  headline USD net-worth number. Document the approximation.

- **Phase 2 (refinement): per-native-country deflator.** Deflate a value by the
  accumulator of the value's **native currency's country** (`AUD → AU`,
  `USD → US`), chosen from `vt.currencyCode`, then convert currency for display.
  This is the theoretically clean "each stream in its own real terms" and reuses
  the `wageCurrency`-style country mapping already in `InflationAdjustReducer`
  (`AUD → AU` else `US`).

Keep Phase 1 as the shippable default; Phase 2 is a follow-up once the plumbing
and UI land.

---

## 8. Top-bar UI

Add a select next to `displayCurrency` in `index.html` and wire it in
`workbench-app.js:_wireSimControls` exactly like the others:

```html
<select id="valueBasis" class="toolbar-select" title="Show values in nominal or real (constant) dollars">
  <option value="nominal">Nominal $</option>
  <option value="real">Real ($)</option>   <!-- label rewritten to "Real (2026 $)" on scenario load -->
</select>
```

```js
$('valueBasis')?.addEventListener('change', () => {
  this.displaySettings.setValueBasis($('valueBasis').value);
});
// …and initialize from persisted state alongside tz/currency/theme:
if ($('valueBasis')) $('valueBasis').value = ds.valueBasis;
```

`AppDisplaySettings` gains `get valueBasis()`, `setValueBasis(v)`, storage
round-trip in `_loadFromStorage`/`_persist`, and the field in the
`DISPLAY_SETTINGS_CHANGED` payload.

**Base-year hint lives on the toggle, not on panels.** Rather than adding a
"(base-year $)" annotation to every panel (which would clutter each one — see the
global-vs-per-panel decision in §12), the **`real` option's own label carries the
base year**: `Real (2026 $)`, derived from the loaded scenario's `simStart` year.
The label is rewritten whenever a scenario loads (and re-rewritten if `simStart`
changes). This makes the lens unambiguous with a single point of truth and zero
per-panel work.

---

## 9. Edge cases & fallbacks

- **Saved states / old snapshots without a recorded accumulator series.** §5
  point-by-point deflation needs the series. If absent (legacy save), fall back to
  the single **current** accumulator for the chart (documented as approximate) and
  keep point-in-time panels exact (they read live state). Never throw; a missing
  accumulator ⇒ divide by 1.0 ⇒ nominal (safe no-op).
- **`inflationAccumulator` absent → `?? 1`** everywhere, so unwired/legacy
  scenarios render nominal, identical to today.
- **MC / Opt panels.** The Die-With-Target objective already deflates terminal
  wealth (`intl-retirement-scenario.js:599`); explicit spending bands are already
  real. Audit these so the toggle does not **double-deflate** an already-real
  figure — mark such series as "already real" and exempt them, or (cleaner)
  standardize on recording nominal and deflating only at display.
- **CSV / clipboard export.** Export should carry the basis in a header/label and
  ideally always export nominal (the source of truth) with the basis noted, so a
  spreadsheet round-trip is unambiguous.

---

## 10. Phasing

1. **P1 — Settings + plumbing.** `valueBasis` in `AppDisplaySettings` (+ persist,
   notify); `presentForDisplay` deflation hop in `StateSchemaRegistry` (US-only
   deflator, §7 Phase 1); top-bar select. Point-in-time panels (state panel, dash
   cards, holdings, balances, MPC cockpit) inherit it. Ship the 90%.
2. **P2 — Chart per-point deflator.** Record `inflationAccumulator.{US,AU}` as a
   metric series; deflate chart series point-by-point (§5A); retire the
   single-rate shortcut on the real path.
3. **P3 — Journal/report per-row real (R1)** using the recorded series; nominal
   badge on tax documents.
4. **P4 — Per-native-country deflator** (§7 Phase 2) and optional re-basable
   anchor year.

---

## 11. Testing

- **Unit:** `realValue` transform (`nominal / accum`), `presentForDisplay` order
  (currency then deflate), `?? 1` fallbacks, basis round-trips through storage.
- **Series alignment:** chart deflation picks the nearest-prior accumulator
  sample; a value at sim start deflates by 1.0; the terminal point matches
  `nominal / inflationAccumulator.US` from final state (the $190.5M → ~$51.9M
  check from §1 becomes a golden assertion).
- **No-op invariant:** `valueBasis === 'nominal'` reproduces byte-identical output
  to pre-feature (guard the whole feature behind the default).
- **Cross-check:** the real terminal net worth equals the optimizer's already-real
  `terminalPriceLevel`-deflated wealth — the two real-dollar paths must agree.
- **Headless:** extend `scripts/run-scenario.mjs` with a `--real` flag that prints
  the deflated net-worth column, so the nominal/real pair is verifiable without
  the browser (this doc's §1 table was produced that way).

---

## 12. Decisions & open questions

**Resolved (2026-07-13):**

1. **Global, not per-panel.** `valueBasis` is a single app-wide top-bar toggle,
   matching currency/timezone/theme. Per-panel overrides are explicitly out of
   scope — a second toggle on every panel is too much clutter for the value. The
   only exception is the hard-coded **tax-document nominal** exemption (§6).
2. **Base year shown explicitly, on the toggle label.** The `real` option reads
   `Real (<simStart-year> $)`, so a scenario whose `simStart` is not the present
   never overclaims "today's $". Single source of truth; no per-panel labels (§8).

**Still open:**

3. Do we ever want **R2 (deflate-to-slider)** for the journal, or is R1 enough?
   (Ship R1; revisit only on request.)
4. P2-vs-P4 ordering: is the AU/US per-country deflator worth doing before the
   chart series, given most headline figures are USD-base? (Plan sequences P2
   before P4.)

---

## 13. Implementation plan

Sequenced to match §10. Each phase is independently shippable and green before
the next. **P1 is safe to ship alone**: the chart formats via its own
`conv.convert(...)` path (`chart-view.js:277`), *not* the registry hop, so it
stays nominal until P2 explicitly makes it per-point — we never expose the wrong
single-factor deflation.

### Phase 1 — Settings, plumbing, top bar, point-in-time panels

**1.1 `AppDisplaySettings` (`src/visualization/app-display-settings.js`)**
- Add `valueBasis: 'nominal'` to `#state`; getter `get valueBasis()`,
  `setValueBasis(v)` (via existing `_set`).
- Include `valueBasis` in `_loadFromStorage`, `_persist`, and the
  `DISPLAY_SETTINGS_CHANGED` payload in `_notify`.
- Bump `STORAGE_KEY`? No — additive field, old blobs simply lack it and default
  to `'nominal'`. Keep `v1`.

**1.2 Deflation hop in `StateSchemaRegistry`
(`src/finance/services/state-schema-registry.js`)**
- Add private `_deflate(value, state)`: when `_displaySettings?.valueBasis ===
  'real'`, return `value / (state?.inflationAccumulator?.US ?? 1)`; else `value`.
  `?? 1` ⇒ safe no-op for legacy/unwired state.
- Apply it **after** currency conversion in the three existing money hops so all
  callers inherit it: `convertForDisplay` (used by `money-format.js`),
  `formatAmount`, and `_toDisplayCurrency` (used by `formatValue`). State comes
  from the same `_rateStateProvider?.()` already used for FX — value and deflator
  share the stepped-to instant.
- P1 uses the **US accumulator only** (§7 Phase 1). Add a `// TODO design 60 §7
  Phase 2: per-native-country accumulator` marker at the deflator.

**1.3 Top-bar select (`index.html` + `src/apps/workbench-app.js`)**
- Add the `#valueBasis` `<select>` next to `#displayCurrency` (§8).
- In `_wireSimControls`: `change` → `setValueBasis`; initialize `.value` from
  `ds.valueBasis` alongside tz/currency/theme.
- On scenario load (where `simStart` is known), rewrite the `real` option's text
  to `Real (${new Date(simStart).getUTCFullYear()} $)`.

**1.4 Point-in-time panel re-render**
- Ensure state panel, dash cards, holdings panel, account balances, and MPC
  cockpit subscribe to `DISPLAY_SETTINGS_CHANGED` and re-render (most already do
  for currency — audit `holdings-plugin.js:104`, `journal-report-plugin.js:153`
  as the pattern; add where missing).

**1.5 Headless (`scripts/run-scenario.mjs`)**
- Add `--real` flag: divide the reported net-worth column by final
  `state.inflationAccumulator.US`. Makes the §1 nominal/real pair reproducible in
  CI.

**P1 acceptance:** toggle flips every point-in-time panel between $190.5M and
~$51.9M for the reference scenario; `nominal` output is byte-identical to today;
chart still shows nominal (documented, resolved in P2).

**P1 tests:** `_deflate` math + `?? 1` fallback; storage round-trip; order
(currency→deflate) via a mixed AUD-native/USD-display case; `nominal` no-op
golden; `run-scenario --real` terminal value equals `nominal / accum.US`.

### Phase 2 — Chart per-point deflator

**2.1 Record the deflator series.** Snapshot `inflationAccumulator.US` (and `.AU`
for P4) into the recorded metric stream each period via the existing
`RECORD_METRIC` mechanism (it is already registered `decimal(4)`). Expose it as a
selectable/hidden series keyed by timestamp.

**2.2 Deflate chart series point-by-point
(`src/visualization/chart/chart-view.js:_displaySeriesData`).**
- When `valueBasis === 'real'` and the series is currency-kind, map each `[t, v]`
  → `[t, v / accum(t)]` using nearest-prior accumulator sample (step function,
  changes only at year boundaries).
- Retire the "single current rate" caveat **on the real path** (comment at
  `chart-view.js:261`); FX single-rate stays until FX Phase 6.
- Legacy saves without the series → fall back to the single **final** accumulator
  (documented approximate) rather than throwing.

**P2 tests:** series alignment (t=simStart deflates by 1.0; terminal point equals
`nominal / final accum.US` — the golden from §1); a rising nominal curve stays
sensibly shaped under real, not flattened by a single factor.

### Phase 3 — Journal / report per-row real (R1)

- In the journal/report presenter, deflate each row's money by the accumulator at
  **that row's date** (R1, §6), using the P2 recorded series.
- Hard-code **tax documents nominal** (`tax-document-modal`) with a small
  "nominal" badge regardless of the toggle.
- CSV/clipboard export: always export nominal, stamp the basis in the header.

### Phase 4 — Per-native-country deflator (§7 Phase 2)

- Replace the fixed US accumulator with a lookup keyed on the value's native
  `vt.currencyCode` (`AUD → AU`, else `US`), reusing the `InflationAdjustReducer`
  country mapping. Deflate in native terms, then convert currency for display.
- Optional: re-basable anchor year (out of scope unless requested).

### Cross-cutting guards
- **Double-deflation audit** (MC/Opt): the Die-With-Target objective already
  deflates (`intl-retirement-scenario.js:599`) and explicit spending bands are
  already real — exempt already-real series from the display deflator, or
  standardize on recording nominal and deflating only at display. Do this audit
  in P1 before wiring MC/Opt panels.
- **`?? 1` everywhere** so absent `inflationAccumulator` renders nominal (legacy
  parity).
