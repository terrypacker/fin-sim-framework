/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { LOAN_RATE_TYPE } from '../../finance/account-rules/loan-classes.js';

/**
 * The rate-type controls of a loan (design 113), shared by the Accounts loan form and the
 * property mortgage form so the two cannot store a rate differently.
 *
 * Both forms have the same controls under different data-ids: the Accounts form uses the
 * bare loan field names (`rateType`) and the property form prefixes them (`mortgageRateType`).
 * Values go in and come out under the LOAN's field names (`interestRate`, `primeSpread`,
 * `rateType`, …); each editor renames them for its own record.
 *
 * Storage, per rate type:
 *   · VARIABLE     — the typed rate becomes `primeSpread = rate − Prime(country)` when a
 *                    Prime is configured, else the absolute `interestRate` (design 56).
 *   · FIXED        — the typed rate is the absolute `interestRate`; `primeSpread` null, so
 *                    no Prime move reaches it.
 *   · FIXED_PERIOD — `interestRate` is the fixed rate; the revert rate is stored like a
 *                    variable rate: `primeSpread` against Prime, or `revertInterestRate`
 *                    when no Prime is configured.
 */
export class LoanRateTermsForm {
  /**
   * @param {object} o
   * @param {HTMLElement} o.el           the form root
   * @param {string}  o.prefix           '' (Accounts form) or 'mortgage' (property form)
   * @param {string}  o.rateId           data-id of the rate input
   * @param {string}  o.rateHintId       data-id of the hint under it
   * @param {string}  o.ioId             data-id of the Interest Only checkbox
   * @param {string}  o.maturityId       data-id of the Maturity Date input
   * @param {?object} o.primeRates       { US, AU } Prime rates, or null
   * @param {function(HTMLElement, string, function): void} o.listen  the editor's listen()
   */
  constructor({ el, prefix, rateId, rateHintId, ioId, maturityId, primeRates, listen }) {
    this.el = el;
    this.prefix = prefix;
    this.rateId = rateId;
    this.rateHintId = rateHintId;
    this.ioId = ioId;
    this.maturityId = maturityId;
    this.primeRates = primeRates ?? null;
    this.listen = listen;
  }

  /** The data-id of a design-113 control in this form. */
  id(name) {
    return this.prefix ? this.prefix + name[0].toUpperCase() + name.slice(1) : name;
  }

  _q(name) { return this.el.querySelector(`[data-id="${this.id(name)}"]`); }
  _country() { return this.el.querySelector('[data-id="country"]')?.value ?? 'US'; }
  _prime() { return this.primeRates?.[this._country()]; }

  /**
   * Fill the controls from a loan's values (loan field names). `isNew` picks the market's
   * common product: FIXED for a US loan, VARIABLE for an AU one. A loan authored before
   * design 113 shows the type it actually resolves as, and its offset box starts TICKED, so
   * saving it unchanged does not switch its offset off.
   */
  render(v, { isNew = false } = {}) {
    const country = this._country();
    const derived = v?.rateType
      ?? (isNew ? (country === 'US' ? LOAN_RATE_TYPE.FIXED : LOAN_RATE_TYPE.VARIABLE)
                : (v?.primeSpread != null ? LOAN_RATE_TYPE.VARIABLE : LOAN_RATE_TYPE.FIXED));
    this._q('rateType').value = derived;
    this._rateTypeTouched = !isNew;

    this.el.querySelector(`[data-id="${this.rateId}"]`).value = this._absoluteRate(v, derived);
    // A date (design 117): `<input type="date">` takes 'YYYY-MM-DD' only.
    this._q('fixedRateUntil').value         = v?.fixedRateUntil ? String(v.fixedRateUntil).slice(0, 10) : '';
    this._q('revertRate').value             = derived === LOAN_RATE_TYPE.FIXED_PERIOD ? this._revertRate(v) : '';
    this._q('offsetWhileFixed').checked     = v?.offsetWhileFixed ?? (!v?.rateType && !isNew);
    this._q('breakCostOnPayoff').checked    = v?.breakCostOnPayoff ?? (!v?.rateType && !isNew ? false : country === 'AU');
    this._q('fixedExtraRepaymentCap').value = v?.fixedExtraRepaymentCap ?? '';
    this._q('fixedAtPrimeRate').value       = v?.fixedAtPrimeRate ?? '';

    const refresh = () => this.refresh();
    this.listen(this._q('rateType'), 'change', () => { this._rateTypeTouched = true; refresh(); });
    this.listen(this.el.querySelector('[data-id="country"]'), 'change', () => {
      // A new loan follows its country's usual product until the author picks one.
      if (!this._rateTypeTouched) {
        this._q('rateType').value = this._country() === 'US' ? LOAN_RATE_TYPE.FIXED : LOAN_RATE_TYPE.VARIABLE;
        this._q('breakCostOnPayoff').checked = this._country() === 'AU';
      }
      refresh();
    });
    for (const id of [this.rateId, this.id('fixedRateUntil'), this.id('revertRate'),
                      this.id('breakCostOnPayoff'), this.id('fixedExtraRepaymentCap'),
                      this.ioId, this.maturityId]) {
      const input = this.el.querySelector(`[data-id="${id}"]`);
      if (!input) continue;
      this.listen(input, 'input', refresh);
      this.listen(input, 'change', refresh);
    }
    this.refresh();
  }

  /** The absolute rate the lender quotes, for display. */
  _absoluteRate(v, type) {
    if (type !== LOAN_RATE_TYPE.VARIABLE) return v?.interestRate ?? 0;
    const prime = this._prime();
    if (v?.primeSpread != null && prime != null) return prime + v.primeSpread;
    return v?.interestRate ?? 0;
  }

  _revertRate(v) {
    const prime = this._prime();
    if (v?.primeSpread != null && prime != null) return prime + v.primeSpread;
    return v?.revertInterestRate ?? '';
  }

  /** Read the controls back as loan field names. Blank numbers are null, never 0. */
  read() {
    const type  = this._q('rateType').value || LOAN_RATE_TYPE.VARIABLE;
    const prime = this._prime();
    const num = (input, round = false) => {
      const raw = input?.value;
      if (raw === '' || raw == null) return null;
      const n = Number(raw);
      if (!Number.isFinite(n)) return null;
      return round ? Math.round(n) : n;
    };
    const rateRaw = this.el.querySelector(`[data-id="${this.rateId}"]`).value;
    const rate    = rateRaw === '' || rateRaw == null ? null : Number(rateRaw);
    const out = {
      rateType: type,
      interestRate: rate ?? 0,
      primeSpread: null,
      revertInterestRate: null,
      fixedRateUntil: null,
      offsetWhileFixed: null,
      breakCostOnPayoff: null,
      fixedExtraRepaymentCap: null,
      fixedAtPrimeRate: null,
    };
    if (type === LOAN_RATE_TYPE.VARIABLE) {
      if (rate != null && prime != null) { out.primeSpread = rate - prime; out.interestRate = 0; }
      return out;
    }
    out.offsetWhileFixed       = this._q('offsetWhileFixed').checked;
    out.breakCostOnPayoff      = this._q('breakCostOnPayoff').checked;
    out.fixedExtraRepaymentCap = num(this._q('fixedExtraRepaymentCap'));
    out.fixedAtPrimeRate       = num(this._q('fixedAtPrimeRate'));
    if (type === LOAN_RATE_TYPE.FIXED_PERIOD) {
      out.fixedRateUntil = this._q('fixedRateUntil').value || null;   // blank = fixed for life
      const revert = num(this._q('revertRate'));
      if (revert != null && prime != null) out.primeSpread = revert - prime;
      else if (revert != null)             out.revertInterestRate = revert;
    }
    return out;
  }

  /** Show the rows the rate type uses, and say what the loan will do. */
  refresh() {
    const type = this._q('rateType').value;
    const fixed  = type === LOAN_RATE_TYPE.FIXED || type === LOAN_RATE_TYPE.FIXED_PERIOD;
    const period = type === LOAN_RATE_TYPE.FIXED_PERIOD;
    for (const row of this.el.querySelectorAll(`[data-rate-group="${this.id('fixed')}"]`)) {
      row.style.display = fixed ? '' : 'none';
    }
    for (const row of this.el.querySelectorAll(`[data-rate-group="${this.id('period')}"]`)) {
      row.style.display = period ? '' : 'none';
    }
    const prime = this._prime();
    const primeText = (raw) => {
      if (raw === '' || raw == null) return '';
      if (prime == null) return 'Prime not configured — stored as an absolute rate';
      const spread = Number(raw) - prime;
      return `= Prime (${fmtPct(prime)}) ${spread >= 0 ? '+' : '−'} ${fmtPct(Math.abs(spread))}`;
    };
    const until = this._q('fixedRateUntil').value;
    const rateHint = this.el.querySelector(`[data-id="${this.rateHintId}"]`);
    if (rateHint) {
      const raw = this.el.querySelector(`[data-id="${this.rateId}"]`).value;
      rateHint.textContent =
          type === LOAN_RATE_TYPE.VARIABLE ? primeText(raw)
        : type === LOAN_RATE_TYPE.FIXED    ? 'Fixed for the life of the loan. Prime moves do not change it.'
        : until ? `Fixed until ${until}, then the revert rate (from that month's payment).`
        : 'Set Fixed Until, or the rate stays fixed for the life of the loan.';
    }
    const revertHint = this._q('revertRateHint');
    if (revertHint) {
      const raw = this._q('revertRate').value;
      revertHint.textContent = raw === '' ? 'Blank keeps the fixed rate after the period ends.' : primeText(raw);
    }
    const fixedHint = this._q('fixedTermsHint');
    if (fixedHint) fixedHint.textContent = fixed ? this._fixedTermsText(type, until) : '';
  }

  _fixedTermsText(type, until) {
    const io       = !!this.el.querySelector(`[data-id="${this.ioId}"]`)?.checked;
    const maturity = this.el.querySelector(`[data-id="${this.maturityId}"]`)?.value;
    const notes = [];
    if (type === LOAN_RATE_TYPE.FIXED_PERIOD && until && !io) {
      notes.push(maturity
        ? `From ${until} the payment is re-amortised at the revert rate over the months to ${maturity}.`
        : `From ${until} the monthly payment continues unchanged. Set a Maturity Date to re-amortise it.`);
    }
    if (this._q('breakCostOnPayoff').checked && type === LOAN_RATE_TYPE.FIXED && !maturity) {
      notes.push('There is no Maturity Date, so a break cost cannot be priced.');
    }
    if (this._q('fixedExtraRepaymentCap').value !== '' && !maturity) {
      notes.push('The extra-repayment cap needs a Maturity Date to measure extra repayments against.');
    }
    return notes.join(' ');
  }
}

/** Format a decimal rate as a percent string, e.g. 0.06 → "6.00%". */
function fmtPct(x) { return `${(x * 100).toFixed(2)}%`; }
