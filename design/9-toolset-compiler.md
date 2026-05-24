# 9 — Toolset Compiler MVP

## Overview

A **toolset** is a declarative domain-capability package. A **ScenarioCompiler** consumes
a scenario definition (people + accounts + toolset IDs) and produces a fully wired,
executable scenario by resolving toolset dependencies, collecting contributions, and
registering everything with the simulation services.

```
ScenarioDefinition (JSON)
        ↓
  ToolsetRegistry  ←  US_BANKING, US_TAX, US_RETIREMENT, AU_TAX, AU_SUPER
        ↓
  ScenarioCompiler
    ├─ resolveToolsets()       — topological dep sort
    ├─ resolveParameters()     — merge toolset defaults + JSON overrides → flat map
    ├─ buildContext()          — people, accounts, parameters, paramSchema, stateRegistry
    ├─ collectContributions()  — state patches, schedules, handlers, reducers
    └─ register()              — push all into simulation services
        ↓
  Executable Scenario
```

## Goals

1. **Declarative toolsets** — toolsets return contribution objects; the compiler does
   all service registration.
2. **Dependency resolution** — `US_RETIREMENT` automatically pulls in `US_TAX` and
   `US_BANKING`; order is guaranteed.
3. **Extensible** — new jurisdictions (AU, CA, UK) fit the same interface without
   touching existing toolsets.
4. **Migration path** — `IntlRetirementScenario` continues to work during transition;
   toolsets eventually replace it.

## Non-Goals (deferred)

- Full compiler pipeline with named phases (VALIDATION, OPTIMIZATION, …)
- Policy / Mechanics separation
- Conflict resolution / namespaces
- Capability-based dependency (`requiresCapability('taxation')`)

---

## JSON Scenario Definition

```json
{
  "toolsets": ["US_RETIREMENT"],
  "simStart": "2026-01-01",
  "simEnd": "2046-01-01",
  "parameters": {
    "inflationRate": 0.03,
    "usSavingsInterestRate": 0.035,
    "iraGrowthRate": 0.07,
    "monthlyExpenses": 6000,
    "inflationAdjust": true
  },
  "persons": [ ... ],
  "accounts": [ ... ]
}
```

`parameters` is a flat key-value map of overrides. Any key absent here falls back to
the `defaultValue` declared in the relevant toolset's `paramSchema()`. The full resolved
map is available to all toolsets via `context.parameters`.

**Breaking changes**:
- `"toolset": "us-retirement"` (singular string) → `"toolsets": [...]` (array)
- `"assumptions": { ... }` removed — values move into `"parameters": { ... }`
- `"expenses": { ... }` removed — `monthlyExpenses` and `inflationAdjust` move into
  `"parameters": { ... }` as typed entries in `US_RETIREMENT`'s `paramSchema()`

---

## Toolset API

```javascript
const MY_TOOLSET = {
  id: 'MY_TOOLSET',

  // Capabilities advertised (for future capability-based deps)
  capabilities: ['banking'],

  // Toolsets that must be resolved before this one
  dependencies: ['US_BANKING'],

  // Returns typed parameter schema entries (same shape as INTL_RETIREMENT_PARAM_SCHEMA)
  paramSchema(context) {
    return [
      { key: 'myRate', label: 'My Rate', type: 'Number', group: 'My Group',
        defaultValue: 0.05, mc: true, opt: true, description: '...' },
    ];
  },

  // Returns plain state key-value pairs to merge into sim.state
  state(context) {
    // Read resolved parameters — no hardcoded fallbacks needed here
    return { myStateKey: context.parameters.myRate };
  },

  // Returns EventSeries instances (created but NOT registered)
  schedules(context) {
    return [
      EventBuilder.eventSeries()
        .name('...').type('MY_EVENT')
        .interval('month-end').enabled(true).build()
    ];
  },

  // Returns handler instances with .handledEvents already set
  handlers(context) {
    // context.schedulesById available for event binding
    const evt = context.schedulesById['MY_EVENT'];
    const h = new MyHandler({
      stateRegistry: context.stateRegistry,
      rate: context.parameters.myRate,
    });
    h.handledEvents.push(evt);
    return [h];
  },

  // Returns reducer instances
  reducers(context) {
    return [new MyReducer()];
  },
};
```

### CompilationContext shape

```javascript
{
  startDate:      Date,
  endDate:        Date,
  people:         Person[],       // personService.getAll()
  accounts:       Account[],      // accountService.getAll()
  parameters:     Object,         // resolved flat map: toolset defaults + JSON overrides
  paramSchema:    Array,          // merged typed schema from all resolved toolsets
  stateRegistry:  StateRegistry,  // passed to handler constructors
  schedulesById:  Object,         // eventType → EventSeries, built up during collection
}
```

Toolsets do **not** receive `eventService`, `handlerService`, or `reducerService`.
Only the compiler touches those. Toolsets also do **not** receive the raw JSON
definition — all tweakable values are pre-resolved into `context.parameters`.

---

## ScenarioCompiler

```javascript
class ScenarioCompiler {
  constructor(registry) { this.registry = registry; }

  compile(definition, services) {
    const resolved   = this._resolveToolsets(definition.toolsets);
    const parameters = this._resolveParameters(definition, resolved);
    const paramSchema = resolved.flatMap(t => t.paramSchema?.({}) ?? []);
    const context    = this._buildContext(definition, services, parameters, paramSchema);

    const statePatches = {};
    const schedules    = [];
    const handlers     = [];
    const reducers     = [];

    for (const toolset of resolved) {
      Object.assign(statePatches, toolset.state?.(context) ?? {});

      const ts = toolset.schedules?.(context) ?? [];
      for (const s of ts) {
        schedules.push(s);
        context.schedulesById[s.type] = s;  // available to subsequent toolsets
      }

      for (const h of toolset.handlers?.(context) ?? []) {
        h._sourceToolset = toolset.id;
        handlers.push(h);
      }

      reducers.push(...(toolset.reducers?.(context) ?? []));
    }

    // Register everything
    const sim = services.simulationRegistry.getPrimary();
    Object.assign(sim.state, statePatches);
    for (const s of schedules) services.eventService.register(s);
    for (const h of handlers)  services.handlerService.register(h);
    for (const r of reducers)  services.reducerService.register(r);

    // Expose merged schema so the UI parameter panel can render it
    return { paramSchema };
  }

  _resolveParameters(definition, resolvedToolsets) {
    const defaults = {};
    for (const toolset of resolvedToolsets) {
      for (const entry of toolset.paramSchema?.({}) ?? []) {
        defaults[entry.key] = entry.defaultValue;
      }
    }
    return { ...defaults, ...(definition.parameters ?? {}) };
  }

  _buildContext(definition, services, parameters, paramSchema) {
    return {
      startDate:    new Date(definition.simStart),
      endDate:      new Date(definition.simEnd),
      people:       services.personService?.getAll()  ?? [],
      accounts:     services.accountService?.getAll() ?? [],
      parameters,
      paramSchema,
      stateRegistry: services.stateRegistry,
      schedulesById: {},
    };
  }

  _resolveToolsets(requestedIds) {
    const resolved = new Map();
    const visit = (id) => {
      if (resolved.has(id)) return;
      const toolset = this.registry.get(id);
      if (!toolset) throw new Error(`Unknown toolset: ${id}`);
      for (const dep of toolset.dependencies ?? []) visit(dep);
      resolved.set(id, toolset);
    };
    for (const id of requestedIds) visit(id);
    return [...resolved.values()];
  }
}
```

---

## ToolsetRegistry

Replaces `ScenarioToolsetRegistry`.

```javascript
class ToolsetRegistry {
  constructor() { this._map = new Map(); }
  register(toolset) { this._map.set(toolset.id, toolset); }
  get(id) {
    if (!this._map.has(id)) throw new Error(`ToolsetRegistry: '${id}' not registered`);
    return this._map.get(id);
  }
  has(id) { return this._map.has(id); }
}
```

---

## MVP Toolsets

### Dependency Graph

```
US_BANKING
    └── US_TAX
            └── US_RETIREMENT

AU_BANKING
    └── AU_TAX
            └── AU_SUPER
```

### US_BANKING
**Capabilities**: `banking`  
**Depends on**: —  
**Contributes**:
- `state`: savings interest rate
- `schedules`: `US_SAVINGS_INTEREST_MONTHLY` (month-end)
- `handlers`: `UsSavingsInterestMonthlyHandler` per US savings account
- `reducers`: `UsSavingsInterestCreditReducer`

### US_TAX
**Capabilities**: `taxation`  
**Depends on**: `US_BANKING`  
**Contributes**:
- `state`: `usOrdinaryIncomeYTD`, `usCapitalGainsYTD`, `usNegativeIncomeYTD`,
  `usPenaltyYTD`, `usFilingSingle`
- Delegates to `TaxService.setup()` + `TaxService.registerHandlersAndReducers()`  
  _(TaxService still imperative internally; wrapped in declarative shell)_
- `schedules`: `ANNUAL_TAX_EVENT` (year-end via PeriodService)

### US_RETIREMENT
**Capabilities**: `retirement`  
**Depends on**: `US_TAX`, `US_BANKING`  
**Contributes**:
- `schedules`: `MONTHLY_WAGES`, `MONTHLY_EXPENSES`, `MONTHLY_SS_INCOME`,
  `INTL_IRA_EARNINGS`, `INTL_ROTH_EARNINGS`, `INTL_K401_EARNINGS`,
  `INTL_STOCK_EARNINGS`, `DIVIDEND_SCHEDULED`, `INTL_FIXED_INCOME_INTEREST`
- `handlers`: `MonthlyWagesHandler`, `MonthlyExpensesHandler`,
  `MonthlySocialSecurityHandler`, earnings handlers per account role,
  `OutOfFundsHandler`
- `reducers`: `ExpenseDebitReducer`, `ReplenishSavingsReducer`,
  `StockDividendCashApplyReducer`, `SetOutOfFundsDateReducer`,
  `AccumulateDeficitReducer`, `OutOfFundsReducer`, `InflationAdjustReducer`
- `state`: `isAuResident: false`, `monthlyExpenses`, `inflationRates`,
  `inflationAccumulator`, `people`, `metrics`

### AU_TAX
**Capabilities**: `taxation`  
**Depends on**: `AU_BANKING`  
**Contributes**:
- `state`: `auPersonOrdinaryIncomeYTD`, `auCapitalGainsYTD`
- Wraps existing AU tax handlers from `TaxService`

### AU_BANKING
**Capabilities**: `banking`  
**Depends on**: —  
**Contributes**:
- `schedules`: AU savings interest (month-end)
- `handlers`: `AuSavingsInterestHandler` per AU savings account
- `reducers`: AU savings interest credit reducer

### AU_SUPER
**Capabilities**: `superannuation`  
**Depends on**: `AU_TAX`, `AU_BANKING`  
**Contributes**:
- Superannuation earnings, concessional contributions, preservation age logic

---

## File Structure

```
src/scenarios/toolsets/
  toolset-registry.js           ← new ToolsetRegistry class
  scenario-compiler.js          ← new ScenarioCompiler class
  us-banking-toolset.js         ← new
  us-tax-toolset.js             ← new
  us-retirement-toolset.js      ← refactored to declarative
  au-banking-toolset.js         ← new
  au-tax-toolset.js             ← new
  au-super-toolset.js           ← new

src/scenarios/
  scenario-toolset-registry.js  ← kept temporarily; deprecated comment added
```

---

## base-app.js Integration

```javascript
// Replace old ScenarioToolsetRegistry path:
} else if (activeConfig?.toolsets && Array.isArray(activeConfig.toolsets)) {
  const registry = new ToolsetRegistry();
  registry.register(USBankingToolset);
  registry.register(USTaxToolset);
  registry.register(USRetirementToolset);
  registry.register(AUBankingToolset);
  registry.register(AUTaxToolset);
  registry.register(AUSuperToolset);

  const compiler = new ScenarioCompiler(registry);
  compiler.compile(activeConfig, services);
}
```

---

## Implementation Phases

### Phase 1 — Infrastructure (no behavior change)
- [ ] `toolset-registry.js` — new `ToolsetRegistry`
- [ ] `scenario-compiler.js` — `ScenarioCompiler` with `_resolveToolsets` + `compile`
- [ ] Unit tests: dependency resolution order, duplicate-dep handling, unknown-ID error

### Phase 2 — US_BANKING + US_TAX toolsets
- [ ] Extract savings interest + US tax wiring out of `UsRetirementToolset` into
  `us-banking-toolset.js` and `us-tax-toolset.js`
- [ ] Both use declarative `state / schedules / handlers / reducers` shape
- [ ] Tests: existing US JSON scenario still produces same output

### Phase 3 — Refactor US_RETIREMENT
- [ ] `us-retirement-toolset.js` becomes declarative; depends on US_BANKING + US_TAX
- [ ] Old `UsRetirementToolset.setup()` deleted
- [ ] `ScenarioToolsetRegistry` deprecated
- [ ] `base-app.js` switches to `ScenarioCompiler` for `toolsets: [...]` path

### Phase 4 — AU toolsets
- [ ] `au-banking-toolset.js`, `au-tax-toolset.js`, `au-super-toolset.js`
- [ ] Tests: AU JSON scenario

### Phase 5 — Cross-border
- [ ] `US_AU_CROSS_BORDER` toolset depending on `US_TAX + AU_TAX`
- [ ] Residency transition handlers, treaty credits

---

## State Ownership Contract

The flat `sim.state` namespace is kept for the MVP. Formal namespacing
(`state.US_BANKING.*`) is deferred — it would require updating every existing handler
and reducer and is not warranted until an actual key collision occurs.

Instead, each toolset documents its state keys in three explicit buckets:

| Bucket | Meaning |
|--------|---------|
| **Initializes** | Keys this toolset creates in `state()` and primarily writes via its own handlers |
| **Reads** | Keys this toolset's handlers read but does not own (written by a dependency toolset) |
| **Shared** | Keys with no single owner; by convention initialized by the outermost toolset (`US_RETIREMENT`, `AU_SUPER`) |

### Naming conventions (collision avoidance)

- `us*` prefix for US-jurisdiction-specific keys (`usOrdinaryIncomeYTD`, `usFilingSingle`)
- `au*` prefix for AU-jurisdiction-specific keys (`auPersonOrdinaryIncomeYTD`)
- No prefix for genuinely shared keys (`people`, `monthlyExpenses`, `inflationRates`,
  `inflationAccumulator`, `metrics`)

### Per-toolset state contract

**US_BANKING** — Initializes: _(none beyond account state entries)_  
**US_TAX** — Initializes: `usOrdinaryIncomeYTD`, `usNegativeIncomeYTD`,
`usCapitalGainsYTD`, `usPenaltyYTD`, `usFilingSingle`  
**US_RETIREMENT** — Initializes: `people`, `monthlyExpenses`, `inflationRates`,
`inflationAccumulator`, `metrics`, `isAuResident`; Reads: all `us*` keys from `US_TAX`  
**AU_BANKING** — Initializes: _(none beyond account state entries)_  
**AU_TAX** — Initializes: `auPersonOrdinaryIncomeYTD`, `auCapitalGainsYTD`  
**AU_SUPER** — Initializes: shared AU fields; Reads: all `au*` keys from `AU_TAX`

---

## TaxService Integration

`TaxService` is internally imperative and calls services directly. It is **not**
refactored as part of this MVP. Instead, `US_TAX` (and `AU_TAX`) wrap it with a thin
shell: the toolset's `state/schedules/handlers/reducers` methods call the existing
`TaxService.setup()` and `TaxService.registerHandlersAndReducers()` internally, then
return the resulting objects to the compiler. TaxService refactoring is deferred.

---

## Conflict Detection

If two toolsets contribute the same event type, the compiler **warns but does not
fail**. Collisions are expected during the transition period (existing scenarios already
share event types across what will become separate toolsets) and are not inherently
wrong — two toolsets can legitimately handle the same event. A console warning surfaces
them for inspection without breaking the simulation.

```javascript
// In compiler, after collecting all schedules:
const seen = new Set();
for (const s of schedules) {
  if (seen.has(s.type)) {
    console.warn(`[ScenarioCompiler] duplicate event type '${s.type}'`);
  }
  seen.add(s.type);
}
```

---

## Possible Next Steps

These were explicitly deferred from the MVP and should be revisited when there is a
concrete need.

1. **Formal state namespacing** — introduce `state.US_BANKING.*`, `state.US_TAX.*`, etc.
   to enforce toolset state isolation and eliminate reliance on naming conventions.
   Requires updating all handlers and reducers that read the current flat namespace.

2. **TaxService refactor** — make `TaxService` fully declarative so it returns
   contribution objects rather than calling services directly. Currently wrapped with a
   thin shell in `US_TAX` / `AU_TAX`; a full refactor would remove the shell and bring
   tax logic into the same declarative model as the rest of the system.

3. **Two-pass `paramSchema` for dynamic defaults** — `paramSchema()` is currently called
   before people and accounts are loaded, so defaults must be static constants. If a
   toolset ever needs runtime data to compute a default (e.g. seeding a parameter from an
   account's opening balance), a second resolution pass after context is fully built will
   be needed.

4. Migration Notes (Future Work): `IntlRetirementScenario` (the hardcoded JS scenario) will eventually be replaced by a
JSON definition that uses `toolsets: ["US_RETIREMENT"]` or
`toolsets: ["US_RETIREMENT", "AU_SUPER"]` for the cross-border case. That migration is
tracked separately. Until then it remains the primary integration test harness.
