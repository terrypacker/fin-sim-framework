/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Reducer coverage manifest — the machine-checkable mirror of the §6 checklist
 * in design/37-reducer-test-framework.md. `reducer-coverage-gate.test.mjs`
 * asserts this manifest is in exact 1:1 correspondence with the reducer classes
 * declared under `src/` (every `class *Reducer extends …`). If you add, rename,
 * or remove a reducer, that test fails until you update this file — so reducer
 * coverage can never silently regress (design 37 §8.5).
 *
 * Buckets:
 *  - ABSTRACT — base classes that are never instantiated as a reducer on their
 *               own; no behavioral postcondition test is required.
 *  - COVERED  — has a dedicated, isolated postcondition / unit test.
 *  - INDIRECT — exercised only through scenario (`evt-*`) suites; still needs an
 *               isolated postcondition test (the remaining §6 burn-down).
 *
 * When you add a reducer: put it in COVERED with a new test, or (only if you
 * must defer) in INDIRECT, and add the matching row to the §6 table.
 */

/** Base/abstract reducers — no behavioral test required. */
export const ABSTRACT = [
  'Reducer',
  'AccountServiceReducer',
];

/** Reducers with a dedicated isolated postcondition / unit test. */
export const COVERED = [
  // A — framework primitives (reducers.test.mjs, reducer-postconditions.test.mjs)
  'AccountTransactionReducer', 'FieldReducer', 'FieldValueReducer', 'ArrayReducer',
  'NumericSumReducer', 'MultiplicativeReducer', 'MetricReducer', 'NoOpReducer',

  // B — holdings (holdings-actions.test.mjs)
  'HoldingTransactReducer', 'HoldingRevalueReducer', 'HoldingSetBasisReducer',
  'HoldingSplitReducer', 'HoldingRetitleReducer',

  // C — US retirement (reducer-postconditions-us-retirement.test.mjs)
  'IraContributionApplyReducer', 'IraEarningsApplyReducer', 'IraWithdrawalContribApplyReducer',
  'IraWithdrawalEarningsApplyReducer', 'IraRmdApplyReducer', 'IraRolloverWithdrawalApplyReducer',
  'K401ContributionApplyReducer', 'K401EarningsApplyReducer', 'K401RmdApplyReducer',
  'K401WithdrawalApplyReducer', 'K401ToIraConversionApplyReducer',
  'RothContributionApplyReducer', 'RothEarningsApplyReducer', 'RothWithdrawalContribApplyReducer',
  'RothWithdrawalEarningsApplyReducer', 'RothConversionApplyReducer',
  'ScheduledEarlyWithdrawalApplyReducer',   // tests/unit/early-withdrawal-decant.test.mjs (design 45)
  'RothRolloverContributionApplyReducer', 'RothRolloverEarningsApplyReducer',
  'RothRolloverWithdrawalContribApplyReducer', 'RothRolloverWithdrawalEarningsApplyReducer',

  // C — US brokerage + collectible (reducer-postconditions-us-brokerage.test.mjs)
  'StockContributionApplyReducer', 'StockEarningsApplyReducer', 'StockDividendApplyReducer',
  'StockWithdrawalApplyReducer', 'FixedIncomeContributionApplyReducer',
  'FixedIncomeEarningsApplyReducer', 'FixedIncomeWithdrawalApplyReducer',
  'CollectibleSaleApplyReducer', 'CollectibleValueChangeApplyReducer',

  // C — US income + real property (reducer-postconditions-us-income.test.mjs)
  'WagesIncomeApplyReducer', 'WagesWithheldApplyReducer', 'SsIncomeApplyReducer',
  'SeIncomeUsApplyReducer', 'BonusApplyReducer', 'CompanySaleApplyReducer',
  'UsHouseSaleApplyReducer',

  // C — AU (reducer-postconditions-au.test.mjs)
  'AuSavingsContributionApplyReducer', 'AuSavingsEarningsApplyReducer', 'AuSavingsWithdrawalApplyReducer',
  'SuperContributionApplyReducer', 'SuperEarningsApplyReducer', 'SuperWithdrawalContribApplyReducer',
  'SuperWithdrawalEarningsApplyReducer',
  'AuDividendFrankedResidentApplyReducer', 'AuDividendFrankedNonResidentApplyReducer',
  'AuDividendUnfrankedResidentApplyReducer', 'AuDividendUnfrankedNonResidentApplyReducer',
  'AuStockEarningsApplyReducer', 'AuStockWithdrawalApplyReducer',
  'AuFixedIncomeEarningsApplyReducer', 'AuSeIncomeApplyReducer', 'AuWagesIncomeApplyReducer', 'AuHouseSaleApplyReducer',

  // D — top-level finance (dedicated tests)
  'AccumulateDeficitReducer', 'OutOfFundsReducer', 'SetOutOfFundsDateReducer',
  // Lifetime running accumulators (design 38 §5) — accumulate-reducers.test.mjs
  'AccumulateTaxesPaidReducer', 'AccumulateConsumptionReducer',
  // CRRA consumption utility (design 39 §4) — crra-objective.test.mjs
  'AccumulateConsumptionUtilityReducer',

  // D — top-level finance (reducer-postconditions-finance.test.mjs)
  'ExpenseDebitReducer', 'ReplenishSavingsReducer', 'InflationAdjustReducer',
  'ChangeResidencyApplyReducer', 'ChangeStateResidencyApplyReducer', 'IntlTransferApplyReducer',
  'IntlTransferRecordReducer',
  'AccountRetitleApplyReducer', 'PersonDiedApplyReducer', 'SocialSecuritySurvivorApplyReducer',
  'StockDividendCashApplyReducer', 'UsSavingsInterestCreditReducer', 'ScenarioCompleteReducer',

  // E — behavioral (reducer-postconditions-behavioral.test.mjs)
  'PanicSellReducer', 'BehavioralPanicSellApplyReducer', 'OpportunisticRebalanceReducer',
  'OpportunisticRebalanceApplyReducer', 'StrategicAssetLocationReducer', 'AssetLocationRebalanceApplyReducer',
  'DownturnRothConversionReducer', 'CashBucketDrawdownReducer', 'ContributionSuspensionToggleReducer',
  'StockHarvestApplyReducer',

  // F/G — economic regimes + FX (reducer-postconditions-regimes-fx.test.mjs)
  'RemoveRegimeReducer', 'RegimeApplyReducer', 'BondPriceAdjustReducer', 'FxRefreshReducer',
  // Time-varying Prime → linked cash (design 56 §5 Phase 2b) — evt-prime-timevarying.test.mjs
  'PrimeRelinkReducer',
  // Time-varying FX (design 47) — evt-fx-process.test.mjs
  'FxProcessReducer', 'FxStepApplyReducer',

  // H — spending (reducer-postconditions-spending.test.mjs)
  'SpendingStrategyApplyReducer', 'AgeBandedSpendingReducer', 'GuardrailBaselineApplyReducer',
  'GuardrailAnnualCheckReducer', 'GuardrailAdjustApplyReducer', 'HealthcareExpenseApplyReducer',
  'LateLifeCareApplyReducer', 'RegimeAwareSpendingReducer',
  // EXPLICIT_BANDS strategy (design 38 §6.1) — spending-explicit-bands.test.mjs
  'ExplicitBandsSpendingReducer',

  // I — tax / period (reducer-postconditions-tax.test.mjs)
  'DynamicTaxReducer', 'UsPeriodAdvanceReducer', 'AuPeriodAdvanceReducer',
  'UsTaxSettleApplyReducer', 'AuTaxSettleApplyReducer', 'UsTaxPaymentDebitReducer',
  'AuTaxPaymentDebitReducer',
  // AU CGT reform 1 Jul 2027 deemed cost base reset (design 57 §6.4) — evt-au-cgt-reform.test.mjs
  'AuCgtBasisResetReducer',

  // A — framework primitives (reducer-postconditions-framework-primitives.test.mjs)
  'BalanceSnapshotReducer', 'ScriptedReducer', 'RepeatingReducer',

  // F/G/I/J — backfill (reducer-postconditions-backfill.test.mjs)
  'AddRegimeReducer', 'RevalueAssetReducer', 'AssetAppreciateReducer', 'FxTransferApplyReducer',
  'StateIncomeClassificationReducer', 'StateTaxSettleApplyReducer', 'StateTaxPaymentDebitReducer',
  'UsMortgagePaymentApplyReducer', 'AuMortgagePaymentApplyReducer',
  'LoanPaymentApplyReducer', // evt-loan.test.mjs — amortization split + negative-amort + cash debit

  // K — rental income (design 48; reducer-postconditions-backfill.test.mjs)
  'UsRentalIncomeApplyReducer', 'AuRentalIncomeApplyReducer',
];

/**
 * Reducers covered only indirectly (scenario suites) — pending isolated tests.
 * EMPTY: the §6 burn-down is complete (design 37 §9). Every concrete reducer now
 * has a dedicated isolated postcondition test. Add a new reducer to COVERED with
 * its test (or, only if you must defer, re-open this bucket and add the §6 row).
 */
export const INDIRECT = [];

/** Every reducer class name the manifest accounts for. */
export const ALL_MANIFEST_REDUCERS = [...ABSTRACT, ...COVERED, ...INDIRECT];
