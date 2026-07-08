# 55 — Configuration-driven (dynamic) parameters

**Status**: **Implemented** through Phase 6b. Phases 1–4 shipped as designed; §7's
transaction account was then extended from "expenses + intl-transfer only" to the
**whole-household cash hub** by Phases 6a/6b (see §7.4 and §12). There was never a
Phase 5 — the numbering jumps 4 → 6a/6b because 6 groups the "make the flag actually
apply everywhere" follow-ups that surfaced during real-scenario testing.

Make the exposed parameter surface a **function of the configuration** instead of a
hand-maintained static list. Today `INTL_RETIREMENT_PARAM_SCHEMA` hard-codes ~50
entries, each bound to one fixed record (`rothAccount`, `spouseRothAccount`,
`usHouseProperty`, `primary`, `spouse`…). Adding a second brokerage, a third
property, or a single-person household means editing that array by hand — and the
"prebuilt scenario" concept forces one frozen shape per configuration. This design
**generates one parameter per domain record from a per-type template at
Build/Rebuild time**, so account/people/property counts and types become flexible
without touching the schema.

**Builds on**:
- `design/13-prebuilt-scenario-parameters.md` — typed param round-tripping (the
  `params` array ⇄ `parameters` map contract).
- `design/32-param-field-linking.md` — the param↔domain-field linking + the
  **harvest-on-Rebuild** rule that resolves the "did the user edit the param or the
  record?" duality. Generated per-record params are *linked fields* in that sense.
- `design/15-config-as-source-of-truth.md` — records are the bootstrap source of truth.
- The existing param→record cascade: `ScenarioLoader._applyParamNode`
  (`scenario-loader.js:279-363`) and `BaseScenario.applyParams`
  (`base-scenario.js:160-206`).
- `design/35` (owner ordering), `design/34` (state tax), `design/27` (per-person
  lifespan) — which already generalized handlers off `primary`/`spouse` onto
  `ownerId` + `state.people`, so the *domain* layer is already N-record-ready; this
  design closes the **parameter** layer's gap.

### Decisions locked (see §"Decisions")
1. **Params drive records.** Generated params stay the primary edit surface and
   cascade onto their record via a per-record `node` (today's mechanism, extended).
2. **Transaction Account = boolean flag on the account** (`isTransactionAccount`),
   one per country of residence; handlers resolve the debit/replenish target from it.
3. **Per-account rates.** Growth/dividend/interest become per-account (the earnings
   handlers already loop per-account — they just read a global rate today).
4. **Phased migration.** Generator covers per-record params; global/optimization/
   cross-border params stay static. Old per-record entries retire behind an alias.

---

## 1. Problem — the schema is static; the configuration is not

`INTL_RETIREMENT_PARAM_SCHEMA` (`intl-retirement-scenario.js:248-583`) enumerates a
parameter for *each specific* account/person/property by fixed key and `stateKey`:

```js
{ key:'rothBalance',       node:{ type:'account', stateKey:'rothAccount',       field:'balance' } },
{ key:'spouseRothBalance', node:{ type:'account', stateKey:'spouseRothAccount', field:'balance' } },
{ key:'usHouseSaleYear',   node:{ type:'realProperty', stateKey:'usHouseProperty', field:'plannedSaleYear' } },
```

Consequences:
- **Counts are frozen.** A third IRA, a second AU property, or a one-person
  household has no parameter surface — even though the *domain* services already
  hold arbitrary-length `accounts` / `persons` / `realProperties` arrays and the
  toolsets already iterate them per-record (`us-retirement-toolset.js:681`
  `for (const acct of iraAccounts)`).
- **The prebuilt scenario is a straitjacket.** Each configuration wants its own
  frozen `buildDefaultConfig`; the user wants to reshape a scenario (add/remove
  accounts, switch a checking account in) and have parameters follow.
- **Rates are mis-scoped.** `iraGrowthRate`/`rothGrowthRate`/… are single global
  params applied to *every* account of that type, so two IRAs cannot grow at
  different rates even though each already gets its own earnings handler.

The domain records already carry everything needed to derive parameters: stable
`stateKey`/`id`, `type`, `role`, `country`, `ownerId`, and the field values
themselves. The parameter list should be **derived from them**, not maintained
alongside them.

---

## 2. Core idea — templates × records ⇒ parameters

Introduce a **parameter template per record type**, and a **generator** that walks
the live records and emits one typed param entry per (record × template-field) at
Build/Rebuild time. The generated entries are merged into the schema exactly like
toolset param entries are today (`ScenarioLoader._mergeParamSchema`,
`scenario-loader.js:408`).

```
 domain records (N)              per-type templates                generated params
 ─────────────────      ×      ────────────────────      ⇒      ──────────────────────
 rothAccount (roth)            ROTH:  balance, basis,           acct.rothAccount.balance
 spouseRothAccount (roth)             growthRate               acct.rothAccount.growthRate
 usSavings (savings)           SAVINGS: balance, min,           acct.spouseRothAccount.balance
 usHouse (realProperty)                interestRate, isTxn      …
 primary (person)              PERSON: wage, retireDate,        person.primary.monthlyWage
                                       lifeExpectancy           prop.usHouse.plannedSaleYear
```

Because a generated param carries a per-record `node`, **all existing machinery
works unchanged**: `_applyParamNode` already fans a value onto `cfg.accounts` /
`cfg.persons` / `cfg.realProperties` / `cfg.companyEquities` found by
`stateKey`/`id` (`scenario-loader.js:280-302`), and `applyParams` does the live-node
equivalent (`base-scenario.js:179-205`). The generator produces `node`s; the cascade
consumes them. Nothing about the cascade needs a per-record special case.

---

## 3. Parameter identity & key scheme

Generated params need stable, collision-free, decodable keys (MC/Opt configs and
saved scenarios reference params by key — `intl-retirement-mc-runner.js` writes
`cfg.parameters[paramKey] = sample`).

```
acct.<stateKey>.<field>      e.g. acct.rothAccount.balance, acct.usSavings.isTransactionAccount
person.<id>.<field>          e.g. person.primary.monthlyWage
prop.<stateKey>.<field>      e.g. prop.usHouseProperty.plannedSaleYear
coll.<stateKey>.<field>      (collectibles — template ready, no fields yet)
equity.<stateKey>.<field>    (company equity — template ready, no fields yet)
```

Properties of the scheme:
- **Stable across Rebuilds** because `stateKey`/`id` are stable (assigned once and
  serialized). Renaming an account's *display name* does not change its key.
- **Decodable** — the cascade can derive the `node` from the key alone if the
  persisted `node` is ever missing (defensive; the generator always emits `node`).
- **Namespaced** so it never collides with the retained flat global keys
  (`iraGrowthRate`, `inflationRate`, `moveYear`, optimization keys…).

The keys are **not** compiler keys: the compiler/toolsets read per-account values
off the **record** (via the node cascade), not off `cfg.parameters[key]`. So a
generated key only has to be unique and carry a `node` — it never needs to match a
name the toolset reads. This is the clean separation that keeps the generator
decoupled from toolset internals.

### 3.1 Prerequisite — every record must have a `stateKey`

This scheme keys params off `stateKey`/`id`, and — separately — the **runtime-state
projection** keys `sim.state` entries off `stateKey` too (`_accountToStatePlain` in
the retirement toolsets seeds `state[account.stateKey]`; `SimulationState._assignAccount`
stamps the key). Today a `stateKey` is stamped **only for accounts the prebuilt
scenario wires by name** (`_assignAccount` is called with a literal key like
`usSavingsAccount`). A record created through the **account editor** or a Config-List
"add" gets **no `stateKey`**, so it never lands in `sim.state` *and* generates no
params — the "add a record + Rebuild → it works" premise silently fails for it.

This design therefore **depends on `stateKey` assignment at record creation**: when a
record is created without one, derive a unique, stable, camelCase slug (e.g. from the
display name, deduped against existing keys), stamp it on the record, and serialize it
so it stays stable across Rebuilds (the stability §3 relies on). Assign it at the
create path (`AccountsController.create` / the service `createAccount`) or as a
compile-time normalization pass over `cfg.accounts`/`persons`/`realProperties` before
generation — the latter also heals older saves.

**Concrete instance that surfaced this** (design 53 §3 OffsetAccount): a user created
an `OffsetAccount` in the editor with `offsetsPropertyKey` set correctly, but with no
`stateKey` it never entered `sim.state`, so `offsetBalanceForLoan` couldn't find it and
the offset silently did nothing — the engine wiring was correct; only the record→state
bridge was missing. (Note also: the same `_accountToStatePlain` projection must carry
any **new per-account field the handlers read at runtime** — §8's `growthRate` etc.,
and design 53's `offsetsPropertyKey` — not just `toJSON`; a field present on the record
but dropped by the projection is invisible to handlers.)

---

## 4. The template registry

A small declarative registry, keyed by record type. Each field entry mirrors the
metadata a static schema entry carries (label, type, group, mc/opt flags, default),
plus a `field` naming the record property it binds.

```js
// src/scenarios/params/record-param-templates.js
export const ACCOUNT_PARAM_TEMPLATES = {
  [ACCOUNT_TYPE.SAVINGS]: [
    { field: 'balance',            type: 'Number',  mc: true,  opt: false, money: true },
    { field: 'minimumBalance',     type: 'Number',  mc: false, opt: true,  money: true },
    { field: 'interestRate',       type: 'Number',  mc: true,  opt: false },
    { field: 'isTransactionAccount', type: 'Boolean', mc: false, opt: false },
  ],
  [ACCOUNT_TYPE.CHECKING]: [ /* same as savings */ ],
  [ACCOUNT_TYPE.BROKERAGE]: [
    { field: 'balance',            type: 'Number',  mc: true,  money: true },
    { field: 'growthRate',         type: 'Number',  mc: true },
    { field: 'dividendRate',       type: 'Number',  mc: true },
    // holdings/basis stay in the account editor (per-lot) — not flattened to a param
  ],
  [ACCOUNT_TYPE.ROTH]: [
    { field: 'balance',            type: 'Number',  mc: true,  money: true },
    { field: 'contributionBasis',  type: 'Number',  mc: false, opt: true, money: true },
    { field: 'growthRate',         type: 'Number',  mc: true },
  ],
  [ACCOUNT_TYPE.TRADITIONAL_IRA]: [ /* balance, contributionBasis, growthRate */ ],
  [ACCOUNT_TYPE.FOUR_OH_ONE_K]:   [ /* balance, contributionBasis, growthRate */ ],
  [ACCOUNT_TYPE.SUPER]:           [ /* balance, contributionBasis, growthRate */ ],
};

export const PERSON_PARAM_TEMPLATE = [
  { field: 'monthlyWage',          type: 'Money',   mc: true,  opt: true },
  { field: 'retirementDate',       type: 'Date',    mc: false, opt: true },
  { field: 'socialSecurityMonthly',type: 'Money',   mc: false, opt: true },
  { field: 'residencyState',       type: 'Enum',    options: ['', 'NE', 'HI', 'SD'], mc: true, opt: true },
  { field: 'lifeExpectancy',       type: 'Number',  mc: true,  opt: false },
];

export const REAL_PROPERTY_PARAM_TEMPLATE = [
  { field: 'value',                type: 'Number',  mc: true,  money: true },
  { field: 'appreciationRate',     type: 'Number',  mc: true },
  { field: 'plannedSaleYear',      type: 'Number',  mc: true,  opt: true, nullable: true },
];

// Ready but empty until these assets grow parameters (per the Overview).
export const COLLECTIBLE_PARAM_TEMPLATE   = [];
export const COMPANY_EQUITY_PARAM_TEMPLATE = [];
```

**Label / group derivation.** Labels come from the record's display name +
field label (`"Roth IRA (Spouse) — Balance"`); groups come from the record so the
UI naturally clusters per record: `group = \`${country} · ${account.name}\``
(e.g. `"US · Roth IRA (Spouse)"`). This gives one collapsible section per record in
the Scenario editor without any hand-authored group names.

**Currency.** `money: true` fields become design-10 `Money` params seeded with the
record's native `currency` (from `account.currency.code`) — the generator sets
`defaultCurrency` + `currencyStateKeys: ['<stateKey>.<field>']` so the existing
display-currency plumbing (`scenario-loader.js:152-156`, `_registerDisplayCurrencies`)
lights up for free.

**Template lookup key.** Accounts key off `account.type` (`ACCOUNT_TYPE`), which is
already stamped on every account (`account.js:99`). Falls back to a role→type map
for legacy records missing `type`.

---

## 5. The generator

```js
// src/scenarios/params/scenario-param-generator.js
export class ScenarioParamGenerator {
  /** Derive per-record schema entries from a cfg's domain records. */
  static generate(cfg) {
    const out = [];
    for (const a of cfg.accounts ?? [])
      out.push(...expand('acct',   a, a.stateKey, ACCOUNT_PARAM_TEMPLATES[a.type] ?? []));
    for (const p of cfg.persons ?? [])
      out.push(...expand('person', p, p.id,       PERSON_PARAM_TEMPLATE));
    for (const r of cfg.realProperties ?? [])
      out.push(...expand('prop',   r, r.stateKey, REAL_PROPERTY_PARAM_TEMPLATE));
    for (const c of cfg.collectibles ?? [])
      out.push(...expand('coll',   c, c.stateKey, COLLECTIBLE_PARAM_TEMPLATE));
    for (const e of cfg.companyEquities ?? [])
      out.push(...expand('equity', e, e.stateKey, COMPANY_EQUITY_PARAM_TEMPLATE));
    return out;
  }
}
// expand() builds { key, label, type, group, defaultValue: record[field], node, mc, opt, … }
// node = { type:'account'|'person'|'realProperty'|'companyEquity', stateKey|id, field }
```

**Where it runs.** In `ScenarioLoader._compileFromToolsets`
(`scenario-loader.js:371-391`), *after* the post-compile re-snapshot of
`cfg.accounts`/`cfg.persons`/… from the services (so the records are authoritative
and reflect any cascade already applied), the loader concatenates
`ScenarioParamGenerator.generate(cfg)` into the `combinedSchema` handed to
`_mergeParamSchema`. Concretely `_mergeParamSchema` gains a third source ranked
below scenario-class entries and toolset entries but above nothing — collision rule:
a generated key never collides with a static key (namespaced), so ordering is only
about dedup of two records sharing a stateKey (a bug — warn).

**Value seeding = the record.** `expand()` sets `defaultValue = record[field]`, so
`_mergeParamSchema._toEntry` seeds `entry.value` from the record's current value
when `cfg.parameters` has no override. The generated param therefore *starts equal
to the record*; the cascade writing it back is a no-op until the user (or MC/Opt)
changes it. This is the round-trip-stable invariant.

---

## 6. Editing & the harvest-on-Rebuild rule (design 32)

Chosen model: **params drive records.** The subtlety design 32 already solved:
a per-record field can be edited in *two* places — the generated param (Scenario
editor) or the record itself (Accounts/People editor). If the param→record cascade
ran blind on Rebuild, a direct domain edit would be clobbered by the stale param.

**Rule (reused verbatim from design 32):** generated per-record params are *linked
fields*. On Rebuild, **harvest the record value back into the param first**
(record→param), *then* run the param→record cascade (now a no-op for unchanged
fields). Net effect:
- Edit the param → cascade writes the record. ✓
- Edit the record directly → harvest lifts it into the param; cascade writes it
  back unchanged. ✓ (no clobber)
- MC/Opt set `cfg.parameters[key]` → that override beats the harvest and cascades. ✓

Implementation: the generator's `defaultValue = record[field]` *is* the harvest for
the fresh-load path; for the persisted-params path, `_mergeParamSchema` must, for
**generated keys only**, refresh `p.value` from the record instead of leaving a
stale persisted value (a targeted exception to the "backfill only when undefined"
rule at `scenario-loader.js:496`). This is exactly the design-32 harvest, scoped to
generated keys by their `acct.`/`person.`/`prop.` prefix.

---

## 7. Transaction Account (the withdraw-from account)

### 7.1 Today
`MonthlyExpensesHandler.call` picks the debit target by **role**
(`monthly-expenses-handler.js:106-108`): `US_SAVINGS`+ownerId pre-move,
`AU_SAVINGS`+ownerId post-move → `targetKey` → `EXPENSE_DEBIT`/`REPLENISH_SAVINGS`.
There's no way to say "withdraw from my *checking* account instead."

### 7.2 Change
Add `isTransactionAccount: boolean` to `Account` (default `false`). Exactly **one**
account per country of residence should carry it. Resolution moves to a shared
helper:

```js
// StateRegistry (or AccountService)
resolveTransactionAccountKey(state, country, ownerId) {
  // 1. account in `country` with isTransactionAccount === true (prefer ownerId match)
  // 2. fallback: existing SAVINGS-role lookup (back-compat for scenarios pre-flag)
}
```

Consumers switch from the role lookup to the helper:
- `MonthlyExpensesHandler` (`:106`) — debit/replenish target.
- `IntlTransferApplyReducer` (`intl-transfer-apply-reducer.js:87,109`) — the
  `usSavingsKey`/`auSavingsKey` sweep targets resolve through the same helper.
- `replenishSavings` still *excludes the target* and treats other cash roles as
  liquid (`account-service.js:488-489`) — unchanged; only which key is "the target"
  changes.

### 7.3 Marking it
`isTransactionAccount` is a generated **Boolean param** (from the SAVINGS/CHECKING
template), so the user flips it in the Scenario editor per account; the cascade
writes the flag onto the account record. A **validator** (in the generator or a
compile-time check) warns when a country of residence has zero or >1 flagged
accounts, and the resolver's role fallback keeps zero-flag scenarios working.

Because the flag lives on the account and the resolver scans by country, a **Checking
account** the user adds and flags becomes the transaction account with no code
change — satisfying "a Savings or Checking account of the user's choosing."

### 7.4 The transaction account is the whole-household cash hub (Phases 6a/6b)

§7.2 as originally shipped (Phase 3) only rerouted **two** flows — `MonthlyExpensesHandler`
(expenses out) and `IntlTransferApplyReducer` (cross-border sweeps). Every *other*
cash movement still hit the canonical `state.usSavingsAccount ?? state.checkingAccount`
literal, so a flagged non-default account was honored for expenses but **bypassed** for
wages, contributions, withdrawals, taxes, sales, and mortgage/loan payments. Real-scenario
testing (a Checking account flagged as the hub) exposed this. Phases 6a and 6b close it so
the flag applies to *both* directions of *every* household cash flow.

**Phase 6a — inflow + per-account savings interest.**
- **Wages route in** to the flag: `MonthlyWagesHandler` resolves
  `resolveTransactionAccountKey(country, personKey) ?? getStateKey(role) ?? default` and
  stamps `targetKey` on `WAGES_INCOME_APPLY` / `AU_WAGES_INCOME_APPLY`; the reducers credit
  `state[targetKey] ?? usCash/auCash(state)`. The hub now receives wages **and** pays
  expenses (Phase 3 was expenses-only).
- **Savings interest is per-account.** The interest handlers/reducers take a `stateKey`
  (ctor arg + stamped on `US_SAVINGS_INTEREST_CREDIT` / `AU_SAVINGS_EARNINGS_APPLY`) and
  credit `action.stateKey ?? canonicalKey`, so a second/renamed savings account (e.g. a
  spouse's) earns its **own** interest instead of having it misattributed to the single
  canonical key. Same latent single-key bug fixed for US fixed-income here and AU
  fixed-income in 6b.

**Phase 6b — route the remaining ~55 debit/credit sites through one helper.**
New `src/finance/account-rules/cash-routing.js`:

```js
resolveCashKey(stateRegistry, country, state, ownerId = null)
// resolveTransactionAccountKey?.(country, ownerId)          // the flag (owner-preferred)
//   ?? getStateKey?.(savingsRole, ownerId) ?? getStateKey?.(savingsRole)   // savings role
//   ?? legacy usSavingsAccount/auSavingsAccount ?? checkingAccount         // pre-flag tail
// guarded so a resolved key absent from `state` falls back to the legacy literal;
// returns a key guaranteed present, so call sites are just state[resolveCashKey(...)].
```

`state` is a parameter (the sketch in §7.2 omitted it) because both the `checkingAccount`
tail and the existence guard read live state. Method-level `?.()` is load-bearing — several
test stubs supply a partial `stateRegistry` with only `getStateKey`.

Two wiring patterns, matching how each site already worked:
- **Reducer-resolves** (contributions, withdrawals, RMDs, brokerage buys/sells, super,
  income credits, house/collectible sales): the `usCash(state)`/`auCash(state)` /
  `destinationKey ?? default` debit is replaced by `resolveCashKey`. `stateRegistry` is
  threaded into the reducer constructor — cheap because `AccountServiceReducer.fromJSON`
  already passes the full `services` context (so deserialized reducers get it for free); the
  toolsets pass `stateRegistry: sr` at fresh-compile construction.
- **Stamp-on-action** (`UsMortgagePaymentHandler` legacy, `Us/AuRentalIncomeHandler`, and the
  active design-54 `LoanPaymentHandler`): the *handler* resolves and stamps `cashKey` on the
  APPLY action (it also drives `REPLENISH_SAVINGS` + the min-balance check); the reducer keeps
  `state[action.cashKey] ?? legacy`. The loan handler's local resolver became
  `resolveLoanCashKey(sr, state, loan)` = `paymentSourceKey ?? resolveCashKey(...)` so an
  explicit per-loan payment source still wins.

**Deliberately left legacy:** the *journal* `RecordBalanceAction` in the stateless income
handlers still names the canonical savings key. That is cosmetic (a per-event balance
snapshot for reporting) — the **reducer** does the real money routing, and year-end syncs
capture the true balances. This matches the precedent 6a set for `WagesIncomeHandler`.

**Net effect:** flag any one account per country and *all* of that country's cash — in and
out — flows through it; the former default savings account is spared (accrues its own
interest only). With nothing flagged the chain returns the SAVINGS-role key, so pre-flag
scenarios are byte-for-byte unchanged.

---

## 8. Per-account rates

The earnings handlers **already loop per-account** and are handed a rate; they just
receive the *global* param today (`us-retirement-toolset.js:681-686`,
`growthRate: p.iraGrowthRate`). Two-line change per handler:

1. Account carries the rate field (`growthRate` / `dividendRate` / `interestRate`),
   generated as a per-account param (§4) and serialized (§11).
2. The toolset passes `growthRate: acct.growthRate ?? p.iraGrowthRate` — the global
   param becomes the **template default / fallback**, not the value. (Or the handler
   reads `state[stateKey].growthRate` at runtime; passing at construction matches the
   current pattern and is less invasive.)

The global `iraGrowthRate`/… params **stay** in the toolset schema as the default
seed for newly-added accounts and as a back-compat MC/Opt target. Result: two IRAs
can grow at different rates; the default keeps single-rate scenarios identical.

---

## 9. UI

No new editor is required — the Scenario tab already renders the `params` array
grouped by `group`, with `Enum`/`Boolean`/`Money`/`Date`/`Number` widgets and
`visibleWhen`/`dynamicOptionsFrom` support. Generated params slot in with a
per-record `group`, so the editor shows one collapsible section per account/person/
property automatically. Adding a record (Config-List "add") + Rebuild makes its
params appear; deleting it makes them disappear — the generator is the single
source of truth for which params exist.

Optional polish (out of scope for phase 1): a compact "Accounts" master view that
lets you add/remove/flag accounts inline rather than via Config-List.

---

## 10. Monte Carlo & Optimization

- Generated params are valid MC/Opt targets: MC writes `cfg.parameters[key]`, the
  cascade applies it to the record before compile — same path as `usHouseSaleYear`
  today. `paramKey` in an MC config just uses the generated key
  (`acct.rothAccount.growthRate`).
- **Migration for existing MC/Opt configs** that reference the old flat keys
  (`rothGrowthRate`, `spouseRothBalance`): keep the global rate keys working (they
  seed *all* accounts of a type lacking an explicit value — §8), and provide an
  alias map (§11) so `spouseRothBalance` resolves to `acct.spouseRothAccount.balance`.
- Note the shadowing rule for MC authors: once a per-account rate param carries an
  explicit value, sweeping the *global* rate no longer moves that account. Doc it;
  the MC config UI reads labels from the schema so the per-account entries are
  discoverable.

---

## 11. Serialization, back-compat, migration

- **New account fields** (`growthRate`, `dividendRate`, `interestRate`,
  `isTransactionAccount`) are added to `Account`/subclass `toJSON`/`fromJSON` and the
  account serializer. Absent on old saves → `undefined` → handlers fall back to the
  global rate / role lookup, so legacy scenarios are byte-for-byte unchanged.
- **Old per-record param keys** (`rothBalance`, `spouseRothBalance`,
  `usHouseSaleYear`, `initialUsSavings`, …) are removed from
  `INTL_RETIREMENT_PARAM_SCHEMA` once the generator covers them. To keep saved
  scenarios and MC/Opt configs alive, add a one-time **alias map**
  `{ rothBalance: 'acct.rothAccount.balance', … }` consulted in `_normalizeParams`:
  a persisted param whose key is an alias is rewritten to the generated key (and its
  value carried over) before the cascade. Aliases can be dropped after a deprecation
  window.
- **Drift-merge** (`_driftMergeDomainRecords`, `scenario-loader.js:538`) already
  re-adds missing default records by key; combined with the generator, a stale save
  that predates a new default account gets both the record *and* its params on the
  next Rebuild.
- Round-trip tests: `scenario-roundtrip`, `serializer-finance-roundtrip` extended
  with a legacy fixture (flat keys, no rate fields) asserting identical sim output.

---

## 12. Phased plan

Ordered so each phase is independently shippable and green.

### Phase 1 — Generator for balances/basis + the record→param plumbing
*No behavior change; the generated params must produce the same numbers as the
static ones they replace.*
1. `record-param-templates.js` (accounts: balance + contributionBasis only;
   persons: wage/retirementDate; properties: value/appreciationRate/plannedSaleYear).
2. `ScenarioParamGenerator.generate(cfg)`; wire into `_mergeParamSchema` with the
   generated-key harvest exception (§6).
3. Alias map for the retired per-record keys; retire those entries from
   `INTL_RETIREMENT_PARAM_SCHEMA`.
4. **Exit test**: a scenario built via generator produces byte-identical
   `sim.state` to the static-schema baseline; `scenario-roundtrip` +
   `intl-retirement-scenario` green; legacy-fixture round-trip green.

### Phase 2 — Per-account rates
1. Add `growthRate`/`dividendRate`/`interestRate` to `Account` + serializer.
2. Templates gain the rate fields; toolsets read `acct.<rate> ?? p.<globalRate>`.
3. **Exit test**: two same-type accounts with different rates diverge as expected;
   single-rate scenarios unchanged; `evt-*` earnings suites green.

### Phase 3 — Transaction Account flag
1. `isTransactionAccount` on `Account` + serializer + SAVINGS/CHECKING template.
2. `resolveTransactionAccountKey` helper; switch `MonthlyExpensesHandler` +
   `IntlTransferApplyReducer` to it (role fallback retained).
3. Per-country zero/multi-flag validator (warn).
4. **Exit test**: flag a CHECKING account → expenses debit it; unflagged scenario
   falls back to SAVINGS role and is unchanged. New `evt-transaction-account.test.mjs`.

### Phase 4 — Flexible counts & the long tail
1. Confirm N-of-a-type accounts/people/properties generate params and compile
   (toolsets already iterate per-record); add a 3rd-account + single-person test.
2. Collectible / Company-equity templates: wire the (empty) templates so fields
   added later auto-generate params.
3. Docs: README "Add a scenario parameter" section updated to describe the
   template-driven path; `design/13`/`design/32` cross-links.

*(No Phase 5 was scoped — see §7.4 for why the numbering jumps to Phase 6.)*

### Phase 6 — Transaction account as the whole-household cash hub
*Follow-up surfaced in real-scenario testing: the Phase-3 flag only rerouted expenses +
intl-transfers; every other cash flow bypassed it (§7.4).*

**Phase 6a — inflow + per-account savings interest.**
1. `MonthlyWagesHandler` resolves the transaction account per person and stamps `targetKey`
   on the wages APPLY actions; the wages reducers credit `state[targetKey] ?? cash(state)`.
2. Savings-interest handlers/reducers take a `stateKey` and credit `action.stateKey ??
   canonicalKey` (per-account); fold in the US fixed-income single-key fix.
3. **Exit test**: a spouse's second savings account earns its own interest; the flagged hub
   receives wages *and* pays expenses. `evt-transaction-account.test.mjs` (EVT-TXN-1/2
   updated), new `evt-multi-savings.test.mjs`.

**Phase 6b — route the remaining ~55 debit/credit sites through `resolveCashKey`.**
1. New `cash-routing.js` `resolveCashKey(stateRegistry, country, state, ownerId)` — the
   flag → savings-role → legacy chain with a state-existence guard (§7.4).
2. Reducer-resolves sites: swap `usCash/auCash(state)` / `destinationKey ?? default` for
   `resolveCashKey`; thread `stateRegistry` into reducer constructors and pass it at
   toolset construction (deserialization is free via `AccountServiceReducer.fromJSON`).
3. Stamp-on-action sites: route the handler's `cashKey` (mortgage/rental legacy +
   the active design-54 `LoanPaymentHandler`, whose local resolver keeps `paymentSourceKey`
   precedence). Fold in the AU fixed-income single-key fix.
4. **Exit test**: `evt-cash-routing.test.mjs` (CASH-1..7) — flagged account debited/credited
   by 401k/IRA/Roth/super/stock/loan; `paymentSourceKey` precedence; unflagged parity;
   AU-FI per-account round-trip. Full unit + viz green. In-app verification: flagging a
   Checking account makes it the hub (drained by expenses+contributions+taxes+mortgage)
   while the former savings hub is spared; unflagged run byte-for-byte unchanged.

---

## 13. Risks / open questions

- **Harvest-vs-cascade ordering (§6).** The generated-key exception to
  `_mergeParamSchema`'s "backfill only when undefined" is the highest-risk change —
  get it wrong and either domain edits are clobbered or param edits are ignored.
  Mirror design 32's tested harvest path exactly; add a test that edits the record
  directly, Rebuilds, and asserts the edit survives.
- **Two records sharing a stateKey** would collide on key. That's already a latent
  bug (stateKeys must be unique); the generator should `console.warn` and skip dupes
  rather than silently overwrite.
- **stateKey assignment for new records (hard prerequisite — see §3.1).** The whole
  "add a record + Rebuild → it works" premise requires every record to carry a unique
  `stateKey`, but today only prebuilt-enumerated accounts get one (`_assignAccount`);
  editor / Config-List-created records get none and never reach `sim.state` or the
  param surface. Assign a deduped camelCase slug at creation (or in a compile-time
  normalization pass) and serialize it. Surfaced concretely by the design 53
  OffsetAccount, which was created in the editor but never took effect for lack of a
  `stateKey`. Related: any new per-account field handlers read at runtime (§8) must be
  carried by the `_accountToStatePlain` state projection, not just `toJSON`.
- **Global-rate shadowing for MC (§10).** Sweeping a global rate silently no-ops on
  accounts with explicit per-account values. Documented, not fixed — the per-account
  key is the correct target once rates are per-account.
- **Basis/holdings stay out of the param surface.** Per-lot cost basis and holdings
  remain in the account editor (design 25); only the scalar `contributionBasis`
  (retirement) is flattened. Flattening holdings to params is explicitly out of scope.
- **`minimumBalance` is still static (open, post-6b).** The replenish threshold that drives
  `REPLENISH_SAVINGS` is not yet templated — it remains the global `usSavingsMinBalance` /
  `auSavingsMinBalance` params rather than a per-account generated field. Once the transaction
  account can be any flagged account (§7.4), its floor should travel with it; folding
  `minimumBalance` into the SAVINGS/CHECKING template is the natural next per-account field.
- **Prebuilt scenario role.** `buildDefaultConfig` remains the *seed* (the default
  records + global params); it is no longer the *enumerator* of per-record params.
  The Overview's "pivot away from rigid prebuilts" is realized by making the record
  set — not the schema — the thing the user reshapes.

---

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Source of truth for a per-record field | **Params drive records** — generated param carries a per-record `node`; cascade as today, harvest-on-Rebuild to protect direct domain edits. |
| 2 | Transaction Account marking | **Boolean `isTransactionAccount` on the account**, one per country; resolver scans by country with SAVINGS-role fallback. |
| 3 | Rate scope | **Per-account** growth/dividend/interest; global rate params become template defaults/fallbacks. |
| 4 | Migration of ~50 static params | **Phased**: generator covers per-record; globals/optimization/cross-border stay static; old keys retire behind an alias map. |
