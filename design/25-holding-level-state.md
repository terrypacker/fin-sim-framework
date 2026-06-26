# 25 — Holding-Level State

**Status**: Implemented (2026-06-03). See §16 for implementation notes, deviations from this design, and remaining follow-ups.
**Phase**: A — Substrate (per `design/24-financial-modeling-roadmap.md` §5)
**Related**: `design/24-financial-modeling-roadmap.md` (umbrella), `design/21-financial-shock-and-regime-framework.md` (rate-key substrate this binds to), `design/23-fx-exchange.md` (effective-rate parallel), `design/15-config-as-source-of-truth.md` (config/state ownership boundary), `design/19-type-registry.md` (action-type entries), `design/25a-mc-nested-param-paths.md` (peer substrate piece in Phase A).
**Author note**: The single largest refactor in the financial-modeling roadmap. Introduces `Holding` as the canonical sub-balance of an `Account`, with `allocation` and `costBasis` as first-class state. Foundational for designs 28 (per-holding appreciation, bond duration), 29 (behavioral selling, tax-loss harvesting), and the dividend-cut extension to design 21.

---

## 1. Purpose

Today an `Account` carries one scalar `balance` and one growth rate. Design 21 made those rates regime-responsive — an equity shock can drop `EQUITY_US` returns globally — but the simulation still cannot answer:

- *What fraction of this 401(k) is in equities vs. bonds vs. cash?*
- *What is the unrealized gain/loss on this position right now?*
- *How much of the brokerage account would a dividend-yield cut actually hit?*
- *Which slice of the portfolio should a panic-sell rotate to cash?*

`Account.balance` is the wrong primitive for any of those questions. This design replaces it with an explicit `Account.holdings: Holding[]` array. Each holding carries its own `allocation` (`EQUITY` / `BOND` / `CASH` / `OTHER`), `marketValue`, `costBasis`, and `rateKey`. `Account.balance` continues to exist as a denormalized scalar kept in sync by reducers — preserving every existing read site and matching the framework's plain-data-state convention — but the source of truth shifts to the holdings array.

This is **Phase A substrate**: the next four follow-on designs (26 spending, 27 mortality, 28 appreciation/duration, 29 behavioral) all sequence behind it. Two of them (spending, mortality) don't read holdings; they ship after this one anyway because §5 of the roadmap commits to a single-threaded build order on the shared `Account` / state surface.

---

## 2. Design Philosophy

> An account is not a balance. An account is a collection of positions, each with its own allocation, basis, and rate exposure.

The framework already commits to:

- **State is plain data.** No methods, no derived getters inside `sim.state`; `structuredClone` is used for snapshots. Service objects (`AccountService`, `StateRegistry`, …) carry the logic.
- **Rates are composable.** Design 21 introduced `rateKey` as the addressable unit of return; `RegimeApplyReducer` writes `state.effectiveGrowthRates[rateKey]`.
- **Handlers return actions; reducers return state.** Mutation flows through the action pipeline; in-place writes outside reducers are forbidden.

Holdings inherit all three. A `Holding` is a plain-data record on `sim.state`. Its `rateKey` slots directly into the design 21 effective-rate map (one holding → one regime exposure). All mutation (transact, split, revalue, retitle) flows through reducers that take a new family of `HOLDING_*` actions.

The denormalized `account.balance` field stays — as a redundant scalar synced by reducers — for three reasons: (a) every existing handler reads `state[stateKey].balance`; rewriting them all in one PR is the point of the big-bang refactor (see §10), but the read surface itself stays the same; (b) the StateSchemaRegistry path `*.balance` is already wired into charts, timelines, and the state panel; (c) `account.balance` is what gets reported to the user as "the account's value" and that semantic doesn't change. The contract is: **`account.balance === Σ holdings[i].marketValue`** is an invariant enforced by `_syncBalance()` at the tail of every holdings-mutating reducer.

---

## 3. In / Out of Scope

### In scope

| Concept | Where it lands |
|---|---|
| `Holding` primitive (`allocation`, `marketValue`, `costBasis`, `rateKey`, `purchaseDate`) | `src/finance/holdings/holding.js` (new module) |
| `Account.holdings: Holding[]` as the source of truth; `Account.balance` as denormalized scalar | `src/finance/assets/account.js` |
| Default-holding bootstrap (every existing account gets one holding matching today's scalar balance) | `AccountService.register()` + `ScenarioCompiler` post-step |
| Action / reducer family for holdings-level mutation (`HOLDING_TRANSACT`, `HOLDING_SET_BASIS`, `HOLDING_REVALUE`, `HOLDING_SPLIT`, `HOLDING_RETITLE`) | `src/finance/holdings/holding-actions.js`, `src/finance/holdings/holding-reducers.js` |
| Earnings handler migration: read `state.effectiveGrowthRates[holding.rateKey]` × `holding.marketValue` per holding | All earnings handlers under `src/finance/handlers/earnings-handlers.js` and account-rules earnings handlers |
| Cost-basis-as-state, replacing transactional `costBasis` on `STOCK_WITHDRAWAL_APPLY` | Holdings carry their own basis; FIFO consumption in the stock-withdrawal reducer |
| `RevalueAssetReducer` (from design 21) targets holdings by `rateKey` rather than account balances directly | `src/finance/economic-regimes/revalue-asset-reducer.js` (touch-up) |
| `StateSchemaRegistry` paths for `*.holdings[*].marketValue`, `*.holdings[*].costBasis`, `*.holdings[*].unrealizedGainLoss` | `src/finance/services/state-schema-registry.js` |
| Holding-level UI in the inspector (read-only this design; editing follows in design 28 once appreciation schedules exist) | `src/visualization/accounts/account-editor.js` |
| Round-trip serialization (Holding → `toJSON`, `static fromJSON` via `TypeRegistry`) | `src/finance/holdings/holding.js` + serializer registration |

### Out of scope (named to keep this design tight)

| Concept | Where it goes |
|---|---|
| Per-holding appreciation schedules (`appreciationSchedule[]`) | Design 28 |
| Real-estate location codes (`RealProperty.market`) | Design 28 |
| Bond duration / yield-curve effects on price | Design 28 |
| Dividend-yield cuts under regimes | Small follow-up to design 21, after design 28 |
| Panic-sell / contribution-suspension handlers | Design 29 |
| Tax-loss harvesting | Design 29 (future-future) |
| Multi-currency holdings within a single account | Out of scope per roadmap §7 |
| Joint holdings (multiple owners on one holding) | Out of scope; tracked under design 17 / spouse-accounts work |
| User-facing "split this account into 60/40" editor flow | UI design; this doc ships the substrate, not the editor |

---

## 4. Core Concepts

### 4.1 `Holding`

Plain-data record. Lives inside `account.holdings`. Never carries methods. Serialized via `TypeRegistry`.

```js
// src/finance/holdings/holding.js
class Holding {
  static type = 'Holding';                       // TypeRegistry discriminator

  constructor({
    id            = null,                        // assigned by AccountService on registration
    allocation,                                  // ALLOCATION value (§4.2)
    marketValue   = 0,
    costBasis     = 0,
    purchaseDate  = null,                        // Date | null; null = "carried in from scenario boot"
    rateKey       = null,                        // resolved at registration if null (§4.3)
    label         = '',                          // optional display label ("ITOT", "BND")
  } = {}) {
    this.id           = id;
    this.allocation   = allocation;
    this.marketValue  = marketValue;
    this.costBasis    = costBasis;
    this.purchaseDate = purchaseDate;
    this.rateKey      = rateKey;
    this.label        = label;
  }

  // unrealizedGainLoss is derived; computed by AccountService.unrealizedGainLoss(holding).
  // Not stored on state to keep the source-of-truth narrow.
}
```

### 4.2 `ALLOCATION`

A small frozen enum. Drives both `rateKey` resolution (§4.3) and the behavioral layer in design 29 (which only acts on `EQUITY` holdings, etc.).

```js
// src/finance/holdings/allocation.js
export const ALLOCATION = Object.freeze({
  EQUITY: 'EQUITY',
  BOND:   'BOND',
  CASH:   'CASH',
  OTHER:  'OTHER',     // real property, collectibles, etc. — see §6
});
```

### 4.3 `rateKey` resolution

A holding's `rateKey` ties it into the design 21 effective-rate substrate. If the toolset doesn't supply one, `AccountService.registerHolding()` resolves it from the account's `(country, allocation)` pair using a fixed table:

| account.country | holding.allocation | resolved rateKey |
|---|---|---|
| `US` | `EQUITY` | `EQUITY_US` |
| `US` | `BOND` | `FIXED_INCOME_US` |
| `US` | `CASH` | `SAVINGS_US` |
| `AU` | `EQUITY` | `EQUITY_AU` |
| `AU` | `BOND` | `FIXED_INCOME_AU` *(rate key newly introduced; see §11)* |
| `AU` | `CASH` | `SAVINGS_AU` |
| any | `OTHER` | falls through to asset-specific key (`REAL_ESTATE_US`, `COLLECTIBLE`, …) — see §6 |

A toolset can override per holding when it needs to (e.g. a 401(k) bond sleeve labeled with a corporate-bond rate key distinct from `FIXED_INCOME_US`). Once resolved, the rate key is stored on the holding and is what every earnings/revaluation handler reads.

### 4.4 The invariant

```
For every account a:
  a.balance === Σ a.holdings[i].marketValue   (rounded to currency precision)
```

This is enforced by `_syncBalance(account)`, called at the tail of every reducer that mutates `account.holdings`. The invariant is **not** enforced by getter/setter magic — `account.balance` is just a number, written by the reducer.

Tests assert this invariant in two places: (a) a generic `holdings-invariant.test.mjs` walks every account after every reducer step and asserts the sum; (b) round-trip serialization tests assert the invariant holds before and after `toJSON`/`fromJSON`.

> ~~**TODO** — Per-reducer postconditions: each reducer should assert its local invariants (§4.4 `balance == Σ marketValue`, `basis ≥ 0`, `mv ≥ 0`, money-conservation for transfers). Added for `transaction`/holdings; the pattern generalizes to every reducer.~~
> **Done / superseded.** Generalized into **[design 37 — Reducer Test Framework & Postcondition Coverage](37-reducer-test-framework.md)**: an invariant taxonomy (I1–I10), a reusable harness (`tests/helpers/reducer-postconditions.js` + `reducer-fixtures.js`), and a per-reducer coverage checklist for all 128 reducer classes. The holdings/transaction postconditions described above are the seed rows.

---

## 5. Data Model Changes

### 5.1 `Account`

```js
// src/finance/assets/account.js
class Account extends Asset {
  constructor(initialValue = 0, opts = {}) {
    super(opts.name ?? '', { ...opts, kind: 'account' });
    this.role           = opts.role           ?? null;
    this.type           = opts.type           ?? null;
    this.balance        = initialValue;          // denormalized scalar — Σ holdings[i].marketValue
    this.holdings       = [];                    // NEW — populated by AccountService on register
    this.minimumBalance = opts.minimumBalance ?? 0;
    this.country        = opts.country        ?? null;
    this.currency       = opts.currency       ?? null;
  }
}
```

No constructor change to the public surface — `initialValue` still works as before. The holdings array is populated separately by `AccountService.register()` (§5.4) so call sites stay terse.

### 5.2 `InvestmentAccount` and subclasses

No structural change. `contributionBasis`, `earningsBasis`, `loanBalance`, `minimumAge`, `allowsEarlyWithdrawal`, `balanceAtResidencyChange` all remain — they describe the *account*, not the individual positions. `contributionBasis` continues to track pre-tax-vs-post-tax money at account granularity (separate concept from per-holding `costBasis`); this design does **not** collapse them.

### 5.3 `RealProperty` and `Collectible`

Two paths considered; design lands on the second:

1. **Path A — wrap them in a Holding.** Treat every asset as a holding, including a house. Pros: one mental model. Cons: `RealProperty` already carries first-class fields (`mortgagePayment`, `plannedSaleYear`, `primaryResidence`) that don't fit the `Holding` shape, and the existing service/editor/serializer plumbing is non-trivial to bend.
2. **Path B — `RealProperty`/`Collectible` stay as-is for design 25.** They carry their own scalar `value`. Design 28 (per-holding appreciation schedules, location codes) is the natural place to revisit whether they get folded into the Holdings model.

Path B keeps this design's surface area honest. The `Holding` primitive is introduced where the simulation needs it most (investment accounts, where the structure question lives) and **not** retrofitted onto every asset type just for symmetry. Revaluation actions from design 21 already target `RealProperty.value` / `Collectible.value` directly via the asset services — they continue to do so. See §6 for the reducer-side detail.

### 5.4 `AccountService.register()` — default-holding bootstrap

Every account, on registration, gets one default holding matching its current scalar balance and the canonical allocation for its type. This is the migration shim that makes the big-bang refactor land in one PR without rewriting every scenario builder.

| account type | default `ALLOCATION` | resolved `rateKey` |
|---|---|---|
| `CheckingAccount` | `CASH` | `SAVINGS_US` / `SAVINGS_AU` |
| `SavingsAccount` | `CASH` | `SAVINGS_US` / `SAVINGS_AU` |
| `BrokerageAccount` (US) | `EQUITY` | `EQUITY_US` |
| `BrokerageAccount` (AU) | `EQUITY` | `EQUITY_AU` |
| `RothAccount` | `EQUITY` | `EQUITY_US` |
| `TraditionalIRAAccount` | `EQUITY` | `EQUITY_US` |
| `FourOhOneKAccount` | `EQUITY` | `EQUITY_US` |
| `SuperannuationAccount` | `EQUITY` | `EQUITY_AU` |
| `FixedIncomeAccount` *(see §11)* | `BOND` | `FIXED_INCOME_US` / `FIXED_INCOME_AU` |

```js
// pseudocode inside AccountService
register(account) {
  // …existing assign-id + state-key wiring…
  if (account.holdings.length === 0) {
    const allocation = DEFAULT_ALLOCATION_BY_TYPE[account.type];
    const rateKey    = resolveRateKey(account.country, allocation);
    account.holdings = [new Holding({
      allocation,
      marketValue:  account.balance,
      costBasis:    account.balance,      // bootstrapped basis = bootstrapped value
      rateKey,
      purchaseDate: null,                  // "carried in"; not a real purchase event
    })];
    account.holdings[0].id = this._nextHoldingId(account.id);
  }
  // …continue with bus publish…
}
```

A toolset that *does* want to declare a 60/40 split passes pre-populated `holdings` to the `Account` constructor (or registers them post-hoc via `AccountService.registerHolding`). The branch above is the default for everything else.

### 5.5 `InternationalRetirementFinancialState`

No new top-level state fields. Holdings live inside the existing account state objects (`state[usStockAccount].holdings`, `state[rothAccount].holdings`, …). The denormalized `state[*].balance` continues to be the field reducers/handlers/UI primarily read.

### 5.6 `StateSchemaRegistry`

Register `ValueType` descriptors for the new state paths so charts/timeline/state-panel format them correctly. Resolution is by glob.

| Path glob | Type |
|---|---|
| `*.holdings` | `ValueType.array()` |
| `*.holdings[*].marketValue` | `ValueType.currency(<account.currency.code>)` |
| `*.holdings[*].costBasis` | `ValueType.currency(<account.currency.code>)` |
| `*.holdings[*].allocation` | `ValueType.enum(ALLOCATION)` |
| `*.holdings[*].rateKey` | `ValueType.text()` |
| `*.holdings[*].purchaseDate` | `ValueType.date()` |
| `*.holdings[*].label` | `ValueType.text()` |

`AccountService.register()` calls `stateSchemaRegistry.registerAccount(stateKey, account)` exactly as today; the helper is extended to stamp the per-holding paths with the account's currency. Glob fallbacks cover anything the per-account stamp misses.

### 5.7 `TypeRegistry`

`Holding` registers as `'Holding'`. Action types under §6 register their own entries. No change to the `Action` family-resolution rules from design 19.

---

## 6. Event / Handler / Action / Reducer Architecture

### 6.1 Actions (new family)

A new action family — `HOLDING` — covers every mutation to `account.holdings`. Each is a `FieldValueAction` subclass (matches the existing convention) and lives under `src/finance/holdings/holding-actions.js`.

| Action | Fields | Purpose |
|---|---|---|
| `HOLDING_TRANSACT` | `stateKey`, `holdingId`, `marketValueDelta`, `costBasisDelta` | Net change to a single holding's value and basis (contribution, withdrawal, dividend reinvest). `costBasisDelta` is often 0 (e.g. appreciation, dividend cash payout) or equal to `marketValueDelta` (e.g. a deposit). |
| `HOLDING_REVALUE` | `stateKey`, `holdingId` *(or)* `rateKey`, `multiplier`, `priceDelta` | Mark-to-market. Used by design 21's level effects (target by `rateKey`) and by design 28's appreciation schedules (target by `holdingId`). Exactly one of `multiplier` / `priceDelta` is supplied. |
| `HOLDING_SET_BASIS` | `stateKey`, `holdingId`, `costBasis` | Explicit basis correction (rollover step-up, residency reset, manual override). |
| `HOLDING_SPLIT` | `stateKey`, `holdingId`, `splits: [{ marketValueDelta, costBasisDelta, allocation?, rateKey?, label? }]` | Split one holding into N. Used by the toolset compiler to materialize a 60/40 split at scenario boot, and by future allocation-rebalance handlers. |
| `HOLDING_RETITLE` | `stateKey`, `holdingId`, `allocation?`, `rateKey?`, `label?` | Change metadata without moving value. Used by design 21's regime-driven recategorization (rare) and by survivor mechanics in design 27 if an inherited account gets re-mapped. |

All five are registered through the `TypeRegistry` with `fields` populated so the workbench's action-detail panel renders payloads correctly. Their `family` is `'HOLDING'`; `cc` is null (these aren't tax-bearing).

### 6.2 Reducers

| Reducer | Priority | Trigger action(s) | Responsibility |
|---|---|---|---|
| `HoldingTransactReducer` | `POSITION_UPDATE (30)` | `HOLDING_TRANSACT` | Adds `marketValueDelta` to `holding.marketValue`, `costBasisDelta` to `holding.costBasis`. Calls `_syncBalance(account)`. |
| `HoldingRevalueReducer` | `POSITION_UPDATE (30)` | `HOLDING_REVALUE` | Targets either the single `holdingId` or every holding under `rateKey`; applies `multiplier` or adds `priceDelta`. Calls `_syncBalance`. |
| `HoldingSetBasisReducer` | `COST_BASIS (40)` | `HOLDING_SET_BASIS` | Overwrites `holding.costBasis`. No balance impact. |
| `HoldingSplitReducer` | `POSITION_UPDATE (30)` | `HOLDING_SPLIT` | Replaces `holdings[i]` with N new holdings whose `marketValueDelta` sum equals the original. Calls `_syncBalance`. |
| `HoldingRetitleReducer` | `PRE_PROCESS (10)` | `HOLDING_RETITLE` | Patches metadata fields only. |

`_syncBalance` is a private helper inside each holdings reducer: `account.balance = Σ holdings[i].marketValue` rounded to currency precision. It runs **inside the reducer**, not after the reducer chain, so the `account.balance` written to the journal's `nextState` is correct on the same tick.

### 6.3 Handlers — earnings migration

Every existing earnings handler reads `state[stateKey].balance` × scalar growth rate and emits a single `*_EARNINGS_APPLY` action. The migration changes each one to:

1. Walk `state[stateKey].holdings`.
2. For each holding, compute `growth = holding.marketValue × state.effectiveGrowthRates[holding.rateKey]` (fallback chain: effective → base → handler's constructor-time rate, matching design 21's contract).
3. Emit one `HOLDING_TRANSACT` per holding with `marketValueDelta = growth, costBasisDelta = 0` *(unrealized appreciation does not add to basis)*.
4. Emit the existing `*_EARNINGS_APPLY` and `RECORD_METRIC` / `RECORD_BALANCE` actions unchanged so downstream tax/RMD/UI math keeps working off `account.balance`.

The diff per handler is small — it's the same handler, just iterating one extra layer. `RothEarningsHandler`, `IraEarningsHandler`, `K401EarningsHandler`, `UsStockEarningsHandler`, `AuStockEarningsHandler`, `SuperEarningsHandler`, `FixedIncomeInterestHandler`, `AuSavingsInterestHandler`, `UsSavingsInterestMonthlyHandler`, `AuFixedIncomeInterestMonthlyHandler` all follow the same template; §11 lists them with line-pointer-style anchors.

For accounts that have a single default holding (every account after the bootstrap), the per-holding loop collapses to the same arithmetic as today. For accounts the toolset has explicitly split (a 60/40 401(k)), each sleeve grows at its own regime-adjusted rate.

### 6.4 Handler — `STOCK_WITHDRAWAL` / cost basis

Today, `STOCK_WITHDRAWAL_APPLY` carries `costBasis` as a field computed at withdrawal time:

```js
const saleCost = (withdraw / totalBal) * account.balance;   // pro-rata basis
{ type: 'STOCK_WITHDRAWAL_TAX', gain, costBasis: saleCost, … }
```

Per the roadmap §3.1, cost basis becomes **state**. The withdrawal handler changes to:

1. Read `account.holdings`, sorted by `purchaseDate` (FIFO).
2. Consume holdings until `withdraw` is satisfied. For each partially or fully consumed holding, accumulate `Σ (consumed / marketValue) × holding.costBasis` to get the realized basis.
3. Emit `HOLDING_TRANSACT` (marketValueDelta = `-consumed`, costBasisDelta = `-consumedBasis`) per affected holding.
4. Emit `STOCK_WITHDRAWAL_TAX` with the realized `costBasis` as before.

LIFO/specific-lot strategies are tracked as a follow-up; FIFO is the default and matches the AU CGT regime's typical assumption. The handler exposes a `costBasisStrategy: 'FIFO' | 'LIFO' | 'SPECIFIC'` field on its constructor so design 29 (tax-loss harvesting) can override per-handler later without another migration.

### 6.5 Handler — `STOCK_DEPOSIT` / contribution

Symmetrically, contributions emit a `HOLDING_TRANSACT` against the account's default holding for that allocation (resolved by `findOrCreateHolding(account, allocation, rateKey)`). Most contributions go to the default `EQUITY` sleeve; an account explicitly split 60/40 by the toolset gets contributions allocated proportionally by a `HoldingAllocationStrategy` (default: pro-rata to current weights; override per-toolset). The allocation strategy is a **plain function** registered with `AccountService`; this design ships only the pro-rata strategy.

### 6.6 Design 21 hook — `RevalueAssetReducer`

`RevalueAssetReducer` today multiplies `state[stateKey].balance` directly for every account whose stamped `rateKey` matches the action's. With holdings, it changes to:

1. For each account whose holdings contain at least one with `holding.rateKey === action.rateKey`:
2. Emit (internally — or implement as a direct mutation since this *is* the reducer) the holdings-level multiplier on each matching holding.
3. `_syncBalance(account)`.

This is a touch-up — the reducer's external contract (action type, fields, priority) doesn't change. Asset-level revaluation for `RealProperty` / `Collectible` continues to target `value` directly per §5.3.

### 6.7 Bootstrap path — `ScenarioCompiler` and toolset handoff

`ScenarioCompiler` already populates `sim.state` via toolset `state(context)` patches before registering handlers/reducers. The compiler grows one extra step: after the `state()` patches land and accounts have been registered, walk every account and emit a `HOLDING_SPLIT` *initial action* for any account the toolset declared as multi-sleeve. This keeps the reducer pipeline as the single mutation path even at boot — no compiler-side direct writes to `account.holdings` beyond the default-holding bootstrap.

Toolset opt-in:

```js
// src/scenarios/toolsets/us-retirement.js  (illustrative)
schedules(context) {
  const k401 = context.accounts.find(a => a.role === ACCOUNT_ROLES.K401);
  if (context.parameters.k401AllocationBondsPct > 0) {
    // Emitted as a OneOffEvent on simStart so the SPLIT lands at t=0
    return [bootstrapHoldingSplit(k401, [
      { allocation: ALLOCATION.EQUITY, fraction: 1 - context.parameters.k401AllocationBondsPct },
      { allocation: ALLOCATION.BOND,   fraction:     context.parameters.k401AllocationBondsPct },
    ])];
  }
  return [];
}
```

No new framework — just the existing `OneOffEvent` → handler → action → reducer pipeline.

---

## 7. AccountService surface

The service grows a thin layer of holdings helpers. Existing methods (`transaction`, `safeDebit`, `getAccountHistory`, `getPersonShare`, `recordResidencyChange`, `isWithdrawalEligible`, `replenishSavings`, the drawdown ladder) stay shaped as today — `account.balance` is still the field they read and write — but they delegate balance mutation through holdings actions when called from inside the simulation.

| New method | Purpose |
|---|---|
| `registerHolding(account, holdingSpec)` | Adds a holding to an already-registered account; assigns id; updates `account.balance`; publishes a `SERVICE_ACTION` `HOLDING_REGISTERED`. UI-side flow. |
| `unrealizedGainLoss(holding)` | Derived getter (`holding.marketValue - holding.costBasis`). Service-side; not stored on state. |
| `findOrCreateHolding(account, allocation, rateKey)` | Returns the account's existing holding matching `(allocation, rateKey)`, or creates one if absent. Used by contribution handlers (§6.5). |
| `defaultHoldingFor(account)` | Returns `account.holdings[0]` after the bootstrap. Convenience for handlers that don't care which sleeve they hit. |
| `holdingsByAllocation(account, allocation)` | Filtered view; used by `PanicSellHandler` (design 29) and by the inspector UI. |

The legacy `transaction(account, amount, date)` helper continues to exist for places that explicitly want to bump the scalar balance without touching holdings (some bookkeeping reducers do exactly this when the value change is mirrored by another holding mutation elsewhere). Those call sites are audited and reduced to a minimum during the big-bang migration; the helper is not deprecated, just constrained.

---

## 8. Serialization

`Holding` registers `toJSON` / `static fromJSON` via the `TypeRegistry`. `Account.toJSON` serializes its holdings as a nested array; `Account.fromJSON` reconstitutes them. Schema:

```js
{
  __type: 'Holding',
  id, allocation, marketValue, costBasis, purchaseDate, rateKey, label,
}
```

`ScenarioSerializer._serializeAccount` and `_deserializeAccount` already drive per-account serialization; the change is two lines (add `holdings: account.holdings.map(h => h.toJSON())` on serialize, the inverse on deserialize) plus a `TypeRegistry.register(Holding)` call in the framework bootstrap.

`scenario-roundtrip.test.mjs` and `serializer-finance-roundtrip.test.mjs` grow holdings-aware assertions: every loaded scenario must round-trip with byte-identical holdings, and the invariant from §4.4 must hold on both sides of the trip.

---

## 9. UI

This design ships **read-only** holdings UI. Editing flows (drag a sleeve, change an allocation %, set a basis) follow in design 28's UX work.

- **Inspector / Account editor** (`src/visualization/accounts/account-editor.js`) — adds a "Holdings" table beneath the account fields. Columns: label, allocation, rateKey, marketValue, costBasis, unrealized G/L, purchase date. Read-only.
- **State panel** — new state paths are picked up automatically from `StateSchemaRegistry` (§5.6). No code changes beyond the registry stamp.
- **Chart** — `*.holdings[*].marketValue` is selectable as a time series. The chart's path-walking logic already supports indexed glob paths from existing array-of-record state; this design adds the holdings paths to the default series catalog.
- **Timeline** — `HOLDING_TRANSACT` / `HOLDING_REVALUE` / `HOLDING_SPLIT` actions render with the new family icon and respect the existing CSV download.

No new plugin. Existing `inspector` / `chart` / `state-panel` / `timeline` plugins absorb the changes.

---

## 10. Migration (big-bang)

One PR (or a tight sequence of two PRs if the diff demands it) introduces `Holding`, migrates every reader/writer, and removes any transitional shim. The framework convention is no long-lived backward-compat code paths; this aligns with the `inconsistencies.md` and `15-config-as-source-of-truth.md` posture.

Step ordering inside the migration:

1. **Add the primitives.** `Holding`, `ALLOCATION`, `DEFAULT_ALLOCATION_BY_TYPE`, `resolveRateKey`. New files only; nothing else changes yet.
2. **Wire `Account.holdings`.** Update the `Account` constructor and `AccountService.register()` to bootstrap a default holding. Verify the §4.4 invariant holds for every existing scenario at boot time. **Pause for a checkpoint:** run the full suite — at this point the holdings array exists but is unused; everything must still pass.
3. **Add the action family + reducers.** Register `HOLDING_*` types, reducer pipeline. Pause again — actions exist but nothing dispatches them.
4. **Migrate earnings handlers.** Per the §6.3 template, switch each handler to walk holdings and emit `HOLDING_TRANSACT`. Tests that assert specific `*_EARNINGS_APPLY` amounts continue to pass because the per-holding amounts sum to the same scalar amount (every account has one default holding at this stage).
5. **Migrate `RevalueAssetReducer`** per §6.6. Existing design-21 tests assert balance changes; with one holding per account, the holding-level multiplier produces the same `account.balance` and the tests pass unchanged.
6. **Migrate `STOCK_WITHDRAWAL` cost basis** per §6.4. Update `STOCK_WITHDRAWAL_TAX` consumers — `costBasis` is still on the action; only the source (state vs. computed) changes. Tax tests assert realized gain, not the path it took to compute basis.
7. **Wire toolset bootstrap split** per §6.7. Only the toolsets that ship with a non-default allocation (initially: none in the production `IntlRetirementScenario`) need to add a `HOLDING_SPLIT` initial action.
8. **Serialization round-trip.** Update `ScenarioSerializer._serializeAccount` / `_deserializeAccount`; add `TypeRegistry.register(Holding)`; re-run `npm run build:index`.
9. **UI read-only.** Add the inspector holdings table; register state paths.
10. **Tests.** Add `holdings-invariant.test.mjs`, `holdings-actions.test.mjs`, holdings-aware extensions to `scenario-roundtrip.test.mjs` and `serializer-finance-roundtrip.test.mjs`. Update any existing test that pokes `state[stateKey].balance` directly to verify it survives the migration; the broad answer is they should because every account has one default holding whose value mirrors the scalar.

Rollback story: the migration is large but contained to (a) `Account` shape, (b) the earnings/withdrawal handler family, (c) `RevalueAssetReducer`, (d) `ScenarioSerializer`. A single revert returns to today's scalar model.

---

## 11. Per-handler / per-reducer touch list

| File | Today | After |
|---|---|---|
| `src/finance/assets/account.js` | `this.balance = initialValue` | Adds `this.holdings = []` |
| `src/finance/services/account-service.js` | `register()` assigns id + stateKey | Plus default-holding bootstrap (§5.4); adds `registerHolding`, `unrealizedGainLoss`, `findOrCreateHolding`, `defaultHoldingFor`, `holdingsByAllocation` |
| `src/finance/handlers/earnings-handlers.js` | `IntlRothEarningsHandler`, `IntlIraEarningsHandler`, `IntlK401EarningsHandler`, `IntlUsStockEarningsHandler`, `IntlAuStockEarningsHandler`, `SuperEarningsHandler`, `FixedIncomeInterestHandler`, `AuSavingsInterestHandler`, `AuFixedIncomeInterestMonthlyHandler` — each reads `state[stateKey].balance` × scalar rate | Each walks `state[stateKey].holdings`, uses `state.effectiveGrowthRates[h.rateKey]` per holding, emits N `HOLDING_TRANSACT` + the existing `*_EARNINGS_APPLY` for cumulative amount |
| `src/finance/handlers/us-savings-interest-handler.js` | Same scalar shape | Same per-holding migration (one holding for a savings account = same arithmetic) |
| `src/finance/handlers/dividend-scheduled-handler.js` | Static yield × `account.balance` | Yield × Σ EQUITY-holdings.marketValue; one `HOLDING_TRANSACT` per holding for any reinvest portion |
| `src/finance/account-rules/us/us-brokerage-classes.js` | `STOCK_WITHDRAWAL_APPLY` computes `costBasis` pro-rata from `account.balance` | FIFO-consumes from `account.holdings`; basis comes from the holdings themselves (§6.4) |
| `src/finance/account-rules/au/au-brokerage-classes.js` | Same | Same |
| `src/finance/account-rules/us/us-collectible-classes.js` | Asset-level `value` + transactional basis | No change (path B per §5.3); collectibles stay scalar until design 28 |
| `src/finance/account-rules/us/us-real-property-classes.js` | Asset-level `value` + transactional basis | No change (path B per §5.3); real estate stays scalar until design 28 |
| `src/finance/economic-regimes/revalue-asset-reducer.js` *(introduced by design 21)* | Multiplies `account.balance` by `multiplier` for matching `rateKey` | Multiplies each `holding.marketValue` whose `holding.rateKey` matches; calls `_syncBalance` |
| `src/finance/economic-regimes/rate-keys.js` *(introduced by design 21)* | `EQUITY_US`, `FIXED_INCOME_US`, etc. | Adds `FIXED_INCOME_AU` to round out the AU bond rate key (the AU fixed-income account today rolls under a generic interest rate) |
| `src/finance/services/state-schema-registry.js` | Per-account exact paths + globs | Plus the §5.6 holdings paths |
| `src/scenarios/scenario-compiler.js` | `state()` patches → registration | Plus emit `HOLDING_SPLIT` initial actions per §6.7 for toolsets that declare splits |
| `src/finance/serialization/scenario-serializer.js` | `_serializeAccount` / `_deserializeAccount` | Holdings array round-trips per §8 |
| `src/visualization/accounts/account-editor.js` | Account fields editor | Read-only holdings table per §9 |
| `src/visualization/chart/chart-presenter.js` *(or wherever the catalog lives)* | Default series catalog | Adds `*.holdings[*].marketValue` group |
| `src/index.js` | Auto-generated | Re-run `npm run build:index` |

---

## 12. Testing

### 12.1 New tests

- `tests/unit/holding.test.mjs` — `Holding` constructor / serialization / `unrealizedGainLoss` derivation.
- `tests/unit/holdings-actions.test.mjs` — every `HOLDING_*` action / reducer pair: pure-function shape, balance invariant after each.
- `tests/unit/holdings-invariant.test.mjs` — runs the production `IntlRetirementScenario` for N years and asserts the §4.4 invariant on every reducer tick.
- `tests/unit/holdings-allocation-bootstrap.test.mjs` — every account class registers with the correct default holding (`allocation`, `rateKey`).
- `tests/unit/holdings-toolset-split.test.mjs` — declaring a 60/40 split in a toolset produces two holdings at boot, each carrying its expected `rateKey`.
- `tests/unit/holdings-cost-basis-fifo.test.mjs` — `STOCK_WITHDRAWAL` consumes holdings in purchase-date order; realized basis matches the FIFO ledger.
- `tests/unit/reducer-postconditions.test.mjs` — generalized per-reducer postcondition table (see [design 37](37-reducer-test-framework.md)); seeded with the holdings/transaction/no-op reducers, burns down to every reducer class.

### 12.2 Extended tests

- `tests/unit/scenario-roundtrip.test.mjs` — every scenario in the corpus round-trips with byte-identical holdings.
- `tests/unit/serializer-finance-roundtrip.test.mjs` — `Holding` survives the framework-level round-trip via `TypeRegistry`.
- `tests/unit/evt-401k.test.mjs`, `evt-ira.test.mjs`, `evt-roth.test.mjs`, `evt-us-brokerage.test.mjs`, `evt-au-brokerage.test.mjs` — each gains an assertion that `holdings.length === 1` after bootstrap and `holdings[0].marketValue === account.balance` after any earnings tick. With a single default holding, every existing assertion on `account.balance` continues to pass without modification.
- `tests/unit/intl-retirement-mc-runner.test.mjs` — adds a single-iteration assertion that holdings survive Monte Carlo's clone/run/restore cycle.

### 12.3 Tests that should *not* need changes

Tax tests (`tax-rates.test.mjs`, `tax-documents.test.mjs`, `evt-roth-conversion.test.mjs`, `evt-real-property.test.mjs`, `evt-collectible.test.mjs`), period tests, builder tests, the full graph / viz suite — none of these touch `account.holdings` directly. They pass through the migration unmodified. If any fails, that's a sign the holdings invariant or a sync-balance write went wrong.

---

## 13. Interaction with existing designs

| Existing design | Interaction |
|---|---|
| **21 — Regimes** | `RevalueAssetReducer` migrates per §6.6 (touch-up, contract unchanged). `state.effectiveGrowthRates[rateKey]` is now read **per holding** rather than per account. The shock library's `levelEffects.equityRevaluation` continues to use the same `rateKeys` keys; the difference is which holdings inside an account it touches. The dividend-cut extension noted in roadmap §3.4 is unblocked by §6.5 (`DividendScheduledHandler` now reads per-holding values) but its own design is a follow-up. |
| **23 — FX** | Untouched. Holdings inherit `account.currency`; multi-currency holdings inside one account are out of scope (§3). FX rate keys (`USD_AUD`) don't interact with `Holding.rateKey`. |
| **15 — Config as Source of Truth** | Holdings flow through the same `cfg.accounts[*].holdings` array as every other account field. `buildDefaultConfig()` populates the default-single-holding shape; user edits to holdings (when the editor flows ship) round-trip through `cfg` the same way `plannedSaleYear` does post-design-15. |
| **19 — Type Registry** | `Holding` registers as a type. `HOLDING_*` actions register with `family: 'HOLDING'`, `cc: null`, and explicit `fields` for the action-detail panel. |
| **17 — Scenario as Graph Node** | Branching scenarios snapshot holdings as part of the per-account state via `structuredClone` — same path as `account.balance`. No interaction beyond the snapshot shape growing. |
| **0 — Period Engine** | No interaction. Holdings mutations don't touch the period queue. |
| **18 — Performance** | Per-holding iteration adds a small per-tick cost on earnings handlers. For the current production scenario (one default holding per account), the cost is one extra array iteration of length 1 per handler invocation — well below the per-reducer `structuredClone` cost flagged in design 18. If a future scenario splits accounts into many sleeves, the cost scales linearly; budgets and the design-18 reducer caching strategy continue to apply. |

---

## 14. Open questions and follow-ups

These are explicitly punted to design 28 or 29 unless flagged otherwise:

- **Allocation strategy beyond pro-rata.** A toolset may want "contributions go 100% to the bond sleeve until rebalanced." Design 29's `RebalanceHandler` is the natural home.
- **Specific-lot identification.** `costBasisStrategy: 'SPECIFIC'` requires UI to pick a lot at withdrawal time; deferred until tax-loss harvesting (design 29 future-future) needs it.
- **Inherited basis (step-up).** Mortality (§3.3, design 27) needs the survivor's holdings to receive a basis adjustment at `PERSON_DIED`. Mechanism is a `HOLDING_SET_BASIS` chain; the policy (full step-up, half step-up under joint accounts, no step-up for IRAs) is design 27 + a small estate-rules table.
- **Holding-level dividend yield.** Roadmap §3.4 calls dividend-yield cuts a small follow-up to design 21. Implementation reads `holding.dividendYield` × `holding.marketValue` and falls back to the handler's static yield; `holding.dividendYield` is added in design 28.
- **Real estate / collectibles as holdings.** Path B per §5.3. Revisit when design 28's appreciation schedules land.
- **Per-holding `purchaseDate` for AU CGT 12-month discount.** AU brokerage tests should grow an assertion that purchases dated > 12 months prior to sale receive the 50% discount; this is a tax-rule policy attached to a holding attribute that the holdings substrate makes available. Mechanically straightforward post-25; treated as a follow-up because the AU CGT discount math itself isn't this design's substrate piece.

---

## 15. Summary

`Holding` is the substrate the financial-modeling roadmap pivots on. With it, asset allocation, cost-basis-as-state, per-holding rate exposure, FIFO basis consumption, and the read surface every future design (28, 29, the dividend-cut follow-up) needs all become tractable.

The shape it lands in is intentionally minimal: a plain-data record on `sim.state`, a denormalized `account.balance` scalar synced by reducers, a five-action family for every holdings-level mutation, a one-PR big-bang migration that leaves every existing scenario passing because every account starts with one default holding.

Everything else — appreciation schedules, location codes, bond duration, panic selling, tax-loss harvesting, joint inheritance — sequences behind this. None of it needs new substrate; all of it reads the same `holdings` array.

---

## 16. Implementation Notes (2026-06-03)

All 10 migration steps from §10 landed in a single working session. Test suite: **2,571 passing** (1,961 unit + 610 viz). §4.4 invariant verified on `IntlRetirementScenario` at boot, after 5 years, and after 10 years.

### 16.1 What landed

| Step | Status | Notes |
|---|---|---|
| 1. Primitives (`Holding`, `ALLOCATION`, `resolveRateKey`) | ✅ Done | `src/finance/holdings/{holding,allocation,default-allocations}.js` |
| 2. `Account.holdings` + service bootstrap | ✅ Done | `AccountService._bootstrapDefaultHolding` + helpers (`registerHolding`, `unrealizedGainLoss`, `findOrCreateHolding`, `defaultHoldingFor`, `holdingsByAllocation`) |
| 3. `HOLDING_*` action family + reducers | ✅ Done | `holding-actions.js`, `holding-reducers.js`. Wired into `TypeRegistry` + every compiled scenario via `ScenarioCompiler` and `ServiceRegistry` |
| 4. Earnings handlers migrated | ✅ Done | All Roth/IRA/K401/UsStock/AuStock/Super/FixedIncome/AuFixedIncome/AuSavings/AuStockDividend handlers walk holdings via the shared `computeHoldingsGrowth` helper |
| 5. `RevalueAssetReducer` migrated | ✅ Done | Shocks each `holding.marketValue` whose `rateKey` matches; re-syncs balance from Σ. RealProperty/Collectible scalar `value` path preserved |
| 6. STOCK_WITHDRAWAL FIFO basis | ✅ Done | `consumeHoldingsFifo()` helper; US + AU `StockWithdrawalApplyReducer` use it. `costBasisStrategy` field on the reducer (`FIFO` / `LIFO` / `SPECIFIC`) for design 29 extension |
| 7. Toolset bootstrap-split mechanism | ✅ Done | `bootstrapHoldingSplit(account, splits, simStart)` helper available; no production toolset opts in yet (every account is single-sleeve) |
| 8. Serialization round-trip | ✅ Done | `Holding.toJSON`/`fromJSON` round-trips via TypeRegistry; `_serializeAccount`/`_makeAccount` carry `holdings: []`; legacy configs without `holdings` re-bootstrap on register |
| 9. Read-only holdings UI | ✅ Done | Holdings table in `account-editor.js` (label, allocation, rateKey, market value, cost basis, unrealized G/L, purchase date); StateSchemaRegistry stamps per-holding paths (`*.holdings.*.marketValue` etc.) |
| 10. Invariant + FIFO + roundtrip tests | ✅ Done | `holdings-invariant.test.mjs` (12 cases incl. 5/10-year sim), `holdings-cost-basis-fifo.test.mjs` (9 cases), `holdings-roundtrip.test.mjs` (3 cases), plus 36 substrate tests (`holding.test.mjs`, `holdings-actions.test.mjs`) |

### 16.2 Deviations from the design as written

- **Action classes extend `Action` directly, not `FieldValueAction`** (§6.1 said the latter). `FieldValueAction`'s `(fieldName, value)` shape doesn't accommodate the multi-field payloads (`HOLDING_TRANSACT` carries `stateKey`, `holdingId`, `marketValueDelta`, `costBasisDelta`). Extending `Action` keeps the payload explicit; `TypeRegistry.registerActionType` still publishes the schema for the workbench's action-detail panel.

- **`AccountService.transaction()` now also syncs `holdings[0].marketValue` for single-holding accounts.** Without this, every legacy cash-flow reducer that calls `transaction()` (expenses, wages, SS, replenishSavings, rollovers, mortgages, real-property sales, …) would break the §4.4 invariant mid-tick. The alternative — migrating every cash-flow handler individually — was out of scope for this session. Multi-holding accounts (post-toolset-split) intentionally do **not** get pro-rata sync; the caller must emit explicit `HOLDING_TRANSACT` against the correct sleeve, matching the design's intent (§6.5).

- **`UsSavingsInterestMonthlyHandler` was NOT migrated to emit `HOLDING_TRANSACT`.** Its reducer (`UsSavingsInterestCreditReducer`) routes through `accountService.transaction()`, which already syncs holdings. Adding `HOLDING_TRANSACT` would double-count. AU savings/fixed-income reducers (`AuSavingsEarningsApplyReducer`, `AuFixedIncomeEarningsApplyReducer`) use direct balance mutation and DO emit `HOLDING_TRANSACT` as designed.

- **`STOCK_WITHDRAWAL_APPLY` keeps backward compatibility with action-data `costBasis`.** When `action.costBasis` is set (legacy tests, manually scheduled withdrawals), it wins over FIFO. When absent, the reducer FIFO-consumes holdings and emits `STOCK_WITHDRAWAL_TAX` with the realized basis. This satisfies design §6.4 for new code paths without invalidating existing tests that pass `costBasis` in event data.

- **`replenishSavings()` is unchanged.** It uses pro-rata basis from `account.earningsBasis`. Per design §7's allowance for legacy direct-balance mutation, and because every drawdown-source account currently has one default holding (where pro-rata = FIFO = SPECIFIC), this is acceptable. Future-future toolset splits in drawdown sources would need this path migrated.

- **`state-utils.js#_leafEqual` now deep-equals object-typed array elements.** Required because `structuredClone` produces value-equal but reference-different array elements (holdings), and the original `_leafEqual` reported spurious diffs for every reducer that snapshotted state but didn't touch holdings. The change is value-safe for arrays of primitives (numbers in `state.metrics.*`) and is correct for arrays-of-records more generally.

- **Toolset state-plain helpers (`us-retirement-toolset.js`, `au-retirement-toolset.js`#`_accountToStatePlain`) now carry `holdings`.** These plain-object copies are what `sim.state` actually holds; omitting holdings would leave the substrate unreachable from handlers. Two near-duplicate helpers — DRYing them is a follow-up.

### 16.3 Follow-ups (not blocking; deferred to designs 28 / 29 / future)

- **Per-holding appreciation schedules + bond duration** — design 28.
- **Per-holding `dividendYield`** — small follow-up to design 21 once design 28 lands.
- **`RealProperty` / `Collectible` folded into Holdings** — design 28 revisit point per §5.3 path B.
- **LIFO / specific-lot identification** — `costBasisStrategy` constructor field is wired (`'FIFO' | 'LIFO' | 'SPECIFIC'`); only FIFO branch is implemented. Specific-lot needs UI work for lot selection — track under design 29 (tax-loss harvesting).
- **Stepped-up basis at inheritance** — `HOLDING_SET_BASIS` is ready; the policy table (full / half / none by jurisdiction × account-type) is design 27 + a small estate-rules module.
- **AU CGT 12-month discount via `purchaseDate`** — substrate is ready; the AU CGT module needs to consult `purchaseDate` rather than the existing flag. Roughly a half-day of tax-module work.
- **`replenishSavings` FIFO migration** — only meaningful once toolsets declare multi-sleeve drawdown sources.
- **`MonthlyExpenses`, `MonthlyWages`, `MonthlySocialSecurity` handlers** — these go through `transaction()` so the invariant holds, but they don't emit explicit `HOLDING_TRANSACT`. Migrating them yields better journal granularity (visible per-sleeve impact for behavioral handlers in design 29) but isn't required for §4.4.
- **DRY `_accountToStatePlain` across `us-retirement-toolset.js` / `au-retirement-toolset.js`** — small refactor; move to `src/finance/state/account-to-state-plain.js`.
- **Per-holding `marketValue` in `account.earningsBasis` reconciliation** — `StockWithdrawalApplyReducer` still derives `contributionBasis = balance - earningsBasis` and updates `earningsBasis` from realized gain. With state-derived holdings basis, the per-account `earningsBasis` field becomes redundant for brokerage accounts; consolidating is a follow-up but not blocking.
- **Holdings editing UI** — read-only this design (§9). Editing flows ship with design 28 once appreciation schedules give the user something meaningful to edit.

### 16.4 Files added

| Path | Purpose |
|---|---|
| `src/finance/holdings/holding.js` | `Holding` plain-data class with `toJSON`/`fromJSON` |
| `src/finance/holdings/allocation.js` | `ALLOCATION` enum + `ALLOCATION_VALUES` |
| `src/finance/holdings/default-allocations.js` | `DEFAULT_ALLOCATION_BY_ROLE` (preferred), `DEFAULT_ALLOCATION_BY_TYPE` (fallback), `resolveDefaultAllocation`, `resolveRateKey` |
| `src/finance/holdings/holding-actions.js` | Five `Holding*Action` subclasses + `HOLDING_ACTION_TYPES`, `HOLDING_ACTION_ENTRIES`, `registerHoldingActionTypes()` |
| `src/finance/holdings/holding-reducers.js` | Five reducers + shared `_syncBalance()` |
| `src/finance/holdings/holdings-earnings.js` | `computeHoldingsGrowth({state, stateKey, fallbackRate, fallbackRateKey, rateSource, factor, rateOverride})` — single helper used by every earnings/interest handler |
| `src/finance/holdings/holdings-fifo.js` | `consumeHoldingsFifo(holdings, amount)` — FIFO consumption + realized-basis accumulation |
| `src/finance/holdings/bootstrap-holding-split.js` | `bootstrapHoldingSplit(account, splits, simStart)` — toolset opt-in helper for multi-sleeve declaration at boot |
| `tests/unit/holding.test.mjs` | 16 substrate tests |
| `tests/unit/holdings-actions.test.mjs` | 20 action/reducer tests |
| `tests/unit/holdings-invariant.test.mjs` | 12 §4.4 invariant + bootstrap tests |
| `tests/unit/holdings-cost-basis-fifo.test.mjs` | 9 FIFO tests |
| `tests/unit/holdings-roundtrip.test.mjs` | 3 serialize→deserialize tests |

### 16.5 Files touched

`src/finance/assets/account.js` · `src/finance/services/account-service.js` · `src/finance/handlers/earnings-handlers.js` · `src/finance/handlers/us-savings-interest-handler.js` (no-op revert) · `src/finance/economic-regimes/revalue-asset-reducer.js` · `src/finance/account-rules/us/us-brokerage-classes.js` · `src/finance/account-rules/au/au-brokerage-classes.js` · `src/finance/services/state-schema-registry.js` · `src/scenarios/scenario-serializer.js` · `src/scenarios/toolsets/scenario-compiler.js` · `src/scenarios/toolsets/us-retirement-toolset.js` · `src/scenarios/toolsets/au-retirement-toolset.js` · `src/services/service-registry.js` · `src/simulation-framework/state-utils.js` · `src/visualization/accounts/account-editor.js` · `index.html` · `assets/css/plugins/config-builder.css` · `src/index.js` (auto-generated)
