/*
 * Copyright (c) 2026 Terry Packer.
 *
 * This file is part of Terry Packer's Work.
 * See www.terrypacker.com for further info.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Currency descriptor — code and display symbol.
 * @typedef {{ code: string, symbol: string }} Currency
 */

/** US Dollar */
export const USD = { code: 'USD', symbol: '$' };

/** Australian Dollar */
export const AUD = { code: 'AUD', symbol: 'A$' };

/**
 * Discriminator strings for all supported account types.
 * Used for UI display, serialization, and type-guarded builder methods.
 *
 * Country availability:
 *   US only:  FOUR_OH_ONE_K, ROTH, TRADITIONAL_IRA
 *   AU only:  SUPER
 *   US + AU:  CHECKING, SAVINGS, BROKERAGE
 */
export const ACCOUNT_TYPE = Object.freeze({
  CHECKING:        'checking',
  SAVINGS:         'savings',
  BROKERAGE:       'brokerage',
  FOUR_OH_ONE_K:   '401k',
  ROTH:            'roth',
  TRADITIONAL_IRA: 'ira',
  SUPER:           'super',
});

/**
 * Thrown by AccountService.replenishSavings when all eligible accounts in a
 * country are exhausted and the requested deficit could not be fully covered.
 */
export class InsufficientFundsError extends Error {
  /**
   * @param {string} country   - ISO country code (e.g. 'US', 'AU')
   * @param {string} currency  - Currency code (e.g. 'USD', 'AUD')
   * @param {number} remaining - Amount still unmet after exhausting all accounts
   */
  constructor(country, currency, remaining) {
    super(
      `Insufficient funds: ${remaining.toFixed(2)} ${currency} still needed ` +
      `after exhausting all eligible ${country} accounts`
    );
    this.name      = 'InsufficientFundsError';
    this.country   = country;
    this.currency  = currency;
    this.remaining = remaining;
  }
}

/**
 * Account — plain ledger with balance, credits, and debits.
 * No methods; safe for structuredClone snapshots.
 * Logic lives in AccountService (src/finance/services/account-service.js).
 *
 * Design note: Account intentionally does NOT extend Asset.
 * Asset models a non-ledger market-value holding (real property, value/costBasis).
 * Account models a transaction ledger (balance, credits[], debits[]).
 * They share some opts (ownershipType, ownerId, drawdownPriority) but their
 * mechanics and service methods are fundamentally different.
 */
export class Account {
  /**
   * @param {number} initialValue - Starting balance (default 0)
   * @param {object} [opts]
   * @param {string|null}   [opts.id=null]              - Assigned by AccountService; null until registered
   * @param {string}        [opts.name='']              - Display name for UI
   * @param {string|null}   [opts.type=null]            - Account type discriminator (ACCOUNT_TYPE value)
   * @param {string}        [opts.ownershipType='sole'] - 'sole' | 'joint'
   * @param {string|null}   [opts.ownerId=null]         - Person id of primary owner
   * @param {number}        [opts.minimumBalance=0]     - Lowest allowed balance
   * @param {number|null}   [opts.drawdownPriority=null] - Liquidation order (1 = first), null = exclude from drawdown
   * @param {string|null}   [opts.country=null]         - ISO country code (e.g. 'US', 'AU')
   * @param {Currency|null} [opts.currency=null]        - Currency descriptor (e.g. USD, AUD)
   */
  constructor(initialValue = 0, opts = {}) {
    this.id               = opts.id               ?? null;
    this.name             = opts.name             ?? '';
    this.type             = opts.type             ?? null;
    this.balance          = initialValue;
    this.credits          = [];
    this.debits           = [];
    this.ownershipType    = opts.ownershipType    ?? 'sole';
    this.ownerId          = opts.ownerId          ?? null;
    this.minimumBalance   = opts.minimumBalance   ?? 0;
    this.drawdownPriority = opts.drawdownPriority ?? null;
    this.country          = opts.country          ?? null;
    this.currency         = opts.currency         ?? null;
  }
}

/**
 * CheckingAccount — liquid cash account for everyday transactions.
 * Available in US and AU.
 * Enforces a minimum balance (default 0; set via opts.minimumBalance).
 */
export class CheckingAccount extends Account {
  /**
   * @param {number} initialValue
   * @param {object} [opts] - All Account opts; type is set automatically
   */
  constructor(initialValue = 0, opts = {}) {
    super(initialValue, { ...opts, type: ACCOUNT_TYPE.CHECKING });
  }
}

/**
 * SavingsAccount — interest-bearing deposit account.
 * Available in US and AU.
 * Enforces a minimum balance (default 0; set via opts.minimumBalance).
 */
export class SavingsAccount extends Account {
  /**
   * @param {number} initialValue
   * @param {object} [opts] - All Account opts; type is set automatically
   */
  constructor(initialValue = 0, opts = {}) {
    super(initialValue, { ...opts, type: ACCOUNT_TYPE.SAVINGS });
  }
}
