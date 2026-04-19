/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Account } from './account.js';

/**
 * InvestmentAccount — extends Account with fields for investment-type accounts
 * (Roth, IRA, 401k, US/AU brokerage stocks, Superannuation).
 *
 * No methods; safe for structuredClone snapshots.
 * Logic lives in AccountService.
 */
export class InvestmentAccount extends Account {
  /**
   * @param {number} initialValue - Starting balance (default 0)
   * @param {object} [opts]       - All Account opts, plus:
   * @param {number}      [opts.contributionBasis]       - Defaults to initialValue
   * @param {number}      [opts.earningsBasis=0]
   * @param {number}      [opts.loanBalance=0]           - Outstanding loan (AR-5, AR-8 if applicable)
   * @param {number|null} [opts.minimumAge=null]         - Age gate in decimal years (e.g. 59.5, 60)
   */
  constructor(initialValue = 0, opts = {}) {
    super(initialValue, opts);
    this.contributionBasis        = opts.contributionBasis ?? initialValue;
    this.earningsBasis            = opts.earningsBasis     ?? 0;
    this.balanceAtResidencyChange = null;   // set by AccountService.recordResidencyChange
    this.loanBalance              = opts.loanBalance       ?? 0;
    this.minimumAge               = opts.minimumAge        ?? null;
  }
}
