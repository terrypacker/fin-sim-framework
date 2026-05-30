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
  #currency = 'USD';        // 'USD' | 'AUD' | 'native'  ('native' = Phase 4)
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

### Phase 3 — Currency rendering (StateSchemaRegistry) — `USD` / `AUD` only

`StateSchemaRegistry.format()` uses each field's registered currency code (`'USD'`, `'AUD'`)
but ignores the user's display-currency preference.

- Pass `displaySettings` into `StateSchemaRegistry` (or inject a `currencyFormatter` factory).
- When the display currency differs from a field's native currency, convert before formatting.
- `toDisplayCurrency()` should read from `displaySettings` instead of `timeControls`.

### Phase 4 — Native currency option (deferred)

Add `'native'` as a third value for `displayCurrency`. In Native mode, each value renders using
the field's own registered `vt.currencyCode` with no conversion. The toolbar `<select>` gets a
third option:

```html
<option value="USD"    selected>USD</option>
<option value="AUD">AUD</option>
<option value="native">Native</option>
```

**Why deferred:** every renderable currency field must have a code on its `ValueType` for Native
to display a symbol. The generic `*.balance` pattern is registered as `ValueType.currency()`
with no code; per-account fields get a code via `registerAccount(account)` which reads
`account.currency.code`. Before enabling Native, we need an audit pass:

- Confirm every account passes through `registerAccount()` (or its currency is otherwise registered).
- For any remaining symbol-less paths, either tighten the pattern registration or fall back to a
  documented behaviour (e.g. "no symbol shown, rendered as decimal").

When Phase 4 ships, `StateSchemaRegistry.format()` branches: `currency === 'native'` → use
`vt.currencyCode` directly (current behaviour); otherwise convert to `currency` first.

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
| `src/finance/services/state-schema-registry.js` | Accept display-currency for conversion (Phase 3); branch on `'native'` (Phase 4) |

---

## Non-goals

- No currency conversion rate lookup — rates remain simulation-provided.
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

**Phase 4 (deferred — Native currency):**
- A third option `Native` is selectable in the currency dropdown.
- Every renderable currency field formats with its registered code (no conversion).
- Audit confirms no fields render symbol-less in Native mode, OR the symbol-less paths are documented as expected.
