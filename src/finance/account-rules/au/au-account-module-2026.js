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
import { RecordBalanceAction } from '../../../simulation-framework/actions.js';

/** Returns age in whole years as of asOfDate. */
function getAge(birthDate, asOfDate) {
  const years = asOfDate.getUTCFullYear() - birthDate.getUTCFullYear();
  const hadBirthday =
    asOfDate.getUTCMonth() > birthDate.getUTCMonth() ||
    (asOfDate.getUTCMonth() === birthDate.getUTCMonth() &&
     asOfDate.getUTCDate() >= birthDate.getUTCDate());
  return hadBirthday ? years : years - 1;
}

/**
 * AuAccountModule2026 — AU account mechanics rules for 2026.
 *
 * Registers Stage-1 (CASH_FLOW priority) reducers and event handlers for all
 * AU account types.  Each reducer that produces a tax effect emits a _TAX child
 * action via next:[] for the AU tax module to handle.
 *
 * Covered events:
 *   EVT-16 to 19  AU Savings
 *   EVT-20 to 23  Superannuation
 *   EVT-26 to 32  AU Brokerage
 *   EVT-33        AU House Sale
 */
export class AuAccountModule2026 extends BaseAccountModule {
  get countryCode() { return 'AU'; }
  get year()        { return 2026; }

  registerWith(sim, svc) {
    this._registerAuSavings(sim, svc);
    this._registerSuper(sim, svc);
    this._registerAuBrokerage(sim, svc);
    this._registerRealProperty(sim, svc);
  }

  // ── AU Savings ────────────────────────────────────────────────────────────

  _registerAuSavings(sim, svc) {
    // EVT-16: contribution — debit checking, credit AU savings, no tax
    sim.reducers.register('AU_SAVINGS_CONTRIBUTION_APPLY', (state, action) => {
      svc.transaction(state.checkingAccount, -action.amount, null);
      return {
        ...state,
        auSavingsAccount: { balance: state.auSavingsAccount.balance + action.amount },
      };
    }, PRIORITY.CASH_FLOW, 'AU Savings Contribution Apply');

    // EVT-17: withdrawal — debit AU savings, credit checking, no tax
    sim.reducers.register('AU_SAVINGS_WITHDRAWAL_APPLY', (state, action) => {
      svc.transaction(state.checkingAccount, action.amount, null);
      return {
        ...state,
        auSavingsAccount: { balance: state.auSavingsAccount.balance - action.amount },
      };
    }, PRIORITY.CASH_FLOW, 'AU Savings Withdrawal Apply');

    // EVT-18/19: earnings — stay in account
    //            chains AU_SAVINGS_EARNINGS_TAX (US ordinary + AU resident/NR bucket)
    sim.reducers.register('AU_SAVINGS_EARNINGS_APPLY', (state, action) => {
      const { amount, isAuResident } = action;
      return {
        state: {
          ...state,
          auSavingsAccount: { balance: state.auSavingsAccount.balance + amount },
        },
        next: [{ type: 'AU_SAVINGS_EARNINGS_TAX', amount, isAuResident }],
      };
    }, PRIORITY.CASH_FLOW, 'AU Savings Earnings Apply');

    sim.register('AU_SAVINGS_CONTRIBUTION', ({ data }) => [
      { type: 'AU_SAVINGS_CONTRIBUTION_APPLY', amount: data.amount },
      new RecordBalanceAction(),
    ]);

    sim.register('AU_SAVINGS_WITHDRAWAL', ({ data }) => [
      { type: 'AU_SAVINGS_WITHDRAWAL_APPLY', amount: data.amount },
      new RecordBalanceAction(),
    ]);

    // EVT-18 and EVT-19 share the same event type; residency in state determines AU tax bucket
    sim.register('AU_SAVINGS_EARNINGS', ({ data, state }) => [
      { type: 'AU_SAVINGS_EARNINGS_APPLY', amount: data.amount, isAuResident: state.isAuResident },
      new RecordBalanceAction(),
    ]);
  }

  // ── Superannuation ────────────────────────────────────────────────────────

  _registerSuper(sim, svc) {
    // EVT-20: contribution — debit checking, credit contributionBasis
    //         chains SUPER_CONTRIBUTION_TAX (AU super tax at 15%)
    sim.reducers.register('SUPER_CONTRIBUTION_APPLY', (state, action) => {
      svc.transaction(state.checkingAccount, -action.amount, null);
      const sa = state.superAccount;
      return {
        state: {
          ...state,
          superAccount: {
            ...sa,
            balance:           sa.balance           + action.amount,
            contributionBasis: sa.contributionBasis + action.amount,
          },
        },
        next: [{ type: 'SUPER_CONTRIBUTION_TAX', amount: action.amount }],
      };
    }, PRIORITY.CASH_FLOW, 'Super Contribution Apply');

    // EVT-21: withdrawal of contributions — age-gated (blocked before 60, no numeric penalty)
    //         no tax on successful withdrawal
    sim.reducers.register('SUPER_WITHDRAWAL_CONTRIB_APPLY', (state, action) => {
      const { amount, blocked } = action;
      if (blocked) {
        return { ...state, superWithdrawalBlocked: true };
      }
      svc.transaction(state.checkingAccount, amount, null);
      const sa = state.superAccount;
      return {
        ...state,
        superWithdrawalBlocked: false,
        superAccount: {
          ...sa,
          balance:           sa.balance           - amount,
          contributionBasis: sa.contributionBasis - amount,
        },
      };
    }, PRIORITY.CASH_FLOW, 'Super Contribution Withdrawal Apply');

    // EVT-22: withdrawal of earnings — age-gated
    //         chains SUPER_WITHDRAWAL_EARNINGS_TAX (US ordinary income)
    sim.reducers.register('SUPER_WITHDRAWAL_EARNINGS_APPLY', (state, action) => {
      const { amount, blocked } = action;
      if (blocked) {
        return { ...state, superWithdrawalBlocked: true };
      }
      svc.transaction(state.checkingAccount, amount, null);
      const sa = state.superAccount;
      return {
        state: {
          ...state,
          superWithdrawalBlocked: false,
          superAccount: {
            ...sa,
            balance:       sa.balance       - amount,
            earningsBasis: sa.earningsBasis - amount,
          },
        },
        next: [{ type: 'SUPER_WITHDRAWAL_EARNINGS_TAX', amount }],
      };
    }, PRIORITY.CASH_FLOW, 'Super Withdrawal Earnings Apply');

    // EVT-23: earnings — stay in account
    //         chains SUPER_EARNINGS_TAX (AU super tax at 15%)
    sim.reducers.register('SUPER_EARNINGS_APPLY', (state, action) => {
      const sa = state.superAccount;
      return {
        state: {
          ...state,
          superAccount: {
            ...sa,
            balance:       sa.balance       + action.amount,
            earningsBasis: sa.earningsBasis + action.amount,
          },
        },
        next: [{ type: 'SUPER_EARNINGS_TAX', amount: action.amount }],
      };
    }, PRIORITY.CASH_FLOW, 'Super Earnings Apply');

    sim.register('SUPER_CONTRIBUTION', ({ data }) => [
      { type: 'SUPER_CONTRIBUTION_APPLY', amount: data.amount },
      new RecordBalanceAction(),
    ]);

    sim.register('SUPER_WITHDRAWAL_CONTRIBUTIONS', ({ date, state, data }) => {
      const age     = getAge(state.personBirthDate, date);
      const blocked = age < 60;
      return [
        { type: 'SUPER_WITHDRAWAL_CONTRIB_APPLY', amount: data.amount, blocked },
        new RecordBalanceAction(),
      ];
    });

    sim.register('SUPER_WITHDRAWAL_EARNINGS', ({ date, state, data }) => {
      const age     = getAge(state.personBirthDate, date);
      const blocked = age < 60;
      return [
        { type: 'SUPER_WITHDRAWAL_EARNINGS_APPLY', amount: data.amount, blocked },
        new RecordBalanceAction(),
      ];
    });

    sim.register('SUPER_EARNINGS', ({ data }) => [
      { type: 'SUPER_EARNINGS_APPLY', amount: data.amount },
      new RecordBalanceAction(),
    ]);
  }

  // ── AU Brokerage ──────────────────────────────────────────────────────────

  _registerAuBrokerage(sim, svc) {
    // EVT-26: franked dividend — AU resident
    //         chains AU_DIVIDEND_FRANKED_RESIDENT_TAX
    sim.reducers.register('AU_DIVIDEND_FRANKED_RESIDENT_APPLY', (state, action) => {
      const sa = state.auStockAccount;
      return {
        state: {
          ...state,
          auStockAccount: {
            ...sa,
            balance:           sa.balance           + action.amount,
            contributionBasis: sa.contributionBasis + action.amount,
            earningsBasis:     sa.earningsBasis     + action.amount,
          },
        },
        next: [{ type: 'AU_DIVIDEND_FRANKED_RESIDENT_TAX', amount: action.amount }],
      };
    }, PRIORITY.CASH_FLOW, 'AU Franked Dividend Resident Apply');

    // EVT-27: franked dividend — non-resident
    //         no AU tax; US treatment unresolved (TODO: CSV "??") — no _TAX action chained
    sim.reducers.register('AU_DIVIDEND_FRANKED_NONRESIDENT_APPLY', (state, action) => {
      const sa = state.auStockAccount;
      return {
        ...state,
        auStockAccount: {
          ...sa,
          balance:           sa.balance           + action.amount,
          contributionBasis: sa.contributionBasis + action.amount,
          earningsBasis:     sa.earningsBasis     + action.amount,
        },
      };
    }, PRIORITY.CASH_FLOW, 'AU Franked Dividend Non-Resident Apply');

    // EVT-28: unfranked dividend — AU resident
    //         chains AU_DIVIDEND_UNFRANKED_RESIDENT_TAX
    sim.reducers.register('AU_DIVIDEND_UNFRANKED_RESIDENT_APPLY', (state, action) => {
      const sa = state.auStockAccount;
      return {
        state: {
          ...state,
          auStockAccount: {
            ...sa,
            balance:           sa.balance           + action.amount,
            contributionBasis: sa.contributionBasis + action.amount,
            earningsBasis:     sa.earningsBasis     + action.amount,
          },
        },
        next: [{ type: 'AU_DIVIDEND_UNFRANKED_RESIDENT_TAX', amount: action.amount }],
      };
    }, PRIORITY.CASH_FLOW, 'AU Unfranked Dividend Resident Apply');

    // EVT-29: unfranked dividend — non-resident
    //         chains AU_DIVIDEND_UNFRANKED_NONRESIDENT_TAX
    sim.reducers.register('AU_DIVIDEND_UNFRANKED_NONRESIDENT_APPLY', (state, action) => {
      const sa = state.auStockAccount;
      return {
        state: {
          ...state,
          auStockAccount: {
            ...sa,
            balance:           sa.balance           + action.amount,
            contributionBasis: sa.contributionBasis + action.amount,
            earningsBasis:     sa.earningsBasis     + action.amount,
          },
        },
        next: [{ type: 'AU_DIVIDEND_UNFRANKED_NONRESIDENT_TAX', amount: action.amount }],
      };
    }, PRIORITY.CASH_FLOW, 'AU Unfranked Dividend Non-Resident Apply');

    // EVT-30: unrealized earnings — stay in account, no tax
    sim.reducers.register('AU_STOCK_EARNINGS_APPLY', (state, action) => {
      const sa = state.auStockAccount;
      return {
        ...state,
        auStockAccount: {
          ...sa,
          balance:       sa.balance       + action.amount,
          earningsBasis: sa.earningsBasis + action.amount,
        },
      };
    }, PRIORITY.CASH_FLOW, 'AU Stock Earnings Apply');

    // EVT-31 (resident) / EVT-32 (non-resident): stock withdrawal (sale)
    //         credit checking with sale proceeds, debit account
    //         chains AU_STOCK_WITHDRAWAL_TAX (US cap gain always, AU cap gain + FTC if resident)
    sim.reducers.register('AU_STOCK_WITHDRAWAL_APPLY', (state, action) => {
      const { salePrice, costBasis, isAuResident } = action;
      const gain = Math.max(0, salePrice - costBasis);
      svc.transaction(state.checkingAccount, salePrice, null);
      const sa = state.auStockAccount;
      const newBalance  = sa.balance - salePrice;
      const newEarnings = Math.max(0, sa.earningsBasis - gain);
      const newContrib  = newBalance - newEarnings;
      return {
        state: {
          ...state,
          auStockAccount: {
            ...sa,
            balance:           newBalance,
            earningsBasis:     newEarnings,
            contributionBasis: newContrib,
          },
        },
        next: [{ type: 'AU_STOCK_WITHDRAWAL_TAX', gain, isAuResident }],
      };
    }, PRIORITY.CASH_FLOW, 'AU Stock Withdrawal Apply');

    sim.register('AU_DIVIDEND_FRANKED_RESIDENT', ({ data }) => [
      { type: 'AU_DIVIDEND_FRANKED_RESIDENT_APPLY', amount: data.amount },
      new RecordBalanceAction(),
    ]);

    sim.register('AU_DIVIDEND_FRANKED_NONRESIDENT', ({ data }) => [
      { type: 'AU_DIVIDEND_FRANKED_NONRESIDENT_APPLY', amount: data.amount },
      new RecordBalanceAction(),
    ]);

    sim.register('AU_DIVIDEND_UNFRANKED_RESIDENT', ({ data }) => [
      { type: 'AU_DIVIDEND_UNFRANKED_RESIDENT_APPLY', amount: data.amount },
      new RecordBalanceAction(),
    ]);

    sim.register('AU_DIVIDEND_UNFRANKED_NONRESIDENT', ({ data }) => [
      { type: 'AU_DIVIDEND_UNFRANKED_NONRESIDENT_APPLY', amount: data.amount },
      new RecordBalanceAction(),
    ]);

    sim.register('AU_STOCK_EARNINGS', ({ data }) => [
      { type: 'AU_STOCK_EARNINGS_APPLY', amount: data.amount },
      new RecordBalanceAction(),
    ]);

    // EVT-31/32: residency flag read from state and passed through to reducer
    sim.register('AU_STOCK_WITHDRAWAL', ({ data, state }) => [
      { type: 'AU_STOCK_WITHDRAWAL_APPLY',
        salePrice:    data.salePrice,
        costBasis:    data.costBasis,
        isAuResident: state.isAuResident,
      },
      new RecordBalanceAction(),
    ]);
  }

  // ── Real Property ─────────────────────────────────────────────────────────

  _registerRealProperty(sim, svc) {
    // EVT-33: AU house sale — credit checking, compute gain, chain AU_HOUSE_SALE_TAX
    sim.reducers.register('AU_HOUSE_SALE_APPLY', (state, action) => {
      const { salePrice, costBasis } = action;
      const gain = Math.max(0, salePrice - costBasis);
      svc.transaction(state.checkingAccount, salePrice, null);
      return {
        state: { ...state },
        next: [{ type: 'AU_HOUSE_SALE_TAX', gain }],
      };
    }, PRIORITY.CASH_FLOW, 'AU House Sale Apply');

    sim.register('AU_HOUSE_SALE', ({ data }) => [
      { type: 'AU_HOUSE_SALE_APPLY', salePrice: data.salePrice, costBasis: data.costBasis },
      new RecordBalanceAction(),
    ]);
  }
}
