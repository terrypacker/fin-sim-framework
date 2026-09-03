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
import { disposalTermFields, auCpiRate } from '../../holdings/holding-period.js';
import { resolveDrawdownSelection, withRebalanceCoupling } from '../../holdings/holdings-selection.js';
import { resolveCashKey } from '../cash-routing.js';
import { section988ForBondPrincipal } from '../bond-currency-basis.js';
import { toMs } from '../main-residence.js';

/** Resolve the AU cash pool (legacy tail; prefer resolveCashKey for routing). */
const auCash = (state) => state.auSavingsAccount ?? state.checkingAccount;

// ─── Reducers ─────────────────────────────────────────────────────────────────

/**
 * EVT-26: AU franked dividend (resident) — stays in account. Chains
 * AU_DIVIDEND_FRANKED_RESIDENT_TAX.
 *
 * Credits `balance` ONLY. `auStockAccount` is a brokerage, and a brokerage has no
 * contribution/earnings ledger — its basis lives per-lot on `Holding.costBasis`
 * (design 53 §2). `contributionBasis`/`earningsBasis` are the retirement-wrapper
 * deferral ledger, and ScenarioLoader's `_normalizeRetirementBasis` deliberately
 * skips brokerage roles, so on this account they are `undefined`.
 */
export class AuDividendFrankedResidentApplyReducer extends AccountServiceReducer {
  static type        = 'AuDividendFrankedResidentApplyReducer';
  static description = 'Adds franked dividend to auStockAccount; chains AU_DIVIDEND_FRANKED_RESIDENT_TAX.';
  static actionType  = 'AU_DIVIDEND_FRANKED_RESIDENT_APPLY';

  constructor({ accountService, stateRegistry }) {  // accountService unused but accepted for API symmetry
    super('AU Franked Dividend Resident Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes   = ['AU_DIVIDEND_FRANKED_RESIDENT_APPLY'];
    this.generatedActionTypes = ['AU_DIVIDEND_FRANKED_RESIDENT_TAX'];
  }

  reduce(state, action) {
    // Per-account (design 55 §7 / 76 Gap C): honor a handler-stamped stateKey so
    // multiple AU brokerage accounts each credit — and are taxed to — their own
    // owner. Falls back to the canonical key for legacy dispatchers and old saves.
    const key = action.stateKey ?? 'auStockAccount';
    const sa = state[key];
    return this.newState(
      state,
      {
        [key]: {
          ...sa,
          balance: sa.balance + action.amount,
        },
      },
      [{ type: 'AU_DIVIDEND_FRANKED_RESIDENT_TAX', amount: action.amount, stateKey: key }]
    );
  }
}

/**
 * EVT-27: AU franked dividend (non-resident) — stays in account, no AU tax.
 * Chains AU_DIVIDEND_FRANKED_NONRESIDENT_TAX (US ordinary income only — Australia
 * exempts the franked part under ITAA 1936 s128B(3)(ga), but a US citizen is taxed
 * on worldwide income regardless). See the tax module for the full reasoning.
 */
export class AuDividendFrankedNonResidentApplyReducer extends AccountServiceReducer {
  static type        = 'AuDividendFrankedNonResidentApplyReducer';
  static description = 'Adds franked dividend to auStockAccount for non-residents; chains AU_DIVIDEND_FRANKED_NONRESIDENT_TAX (US ordinary income, no AU tax).';
  static actionType  = 'AU_DIVIDEND_FRANKED_NONRESIDENT_APPLY';

  constructor({ accountService, stateRegistry }) {  // accountService unused but accepted for API symmetry
    super('AU Franked Dividend Non-Resident Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes   = ['AU_DIVIDEND_FRANKED_NONRESIDENT_APPLY'];
    this.generatedActionTypes = ['AU_DIVIDEND_FRANKED_NONRESIDENT_TAX'];
  }

  reduce(state, action) {
    // Per-account (design 55 §7 / 76 Gap C) — see the sibling reducers above.
    const key = action.stateKey ?? 'auStockAccount';
    const sa = state[key];
    return this.newState(
      state,
      {
        // Credits `balance` ONLY, matching the resident sibling above. This used to
        // also add `action.amount` to `contributionBasis` and `earningsBasis` —
        // following the (now corrected) "increases all bases" note on EVT-26. Those
        // fields are `undefined` on a brokerage account, so `undefined + amount`
        // wrote NaN into state on the first non-resident franked dividend and it
        // stayed NaN for the rest of the run. Nothing recomputed them, and
        // ScenarioSerializer's `account.earningsBasis ?? 0` does not catch NaN
        // (nullish coalescing only guards null/undefined), so a save taken after
        // such a run persisted the NaN as JSON `null`.
        [key]: {
          ...sa,
          balance: sa.balance + action.amount,
        },
      },
      [{ type: 'AU_DIVIDEND_FRANKED_NONRESIDENT_TAX', amount: action.amount, stateKey: key }]
    );
  }
}

/**
 * EVT-28: AU unfranked dividend (resident) — stays in account.
 * Chains AU_DIVIDEND_UNFRANKED_RESIDENT_TAX.
 */
export class AuDividendUnfrankedResidentApplyReducer extends AccountServiceReducer {
  static type        = 'AuDividendUnfrankedResidentApplyReducer';
  static description = 'Adds unfranked dividend to auStockAccount; chains AU_DIVIDEND_UNFRANKED_RESIDENT_TAX.';
  static actionType  = 'AU_DIVIDEND_UNFRANKED_RESIDENT_APPLY';

  constructor({ accountService, stateRegistry }) {  // accountService unused but accepted for API symmetry
    super('AU Unfranked Dividend Resident Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes   = ['AU_DIVIDEND_UNFRANKED_RESIDENT_APPLY'];
    this.generatedActionTypes = ['AU_DIVIDEND_UNFRANKED_RESIDENT_TAX'];
  }

  reduce(state, action) {
    // Per-account (design 55 §7 / 76 Gap C): honor a handler-stamped stateKey so
    // multiple AU brokerage accounts each credit — and are taxed to — their own
    // owner. Falls back to the canonical key for legacy dispatchers and old saves.
    const key = action.stateKey ?? 'auStockAccount';
    const sa = state[key];
    return this.newState(
      state,
      {
        [key]: {
          ...sa,
          balance: sa.balance + action.amount,
        },
      },
      [{ type: 'AU_DIVIDEND_UNFRANKED_RESIDENT_TAX', amount: action.amount, stateKey: key }]
    );
  }
}

/**
 * EVT-29: AU unfranked dividend (non-resident) — stays in account.
 * Chains AU_DIVIDEND_UNFRANKED_NONRESIDENT_TAX.
 */
export class AuDividendUnfrankedNonResidentApplyReducer extends AccountServiceReducer {
  static type        = 'AuDividendUnfrankedNonResidentApplyReducer';
  static description = 'Adds unfranked dividend to auStockAccount for non-residents; chains AU_DIVIDEND_UNFRANKED_NONRESIDENT_TAX.';
  static actionType  = 'AU_DIVIDEND_UNFRANKED_NONRESIDENT_APPLY';

  constructor({ accountService, stateRegistry }) {  // accountService unused but accepted for API symmetry
    super('AU Unfranked Dividend Non-Resident Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes   = ['AU_DIVIDEND_UNFRANKED_NONRESIDENT_APPLY'];
    this.generatedActionTypes = ['AU_DIVIDEND_UNFRANKED_NONRESIDENT_TAX'];
  }

  reduce(state, action) {
    // Per-account (design 55 §7 / 76 Gap C): honor a handler-stamped stateKey so
    // multiple AU brokerage accounts each credit — and are taxed to — their own
    // owner. Falls back to the canonical key for legacy dispatchers and old saves.
    const key = action.stateKey ?? 'auStockAccount';
    const sa = state[key];
    return this.newState(
      state,
      {
        [key]: {
          ...sa,
          balance: sa.balance + action.amount,
        },
      },
      [{ type: 'AU_DIVIDEND_UNFRANKED_NONRESIDENT_TAX', amount: action.amount, stateKey: key }]
    );
  }
}

/** EVT-30: AU stock unrealized earnings — stay in account, no tax. */
export class AuStockEarningsApplyReducer extends AccountServiceReducer {
  static type        = 'AuStockEarningsApplyReducer';
  static description = 'Adds unrealized earnings to auStockAccount balance; no tax effect.';
  static actionType  = 'AU_STOCK_EARNINGS_APPLY';

  constructor({ accountService, stateRegistry }) {  // accountService unused but accepted for API symmetry
    super('AU Stock Earnings Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes = ['AU_STOCK_EARNINGS_APPLY'];
  }

  reduce(state, action) {
    const sa = state.auStockAccount;
    // Negative in a losing year (design 84 G12) — see the US sibling: no ledger to
    // split, floor is defensive.
    return this.newState(state, {
      auStockAccount: { ...sa, balance: Math.max(0, sa.balance + action.amount) },
    });
  }
}

/**
 * EVT-31 (resident) / EVT-32 (non-resident): AU stock withdrawal (sale).
 * Credits AU cash pool, debits account.
 * Chains AU_STOCK_WITHDRAWAL_TAX (US cap gain always, AU cap gain + FTC if resident).
 */
export class AuStockWithdrawalApplyReducer extends AccountServiceReducer {
  static type        = 'AuStockWithdrawalApplyReducer';
  static description = 'Credits AU cash pool with sale proceeds, FIFO-consumes auStockAccount.holdings (design 25 §6.4), and chains AU_STOCK_WITHDRAWAL_TAX with the realized basis.';
  static actionType  = 'AU_STOCK_WITHDRAWAL_APPLY';

  constructor({ accountService, costBasisStrategy = 'FIFO', stateRegistry }) {
    super('AU Stock Withdrawal Apply', PRIORITY.CASH_FLOW);
    this.accountService    = accountService;
    this.stateRegistry     = stateRegistry;
    this.costBasisStrategy = costBasisStrategy;
    this.reducedActionTypes   = ['AU_STOCK_WITHDRAWAL_APPLY'];
    this.generatedActionTypes = ['AU_STOCK_WITHDRAWAL_TAX', 'SECTION_988_GAIN'];
  }

  reduce(state, action, date) {
    const { salePrice, residency } = action;
    // Per-account (design 55 §7 / 76 Gap C) — see the dividend reducers above.
    const key = action.stateKey ?? 'auStockAccount';
    const sa = state[key];

    // CGT cost-base indexation context (design 57 §6.3): current AU price level and
    // the as-of (sale) date from the current AU period. FIFO returns an indexed AU
    // basis alongside the un-indexed one; lots with no acquisitionPriceLevel index at
    // factor 1, so auIndexedGain === auGain until the 1 Jul 2027 reset stamps levels.
    // Indexation reads the dedicated ATO CPI series (design 57 Part 2, Item A),
    // falling back to inflationAccumulator (and 1) for old saves.
    const auLevel   = state.cpiAccumulator?.AU ?? state.inflationAccumulator?.AU ?? 1;
    // Design 83 G7 (F3) — the DISPOSAL date, not the start of the financial year the
    // disposal falls in. See the US sibling reducer for why: this same `asOfMs` ends
    // both Div 115's ≥12-month test and §1222's >1-year split, and the period start
    // understated the hold by up to a full year. Fallback only for a replayed action
    // dispatched without a date; the old `Date.now()` fallback is gone because a wall
    // clock in a reducer breaks the sim's bit-determinism.
    const asOfMs    = toMs(date) ?? state.currentPeriods?.AU?.startMs ?? null;
    // Allocation-aware liquidation (design 65): shares the engine draw's selection
    // policy. Null (default FIFO/FIFO) ⇒ byte-identical to the prior FIFO.
    const selection = withRebalanceCoupling(resolveDrawdownSelection({
      sleeveOrderMode: state.drawdownSleeveOrder,
      lotStrategy:     state.drawdownLotStrategy,
      sleeveWeights:   state.drawdownSleeveWeights,
      rebalanceWeight: state.drawdownRebalanceWeight,
      securityOrder:   state.drawdownSecurityOrder,
    }), sa);
    // Design 90 §9 step 2 — the signed, §1222-charactered split. Requested for BOTH
    // countries even though this is an AU account: a US person is taxed on worldwide
    // gains, so the US character of an AU disposal is not optional.
    const r = consumeHoldings(sa.holdings ?? [], salePrice, { indexation: { level: auLevel, asOfMs, country: 'AU', cpiRate: auCpiRate(state) }, selection, terms: { asOfMs, countries: ['US', 'AU'] }, securities: state.securities ?? null });
    const realizedBasis = action.costBasis != null ? action.costBasis : r.realizedBasis;
    const newHoldings   = r.newHoldings;
    // AU cost-base reset (design 36 §12.2): realized AU basis from each lot's
    // stepped-up cost base; no step-up ⇒ falls back to realizedBasis (auGain === gain).
    const realizedAuBasis        = r.realizedBasisByCountry?.AU ?? realizedBasis;
    const realizedIndexedAuBasis = r.realizedIndexedBasisByCountry?.AU ?? realizedAuBasis;
    const gain        = Math.max(0, salePrice - realizedBasis);
    const auGain      = Math.max(0, salePrice - realizedAuBasis);
    const auIndexedGain = Math.max(0, salePrice - realizedIndexedAuBasis);
    // CGT 50%-discount-eligible slice (design 62 §4): gain from lots held ≥12 months
    // from the AU deemed-acquisition date, capped at auGain. Read by the pre-2027
    // rates module so the discount applies only to the eligible portion.
    const auDiscountableGain = Math.min(auGain, r.realizedDiscountableGainByCountry?.AU ?? auGain);
    // Design 90 §9 step 2 — signed and charactered, alongside the floored figures above.
    // An AU brokerage holds no gold sleeve, so there is no collectible slice to split.
    const { usShortTermGain, usLongTermGain, auShortTermGain, auLongTermGain } =
      disposalTermFields(r.realizedGainByCountryAndTerm);

    this.accountService.transaction(state[resolveCashKey(this.stateRegistry, 'AU', state)], salePrice, null);

    const newBalance = +newHoldings.reduce((s, h) => s + (h?.marketValue ?? 0), 0).toFixed(2);
    // Brokerage basis is no longer tracked (design 53 P1) — the FIFO realizedBasis
    // above is the authoritative CGT source.
    return this.newState(
      state,
      {
        [key]: {
          ...sa,
          balance:  newBalance,
          holdings: newHoldings,
        },
      },
      [{ type: 'AU_STOCK_WITHDRAWAL_TAX', gain, auGain, auIndexedGain, auDiscountableGain, residency, usShortTermGain, usLongTermGain, auShortTermGain, auLongTermGain, proceeds: salePrice, costBasis: realizedBasis, description: sa.name || key, stateKey: key },
       // Design 87 G9 — the second Reg. §1.988-2(b)(5) trigger: "or the instrument is
       // disposed of". A foreign-currency bond sold before maturity realizes the same
       // accumulated exchange position a redemption would. Null unless this disposal
       // actually consumed such a lot, so a plain AU equity sale is unchanged.
       ...section988ForBondPrincipal(state, key, sa, r.section988 ?? {})]
    );
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export class AuDividendFrankedResidentHandler extends HandlerEntry {
  static type        = 'AuDividendFrankedResidentHandler';
  static description = 'Dispatches AU_DIVIDEND_FRANKED_RESIDENT_APPLY.';
  static eventType   = 'AU_DIVIDEND_FRANKED_RESIDENT';

  constructor() {
    super(null, 'AU Franked Dividend Resident');
    this.generatedActionTypes = ['AU_DIVIDEND_FRANKED_RESIDENT_APPLY', 'RECORD_BALANCE'];
  }

  call({ data }) {
    return [
      { type: 'AU_DIVIDEND_FRANKED_RESIDENT_APPLY', amount: data.amount },
      new RecordBalanceAction('auStockAccount.balance', 'auStockAccount'),
    ];
  }
}

export class AuDividendFrankedNonResidentHandler extends HandlerEntry {
  static type        = 'AuDividendFrankedNonResidentHandler';
  static description = 'Dispatches AU_DIVIDEND_FRANKED_NONRESIDENT_APPLY.';
  static eventType   = 'AU_DIVIDEND_FRANKED_NONRESIDENT';

  constructor() {
    super(null, 'AU Franked Dividend Non-Resident');
    this.generatedActionTypes = ['AU_DIVIDEND_FRANKED_NONRESIDENT_APPLY', 'RECORD_BALANCE'];
  }

  call({ data }) {
    return [
      { type: 'AU_DIVIDEND_FRANKED_NONRESIDENT_APPLY', amount: data.amount },
      new RecordBalanceAction('auStockAccount.balance', 'auStockAccount'),
    ];
  }
}

export class AuDividendUnfrankedResidentHandler extends HandlerEntry {
  static type        = 'AuDividendUnfrankedResidentHandler';
  static description = 'Dispatches AU_DIVIDEND_UNFRANKED_RESIDENT_APPLY.';
  static eventType   = 'AU_DIVIDEND_UNFRANKED_RESIDENT';

  constructor() {
    super(null, 'AU Unfranked Dividend Resident');
    this.generatedActionTypes = ['AU_DIVIDEND_UNFRANKED_RESIDENT_APPLY', 'RECORD_BALANCE'];
  }

  call({ data }) {
    return [
      { type: 'AU_DIVIDEND_UNFRANKED_RESIDENT_APPLY', amount: data.amount },
      new RecordBalanceAction('auStockAccount.balance', 'auStockAccount'),
    ];
  }
}

export class AuDividendUnfrankedNonResidentHandler extends HandlerEntry {
  static type        = 'AuDividendUnfrankedNonResidentHandler';
  static description = 'Dispatches AU_DIVIDEND_UNFRANKED_NONRESIDENT_APPLY.';
  static eventType   = 'AU_DIVIDEND_UNFRANKED_NONRESIDENT';

  constructor() {
    super(null, 'AU Unfranked Dividend Non-Resident');
    this.generatedActionTypes = ['AU_DIVIDEND_UNFRANKED_NONRESIDENT_APPLY', 'RECORD_BALANCE'];
  }

  call({ data }) {
    return [
      { type: 'AU_DIVIDEND_UNFRANKED_NONRESIDENT_APPLY', amount: data.amount },
      new RecordBalanceAction('auStockAccount.balance', 'auStockAccount'),
    ];
  }
}

export class AuStockEarningsHandler extends HandlerEntry {
  static type        = 'AuStockEarningsHandler';
  static description = 'Dispatches AU_STOCK_EARNINGS_APPLY.';
  static eventType   = 'AU_STOCK_EARNINGS';

  constructor() {
    super(null, 'AU Stock Earnings');
    this.generatedActionTypes = ['AU_STOCK_EARNINGS_APPLY', 'RECORD_BALANCE'];
  }

  call({ data }) {
    return [
      { type: 'AU_STOCK_EARNINGS_APPLY', amount: data.amount },
      new RecordBalanceAction('auStockAccount.balance', 'auStockAccount'),
    ];
  }
}

export class AuStockWithdrawalHandler extends HandlerEntry {
  static type        = 'AuStockWithdrawalHandler';
  static description = 'Dispatches AU_STOCK_WITHDRAWAL_APPLY with sale price, cost basis, and AU residency flag.';
  static eventType   = 'AU_STOCK_WITHDRAWAL';

  constructor() {
    super(null, 'AU Stock Withdrawal');
    this.generatedActionTypes = ['AU_STOCK_WITHDRAWAL_APPLY', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    return [
      {
        type:         'AU_STOCK_WITHDRAWAL_APPLY',
        salePrice:    data.salePrice,
        costBasis:    data.costBasis,
        residency: state.people?.[Object.keys(state.people ?? {})[0]]?.residency ?? null,
      },
      new RecordBalanceAction('auStockAccount.balance', 'auStockAccount'),
    ];
  }
}
