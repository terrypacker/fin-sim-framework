/**
 * AUTO-GENERATED FILE - DO NOT EDIT
 * Run: npm run build:index
 */

import { SimulationWorkbench } from './apps/simulation-workbench.js';
import { WorkbenchApp } from './apps/workbench-app.js';
import { AccountRulesEngine } from './finance/account-rules/account-rules-engine.js';
import { AuAccountModule2024 } from './finance/account-rules/au/au-account-module-2024.js';
import { AuAccountModule2025 } from './finance/account-rules/au/au-account-module-2025.js';
import { AuAccountModule2026 } from './finance/account-rules/au/au-account-module-2026.js';
import { AuDividendFrankedResidentApplyReducer, AuDividendFrankedNonResidentApplyReducer, AuDividendUnfrankedResidentApplyReducer, AuDividendUnfrankedNonResidentApplyReducer, AuStockEarningsApplyReducer, AuStockWithdrawalApplyReducer, AuDividendFrankedResidentHandler, AuDividendFrankedNonResidentHandler, AuDividendUnfrankedResidentHandler, AuDividendUnfrankedNonResidentHandler, AuStockEarningsHandler, AuStockWithdrawalHandler } from './finance/account-rules/au/au-brokerage-classes.js';
import { AuFixedIncomeEarningsApplyReducer } from './finance/account-rules/au/au-fixed-income-classes.js';
import { AuSeIncomeApplyReducer, AuWagesIncomeApplyReducer, AuSeIncomeHandler } from './finance/account-rules/au/au-income-classes.js';
import { AuHouseSaleApplyReducer, AuHouseSaleHandler } from './finance/account-rules/au/au-real-property-classes.js';
import { AuSavingsContributionApplyReducer, AuSavingsWithdrawalApplyReducer, AuSavingsEarningsApplyReducer, AuSavingsContributionHandler, AuSavingsWithdrawalHandler, AuSavingsEarningsHandler } from './finance/account-rules/au/au-savings-classes.js';
import { SuperContributionApplyReducer, SuperWithdrawalContribApplyReducer, SuperWithdrawalEarningsApplyReducer, SuperEarningsApplyReducer, SuperContributionHandler, SuperWithdrawalContributionsHandler, SuperWithdrawalEarningsHandler, SuperEarningsDirectHandler } from './finance/account-rules/au/au-super-classes.js';
import { BaseAccountModule } from './finance/account-rules/base-account-module.js';
import { resolveCashKey, resolveDestinationCashKey, resolveSaleDestinationKey, resolvePresentCash } from './finance/account-rules/cash-routing.js';
import { InheritHandler, InheritApplyReducer, InheritanceNeTaxApplyReducer, InheritedRaDistributionHandler, InheritedRaDistributionApplyReducer } from './finance/account-rules/inheritance-classes.js';
import { INHERITED_RA_WINDOW, INHERITED_RA_DISTRIBUTION_STRATEGY, inheritedRaStrategy } from './finance/account-rules/inherited-ra-distribution-strategy.js';
import { loanKeyForProperty, findLoanForProperty, synthesizeLoanForProperty, offsetBalanceForLoan, effectivePrincipal, resolveLoanRate, LoanPaymentHandler, UsLoanPaymentHandler, AuLoanPaymentHandler, LoanPaymentApplyReducer } from './finance/account-rules/loan-classes.js';
import { UsMortgagePaymentHandler, UsMortgagePaymentApplyReducer, AuMortgagePaymentHandler, AuMortgagePaymentApplyReducer } from './finance/account-rules/mortgage-payment-classes.js';
import { computeRentalMonth, UsRentalIncomeHandler, UsRentalIncomeApplyReducer, AuRentalIncomeHandler, AuRentalIncomeApplyReducer } from './finance/account-rules/rental-income-classes.js';
import { ScheduledEarlyWithdrawalApplyReducer, EarlyWithdrawalPolicyHandler } from './finance/account-rules/us/early-withdrawal-classes.js';
import { IraContributionApplyReducer, IraWithdrawalContribApplyReducer, IraWithdrawalEarningsApplyReducer, IraEarningsApplyReducer, IraContributionHandler, IraWithdrawalContributionsHandler, IraWithdrawalEarningsHandler, IraEarningsHandler } from './finance/account-rules/us/ira-classes.js';
import { debitIra, IraRolloverWithdrawalApplyReducer, IraRmdApplyReducer, IraRolloverWithdrawalHandler, IraRmdHandler, IraAnnualRmdHandler } from './finance/account-rules/us/ira-rollover-classes.js';
import { K401ContributionApplyReducer, K401EarningsApplyReducer, K401WithdrawalApplyReducer, K401ContributionHandler, K401EarningsHandler, K401WithdrawalHandler, K401RmdApplyReducer, K401AnnualRmdHandler, K401ToIraConversionApplyReducer, K401ToIraConversionHandler } from './finance/account-rules/us/k401-classes.js';
import { RothContributionApplyReducer, RothWithdrawalContribApplyReducer, RothWithdrawalEarningsApplyReducer, RothEarningsApplyReducer, RothContributionHandler, RothWithdrawalContributionsHandler, RothWithdrawalEarningsHandler, RothEarningsHandler } from './finance/account-rules/us/roth-classes.js';
import { RothConversionApplyReducer, RothConversionHandler, RothConversionPolicyHandler } from './finance/account-rules/us/roth-conversion-classes.js';
import { RothRolloverContributionApplyReducer, RothRolloverEarningsApplyReducer, RothRolloverWithdrawalContribApplyReducer, RothRolloverWithdrawalEarningsApplyReducer, RothRolloverContributionHandler, RothRolloverEarningsHandler, RothRolloverWithdrawalContributionsHandler, RothRolloverWithdrawalEarningsHandler } from './finance/account-rules/us/roth-rollover-classes.js';
import { UsAccountModule2024 } from './finance/account-rules/us/us-account-module-2024.js';
import { UsAccountModule2025 } from './finance/account-rules/us/us-account-module-2025.js';
import { UsAccountModule2026 } from './finance/account-rules/us/us-account-module-2026.js';
import { FixedIncomeContributionApplyReducer, FixedIncomeWithdrawalApplyReducer, FixedIncomeEarningsApplyReducer, StockContributionApplyReducer, StockDividendApplyReducer, BondCouponApplyReducer, StockEarningsApplyReducer, StockWithdrawalApplyReducer, FixedIncomeContributionHandler, FixedIncomeWithdrawalHandler, FixedIncomeEarningsHandler, StockContributionHandler, StockDividendHandler, StockEarningsHandler, StockWithdrawalHandler } from './finance/account-rules/us/us-brokerage-classes.js';
import { CollectibleSaleApplyReducer, CollectibleValueChangeApplyReducer, CollectibleSaleHandler, CollectibleValueChangeHandler } from './finance/account-rules/us/us-collectible-classes.js';
import { getUsEarlyWithdrawalRules } from './finance/account-rules/us/us-early-withdrawal-rules.js';
import { SsIncomeApplyReducer, WagesIncomeApplyReducer, WagesWithheldApplyReducer, SeIncomeUsApplyReducer, BonusApplyReducer, CompanySaleApplyReducer, SsIncomeHandler, WagesIncomeHandler, WagesWithheldHandler, SeIncomeUsHandler, resolveBonusEarner, BonusHandler, CompanySaleHandler } from './finance/account-rules/us/us-income-classes.js';
import { auMainResidenceExemptFraction, UsHouseSaleApplyReducer, UsHouseSaleHandler } from './finance/account-rules/us/us-real-property-classes.js';
import { getUniformDistributionPeriod } from './finance/account-rules/us/us-rmd-uniform-table.js';
import { USD, AUD, ACCOUNT_TYPE, InsufficientFundsError, Account, CheckingAccount, SavingsAccount, LoanAccount, OffsetAccount } from './finance/assets/account.js';
import { Asset } from './finance/assets/asset.js';
import { Bequest } from './finance/assets/bequest.js';
import { Collectible } from './finance/assets/collectible.js';
import { CompanyEquity } from './finance/assets/company-equity.js';
import { INHERITANCE_META_FIELDS, applyInheritanceMeta, serializeInheritanceMeta } from './finance/assets/inheritance-meta.js';
import { reconcileLedgerToBalance, deriveEarningsBasis, InvestmentAccount, BrokerageAccount, RetirementAccount, FourOhOneKAccount, RothAccount, TraditionalIRAAccount, SuperannuationAccount } from './finance/assets/investment-account.js';
import { RealProperty } from './finance/assets/real-property.js';
import { DEFAULT_LOCATION_POLICY, planLocatedTargets } from './finance/behavioral/allocation-location.js';
import { AssetLocationRebalanceApplyReducer } from './finance/behavioral/asset-location-rebalance-apply-reducer.js';
import { BehavioralPanicSellApplyReducer } from './finance/behavioral/behavioral-panic-sell-apply-reducer.js';
import { BEHAVIORAL_STRATEGY_REGISTRY } from './finance/behavioral/behavioral-strategy-registry.js';
import { BondLadderReducer, materializeLadder } from './finance/behavioral/bond-ladder-reducer.js';
import { CashBucketDrawdownReducer } from './finance/behavioral/cash-bucket-drawdown-reducer.js';
import { ContributionSuspensionToggleReducer } from './finance/behavioral/contribution-suspension-toggle-reducer.js';
import { DownturnRothConversionReducer } from './finance/behavioral/downturn-roth-conversion-reducer.js';
import { OpportunisticRebalanceApplyReducer } from './finance/behavioral/opportunistic-rebalance-apply-reducer.js';
import { OpportunisticRebalanceReducer } from './finance/behavioral/opportunistic-rebalance-reducer.js';
import { PanicSellReducer } from './finance/behavioral/panic-sell-reducer.js';
import { RebalanceToTargetApplyReducer } from './finance/behavioral/rebalance-to-target-apply-reducer.js';
import { ALLOCATION_LOCATION, TAX_ADVANTAGED_ROLES, TAXABLE_ROLES, US_TAX_ADVANTAGED_ROLES, countryForRole, roleCanHoldGold, ALLOCATION_SCHEDULE, REGIME_TARGET_PRIORITY, ageAsOf, interpolateGlidepath, resolveRegimeTarget, targetForRole, RebalanceToTargetReducer } from './finance/behavioral/rebalance-to-target-reducer.js';
import { StockHarvestApplyReducer } from './finance/behavioral/stock-harvest-apply-reducer.js';
import { StrategicAssetLocationReducer } from './finance/behavioral/strategic-asset-location-reducer.js';
import { resolveSubstitute } from './finance/behavioral/substitute-holding.js';
import { TaxGainHarvestHandler } from './finance/behavioral/tax-gain-harvest-handler.js';
import { TaxLossHarvestHandler } from './finance/behavioral/tax-loss-harvest-handler.js';
import { AccountBuilder } from './finance/builders/account-builder.js';
import { PersonBuilder } from './finance/builders/person-builder.js';
import { US, AU, COUNTRY_CODES, currencyForCountry, defaultCurrencyForCountry, normalizeCountryCode } from './finance/country-codes.js';
import { buildDecisionGraphCsv } from './finance/decision-graph/decision-graph-csv.js';
import { DecisionPoint, DecisionGraph } from './finance/decision-graph/decision-graph-models.js';
import { DecisionGraphRegistry } from './finance/decision-graph/decision-graph-registry.js';
import { DecisionGraphResultStorage } from './finance/decision-graph/decision-graph-result-storage.js';
import { DecisionGraphRunner } from './finance/decision-graph/decision-graph-runner.js';
import { DecisionGraphStorage } from './finance/decision-graph/decision-graph-storage.js';
import { TAX_CLASS, taxClassForRole, defaultRateProvider, liquidationRateProvider, computeAfterTaxValue, computeAfterTaxNetWorth, computeAfterTaxNetLiquidity, deriveAfterTaxNetWorth, deriveAfterTaxNetLiquidity } from './finance/derived-metrics/after-tax.js';
import { isDrawdownAccessible, computeNetLiquidity, deriveNetLiquidity } from './finance/derived-metrics/net-liquidity.js';
import { computeNetWorth, deriveNetWorth } from './finance/derived-metrics/net-worth.js';
import { AddRegimeReducer } from './finance/economic-regimes/add-regime-reducer.js';
import { BondMaturityReducer } from './finance/economic-regimes/bond-maturity-reducer.js';
import { BondPriceAdjustReducer } from './finance/economic-regimes/bond-price-adjust-reducer.js';
import { EconomicRecoveryTickHandler } from './finance/economic-regimes/economic-recovery-tick-handler.js';
import { EconomicShockHandler } from './finance/economic-regimes/economic-shock-handler.js';
import { EquityReturnReducer } from './finance/economic-regimes/equity-return-reducer.js';
import { EquityReturnStepReducer } from './finance/economic-regimes/equity-return-step-reducer.js';
import { EquityReturnTickHandler } from './finance/economic-regimes/equity-return-tick-handler.js';
import { PrimeRelinkReducer } from './finance/economic-regimes/prime-relink-reducer.js';
import { PropertyReturnStepReducer } from './finance/economic-regimes/property-return-step-reducer.js';
import { PropertyReturnTickHandler } from './finance/economic-regimes/property-return-tick-handler.js';
import { RATE_KEYS, RATE_KEY_META, RATE_KEY_CLASS_MEMBERS, EQUITY_SLEEVES, DEFAULT_EQUITY_BETA, PROPERTY_SLEEVES, DEFAULT_RE_BETA, DEFAULT_RE_IDIO, ROLE_TO_RATE_KEY, MEMBER_RATE_KEY_BY_ROLE, INTEREST_RATE_KEYS, CASH_PRIME_KEY_BY_RATE_KEY, SAVINGS_KEY_BY_COUNTRY, PRIME_KEY_BY_COUNTRY } from './finance/economic-regimes/rate-keys.js';
import { RecoveryCurves } from './finance/economic-regimes/recovery-curves.js';
import { RegimeApplyReducer } from './finance/economic-regimes/regime-apply-reducer.js';
import { REGIME_TAG } from './finance/economic-regimes/regime-tag.js';
import { RemoveRegimeReducer } from './finance/economic-regimes/remove-regime-reducer.js';
import { RevalueAssetReducer } from './finance/economic-regimes/revalue-asset-reducer.js';
import { YieldCurveReducer } from './finance/economic-regimes/yield-curve-reducer.js';
import { YieldCurveStepReducer } from './finance/economic-regimes/yield-curve-step-reducer.js';
import { YieldCurveTickHandler } from './finance/economic-regimes/yield-curve-tick-handler.js';
import { countryOfRateKey, interpolateSpread, resolveYield, composeYieldCurve, shapeDelta } from './finance/economic-regimes/yield-curve.js';
import { SHOCK_LIBRARY, SHOCK_PRESET_OPTIONS } from './finance/economic-shocks/shock-library.js';
import { CurrencyConverter } from './finance/fx/currency-converter.js';
import { convertExpenseToAccount } from './finance/fx/expense-fx.js';
import { fxRate, fxFeeIn, convertNetOfFee, grossUpForTarget } from './finance/fx/fx-conversion.js';
import { CurrencyPair, FxEngine } from './finance/fx/fx-engine.js';
import { FX_PROCESS_MODELS, FX_PROCESS_MODEL_IDS, gaussianFrom } from './finance/fx/fx-process-models.js';
import { FxProcessReducer } from './finance/fx/fx-process-reducer.js';
import { FxRefreshReducer } from './finance/fx/fx-refresh-reducer.js';
import { FxService } from './finance/fx/fx-service.js';
import { FxStepApplyReducer } from './finance/fx/fx-step-apply-reducer.js';
import { FxTickHandler } from './finance/fx/fx-tick-handler.js';
import { FxTransferApplyReducer } from './finance/fx/fx-transfer-apply-reducer.js';
import { FxTransferToHandler } from './finance/fx/fx-transfer-handler.js';
import { UsdAudPair } from './finance/fx/usd-aud-pair.js';
import { AssetAppreciationHandler, AssetAppreciateReducer } from './finance/handlers/asset-appreciation-handler.js';
import { BondAccretionHandler } from './finance/handlers/bond-accretion-handler.js';
import { BondCouponScheduledHandler } from './finance/handlers/bond-coupon-handler.js';
import { BondSleeveCouponHandler } from './finance/handlers/bond-sleeve-coupon-handler.js';
import { CashSleeveInterestHandler } from './finance/handlers/cash-sleeve-interest-handler.js';
import { ChangeResidencyHandler } from './finance/handlers/change-residency-handler.js';
import { ChangeStateResidencyHandler } from './finance/handlers/change-state-residency-handler.js';
import { DividendScheduledHandler } from './finance/handlers/dividend-scheduled-handler.js';
import { IntlRothEarningsHandler, IntlIraEarningsHandler, IntlK401EarningsHandler, IntlUsStockEarningsHandler, IntlAuStockEarningsHandler, IntlAuStockDividendHandler, AuSavingsInterestHandler, AuFixedIncomeInterestMonthlyHandler, FixedIncomeInterestHandler, SuperEarningsHandler } from './finance/handlers/earnings-handlers.js';
import { HouseRunningCostHandler } from './finance/handlers/house-running-cost-handler.js';
import { IntlTransferToUsHandler, IntlTransferToAuHandler } from './finance/handlers/intl-transfer-handlers.js';
import { MonthlyExpensesHandler } from './finance/handlers/monthly-expenses-handler.js';
import { MonthlySocialSecurityHandler } from './finance/handlers/monthly-social-security-handler.js';
import { MonthlyWagesHandler } from './finance/handlers/monthly-wages-handler.js';
import { MortalityHandler } from './finance/handlers/mortality-handler.js';
import { OutOfFundsHandler } from './finance/handlers/out-of-funds-handler.js';
import { RealPropertyRepairTickHandler } from './finance/handlers/real-property-repair-tick-handler.js';
import { UsSavingsInterestMonthlyHandler } from './finance/handlers/us-savings-interest-handler.js';
import { ALLOCATION, ALLOCATION_VALUES, COLLECTIBLE_ALLOCATIONS, isCollectibleAllocation } from './finance/holdings/allocation.js';
import { resolveScheduledRate } from './finance/holdings/appreciation-schedule-utils.js';
import { bootstrapHoldingSplit } from './finance/holdings/bootstrap-holding-split.js';
import { DEFAULT_ALLOCATION_BY_ROLE, DEFAULT_ALLOCATION_BY_TYPE, resolveDefaultAllocation, resolveRateKey } from './finance/holdings/default-allocations.js';
import { HOLDING_ACTION_TYPES, HOLDING_ACTION_ENTRIES, HoldingTransactAction, HoldingRevalueAction, HoldingSetBasisAction, HoldingSplitAction, HoldingRetitleAction, HOLDING_ACTION_CLASSES, registerHoldingActionTypes } from './finance/holdings/holding-actions.js';
import { HOLDING_ACTIVITY_KIND, snapshotHoldings, totalSnapshot, buildHoldingActivity } from './finance/holdings/holding-activity.js';
import { HoldingTransactReducer, HoldingRevalueReducer, HoldingSetBasisReducer, HoldingSplitReducer, HoldingRetitleReducer, HOLDING_REDUCER_CLASSES, _syncBalance } from './finance/holdings/holding-reducers.js';
import { scaleHoldings, rescaleHoldingsToBalance, distributeHoldingsCredit, holdingsOutOfSync } from './finance/holdings/holding-utils.js';
import { Holding } from './finance/holdings/holding.js';
import { couponFederalExempt, couponStateExempt, computeHoldingsGrowth, computeHoldingsDividends, computeHoldingsCoupons, couponFiringFraction, couponFiringIndex, resolvePrevailingCouponRate, mergeCouponReinvestLots, computeHoldingsAccretion, computeHoldingsCashInterest } from './finance/holdings/holdings-earnings.js';
import { consumeHoldings, consumeHoldingsFifo } from './finance/holdings/holdings-fifo.js';
import { SLEEVE_ORDER, LOT_STRATEGY, purchaseTs, SLEEVE_ORDER_MODES, LOT_STRATEGIES, DRAWDOWN_SLEEVE_CLASSES, SLEEVE_WEIGHT_PREFIX, SLEEVE_WEIGHT_SEP, SLEEVE_WEIGHT_MODE, sleeveWeightKey, sleeveWeightsFromParams, resolveDrawdownSelection, withRebalanceCoupling, buildHoldingsComparator } from './finance/holdings/holdings-selection.js';
import { JournalDataSource } from './finance/journal-data-source.js';
import { JournalQueryApi } from './finance/journal-query-api.js';
import { exportDrillReports } from './finance/journal-reporting/drill-report-export.js';
import { buildReportRows, rowsToCsv, generateReportCsv } from './finance/journal-reporting/report-csv.js';
import { ReportDefinition, ReportDefinitionRegistry } from './finance/journal-reporting/report-definition-registry.js';
import { createReportApis, apiFor, runReport } from './finance/journal-reporting/run-report.js';
import { JournalReportingService } from './finance/journal-reporting-service.js';
import { DEFAULT_MC_VARIABLE_CONFIGS, CENTER_SOURCES, IntlRetirementMcConfig } from './finance/monte-carlo/intl-retirement-mc-config.js';
import { computeNetWorthUsd, computeHouseValueUsd, computePathShape, summarizeProvenance, IntlRetirementMcRunner } from './finance/monte-carlo/intl-retirement-mc-runner.js';
import { CDC_2024, AU_2022, lookupLifeTable } from './finance/monte-carlo/life-tables.js';
import { get, set } from './finance/monte-carlo/mc-param-paths.js';
import { rollForwardWithControls, recordDecisionRecord, readDecisionRecords, readDecisionRuns } from './finance/mpc/apply-forward.js';
import { COCKPIT_CONTROLS, CockpitController } from './finance/mpc/cockpit-controller.js';
import { DecisionRecordRegistry } from './finance/mpc/decision-record-registry.js';
import { DecisionRecordStorage } from './finance/mpc/decision-record-storage.js';
import { applyHarvestPlan, paramKeyOf, readParamValue, upsertParam, inferParamType, withIncluded } from './finance/mpc/harvest-apply.js';
import { foldHarvestPlan, feasibilityOfResult, checkHarvestFeasibility, describeFeasibility } from './finance/mpc/harvest-feasibility.js';
import { resolveStaticLevers, foldScheduleBakes, mergeResolved } from './finance/mpc/harvest-resolve.js';
import { HARVEST_FORMS, COLLAPSE_RULES, requiresIncludes, isIncludesRequirement, requirementSatisfied, harvestDecisions, pointHarvest, collapseConsecutive, ageAt, resolveBirthDate, _internals } from './finance/mpc/harvest.js';
import { runMpc, makeInitialSnapshot } from './finance/mpc/mpc-controller.js';
import { replayDecisions } from './finance/mpc/replay.js';
import { DEFAULT_OPTIMIZATION_CONFIGS, buildOptVariables } from './finance/optimization/intl-retirement-opt-config.js';
import { IntlRetirementOptimizer } from './finance/optimization/intl-retirement-optimizer.js';
import { valuesForConfig, cartesianProduct } from './finance/optimization/opt-values.js';
import { OPT_PARAM_TYPES, DEFAULT_TERMINAL_WEALTH_PENALTY, DEFAULT_DEFICIT_PENALTY, windowedDeficit, infeasibilityOf, isFeasibleResult, INFEASIBLE_OFFSET, DIE_WITH_TARGET_FAMILY, DIE_WITH_TARGET_AXES, resolveTerminalKey, terminalAxesFor, OPTIMIZATION_OBJECTIVES, OBJECTIVE_FAMILY_LABELS, objectivePrimaryMetric, objectiveIsWindowable, resolveDieWithTargetKey, groupedObjectiveOptions } from './finance/optimization/optimization-objectives.js';
import { OptimizationProblem } from './finance/optimization/optimization-problem.js';
import { initProblem, runTask, runSeriesTask } from './finance/optimization/parallel/rollout-worker-core.js';
import { rolloutContext, browserRolloutSpawn, RolloutWorkerPool } from './finance/optimization/parallel/rollout-worker-pool.js';
import { rolloutProfiler } from './finance/optimization/rollout-profiler.js';
import { CemSolver } from './finance/optimization/solvers/cem-solver.js';
import { GridSearchSolver } from './finance/optimization/solvers/grid-search-solver.js';
import { PatternSearchSolver } from './finance/optimization/solvers/pattern-search-solver.js';
import { qpPolish, QpPolishSolver } from './finance/optimization/solvers/qp-polish.js';
import { RandomSolver } from './finance/optimization/solvers/random-solver.js';
import { SimulatedAnnealingSolver } from './finance/optimization/solvers/simulated-annealing-solver.js';
import { SOLVER_REGISTRY, createSolver } from './finance/optimization/solvers/solver-registry.js';
import { makeSeededRng, EvalLedger } from './finance/optimization/solvers/solver-support.js';
import { ownershipFractions, splitByOwnership, resolveAttributionAsset, resolveAttributionFractions, accumulateByOwnership } from './finance/ownership-utils.js';
import { isParamVisible, visibleWhenControllers, controllableVariables, scenarioParamValues, paramSchemaDefaults, indexParamSchema, resolveSweepVariables } from './finance/param-schema-utils.js';
import { buildMonthPeriod, buildUsCalendarYear, buildAuFiscalYear, applyTo } from './finance/period/period-builder.js';
import { Period, PeriodRelationship, PeriodService } from './finance/period/period-service.js';
import { Person } from './finance/person.js';
import { AccountRetitleApplyReducer } from './finance/reducers/account-retitle-apply-reducer.js';
import { AccumulateConsumptionReducer } from './finance/reducers/accumulate-consumption-reducer.js';
import { AccumulateConsumptionUtilityReducer } from './finance/reducers/accumulate-consumption-utility-reducer.js';
import { AccumulateDeficitReducer } from './finance/reducers/accumulate-deficit-reducer.js';
import { AccumulateTaxesPaidReducer } from './finance/reducers/accumulate-taxes-paid-reducer.js';
import { BondAccretionApplyReducer } from './finance/reducers/bond-accretion-apply-reducer.js';
import { BondCouponCashApplyReducer } from './finance/reducers/bond-coupon-cash-apply-reducer.js';
import { BondSleeveCouponApplyReducer } from './finance/reducers/bond-sleeve-coupon-apply-reducer.js';
import { CashSleeveInterestApplyReducer } from './finance/reducers/cash-sleeve-interest-apply-reducer.js';
import { ChangeResidencyApplyReducer } from './finance/reducers/change-residency-apply-reducer.js';
import { ChangeStateResidencyApplyReducer } from './finance/reducers/change-state-residency-apply-reducer.js';
import { ExpenseDebitReducer } from './finance/reducers/expense-debit-reducer.js';
import { HouseRepairApplyReducer } from './finance/reducers/house-repair-apply-reducer.js';
import { InflationAdjustReducer } from './finance/reducers/inflation-adjust-reducer.js';
import { IntlTransferApplyReducer, IntlTransferRecordReducer } from './finance/reducers/intl-transfer-apply-reducer.js';
import { OutOfFundsReducer } from './finance/reducers/out-of-funds-reducer.js';
import { PersonDiedApplyReducer } from './finance/reducers/person-died-apply-reducer.js';
import { ReplenishSavingsReducer } from './finance/reducers/replenish-savings-reducer.js';
import { ScenarioCompleteReducer } from './finance/reducers/scenario-complete-reducer.js';
import { SetOutOfFundsDateReducer } from './finance/reducers/set-out-of-funds-date-reducer.js';
import { SocialSecuritySurvivorApplyReducer } from './finance/reducers/social-security-survivor-apply-reducer.js';
import { StockDividendCashApplyReducer } from './finance/reducers/stock-dividend-cash-apply-reducer.js';
import { SuperDeathBenefitApplyReducer } from './finance/reducers/super-death-benefit-apply-reducer.js';
import { UsSavingsInterestCreditReducer } from './finance/reducers/us-savings-interest-credit-reducer.js';
import { getResidency, isResident, residentsOf, primaryPersonKey, primaryResidencyState, getBirthDate } from './finance/residency-utils.js';
import { ScenarioCompareRunner } from './finance/scenario-compare/scenario-compare-runner.js';
import { flattenNumericState, computeStateDiff, journalPairKey, mergeEntryFieldRows, pairEntriesWithinDay, firstDivergenceDate, runningNetWorthSeries, buildJournalOverlay } from './finance/scenario-compare/scenario-compare-utils.js';
import { AccountService } from './finance/services/account-service.js';
import { AssetService } from './finance/services/asset-service.js';
import { promotedRetirementMeta, inheritedAssetMeta, BequestService } from './finance/services/bequest-service.js';
import { CollectibleService } from './finance/services/collectible-service.js';
import { CompanyEquityService } from './finance/services/company-equity-service.js';
import { PersonService } from './finance/services/person-service.js';
import { RealPropertyService } from './finance/services/real-property-service.js';
import { StateRegistry } from './finance/services/state-registry.js';
import { ParameterValueType, StateSchemaRegistry } from './finance/services/state-schema-registry.js';
import { ageBandStartAge, ageSpendingFactor } from './finance/spending/age-spending-factor.js';
import { computeGuardrailPortfolioValue } from './finance/spending/guardrail-portfolio-value.js';
import { SpendingStrategyApplyReducer } from './finance/spending/spending-strategy-apply-reducer.js';
import { SPENDING_STRATEGY_REGISTRY } from './finance/spending/spending-strategy-registry.js';
import { DEFAULT_AGE_BANDS, AgeBandedSpendingReducer } from './finance/spending/strategies/age-banded-spending-reducer.js';
import { DEFAULT_EXPENSE_BANDS, pinExpensesForBand, repinExpensesIfChanged, ExplicitBandsSpendingReducer } from './finance/spending/strategies/explicit-bands-spending-reducer.js';
import { GuardrailAdjustApplyReducer } from './finance/spending/strategies/guardrail-adjust-apply-reducer.js';
import { GuardrailAnnualCheckReducer } from './finance/spending/strategies/guardrail-annual-check-reducer.js';
import { GuardrailBaselineApplyReducer } from './finance/spending/strategies/guardrail-baseline-apply-reducer.js';
import { HealthcareEventHandler } from './finance/spending/strategies/healthcare-event-handler.js';
import { HealthcareExpenseApplyReducer } from './finance/spending/strategies/healthcare-expense-apply-reducer.js';
import { LateLifeCareApplyReducer } from './finance/spending/strategies/late-life-care-apply-reducer.js';
import { LateLifeCareHandler } from './finance/spending/strategies/late-life-care-handler.js';
import { RegimeAwareSpendingReducer } from './finance/spending/strategies/regime-aware-spending-reducer.js';
import { RetirementDateHandler } from './finance/spending/strategies/retirement-date-handler.js';
import { ACCOUNT_ROLES, INHERITED_RETIREMENT_ROLES } from './finance/state/account-roles.js';
import { InternationalRetirementFinancialState } from './finance/state/intl-retirement-state.js';
import { StateTaxService } from './finance/state-tax-service.js';
import { AuTaxDocument2024 } from './finance/tax/au/au-tax-document-2024.js';
import { AuTaxDocument2025 } from './finance/tax/au/au-tax-document-2025.js';
import { AuTaxDocument2026 } from './finance/tax/au/au-tax-document-2026.js';
import { AuTaxDocument2027 } from './finance/tax/au/au-tax-document-2027.js';
import { AuTaxModule2024 } from './finance/tax/au/au-tax-module-2024.js';
import { AuTaxModule2025 } from './finance/tax/au/au-tax-module-2025.js';
import { AuTaxModule2026 } from './finance/tax/au/au-tax-module-2026.js';
import { AuTaxModule2027 } from './finance/tax/au/au-tax-module-2027.js';
import { AuTaxRates2024 } from './finance/tax/au/au-tax-rates-2024.js';
import { AuTaxRates2025 } from './finance/tax/au/au-tax-rates-2025.js';
import { AuTaxRates2026 } from './finance/tax/au/au-tax-rates-2026.js';
import { AuTaxRates2027 } from './finance/tax/au/au-tax-rates-2027.js';
import { AuTaxRatesBase } from './finance/tax/au/au-tax-rates-base.js';
import { SUPER_TAX_RATE, superEarningsTaxRate } from './finance/tax/au/super-tax-rate.js';
import { BaseTaxDocumentModule } from './finance/tax/base-tax-document-module.js';
import { BaseTaxModule } from './finance/tax/base-tax-module.js';
import { BaseTaxRatesModule } from './finance/tax/base-tax-rates-module.js';
import { applyBracketsDetailed, applyBrackets, marginalBracketRate, subtractBands, flatRateBand } from './finance/tax/bracket-schedule.js';
import { DynamicTaxReducer } from './finance/tax/dynamic-tax-reducer.js';
import { InflationAdjustedUsTaxRates, InflationAdjustedAuTaxRates } from './finance/tax/inflation-adjusted-tax-rates.js';
import { UsPeriodAdvanceReducer, AuPeriodAdvanceReducer, UsPeriodAdvanceHandler, AuPeriodAdvanceHandler } from './finance/tax/period-advance-classes.js';
import { RESIDENCY_COST_BASE_STEP_UP, stepsUpCostBaseOnResidency } from './finance/tax/residency-cost-base-policy.js';
import { BaseStateTaxRatesModule } from './finance/tax/state/base-state-tax-rates-module.js';
import { HiStateTaxRates2024 } from './finance/tax/state/hi/hi-state-tax-rates-2024.js';
import { HiStateTaxRates2025 } from './finance/tax/state/hi/hi-state-tax-rates-2025.js';
import { HiStateTaxRates2026 } from './finance/tax/state/hi/hi-state-tax-rates-2026.js';
import { HiStateTaxRates2027 } from './finance/tax/state/hi/hi-state-tax-rates-2027.js';
import { HiStateTaxRates2028 } from './finance/tax/state/hi/hi-state-tax-rates-2028.js';
import { HiStateTaxRates2029 } from './finance/tax/state/hi/hi-state-tax-rates-2029.js';
import { HiStateTaxRates2030 } from './finance/tax/state/hi/hi-state-tax-rates-2030.js';
import { HiStateTaxRates2031 } from './finance/tax/state/hi/hi-state-tax-rates-2031.js';
import { NeStateTaxRates2024 } from './finance/tax/state/ne/ne-state-tax-rates-2024.js';
import { NeStateTaxRates2025 } from './finance/tax/state/ne/ne-state-tax-rates-2025.js';
import { SdStateTaxRates2024 } from './finance/tax/state/sd/sd-state-tax-rates-2024.js';
import { STATE_INCOME_ROUTING, STATE_YTD_FIELDS, StateIncomeClassificationReducer, buildStateClassificationReducers } from './finance/tax/state/state-income-classification.js';
import { StateTaxDocumentReporter } from './finance/tax/state/state-tax-document.js';
import { StateTaxSettleHandler, StateTaxSettleApplyReducer, StateTaxPaymentDebitReducer } from './finance/tax/state/state-tax-settle-classes.js';
import { StateTaxSettleService } from './finance/tax/state/state-tax-settle-service.js';
import { TaxDocumentRegistry } from './finance/tax/tax-document-registry.js';
import { TaxEngine } from './finance/tax/tax-engine.js';
import { toCcy, toUSD, toAUD, TAX_FX_PAIR, taxFxRate } from './finance/tax/tax-fx.js';
import { UsTaxSettleHandler, AuTaxSettleHandler, UsTaxSettleApplyReducer, AuTaxSettleApplyReducer, UsTaxPaymentDebitReducer, AuTaxPaymentDebitReducer } from './finance/tax/tax-settle-classes.js';
import { TAX_SETTLE_ACTION_TYPES, settleActionTypeFor, isTaxSettleEntry, primaryTaxSettleEntries } from './finance/tax/tax-settle-entries.js';
import { WORKSHEET_COLUMNS, buildTaxWorksheetRows, worksheetRowsFromDocuments, verifyWorksheetRows, toCsv } from './finance/tax/tax-worksheet-export.js';
import { taxYearLabel, auFyLabel } from './finance/tax/tax-year-label.js';
import { UsTaxDocument2024 } from './finance/tax/us/us-tax-document-2024.js';
import { UsTaxDocument2025 } from './finance/tax/us/us-tax-document-2025.js';
import { UsTaxDocument2026 } from './finance/tax/us/us-tax-document-2026.js';
import { UsTaxModule2024 } from './finance/tax/us/us-tax-module-2024.js';
import { UsTaxModule2025 } from './finance/tax/us/us-tax-module-2025.js';
import { UsTaxModule2026 } from './finance/tax/us/us-tax-module-2026.js';
import { UsTaxRates2024 } from './finance/tax/us/us-tax-rates-2024.js';
import { UsTaxRates2025 } from './finance/tax/us/us-tax-rates-2025.js';
import { UsTaxRates2026 } from './finance/tax/us/us-tax-rates-2026.js';
import { UsTaxRatesBase, _drawDownBasket } from './finance/tax/us/us-tax-rates-base.js';
import { TaxService } from './finance/tax-service.js';
import { TaxSettleService, US_BRACKET_BASE_YEAR, usRatesForYear, usBracketGrossIncomeCeiling } from './finance/tax-settle-service.js';
import { EDGE_TYPES, createEdgeId, Edge } from './graph/edge.js';
import { GraphQueryApi } from './graph/graph-query-api.js';
import { Graph } from './graph/graph.js';
import { SimGraphNode } from './graph/sim-graph-node.js';
import { QueryApi } from './query/query-api.js';
import { BaseScenario } from './scenarios/base-scenario.js';
import { BlankScenario } from './scenarios/blank-scenario.js';
import { DRAWDOWN_STRATEGIES, DRAWDOWN_ROLES, DRAWDOWN_WEIGHT_MODE, DRAWDOWN_WEIGHT_PREFIX, DRAWDOWN_WEIGHT_SEP, drawdownWeightKey, DRAWDOWN_WEIGHT_ROLES, DRAWDOWN_CASH_ROLES, DRAWDOWN_ROLE_LABELS, presentDrawdownWeightRoles, drawdownWeightsFromStrategy, DEFAULT_DRAWDOWN_WEIGHTS, buildDrawdownWeightSchema, DEFAULT_DRAWDOWN_WEIGHT_PARAMS, DEFAULT_SLEEVE_WEIGHTS, buildSleeveWeightSchema, DEFAULT_SLEEVE_WEIGHT_PARAMS, ALLOCATION_OPTIMIZED_MODE, ALLOC_WEIGHT_CLASSES, ALLOC_WEIGHT_PREFIX, ALLOC_WEIGHT_SEP, allocWeightKey, ALLOC_WEIGHT_CLASS_LABELS, ALLOCATION_PRESETS, DEFAULT_ALLOC_WEIGHTS, synthesizeTargetAllocation, allocWeightsFromMix, allocWeightsFromPreset, presentAllocations, buildAllocWeightSchema, DEFAULT_ALLOC_WEIGHT_PARAMS, INTL_RETIREMENT_DEFAULTS, INTL_RETIREMENT_PARAM_SCHEMA, INTL_RETIREMENT_PARAM_ALIASES, resolveBalanceCenters, IntlRetirementScenario, applyRealPropertySaleYearParams } from './scenarios/intl-retirement-scenario.js';
import { BALANCE_TARGET, ACCOUNT_PARAM_TEMPLATES, PERSON_PARAM_TEMPLATE, REAL_PROPERTY_PARAM_TEMPLATE, COLLECTIBLE_PARAM_TEMPLATE, COMPANY_EQUITY_PARAM_TEMPLATE, BEQUEST_PARAM_TEMPLATE, INHERITED_RA_PARAM_TEMPLATE } from './scenarios/params/record-param-templates.js';
import { GENERATED_KEY_PREFIXES, isGeneratedParamKey, decodeGeneratedParamKey, ScenarioParamGenerator } from './scenarios/params/scenario-param-generator.js';
import { synthesizeWeightedPriorities, ScenarioLoader } from './scenarios/scenario-loader.js';
import { ScenarioRegistry } from './scenarios/scenario-registry.js';
import { ScenarioSerializer } from './scenarios/scenario-serializer.js';
import { ScenarioStorage } from './scenarios/scenario-storage.js';
import { AU_BANKING } from './scenarios/toolsets/au-banking-toolset.js';
import { AU_BROKERAGE } from './scenarios/toolsets/au-brokerage-toolset.js';
import { AU_INCOME } from './scenarios/toolsets/au-income-toolset.js';
import { AU_REAL_PROPERTY } from './scenarios/toolsets/au-real-property-toolset.js';
import { AU_RETIREMENT } from './scenarios/toolsets/au-retirement-toolset.js';
import { AU_TAX } from './scenarios/toolsets/au-tax-toolset.js';
import { resolvePropertyRateKey, ECONOMIC_REGIMES } from './scenarios/toolsets/economic-regimes-toolset.js';
import { INHERITANCE } from './scenarios/toolsets/inheritance-toolset.js';
import { ScenarioCompiler } from './scenarios/toolsets/scenario-compiler.js';
import { ToolsetRegistry } from './scenarios/toolsets/toolset-registry.js';
import { US_AU_CROSS_BORDER } from './scenarios/toolsets/us-au-cross-border-toolset.js';
import { US_BANKING } from './scenarios/toolsets/us-banking-toolset.js';
import { US_BROKERAGE } from './scenarios/toolsets/us-brokerage-toolset.js';
import { US_COLLECTIBLES } from './scenarios/toolsets/us-collectibles-toolset.js';
import { US_COMPANY_SALE } from './scenarios/toolsets/us-company-sale-toolset.js';
import { retargetEarlyWithdrawalEvents, US_EARLY_WITHDRAWAL } from './scenarios/toolsets/us-early-withdrawal-toolset.js';
import { US_INCOME } from './scenarios/toolsets/us-income-toolset.js';
import { US_REAL_PROPERTY } from './scenarios/toolsets/us-real-property-toolset.js';
import { US_RETIREMENT } from './scenarios/toolsets/us-retirement-toolset.js';
import { BRACKET_BASE_YEAR, retargetRothConversionEvents, US_ROTH_CONVERSION } from './scenarios/toolsets/us-roth-conversion-toolset.js';
import { US_STATE_TAX } from './scenarios/toolsets/us-state-tax-toolset.js';
import { US_TAX } from './scenarios/toolsets/us-tax-toolset.js';
import { ActionService } from './services/action-service.js';
import { BaseService } from './services/base-service.js';
import { EVENT_CLASSES, EventService } from './services/event-service.js';
import { HandlerService } from './services/handler-service.js';
import { ReducerService } from './services/reducer-service.js';
import { ScenarioService } from './services/scenario-service.js';
import { ServiceRegistry } from './services/service-registry.js';
import { SimulationRegistry } from './services/simulation-registry.js';
import { SimulationSync } from './services/simulation-sync.js';
import { ACTION_TEMPLATES } from './simulation-framework/action-templates.js';
import { DEFAULT_ACTIONS, Action, FieldAction, FieldValueAction, AmountAction, RecordBalanceAction, RecordMetricAction, ScriptedAction, ACTION_CLASSES, generateActionId, ActionDefinition } from './simulation-framework/actions.js';
import { ActionBuilder } from './simulation-framework/builders/action-builder.js';
import { EventBuilder } from './simulation-framework/builders/event-builder.js';
import { HandlerBuilder } from './simulation-framework/builders/handler-builder.js';
import { ReducerBuilder } from './simulation-framework/builders/reducer-builder.js';
import { EXECUTION_KINDS, EXECUTION_PHASES, SIMULATION_BUS_MESSAGES, BusMessage, SimulationBusMessage, ExecutionBusMessage, BreakpointHitMessage, ServiceActionEvent, ServiceBulkActionEvent, ServiceEdgeActionEvent } from './simulation-framework/bus-messages.js';
import { DateUtils } from './simulation-framework/date-utils.js';
import { DerivedMetricsRegistry } from './simulation-framework/derived-metrics-registry.js';
import { ConstantDistribution, UniformDistribution, NormalDistribution, LogNormalDistribution, BernoulliDistribution, UniformDateDistribution, ActuarialLifespanDistribution, DISTRIBUTION_TYPES, createDistribution } from './simulation-framework/distributions.js';
import { EventBus } from './simulation-framework/event-bus.js';
import { BaseEvent } from './simulation-framework/events/base-event.js';
import { EventSeries } from './simulation-framework/events/event-series.js';
import { OneOffEvent } from './simulation-framework/events/one-off-event.js';
import { EXECUTION_EDGE_TYPES, ExecutionGraph } from './simulation-framework/execution-graph.js';
import { buildExecutionId, parentIdOf, nodeIdOf, executionIndexOf } from './simulation-framework/execution-utils.js';
import { GraphRecorder } from './simulation-framework/graph-recorder.js';
import { HandlerEntry, HANDLER_CLASSES, HandlerRegistry } from './simulation-framework/handlers.js';
import { IndexedMinHeap } from './simulation-framework/indexed-min-heap.js';
import { JournalEntry, Journal } from './simulation-framework/journal.js';
import { MinHeap } from './simulation-framework/min-heap.js';
import { ReducerPipeline, PRIORITY, Reducer, NoOpReducer, FieldReducer, MetricReducer, BalanceSnapshotReducer, FieldValueReducer, ArrayReducer, NumericSumReducer, MultiplicativeReducer, AccountTransactionReducer, REDUCER_CLASSES, RepeatingReducer, ScriptedReducer, AccountServiceReducer } from './simulation-framework/reducers.js';
import { ScenarioRunner } from './simulation-framework/scenario.js';
import { intervalFns, startSnapFns, SimulationAdapter } from './simulation-framework/simulation/simulation-adapter.js';
import { SimulationHistory } from './simulation-framework/simulation-history.js';
import { SimulationState } from './simulation-framework/simulation-state.js';
import { BreakpointSignal, SimulationHorizonError, TELEMETRY_LEVELS, Simulation } from './simulation-framework/simulation.js';
import { deepClone, snapshotForDiff, MutationTracker, diffStates } from './simulation-framework/state-utils.js';
import { ValueType, TypeRegistry } from './simulation-framework/type-registry.js';
import { InMemoryStorage } from './storage/in-memory-storage.js';
import { AccountEditor } from './visualization/accounts/account-editor.js';
import { AccountsController } from './visualization/accounts/accounts-controller.js';
import { APP_EVENTS, AppDisplaySettings } from './visualization/app-display-settings.js';
import { BequestEditor } from './visualization/assets/bequest-editor.js';
import { CollectibleEditor } from './visualization/assets/collectible-editor.js';
import { CompanyEquityEditor } from './visualization/assets/company-equity-editor.js';
import { RealPropertyEditor } from './visualization/assets/real-property-editor.js';
import { ChartController } from './visualization/chart/chart-controller.js';
import { ChartPresenter } from './visualization/chart/chart-presenter.js';
import { ChartView } from './visualization/chart/chart-view.js';
import { ActionDefinitionList } from './visualization/components/action-definition-list.js';
import { ActionEditor } from './visualization/components/action-editor.js';
import { BaseComponent } from './visualization/components/base-component.js';
import { BaseNodeEditor } from './visualization/components/base-node-editor.js';
import { EChartsGraphRenderer } from './visualization/components/echarts-graph-renderer.js';
import { initEChartWhenReady } from './visualization/components/echarts-init.js';
import { EventEditor } from './visualization/components/event-editor.js';
import { AccountNodeRenderer } from './visualization/components/graph/rendering/account-node-renderer.js';
import { ActionNodeRenderer } from './visualization/components/graph/rendering/action-node-renderer.js';
import { BequestNodeRenderer } from './visualization/components/graph/rendering/bequest-node-renderer.js';
import { CollectibleNodeRenderer } from './visualization/components/graph/rendering/collectible-node-renderer.js';
import { CompanyEquityNodeRenderer } from './visualization/components/graph/rendering/company-equity-node-renderer.js';
import { DefaultNodeRenderer, NodeRenderGroup } from './visualization/components/graph/rendering/default-node-renderer.js';
import { EventNodeRenderer } from './visualization/components/graph/rendering/event-node-renderer.js';
import { HandlerNodeRenderer } from './visualization/components/graph/rendering/handler-node-renderer.js';
import { NodeRenderKit } from './visualization/components/graph/rendering/node-render-kit.js';
import { NodeRendererRegistry } from './visualization/components/graph/rendering/node-renderer-registry.js';
import { PersonNodeRenderer } from './visualization/components/graph/rendering/person-node-renderer.js';
import { RealPropertyNodeRenderer } from './visualization/components/graph/rendering/real-property-node-renderer.js';
import { ReducerNodeRenderer } from './visualization/components/graph/rendering/reducer-node-renderer.js';
import { GraphNodeFilterMultiSelect } from './visualization/components/graph-node-filter-multi-select.js';
import { HandlerEditor } from './visualization/components/handler-editor.js';
import { MapFilterMultiSelect } from './visualization/components/map-filter-multi-select.js';
import { NodeEditModal } from './visualization/components/node-edit-modal.js';
import { ReducerEditor } from './visualization/components/reducer-editor.js';
import { RenderScheduler } from './visualization/components/render-scheduler.js';
import { ConfigurationListComponent } from './visualization/configuration/configuration-list.js';
import { DecisionGraphPresenter } from './visualization/decision-graph/decision-graph-presenter.js';
import { DgConfigPanel } from './visualization/decision-graph/dg-config-panel.js';
import { DgResultsPanel } from './visualization/decision-graph/dg-results-panel.js';
import { BaseGraphView } from './visualization/graph-builder/base-graph-view.js';
import { detectMidXObstacles, chooseClearMidX } from './visualization/graph-builder/collision-detector.js';
import { ColumnLayout } from './visualization/graph-builder/column-layout.js';
import { ConfigGraphView } from './visualization/graph-builder/config-graph-view.js';
import { GraphBuilderController } from './visualization/graph-builder/graph-builder-controller.js';
import { GraphBuilderPresenter } from './visualization/graph-builder/graph-builder-presenter.js';
import { GraphBuilderView } from './visualization/graph-builder/graph-builder-view.js';
import { nodeBounds, nodeAnchors } from './visualization/graph-builder/graph-geometry.js';
import { NODE_WIDTH, NODE_HEIGHT, COLUMN_GAP, ROW_GAP, PADDING_X, PADDING_Y, BACKWARD_MARGIN, EDGE_SPACING, LANE_OFFSET, OBSTACLE_MARGIN, MERGE_OFFSET, ARROW_SIZE, ARROW_HALF, EDGE_COLOR, EDGE_COLOR_HIGHLIGHT, EDGE_WIDTH, EDGE_WIDTH_HIGHLIGHT, EDGE_OPACITY, EDGE_OPACITY_HIGHLIGHT } from './visualization/graph-builder/graph-metrics.js';
import { GraphNodeExecHistory } from './visualization/graph-builder/graph-node-exec-history.js';
import { GraphNodeInspectorPanel } from './visualization/graph-builder/graph-node-inspector-panel.js';
import { GraphNodeLineage } from './visualization/graph-builder/graph-node-lineage.js';
import { groupMergeTargets, routeEdge, computeFanOutOffsets, computeLaneOffsets } from './visualization/graph-builder/orthogonal-edge-router.js';
import { fmtCompact, fmtWhole } from './visualization/money-format.js';
import { McConfigPanel } from './visualization/monte-carlo/mc-config-panel.js';
import { McResultsPanel } from './visualization/monte-carlo/mc-results-panel.js';
import { McRunsPanel } from './visualization/monte-carlo/mc-runs-panel.js';
import { MonteCarloController } from './visualization/monte-carlo/monte-carlo-controller.js';
import { MonteCarloPresenter } from './visualization/monte-carlo/monte-carlo-presenter.js';
import { MonteCarloView } from './visualization/monte-carlo/monte-carlo-view.js';
import { OptConfigPanel } from './visualization/optimization/opt-config-panel.js';
import { OptResultsPanel } from './visualization/optimization/opt-results-panel.js';
import { OptRunsPanel } from './visualization/optimization/opt-runs-panel.js';
import { OptimizationController } from './visualization/optimization/optimization-controller.js';
import { OptimizationPresenter } from './visualization/optimization/optimization-presenter.js';
import { OptimizationView } from './visualization/optimization/optimization-view.js';
import { PeopleController } from './visualization/people/people-controller.js';
import { PersonEditor } from './visualization/people/person-editor.js';
import { CSV_SCALAR_TYPES, paramsToCsv, csvToParamUpdates, coerceParamValue } from './visualization/scenario/param-csv.js';
import { ParamFieldLinks } from './visualization/scenario/param-field-links.js';
import { bindParamLinkedField } from './visualization/scenario/param-linked-field.js';
import { ScenarioTabController } from './visualization/scenario/scenario-tab-controller.js';
import { ScenarioTabPresenter } from './visualization/scenario/scenario-tab-presenter.js';
import { ScenarioTabView } from './visualization/scenario/scenario-tab-view.js';
import { ScenarioComparePresenter } from './visualization/scenario-compare/scenario-compare-presenter.js';
import { DashCardsComponent } from './visualization/simulation/dash-cards-component.js';
import { PlaybackProgressComponent } from './visualization/simulation/playback-progress-component.js';
import { SimulationAnimator } from './visualization/simulation/simulation-animator.js';
import { StatePanelView } from './visualization/simulation/state-panel-view.js';
import { FieldSeriesStore } from './visualization/state/field-series-store.js';
import { flattenStatePaths, typeForPath, STATE_FIELD_GROUPS, groupFor } from './visualization/state/state-paths.js';
import { readThemeColor, CHART_PALETTE } from './visualization/theme.js';
import { TimeControls } from './visualization/time-controls.js';
import { TaxDocumentModal } from './visualization/timeline/tax-document-modal.js';
import { TimelineController } from './visualization/timeline/timeline-controller.js';
import { TimelinePresenter } from './visualization/timeline/timeline-presenter.js';
import { TimelineView } from './visualization/timeline/timeline-view.js';
import { $, fmt, fmtUTC, fmtLocal } from './visualization/ui-utils.js';
import { WorkbenchComponent } from './visualization/workbench/component.js';
import { WorkbenchLayoutModel } from './visualization/workbench/layout-model.js';
import { PluginRegistry } from './visualization/workbench/plugin-registry.js';
import { PLUGIN_CATEGORIES, PLUGIN_PANES, definePlugin } from './visualization/workbench/plugin-sdk.js';
import { ScenarioPlugin, ConfigGraphPlugin, ConfigListPlugin, InspectorPlugin, TimelinePlugin, ChartPlugin, StatePanelPlugin, DashboardPlugin, McConfigPlugin, McResultsPlugin, McRunsPlugin, OptConfigPlugin, OptResultsPlugin, OptRunsPlugin, ExecHistoryPlugin, LineagePlugin, PerfPlugin, ActionDetailPlugin, JournalReportPlugin, ScenarioComparePlugin, DgConfigPlugin, DgResultsPlugin, CrossActionQueryPlugin, HoldingsPlugin, MpcCockpitPlugin, FINANCE_PLUGINS, FINANCE_DEFAULT_LAYOUT } from './visualization/workbench/plugins/finance/finance-plugin-package.js';
import { SplitPane } from './visualization/workbench/split-pane.js';
import { TabGroup } from './visualization/workbench/tab-group.js';
import { WB_EVENTS, WorkbenchRuntime } from './visualization/workbench/workbench-runtime.js';
import { WorkbenchShell } from './visualization/workbench/workbench-shell.js';

// =========================================================
// TOP-LEVEL EXPORTS
// =========================================================

export {
  Account,
  InvestmentAccount,
  Person,
  BaseScenario,
  Simulation
};

// =========================================================
// NAMESPACES
// =========================================================

export const Apps = {
  SimulationWorkbench,
  WorkbenchApp,
};

export const Finance = {
  AccountRulesEngine,
  AuAccountModule2024,
  AuAccountModule2025,
  AuAccountModule2026,
  AuDividendFrankedResidentApplyReducer,
  AuDividendFrankedNonResidentApplyReducer,
  AuDividendUnfrankedResidentApplyReducer,
  AuDividendUnfrankedNonResidentApplyReducer,
  AuStockEarningsApplyReducer,
  AuStockWithdrawalApplyReducer,
  AuDividendFrankedResidentHandler,
  AuDividendFrankedNonResidentHandler,
  AuDividendUnfrankedResidentHandler,
  AuDividendUnfrankedNonResidentHandler,
  AuStockEarningsHandler,
  AuStockWithdrawalHandler,
  AuFixedIncomeEarningsApplyReducer,
  AuSeIncomeApplyReducer,
  AuWagesIncomeApplyReducer,
  AuSeIncomeHandler,
  AuHouseSaleApplyReducer,
  AuHouseSaleHandler,
  AuSavingsContributionApplyReducer,
  AuSavingsWithdrawalApplyReducer,
  AuSavingsEarningsApplyReducer,
  AuSavingsContributionHandler,
  AuSavingsWithdrawalHandler,
  AuSavingsEarningsHandler,
  SuperContributionApplyReducer,
  SuperWithdrawalContribApplyReducer,
  SuperWithdrawalEarningsApplyReducer,
  SuperEarningsApplyReducer,
  SuperContributionHandler,
  SuperWithdrawalContributionsHandler,
  SuperWithdrawalEarningsHandler,
  SuperEarningsDirectHandler,
  BaseAccountModule,
  resolveCashKey,
  resolveDestinationCashKey,
  resolveSaleDestinationKey,
  resolvePresentCash,
  InheritHandler,
  InheritApplyReducer,
  InheritanceNeTaxApplyReducer,
  InheritedRaDistributionHandler,
  InheritedRaDistributionApplyReducer,
  INHERITED_RA_WINDOW,
  INHERITED_RA_DISTRIBUTION_STRATEGY,
  inheritedRaStrategy,
  loanKeyForProperty,
  findLoanForProperty,
  synthesizeLoanForProperty,
  offsetBalanceForLoan,
  effectivePrincipal,
  resolveLoanRate,
  LoanPaymentHandler,
  UsLoanPaymentHandler,
  AuLoanPaymentHandler,
  LoanPaymentApplyReducer,
  UsMortgagePaymentHandler,
  UsMortgagePaymentApplyReducer,
  AuMortgagePaymentHandler,
  AuMortgagePaymentApplyReducer,
  computeRentalMonth,
  UsRentalIncomeHandler,
  UsRentalIncomeApplyReducer,
  AuRentalIncomeHandler,
  AuRentalIncomeApplyReducer,
  ScheduledEarlyWithdrawalApplyReducer,
  EarlyWithdrawalPolicyHandler,
  IraContributionApplyReducer,
  IraWithdrawalContribApplyReducer,
  IraWithdrawalEarningsApplyReducer,
  IraEarningsApplyReducer,
  IraContributionHandler,
  IraWithdrawalContributionsHandler,
  IraWithdrawalEarningsHandler,
  IraEarningsHandler,
  debitIra,
  IraRolloverWithdrawalApplyReducer,
  IraRmdApplyReducer,
  IraRolloverWithdrawalHandler,
  IraRmdHandler,
  IraAnnualRmdHandler,
  K401ContributionApplyReducer,
  K401EarningsApplyReducer,
  K401WithdrawalApplyReducer,
  K401ContributionHandler,
  K401EarningsHandler,
  K401WithdrawalHandler,
  K401RmdApplyReducer,
  K401AnnualRmdHandler,
  K401ToIraConversionApplyReducer,
  K401ToIraConversionHandler,
  RothContributionApplyReducer,
  RothWithdrawalContribApplyReducer,
  RothWithdrawalEarningsApplyReducer,
  RothEarningsApplyReducer,
  RothContributionHandler,
  RothWithdrawalContributionsHandler,
  RothWithdrawalEarningsHandler,
  RothEarningsHandler,
  RothConversionApplyReducer,
  RothConversionHandler,
  RothConversionPolicyHandler,
  RothRolloverContributionApplyReducer,
  RothRolloverEarningsApplyReducer,
  RothRolloverWithdrawalContribApplyReducer,
  RothRolloverWithdrawalEarningsApplyReducer,
  RothRolloverContributionHandler,
  RothRolloverEarningsHandler,
  RothRolloverWithdrawalContributionsHandler,
  RothRolloverWithdrawalEarningsHandler,
  UsAccountModule2024,
  UsAccountModule2025,
  UsAccountModule2026,
  FixedIncomeContributionApplyReducer,
  FixedIncomeWithdrawalApplyReducer,
  FixedIncomeEarningsApplyReducer,
  StockContributionApplyReducer,
  StockDividendApplyReducer,
  BondCouponApplyReducer,
  StockEarningsApplyReducer,
  StockWithdrawalApplyReducer,
  FixedIncomeContributionHandler,
  FixedIncomeWithdrawalHandler,
  FixedIncomeEarningsHandler,
  StockContributionHandler,
  StockDividendHandler,
  StockEarningsHandler,
  StockWithdrawalHandler,
  CollectibleSaleApplyReducer,
  CollectibleValueChangeApplyReducer,
  CollectibleSaleHandler,
  CollectibleValueChangeHandler,
  getUsEarlyWithdrawalRules,
  SsIncomeApplyReducer,
  WagesIncomeApplyReducer,
  WagesWithheldApplyReducer,
  SeIncomeUsApplyReducer,
  BonusApplyReducer,
  CompanySaleApplyReducer,
  SsIncomeHandler,
  WagesIncomeHandler,
  WagesWithheldHandler,
  SeIncomeUsHandler,
  resolveBonusEarner,
  BonusHandler,
  CompanySaleHandler,
  auMainResidenceExemptFraction,
  UsHouseSaleApplyReducer,
  UsHouseSaleHandler,
  getUniformDistributionPeriod,
  USD,
  AUD,
  ACCOUNT_TYPE,
  InsufficientFundsError,
  Account,
  CheckingAccount,
  SavingsAccount,
  LoanAccount,
  OffsetAccount,
  Asset,
  Bequest,
  Collectible,
  CompanyEquity,
  INHERITANCE_META_FIELDS,
  applyInheritanceMeta,
  serializeInheritanceMeta,
  reconcileLedgerToBalance,
  deriveEarningsBasis,
  InvestmentAccount,
  BrokerageAccount,
  RetirementAccount,
  FourOhOneKAccount,
  RothAccount,
  TraditionalIRAAccount,
  SuperannuationAccount,
  RealProperty,
  DEFAULT_LOCATION_POLICY,
  planLocatedTargets,
  AssetLocationRebalanceApplyReducer,
  BehavioralPanicSellApplyReducer,
  BEHAVIORAL_STRATEGY_REGISTRY,
  BondLadderReducer,
  materializeLadder,
  CashBucketDrawdownReducer,
  ContributionSuspensionToggleReducer,
  DownturnRothConversionReducer,
  OpportunisticRebalanceApplyReducer,
  OpportunisticRebalanceReducer,
  PanicSellReducer,
  RebalanceToTargetApplyReducer,
  ALLOCATION_LOCATION,
  TAX_ADVANTAGED_ROLES,
  TAXABLE_ROLES,
  US_TAX_ADVANTAGED_ROLES,
  countryForRole,
  roleCanHoldGold,
  ALLOCATION_SCHEDULE,
  REGIME_TARGET_PRIORITY,
  ageAsOf,
  interpolateGlidepath,
  resolveRegimeTarget,
  targetForRole,
  RebalanceToTargetReducer,
  StockHarvestApplyReducer,
  StrategicAssetLocationReducer,
  resolveSubstitute,
  TaxGainHarvestHandler,
  TaxLossHarvestHandler,
  AccountBuilder,
  PersonBuilder,
  US,
  AU,
  COUNTRY_CODES,
  currencyForCountry,
  defaultCurrencyForCountry,
  normalizeCountryCode,
  buildDecisionGraphCsv,
  DecisionPoint,
  DecisionGraph,
  DecisionGraphRegistry,
  DecisionGraphResultStorage,
  DecisionGraphRunner,
  DecisionGraphStorage,
  TAX_CLASS,
  taxClassForRole,
  defaultRateProvider,
  liquidationRateProvider,
  computeAfterTaxValue,
  computeAfterTaxNetWorth,
  computeAfterTaxNetLiquidity,
  deriveAfterTaxNetWorth,
  deriveAfterTaxNetLiquidity,
  isDrawdownAccessible,
  computeNetLiquidity,
  deriveNetLiquidity,
  computeNetWorth,
  deriveNetWorth,
  AddRegimeReducer,
  BondMaturityReducer,
  BondPriceAdjustReducer,
  EconomicRecoveryTickHandler,
  EconomicShockHandler,
  EquityReturnReducer,
  EquityReturnStepReducer,
  EquityReturnTickHandler,
  PrimeRelinkReducer,
  PropertyReturnStepReducer,
  PropertyReturnTickHandler,
  RATE_KEYS,
  RATE_KEY_META,
  RATE_KEY_CLASS_MEMBERS,
  EQUITY_SLEEVES,
  DEFAULT_EQUITY_BETA,
  PROPERTY_SLEEVES,
  DEFAULT_RE_BETA,
  DEFAULT_RE_IDIO,
  ROLE_TO_RATE_KEY,
  MEMBER_RATE_KEY_BY_ROLE,
  INTEREST_RATE_KEYS,
  CASH_PRIME_KEY_BY_RATE_KEY,
  SAVINGS_KEY_BY_COUNTRY,
  PRIME_KEY_BY_COUNTRY,
  RecoveryCurves,
  RegimeApplyReducer,
  REGIME_TAG,
  RemoveRegimeReducer,
  RevalueAssetReducer,
  YieldCurveReducer,
  YieldCurveStepReducer,
  YieldCurveTickHandler,
  countryOfRateKey,
  interpolateSpread,
  resolveYield,
  composeYieldCurve,
  shapeDelta,
  SHOCK_LIBRARY,
  SHOCK_PRESET_OPTIONS,
  CurrencyConverter,
  convertExpenseToAccount,
  fxRate,
  fxFeeIn,
  convertNetOfFee,
  grossUpForTarget,
  CurrencyPair,
  FxEngine,
  FX_PROCESS_MODELS,
  FX_PROCESS_MODEL_IDS,
  gaussianFrom,
  FxProcessReducer,
  FxRefreshReducer,
  FxService,
  FxStepApplyReducer,
  FxTickHandler,
  FxTransferApplyReducer,
  FxTransferToHandler,
  UsdAudPair,
  AssetAppreciationHandler,
  AssetAppreciateReducer,
  BondAccretionHandler,
  BondCouponScheduledHandler,
  BondSleeveCouponHandler,
  CashSleeveInterestHandler,
  ChangeResidencyHandler,
  ChangeStateResidencyHandler,
  DividendScheduledHandler,
  IntlRothEarningsHandler,
  IntlIraEarningsHandler,
  IntlK401EarningsHandler,
  IntlUsStockEarningsHandler,
  IntlAuStockEarningsHandler,
  IntlAuStockDividendHandler,
  AuSavingsInterestHandler,
  AuFixedIncomeInterestMonthlyHandler,
  FixedIncomeInterestHandler,
  SuperEarningsHandler,
  HouseRunningCostHandler,
  IntlTransferToUsHandler,
  IntlTransferToAuHandler,
  MonthlyExpensesHandler,
  MonthlySocialSecurityHandler,
  MonthlyWagesHandler,
  MortalityHandler,
  OutOfFundsHandler,
  RealPropertyRepairTickHandler,
  UsSavingsInterestMonthlyHandler,
  ALLOCATION,
  ALLOCATION_VALUES,
  COLLECTIBLE_ALLOCATIONS,
  isCollectibleAllocation,
  resolveScheduledRate,
  bootstrapHoldingSplit,
  DEFAULT_ALLOCATION_BY_ROLE,
  DEFAULT_ALLOCATION_BY_TYPE,
  resolveDefaultAllocation,
  resolveRateKey,
  HOLDING_ACTION_TYPES,
  HOLDING_ACTION_ENTRIES,
  HoldingTransactAction,
  HoldingRevalueAction,
  HoldingSetBasisAction,
  HoldingSplitAction,
  HoldingRetitleAction,
  HOLDING_ACTION_CLASSES,
  registerHoldingActionTypes,
  HOLDING_ACTIVITY_KIND,
  snapshotHoldings,
  totalSnapshot,
  buildHoldingActivity,
  HoldingTransactReducer,
  HoldingRevalueReducer,
  HoldingSetBasisReducer,
  HoldingSplitReducer,
  HoldingRetitleReducer,
  HOLDING_REDUCER_CLASSES,
  _syncBalance,
  scaleHoldings,
  rescaleHoldingsToBalance,
  distributeHoldingsCredit,
  holdingsOutOfSync,
  Holding,
  couponFederalExempt,
  couponStateExempt,
  computeHoldingsGrowth,
  computeHoldingsDividends,
  computeHoldingsCoupons,
  couponFiringFraction,
  couponFiringIndex,
  resolvePrevailingCouponRate,
  mergeCouponReinvestLots,
  computeHoldingsAccretion,
  computeHoldingsCashInterest,
  consumeHoldings,
  consumeHoldingsFifo,
  SLEEVE_ORDER,
  LOT_STRATEGY,
  purchaseTs,
  SLEEVE_ORDER_MODES,
  LOT_STRATEGIES,
  DRAWDOWN_SLEEVE_CLASSES,
  SLEEVE_WEIGHT_PREFIX,
  SLEEVE_WEIGHT_SEP,
  SLEEVE_WEIGHT_MODE,
  sleeveWeightKey,
  sleeveWeightsFromParams,
  resolveDrawdownSelection,
  withRebalanceCoupling,
  buildHoldingsComparator,
  JournalDataSource,
  JournalQueryApi,
  exportDrillReports,
  buildReportRows,
  rowsToCsv,
  generateReportCsv,
  ReportDefinition,
  ReportDefinitionRegistry,
  createReportApis,
  apiFor,
  runReport,
  JournalReportingService,
  DEFAULT_MC_VARIABLE_CONFIGS,
  CENTER_SOURCES,
  IntlRetirementMcConfig,
  computeNetWorthUsd,
  computeHouseValueUsd,
  computePathShape,
  summarizeProvenance,
  IntlRetirementMcRunner,
  CDC_2024,
  AU_2022,
  lookupLifeTable,
  get,
  set,
  rollForwardWithControls,
  recordDecisionRecord,
  readDecisionRecords,
  readDecisionRuns,
  COCKPIT_CONTROLS,
  CockpitController,
  DecisionRecordRegistry,
  DecisionRecordStorage,
  applyHarvestPlan,
  paramKeyOf,
  readParamValue,
  upsertParam,
  inferParamType,
  withIncluded,
  foldHarvestPlan,
  feasibilityOfResult,
  checkHarvestFeasibility,
  describeFeasibility,
  resolveStaticLevers,
  foldScheduleBakes,
  mergeResolved,
  HARVEST_FORMS,
  COLLAPSE_RULES,
  requiresIncludes,
  isIncludesRequirement,
  requirementSatisfied,
  harvestDecisions,
  pointHarvest,
  collapseConsecutive,
  ageAt,
  resolveBirthDate,
  _internals,
  runMpc,
  makeInitialSnapshot,
  replayDecisions,
  DEFAULT_OPTIMIZATION_CONFIGS,
  buildOptVariables,
  IntlRetirementOptimizer,
  valuesForConfig,
  cartesianProduct,
  OPT_PARAM_TYPES,
  DEFAULT_TERMINAL_WEALTH_PENALTY,
  DEFAULT_DEFICIT_PENALTY,
  windowedDeficit,
  infeasibilityOf,
  isFeasibleResult,
  INFEASIBLE_OFFSET,
  DIE_WITH_TARGET_FAMILY,
  DIE_WITH_TARGET_AXES,
  resolveTerminalKey,
  terminalAxesFor,
  OPTIMIZATION_OBJECTIVES,
  OBJECTIVE_FAMILY_LABELS,
  objectivePrimaryMetric,
  objectiveIsWindowable,
  resolveDieWithTargetKey,
  groupedObjectiveOptions,
  OptimizationProblem,
  initProblem,
  runTask,
  runSeriesTask,
  rolloutContext,
  browserRolloutSpawn,
  RolloutWorkerPool,
  rolloutProfiler,
  CemSolver,
  GridSearchSolver,
  PatternSearchSolver,
  qpPolish,
  QpPolishSolver,
  RandomSolver,
  SimulatedAnnealingSolver,
  SOLVER_REGISTRY,
  createSolver,
  makeSeededRng,
  EvalLedger,
  ownershipFractions,
  splitByOwnership,
  resolveAttributionAsset,
  resolveAttributionFractions,
  accumulateByOwnership,
  isParamVisible,
  visibleWhenControllers,
  controllableVariables,
  scenarioParamValues,
  paramSchemaDefaults,
  indexParamSchema,
  resolveSweepVariables,
  buildMonthPeriod,
  buildUsCalendarYear,
  buildAuFiscalYear,
  applyTo,
  Period,
  PeriodRelationship,
  PeriodService,
  Person,
  AccountRetitleApplyReducer,
  AccumulateConsumptionReducer,
  AccumulateConsumptionUtilityReducer,
  AccumulateDeficitReducer,
  AccumulateTaxesPaidReducer,
  BondAccretionApplyReducer,
  BondCouponCashApplyReducer,
  BondSleeveCouponApplyReducer,
  CashSleeveInterestApplyReducer,
  ChangeResidencyApplyReducer,
  ChangeStateResidencyApplyReducer,
  ExpenseDebitReducer,
  HouseRepairApplyReducer,
  InflationAdjustReducer,
  IntlTransferApplyReducer,
  IntlTransferRecordReducer,
  OutOfFundsReducer,
  PersonDiedApplyReducer,
  ReplenishSavingsReducer,
  ScenarioCompleteReducer,
  SetOutOfFundsDateReducer,
  SocialSecuritySurvivorApplyReducer,
  StockDividendCashApplyReducer,
  SuperDeathBenefitApplyReducer,
  UsSavingsInterestCreditReducer,
  getResidency,
  isResident,
  residentsOf,
  primaryPersonKey,
  primaryResidencyState,
  getBirthDate,
  ScenarioCompareRunner,
  flattenNumericState,
  computeStateDiff,
  journalPairKey,
  mergeEntryFieldRows,
  pairEntriesWithinDay,
  firstDivergenceDate,
  runningNetWorthSeries,
  buildJournalOverlay,
  AccountService,
  AssetService,
  promotedRetirementMeta,
  inheritedAssetMeta,
  BequestService,
  CollectibleService,
  CompanyEquityService,
  PersonService,
  RealPropertyService,
  StateRegistry,
  ParameterValueType,
  StateSchemaRegistry,
  ageBandStartAge,
  ageSpendingFactor,
  computeGuardrailPortfolioValue,
  SpendingStrategyApplyReducer,
  SPENDING_STRATEGY_REGISTRY,
  DEFAULT_AGE_BANDS,
  AgeBandedSpendingReducer,
  DEFAULT_EXPENSE_BANDS,
  pinExpensesForBand,
  repinExpensesIfChanged,
  ExplicitBandsSpendingReducer,
  GuardrailAdjustApplyReducer,
  GuardrailAnnualCheckReducer,
  GuardrailBaselineApplyReducer,
  HealthcareEventHandler,
  HealthcareExpenseApplyReducer,
  LateLifeCareApplyReducer,
  LateLifeCareHandler,
  RegimeAwareSpendingReducer,
  RetirementDateHandler,
  ACCOUNT_ROLES,
  INHERITED_RETIREMENT_ROLES,
  InternationalRetirementFinancialState,
  StateTaxService,
  AuTaxDocument2024,
  AuTaxDocument2025,
  AuTaxDocument2026,
  AuTaxDocument2027,
  AuTaxModule2024,
  AuTaxModule2025,
  AuTaxModule2026,
  AuTaxModule2027,
  AuTaxRates2024,
  AuTaxRates2025,
  AuTaxRates2026,
  AuTaxRates2027,
  AuTaxRatesBase,
  SUPER_TAX_RATE,
  superEarningsTaxRate,
  BaseTaxDocumentModule,
  BaseTaxModule,
  BaseTaxRatesModule,
  applyBracketsDetailed,
  applyBrackets,
  marginalBracketRate,
  subtractBands,
  flatRateBand,
  DynamicTaxReducer,
  InflationAdjustedUsTaxRates,
  InflationAdjustedAuTaxRates,
  UsPeriodAdvanceReducer,
  AuPeriodAdvanceReducer,
  UsPeriodAdvanceHandler,
  AuPeriodAdvanceHandler,
  RESIDENCY_COST_BASE_STEP_UP,
  stepsUpCostBaseOnResidency,
  BaseStateTaxRatesModule,
  HiStateTaxRates2024,
  HiStateTaxRates2025,
  HiStateTaxRates2026,
  HiStateTaxRates2027,
  HiStateTaxRates2028,
  HiStateTaxRates2029,
  HiStateTaxRates2030,
  HiStateTaxRates2031,
  NeStateTaxRates2024,
  NeStateTaxRates2025,
  SdStateTaxRates2024,
  STATE_INCOME_ROUTING,
  STATE_YTD_FIELDS,
  StateIncomeClassificationReducer,
  buildStateClassificationReducers,
  StateTaxDocumentReporter,
  StateTaxSettleHandler,
  StateTaxSettleApplyReducer,
  StateTaxPaymentDebitReducer,
  StateTaxSettleService,
  TaxDocumentRegistry,
  TaxEngine,
  toCcy,
  toUSD,
  toAUD,
  TAX_FX_PAIR,
  taxFxRate,
  UsTaxSettleHandler,
  AuTaxSettleHandler,
  UsTaxSettleApplyReducer,
  AuTaxSettleApplyReducer,
  UsTaxPaymentDebitReducer,
  AuTaxPaymentDebitReducer,
  TAX_SETTLE_ACTION_TYPES,
  settleActionTypeFor,
  isTaxSettleEntry,
  primaryTaxSettleEntries,
  WORKSHEET_COLUMNS,
  buildTaxWorksheetRows,
  worksheetRowsFromDocuments,
  verifyWorksheetRows,
  toCsv,
  taxYearLabel,
  auFyLabel,
  UsTaxDocument2024,
  UsTaxDocument2025,
  UsTaxDocument2026,
  UsTaxModule2024,
  UsTaxModule2025,
  UsTaxModule2026,
  UsTaxRates2024,
  UsTaxRates2025,
  UsTaxRates2026,
  UsTaxRatesBase,
  _drawDownBasket,
  TaxService,
  TaxSettleService,
  US_BRACKET_BASE_YEAR,
  usRatesForYear,
  usBracketGrossIncomeCeiling,
};

export const Engine = {
  EDGE_TYPES,
  createEdgeId,
  Edge,
  GraphQueryApi,
  Graph,
  SimGraphNode,
  QueryApi,
  ACTION_TEMPLATES,
  DEFAULT_ACTIONS,
  Action,
  FieldAction,
  FieldValueAction,
  AmountAction,
  RecordBalanceAction,
  RecordMetricAction,
  ScriptedAction,
  ACTION_CLASSES,
  generateActionId,
  ActionDefinition,
  ActionBuilder,
  EventBuilder,
  HandlerBuilder,
  ReducerBuilder,
  EXECUTION_KINDS,
  EXECUTION_PHASES,
  SIMULATION_BUS_MESSAGES,
  BusMessage,
  SimulationBusMessage,
  ExecutionBusMessage,
  BreakpointHitMessage,
  ServiceActionEvent,
  ServiceBulkActionEvent,
  ServiceEdgeActionEvent,
  DateUtils,
  DerivedMetricsRegistry,
  ConstantDistribution,
  UniformDistribution,
  NormalDistribution,
  LogNormalDistribution,
  BernoulliDistribution,
  UniformDateDistribution,
  ActuarialLifespanDistribution,
  DISTRIBUTION_TYPES,
  createDistribution,
  EventBus,
  BaseEvent,
  EventSeries,
  OneOffEvent,
  EXECUTION_EDGE_TYPES,
  ExecutionGraph,
  buildExecutionId,
  parentIdOf,
  nodeIdOf,
  executionIndexOf,
  GraphRecorder,
  HandlerEntry,
  HANDLER_CLASSES,
  HandlerRegistry,
  IndexedMinHeap,
  JournalEntry,
  Journal,
  MinHeap,
  ReducerPipeline,
  PRIORITY,
  Reducer,
  NoOpReducer,
  FieldReducer,
  MetricReducer,
  BalanceSnapshotReducer,
  FieldValueReducer,
  ArrayReducer,
  NumericSumReducer,
  MultiplicativeReducer,
  AccountTransactionReducer,
  REDUCER_CLASSES,
  RepeatingReducer,
  ScriptedReducer,
  AccountServiceReducer,
  ScenarioRunner,
  intervalFns,
  startSnapFns,
  SimulationAdapter,
  SimulationHistory,
  SimulationState,
  BreakpointSignal,
  SimulationHorizonError,
  TELEMETRY_LEVELS,
  Simulation,
  deepClone,
  snapshotForDiff,
  MutationTracker,
  diffStates,
  ValueType,
  TypeRegistry,
  InMemoryStorage,
};

export const Scenarios = {
  BaseScenario,
  BlankScenario,
  DRAWDOWN_STRATEGIES,
  DRAWDOWN_ROLES,
  DRAWDOWN_WEIGHT_MODE,
  DRAWDOWN_WEIGHT_PREFIX,
  DRAWDOWN_WEIGHT_SEP,
  drawdownWeightKey,
  DRAWDOWN_WEIGHT_ROLES,
  DRAWDOWN_CASH_ROLES,
  DRAWDOWN_ROLE_LABELS,
  presentDrawdownWeightRoles,
  drawdownWeightsFromStrategy,
  DEFAULT_DRAWDOWN_WEIGHTS,
  buildDrawdownWeightSchema,
  DEFAULT_DRAWDOWN_WEIGHT_PARAMS,
  DEFAULT_SLEEVE_WEIGHTS,
  buildSleeveWeightSchema,
  DEFAULT_SLEEVE_WEIGHT_PARAMS,
  ALLOCATION_OPTIMIZED_MODE,
  ALLOC_WEIGHT_CLASSES,
  ALLOC_WEIGHT_PREFIX,
  ALLOC_WEIGHT_SEP,
  allocWeightKey,
  ALLOC_WEIGHT_CLASS_LABELS,
  ALLOCATION_PRESETS,
  DEFAULT_ALLOC_WEIGHTS,
  synthesizeTargetAllocation,
  allocWeightsFromMix,
  allocWeightsFromPreset,
  presentAllocations,
  buildAllocWeightSchema,
  DEFAULT_ALLOC_WEIGHT_PARAMS,
  INTL_RETIREMENT_DEFAULTS,
  INTL_RETIREMENT_PARAM_SCHEMA,
  INTL_RETIREMENT_PARAM_ALIASES,
  resolveBalanceCenters,
  IntlRetirementScenario,
  applyRealPropertySaleYearParams,
  BALANCE_TARGET,
  ACCOUNT_PARAM_TEMPLATES,
  PERSON_PARAM_TEMPLATE,
  REAL_PROPERTY_PARAM_TEMPLATE,
  COLLECTIBLE_PARAM_TEMPLATE,
  COMPANY_EQUITY_PARAM_TEMPLATE,
  BEQUEST_PARAM_TEMPLATE,
  INHERITED_RA_PARAM_TEMPLATE,
  GENERATED_KEY_PREFIXES,
  isGeneratedParamKey,
  decodeGeneratedParamKey,
  ScenarioParamGenerator,
  synthesizeWeightedPriorities,
  ScenarioLoader,
  ScenarioRegistry,
  ScenarioSerializer,
  ScenarioStorage,
  AU_BANKING,
  AU_BROKERAGE,
  AU_INCOME,
  AU_REAL_PROPERTY,
  AU_RETIREMENT,
  AU_TAX,
  resolvePropertyRateKey,
  ECONOMIC_REGIMES,
  INHERITANCE,
  ScenarioCompiler,
  ToolsetRegistry,
  US_AU_CROSS_BORDER,
  US_BANKING,
  US_BROKERAGE,
  US_COLLECTIBLES,
  US_COMPANY_SALE,
  retargetEarlyWithdrawalEvents,
  US_EARLY_WITHDRAWAL,
  US_INCOME,
  US_REAL_PROPERTY,
  US_RETIREMENT,
  BRACKET_BASE_YEAR,
  retargetRothConversionEvents,
  US_ROTH_CONVERSION,
  US_STATE_TAX,
  US_TAX,
};

export const Services = {
  ActionService,
  BaseService,
  EVENT_CLASSES,
  EventService,
  HandlerService,
  ReducerService,
  ScenarioService,
  ServiceRegistry,
  SimulationRegistry,
  SimulationSync,
};

export const Visualization = {
  AccountEditor,
  AccountsController,
  APP_EVENTS,
  AppDisplaySettings,
  BequestEditor,
  CollectibleEditor,
  CompanyEquityEditor,
  RealPropertyEditor,
  ChartController,
  ChartPresenter,
  ChartView,
  ActionDefinitionList,
  ActionEditor,
  BaseComponent,
  BaseNodeEditor,
  EChartsGraphRenderer,
  initEChartWhenReady,
  EventEditor,
  AccountNodeRenderer,
  ActionNodeRenderer,
  BequestNodeRenderer,
  CollectibleNodeRenderer,
  CompanyEquityNodeRenderer,
  DefaultNodeRenderer,
  NodeRenderGroup,
  EventNodeRenderer,
  HandlerNodeRenderer,
  NodeRenderKit,
  NodeRendererRegistry,
  PersonNodeRenderer,
  RealPropertyNodeRenderer,
  ReducerNodeRenderer,
  GraphNodeFilterMultiSelect,
  HandlerEditor,
  MapFilterMultiSelect,
  NodeEditModal,
  ReducerEditor,
  RenderScheduler,
  ConfigurationListComponent,
  DecisionGraphPresenter,
  DgConfigPanel,
  DgResultsPanel,
  BaseGraphView,
  detectMidXObstacles,
  chooseClearMidX,
  ColumnLayout,
  ConfigGraphView,
  GraphBuilderController,
  GraphBuilderPresenter,
  GraphBuilderView,
  nodeBounds,
  nodeAnchors,
  NODE_WIDTH,
  NODE_HEIGHT,
  COLUMN_GAP,
  ROW_GAP,
  PADDING_X,
  PADDING_Y,
  BACKWARD_MARGIN,
  EDGE_SPACING,
  LANE_OFFSET,
  OBSTACLE_MARGIN,
  MERGE_OFFSET,
  ARROW_SIZE,
  ARROW_HALF,
  EDGE_COLOR,
  EDGE_COLOR_HIGHLIGHT,
  EDGE_WIDTH,
  EDGE_WIDTH_HIGHLIGHT,
  EDGE_OPACITY,
  EDGE_OPACITY_HIGHLIGHT,
  GraphNodeExecHistory,
  GraphNodeInspectorPanel,
  GraphNodeLineage,
  groupMergeTargets,
  routeEdge,
  computeFanOutOffsets,
  computeLaneOffsets,
  fmtCompact,
  fmtWhole,
  McConfigPanel,
  McResultsPanel,
  McRunsPanel,
  MonteCarloController,
  MonteCarloPresenter,
  MonteCarloView,
  OptConfigPanel,
  OptResultsPanel,
  OptRunsPanel,
  OptimizationController,
  OptimizationPresenter,
  OptimizationView,
  PeopleController,
  PersonEditor,
  CSV_SCALAR_TYPES,
  paramsToCsv,
  csvToParamUpdates,
  coerceParamValue,
  ParamFieldLinks,
  bindParamLinkedField,
  ScenarioTabController,
  ScenarioTabPresenter,
  ScenarioTabView,
  ScenarioComparePresenter,
  DashCardsComponent,
  PlaybackProgressComponent,
  SimulationAnimator,
  StatePanelView,
  FieldSeriesStore,
  flattenStatePaths,
  typeForPath,
  STATE_FIELD_GROUPS,
  groupFor,
  readThemeColor,
  CHART_PALETTE,
  TimeControls,
  TaxDocumentModal,
  TimelineController,
  TimelinePresenter,
  TimelineView,
  $,
  fmt,
  fmtUTC,
  fmtLocal,
};

export const Workbench = {
  WorkbenchComponent,
  WorkbenchLayoutModel,
  PluginRegistry,
  PLUGIN_CATEGORIES,
  PLUGIN_PANES,
  definePlugin,
  SplitPane,
  TabGroup,
  WB_EVENTS,
  WorkbenchRuntime,
  WorkbenchShell,
};

export const FinancePlugins = {
  ScenarioPlugin,
  ConfigGraphPlugin,
  ConfigListPlugin,
  InspectorPlugin,
  TimelinePlugin,
  ChartPlugin,
  StatePanelPlugin,
  DashboardPlugin,
  McConfigPlugin,
  McResultsPlugin,
  McRunsPlugin,
  OptConfigPlugin,
  OptResultsPlugin,
  OptRunsPlugin,
  ExecHistoryPlugin,
  LineagePlugin,
  PerfPlugin,
  ActionDetailPlugin,
  JournalReportPlugin,
  ScenarioComparePlugin,
  DgConfigPlugin,
  DgResultsPlugin,
  CrossActionQueryPlugin,
  HoldingsPlugin,
  MpcCockpitPlugin,
  FINANCE_PLUGINS,
  FINANCE_DEFAULT_LAYOUT,
};

// =========================================================
// DEFAULT EXPORT
// =========================================================

export default {
  Account,
  InvestmentAccount,
  Person,
  BaseScenario,
  Simulation,
  Apps,
  Finance,
  Engine,
  Scenarios,
  Services,
  Visualization,
  Workbench,
  FinancePlugins,
};
