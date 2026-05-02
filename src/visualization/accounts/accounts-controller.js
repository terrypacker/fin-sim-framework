/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { AccountBuilder } from '../../finance/builders/account-builder.js';
import { USD, AUD }       from '../../finance/account.js';

// Account types whose country/currency are variable (US or AU).
const VARIABLE_COUNTRY = new Set(['checking', 'savings', 'brokerage']);

// Account types that are investment accounts (have contributionBasis / earningsBasis).
const INVESTMENT_TYPES = new Set(['brokerage', '401k', 'roth', 'ira', 'super']);

/**
 * AccountsController — pure domain layer for Account CRUD.
 * No DOM, no bus, no globals — all dependencies injected.
 */
export class AccountsController {
  /** @param {{ accountService: import('../../finance/services/account-service.js').AccountService }} */
  constructor({ accountService }) {
    this._service = accountService;
  }

  /**
   * Build and register a new account from raw form data.
   *
   * @param {{
   *   type: string, name: string, balance: number|string,
   *   country: string, ownershipType: string, ownerId: string|null,
   *   minimumBalance: number|string, drawdownPriority: number|string|null,
   *   contributionBasis?: number|string, earningsBasis?: number|string
   * }} data
   */
  create(data) {
    const builder = this._builderFor(data.type);

    builder
      .name(data.name)
      .initialValue(Number(data.balance) || 0)
      .ownershipType(data.ownershipType || 'sole')
      .ownerId(data.ownerId || null)
      .minimumBalance(Number(data.minimumBalance) || 0);

    const dp = data.drawdownPriority;
    if (dp !== '' && dp != null) builder.drawdownPriority(Number(dp));

    if (VARIABLE_COUNTRY.has(data.type)) {
      const ctry = data.country || 'US';
      builder.country(ctry).currency(ctry === 'AU' ? AUD : USD);
    }

    if (INVESTMENT_TYPES.has(data.type)) {
      if (data.contributionBasis != null && data.contributionBasis !== '') {
        builder.contributionBasis(Number(data.contributionBasis));
      }
      builder.earningsBasis(Number(data.earningsBasis) || 0);
    }

    return this._service.createAccount(builder.build());
  }

  /**
   * Apply field-level updates to an existing account.
   * Type cannot change after creation.
   *
   * @param {string} id
   * @param {object} changes
   */
  update(id, changes) {
    const n = { ...changes };
    if ('balance'          in n) n.balance          = Number(n.balance)          || 0;
    if ('minimumBalance'   in n) n.minimumBalance   = Number(n.minimumBalance)   || 0;
    if ('contributionBasis'in n) n.contributionBasis= Number(n.contributionBasis)|| 0;
    if ('earningsBasis'    in n) n.earningsBasis    = Number(n.earningsBasis)    || 0;
    if ('drawdownPriority' in n) {
      const dp = n.drawdownPriority;
      n.drawdownPriority = (dp === '' || dp == null) ? null : Number(dp);
    }
    return this._service.updateAccount(id, n);
  }

  /** @param {string} id */
  delete(id) {
    return this._service.deleteAccount(id);
  }

  /** @returns {import('../../finance/account.js').Account[]} */
  list() {
    return this._service.getAll();
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  _builderFor(type) {
    switch (type) {
      case 'checking': return AccountBuilder.checking();
      case 'savings':  return AccountBuilder.savings();
      case 'brokerage':return AccountBuilder.brokerage();
      case '401k':     return AccountBuilder.fourOhOneK();
      case 'roth':     return AccountBuilder.roth();
      case 'ira':      return AccountBuilder.traditionalIRA();
      case 'super':    return AccountBuilder.super();
      default:         throw new Error(`AccountsController: unknown account type "${type}"`);
    }
  }
}
