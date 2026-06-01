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

import {ACCOUNT_TYPE} from "../assets/account.js";

/**
 * Descriptor for how a state field value should be interpreted and displayed.
 * Used by the display layer to format raw numbers with the right currency,
 * unit, or precision — without baking that context into raw journal data.
 */
export class ValueType {
  constructor(kind, options = {}) {
    this.kind         = kind;
    this.currencyCode = options.currencyCode ?? null; // string|null — for kind 'currency'
    this.precision    = options.precision    ?? 2;    // number      — for kind 'decimal'
  }

  static currency(code = null) { return new ValueType('currency', { currencyCode: code }); }
  static rate()                { return new ValueType('rate'); }
  static percentage()          { return new ValueType('percentage'); }
  static integer()             { return new ValueType('integer'); }
  static decimal(precision=2)  { return new ValueType('decimal', { precision }); }
  static boolean()             { return new ValueType('boolean'); }
  static date()                { return new ValueType('date'); }
  static text()                { return new ValueType('text'); }
  static metric()              { return new ValueType('metric'); }
  static unknown()             { return new ValueType('unknown'); }
}

function _globToRegex(glob) {
  // Escape regex special chars (but not *)
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // ** before * to avoid double-replace
  const pattern = escaped.replace(/\*\*/g, '.+').replace(/\*/g, '[^.]+');
  return new RegExp(`^${pattern}$`);
}

function _fmt(vt, value) {
  if (value == null) return '—';
  switch (vt.kind) {
    case 'currency': {
      if (typeof value !== 'number') return String(value);
      if (vt.currencyCode) {
        return new Intl.NumberFormat('en-US', { style: 'currency', currency: vt.currencyCode }).format(value);
      }
      return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    case 'rate':
      return typeof value === 'number'
        ? value.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 6 })
        : String(value);
    case 'percentage':
      return typeof value === 'number' ? `${(value * 100).toFixed(2)}%` : String(value);
    case 'integer':
    case 'metric':
      return typeof value === 'number' ? Math.round(value).toLocaleString('en-US') : String(value);
    case 'decimal':
      return typeof value === 'number'
        ? value.toLocaleString('en-US', { minimumFractionDigits: vt.precision, maximumFractionDigits: vt.precision })
        : String(value);
    case 'boolean':
      return String(value);
    case 'date':
      return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
    case 'text':
    case 'unknown':
    default:
      return typeof value === 'number'
        ? value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : String(value);
  }
}

/**
 * Maps state field paths to ValueType descriptors so the display layer can
 * format raw journal values with correct currency, unit, and precision.
 *
 * Resolution order: exact path → first matching glob pattern → unknown.
 * registerAccount() stamps exact paths from a stamped Account, overriding
 * any glob pattern for that account's fields.
 *
 * Usage:
 *   registry.register('exchangeRateUsdToAud', ValueType.rate());
 *   registry.registerPattern('*.balance', ValueType.currency());
 *   registry.registerAccount('usSavingsAccount', account); // exact → currency('USD')
 *   registry.format('usSavingsAccount.balance', 50000);    // → '$50,000.00'
 */
export class StateSchemaRegistry {
  constructor() {
    this._exact    = new Map(); // path → ValueType
    this._patterns = [];       // [{ re, vt }] ordered by registration

    // ── Glob patterns ─────────────────────────────────────────────────────────
    this.registerPattern('*.balance',           ValueType.currency());
    this.registerPattern('*.contributionBasis', ValueType.currency());
    this.registerPattern('*.earningsBasis',     ValueType.currency());
    this.registerPattern('*.minimumBalance',    ValueType.currency());
    this.registerPattern('metrics.*',           ValueType.metric());

    // ── Well-known exact fields ───────────────────────────────────────────────
    this.register('exchangeRateUsdToAud',        ValueType.rate());
    this.register('isAuResident',                ValueType.boolean());
    this.register('scenarioFailed',              ValueType.boolean());
    this.register('superWithdrawalBlocked',      ValueType.boolean());
    this.register('outOfFundsDate',              ValueType.date());
    this.register('monthlyExpenses',             ValueType.currency('USD'));

    // US YTD
    this.register('usOrdinaryIncomeYTD',         ValueType.currency('USD'));
    this.register('usNegativeIncomeYTD',         ValueType.currency('USD'));
    this.register('usCapitalGainsYTD',           ValueType.currency('USD'));
    this.register('usCollectibleGainsYTD',       ValueType.currency('USD'));
    this.register('usPenaltyYTD',                ValueType.currency('USD'));
    this.register('ftcYTD',                      ValueType.currency('USD'));
    this.register('cumulativeDeficit',           ValueType.currency('USD'));

    // AU YTD
    this.register('auOrdinaryIncomeYTD',         ValueType.currency('AUD'));
    this.register('auCapitalGainsYTD',           ValueType.currency('AUD'));
    this.register('auNonResidentWithholdingYTD', ValueType.currency('AUD'));
    this.register('auSuperTaxYTD',               ValueType.currency('AUD'));
    this.register('auFrankingCreditYTD',         ValueType.currency('AUD'));

    this.register('intlTransferFeeUsd',          ValueType.currency('USD'));
    this.register('inflationAccumulator',        ValueType.decimal(4));
  }

  /**
   * Register an exact-path → ValueType mapping.
   * Overwrites any prior registration for the same path.
   */
  register(path, valueType) {
    this._exact.set(path, valueType);
  }

  /**
   * Register a glob pattern → ValueType mapping.
   * Patterns are tested in registration order; first match wins.
   * Supported wildcards: `*` = one segment (no dots), `**` = any segments.
   */
  registerPattern(glob, valueType) {
    this._patterns.push({ re: _globToRegex(glob), vt: valueType });
  }

  /**
   * Register exact field paths for an account, using the account's currency.
   * Call once per account immediately after _assignAccount() stamps stateKey.
   * Exact registrations override any matching glob pattern for that account.
   *
   * @param {string}  stateKey  - e.g. 'usSavingsAccount'
   * @param {object}  account   - Account instance; reads account.currency?.code
   */
  registerAccount(stateKey, account) {
    const code = account?.currency?.code ?? null;
    const vt   = ValueType.currency(code);
    this.register(`${stateKey}.balance`,          vt);
    this.register(`${stateKey}.contributionBasis`, vt);
    this.register(`${stateKey}.earningsBasis`,    vt);
    this.register(`${stateKey}.minimumBalance`,   vt);
    if (account.type === ACCOUNT_TYPE.BROKERAGE && 'earningsBasis' in account) {
      this.register(`${stateKey}.earningsBasis`,   vt);
    }
  }

  /**
   * Resolve the ValueType for a field path.
   * Returns ValueType.unknown() when no registration matches.
   *
   * @param {string} fieldPath - e.g. 'usSavingsAccount.balance'
   * @returns {ValueType}
   */
  resolve(fieldPath) {
    const exact = this._exact.get(fieldPath);
    if (exact) return exact;
    for (const { re, vt } of this._patterns) {
      if (re.test(fieldPath)) return vt;
    }
    return ValueType.unknown();
  }

  /**
   * Format a value using its registered ValueType.
   * For unknown or non-numeric types that need richer formatting
   * (dates, objects, arrays), returns null so the caller can fall back
   * to its own renderer.
   *
   * @param {string} fieldPath
   * @param {*}      value
   * @returns {string|null}  formatted string, or null for unknown/non-scalar
   */
  format(fieldPath, value) {
    if (value == null) return '—';
    const vt = this.resolve(fieldPath);
    if (vt.kind === 'unknown' && typeof value !== 'number') return null;
    return _fmt(vt, value);
  }

}
