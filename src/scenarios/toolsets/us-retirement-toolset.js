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
import { HouseRunningCostHandler }      from '../../finance/handlers/house-running-cost-handler.js';
import { RealPropertyRepairTickHandler } from '../../finance/handlers/real-property-repair-tick-handler.js';
import { HouseRepairApplyReducer }      from '../../finance/reducers/house-repair-apply-reducer.js';
import { PayrollHandler, PAYROLL_STAGE, WITHHOLDING_METHOD, hasPayrollContributions, US_CONTRIBUTION_FIELDS }
  from '../../finance/handlers/payroll-handler.js';
import { projectPeople }                from '../../finance/state/person-projection.js';
import { MonthlySocialSecurityHandler } from '../../finance/handlers/monthly-social-security-handler.js';
import { DividendScheduledHandler }     from '../../finance/handlers/dividend-scheduled-handler.js';
import { BondCouponScheduledHandler }   from '../../finance/handlers/bond-coupon-handler.js';
import { CashSleeveInterestHandler }     from '../../finance/handlers/cash-sleeve-interest-handler.js';
import { BondSleeveCouponHandler }       from '../../finance/handlers/bond-sleeve-coupon-handler.js';
import { BondAccretionHandler }          from '../../finance/handlers/bond-accretion-handler.js';
import {
  FixedIncomeInterestHandler,
  IntlIraEarningsHandler, IntlRothEarningsHandler, IntlK401EarningsHandler,
  IntlUsStockEarningsHandler,
} from '../../finance/handlers/earnings-handlers.js';
import { SLEEVE_ORDER_MODES, LOT_STRATEGIES, sleeveWeightsFromParams } from '../../finance/holdings/holdings-selection.js';
import { OutOfFundsHandler }            from '../../finance/handlers/out-of-funds-handler.js';
import { RetirementDateHandler }        from '../../finance/spending/strategies/retirement-date-handler.js';
import { ExpenseEventHandler, buildExpenseEventSchedule } from '../../finance/spending/strategies/expense-event-handler.js';
import { ExpenseDebitReducer }          from '../../finance/reducers/expense-debit-reducer.js';
import { ReplenishSavingsReducer }      from '../../finance/reducers/replenish-savings-reducer.js';
import { StockDividendCashApplyReducer }    from '../../finance/reducers/stock-dividend-cash-apply-reducer.js';
import { BondCouponCashApplyReducer }       from '../../finance/reducers/bond-coupon-cash-apply-reducer.js';
import { CashSleeveInterestApplyReducer }    from '../../finance/reducers/cash-sleeve-interest-apply-reducer.js';
import { BondSleeveCouponApplyReducer }      from '../../finance/reducers/bond-sleeve-coupon-apply-reducer.js';
import { BondAccretionApplyReducer }         from '../../finance/reducers/bond-accretion-apply-reducer.js';
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
import { SuperDeathBenefitApplyReducer }         from '../../finance/reducers/super-death-benefit-apply-reducer.js';
import { ScenarioCompleteReducer }               from '../../finance/reducers/scenario-complete-reducer.js';
import { LateLifeCareHandler }                  from '../../finance/spending/strategies/late-life-care-handler.js';
import { LateLifeCareApplyReducer }             from '../../finance/spending/strategies/late-life-care-apply-reducer.js';
import {
  RothRolloverContributionApplyReducer, RothRolloverEarningsApplyReducer,
  RothRolloverWithdrawalContribApplyReducer, RothRolloverWithdrawalEarningsApplyReducer,
  RothRolloverContributionHandler, RothRolloverEarningsHandler,
  RothRolloverWithdrawalContributionsHandler, RothRolloverWithdrawalEarningsHandler,
} from '../../finance/account-rules/us/roth-rollover-classes.js';
import { projectHoldingsToState }             from '../../finance/holdings/holding-utils.js';

function _accountToStatePlain(account) {
  const plain = {
    balance:               account.balance,
    stateKey:              account.stateKey,
    type:                  account.type                  ?? null,
    country:               account.country               ?? null,
    currency:              account.currency              ?? null,
    role:                  account.role                  ?? null,
    ownerId:               account.ownerId               ?? null,
    // Design 76 Gap A: ownershipType MUST be projected alongside ownerId.
    // `ownershipFractions` resolves owners[] → sole+ownerId → even split, so a
    // missing ownershipType silently disqualifies the `sole` branch and sends
    // every per-person attribution to the even split — which is what made all
    // the accumulateByOwnership wiring from designs 52/55/73 inert.
    ownershipType:         account.ownershipType         ?? 'sole',
    minimumBalance:        account.minimumBalance        ?? 0,
    drawdownPriority:      account.drawdownPriority      ?? null,
    allowsEarlyWithdrawal: account.allowsEarlyWithdrawal ?? false,
    // Holdings — plain-data array (no methods), structuredClone-safe. This is also the
    // config→run boundary where a scalar individual bond is PROMOTED to the unitised
    // representation (design 93 §5b); the account record on disk is never rewritten.
    holdings:              projectHoldingsToState(account.holdings),
  };
  // OffsetAccount link (design 53 §3 / 54 P3): carry the property key into runtime
  // state so offsetBalanceForLoan() can find it — otherwise the offset is invisible.
  if (account.offsetsPropertyKey !== undefined) {
    plain.offsetsPropertyKey = account.offsetsPropertyKey ?? null;
  }
  // §988 currency basis + income-producing share (design 87). Same reason as the
  // offset link: the reducers read the runtime STATE entry, not the record, so a
  // field left out here makes an authored basis rate invisible and the pool gets
  // stamped at its first disposition instead. Projected only when set, so legacy
  // accounts are byte-identical.
  if (account.fxBasisRate != null) plain.fxBasisRate = account.fxBasisRate;
  if (account.type !== 'loan' && account.deductibleFraction != null) {
    plain.deductibleFraction = account.deductibleFraction;
  }
  // LoanAccount terms (design 54 §2 + design 86). Same reason as the offset link
  // above: LoanPaymentHandler reads the runtime STATE entry, not the record, so a
  // field left out here makes an authored loan a balance with no rate and no
  // payment — it sits in net worth and is never serviced.
  if (account.type === 'loan') {
    plain.interestRate          = account.interestRate          ?? 0;
    plain.primeSpread           = account.primeSpread           ?? null;
    plain.monthlyPayment        = account.monthlyPayment        ?? 0;
    plain.linkedPropertyKey     = account.linkedPropertyKey     ?? null;
    plain.paymentSourceKey      = account.paymentSourceKey      ?? null;
    plain.interestOnly          = account.interestOnly          ?? false;
    plain.deductibleFraction    = account.deductibleFraction    ?? null;
    plain.interestOnlyUntilYear = account.interestOnlyUntilYear ?? null;
    plain.maturityYear          = account.maturityYear          ?? null;
    plain.bookingFxRate         = account.bookingFxRate         ?? null;
    // Anchor for the post-IO payment (see scheduledLoanPayment). Same reason as every
    // other field here: the handler reads the runtime STATE entry, so leaving it out
    // silently drops the loan back onto the legacy self-damping schedule.
    plain.postIoPrincipal       = account.postIoPrincipal       ?? null;
  }
  if (account.contributionBasis !== undefined) {
    plain.contributionBasis        = account.contributionBasis;
    plain.earningsBasis            = account.earningsBasis ?? 0;
    plain.derivedIncomeBasis       = account.derivedIncomeBasis ?? 0;
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

/** True when any property carries a positive regular running cost (design 75 §5.1). */
function _hasHouseRunningCost(realProperties) {
  return (realProperties ?? []).some(pr =>
    (pr.annualRunningCost ?? 0) > 0 || (pr.runningCostValuePct ?? 0) > 0);
}

/** True when any property has a stochastic repair model (design 75 §5.2). */
function _hasHouseRepairs(realProperties) {
  return (realProperties ?? []).some(pr => (pr.repairModel ?? 'NONE') !== 'NONE');
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
/**
 * Does this scenario contribute anything to a US retirement wrapper during the run?
 *
 * Gates the whole payroll-contribution path: with every rate and amount left at its
 * 0 default, no event is scheduled and no handler is wired, so a scenario that does
 * not opt in is byte-identical to one built before the feature existed. Someone has
 * to still be earning, too — contributing a percentage of a wage nobody draws would
 * schedule a monthly event that can only ever emit nothing.
 */
function _hasPayrollContributions(context) {
  // Design 95 §7.1 phase 1: reads BOTH the household defaults and each person's own
  // election. Reading only the former left a per-person election inert whenever the
  // household default was 0 — no event scheduled, so nothing consumed the field.
  return hasPayrollContributions(
    context.people ?? [], context.parameters ?? {}, US_CONTRIBUTION_FIELDS);
}

export const US_RETIREMENT = {
  id: 'US_RETIREMENT',
  capabilities: ['retirement'],
  dependencies: ['US_BANKING', 'US_TAX', 'US_INCOME', 'US_BROKERAGE'],

  types: {
    handlers: [
      MonthlyExpensesHandler, HouseRunningCostHandler, RealPropertyRepairTickHandler, PayrollHandler, MonthlySocialSecurityHandler,
      DividendScheduledHandler, BondCouponScheduledHandler, CashSleeveInterestHandler, BondSleeveCouponHandler, BondAccretionHandler, FixedIncomeInterestHandler,
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
      ExpenseDebitReducer, HouseRepairApplyReducer, ReplenishSavingsReducer, StockDividendCashApplyReducer, BondCouponCashApplyReducer, CashSleeveInterestApplyReducer, BondSleeveCouponApplyReducer, BondAccretionApplyReducer,
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
      // `section988` — design 87 §14.4 item 2, the §988 character declaration the currency
      // lot observer reads. Declared for JOURNAL visibility rather than for the mechanism
      // (the observer sees the live action, which pickPayload never filters): undeclared,
      // a currency disposition would compute correctly and then be invisible in every
      // report that reads the journal. Both retirement toolsets declare this shared type
      // and registerActionType is last-writer-wins, so they must stay identical.
      // `realizedAmount` is stamped by ExpenseDebitReducer, not by the four emitters:
      // it is what the balance cap actually let through (design 89 §5.4). Declared so
      // the journal carries intent and realized side by side on every dispatch —
      // design 89 §5's intent-vs-realized pair, readable off the payload instead of
      // reconstructed by pairing `amount` against `stateDelta` while dodging the fact
      // that EXPENSE_DEBIT is journaled once per consuming reducer.
      // `number()` not `currency()` deliberately, matching `amount`: this type spans
      // both currencies (the pool is picked by residency), so a fixed per-type code
      // would be the design 91 §8.1 error. Money reports read `stateDelta`, whose unit
      // comes from the state schema.
      // `priceLevel` is likewise stamped, by the four EMITTERS (design 89 §5.6): the
      // index the money was incurred at, which is residence for living costs and
      // prop.country for property costs — a different axis from the account's currency,
      // and one a single debit can blend when several properties pay from one account.
      // `spendCategory` + `capitalFraction` are stamped by the four EMITTERS
      // (design 89 §6.1 A, §8.1). The category is the one thing that separates a
      // month's groceries from a home's rates: same type, same pool, same
      // `businessFraction`, and the report has to draw them as different bands.
      // Emitted, never inferred — inferring it from targetKey/amount/cadence is the
      // trap design 82 §2 exists to prevent, and it fails silently.
      // NOT named `category`: `EXPENSE_EVENT_APPLY` below already declares one, it is
      // the author's free text, and ExpenseEventHandler emits both in the same tick.
      // `capitalFraction` is the share that lifted a cost basis rather than being
      // consumed — non-constant only on the repair emitter, where design 75 §5.2's
      // `capitalizeRepairs` splits it per property.
      { type: 'EXPENSE_DEBIT',         fields: { amount: ValueType.number(), realizedAmount: ValueType.number(),
                                                 priceLevel: ValueType.number(),
                                                 spendCategory: ValueType.text(),
                                                 capitalFraction: ValueType.number(),
                                                 targetKey: ValueType.text(),
                                                 section988: ValueType.any() } },
      { type: 'REPLENISH_SAVINGS',  family: 'WITHDRAWAL', fields: { deficit: ValueType.number(), targetKey: ValueType.text() } },
      { type: 'RECORD_METRIC',         fields: { fieldName: ValueType.text(), value: ValueType.number() } },
      { type: 'SET_OUT_OF_FUNDS_DATE', fields: { date: ValueType.any() } },
      { type: 'ACCUMULATE_DEFICIT',    fields: { amount: ValueType.number() } },
      { type: 'OUT_OF_FUNDS',          fields: { deficit: ValueType.number(), currency: ValueType.text() } },
      { type: 'STOCK_DIVIDEND_CASH_APPLY',              fields: { amount: ValueType.currency('USD'), residency: ValueType.text(), stateKey: ValueType.text() } },
      { type: 'CASH_SLEEVE_INTEREST_APPLY',             fields: { amount: ValueType.currency('USD'), stateKey: ValueType.text(), taxMode: ValueType.text(), residency: ValueType.text() } },
      { type: 'BOND_SLEEVE_COUPON_APPLY',               fields: { amount: ValueType.currency('USD'), federalTaxableAmount: ValueType.currency('USD'), stateTaxableAmount: ValueType.currency('USD'), stateKey: ValueType.text(), taxMode: ValueType.text(), residency: ValueType.text() } },
      { type: 'BOND_ACCRETION_APPLY',                   fields: { amount: ValueType.currency('USD'), federalTaxableAmount: ValueType.currency('USD'), stateTaxableAmount: ValueType.currency('USD'), stateKey: ValueType.text(), taxMode: ValueType.text(), residency: ValueType.text() } },
      { type: 'ROTH_CONTRIBUTION_APPLY',                fields: { amount: ValueType.currency('USD'), stateKey: ValueType.text() } },
      { type: 'ROTH_WITHDRAWAL_CONTRIB_APPLY',  family: 'WITHDRAWAL', cc: 'US', fields: { amount: ValueType.currency('USD') } },
      // The WITHDRAWAL family's apply actions carry `penaltyAmount` (the §72(t) 10%)
      // and `residency` alongside `amount`; both were declared only on the paired *_TAX
      // types, so the two halves of the same withdrawal disagreed about what it carries.
      // `residency` matters most: it is one of the fields JournalDataSource._project
      // lifts onto every report row, so once the manifest gate is wired (design 91 §2.1)
      // an undeclared one would be dropped and `row.residency` would go null on these
      // rows. `number()` for penaltyAmount, matching every *_TAX sibling.
      { type: 'ROTH_WITHDRAWAL_EARNINGS_APPLY', family: 'WITHDRAWAL', cc: 'US', fields: { amount: ValueType.currency('USD'), penaltyAmount: ValueType.number(), residency: ValueType.text() } },
      // `auAssessableAmount` (design 84 G2) is the DERIVED slice s99B reaches. It MUST
      // be declared: pickPayload keeps only declared fields, so an undeclared one is
      // silently dropped and the tax module falls back to assessing the whole amount.
      { type: 'ROTH_WITHDRAWAL_EARNINGS_TAX',   fields: { amount: ValueType.currency('USD'), penaltyAmount: ValueType.number(), auAssessableAmount: ValueType.number(), residency: ValueType.text() , stateKey: ValueType.text()} },
      { type: 'ROTH_EARNINGS_APPLY',                    fields: { amount: ValueType.currency('USD'), stateKey: ValueType.text(), derivedAmount: ValueType.number() } },
      { type: 'ROTH_ROLLOVER_CONTRIBUTION_APPLY',        fields: { amount: ValueType.currency('USD') } },
      { type: 'ROTH_ROLLOVER_EARNINGS_APPLY',            fields: { amount: ValueType.currency('USD') } },
      { type: 'ROTH_ROLLOVER_WITHDRAWAL_CONTRIB_APPLY',  family: 'WITHDRAWAL', cc: 'US', fields: { amount: ValueType.currency('USD'), penaltyAmount: ValueType.number(), auAssessableAmount: ValueType.number(), residency: ValueType.text(), rolloverConversions: ValueType.any() } },
      { type: 'ROTH_ROLLOVER_WITHDRAWAL_CONTRIB_TAX',    fields: { amount: ValueType.currency('USD'), penaltyAmount: ValueType.number(), auAssessableAmount: ValueType.number(), residency: ValueType.text() , stateKey: ValueType.text()} },
      { type: 'ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_APPLY', family: 'WITHDRAWAL', cc: 'US', fields: { amount: ValueType.currency('USD'), penaltyAmount: ValueType.number(), residency: ValueType.text() } },
      { type: 'ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_TAX',   fields: { amount: ValueType.currency('USD'), penaltyAmount: ValueType.number(), residency: ValueType.text() , stateKey: ValueType.text()} },
      { type: 'IRA_CONTRIBUTION_APPLY',                 fields: { amount: ValueType.currency('USD'), stateKey: ValueType.text() } },
      { type: 'IRA_CONTRIBUTION_TAX',                   fields: { amount: ValueType.currency('USD') } },
      { type: 'IRA_WITHDRAWAL_CONTRIB_APPLY',   family: 'WITHDRAWAL', cc: 'US', fields: { amount: ValueType.currency('USD'), penaltyAmount: ValueType.number() } },
      { type: 'IRA_WITHDRAWAL_CONTRIB_TAX',     fields: { amount: ValueType.currency('USD'), penaltyAmount: ValueType.number() } },
      { type: 'IRA_WITHDRAWAL_EARNINGS_APPLY',  family: 'WITHDRAWAL', cc: 'US', fields: { amount: ValueType.currency('USD'), penaltyAmount: ValueType.number(), residency: ValueType.text() } },
      { type: 'IRA_WITHDRAWAL_EARNINGS_TAX',    fields: { amount: ValueType.currency('USD'), penaltyAmount: ValueType.number(), residency: ValueType.text() , stateKey: ValueType.text()} },
      { type: 'IRA_EARNINGS_APPLY',                     fields: { amount: ValueType.currency('USD'), stateKey: ValueType.text(), derivedAmount: ValueType.number() } },
      { type: 'IRA_ROLLOVER_WITHDRAWAL_APPLY',  family: 'WITHDRAWAL', cc: 'US', fields: { amount: ValueType.currency('USD'), residency: ValueType.text() } },
      { type: 'IRA_ROLLOVER_WITHDRAWAL_TAX',    fields: { amount: ValueType.currency('USD'), residency: ValueType.text() , stateKey: ValueType.text()} },
      { type: 'IRA_RMD_APPLY',                  family: 'WITHDRAWAL', cc: 'US', fields: { amount: ValueType.currency('USD'), residency: ValueType.text(), stateKey: ValueType.text() } },
      { type: 'IRA_RMD_TAX',                    fields: { amount: ValueType.currency('USD'), residency: ValueType.text() , stateKey: ValueType.text()} },
      // stateKey routes the credit to one member's 401(k); employerFunded marks a
      // match, which skips both the cash debit and the pre-tax deduction. Both must be
      // declared here or pickPayload drops them and the journal cannot tell a match
      // from a deferral.
      { type: 'K401_CONTRIBUTION_APPLY',                fields: { amount: ValueType.currency('USD'), stateKey: ValueType.text(), employerFunded: ValueType.boolean(), personKey: ValueType.text(), nonElective: ValueType.boolean(), clamps: ValueType.any() } },
      { type: 'K401_CONTRIBUTION_TAX',                  fields: { amount: ValueType.currency('USD') } },
      { type: 'K401_EARNINGS_APPLY',                    fields: { amount: ValueType.currency('USD'), stateKey: ValueType.text(), derivedAmount: ValueType.number() } },
      { type: 'K401_WITHDRAWAL_APPLY',          family: 'WITHDRAWAL', cc: 'US', fields: { amount: ValueType.currency('USD'), penaltyAmount: ValueType.number() } },
      { type: 'K401_WITHDRAWAL_TAX',            fields: { amount: ValueType.currency('USD'), penaltyAmount: ValueType.number() } },
      { type: 'K401_RMD_APPLY',                 family: 'WITHDRAWAL', cc: 'US', fields: { amount: ValueType.currency('USD'), residency: ValueType.text(), stateKey: ValueType.text() } },
      { type: 'K401_RMD_TAX',                   fields: { amount: ValueType.currency('USD'), residency: ValueType.text() , stateKey: ValueType.text()} },
      { type: 'K401_TO_IRA_CONVERSION_APPLY', family: 'WITHDRAWAL', cc: 'US', fields: { amount: ValueType.currency('USD') } },
      { type: 'GUARDRAIL_BASELINE_APPLY',   fields: { initialWithdrawalRate: ValueType.number(), portfolioValue: ValueType.number(), annualSpending: ValueType.number(), date: ValueType.any() } },
      { type: 'GUARDRAIL_ADJUST_APPLY',     fields: { multiplier: ValueType.number(), cause: ValueType.text(), date: ValueType.any() } },
      // personId — whose expense this is (design 89 spending-over-time). Stamped by
      // ExpenseEventHandler and already declared on the LATE_LIFE_CARE_APPLY sibling;
      // without it a per-person spending drill has nothing to group by. Must stay
      // identical to the AU_RETIREMENT declaration of this shared type.
      { type: 'EXPENSE_EVENT_APPLY',        fields: { amount: ValueType.number(), category: ValueType.text(), currency: ValueType.text(), propertyKey: ValueType.text(), capitalizeAmount: ValueType.number(), personId: ValueType.text() } },
      { type: 'HOUSE_REPAIR_APPLY',         fields: { stateKey: ValueType.text(), amount: ValueType.number(), capitalize: ValueType.number() } },
      { type: 'LATE_LIFE_CARE_APPLY',       fields: { active: ValueType.boolean(), factor: ValueType.number(), personId: ValueType.text() } },
      // ── Mortality family (design 27 step 7 / design 68) ──────────────────────
      // Every type MortalityHandler generates. These were registered NOWHERE until
      // design 91 §6: neither drift pass could see them (the static scan only checks
      // types some toolset already declares, and the 2-year detector run has no
      // deaths), and nothing failed because an unregistered type falls through to
      // Simulation's heuristic. That silence ends the moment the manifest gate is
      // wired — TypeRegistry._fallbackPayload THROWS under setStrict(true) — so a
      // strict run would have died on the first death rather than dropping a field.
      // Declared identically in AU_RETIREMENT, which owns the same reducers.
      { type: 'PERSON_DIED_APPLY',          fields: { personId: ValueType.text(), personName: ValueType.text(), date: ValueType.any(), taxJurisdiction: ValueType.text(), deceasedSocialSecurityMonthly: ValueType.number(), incomeSupportRecipient: ValueType.boolean() } },
      { type: 'ACCOUNT_RETITLE_APPLY',      fields: { deceasedId: ValueType.text(), survivorId: ValueType.text() } },
      { type: 'SOCIAL_SECURITY_SURVIVOR_APPLY', fields: { survivorId: ValueType.text(), deceasedSocialSecurityMonthly: ValueType.number() } },
      // `slice` + `reason` are what make a spending change explainable: without them
      // a guardrail cut and a survivor adjustment are the same anonymous delta.
      { type: 'SPENDING_STRATEGY_APPLY',    fields: { slice: ValueType.text(), delta: ValueType.number(), reason: ValueType.text() } },
      // Last-survivor AU super death benefit — `paidViaEstate` decides whether the 2%
      // Medicare levy rides on top of the 15% (design 68 Gap 4).
      { type: 'SUPER_DEATH_BENEFIT_APPLY',  fields: { stateKey: ValueType.text(), taxable: ValueType.number(), paidViaEstate: ValueType.boolean() } },
      { type: 'SCENARIO_COMPLETE_CHECK',    fields: {} },
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
        key: 'goldGrowthRate', label: 'Gold Growth Rate',
        type: 'Number', group: 'US Retirement', mc: true, opt: true,
        defaultValue: 0.05,
        description: 'Annual commodity growth rate for GOLD holdings (design 56 §7); decoupled from equity returns and central-bank Prime, taxed at the 28% collectibles rate on disposal.',
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
      // ── Payroll retirement contributions (the working years) ─────────────────
      // All default to 0 / null, so every pre-existing scenario schedules no
      // contribution event at all and is byte-identical.
      {
        key: 'k401DeferralPct', label: '401(k) Employee Deferral',
        type: 'Number', group: 'Contributions', mc: false, opt: true,
        defaultValue: 0,
        description: 'HOUSEHOLD DEFAULT for the employee 401(k) deferral, as a fraction of annual pay (0.10 = 10%). A Person\'s own election overrides it, and an explicit 0 on a Person opts them out entirely (design 95 §7.1). Pre-tax: it leaves the cash pool and reduces taxable income. Applies to every employed person until their retirement date.',
      },
      {
        key: 'k401EmployerMatchPct', label: '401(k) Employer Match',
        type: 'Number', group: 'Contributions', mc: false, opt: true,
        defaultValue: 0,
        description: 'HOUSEHOLD DEFAULT for the employer 401(k) match, as a fraction of annual pay; a Person\'s own election overrides it. Employer-funded: it never debits the household cash pool and is not the employee\'s deduction.',
      },
      {
        key: 'withholdingMethod', label: 'Payroll Withholding',
        type: 'Enum', group: 'Contributions', mc: false, opt: false,
        options: ['FICA_ONLY', 'NONE'],
        defaultValue: 'FICA_ONLY',
        description: 'How much of a US paycheque is withheld before it reaches the household. FICA_ONLY withholds Social Security and Medicare exactly — they are a rate times a base, so no estimate is involved — and leaves income tax to settle annually with the withholding credited against it. NONE credits the wage gross and settles everything annually (pre-design-95 behaviour). Income-tax withholding is not modelled: real withholding follows the Form W-4 / Pub 15-T tables, which this model does not carry.',
      },
      {
        key: 'k401MatchTiers', label: '401(k) Match Formula',
        type: 'Json', group: 'Contributions', mc: false, opt: false,
        defaultValue: null,
        description: 'HOUSEHOLD DEFAULT match formula as tiers, e.g. [{"matchRate":1,"uptoPctOfComp":0.03},{"matchRate":0.5,"uptoPctOfComp":0.02}] for the safe-harbor basic match (100% of the first 3%, 50% of the next 2%). Tiers consume the deferral in order, so someone deferring less than the band is matched only what they deferred. Empty falls back to the 401(k) Employer Match rate read as a 100% match on that first N% of pay.',
      },
      {
        key: 'k401NonElectivePct', label: '401(k) Non-Elective Contribution',
        type: 'Number', group: 'Contributions', mc: false, opt: true,
        defaultValue: 0,
        description: 'HOUSEHOLD DEFAULT employer contribution as a fraction of annual pay that does NOT depend on the employee deferring anything — a profit-sharing or safe-harbor non-elective contribution. This is not a match and is deliberately a separate field. Employer-funded, and it counts toward the §415(c) annual-additions limit.',
      },
      {
        key: 'k401AnnualCap', label: '401(k) Annual Cap',
        type: 'Money', group: 'Contributions', mc: false, opt: false,
        defaultValue: null, defaultCurrency: 'USD',
        description: 'HOUSEHOLD DEFAULT annual dollar cap, applied to the deferral and to the match separately; empty means uncapped. Overridden by a Person\'s own cap. A scenario-level assumption, NOT an indexed statutory limit \u2014 this model carries no \u00a7402(g) schedule.',
      },
      {
        key: 'iraAnnualContribution', label: 'IRA Annual Contribution',
        type: 'Money', group: 'Contributions', mc: false, opt: true,
        defaultValue: 0, defaultCurrency: 'USD',
        description: 'HOUSEHOLD DEFAULT deductible Traditional IRA contribution per employed person per year, overridden by a Person\'s own election; paid in twelfths from the cash pool.',
      },
      {
        key: 'rothAnnualContribution', label: 'Roth Annual Contribution',
        type: 'Money', group: 'Contributions', mc: false, opt: true,
        defaultValue: 0, defaultCurrency: 'USD',
        description: 'HOUSEHOLD DEFAULT after-tax Roth contribution per employed person per year, overridden by a Person\'s own election; paid in twelfths from the cash pool. No income phase-out is modelled.',
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
        key: 'monthlyExpensesCurrency', label: 'Expense Denomination',
        type: 'Enum', group: 'Spending', mc: false, opt: false,
        options: ['RESIDENCE', 'USD', 'AUD'],
        defaultValue: 'RESIDENCE',
        description: 'What currency the Monthly Expenses figure is a price IN. '
          + 'RESIDENCE (default) treats it as the cost of living in the country you live in: '
          + 'the figure is re-based once into the residence currency at the scenario anchor rate '
          + 'on a move, then indexed to that country’s CPI, and the exchange rate moves the '
          + 'COST OF FUNDING it rather than the standard of living. USD/AUD pin the figure to one '
          + 'currency and convert at spot each month, which for a household that moves country is '
          + 'inconsistent with the CPI indexation and reports far too little FX risk '
          + '(measured: 1.5% spending dispersion under USD vs 36% under RESIDENCE on a '
          + '44-year US→AU plan). Pin to a fixed currency only when the costs really are '
          + 'denominated there regardless of where you live.',
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
      // Cross-border drawdown mode (design 58 Lever A) is a scenario-level param
      // (INTL_RETIREMENT_PARAM_SCHEMA) — this toolset only *reads*
      // context.parameters.crossBorderDrawdown in state(). Declaring it here too
      // would duplicate the key (drift guard in intl-retirement-optimizer.test).
      {
        key: 'spendingStrategy', label: 'Spending Strategy',
        type: 'EnumMulti', group: 'Spending', mc: false, opt: true,
        options: ['FIXED', 'REGIME_AWARE', 'GUARDRAIL', 'EXPENSE_EVENTS', 'AGE_BANDED', 'EXPLICIT_BANDS'],
        defaultValue: ['FIXED'],
        description: 'Active spending strategies; FIXED = inflation-adjusted scalar (default), REGIME_AWARE = cut discretionary under economic-stress regimes, GUARDRAIL = Guyton-Klinger withdrawal-rate bands, EXPENSE_EVENTS = dated one-off expenses in a chosen currency, optionally funded from a nominated account (design 86 G8/G9; supersedes HEALTHCARE, which is now the `healthcare` category), AGE_BANDED = age-driven real spending smile (go-go/slow-go/no-go), EXPLICIT_BANDS = absolute monthly amount per age band (design 38 §6.1)',
      },
      ...SPENDING_STRATEGY_REGISTRY.REGIME_AWARE.paramSchema(),
      ...SPENDING_STRATEGY_REGISTRY.GUARDRAIL.paramSchema(),
      ...SPENDING_STRATEGY_REGISTRY.EXPENSE_EVENTS.paramSchema(),
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

    // One shared projector (see person-projection.js): this map used to be built
    // here field by field and had drifted from the cross-border toolset's copy,
    // silently dropping `residencyState` and taking US state income tax with it.
    const people = projectPeople(context.people, {
      defaultWageCurrency: 'USD', defaultCitizen: 'US',
    });

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
      // design 95 §10 phase 9 — 1.0 until the run passes the last published
      // contribution-limit year, then compounds the same effective inflation rate.
      limitIndexAccumulator: { US: 1.0 },
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
      // Cross-border drawdown policy read by AccountService.replenishSavings
      // (design 58 Lever A). LOCAL_FIRST: drain only same-country accounts to cover
      // a savings deficit, escalating to INTL_TRANSFER as a last resort (avoids an
      // FX wire on every top-up). GLOBAL: draw from accounts in either country in
      // one global drawdownPriority order, converting AUD↔USD per draw — lets any
      // strategy (incl. CUSTOM) honor the authored priority across the border.
      //
      // Now a standalone `crossBorderDrawdown` param: an explicit LOCAL_FIRST/GLOBAL
      // wins; AUTO (the default) and any unknown value preserve the legacy coupling
      // (TAX_EFFICIENT ⇒ GLOBAL, else LOCAL_FIRST), so existing scenarios are
      // byte-identical.
      crossBorderDrawdown:
        (p.crossBorderDrawdown === 'LOCAL_FIRST' || p.crossBorderDrawdown === 'GLOBAL')
          ? p.crossBorderDrawdown
          : (p.drawdownStrategy === 'TAX_EFFICIENT' ? 'GLOBAL' : 'LOCAL_FIRST'),
      // Within-tier draw policy read by AccountService.replenishSavings (design 58
      // Lever C). How accounts sharing one drawdown tier (equal effective priority)
      // split a draw: SEQUENTIAL (default) drains one fully before the next;
      // EQUAL splits evenly; PROPORTIONAL splits by available balance. An unknown
      // value falls back to SEQUENTIAL so existing scenarios are byte-identical.
      withinTierDraw:
        (p.withinTierDraw === 'EQUAL' || p.withinTierDraw === 'PROPORTIONAL')
          ? p.withinTierDraw
          : 'SEQUENTIAL',
      // Allocation-aware drawdown (design 65). The disposal primitive
      // (consumeHoldings) reads these to choose which sleeve/lots to sell for a
      // spending debit: drawdownSleeveOrder (Lever A) + drawdownLotStrategy (Lever B),
      // with the WEIGHTED sleeve order sorting classes by drawdownSleeveWeights. An
      // unknown value falls back to FIFO/FIFO so existing scenarios are byte-identical.
      drawdownSleeveOrder:
        SLEEVE_ORDER_MODES.includes(p.drawdownSleeveOrder) ? p.drawdownSleeveOrder : 'FIFO',
      drawdownLotStrategy:
        LOT_STRATEGIES.includes(p.drawdownLotStrategy) ? p.drawdownLotStrategy : 'FIFO',
      drawdownSleeveWeights: sleeveWeightsFromParams(p),
      // Lever C (design 65 §4-C) rebalance-coupling weight; 0 = off (byte-identical).
      drawdownRebalanceWeight: Number.isFinite(p.drawdownRebalanceWeight) ? p.drawdownRebalanceWeight : 0,
      // The SECURITY tier (design 94 step 6): security ids to sell out of first, in order.
      // Ids are scenario data, so nothing here can validate them against a registry that is
      // projected later at load — an id naming nothing simply ranks with the unlisted, which
      // is the same degradation `sleeveOrder` gives an absent class. Empty ⇒ absent ⇒ the
      // byte-identical FIFO path.
      // Spread, not a `?? null`: a scenario that names no security must gain NO state key
      // at all, so no whole-state fixture in the repo grows a line to say nothing (the same
      // "absent is absent" rule the security registry itself follows, design 94 §4.1).
      ...((Array.isArray(p.drawdownSecurityOrder) && p.drawdownSecurityOrder.length)
        ? { drawdownSecurityOrder: [...p.drawdownSecurityOrder] } : {}),
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
      // Design 95 §P0. `PAYROLL` supersedes `MONTHLY_WAGES`: same queue position,
      // same emission, but the handler behind it derives the whole month's payroll
      // in one pass rather than re-deriving "who is earning" in three places.
      EventBuilder.eventSeries()
        .name('Payroll').type('PAYROLL')
        .interval('month-end').enabled(true).color('#4CAF50').build(),
    ];

    if (personsWithSS.length > 0) {
      schedules.push(
        EventBuilder.eventSeries()
          .name('Monthly Social Security').type('MONTHLY_SS_INCOME')
          .interval('month-end').enabled(true).color('#3F51B5').build()
      );
    }

    // Payroll retirement contributions. `order(1)` puts them after wages AND expenses
    // (both order 0) on the same month-end: a deferral taken before the month's
    // spending can overdraw the cash pool and escalate into the drawdown cascade,
    // liquidating assets to fund a contribution.
    // Design 95 §P0: `PAYROLL_CONTRIBUTIONS` supersedes US_RETIREMENT_CONTRIBUTION
    // and AU_SUPER_GUARANTEE — one event, one order, both countries' streams. The
    // AU toolset attaches its own handler instance to this same event rather than
    // scheduling a second one.
    if (_hasPayrollContributions(context) && !context.schedulesById['PAYROLL_CONTRIBUTIONS']) {
      schedules.push(
        EventBuilder.eventSeries()
          .name('Payroll Contributions').type('PAYROLL_CONTRIBUTIONS')
          .interval('month-end').order(1).enabled(true).color('#00897B').build()
      );
    }

    // Regular house running cost (design 75 §5.1) — a monthly essential debit, scheduled only
    // when some property carries a positive cost so default scenarios stay byte-identical.
    if (_hasHouseRunningCost(context.realProperties)) {
      schedules.push(
        EventBuilder.eventSeries()
          .name('House Running Cost').type('HOUSE_RUNNING_COST')
          .interval('month-end').enabled(true).color('#8D6E63').build()
      );
    }

    // Stochastic house repairs (design 75 §5.2) — an annual seeded-RNG tick, `order(2)` so it
    // draws AFTER the equity (0) and property-return (1) ticks and never perturbs their
    // sequences. Scheduled only when a property has a repair model, so it draws nothing (and is
    // byte-identical) otherwise.
    if (_hasHouseRepairs(context.realProperties)) {
      schedules.push(
        EventBuilder.eventSeries()
          .name('House Repair').type('HOUSE_REPAIR')
          .interval('year-end').startOffset(1).order(2).enabled(true).color('#6D4C41').build()
      );
    }

    if (iraAccounts.length > 0) {
      schedules.push(
        EventBuilder.eventSeries()
          .name('IRA Earnings').type('INTL_IRA_EARNINGS')
          .interval('year-end').startOffset(0).enabled(true).color('#5C6BC0').build()
      );
      schedules.push(
        EventBuilder.eventSeries()
          .name('IRA Annual RMD').type('IRA_ANNUAL_RMD')
          .interval('year-end').startOffset(0).enabled(true).color('#E65100').build()
      );
    }

    if (rothAccounts.length > 0) {
      schedules.push(
        EventBuilder.eventSeries()
          .name('Roth IRA Earnings').type('INTL_ROTH_EARNINGS')
          .interval('year-end').startOffset(0).enabled(true).color('#7E57C2').build()
      );
    }

    if (k401Accounts.length > 0) {
      schedules.push(
        EventBuilder.eventSeries()
          .name('401k Earnings').type('INTL_K401_EARNINGS')
          .interval('year-end').startOffset(0).enabled(true).color('#42A5F5').build()
      );
      schedules.push(
        EventBuilder.eventSeries()
          .name('401k Annual RMD').type('K401_ANNUAL_RMD')
          .interval('year-end').startOffset(0).enabled(true).color('#BF360C').build()
      );
    }

    if (usStockAccounts.length > 0) {
      schedules.push(
        EventBuilder.eventSeries()
          .name('US Stock Earnings').type('INTL_STOCK_EARNINGS')
          .interval('year-end').startOffset(0).enabled(true).color('#26A69A').build()
      );
      schedules.push(
        EventBuilder.eventSeries()
          .name('US Stock Dividends').type('DIVIDEND_SCHEDULED')
          .interval('year-end').startOffset(0).enabled(true).color('#4CAF50').build()
      );
      // Semi-annual coupons (design 66 §G10a): fires on both half-year ends (Jun 30 /
      // Dec 31); each firing pays the per-holding fraction of the annual coupon
      // (`firingsPerYear` tells the handler the stream cadence). Real bonds pay
      // semi-annually; reinvested halves compound intra-year.
      schedules.push(
        EventBuilder.eventSeries()
          .name('Bond Coupons').type('INTL_BOND_COUPON')
          .interval('semiannual').startOffset(0).enabled(true).color('#8D6E63')
          .data({ firingsPerYear: 2 }).build()
      );
    }

    // Money-market yield on CASH sleeves of equity-served accounts (design 60).
    // One shared monthly stream; US + AU handlers (wired in this toolset and the AU
    // toolsets) subscribe to it. Scheduled when any equity-served account exists
    // (US brokerage/retirement or AU stock/super) since those accounts run off the
    // equity-growth earnings handler, which credits CASH no return of its own.
    const EQUITY_SERVED_ROLES = [
      ACCOUNT_ROLES.US_STOCK, ACCOUNT_ROLES.K401, ACCOUNT_ROLES.IRA, ACCOUNT_ROLES.ROTH,
      ACCOUNT_ROLES.AU_STOCK, ACCOUNT_ROLES.SUPER,
    ];
    if (accounts.some(a => EQUITY_SERVED_ROLES.includes(a.role))) {
      schedules.push(
        EventBuilder.eventSeries()
          .name('Cash Sleeve Interest').type('CASH_SLEEVE_INTEREST')
          .interval('month-end').enabled(true).color('#009688').build()
      );
      // Coupon interest on BOND sleeves of equity-served accounts (IRA/401k/Roth/
      // super/au-stock). One shared semi-annual stream (design 66 §G10a); the US
      // handlers here and the AU handlers (au-retirement toolset) subscribe to it.
      // US_STOCK brokerage bonds keep their own INTL_BOND_COUPON stream. Fires on both
      // half-year ends; `firingsPerYear` tells the handler to split each coupon.
      schedules.push(
        EventBuilder.eventSeries()
          .name('Bond Sleeve Coupons').type('BOND_SLEEVE_COUPON')
          .interval('semiannual').startOffset(0).enabled(true).color('#795548')
          .data({ firingsPerYear: 2 }).build()
      );
      // Non-cash bond accretion — zero-coupon/OID + TIPS inflation indexation
      // (design 66 §G5/§G6). One shared annual stream across brokerage + all
      // equity-served accounts (US handlers here, AU handlers in au-retirement); the
      // handler no-ops when an account holds no zero/TIPS bond. Annual, matching the
      // per-year OID / CPI accretion units.
      schedules.push(
        EventBuilder.eventSeries()
          .name('Bond Accretion').type('BOND_ACCRETION')
          .interval('year-end').startOffset(0).enabled(true).color('#6D4C41').build()
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

        // Legal gate: a 401(k) can only be rolled over to an IRA after separating
        // from the sponsoring employer. This model has a single job per person,
        // so separation is the owner's retirement date. Clamp any requested
        // conversion date that lands before retirement up to the retirement date —
        // an in-service rollover while still working is not permitted. Later dates
        // (deliberately delaying the rollover) are still honored.
        const requested = new Date(Date.UTC(year, month, day));
        const convDate  = requested < retirement ? retirement : requested;

        schedules.push(new OneOffEvent({
          name:    `401(k)→IRA Conversion (${owner.name})`,
          type:    'K401_TO_IRA_CONVERSION',
          date:    convDate,
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

    // One-off expenses — schedule EXPENSE_EVENT events from parameters
    // (design/26 step 16, generalized by design 86 G8/G9).
    if (strategies.includes('EXPENSE_EVENTS')) {
      for (const evt of p.expenseEvents ?? []) {
        if (!evt.date || !evt.amount) continue;
        schedules.push(buildExpenseEventSchedule(evt));
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
      expensesCurrency: p.monthlyExpensesCurrency ?? 'RESIDENCE',
      usRole:           ACCOUNT_ROLES.US_SAVINGS, usOwnerId: primaryId,
      auRole:           ACCOUNT_ROLES.AU_SAVINGS,  auOwnerId: primaryId,
    });
    expensesHandler.handledEvents.push(context.schedulesById['MONTHLY_EXPENSES']);
    handlers.push(expensesHandler);

    // House running cost (design 75 §5.1) — iterates ALL properties (both countries); the
    // debit is residence-aware and each property's base cost is converted from its own
    // currency. Only wired when the HOUSE_RUNNING_COST event was scheduled (a property has a
    // positive cost), so it is inert otherwise.
    const houseCostEvent = context.schedulesById['HOUSE_RUNNING_COST'];
    if (houseCostEvent) {
      const runningCostHandler = new HouseRunningCostHandler({
        stateRegistry:    sr,
        propertyKeys:     (context.realProperties ?? []).filter(pr => pr.stateKey).map(pr => pr.stateKey),
        usRole:           ACCOUNT_ROLES.US_SAVINGS, usOwnerId: primaryId,
        auRole:           ACCOUNT_ROLES.AU_SAVINGS,  auOwnerId: primaryId,
        startDate:        context.startDate,
      });
      runningCostHandler.handledEvents.push(houseCostEvent);
      handlers.push(runningCostHandler);
    }

    // Stochastic house repairs (design 75 §5.2) — annual seeded-RNG tick over all properties.
    const houseRepairEvent = context.schedulesById['HOUSE_REPAIR'];
    if (houseRepairEvent) {
      const repairHandler = new RealPropertyRepairTickHandler({
        stateRegistry:    sr,
        propertyKeys:     (context.realProperties ?? []).filter(pr => pr.stateKey).map(pr => pr.stateKey),
        usRole:           ACCOUNT_ROLES.US_SAVINGS, usOwnerId: primaryId,
        auRole:           ACCOUNT_ROLES.AU_SAVINGS,  auOwnerId: primaryId,
        // MC scalers (design 75 §6.4 B) — global multipliers on repair size/frequency, since the
        // per-property repair fields in cfg.realProperties can't be swept directly. Default 1 ⇒ inert.
        severityScale:    p.repairSeverityScale ?? 1,
        freqScale:        p.repairFreqScale     ?? 1,
      });
      repairHandler.handledEvents.push(houseRepairEvent);
      handlers.push(repairHandler);
    }

    // Payroll, stage INCOME (design 95 §P0) — the wage credits, at queue order 0.
    const wagesHandler = new PayrollHandler({
      stateRegistry: sr, stage: PAYROLL_STAGE.INCOME,
      withholding: p.withholdingMethod ?? WITHHOLDING_METHOD.FICA_ONLY,
      // Design 95 §9.1 phase 6b — yes, a US toolset reading an AU parameter, and it
      // is deliberate. The INCOME stage is country-AGNOSTIC: this one handler credits
      // both the USD and the AUD earners, and in a cross-border scenario it is the
      // only income-stage instance there is (AU_RETIREMENT's is behind
      // `_auSharedDelegated`). Salary sacrifice reduces an AUD wage at source, so
      // whichever toolset owns the wage must carry the rate. Without it a
      // cross-border household is paid in full and ALSO has the sacrifice land in
      // super — the same money twice, and no reduction in assessable income.
      //
      // It carries the AU elections but emits no AU stream: `_incomeActions` produces
      // wage credits only, and `_ownsAuStream` keeps the contribution stage's streams
      // with whichever instance actually owns them.
        // Design 95 §9.1 — the FULL AU election set, not just the sacrifice rate.
        // Sacrifice is rationed against the Div 291 cap ALONGSIDE the SG and the
        // personal deductible contribution, so an instance that knows only the
        // sacrifice rate rations it against an empty pool and arrives at a different
        // figure from the one the contributions stage will actually credit. The wage
        // was then reduced by one number and the fund credited with another, and the
        // difference simply vanished. Both stages must ration from the same inputs.
        superGuaranteePct:              p.superGuaranteePct                   ?? 0,
        superAnnualCap:                 p.superGuaranteeAnnualCap             ?? null,
        salarySacrificePct:             p.superSalarySacrificePct             ?? 0,
        personalDeductibleContribution: p.superPersonalDeductibleContribution ?? 0,
        nonConcessionalContribution:    p.superNonConcessionalContribution    ?? 0,
    });
    wagesHandler.handledEvents.push(context.schedulesById['PAYROLL']);
    handlers.push(wagesHandler);

    // Payroll, stage CONTRIBUTIONS — 401(k) deferral + employer match, IRA, Roth.
    // Queue order 1, i.e. after expenses AND after the savings-interest credit, which
    // reads the live balance. That ordering is load-bearing: see payroll-handler.js.
    const contribEvent = context.schedulesById['PAYROLL_CONTRIBUTIONS'];
    if (contribEvent) {
      const contribHandler = new PayrollHandler({
        stateRegistry:          sr,
        stage:                  PAYROLL_STAGE.CONTRIBUTIONS,
        k401DeferralPct:        p.k401DeferralPct        ?? 0,
        k401EmployerMatchPct:   p.k401EmployerMatchPct   ?? 0,
        k401MatchTiers:         p.k401MatchTiers         ?? null,
        k401NonElectivePct:     p.k401NonElectivePct     ?? 0,
        k401AnnualCap:          p.k401AnnualCap          ?? null,
        iraAnnualContribution:  p.iraAnnualContribution  ?? 0,
        rothAnnualContribution: p.rothAnnualContribution ?? 0,
      });
      contribHandler.handledEvents.push(contribEvent);
      handlers.push(contribHandler);
    }

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
          growthRate: acct.growthRate ?? p.iraGrowthRate,
          // Design 84 G2 — the derived (yield) slice of the wrapper's equity return.
          // Defaults to the plan's brokerage dividend rate so sheltered and taxable
          // equity are described consistently; per-holding `dividendYield` still wins.
          dividendYield: acct.dividendYield ?? p.brokerageDividendRate,
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
          growthRate: acct.growthRate ?? p.rothGrowthRate,
          // Design 84 G2 — the derived (yield) slice of the wrapper's equity return.
          // Defaults to the plan's brokerage dividend rate so sheltered and taxable
          // equity are described consistently; per-holding `dividendYield` still wins.
          dividendYield: acct.dividendYield ?? p.brokerageDividendRate,
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
          growthRate: acct.growthRate ?? p.k401GrowthRate,
          // Design 84 G2 — the derived (yield) slice of the wrapper's equity return.
          // Defaults to the plan's brokerage dividend rate so sheltered and taxable
          // equity are described consistently; per-holding `dividendYield` still wins.
          dividendYield: acct.dividendYield ?? p.brokerageDividendRate,
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

    // US Stock earnings + dividends + bond coupons
    const stockEvent  = context.schedulesById['INTL_STOCK_EARNINGS'];
    const divEvent    = context.schedulesById['DIVIDEND_SCHEDULED'];
    const couponEvent = context.schedulesById['INTL_BOND_COUPON'];
    if (stockEvent) {
      for (const acct of usStockAccounts) {
        const earningsH = new IntlUsStockEarningsHandler({
          stateRegistry: sr, role: ACCOUNT_ROLES.US_STOCK,
          ownerId: acct.ownerId, stateKey: acct.stateKey,
          growthRate: acct.growthRate ?? p.brokerageGrowthRate,
        });
        earningsH.handledEvents.push(stockEvent);
        handlers.push(earningsH);

        const divH = new DividendScheduledHandler({
          stateRegistry: sr, role: ACCOUNT_ROLES.US_STOCK,
          ownerId: acct.ownerId, stateKey: acct.stateKey,
          dividendRate: acct.dividendRate ?? p.brokerageDividendRate,
          reinvest:     p.dividendReinvest,
        });
        divH.handledEvents.push(divEvent);
        handlers.push(divH);

        // Bond coupon interest on any BOND holdings in this account (design 59).
        // Coupons come from each holding's couponRate; reinvest mirrors dividends.
        if (couponEvent) {
          const couponH = new BondCouponScheduledHandler({
            stateRegistry: sr, role: ACCOUNT_ROLES.US_STOCK,
            ownerId: acct.ownerId, stateKey: acct.stateKey,
            reinvest: p.dividendReinvest,
          });
          couponH.handledEvents.push(couponEvent);
          handlers.push(couponH);
        }
      }
    }

    // Money-market yield on CASH sleeves of equity-served accounts (design 60).
    // Brokerage (us-stock) cash interest is US ordinary income; retirement
    // (401k/IRA/Roth) cash interest is tax-deferred/free. Rate reuses the US
    // savings rate from effectiveInterestRates (regime- and per-account-aware),
    // compounded monthly by reinvesting into the cash sleeve.
    const cashInterestEvent = context.schedulesById['CASH_SLEEVE_INTEREST'];
    if (cashInterestEvent) {
      const usCashSleeveAccounts = [
        ...usStockAccounts.map(a => ({ acct: a, role: ACCOUNT_ROLES.US_STOCK, taxMode: 'us' })),
        ...k401Accounts.map(a  => ({ acct: a, role: ACCOUNT_ROLES.K401,     taxMode: 'deferred' })),
        ...iraAccounts.map(a   => ({ acct: a, role: ACCOUNT_ROLES.IRA,      taxMode: 'deferred' })),
        ...rothAccounts.map(a  => ({ acct: a, role: ACCOUNT_ROLES.ROTH,     taxMode: 'deferred' })),
      ];
      for (const { acct, role, taxMode } of usCashSleeveAccounts) {
        const h = new CashSleeveInterestHandler({
          stateRegistry: sr, role,
          ownerId: acct.ownerId, stateKey: acct.stateKey,
          interestRate: acct.interestRate ?? p.usSavingsInterestRate,
          taxMode,
        });
        h.handledEvents.push(cashInterestEvent);
        handlers.push(h);
      }
    }

    // Coupon interest on BOND sleeves of equity-served retirement accounts
    // (401k/IRA/Roth). These wrappers run off the equity-growth earnings handler,
    // which applies no return to BOND holdings, and — unlike US_STOCK brokerage,
    // served by INTL_BOND_COUPON — had no coupon stream, so a BOND sleeve here
    // (routinely established by the design-61 allocation lever) earned nothing.
    // US_STOCK is deliberately EXCLUDED (its bonds keep INTL_BOND_COUPON, no
    // double-count). All three wrappers are tax-deferred/free: the coupon grows
    // the balance and is taxed (or not, for Roth) on withdrawal.
    const bondCouponEvent = context.schedulesById['BOND_SLEEVE_COUPON'];
    if (bondCouponEvent) {
      const usBondSleeveAccounts = [
        ...k401Accounts.map(a => ({ acct: a, role: ACCOUNT_ROLES.K401, taxMode: 'deferred' })),
        ...iraAccounts.map(a  => ({ acct: a, role: ACCOUNT_ROLES.IRA,  taxMode: 'deferred' })),
        ...rothAccounts.map(a => ({ acct: a, role: ACCOUNT_ROLES.ROTH, taxMode: 'deferred' })),
      ];
      for (const { acct, role, taxMode } of usBondSleeveAccounts) {
        const h = new BondSleeveCouponHandler({
          stateRegistry: sr, role,
          ownerId: acct.ownerId, stateKey: acct.stateKey,
          couponRate: acct.interestRate ?? p.fixedIncomeInterestRate,
          taxMode,
        });
        h.handledEvents.push(bondCouponEvent);
        handlers.push(h);
      }
    }

    // Non-cash bond accretion — zero-coupon/OID + TIPS inflation indexation
    // (design 66 §G5/§G6) — across ALL US bond-capable accounts. Brokerage accretion
    // is US ordinary income ('us'); retirement wrappers (401k/IRA/Roth) defer it.
    // The handler no-ops when an account holds no accreting bond, so this is safe to
    // wire unconditionally alongside the coupon streams.
    const bondAccretionEvent = context.schedulesById['BOND_ACCRETION'];
    if (bondAccretionEvent) {
      const usAccretionAccounts = [
        ...usStockAccounts.map(a => ({ acct: a, role: ACCOUNT_ROLES.US_STOCK, taxMode: 'us' })),
        ...k401Accounts.map(a  => ({ acct: a, role: ACCOUNT_ROLES.K401,     taxMode: 'deferred' })),
        ...iraAccounts.map(a   => ({ acct: a, role: ACCOUNT_ROLES.IRA,      taxMode: 'deferred' })),
        ...rothAccounts.map(a  => ({ acct: a, role: ACCOUNT_ROLES.ROTH,     taxMode: 'deferred' })),
      ];
      for (const { acct, role, taxMode } of usAccretionAccounts) {
        const h = new BondAccretionHandler({
          stateRegistry: sr, role,
          ownerId: acct.ownerId, stateKey: acct.stateKey,
          country: 'US', taxMode,
        });
        h.handledEvents.push(bondAccretionEvent);
        handlers.push(h);
      }
    }

    // Fixed income interest
    const fiEvent = context.schedulesById['INTL_FIXED_INCOME_INTEREST'];
    if (fiEvent) {
      for (const acct of fixedIncomeAccounts) {
        const h = new FixedIncomeInterestHandler({
          stateRegistry: sr, role: ACCOUNT_ROLES.FIXED_INCOME,
          ownerId: acct.ownerId, stateKey: acct.stateKey,
          interestRate: acct.interestRate ?? p.fixedIncomeInterestRate,
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

    // One-off expenses — ExpenseEventHandler fires on EXPENSE_EVENT (design 86 G8/G9).
    if (strategiesH.includes('EXPENSE_EVENTS')) {
      const expEvents = Object.values(context.schedulesById).filter(e => e?.type === 'EXPENSE_EVENT');
      if (expEvents.length > 0) {
        const expH = new ExpenseEventHandler({
          stateRegistry: sr,
          expensesCurrency: p.monthlyExpensesCurrency ?? 'RESIDENCE',
          usRole: ACCOUNT_ROLES.US_SAVINGS, usOwnerId: primaryId,
          auRole: ACCOUNT_ROLES.AU_SAVINGS,  auOwnerId: primaryId,
        });
        for (const evt of expEvents) expH.handledEvents.push(evt);
        handlers.push(expH);
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

    reducers.push(new ExpenseDebitReducer({ accountService: accountSvc, stateRegistry: sr }));
    reducers.push(new HouseRepairApplyReducer());   // design 75 §5.2 — tracking + capitalize basis
    reducers.push(new ReplenishSavingsReducer({ accountService: accountSvc, stateRegistry: sr }));

    if (usStockAccounts.length > 0) {
      reducers.push(new StockDividendCashApplyReducer({
        accountService: accountSvc, stateRegistry: sr,
        role: ACCOUNT_ROLES.US_SAVINGS, ownerId: primaryId,
      }));
      reducers.push(new BondCouponCashApplyReducer({
        accountService: accountSvc, stateRegistry: sr,
        role: ACCOUNT_ROLES.US_SAVINGS, ownerId: primaryId,
      }));
    }

    // Cash-sleeve money-market interest (design 60). One reducer serves all
    // equity-served accounts (US + AU); it branches on the action's taxMode, so it
    // is registered whenever any such account exists — including AU-only ones whose
    // handlers are wired in the AU toolsets.
    const EQUITY_SERVED_ROLES = [
      ACCOUNT_ROLES.US_STOCK, ACCOUNT_ROLES.K401, ACCOUNT_ROLES.IRA, ACCOUNT_ROLES.ROTH,
      ACCOUNT_ROLES.AU_STOCK, ACCOUNT_ROLES.SUPER,
    ];
    if (accounts.some(a => EQUITY_SERVED_ROLES.includes(a.role))) {
      reducers.push(new CashSleeveInterestApplyReducer({ accountService: accountSvc, stateRegistry: sr }));
      reducers.push(new BondSleeveCouponApplyReducer({ accountService: accountSvc, stateRegistry: sr }));
      // Non-cash bond accretion apply (design 66 §G5/§G6). One reducer for all
      // bond-capable accounts (US + AU); branches on the action's taxMode.
      reducers.push(new BondAccretionApplyReducer({ accountService: accountSvc, stateRegistry: sr }));
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
      new RothContributionApplyReducer({ accountService: accountSvc, stateRegistry: sr }),
      new RothWithdrawalContribApplyReducer({ accountService: accountSvc, stateRegistry: sr }),
      new RothWithdrawalEarningsApplyReducer({ accountService: accountSvc, stateRegistry: sr }),
      new RothEarningsApplyReducer({ accountService: accountSvc, stateRegistry: sr }),
      new RothRolloverContributionApplyReducer({ accountService: accountSvc, stateRegistry: sr }),
      new RothRolloverEarningsApplyReducer({ accountService: accountSvc, stateRegistry: sr }),
      new RothRolloverWithdrawalContribApplyReducer({ accountService: accountSvc, stateRegistry: sr }),
      new RothRolloverWithdrawalEarningsApplyReducer({ accountService: accountSvc, stateRegistry: sr }),
    );

    // Traditional IRA mechanics
    if (iraAccounts.length > 0) reducers.push(
      new IraContributionApplyReducer({ accountService: accountSvc, stateRegistry: sr }),
      new IraWithdrawalContribApplyReducer({ accountService: accountSvc, stateRegistry: sr }),
      new IraWithdrawalEarningsApplyReducer({ accountService: accountSvc, stateRegistry: sr }),
      new IraEarningsApplyReducer({ accountService: accountSvc, stateRegistry: sr }),
      new IraRolloverWithdrawalApplyReducer({ accountService: accountSvc, stateRegistry: sr }),
      new IraRmdApplyReducer({ accountService: accountSvc, stateRegistry: sr }),
    );

    // 401(k) mechanics
    if (k401Accounts.length > 0) reducers.push(
      new K401ContributionApplyReducer({ accountService: accountSvc, stateRegistry: sr }),
      new K401EarningsApplyReducer({ accountService: accountSvc, stateRegistry: sr }),
      new K401WithdrawalApplyReducer({ accountService: accountSvc, stateRegistry: sr }),
      new K401RmdApplyReducer({ accountService: accountSvc, stateRegistry: sr }),
    );

    // 401(k)→IRA conversion (no cash pool / tax — direct rollover)
    if (k401Accounts.length > 0 && iraAccounts.length > 0) {
      reducers.push(new K401ToIraConversionApplyReducer({ accountService: accountSvc, stateRegistry: sr }));
    }

    // Mortality reducers (design/27 Step 7).
    const mortalityEnabledR = p.mortalityEnabled ?? true;
    if (mortalityEnabledR) {
      reducers.push(new PersonDiedApplyReducer());
      reducers.push(new SocialSecuritySurvivorApplyReducer());
      reducers.push(new AccountRetitleApplyReducer());
      reducers.push(new SuperDeathBenefitApplyReducer());
      reducers.push(new ScenarioCompleteReducer());

      // Late-life care reducer (design/27 Increment 2).
      if ((p.lateLifeCareMonths ?? 0) > 0) {
        reducers.push(new LateLifeCareApplyReducer());
      }
    }

    return reducers;
  },
};
