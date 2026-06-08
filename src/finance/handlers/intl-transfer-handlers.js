/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HandlerEntry } from '../../simulation-framework/handlers.js';
import { RecordBalanceAction, RecordMetricAction } from '../../simulation-framework/actions.js';

/**
 * Handles user-triggered INTL_TRANSFER_TO_US events (AUD → USD).
 *
 * data.amount is the AUD amount the user wants to send from the AU savings account.
 * The actual AUD withdrawn is capped to the available balance; the USD received
 * is computed after the fixed fee is subtracted:
 *
 *   audActual     = min(data.amount, auSavings.balance)
 *   targetDeficit = max(0, audActual / rate − fee)   [USD to land in US account]
 *
 * Emits INTL_TRANSFER_APPLY direction=AU_TO_US so IntlTransferApplyReducer
 * handles the actual ledger mutations.
 *
 * @param {object} [opts]
 * @param {import('../services/state-registry.js').StateRegistry} opts.stateRegistry
 * @param {string} opts.auRole      - ACCOUNT_ROLES value for the AU savings account
 * @param {string} [opts.auOwnerId] - Person id for AU savings (null = any owner)
 * @param {string} opts.usRole      - ACCOUNT_ROLES value for the US savings account
 * @param {string} [opts.usOwnerId] - Person id for US savings (null = any owner)
 */
export class IntlTransferToUsHandler extends HandlerEntry {
  static description = 'User-triggered AUD→USD transfer: converts data.amount AUD to USD using state exchange rate and fee, emitting INTL_TRANSFER_APPLY direction=AU_TO_US.';
  static type        = 'IntlTransferToUsHandler';
  static eventType   = 'INTL_TRANSFER_TO_US';

  constructor({ stateRegistry, auRole, auOwnerId = null, usRole, usOwnerId = null } = {}) {
    super(null, 'International Transfer to US');
    this.stateRegistry = stateRegistry;
    this.auRole        = auRole;
    this.auOwnerId     = auOwnerId;
    this.usRole        = usRole;
    this.usOwnerId     = usOwnerId;
    this.generatedActionTypes = ['INTL_TRANSFER_APPLY', 'RECORD_METRIC', 'RECORD_BALANCE'];
  }

  static fromJSON(d, { stateRegistry }) {
    const h = new this({ stateRegistry, auRole: d.auRole, auOwnerId: d.auOwnerId ?? null, usRole: d.usRole, usOwnerId: d.usOwnerId ?? null });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return { ...super.toJSON(), auRole: this.auRole, auOwnerId: this.auOwnerId, usRole: this.usRole, usOwnerId: this.usOwnerId };
  }

  call({ state, data }) {
    const amount        = data?.amount ?? 0;
    const rate          = state.effectiveExchangeRates?.USD_AUD ?? 1.55;
    const fee           = state.effectiveFxFees?.USD_AUD        ?? 15;
    const auBalance     = this.stateRegistry.getAccount(state, this.auRole, this.auOwnerId)?.balance ?? 0;
    const audActual     = Math.min(amount, auBalance);
    const targetDeficit = Math.max(0, audActual / rate - fee);
    const usStateKey    = this.stateRegistry.getStateKey(this.usRole, this.usOwnerId);
    return [
      { type: 'INTL_TRANSFER_APPLY', direction: 'AU_TO_US', targetDeficit },
      new RecordMetricAction('intl_transfer_to_us', targetDeficit),
      new RecordBalanceAction(`${usStateKey}.balance`, usStateKey),
    ];
  }
}

/**
 * Handles user-triggered INTL_TRANSFER_TO_AU events (USD → AUD).
 *
 * data.amount is the USD amount the user wants to send from the US savings account.
 * The actual USD withdrawn is capped to the available balance; the AUD received
 * is computed after the fixed fee is subtracted:
 *
 *   usdActual     = min(data.amount, usSavings.balance)
 *   targetDeficit = max(0, (usdActual − fee) × rate)   [AUD to land in AU account]
 *
 * Emits INTL_TRANSFER_APPLY direction=US_TO_AU so IntlTransferApplyReducer
 * handles the actual ledger mutations.
 *
 * @param {object} [opts]
 * @param {import('../services/state-registry.js').StateRegistry} opts.stateRegistry
 * @param {string} opts.usRole      - ACCOUNT_ROLES value for the US savings account
 * @param {string} [opts.usOwnerId] - Person id for US savings (null = any owner)
 * @param {string} opts.auRole      - ACCOUNT_ROLES value for the AU savings account
 * @param {string} [opts.auOwnerId] - Person id for AU savings (null = any owner)
 */
export class IntlTransferToAuHandler extends HandlerEntry {
  static description = 'User-triggered USD→AUD transfer: converts data.amount USD to AUD using state exchange rate and fee, emitting INTL_TRANSFER_APPLY direction=US_TO_AU.';
  static type        = 'IntlTransferToAuHandler';
  static eventType   = 'INTL_TRANSFER_TO_AU';

  constructor({ stateRegistry, usRole, usOwnerId = null, auRole, auOwnerId = null } = {}) {
    super(null, 'International Transfer to AU');
    this.stateRegistry = stateRegistry;
    this.usRole        = usRole;
    this.usOwnerId     = usOwnerId;
    this.auRole        = auRole;
    this.auOwnerId     = auOwnerId;
    this.generatedActionTypes = ['INTL_TRANSFER_APPLY', 'RECORD_METRIC', 'RECORD_BALANCE'];
  }

  static fromJSON(d, { stateRegistry }) {
    const h = new this({ stateRegistry, usRole: d.usRole, usOwnerId: d.usOwnerId ?? null, auRole: d.auRole, auOwnerId: d.auOwnerId ?? null });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return { ...super.toJSON(), usRole: this.usRole, usOwnerId: this.usOwnerId, auRole: this.auRole, auOwnerId: this.auOwnerId };
  }

  call({ state, data }) {
    const amount        = data?.amount ?? 0;
    const rate          = state.effectiveExchangeRates?.USD_AUD ?? 1.55;
    const fee           = state.effectiveFxFees?.USD_AUD        ?? 15;
    const usBalance     = this.stateRegistry.getAccount(state, this.usRole, this.usOwnerId)?.balance ?? 0;
    const usdActual     = Math.min(amount, usBalance);
    const targetDeficit = Math.max(0, (usdActual - fee) * rate);
    const auStateKey    = this.stateRegistry.getStateKey(this.auRole, this.auOwnerId);
    return [
      { type: 'INTL_TRANSFER_APPLY', direction: 'US_TO_AU', targetDeficit },
      new RecordMetricAction('intl_transfer_to_au', targetDeficit),
      new RecordBalanceAction(`${auStateKey}.balance`, auStateKey),
    ];
  }
}
