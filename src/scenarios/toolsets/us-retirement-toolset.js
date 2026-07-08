/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { EventBuilder }         from '../../simulation-framework/builders/event-builder.js';
import { ReducerBuilder }       from '../../simulation-framework/builders/reducer-builder.js';
import { OneOffEvent }          from '../../simulation-framework/events/one-off-event.js';
import { ACCOUNT_ROLES }        from '../../finance/state/account-roles.js';
import { MonthlyExpensesHandler }       from '../../finance/handlers/monthly-expenses-handler.js';
import { MonthlyWagesHandler }          from '../../finance/handlers/monthly-wages-handler.js';
import { MonthlySocialSecurityHandler } from '../../finance/handlers/monthly-social-security-handler.js';
import { DividendScheduledHandler }     from '../../finance/handlers/dividend-scheduled-handler.js';
import {
  FixedIncomeInterestHandler,
  IntlIraEarningsHandler, IntlRothEarningsHandler, IntlK401EarningsHandler,
  IntlUsStockEarningsHandler,
} from '../../finance/handlers/earnings-handlers.js';
import { OutOfFundsHandler }            from '../../finance/handlers/out-of-funds-handler.js';
import { RetirementDateHandler }        from '../../finance/spending/strategies/retirement-date-handler.js';
import { HealthcareEventHandler }       from '../../finance/spending/strategies/healthcare-event-handler.js';
import { ExpenseDebitReducer }          from '../../finance/reducers/expense-debit-reducer.js';
import { ReplenishSavingsReducer }      from '../../finance/reducers/replenish-savings-reducer.js';
import { StockDividendCashApplyReducer }    from '../../finance/reducers/stock-dividend-cash-apply-reducer.js';
import { SetOutOfFundsDateReducer }     from '../../finance/reducers/set-out-of-funds-date-reducer.js';
import { AccumulateDeficitReducer }     from '../../finance/reducers/accumulate-deficit-reducer.js';
import { AccumulateTaxesPaidReducer }   from '../../finance/reducers/accumulate-taxes-paid-reducer.js';
import { AccumulateConsumptionReducer } from '../../finance/reducers/accumulate-consumption-reducer.js';
import { AccumulateConsumptionUtilityReducer } from '../../finance/reducers/accumulate-consumption-utility-reducer.js';
import { OutOfFundsReducer }            from '../../finance/reducers/out-of-funds-reducer.js';
import { InflationAdjustReducer }           from '../../finance/reducers/inflation-adjust-reducer.js';
import { SpendingStrategyApplyReducer }     from '../../finance/spending/spending-strategy-apply-reducer.js';
import { SPENDING_STRATEGY_REGISTRY }       from '../../finance/spending/spending-strategy-registry.js';
import {
  RothContributionApplyReducer, RothWithdrawalContribApplyReducer,
  RothWithdrawalEarningsApplyReducer, RothEarningsApplyReducer,
  RothContributionHandler, RothWithdrawalContributionsHandler,
  RothWithdrawalEarningsHandler, RothEarningsHandler,
} from '../../finance/account-rules/us/roth-classes.js';
import {
  IraContributionApplyReducer, IraWithdrawalContribApplyReducer,
  IraWithdrawalEarningsApplyReducer, IraEarningsApplyReducer,
  IraContributionHandler, IraWithdrawalContributionsHandler,
  IraWithdrawalEarningsHandler, IraEarningsHandler,
} from '../../finance/account-rules/us/ira-classes.js';
import {
  K401ContributionApplyReducer, K401EarningsApplyReducer, K401WithdrawalApplyReducer,
  K401ContributionHandler, K401EarningsHandler, K401WithdrawalHandler,
  K401RmdApplyReducer, K401AnnualRmdHandler,
  K401ToIraConversionHandler, K401ToIraConversionApplyReducer,
} from '../../finance/account-rules/us/k401-classes.js';
import {
  IraRolloverWithdrawalApplyReducer, IraRmdApplyReducer,
  IraRolloverWithdrawalHandler, IraRmdHandler, IraAnnualRmdHandler,
} from '../../finance/account-rules/us/ira-rollover-classes.js';
import { ValueType } from '../../simulation-framework/type-registry.js';
import { TaxService } from '../../finance/tax-service.js';
import { MortalityHandler }                      from '../../finance/handlers/mortality-handler.js';
import { PersonDiedApplyReducer }                from '../../finance/reducers/person-died-apply-reducer.js';
import { SocialSecuritySurvivorApplyReducer }    from '../../finance/reducers/social-security-survivor-apply-reducer.js';
import { AccountRetitleApplyReducer }            from '../../finance/reducers/account-retitle-apply-reducer.js';
import { ScenarioCompleteReducer }               from '../../finance/reducers/scenario-complete-reducer.js';
import { LateLifeCareHandler }                  from '../../finance/spending/strategies/late-life-care-handler.js';
import { LateLifeCareApplyReducer }             from '../../finance/spending/strategies/late-life-care-apply-reducer.js';
import {
  RothRolloverContributionApplyReducer, RothRolloverEarningsApplyReducer,
  RothRolloverWithdrawalContribApplyReducer, RothRolloverWithdrawalEarningsApplyReducer,
  RothRolloverContributionHandler, RothRolloverEarningsHandler,
  RothRolloverWithdrawalContributionsHandler, RothRolloverWithdrawalEarningsHandler,
} from '../../finance/account-rules/us/roth-rollover-classes.js';

function _accountToStatePlain(account) {
  const plain = {
    balance:               account.balance,
    stateKey:              account.stateKey,
    type:                  account.type                  ?? null,
    country:               account.country               ?? null,
    currency:              account.currency              ?? null,
    role:                  account.role                  ?? null,
    ownerId:               account.ownerId               ?? null,
    minimumBalance:        account.minimumBalance        ?? 0,
    drawdownPriority:      account.drawdownPriority      ?? null,
    allowsEarlyWithdrawal: account.allowsEarlyWithdrawal ?? false,
    // Holdings — plain-data array (no methods), structuredClone-safe.
    holdings:              (account.holdings ?? []).map(h => ({ ...h })),
  };
  // OffsetAccount link (design 53 §3 / 54 P3): carry the property key into runtime
  // state so offsetBalanceForLoan() can find it — otherwise the offset is invisible.
  if (account.offsetsPropertyKey !== undefined) {
    plain.offsetsPropertyKey = account.offsetsPropertyKey ?? null;
  }
  if (account.contributionBasis !== undefined) {
    plain.contributionBasis        = account.contributionBasis;
    plain.earningsBasis            = account.earningsBasis ?? 0;
    plain.loanBalance              = account.loanBalance   ?? 0;
    plain.minimumAge               = account.minimumAge    ?? null;
    plain.balanceAtResidencyChange = account.balanceAtResidencyChange ?? null;
    // Per-country residency cost-base step-up (design 36 §12.2); null until a move.
    plain.costBaseStepUpByCountry  = account.costBaseStepUpByCountry ?? null;
    if (account.rolloverContribBasis  !== undefined) plain.rolloverContribBasis  = account.rolloverContribBasis;
    if (account.rolloverEarningsBasis !== undefined) plain.rolloverEarningsBasis = account.rolloverEarningsBasis;
    // Dated conversion lots backing the §408A(d)(3)(F) 5-year recapture (EVT-43).
    if (account.rolloverContribBasis  !== undefined) plain.rolloverConversions   = (account.rolloverConversions ?? []).map(l => ({ ...l }));
  }
  return plain;
}

/**
 * US_RETIREMENT toolset — declarative shape for ScenarioCompiler.
 *
 * Capabilities: retirement
 * Depends on: US_BANKING, US_TAX (pulled in automatically by the dependency graph)
 *
 * State ownership:
 *   Initializes: people (with residency), monthlyExpenses, inflationRates,
 *                inflationAccumulator, metrics, people, per-account state entries
 *   Reads: us* keys from US_TAX; US_SAVINGS_INTEREST_MONTHLY from US_BANKING
 */
export const US_RETIREMENT = {
  id: 'US_RETIREMENT',
  capabilities: ['retirement'],
  dependencies: ['US_BANKING', 'US_TAX', 'US_INCOME', 'US_BROKERAGE'],

  types: {
    handlers: [
      MonthlyExpensesHandler, MonthlyWagesHandler, MonthlySocialSecurityHandler,
      DividendScheduledHandler, FixedIncomeInterestHandler,
      IntlIraEarningsHandler, IntlRothEarningsHandler, IntlK401EarningsHandler, IntlUsStockEarningsHandler,
      OutOfFundsHandler,
      RothContributionHandler, RothWithdrawalContributionsHandler, RothWithdrawalEarningsHandler, RothEarningsHandler,
      RothRolloverContributionHandler, RothRolloverEarningsHandler,
      RothRolloverWithdrawalContributionsHandler, RothRolloverWithdrawalEarningsHandler,
      IraContributionHandler, IraWithdrawalContributionsHandler, IraWithdrawalEarningsHandler, IraEarningsHandler,
      IraRolloverWithdrawalHandler, IraRmdHandler, IraAnnualRmdHandler,
      K401ContributionHandler, K401EarningsHandler, K401WithdrawalHandler,
      K401AnnualRmdHandler, K401ToIraConversionHandler,
    ],
    reducers: [
      ExpenseDebitReducer, ReplenishSavingsReducer, StockDividendCashApplyReducer,
      SetOutOfFundsDateReducer, AccumulateDeficitReducer, OutOfFundsReducer, InflationAdjustReducer,
      RothContributionApplyReducer, RothWithdrawalContribApplyReducer,
      RothWithdrawalEarningsApplyReducer, RothEarningsApplyReducer,
      RothRolloverContributionApplyReducer, RothRolloverEarningsApplyReducer,
      RothRolloverWithdrawalContribApplyReducer, RothRolloverWithdrawalEarningsApplyReducer,
      IraContributionApplyReducer, IraWithdrawalContribApplyReducer,
      IraWithdrawalEarningsApplyReducer, IraEarningsApplyReducer,
      IraRolloverWithdrawalApplyReducer, IraRmdApplyReducer,
      K401ContributionApplyReducer, K401EarningsApplyReducer,
      K401WithdrawalApplyReducer, K401RmdApplyReducer, K401ToIraConversionApplyReducer,
    ],
    actions: [
      { type: 'EXPENSE_DEBIT',         fields: { amount: ValueType.number(), targetKey: ValueType.text() } },
      { type: 'REPLENISH_SAVINGS',  family: 'WITHDRAWAL', fields: { deficit: ValueType.number(), targetKey: ValueType.text() } },
      { type: 'RECORD_METRIC',         fields: { fieldName: ValueType.text(), value: ValueType.number() } },
      { type: 'SET_OUT_OF_FUNDS_DATE', fields: { date: ValueType.any() } },
      { type: 'ACCUMULATE_DEFICIT',    fields: { amount: ValueType.number() } },
      { type: 'OUT_OF_FUNDS',          fields: { deficit: ValueType.number(), currency: ValueType.text() } },
      { type: 'STOCK_DIVIDEND_CASH_APPLY',              fields: { amount: ValueType.currency('USD'), residency: ValueType.text(), stateKey: ValueType.text() } },
      { type: 'ROTH_CONTRIBUTION_APPLY',                fields: { amount: ValueType.currency('USD') } },
      { type: 'ROTH_WITHDRAWAL_CONTRIB_APPLY',  family: 'WITHDRAWAL', cc: 'US', fields: { amount: ValueType.currency('USD') } },
      { type: 'ROTH_WITHDRAWAL_EARNINGS_APPLY', family: 'WITHDRAWAL', cc: 'US', fields: { amount: ValueType.currency('USD') } },
      { type: 'ROTH_WITHDRAWAL_EARNINGS_TAX',   fields: { amount: ValueType.currency('USD'), penaltyAmount: ValueType.number(), residency: ValueType.text() } },
      { type: 'ROTH_EARNINGS_APPLY',                    fields: { amount: ValueType.currency('USD'), stateKey: ValueType.text() } },
      { type: 'ROTH_ROLLOVER_CONTRIBUTION_APPLY',        fields: { amount: ValueType.currency('USD') } },
      { type: 'ROTH_ROLLOVER_EARNINGS_APPLY',            fields: { amount: ValueType.currency('USD') } },
      { type: 'ROTH_ROLLOVER_WITHDRAWAL_CONTRIB_APPLY',  family: 'WITHDRAWAL', cc: 'US', fields: { amount: ValueType.currency('USD'), penaltyAmount: ValueType.number(), auAssessableAmount: ValueType.number(), residency: ValueType.text(), rolloverConversions: ValueType.any() } },
      { type: 'ROTH_ROLLOVER_WITHDRAWAL_CONTRIB_TAX',    fields: { amount: ValueType.currency('USD'), penaltyAmount: ValueType.number(), auAssessableAmount: ValueType.number(), residency: ValueType.text() } },
      { type: 'ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_APPLY', family: 'WITHDRAWAL', cc: 'US', fields: { amount: ValueType.currency('USD'), penaltyAmount: ValueType.number() } },
      { type: 'ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_TAX',   fields: { amount: ValueType.currency('USD'), penaltyAmount: ValueType.number(), residency: ValueType.text() } },
      { type: 'IRA_CONTRIBUTION_APPLY',                 fields: { amount: ValueType.currency('USD') } },
      { type: 'IRA_CONTRIBUTION_TAX',                   fields: { amount: ValueType.currency('USD') } },
      { type: 'IRA_WITHDRAWAL_CONTRIB_APPLY',   family: 'WITHDRAWAL', cc: 'US', fields: { amount: ValueType.currency('USD') } },
      { type: 'IRA_WITHDRAWAL_CONTRIB_TAX',     fields: { amount: ValueType.currency('USD'), penaltyAmount: ValueType.number() } },
      { type: 'IRA_WITHDRAWAL_EARNINGS_APPLY',  family: 'WITHDRAWAL', cc: 'US', fields: { amount: ValueType.currency('USD') } },
      { type: 'IRA_WITHDRAWAL_EARNINGS_TAX',    fields: { amount: ValueType.currency('USD'), penaltyAmount: ValueType.number(), residency: ValueType.text() } },
      { type: 'IRA_EARNINGS_APPLY',                     fields: { amount: ValueType.currency('USD'), stateKey: ValueType.text() } },
      { type: 'IRA_ROLLOVER_WITHDRAWAL_APPLY',  family: 'WITHDRAWAL', cc: 'US', fields: { amount: ValueType.currency('USD') } },
      { type: 'IRA_ROLLOVER_WITHDRAWAL_TAX',    fields: { amount: ValueType.currency('USD'), residency: ValueType.text() } },
      { type: 'IRA_RMD_APPLY',                  family: 'WITHDRAWAL', cc: 'US', fields: { amount: ValueType.currency('USD') } },
      { type: 'IRA_RMD_TAX',                    fields: { amount: ValueType.currency('USD'), residency: ValueType.text() } },
      { type: 'K401_CONTRIBUTION_APPLY',                fields: { amount: ValueType.currency('USD') } },
      { type: 'K401_CONTRIBUTION_TAX',                  fields: { amount: ValueType.currency('USD') } },
      { type: 'K401_EARNINGS_APPLY',                    fields: { amount: ValueType.currency('USD'), stateKey: ValueType.text() } },
      { type: 'K401_WITHDRAWAL_APPLY',          family: 'WITHDRAWAL', cc: 'US', fields: { amount: ValueType.currency('USD') } },
      { type: 'K401_WITHDRAWAL_TAX',            fields: { amount: ValueType.currency('USD'), penaltyAmount: ValueType.number() } },
      { type: 'K401_RMD_APPLY',                 family: 'WITHDRAWAL', cc: 'US', fields: { amount: ValueType.currency('USD') } },
      { type: 'K401_RMD_TAX',                   fields: { amount: ValueType.currency('USD'), residency: ValueType.text() } },
      { type: 'K401_TO_IRA_CONVERSION_APPLY', family: 'WITHDRAWAL', cc: 'US', fields: { amount: ValueType.currency('USD') } },
      { type: 'GUARDRAIL_BASELINE_APPLY',   fields: { initialWithdrawalRate: ValueType.number(), portfolioValue: ValueType.number(), annualSpending: ValueType.number(), date: ValueType.any() } },
      { type: 'GUARDRAIL_ADJUST_APPLY',     fields: { multiplier: ValueType.number(), cause: ValueType.text(), date: ValueType.any() } },
      { type: 'HEALTHCARE_EXPENSE_APPLY',   fields: { amount: ValueType.number() } },
      { type: 'LATE_LIFE_CARE_APPLY',       fields: { active: ValueType.boolean(), factor: ValueType.number(), personId: ValueType.text() } },
    ],
  },

  paramSchema(context) {
    return [
      {
        key: 'inflationRate', label: 'Inflation Rate',
        type: 'Number', group: 'US Retirement', mc: true, opt: true,
        defaultValue: 0.03,
        description: 'Annual inflation rate applied to expenses',
      },
      {
        key: 'iraGrowthRate', label: 'IRA Growth Rate',
        type: 'Number', group: 'US Retirement', mc: true, opt: true,
        defaultValue: 0.07,
        description: 'Annual growth rate for Traditional IRA accounts',
      },
      {
        key: 'rothGrowthRate', label: 'Roth IRA Growth Rate',
        type: 'Number', group: 'US Retirement', mc: true, opt: true,
        defaultValue: 0.07,
        description: 'Annual growth rate for Roth IRA accounts',
      },
      {
        key: 'k401GrowthRate', label: '401(k) Growth Rate',
        type: 'Number', group: 'US Retirement', mc: true, opt: true,
        defaultValue: 0.07,
        description: 'Annual growth rate for 401(k) accounts',
      },
      {
        key: 'brokerageGrowthRate', label: 'Brokerage Growth Rate',
        type: 'Number', group: 'US Retirement', mc: true, opt: true,
        defaultValue: 0.05,
        description: 'Annual growth rate for US brokerage stock accounts',
      },
      {
        key: 'brokerageDividendRate', label: 'Brokerage Dividend Rate',
        type: 'Number', group: 'US Retirement', mc: true, opt: true,
        defaultValue: 0.02,
        description: 'Annual dividend yield for US brokerage stock accounts',
      },
      {
        key: 'dividendReinvest', label: 'Reinvest Dividends',
        type: 'Boolean', group: 'US Retirement', mc: false, opt: true,
        defaultValue: false,
        description: 'If true, US stock dividends are reinvested rather than taken as cash',
      },
      {
        key: 'fixedIncomeInterestRate', label: 'Fixed Income Interest Rate',
        type: 'Number', group: 'US Retirement', mc: true, opt: true,
        defaultValue: 0.04,
        description: 'Annual interest rate for fixed income accounts',
      },
      {
        key: 'monthlyExpenses', label: 'Monthly Expenses',
        type: 'Money', group: 'Spending', mc: true, opt: true,
        defaultValue: 6_000,
        // Native currency of the household-base expense figure (design 10 §Phase 5);
        // stamps these state paths so the display layer converts them.
        defaultCurrency: 'USD',
        currencyStateKeys: ['monthlyExpenses', 'expenses.essential', 'expenses.discretionary'],
        description: 'Monthly household expenses drawn from savings',
      },
      {
        key: 'inflationAdjust', label: 'Inflation-Adjust Expenses',
        type: 'Boolean', group: 'Spending', mc: false, opt: true,
        defaultValue: true,
        description: 'If true, monthly expenses grow with inflation each year',
      },
      {
        key: 'k401ToIraConversionEnabled', label: '401(k)→IRA Conversion Enabled',
        type: 'Boolean', group: 'US Retirement', mc: false, opt: false,
        defaultValue: true,
        description: 'If true, each 401(k) is rolled into the owner\'s first IRA on the owner\'s retirement date',
      },
      {
        key: 'k401ToIraConversionMonth', label: '401(k)→IRA Conversion Month',
        type: 'Number', group: 'US Retirement', mc: false, opt: true,
        defaultValue: null,
        description: 'Month (1–12) of the conversion; null = use the owner\'s retirement month',
      },
      {
        key: 'k401ToIraConversionDay', label: '401(k)→IRA Conversion Day',
        type: 'Number', group: 'US Retirement', mc: false, opt: true,
        defaultValue: null,
        description: 'Day of month for the conversion; null = use the owner\'s retirement day',
      },
      {
        key: 'k401ToIraConversionYear', label: '401(k)→IRA Conversion Year',
        type: 'Number', group: 'US Retirement', mc: false, opt: true,
        defaultValue: null,
        description: 'Year of the conversion; null = use the owner\'s retirement year',
      },
      {
        key: 'discretionarySharePct', label: 'Discretionary Share',
        type: 'Number', group: 'Spending', mc: false, opt: true,
        defaultValue: 0.30,
        description: 'Fraction of monthly expenses treated as discretionary (0.30 = 30%)',
      },
      {
        key: 'spendingStrategy', label: 'Spending Strategy',
        type: 'EnumMulti', group: 'Spending', mc: false, opt: true,
        options: ['FIXED', 'REGIME_AWARE', 'GUARDRAIL', 'HEALTHCARE', 'AGE_BANDED', 'EXPLICIT_BANDS'],
        defaultValue: ['FIXED'],
        description: 'Active spending strategies; FIXED = inflation-adjusted scalar (default), REGIME_AWARE = cut discretionary under economic-stress regimes, GUARDRAIL = Guyton-Klinger withdrawal-rate bands, HEALTHCARE = one-off healthcare expense events, AGE_BANDED = age-driven real spending smile (go-go/slow-go/no-go), EXPLICIT_BANDS = absolute monthly amount per age band (design 38 §6.1)',
      },
      ...SPENDING_STRATEGY_REGISTRY.REGIME_AWARE.paramSchema(),
      ...SPENDING_STRATEGY_REGISTRY.GUARDRAIL.paramSchema(),
      ...SPENDING_STRATEGY_REGISTRY.HEALTHCARE.paramSchema(),
      ...SPENDING_STRATEGY_REGISTRY.AGE_BANDED.paramSchema(),
      ...SPENDING_STRATEGY_REGISTRY.EXPLICIT_BANDS.paramSchema(),
      {
        key: 'crraGamma', label: 'CRRA Risk Aversion (γ)',
        type: 'Number', group: 'Spending', mc: false, opt: false,
        defaultValue: 1.5,
        description: 'Relative risk aversion for the CRRA consumption-utility accumulator (design 39 §4). γ=1 ⇒ log utility; higher γ ⇒ stronger preference for smooth real spending.',
      },
      {
        key: 'mortalityEnabled', label: 'Mortality Enabled',
        type: 'Boolean', group: 'Mortality', mc: false, opt: true,
        defaultValue: true,
        description: 'If true, PERSON_DIED events are scheduled and processed; disable to run to simEnd regardless of lifespan',
      },
      {
        key: 'survivorEssentialMultiplier', label: 'Survivor Essential Multiplier',
        type: 'Number', group: 'Mortality', mc: false, opt: true,
        defaultValue: 0.85,
        description: 'Fraction of essential expenses retained after a spouse dies (default 0.85)',
      },
      {
        key: 'survivorDiscretionaryMultiplier', label: 'Survivor Discretionary Multiplier',
        type: 'Number', group: 'Mortality', mc: false, opt: true,
        defaultValue: 0.50,
        description: 'Fraction of discretionary expenses retained after a spouse dies (default 0.50)',
      },
      {
        key: 'lateLifeCareMonths', label: 'Late-Life Care Window (months)',
        type: 'Number', group: 'Mortality', mc: false, opt: true,
        defaultValue: 0,
        description: 'Number of months before death to apply the late-life care expense multiplier; 0 = disabled',
      },
      {
        key: 'lateLifeCareFactor', label: 'Late-Life Care Factor',
        type: 'Number', group: 'Mortality', mc: false, opt: true,
        defaultValue: 2.0,
        description: 'Multiplier applied to all monthly expenses during the late-life care window',
      },
    ];
  },

  state(context) {
    const p = context.parameters;

    // Build people map (same shape as UsRetirementToolset.setup())
    const people = {};
    for (const person of context.people) {
      people[person.id] = {
        id:                    person.id,
        name:                  person.name,
        birthDate:             person.birthDate,
        monthlyWage:           person.monthlyWage           ?? 0,
        retirementDate:        person.retirementDate        ?? null,
        socialSecurityMonthly: person.socialSecurityMonthly ?? 0,
        lifeExpectancy:        person.lifeExpectancy        ?? 90,
        citizen:               person.citizen               ?? ['US'],
        residency:             person.residency             ?? person.citizen?.[0] ?? 'US',
      };
    }

    const metrics = {};
    const monthlyExpenses       = p.monthlyExpenses;
    const discretionarySharePct = p.discretionarySharePct ?? 0.30;

    const patches = {
      monthlyExpenses,
      discretionarySharePct,
      expenses: {
        essential:     monthlyExpenses * (1 - discretionarySharePct),
        discretionary: monthlyExpenses * discretionarySharePct,
      },
      inflationRates:       { US: p.inflationRate },
      inflationAccumulator: { US: 1.0 },
      metrics,
      people,
      outOfFundsDate:       null,
      scenarioFailed:       false,
      cumulativeDeficit:    0,
      deficitMonths:        0,
      cumulativeTaxesPaid:  0,
      cumulativeConsumption: 0,
      cumulativeConsumptionUtility: 0,
      personBirthDate:      context.people[0]?.birthDate ?? null,
      // Drawdown mode read by AccountService.replenishSavings. Ordered (default)
      // honors drawdownPriority; PROPORTIONAL draws pro-rata across eligible buckets.
      drawdownMode:         p.drawdownStrategy === 'PROPORTIONAL' ? 'PROPORTIONAL' : 'ORDERED',
      // Cross-border drawdown policy read by AccountService.replenishSavings.
      // LOCAL_FIRST (default): drain only same-country accounts to cover a savings
      // deficit, escalating to INTL_TRANSFER as a last resort (avoids an FX wire on
      // every top-up). GLOBAL: draw from accounts in either country in one global
      // drawdownPriority order, converting AUD↔USD per draw — used by the
      // TAX_EFFICIENT strategy so the residency country no longer dictates which
      // accounts drain first.
      crossBorderDrawdown:  p.drawdownStrategy === 'TAX_EFFICIENT' ? 'GLOBAL' : 'LOCAL_FIRST',
    };

    // Account state entries + initial metrics snapshot so the chart shows
    // correct balances at t=0 without waiting for the first RECORD_BALANCE.
    for (const account of context.accounts) {
      if (account.stateKey && patches[account.stateKey] === undefined) {
        patches[account.stateKey] = _accountToStatePlain(account);
      }
      if (account.stateKey != null && account.balance != null) {
        metrics[account.stateKey] = account.balance;
      }
    }

    // Guardrail pre-population for post-retirement scenarios (design/26 §12 step 12):
    // if any person is already retired at sim start, capture the initial withdrawal
    // rate immediately from the seeded account balances so GuardrailAnnualCheckReducer
    // has a baseline without needing to wait for a future RETIREMENT_DATE_REACHED event.
    const strategies = p.spendingStrategy ?? ['FIXED'];
    if (strategies.includes('GUARDRAIL')) {
      const simStart     = context.simStart ?? new Date();
      const anyRetired   = context.people.some(pe => pe.retirementDate && new Date(pe.retirementDate) <= simStart);
      if (anyRetired) {
        const drawdownAccounts = context.accounts.filter(a => a.drawdownPriority != null);
        const portfolioValue   = drawdownAccounts.reduce((sum, a) => sum + (a.balance ?? 0), 0);
        const annualSpending   = monthlyExpenses * 12;
        patches.guardrail = {
          initialWithdrawalRate:       portfolioValue > 0 ? annualSpending / portfolioValue : 0,
          portfolioValue,
          annualSpending,
          baselineDate:                simStart,
          lastAdjustmentDate:          null,
          lastAdjustmentCause:         null,
          currentAdjustmentMultiplier: 1.0,
        };
      }
    }

    return patches;
  },

  schedules(context) {
    const p        = context.parameters;
    const accounts = context.accounts;
    const people   = context.people;

    const usSavingsAccounts   = accounts.filter(a => a.role === ACCOUNT_ROLES.US_SAVINGS);
    const iraAccounts         = accounts.filter(a => a.role === ACCOUNT_ROLES.IRA);
    const rothAccounts        = accounts.filter(a => a.role === ACCOUNT_ROLES.ROTH);
    const k401Accounts        = accounts.filter(a => a.role === ACCOUNT_ROLES.K401);
    const usStockAccounts     = accounts.filter(a => a.role === ACCOUNT_ROLES.US_STOCK);
    const fixedIncomeAccounts = accounts.filter(a => a.role === ACCOUNT_ROLES.FIXED_INCOME);
    const personsWithSS       = people.filter(pe => (pe.socialSecurityMonthly ?? 0) > 0);

    const schedules = [
      EventBuilder.eventSeries()
        .name('Monthly Expenses').type('MONTHLY_EXPENSES')
        .interval('month-end').enabled(true).color('#F44336').build(),
      EventBuilder.eventSeries()
        .name('Monthly Wages').type('MONTHLY_WAGES')
        .interval('month-end').enabled(true).color('#4CAF50').build(),
    ];

    if (personsWithSS.length > 0) {
      schedules.push(
        EventBuilder.eventSeries()
          .name('Monthly Social Security').type('MONTHLY_SS_INCOME')
          .interval('month-end').enabled(true).color('#3F51B5').build()
      );
    }

    if (iraAccounts.length > 0) {
      schedules.push(
        EventBuilder.eventSeries()
          .name('IRA Earnings').type('INTL_IRA_EARNINGS')
          .interval('year-end').startOffset(1).enabled(true).color('#5C6BC0').build()
      );
      schedules.push(
        EventBuilder.eventSeries()
          .name('IRA Annual RMD').type('IRA_ANNUAL_RMD')
          .interval('year-end').startOffset(1).enabled(true).color('#E65100').build()
      );
    }

    if (rothAccounts.length > 0) {
      schedules.push(
        EventBuilder.eventSeries()
          .name('Roth IRA Earnings').type('INTL_ROTH_EARNINGS')
          .interval('year-end').startOffset(1).enabled(true).color('#7E57C2').build()
      );
    }

    if (k401Accounts.length > 0) {
      schedules.push(
        EventBuilder.eventSeries()
          .name('401k Earnings').type('INTL_K401_EARNINGS')
          .interval('year-end').startOffset(1).enabled(true).color('#42A5F5').build()
      );
      schedules.push(
        EventBuilder.eventSeries()
          .name('401k Annual RMD').type('K401_ANNUAL_RMD')
          .interval('year-end').startOffset(1).enabled(true).color('#BF360C').build()
      );
    }

    if (usStockAccounts.length > 0) {
      schedules.push(
        EventBuilder.eventSeries()
          .name('US Stock Earnings').type('INTL_STOCK_EARNINGS')
          .interval('year-end').startOffset(1).enabled(true).color('#26A69A').build()
      );
      schedules.push(
        EventBuilder.eventSeries()
          .name('US Stock Dividends').type('DIVIDEND_SCHEDULED')
          .interval('year-end').startOffset(1).enabled(true).color('#4CAF50').build()
      );
    }

    if (fixedIncomeAccounts.length > 0) {
      schedules.push(
        EventBuilder.eventSeries()
          .name('Fixed Income Interest').type('INTL_FIXED_INCOME_INTEREST')
          .interval('month-end').enabled(true).color('#2196F3').build()
      );
    }

    if (p.k401ToIraConversionEnabled && k401Accounts.length > 0) {
      for (const k401 of k401Accounts) {
        const owner = people.find(pe => pe.id === k401.ownerId);
        if (!owner?.retirementDate) continue;
        const ownerIra = iraAccounts.find(a => a.ownerId === k401.ownerId);
        if (!ownerIra) continue;

        const retirement = new Date(owner.retirementDate);
        const year  = p.k401ToIraConversionYear  ?? retirement.getUTCFullYear();
        const month = (p.k401ToIraConversionMonth ?? (retirement.getUTCMonth() + 1)) - 1;
        const day   = p.k401ToIraConversionDay   ?? retirement.getUTCDate();

        schedules.push(new OneOffEvent({
          name:    `401(k)→IRA Conversion (${owner.name})`,
          type:    'K401_TO_IRA_CONVERSION',
          date:    new Date(Date.UTC(year, month, day)),
          data:    { k401Key: k401.stateKey, iraKey: ownerIra.stateKey },
          enabled: true,
          color:   '#BF360C',
        }));
      }
    }

    // Guardrail — schedule RETIREMENT_DATE_REACHED for future-retirement persons (design/26 step 12).
    // Post-retirement persons are handled via state() patches (baseline captured at sim start).
    const strategies = p.spendingStrategy ?? ['FIXED'];
    if (strategies.includes('GUARDRAIL')) {
      const simStart = context.simStart ?? new Date();
      for (const person of people) {
        if (!person.retirementDate) continue;
        const retDate = new Date(person.retirementDate);
        if (retDate > simStart) {
          schedules.push(new OneOffEvent({
            name:    `Retirement Date — ${person.name}`,
            type:    'RETIREMENT_DATE_REACHED',
            date:    retDate,
            data:    { personId: person.id },
            enabled: true,
            color:   '#FF9800',
          }));
        }
      }
    }

    // Healthcare — schedule HEALTHCARE_EXPENSE one-off events from parameters (design/26 step 16).
    if (strategies.includes('HEALTHCARE')) {
      const healthcareEvents = p.healthcareEvents ?? [];
      for (const evt of healthcareEvents) {
        if (!evt.date || !evt.amount) continue;
        schedules.push(new OneOffEvent({
          name:    `Healthcare Expense${evt.category ? ` — ${evt.category}` : ''}`,
          type:    'HEALTHCARE_EXPENSE',
          date:    new Date(evt.date),
          data:    { amount: evt.amount, category: evt.category ?? 'healthcare', personId: evt.personId ?? null },
          enabled: true,
          color:   '#E91E63',
        }));
      }
    }

    // Mortality — PERSON_DIED one-off events (design/27 Increment 1 Step 2).
    const mortalityEnabled   = p.mortalityEnabled ?? true;
    const lateLifeCareMonths = p.lateLifeCareMonths ?? 0;
    const lateLifeCareFactor = p.lateLifeCareFactor ?? 2.0;

    if (mortalityEnabled) {
      const simEnd = context.simEnd ? new Date(context.simEnd) : null;
      for (const person of people) {
        // Prefer the MC-perturbed lifeExpectancy from params.people if present;
        // fall back to the person's own lifeExpectancy field (deterministic single runs).
        const lifeExpectancy = p.people?.[person.id]?.lifeExpectancy ?? person.lifeExpectancy;
        if (!person.birthDate || !lifeExpectancy) continue;
        const birth     = new Date(person.birthDate);
        const deathDate = new Date(Date.UTC(
          birth.getUTCFullYear() + Math.round(lifeExpectancy),
          birth.getUTCMonth(),
          birth.getUTCDate(),
        ));
        if (simEnd && deathDate > simEnd) continue;
        schedules.push(new OneOffEvent({
          name:    `Death — ${person.name ?? person.id}`,
          type:    'PERSON_DIED',
          date:    deathDate,
          data:    { personId: person.id },
          enabled: true,
          color:   '#37474F',
        }));

        // Late-life care window (design/27 Increment 2 Step 11).
        if (lateLifeCareMonths > 0) {
          const careBegin = new Date(deathDate);
          careBegin.setUTCMonth(careBegin.getUTCMonth() - lateLifeCareMonths);
          schedules.push(new OneOffEvent({
            name:    `Late-Life Care Begin — ${person.name ?? person.id}`,
            type:    'LATE_LIFE_CARE_BEGIN',
            date:    careBegin,
            data:    { personId: person.id, factor: lateLifeCareFactor },
            enabled: true,
            color:   '#BF360C',
          }));
          schedules.push(new OneOffEvent({
            name:    `Late-Life Care End — ${person.name ?? person.id}`,
            type:    'LATE_LIFE_CARE_END',
            date:    new Date(deathDate),
            data:    { personId: person.id },
            enabled: true,
            color:   '#BF360C',
          }));
        }
      }
    }

    return schedules;
  },

  handlers(context) {
    const p        = context.parameters;
    const accounts = context.accounts;
    const people   = context.people;
    const sr       = context.stateRegistry;

    const usSavingsAccounts   = accounts.filter(a => a.role === ACCOUNT_ROLES.US_SAVINGS);
    const iraAccounts         = accounts.filter(a => a.role === ACCOUNT_ROLES.IRA);
    const rothAccounts        = accounts.filter(a => a.role === ACCOUNT_ROLES.ROTH);
    const k401Accounts        = accounts.filter(a => a.role === ACCOUNT_ROLES.K401);
    const usStockAccounts     = accounts.filter(a => a.role === ACCOUNT_ROLES.US_STOCK);
    const fixedIncomeAccounts = accounts.filter(a => a.role === ACCOUNT_ROLES.FIXED_INCOME);
    const personsWithSS       = people.filter(pe => (pe.socialSecurityMonthly ?? 0) > 0);

    const primaryId         = usSavingsAccounts[0]?.ownerId ?? (people[0]?.id ?? null);
    const accountRulesEngine = new TaxService().accountRulesEngine;
    const handlers          = [];

    // Monthly Expenses
    const expensesHandler = new MonthlyExpensesHandler({
      stateRegistry:    sr,
      monthlyExpenses:  p.monthlyExpenses,
      expensesCurrency: p.monthlyExpensesCurrency ?? 'USD',
      usRole:           ACCOUNT_ROLES.US_SAVINGS, usOwnerId: primaryId,
      auRole:           ACCOUNT_ROLES.AU_SAVINGS,  auOwnerId: primaryId,
    });
    expensesHandler.handledEvents.push(context.schedulesById['MONTHLY_EXPENSES']);
    handlers.push(expensesHandler);

    // Monthly Wages
    const wagesHandler = new MonthlyWagesHandler({ stateRegistry: sr });
    wagesHandler.handledEvents.push(context.schedulesById['MONTHLY_WAGES']);
    handlers.push(wagesHandler);

    // Social Security
    if (personsWithSS.length > 0) {
      const ssHandler = new MonthlySocialSecurityHandler({ stateRegistry: sr, accountRulesEngine });
      ssHandler.handledEvents.push(context.schedulesById['MONTHLY_SS_INCOME']);
      handlers.push(ssHandler);
    }

    // IRA earnings + annual RMD
    const iraEvent   = context.schedulesById['INTL_IRA_EARNINGS'];
    const rmdEvent   = context.schedulesById['IRA_ANNUAL_RMD'];
    if (iraEvent) {
      for (const acct of iraAccounts) {
        const h = new IntlIraEarningsHandler({
          stateRegistry: sr, role: ACCOUNT_ROLES.IRA,
          ownerId: acct.ownerId, stateKey: acct.stateKey,
          growthRate: p.iraGrowthRate,
        });
        h.handledEvents.push(iraEvent);
        handlers.push(h);

        if (rmdEvent) {
          const rmdH = new IraAnnualRmdHandler({
            stateRegistry: sr, role: ACCOUNT_ROLES.IRA,
            ownerId: acct.ownerId, stateKey: acct.stateKey,
            accountRulesEngine,
          });
          rmdH.handledEvents.push(rmdEvent);
          handlers.push(rmdH);
        }
      }
    }

    // Roth IRA earnings
    const rothEvent = context.schedulesById['INTL_ROTH_EARNINGS'];
    if (rothEvent) {
      for (const acct of rothAccounts) {
        const h = new IntlRothEarningsHandler({
          stateRegistry: sr, role: ACCOUNT_ROLES.ROTH,
          ownerId: acct.ownerId, stateKey: acct.stateKey,
          growthRate: p.rothGrowthRate,
        });
        h.handledEvents.push(rothEvent);
        handlers.push(h);
      }
    }

    // 401(k) earnings + annual RMD
    const k401Event    = context.schedulesById['INTL_K401_EARNINGS'];
    const k401RmdEvent = context.schedulesById['K401_ANNUAL_RMD'];
    if (k401Event) {
      for (const acct of k401Accounts) {
        const h = new IntlK401EarningsHandler({
          stateRegistry: sr, role: ACCOUNT_ROLES.K401,
          ownerId: acct.ownerId, stateKey: acct.stateKey,
          growthRate: p.k401GrowthRate,
        });
        h.handledEvents.push(k401Event);
        handlers.push(h);

        if (k401RmdEvent) {
          const rmdH = new K401AnnualRmdHandler({
            stateRegistry: sr, role: ACCOUNT_ROLES.K401,
            ownerId: acct.ownerId, stateKey: acct.stateKey,
            accountRulesEngine,
          });
          rmdH.handledEvents.push(k401RmdEvent);
          handlers.push(rmdH);
        }
      }
    }

    // US Stock earnings + dividends
    const stockEvent = context.schedulesById['INTL_STOCK_EARNINGS'];
    const divEvent   = context.schedulesById['DIVIDEND_SCHEDULED'];
    if (stockEvent) {
      for (const acct of usStockAccounts) {
        const earningsH = new IntlUsStockEarningsHandler({
          stateRegistry: sr, role: ACCOUNT_ROLES.US_STOCK,
          ownerId: acct.ownerId, stateKey: acct.stateKey,
          growthRate: p.brokerageGrowthRate,
        });
        earningsH.handledEvents.push(stockEvent);
        handlers.push(earningsH);

        const divH = new DividendScheduledHandler({
          stateRegistry: sr, role: ACCOUNT_ROLES.US_STOCK,
          ownerId: acct.ownerId, stateKey: acct.stateKey,
          dividendRate: p.brokerageDividendRate,
          reinvest:     p.dividendReinvest,
        });
        divH.handledEvents.push(divEvent);
        handlers.push(divH);
      }
    }

    // Fixed income interest
    const fiEvent = context.schedulesById['INTL_FIXED_INCOME_INTEREST'];
    if (fiEvent) {
      for (const acct of fixedIncomeAccounts) {
        const h = new FixedIncomeInterestHandler({
          stateRegistry: sr, role: ACCOUNT_ROLES.FIXED_INCOME,
          ownerId: acct.ownerId, stateKey: acct.stateKey,
          interestRate: p.fixedIncomeInterestRate,
        });
        h.handledEvents.push(fiEvent);
        handlers.push(h);
      }
    }

    // Roth IRA mechanics
    if (rothAccounts.length > 0) handlers.push(
      new RothContributionHandler(), new RothWithdrawalContributionsHandler(),
      new RothWithdrawalEarningsHandler(), new RothEarningsHandler(),
      new RothRolloverContributionHandler(), new RothRolloverEarningsHandler(),
      new RothRolloverWithdrawalContributionsHandler(), new RothRolloverWithdrawalEarningsHandler(),
    );

    // Traditional IRA mechanics
    if (iraAccounts.length > 0) handlers.push(
      new IraContributionHandler(), new IraWithdrawalContributionsHandler(),
      new IraWithdrawalEarningsHandler(), new IraEarningsHandler(),
      new IraRolloverWithdrawalHandler(), new IraRmdHandler(),
    );

    // 401(k) mechanics
    if (k401Accounts.length > 0) handlers.push(
      new K401ContributionHandler(), new K401EarningsHandler(), new K401WithdrawalHandler(),
    );

    // 401(k)→IRA conversion (only when both account types exist)
    if (k401Accounts.length > 0 && iraAccounts.length > 0) {
      const convEvent = context.schedulesById['K401_TO_IRA_CONVERSION'];
      const convH = new K401ToIraConversionHandler();
      if (convEvent) convH.handledEvents.push(convEvent);
      handlers.push(convH);
    }

    // Out-of-funds handler (no event binding)
    handlers.push(new OutOfFundsHandler());

    // Mortality — MortalityHandler fires on PERSON_DIED (design/27 Step 7).
    const mortalityEnabled = p.mortalityEnabled ?? true;
    if (mortalityEnabled) {
      const deathEvents = Object.values(context.schedulesById).filter(e => e?.type === 'PERSON_DIED');
      if (deathEvents.length > 0) {
        const mortalityH = new MortalityHandler({
          survivorEssentialMultiplier:     p.survivorEssentialMultiplier     ?? 0.85,
          survivorDiscretionaryMultiplier: p.survivorDiscretionaryMultiplier ?? 0.50,
        });
        for (const evt of deathEvents) mortalityH.handledEvents.push(evt);
        handlers.push(mortalityH);
      }

      // Late-life care handler (design/27 Increment 2 Step 12).
      const llcBeginEvents = Object.values(context.schedulesById).filter(e => e?.type === 'LATE_LIFE_CARE_BEGIN');
      const llcEndEvents   = Object.values(context.schedulesById).filter(e => e?.type === 'LATE_LIFE_CARE_END');
      if (llcBeginEvents.length > 0 || llcEndEvents.length > 0) {
        const llcH = new LateLifeCareHandler();
        for (const evt of [...llcBeginEvents, ...llcEndEvents]) llcH.handledEvents.push(evt);
        handlers.push(llcH);
      }
    }

    // Guardrail — RetirementDateHandler fires on RETIREMENT_DATE_REACHED (design/26 step 12).
    const strategiesH = p.spendingStrategy ?? ['FIXED'];
    if (strategiesH.includes('GUARDRAIL')) {
      const retDateEvents = Object.values(context.schedulesById).filter(e => e?.type === 'RETIREMENT_DATE_REACHED');
      if (retDateEvents.length > 0) {
        const retH = new RetirementDateHandler({
          baseCurrency: p.guardrailBaseCurrency ?? 'USD',
        });
        for (const evt of retDateEvents) retH.handledEvents.push(evt);
        handlers.push(retH);
      }
    }

    // Healthcare — HealthcareEventHandler fires on HEALTHCARE_EXPENSE (design/26 step 16).
    if (strategiesH.includes('HEALTHCARE')) {
      const hcEvents = Object.values(context.schedulesById).filter(e => e?.type === 'HEALTHCARE_EXPENSE');
      if (hcEvents.length > 0) {
        const hcH = new HealthcareEventHandler({
          stateRegistry: sr,
          expensesCurrency: p.monthlyExpensesCurrency ?? 'USD',
          usRole: ACCOUNT_ROLES.US_SAVINGS, usOwnerId: primaryId,
          auRole: ACCOUNT_ROLES.AU_SAVINGS,  auOwnerId: primaryId,
        });
        for (const evt of hcEvents) hcH.handledEvents.push(evt);
        handlers.push(hcH);
      }
    }

    return handlers;
  },

  reducers(context) {
    const p           = context.parameters;
    const accounts    = context.accounts;
    const accountSvc  = context.accountService;
    const sr          = context.stateRegistry;

    const usSavingsAccounts = accounts.filter(a => a.role === ACCOUNT_ROLES.US_SAVINGS);
    const usStockAccounts   = accounts.filter(a => a.role === ACCOUNT_ROLES.US_STOCK);
    const rothAccounts      = accounts.filter(a => a.role === ACCOUNT_ROLES.ROTH);
    const iraAccounts       = accounts.filter(a => a.role === ACCOUNT_ROLES.IRA);
    const k401Accounts      = accounts.filter(a => a.role === ACCOUNT_ROLES.K401);
    const primaryId = usSavingsAccounts[0]?.ownerId ?? (context.people[0]?.id ?? null);

    const reducers = [];

    const recordMetricReducer = ReducerBuilder.metric(null).name('Record Metric').build();
    recordMetricReducer.reducedActionTypes = ['RECORD_METRIC'];
    reducers.push(recordMetricReducer);

    reducers.push(new ExpenseDebitReducer({ accountService: accountSvc }));
    reducers.push(new ReplenishSavingsReducer({ accountService: accountSvc }));

    if (usStockAccounts.length > 0) {
      reducers.push(new StockDividendCashApplyReducer({
        accountService: accountSvc, stateRegistry: sr,
        role: ACCOUNT_ROLES.US_SAVINGS, ownerId: primaryId,
      }));
    }

    reducers.push(new SetOutOfFundsDateReducer());
    reducers.push(new AccumulateDeficitReducer());
    reducers.push(new AccumulateTaxesPaidReducer());
    reducers.push(new AccumulateConsumptionReducer());
    reducers.push(new AccumulateConsumptionUtilityReducer({ gamma: p.crraGamma ?? 1.5 }));
    reducers.push(new OutOfFundsReducer());

    if (p.inflationAdjust) {
      reducers.push(new InflationAdjustReducer());
    }

    reducers.push(new SpendingStrategyApplyReducer());

    const strategies = p.spendingStrategy ?? ['FIXED'];
    for (const stratKey of strategies) {
      if (stratKey !== 'FIXED' && SPENDING_STRATEGY_REGISTRY[stratKey]) {
        reducers.push(...SPENDING_STRATEGY_REGISTRY[stratKey].reducers(context));
      }
    }

    // Roth IRA mechanics
    if (rothAccounts.length > 0) reducers.push(
      new RothContributionApplyReducer({ accountService: accountSvc }),
      new RothWithdrawalContribApplyReducer({ accountService: accountSvc }),
      new RothWithdrawalEarningsApplyReducer({ accountService: accountSvc }),
      new RothEarningsApplyReducer({ accountService: accountSvc }),
      new RothRolloverContributionApplyReducer({ accountService: accountSvc }),
      new RothRolloverEarningsApplyReducer({ accountService: accountSvc }),
      new RothRolloverWithdrawalContribApplyReducer({ accountService: accountSvc }),
      new RothRolloverWithdrawalEarningsApplyReducer({ accountService: accountSvc }),
    );

    // Traditional IRA mechanics
    if (iraAccounts.length > 0) reducers.push(
      new IraContributionApplyReducer({ accountService: accountSvc }),
      new IraWithdrawalContribApplyReducer({ accountService: accountSvc }),
      new IraWithdrawalEarningsApplyReducer({ accountService: accountSvc }),
      new IraEarningsApplyReducer({ accountService: accountSvc }),
      new IraRolloverWithdrawalApplyReducer({ accountService: accountSvc }),
      new IraRmdApplyReducer({ accountService: accountSvc }),
    );

    // 401(k) mechanics
    if (k401Accounts.length > 0) reducers.push(
      new K401ContributionApplyReducer({ accountService: accountSvc }),
      new K401EarningsApplyReducer({ accountService: accountSvc }),
      new K401WithdrawalApplyReducer({ accountService: accountSvc }),
      new K401RmdApplyReducer({ accountService: accountSvc }),
    );

    // 401(k)→IRA conversion (no cash pool / tax — direct rollover)
    if (k401Accounts.length > 0 && iraAccounts.length > 0) {
      reducers.push(new K401ToIraConversionApplyReducer({ accountService: accountSvc }));
    }

    // Mortality reducers (design/27 Step 7).
    const mortalityEnabledR = p.mortalityEnabled ?? true;
    if (mortalityEnabledR) {
      reducers.push(new PersonDiedApplyReducer());
      reducers.push(new SocialSecuritySurvivorApplyReducer());
      reducers.push(new AccountRetitleApplyReducer());
      reducers.push(new ScenarioCompleteReducer());

      // Late-life care reducer (design/27 Increment 2).
      if ((p.lateLifeCareMonths ?? 0) > 0) {
        reducers.push(new LateLifeCareApplyReducer());
      }
    }

    return reducers;
  },
};
