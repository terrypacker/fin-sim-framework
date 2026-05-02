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
import { RecordBalanceAction } from '../../simulation-framework/actions.js';
import { TaxSettleService } from '../tax-settle-service.js';

/**
 * Handles CHANGE_RESIDENCY events.
 *
 * Triggered as a one-off event on the date the simulation person moves from
 * the US to AU. Closes the partial US tax year by computing a mid-year US tax
 * liability, then emits the full residency-change sequence:
 *
 *   1. CHANGE_RESIDENCY_APPLY — flips state.isAuResident, snapshots investment
 *      account balances, and adds AU citizenship to all people in state.
 *
 *   2. TAX_SETTLE_APPLY { cc: 'US', tax } — processed by TaxService to reset
 *      YTD accumulators and emit a TAX_PAYMENT_DEBIT if tax > 0.
 *
 *   3. RecordBalanceAction — captures the fully-settled stateAfter snapshot.
 *
 * TaxSettleService is instantiated internally — it is stateless and carries
 * only read-only tax-rates data, so no injection is required.
 */
export class ChangeResidencyHandler extends HandlerEntry {
  static description = 'Closes the partial US tax year and emits CHANGE_RESIDENCY_APPLY + TAX_SETTLE_APPLY on the move date.';

  static eventType = 'CHANGE_RESIDENCY';

  constructor() {
    super(null, 'Change Residency');
    this._settleService = new TaxSettleService();
  }

  call({ state }) {
    const usTax = this._settleService.computeUsTax(state);
    return [
      { type: 'CHANGE_RESIDENCY_APPLY' },
      { type: 'TAX_SETTLE_APPLY', cc: 'US', tax: usTax },
      new RecordBalanceAction(),
    ];
  }
}
