/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseAccountModule } from '../base-account-module.js';
import { PRIORITY } from '../../../simulation-framework/reducers.js';
import { RecordArrayMetricAction, RecordBalanceAction } from '../../../simulation-framework/actions.js';


/** Returns age in whole years as of asOfDate. */
function getAge(birthDate, asOfDate) {
  const years = asOfDate.getUTCFullYear() - birthDate.getUTCFullYear();
  const hadBirthday =
    asOfDate.getUTCMonth() > birthDate.getUTCMonth() ||
    (asOfDate.getUTCMonth() === birthDate.getUTCMonth() &&
     asOfDate.getUTCDate() >= birthDate.getUTCDate());
  return hadBirthday ? years : years - 1;
}

/** Returns age as a decimal (years + fractional months) for the 59.5 threshold. */
function getAgeDecimal(birthDate, asOfDate) {
  const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
  return (asOfDate - birthDate) / msPerYear;
}

const US_PRIMARY_HOME_EXEMPTION = 500_000;

/** Resolve the US cash pool: usSavingsAccount in intl scenarios, checkingAccount in single-account tests. */
const usCash = (state) => state.usSavingsAccount ?? state.checkingAccount;

/**
 * UsAccountModule2026 — US account mechanics rules for 2026.
 *
 * Registers Stage-1 (CASH_FLOW priority) reducers and event handlers for all
 * US account types.  Each reducer that produces a tax effect emits a _TAX child
 * action via next:[] for the US tax module to handle.
 *
 * Covered events:
 *   EVT-1 to 4   Roth IRA
 *   EVT-5 to 8   Traditional IRA
 *   EVT-9 to 15  US Brokerage (fixed income + stocks)
 *   EVT-24/25    401k
 *   EVT-34       US House Sale
 */
export class UsAccountModule2026 extends BaseAccountModule {
  get countryCode() { return 'US'; }
  get year()        { return 2026; }

  registerWith(sim, svc) {
    this._registerRoth(sim, svc);
    this._registerIra(sim, svc);
    this._register401k(sim, svc);
    this._registerUsBrokerage(sim, svc);
    this._registerRealProperty(sim, svc);
  }

  // ── Roth IRA ──────────────────────────────────────────────────────────────

  _registerRoth(sim, svc) {
    // EVT-1: contribution — debit checking, credit contributionBasis, no tax
    sim.reducers.register('ROTH_CONTRIBUTION_APPLY', (state, action) => {
      svc.transaction(usCash(state), -action.amount, null);
      const ra = state.rothAccount;
      return {
        ...state,
        rothAccount: {
          ...ra,
          balance:           ra.balance           + action.amount,
          contributionBasis: ra.contributionBasis + action.amount,
        },
      };
    }, PRIORITY.CASH_FLOW, 'Roth Contribution Apply');

    // EVT-2: withdrawal of contributions — credit checking, debit contributionBasis, no tax
    sim.reducers.register('ROTH_WITHDRAWAL_CONTRIB_APPLY', (state, action) => {
      svc.transaction(usCash(state), action.amount, null);
      const ra = state.rothAccount;
      return {
        ...state,
        rothAccount: {
          ...ra,
          balance:           ra.balance           - action.amount,
          contributionBasis: ra.contributionBasis - action.amount,
        },
      };
    }, PRIORITY.CASH_FLOW, 'Roth Contribution Withdrawal Apply');

    // EVT-3: withdrawal of earnings — credit checking (minus penalty), debit earningsBasis
    //        chains ROTH_WITHDRAWAL_EARNINGS_TAX for penalty + optional AU tax
    sim.reducers.register('ROTH_WITHDRAWAL_EARNINGS_APPLY', (state, action) => {
      const { amount, penaltyAmount, isAuResident } = action;
      svc.transaction(usCash(state), amount - penaltyAmount, null);
      const ra = state.rothAccount;
      return {
        state: {
          ...state,
          rothAccount: {
            ...ra,
            balance:       ra.balance       - amount,
            earningsBasis: ra.earningsBasis - amount,
          },
        },
        next: [{ type: 'ROTH_WITHDRAWAL_EARNINGS_TAX', amount, penaltyAmount, isAuResident }],
      };
    }, PRIORITY.CASH_FLOW, 'Roth Withdrawal Earnings Apply');

    // EVT-4: earnings — stay in account, no tax
    sim.reducers.register('ROTH_EARNINGS_APPLY', (state, action) => {
      const ra = state.rothAccount;
      return {
        ...state,
        rothAccount: {
          ...ra,
          balance:       ra.balance       + action.amount,
          earningsBasis: ra.earningsBasis + action.amount,
        },
      };
    }, PRIORITY.CASH_FLOW, 'Roth Earnings Apply');

    sim.register('ROTH_CONTRIBUTION', ({ data }) => [
      { type: 'ROTH_CONTRIBUTION_APPLY', amount: data.amount },
      new RecordArrayMetricAction('roth_contribution', data.amount),
      new RecordBalanceAction(),
    ]);

    sim.register('ROTH_WITHDRAWAL_CONTRIBUTIONS', ({ data }) => [
      { type: 'ROTH_WITHDRAWAL_CONTRIB_APPLY', amount: data.amount },
      new RecordArrayMetricAction('roth_withdrawal_contributions', data.amount),
      new RecordBalanceAction(),
    ]);

    sim.register('ROTH_WITHDRAWAL_EARNINGS', ({ date, state, data }) => {
      const age     = getAge(state.personBirthDate, date);
      const penalty = age < 60 ? data.amount * 0.10 : 0;
      return [
        { type: 'ROTH_WITHDRAWAL_EARNINGS_APPLY',
          amount: data.amount,
          penaltyAmount: penalty,
          isAuResident: state.isAuResident,
        },
        new RecordArrayMetricAction('roth_withdrawal_earnings', data.amount),
        new RecordBalanceAction(),
      ];
    });

    sim.register('ROTH_EARNINGS', ({ data }) => [
      { type: 'ROTH_EARNINGS_APPLY', amount: data.amount },
      new RecordArrayMetricAction('roth_earnings', data.amount),
      new RecordBalanceAction(),
    ]);
  }

  // ── Traditional IRA ───────────────────────────────────────────────────────

  _registerIra(sim, svc) {
    // EVT-5: contribution — debit checking, credit contributionBasis
    //        chains IRA_CONTRIBUTION_TAX (US negative income)
    sim.reducers.register('IRA_CONTRIBUTION_APPLY', (state, action) => {
      svc.transaction(usCash(state), -action.amount, null);
      const ia = state.iraAccount;
      return {
        state: {
          ...state,
          iraAccount: {
            ...ia,
            balance:           ia.balance           + action.amount,
            contributionBasis: ia.contributionBasis + action.amount,
          },
        },
        next: [{ type: 'IRA_CONTRIBUTION_TAX', amount: action.amount }],
      };
    }, PRIORITY.CASH_FLOW, 'IRA Contribution Apply');

    // EVT-6: withdrawal of contributions — credit checking (minus penalty), debit contributionBasis
    //        chains IRA_WITHDRAWAL_CONTRIB_TAX (US ordinary income + penalty)
    sim.reducers.register('IRA_WITHDRAWAL_CONTRIB_APPLY', (state, action) => {
      const { amount, penaltyAmount } = action;
      svc.transaction(usCash(state), amount - penaltyAmount, null);
      const ia = state.iraAccount;
      return {
        state: {
          ...state,
          iraAccount: {
            ...ia,
            balance:           ia.balance           - amount,
            contributionBasis: ia.contributionBasis - amount,
          },
        },
        next: [{ type: 'IRA_WITHDRAWAL_CONTRIB_TAX', amount, penaltyAmount }],
      };
    }, PRIORITY.CASH_FLOW, 'IRA Contribution Withdrawal Apply');

    // EVT-7: withdrawal of earnings — credit checking (minus penalty), debit earningsBasis
    //        chains IRA_WITHDRAWAL_EARNINGS_TAX (US ordinary income + penalty + optional AU)
    sim.reducers.register('IRA_WITHDRAWAL_EARNINGS_APPLY', (state, action) => {
      const { amount, penaltyAmount, isAuResident } = action;
      svc.transaction(usCash(state), amount - penaltyAmount, null);
      const ia = state.iraAccount;
      return {
        state: {
          ...state,
          iraAccount: {
            ...ia,
            balance:       ia.balance       - amount,
            earningsBasis: ia.earningsBasis - amount,
          },
        },
        next: [{ type: 'IRA_WITHDRAWAL_EARNINGS_TAX', amount, penaltyAmount, isAuResident }],
      };
    }, PRIORITY.CASH_FLOW, 'IRA Withdrawal Earnings Apply');

    // EVT-8: earnings — stay in account, no tax
    sim.reducers.register('IRA_EARNINGS_APPLY', (state, action) => {
      const ia = state.iraAccount;
      return {
        ...state,
        iraAccount: {
          ...ia,
          balance:       ia.balance       + action.amount,
          earningsBasis: ia.earningsBasis + action.amount,
        },
      };
    }, PRIORITY.CASH_FLOW, 'IRA Earnings Apply');

    sim.register('IRA_CONTRIBUTION', ({ data }) => [
      { type: 'IRA_CONTRIBUTION_APPLY', amount: data.amount },
      new RecordArrayMetricAction('ira_contribution', data.amount),
      new RecordBalanceAction(),
    ]);

    sim.register('IRA_WITHDRAWAL_CONTRIBUTIONS', ({ date, state, data }) => {
      const age     = getAge(state.personBirthDate, date);
      const penalty = age < 60 ? data.amount * 0.10 : 0;
      return [
        { type: 'IRA_WITHDRAWAL_CONTRIB_APPLY', amount: data.amount, penaltyAmount: penalty },
        new RecordArrayMetricAction('ira_withdrawal_contributions', data.amount),
        new RecordBalanceAction(),
      ];
    });

    sim.register('IRA_WITHDRAWAL_EARNINGS', ({ date, state, data }) => {
      const age     = getAge(state.personBirthDate, date);
      const penalty = age < 60 ? data.amount * 0.10 : 0;
      return [
        { type: 'IRA_WITHDRAWAL_EARNINGS_APPLY',
          amount: data.amount,
          penaltyAmount: penalty,
          isAuResident: state.isAuResident,
        },
        new RecordArrayMetricAction('ira_withdrawal_earnings', data.amount),
        new RecordBalanceAction(),
      ];
    });

    sim.register('IRA_EARNINGS', ({ data }) => [
      { type: 'IRA_EARNINGS_APPLY', amount: data.amount },
      new RecordArrayMetricAction('ira_earnings', data.amount),
      new RecordBalanceAction(),
    ]);
  }

  // ── 401k ──────────────────────────────────────────────────────────────────

  _register401k(sim, svc) {
    // EVT-24: contribution — debit checking, credit contributionBasis
    //         chains K401_CONTRIBUTION_TAX (US negative income)
    sim.reducers.register('K401_CONTRIBUTION_APPLY', (state, action) => {
      svc.transaction(usCash(state), -action.amount, null);
      const ka = state.k401Account;
      return {
        state: {
          ...state,
          k401Account: {
            ...ka,
            balance:           ka.balance           + action.amount,
            contributionBasis: ka.contributionBasis + action.amount,
          },
        },
        next: [{ type: 'K401_CONTRIBUTION_TAX', amount: action.amount }],
      };
    }, PRIORITY.CASH_FLOW, '401k Contribution Apply');

    // EVT-25 (accrual): earnings — stay in account, no immediate tax (deferred to withdrawal)
    sim.reducers.register('K401_EARNINGS_APPLY', (state, action) => {
      const ka = state.k401Account;
      return {
        ...state,
        k401Account: {
          ...ka,
          balance:       ka.balance       + action.amount,
          earningsBasis: ka.earningsBasis + action.amount,
        },
      };
    }, PRIORITY.CASH_FLOW, '401k Earnings Apply');

    // EVT-25 (withdrawal): credit checking (minus penalty), debit account
    //                      chains K401_WITHDRAWAL_TAX (US ordinary income + penalty)
    sim.reducers.register('K401_WITHDRAWAL_APPLY', (state, action) => {
      const { amount, penaltyAmount } = action;
      svc.transaction(usCash(state), amount - penaltyAmount, null);
      const ka = state.k401Account;
      const fromEarnings = Math.min(amount, ka.earningsBasis);
      const fromContrib  = amount - fromEarnings;
      return {
        state: {
          ...state,
          k401Account: {
            ...ka,
            balance:           ka.balance           - amount,
            earningsBasis:     ka.earningsBasis     - fromEarnings,
            contributionBasis: ka.contributionBasis - fromContrib,
          },
        },
        next: [{ type: 'K401_WITHDRAWAL_TAX', amount, penaltyAmount }],
      };
    }, PRIORITY.CASH_FLOW, '401k Withdrawal Apply');

    sim.register('K401_CONTRIBUTION', ({ data }) => [
      { type: 'K401_CONTRIBUTION_APPLY', amount: data.amount },
      new RecordBalanceAction(),
    ]);

    sim.register('K401_EARNINGS', ({ data }) => [
      { type: 'K401_EARNINGS_APPLY', amount: data.amount },
      new RecordBalanceAction(),
    ]);

    // EVT-25 withdrawal handler — 10% penalty if under age 59.5
    sim.register('K401_WITHDRAWAL', ({ date, state, data }) => {
      const age     = getAgeDecimal(state.personBirthDate, date);
      const penalty = age < 59.5 ? data.amount * 0.10 : 0;
      return [
        { type: 'K401_WITHDRAWAL_APPLY', amount: data.amount, penaltyAmount: penalty },
        new RecordBalanceAction(),
      ];
    });
  }

  // ── US Brokerage ──────────────────────────────────────────────────────────

  _registerUsBrokerage(sim, svc) {
    // EVT-9: fixed income contribution — debit checking, credit account, no tax
    sim.reducers.register('FIXED_INCOME_CONTRIBUTION_APPLY', (state, action) => {
      svc.transaction(usCash(state), -action.amount, null);
      return {
        ...state,
        fixedIncomeAccount: { ...state.fixedIncomeAccount, balance: state.fixedIncomeAccount.balance + action.amount },
      };
    }, PRIORITY.CASH_FLOW, 'Fixed Income Contribution Apply');

    // EVT-10: fixed income withdrawal — debit account, credit checking, no tax
    sim.reducers.register('FIXED_INCOME_WITHDRAWAL_APPLY', (state, action) => {
      svc.transaction(usCash(state), action.amount, null);
      return {
        ...state,
        fixedIncomeAccount: { ...state.fixedIncomeAccount, balance: state.fixedIncomeAccount.balance - action.amount },
      };
    }, PRIORITY.CASH_FLOW, 'Fixed Income Withdrawal Apply');

    // EVT-11: fixed income earnings — stay in account
    //         chains FIXED_INCOME_EARNINGS_TAX (US ordinary income, AU ordinary if resident)
    sim.reducers.register('FIXED_INCOME_EARNINGS_APPLY', (state, action) => {
      const { amount, isAuResident } = action;
      return {
        state: {
          ...state,
          fixedIncomeAccount: { ...state.fixedIncomeAccount, balance: state.fixedIncomeAccount.balance + amount },
        },
        next: [{ type: 'FIXED_INCOME_EARNINGS_TAX', amount, isAuResident }],
      };
    }, PRIORITY.CASH_FLOW, 'Fixed Income Earnings Apply');

    // EVT-12: stock contribution — debit checking, credit contributionBasis, no tax
    sim.reducers.register('STOCK_CONTRIBUTION_APPLY', (state, action) => {
      svc.transaction(usCash(state), -action.amount, null);
      const sa = state.stockAccount;
      return {
        ...state,
        stockAccount: {
          ...sa,
          balance:           sa.balance           + action.amount,
          contributionBasis: sa.contributionBasis + action.amount,
        },
      };
    }, PRIORITY.CASH_FLOW, 'Stock Contribution Apply');

    // EVT-13: stock dividend — stays in account, increases both bases
    //         chains STOCK_DIVIDEND_TAX (US ordinary income, AU ordinary if resident)
    sim.reducers.register('STOCK_DIVIDEND_APPLY', (state, action) => {
      const { amount, isAuResident } = action;
      const sa = state.stockAccount;
      return {
        state: {
          ...state,
          stockAccount: {
            ...sa,
            balance:           sa.balance           + amount,
            contributionBasis: sa.contributionBasis + amount,
            earningsBasis:     sa.earningsBasis     + amount,
          },
        },
        next: [{ type: 'STOCK_DIVIDEND_TAX', amount, isAuResident }],
      };
    }, PRIORITY.CASH_FLOW, 'Stock Dividend Apply');

    // EVT-14: stock earnings (unrealized) — stay in account, no tax
    sim.reducers.register('STOCK_EARNINGS_APPLY', (state, action) => {
      const sa = state.stockAccount;
      return {
        ...state,
        stockAccount: {
          ...sa,
          balance:       sa.balance       + action.amount,
          earningsBasis: sa.earningsBasis + action.amount,
        },
      };
    }, PRIORITY.CASH_FLOW, 'Stock Earnings Apply');

    // EVT-15: stock withdrawal (sale) — credit checking with sale proceeds, debit account
    //         chains STOCK_WITHDRAWAL_TAX (US capital gain, AU capital gain if resident)
    sim.reducers.register('STOCK_WITHDRAWAL_APPLY', (state, action) => {
      const { salePrice, costBasis, isAuResident } = action;
      const gain = Math.max(0, salePrice - costBasis);
      svc.transaction(usCash(state), salePrice, null);
      const sa = state.stockAccount;
      const newBalance  = sa.balance - salePrice;
      const newEarnings = Math.max(0, sa.earningsBasis - gain);
      const newContrib  = newBalance - newEarnings;
      return {
        state: {
          ...state,
          stockAccount: {
            ...sa,
            balance:           newBalance,
            contributionBasis: newContrib,
            earningsBasis:     newEarnings,
          },
        },
        next: [{ type: 'STOCK_WITHDRAWAL_TAX', gain, isAuResident }],
      };
    }, PRIORITY.CASH_FLOW, 'Stock Withdrawal Apply');

    sim.register('FIXED_INCOME_CONTRIBUTION', ({ data }) => [
      { type: 'FIXED_INCOME_CONTRIBUTION_APPLY', amount: data.amount },
      new RecordBalanceAction(),
    ]);

    sim.register('FIXED_INCOME_WITHDRAWAL', ({ data }) => [
      { type: 'FIXED_INCOME_WITHDRAWAL_APPLY', amount: data.amount },
      new RecordBalanceAction(),
    ]);

    sim.register('FIXED_INCOME_EARNINGS', ({ data, state }) => [
      { type: 'FIXED_INCOME_EARNINGS_APPLY', amount: data.amount, isAuResident: state.isAuResident },
      new RecordBalanceAction(),
    ]);

    sim.register('STOCK_CONTRIBUTION', ({ data }) => [
      { type: 'STOCK_CONTRIBUTION_APPLY', amount: data.amount },
      new RecordBalanceAction(),
    ]);

    sim.register('STOCK_DIVIDEND', ({ data, state }) => [
      { type: 'STOCK_DIVIDEND_APPLY', amount: data.amount, isAuResident: state.isAuResident },
      new RecordBalanceAction(),
    ]);

    sim.register('STOCK_EARNINGS', ({ data }) => [
      { type: 'STOCK_EARNINGS_APPLY', amount: data.amount },
      new RecordBalanceAction(),
    ]);

    sim.register('STOCK_WITHDRAWAL', ({ data, state }) => [
      { type: 'STOCK_WITHDRAWAL_APPLY',
        salePrice:    data.salePrice,
        costBasis:    data.costBasis,
        isAuResident: state.isAuResident,
      },
      new RecordBalanceAction(),
    ]);
  }

  // ── Real Property ─────────────────────────────────────────────────────────

  _registerRealProperty(sim, svc) {
    // EVT-34: US house sale — credit checking, compute taxable gain after $500K exemption
    //         chains US_HOUSE_SALE_TAX
    //         AU tax treatment is unresolved (TODO: CSV "??") — not chained to AU tax
    sim.reducers.register('US_HOUSE_SALE_APPLY', (state, action) => {
      const { salePrice, costBasis } = action;
      const rawGain     = Math.max(0, salePrice - costBasis);
      const taxableGain = Math.max(0, rawGain - US_PRIMARY_HOME_EXEMPTION);
      svc.transaction(usCash(state), salePrice, null);
      return {
        state: { ...state },
        next: [{ type: 'US_HOUSE_SALE_TAX', taxableGain }],
      };
    }, PRIORITY.CASH_FLOW, 'US House Sale Apply');

    sim.register('US_HOUSE_SALE', ({ data, state }) => [
      { type: 'US_HOUSE_SALE_APPLY',
        salePrice:    data.salePrice,
        costBasis:    data.costBasis,
        isAuResident: state.isAuResident,
      },
      new RecordBalanceAction(),
    ]);
  }
}
