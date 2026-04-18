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
 * Account — plain ledger with balance, credits, and debits.
 * No methods; safe for structuredClone snapshots.
 * Logic lives in AccountService.
 */
export class Account {
  /**
   * @param {number} initialValue - Starting balance (default 0)
   * @param {object} [opts]
   * @param {string}  [opts.ownershipType='sole']  - 'sole' | 'joint'
   * @param {string}  [opts.ownerId=null]          - Person id of the primary owner
   * @param {number}  [opts.minimumBalance=0]      - Lowest allowed balance (AR-1, AR-2)
   * @param {number|null} [opts.drawdownPriority=null] - Liquidation order (1 = first)
   */
  constructor(initialValue = 0, opts = {}) {
    this.balance          = initialValue;
    this.credits          = [];
    this.debits           = [];
    this.ownershipType    = opts.ownershipType    ?? 'sole';
    this.ownerId          = opts.ownerId          ?? null;
    this.minimumBalance   = opts.minimumBalance   ?? 0;
    this.drawdownPriority = opts.drawdownPriority ?? null;
  }
}

export class AccountService {

  /**
   * Perform a transaction on an account.
   * Positive amount → credit; negative amount → debit.
   * @param {Account} account
   * @param {number}  amount
   * @param {Date}    date
   */
  transaction(account, amount, date) {
    if (amount > 0) {
      account.credits.push({ amount, date });
    } else if (amount < 0) {
      account.debits.push({ amount, date });
    }
    account.balance = account.balance + amount;
  }

  /**
   * Returns the balance attributable to one person.
   * Joint ownership splits the balance 50/50.
   * @param {Account} account
   * @returns {number}
   */
  getPersonShare(account) {
    return account.ownershipType === 'joint' ? account.balance / 2 : account.balance;
  }

  /**
   * Returns true if debiting amount would not breach minimumBalance.
   * @param {Account} account
   * @param {number}  amount  - Positive value representing the debit size
   * @returns {boolean}
   */
  canDebit(account, amount) {
    return account.balance - amount >= (account.minimumBalance ?? 0);
  }

  /**
   * Applies a debit only if it won't breach minimumBalance.
   * @param {Account} account
   * @param {number}  amount  - Positive value representing the debit size
   * @param {Date}    date
   * @returns {boolean} true if the debit was applied; false if rejected
   */
  safeDebit(account, amount, date) {
    if (!this.canDebit(account, amount)) return false;
    this.transaction(account, -amount, date);
    return true;
  }

  /**
   * Snapshots the current balance as balanceAtResidencyChange (one-time capture).
   * Only operates on accounts that carry the balanceAtResidencyChange field
   * (i.e. InvestmentAccount instances).  No-op on plain Account objects.
   * @param {Account} account
   */
  recordResidencyChange(account) {
    if ('balanceAtResidencyChange' in account && account.balanceAtResidencyChange === null) {
      account.balanceAtResidencyChange = account.balance;
    }
  }

  /**
   * Returns true if the person meets the account's minimum age requirement.
   * If the account has no minimumAge (null or field absent) always returns true.
   * Uses decimal age to support the 59.5-year gate (401k).
   * @param {Account} account
   * @param {import('./person.js').Person} person
   * @param {Date}    asOfDate
   * @returns {boolean}
   */
  isWithdrawalEligible(account, person, asOfDate) {
    if (!('minimumAge' in account) || account.minimumAge === null) return true;
    const msPerYear  = 365.25 * 24 * 60 * 60 * 1000;
    const ageDecimal = (asOfDate - person.birthDate) / msPerYear;
    return ageDecimal >= account.minimumAge;
  }
}
