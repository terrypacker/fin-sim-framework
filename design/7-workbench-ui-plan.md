# Workbench UI Implementation Plan

## Status: PLANNING — 2026-05-17

---

## Current State Assessment

The production UI is a hardcoded, static 3-column layout defined in `index.html` (~988 lines) and wired in `BaseApp` (~750 lines). Characteristics:

- **Fixed DOM structure** — left-col / center-col / right-col with static tab groups using `data-tab-group` / `data-dest-tab` attributes
- **Hardcoded IDs** — ~30+ DOM IDs scattered throughout `BaseApp` (`$('chartCanvas')`, `$('timelineContainer')`, etc.)
- **Tab switching** — `openTab()` is a simple `display:none` show/hide; no docking, no drag-and-drop
- **Group selectors** — left and right columns use bespoke button-based "group selector" to swap between Simulation / Configuration / MC / OPT / GRAPH groups
- **~50 visualization files** — vanilla JS, MVC-ish triads (Controller / Presenter / View)
- **No persistent layout** — layout is entirely code-defined; user cannot rearrange panels

The V7 prototype (`design/ui-prototypes/sim-workbench-v7.html`) demonstrates the target architecture:
a plugin registry, Component base class with lifecycle methods, dockable tab groups, drag-and-drop tab migration, and localStorage-persisted layout.

---

## Target Architecture (from design/6-workbench-ui.md)

```
WorkbenchShell
├── TopBar          ← runtime controls, scenario selector, time/currency/tz
└── WorkspaceGrid
    ├── SplitPane (resizable gutter)
    │   ├── LeftPane   → TabGroup [ ScenarioPlugin, ConfigPlugin, ... ]
    │   ├── CenterPane → TabGroup [ TimelinePlugin, ChartPlugin, GraphPlugin, ... ]
    │   └── RightPane  → TabGroup [ InspectorPlugin, StatePanelPlugin, ... ]
    └── LayoutModel   → persisted to localStorage

PluginRegistry { id → { title, ComponentClass } }
WorkbenchRuntime { selection, simTime, execState, breakpoints }
WorkbenchBus { selection.changed, runtime.tick, breakpoint.hit, ... }
```

---

## Development Phases

### Phase 1 — Workbench Shell Infrastructure

> Goal: Build the new docking system as standalone, independently testable modules.
> No existing production code changes in this phase.
> Validated by: a demo HTML page wired to all Phase 1 modules.

#### P1-T1: WorkbenchComponent base class
- File: `src/visualization/workbench/component.js`
- API: `mount(container)`, `unmount()`, `rerender()`
- `mount()` calls `render()` → appends to container → calls `onMount()`
- `unmount()` calls `onUnmount()` → removes element
- `rerender()` unmounts then re-mounts in same container
- Subclasses override `render()` (returns DOM element), `onMount()`, `onUnmount()`

#### P1-T2: PluginRegistry
- File: `src/visualization/workbench/plugin-registry.js`
- `registerPlugin({ id, title, component })` — component is a WorkbenchComponent subclass
- `getPlugin(id)` → plugin descriptor
- `getAllPlugins()` → array of all registered descriptors
- Throws if duplicate `id` registered

#### P1-T3: WorkbenchLayoutModel
- File: `src/visualization/workbench/layout-model.js`
- Manages `{ left, center, right }` pane configurations
- Each pane: `{ tabs: string[], active: string }`
- `load(storageKey)` — restores from localStorage; falls back to default
- `save(storageKey)` — serializes to localStorage
- `reset()` — reverts to default layout
- `moveTab(tab, fromPane, toPane)` — mutates layout; caller re-renders
- `closeTab(pane, tab)` — removes tab; advances active

#### P1-T4: TabGroup renderer
- File: `src/visualization/workbench/tab-group.js`
- `class TabGroup` extends WorkbenchComponent
- Constructor: `{ pane, layout, registry, onLayoutChange }`
- `render()` — builds tab bar + view container; instantiates active plugin from registry
- Tab click → sets `layout[pane].active`, calls `onLayoutChange`
- Close button → `layout.closeTab(pane, tab)`, calls `onLayoutChange`
- Tracks mounted plugin instance; calls `unmount()` before switching

#### P1-T5: SplitPane renderer
- File: `src/visualization/workbench/split-pane.js`
- `class SplitPane` — not a WorkbenchComponent (renders directly to container)
- Horizontal split with 3 children and 2 resizable gutters
- Gutter drag: `mousedown` → track `mousemove` → update `flex` ratio on adjacent panes
- Sizes expressed as flex fractions; persisted in LayoutModel alongside tab config

#### P1-T6: Drag-and-drop tab migration
- Add to TabGroup: `draggable=true` on each tab element
- `ondragstart` — stores `{ tab: id, from: pane }` in `dataTransfer`
- `ondragover` / `ondragleave` — visual dragover highlight on target pane
- `ondrop` on pane root → calls `layout.moveTab(...)`, triggers `onLayoutChange`
- Ghost element follows cursor during drag (from V7 prototype)

#### P1-T7: WorkbenchRuntime + Bus
- File: `src/visualization/workbench/workbench-runtime.js`
- `WorkbenchRuntime` — global state singleton:
  - `selection: null | { type, id, data }`
  - `sim: { running, time }`
  - `breakpoints: Set`
- `WorkbenchBus` — thin event bus (may wrap existing EventBus)
  - Events: `selection.changed`, `runtime.tick`, `breakpoint.hit`, `scenario.ready`
- `play()`, `step()`, `reset()` — delegates to simulation adapter

#### P1-T8: WorkbenchShell (demo wiring)
- File: `src/visualization/workbench/workbench-shell.js`
- Assembles TopBar + SplitPane + 3 × TabGroup from LayoutModel + PluginRegistry
- `init(container)` — renders full shell into a given container
- Used by demo page to validate full Phase 1 system

---

### Phase 2 — Production Panel Migration

> Goal: Wrap each existing production panel as a WorkbenchComponent plugin.
> Update `BaseApp` + `index.html` to use the docking system.
> Existing behavior preserved exactly; just structure changes.

#### P2-T1: ScenarioPlugin
- File: `src/visualization/workbench/plugins/scenario-plugin.js`
- Wraps `ScenarioTabView` / `ScenarioTabPresenter` / `ScenarioTabController`
- Removes dependency on hardcoded `#scenarioSelect`, `#scenarioName`, etc.
- Panel renders its own scenario form into the provided container

#### P2-T2: TimelinePlugin
- File: `src/visualization/workbench/plugins/timeline-plugin.js`
- Wraps `TimelineView` / `TimelinePresenter` / `TimelineController`
- Removes dependency on `#timelineContainer`
- Subscribes to `selection.changed` bus event for highlight sync

#### P2-T3: ChartPlugin
- File: `src/visualization/workbench/plugins/chart-plugin.js`
- Wraps `ChartView` / `ChartPresenter` / `ChartController`
- Creates own `<canvas>` in container; handles resize via ResizeObserver
- Removes dependency on `#chartCanvas`, `#chartFilterContainer`, `#failureBanner`

#### P2-T4: ConfigGraphPlugin
- File: `src/visualization/workbench/plugins/config-graph-plugin.js`
- Wraps `ConfigGraphView` / `GraphBuilderPresenter`
- Creates own graph root in container; handles canvas resize
- Removes dependency on `#graphRoot`, `#graphNodes`, `#graphEdges`
- Emits `selection.changed` on node click

#### P2-T5: ConfigurationListPlugin
- File: `src/visualization/workbench/plugins/configuration-list-plugin.js`
- Wraps `ConfigurationListComponent` + node add/edit actions
- Removes dependency on `#configGroupNodes`

#### P2-T6: MonteCarloPlugin
- File: `src/visualization/workbench/plugins/monte-carlo-plugin.js`
- Wraps MC config + results panels (config on left, results on center/right)
- Consider splitting into `McConfigPlugin` and `McResultsPlugin` for separate pane placement

#### P2-T7: OptimizationPlugin
- File: `src/visualization/workbench/plugins/optimization-plugin.js`
- Same split pattern as Monte Carlo

#### P2-T8: InspectorPlugin
- File: `src/visualization/workbench/plugins/inspector-plugin.js`
- Wraps `GraphNodeInspectorPanel`
- Subscribes to `selection.changed` to auto-load selected node

#### P2-T9: ExecHistoryPlugin
- File: `src/visualization/workbench/plugins/exec-history-plugin.js`
- Wraps `GraphNodeExecHistory`
- Subscribes to `selection.changed`

#### P2-T10: LineagePlugin
- File: `src/visualization/workbench/plugins/lineage-plugin.js`
- Wraps `GraphNodeLineage`
- Subscribes to `selection.changed`

#### P2-T11: StatePanelPlugin
- File: `src/visualization/workbench/plugins/state-panel-plugin.js`
- Wraps `StatePanelView` (current state + cumulative metrics + action detail)
- Removes dependency on `#currentStateContent`, `#cumulativeMetricsContent`

#### P2-T12: DashboardPlugin
- File: `src/visualization/workbench/plugins/dashboard-plugin.js`
- Wraps `DashCardsComponent` (the LIVE DASHBOARD cards row)
- Subscribes to `runtime.tick` for live updates

#### P2-T13: BaseApp refactor
- Remove `openTab()` and `_initGroupSelector()` / `_initRightGroupSelector()` 
- Remove hardcoded DOM IDs from `initScenario()` / `initView()`
- Wire `WorkbenchShell.init()` and register all Phase 2 plugins
- Default layout definition preserves current panel placement

#### P2-T14: index.html simplification
- Remove all static tab group HTML for panels handled by plugins
- Keep only outer shell mounting point (`<div id="workbench-root">`)
- Templates that cannot be migrated yet (`tpl-*`) remain until Phase 2 complete

---

### Phase 3 — Detachable Windows

> Goal: Any panel tab can be popped out into a separate browser window.
> Panels in detached windows remain synchronized with main window.

#### P3-T1: Detach button on tab
- Add a detach icon (⤢) to each tab alongside the close button
- `detachTab(pane, tabId)` — opens a new window via `window.open()`
- New window loads a minimal shell (`workbench-panel.html`) with only the detached plugin

#### P3-T2: BroadcastChannel synchronization
- Main window and all detached windows share a `BroadcastChannel('workbench')`
- All `WorkbenchBus` events are mirrored through BroadcastChannel
- `selection.changed`, `runtime.tick`, `scenario.ready` all cross window boundaries
- Detached window panels update identically to main window panels

#### P3-T3: Reattach / close handling
- `window.close()` in detached panel triggers reattach of tab back to source pane
- Main window listens for `beforeunload` on detached windows via channel message

---

### Phase 4 — Performance & Replay Debugger

> Goal: Handle large journal entry counts and graph sizes without frame drops.
> Introduce a proper time-travel / breakpoint replay debugger.

#### P4-T1: Timeline virtualization
- Replace full render of journal rows with windowed rendering (visible rows only)
- Maintain a `virtualTop` offset; re-render on scroll
- Target: smooth scrolling at 10,000+ journal entries

#### P4-T2: Graph virtualization
- Render only nodes within the visible viewport
- Use spatial index (quadtree) for hit testing and edge clipping
- Target: smooth pan/zoom at 500+ nodes

#### P4-T3: Replay debugger integration
- Breakpoint hit → pause simulation; emit `breakpoint.hit` on WorkbenchBus
- Timeline panel highlights current execution point
- Graph panel highlights active node chain
- Step-through: advance one event/handler/action at a time
- State panel updates after each step
- "Causal trace" mode: highlight all ancestors of selected event in graph

#### P4-T4: Performance instrumentation panel
- New plugin: `PerfPlugin` — shows event loop timing, frame time histogram, heap usage
- Subscribes to `runtime.tick` for update cadence

---

### Phase 5 — Domain Plugin SDK

> Goal: Enable third-party or domain-specific plugins to register and render
> within the workbench without modifying core files.

#### P5-T1: Plugin SDK documentation + API contract
- Formal `WorkbenchPlugin` interface spec
- Published as `src/visualization/workbench/plugin-sdk.js`
- Includes: `id`, `title`, `category`, `component` (WorkbenchComponent subclass), optional `defaultPane`

#### P5-T2: Workspace templates
- Named presets stored in localStorage: `workbench-template-{name}`
- Template picker in top bar
- Built-in templates: Default, Analysis (MC-centric), Debugging (Graph-centric), Review (Timeline-centric)

#### P5-T3: Finance plugin package
- Relocate all finance-domain panels (`src/visualization/workbench/plugins/finance/`)
- `finance-plugin-package.js` — registers all finance plugins in one call
- Framework core (`WorkbenchShell`, `SplitPane`, `TabGroup`, `PluginRegistry`, `WorkbenchRuntime`) has zero finance imports

---

## Key Migration Constraints

1. **No behavior regression** — all existing simulation features must work throughout migration
2. **Incremental phases** — each phase is independently shippable; don't start Phase 2 until Phase 1 is validated
3. **Existing tests remain green** — backend simulation tests must not be affected
4. **No framework introduction** — vanilla JS continues; no React/Vue/Svelte
5. **Hardcoded DOM IDs must be removed** one plugin at a time; no big-bang rewrites

---

## Default Layout (Phase 2 target)

```
Left (260px)          Center (flex)         Right (320px)
─────────────────     ─────────────────     ─────────────────
[SC] [MC] [OPT]       [GR] [TL] [CT]        [ST] [AD]
[ND] [ED]             [MC] [OPT]             [IN] [EH] [LN]
```

Matches current production layout; user can rearrange after Phase 1.

---

## File Structure (new files)

```
src/visualization/workbench/
  component.js             ← P1-T1
  plugin-registry.js       ← P1-T2
  layout-model.js          ← P1-T3
  tab-group.js             ← P1-T4
  split-pane.js            ← P1-T5
  workbench-runtime.js     ← P1-T7
  workbench-shell.js       ← P1-T8
  plugins/
    scenario-plugin.js     ← P2-T1
    timeline-plugin.js     ← P2-T2
    chart-plugin.js        ← P2-T3
    config-graph-plugin.js ← P2-T4
    configuration-list-plugin.js ← P2-T5
    monte-carlo-plugin.js  ← P2-T6
    optimization-plugin.js ← P2-T7
    inspector-plugin.js    ← P2-T8
    exec-history-plugin.js ← P2-T9
    lineage-plugin.js      ← P2-T10
    state-panel-plugin.js  ← P2-T11
    dashboard-plugin.js    ← P2-T12
```

---

## Open Questions / Decisions Needed

1. **SplitPane sizing persistence** — store as flex fractions (0.0–1.0) or pixel widths?
   Flex fractions are viewport-relative; pixel widths survive resize better.

2. **Plugin mount timing** — should unmounted (background) plugins continue to receive bus events,
   or only active (mounted) plugins? Current prototype only mounts the active tab.
   Decision impacts live-update behavior of non-visible panels.

3. **MC / OPT config vs results split** — do MC Config and MC Results become separate plugins
   (allowing them to live in different panes), or stay as one plugin that renders both?
   Split is more flexible; combined is simpler to wire.

4. **NodeEditModal fate** — the modal is used for quick node editing from the graph and config list.
   Keep as modal overlay (not a plugin), or convert to a dockable inspector replacement?

5. **ResizeObserver for canvas panels** — ChartPlugin and GraphPlugin need to know their container
   size. ResizeObserver is cleaner than the current `window.resize` listener on `BaseApp`.

6. **WorkbenchBus vs existing EventBus** — should WorkbenchBus wrap the existing `event-bus.js`
   (which is simulation-domain), or be a completely separate UI-layer bus?
   Recommendation: separate bus; UI events and sim events should not share the same channel.

## Answers to: Open Questions / Decisions Needed
1. Store as flex
2. Hard to say but I think you want them on the bus at all times, until this become a performance issue I think we don't want to worry about being 'out of state' while in the background
3. Split, they are separate concepts and I can see them used independently
4. I think we want to keep it as an option to use, however I imagine we will also have a plugin that is used for some situations.  So I guess make the modal a plugin too as well as a plugin panel similar to how it the editors exist now, in 2 places.
5. Yes use a ResizeObserver
6. Sure, use a separate bus instance but I'd like to think you can use the same class so we can leverage improvements on it for both purposes...
