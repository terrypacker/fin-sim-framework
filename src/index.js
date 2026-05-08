/**
 * AUTO-GENERATED FILE - DO NOT EDIT
 * Run: npm run build:index
 */

import { BaseApp } from './apps/base-app.js';
import { ScenarioTabPresenter } from './apps/scenario-tab-presenter.js';
import { SimulationAnimator } from './apps/simulation-animator.js';
import { SimulationWorkbench } from './apps/simulation-workbench.js';
import { StatePanelView } from './apps/state-panel-view.js';
import { AccountRulesEngine } from './finance/account-rules/account-rules-engine.js';
import { AuAccountModule2024 } from './finance/account-rules/au/au-account-module-2024.js';
import { AuAccountModule2025 } from './finance/account-rules/au/au-account-module-2025.js';
import { AuAccountModule2026 } from './finance/account-rules/au/au-account-module-2026.js';
import { AuDividendFrankedResidentApplyReducer, AuDividendFrankedNonResidentApplyReducer, AuDividendUnfrankedResidentApplyReducer, AuDividendUnfrankedNonResidentApplyReducer, AuStockEarningsApplyReducer, AuStockWithdrawalApplyReducer, AuDividendFrankedResidentHandler, AuDividendFrankedNonResidentHandler, AuDividendUnfrankedResidentHandler, AuDividendUnfrankedNonResidentHandler, AuStockEarningsHandler, AuStockWithdrawalHandler } from './finance/account-rules/au/au-brokerage-classes.js';
import { AuHouseSaleApplyReducer, AuHouseSaleHandler } from './finance/account-rules/au/au-real-property-classes.js';
import { AuSavingsContributionApplyReducer, AuSavingsWithdrawalApplyReducer, AuSavingsEarningsApplyReducer, AuSavingsContributionHandler, AuSavingsWithdrawalHandler, AuSavingsEarningsHandler } from './finance/account-rules/au/au-savings-classes.js';
import { SuperContributionApplyReducer, SuperWithdrawalContribApplyReducer, SuperWithdrawalEarningsApplyReducer, SuperEarningsApplyReducer, SuperContributionHandler, SuperWithdrawalContributionsHandler, SuperWithdrawalEarningsHandler, SuperEarningsDirectHandler } from './finance/account-rules/au/au-super-classes.js';
import { BaseAccountModule } from './finance/account-rules/base-account-module.js';
import { IraContributionApplyReducer, IraWithdrawalContribApplyReducer, IraWithdrawalEarningsApplyReducer, IraEarningsApplyReducer, IraContributionHandler, IraWithdrawalContributionsHandler, IraWithdrawalEarningsHandler, IraEarningsHandler } from './finance/account-rules/us/ira-classes.js';
import { K401ContributionApplyReducer, K401EarningsApplyReducer, K401WithdrawalApplyReducer, K401ContributionHandler, K401EarningsHandler, K401WithdrawalHandler } from './finance/account-rules/us/k401-classes.js';
import { RothContributionApplyReducer, RothWithdrawalContribApplyReducer, RothWithdrawalEarningsApplyReducer, RothEarningsApplyReducer, RothContributionHandler, RothWithdrawalContributionsHandler, RothWithdrawalEarningsHandler, RothEarningsHandler } from './finance/account-rules/us/roth-classes.js';
import { UsAccountModule2024 } from './finance/account-rules/us/us-account-module-2024.js';
import { UsAccountModule2025 } from './finance/account-rules/us/us-account-module-2025.js';
import { UsAccountModule2026 } from './finance/account-rules/us/us-account-module-2026.js';
import { FixedIncomeContributionApplyReducer, FixedIncomeWithdrawalApplyReducer, FixedIncomeEarningsApplyReducer, StockContributionApplyReducer, StockDividendApplyReducer, StockEarningsApplyReducer, StockWithdrawalApplyReducer, FixedIncomeContributionHandler, FixedIncomeWithdrawalHandler, FixedIncomeEarningsHandler, StockContributionHandler, StockDividendHandler, StockEarningsHandler, StockWithdrawalHandler } from './finance/account-rules/us/us-brokerage-classes.js';
import { UsHouseSaleApplyReducer, UsHouseSaleHandler } from './finance/account-rules/us/us-real-property-classes.js';
import { USD, AUD, ACCOUNT_TYPE, InsufficientFundsError, Account, CheckingAccount, SavingsAccount } from './finance/account.js';
import { AssetService } from './finance/asset-service.js';
import { Asset } from './finance/asset.js';
import { AccountBuilder } from './finance/builders/account-builder.js';
import { PersonBuilder } from './finance/builders/person-builder.js';
import { ChangeResidencyHandler } from './finance/handlers/change-residency-handler.js';
import { DividendScheduledHandler } from './finance/handlers/dividend-scheduled-handler.js';
import { IntlRothEarningsHandler, IntlIraEarningsHandler, IntlK401EarningsHandler, IntlUsStockEarningsHandler, IntlAuStockEarningsHandler, IntlAuStockDividendHandler, AuSavingsInterestHandler, FixedIncomeInterestHandler, SuperEarningsHandler } from './finance/handlers/earnings-handlers.js';
import { IntlTransferToUsHandler, IntlTransferToAuHandler } from './finance/handlers/intl-transfer-handlers.js';
import { MonthlyExpensesHandler } from './finance/handlers/monthly-expenses-handler.js';
import { OutOfFundsHandler } from './finance/handlers/out-of-funds-handler.js';
import { UsSavingsInterestMonthlyHandler } from './finance/handlers/us-savings-interest-handler.js';
import { InvestmentAccount, BrokerageAccount, FourOhOneKAccount, RothAccount, TraditionalIRAAccount, SuperannuationAccount } from './finance/investment-account.js';
import { buildMonthPeriod, buildUsCalendarYear, buildAuFiscalYear, applyTo } from './finance/period/period-builder.js';
import { Period, PeriodRelationship, PeriodService } from './finance/period/period-service.js';
import { Person } from './finance/person.js';
import { ChangeResidencyApplyReducer } from './finance/reducers/change-residency-apply-reducer.js';
import { ExpenseDebitReducer } from './finance/reducers/expense-debit-reducer.js';
import { IntlTransferApplyReducer } from './finance/reducers/intl-transfer-apply-reducer.js';
import { ReplenishSavingsReducer } from './finance/reducers/replenish-savings-reducer.js';
import { SetOutOfFundsDateReducer } from './finance/reducers/set-out-of-funds-date-reducer.js';
import { StockDividendCashApplyReducer } from './finance/reducers/stock-dividend-cash-apply-reducer.js';
import { UsSavingsInterestCreditReducer } from './finance/reducers/us-savings-interest-credit-reducer.js';
import { AccountService } from './finance/services/account-service.js';
import { PersonService } from './finance/services/person-service.js';
import { FinancialState } from './finance/state/financial-state.js';
import { InternationalRetirementFinancialState } from './finance/state/intl-retirement-state.js';
import { AuTaxModule2024 } from './finance/tax/au/au-tax-module-2024.js';
import { AuTaxModule2025 } from './finance/tax/au/au-tax-module-2025.js';
import { AuTaxModule2026 } from './finance/tax/au/au-tax-module-2026.js';
import { AuTaxRates2024 } from './finance/tax/au/au-tax-rates-2024.js';
import { AuTaxRates2025 } from './finance/tax/au/au-tax-rates-2025.js';
import { AuTaxRatesBase } from './finance/tax/au/au-tax-rates-base.js';
import { BaseTaxModule } from './finance/tax/base-tax-module.js';
import { BaseTaxRatesModule } from './finance/tax/base-tax-rates-module.js';
import { DynamicTaxReducer } from './finance/tax/dynamic-tax-reducer.js';
import { PeriodAdvanceReducer, PeriodAdvanceHandler } from './finance/tax/period-advance-classes.js';
import { TaxEngine } from './finance/tax/tax-engine.js';
import { TaxSettleHandler, TaxSettleApplyReducer, TaxPaymentDebitReducer } from './finance/tax/tax-settle-classes.js';
import { UsTaxModule2024 } from './finance/tax/us/us-tax-module-2024.js';
import { UsTaxModule2025 } from './finance/tax/us/us-tax-module-2025.js';
import { UsTaxModule2026 } from './finance/tax/us/us-tax-module-2026.js';
import { UsTaxRates2024 } from './finance/tax/us/us-tax-rates-2024.js';
import { UsTaxRates2025 } from './finance/tax/us/us-tax-rates-2025.js';
import { UsTaxRatesBase } from './finance/tax/us/us-tax-rates-base.js';
import { TaxService } from './finance/tax-service.js';
import { TaxSettleService } from './finance/tax-settle-service.js';
import { EDGE_TYPES, createEdgeId, Edge } from './graph/edge.js';
import { GraphQueryApi } from './graph/graph-query-api.js';
import { Graph } from './graph/graph.js';
import { SimGraphNode } from './graph/sim-graph-node.js';
import { QueryApi } from './query/query-api.js';
import { BaseScenario } from './scenarios/base-scenario.js';
import { INTL_RETIREMENT_DEFAULTS, IntlRetirementScenario } from './scenarios/intl-retirement-scenario.js';
import { PrebuiltScenario } from './scenarios/prebuilt-scenario.js';
import { ScenarioSerializer } from './scenarios/scenario-serializer.js';
import { ScenarioStorage } from './scenarios/scenario-storage.js';
import { SimulationWorkbenchDefaultScenario } from './scenarios/simulation-workbench-default-scenario.js';
import { ActionService } from './services/action-service.js';
import { BaseService } from './services/base-service.js';
import { EVENT_CLASSES, EventService } from './services/event-service.js';
import { HandlerService } from './services/handler-service.js';
import { ReducerService } from './services/reducer-service.js';
import { ServiceRegistry } from './services/service-registry.js';
import { SimulationRegistry } from './services/simulation-registry.js';
import { SimulationSync } from './services/simulation-sync.js';
import { ACTION_TEMPLATES } from './simulation-framework/action-templates.js';
import { DEFAULT_ACTIONS, Action, FieldAction, FieldValueAction, AmountAction, RecordBalanceAction, RecordMetricAction, ScriptedAction, ACTION_CLASSES, generateActionId, ActionDefinition } from './simulation-framework/actions.js';
import { ActionBuilder } from './simulation-framework/builders/action-builder.js';
import { EventBuilder } from './simulation-framework/builders/event-builder.js';
import { HandlerBuilder } from './simulation-framework/builders/handler-builder.js';
import { ReducerBuilder } from './simulation-framework/builders/reducer-builder.js';
import { SIMULATION_BUS_MESSAGES, BusMessage, SimulationBusMessage, NodeDataBusMessage, BreakpointHitBusMessage, EventStartBusMessage, EventEndBusMessage, EventHandledMessage, ActionInstanceMessage, ActionResultMessage, ReducerResultMessage, ServiceActionEvent, ServiceBulkActionEvent } from './simulation-framework/bus-messages.js';
import { DateUtils } from './simulation-framework/date-utils.js';
import { EventBus } from './simulation-framework/event-bus.js';
import { BaseEvent } from './simulation-framework/events/base-event.js';
import { EventSeries } from './simulation-framework/events/event-series.js';
import { OneOffEvent } from './simulation-framework/events/one-off-event.js';
import { HandlerEntry, HANDLER_CLASSES, HandlerRegistry } from './simulation-framework/handlers.js';
import { IndexedMinHeap } from './simulation-framework/indexed-min-heap.js';
import { JournalEntry, Journal } from './simulation-framework/journal.js';
import { MinHeap } from './simulation-framework/min-heap.js';
import { ReducerPipeline, PRIORITY, Reducer, NoOpReducer, FieldReducer, MetricReducer, BalanceSnapshotReducer, FieldValueReducer, ArrayReducer, NumericSumReducer, MultiplicativeReducer, AccountTransactionReducer, REDUCER_CLASSES, RepeatingReducer, ScriptedReducer } from './simulation-framework/reducers.js';
import { ScenarioRunner } from './simulation-framework/scenario.js';
import { intervalFns, startSnapFns, SimulationAdapter } from './simulation-framework/simulation/simulation-adapter.js';
import { ActionNode, SimulationEventGraph } from './simulation-framework/simulation-event-graph.js';
import { SimulationHistory } from './simulation-framework/simulation-history.js';
import { SimulationState } from './simulation-framework/simulation-state.js';
import { BreakpointSignal, Simulation } from './simulation-framework/simulation.js';
import { diffStates } from './simulation-framework/state-utils.js';
import { AccountsController } from './visualization/accounts/accounts-controller.js';
import { AccountsPresenter } from './visualization/accounts/accounts-presenter.js';
import { AccountsView } from './visualization/accounts/accounts-view.js';
import { BalanceChartView } from './visualization/balance-chart-view.js';
import { ChartView } from './visualization/chart-view.js';
import { BaseComponent } from './visualization/components/base-component.js';
import { GraphNodeFilterMultiSelect } from './visualization/components/graph-node-filter-multi-select.js';
import { GraphRenderer } from './visualization/components/graph-renderer.js';
import { ConfigGraph } from './visualization/config-graph.js';
import { GraphBuilderController } from './visualization/graph-builder/graph-builder-controller.js';
import { GraphBuilderPresenter } from './visualization/graph-builder/graph-builder-presenter.js';
import { GraphBuilderView } from './visualization/graph-builder/graph-builder-view.js';
import { GraphSync } from './visualization/graph-sync.js';
import { GraphView } from './visualization/graph-view.js';
import { PeopleController } from './visualization/people/people-controller.js';
import { PeoplePresenter } from './visualization/people/people-presenter.js';
import { PeopleView } from './visualization/people/people-view.js';
import { TimeControls } from './visualization/time-controls.js';
import { TimelineView } from './visualization/timeline-view.js';
import { $, fmt, fmtUTC, fmtLocal } from './visualization/ui-utils.js';

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

export const Misc = {
  BaseApp,
  ScenarioTabPresenter,
  SimulationAnimator,
  SimulationWorkbench,
  StatePanelView,
  EDGE_TYPES,
  createEdgeId,
  Edge,
  GraphQueryApi,
  Graph,
  SimGraphNode,
  QueryApi,
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
  IraContributionApplyReducer,
  IraWithdrawalContribApplyReducer,
  IraWithdrawalEarningsApplyReducer,
  IraEarningsApplyReducer,
  IraContributionHandler,
  IraWithdrawalContributionsHandler,
  IraWithdrawalEarningsHandler,
  IraEarningsHandler,
  K401ContributionApplyReducer,
  K401EarningsApplyReducer,
  K401WithdrawalApplyReducer,
  K401ContributionHandler,
  K401EarningsHandler,
  K401WithdrawalHandler,
  RothContributionApplyReducer,
  RothWithdrawalContribApplyReducer,
  RothWithdrawalEarningsApplyReducer,
  RothEarningsApplyReducer,
  RothContributionHandler,
  RothWithdrawalContributionsHandler,
  RothWithdrawalEarningsHandler,
  RothEarningsHandler,
  UsAccountModule2024,
  UsAccountModule2025,
  UsAccountModule2026,
  FixedIncomeContributionApplyReducer,
  FixedIncomeWithdrawalApplyReducer,
  FixedIncomeEarningsApplyReducer,
  StockContributionApplyReducer,
  StockDividendApplyReducer,
  StockEarningsApplyReducer,
  StockWithdrawalApplyReducer,
  FixedIncomeContributionHandler,
  FixedIncomeWithdrawalHandler,
  FixedIncomeEarningsHandler,
  StockContributionHandler,
  StockDividendHandler,
  StockEarningsHandler,
  StockWithdrawalHandler,
  UsHouseSaleApplyReducer,
  UsHouseSaleHandler,
  USD,
  AUD,
  ACCOUNT_TYPE,
  InsufficientFundsError,
  Account,
  CheckingAccount,
  SavingsAccount,
  AssetService,
  Asset,
  AccountBuilder,
  PersonBuilder,
  ChangeResidencyHandler,
  DividendScheduledHandler,
  IntlRothEarningsHandler,
  IntlIraEarningsHandler,
  IntlK401EarningsHandler,
  IntlUsStockEarningsHandler,
  IntlAuStockEarningsHandler,
  IntlAuStockDividendHandler,
  AuSavingsInterestHandler,
  FixedIncomeInterestHandler,
  SuperEarningsHandler,
  IntlTransferToUsHandler,
  IntlTransferToAuHandler,
  MonthlyExpensesHandler,
  OutOfFundsHandler,
  UsSavingsInterestMonthlyHandler,
  InvestmentAccount,
  BrokerageAccount,
  FourOhOneKAccount,
  RothAccount,
  TraditionalIRAAccount,
  SuperannuationAccount,
  buildMonthPeriod,
  buildUsCalendarYear,
  buildAuFiscalYear,
  applyTo,
  Period,
  PeriodRelationship,
  PeriodService,
  Person,
  ChangeResidencyApplyReducer,
  ExpenseDebitReducer,
  IntlTransferApplyReducer,
  ReplenishSavingsReducer,
  SetOutOfFundsDateReducer,
  StockDividendCashApplyReducer,
  UsSavingsInterestCreditReducer,
  AccountService,
  PersonService,
  FinancialState,
  InternationalRetirementFinancialState,
  AuTaxModule2024,
  AuTaxModule2025,
  AuTaxModule2026,
  AuTaxRates2024,
  AuTaxRates2025,
  AuTaxRatesBase,
  BaseTaxModule,
  BaseTaxRatesModule,
  DynamicTaxReducer,
  PeriodAdvanceReducer,
  PeriodAdvanceHandler,
  TaxEngine,
  TaxSettleHandler,
  TaxSettleApplyReducer,
  TaxPaymentDebitReducer,
  UsTaxModule2024,
  UsTaxModule2025,
  UsTaxModule2026,
  UsTaxRates2024,
  UsTaxRates2025,
  UsTaxRatesBase,
  TaxService,
  TaxSettleService,
};

export const Scenarios = {
  BaseScenario,
  INTL_RETIREMENT_DEFAULTS,
  IntlRetirementScenario,
  PrebuiltScenario,
  ScenarioSerializer,
  ScenarioStorage,
  SimulationWorkbenchDefaultScenario,
};

export const Services = {
  ActionService,
  BaseService,
  EVENT_CLASSES,
  EventService,
  HandlerService,
  ReducerService,
  ServiceRegistry,
  SimulationRegistry,
  SimulationSync,
};

export const Core = {
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
  SIMULATION_BUS_MESSAGES,
  BusMessage,
  SimulationBusMessage,
  NodeDataBusMessage,
  BreakpointHitBusMessage,
  EventStartBusMessage,
  EventEndBusMessage,
  EventHandledMessage,
  ActionInstanceMessage,
  ActionResultMessage,
  ReducerResultMessage,
  ServiceActionEvent,
  ServiceBulkActionEvent,
  DateUtils,
  EventBus,
  BaseEvent,
  EventSeries,
  OneOffEvent,
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
  ScenarioRunner,
  intervalFns,
  startSnapFns,
  SimulationAdapter,
  ActionNode,
  SimulationEventGraph,
  SimulationHistory,
  SimulationState,
  BreakpointSignal,
  Simulation,
  diffStates,
};

export const Visualization = {
  AccountsController,
  AccountsPresenter,
  AccountsView,
  BalanceChartView,
  ChartView,
  BaseComponent,
  GraphNodeFilterMultiSelect,
  GraphRenderer,
  ConfigGraph,
  GraphBuilderController,
  GraphBuilderPresenter,
  GraphBuilderView,
  GraphSync,
  GraphView,
  PeopleController,
  PeoplePresenter,
  PeopleView,
  TimeControls,
  TimelineView,
  $,
  fmt,
  fmtUTC,
  fmtLocal,
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
  Misc,
  Finance,
  Scenarios,
  Services,
  Core,
  Visualization,
};
