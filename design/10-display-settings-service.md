# Design: AppDisplaySettings Service — Unified Timezone & Currency

## Problem

The timezone (`tzSelect`) and display-currency (`displayCurrency`) selects in the top bar have
no coherent API. Their values are scattered across the DOM, `TimeControls`, and `BaseApp`, and
subscribing to changes requires a full `destroyScenario() + initScenario()` rebuild — even though
neither setting affects simulation logic, only rendering.

### Current pain points

| Issue | Detail |
|---|---|
| Unnecessary rebuilds | Both `tzSelect` and `displayCurrency` change handlers call `destroyScenario()` + `initScenario()` — TODO comments acknowledge this is wrong |
| No subscriber model | Components that need `formatDate` (`DashCardsComponent`, `PlaybackProgressComponent`) receive it only at construction and have no mechanism to update without a rebuild |
| Duplicated handler code | `base-app.js` and `workbench-app.js` each duplicate the change-listener logic |
| Inline styles on selects | `index.html:67-74` sets styles inline on the `<select>` elements, violating the CSS-class convention |
| Inconsistent formatter use | `simulation-animator.js:151` inlines its own `(d) => statePanelView.fmtVal(d)` instead of the injected formatter; `base-app.js:810` calls `fmtUTC` directly |
| Currency lookup is indirect | `toDisplayCurrency()` reads `this.timeControls?.displayCurrency` — the currency lives inside `TimeControls`, a UI component, rather than a settings service |

---

## Proposed Solution: `AppDisplaySettings`

Introduce a single, app-lifetime service that is the **sole source of truth** for timezone and
display-currency. Components subscribe to it; the service notifies them when either value changes
so they can re-render in place, without any scenario teardown.

### New file: `src/visualization/app-display-settings.js`

```js
export class AppDisplaySettings {
  #timezone = 'utc';        // 'utc' | 'local'
  #currency = 'USD';        // 'USD' | 'AUD' | …
  #subscribers = new Set();

  get timezone()        { return this.#timezone; }
  get displayCurrency() { return this.#currency; }

  get formatDate() {
    return this.#timezone === 'utc' ? fmtUTC : fmtLocal;
  }

  setTimezone(tz) {
    if (this.#timezone === tz) return;
    this.#timezone = tz;
    this._notify();
  }

  setCurrency(code) {
    if (this.#currency === code) return;
    this.#currency = code;
    this._notify();
  }

  /** Returns an unsubscribe function. */
  subscribe(fn) {
    this.#subscribers.add(fn);
    return () => this.#subscribers.delete(fn);
  }

  _notify() {
    const snapshot = { timezone: this.#timezone, currency: this.#currency, formatDate: this.formatDate };
    for (const fn of this.#subscribers) fn(snapshot);
  }
}
```

---

## Integration Plan

### Phase 1 — Create and wire the service (no behaviour change)

1. Add `src/visualization/app-display-settings.js` with the class above.
2. Instantiate once in `BaseApp` (and `WorkbenchApp`) as `this.displaySettings = new AppDisplaySettings()`.
3. Wire the DOM selects to call `displaySettings.setTimezone()` / `displaySettings.setCurrency()` — **remove `destroyScenario` + `initScenario` calls** from both handlers.
4. Remove inline `style` attributes from the two `<select>` elements in `index.html`; add equivalent rules to the top-bar CSS (class `.toolbar-select` or similar).
5. Remove duplicate handler code in `workbench-app.js`.

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

Each component should call `displaySettings.subscribe(…)` in its constructor and register the
returned unsubscribe function with its existing `onCleanup()` / `destroy()` lifecycle hook.

### Phase 3 — Currency rendering (StateSchemaRegistry)

`StateSchemaRegistry.format()` uses hardcoded currency codes (`'USD'`, `'AUD'`) for
display-formatted values but ignores the user's display-currency preference.

- Pass `displaySettings` into `StateSchemaRegistry` (or inject a `currencyFormatter` factory).
- When the display currency differs from a field's native currency, convert before formatting.
- `BaseApp.toDisplayCurrency()` should read from `displaySettings` instead of `timeControls`.

---

## Files Affected

| File | Change |
|---|---|
| `src/visualization/app-display-settings.js` | **New** — the service |
| `index.html` | Remove inline styles from `#tzSelect` / `#displayCurrency`; add CSS class |
| `src/apps/base-app.js` | Instantiate service; wire selects; remove scenario rebuild; remove `toDisplayCurrency` coupling to `timeControls` |
| `src/apps/workbench-app.js` | Remove duplicated change-listener; delegate to service |
| `src/visualization/time-controls.js` | Subscribe; remove `setFormatDate` setter; remove `displayCurrency` property |
| `src/visualization/simulation/state-panel-view.js` | Subscribe instead of `set formatDate` setter |
| `src/visualization/simulation/playback-progress-component.js` | Subscribe |
| `src/visualization/simulation/dash-cards-component.js` | Subscribe |
| `src/visualization/simulation/simulation-animator.js` | Subscribe; drop inline formatter |
| `src/visualization/timeline/timeline-presenter.js` | Subscribe |
| `src/visualization/graph-builder/graph-node-exec-history.js` | Subscribe for currency symbol |
| `src/finance/services/state-schema-registry.js` | Accept display-currency for conversion (Phase 3) |

---

## Non-goals

- No currency conversion rate lookup — rates remain simulation-provided.
- No persistence across page reloads (could be a separate enhancement via `localStorage`).
- No additional timezone options beyond `utc` / `local` at this stage.

---

## Acceptance Criteria

- Changing the timezone select updates all date labels and the timeline **without** a scenario rebuild.
- Changing the display-currency select updates currency-formatted labels **without** a scenario rebuild.
- No component reads `$('tzSelect').value` or `$('displayCurrency').value` directly.
- No inline styles on the toolbar select elements.
- `TimeControls.displayCurrency` property and `setFormatDate()` method are removed; all callers use `AppDisplaySettings`.
- Existing tests (`npm test`) remain green.
