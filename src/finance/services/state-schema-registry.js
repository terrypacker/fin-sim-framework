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
export class ParameterValueType {
  constructor(kind, options = {}) {
    this.kind         = kind;
    this.currencyCode = options.currencyCode ?? null; // string|null — for kind 'currency'
    this.precision    = options.precision    ?? 2;    // number      — for kind 'decimal'
  }

  static currency(code = null) { return new ParameterValueType('currency', { currencyCode: code }); }
  static rate()                { return new ParameterValueType('rate'); }
  static percentage()          { return new ParameterValueType('percentage'); }
  static integer()             { return new ParameterValueType('integer'); }
  static decimal(precision=2)  { return new ParameterValueType('decimal', { precision }); }
  static boolean()             { return new ParameterValueType('boolean'); }
  static date()                { return new ParameterValueType('date'); }
  static text()                { return new ParameterValueType('text'); }
  static metric()              { return new ParameterValueType('metric'); }
  static unknown()             { return new ParameterValueType('unknown'); }
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
 *   registry.registerPattern('effectiveExchangeRates.*', ParameterValueType.rate());
 *   registry.registerPattern('*.balance', ParameterValueType.currency());
 *   registry.registerAccount('usSavingsAccount', account); // exact → currency('USD')
 *   registry.format('usSavingsAccount.balance', 50000);    // → '$50,000.00'
 */
export class StateSchemaRegistry {
  constructor() {
    this._exact    = new Map(); // path → ParameterValueType
    this._patterns = [];       // [{ re, vt }] ordered by registration

    // ── Glob patterns ─────────────────────────────────────────────────────────
    this.registerPattern('*.balance',           ParameterValueType.currency());
    this.registerPattern('*.contributionBasis', ParameterValueType.currency());
    this.registerPattern('*.earningsBasis',     ParameterValueType.currency());
    this.registerPattern('*.minimumBalance',    ParameterValueType.currency());
    this.registerPattern('metrics.*',           ParameterValueType.metric());

    // Holdings (design 25 §5.6). Per-account exact paths take precedence
    // when an account stamps them with its specific currency; globs cover
    // anything the per-account stamp misses.
    this.registerPattern('*.holdings.*.marketValue', ParameterValueType.currency());
    this.registerPattern('*.holdings.*.costBasis',   ParameterValueType.currency());
    this.registerPattern('*.holdings.*.allocation',  ParameterValueType.text());
    this.registerPattern('*.holdings.*.rateKey',     ParameterValueType.text());
    this.registerPattern('*.holdings.*.label',       ParameterValueType.text());
    this.registerPattern('*.holdings.*.purchaseDate', ParameterValueType.date());

    // ── FX rate/fee maps ──────────────────────────────────────────────────────
    this.registerPattern('baseExchangeRates.*',      ParameterValueType.rate());
    this.registerPattern('effectiveExchangeRates.*', ParameterValueType.rate());
    this.registerPattern('baseFxFees.*',             ParameterValueType.currency('USD'));
    this.registerPattern('effectiveFxFees.*',        ParameterValueType.currency('USD'));

    // ── Well-known exact fields ───────────────────────────────────────────────
    this.registerPattern('people.*.residency',    ParameterValueType.text());
    this.register('scenarioFailed',              ParameterValueType.boolean());
    this.register('superWithdrawalBlocked',      ParameterValueType.boolean());
    this.register('outOfFundsDate',              ParameterValueType.date());
    this.register('monthlyExpenses',             ParameterValueType.currency('USD'));

    // US YTD
    this.register('usOrdinaryIncomeYTD',         ParameterValueType.currency('USD'));
    this.register('usNegativeIncomeYTD',         ParameterValueType.currency('USD'));
    this.register('usCapitalGainsYTD',           ParameterValueType.currency('USD'));
    this.register('usCollectibleGainsYTD',       ParameterValueType.currency('USD'));
    this.register('usPenaltyYTD',                ParameterValueType.currency('USD'));
    this.register('ftcYTD',                      ParameterValueType.currency('USD'));
    this.register('cumulativeDeficit',           ParameterValueType.currency('USD'));

    // AU YTD
    this.register('auOrdinaryIncomeYTD',         ParameterValueType.currency('AUD'));
    this.register('auCapitalGainsYTD',           ParameterValueType.currency('AUD'));
    this.register('auNonResidentWithholdingYTD', ParameterValueType.currency('AUD'));
    this.register('auSuperTaxYTD',               ParameterValueType.currency('AUD'));
    this.register('auFrankingCreditYTD',         ParameterValueType.currency('AUD'));

    this.register('inflationAccumulator',        ParameterValueType.decimal(4));
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
    const vt   = ParameterValueType.currency(code);
    this.register(`${stateKey}.balance`,          vt);
    this.register(`${stateKey}.contributionBasis`, vt);
    this.register(`${stateKey}.earningsBasis`,    vt);
    this.register(`${stateKey}.minimumBalance`,   vt);
    if (account.type === ACCOUNT_TYPE.BROKERAGE && 'earningsBasis' in account) {
      this.register(`${stateKey}.earningsBasis`,   vt);
    }
    // Holdings per-account stamp with the account's currency (design 25 §5.6).
    this.registerPattern(`${stateKey}.holdings.*.marketValue`, vt);
    this.registerPattern(`${stateKey}.holdings.*.costBasis`,   vt);
  }

  /**
   * Resolve the ValueType for a field path.
   * Returns ValueType.unknown() when no registration matches.
   *
   * @param {string} fieldPath - e.g. 'usSavingsAccount.balance'
   * @returns {ParameterValueType}
   */
  resolve(fieldPath) {
    const exact = this._exact.get(fieldPath);
    if (exact) return exact;
    for (const { re, vt } of this._patterns) {
      if (re.test(fieldPath)) return vt;
    }
    return ParameterValueType.unknown();
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
