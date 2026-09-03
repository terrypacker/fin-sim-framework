/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY }      from '../../simulation-framework/reducers.js';
import { RecordBalanceAction }    from '../../simulation-framework/actions.js';
import { InsufficientFundsError } from '../assets/account.js';
import { currencyOf }             from '../fx/to-base-currency.js';
import { depositKeyFor, purchaseTargetFor } from './liquidity-graph.js';

/**
 * DESIGN 97 §12.4 — EXECUTOR 2, the cross-account pool flow.
 *
 * An edge moves value between two pools. When both ends sit inside the rebalanceable book
 * the design-61 rebalancer moves it and this reducer never sees it (that is executor 1, and
 * it is free — no new disposal path, no new tax path). When either end is a cash-like
 * account the move is a real debit and credit, and it comes here.
 *
 * The whole design of this reducer is **that it does not move money itself**. It delegates
 * to `AccountService.replenishSavings` with a scoped source list, which is the seam every
 * spending draw already goes through: the sleeve-narrowed FIFO consume, the withdrawal-tax
 * actions, the §988 realization on a cross-currency leg, `INTL_TRANSFER_RECORD`. This repo
 * has three separate memories of the same bug — a new way to move money that skips the
 * taxing seam and produces a believable untaxed number — and a refill edge that draws a
 * brokerage would be the fourth.
 *
 * An under-filled flow is normal, not an error: a scoped draw returns its `shortfall`
 * instead of escalating, because a pool that could not be filled is the honest outcome and
 * paying a 10 % early-withdrawal penalty to hide it is not a refill policy.
 */
export class PoolFlowApplyReducer extends Reducer {
  static type        = 'PoolFlowApplyReducer';
  static description = 'Executes a design-97 cross-account pool flow by delegating to AccountService.replenishSavings with a scoped source list, so withdrawal tax, §988 and INTL_TRANSFER_RECORD all fire as they do for spending.';

  /**
   * @param {object} opts
   * @param {import('../services/account-service.js').AccountService} opts.accountService
   * @param {{pools:Array}} opts.graph  - the normalized graph (claims + deposit resolution)
   * @param {Array<{stateKey:string,type:string}>} opts.accounts
   * @param {string} [opts.baseCurrency='USD']
   */
  constructor({ accountService, graph, accounts = [], baseCurrency = 'USD' } = {}) {
    // POSITION_UPDATE, matching every other apply reducer. Note what the framework's
    // queueing then implies for the ORDER within a period: emitted actions are unshifted, so
    // the rebalancer (which decides at PRE_PROCESS + 4, one step after the flow reducer)
    // gets its APPLY processed first, and the cross-account transfer runs after it. That is
    // the right way round — rebalance to the (possibly vetoed) target, then raise the cash.
    super('Pool Flow Apply', PRIORITY.POSITION_UPDATE);
    this.accountService = accountService;
    this.graph          = graph;
    this.baseCurrency   = baseCurrency;
    this._byKey         = new Map((accounts ?? []).map(a => [a.stateKey, a]));
    this.reducedActionTypes   = ['POOL_FLOW_APPLY'];
    this.generatedActionTypes = ['RECORD_BALANCE', 'INTL_TRANSFER_RECORD'];
  }

  reduce(state, action, date) {
    const { from, to, amountBase, flowId } = action;
    const src = this.graph?.pools?.find(p => p.id === from);
    const dst = this.graph?.pools?.find(p => p.id === to);
    if (!src || !dst || !(amountBase > 0)) return this.newState(state);

    // Two shapes of destination (design 97 §12.4a). A pool with a cash-like claim is a
    // DEPOSIT; a pool that is one brokerage account narrowed to one sleeve is a PURCHASE of
    // that sleeve — the offset buying the dip, which has no cash-like account to land in and
    // is not reachable by executor 1 because the offset is not in the rebalanceable book.
    // Both raise the money the same way, through the scoped `replenishSavings` draw; they
    // differ only in what the credit becomes.
    const depositKey = depositKeyFor(dst, this._byKey);
    const purchase   = depositKey ? null : purchaseTargetFor(dst, this._byKey);
    const targetKey  = depositKey ?? purchase?.key ?? null;
    const target     = targetKey ? state[targetKey] : null;
    if (!target) return this.newState(state);

    // `amountBase` is in the valuation base currency (that is the only currency in which
    // the graph's targets and triggers mean anything); `replenishSavings` wants the deposit
    // in the TARGET account's own currency. Converting here rather than earlier keeps the
    // graph currency-agnostic and the draw currency-exact.
    const ccy  = currencyOf(target, this.baseCurrency);
    const rate = ccy === this.baseCurrency ? 1 : (state.effectiveExchangeRates?.[`${this.baseCurrency}_${ccy}`] ?? 1);
    const want = amountBase * rate;

    // The scope: this pool's claims, minus the deposit account itself. Drawing the target of
    // the transfer to fund the transfer is a no-op that still books a disposal.
    const scopedSources = src.claims
      .filter(c => c.key !== targetKey)
      .map(c => ({ key: c.key, sleeves: c.sleeves ?? null }));
    if (!scopedSources.length) return this.newState(state);

    let result;
    try {
      result = this.accountService.replenishSavings(state, targetKey, want, date,
        { scopedSources, depositAllocation: purchase?.allocation ?? null });
    } catch (e) {
      // A scoped draw does not throw InsufficientFunds by construction, but if a future
      // change makes it, the accruals still have to reach the tax engine — an aborted refill
      // that swallows its own realized gains is the `tax-payment-funding-untaxed` shape.
      if (!(e instanceof InsufficientFundsError)) throw e;
      result = e.partial ?? {};
    }
    const { drawnKeys = [], pendingTaxActions = [], crossBorderTransfers = [] } = result;
    const balanceActions = [...new Set([...drawnKeys, targetKey])].map(k => new RecordBalanceAction(`${k}.balance`, k));
    return this.newState(state, {}, [...balanceActions, ...crossBorderTransfers, ...pendingTaxActions]);
  }

  toJSON() {
    return { ...super.toJSON(), graph: this.graph, baseCurrency: this.baseCurrency };
  }

  static fromJSON(d, { accountService } = {}) {
    const r = new this({ ...d, accountService });
    r.id = d.id;
    return r;
  }
}
