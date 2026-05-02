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
 * data.amount is the AUD amount the user wants to send from auSavingsAccount.
 * The actual AUD withdrawn is capped to the available balance; the USD received
 * is computed after the fixed fee is subtracted. The computation is:
 *
 *   audActual     = min(data.amount, auSavingsAccount.balance)
 *   targetDeficit = max(0, audActual / rate − fee)   [USD to land in US account]
 *
 * Emits INTL_TRANSFER_APPLY direction=AU_TO_US so IntlTransferApplyReducer
 * handles the actual ledger mutations.
 *
 * Exchange rate and fee are read from state (state.exchangeRateUsdToAud,
 * state.intlTransferFeeUsd) at event time.
 *
 * @param {object} [opts]
 * @param {string} [opts.auAccountKey='auSavingsAccount']
 * @param {string} [opts.usAccountKey='usSavingsAccount']
 */
export class IntlTransferToUsHandler extends HandlerEntry {
  static description = 'User-triggered AUD→USD transfer: converts data.amount AUD to USD using state exchange rate and fee, emitting INTL_TRANSFER_APPLY direction=AU_TO_US.';

  static eventType = 'INTL_TRANSFER_TO_US';

  constructor({ auAccountKey = 'auSavingsAccount', usAccountKey = 'usSavingsAccount' } = {}) {
    super(null, 'International Transfer to US');
    this.auAccountKey = auAccountKey;
    this.usAccountKey = usAccountKey;
  }

  call({ state, data }) {
    const amount        = data?.amount ?? 0;
    const rate          = state.exchangeRateUsdToAud;
    const fee           = state.intlTransferFeeUsd;
    const audActual     = Math.min(amount, state[this.auAccountKey].balance);
    const targetDeficit = Math.max(0, audActual / rate - fee);
    return [
      { type: 'INTL_TRANSFER_APPLY', direction: 'AU_TO_US', targetDeficit },
      new RecordMetricAction('intl_transfer_to_us', targetDeficit),
      new RecordBalanceAction(),
    ];
  }
}

/**
 * Handles user-triggered INTL_TRANSFER_TO_AU events (USD → AUD).
 *
 * data.amount is the USD amount the user wants to send from usSavingsAccount.
 * The actual USD withdrawn is capped to the available balance; the AUD received
 * is computed after the fixed fee is subtracted. The computation is:
 *
 *   usdActual     = min(data.amount, usSavingsAccount.balance)
 *   targetDeficit = max(0, (usdActual − fee) × rate)   [AUD to land in AU account]
 *
 * Emits INTL_TRANSFER_APPLY direction=US_TO_AU so IntlTransferApplyReducer
 * handles the actual ledger mutations.
 *
 * @param {object} [opts]
 * @param {string} [opts.usAccountKey='usSavingsAccount']
 * @param {string} [opts.auAccountKey='auSavingsAccount']
 */
export class IntlTransferToAuHandler extends HandlerEntry {
  static description = 'User-triggered USD→AUD transfer: converts data.amount USD to AUD using state exchange rate and fee, emitting INTL_TRANSFER_APPLY direction=US_TO_AU.';

  static eventType = 'INTL_TRANSFER_TO_AU';

  constructor({ usAccountKey = 'usSavingsAccount', auAccountKey = 'auSavingsAccount' } = {}) {
    super(null, 'International Transfer to AU');
    this.usAccountKey = usAccountKey;
    this.auAccountKey = auAccountKey;
  }

  call({ state, data }) {
    const amount        = data?.amount ?? 0;
    const rate          = state.exchangeRateUsdToAud;
    const fee           = state.intlTransferFeeUsd;
    const usdActual     = Math.min(amount, state[this.usAccountKey].balance);
    const targetDeficit = Math.max(0, (usdActual - fee) * rate);
    return [
      { type: 'INTL_TRANSFER_APPLY', direction: 'US_TO_AU', targetDeficit },
      new RecordMetricAction('intl_transfer_to_au', targetDeficit),
      new RecordBalanceAction(),
    ];
  }
}
