# 23 — FX Exchange Service

**Status**: Draft
**Resolves**: `inconsistencies.md` §2.12 (`intl-retirement-state.js` carries `//TODO Move to FX When available`)
**Related**: `design/21-financial-shock-and-regime-framework.md` §10 (this design deletes that shim), `design/9-toolset-compiler.md` (toolset wiring model), `design/11-taxservice-declarative-refactor.md` (the `getContributions()` pattern this borrows)
**Author note**: Lift cross-currency mechanics out of `IntlTransferApplyReducer` and into a real FX service that owns the rate/fee composition, the per-currency settlement registry, and the transfer reducer. Designed to slot underneath the shock-and-regime framework so regime FX adjustments flow through one consistent path.

---

## 1. Problem

Today FX is two flat scalars on state with no service backing them:

```
state.exchangeRateUsdToAud   // 1 USD = N AUD
state.intlTransferFeeUsd     // fixed fee per transfer in USD
```

Both are read directly in three places:

- `IntlTransferToUsHandler` (`intl-transfer-handlers.js:61-62`)
- `IntlTransferToAuHandler` (`intl-transfer-handlers.js:122-123`)
- `IntlTransferApplyReducer` (`intl-transfer-apply-reducer.js:75-76`)

Concrete problems this creates:

1. **No composition surface.** The shock-and-regime framework wants to adjust FX as part of a crisis regime; design 21 §10 introduces a shim that dual-writes `state.exchangeRateUsdToAud` so consumers still work. The shim only exists because there's no single owner of "current effective FX rate."
2. **Hard-coded pair.** Field names bake `UsdToAud` into the state shape. Adding a second pair (`USD_TO_EUR`, `AUD_TO_GBP`) requires touching the state class plus every consumer.
3. **Settlement is wired by string.** `IntlTransferApplyReducer` hard-codes `usSavingsAccount` / `auSavingsAccount` as constructor defaults. The reducer also knows about `accountService.replenishSavings` — an unrelated liquidity concern bolted onto the transfer mechanics.
4. **No registration surface.** There is no API for "this account is my USD settlement account." Today the answer is "convention" (the `usSavingsAccount` state slot) plus a string constructor argument on the reducer.

---

## 2. Goals & Non-Goals

### Goals

- Introduce an **`FxService`** that owns currency-pair registration, rate/fee composition, and the transfer reducer.
- Expose a `getContributions(currencies, ...)` declarative API matching `TaxService`'s shape (design 11), so the `US_AU_CROSS_BORDER` toolset can pull `{ statePatches, events, handlers, reducers }` without calling internal setters.
- Store rates and fees as **base + effective** state pairs so the regime framework's `RegimeApplyReducer` writes the effective value through the same field everyone reads.
- Provide a **per-currency settlement registry** so the toolset wires "USD lands in this account, AUD lands in that account" once, at compile time.
- Delete the design-21 §10 FX shim.

### Non-Goals (deferred)

- **Time-versioned FX modules** (`FxModule2026` / `FxModule2027` like `TaxModule2026`). FX rules don't have year-boundary changes the way tax does; if that need shows up, add it later.
- **Time-series rate schedule.** The base rate is a scalar updated at scenario boot (and optionally by a future `FX_RATE_UPDATE` mechanism). Building a full per-date rate schedule is a separate design — the regime framework already provides the only "rate varies over time" mechanism we need today.
- **Currencies beyond USD / AUD.** The API is pair-generic from day one but only `USD_AUD` ships.
- **FX spreads, bid/ask, intra-day rates.** A transfer uses one composite rate × notional minus a fixed fee. Two-sided pricing is out of scope.
- **Replenishment.** Pulling from investments before a transfer moves into the handler (§7); the FX service does ledger ops, not liquidity sourcing.

---

## 3. Core Concepts

### 3.1 `FxService`

The coordinator. Modeled on `TaxService` (`src/finance/tax-service.js`). One instance, registered with `ServiceRegistry` and reset on every scenario rebuild.

```js
class FxService {
  constructor() {
    this._fxEngine = new FxEngine();
    this._fxEngine.registerPair(new UsdAudPair());     // ships today
  }

  /**
   * Declarative contributions. Returns plain data — no side effects.
   * Matches TaxService.getContributions() shape (design 11).
   */
  getContributions(currencies, accountService, stateRegistry, parameters) { ... }

  get fxEngine() { return this._fxEngine; }
}
```

### 3.2 `FxEngine`

Registry of currency pairs. Pure data; no side effects.

```js
class FxEngine {
  registerPair(pair)              { this._pairs[pair.id] = pair; }
  getPair(fromCurrency, toCurrency) { ... }  // resolves either direction
  pairs()                         { return Object.values(this._pairs); }
}
```

### 3.3 `CurrencyPair`

One per directional pair. Today: `UsdAudPair` (covers both `USD→AUD` and `AUD→USD`; a pair is bidirectional).

```js
class CurrencyPair {
  static id;             // e.g. 'USD_AUD'
  static fromCurrency;   // 'USD'
  static toCurrency;     // 'AUD'

  /**
   * Compose the effective forward rate (fromCurrency → toCurrency)
   * from state and current regime stack. The default implementation
   * reads state.effectiveExchangeRates[this.id]; subclasses can
   * override for pair-specific rules.
   */
  rate(state, direction)  { ... }

  /**
   * Composite fee for a transfer of `notional` units of `fromCurrency`.
   * Default: state.effectiveFxFees[this.id]. Override for tiered fees,
   * percentage fees, etc.
   */
  fee(state, notional, direction) { ... }
}
```

### 3.4 Settlement accounts

Each currency has a registered **settlement account** — the state-key slot that FX transfers debit or credit for that currency. The toolset wires this once at compile time:

```js
fxService.registerSettlement('USD', stateRegistry.getStateKey(ACCOUNT_ROLES.US_SAVINGS, primaryId));
fxService.registerSettlement('AUD', stateRegistry.getStateKey(ACCOUNT_ROLES.AU_SAVINGS, primaryId));
```

A transfer's source/destination accounts are resolved by looking up the registered settlement account for each side at reducer time.

> **Multi-person households**: until spouse settlement accounts are explicitly required, the household has one settlement account per currency, owned by the primary person. When spouse settlement is needed, `registerSettlement(currency, stateKey, { ownerId })` extends naturally — `FxTransferApplyReducer` resolves the matching pair on `(currency, ownerId)`.

---

## 4. Data Model Changes

### 4.1 New state fields (on `InternationalRetirementFinancialState`)

```js
// ── FX (NEW) ──────────────────────────────────────────────────────────
this.baseExchangeRates      = { USD_AUD: opts.exchangeRateUsdToAud ?? 1.55 };
this.baseFxFees             = { USD_AUD: opts.intlTransferFeeUsd   ?? 15 };

// Effective fields: regime-adjusted. RegimeApplyReducer writes them
// when the regime toolset is loaded; otherwise FxRefreshReducer
// mirrors base → effective on each period advance.
this.effectiveExchangeRates = { ...this.baseExchangeRates };
this.effectiveFxFees        = { ...this.baseFxFees };
```

### 4.2 Removed state fields

```diff
- this.exchangeRateUsdToAud = exchangeRateUsdToAud;
- this.intlTransferFeeUsd   = intlTransferFeeUsd;
```

These are deleted **only after** all consumers migrate (§9). The deletion is part of this design's Phase 2; Phase 1 keeps them as derived getters that mirror `effectiveExchangeRates.USD_AUD` / `effectiveFxFees.USD_AUD` so the migration can land in pieces.

### 4.3 Pair-id convention

Pair ids are `<FROM>_<TO>` in the **canonical direction** declared by the `CurrencyPair` subclass, regardless of transfer direction at call time. `UsdAudPair.id = 'USD_AUD'`. Reverse-direction transfers (`AUD → USD`) resolve to the same pair and invert the rate. The state-field key matches the pair id: `state.effectiveExchangeRates.USD_AUD`. This is a renaming from design 21's draft, which used `USD_TO_AUD`; aligning on `USD_AUD` matches the pair-id convention everywhere.

### 4.4 `StateSchemaRegistry`

Register paths for the workbench:

| Path | Type |
|---|---|
| `baseExchangeRates.*` | `ValueType.number()` |
| `effectiveExchangeRates.*` | `ValueType.number()` |
| `baseFxFees.*` | `ValueType.currency('USD')` |
| `effectiveFxFees.*` | `ValueType.currency('USD')` |

Registered in `US_AU_CROSS_BORDER.state(context)` (§9).

---

## 5. Architecture: FxService + FxEngine

```
FxService (singleton, ServiceRegistry)
   │
   ├─ FxEngine
   │     └─ pairs: { 'USD_AUD': UsdAudPair }
   │
   ├─ settlements: { 'USD': 'usSavingsAccount', 'AUD': 'auSavingsAccount' }
   │
   └─ getContributions(currencies, accountService, stateRegistry, parameters)
        ↓
        { statePatches:  { baseExchangeRates: {...}, baseFxFees: {...},
                           effectiveExchangeRates: {...}, effectiveFxFees: {...} },
          events:        [],   // FX has no scheduled events of its own; transfers are user-triggered
          handlers:      [FxTransferToHandler],
          reducers:      [FxTransferApplyReducer, FxRefreshReducer] }
```

`FxRefreshReducer` is the "regime-not-loaded" fallback (§6.3) — a tiny pre-process reducer that mirrors `baseExchangeRates` → `effectiveExchangeRates` and `baseFxFees` → `effectiveFxFees` on every period advance. When the regime toolset is loaded, `RegimeApplyReducer` writes the effective fields and `FxRefreshReducer` is a no-op (it runs but its writes are immediately overwritten by `RegimeApplyReducer` at `PRE_PROCESS + 1`).

---

## 6. Events / Handlers / Actions / Reducers

### 6.1 Events

| Event | Kind | Purpose |
|---|---|---|
| `FX_TRANSFER` | `OneOffEvent` | User- or handler-triggered cross-currency transfer. Carries `data: { from: 'USD', to: 'AUD', amount }`. Replaces the today's `INTL_TRANSFER_TO_US` / `INTL_TRANSFER_TO_AU` pair with a single direction-agnostic event. |

### 6.2 Handlers

| Handler | Event | Emits |
|---|---|---|
| `FxTransferToHandler` | `FX_TRANSFER` | One `FX_TRANSFER_APPLY` action carrying resolved `(from, to, sourceStateKey, destStateKey, fromAmount, toAmount, rate, fee)`. **Pre-resolves all amounts** by looking up the rate, fee, and settlement balances — the reducer is purely a ledger op. **Handles replenishment**: if the source settlement balance is short, calls `accountService.replenishSavings()` before emitting `FX_TRANSFER_APPLY`. The pending tax actions returned by replenishment are appended to the emitted action list. |

The replenishment call lives in the handler (not the reducer), per the answer to question 3. This separates liquidity concerns from FX concerns:

```js
class FxTransferToHandler extends HandlerEntry {
  call({ state, data }) {
    const { from, to, amount } = data;     // amount in `from` currency
    const fxService = this.fxService;
    const pair      = fxService.engine.getPair(from, to);
    const rate      = pair.rate(state, { from, to });
    const fee       = pair.fee(state, amount, { from, to });
    const srcKey    = fxService.settlement(from);
    const dstKey    = fxService.settlement(to);
    const srcBal    = state[srcKey].balance;

    // Liquidity: handler decides whether to replenish.
    const pendingTax = [];
    if (amount > srcBal) {
      try {
        const r = this.accountService.replenishSavings(state, srcKey, amount - srcBal, date);
        pendingTax.push(...r.pendingTaxActions);
      } catch (e) {
        if (!(e instanceof InsufficientFundsError)) throw e;
      }
    }

    // Cap by what's actually available; compute destination credit.
    const fromActual = Math.min(amount, state[srcKey].balance);
    const toCredit   = Math.max(0, (fromActual - fee) * rate);
    return [
      { type: 'FX_TRANSFER_APPLY', from, to, srcKey, dstKey,
        fromAmount: fromActual, toAmount: toCredit, rate, fee },
      new RecordMetricAction(`fx_transfer_${from}_${to}`, toCredit),
      new RecordBalanceAction(`${dstKey}.balance`, dstKey),
      ...pendingTax,
    ];
  }
}
```

### 6.3 Actions

| Action | Fields | Reducer that consumes it |
|---|---|---|
| `FX_TRANSFER_APPLY` | `from, to, srcKey, dstKey, fromAmount, toAmount, rate, fee` | `FxTransferApplyReducer` — pure ledger op. Debits `srcKey.balance` by `fromAmount`, credits `dstKey.balance` by `toAmount`. Emits `OUT_OF_FUNDS` if `toAmount` falls short of any caller-supplied `targetDeficit`. |

The action-type entry lives in `US_AU_CROSS_BORDER.types.actions` and declares `rate`, `fee`, `fromAmount`, `toAmount` fields so the workbench action-detail panel renders them.

### 6.4 Reducers and their priorities

| Reducer | Priority | Trigger action(s) | Responsibility |
|---|---|---|---|
| `FxRefreshReducer` (NEW) | `PRE_PROCESS (10)` | `US_PERIOD_ADVANCE`, `AU_PERIOD_ADVANCE` | Mirrors `state.baseExchangeRates` → `state.effectiveExchangeRates` and `baseFxFees` → `effectiveFxFees`. No-op when `RegimeApplyReducer` is also registered (its `PRE_PROCESS + 1` writes win). |
| `RegimeApplyReducer` (from design 21) | `PRE_PROCESS + 1 (11)` | (as design 21) | Overwrites `state.effectiveExchangeRates` / `effectiveFxFees` with the regime-composed values. |
| `FxTransferApplyReducer` (NEW) | `CASH_FLOW (20)` | `FX_TRANSFER_APPLY` | Pure ledger op via `accountService.transaction()`. No rate/fee math (handler already resolved it). No replenishment. Emits `OUT_OF_FUNDS` if the configured `targetDeficit` exceeds `toAmount`. |

**Why `FxRefreshReducer` exists**: design 21's regime framework is optional. A scenario can be configured with `US_AU_CROSS_BORDER` and no `ECONOMIC_REGIMES` toolset; in that case nothing else writes `effective*Rates`. The refresh reducer makes the effective fields work as a passthrough so consumers always read one path. Cost: one trivial reducer that does ~2 object spreads per period.

**Why no `FX_RATE_UPDATE` series in Phase 1**: see §2 Non-Goals. The base rate is a scalar; if the user wants it to vary across time without the regime framework, that's a future addition that wires an `FX_RATE_UPDATE` `EventSeries` into `FxService.getContributions()` from a `parameters.fxRateSchedule` entry. The hook point exists; the schedule mechanism doesn't ship now.

---

## 7. Toolset wiring (`US_AU_CROSS_BORDER`)

The existing `us-au-cross-border-toolset.js` becomes a thin caller of `FxService.getContributions()`. Today it owns the `IntlTransferTo*Handler`s + `IntlTransferApplyReducer` directly; after this design they come from the service.

```js
export const US_AU_CROSS_BORDER = {
  id: 'US_AU_CROSS_BORDER',
  capabilities: ['fx', 'cross-border'],
  dependencies: ['US_BANKING', 'AU_BANKING'],

  types: { ... },                  // FX_TRANSFER_APPLY, ValueType.* entries

  paramSchema(context) {
    return [
      { key: 'exchangeRateUsdToAud', label: 'Exchange Rate USD→AUD',
        type: 'Number', group: 'FX', defaultValue: 1.55, mc: true, opt: true },
      { key: 'intlTransferFeeUsd',   label: 'International Transfer Fee (USD)',
        type: 'Number', group: 'FX', defaultValue: 15,   mc: true, opt: true },
    ];
  },

  state(context) {
    const fx = context.services.fxService;
    const contribs = fx.getContributions(
      ['USD', 'AUD'],
      context.accountService, context.stateRegistry,
      context.parameters,
    );
    return contribs.statePatches;        // baseExchangeRates, etc.
  },

  schedules(context) {
    return context.services.fxService
      .getContributions(['USD', 'AUD'], ...).events;  // empty today
  },

  handlers(context) {
    const fx = context.services.fxService;
    // Register settlement accounts before handlers/reducers resolve them.
    fx.registerSettlement('USD', context.stateRegistry.getStateKey(ACCOUNT_ROLES.US_SAVINGS, context.primaryId));
    fx.registerSettlement('AUD', context.stateRegistry.getStateKey(ACCOUNT_ROLES.AU_SAVINGS, context.primaryId));
    return fx.getContributions(['USD', 'AUD'], ...).handlers;
  },

  reducers(context) {
    return context.services.fxService
      .getContributions(['USD', 'AUD'], ...).reducers;
  },
};
```

`ServiceRegistry` is updated to instantiate `FxService` alongside `TaxService` and the existing domain services.

---

## 8. Interaction with the Regime Framework

This design and design 21 are **complementary**:

- Design 21 declared (§5.2) `state.baseExchangeRates`, `state.effectiveExchangeRates`. Those are now **owned by `FxService`** — the regime framework reads them and writes to them, but the field shape and registration come from FX.
- Design 21 §10's shim — the dual-write of `state.exchangeRateUsdToAud` from inside `RegimeApplyReducer` — is **deleted**. All FX consumers read `state.effectiveExchangeRates.USD_AUD`. Design 21's draft is updated to remove §10 the same time as this design ships.
- The field name changes from `USD_TO_AUD` (design 21 draft) to `USD_AUD` (this design's pair-id convention). Design 21 §5.2 should be updated to match.

When **only the FX toolset is loaded** (no regime toolset): `FxRefreshReducer` writes `effective = base` on every period; the regime framework's effective-rates math is unused. Behavior matches today.

When **both are loaded**: `FxRefreshReducer` runs at `PRE_PROCESS (10)`, `RegimeApplyReducer` runs at `PRE_PROCESS + 1 (11)` and overwrites the effective fields with regime-composed values. `FxTransferApplyReducer` reads the effective fields without caring which reducer wrote them.

---

## 9. Migration

Two-phase, both shippable independently.

### Phase 1 — Extract the service; keep legacy state fields

1. Add `FxService` + `FxEngine` + `UsdAudPair` under `src/finance/fx/`.
2. Add `FxTransferApplyReducer` (pure ledger op) and `FxRefreshReducer`.
3. Add `FxTransferToHandler` (single direction-agnostic handler, with handler-side replenishment).
4. Add new state fields (`baseExchangeRates`, `baseFxFees`, `effectiveExchangeRates`, `effectiveFxFees`) to `InternationalRetirementFinancialState`.
5. **Keep `state.exchangeRateUsdToAud` / `state.intlTransferFeeUsd`** as getters that mirror `effectiveExchangeRates.USD_AUD` / `effectiveFxFees.USD_AUD`. All existing consumers continue to work.
6. Update `US_AU_CROSS_BORDER` toolset to call `FxService.getContributions()` and `registerSettlement()`.
7. Add `FxService` to `ServiceRegistry`.

**Exit criteria**: A `FX_TRANSFER` event with `data: { from: 'USD', to: 'AUD', amount: 5000 }` debits the US savings settlement account by 5000 and credits the AU savings settlement account by `(5000 - fee) × rate`. Existing `INTL_TRANSFER_TO_US` / `INTL_TRANSFER_TO_AU` event paths still work unchanged via the legacy state-field getters.

### Phase 2 — Retire `INTL_TRANSFER_*` event types and legacy state fields

1. Replace `INTL_TRANSFER_TO_US` / `INTL_TRANSFER_TO_AU` event types with `FX_TRANSFER` everywhere they're scheduled or emitted.
2. Delete `IntlTransferToUsHandler`, `IntlTransferToAuHandler`, `IntlTransferApplyReducer`.
3. Delete `state.exchangeRateUsdToAud` and `state.intlTransferFeeUsd` (the getters).
4. Update all UI references (charts, journal labels, type-registry entries).
5. Delete design 21 §10 shim from `RegimeApplyReducer`.

**Exit criteria**: `grep` for `exchangeRateUsdToAud` and `intlTransferFeeUsd` returns 0 hits across `src/`. Only `FxService` writes effective FX fields outside of regimes.

---

## 10. Testing

EVT-X test files under `tests/unit/`:

| File | Coverage |
|---|---|
| `evt-fx-transfer-usd-to-aud.test.mjs` | `FX_TRANSFER` with `from: 'USD', to: 'AUD'` debits US settlement, credits AU settlement with `(amount - fee) × rate`. |
| `evt-fx-transfer-aud-to-usd.test.mjs` | Reverse direction; rate is inverted (`1 / rate`). |
| `evt-fx-replenishment.test.mjs` | Source settlement is short; handler calls `replenishSavings`; tax actions are appended; transfer completes with full amount. |
| `evt-fx-out-of-funds.test.mjs` | Source settlement and investments together cannot cover; partial transfer completes; `OUT_OF_FUNDS` emitted for the gap. |
| `evt-fx-refresh-no-regime.test.mjs` | Without `ECONOMIC_REGIMES` toolset, `FxRefreshReducer` mirrors base → effective each period. |
| `evt-fx-with-regime.test.mjs` | With both toolsets, regime FX adjustment composes into `effectiveExchangeRates.USD_AUD` and the next transfer uses the adjusted rate. |
| `evt-fx-settlement-registry.test.mjs` | `FxService.registerSettlement` accepts per-currency state keys; `FX_TRANSFER` resolves the correct accounts. |
| `evt-fx-roundtrip.test.mjs` | Scenario with an `FX_TRANSFER` round-trips through `ScenarioSerializer`. |

Tests follow the existing journal-assertion patterns in `evt-401k.test.mjs` / `evt-ira.test.mjs`.

---

## 11. Out of Scope / Future Work

- **Per-date rate schedule**. A `parameters.fxRateSchedule: [{ date, rate, fee }, ...]` array could drive an `FX_RATE_UPDATE` `EventSeries`; the hook point is in `FxService.getContributions()`. Not shipping in Phase 1; everything else here is built so it slots in cleanly.
- **Time-versioned FX modules** (`FxModule2026` analogous to `TaxModule2026`). FX doesn't have year-boundary rule changes today; if the need shows up, add per-year modules under `FxEngine` the same way `TaxEngine` does.
- **Additional currencies**. `EUR`, `GBP`, etc. The API is pair-generic; each new pair is a `CurrencyPair` subclass plus a `registerPair()` call in `FxService`'s constructor.
- **Bid/ask spreads, tiered fees, percentage fees**. The `CurrencyPair.fee(state, notional, direction)` signature accommodates these; `UsdAudPair` ships with a fixed-fee implementation.
- **Cross-pair routing** (e.g. AUD → GBP via USD). Out of scope; the service assumes a direct pair exists for every requested transfer.
- **Spouse settlement accounts**. The `registerSettlement(currency, stateKey, { ownerId })` overload extends naturally; until spouse cross-border transfers are explicitly modeled, settlements are household-level (one per currency).

---

## 12. Summary

`FxService` lifts cross-currency mechanics into a real service that owns:

- **The rate/fee composition surface** — `state.base*` written at scenario boot, `state.effective*` read by the transfer reducer; regime-composed when the regime toolset is loaded, mirrored from base by `FxRefreshReducer` when it isn't.
- **A per-currency settlement registry** — one call per currency at toolset compile time; transfers resolve source/destination automatically.
- **A pure-ledger transfer reducer** — `FxTransferApplyReducer` does no math beyond `accountService.transaction()` debits and credits; the handler owns rate lookup, fee math, and replenishment.

The two-phase migration lets Phase 1 ship behind a backward-compat shim (legacy state fields exist as getters), then Phase 2 retires the legacy `INTL_TRANSFER_*` events and the shim. Design 21's §10 dual-write goes away when Phase 2 lands.
