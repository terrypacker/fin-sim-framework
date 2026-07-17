/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY, AccountServiceReducer } from '../../../simulation-framework/reducers.js';
import { HandlerEntry }       from '../../../simulation-framework/handlers.js';
import { RecordBalanceAction } from '../../../simulation-framework/actions.js';
import { consumeHoldings } from '../../holdings/holdings-fifo.js';
import { resolveDrawdownSelection, withRebalanceCoupling } from '../../holdings/holdings-selection.js';
import { distributeHoldingsCredit } from '../../holdings/holding-utils.js';
import { resolveCashKey } from '../cash-routing.js';

/** Resolve the US cash pool (legacy tail; prefer resolveCashKey for routing). */
const usCash = (state) => state.usSavingsAccount ?? state.checkingAccount;

// ─── Fixed Income Reducers ────────────────────────────────────────────────────

/** EVT-9: Fixed income contribution — debit US cash pool, credit account, no tax. */
export class FixedIncomeContributionApplyReducer extends AccountServiceReducer {
  static type        = 'FixedIncomeContributionApplyReducer';
  static description = 'Debits the US cash pool and credits the fixed income account balance; no tax effect.';
  static actionType  = 'FIXED_INCOME_CONTRIBUTION_APPLY';

  constructor({ accountService, stateRegistry }) {
    super('Fixed Income Contribution Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes = ['FIXED_INCOME_CONTRIBUTION_APPLY'];
  }

  reduce(state, action) {
    this.accountService.transaction(state[resolveCashKey(this.stateRegistry, 'US', state)], -action.amount, null);
    this.accountService.transaction(state.fixedIncomeAccount, action.amount, null);
    return this.newState(state, {});
  }
}

/** EVT-10: Fixed income withdrawal — debit account, credit US cash pool, no tax. */
export class FixedIncomeWithdrawalApplyReducer extends AccountServiceReducer {
  static type        = 'FixedIncomeWithdrawalApplyReducer';
  static description = 'Credits the US cash pool and debits the fixed income account balance; no tax effect.';
  static actionType  = 'FIXED_INCOME_WITHDRAWAL_APPLY';

  constructor({ accountService, stateRegistry }) {
    super('Fixed Income Withdrawal Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes = ['FIXED_INCOME_WITHDRAWAL_APPLY'];
  }

  reduce(state, action) {
    this.accountService.transaction(state[resolveCashKey(this.stateRegistry, 'US', state)], action.amount, null);
    this.accountService.transaction(state.fixedIncomeAccount, -action.amount, null);
    return this.newState(state, {});
  }
}

/**
 * EVT-11: Fixed income earnings — stay in account.
 * Chains FIXED_INCOME_EARNINGS_TAX (US ordinary income, AU ordinary if resident).
 */
export class FixedIncomeEarningsApplyReducer extends AccountServiceReducer {
  static type        = 'FixedIncomeEarningsApplyReducer';
  static description = 'Adds earnings to fixed income account; chains FIXED_INCOME_EARNINGS_TAX.';
  static actionType  = 'FIXED_INCOME_EARNINGS_APPLY';

  constructor({ accountService, stateRegistry }) {  // accountService unused but accepted for API symmetry
    super('Fixed Income Earnings Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes   = ['FIXED_INCOME_EARNINGS_APPLY'];
    this.generatedActionTypes = ['FIXED_INCOME_EARNINGS_TAX'];
  }

  reduce(state, action) {
    const { amount, residency } = action;
    // Per-account (design 55): the handler stamps the earning account's stateKey.
    // Fall back to the canonical single-account key so legacy bare-event dispatchers
    // (and pre-stateKey saved actions) still resolve.
    const key   = action.stateKey ?? 'fixedIncomeAccount';
    const acct  = state[key];
    return this.newState(
      state,
      {
        [key]: {
          ...acct,
          balance: acct.balance + amount,
        },
      },
      [{ type: 'FIXED_INCOME_EARNINGS_TAX', amount, residency }]
    );
  }
}

// ─── Stock Reducers ───────────────────────────────────────────────────────────

/** EVT-12: Stock contribution — debit US cash pool, credit the stock account, no tax. */
export class StockContributionApplyReducer extends AccountServiceReducer {
  static type        = 'StockContributionApplyReducer';
  static description = 'Debits the US cash pool and credits the stock account (balance + holdings); no tax effect.';
  static actionType  = 'STOCK_CONTRIBUTION_APPLY';

  constructor({ accountService, stateRegistry }) {
    super('Stock Contribution Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes = ['STOCK_CONTRIBUTION_APPLY'];
  }

  reduce(state, action) {
    this.accountService.transaction(state[resolveCashKey(this.stateRegistry, 'US', state)], -action.amount, null);
    const key = action.stateKey ?? 'usStockAccount';
    // transaction() credits balance and distributes to holdings in place (design 25).
    // Brokerage basis is no longer tracked here — CGT comes from holdings (design 53 P1).
    this.accountService.transaction(state[key], action.amount, null);
    return this.newState(state, {});
  }
}

/**
 * EVT-13: Stock dividend — stays in account (reinvested into holdings).
 * Chains STOCK_DIVIDEND_TAX (US ordinary income, AU ordinary if resident).
 */
export class StockDividendApplyReducer extends AccountServiceReducer {
  static type        = 'StockDividendApplyReducer';
  static description = 'Adds dividend to stock balance and reinvests into holdings; chains STOCK_DIVIDEND_TAX.';
  static actionType  = 'STOCK_DIVIDEND_APPLY';

  constructor({ accountService, stateRegistry }) {  // accountService unused but accepted for API symmetry
    super('Stock Dividend Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes   = ['STOCK_DIVIDEND_APPLY'];
    this.generatedActionTypes = ['STOCK_DIVIDEND_TAX'];
  }

  reduce(state, action) {
    const { amount, residency } = action;
    const key = action.stateKey ?? 'usStockAccount';
    const sa = state[key];
    return this.newState(
      state,
      {
        [key]: {
          ...sa,
          balance:  sa.balance + amount,
          // Reinvest the dividend into the holdings so Σ marketValue tracks the
          // balance credit (§4.4 invariant). Without this the scalar balance
          // credit desyncs from holdings and is discarded by the next earnings
          // _syncBalance. (Brokerage basis is no longer tracked — design 53 P1.)
          holdings: distributeHoldingsCredit(sa.holdings, amount),
        },
      },
      [{ type: 'STOCK_DIVIDEND_TAX', amount, residency }]
    );
  }
}

/**
 * Bond coupon (reinvest path) — coupon interest stays in the account, reinvested
 * into the holdings. Chains BOND_COUPON_TAX carrying `amount` (full, federal) and
 * `stateTaxableAmount` (non-Treasury, US state) — design 59.
 */
export class BondCouponApplyReducer extends AccountServiceReducer {
  static type        = 'BondCouponApplyReducer';
  static description = 'Adds bond coupon interest to the account balance and reinvests into holdings; chains BOND_COUPON_TAX (federal + state, with the Treasury-exempt split).';
  static actionType  = 'BOND_COUPON_APPLY';

  constructor({ accountService, stateRegistry }) {  // accountService unused but accepted for API symmetry
    super('Bond Coupon Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes   = ['BOND_COUPON_APPLY'];
    this.generatedActionTypes = ['BOND_COUPON_TAX'];
  }

  reduce(state, action) {
    const { amount, federalTaxableAmount, stateTaxableAmount, residency } = action;
    const key = action.stateKey ?? 'usStockAccount';
    const sa  = state[key];
    return this.newState(
      state,
      {
        [key]: {
          ...sa,
          balance:  sa.balance + amount,
          holdings: distributeHoldingsCredit(sa.holdings, amount),
        },
      },
      [{ type: 'BOND_COUPON_TAX', amount, federalTaxableAmount, stateTaxableAmount, residency }]
    );
  }
}

/** EVT-14: Stock earnings (unrealized) — stay in account, no tax. */
export class StockEarningsApplyReducer extends AccountServiceReducer {
  static type        = 'StockEarningsApplyReducer';
  static description = 'Adds unrealized earnings to stock balance; no tax effect.';
  static actionType  = 'STOCK_EARNINGS_APPLY';

  constructor({ accountService, stateRegistry }) {  // accountService unused but accepted for API symmetry
    super('Stock Earnings Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes = ['STOCK_EARNINGS_APPLY'];
  }

  reduce(state, action) {
    const key = action.stateKey ?? 'usStockAccount';
    const sa = state[key];
    return this.newState(state, {
      [key]: { ...sa, balance: sa.balance + action.amount },
    });
  }
}

/**
 * EVT-15: Stock withdrawal (sale) — credit US cash pool, debit account.
 * Chains STOCK_WITHDRAWAL_TAX (US capital gain, AU capital gain if resident).
 */
export class StockWithdrawalApplyReducer extends AccountServiceReducer {
  static type        = 'StockWithdrawalApplyReducer';
  static description = 'Credits the US cash pool with sale proceeds, FIFO-consumes the stock account\'s holdings (design 25 §6.4), and chains STOCK_WITHDRAWAL_TAX with the realized basis.';
  static actionType  = 'STOCK_WITHDRAWAL_APPLY';

  constructor({ accountService, costBasisStrategy = 'FIFO', stateRegistry }) {
    super('Stock Withdrawal Apply', PRIORITY.CASH_FLOW);
    this.accountService    = accountService;
    this.stateRegistry     = stateRegistry;
    this.costBasisStrategy = costBasisStrategy; // 'FIFO' | 'LIFO' | 'SPECIFIC' (per design §6.4)
    this.reducedActionTypes   = ['STOCK_WITHDRAWAL_APPLY'];
    this.generatedActionTypes = ['STOCK_WITHDRAWAL_TAX', 'COLLECTIBLE_SALE_TAX'];
  }

  reduce(state, action) {
    const { salePrice, residency } = action;
    const key = action.stateKey ?? 'usStockAccount';
    const sa  = state[key];

    // Resolve realized cost basis. Action-supplied costBasis wins for backward
    // compatibility (event-data API); otherwise consume holdings FIFO from state.
    // AU CGT-reform indexation context (design 57 §6.3): the current AU price level
    // and the as-of (sale) date, so FIFO also returns a per-lot CPI-indexed AU
    // basis. Lots with no acquisitionPriceLevel (never stepped up / bootstrapped)
    // index at factor 1, so auIndexedGain === auGain until the residency step-up
    // (design 57 §6.3) stamps the deemed-acquisition level.
    // Indexation reads the dedicated ATO CPI series (design 57 Part 2, Item A),
    // falling back to inflationAccumulator (and 1) for old saves. The stamp
    // (residency step-up) reads the same accumulator so the ratio is consistent.
    const auLevel = state.cpiAccumulator?.AU ?? state.inflationAccumulator?.AU ?? 1;
    const asOfMs  = state.currentPeriods?.AU?.startMs ?? Date.now();
    // Allocation-aware liquidation (design 65): the event path shares the same
    // selection policy as the engine draw, so both realize identical tax for the
    // same account + policy. Null (default FIFO/FIFO) ⇒ byte-identical to the prior FIFO.
    const selection = withRebalanceCoupling(resolveDrawdownSelection({
      sleeveOrderMode: state.drawdownSleeveOrder,
      lotStrategy:     state.drawdownLotStrategy,
      sleeveWeights:   state.drawdownSleeveWeights,
      rebalanceWeight: state.drawdownRebalanceWeight,
    }), sa);
    const r = consumeHoldings(sa.holdings ?? [], salePrice, { indexation: { level: auLevel, asOfMs, country: 'AU' }, selection });
    const realizedBasis = action.costBasis != null ? action.costBasis : r.realizedBasis;
    const newHoldings   = r.newHoldings;
    // AU cost-base reset (design 36 §12.2): the realized AU basis sums each lot's
    // stepped-up cost base; no step-up ⇒ falls back to realizedBasis (auGain === gain).
    const realizedAuBasis        = r.realizedBasisByCountry?.AU ?? realizedBasis;
    const realizedIndexedAuBasis = r.realizedIndexedBasisByCountry?.AU ?? realizedAuBasis;

    // Collectible split (design 56 §7.2): the proceeds/basis attributable to consumed
    // GOLD lots are taxed at the US 28% collectibles rate (and AU CGT if resident) via
    // COLLECTIBLE_SALE_TAX; the remainder keeps ordinary brokerage CGT via
    // STOCK_WITHDRAWAL_TAX. A backward-compatible action-supplied `costBasis` (bare-event
    // API) has no per-lot allocation, so it can't be split — treat it as all-equity.
    const collectibleProceeds = action.costBasis != null ? 0 : r.collectibleProceeds;
    const collectibleBasis    = action.costBasis != null ? 0 : r.collectibleBasis;
    const collectibleGain     = Math.max(0, collectibleProceeds - collectibleBasis);
    // Gold (collectible) AU cost base — stepped-up and CPI-indexed (design 57 §6.3).
    // A bullion sleeve is an ordinary AU CGT asset, so it indexes like equity; a
    // sale with no per-country override falls back to the US collectible basis.
    const collectibleAuBasis        = r.collectibleBasisByCountry?.AU        ?? collectibleBasis;
    const collectibleIndexedAuBasis = r.collectibleIndexedBasisByCountry?.AU ?? collectibleAuBasis;
    const collectibleAuGain        = Math.max(0, collectibleProceeds - collectibleAuBasis);
    const collectibleIndexedAuGain = Math.max(0, collectibleProceeds - collectibleIndexedAuBasis);

    // The equity (non-collectible) portion is the total less the collectible slice.
    const equityProceeds        = +(salePrice - collectibleProceeds).toFixed(2);
    const equityBasis           = +(realizedBasis - collectibleBasis).toFixed(2);
    const equityAuBasis         = +(realizedAuBasis - collectibleAuBasis).toFixed(2);
    const equityIndexedAuBasis  = +(realizedIndexedAuBasis - collectibleIndexedAuBasis).toFixed(2);
    const gain          = Math.max(0, equityProceeds - equityBasis);
    const auGain        = Math.max(0, equityProceeds - equityAuBasis);
    const auIndexedGain = Math.max(0, equityProceeds - equityIndexedAuBasis);

    this.accountService.transaction(state[resolveCashKey(this.stateRegistry, 'US', state)], salePrice, null);

    const newBalance = +newHoldings.reduce((s, h) => s + (h?.marketValue ?? 0), 0).toFixed(2);
    // Brokerage basis is no longer tracked (design 53 P1) — the FIFO realizedBasis
    // above is the authoritative CGT source. auIndexedGain carries the AU CGT-reform
    // real gain (design 57) alongside the stepped-up auGain and the US gain.
    const taxActions = [
      { type: 'STOCK_WITHDRAWAL_TAX', gain, auGain, auIndexedGain, residency, proceeds: equityProceeds, costBasis: equityBasis, description: sa.name || key },
    ];
    if (collectibleGain > 0) {
      // isGold flags this collectible slice as bullion so the AU FY2027 classifier
      // indexes it (ordinary AU CGT), unlike true collectibles (design 57 §6.4/§7.2).
      taxActions.push({ type: 'COLLECTIBLE_SALE_TAX', gain: collectibleGain, auGain: collectibleAuGain, auIndexedGain: collectibleIndexedAuGain, isGold: true, residency });
    }
    return this.newState(
      state,
      {
        [key]: {
          ...sa,
          balance:  newBalance,
          holdings: newHoldings,
        },
      },
      taxActions,
    );
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export class FixedIncomeContributionHandler extends HandlerEntry {
  static type        = 'FixedIncomeContributionHandler';
  static description = 'Dispatches FIXED_INCOME_CONTRIBUTION_APPLY.';
  static eventType   = 'FIXED_INCOME_CONTRIBUTION';

  constructor() {
    super(null, 'Fixed Income Contribution');
    this.generatedActionTypes = ['FIXED_INCOME_CONTRIBUTION_APPLY', 'RECORD_BALANCE'];
  }

  call({ data }) {
    return [
      { type: 'FIXED_INCOME_CONTRIBUTION_APPLY', amount: data.amount },
      new RecordBalanceAction('fixedIncomeAccount.balance', 'fixedIncomeAccount'),
    ];
  }
}

export class FixedIncomeWithdrawalHandler extends HandlerEntry {
  static type        = 'FixedIncomeWithdrawalHandler';
  static description = 'Dispatches FIXED_INCOME_WITHDRAWAL_APPLY.';
  static eventType   = 'FIXED_INCOME_WITHDRAWAL';

  constructor() {
    super(null, 'Fixed Income Withdrawal');
    this.generatedActionTypes = ['FIXED_INCOME_WITHDRAWAL_APPLY', 'RECORD_BALANCE'];
  }

  call({ data }) {
    return [
      { type: 'FIXED_INCOME_WITHDRAWAL_APPLY', amount: data.amount },
      new RecordBalanceAction('fixedIncomeAccount.balance', 'fixedIncomeAccount'),
    ];
  }
}

export class FixedIncomeEarningsHandler extends HandlerEntry {
  static type        = 'FixedIncomeEarningsHandler';
  static description = 'Dispatches FIXED_INCOME_EARNINGS_APPLY, passing through the AU residency flag.';
  static eventType   = 'FIXED_INCOME_EARNINGS';

  constructor() {
    super(null, 'Fixed Income Earnings');
    this.generatedActionTypes = ['FIXED_INCOME_EARNINGS_APPLY', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    return [
      { type: 'FIXED_INCOME_EARNINGS_APPLY', amount: data.amount, residency: state.people?.[Object.keys(state.people ?? {})[0]]?.residency ?? null },
      new RecordBalanceAction('fixedIncomeAccount.balance', 'fixedIncomeAccount'),
    ];
  }
}

export class StockContributionHandler extends HandlerEntry {
  static type        = 'StockContributionHandler';
  static description = 'Dispatches STOCK_CONTRIBUTION_APPLY.';
  static eventType   = 'STOCK_CONTRIBUTION';

  constructor() {
    super(null, 'Stock Contribution');
    this.generatedActionTypes = ['STOCK_CONTRIBUTION_APPLY', 'RECORD_BALANCE'];
  }

  call({ data }) {
    return [
      { type: 'STOCK_CONTRIBUTION_APPLY', amount: data.amount },
      new RecordBalanceAction('usStockAccount.balance', 'usStockAccount'),
    ];
  }
}

export class StockDividendHandler extends HandlerEntry {
  static type        = 'StockDividendHandler';
  static description = 'Dispatches STOCK_DIVIDEND_APPLY, passing through the AU residency flag.';
  static eventType   = 'STOCK_DIVIDEND';

  constructor() {
    super(null, 'Stock Dividend');
    this.generatedActionTypes = ['STOCK_DIVIDEND_APPLY', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    return [
      { type: 'STOCK_DIVIDEND_APPLY', amount: data.amount, residency: state.people?.[Object.keys(state.people ?? {})[0]]?.residency ?? null },
      new RecordBalanceAction('usStockAccount.balance', 'usStockAccount'),
    ];
  }
}

export class StockEarningsHandler extends HandlerEntry {
  static type        = 'StockEarningsHandler';
  static description = 'Dispatches STOCK_EARNINGS_APPLY.';
  static eventType   = 'STOCK_EARNINGS';

  constructor() {
    super(null, 'Stock Earnings');
    this.generatedActionTypes = ['STOCK_EARNINGS_APPLY', 'RECORD_BALANCE'];
  }

  call({ data }) {
    return [
      { type: 'STOCK_EARNINGS_APPLY', amount: data.amount },
      new RecordBalanceAction('usStockAccount.balance', 'usStockAccount'),
    ];
  }
}

export class StockWithdrawalHandler extends HandlerEntry {
  static type        = 'StockWithdrawalHandler';
  static description = 'Dispatches STOCK_WITHDRAWAL_APPLY with sale price, cost basis, and AU residency flag.';
  static eventType   = 'STOCK_WITHDRAWAL';

  constructor() {
    super(null, 'Stock Withdrawal');
    this.generatedActionTypes = ['STOCK_WITHDRAWAL_APPLY', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    return [
      {
        type:         'STOCK_WITHDRAWAL_APPLY',
        salePrice:    data.salePrice,
        costBasis:    data.costBasis,
        residency: state.people?.[Object.keys(state.people ?? {})[0]]?.residency ?? null,
      },
      new RecordBalanceAction('usStockAccount.balance', 'usStockAccount'),
    ];
  }
}
