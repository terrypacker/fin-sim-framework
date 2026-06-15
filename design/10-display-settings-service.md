# Design: AppDisplaySettings Service — Unified Timezone, Currency & Theme

## Problem

The timezone (`tzSelect`) and display-currency (`displayCurrency`) selects in the top bar have
no coherent API. Their values are scattered across the DOM, `TimeControls`, and `BaseApp`, and
subscribing to changes requires a full `destroyScenario() + initScenario()` rebuild — even though
neither setting affects simulation logic, only rendering.

The app is also dark-theme-only with no switch, and none of the three rendering preferences
(timezone, currency, theme) persist across reloads.

### Current pain points

| Issue | Detail |
|---|---|
| Unnecessary rebuilds | Both `tzSelect` and `displayCurrency` change handlers call `destroyScenario()` + `initScenario()` — TODO comments acknowledge this is wrong |
| No subscriber model | Components that need `formatDate` (`DashCardsComponent`, `PlaybackProgressComponent`) receive it only at construction and have no mechanism to update without a rebuild |
| Duplicated handler code | `base-app.js` and `workbench-app.js` each duplicate the change-listener logic |
| Inline styles on selects | `index.html:67-74` sets styles inline on the `<select>` elements, violating the CSS-class convention |
| Inconsistent formatter use | `simulation-animator.js:151` inlines its own `(d) => statePanelView.fmtVal(d)` instead of the injected formatter; `base-app.js:810` calls `fmtUTC` directly |
| Currency lookup is indirect | `toDisplayCurrency()` reads `this.timeControls?.displayCurrency` — the currency lives inside `TimeControls`, a UI component, rather than a settings service |
| No theme switching | `developer.css` is the only theme; no light/dark toggle. CSS vars are already in place on `:root` but there is no override block or runtime switch |
| No persistence | Timezone, currency, and theme reset on every page reload |

---

## Proposed Solution: `AppDisplaySettings`

Introduce a single, app-lifetime service that is the **sole source of truth** for timezone,
display-currency, and theme. Components subscribe to it; the service notifies them when any
value changes so they can re-render in place, without any scenario teardown. Theme is applied
purely via a `data-theme` attribute on `<html>` so the CSS cascade handles it with no
component re-render at all. Settings are persisted to `localStorage` and rehydrated on construction.

### New file: `src/visualization/app-display-settings.js`

```js
const STORAGE_KEY = 'finsim.displaySettings.v1';

export class AppDisplaySettings {
  #timezone = 'utc';        // 'utc' | 'local'
  #currency = 'USD';        // 'USD' | 'AUD' — the display target; values convert at format time
  #theme    = 'dark';       // 'dark' | 'light'
  #subscribers = new Set();

  constructor() {
    this._loadFromStorage();
    this._applyThemeToDom();
  }

  get timezone()        { return this.#timezone; }
  get displayCurrency() { return this.#currency; }
  get theme()           { return this.#theme; }

  get formatDate() {
    return this.#timezone === 'utc' ? fmtUTC : fmtLocal;
  }

  setTimezone(tz)   { this._set('#timezone', tz); }
  setCurrency(code) { this._set('#currency', code); }
  setTheme(theme)   { if (this._set('#theme', theme)) this._applyThemeToDom(); }

  /** Returns an unsubscribe function. */
  subscribe(fn) {
    this.#subscribers.add(fn);
    return () => this.#subscribers.delete(fn);
  }

  _set(field, value) {
    if (this[field] === value) return false;
    this[field] = value;
    this._persist();
    this._notify();
    return true;
  }

  _applyThemeToDom() {
    document.documentElement.dataset.theme = this.#theme;
  }

  _loadFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const { timezone, currency, theme } = JSON.parse(raw);
      if (timezone) this.#timezone = timezone;
      if (currency) this.#currency = currency;
      if (theme)    this.#theme    = theme;
    } catch { /* ignore — fall back to defaults */ }
  }

  _persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        timezone: this.#timezone,
        currency: this.#currency,
        theme:    this.#theme,
      }));
    } catch { /* ignore quota / privacy-mode errors */ }
  }

  _notify() {
    const snapshot = {
      timezone:  this.#timezone,
      currency:  this.#currency,
      theme:     this.#theme,
      formatDate: this.formatDate,
    };
    for (const fn of this.#subscribers) fn(snapshot);
  }
}
```

### Theme implementation

`developer.css` already defines every color as a CSS custom property on `:root`. To add light
mode, scope the existing block to `[data-theme="dark"]` (also keep the bare `:root` so first
paint before JS runs still picks dark) and add a parallel `[data-theme="light"]` block that
overrides only the variables that change.

```css
/* developer.css */
:root,
:root[data-theme="dark"] {
  --bg-base:    #0a0c0f;
  --bg-panel:   #0f1217;
  --text-base:  #cfd6e4;
  /* …existing dark vars… */
}

:root[data-theme="light"] {
  --bg-base:    #f7f8fa;
  --bg-panel:   #ffffff;
  --bg-panel2:  #eef1f5;
  --bg-input:   #ffffff;
  --bg-active:  #d8dde5;
  --border:     #d0d6df;
  --border-hi:  #b4bcc8;
  --text-base:  #1a1f2a;
  --text-muted: #5a6478;
  /* accents (amber/cyan/green/red) are kept — they read fine on both backgrounds */
}
```

Components that draw with JS (canvas charts, SVG fills derived from JS reads of CSS vars)
must re-read their colors when `theme` changes in the subscription snapshot. Plain DOM/CSS
components need no special handling — the cascade does the work.

> **First-paint:** add the saved theme to `<html data-theme="…">` from a tiny inline script
> at the very top of `<head>` so the page never flashes the wrong colors:
>
> ```html
> <script>
>   try {
>     const s = JSON.parse(localStorage.getItem('finsim.displaySettings.v1') || '{}');
>     if (s.theme === 'light' || s.theme === 'dark')
>       document.documentElement.dataset.theme = s.theme;
>     else document.documentElement.dataset.theme = 'dark';
>   } catch { document.documentElement.dataset.theme = 'dark'; }
> </script>
> ```

---

## Currency Architecture

The timezone/theme parts of this service are complete (Phases 1–2). The remaining
work — and the bulk of this document — is **application-wide currency support**.

### Principle: native internal, display-only conversion

There is **no base currency** for internal math. Every monetary value is computed and
stored in its own **native currency** (an account's `currency.code`, a param's declared
currency). This preserves fidelity — AUD super is taxed in AUD, USD brokerage in USD — and
matches the engine, which is already natively multi-currency (conversion happens only at
explicit FX-transfer points). The **display currency** chosen in `AppDisplaySettings` is
purely a presentation concern: values are converted **at format time only**, never in
`sim.state` or the journal. Switching display currency therefore **never requires a
re-run**.

### Every value carries a native currency

For conversion to be possible, the display layer must know the *source* currency of every
money value:

- **State fields** already resolve to a `ValueType` via `StateSchemaRegistry`. The contract
  becomes: **every `currency` ValueType must carry a `currencyCode`** — no symbol-less
  currency paths. See the Phase 3 audit.
- **Inputs** (params, account / person / asset values) gain an explicit native currency,
  **defaulted by jurisdiction and overridable** in the UI (a US house defaults to USD with a
  currency selector beside it; super defaults to AUD). See Phase 5.

### Rates come from the run, via the FX engine

The display layer must **not** hardcode or re-derive rates (no `1.55` literal, no external
feed). A new stateless `CurrencyConverter` (in `src/finance/fx/`) wraps an `FxEngine` — the
same `UsdAudPair` rate math the simulation uses — and reads the rate from a **state
snapshot's `effectiveExchangeRates`**:

```js
// src/finance/fx/currency-converter.js
export class CurrencyConverter {
  constructor(fxEngine = defaultFxEngine()) { this._fx = fxEngine; }

  /**
   * Convert `value` from → to using the rate recorded in `state`.
   * Returns `value` unchanged when from === to.
   * Returns `null` (caller renders native) when no pair/rate is available —
   * e.g. the FX toolset is not loaded so `state.effectiveExchangeRates` is absent.
   */
  convert(value, fromCode, toCode, state) {
    if (value == null || fromCode === toCode) return value;
    try {
      const pair = this._fx.getPair(fromCode, toCode);
      return value * pair.rate(state, { from: fromCode, to: toCode });
    } catch { return null; }
  }
}
```

The converter constructs its **own** `FxEngine` with the known pairs (it does not depend on
the per-compilation `FxService` instance, which only exists when the cross-border toolset is
loaded). It only needs the pair's `rate()` math plus the snapshot's `effectiveExchangeRates`.
Because that field is rewritten each period advance by `FxRefreshReducer`, **time-varying
rates (Phase 6) require no converter change** — each call passes the snapshot from the
relevant point in time.

### Picking the right snapshot (per-point conversion)

| Surface | Snapshot used for the rate |
|---|---|
| State panel (current sim time) | the live `sim.state` |
| Timeline / journal rows | the journal entry's own `nextState` (rate as-of that entry's date) |
| Chart time-series | the `effectiveExchangeRates.<pair>` series, zipped **per-point** with the value series — each point converted at its own historical rate |
| MC / Opt result summaries | the run's final-state rate (single scalar outputs) |

Per-point historical conversion is the chosen behaviour for charts: the rate series is itself
a chartable state field, so as rates vary over time (Phase 6) each data point automatically
uses the rate in effect when it occurred.

---

## Integration Plan

### Phase 1 — Create and wire the service (no behaviour change for tz/currency; adds theme)

1. Add `src/visualization/app-display-settings.js` with the class above.
2. Add the first-paint `<script>` shown above to the very top of `<head>` in `index.html`.
3. Instantiate once in `WorkbenchApp` as `this.displaySettings = new AppDisplaySettings()`.
4. Add a `<select id="themeSelect">` (options: `Dark`, `Light`) to the toolbar next to the
   timezone and currency selects.
5. Wire the three DOM selects to call `displaySettings.setTimezone()` / `setCurrency()` /
   `setTheme()` — **remove `destroyScenario` + `initScenario` calls** from both existing
   handlers. Initialize each select's `value` from `displaySettings` on app boot so the UI
   reflects the persisted state.
6. Remove inline `style` attributes from the toolbar `<select>` elements in `index.html`; add
   equivalent rules to the top-bar CSS (class `.toolbar-select` or similar) using theme vars.
7. Remove duplicate handler code in `workbench-app.js`.
8. Extend `developer.css` with the `[data-theme="light"]` override block and scope the existing
   `:root` block to `:root, :root[data-theme="dark"]`.

### Phase 2 — Subscribe components

Make every display component subscribe to `AppDisplaySettings` instead of receiving a
one-time injection.

| Component | Current mechanism | After |
|---|---|---|
| `TimeControls` | `setFormatDate(fn)` setter, `displayCurrency` property | Subscribe; update internal state + re-render label |
| `StatePanelView` | `set formatDate(fn)` setter | Subscribe; update `_formatDate` + schedule re-render |
| `PlaybackProgressComponent` | constructor-only `formatDate` | Subscribe; update `_formatDate` |
| `DashCardsComponent` | constructor-only `formatDate` | Subscribe; update `_formatDate` + schedule re-render |
| `TimelinePresenter` | constructor-only `_formatDate` | Subscribe; update and re-render if open |
| `SimulationAnimator` | inline lambda, ignores injected formatter | Subscribe and use `displaySettings.formatDate` |
| `GraphNodeExecHistory` | `_fmt()` uses hardcoded `$` symbol | Subscribe; use `displaySettings.displayCurrency` to pick symbol |
| JS-driven color readers (chart axes, SVG fills derived from `getComputedStyle(:root)`) | Read once at construction | Subscribe; re-read CSS vars when `snapshot.theme` changes |

Each component should call `displaySettings.subscribe(…)` in its constructor and register the
returned unsubscribe function with its existing `onCleanup()` / `destroy()` lifecycle hook.
Pure DOM/CSS components do **not** need to subscribe for theme — the cascade handles them.

### Phase 3 — Native-code audit (prerequisite) — ✅ IMPLEMENTED

Guarantee every renderable money value resolves to a **non-null `currencyCode`**, so the
converter always knows the source currency. Conversion is impossible without it.

**Audit findings (empirical, against a compiled `IntlRetirementScenario`):**

- **`registerAccount()` was never called in the production toolset path.** Only the legacy
  hand-built `InternationalRetirementFinancialState._assignAccount` invoked it; the toolset
  compiler just `Object.assign`s plain state patches. So **every** account balance / basis /
  holdings field resolved to a **code-less** `currency()` via the generic globs.
- **Holdings precedence bug:** even where `registerAccount` ran, its per-account holdings
  patterns were *appended* after the generic code-less `*.holdings.*` globs — and resolution is
  first-match — so the code-less glob always won.
- **Untyped money** (resolved to `unknown`): asset fields (`*HouseProperty.value` /
  `.costBasis` / `.mortgageBalance` / `.monthlyMortgage`, `collectibleAccount.value` /
  `.costBasis`), account `*.loanBalance`, AU per-person YTD (`auPerson*YTD.{primary,spouse}`),
  and `people.*.monthlyWage` / `.socialSecurityMonthly`.

**Implemented:**

- `StateSchemaRegistry`: pattern registration is now **idempotent** (dedupe by glob — the
  registry is reused across rebuilds) and gained `registerPatternFront()` so per-account
  holdings patterns are **front-inserted** and win over the generic globs. `registerAccount()`
  also stamps `loanBalance`. New `registerAsset(stateKey, asset)` stamps `value` / `costBasis`
  / `mortgageBalance` / `monthlyMortgage` / `balanceAtResidencyChange`, deriving the code from
  `asset.currency?.code ?? country` (assets carry a null currency descriptor today).
- Static registrations added: `auPerson*YTD.*` (AUD) and `people.*.monthlyWage` /
  `.socialSecurityMonthly` (USD baseline; per-person override is Phase 5).
- **`ScenarioCompiler.compile()`** now calls `registerAccount` / `registerAsset` for every
  account, real property, and collectible right after the state patches are assigned — this is
  the fix for the "never called" finding.
- Guard test `tests/unit/currency-schema-coverage.test.mjs`: asserts the compiled scenario has
  **zero** code-less currency paths, that representative money paths carry the right code, and
  that re-registration does not grow the pattern list.

**Result:** zero code-less currency paths in the compiled scenario.

**Deferred / out of scope:**

- The dev-only warn ("conversion requested for a code-less source") belongs to `format()`'s
  conversion branch and lands with **Phase 4**, since no conversion happens yet.
- Remaining `unknown` numeric paths are **non-money** and were left alone: `*.drawdownPriority`
  / `*.minimumAge` / `deficitMonths` / `*.lifeExpectancy` (integer), `*.appreciationRate` /
  `baseGrowthRates.*` / `effectiveGrowthRates.*` (rate), `discretionarySharePct` (percentage),
  `inflationAccumulator.*` (decimal), `currentPeriods.*.startMs|endMs` (epoch-ms). Typing these
  correctly would improve display precision but is a separate cleanup, not a currency blocker.

### Phase 4 — Display-currency conversion through `StateSchemaRegistry` — ✅ COMPLETE

Wire the `CurrencyConverter` so every money surface honours the active display currency, with
**no scenario re-run**. All reads go through one path: a value's native code (from `ValueType` /
`TypeRegistry` / account stamping) → `CurrencyConverter` → the run's recorded
`effectiveExchangeRates` → the display currency.

**Surfaces converted (every user-facing money surface):**

| Surface | Mechanism |
|---|---|
| State panel rows + deficit banner | `format()` via `metrics.<stateKey>` + account stamping; sparkline is normalization-invariant |
| Chart (incl. `metrics.netWorth/netLiquidity`, account balance series) | `chart-view._displaySeriesData()`, axis/tooltip display symbol |
| Timeline (on-screen amounts, CSV) | `TimelineController._nativeCode()` (TypeRegistry → cc → target-account fallback) |
| Action Detail (state changes + annotated payload) | `_fmtChange` + `_formatActionPayload` |
| Embedded tax reports | `tax-document-modal._fmtAmt(amount, code)` from `doc.country` |
| Cross-action query | `format()` |
| Decision-graph results, scenario compare | `formatAmount(v, 'USD', { maximumFractionDigits: 0 })` |
| Journal report | `_fmtMoney(n)` keyed on the active `cc` facet |
| MC / OPT results + runs | `money-format.js` (`fmtCompact`/`fmtWhole` → `convertForDisplay`) |
| Graph node exec history | `_fmtField(field, value)` (currency fields only) |

**Re-render on switch (no re-run):** every docked surface subscribes to
`DISPLAY_SETTINGS_CHANGED` (app or workbench bus) and reformats in place; transient dialogs
(tax modal) reflect the current currency on next open.

**Remaining (documented, intentionally not done):** object-valued state diffs (a whole
`*.holdings` element dumped as JSON) show native nested numbers — same class as a raw payload.

**Implemented:**

- `src/finance/fx/currency-converter.js` — stateless `CurrencyConverter` wrapping an `FxEngine`
  (`UsdAudPair`). Reads the rate from `state.effectiveExchangeRates`; returns `null` (caller
  renders native) when no pair or **no recorded rate** exists — it never silently assumes 1:1,
  which would mislabel a native magnitude with the display symbol.
- `StateSchemaRegistry`: injected `displaySettings` / `currencyConverter` / `rateStateProvider`
  (all duck-typed — no UI imports into the finance layer). `format(path, value, { state })`
  converts a currency field to the display currency, formats with the display symbol, and falls
  back to native when the source is code-less (warns once) or no rate is available. `ServiceRegistry`
  constructs the converter and attaches it; `WorkbenchApp.initScenario` injects `displaySettings`
  and `rateStateProvider = () => sim.state`.
- **Chart** (`chart-view.js`): currency series are stored native and converted at build time via
  `_displaySeriesData()` (single current rate); the magnitude rescales so USD/AUD series share a
  comparable axis. The left axis and tooltip now carry the **display currency symbol** so the
  switch is legible (a lone converted series auto-rescales and would otherwise look identical).
  Re-renders on `DISPLAY_SETTINGS_CHANGED`. Per-point historical rates are a Phase 6 swap.
- **Money metrics typed as currency:** `metrics.netWorth` / `metrics.netLiquidity` are aggregates
  in the USD base currency but were typed `metric()` (no code) and so were skipped. They are now
  registered as `currency('USD')` — the default chart series (`metrics.netWorth`) converts.
- **Per-account balance metrics convert:** each account's balance is also recorded into
  `state.metrics[stateKey]` via `RecordBalanceAction('<stateKey>.balance', '<stateKey>')` for
  charting. These matched the generic `metrics.*` → `metric` glob (no code), so account series in
  the chart/state-panel did **not** convert while `metrics.netWorth` did — the reported symptom.
  `registerAccount()` now also stamps `metrics.<stateKey>` with the account's currency. And the
  chart determines a series' currency-ness from the **injected (stamped) registry**, not
  state-paths' module registry (which lacks per-account stamps and would type these `metric`).
- **Timeline native currency from the `TypeRegistry`:** most action payloads carry **no `cc`**
  (e.g. `SUPER_CONTRIBUTION_APPLY` is AUD with no prefix/cc), so a country heuristic would
  mislabel them. `TimelineController._nativeCode()` resolves each amount's currency from the
  registered field type (`getAction(type).fields.amount` → `ValueType.currency(code)`), falling
  back to `cc`, then to the **target account's currency** via `data.targetKey`/`stateKey`/
  `destinationKey` (`<key>.balance` code). This last fallback covers amounts typed
  `ValueType.number()` rather than `currency()` — the reason `EXPENSE_DEBIT` did not convert
  while `US_SAVINGS_INTEREST_CREDIT` (typed `currency('USD')`) did. When none resolve, the amount
  renders native (no symbol change).
- **State panel:** the per-account row values convert via the `metrics.<stateKey>` stamping above.
  The mini **sparkline** is min/max-normalized, so it is **shape-invariant** under a uniform rate
  and needs no conversion. The out-of-funds **deficit banner** previously hardcoded `'$' + …`;
  it now routes through `format()` (`cumulativeDeficit`, USD) and converts.
- **`RECORD_BALANCE` rendering (by design, not a bug):** `RecordBalanceAction` captures a balance
  into `state.metrics[stateKey]` but its payload only carries `fieldPath`/`metricKey` (a
  reference) — no amount or currency — so a timeline `RECORD_BALANCE` row has nothing to
  render/convert. The captured value lives in `metrics.<stateKey>`, which IS currency-typed and
  converts in the chart/state-panel.
- **On-screen timeline** (`TimelineController.sum()`): action-payload amounts (`amount` / `tax`
  / `value`) carry a country code (`data.cc`) → native currency, now converted to the display
  currency via the injected `CurrencyConverter` + `rateStateProvider` (falls back to native when
  no rate). The presenter already re-renders the timeline on `DISPLAY_SETTINGS_CHANGED`.
- **Re-render on switch (no re-run):** `state-panel-view` calls `refresh()`,
  `cross-action-query-plugin` re-runs its query, the timeline and chart re-render — all on
  `DISPLAY_SETTINGS_CHANGED`. Timeline CSV export auto-converts (it routes diffs through `format()`).
- Tests: `tests/unit/currency-converter.test.mjs` (converter + `format()` conversion),
  chart cases in `tests/viz/chart/chart-view.test.mjs`, and timeline `sum()` conversion cases in
  `tests/viz/timeline/timeline-controller.test.mjs`.

- **Action Detail panel:** state-change before/after/delta already convert via `_fmtChange`. The
  collapsed **payload** dump now annotates currency-typed `data` fields (resolved via the
  `TypeRegistry`) with their display value — e.g. `"amount": "8000 USD → A$12,400.00"` — via
  `StateSchemaRegistry.formatAmount(value, nativeCode)` + `displayCurrencyCode()`. An open detail
  re-renders on `DISPLAY_SETTINGS_CHANGED` (`showNodeDetail(entry, { reveal:false })`, tracking
  `_lastDetailEntry`). Object-valued state diffs (e.g. a whole `*.holdings` element) still render
  as raw JSON with native nested numbers — same class as the raw payload; minor follow-up.
- **Embedded tax reports** (`tax-document-modal.js`): `_fmtAmt` hardcoded `'$'` and never converted.
  Each `TaxDocument` carries `country` (`'US'`/`'AU'`) → native currency; `_fmtAmt(amount, code)`
  now converts via `StateSchemaRegistry.formatAmount()` (injected) and keeps accounting-style
  parens for negatives. Covers table rows/totals, line items (incl. drill-down buttons), and the
  summary. The modal is a transient on-demand dialog, so reopening reflects the current currency
  (no live re-render needed).

**Aggregate / report panels — ✅ IMPLEMENTED:**

- `dg-results-panel` (MC percentiles, expected value) and `scenario-compare-presenter` (net worth,
  cumulative deficit) are USD-base aggregates; their `FMT`/`fmtUsd` now route through
  `ServiceRegistry.getInstance().schemaRegistry.formatAmount(v, 'USD', { maximumFractionDigits: 0 })`
  (whole dollars), converting to the active display currency with a graceful Intl-USD fallback.
- `journal-report-plugin`: amounts are in the active `cc` facet's currency (US→USD, AU→AUD). New
  `_fmtMoney(n)` resolves that code, converts via `formatAmount`, and keeps the +/- sign; it
  re-renders on `WB_EVENTS.DISPLAY_SETTINGS_CHANGED`.
- **MC & OPT results/runs panels** (`mc-results-panel`, `mc-runs-panel`, `opt-results-panel`,
  `opt-runs-panel`): their compact (`$1.5M`/`$500k`) and whole-dollar formatters are USD-base
  aggregates (net worth percentiles, scores, `finalNetWorthUsd`). A shared `money-format.js`
  (`fmtCompact`/`fmtWhole`) converts via `StateSchemaRegistry.convertForDisplay(value, 'USD')`
  (returns converted value + display symbol, for custom compact formatting). The MC/OPT
  presenters take `appBus` and re-render their cached `_lastResult` on
  `DISPLAY_SETTINGS_CHANGED`, so switching currency reflows results without re-running the sweep.

**CSV policy — settled:**

- **Timeline CSV** routes diff cells through `format()`, so it follows the **active display
  currency** (matches the on-screen timeline — least surprising for "export what I see").
- **Param CSV** exports **native** param values (literal inputs; per-input currency is Phase 5).

**`graph-node-exec-history` — ✅ IMPLEMENTED:** state-change before/after/delta now route through
`_fmtField(field, value)`, which uses the schema registry **only for currency fields** (conversion
+ symbol) and the plain formatter for everything else (so integers stay integers). Injected
`schemaRegistry` + `appBus`; re-renders the selected node on `DISPLAY_SETTINGS_CHANGED`.

**Remaining minor follow-up:**

- **Object-valued state diffs** (a whole `*.holdings` element rendered as JSON) show native nested
  `marketValue`/`costBasis`. Converting money inside an object dump is messy and low-value (the
  adjacent scalar balance change converts); left as-is, same class as the raw action payload.

### Phase 5 — Per-input native currency (implicit default + explicit override) — ✅ IMPLEMENTED

Make every money **input** declare its native currency, defaulted by jurisdiction with an
explicit override. **Scope is input-side only: assign/edit native currency codes.** The display
side is finished (Phase 4) — any value whose native code is known already converts everywhere, so
**no display/formatter changes are needed.**

**Decisions taken:** (1) a dedicated **`Money` param type** (numeric `value` + sibling `currency`)
rather than an attribute — `cfg.parameters[name]` stays numeric so the compiler / MC / optimizer are
untouched; (2) **per-field** person currency (`wageCurrency` + `ssCurrency`, individually
overridable, defaulted by residency/citizenship) so a USD wage can fund a USD account under later FX
work; (3) `monthlyExpenses` is a **household-base** Money param defaulting USD (per-residency-over-time
deferred). Currency choices are USD/AUD (the only `FxEngine` pair).

**Implemented:**

- **`StateSchemaRegistry`**: `registerPerson(person)` stamps `people.<id>.monthlyWage` /
  `socialSecurityMonthly` from per-field `wageCurrency` / `ssCurrency` (default via residency);
  `registerCurrencyPaths(paths, code)` stamps free-standing money-param paths. The hardcoded
  `people.*.monthlyWage` / `socialSecurityMonthly` USD globs were removed (no code-less glob remains,
  so an unstamped person surfaces as `unknown` and is caught by the coverage guard).
- **`ScenarioLoader._registerDisplayCurrencies(cfg, services)`** now also stamps every person and any
  `type:'Money'` param's `currencyStateKeys`. `_normalizeParams` / `_mergeParamSchema` carry
  `currency` / `defaultCurrency` / `currencyStateKeys` onto entries and upgrade a schema param that
  became `Money` (the value is numeric, so the type change is safe) — old configs gain the selector.
- **Person** (`person.js`): `wageCurrency` / `ssCurrency` (default from residency); round-tripped by
  the serializer; editor (`person-editor.js` + `tpl-person-editor`) gains two currency selects;
  `PeopleController` passes them through.
- **Account** editor: a currency `<select>` defaulted by type/country (super→AUD; 401k/roth/ira→USD;
  variable→country), overridable; `AccountsController` maps the code → `USD`/`AUD` descriptor on
  create/update. Accounts already round-tripped `currency`.
- **Assets** (`real-property` / `collectible` editors): a currency `<select>` defaulted by country,
  overridable; `workbench-app` maps the code → descriptor on save; the **serializer now round-trips
  `currency`** for both assets (previously dropped — they fell back to `country`).
- **Money param type**: `scenario-tab-view` renders a numeric value + inline currency `<select>` and
  adds `Money` to the type list; `param-csv` adds `Money` to the scalar set and a `currency` column
  (round-tripped on import for Money rows); `US_RETIREMENT`'s `monthlyExpenses` schema entry is now
  `type:'Money'`, `defaultCurrency:'USD'`,
  `currencyStateKeys:['monthlyExpenses','expenses.essential','expenses.discretionary']`.
- **Tests**: `currency-schema-coverage` extended (registerPerson per-field, registerCurrencyPaths,
  account/asset override re-stamp); `param-csv` Money round-trip; new
  `tests/viz/editors/currency-selectors.test.mjs` exercises all four editors against the real
  templates. Full `test:unit` + `test:viz` green; production build clean.

#### What Phase 4/5 already gives you (the leverage — don't rebuild it)

- **Display conversion is automatic from the native code.** `StateSchemaRegistry` resolves a
  field's `ValueType.currencyCode`; if a value has a code, every surface converts it. Phase 5's
  only job is to make sure each money input *has the right code* in its `ValueType`.
- **Account/asset stamping already keys off the domain object's currency:**
  - `StateSchemaRegistry.registerAccount(stateKey, account)` stamps `<stateKey>.balance`,
    `.contributionBasis`, `.earningsBasis`, `.minimumBalance`, `.loanBalance`,
    `<stateKey>.holdings.*`, **and** `metrics.<stateKey>` from `account.currency.code`.
  - `StateSchemaRegistry.registerAsset(stateKey, asset)` stamps `value` / `costBasis` /
    `mortgageBalance` / `monthlyMortgage` / `balanceAtResidencyChange` from
    `asset.currency?.code ?? countryToCurrency(asset.country)`.
  - Both run in **`ScenarioLoader._registerDisplayCurrencies(services)`** (on both compile and
    deserialize paths) after `deserializePersonsAccounts`. → **Change an account's/asset's
    currency and re-stamp, and conversion follows automatically.**
- **Accounts already carry `currency` (`{code, symbol}`)** — Phase 5 just needs an editor
  selector + ensure it serializes. **Assets carry `currency` but it is `null` today** (they fall
  back to `country`); Phase 5 makes it explicit/editable.
- **Person income is currently hardcoded** `currency('USD')` for `people.*.monthlyWage` /
  `people.*.socialSecurityMonthly` (static registration in the `StateSchemaRegistry` constructor).
  Phase 5 should make this per-person (add a person currency + a `registerPerson`-style stamp in
  `_registerDisplayCurrencies`, and drop the hardcoded USD globs).
- **`monthlyExpenses`, US/AU YTD fields** are jurisdiction-fixed currency registrations — leave
  them; they are correct native codes.

#### Work, by input type

1. **Account editor** (`src/visualization/accounts/`) — add a currency `<select>` (USD/AUD)
   bound to `account.currency`, defaulted by `account.country`. Mutate via the service so the
   `SERVICE_ACTION` rebuild re-runs `_registerDisplayCurrencies`. (`ScenarioSerializer` already
   round-trips `account.currency` — serializer lines ~561/~766 — so the selector persists.)
2. **RealProperty / Collectible editors** (`src/visualization/assets/`) — same selector bound to
   `asset.currency`, defaulted by `country`. `registerAsset` already reads `currency?.code` first.
3. **Person** (`src/finance/person.js` + `src/visualization/people/`) — add a person currency
   field (decide: one `incomeCurrency` per person vs per-field for wage/SS — recommend one,
   defaulted by primary citizenship/residency). Replace the hardcoded `people.*.monthlyWage` /
   `socialSecurityMonthly` USD registrations with a per-person stamp keyed on that field.
4. **Params** (`scenario` toolset schemas + `scenario-tab-view`) — for free-standing money params
   not already owned by an account/person (e.g. `monthlyExpenses`), add a `currency` attribute
   (and/or a `Money` param `type`) so the money row renders `[ value ] [CUR ▾]`, defaulted by
   group/jurisdiction. Params that node-cascade into an account/person field should defer to that
   object's currency rather than carry their own.
5. **`param-csv.js`** — round-trip a `currency` column so import/export preserves native codes.

#### Open decisions for the session that picks this up

- **Person currency granularity:** one per person, or separate wage vs SS? (Recommend one.)
- **Param currency vs object currency:** avoid two sources of truth — node-cascaded params should
  read the target object's currency; only free-standing money params need their own.
- **New `Money` param type vs a `currency` attribute** on existing `Number` entries. (Attribute is
  less disruptive; a `Money` type is cleaner for the editor — pick one.)
- **`monthlyExpenses` semantics:** household base currency, or per-jurisdiction? Decides its
  default + whether it gets a selector.

#### Verification pattern (reuse)

- Extend `tests/unit/currency-schema-coverage.test.mjs` — after changing an account/asset/person
  currency, assert its state paths re-stamp to the new code.
- Live: the Chrome CDP loop used throughout Phase 4 (reload → `window.__app` / `window.ServiceRegistry`
  → flip `#displayCurrency` → read rendered values) is the fastest way to confirm a new selector
  flows native code → conversion.

### Phase 6 — Time-varying exchange rates (deferred, seam-ready)

- Replace the static mirror in `FxRefreshReducer` with a **rate-curve lookup** — analogous to
  the economic-regime reducers that already overwrite `effectiveExchangeRates` at
  `PRE_PROCESS + 1`.
- Drive it from a new rate-curve param (point list or annual drift), seeded from
  `exchangeRateUsdToAud` as the t0 value.
- **No display-layer change required:** because every surface already converts at the
  snapshot's recorded rate (Phase 4), per-point chart conversions and per-entry timeline
  conversions automatically track the varying rate.

---

## Files Affected

| File | Change |
|---|---|
| `src/visualization/app-display-settings.js` | **New** — the service (timezone + currency + theme + localStorage) |
| `index.html` | Add first-paint theme `<script>`; add `<select id="themeSelect">`; remove inline styles from `#tzSelect` / `#displayCurrency` / `#themeSelect`; add CSS class |
| `assets/css/themes/developer.css` | Scope existing `:root` block to `:root, :root[data-theme="dark"]`; add `:root[data-theme="light"]` override block |
| `src/apps/workbench-app.js` | Instantiate service; wire all three selects; remove duplicated change-listeners; remove scenario rebuild; initialize select values from persisted state |
| `src/visualization/time-controls.js` | Subscribe; remove `setFormatDate` setter; remove `displayCurrency` property |
| `src/visualization/simulation/state-panel-view.js` | Subscribe instead of `set formatDate` setter |
| `src/visualization/simulation/playback-progress-component.js` | Subscribe |
| `src/visualization/simulation/dash-cards-component.js` | Subscribe |
| `src/visualization/simulation/simulation-animator.js` | Subscribe; drop inline formatter |
| `src/visualization/timeline/timeline-presenter.js` | Subscribe |
| `src/visualization/graph-builder/graph-node-exec-history.js` | Subscribe for currency symbol |
| JS-driven chart/canvas components | Re-read CSS vars on `snapshot.theme` change |
| `src/finance/fx/currency-converter.js` | **New** — stateless display-side converter wrapping `FxEngine`; reads `state.effectiveExchangeRates` (Phase 4) |
| `src/finance/services/state-schema-registry.js` | Phase 3 native-code audit; Phase 4 `format(path, value, { state })` display-currency conversion via `CurrencyConverter` |
| `src/visualization/simulation/state-panel-view.js`, `timeline/timeline-controller.js`, `scenario-compare/scenario-compare-presenter.js`, `decision-graph/dg-results-panel.js`, plugins `journal-report` / `cross-action-query` | Pass the relevant `state` snapshot into `format()` (Phase 4) |
| `src/visualization/chart/*` | Per-point conversion using the `effectiveExchangeRates.<pair>` series; display-code axis label; re-convert on settings change (Phase 4) |
| `src/visualization/simulation/dash-cards-component.js`, `graph-builder/graph-node-exec-history.js` | Use display currency + converter instead of hardcoded `$` (Phase 4) |
| `src/scenarios/**` param schemas, `src/visualization/scenario/scenario-tab-view.js`, `scenario/param-csv.js` | Per-input `currency` field / `Money` type + selector; CSV currency column (Phase 5) |
| `src/visualization/accounts/`, `people/`, `assets/` editors | Currency selector defaulted by jurisdiction (Phase 5) |
| `src/finance/fx/fx-refresh-reducer.js` | Replace static mirror with rate-curve lookup (Phase 6, deferred) |

---

## Non-goals

- **No base currency for internal math.** Values stay native; conversion is display-only and never mutates `sim.state` or the journal.
- **No external/live FX rate feed.** Display conversion uses **only** the rates the simulation recorded into `state.effectiveExchangeRates` via the FX engine. There is no network rate API.
- No additional timezone options beyond `utc` / `local` at this stage.
- No third theme (e.g. high-contrast). Only `dark` and `light`.
- No following the OS `prefers-color-scheme` media query — default is `dark` unless the user has
  explicitly chosen otherwise. (Easy to add later if requested.)

---

## Acceptance Criteria

**Phase 1–2 (this work):**
- Changing the timezone select updates all date labels and the timeline **without** a scenario rebuild.
- Changing the display-currency select updates currency-formatted labels **without** a scenario rebuild.
- Changing the theme select swaps the entire UI from dark to light (or back) with no flash and no scenario rebuild; JS-drawn charts re-pick their colors.
- Reloading the page restores the last-chosen timezone, currency, and theme from `localStorage`, and there is no first-paint flash of the wrong theme.
- No component reads `$('tzSelect').value` / `$('displayCurrency').value` / `$('themeSelect').value` directly.
- No inline styles on the toolbar select elements.
- `TimeControls.displayCurrency` property and `setFormatDate()` method are removed; all callers use `AppDisplaySettings`.
- Existing tests (`npm test`, `npm run test:viz`) remain green.

**Phase 3 (native-code audit):**
- Every renderable money path resolves to a non-null `currencyCode`, OR is documented as intentionally code-less (rendered native, never converted).
- A dev-only warning fires when a conversion is requested for a code-less source.

**Phase 4 (display-currency conversion):**
- Selecting `AUD` (resp. `USD`) re-renders every money value across state-panel, timeline, charts, dashboard, and the report/compare plugins in the chosen currency **without a scenario re-run**.
- Conversion uses the run's recorded `effectiveExchangeRates` via `CurrencyConverter` — no hardcoded rate, no external feed.
- Chart series convert **per-point** at each point's historical rate; the axis label shows the display code.
- When no rate is available (FX toolset absent), values fall back to native with the correct native symbol — never a wrong symbol or a throw.

**Phase 5 (per-input currency):**
- Each money input shows a currency selector defaulted by jurisdiction (US → USD, AU → AUD) and overridable.
- The chosen native code is stamped into state and honoured by Phase 4 conversion with no extra wiring.
- Param CSV import/export round-trips the currency column.

**Phase 6 (time-varying rates — deferred):**
- `effectiveExchangeRates` varies over the run via a rate curve; chart and timeline conversions track it per-point/per-entry with no display-layer change.
