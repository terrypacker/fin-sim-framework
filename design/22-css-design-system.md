# 22 — CSS Design System Rework

Status: **proposal**
Owner: Terry Packer

## 1. Motivation

The current stylesheets ship a single "Amber Terminal" aesthetic by default. That look was a fun signal-of-personality, but for a financial-simulation IDE it works against us in three concrete ways:

1. **Amber is overloaded.** `--amber` is the primary accent (buttons, focus rings, tab actives, edge highlights, selected nodes, link-text) **and** is being used wherever a warning color would be more semantically correct. Anywhere you want to call attention to a number, an issue, or an action, it competes with the existing chrome.
2. **The "default" theme is the loudest theme.** Share Tech Mono + Barlow Condensed + amber glow + screen-door scanlines push the whole product toward cyberpunk-terminal. That's a strong opinion for an app whose primary value is reading tables of currency amounts.
3. **Token + component layering is muddled.** `themes/developer.css` defines *both* the theme tokens *and* a large chunk of component styles (header, panel, button, footer, scanlines). `fin-sim.css` redefines scrollbars at a smaller width than `base.css`. `workbench.css` invents its own `--wb-accent` (blue) divorced from `--accent-primary` (amber). The amber theme is "the theme" rather than "a theme."

This proposal ships **three explicit themes**, decouples the accent from the warning color, modernizes typography, codifies a small set of semantic colors for the simulator's domain language (Events / Actions / Handlers / Reducers), and reorganizes the CSS files so token definitions, base styles, and component styles live in clearly separated files.

---

## 2. Themes

We ship **three** themes. The user picks via the existing `<select id="themeSelect">` in the header; `AppDisplaySettings.setTheme()` already writes `document.documentElement.dataset.theme` and persists to `localStorage`. The selector grows from 2 options to 3.

| Theme | Selector | Default | Aesthetic |
|---|---|---|---|
| **FinSim Dark** | `data-theme="dark"` | ✅ | Indigo accent on slate; clean, neutral, IDE-flavored |
| **FinSim Light** | `data-theme="light"` |  | Indigo accent on slate-50; high contrast, print-friendly |
| **Amber Terminal** | `data-theme="amber"` |  | The current dark amber look, Share Tech Mono, scanlines |

`AppDisplaySettings`'s defaulting clause and the inline bootstrap script in `index.html` both extend to accept `'amber'` in addition to `'dark'` / `'light'`.

### 2.1 FinSim Dark (default)

```css
:root,
:root[data-theme="dark"] {
  /* Surfaces */
  --bg-base:      #0b1220;
  --bg-panel:     #111827;
  --bg-panel2:    #1f2937;
  --bg-panel3:    #273548;
  --bg-input:     var(--bg-panel2);
  --bg-deep:      #060910;   /* code editors */
  --bg-inset:     #0b1220;   /* viz/canvas */
  --bg-subtle:    var(--bg-panel);
  --bg-muted:     var(--bg-panel2);
  --bg-overlay:   rgba(0, 0, 0, 0.55);

  /* Borders */
  --border:       #334155;
  --border-hi:    #475569;
  --border-light: #1e293b;

  /* Text */
  --text-primary: #f1f5f9;
  --text-dim:     #94a3b8;
  --text-muted:   #64748b;

  /* Accent (primary action / focus / selection) */
  --accent-primary:    #6366f1;   /* indigo-500 */
  --accent-primary-bg: rgba(99, 102, 241, 0.14);

  /* Status palette */
  --blue:   #60a5fa;
  --green:  #34d399;
  --red:    #fb7185;
  --amber:  #f59e0b;    /* NOW means "warning", not accent */
  --purple: #a78bfa;
  --cyan:   #22d3ee;

  /* Diff */
  --diff-added:   var(--green);
  --diff-removed: var(--red);

  /* Row hover */
  --row-hover:    rgba(99, 102, 241, 0.05);
}
```

### 2.2 FinSim Light

```css
:root[data-theme="light"] {
  --bg-base:      #f8fafc;
  --bg-panel:     #ffffff;
  --bg-panel2:    #f1f5f9;
  --bg-panel3:    #e2e8f0;
  --bg-input:     #ffffff;
  --bg-deep:      #e2e8f0;
  --bg-inset:     #f1f5f9;
  --bg-subtle:    #f8fafc;
  --bg-muted:     #e2e8f0;
  --bg-overlay:   rgba(15, 23, 42, 0.40);

  --border:       #cbd5e1;
  --border-hi:    #94a3b8;
  --border-light: #e2e8f0;

  --text-primary: #0f172a;
  --text-dim:     #475569;
  --text-muted:   #64748b;

  --accent-primary:    #4f46e5;     /* indigo-600 — slightly darker for AA contrast on white */
  --accent-primary-bg: rgba(79, 70, 229, 0.08);

  --blue:   #2563eb;
  --green:  #16a34a;
  --red:    #dc2626;
  --amber:  #d97706;
  --purple: #7c3aed;
  --cyan:   #0891b2;

  --row-hover: rgba(79, 70, 229, 0.05);
}
```

### 2.3 Amber Terminal

The existing amber palette gets moved here verbatim, plus the scanlines + Share Tech Mono / Barlow are scoped to this theme rather than living on `:root`.

```css
:root[data-theme="amber"] {
  --bg-base:    #0a0c0f;
  --bg-panel:   #0f1217;
  --bg-panel2:  #141820;
  --bg-panel3:  #1f2630;
  --bg-input:   #1a1f2a;
  --bg-deep:    #060910;
  --bg-inset:   #080b10;
  --bg-overlay: rgba(0, 0, 0, 0.55);

  --border:     #222a38;
  --border-hi:  #2e3a50;
  --border-light: #111827;

  --text-primary: #d8dde8;
  --text-dim:     #8d98af;
  --text-muted:   #8690ab;

  --accent-primary:    #f0a500;        /* amber as primary, only here */
  --accent-primary-bg: rgba(240, 165, 0, 0.12);

  --blue:   #3b82f6;
  --green:  #39e080;
  --red:    #ff4455;
  --amber:  #f0a500;
  --purple: #a080ff;
  --cyan:   #00d4e8;

  /* Type system: terminal vibes */
  --font-head: 'Barlow Condensed', sans-serif;
  --font-body: 'Barlow', sans-serif;
  --font-mono: 'Share Tech Mono', monospace;
}

/* Scanlines only apply when this theme is active. */
:root[data-theme="amber"] .scanlines::after { /* existing rule */ }
```

> **`.scanlines` deprecation note.** Today `.scanlines::after` lives in `base.css` and is applied opt-in by adding the class. It is currently **unused** in any markup we ship — there is no `.scanlines` class on `<body>` or `#app`. We keep the rule, scope it to `data-theme="amber"`, and *opt-in* by adding `class="scanlines"` to `<body>` only when the amber theme is selected (via `AppDisplaySettings._applyThemeToDom()`). Default themes get no scanlines.

### 2.4 Token preservation / cleanups

Today's themes define `--amber`, `--amber-glow`, `--amber-dim`, `--green-glow`, `--cyan-glow`, etc. The `--amber-*` family is overloaded — sometimes "primary action," sometimes "warning/attention." This refactor splits the two meanings into separate token names and **renames the warning family from `--amber` to `--warning`** in a single pass, with no deprecation alias. Anything that genuinely meant "primary action" moves to `--accent-primary`; anything that meant "warning/attention" moves to `--warning`.

The `--green-*`, `--red-*`, `--cyan-*`, `--purple-*`, `--blue-*` families are unaffected.

Token rename:

| Old | New |
|---|---|
| `--amber` | `--warning` |
| `--amber-dim` | `--warning-dim` |
| `--amber-glow` | `--warning-bg` (rename for consistency with `--accent-primary-bg`) |

Per-call-site replacements:

| Old usage of `--amber*` | New token |
|---|---|
| Primary CTA, focus ring, active tab, selected node, edge highlight | `--accent-primary` / `--accent-primary-bg` |
| "Generation count" / pulse display in header | `--accent-primary` |
| `.tax-doc-net-amount`, "best" rank, "warning" — currently amber for *attention* | `--warning` / `--warning-bg` |
| `.tl-act-type`, `.tl-ev-type` (timeline event/action labels) | Semantic kind color (see §4) |

Because the old name `--accent-primary` already existed but aliased to `var(--amber)` in `developer.css`, **every CSS file that uses `var(--amber*)` for "primary action" switches to `var(--accent-primary*)`; everything else switches to `var(--warning*)`**. The sweep is mechanical (grep + diff per file) and is the single largest delta in this refactor.

---

## 3. Typography

Current stack:

| Var | Current | Used for |
|---|---|---|
| `--font-mono` | Share Tech Mono | almost everything labeled "code" or "mono", plus runtime stats, IDs, monetary values |
| `--font-head` | Barlow Condensed | `.app-title`, `.panel-title`, `.btn`, `.sim-status-row` |
| `--font-body` | Barlow | `body` |

Problems: Share Tech Mono is hard to read at small sizes for currency/numeric tables; Barlow Condensed gives every header an "engineering schematic" feel; the three-font sandwich (Share Tech / Barlow Condensed / Barlow) costs three Google Fonts loads and three rendering profiles.

### 3.1 Proposed type system

```css
:root,
:root[data-theme="dark"],
:root[data-theme="light"] {
  --font-head: 'Inter', system-ui, sans-serif;
  --font-body: 'Inter', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace;
}
```

(`'IBM Plex Sans'` is a viable alternative to Inter. Inter is recommended because it has tabular numerals and JetBrains Mono pairs well with it — both are designed for code/data UIs.)

The Amber theme keeps its existing stack (§2.3).

### 3.2 Where Share Tech Mono stays

A short allow-list, even on the default themes, where the terminal flavor reads as intentional rather than incidental:

| Surface | Why |
|---|---|
| Generation counter (`.sim-gen-display`) | A live tick — terminal vibe reads as "system state" |
| Node IDs (`.g-header-text`, ID columns in tables) | Distinct from user-facing labels |
| Code editor (`.code-editor`) | Code is code |
| Performance plugin readouts (`.perf-val`, `.perf-slow-dur`) | Live runtime stats |

To make that targeted, add a `--font-mono-terminal` token that defaults to `'Share Tech Mono'` (loaded for all themes), and have the four allow-list selectors reference it explicitly. Everything else uses `--font-mono` which is JetBrains Mono on Dark/Light, Share Tech Mono on Amber.

```css
:root {
  --font-mono-terminal: 'Share Tech Mono', monospace;
}

.sim-gen-display,
.g-header-text,
.code-editor,
.perf-val,
.perf-slow-dur {
  font-family: var(--font-mono-terminal);
}
```

### 3.3 Fonts loaded

Move the `@import` for fonts out of `themes/developer.css` (which is going away — see §6) and into a new `typography.css` that loads:

```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&family=Share+Tech+Mono&display=swap');
```

Drop the Barlow + Barlow Condensed loads. The amber theme still uses Barlow if selected, so we either (a) lazy-load Barlow only when amber is active (cleanest), or (b) keep them in the main import. Recommend (a) via a small CSS string injection in `_applyThemeToDom()`:

```js
if (theme === 'amber' && !this._barlowLoaded) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600&family=Barlow+Condensed:wght@600;700;800;900&display=swap';
  document.head.appendChild(link);
  this._barlowLoaded = true;
}
```

---

## 4. Semantic Kind Colors

The simulator already has a four-noun domain language: **Event**, **Action**, **Handler**, **Reducer**. There are currently *two* ad-hoc places that map these to colors, and they disagree:

| File | event | handler | action | reducer |
|---|---|---|---|---|
| `state-panel-view.js` line 817 | `#a78bfa` (purple) | `#6b7280` (gray) | `#60a5fa` (blue) | `#34d399` (green) |
| `graph-node-lineage.js` line 16 | `--blue-muted` | `--amber` | `--green` | `--purple` |

Two callers, two different mappings, both inline JS. We pick one and codify it as CSS tokens.

### 4.1 Canonical mapping

| Kind | Token | Hex |
|---|---|---|
| Event | `--kind-event` | `#3b82f6` blue |
| Action | `--kind-action` | `#8b5cf6` purple |
| Handler | `--kind-handler` | `#10b981` green |
| Reducer | `--kind-reducer` | `#f59e0b` amber (now repurposed as warning, but it's a fine reducer color too) |
| Error | `--kind-error` | `#ef4444` red |
| Optimization | `--kind-optimization` | `#06b6d4` cyan |

(In Amber Terminal these can keep stronger glows.)

### 4.2 Where they apply

1. **Graph nodes** — `g-node` border / header tint per kind.
2. **Badges** — replace the per-kind ad-hoc CSS (`.badge-green`, `.badge-purple`, etc., in `fin-sim.css`) with a single `.kind-badge` + `data-kind="event|action|handler|reducer"`.
3. **Execution traces** — `graph-node-lineage.js` reads tokens via `readThemeColor()` (already implemented for that file); `state-panel-view.js` switches from its hard-coded map to reading the same tokens.
4. **Timeline event/action type chips** — `.tl-ev-type` and `.tl-act-type` switch from hard-coded `--amber` / `--purple` to `--kind-event` / `--kind-action`.
5. **Logs / inspector type labels** — same.

The benefit isn't just visual consistency — users learn the **language of the application**. After ten minutes, "purple text in the timeline" reads as "that's an Action" without thinking.

---

## 5. Component-level changes

These are the small, concrete edits that come along with the token shifts.

### 5.1 Tabs

Today (`developer.css`):

```css
.tab-header:hover { background-color: var(--amber-dim); }
.tab .active     { background-color: var(--bg-active); }
```

Proposed:

```css
.tab-header:hover  { background: var(--bg-panel3); }
.tab-header.active { border-bottom: 2px solid var(--accent-primary); background: transparent; }
```

Same change in `.wb-tab` (workbench.css line 144): replace the `--wb-accent-bg` highlight with a 2px `--accent-primary` bottom border for the active tab, and `--bg-panel3` for hover.

### 5.2 Tables (journal-report, opt-table, acct-history, tax-doc-tbl, lsp-metric-row)

Today: ad-hoc per-plugin styling, mostly inheriting from the surrounding panel background with `--border-light` row separators.

Proposed shared rules in `components.css`:

```css
.tbl thead,
.tbl-th {
  background: var(--bg-panel2);
  font-weight: 600;
  color: var(--text-dim);
}
.tbl tbody tr:hover { background: var(--accent-primary-bg); }
```

Then journal-report's `.jr-th`, optimization's `.opt-table-th`, etc., either adopt the shared `.tbl` family or use their existing class names but pull from the same tokens. The visual change is small but pleasant — hovering a row now lightly tints with the accent rather than blending into nearby panel chrome.

### 5.3 Workbench palette

`workbench.css` line 12–14 today:

```css
--wb-accent:    #5aa2ff;
--wb-accent-bg: rgba(90, 162, 255, 0.14);
```

**Hard delete.** Remove the `--wb-accent` and `--wb-accent-bg` token definitions entirely, and rewrite every `var(--wb-accent)` / `var(--wb-accent-bg)` call site inside `workbench.css` to `var(--accent-primary)` / `var(--accent-primary-bg)`. No alias period. The workbench is internal-only, the references are confined to one file, and keeping a deprecated alias just preserves the two-source-of-truth problem we're fixing.

Net effect: tab actives, dock drag-over outlines, perf metric values, and event-row selection outlines all unify under `--accent-primary`. Single accent token everywhere.

### 5.4 Scanlines

Already covered in §2.3 — remove the global rule, scope to `data-theme="amber"`, and have the theme switcher add/remove the `.scanlines` class on `<body>` accordingly.

### 5.5 Hard-coded `'Courier New'` font

`modals.css` lines 51, 117, 206 use `font-family: 'Courier New', monospace;` directly. Replace with `var(--font-mono)`. Same for any other hard-coded font in plugin CSS.

### 5.6 Scrollbar consistency

`base.css` defines 5px scrollbars; `fin-sim.css` overrides to 3px at the bottom of the file. Pick one (5px, slimmer than browser default but visible) and remove the duplicate from `fin-sim.css`.

### 5.7 Configuration Graph theme reactivity (known bug)

**Problem.** Switching themes does not repaint the Configuration Graph. Existing nodes and edges stay whatever color they were originally rendered in until something else triggers a re-render (editing a node, scenario rebuild, panel resize). Every other surface in the app responds to a theme change immediately because their colors are CSS-driven; the graph is the one component that paints with JS-read color values.

**Why.** `EChartsGraphRenderer` (`src/visualization/components/echarts-graph-renderer.js`) caches theme tokens into `this._colors` inside `_renderGraph()` (line 294):

```js
_renderGraph() {
  this._colors = buildColors();   // reads --bg-panel2, --border-hi, --amber, etc. via readThemeColor()
  …
}
```

The renderer re-renders on `SERVICE_ACTION` and `SERVICE_BULK_ACTION` bus messages, but it does **not** subscribe to `AppDisplaySettings`, and a theme change publishes nothing on the sim bus — it just rewrites `document.documentElement.dataset.theme`. So `_colors` stays stale and the canvas keeps painting with the previous theme's values. The same trap applies to `state-panel-view.js`'s inline `kindColor` map and to `graph-node-lineage.js`'s `kindColor()` (which already calls `readThemeColor` per render — luckier accident, since it rebuilds each time `_renderTree()` runs after a node selection).

**Fix.** Two pieces:

1. **Subscribe to `displaySettings` in the graph renderer.** `EChartsGraphRenderer`'s constructor already receives a `bus`; thread `displaySettings` in the same way (via the plugin descriptor's runtime), and in `_mount()`:

   ```js
   if (this._displaySettings) {
     this.onCleanup(this._displaySettings.subscribe(({ theme }) => {
       if (theme === this._lastTheme) return;
       this._lastTheme = theme;
       this._colors = buildColors();   // re-read tokens
       this.render();                  // schedule a full re-render
     }));
   }
   ```

   `onCleanup` is the existing `BaseComponent` lifecycle hook; the subscription drops when the plugin tab is closed.

2. **Don't cache colors across renders.** As a defense-in-depth simplification, drop `this._colors` from constructor state and just call `const colors = buildColors()` at the top of `_renderGraph()` (it already does — the field is set there). The risk surface is the *other* code paths that read `this._colors` outside `_renderGraph()` (`_renderNodeBg`/edge styling helpers). Have them call `buildColors()` themselves or accept `colors` as a parameter. Cost is one extra `getComputedStyle` per render, which is negligible relative to ECharts' own work.

   The combination (subscribe-and-rerender + don't-cache) means even if a future caller forgets to invalidate the cache, the next render still paints with current tokens.

This fix is **in scope for Phase 3** (alongside the semantic kind-color migration), because Phase 3 is when `state-panel-view.js` and `graph-node-lineage.js` switch to the new `--kind-*` tokens — and at that point all three callers benefit from a consistent "tokens are read per-render, never cached across themes" rule.

**Sanity check after fix.** Open the Configuration Graph plugin, switch theme dark → light → amber → dark via the header dropdown, confirm node backgrounds, borders, edges, selected/highlight states, and breakpoint markers all repaint immediately on each switch.

---

## 6. File reorganization

### 6.1 Current state (3,548 LOC across 15 files)

```
assets/css/
├── base.css                          59   reset + scrollbars + .hidden/.mono
├── fin-sim.css                      273   app shell, header, badges, viz canvas, scrollbars (dup)
├── workbench.css                    542   wb-* shell + perf plugin styles
├── themes/developer.css             440   tokens (dark + light) + header + tabs + panel + btn + form
└── plugins/
    ├── chart.css                     20   failure banner only
    ├── config-builder.css           375
    ├── config-graph.css             156
    ├── dashboard.css                 36
    ├── inspector.css                 66
    ├── journal-report.css           290
    ├── modals.css                   300
    ├── monte-carlo.css              244
    ├── optimization.css             339
    ├── state-panel.css              166
    └── timeline.css                 242
```

Two structural issues:

1. **Tokens and components are mixed in `themes/developer.css`.** Header, tabs, panel, button, form-row, footer all live alongside the token definitions. Adding a new theme requires editing a file full of unrelated component styles.
2. **`fin-sim.css` is a grab bag** — app shell + header + badges + viz canvas + code editor + scrollbars. Several of those belong with components, several with the app shell.

### 6.2 Proposed layout

```
assets/css/
├── tokens.css              # NEW. THE three themes — variables only, no component rules.
├── base.css                # Reset, html/body, root utilities (.hidden, .mono, .scanlines)
├── typography.css          # NEW. Font @imports + base type rules. Loads Inter+JetBrainsMono+ShareTechMono.
├── components.css          # NEW. Panels, buttons, badges, form inputs, tabs, tables, status-dot.
├── app-shell.css           # RENAMED from fin-sim.css. Header, status bar, viz canvas, time controls only.
├── workbench.css           # Workbench dockable shell + perf plugin. --wb-accent deleted; uses --accent-primary directly.
└── plugins/
    ├── finance-cards.css   # MERGED. Failure banner (was chart.css) + dashboard cards (was dashboard.css). ~50 LOC total.
    ├── config-builder.css
    ├── config-graph.css
    ├── inspector.css
    ├── journal-report.css
    ├── modals.css
    ├── monte-carlo.css
    ├── optimization.css
    ├── state-panel.css
    └── timeline.css
```

### 6.3 Where current rules move

| Current file | Moves to |
|---|---|
| `themes/developer.css` `:root` variable blocks | `tokens.css` (split into dark / light / amber) |
| `themes/developer.css` `@import` fonts | `typography.css` |
| `themes/developer.css` `html, body` | `typography.css` |
| `themes/developer.css` `.tab*`, `.panel*`, `.btn*`, `.field-*`, `.status-dot`, `.divider`, `footer` | `components.css` |
| `themes/developer.css` `.scanlines::after` | `base.css` (scoped to `data-theme="amber"` inside `tokens.css`) |
| `fin-sim.css` `.badge-*` family | `components.css` (collapse into `.kind-badge[data-kind]`) |
| `fin-sim.css` `.scrollbar` rules | delete (duplicated in base.css) |
| `fin-sim.css` `.code-editor`, `.code-error`, `.field-code` | `components.css` |
| `fin-sim.css` everything else (header, status bar, viz canvas, time controls) | `app-shell.css` |
| `base.css` reset + scrollbar | stays |
| `base.css` `.hidden`, `.mono` | stays |
| `workbench.css` `--wb-*` block | **delete**; call sites rewritten to `var(--accent-primary)` / `var(--accent-primary-bg)` |
| `plugins/chart.css` + `plugins/dashboard.css` | **merged** into `plugins/finance-cards.css` |
| All `plugins/*.css` | stay; sweep for `--amber*` → `--accent-primary*` (active/primary) or `--warning*` (attention/best/highlight) per §2.4 |

### 6.4 `main.js` import order

The order matters for cascade — tokens before everything, base reset before components, components before plugins:

```js
import '../assets/css/tokens.css';
import '../assets/css/base.css';
import '../assets/css/typography.css';
import '../assets/css/components.css';
import '../assets/css/app-shell.css';
import '../assets/css/workbench.css';
import '../assets/css/plugins/config-builder.css';
import '../assets/css/plugins/config-graph.css';
import '../assets/css/plugins/timeline.css';
import '../assets/css/plugins/state-panel.css';
import '../assets/css/plugins/finance-cards.css';
import '../assets/css/plugins/inspector.css';
import '../assets/css/plugins/modals.css';
import '../assets/css/plugins/journal-report.css';
import '../assets/css/plugins/optimization.css';
import '../assets/css/plugins/monte-carlo.css';
```

`themes/developer.css`, `fin-sim.css`, `plugins/chart.css`, and `plugins/dashboard.css` get deleted. The `themes/` directory goes with them (no other contents). Net file count drops from 15 → 13, and the largest single file (`developer.css`, 440 LOC) splits into three smaller, single-responsibility files.

---

## 7. Migration plan

Four PR-sized phases. Each lands independently and the app is functional and visually coherent at every step.

### ✅ Phase 1 — Token reshuffle (no visual change)

Goal: separate tokens from components without changing what the app looks like.

1. Create `tokens.css` containing the current `:root[data-theme="dark"]` and `:root[data-theme="light"]` blocks **verbatim** from `themes/developer.css`. `--accent-primary` still aliases to `--amber`.
2. Strip those `:root` blocks out of `themes/developer.css`. Move the `@import` and `html, body` to a new `typography.css`. Move the remaining component rules (`.tab*`, `.panel*`, `.btn*`, `.field-*`, etc.) to a new `components.css`. Delete `themes/developer.css`.
3. Update `main.js` imports.
4. Visual diff against the live app: should be **identical** to today.

### ✅ Phase 2 — Amber Terminal becomes a theme

Goal: existing look is preserved as an opt-in theme, default themes start using indigo.

1. Add `:root[data-theme="amber"]` block in `tokens.css` carrying today's amber-glow / Share Tech Mono / Barlow values verbatim.
2. Switch the `:root,:root[data-theme="dark"]` block to the proposed indigo + slate values from §2.1.
3. Add the `'amber'` option to the `<select id="themeSelect">` in `index.html`.
4. Extend `AppDisplaySettings`'s theme validation to accept `'amber'`. Extend the inline bootstrap script in `index.html` the same way.
5. Implement the conditional Barlow font load (§3.3) and the conditional `.scanlines` body class (§2.3, §5.4).
6. **Rename `--amber*` → `--warning*` and split out `--accent-primary*` in one pass.** Per call site:
   - `var(--amber)` used for "primary action" → `var(--accent-primary)`. Examples: `.btn:hover`, `.btn-primary`, focus rings (`.field-group input:focus` etc.), tab actives, selected nodes (`g-node.selected`), edge highlights, reducer-chip "on" state, `--edge-color-highlight`.
   - `var(--amber)` used for "warning/attention/best" → `var(--warning)`. Examples: `tax-doc-net-amount`, "best rank" markers (`opt-table-td--rank-best`, `opt-badge-value--best-score`), `param-row--unlinked` label, MC `badge-value--warning`, `tl-taxdoc`.
   - `var(--amber-dim)` → `var(--warning-dim)` everywhere.
   - `var(--amber-glow)` → `var(--accent-primary-bg)` (primary-action hover backgrounds, e.g. `multi-select-item.selected`, `reducer-chip-on`) or `var(--warning-bg)` (attention/highlight backgrounds, e.g. `tl-act--bp` breakpoint flash).

   The split is decided per call site, not per token, because today's CSS conflates the two. No deprecation alias — the old `--amber*` token names are gone after this phase.

### ✅ Phase 3 — Typography + semantic kind colors

Goal: replace the hard-coded `kindColor` maps with tokens; switch default fonts.

1. In `tokens.css`, add `--kind-event` / `--kind-action` / `--kind-handler` / `--kind-reducer` / `--kind-error` / `--kind-optimization` to all three themes (per §4.1).
2. Update `state-panel-view.js` (line 817) and `graph-node-lineage.js` (line 16) to read from tokens via the existing `readThemeColor()` helper.
3. Add the `.kind-badge[data-kind]` family in `components.css`. Migrate timeline `.tl-ev-type` / `.tl-act-type`, the various per-plugin "type" labels.
4. Update `--font-head` / `--font-body` / `--font-mono` defaults to Inter / Inter / JetBrains Mono. Keep Amber Terminal's overrides.
5. Apply `--font-mono-terminal` to the gen counter / node IDs / code editor / perf readouts.

### Phase 4 — Component polish

1. Tabs: `--bg-panel3` hover + 2px `--accent-primary` bottom border on active. Apply to `.tab-header.active` and `.wb-tab.active`.
2. Tables: shared `tbody tr:hover { background: var(--accent-primary-bg); }` row hover; `thead { background: var(--bg-panel2); font-weight: 600; }`.
3. Workbench: **delete** `--wb-accent` / `--wb-accent-bg` from `workbench.css`; rewrite call sites to `var(--accent-primary)` / `var(--accent-primary-bg)`.
4. Modals: replace `'Courier New'` with `var(--font-mono)`.
5. Scrollbar: drop duplicate rules from `fin-sim.css` (already deleted at this point — verify there are no lingering scrollbar rules outside `base.css`).
6. **Merge `plugins/chart.css` and `plugins/dashboard.css`** into `plugins/finance-cards.css`; update `main.js` imports.

After Phase 4, run an eye-pass on every workbench tab in all three themes. Update the screenshots in `design/7-workbench-ui-plan.md` if any are still attached.

---

## 8. Risks & rollback

- **Color regressions.** The `--amber` → `--accent-primary` sweep is the riskiest single change. Mitigation: do Phase 2 in a branch and walk the workbench template-by-template (Default, Analysis, Debugging, Review) with both themes before merging. If anything still genuinely needs to be amber, leave it amber — `--amber` is still defined.
- **Inline styles in JS.** A handful of files (`graph-node-inspector-panel.js`, `graph-node-exec-history.js`, `graph-node-lineage.js`, `state-panel-view.js`) write inline color values via `style.cssText`. Phase 3 migrates the kind-color cases; the remaining inline styles (mostly layout-related — flex, padding, gap, height) are out of scope per the project's `feedback_inline_styles` rule about structural layout being OK inline only for runtime-computed values.
- **Light theme has never been used in anger.** Today's `:root[data-theme="light"]` exists in tokens but the app has not been pixel-audited under it. Phase 2 should include a sweep of the actual UI under light theme — likely a few opacity-based hover backgrounds and the failure-banner red glow will need tuning. We treat any light-theme bugs found during the sweep as in-scope for Phase 2.
- **Font CDN dependency.** Existing code already uses Google Fonts; we don't worsen the network surface (we trade Barlow + Barlow Condensed for Inter + JetBrains Mono, plus the existing Share Tech Mono). All loads gated to `display=swap` so we don't FOIT.
- **Rollback.** Each phase is a single PR. Reverting any phase restores the prior phase's visual baseline. Phase 1 is purely a file shuffle and is the safest checkpoint.

---

## 9. Decisions

1. **Font:** Inter (head/body) + JetBrains Mono (code) + Share Tech Mono (gated via `--font-mono-terminal` for gen counter / node IDs / code editor / perf readouts, and as the default mono for the Amber Terminal theme).
2. **Light-theme accent shade:** indigo-500 (`#6366f1`) on dark, indigo-600 (`#4f46e5`) on light. Per-theme shift accepted for AA contrast.
3. **`--wb-accent` / `--wb-accent-bg`:** hard delete. No alias.
4. **`--amber` → `--warning`:** rename in one pass, no deprecation alias. The split between primary-action and warning is decided per call site (see Phase 2, step 6).
5. **`chart.css` + `dashboard.css`:** merge into `plugins/finance-cards.css`.

---

## 10. Out of scope

- Animations and motion system.
- Iconography. We continue using the existing emoji / unicode icons in the chrome.
- Dark-mode auto-detection (`prefers-color-scheme`). The user already picks a theme manually and we persist it; auto-detect can be added later if desired.
- ECharts color overrides. The graph renderer reads its colors from `readThemeColor()` already; once tokens move, no ECharts code changes.
