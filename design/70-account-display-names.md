# 70 — Account display names (show the name, keep the key)

**Status: IMPLEMENTED** (all four phases, §8; Axis A only — key generation and key migration
remain out of scope, §9). A `stateKey` is the simulation's durable *identity* for an
account/asset, but it currently leaks into user-facing surfaces as if it were a *label* — the
State/Metrics panel and the Journal reports show `usSavings2Account` / `beq1IraAccount` instead of
"Shared Checking" / "Marge IRA". This design introduces one shared **stateKey → display-name
resolver** and routes the surfaces that leak keys through it, so the human name shows everywhere —
**without** changing any stateKey, param key, or the serialized config (zero identity churn).

**Builds on / relates to:**
- **`design/55` (config-driven params)** — per-record params are keyed `acct.<stateKey>.<field>`;
  the stateKey is load-bearing identity and must not move. This design leaves it untouched.
- **`design/63 §14.6` (journal naming fragility)** — the per-account Journal reports select balance
  rows by the `contains 'account.balance'` substring "disambiguation-by-luck". The resolver + the
  effective account set let us **retire that substring** (the §14.6 "robust" fix) as a fold-in.
- **`design/10` (currency display)** — `StateSchemaRegistry` already stamps per-`stateKey` display
  metadata (currency) at load; the display-name map is the same shape of "load-time per-key display
  info" and rides the same registration seam.

---

## 1. Problem

The `stateKey` is an internal identifier, but three user-facing surfaces render it verbatim:

1. **State / Metrics panel** — every row is labeled `toLabel(stateKey)`
   (`state-panel-view.js:1640`), which merely *beautifies the key text*
   (`usSavings2Account` → "Us Savings 2 Account"). The panel has no `accountService` reference and
   never sees the account's `name`.
2. **Journal reports** — group by `stateKey` (`defaultGroupBy = ['stateKey']`,
   `report-definition-registry.js`) and show the raw key as the row identity; there is no name column.
3. **Anywhere else a key is echoed** (field-history modals, chart series labels) inherits the same
   `toLabel(key)` beautification.

The names *exist* — on the account record (`accountService`), in generated param labels
("Mo Brokerage — Growth Rate"), and the **Holdings dropdown already labels by name**
(`${country} ${name}`, `holdings-plugin.js`). The name simply isn't carried to the state map, the
metrics panel, or the journal. The result is that a user reading the metrics or a journal report
cannot correlate a row back to the account they configured — acute for inherited assets
(`beq1IraAccount`) and for keys whose role-derived spelling is misleading (a checking account keyed
`usSavings2Account` because the key camelCases its **role** (`us-savings`), not its name or type —
`_generateStateKey`, `accounts-controller.js:145`).

---

## 2. Goals & Non-Goals

### Goals
- One **shared resolver**: `stateKey → { name, kind, currency }`, populated at load from the
  account / real-property / collectible / bequest / person records, available to both the engine
  (journal) and the UI (panels).
- **Reroute the leaking surfaces** to show the name (falling back to `toLabel(key)` when absent):
  the State/Metrics panel section/row labels, and the Journal reports' per-account **group label**
  (the group *value* stays the stateKey identity; only the rendered label becomes the name).
- **Retire the §14.6 substring** in the per-account reports by defaulting their account scope to the
  effective account set (name + key both available).
- **Zero identity churn**: no stateKey changes, no param-key changes, no serialized-config changes,
  reference golden unmoved.

### Non-Goals (deferred, §9)
- **Changing how keys are generated** (name-derived keys, user-editable key field) — Axis B.
- **Migrating existing keys** to readable ones — breaking; needs a param/journal migration path.
- Renaming the runtime `state` map keys (they *are* the stateKey; that is identity, not display).

---

## 3. Root cause — the name lives on the record, not on the key's display path

The framework reaches "the accounts" through several lists; the *name* is present on the
**config-record** list (`accountService.getAll()`), but the surfaces that render keys read from the
**runtime state map** (metrics panel) or the **journal rows** — neither of which carries the name:

| Surface | Reads from | Has the name? | Shows |
|---|---|---|---|
| Holdings dropdown | `accountService.getAll()` | ✅ | `${country} ${name}` (correct — the model) |
| Journal facet filter | `accountService.getAll()` via `_accountLabel(a)` | ✅ | name (correct — but only in the *filter*, not the report rows) |
| **State / Metrics panel** | runtime `state` keys | ❌ | `toLabel(stateKey)` |
| **Journal report rows** | journal `stateKey` field | ❌ | raw `stateKey` |

The fix is to make the name reachable from the key on *every* surface via one resolver, instead of
each surface re-deriving it (or not). Note `_accountLabel` (`journal-report-plugin.js:528`) is
exactly the mapper we want — it exists, but privately, for one dropdown. §70 **generalizes it**.

---

## 4. The tension — why the key is not simply renamed to the name

Three properties make the stateKey identity, not a label, and rule out "key = name":

- **Non-unique** — two accounts can both be named "Savings"; the key must disambiguate.
- **Mutable name** — renaming an account must *not* re-key it, or every `acct.<sk>.*` param orphans,
  the journal history splits, and saved MC/Opt/MPC overrides drop. So name and key must be separable.
- **Encoded** — `acct.<sk>.<field>` and the `account.balance` substring require a safe identifier
  (camelCase, no spaces/dots); "Shared Checking (Joint)" cannot be a raw key.

Therefore: **keep the stableKey as hidden identity; show the (mutable, non-unique) name on top.** A
display layer is the correct shape — and it is inherently robust to duplicate names (the key stays
the tiebreaker under the hood) and to renames (the resolver re-reads the current name each load).

---

## 5. Chosen model — one display-name resolver, config stays keyed by stateKey

Introduce a single resolver populated at load, keyed by `stateKey`:

```
registry.displayNameFor(stateKey) -> string | null      // the label, or null when unknown
```

- **Where it lives — `StateSchemaRegistry`, and the wiring already exists.** `registerAccount(stateKey,
  account)` already receives the **full account** and today reads only its currency
  (`state-schema-registry.js:345`); extend it to also retain `{ name, kind }` and expose
  `displayNameFor()`. It is populated by `ScenarioLoader._registerDisplayCurrencies`, which already
  walks accounts / real property / collectibles / company equities / **bequests (funded inherited
  keys)** / persons on **both** load paths — so the name map lands exactly where the currency stamps
  already do, with no new registration pass.
- **Both consumers already hold the registry.** The **State panel view already has
  `this._schemaRegistry`** (set via its setter, used for currency at `state-panel-view.js:1580-1607`) —
  so P2 needs *zero* new wiring. The registry is bus-shared (design 10), so the **journal** side reaches
  the same instance (threaded through the query api, §6.2). One resolver, one source of truth, both
  sides.
- **The canonical label = generalize `_accountLabel`.** `_accountLabel(account)` =
  `` `${country} ${name || stateKey}` `` (`journal-report-plugin.js:797`) is *already* the mapper the
  journal filter dropdown and (in spirit) the Holdings dropdown use. Lift this one function into the
  registry as the label rule so every surface reads identically instead of re-deriving it.
- **Fallback contract.** `displayNameFor(sk) ?? toLabel(sk)` — a key with no registered name (a bare
  metric, an intermediate state path) still renders its beautified key, so nothing regresses.
- **Duplicate names.** When two accounts share a name, the resolver returns a disambiguated label
  (append the owner, or `· <shortkey>`) so rows stay distinguishable; the key remains the underlying
  identity for selection/history.

The **serialized config never changes** — the resolver is derived from records on every load, exactly
like the currency stamps. No new persisted field, no double-serialize, no migration.

## 6. Per-surface reroute

### 6.1 State / Metrics panel (`state-panel-view.js`)
Accounts/assets render as **collapsible sections**: `renderState` emits
`_appendCollapsibleSection({ label: k, … })` with `k` = the raw stateKey (`:353`), and the header runs
it through `toLabel` (`:1692`). The reroute is one line at each section/row site — resolve the name and
skip the beautifier when one is found:

```
const name = this._schemaRegistry?.displayNameFor(k);
_appendCollapsibleSection({ label: name ?? k, alreadyLabel: name != null, … });
```

`displayNameFor(k)` returning non-null **is** the "this key is an account/asset" signal — no
account-type enumeration needed. The same swap applies to the metric rows (`metrics.<stateKey>` at
`:271`/`:360`) and the field-history modal title (`:722`). Sub-field rows (`.balance`, `.holdings…`)
inherit the account name from their section header. Optionally keep the raw key as a `title=` tooltip so
power users still see identity.

### 6.2 Journal reports (`report-definition-registry.js` + `journal-report-plugin.js`)
The per-account reports set `defaultGroupBy = ['stateKey']` (`:310`), and the plugin renders each group
cell as `String(g.key[f] ?? '—')` verbatim (`_renderResults`, `journal-report-plugin.js:604-608`) — so
the user sees the full journal-row path, e.g. `usSavingsAccount.balance`. Two changes:

- **Show the name, keep the identity.** Give each group a parallel `labels` map alongside `g.key`. The
  account reports override the existing `decorate(groups)` hook (`report-definition-registry.js:96`,
  extended to `decorate(groups, api)`) to set
  `g.labels.stateKey = api.displayNameFor(accountKeyOf(g.key.stateKey)) ?? g.key.stateKey`, where
  `accountKeyOf` strips the trailing `.balance`/`.<field>` to recover the bare account key. The plugin
  renders `g.labels?.[f] ?? String(g.key[f] ?? '—')`. `g.key` is untouched, so expand-to-entries and
  history keying (`dataset.key`, `:205-207`) still work on the stable identity.
- **Thread the resolver through the api.** The apis are built as
  `new JournalQueryApi(dataSource, typeRegistry, periodService)` (`journal-report-plugin.js:223-225`) —
  no registry today. Add the schema registry so `api.displayNameFor(sk)` and `api.accountBalanceKeys()`
  exist for both `buildQuery` and `decorate`.

### 6.3 §14.6 retire (fold-in)
With `api.accountBalanceKeys()` available, replace the fragile substring selector
`{ op:'contains', field:'stateKey', value:'account.balance' }` — present in every per-account report
(`report-definition-registry.js:328, 369, 404, 439, 637, 726`) — with the real OR-of-prefixes over the
effective account set, generalizing `_appendAccountStateKeyFilter` (`:126`, which already does this for
*selected* accounts): `_appendAccountStateKeyFilter(conditions, accountStateKeys ?? api.accountBalanceKeys())`.
This removes the `…Account`-suffix dependency for good — a future inherited/legacy key lacking `account`
(the bug that bit `beq1_a1`) is still selected. Existing `…Account` keys select exactly as before.

### 6.4 Chart series / field-history labels
Route the same `displayNameFor` for a charted per-account series and the history modal so they read by
name (the state panel already owns both — §6.1).

## 7. Cosmetic leftovers folded in
- **Sale-handler legacy key in `RecordBalanceAction`** (reporting-only, no money impact) — once the
  journal renders names via the resolver, the legacy key stops being *user-visible* even where it is
  still *recorded*; whether to also normalize the recorded key is a separate, optional cleanup.
- **Role-vs-type key oddity** (`usSavings2Account` for a checking account) — the display layer makes
  the misleading key invisible to the user; fixing the *generator* to derive from name/type is Axis B
  (§9), not needed once the name shows.

## 8. Phasing — ALL COMPLETE

**Decisions locked at implementation** (the doc left these open):
- **Label rule** = country-prefixed `${country} ${name}` (the lifted `_accountLabel`), so the state
  panel, the journal rows, and the facet dropdown read a record identically. A countryless record
  renders the bare name; a nameless one falls back to its own stateKey.
- **Duplicate names** = collision-only suffix: unique names are never decorated; colliding ones take
  `· <owner>` when the owner separates them, else `· <stateKey>`. Labels are therefore derived
  **lazily** — persons register *after* accounts in `_registerDisplayCurrencies`, so a label computed
  eagerly at `registerAccount` could not see the owner name that disambiguates it.
- **Key visibility** = the raw key is kept as a `title=` tooltip on section headers, field/static
  rows, the history-modal title, and renamed journal group cells.
- **Coverage** = accounts + real property / collectibles / equities + persons + inline bequest assets
  (which are plain descriptors, not model instances, so `_registerDisplayCurrencies` calls
  `registerDisplayRecord` for them explicitly; `kind` follows `__type` so a bequeathed property is
  not mistaken for an account by `accountBalanceKeys()`).

- **P1 — resolver. DONE.** `StateSchemaRegistry.registerDisplayRecord(stateKey, record, kind)` retains
  `{ name, country, ownerId, kind }`; `registerAccount` / `registerAsset` / `registerPerson` call it
  for free, and `_registerDisplayCurrencies` calls it directly for inline bequest assets.
  `displayNameFor(stateKey)` returns the label or **null** (callers own the `?? toLabel` fallback);
  `accountBalanceKeys()` returns the `<sk>.balance` paths of account-kind records. Labels are built in
  one lazy `_rebuildLabels()` pass, invalidated by any new registration. 16 unit tests
  (`tests/unit/display-name-resolver.test.mjs`).
- **P2 — State/Metrics panel. DONE.** `_displayName(path)` on the view resolves section headers,
  numeric rows, static rows, and metric rows (`renderState` / `_renderMetricsPanel`), passing
  `alreadyLabel` so a resolved name is not re-beautified. Added `_pathLabel(path)`, which resolves the
  *owning* record for a field path — `usSavings2Account.balance` → "US Shared Checking — Balance" —
  and backs the history-modal title. No new wiring, as predicted. 8 viz tests.
- **P3 — Journal names. DONE.** `JournalQueryApi` takes the schema registry as a 4th ctor arg and
  exposes `displayNameFor()` / `accountBalanceKeys()`; the plugin passes `svc.schemaRegistry` to all
  three constructions and calls `def.decorate(result.groups, api)`. The four stateKey-grouped reports
  share `_labelAccountGroups(groups, api)`, which sets `g.labels.stateKey` via `_accountKeyOf()` and
  leaves `g.key` untouched (asserted by test — expand-to-entries keys off it). `_renderResults` renders
  `g.labels?.[f] ?? g.key[f]` with the raw key as the cell tooltip. The facet dropdown now reads the
  resolver too, so filter and rows agree; `_accountLabel` survives only as the no-registry fallback.
  4 viz tests.
- **P4 — §14.6 retire. DONE.** All six sites now call `_appendAccountBalanceScope(conditions,
  accountStateKeys, api)`, an exact `in` over the selected accounts' `.balance` paths, defaulting to
  `api.accountBalanceKeys()`. This is *more* precise than the substring it replaces (which also
  depended on `contains` being case-insensitive), and it degrades to the old substring when no
  registry is bound to the api. 4 unit tests, including both regression directions.

**Verified**: 3707 unit / 892 viz green; reference golden unmoved (headless
`fin-sim-scenarios.json` net worth 27,569,102).

## 9. Deferred / documented-only
- **Axis B — key generation ergonomics** (separate design): derive a *new* account's key from its
  **name-at-creation** (slugified) instead of its role, and/or a user-editable key field, both with a
  `…Account` guard (so §14.6-style invisibility can't be reintroduced). Freezes at creation (a rename
  never re-keys). Existing keys are **not** touched — the §70 display layer makes their spelling moot.
- **`scripts/run-scenario.mjs` tables** still print raw stateKeys. It reads the runtime state map
  directly and is a headless dev tool, not one of the §1 user-facing surfaces, so it was left alone;
  routing it through the resolver is a one-line follow-up if the raw keys ever get in the way.
- **Full key migration** (existing `usSavings2Account` → readable): breaking (param keys + journal
  history); needs an alias map + rewrite pass + history-continuity strategy. Not planned — the display
  layer removes the motivation.

## 10. Regression guard
The resolver is derived from records on every load; for any scenario it returns the same names the
records already hold, and `?? toLabel(key)` preserves today's output wherever a name is absent. No
stateKey, param key, or serialized field changes, so the reference golden and every param/opt key are
byte-identical. The §14.6 change only widens which balance rows a per-account report *can* select
(previously-excluded non-`…Account` keys); existing `…Account` keys select exactly as before.
