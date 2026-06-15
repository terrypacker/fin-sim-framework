# Design: Parameter ↔ Field Linking — one source of truth for editable values

> Status: **✅ IMPLEMENTED.** Companion to `design/10` (currency) and `design/13`
> (typed param round-tripping) / `design/15` (config as source of truth).
>
> **Implemented:**
> - `src/visualization/scenario/param-field-links.js` — `ParamFieldLinks` (inverse of
>   `nodeLookup`); `getParamFor(type, id|stateKey, field)`.
> - `src/visualization/scenario/param-linked-field.js` — `bindParamLinkedField()`: shows the
>   param value, writes the param on change, appends the 🔗 badge + click-through.
> - `ScenarioSerializer.snapshotDomainRecords()` (records only, no graph) + harvest in
>   `WorkbenchApp.destroyScenario()` *before* `ServiceRegistry.reset()` — Rebuild now rebuilds
>   what's configured; free fields (currency, …) survive without a manual Save.
> - Account / person / real-property / collectible editors consult the link registry per field;
>   linked fields (`balance` when not holdings-driven, `minimumBalance`, `monthlyWage`,
>   `retirementDate`, `plannedSaleYear`) read/write the param and are excluded from the service
>   payload via a `_linkedFields` set in `_readForm`.
> - `ScenarioTabPresenter.getActiveParams()/refreshParams()/revealParam()` + the view's
>   `revealParam()` (clears filter, expands group, scrolls + flashes the row).
> - Money-type audit: only the free-standing `monthlyExpenses` is `Money` (both US/AU toolset
>   copies aligned); node-linked money params stay `Number` and defer to the object currency.
> - Tests: `tests/unit/param-field-links.test.mjs`, `tests/viz/editors/param-linked-fields.test.mjs`;
>   full `test:unit` + `test:viz` green, production build clean.

## Context / Problem

Many editable values exist in **two places at once**, and the two diverge silently:

1. A **domain-object field** edited in an editor form — `account.balance`,
   `account.minimumBalance`, `person.monthlyWage`, `person.retirementDate`,
   `realProperty.plannedSaleYear`, and (added in design/10 Phase 5)
   `account.currency`, `person.wageCurrency` / `ssCurrency`, `asset.currency`.
2. A **scenario param** with a `node` declaration pointing at that same field — e.g.
   `{ key:'usStockBalance', node:{ type:'account', stateKey:'usStockAccount', field:'balance' } }`.
   ~15 account `balance`s, both `minimumBalance`s, both people's `monthlyWage` /
   `retirementDate`, and the two houses' `plannedSaleYear` are node-linked today.

The two paths persist **differently**, which is the trap:

- **Param edits** write straight into the active scenario record (`_activeScenario.params`,
  i.e. `cfg.params`) — the same object `ScenarioLoader.load()` reads. So a param edit is in
  `cfg` immediately; Rebuild applies it. No Save needed.
- **Domain-object edits** go through the **service map** (`accountService.updateAccount` →
  `SERVICE_ACTION`). They mutate the live object but **never touch `cfg`**. `onSave`
  (`scenario-tab-presenter.js:144-150`) is the only thing that harvests service state into `cfg`.

So on Rebuild (`workbench-app.js:464-473` → `ServiceRegistry.reset()` → reload from `cfg`):

- A domain-object edit that wasn't Saved is **discarded** (reloaded from `cfg`). This is what
  makes a currency change "revert" unless you Save first.
- Worse, for a **node-linked** field, `ScenarioLoader._normalizeParams` → `_applyParamNode`
  (`scenario-loader.js:211-238`) writes the **param's** stored value onto `cfg.accounts[].field`
  *before* deserialize — so even a Saved domain edit to a linked field is **overwritten by the
  param value**. Two inputs for one field; on Rebuild the param silently wins.

Users cannot tell, looking at a form field, whether they're editing "the thing that wins"
(a param) or "the thing that gets clobbered" (a domain field). As the param schema grows, new
node-links silently turn previously-safe form fields into clobbered ones.

## Goals

- **One source of truth per editable field.** A field is owned by *either* a param *or* the
  domain object, never both-with-divergence.
- **Editors are param-aware.** A form input that is backed by a param reads and writes that
  param; the user sees it's a parameter and that the edit round-trips / is MC-/opt-eligible.
- **Domain-object edits survive Rebuild** without a manual Save (close the revert trap for the
  free fields that are *not* params — currency, name, holdings, wage/ss currency, …).
- **Robust to schema drift.** Adding a node-linked param automatically makes the matching form
  field param-backed — no per-field wiring, no new silent clobbers.
- Keep the existing param→node cascade and toolset-recompile semantics intact.

## Non-goals

- Not turning every domain field into a param. Domain objects stay first-class (an account
  owns its `currency`, drives FX / tax / account-rules). Only fields a param *already* targets
  become param-backed in the editor.
- No live bidirectional sync engine (echo-loop / ordering complexity). Linked fields have a
  single home (the param); free fields have a single home (the domain object).
- No new currency params. `account.currency` etc. stay free domain fields (covered by the
  harvest fix), not params — a `param.currency` next to `account.currency` would recreate the
  dual-source problem.

## Design

### 1. `ParamFieldLinks` — the inverse of `nodeLookup`

A small, pure helper built from the active scenario's params that carry a `.node`. It is the
inverse of the existing `nodeLookup` (`scenario-tab-presenter.js:59`, param → live node);
this maps **(domain field) → param**.

```js
// src/visualization/scenario/param-field-links.js
export class ParamFieldLinks {
  constructor(params = []) {
    this._byField = new Map(); // `${type}:${id|stateKey}:${field}` → param
    for (const p of params) {
      const n = p.node;
      if (!n?.field) continue;
      this._byField.set(`${n.type}:${n.id ?? n.stateKey}:${n.field}`, p);
    }
  }
  /** The param backing this domain field, or null. */
  getParamFor(type, idOrStateKey, field) {
    return this._byField.get(`${type}:${idOrStateKey}:${field}`) ?? null;
  }
}
```

Built once per editor open from `_activeScenario.params` and injected into the editor
(alongside the existing `people` / `accounts` props).

### 2. Editor contract — route linked fields through the param

For each money/number form input the editor renders, it asks
`links.getParamFor(type, id|stateKey, field)`:

- **Hit (param-backed):**
  - **Read** the displayed value from `param.value` (the source of truth), *not* the domain
    object — so the form shows what will actually be applied on Rebuild.
  - **Write** on change to `param.value` (the `cfg.params` entry). Do **not** write the field
    into the service-update payload.
  - **Badge** the field (e.g. a small `🔗` with title "Parameter: <key>"), optionally with a
    click-through that activates the Scenario panel scrolled to that param (inverse of the
    panel's existing param→node click-through).
- **Miss (free field):** current behavior — read/write the domain object via the service.

`_readForm()` therefore splits its output into `{ serviceChanges, paramChanges }`; `onSave`
applies `paramChanges` to the live `cfg.params` entries and `serviceChanges` via the controller.

> **Behavior change to call out:** a linked field (e.g. `balance`) becomes "applies on
> Rebuild" (the param/node-cascade path) rather than applying live via `SimulationSync`. For
> initial-condition values like balances this is arguably more correct, and it removes the
> clobber — but it is a deliberate change and needs a note in the UI (the badge conveys it).

### 3. Harvest free domain edits into `cfg` on Rebuild

So that **non-param** domain edits (currency, wage/ss currency, name, holdings, ownership, …)
survive Rebuild without a manual Save, the Rebuild path harvests the live **domain records
only** into `cfg` *before* `ServiceRegistry.reset()`:

```
initScenario (Rebuild):
  cfg.persons        = personService.getAll().map(serializePerson)
  cfg.accounts       = accountService.getAll().map(serializeAccount)
  cfg.realProperties = realPropertyService.getAll().map(serializeRealProperty)
  cfg.collectibles   = collectibleService.getAll().map(serializeCollectible)
  ServiceRegistry.reset()
  ScenarioLoader.load(cfg)   // node-cascade still overwrites *linked* fields from params
```

Crucially this harvests **records only**, *not* the events/handlers/reducers/graph snapshot —
so it does **not** flip `load()` into the deserialize branch; toolsets still recompile
(unlike `onSave`'s full `snapshotServices`, which intentionally freezes the graph). Composition
is correct: harvest carries free fields (currency); the node-cascade then overwrites linked
fields (balance) from the params — each field ends up from its single owner.

This also fixes the original currency trap with no special-casing: `account.currency` is a free
field, harvested into `cfg.accounts`, and `_registerDisplayCurrencies` re-stamps from it on the
same `load()`.

### 4. Money-type cleanup (narrow)

Audit money-representing params and set `type:'Money'` **only for free-standing** ones (own a
currency) — e.g. `monthlyExpenses` (done). **Node-linked** money params (every `*balance`,
`minimumBalance`, `monthlyWage`) stay `Number` and **defer to the owning object's currency**
(`account.currency` / `person.wageCurrency`). Making them `Money` would put a second currency
beside the object's and reintroduce dual-source. The display already converts them via the
object's stamped code (design/10 Phase 4/5), so no Money type is needed there.

## Affected files (anticipated)

| File | Change |
|---|---|
| `src/visualization/scenario/param-field-links.js` | **New** — the inverse link registry |
| `src/apps/workbench-app.js` | Build `ParamFieldLinks` per editor open; inject into editors; harvest domain records into `cfg` before reset on Rebuild |
| `src/visualization/accounts/account-editor.js`, `people/person-editor.js`, `assets/*-editor.js` | Consult links per field; read/write linked fields via the param; badge; split `_readForm` into service vs param changes |
| `src/visualization/scenario/scenario-tab-presenter.js` | Re-render params panel when an editor writes a linked param; optional node-field→param navigation |
| toolset param schemas | Money-type audit (free-standing only) |
| `tests/...` | Link-registry unit tests; editor smoke tests (linked field reads param, writes param, free field unchanged); a Rebuild-without-Save harvest test |

## Risks / watch-items

- **Identity invariant:** `_activeScenario.params` must be the same object `ScenarioLoader.load`
  reads, or "write param → Rebuild sees it" breaks. Verify the `ScenarioRegistry` preserves the
  active record across `reset()` (it is documented to) and add a test.
- **Linked-field edits become Rebuild-applied**, not live. Acceptable for initial conditions;
  flagged by the badge. Confirm no surface depends on live balance edits via `SimulationSync`.
- **Harvest ordering:** harvest must run *before* `reset()` and must serialize records only
  (no graph) to preserve recompile. A full-snapshot harvest would silently disable toolset
  recompilation.
- **Param panel ↔ editor consistency:** editing a linked field in the form and in the param
  panel now hit the same `param.value`; both views must re-render off it.

## Suggested sequencing

1. `ParamFieldLinks` + unit tests (pure, no UI).
2. Harvest-on-Rebuild (records only) — closes the currency/free-field revert trap immediately.
3. Editor contract: account editor first (balances are the worst offender), then person/asset.
4. Money-type audit (free-standing only).

## Resolved decisions

- **Badge + click-through.** Linked fields stay editable (route-through-param) and carry a
  visible `🔗` affordance that jumps to the param in the Scenario panel.
- **Show all linked fields read-from-param** (`minimumBalance` / `retirementDate` /
  `plannedSaleYear` behave like balances — shown, value from the param). Consistency.
- **Harvest on every Rebuild** — "rebuild what I configured." Discarding drafts stays the job of
  the explicit *Reset to Defaults* action.
