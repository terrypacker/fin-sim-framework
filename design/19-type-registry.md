# 19 — TypeRegistry, Action-Type Families, and the Per-Country Tax Split

**Status**: Phase 0 + 1 + 2 + 3 + 4 complete (2026-06-01); Phase 5 next
**Resolves**: `inconsistencies.md` §3.1 (`simulation.js` reaches into finance fields), §3.2 (`StateSchemaRegistry.pickActionData` lives in the wrong layer — partial), §3.6 (handler/reducer string sets in the serializer), §4.6 (`_pickActionData` allow-list is a maintenance burden)
**Related**: `design/9-toolset-compiler.md` (toolset shape this design extends), `design/15-config-as-source-of-truth.md` (the cfg → services contract), `design/17-scenario-as-graph-node.md` (ServiceRegistry layered reset model)
**Author note**: Introduces a framework-level `TypeRegistry` that lets toolsets declare every class, action type, and field-schema they own in inert metadata. Removes three categories of hand-maintained string lists, deletes ~1,100 lines from `scenario-serializer.js`, and ends the implicit "first-toolset-wins" coupling between `US_TAX` and `AU_TAX`. Bakes in a small rename of framework-internal fields on `Action` so `_*` actually means "framework-internal" everywhere.

---

## 1. Problem

Three nominally separate inconsistencies all stem from the same missing primitive — the framework has no name for "an action / handler / reducer class plus all the metadata downstream code wants to look up about it."

**§3.1 — `simulation.js` knows finance fields.** `_pickActionData()` in `src/simulation-framework/simulation.js:45–61` enumerates 12 finance-specific action fields (`tax`, `taxDetail`, `personTaxDetails`, `gain`, `proceeds`, `costBasis`, `cc`, `isLongTerm`, `isAuResident`, …). The framework is supposed to be domain-agnostic.

**§3.6 — Serializer maintains 70-name string sets.** `src/scenarios/scenario-serializer.js:223–316` defines `_ACCOUNT_SERVICE_REDUCERS` and `_NO_ARG_HANDLERS` by hand; the file is 1,251 lines of dispatch over 50-odd action / handler / reducer subclasses. Adding a new account-module class silently fails to deserialize unless the author remembers to add its name to the right set.

**§4.6 — Picker allow-list drifts.** Every new action field the timeline wants must be added to `_pickActionData`. Worse, the same problem recurs in `JournalReportPlugin` (line 565), `report-definition-registry.js` (`WITHDRAWAL_ACTION_TYPES` at line 245, `REAL_PROPERTY_ACTION_TYPES` at line 413, inline cc lists at line 187) — each is a separately-maintained allow-list that silently drops new entries.

**Plus an implicit coupling bug.** `AU_TAX` and `US_TAX` both call `TaxService().getSharedReducers()` (`tax-service.js:174–188`) which returns a single `TaxPaymentDebitReducer` instance. A context-level cache makes "first toolset to run wins" — neither toolset declares a dependency on the other, but they silently share state through the cache. This is downstream of the same root cause: `TAX_PAYMENT_DEBIT` is a single action type that carries `cc` as a field, so one reducer handles both countries by branching on `action.cc`.

### Why one design

All four problems collapse if we:

1. Give each handler / reducer / action subclass a `static type` + `static fromJSON` + `toJSON` so the class is its own (de)serialization contract.
2. Give each *action-type discriminator* (the string, not the class) a typed `fields` declaration that the picker, journal report, CSV layer, and chart layer all consult.
3. Route both through a single `TypeRegistry` owned by `ServiceRegistry`.
4. Populate the registry from inert `types: {...}` metadata on each toolset — so toolsets remain the single point of ownership.
5. Promote `cc` from a field to a type discriminator on the tax actions (`TAX_PAYMENT_DEBIT` → `US_TAX_PAYMENT_DEBIT` / `AU_TAX_PAYMENT_DEBIT`), then recover cross-country queries with a `family` tag on the registry entry.

---

## 2. Goals & Non-Goals

### Goals

- Delete the 70-name string sets and ~1,100 lines of switch dispatch in `scenario-serializer.js`. Adding a new class becomes "register it in your toolset's `types` block."
- Delete `_pickActionData()` from `simulation.js` and `StateSchemaRegistry.pickActionData()` from finance. Replace with `services.typeRegistry.pickPayload(action)` consulting per-type declarations.
- Make `_*` prefix mean "framework-internal" on `Action` consistently, so the picker's fallback rule (`include everything except framework-internal`) is real and small.
- Split `TAX_PAYMENT_DEBIT` / `TAX_SETTLE_APPLY` / `PERIOD_ADVANCE` into per-country variants. Delete `getSharedReducers()` and its context cache. AU_TAX no longer depends implicitly on US_TAX running first.
- Replace three hand-maintained literal action-type lists in `report-definition-registry.js` with `api.familyTypes(family, { cc })` calls that read from the registry.
- Make `TypeRegistry` instance-scoped on `ServiceRegistry` so the future multi-`ServiceRegistry` world (MC parallelism, branching) gets isolation for free.

### Non-Goals

- **§4.1 (ServiceRegistry singleton).** This design positions `TypeRegistry` to fit the per-instance world but does not unwind the singleton itself. `ServiceRegistry.getInstance().typeRegistry` keeps working today.
- **§1.4 (params vs parameters vs paramSchema).** Owned by design 13. The new `types` block on toolsets is additive to the existing schema; nothing in the param flow changes.
- **§3.2 second half (StateSchemaRegistry split).** The picker dedup (§1.7) is resolved here. Splitting `StateSchemaRegistry` into a framework-level `JournalSchemaRegistry` plus a finance-level overlay is a separate design — `StateSchemaRegistry` stays in `src/finance/` for now but stops carrying the `pickActionData` static.
- **Line 565 `primaryAmountField` hint.** The journal-report plugin's `item.stateDelta ?? item.personTaxAmount ?? item.amount ?? item.proceeds` fallback chain is the same family of problem, but its fix can ride a follow-up doc using the same registry.
- **Generalizing the picker to non-finance domains.** The registry contract is domain-agnostic; the migration of every existing finance action type into it is part of this design, but no second domain is added.

---

## 3. Phase 0 — Framework Field Rename

Before the registry lands, tighten the underscore convention on `Action` so the picker's fallback rule is meaningful.

### 3.1 Today's mixed convention

Underscore-prefixed framework fields (the convention exists):

- `action._repeaterCounter` — `RepeatingReducer` iteration counter (`reducers.js:487`)
- `action._script` — `ScriptedAction` source string (`actions.js:161`)
- `action._fn` — compiled function cache (`actions.js:162`)
- `action._emittedByNodeId` — graph-recorder edge tag (`simulation.js:626`)

Non-underscore framework fields (the convention breaks):

- `instanceId`, `parentInstanceId`, `rootInstanceId` — runtime parentage UUIDs (`actions.js:45–47`)
- `actionId` — execution-time id reference

Public domain fields (correct as-is): `id`, `type`, `name`, plus per-subclass payload (`amount`, `value`, `fieldName`, `script`).

### 3.2 Rename

| Before | After |
|---|---|
| `action.instanceId` | `action._instanceId` |
| `action.parentInstanceId` | `action._parentInstanceId` |
| `action.rootInstanceId` | `action._rootInstanceId` |
| `action.actionId` | `action._actionId` |

`Action` constructor (`actions.js:43–48`), `ActionDefinition.instantiate()` (`actions.js:309–311`), `Simulation._processActionQueue` and `_makeExecutionId` callsites in `simulation.js` are the writers. Readers are the breakpoint/lineage paths in `simulation.js`, `graph-recorder.js`, and a handful of execution-history plugins. Mechanical find-replace, ~60 callsites by grep.

Public fields that **stay non-underscore** because they're durable identity / dispatch:
- `id` (service-assigned config id; survives serialization)
- `type` (action discriminator; pipeline key)
- `name` (UI label)
- `kind`, `layer` (SimGraphNode base — stable graph metadata)

### 3.3 Resulting rule

After Phase 0, the framework block-list for the picker is:

```js
const FRAMEWORK_FIELDS = new Set(['id', 'type', 'name', 'kind', 'layer']);
// Plus: any property starting with '_' (now exhaustive — covers all framework internals).
```

Five names plus one regex. Stable, framework-owned, finance-agnostic.

---

## 4. The `TypeRegistry`

### 4.1 Location and lifecycle

```
src/simulation-framework/type-registry.js
```

Framework layer — no `src/finance` imports. Domain-agnostic.

```js
export class TypeRegistry {
  constructor() {
    this._classes     = new Map();  // typeName → ctor
    this._actionTypes = new Map();  // typeString → ActionTypeEntry
    this._families    = new Map();  // familyName → Set<typeString>
    this._byCategory  = new Map();  // 'handler'|'reducer'|'action' → Set<ctor>
  }
  // ... see §4.5
}
```

**Owned by `ServiceRegistry`.** Created in the constructor alongside `graph`, `bus`, etc. Accessed via `services.typeRegistry`. Reset via `ServiceRegistry.reset()` and `resetAll()` — no preserved state to protect, because toolsets re-run on Rebuild fully repopulate it (unlike `ScenarioRegistry`, which carries user-edited params; see §4.2 resolution in `design/17`).

**Future-proofing for §4.1.** API is purely instance-based. Today there is one `ServiceRegistry`, so functionally one `TypeRegistry`. When the singleton is unwound, each `ServiceRegistry` carries its own and MC / branching get isolation for free. **No call-site churn at that point** — every reader already accesses via `services.typeRegistry`.

**Branching:** branches share their parent's `ServiceRegistry` (today) so they share `typeRegistry` by reference. No allocation per branch.

### 4.2 Cost model

Toolset declarations are inert module-level data. Population is `Map.set` × ~15 toolsets × ~100 entries per toolset = ~1,500 hash inserts per `ServiceRegistry` construction. A 10K-run MC sweep does ~15M `Map.set` calls in total — measurable but tiny next to the simulation work itself. If profiling later flags it, the toolset `types` blocks are immutable, so a module-level `toolsetId → frozen bundle` memo is a drop-in optimization that doesn't change the API.

### 4.3 Class contract — what each subclass declares

Base classes get default `static type` / `static fromJSON` / `toJSON` that work for the common shapes. Subclasses override only the delta.

```js
// src/simulation-framework/handlers.js
export class HandlerEntry extends SimGraphNode {
  static type     = 'HandlerEntry';
  static category = 'handler';

  static fromJSON(d, _ctx) {
    const h = new this();
    h.id = d.id;
    return h;
  }

  toJSON() {
    return { __type: this.constructor.type, id: this.id, name: this.name };
  }
}
```

Most account-module handlers are in `_NO_ARG_HANDLERS` today — they get the base `fromJSON` for free, no override needed.

For handlers that carry config:

```js
// src/finance/handlers/us-savings-interest-handler.js
export class UsSavingsInterestMonthlyHandler extends HandlerEntry {
  static type     = 'UsSavingsInterestMonthlyHandler';
  static eventType = 'US_SAVINGS_INTEREST_MONTHLY';

  static fromJSON(d, { stateRegistry }) {
    const h = new this({
      stateRegistry,
      role:         d.role,
      ownerId:      d.ownerId,
      interestRate: d.interestRate,
    });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      role:         this.role,
      ownerId:      this.ownerId,
      interestRate: this.interestRate,
    };
  }

  // existing constructor + call() unchanged
}
```

Reducers follow the same pattern. The common `({ accountService })` shape gets a `Reducer.fromJSON` default that's specialised once on the base class.

### 4.4 Action-type entries

The picker's allow-list problem is solved at the action-type level (string discriminator), not the class level — because most actions in flight are plain objects emitted by reducers via `newState(state, {}, [{ type: 'X', ... }])`, not subclass instances.

```js
{
  type:        'US_TAX_PAYMENT_DEBIT',
  family:      'TAX_PAYMENT_DEBIT',   // optional — see §6
  cc:          'US',                  // optional — see §5
  description: 'US tax payment debit (chained from US_TAX_SETTLE_APPLY when liability > 0)',
  fields: {
    amount: ValueType.currency('USD'),
  },
}
```

`fields` is typed (`ValueType.currency('USD')`) so the journal, CSV, chart, and state-panel layers can read the same descriptor and format consistently. This subsumes the per-feature allow-lists scattered today.

### 4.5 API

```js
class TypeRegistry {
  registerClass(ctor)                          // reads ctor.type / ctor.category
  registerActionType(entry)                    // entry.type → indexed by family + cc
  registerToolset(toolset)                     // walks toolset.types.{handlers,reducers,actions}

  get(typeName)                                // → ctor | null
  getAction(typeString)                        // → ActionTypeEntry | null
  byCategory(category)                         // → ctor[]
  byFamily(family, { cc } = {})                // → ActionTypeEntry[]
  familyTypes(family, { cc } = {})             // → string[]   (for op:'in' queries)

  pickPayload(action)                          // see §7
}
```

`registerToolset` is the one ScenarioCompiler / ScenarioLoader calls. Everything else is read-side.

---

## 5. Action-Type Country Split

### 5.1 The rule

> If a reducer branches on a field whose values come from a small enumerated set known at toolset-construction time, that field should be promoted to the action-type discriminator.

Applied to the codebase:

| Today | Becomes |
|---|---|
| `TAX_PAYMENT_DEBIT` + `action.cc` | `US_TAX_PAYMENT_DEBIT` / `AU_TAX_PAYMENT_DEBIT` |
| `TAX_SETTLE_APPLY` + `action.cc` | `US_TAX_SETTLE_APPLY` / `AU_TAX_SETTLE_APPLY` |
| `PERIOD_ADVANCE` + `action.cc` | `US_PERIOD_ADVANCE` / `AU_PERIOD_ADVANCE` |
| `WAGES_INCOME_APPLY` + `action.amount` | **unchanged** — `amount` is continuous, not enumerable |
| `STOCK_WITHDRAWAL_TAX` + `action.isLongTerm` | **unchanged** — runtime-computed boolean |

The events `TAX_SETTLE_US/TAX_SETTLE_AU` and `PERIOD_ADVANCE_US/PERIOD_ADVANCE_AU` are already country-discriminated; only the *actions* they emit weren't. This finishes the pattern.

### 5.2 Implementation — base class + thin subclasses

```js
// src/finance/tax/tax-settle-classes.js
class TaxPaymentDebitReducerBase extends Reducer {
  static cc;
  static actionType;     // derived: `${cc}_TAX_PAYMENT_DEBIT`

  constructor({ accountService, stateRegistry }) {
    const cc = new.target.cc;
    super(`${cc} Tax Payment Debit`, PRIORITY.TAX_APPLY + 1);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes = [new.target.actionType];
  }

  reduce(state, action, date) { /* shared body — reads this.constructor.cc */ }
}

export class UsTaxPaymentDebitReducer extends TaxPaymentDebitReducerBase {
  static type       = 'UsTaxPaymentDebitReducer';
  static cc         = 'US';
  static actionType = 'US_TAX_PAYMENT_DEBIT';
}

export class AuTaxPaymentDebitReducer extends TaxPaymentDebitReducerBase {
  static type       = 'AuTaxPaymentDebitReducer';
  static cc         = 'AU';
  static actionType = 'AU_TAX_PAYMENT_DEBIT';
}
```

Same pattern for `TaxSettleHandler`, `TaxSettleApplyReducer`, `PeriodAdvanceHandler`, `PeriodAdvanceReducer`.

### 5.3 What goes away

- `TaxService.getSharedReducers()` is deleted. Each country tax toolset owns its own reducers.
- The "first-toolset-wins" context cache in `us-tax-toolset.js` / `au-tax-toolset.js` is deleted.
- The `cc` field on the action object is removed (it's now implicit in the type). Callsites that read `action.cc` become `entry.cc` via the registry, or are removed because the dispatch is already by type.
- Cross-country journal queries that today filter by `action.cc` use `byFamily('TAX_PAYMENT_DEBIT')` instead (see §6).
- Implicit dependency between `AU_TAX` and `US_TAX` disappears — either, neither, or both can run independently.

### 5.4 Emitter callsite changes

`TaxSettleApplyReducer.reduce` today emits `{ type: 'TAX_PAYMENT_DEBIT', amount, cc }`. Post-split, each country variant emits its own type:

```js
// AuTaxSettleApplyReducer.reduce
return this.newState({ ...state, ...resets }, {}, [{ type: 'AU_TAX_PAYMENT_DEBIT', amount: tax }]);
```

`ChangeResidencyHandler` (which emits a final tax payment for the country being left) becomes a one-line `type` conditional instead of a `cc` field assignment — same mechanical complexity.

---

## 6. Action-Type Families

### 6.1 Why

Splitting types recovers per-country dispatch but loses the single-predicate "all tax payments across both countries" query. Three places in the codebase currently maintain hand-rolled literal lists for exactly this kind of grouping — each one is a separate §4.6-style drift hazard:

| Location | List | Migration |
|---|---|---|
| `report-definition-registry.js:245` | `WITHDRAWAL_ACTION_TYPES` (16 entries) | `family: 'WITHDRAWAL'` on every withdrawal entry |
| `report-definition-registry.js:413` | `REAL_PROPERTY_ACTION_TYPES` (4 entries) | `family: 'REAL_PROPERTY_CASH'` |
| `report-definition-registry.js:187` | inline cc-dependent capital gains list | `family: 'CAPITAL_GAINS'` + `cc` on each entry |

### 6.2 Mechanics

`family` and `cc` are optional fields on each `ActionTypeEntry` (§4.4). The registry maintains `_families: Map<familyName, Set<typeString>>` and exposes:

```js
typeRegistry.familyTypes('TAX_PAYMENT_DEBIT')             // ['US_TAX_PAYMENT_DEBIT','AU_TAX_PAYMENT_DEBIT']
typeRegistry.familyTypes('TAX_PAYMENT_DEBIT', { cc: 'US' }) // ['US_TAX_PAYMENT_DEBIT']
typeRegistry.familyTypes('WITHDRAWAL')                    // all 16, in registration order
```

`JournalQueryApi` gets one new method that wraps it:

```js
api.familyTypes(family, opts)   // → string[], used in { op: 'in', field: 'actionType', value: ... }
```

**No AST change.** The existing `op: 'in'` consumes the list. Existing reports rewrite from a literal array to a `familyTypes()` call.

### 6.3 Reports that don't benefit (and shouldn't try)

Three report definitions filter on `changedFields` / `stateKey`, not action type:

- `OrdinaryIncomeBySourceDef` (`contains(changedFields, 'usOrdinaryIncomeYTD' | 'auOrdinaryIncomeYTD')`)
- `PretaxAdjustmentsBySourceDef` (`contains(changedFields, 'usNegativeIncomeYTD')`)
- `CashFlowByAccountDef` (`contains(stateKey, 'account.balance')`)

These are tied to the state schema, not the action shape. Family doesn't apply. The clean home for them is the eventual `StateSchemaRegistry` split (non-goal — see §2).

---

## 7. The Picker Contract

### 7.1 Single picker, single source of truth

```js
// src/simulation-framework/type-registry.js
const FRAMEWORK_FIELDS = new Set(['id', 'type', 'name', 'kind', 'layer']);

class TypeRegistry {
  pickPayload(action) {
    const entry = this._actionTypes.get(action.type);
    if (entry) {
      const out = {};
      for (const k of Object.keys(entry.fields)) {
        if (action[k] != null) out[k] = action[k];
      }
      return out;
    }
    return this._fallbackPayload(action);
  }

  _fallbackPayload(action) {
    if (this._strict) {
      throw new Error(
        `TypeRegistry: action type '${action.type}' not registered — ` +
        `declare it in the owning toolset's types.actions block.`
      );
    }
    this._warnOnce(action.type);
    const out = {};
    for (const k of Object.keys(action)) {
      if (FRAMEWORK_FIELDS.has(k)) continue;
      if (k.startsWith('_'))       continue;
      if (action[k] != null)       out[k] = action[k];
    }
    return out;
  }
}
```

After Phase 0 (§3), the underscore check is exhaustive over framework-internal fields; the explicit `FRAMEWORK_FIELDS` set is just the five durable public framework names.

### 7.2 Strict mode

`TypeRegistry` is strict by default in dev, permissive in `silent` simulation mode (MC / batch). The strict mode flag is set by `ServiceRegistry` based on the simulation's `opts.silent`:

```js
const sim = new Simulation(startDate, { ...opts, silent: true });
services.typeRegistry.setStrict(!opts.silent);
```

Strict throws on unregistered types — drift caught at the test that triggered it. Permissive warns once per unknown type and applies the fallback, so a 10K-run MC sweep with one unregistered type emits one warning, not 10K.

### 7.3 What gets deleted

- `_pickActionData` in `simulation.js` (§3.1).
- `StateSchemaRegistry.pickActionData` in `src/finance/services/state-schema-registry.js` (§1.7).
- The cluster of allow-list-style field reads inside `JournalReportPlugin` (and similar) — they read `entry.fields` directly.

---

## 8. Toolset Manifest Shape

### 8.1 Additive

Toolsets remain plain objects with their existing `paramSchema/state/schedules/handlers/reducers/dependencies/capabilities`. They gain one new optional field:

```js
export const US_RETIREMENT = {
  id: 'US_RETIREMENT',
  capabilities: ['retirement'],
  dependencies: ['US_BANKING', 'US_TAX', 'US_INCOME', 'US_BROKERAGE'],

  // NEW — inert metadata, no side effects
  types: {
    handlers: [
      RothContributionHandler,
      IraContributionHandler,
      K401ContributionHandler,
      // ... etc
    ],
    reducers: [
      RothContributionApplyReducer,
      IraContributionApplyReducer,
      K401ContributionApplyReducer,
      // ... etc
    ],
    actions: [
      { type: 'ROTH_CONTRIB_APPLY',  fields: { amount: ValueType.currency('USD'), personKey: ValueType.text() } },
      { type: 'IRA_WITHDRAWAL_CONTRIB_APPLY', family: 'WITHDRAWAL',
        fields: { amount: ValueType.currency('USD') } },
      // ... etc
    ],
  },

  // unchanged below
  paramSchema(context) { /* ... */ },
  state(context)       { /* ... */ },
  schedules(context)   { /* ... */ },
  handlers(context)    { /* ... */ },
  reducers(context)    { /* ... */ },
};
```

### 8.2 Who calls `registerToolset`

Two writers:

1. **`ScenarioCompiler.compile()`** — for the toolset-based path. Inserts a new first step that walks `resolved.types` for each toolset.
2. **`ScenarioLoader.load()`** — for the graph-deserialize path. Before dispatching to `ScenarioSerializer.deserializeGraph`, walks every toolset listed in `cfg.toolsets` and registers their types so the serializer's `registry.get(d.__type)` lookups succeed.

Both writers run **before** any deserialization, so the registry is always populated when the serializer asks.

### 8.3 Where ownership lives

Action types that are chained from multiple toolsets (e.g. `RECORD_BALANCE`, `RECORD_METRIC`) are declared in the framework's `core-types` registration that ScenarioCompiler / ScenarioLoader always invokes first. The tax actions are declared in the corresponding country's tax toolset. The cross-border toolset declares its own action types only (no piggybacking on US_TAX entries).

---

## 9. Serializer Rewrite

### 9.1 Before → after

`scenario-serializer.js` shrinks from 1,251 lines to ~100. Every per-class case in `_makeHandler`, `_makeAction`, `_makeReducer` is replaced by:

```js
static _makeHandler(d, services) {
  const ctor = services.typeRegistry.get(d.__type);
  if (!ctor) throw new Error(`Unknown handler type: ${d.__type}`);
  return ctor.fromJSON(d, services);
}

// same for _makeAction, _makeReducer
```

Per-class metadata (`role`, `ownerId`, `interestRate`, …) lives in each class's `toJSON` / `fromJSON`. The serializer is purely dispatch + the four domain helpers (`_makePerson`, `_makeAccount`, `_makeRealProperty`, `_makeCollectible`) which are unchanged because those aren't `SimGraphNode`s.

### 9.2 What gets deleted

- `_ACCOUNT_SERVICE_REDUCERS` (lines 223–268)
- `_NO_ARG_HANDLERS` (lines 274–316)
- `Engine` and `Finance` namespace objects (lines 142–215)
- ~50 case branches in `_makeHandler` (lines 906–1044)
- ~25 case branches in `_makeAction` (lines 1130–1153) — replaced by registry lookup; classes themselves keep their constructors
- ~70 case branches in `_makeReducer` (lines 1156–1248)
- `_serializeHandler`'s subclass switch (lines 725–807) — each subclass's `toJSON` carries its own fields
- `_serializeReducer`'s subclass switch (lines 856–882)

The fast-path `_isAlreadySerialized()` and the helper for `Account` type-discriminator → class name stay; they're orthogonal to the type registry.

### 9.3 The minification hazard

Today the project's vite config preserves class names because `Action.actionClass`, `Reducer.reducerType`, `HandlerEntry.handlerClass` all return `this.constructor.name` (README "Class-name preservation under minification"). After this design, `__type` comes from explicit `static type` declarations on each subclass — minification can no longer break serialization. **Remove the class-name preservation note from the README** as part of this work.

---

## 10. Migration Plan

Ordered for testability — each step leaves the tree green.

### Phase 0 — framework field rename ✅

1. ✅ Find/replace `instanceId/parentInstanceId/rootInstanceId/actionId` → `_instanceId/...` across `src/simulation-framework/actions.js`, `simulation.js`, `graph-recorder.js`, and matching test fixtures in `simulation-breakpoints.test.mjs`, `action-definition.test.mjs`. Journal entry sub-objects (`entry.action.instanceId` etc.) are a separate schema and left unchanged.
2. ✅ `npm test:all` — 1783 backend + 597 viz = 2380 tests, 0 failures.

### Phase 1 — TypeRegistry primitive ✅

3. ✅ `src/simulation-framework/type-registry.js` created (TypeRegistry + ValueType). No callers yet.
4. ✅ `static type` + `static category` added to `Action`, `FieldAction`, `FieldValueAction`, `AmountAction`, `RecordBalanceAction`, `RecordMetricAction`, `ScriptedAction` in `actions.js`; `HandlerEntry` in `handlers.js`; `Reducer`, `NoOpReducer`, `FieldReducer`, `MetricReducer`, `BalanceSnapshotReducer`, `FieldValueReducer`, `ArrayReducer`, `NumericSumReducer`, `MultiplicativeReducer`, `AccountTransactionReducer`, `RepeatingReducer`, `ScriptedReducer` in `reducers.js`.
5. ✅ Default `toJSON` / `static fromJSON` added to `HandlerEntry` and `Reducer` base classes.
6. ✅ `typeRegistry` added to `ServiceRegistry` constructor, `simulationContext`, and instance `reset()`.
7. ✅ `tests/unit/type-registry.test.mjs` — 29 tests covering registration, lookup, family queries, strict / permissive `pickPayload`, framework block-list, base class statics. All 2409 tests pass.

### Phase 2 — country split ✅

8. ✅ Refactored `TaxPaymentDebitReducer` / `TaxSettleApplyReducer` / `TaxSettleHandler` / `PeriodAdvanceReducer` / `PeriodAdvanceHandler` into base + per-country subclasses. Updated emitters (`TaxSettleApplyReducer` chained action, `ChangeResidencyHandler`).
9. ✅ Deleted `TaxService.getSharedReducers()` and the context cache.
10. ✅ Updated US_TAX / AU_TAX toolsets to register their own per-country reducers directly.
11. ✅ Regression: `evt-*` tests still pass; `intl-retirement-scenario.test.mjs` still passes; tax round-trip via `serializer-finance-roundtrip.test.mjs` still passes.

### Phase 3 — toolset manifests ✅

12. ✅ Added `types: { handlers, reducers, actions }` blocks to all 17 toolsets in `src/scenarios/toolsets/`. Action entries cover all per-country tax variants, account-level withdrawal/deposit actions, and cross-border actions.
13. ✅ `ScenarioCompiler.compile()` calls `services.typeRegistry.registerToolset(t)` for each resolved toolset as the first step.
14. ✅ `ScenarioLoader.load()` graph-deserialize path covered via the compiler delegation — no separate change needed. All 597 tests pass.

### Phase 4 — class statics + `fromJSON` for every subclass ✅

15. ✅ Walk every finance handler, reducer, and action subclass listed in the deleted `_NO_ARG_HANDLERS` / `_ACCOUNT_SERVICE_REDUCERS`. Add `static type` and override `fromJSON` / `toJSON` only where they carry config beyond the base shape.
16. ✅ Subclasses that only need the base behaviour add `static type` and inherit `fromJSON`. `AccountServiceReducer` intermediate class added to `reducers.js` — all 52 account-module reducers now extend it. Base `HandlerEntry.toJSON()` and `Reducer.toJSON()` updated to emit full graph fields for Phase 5 compatibility. `DynamicTaxReducer` given `fromJSON` with fresh `TaxService().taxEngine`. All 2409 tests pass.

### Phase 5 — serializer rewrite

17. Rewrite `scenario-serializer.js` per §9. Big-bang — delete the string sets and switches in one PR.
18. Run the full test suite. The roundtrip suite is the regression net.

### Phase 6 — picker swap

19. Delete `_pickActionData` from `simulation.js`. Replace callsites with `this.bus.serviceRegistry?.typeRegistry?.pickPayload(action)`, with a small fallback when the sim is constructed without a `ServiceRegistry` (test fixtures).
20. Delete `StateSchemaRegistry.pickActionData`.
21. Update `JournalReportPlugin` and any other plugin reading directly from action objects to use `typeRegistry.getAction(type).fields`.

### Phase 7 — report families

22. Rewrite `WithdrawalsByAccountDef`, `RealPropertyCashFlowDef`, `CapitalGainsByDisposalDef`, `TaxPaidByYearDef`, `AuTaxByPersonYearDef` to use `api.familyTypes(family, { cc })` and the per-country tax types.
23. Delete `WITHDRAWAL_ACTION_TYPES`, `REAL_PROPERTY_ACTION_TYPES`, and the inline capital-gains list.

### Phase 8 — cleanup

24. Remove the class-name preservation note from README (§9.3).
25. Update `design/inconsistencies.md` — mark §3.1, §3.6, §4.6 resolved; partial on §3.2 (picker dedup done; full split deferred).
26. Add `design/19-type-registry.md` to README design index.

---

## 11. Test Plan

### New unit tests

- `tests/unit/type-registry.test.mjs` — registration, lookup, `byFamily`, `familyTypes`, strict/permissive `pickPayload`, framework block-list correctness, `registerToolset` walks all three buckets.
- `tests/unit/action-payload-schema.test.mjs` — drift detector: for every registered action type, build a sim that emits it, capture the live action, and assert that **every non-framework non-underscore field on the live action appears in the registry's `fields` declaration**. Failing test names the toolset that needs updating.

### Existing tests as regression net

- `scenario-roundtrip.test.mjs` and `serializer-finance-roundtrip.test.mjs` — the load-bearing roundtrip suite. After Phase 5 these must pass unchanged. They are the proof the rewrite preserves behaviour.
- `evt-*` (40+ files) — confirm every event-driven test still works after the country split.
- `intl-retirement-mc-runner.test.mjs` — confirms permissive `pickPayload` doesn't degrade MC.
- `state-registry.test.mjs`, `type-registries.test.mjs` — existing registry tests stay green.

### Manual verification

UI feature paths require dev-server walkthrough (per project conventions): journal timeline filtering, journal report family queries, exec-history lineage with renamed `_instanceId` fields, MC summary with the new permissive path.

---

## 12. Risks

- **Phase 0 rename touches 60+ callsites.** Most are mechanical, but lineage / exec-history / graph-recorder code is dense around these fields. Risk is missing a reader — covered by the existing breakpoint + lineage tests.
- **Phase 2 country split is observable in the journal.** Existing tests that filter on `action.cc === 'US'` need to switch to `action.type === 'US_TAX_PAYMENT_DEBIT'` (or use the family helper). About 6 such test assertions, mostly in `evt-401k.test.mjs` and `evt-ira.test.mjs`.
- **Toolset manifest authorship.** Adding `types.actions` to every toolset is mechanical but tedious — ~60 distinct action types across 17 toolsets. The drift detector test (`action-payload-schema.test.mjs`) is the safety net that catches a missed declaration immediately.
- **Strict-mode in tests.** Phase 6 swap turns on strict-mode by default in unit tests; any test that emits an ad-hoc action type without registering it will fail. We pre-empt this by giving the test helper a `registerActionType(...)` shortcut and converting the (small) set of ad-hoc tests to use it.
- **MC perf.** Per-`ServiceRegistry` population is theoretical overhead. The cost-model estimate in §4.2 says we're far below sim-loop costs. If profiling later shows otherwise, the bundle memo (§4.2) is a non-API-breaking fix.

---

## 13. Follow-ups (out of scope, enabled by this design)

- **`primaryAmountField` per action type.** Replaces `journal-report-plugin.js:565`'s `item.stateDelta ?? item.personTaxAmount ?? item.amount ?? item.proceeds` fallback chain with a registry hint. Same family of problem, easy to ride this registry.
- **`StateSchemaRegistry` split (§3.2 full resolution).** Frame as `JournalSchemaRegistry` (framework) + `FinanceStateSchemaRegistry` (overlay). The picker dedup this design provides closes half of §3.2; the other half is a separate doc.
- **Reducer payload contamination (§2.3).** `RepeatingReducer`'s `{ ...action, _repeaterCounter }` spread is cleaner once underscore-prefix is exhaustive — the journal will already strip these. A dedicated `actionPayload(action)` helper for re-emission is still worth adding but the urgency drops.
- **§4.1 ServiceRegistry singleton unwind.** This design positions TypeRegistry to ride it without API churn.
- **§4.5 action id namespacing.** Once action types are first-class registry entries, `id = ${toolsetId}:${type}` becomes trivial — the toolset that registered the type is already known.
