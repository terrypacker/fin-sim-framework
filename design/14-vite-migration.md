# Design: Vite Migration

## Current State

| Aspect | Now |
|---|---|
| Build | Rollup producing ESM + CJS + UMD into `dist/` |
| Dev server | `rollup-plugin-dev` + `rollup-plugin-livereload` (no HMR) |
| App entry | `index.html` loads `dist/index.umd.min.js` as a pre-built UMD global, inline `<script type="module">` initialises the app |
| Minification | Disabled — `constructor.name` used as the canonical type identifier in `Action`, `Reducer`, `HandlerEntry`, and `BaseEvent` |
| Assets | Copied from `assets/` into `dist/assets/` by `rollup-plugin-copy` |
| GitHub Pages | `npm run build` → `dist/` → `actions/upload-pages-artifact` |

---

## Goals

1. **Dev workflow** — fast HMR, proper source maps, no manual rebuild cycle.
2. **Library packaging** — one or more publishable packages; build tooling in place even if the monorepo split happens later.
3. **Minification** — unblock it by removing the `constructor.name` dependency.
4. **GitHub Pages** — keep the existing deploy workflow working.
5. **ESM-only** — drop CJS and UMD.
6. **Repo restructure** — optional, but design should accommodate it.

---

## Minification Blocker: `constructor.name`

Four base classes use `this.constructor.name` as the serialized type identifier:

| Getter | Class | File |
|---|---|---|
| `actionClass` | `Action` | `simulation-framework/actions.js` |
| `reducerType` | `Reducer` | `simulation-framework/reducers.js` |
| `handlerClass` | `HandlerEntry` | `simulation-framework/handlers.js` |
| `eventType` | `BaseEvent` | `simulation-framework/events/base-event.js` |

Minification mangles class names, breaking serialization (`ScenarioSerializer`) and type dispatch (`ConfigBuilder`).

**Fix:** Replace the dynamic `constructor.name` getter with a static class field. Each concrete subclass declares its own stable string identity, independent of the minified class name.

```js
// Before — breaks under minification
class WagesIncomeApplyReducer extends Reducer {
  // inherits: get reducerType() { return this.constructor.name; }
}

// After — minification-safe
class WagesIncomeApplyReducer extends Reducer {
  static reducerType = 'WagesIncomeApplyReducer';
  get reducerType() { return this.constructor.reducerType; }
}
```

The four base getters become:
```js
get actionClass()  { return this.constructor.actionClass  ?? this.constructor.name; }
get reducerType()  { return this.constructor.reducerType  ?? this.constructor.name; }
get handlerClass() { return this.constructor.handlerClass ?? this.constructor.name; }
get eventType()    { return this.constructor.eventType    ?? this.constructor.name; }
```

The `?? this.constructor.name` fallback means the change is opt-in — subclasses that haven't added the static field continue to work as before. Minification can be enabled once all subclasses are converted. This can be done incrementally as part of the Vite migration or as a separate PR.

---

## Phase 1: Single-Package Vite (do now)

Replace Rollup with Vite while keeping the existing single-package structure. This is the smallest viable change and delivers the dev-workflow improvement immediately.

### New files

```
vite.config.js        ← app dev server + app build
vite.lib.config.js    ← library build (ESM only)
src/main.js           ← new app entry point (replaces inline <script> in index.html)
```

### `vite.config.js` (app mode)

```js
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  root: '.',
  base: './',                    // relative paths → works on GitHub Pages subpaths
  publicDir: 'assets',           // static files served as-is in dev; copied to dist/
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 10001,
    open: true,
  },
}));
```

### `vite.lib.config.js` (library build)

```js
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: 'dist-lib',
    lib: {
      entry: resolve(__dirname, 'src/index.js'),
      name: 'FinSimLib',
      formats: ['es'],              // ESM only
      fileName: () => 'index.esm.js',
    },
    rollupOptions: {
      external: ['echarts'],
    },
  },
});
```

### CSS loading

Vite's standard pattern is to import CSS from the JS entry point rather than via `<link>` tags. Vite bundles all imported CSS into an optimized `dist/assets/index-[hash].css` and injects it automatically — no manual `<link>` management in `index.html`.

`src/main.js` becomes:

```js
// CSS — Vite bundles and injects these
import '../assets/css/base.css';
import '../assets/css/themes/developer.css';
import '../assets/css/fin-sim.css';
import '../assets/css/workbench.css';
import '../assets/css/plugins/config-builder.css';
import '../assets/css/plugins/config-graph.css';
import '../assets/css/plugins/timeline.css';
import '../assets/css/plugins/state-panel.css';
import '../assets/css/plugins/dashboard.css';
import '../assets/css/plugins/chart.css';
import '../assets/css/plugins/inspector.css';
import '../assets/css/plugins/modals.css';

import { WorkbenchApp } from './apps/workbench-app.js';

const app = new WorkbenchApp();
app.init();
```

In Phase 2, each package imports only the CSS it owns — the app just imports the entry points.

### `index.html` — before/after

The eight `<link rel="stylesheet">` tags are removed (Vite injects the bundled CSS automatically). Favicon `<link>` tags stay but their paths shift: because `publicDir: 'assets'`, Vite serves `assets/img/` at `/img/` — not `/assets/img/`.

```html
<!-- Before -->
<link rel="stylesheet" href="assets/css/base.css">
<!-- ... 7 more CSS links ... -->
<link rel="icon" type="image/x-icon" href="assets/img/favicon.ico">
<link rel="icon" type="image/png" sizes="16x16" href="assets/img/favicon-16x16.png">
<link rel="icon" type="image/png" sizes="32x32" href="assets/img/favicon-32x32.png">
<link rel="apple-touch-icon" sizes="180x180" href="assets/img/apple-touch-icon.png">
<script type="module" src="./index.umd.min.js"></script>
<script type="module">/* inline bootstrap */</script>

<!-- After -->
<link rel="icon" type="image/x-icon" href="/img/favicon.ico">
<link rel="icon" type="image/png" sizes="16x16" href="/img/favicon-16x16.png">
<link rel="icon" type="image/png" sizes="32x32" href="/img/favicon-32x32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/img/apple-touch-icon.png">
<script type="module" src="/src/main.js"></script>
```

In dev, Vite serves `src/main.js` directly with HMR. In production, `vite build` bundles everything from `src/main.js` into `dist/`.

### Updated `package.json` scripts

```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "build:lib": "vite build --config vite.lib.config.js",
    "build:all": "npm run build && npm run build:lib",
    "preview": "vite preview",
    "clean": "rm -rf dist dist-lib"
  },
  "devDependencies": {
    "vite": "^6.x"
  }
}
```

Rollup and all rollup plugins can be removed from `devDependencies`.

### GitHub Pages — `deploy.yml` change

```yaml
- name: Install and Build
  run: |
    npm ci
    npm run build          # vite build → dist/
```

No other changes needed — the workflow already deploys `./dist`.

### What stays the same

- All `src/` source files — zero changes required.
- `assets/css/` — files stay in place; paths don't change; only the `<link>` tags in `index.html` are replaced by imports in `main.js`.
- `assets/img/`, `assets/schema/`, `assets/help/` — served verbatim via `publicDir`; no changes to the files themselves.
- `tests/` — Jest config untouched.
- `scripts/` — unchanged.
- `CNAME` — stays in `assets/` (Vite copies `publicDir` contents to `dist/`).

---

## Phase 2: Monorepo Split (later)

Split into npm workspaces. Each workspace has its own `package.json` and `vite.config.js`.

### Proposed structure

```
packages/
  simulation-framework/          @terrypacker/simulation-framework
    src/                         ← moved from src/simulation-framework/
    package.json
    vite.config.js               (lib build)

  financial-simulation/          @terrypacker/financial-simulation
    src/                         ← moved from src/finance/, src/services/,
    package.json                    src/query/, src/storage/, src/scenarios/
    vite.config.js               (lib build)

  workbench/                     @terrypacker/workbench
    src/                         ← moved from src/apps/, src/visualization/,
    package.json                    src/graph/
    vite.config.js               (lib build)

apps/
  simulation-workbench/          (the deployable app)
    index.html
    src/main.js                  ← imports from @terrypacker/workbench
    assets/
    vite.config.js               (app build)
    package.json

package.json                     (root — workspaces config)
jest.config.cjs                  (root — runs tests across all packages)
```

### Root `package.json`

```json
{
  "name": "fin-sim-framework",
  "private": true,
  "workspaces": [
    "packages/*",
    "apps/*"
  ],
  "scripts": {
    "dev": "npm run dev --workspace=apps/simulation-workbench",
    "build": "npm run build --workspaces",
    "test": "..."
  }
}
```

### Build order dependency

`financial-simulation` depends on `simulation-framework`; `workbench` depends on both. Use Vite's `build.watch` or a script (`scripts/build-all.js`) to build in topological order. A future step could use Turborepo or `nx` if build-time dependency tracking becomes painful.

### Recommendation

Do Phase 2 only after Phase 1 is stable. The Phase 1 structure (single package, Vite) does not block Phase 2 — the monorepo split is purely a file-move + `package.json` restructure on top of the Vite foundation.

---

## Minification Plan

Enabling minification requires all four type-dispatch getters to use static fields (see above). There are ~100 concrete subclasses across `src/finance/account-rules/`, `src/finance/handlers/`, and `src/simulation-framework/`.

Two options:

**A. Codemod (recommended):** A short Node script using `@babel/parser` + `@babel/generator` walks every subclass of `Action`, `Reducer`, `HandlerEntry`, and `BaseEvent` and inserts `static X = 'ClassName'`. Run once, commit, done. The existing `scripts/build-index.js` shows the team is comfortable with AST-based scripts.

**B. Esbuild keepNames (temporary workaround):** In `vite.config.js`:
```js
optimizeDeps: { esbuildOptions: { keepNames: true } },
build: { minify: 'esbuild' },
esbuild: { keepNames: true },
```
This is a flag rather than a fix — it prevents minification of class names project-wide, which defeats part of the minification benefit. Acceptable as a bridge while the codemod runs.

---

## Decision Summary

| Question | Recommendation |
|---|---|
| Rollup or Vite? | Vite |
| Do it now or later? | Phase 1 (single package) now |
| Monorepo split now? | No — design for it, do it later |
| ESM-only? | Yes — drop CJS and UMD |
| Minification now? | Add `keepNames` as bridge; codemod static fields in a follow-up PR |
| GitHub Pages? | No workflow changes except `npm run build` command stays the same |
| assets/js/ legacy files? | Delete them — README already marks them as legacy |
