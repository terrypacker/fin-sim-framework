/**
 * AUTO-GENERATED FILE - DO NOT EDIT
 * Run: npm run build:index
 */

import { BaseApp } from './apps/base-app.js';
import { AccountRulesEngine } from './finance/account-rules/account-rules-engine.js';
import { AuAccountModule2024 } from './finance/account-rules/au/au-account-module-2024.js';
import { AuAccountModule2025 } from './finance/account-rules/au/au-account-module-2025.js';
import { AuAccountModule2026 } from './finance/account-rules/au/au-account-module-2026.js';
import { BaseAccountModule } from './finance/account-rules/base-account-module.js';
import { UsAccountModule2024 } from './finance/account-rules/us/us-account-module-2024.js';
import { UsAccountModule2025 } from './finance/account-rules/us/us-account-module-2025.js';
import { UsAccountModule2026 } from './finance/account-rules/us/us-account-module-2026.js';
import { USD, AUD, InsufficientFundsError, Account, AccountService } from './finance/account.js';
import { AssetService } from './finance/asset-service.js';
import { Asset } from './finance/asset.js';
import { FinancialState } from './finance/financial-state.js';
import { InvestmentAccount } from './finance/investment-account.js';
import { buildMonthPeriod, buildUsCalendarYear, buildAuFiscalYear, applyTo } from './finance/period/period-builder.js';
import { Period, PeriodRelationship, PeriodService } from './finance/period/period-service.js';
import { Person, PersonService } from './finance/person.js';
import { AuTaxModule2024 } from './finance/tax/au/au-tax-module-2024.js';
import { AuTaxModule2025 } from './finance/tax/au/au-tax-module-2025.js';
import { AuTaxModule2026 } from './finance/tax/au/au-tax-module-2026.js';
import { AuTaxRates2024 } from './finance/tax/au/au-tax-rates-2024.js';
import { AuTaxRates2025 } from './finance/tax/au/au-tax-rates-2025.js';
import { AuTaxRatesBase } from './finance/tax/au/au-tax-rates-base.js';
import { BaseTaxModule } from './finance/tax/base-tax-module.js';
import { BaseTaxRatesModule } from './finance/tax/base-tax-rates-module.js';
import { TaxEngine } from './finance/tax/tax-engine.js';
import { UsTaxModule2024 } from './finance/tax/us/us-tax-module-2024.js';
import { UsTaxModule2025 } from './finance/tax/us/us-tax-module-2025.js';
import { UsTaxModule2026 } from './finance/tax/us/us-tax-module-2026.js';
import { UsTaxRates2024 } from './finance/tax/us/us-tax-rates-2024.js';
import { UsTaxRates2025 } from './finance/tax/us/us-tax-rates-2025.js';
import { UsTaxRatesBase } from './finance/tax/us/us-tax-rates-base.js';
import { TaxService } from './finance/tax-service.js';
import { TaxSettleService } from './finance/tax-settle-service.js';
import { BaseScenario } from './scenarios/base-scenario.js';
import { EventSeries } from './scenarios/event-series.js';
import { Action, AmountAction, RecordArrayMetricAction, RecordMetricAction, RecordNumericSumMetricAction, RecordMultiplicativeMetricAction, RecordBalanceAction } from './simulation-framework/actions.js';
import { BusMessage, SimulationBusMessage, DebugActionBusMessage } from './simulation-framework/bus-messages.js';
import { DateUtils } from './simulation-framework/date-utils.js';
import { EventBus } from './simulation-framework/event-bus.js';
import { HandlerEntry, HandlerRegistry } from './simulation-framework/handlers.js';
import { JournalEntry, Journal } from './simulation-framework/journal.js';
import { MinHeap } from './simulation-framework/min-heap.js';
import { ReducerPipeline, PRIORITY, Reducer, NoOpReducer, ArrayMetricReducer, NumericSumMetricReducer, MultiplicativeMetricReducer, MetricReducer, AccountTransactionReducer } from './simulation-framework/reducers.js';
import { ScenarioRunner } from './simulation-framework/scenario.js';
import { ActionNode, SimulationEventGraph } from './simulation-framework/simulation-event-graph.js';
import { SimulationHistory } from './simulation-framework/simulation-history.js';
import { SimulationState } from './simulation-framework/simulation-state.js';
import { Simulation } from './simulation-framework/simulation.js';
import { BalanceChartView } from './visualization/balance-chart-view.js';
import { GraphView } from './visualization/graph-view.js';
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
};

export const Finance = {
  AccountRulesEngine,
  AuAccountModule2024,
  AuAccountModule2025,
  AuAccountModule2026,
  BaseAccountModule,
  UsAccountModule2024,
  UsAccountModule2025,
  UsAccountModule2026,
  USD,
  AUD,
  InsufficientFundsError,
  Account,
  AccountService,
  AssetService,
  Asset,
  FinancialState,
  InvestmentAccount,
  buildMonthPeriod,
  buildUsCalendarYear,
  buildAuFiscalYear,
  applyTo,
  Period,
  PeriodRelationship,
  PeriodService,
  Person,
  PersonService,
  AuTaxModule2024,
  AuTaxModule2025,
  AuTaxModule2026,
  AuTaxRates2024,
  AuTaxRates2025,
  AuTaxRatesBase,
  BaseTaxModule,
  BaseTaxRatesModule,
  TaxEngine,
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
  EventSeries,
};

export const Core = {
  Action,
  AmountAction,
  RecordArrayMetricAction,
  RecordMetricAction,
  RecordNumericSumMetricAction,
  RecordMultiplicativeMetricAction,
  RecordBalanceAction,
  BusMessage,
  SimulationBusMessage,
  DebugActionBusMessage,
  DateUtils,
  EventBus,
  HandlerEntry,
  HandlerRegistry,
  JournalEntry,
  Journal,
  MinHeap,
  ReducerPipeline,
  PRIORITY,
  Reducer,
  NoOpReducer,
  ArrayMetricReducer,
  NumericSumMetricReducer,
  MultiplicativeMetricReducer,
  MetricReducer,
  AccountTransactionReducer,
  ScenarioRunner,
  ActionNode,
  SimulationEventGraph,
  SimulationHistory,
  SimulationState,
  Simulation,
};

export const Visualization = {
  BalanceChartView,
  GraphView,
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
  Core,
  Visualization,
};
