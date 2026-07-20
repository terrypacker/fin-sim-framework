/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */



import {
  ActionDefinition,
  Action, FieldAction, FieldValueAction, AmountAction, ScriptedAction,
} from '../simulation-framework/actions.js';
import { ACCOUNT_ROLES }  from '../finance/state/account-roles.js';
import { Person }         from '../finance/person.js';
import { Account, CheckingAccount, SavingsAccount, LoanAccount, OffsetAccount } from '../finance/assets/account.js';
import {
  InvestmentAccount, BrokerageAccount, FourOhOneKAccount,
  RothAccount, TraditionalIRAAccount, SuperannuationAccount,
  reconcileLedgerToBalance,
} from '../finance/assets/investment-account.js';
import { Holding } from '../finance/holdings/holding.js';
import { rescaleHoldingsToBalance, holdingsOutOfSync } from '../finance/holdings/holding-utils.js';
import { RealProperty }  from '../finance/assets/real-property.js';
import { Collectible }   from '../finance/assets/collectible.js';
import { CompanyEquity } from '../finance/assets/company-equity.js';
import { Bequest }       from '../finance/assets/bequest.js';
import { serializeInheritanceMeta, applyInheritanceMeta } from '../finance/assets/inheritance-meta.js';

// ─── Framework classes ──────────────────────────────────────────────────────
import { HandlerEntry }   from '../simulation-framework/handlers.js';
import { OneOffEvent }    from '../simulation-framework/events/one-off-event.js';
import { EventSeries }    from '../simulation-framework/events/event-series.js';
import {
  NoOpReducer, FieldReducer, MetricReducer, BalanceSnapshotReducer,
  FieldValueReducer, ArrayReducer, NumericSumReducer, MultiplicativeReducer,
  ScriptedReducer, AccountTransactionReducer, AccountServiceReducer,
} from '../simulation-framework/reducers.js';

// ─── Finance handler classes ────────────────────────────────────────────────
import { UsSavingsInterestMonthlyHandler }              from '../finance/handlers/us-savings-interest-handler.js';
import { MonthlyExpensesHandler }                       from '../finance/handlers/monthly-expenses-handler.js';
import { MonthlyWagesHandler }                          from '../finance/handlers/monthly-wages-handler.js';
// IntlTransferToUsHandler / IntlTransferToAuHandler kept for deserializing saved scenarios.
import { IntlTransferToUsHandler, IntlTransferToAuHandler } from '../finance/handlers/intl-transfer-handlers.js';
import { FxTransferToHandler }       from '../finance/fx/fx-transfer-handler.js';
import { FxTickHandler }             from '../finance/fx/fx-tick-handler.js';
import {
  AuSavingsInterestHandler, AuFixedIncomeInterestMonthlyHandler,
  FixedIncomeInterestHandler, SuperEarningsHandler,
  IntlRothEarningsHandler, IntlIraEarningsHandler, IntlK401EarningsHandler,
  IntlUsStockEarningsHandler, IntlAuStockEarningsHandler, IntlAuStockDividendHandler,
} from '../finance/handlers/earnings-handlers.js';
import { DividendScheduledHandler }       from '../finance/handlers/dividend-scheduled-handler.js';
import { BondCouponScheduledHandler }     from '../finance/handlers/bond-coupon-handler.js';
import { CashSleeveInterestHandler }       from '../finance/handlers/cash-sleeve-interest-handler.js';
import { BondSleeveCouponHandler }         from '../finance/handlers/bond-sleeve-coupon-handler.js';
import { BondAccretionHandler }            from '../finance/handlers/bond-accretion-handler.js';
import { ChangeResidencyHandler }         from '../finance/handlers/change-residency-handler.js';
import { ChangeStateResidencyHandler }    from '../finance/handlers/change-state-residency-handler.js';
import { OutOfFundsHandler }              from '../finance/handlers/out-of-funds-handler.js';
import { MonthlySocialSecurityHandler }   from '../finance/handlers/monthly-social-security-handler.js';
import { MortalityHandler }              from '../finance/handlers/mortality-handler.js';
import { LateLifeCareHandler }          from '../finance/spending/strategies/late-life-care-handler.js';
import { LateLifeCareApplyReducer }     from '../finance/spending/strategies/late-life-care-apply-reducer.js';

// ─── Finance reducer classes ────────────────────────────────────────────────
import { UsSavingsInterestCreditReducer } from '../finance/reducers/us-savings-interest-credit-reducer.js';
import { ExpenseDebitReducer }            from '../finance/reducers/expense-debit-reducer.js';
import { ReplenishSavingsReducer }        from '../finance/reducers/replenish-savings-reducer.js';
import { IntlTransferApplyReducer, IntlTransferRecordReducer }       from '../finance/reducers/intl-transfer-apply-reducer.js';
import { FxTransferApplyReducer }        from '../finance/fx/fx-transfer-apply-reducer.js';
import { FxRefreshReducer }              from '../finance/fx/fx-refresh-reducer.js';
import { FxProcessReducer }              from '../finance/fx/fx-process-reducer.js';
import { FxStepApplyReducer }            from '../finance/fx/fx-step-apply-reducer.js';
import { StockDividendCashApplyReducer }  from '../finance/reducers/stock-dividend-cash-apply-reducer.js';
import { BondCouponCashApplyReducer }     from '../finance/reducers/bond-coupon-cash-apply-reducer.js';
import { CashSleeveInterestApplyReducer } from '../finance/reducers/cash-sleeve-interest-apply-reducer.js';
import { BondSleeveCouponApplyReducer } from '../finance/reducers/bond-sleeve-coupon-apply-reducer.js';
import { BondAccretionApplyReducer }    from '../finance/reducers/bond-accretion-apply-reducer.js';
import { ChangeResidencyApplyReducer }    from '../finance/reducers/change-residency-apply-reducer.js';
import { ChangeStateResidencyApplyReducer } from '../finance/reducers/change-state-residency-apply-reducer.js';
import { PersonDiedApplyReducer }        from '../finance/reducers/person-died-apply-reducer.js';
import { SocialSecuritySurvivorApplyReducer } from '../finance/reducers/social-security-survivor-apply-reducer.js';
import { AccountRetitleApplyReducer }    from '../finance/reducers/account-retitle-apply-reducer.js';
import { SuperDeathBenefitApplyReducer } from '../finance/reducers/super-death-benefit-apply-reducer.js';
import { ScenarioCompleteReducer }       from '../finance/reducers/scenario-complete-reducer.js';
import { SetOutOfFundsDateReducer }       from '../finance/reducers/set-out-of-funds-date-reducer.js';
import { AccumulateDeficitReducer }       from '../finance/reducers/accumulate-deficit-reducer.js';
import { AccumulateTaxesPaidReducer }     from '../finance/reducers/accumulate-taxes-paid-reducer.js';
import { AccumulateConsumptionReducer }   from '../finance/reducers/accumulate-consumption-reducer.js';
import { AccumulateConsumptionUtilityReducer } from '../finance/reducers/accumulate-consumption-utility-reducer.js';
import { OutOfFundsReducer }             from '../finance/reducers/out-of-funds-reducer.js';
import { InflationAdjustReducer }        from '../finance/reducers/inflation-adjust-reducer.js';
import { SpendingStrategyApplyReducer }  from '../finance/spending/spending-strategy-apply-reducer.js';
import { RegimeAwareSpendingReducer }    from '../finance/spending/strategies/regime-aware-spending-reducer.js';
import { EconomicShockHandler }          from '../finance/economic-regimes/economic-shock-handler.js';
import { EconomicRecoveryTickHandler }   from '../finance/economic-regimes/economic-recovery-tick-handler.js';
import { RegimeApplyReducer }            from '../finance/economic-regimes/regime-apply-reducer.js';
import { PrimeRelinkReducer }            from '../finance/economic-regimes/prime-relink-reducer.js';
import { AddRegimeReducer }              from '../finance/economic-regimes/add-regime-reducer.js';
import { RemoveRegimeReducer }           from '../finance/economic-regimes/remove-regime-reducer.js';
import { RevalueAssetReducer }           from '../finance/economic-regimes/revalue-asset-reducer.js';
import { BondPriceAdjustReducer }        from '../finance/economic-regimes/bond-price-adjust-reducer.js';
import { BondMaturityReducer }           from '../finance/economic-regimes/bond-maturity-reducer.js';
import { YieldCurveReducer }             from '../finance/economic-regimes/yield-curve-reducer.js';
import { YieldCurveStepReducer }         from '../finance/economic-regimes/yield-curve-step-reducer.js';
import { YieldCurveTickHandler }         from '../finance/economic-regimes/yield-curve-tick-handler.js';
import { AssetAppreciationHandler, AssetAppreciateReducer } from '../finance/handlers/asset-appreciation-handler.js';

// ─── Tax infrastructure ─────────────────────────────────────────────────────
import { UsPeriodAdvanceHandler, AuPeriodAdvanceHandler, UsPeriodAdvanceReducer, AuPeriodAdvanceReducer } from '../finance/tax/period-advance-classes.js';
import { UsTaxSettleHandler, AuTaxSettleHandler, UsTaxSettleApplyReducer, AuTaxSettleApplyReducer, UsTaxPaymentDebitReducer, AuTaxPaymentDebitReducer } from '../finance/tax/tax-settle-classes.js';
import { DynamicTaxReducer }  from '../finance/tax/dynamic-tax-reducer.js';
import { StateTaxSettleHandler, StateTaxSettleApplyReducer, StateTaxPaymentDebitReducer } from '../finance/tax/state/state-tax-settle-classes.js';
import { StateIncomeClassificationReducer } from '../finance/tax/state/state-income-classification.js';

// ─── US account-module handlers and reducers ────────────────────────────────
import {
  RothContributionHandler, RothWithdrawalContributionsHandler,
  RothWithdrawalEarningsHandler, RothEarningsHandler,
  RothContributionApplyReducer, RothWithdrawalContribApplyReducer,
  RothWithdrawalEarningsApplyReducer, RothEarningsApplyReducer,
} from '../finance/account-rules/us/roth-classes.js';
import {
  IraContributionHandler, IraWithdrawalContributionsHandler,
  IraWithdrawalEarningsHandler, IraEarningsHandler,
  IraContributionApplyReducer, IraWithdrawalContribApplyReducer,
  IraWithdrawalEarningsApplyReducer, IraEarningsApplyReducer,
} from '../finance/account-rules/us/ira-classes.js';
import {
  K401ContributionHandler, K401EarningsHandler, K401WithdrawalHandler, K401AnnualRmdHandler,
  K401ContributionApplyReducer, K401EarningsApplyReducer, K401WithdrawalApplyReducer,
  K401RmdApplyReducer,
  K401ToIraConversionHandler, K401ToIraConversionApplyReducer,
} from '../finance/account-rules/us/k401-classes.js';
import {
  FixedIncomeContributionHandler, FixedIncomeWithdrawalHandler, FixedIncomeEarningsHandler,
  StockContributionHandler, StockDividendHandler, StockEarningsHandler, StockWithdrawalHandler,
  FixedIncomeContributionApplyReducer, FixedIncomeWithdrawalApplyReducer, FixedIncomeEarningsApplyReducer,
  StockContributionApplyReducer, StockDividendApplyReducer, BondCouponApplyReducer, StockEarningsApplyReducer, StockWithdrawalApplyReducer,
} from '../finance/account-rules/us/us-brokerage-classes.js';
import { UsHouseSaleHandler, UsHouseSaleApplyReducer }     from '../finance/account-rules/us/us-real-property-classes.js';
import {
  SsIncomeHandler, WagesIncomeHandler, WagesWithheldHandler,
  SeIncomeUsHandler, BonusHandler, CompanySaleHandler,
  SsIncomeApplyReducer, WagesIncomeApplyReducer, WagesWithheldApplyReducer,
  SeIncomeUsApplyReducer, BonusApplyReducer, CompanySaleApplyReducer,
} from '../finance/account-rules/us/us-income-classes.js';
import {
  CollectibleSaleHandler, CollectibleValueChangeHandler,
  CollectibleSaleApplyReducer, CollectibleValueChangeApplyReducer,
} from '../finance/account-rules/us/us-collectible-classes.js';
import {
  IraRolloverWithdrawalHandler, IraRmdHandler, IraAnnualRmdHandler,
  IraRolloverWithdrawalApplyReducer, IraRmdApplyReducer,
} from '../finance/account-rules/us/ira-rollover-classes.js';
import {
  RothRolloverContributionHandler, RothRolloverEarningsHandler,
  RothRolloverWithdrawalContributionsHandler, RothRolloverWithdrawalEarningsHandler,
  RothRolloverContributionApplyReducer, RothRolloverEarningsApplyReducer,
  RothRolloverWithdrawalContribApplyReducer, RothRolloverWithdrawalEarningsApplyReducer,
} from '../finance/account-rules/us/roth-rollover-classes.js';
import {
  RothConversionHandler, RothConversionPolicyHandler,
  RothConversionApplyReducer,
} from '../finance/account-rules/us/roth-conversion-classes.js';
import {
  EarlyWithdrawalPolicyHandler, ScheduledEarlyWithdrawalApplyReducer,
} from '../finance/account-rules/us/early-withdrawal-classes.js';

// ─── AU account-module handlers and reducers ────────────────────────────────
import {
  AuSavingsContributionHandler, AuSavingsWithdrawalHandler, AuSavingsEarningsHandler,
  AuSavingsContributionApplyReducer, AuSavingsWithdrawalApplyReducer, AuSavingsEarningsApplyReducer,
} from '../finance/account-rules/au/au-savings-classes.js';
import {
  SuperContributionHandler, SuperWithdrawalContributionsHandler,
  SuperWithdrawalEarningsHandler, SuperEarningsDirectHandler,
  SuperContributionApplyReducer, SuperWithdrawalContribApplyReducer,
  SuperWithdrawalEarningsApplyReducer, SuperEarningsApplyReducer,
} from '../finance/account-rules/au/au-super-classes.js';
import {
  AuDividendFrankedResidentHandler, AuDividendFrankedNonResidentHandler,
  AuDividendUnfrankedResidentHandler, AuDividendUnfrankedNonResidentHandler,
  AuStockEarningsHandler, AuStockWithdrawalHandler,
  AuDividendFrankedResidentApplyReducer, AuDividendFrankedNonResidentApplyReducer,
  AuDividendUnfrankedResidentApplyReducer, AuDividendUnfrankedNonResidentApplyReducer,
  AuStockEarningsApplyReducer, AuStockWithdrawalApplyReducer,
} from '../finance/account-rules/au/au-brokerage-classes.js';
import { AuHouseSaleHandler, AuHouseSaleApplyReducer } from '../finance/account-rules/au/au-real-property-classes.js';
import { AuSeIncomeHandler, AuSeIncomeApplyReducer, AuWagesIncomeApplyReducer }   from '../finance/account-rules/au/au-income-classes.js';
import { AuFixedIncomeEarningsApplyReducer }            from '../finance/account-rules/au/au-fixed-income-classes.js';
import {
  UsMortgagePaymentHandler, UsMortgagePaymentApplyReducer,
  AuMortgagePaymentHandler, AuMortgagePaymentApplyReducer,
} from '../finance/account-rules/mortgage-payment-classes.js';
import { LoanPaymentHandler, UsLoanPaymentHandler, AuLoanPaymentHandler, LoanPaymentApplyReducer } from '../finance/account-rules/loan-classes.js';

// ─── Holdings substrate (design 25) ─────────────────────────────────────────
import {
  HoldingTransactAction, HoldingRevalueAction, HoldingSetBasisAction,
  HoldingSplitAction, HoldingRetitleAction, HOLDING_ACTION_ENTRIES,
} from '../finance/holdings/holding-actions.js';
import {
  HoldingTransactReducer, HoldingRevalueReducer, HoldingSetBasisReducer,
  HoldingSplitReducer, HoldingRetitleReducer,
} from '../finance/holdings/holding-reducers.js';

/**
 * All known handler / reducer / action classes.
 * Registered into the TypeRegistry before deserialization when the registry
 * has not already been populated by ScenarioCompiler (e.g. in legacy roundtrip
 * scenarios and unit tests that call deserializeGraph directly).
 */
const _ALL_CLASSES = [
  // Framework actions
  Action, FieldAction, FieldValueAction, AmountAction, ScriptedAction,
  // Holdings actions + reducers (design 25)
  HoldingTransactAction, HoldingRevalueAction, HoldingSetBasisAction,
  HoldingSplitAction, HoldingRetitleAction,
  HoldingTransactReducer, HoldingRevalueReducer, HoldingSetBasisReducer,
  HoldingSplitReducer, HoldingRetitleReducer,
  // Framework handlers
  HandlerEntry,
  // Framework reducers
  NoOpReducer, FieldReducer, MetricReducer, BalanceSnapshotReducer,
  FieldValueReducer, ArrayReducer, NumericSumReducer, MultiplicativeReducer,
  ScriptedReducer, AccountTransactionReducer, AccountServiceReducer,
  // Finance handlers
  UsSavingsInterestMonthlyHandler, MonthlyExpensesHandler, MonthlyWagesHandler,
  IntlTransferToUsHandler, IntlTransferToAuHandler, FxTransferToHandler, FxTickHandler,
  AuSavingsInterestHandler, AuFixedIncomeInterestMonthlyHandler,
  FixedIncomeInterestHandler, SuperEarningsHandler,
  IntlRothEarningsHandler, IntlIraEarningsHandler, IntlK401EarningsHandler,
  IntlUsStockEarningsHandler, IntlAuStockEarningsHandler, IntlAuStockDividendHandler,
  DividendScheduledHandler, BondCouponScheduledHandler, CashSleeveInterestHandler, BondSleeveCouponHandler, BondAccretionHandler, ChangeResidencyHandler, ChangeStateResidencyHandler, OutOfFundsHandler, MonthlySocialSecurityHandler,
  MortalityHandler, LateLifeCareHandler,
  UsMortgagePaymentHandler, AuMortgagePaymentHandler,
  UsPeriodAdvanceHandler, AuPeriodAdvanceHandler,
  UsTaxSettleHandler, AuTaxSettleHandler, StateTaxSettleHandler,
  RothContributionHandler, RothWithdrawalContributionsHandler,
  RothWithdrawalEarningsHandler, RothEarningsHandler,
  IraContributionHandler, IraWithdrawalContributionsHandler,
  IraWithdrawalEarningsHandler, IraEarningsHandler,
  K401ContributionHandler, K401EarningsHandler, K401WithdrawalHandler, K401AnnualRmdHandler,
  K401ToIraConversionHandler,
  FixedIncomeContributionHandler, FixedIncomeWithdrawalHandler, FixedIncomeEarningsHandler,
  StockContributionHandler, StockDividendHandler, StockEarningsHandler, StockWithdrawalHandler,
  UsHouseSaleHandler,
  SsIncomeHandler, WagesIncomeHandler, WagesWithheldHandler,
  SeIncomeUsHandler, BonusHandler, CompanySaleHandler,
  CollectibleSaleHandler, CollectibleValueChangeHandler,
  IraRolloverWithdrawalHandler, IraRmdHandler, IraAnnualRmdHandler,
  RothRolloverContributionHandler, RothRolloverEarningsHandler,
  RothRolloverWithdrawalContributionsHandler, RothRolloverWithdrawalEarningsHandler,
  RothConversionHandler, RothConversionPolicyHandler,
  EarlyWithdrawalPolicyHandler,
  AuSavingsContributionHandler, AuSavingsWithdrawalHandler, AuSavingsEarningsHandler,
  SuperContributionHandler, SuperWithdrawalContributionsHandler,
  SuperWithdrawalEarningsHandler, SuperEarningsDirectHandler,
  AuDividendFrankedResidentHandler, AuDividendFrankedNonResidentHandler,
  AuDividendUnfrankedResidentHandler, AuDividendUnfrankedNonResidentHandler,
  AuStockEarningsHandler, AuStockWithdrawalHandler,
  AuHouseSaleHandler, AuSeIncomeHandler,
  // Finance reducers
  UsSavingsInterestCreditReducer, ExpenseDebitReducer, ReplenishSavingsReducer,
  IntlTransferApplyReducer, IntlTransferRecordReducer, FxTransferApplyReducer, FxRefreshReducer,
  FxProcessReducer, FxStepApplyReducer,
  StockDividendCashApplyReducer, BondCouponCashApplyReducer, CashSleeveInterestApplyReducer, BondSleeveCouponApplyReducer, BondAccretionApplyReducer, ChangeResidencyApplyReducer, ChangeStateResidencyApplyReducer,
  PersonDiedApplyReducer, SocialSecuritySurvivorApplyReducer, AccountRetitleApplyReducer, SuperDeathBenefitApplyReducer, ScenarioCompleteReducer,
  LateLifeCareApplyReducer,
  SetOutOfFundsDateReducer, AccumulateDeficitReducer, AccumulateTaxesPaidReducer, AccumulateConsumptionReducer,
  AccumulateConsumptionUtilityReducer,
  OutOfFundsReducer, InflationAdjustReducer,
  SpendingStrategyApplyReducer, RegimeAwareSpendingReducer,
  UsPeriodAdvanceReducer, AuPeriodAdvanceReducer,
  UsTaxSettleApplyReducer, AuTaxSettleApplyReducer,
  UsTaxPaymentDebitReducer, AuTaxPaymentDebitReducer,
  DynamicTaxReducer,
  StateTaxSettleApplyReducer, StateTaxPaymentDebitReducer, StateIncomeClassificationReducer,
  RothContributionApplyReducer, RothWithdrawalContribApplyReducer,
  RothWithdrawalEarningsApplyReducer, RothEarningsApplyReducer,
  IraContributionApplyReducer, IraWithdrawalContribApplyReducer,
  IraWithdrawalEarningsApplyReducer, IraEarningsApplyReducer,
  K401ContributionApplyReducer, K401EarningsApplyReducer, K401WithdrawalApplyReducer,
  K401RmdApplyReducer, K401ToIraConversionApplyReducer,
  FixedIncomeContributionApplyReducer, FixedIncomeWithdrawalApplyReducer, FixedIncomeEarningsApplyReducer,
  StockContributionApplyReducer, StockDividendApplyReducer, BondCouponApplyReducer, StockEarningsApplyReducer, StockWithdrawalApplyReducer,
  UsHouseSaleApplyReducer,
  SsIncomeApplyReducer, WagesIncomeApplyReducer, WagesWithheldApplyReducer,
  SeIncomeUsApplyReducer, BonusApplyReducer, CompanySaleApplyReducer,
  CollectibleSaleApplyReducer, CollectibleValueChangeApplyReducer,
  IraRolloverWithdrawalApplyReducer, IraRmdApplyReducer,
  RothRolloverContributionApplyReducer, RothRolloverEarningsApplyReducer,
  RothRolloverWithdrawalContribApplyReducer, RothRolloverWithdrawalEarningsApplyReducer,
  RothConversionApplyReducer,
  ScheduledEarlyWithdrawalApplyReducer,
  AuSavingsContributionApplyReducer, AuSavingsWithdrawalApplyReducer, AuSavingsEarningsApplyReducer,
  AuFixedIncomeEarningsApplyReducer,
  SuperContributionApplyReducer, SuperWithdrawalContribApplyReducer,
  SuperWithdrawalEarningsApplyReducer, SuperEarningsApplyReducer,
  AuDividendFrankedResidentApplyReducer, AuDividendFrankedNonResidentApplyReducer,
  AuDividendUnfrankedResidentApplyReducer, AuDividendUnfrankedNonResidentApplyReducer,
  AuStockEarningsApplyReducer, AuStockWithdrawalApplyReducer,
  AuHouseSaleApplyReducer, AuSeIncomeApplyReducer, AuWagesIncomeApplyReducer,
  UsMortgagePaymentApplyReducer, AuMortgagePaymentApplyReducer,
  // Loan (liability) accounts (design 54)
  LoanPaymentHandler, UsLoanPaymentHandler, AuLoanPaymentHandler, LoanPaymentApplyReducer,
  // Economic regime handlers and reducers
  EconomicShockHandler, EconomicRecoveryTickHandler, YieldCurveTickHandler,
  RegimeApplyReducer, PrimeRelinkReducer, AddRegimeReducer, RemoveRegimeReducer, RevalueAssetReducer,
  BondPriceAdjustReducer, BondMaturityReducer, YieldCurveReducer, YieldCurveStepReducer,
  // Asset appreciation (design 28)
  AssetAppreciationHandler, AssetAppreciateReducer,
];

/**
 * Module-level fallback map: populated once on first use, covering all classes
 * known to this serializer. Used when no TypeRegistry is available (e.g. direct
 * unit-test calls to _makeHandler / _makeReducer / _makeAction).
 */
let _fallbackMap = null;
function _getFallbackMap() {
  if (!_fallbackMap) {
    _fallbackMap = new Map();
    for (const ctor of _ALL_CLASSES) {
      if (ctor.type) _fallbackMap.set(ctor.type, ctor);
    }
  }
  return _fallbackMap;
}

/**
 * Ensure every known handler / reducer / action class is registered in the
 * TypeRegistry. Idempotent — safe to call even when toolsets already
 * populated it via ScenarioCompiler.
 */
function _populateRegistry(typeRegistry) {
  if (!typeRegistry) return;
  for (const ctor of _ALL_CLASSES) {
    typeRegistry.registerClass(ctor);
  }
  // Framework-owned action type entries (holdings substrate).
  // Toolset-owned entries are registered separately by ScenarioCompiler via
  // typeRegistry.registerToolset().
  for (const entry of HOLDING_ACTION_ENTRIES) {
    typeRegistry.registerActionType(entry);
  }
}

function _lookupCtor(typeName, services) {
  return services?.typeRegistry?.get(typeName) ?? _getFallbackMap().get(typeName) ?? null;
}

/**
 * True when `node` looks like a record previously emitted by one of the
 * _serialize* helpers: a plain object (own prototype is Object.prototype) that
 * already carries a `__type` discriminator. Used by the _serialize* helpers to
 * remain idempotent — `serializeScenario` is sometimes called on a scenario
 * whose graph arrays were pre-serialized by `onSave`, and the live-instance
 * fields those helpers read (handlerClass, reducerType, handledEvents, …) are
 * absent on plain records, which would silently clobber data otherwise.
 */
function _isAlreadySerialized(node) {
  return node && typeof node === 'object' && typeof node.__type === 'string'
      && Object.getPrototypeOf(node) === Object.prototype;
}

export class ScenarioSerializer {

  /**
   * Canonicalize a sim start/end date to a full ISO 8601 string
   * (`YYYY-MM-DDTHH:mm:ss.sssZ`). Used by the scenario registry + serializer to
   * guarantee a single representation across:
   *   - Prebuilt registry entries (originally `Date` objects)
   *   - User scenarios in localStorage (round-tripped via JSON)
   *   - Downloaded JSON exports
   *
   * Returns null for null/undefined inputs and for unparseable strings. UI
   * inputs (`<input type="date">`) slice the first 10 characters; scenario
   * construction calls `new Date(isoString)` to obtain a real `Date`.
   *
   * @param {Date|string|null|undefined} d
   * @returns {string|null}
   */
  static toDateStr(d) {
    if (d == null) return null;
    if (d instanceof Date) {
      if (Number.isNaN(d.getTime())) return null;
      return d.toISOString();
    }
    const parsed = new Date(d);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString();
  }

  static serializeScenario(scenario) {
    return {
      id: scenario.id,
      name: scenario.name,
      order: scenario.order,
      active: scenario.active,
      prebuilt: scenario.prebuilt,
      scenarioId:   scenario?.scenarioId ?? null,
      simStart: this.toDateStr(scenario.simStart),
      simEnd:   this.toDateStr(scenario.simEnd),
      persons:        (scenario.persons  ?? []).map(n => ScenarioSerializer._serializePerson(n)),
      accounts:       (scenario.accounts ?? []).map(n => ScenarioSerializer._serializeAccount(n)),
      realProperties: (scenario.realProperties ?? []).map(n => ScenarioSerializer._serializeRealProperty(n)),
      collectibles:   (scenario.collectibles ?? []).map(n => ScenarioSerializer._serializeCollectible(n)),
      companyEquities: (scenario.companyEquities ?? []).map(n => ScenarioSerializer._serializeCompanyEquity(n)),
      bequests:       (scenario.bequests ?? []).map(n => ScenarioSerializer._serializeBequest(n)),
      events:   (scenario.events ?? []).map(n => ScenarioSerializer._serializeEvent(n)),
      handlers: (scenario.handlers ?? []).map(n => ScenarioSerializer._serializeHandler(n)),
      actions:  (scenario.actions ?? []).map(n => ScenarioSerializer._serializeAction(n)),
      reducers: (scenario.reducers ?? []).map(n => ScenarioSerializer._serializeReducer(n)),
      initialState: scenario.initialState ? structuredClone(scenario.initialState) : {},
      params:     scenario.params ?? [],
      toolsets:   scenario?.toolsets ?? [],
      watchlists: scenario.watchlists ?? [],
      // Tombstones of deleted default records (design 55 follow-up) — carried so a
      // downloaded/re-imported JSON keeps deletions sticky across Rebuild.
      ...(scenario.deletedDefaults ? { deletedDefaults: scenario.deletedDefaults } : {}),
    };
  }

  /**
   * Capture the current state of the live service maps as a partial cfg slice
   * — persons, accounts, realProperties, collectibles plus the full
   * events/handlers/actions/reducers graph.
   *
   * Compose with `serializeScenario` when you need a complete cfg:
   *
   * ```js
   * const cfg = ScenarioSerializer.serializeScenario({
   *   ...ScenarioSerializer.snapshotServices(services),
   *   id, name, order, simStart, simEnd, initialState, params,
   * });
   * ```
   *
   * Design 15: the active scenario record is the source of truth, not the
   * services. This helper is the bridge for callers (the Save handler, tests)
   * that need to harvest in-flight service-map state into that record.
   *
   * @param {{ eventService, handlerService, actionService, reducerService,
   *           personService, accountService, realPropertyService, collectibleService }} services
   * @returns {{ persons, accounts, realProperties, collectibles,
   *             events, handlers, actions, reducers }}
   */
  static snapshotServices(services) {
    const {
      eventService, handlerService, actionService, reducerService,
      personService, accountService, realPropertyService, collectibleService, companyEquityService, bequestService,
    } = services;
    return {
      persons:        (personService?.getAll()         ?? []).map(n => ScenarioSerializer._serializePerson(n)),
      accounts:       (accountService?.getAll()        ?? []).map(n => ScenarioSerializer._serializeAccount(n)),
      realProperties: (realPropertyService?.getAll()   ?? []).map(n => ScenarioSerializer._serializeRealProperty(n)),
      collectibles:   (collectibleService?.getAll()    ?? []).map(n => ScenarioSerializer._serializeCollectible(n)),
      companyEquities: (companyEquityService?.getAll() ?? []).map(n => ScenarioSerializer._serializeCompanyEquity(n)),
      bequests:       (bequestService?.getAll()        ?? []).map(n => ScenarioSerializer._serializeBequest(n)),
      events:         (eventService?.getAll()          ?? []).map(n => ScenarioSerializer._serializeEvent(n)),
      handlers:       (handlerService?.getAll()        ?? []).map(n => ScenarioSerializer._serializeHandler(n)),
      actions:        (actionService?.getAll()         ?? []).map(n => ScenarioSerializer._serializeAction(n)),
      reducers:       (reducerService?.getAll()        ?? []).map(n => ScenarioSerializer._serializeReducer(n)),
    };
  }

  /**
   * Snapshot only the domain records (persons / accounts / real-properties /
   * collectibles) from the services — NOT the events/handlers/actions/reducers
   * graph. Used by the Rebuild path to harvest in-flight free-field edits (e.g.
   * currency, holdings, names) into the active cfg before ServiceRegistry.reset()
   * (design/32), without freezing the graph: omitting the graph keeps
   * ScenarioLoader on the toolset-recompile branch (a full snapshotServices()
   * would flip it to deserialize). Node-linked fields are still re-applied from
   * params by the compile-time node cascade, so each field comes from its single
   * owner.
   *
   * @param {{ personService, accountService, realPropertyService, collectibleService }} services
   * @returns {{ persons, accounts, realProperties, collectibles }}
   */
  static snapshotDomainRecords(services) {
    const { personService, accountService, realPropertyService, collectibleService, companyEquityService, bequestService } = services;
    return {
      persons:        (personService?.getAll()         ?? []).map(n => ScenarioSerializer._serializePerson(n)),
      accounts:       (accountService?.getAll()        ?? []).map(n => ScenarioSerializer._serializeAccount(n)),
      realProperties: (realPropertyService?.getAll()   ?? []).map(n => ScenarioSerializer._serializeRealProperty(n)),
      collectibles:   (collectibleService?.getAll()    ?? []).map(n => ScenarioSerializer._serializeCollectible(n)),
      companyEquities: (companyEquityService?.getAll() ?? []).map(n => ScenarioSerializer._serializeCompanyEquity(n)),
      bequests:       (bequestService?.getAll()        ?? []).map(n => ScenarioSerializer._serializeBequest(n)),
    };
  }

  /**
   * Load only the persons and accounts from a config into the services.
   * Used by the toolset path in WorkbenchApp when a custom JSON has persons/accounts
   * but no serialized events/handlers/actions/reducers.
   *
   * @param {object} config   - serialized scenario config (only persons/accounts are read)
   * @param {object} services - ServiceRegistry instance
   */
  static deserializePersonsAccounts(config, services) {
    const { personService, accountService, realPropertyService, collectibleService, companyEquityService, bequestService } = services;
    if (personService) {
      for (const d of (config.persons ?? [])) {
        const person = ScenarioSerializer._makePerson(d);
        personService.register(person);
      }
    }
    if (accountService) {
      for (const d of (config.accounts ?? [])) {
        const account = ScenarioSerializer._makeAccount(d);
        accountService.register(account);
      }
    }
    if (realPropertyService) {
      for (const d of (config.realProperties ?? [])) {
        const prop = ScenarioSerializer._makeRealProperty(d);
        realPropertyService.createProperty(prop);
      }
    }
    if (collectibleService) {
      for (const d of (config.collectibles ?? [])) {
        const col = ScenarioSerializer._makeCollectible(d);
        collectibleService.createCollectible(col);
      }
    }
    if (companyEquityService) {
      for (const d of (config.companyEquities ?? [])) {
        const eq = ScenarioSerializer._makeCompanyEquity(d);
        companyEquityService.createCompanyEquity(eq);
      }
    }
    if (bequestService) {
      for (const d of (config.bequests ?? [])) {
        const bq = ScenarioSerializer._makeBequest(d);
        bequestService.createBequest(bq);
      }
    }
  }

  /**
   * Returns true when `config` carries a serialized graph snapshot
   * (events/handlers/actions/reducers populated by a prior save).
   * Persons / accounts / real-properties / collectibles do not count — those
   * may be present without a snapshot when the scenario was built declaratively.
   */
  static hasSerializedGraph(config) {
    return (config?.events?.length   > 0)
        || (config?.handlers?.length > 0)
        || (config?.actions?.length  > 0)
        || (config?.reducers?.length > 0);
  }

  /**
   * Restore a previously serialized graph (events / handlers / actions /
   * reducers) into the services. Persons / accounts / real-properties /
   * collectibles are also restored as a convenience, so this is the single
   * call that fully rebuilds the services from a snapshot.
   */
  static deserializeGraph(config, services) {
    const { eventService, handlerService, actionService, reducerService } = services;

    // Ensure all known classes are in the registry before dispatch.
    // Idempotent — safe when ScenarioCompiler already populated it.
    _populateRegistry(services?.typeRegistry);

    // 0. Persons + accounts — delegate to the dedicated helper.
    ScenarioSerializer.deserializePersonsAccounts(config, services);

    // 1. Actions first — handlers and reducers hold references to them.
    const actionMap = new Map();
    for (const d of (config.actions ?? [])) {
      const action = ScenarioSerializer._makeAction(d, services);
      actionService.register(action);   // publishes CREATE → graph node added
      actionMap.set(d.id, action);
    }

    // 2. Events
    const eventMap = new Map();
    for (const d of (config.events ?? [])) {
      const event = ScenarioSerializer._makeEvent(d);
      eventService.register(event);     // publishes CREATE → sim schedules (if enabled) + graph node added
      eventMap.set(d.id, event);
    }

    // 3. Handlers — resolve references before registering so the CREATE
    //    subscriber sees the fully-wired handler.
    for (const d of (config.handlers ?? [])) {
      const handler = ScenarioSerializer._makeHandler(d, services);
      for (const eid of (d.handledEventIds ?? [])) {
        const ev = eventMap.get(eid);
        if (ev) handler.handledEvents.push(ev);
      }
      handler.generatedActionTypes = [...(d.generatedActionTypes ?? [])];
      for (const defData of (d.generatedActionDefinitions ?? [])) {
        handler.generatedActionDefinitions.push(new ActionDefinition(defData));
      }
      handlerService.register(handler); // publishes CREATE → sim registers handlers + graph node added
    }

    // 4. Reducers — resolve references before registering.
    for (const d of (config.reducers ?? [])) {
      const reducer = ScenarioSerializer._makeReducer(d, services);
      reducer.id = d.id;
      reducer.reducedActionTypes   = [...(d.reducedActionTypes ?? [])];
      reducer.generatedActionTypes = [...(d.generatedActionTypes ?? [])];
      for (const defData of (d.generatedActionDefinitions ?? [])) {
        reducer.generatedActionDefinitions.push(new ActionDefinition(defData));
      }
      reducerService.register(reducer); // publishes CREATE → sim wires reducers + graph node added
    }
  }

  // ─── Serializers ──────────────────────────────────────────────────────────────

  static _serializeAccount(account) {
    // Determine __type from type discriminator or class name
    const typeToClass = {
      'checking': 'CheckingAccount',
      'savings':  'SavingsAccount',
      'brokerage':'BrokerageAccount',
      '401k':     'FourOhOneKAccount',
      'roth':     'RothAccount',
      'ira':      'TraditionalIRAAccount',
      'super':    'SuperannuationAccount',
      'loan':     'LoanAccount',
      'offset':   'OffsetAccount',
    };
    const __type = typeToClass[account.type] ?? account.constructor?.name ?? 'Account';
    const d = {
      __type,
      id:               account.id,
      name:             account.name             ?? '',
      type:             account.type             ?? null,
      role:             account.role             ?? null,
      stateKey:         account.stateKey         ?? null,
      balance:          account.balance,
      ownershipType:    account.ownershipType    ?? 'sole',
      ownerId:          account.ownerId          ?? null,
      minimumBalance:   account.minimumBalance   ?? 0,
      drawdownPriority: account.drawdownPriority ?? null,
      country:          account.country          ?? null,
      currency:         account.currency         ?? null,
    };
    // InvestmentAccount base fields (brokerage + retirement). Gated on loanBalance
    // presence, NOT contributionBasis — brokerage keeps these but no longer carries
    // the basis ledger (design 53 §2), so an earlier contributionBasis gate silently
    // dropped a brokerage's AU margin loanBalance / balanceAtResidencyChange.
    if ('loanBalance' in account) {
      d.loanBalance              = account.loanBalance              ?? 0;
      d.balanceAtResidencyChange = account.balanceAtResidencyChange ?? null;
      // Per-country residency cost-base step-up (design 36 §12.2) — only emitted
      // when present (set at a move) so pre-move configs round-trip unchanged.
      if (account.costBaseStepUpByCountry != null) {
        d.costBaseStepUpByCountry = { ...account.costBaseStepUpByCountry };
      }
    }
    // RetirementAccount ledger fields (design 53 §2).
    if ('contributionBasis' in account) {
      d.contributionBasis = account.contributionBasis;
      d.earningsBasis     = account.earningsBasis ?? 0;
      d.minimumAge        = account.minimumAge    ?? null;
      // Roth rollover (conversion) buckets — only emitted when present so
      // accounts without conversions round-trip unchanged.
      if (account.rolloverContribBasis  != null) d.rolloverContribBasis  = account.rolloverContribBasis;
      if (account.rolloverEarningsBasis != null) d.rolloverEarningsBasis = account.rolloverEarningsBasis;
      if (Array.isArray(account.rolloverConversions) && account.rolloverConversions.length > 0) {
        d.rolloverConversions = account.rolloverConversions.map(l => ({ ...l }));
      }
    }
    // LoanAccount (liability) fields (design 54).
    if (account.type === 'loan') {
      d.interestRate      = account.interestRate      ?? 0;
      d.monthlyPayment    = account.monthlyPayment    ?? 0;
      d.linkedPropertyKey = account.linkedPropertyKey ?? null;
      d.paymentSourceKey  = account.paymentSourceKey  ?? null;
    }
    // OffsetAccount (cash-like, linked) field (design 53 §3 / 54 P3).
    if (account.type === 'offset') {
      d.offsetsPropertyKey = account.offsetsPropertyKey ?? null;
    }
    // Per-account earnings rates (design 55 §8) — only emitted when explicitly set
    // so legacy accounts (null → global fallback) round-trip byte-for-byte. The
    // loan branch above already owns `interestRate` for its loan rate, so the
    // generic earnings interestRate is skipped for loans.
    if (account.growthRate   != null) d.growthRate   = account.growthRate;
    if (account.dividendRate != null) d.dividendRate = account.dividendRate;
    if (account.type !== 'loan' && account.interestRate != null) d.interestRate = account.interestRate;
    // Prime-relative spread (design 56) — emitted only when set so non-Prime-linked
    // accounts (null) round-trip byte-for-byte.
    if (account.primeSpread != null) d.primeSpread = account.primeSpread;
    // Transaction-account flag (design 55 §7) — emitted only when true so legacy
    // accounts (default false) round-trip byte-for-byte.
    if (account.isTransactionAccount) d.isTransactionAccount = true;
    // Holdings (design 25 §8). Round-trip via Holding.toJSON; null when
    // absent so legacy configs (no holdings field) round-trip unchanged
    // and AccountService.register() re-bootstraps a default holding.
    if (Array.isArray(account.holdings) && account.holdings.length > 0) {
      d.holdings = account.holdings.map(h => (
        h instanceof Holding ? h.toJSON() : new Holding(h).toJSON()
      ));
    }
    // Inheritance metadata (design 63 §14) — emitted only on promoted inherited
    // records so owned accounts round-trip byte-for-byte.
    Object.assign(d, serializeInheritanceMeta(account) ?? {});
    return d;
  }

  static _serializeRealProperty(p) {
    const d = {
      __type:               'RealProperty',
      id:                   p.id,
      name:                 p.name                 ?? '',
      value:                p.value                ?? 0,
      costBasis:            p.costBasis            ?? 0,
      mortgageBalance:      p.mortgageBalance      ?? 0,
      monthlyMortgage:      p.monthlyMortgage      ?? 0,
      appreciationRate:     p.appreciationRate     ?? 0.035,
      isPrimaryResidence:   p.isPrimaryResidence   ?? false,
      plannedSaleYear:      p.plannedSaleYear      ?? null,
      saleDestinationAccount: p.saleDestinationAccount ?? null,
      ownershipType:        p.ownershipType        ?? 'sole',
      ownerId:              p.ownerId              ?? null,
      drawdownPriority:     p.drawdownPriority     ?? null,
      owners:               p.owners               ?? [],
      country:              p.country              ?? 'US',
      currency:             p.currency             ?? null,
      stateKey:             p.stateKey             ?? null,
      appreciationSchedule: p.appreciationSchedule
        ? p.appreciationSchedule.map(e => ({
            date: e.date instanceof Date ? e.date.toISOString() : e.date,
            rate: e.rate,
          }))
        : null,
      market:               p.market               ?? null,
      // Rental income (design 48)
      rentalEnabled:              p.rentalEnabled              ?? false,
      monthlyRent:                p.monthlyRent                ?? 0,
      occupancyRate:              p.occupancyRate              ?? 0.95,
      rentalExpenseRatio:         p.rentalExpenseRatio         ?? 0.25,
      mortgageInterestRate:       p.mortgageInterestRate       ?? 0,
      mortgagePrimeSpread:        p.mortgagePrimeSpread        ?? null,
      landValueRatio:             p.landValueRatio             ?? 0.2,
      annualDepreciationOverride: p.annualDepreciationOverride ?? null,
      accumulatedDepreciation:    p.accumulatedDepreciation    ?? 0,
      // Cross-border CGT step-up (design 62 §5)
      costBaseByCountry:          p.costBaseByCountry          ?? null,
      acquisitionPriceLevel:      p.acquisitionPriceLevel      ?? null,
      acquisitionDateByCountry:   p.acquisitionDateByCountry   ?? null,
    };
    // Inheritance metadata (design 63 §14) — emitted only on promoted inherited
    // property so owned properties round-trip byte-for-byte.
    Object.assign(d, serializeInheritanceMeta(p) ?? {});
    return d;
  }

  static _makeRealProperty(d) {
    const prop = new RealProperty(d.value ?? 0, {
      id:                  d.id,
      name:                d.name                ?? '',
      costBasis:           d.costBasis           ?? 0,
      mortgageBalance:     d.mortgageBalance     ?? 0,
      monthlyMortgage:     d.monthlyMortgage     ?? 0,
      appreciationRate:    d.appreciationRate    ?? 0.035,
      isPrimaryResidence:  d.isPrimaryResidence  ?? false,
      plannedSaleYear:     d.plannedSaleYear     ?? null,
      saleDestinationAccount: d.saleDestinationAccount ?? null,
      ownershipType:       d.ownershipType       ?? 'sole',
      ownerId:             d.ownerId             ?? null,
      drawdownPriority:    d.drawdownPriority    ?? null,
      owners:              d.owners              ?? [],
      country:             d.country             ?? 'US',
      currency:            d.currency            ?? null,
      appreciationSchedule: d.appreciationSchedule
        ? d.appreciationSchedule.map(e => ({ date: new Date(e.date), rate: e.rate }))
        : null,
      market:              d.market              ?? null,
      // Rental income (design 48)
      rentalEnabled:              d.rentalEnabled              ?? false,
      monthlyRent:                d.monthlyRent                ?? 0,
      occupancyRate:              d.occupancyRate              ?? 0.95,
      rentalExpenseRatio:         d.rentalExpenseRatio         ?? 0.25,
      mortgageInterestRate:       d.mortgageInterestRate       ?? 0,
      mortgagePrimeSpread:        d.mortgagePrimeSpread        ?? null,
      landValueRatio:             d.landValueRatio             ?? 0.2,
      annualDepreciationOverride: d.annualDepreciationOverride ?? null,
      accumulatedDepreciation:    d.accumulatedDepreciation    ?? 0,
      // Cross-border CGT step-up (design 62 §5)
      costBaseByCountry:          d.costBaseByCountry          ?? null,
      acquisitionPriceLevel:      d.acquisitionPriceLevel      ?? null,
      acquisitionDateByCountry:   d.acquisitionDateByCountry   ?? null,
    });
    if (d.stateKey) prop.stateKey = d.stateKey;
    // Inheritance metadata (design 63 §14) — restored from the serialized record
    // (defaults keep owned properties unchanged).
    applyInheritanceMeta(prop, d);
    return prop;
  }

  static _serializeCollectible(c) {
    const d = {
      __type:               'Collectible',
      id:                   c.id,
      name:                 c.name                 ?? '',
      value:                c.value                ?? 0,
      costBasis:            c.costBasis            ?? 0,
      appreciationRate:     c.appreciationRate     ?? 0.035,
      plannedSaleYear:      c.plannedSaleYear      ?? null,
      saleDestinationAccount: c.saleDestinationAccount ?? null,
      ownershipType:        c.ownershipType        ?? 'sole',
      ownerId:              c.ownerId              ?? null,
      drawdownPriority:     c.drawdownPriority     ?? null,
      owners:               c.owners               ?? [],
      country:              c.country              ?? 'US',
      currency:             c.currency             ?? null,
      stateKey:             c.stateKey             ?? null,
      // AU CGT reform (design 57 Part 2, Item C) — bullion marker + AU basis/level.
      isGold:               c.isGold               ?? false,
      costBaseByCountry:    c.costBaseByCountry    ?? null,
      acquisitionPriceLevel: c.acquisitionPriceLevel ?? null,
      acquisitionDateByCountry: c.acquisitionDateByCountry ?? null,
      appreciationSchedule: c.appreciationSchedule
        ? c.appreciationSchedule.map(e => ({
            date: e.date instanceof Date ? e.date.toISOString() : e.date,
            rate: e.rate,
          }))
        : null,
    };
    // Inheritance metadata (design 63 §14) — emitted only on promoted inherited
    // collectibles so owned collectibles round-trip byte-for-byte.
    Object.assign(d, serializeInheritanceMeta(c) ?? {});
    return d;
  }

  static _makeCollectible(d) {
    const col = new Collectible(d.value ?? 0, {
      id:                  d.id,
      name:                d.name                ?? '',
      costBasis:           d.costBasis           ?? 0,
      appreciationRate:    d.appreciationRate    ?? 0.035,
      plannedSaleYear:     d.plannedSaleYear     ?? null,
      saleDestinationAccount: d.saleDestinationAccount ?? null,
      ownershipType:       d.ownershipType       ?? 'sole',
      ownerId:             d.ownerId             ?? null,
      drawdownPriority:    d.drawdownPriority    ?? null,
      owners:              d.owners              ?? [],
      country:             d.country             ?? 'US',
      currency:            d.currency            ?? null,
      // AU CGT reform (design 57 Part 2, Item C).
      isGold:              d.isGold              ?? false,
      costBaseByCountry:   d.costBaseByCountry   ?? null,
      acquisitionPriceLevel: d.acquisitionPriceLevel ?? null,
      acquisitionDateByCountry: d.acquisitionDateByCountry ?? null,
      appreciationSchedule: d.appreciationSchedule
        ? d.appreciationSchedule.map(e => ({ date: new Date(e.date), rate: e.rate }))
        : null,
    });
    if (d.stateKey) col.stateKey = d.stateKey;
    // Inheritance metadata (design 63 §14) — restored from the serialized record.
    applyInheritanceMeta(col, d);
    return col;
  }

  static _serializeCompanyEquity(c) {
    return {
      __type:               'CompanyEquity',
      id:                   c.id,
      name:                 c.name                 ?? '',
      value:                c.value                ?? 0,
      costBasis:            c.costBasis            ?? 0,
      appreciationRate:     c.appreciationRate     ?? 0.08,
      plannedSaleYear:      c.plannedSaleYear      ?? null,
      saleDestinationAccount: c.saleDestinationAccount ?? null,
      ownershipType:        c.ownershipType        ?? 'sole',
      ownerId:              c.ownerId              ?? null,
      drawdownPriority:     c.drawdownPriority     ?? null,
      owners:               c.owners               ?? [],
      country:              c.country              ?? 'US',
      currency:             c.currency             ?? null,
      stateKey:             c.stateKey             ?? null,
      // s855-45 residency step-up stamps (design 72 §3) — must round-trip, or a
      // scenario saved after the AU move reloads with the AU basis lost and the
      // full gain re-assessed.
      costBaseByCountry:        c.costBaseByCountry        ?? null,
      acquisitionPriceLevel:    c.acquisitionPriceLevel    ?? null,
      acquisitionDateByCountry: c.acquisitionDateByCountry ?? null,
      appreciationSchedule: c.appreciationSchedule
        ? c.appreciationSchedule.map(e => ({
            date: e.date instanceof Date ? e.date.toISOString() : e.date,
            rate: e.rate,
          }))
        : null,
    };
  }

  static _makeCompanyEquity(d) {
    const eq = new CompanyEquity(d.value ?? 0, {
      id:                  d.id,
      name:                d.name                ?? '',
      costBasis:           d.costBasis           ?? 0,
      appreciationRate:    d.appreciationRate    ?? 0.08,
      plannedSaleYear:     d.plannedSaleYear     ?? null,
      saleDestinationAccount: d.saleDestinationAccount ?? null,
      ownershipType:       d.ownershipType       ?? 'sole',
      ownerId:             d.ownerId             ?? null,
      drawdownPriority:    d.drawdownPriority    ?? null,
      owners:              d.owners              ?? [],
      country:             d.country             ?? 'US',
      currency:            d.currency            ?? null,
      costBaseByCountry:        d.costBaseByCountry        ?? null,
      acquisitionPriceLevel:    d.acquisitionPriceLevel    ?? null,
      acquisitionDateByCountry: d.acquisitionDateByCountry ?? null,
      appreciationSchedule: d.appreciationSchedule
        ? d.appreciationSchedule.map(e => ({ date: new Date(e.date), rate: e.rate }))
        : null,
    });
    if (d.stateKey) eq.stateKey = d.stateKey;
    return eq;
  }

  /**
   * Serialize a Bequest config container (design 63). The inherited-asset
   * descriptors are plain, structuredClone-safe objects, so they round-trip
   * verbatim (deep-cloned to detach from the live record).
   */
  static _serializeBequest(b) {
    return {
      __type:          'Bequest',
      id:              b.id,
      name:            b.name            ?? '',
      stateKey:        b.stateKey        ?? null,
      decedentName:    b.decedentName    ?? '',
      relationship:    b.relationship    ?? 'immediate',
      decedentState:   b.decedentState   ?? null,
      heirId:          b.heirId          ?? null,
      inheritanceYear:  b.inheritanceYear  ?? null,
      inheritanceMonth: b.inheritanceMonth ?? 0,
      inheritanceDay:   b.inheritanceDay   ?? 15,
      paidViaEstate:   b.paidViaEstate   ?? false,
      assets:          (b.assets ?? []).map(a => ({ ...a })),
    };
  }

  static _makeBequest(d) {
    const bq = new Bequest({
      id:               d.id,
      name:             d.name            ?? '',
      decedentName:     d.decedentName    ?? '',
      relationship:     d.relationship    ?? 'immediate',
      decedentState:    d.decedentState   ?? null,
      heirId:           d.heirId          ?? null,
      inheritanceYear:  d.inheritanceYear  ?? null,
      inheritanceMonth: d.inheritanceMonth ?? 0,
      inheritanceDay:   d.inheritanceDay   ?? 15,
      paidViaEstate:    d.paidViaEstate   ?? false,
      assets:           (d.assets ?? []).map(a => ({ ...a })),
    });
    if (d.stateKey) bq.stateKey = d.stateKey;
    return bq;
  }

  static _serializePerson(person) {
    return {
      __type:                'Person',
      id:                    person.id,
      name:                  person.name,
      // Design 15: all dates serialize as full ISO 8601 strings. Deserializers
      // (e.g. _makePerson) wrap with `new Date(...)` which accepts both full ISO
      // and YYYY-MM-DD, so existing payloads remain readable.
      birthDate:             ScenarioSerializer.toDateStr(person.birthDate),
      citizen:               person.citizen ?? ['US'],
      residencyState:        person.residencyState ?? null,
      lifeExpectancy:        person.lifeExpectancy ?? 90,
      socialSecurityMonthly: person.socialSecurityMonthly ?? 2800,
      monthlyWage:           person.monthlyWage ?? 0,
      selfEmployed:          person.selfEmployed ?? false,
      retirementDate:        ScenarioSerializer.toDateStr(person.retirementDate)
                               ?? new Date(Date.UTC(2040, 0, 1)).toISOString(),
      wageCurrency:          person.wageCurrency ?? null,
      ssCurrency:            person.ssCurrency   ?? null,
      incomeSupportRecipient: person.incomeSupportRecipient ?? false,
    };
  }

  static _serializeEvent(node) {
    if (_isAlreadySerialized(node)) return node;
    const d = {
      __type:   node.eventType === 'OneOffEvent' ? 'OneOffEvent' : 'EventSeries',
      id:       node.id,
      name:     node.name,
      type:     node.type,
      enabled:  node.enabled ?? false,
      color:    node.color ?? '#888888',
    };
    if (node.order) d.order = node.order;   // same-date tiebreak; omit when default 0
    if (node.eventType === 'OneOffEvent') {
      d.date = node.date instanceof Date ? node.date.toISOString() : node.date;
      if (node.data && Object.keys(node.data).length > 0) {
        d.data = JSON.parse(JSON.stringify(node.data));
      }
    } else {
      d.interval    = node.interval;
      d.startOffset = node.startOffset ?? 0;
      if (node.month != null) d.month = node.month;
      if (node.day   != null) d.day   = node.day;
      if (node.data && Object.keys(node.data).length > 0) {
        d.data = JSON.parse(JSON.stringify(node.data));
      }
    }
    return d;
  }

  static _serializeHandler(node) {
    if (_isAlreadySerialized(node)) return node;
    return node.toJSON();
  }

  static _serializeAction(node) {
    if (_isAlreadySerialized(node)) return node;
    return node.toJSON();
  }

  static _serializeReducer(node) {
    if (_isAlreadySerialized(node)) return node;
    return node.toJSON();
  }

  // ─── Constructors ─────────────────────────────────────────────────────────────

  static _makeHandler(d, services) {
    const ctor = _lookupCtor(d.__type, services);
    if (!ctor) throw new Error(`Unknown handler type: ${d.__type}`);
    return ctor.fromJSON(d, services);
  }

  static _makeAction(d, services) {
    const ctor = _lookupCtor(d.__type, services);
    if (!ctor) throw new Error(`Unknown action type: ${d.__type}`);
    return ctor.fromJSON(d, services);
  }

  static _makeAccount(d) {
    const opts = {
      id:               d.id,
      name:             d.name             ?? '',
      role:             d.role             ?? null,
      ownershipType:    d.ownershipType    ?? 'sole',
      ownerId:          d.ownerId          ?? null,
      minimumBalance:   d.minimumBalance   ?? 0,
      drawdownPriority: d.drawdownPriority ?? null,
      country:          d.country          ?? null,
      currency:         d.currency         ?? null,
    };
    // InvestmentAccount base opt (brokerage + retirement) — independent of the
    // basis ledger (design 53 §2).
    if (d.loanBalance !== undefined) opts.loanBalance = d.loanBalance;
    // RetirementAccount ledger opts.
    if (d.contributionBasis !== undefined) {
      opts.contributionBasis = d.contributionBasis;
      opts.earningsBasis     = d.earningsBasis ?? 0;
      // Only set minimumAge when the serialized value is non-null; otherwise let
      // the subclass constructor apply its own default (59.5, 60, etc.).
      if (d.minimumAge != null) opts.minimumAge = d.minimumAge;
    }
    // LoanAccount (liability) opts (design 54).
    if (d.__type === 'LoanAccount') {
      opts.interestRate      = d.interestRate      ?? 0;
      opts.monthlyPayment    = d.monthlyPayment    ?? 0;
      opts.linkedPropertyKey = d.linkedPropertyKey ?? null;
      opts.paymentSourceKey  = d.paymentSourceKey  ?? null;
    }
    // OffsetAccount (cash-like, linked) opts (design 53 §3 / 54 P3).
    if (d.__type === 'OffsetAccount') {
      opts.offsetsPropertyKey = d.offsetsPropertyKey ?? null;
    }
    // Per-account earnings rates (design 55 §8). Skip interestRate for loans — the
    // LoanAccount branch above already set it from the loan rate.
    if (d.growthRate   !== undefined) opts.growthRate   = d.growthRate;
    if (d.dividendRate !== undefined) opts.dividendRate = d.dividendRate;
    if (d.__type !== 'LoanAccount' && d.interestRate !== undefined) opts.interestRate = d.interestRate;
    // Prime-relative spread (design 56) — absent on legacy saves → null (not linked).
    if (d.primeSpread !== undefined) opts.primeSpread = d.primeSpread;
    // Transaction-account flag (design 55 §7) — absent on legacy saves → false.
    if (d.isTransactionAccount !== undefined) opts.isTransactionAccount = d.isTransactionAccount;
    let account;
    switch (d.__type) {
      case 'CheckingAccount':       account = new CheckingAccount       ((d.balance ?? d.initialValue) ?? 0, opts); break;
      case 'SavingsAccount':        account = new SavingsAccount        ((d.balance ?? d.initialValue) ?? 0, opts); break;
      case 'LoanAccount':           account = new LoanAccount           ((d.balance ?? d.initialValue) ?? 0, opts); break;
      case 'OffsetAccount':         account = new OffsetAccount         ((d.balance ?? d.initialValue) ?? 0, opts); break;
      case 'BrokerageAccount':      account = new BrokerageAccount      ((d.balance ?? d.initialValue) ?? 0, opts); break;
      case 'FourOhOneKAccount':     account = new FourOhOneKAccount     ((d.balance ?? d.initialValue) ?? 0, opts); break;
      case 'RothAccount':           account = new RothAccount           ((d.balance ?? d.initialValue) ?? 0, opts); break;
      case 'TraditionalIRAAccount': account = new TraditionalIRAAccount ((d.balance ?? d.initialValue) ?? 0, opts); break;
      case 'SuperannuationAccount': account = new SuperannuationAccount ((d.balance ?? d.initialValue) ?? 0, opts); break;
      default:
        account = new Account((d.balance ?? d.initialValue) ?? 0, opts);
    }
    if (d.stateKey) account.stateKey = d.stateKey;
    if (d.costBaseStepUpByCountry != null) account.costBaseStepUpByCountry = { ...d.costBaseStepUpByCountry };
    if (d.rolloverContribBasis  != null) account.rolloverContribBasis  = d.rolloverContribBasis;
    if (d.rolloverEarningsBasis != null) account.rolloverEarningsBasis = d.rolloverEarningsBasis;
    if (Array.isArray(d.rolloverConversions)) account.rolloverConversions = d.rolloverConversions.map(l => ({ ...l }));
    // Holdings (design 25 §8) — restored via Holding.fromJSON. When absent
    // the account's empty holdings array triggers AccountService.register()'s
    // default-holding bootstrap, preserving legacy single-sleeve behavior.
    if (Array.isArray(d.holdings) && d.holdings.length > 0) {
      account.holdings = d.holdings.map(h => Holding.fromJSON(h));
      // Auto-heal the §4.4 invariant on load: scenarios saved before balance
      // edits kept holdings in sync (holdings-balance desync) can carry a
      // holdings sum that disagrees with account.balance. Treat the stored
      // balance as authoritative and rescale the holdings to match.
      if (holdingsOutOfSync(account)) {
        account.holdings = rescaleHoldingsToBalance(account.holdings, account.balance);
      }
    }
    // Auto-heal the basis ledger (design 43 §5 Phase 3): saved states drifted by
    // a pre-fix drawdown can carry contributionBasis/earningsBasis that over-state
    // balance (e.g. super contributionBasis 180k vs balance 39k). Clamp to balance
    // preserving the earnings fraction, before any consumer (scenario-compare,
    // after-tax metric) reads the ledger. No-op for cash and already-tied ledgers.
    reconcileLedgerToBalance(account);
    // Inheritance metadata (design 63 §14) — restored from the serialized record.
    applyInheritanceMeta(account, d);
    return account;
  }

  static _makePerson(d) {
    const person = new Person(d.id, new Date(d.birthDate), {
      name:                  d.name ?? '',
      citizen:               d.citizen ?? ['US'],
      residencyState:        d.residencyState ?? null,
      lifeExpectancy:        d.lifeExpectancy ?? 90,
      socialSecurityMonthly: d.socialSecurityMonthly ?? 2800,
      monthlyWage:           d.monthlyWage ?? 0,
      selfEmployed:          d.selfEmployed ?? false,
      retirementDate:        d.retirementDate ? new Date(d.retirementDate) : new Date(Date.UTC(2040, 0, 1)),
      wageCurrency:          d.wageCurrency ?? undefined,
      ssCurrency:            d.ssCurrency   ?? undefined,
      incomeSupportRecipient: d.incomeSupportRecipient ?? false,
    });
    return person;
  }

  static _makeEvent(d) {
    if (d.__type === 'OneOffEvent') {
      return new OneOffEvent({
        id:      d.id,
        name:    d.name,
        type:    d.type,
        date:    d.date ? new Date(d.date) : new Date(),
        enabled: d.enabled ?? false,
        color:   d.color ?? '#888888',
        order:   d.order ?? 0,
        data:    d.data ?? {},
      });
    } else if (d.__type == 'EventSeries') {
      return new EventSeries({
        id:          d.id,
        name:        d.name,
        type:        d.type,
        interval:    d.interval ?? 'month-end',
        startOffset: d.startOffset ?? 0,
        month:       d.month,
        day:         d.day,
        enabled:     d.enabled ?? false,
        color:       d.color ?? '#888888',
        order:       d.order ?? 0,
        data:        d.data ?? {},
      });
    } else {
      throw new Error(`Add support for deserialization of event type ${d.__type}.`);
    }
  }

  static _makeReducer(d, services) {
    const ctor = _lookupCtor(d.__type, services);
    if (!ctor) throw new Error(`Unknown reducer type: ${d.__type}`);
    return ctor.fromJSON(d, services);
  }
}
