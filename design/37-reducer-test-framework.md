# 37 — Reducer Test Framework & Postcondition Coverage

> Status: **Complete** — every concrete reducer has an isolated postcondition test; the coverage gate
> (§8.5) enforces it. The `INDIRECT` burn-down is empty (§9). One latent bug surfaced & fixed (§7.4).
> Origin: Design 25 (Holding-Level State) §4.4 left a TODO:
>
> > *Per-reducer postconditions (unit tests) — each reducer asserts local invariants: §4.4
> > (`balance == Σ marketValue`), `basis ≥ 0`, `mv ≥ 0`, and money-conservation for transfers
> > (debit one == credit other). I've added these for transaction/holdings; the pattern
> > generalizes to every reducer.*
>
> This document generalizes that pattern to **every reducer in the application**: it defines the
> invariant taxonomy, a reusable test harness, and a coverage checklist we drive to completion.

---

## 1. Why

Reducers are the only place `sim.state` is mutated. They are required to be **pure**
(`(state, action, date) → state'`) and to preserve a small set of **local invariants** regardless of
which scenario invokes them. Today those invariants are verified mostly *indirectly*:

- The holdings reducers and `AccountTransactionReducer` have dedicated postcondition tests
  (`holdings-actions.test.mjs`, `holdings-invariant.test.mjs`, `holding-balance-sync.test.mjs`).
- The ~50 account-module reducers (`AccountServiceReducer` subclasses) are exercised end-to-end by the
  `evt-*.test.mjs` scenario suite, but **no test pins their local postconditions** in isolation. A
  scenario test that happens to still pass can mask a reducer that silently breaks the §4.4 invariant
  mid-tick (exactly the class of bug that motivated Design 25, and the "account bounce" desync bug).

A scenario test answers *"did the 30-year number come out right?"*. A postcondition test answers
*"is this reducer locally correct for any input?"* — which is what lets us refactor the engine
without fear. We want both. This doc builds the second layer.

---

## 2. Invariant taxonomy

Each reducer is tagged with the invariants that **must** hold across its `reduce()` call. Not every
invariant applies to every reducer — the checklist in §6 records which apply.

| # | Invariant | Statement | Applies to |
|---|-----------|-----------|-----------|
| **I1** | **Purity / no input mutation** | `reduce(state, …)` returns a value; the *input* `state` object is structurally unchanged (deep-equal to a pre-call clone). **Exception:** service-backed reducers that call `AccountService.transaction()`/`replenishSavings()` mutate accounts in place (see §7.3) — for those, assert I3/I5 on the result and skip I1 (`checkNoMutation: false`). | **Every** reducer except the `transaction()`-backed family. |
| **I2** | **Determinism** | Same `(state, action, date)` → deep-equal output on repeat calls. (RNG-driven reducers seed from state/action, so this still holds.) | Every reducer. |
| **I3** | **§4.4 balance sync** | For every account touched: `account.balance === Σ holdings[i].marketValue` (rounded to currency precision). **Granularity:** reducer-local for holdings-mutating reducers (`transaction`/`HOLDING_*`); **event-level** for the earnings family, where the scalar `*_EARNINGS_APPLY` reducer and its paired `HOLDING_TRANSACT` together restore the invariant (see §7.2). | Any reducer that mutates `holdings` or `balance`. |
| **I4** | **Non-negativity** | `marketValue ≥ 0`, `costBasis ≥ 0`, and `balance ≥ 0` after the call. | Account/holdings reducers. *Exceptions documented* (e.g. deficit accumulators). |
| **I5** | **Money conservation** | For transfers: `Δsource + Δdest == 0` (same currency), or `|Δsource| · rate == |Δdest|` within FX tolerance. Fees/taxes are explicit terms, not leakage. | Transfer/withdrawal/contribution/tax-debit reducers. |
| **I6** | **Cost-basis correctness** | Basis tracks the documented method (FIFO for holdings); a partial disposal reduces basis proportionally to units removed; full disposal zeroes basis. | Reducers that dispose/acquire holdings. |
| **I7** | **No-op / missing-target safety** | Action referencing an absent account/holding/period returns `state` unchanged and does not throw. | Every reducer. |
| **I8** | **Field scope** | `FieldReducer`-family reducers write **only** their declared field path; no collateral state writes. | Framework field reducers + scripted/metric reducers. |
| **I9** | **Monotonicity** | Accumulators that should only grow (cumulative deficit, lifetime tax) never decrease across a call. | `AccumulateDeficitReducer`, metric accumulators. |
| **I10** | **Idempotency** | Re-applying a "settle/mark" action that has already fired is a no-op (where the semantics demand it — e.g. set-out-of-funds-date only sets once). | Marker/latch reducers. |

---

## 3. Reusable test harness

Add `tests/helpers/reducer-postconditions.js`. It centralizes the invariant assertions so each
reducer test is a few lines and new invariants are added in one place.

```js
// tests/helpers/reducer-postconditions.js
import assert from 'node:assert/strict';

const CURRENCY_EPS = 0.005;   // half a cent

export function sumHoldings(account) {
  return (account.holdings ?? []).reduce((s, h) => s + (h.marketValue ?? 0), 0);
}

// I3 — §4.4 balance sync for every account in a state tree (or a named subset).
export function assertBalanceInvariant(state, stateKeys = null) {
  for (const [key, node] of Object.entries(state)) {
    if (!node || typeof node !== 'object' || !Array.isArray(node.holdings)) continue;
    if (stateKeys && !stateKeys.includes(key)) continue;
    assert.ok(
      Math.abs((node.balance ?? 0) - sumHoldings(node)) <= CURRENCY_EPS,
      `§4.4 violated for ${key}: balance=${node.balance} Σmv=${sumHoldings(node)}`,
    );
  }
}

// I4 — non-negativity (opt-out per field for documented exceptions).
export function assertNonNegative(state, { allowNegativeBalance = [] } = {}) {
  for (const [key, node] of Object.entries(state)) {
    if (!node || typeof node !== 'object') continue;
    for (const h of node.holdings ?? []) {
      assert.ok(h.marketValue >= -CURRENCY_EPS, `mv<0 in ${key}`);
      assert.ok(h.costBasis   >= -CURRENCY_EPS, `basis<0 in ${key}`);
    }
    if (Array.isArray(node.holdings) && !allowNegativeBalance.includes(key)) {
      assert.ok(node.balance >= -CURRENCY_EPS, `balance<0 in ${key}`);
    }
  }
}

// I1 — input not mutated. Pass a clone captured BEFORE the reduce() call.
export function assertNoInputMutation(before, inputAfter) {
  assert.deepEqual(inputAfter, before, 'reducer mutated its input state (I1)');
}

// I5 — money conservation between two stateKeys (same currency).
export function assertConserved(prev, next, srcKey, dstKey, { fee = 0 } = {}) {
  const dSrc = next[srcKey].balance - prev[srcKey].balance;
  const dDst = next[dstKey].balance - prev[dstKey].balance;
  assert.ok(Math.abs(dSrc + dDst + fee) <= CURRENCY_EPS,
    `money not conserved: Δsrc=${dSrc} Δdst=${dDst} fee=${fee}`);
}

// Convenience wrapper: run a reducer and assert the standard bundle.
export function runReducer(reducer, state, action, date, opts = {}) {
  const before = structuredClone(state);
  const next   = reducer.reduce(state, action, date);
  if (opts.checkNoMutation !== false) assertNoInputMutation(before, state);
  if (opts.balance)      assertBalanceInvariant(next, opts.balance === true ? null : opts.balance);
  if (opts.nonNegative)  assertNonNegative(next, opts.nonNegative === true ? {} : opts.nonNegative);
  return next;
}
```

### Table-driven reducer spec

For the bulk account-module reducers, a table keeps each test to one row:

```js
// tests/unit/reducer-postconditions.test.mjs
import { test } from 'node:test';
import { runReducer } from '../helpers/reducer-postconditions.js';
import { makeAccountState, makeAction } from '../helpers/reducer-fixtures.js'; // NEW small fixture lib

const CASES = [
  { name: 'RothContribution',  reducer: () => new RothContributionApplyReducer(services),
    state: makeAccountState({ role: ACCOUNT_ROLES.ROTH, balance: 1000 }),
    action: makeAction('ROTH_CONTRIBUTION', { amount: 500 }),
    expect: { balance: true, nonNegative: true } },
  // … one row per reducer …
];

for (const c of CASES) {
  test(`reducer-postconditions: ${c.name}`, () => {
    runReducer(c.reducer(), c.state, c.action, c.date ?? new Date('2030-01-15'), c.expect);
  });
}
```

`tests/helpers/reducer-fixtures.js` (new) provides `makeAccountState()` /
`makeAction()` builders modeled on the inline helpers already in `holdings-actions.test.mjs`, so we
don't stand up a whole `ScenarioCompiler` per row.

---

## 4. What "covered" means

A reducer is **covered** when there is a *dedicated, isolated* test that asserts **every invariant in
its checklist row** for at least:

1. a representative happy-path action, **and**
2. the no-op/missing-target case (I7).

Being run inside an `evt-*.test.mjs` scenario is **necessary context but not coverage** — scenario
tests stay, but they don't tick the box here.

---

## 5. Reducer inventory (by group)

128 reducer classes live under `src/` (excluding builders, the editor, and the node renderer). They
group as:

- **A — Framework primitives** (`simulation-framework/reducers.js`): `Reducer` (abstract),
  `AccountTransactionReducer`, `FieldReducer`, `FieldValueReducer`, `ArrayReducer`,
  `NumericSumReducer`, `MultiplicativeReducer`, `MetricReducer`, `BalanceSnapshotReducer`,
  `RepeatingReducer`, `ScriptedReducer`, `NoOpReducer`, `AccountServiceReducer` (abstract).
- **B — Holdings** (`finance/holdings/holding-reducers.js`): `HoldingTransact`, `HoldingRevalue`,
  `HoldingSetBasis`, `HoldingSplit`, `HoldingRetitle`.
- **C — Account modules** (`finance/account-rules/**`, all `AccountServiceReducer`): IRA, 401k, Roth,
  Roth-conversion, Roth-rollover, IRA-rollover, US brokerage, US collectible, US income, US real
  property; AU brokerage, AU fixed-income, AU income, AU real property, AU savings, AU super.
- **D — Top-level finance** (`finance/reducers/**`): `ExpenseDebit`, `ReplenishSavings`,
  `OutOfFunds`, `AccumulateDeficit`, `SetOutOfFundsDate`, `InflationAdjust`,
  `ChangeResidencyApply`, `ChangeStateResidencyApply`, `IntlTransferApply`, `AccountRetitleApply`,
  `PersonDiedApply`, `SocialSecuritySurvivorApply`, `StockDividendCashApply`,
  `UsSavingsInterestCredit`, `ScenarioComplete`.
- **E — Behavioral** (`finance/behavioral/**`): panic-sell (split + apply), opportunistic-rebalance
  (split + apply), asset-location-rebalance, strategic-asset-location, cash-bucket-drawdown,
  contribution-suspension-toggle, downturn-roth-conversion, stock-harvest-apply.
- **F — Economic regimes** (`finance/economic-regimes/**`): `AddRegime`, `RemoveRegime`,
  `RegimeApply`, `BondPriceAdjust`, `RevalueAsset`.
- **G — FX** (`finance/fx/**`): `FxRefresh`, `FxTransferApply`.
- **H — Spending** (`finance/spending/**`): `SpendingStrategyApply`, `AgeBandedSpending`,
  `GuardrailBaselineApply`, `GuardrailAnnualCheck`, `GuardrailAdjustApply`,
  `HealthcareExpenseApply`, `LateLifeCareApply`, `RegimeAwareSpending`.
- **I — Tax / period** (`finance/tax/**`): `DynamicTax`, period-advance (US/AU + base), tax-settle
  (US/AU + base) `*TaxSettleApply` / `*TaxPaymentDebit`, state-tax (`StateIncomeClassification`,
  `StateTaxSettleApply`, `StateTaxPaymentDebit`).
- **J — Misc** : `AssetAppreciate` (`handlers/asset-appreciation-handler.js`),
  `UsMortgagePaymentApply`, `AuMortgagePaymentApply`.

---

## 6. Coverage checklist

Legend — **Status**: ✅ dedicated postcondition test · 🟡 indirect only (`evt-*`/scenario) ·
⬜ no isolated test. **Invariants**: the rows from §2 that this reducer must satisfy.

> The Status column is a **first-pass audit** from test-file references (`grep`), not a per-assertion
> verification. The "🟡 indirect" rows are the work: each needs an isolated postcondition test before
> it flips to ✅. Treat this table as the burn-down list.

### A — Framework primitives

| Reducer | Invariants | Status | Notes |
|---|---|---|---|
| `AccountTransactionReducer` | I1 I3 I4 I5 I7 | ✅ | `holding-balance-sync`, `reducers.test` |
| `FieldReducer` / `FieldValueReducer` | I1 I2 I8 | ✅ | `reducers.test` |
| `ArrayReducer` | I1 I8 | ✅ | `reducers.test` |
| `NumericSumReducer` | I1 I8 I9 | ✅ | `reducers.test` |
| `MultiplicativeReducer` | I1 I8 | ✅ | `reducers.test` |
| `MetricReducer` | I1 I8 | ✅ | `reducers.test` |
| `BalanceSnapshotReducer` | I1 I8 | ✅ `reducer-postconditions-framework-primitives` | |
| `RepeatingReducer` | I1 I8 | ✅ `…framework-primitives` | count>0 path **fixed** (§7.4): threads combined child state over N iterations + merges child `next`; count≤0 no-op |
| `ScriptedReducer` | I1 I2 I8 | ✅ `…framework-primitives` | fieldName-write + spread paths; throwing script degrades to no-op |
| `NoOpReducer` | I1 (identity) | ✅ | `reducers.test` |

### B — Holdings

| Reducer | Invariants | Status |
|---|---|---|
| `HoldingTransactReducer` | I1 I3 I4 I5 I6 I7 | ✅ `holdings-actions` |
| `HoldingRevalueReducer` | I1 I3 I4 I7 | ✅ |
| `HoldingSetBasisReducer` | I1 I4 I7 | ✅ |
| `HoldingSplitReducer` | I1 I3 I4 I6 I7 | ✅ |
| `HoldingRetitleReducer` | I1 I7 | ✅ |

### C — Account-module reducers (`AccountServiceReducer`)

All share invariants **I1 I3 I4 I7**; withdrawal/contribution/dividend/RMD variants add **I5**;
disposal variants add **I6**. **Swept ✅** — isolated postcondition tests in four files:
`reducer-postconditions-us-retirement.test.mjs`, `-us-brokerage.test.mjs`, `-us-income.test.mjs`,
`-au.test.mjs` (52 tests). Three behavioral classes emerged from reading the reducers:

- **Cash-movement reducers** (contribution / withdrawal / RMD / stock sale / conversion) keep §4.4
  **reducer-locally** via `scaleHoldings()` / `debitIra()` / `distributeHoldingsCredit()` /
  `consumeHoldingsFifo()` on the account side and `transaction()` (which syncs holdings) on the cash
  side. Tested for I3 (both accounts) + I5 conservation. Service-backed ⇒ I1 skipped (§7.3).
  Withdrawals leak a penalty → conservation `fee = penaltyAmount`; Roth *contribution* withdrawals are
  penalty-free (`fee = 0`).
- **Earnings + AU dividend reducers** update only the scalar balance/basis; §4.4 is **event-level**
  (handler emits the paired `HOLDING_TRANSACT` — §7.2). Tested for the scalar contract + I1.
- **Exogenous income** (wages/SS/SE/bonus/company sale) and **scalar-asset disposals** (collectible,
  US/AU house) credit the cash pool against an off-ledger source → I3 on the cash account only.

| File | Reducers | Status |
|---|---|---|
| `us/ira-classes.js` | IraContribution, IraEarnings, IraWithdrawalContrib, IraWithdrawalEarnings | ✅ |
| `us/ira-rollover-classes.js` | IraRmdApply, IraRolloverWithdrawal | ✅ |
| `us/k401-classes.js` | K401Contribution, K401Earnings, K401Rmd, K401Withdrawal, K401ToIraConversion | ✅ |
| `us/roth-classes.js` | RothContribution, RothEarnings, RothWithdrawalContrib, RothWithdrawalEarnings | ✅ |
| `us/roth-conversion-classes.js` | RothConversion | ✅ |
| `us/roth-rollover-classes.js` | RothRolloverContribution, RothRolloverEarnings, RothRolloverWithdrawalContrib, RothRolloverWithdrawalEarnings | ✅ |
| `us/us-brokerage-classes.js` | StockContribution, StockEarnings, StockDividend, StockWithdrawal, FixedIncomeContribution, FixedIncomeEarnings, FixedIncomeWithdrawal | ✅ |
| `us/us-collectible-classes.js` | CollectibleSale, CollectibleValueChange | ✅ |
| `us/us-income-classes.js` | WagesIncome, WagesWithheld, SsIncome, SeIncomeUs, Bonus, CompanySale | ✅ |
| `us/us-real-property-classes.js` | UsHouseSale | ✅ |
| `au/au-brokerage-classes.js` | AuStockEarnings, AuStockWithdrawal, Au Dividend {Franked,Unfranked}×{Resident,NonResident} | ✅ |
| `au/au-fixed-income-classes.js` | AuFixedIncomeEarnings | ✅ scalar contract + event-level §4.4 (`earnings-holdings-sync`) |
| `au/au-income-classes.js` | AuSeIncome | ✅ |
| `au/au-real-property-classes.js` | AuHouseSale | ✅ |
| `au/au-savings-classes.js` | AuSavingsContribution, AuSavingsEarnings, AuSavingsWithdrawal | ✅ |
| `au/au-super-classes.js` | SuperContribution, SuperEarnings, SuperWithdrawalContrib, SuperWithdrawalEarnings | ✅ |

### D — Top-level finance reducers

| Reducer | Invariants | Status |
|---|---|---|
| `ExpenseDebitReducer` | I1 I3 I4 I7 | ✅ `reducer-postconditions-finance` (not I1 — §7.3) |
| `ReplenishSavingsReducer` | I1 I3 I5 I7 | ✅ `reducer-postconditions-finance` (not I1 — §7.3) |
| `OutOfFundsReducer` | I1 I7 | ✅ `out-of-funds-reducer` |
| `AccumulateDeficitReducer` | I1 I9 | ✅ `accumulate-deficit-reducer` |
| `SetOutOfFundsDateReducer` | I1 I10 | ✅ `set-out-of-funds-date-reducer` |
| `InflationAdjustReducer` | I1 I2 | ✅ `reducer-postconditions-finance` |
| `ChangeResidencyApplyReducer` | I1 I7 | ✅ `reducer-postconditions-finance` |
| `ChangeStateResidencyApplyReducer` | I1 I7 | ✅ `reducer-postconditions-finance` |
| `IntlTransferApplyReducer` | I1 I3 I5 (FX) I7 | ✅ `reducer-postconditions-finance` (not I1 — §7.3) |
| `AccountRetitleApplyReducer` | I1 I7 | ✅ `reducer-postconditions-finance` |
| `PersonDiedApplyReducer` | I1 I7 | ✅ `reducer-postconditions-finance` |
| `SocialSecuritySurvivorApplyReducer` | I1 I7 | ✅ `reducer-postconditions-finance` |
| `StockDividendCashApplyReducer` | I1 I3 I5 I7 | ✅ `reducer-postconditions-finance` (not I1 — §7.3) |
| `UsSavingsInterestCreditReducer` | I1 I3 I4 I7 | ✅ `reducer-postconditions-finance` (not I1 — §7.3) |
| `ScenarioCompleteReducer` | I1 I10 | ✅ `reducer-postconditions-finance` |

### E — Behavioral

All: **I1 I2 I7**; the `*Apply` reducers that move money/holdings add **I3 I4 I5/I6**.

All ✅ in `reducer-postconditions-behavioral.test.mjs` (21 tests) — all I1-pure (immutable
holdings math / action emission; none service-backed).

| Reducer | Status |
|---|---|
| `PanicSellReducer` / `BehavioralPanicSellApplyReducer` | ✅ |
| `OpportunisticRebalanceReducer` / `OpportunisticRebalanceApplyReducer` | ✅ |
| `AssetLocationRebalanceApplyReducer` | ✅ |
| `StrategicAssetLocationReducer` | ✅ |
| `CashBucketDrawdownReducer` | ✅ |
| `ContributionSuspensionToggleReducer` | ✅ |
| `DownturnRothConversionReducer` | ✅ |
| `StockHarvestApplyReducer` | ✅ |

### F — Economic regimes

| Reducer | Invariants | Status |
|---|---|---|
| `AddRegimeReducer` / `RemoveRegimeReducer` | I1 I7 I10 | ✅ AddRegime (backfill) / RemoveRegime (`regimes-fx`) |
| `RegimeApplyReducer` | I1 I2 I7 | ✅ `regimes-fx` |
| `BondPriceAdjustReducer` | I1 I3 I4 | ✅ `regimes-fx` |
| `RevalueAssetReducer` | I1 I3 I4 I7 | ✅ backfill |

### G — FX

| Reducer | Invariants | Status |
|---|---|---|
| `FxRefreshReducer` | I1 I2 I7 | ✅ `regimes-fx` |
| `FxTransferApplyReducer` | I3 I5 (FX tol.) I7 (not I1 — §7.3) | ✅ backfill |

### H — Spending

All: **I1 I2 I7**; `*ExpenseApply` / debit variants add **I3 I4 I5**.

All ✅ in `reducer-postconditions-spending.test.mjs` (14 tests). All I1-pure budget-slice / tracking
reducers — none move cash or holdings (the recurring debit is `ExpenseDebitReducer`, group D), so no
I3/I4/I5 applies here.

| Reducer | Status |
|---|---|
| `SpendingStrategyApplyReducer` | ✅ |
| `AgeBandedSpendingReducer` | ✅ |
| `GuardrailBaselineApply` / `GuardrailAnnualCheck` / `GuardrailAdjustApply` | ✅ |
| `HealthcareExpenseApplyReducer` | ✅ (I9 monotonic accumulator) |
| `LateLifeCareApplyReducer` | ✅ (apply/revert round-trip) |
| `RegimeAwareSpendingReducer` | ✅ (apply/revert round-trip) |

### I — Tax / period

| Reducer | Invariants | Status |
|---|---|---|
| `DynamicTaxReducer` | I1 I2 I7 | ✅ `reducer-postconditions-tax` |
| `Us/AuPeriodAdvanceReducer` (+ base) | I1 I7 I10 | ✅ `reducer-postconditions-tax` |
| `Us/AuTaxSettleApplyReducer` (+ base) | I1 I3 I5 I7 | ✅ `reducer-postconditions-tax` (YTD reset + chained debit; §4.4/I5 event-level) |
| `Us/AuTaxPaymentDebitReducer` (+ base) | I1 I3 I4 I5 I7 | ✅ `reducer-postconditions-tax` (not I1 — §7.3) |
| `StateIncomeClassificationReducer` | I1 I7 | ✅ backfill |
| `StateTaxSettleApplyReducer` | I1 I7 (resets YTD; chains debit) | ✅ backfill |
| `StateTaxPaymentDebitReducer` | I3 I4 I7 (not I1 — §7.3) | ✅ backfill |

### J — Misc

| Reducer | Invariants | Status |
|---|---|---|
| `AssetAppreciateReducer` | I1 I4 I7 (scalar value) | ✅ backfill |
| `UsMortgagePaymentApplyReducer` | I3 I4 I5 I7 (not I1 — §7.3) | ✅ backfill |
| `AuMortgagePaymentApplyReducer` | I3 I4 I5 I7 (not I1 — §7.3) | ✅ backfill |

---

## 7. Audit notes

### 7.1 Zero-reference reducers — now backfilled (§8.2 ✅)

From a name-reference grep, these 11 concrete reducer classes had **zero** mention anywhere under
`tests/`. All are now pinned in `tests/unit/reducer-postconditions-backfill.test.mjs`:

`AddRegimeReducer`, `AssetAppreciateReducer`, `AuFixedIncomeEarningsApplyReducer`,
`AuMortgagePaymentApplyReducer`, `FxTransferApplyReducer`, `K401ToIraConversionApplyReducer`,
`RevalueAssetReducer`, `StateIncomeClassificationReducer`, `StateTaxPaymentDebitReducer`,
`StateTaxSettleApplyReducer`, `UsMortgagePaymentApplyReducer`. (The abstract bases
`AccountServiceReducer`, `BaseReducer`, `BaseFieldReducer`, `BaseFieldValueReducer` need no
behavioral test.)

### 7.2 §4.4 for the earnings family is event-level, not reducer-local (corrected)

> An earlier draft of this section called the `*EarningsApplyReducer` family a "systemic §4.4
> desync bug." **That was an over-call** — the result of testing the earnings reducer in isolation,
> the wrong granularity. The reducers are correct by design. Corrected finding below.

The `*_EARNINGS_APPLY` **reducer** is intentionally responsible only for the scalar `account.balance`
(and `earningsBasis`). The active earnings **handler** (`Intl*EarningsHandler` / `*InterestHandler`
in `src/finance/handlers/earnings-handlers.js`) emits, **in the same action batch**, the
`*_EARNINGS_APPLY` action *followed by* one `HoldingTransactAction` per sleeve — computed by
`computeHoldingsGrowth()` with `marketValueDelta = growth`, `costBasisDelta = 0` (appreciation does
not raise basis). `HoldingTransactReducer` (POSITION_UPDATE, after the earnings reducer at CASH_FLOW)
applies those and re-syncs `balance` to `Σ marketValue`. So **§4.4 holds after the batch**, which is
why the production holdings-invariant test is green.

Two things made this look like a bug at first glance:
- Every account bootstraps a holding, so the earnings reducer *alone* leaves `balance ≠ Σ mv`
  mid-batch — true, but transient; the paired `HOLDING_TRANSACT` closes it before the tick ends.
- There is a **second, legacy** set of colocated handlers (`RothEarningsHandler`, `IraEarningsHandler`,
  `StockEarningsHandler`, … inside `account-rules/*-classes.js`) that emit `*_EARNINGS_APPLY` **without**
  holding actions. These bind to the bare events (`ROTH_EARNINGS`, …); production schedules the
  holdings-aware `INTL_*`/interest events instead, and the legacy handlers are pushed **with no event
  bound** — so they never fire. They are dormant duplicates (a footgun, not an active bug).

**Consequence for the framework:** §4.4 (I3) for the earnings family is an **event-level** invariant
(reducer + paired `HOLDING_TRANSACT`), not a reducer-local one. It is pinned that way in
`tests/unit/earnings-holdings-sync.test.mjs` — a green test, **no `todo`**. Do **not** "migrate" the
earnings reducers to touch holdings themselves: the handler already emits the holding delta, so a
reducer-side update would **double-apply** and break §4.4 the other way. The reducer's own row asserts
only its scalar contract + I1.

> Open follow-up (low priority, not a correctness bug): delete the dormant legacy colocated
> `*EarningsHandler` classes so no future wiring can schedule the no-holdings path by accident.

> Caveat: a grep hit only proves the *name* appears in a test — it does not prove a postcondition is
> asserted. The 🟡 rows must each be opened and verified, not trusted. The point of this doc is to
> replace "the scenario still passed" with "the reducer is locally pinned."

### 7.3 Finding: service-backed reducers are not I1-pure

`AccountService.transaction()` (and `replenishSavings()`) **mutate the account in place**. Every
reducer built on them — `FxTransferApply`, the mortgage reducers, `StateTaxPaymentDebit`, and the
whole `AccountServiceReducer` cash-flow family — therefore violates I1 (no input mutation) at the
reducer boundary, even though they return a fresh top-level state via `newState()`. The simulation as
a whole stays correct because the journal snapshots state with `structuredClone` at the tick
boundary, so the impurity does not leak across events. The harness handles this with
`runReducer(..., { checkNoMutation: false })` and snapshots the pre-state for conservation checks.
This is captured as an explicit exception in §2 (I1) rather than treated as a bug.

### 7.4 Finding & fix: `RepeatingReducer`'s active (count>0) path was broken

Pinning `RepeatingReducer` in isolation surfaced a real latent bug. For `count <= 0` it was already a
clean no-op (`return this.newState(state)`). For `count > 0` it ran each child reducer once, then
called:

```js
this.newState(state, {}, { ...action, _repeaterCounter: count - 1 });
```

`newState(currentState, toAdd, next)` does `[...next, ...emitted]`, so passing an **object** (not an
array) threw `TypeError: next is not iterable`. The line also lacked a `return`, and rebuilt from the
original `state` rather than the loop's accumulated state — so even past the throw the child effects
would have been discarded and the action would never actually repeat. The reducer is in
`REDUCER_CLASSES` but was evidently never exercised on the active path in production (it would crash).

**Fixed.** The reducer now runs the whole action `count` times, threading one combined state through
every child and every iteration (each child's modification propagates to the next child and the next
pass), and — because a reducer return exposes a single `next` array — it collects every
child-emitted action across all iterations and returns them merged, so the engine queues each one.
The fragile re-emit/`_repeaterCounter` pipeline path is gone; the count is resolved from a fixed
`this.count` or `action[fieldName]`. Pinned in `reducer-postconditions-framework-primitives.test.mjs`
(threading across children/iterations, `next` collection, count-from-field, count≤0 no-op).

---

## 8. Rollout plan

1. ✅ **Land the harness** — `tests/helpers/reducer-postconditions.js` + `tests/helpers/reducer-fixtures.js`,
   plus the seeded `tests/unit/reducer-postconditions.test.mjs` table file (holdings/transaction/no-op
   rows + harness self-tests).
2. ✅ **Backfill the 11 zero-reference reducers** (§7.1) — `tests/unit/reducer-postconditions-backfill.test.mjs`.
   Surfaced the `*EarningsApply` §4.4 desync (§7.2) and the service-backed I1 exception (§7.3).
3. ✅ **Sweep group C** (account modules) — `reducer-postconditions-{us-retirement,us-brokerage,us-income,au}.test.mjs`
   (52 tests). Cash-movement reducers asserted reducer-local I3 + I5; earnings/dividends asserted
   scalar contract + I1 (event-level §4.4 per §7.2); exogenous income asserted I3 on the cash pool.
   No production bugs found — every cash-movement reducer keeps §4.4 locally via
   `scaleHoldings`/`debitIra`/`distributeHoldingsCredit`/`consumeHoldingsFifo`.
4. **Groups D–J** — convert 🟡 → ✅ row by row. ✅ **Group D swept** —
   `reducer-postconditions-finance.test.mjs` (24 tests) pins all 12 top-level finance reducers:
   pure people/state reducers asserted I1 + I2/I7/I10 as tagged; service-backed cash movers
   (ExpenseDebit, ReplenishSavings, IntlTransfer, StockDividendCash, UsSavingsInterestCredit) asserted
   reducer-local I3/I4 + I5 conservation with I1 skipped (§7.3). No production bugs found.
   ✅ **Group E swept** — `reducer-postconditions-behavioral.test.mjs` (21 tests): trigger reducers
   asserted I1 + I2/I7/I10 (per-shock latch); `*Apply` reducers asserted I3/I4/I6 (+ I5 for the
   cross-account asset-location swap). All I1-pure — none are service-backed. No production bugs found.
   ✅ **Groups F+G swept** — `reducer-postconditions-regimes-fx.test.mjs` (10 tests): RemoveRegime
   (I1/I7/I10), RegimeApply (I1/I2/I7 — effective-rate composition + recovered-regime drop),
   BondPriceAdjust (I1/I3/I4 mark-to-market + clamp), FxRefresh (I1/I2/I7). All I1-pure. No production
   bugs found.
   ✅ **Group H swept** — `reducer-postconditions-spending.test.mjs` (14 tests): all 8 spending
   reducers, all I1-pure budget-slice / tracking reducers (no cash movement ⇒ no I3/I4/I5). Asserted
   I1 + I2/I7 as tagged, plus I9 for the healthcare accumulator and apply/revert round-trips for
   late-life-care and regime-aware spending. No production bugs found.
   ✅ **Group I swept** — `reducer-postconditions-tax.test.mjs` (12 tests): DynamicTax (I1/I2/I7 +
   wiring-guard throw), US/AU period-advance (I1/I7/I10 + filing-single tracking), US/AU tax-settle
   (I1 — YTD reset incl. AU per-person maps + chained debit; §4.4/I5 event-level), US/AU
   tax-payment-debit (service-backed I3/I4 + cap-to-available, I1 skipped per §7.3). No production bugs
   found.
   ✅ **Group A primitives swept** — `reducer-postconditions-framework-primitives.test.mjs` (7 tests):
   BalanceSnapshot (I1/I8), Scripted (I1/I2/I8 + throwing-script no-op), Repeating (threading +
   `next` merge + count≤0 no-op). **Surfaced AND FIXED the `RepeatingReducer` count>0 bug (§7.4).**
   **The INDIRECT bucket is now empty: every concrete reducer has a dedicated isolated postcondition
   test.**
5. ✅ **CI gate** — `tests/unit/reducer-coverage-gate.test.mjs` walks `src/` for every
   `class *Reducer extends …` and asserts 1:1 correspondence with the coverage manifest
   (`tests/helpers/reducer-coverage-manifest.js`, the machine-checkable mirror of §6 — buckets
   `ABSTRACT` / `COVERED` / `INDIRECT`). Adding, renaming, or deleting a reducer fails the gate until
   the manifest is updated, so coverage can't silently regress. Runs in `npm run test:unit`.

## 9. Definition of done

- ✅ **DONE** — every concrete reducer in §6 has a dedicated isolated postcondition test for its
  tagged invariants (+ I7). Groups A–J all ✅; the manifest's `INDIRECT` bucket is **empty**.
  One latent production bug was surfaced **and fixed** along the way (`RepeatingReducer`, §7.4) — its
  count>0 path now threads combined child state over N iterations and merges child-emitted actions.
- ✅ The §8.5 gate is green and wired into `npm run test:unit`. The manifest's `INDIRECT` bucket is the
  authoritative remaining-work list; it is now empty, so "done" is reached. A newly added reducer must
  land in `COVERED` with a test (or re-open `INDIRECT`) or the gate fails.
- ✅ Design 25 §4.4's "the pattern generalizes to every reducer" TODO is struck and points here.
