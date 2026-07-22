/*
 * Copyright (c) 2026 Terry Packer.
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

import { BaseComponent } from '../components/base-component.js';
import { bindParamLinkedField } from '../scenario/param-linked-field.js';
import { defaultCurrencyForCountry as _countryCurrency } from '../../finance/country-codes.js';

/**
 * RealPropertyEditor — renders the real-property edit form from
 * tpl-real-property-editor into a given container.
 *
 * Communicates outward via callbacks:
 *   onSave(data)    — user clicked Save
 *   onDelete(id)    — user clicked Delete
 */
export class RealPropertyEditor extends BaseComponent {
  /**
   * @param {{
   *   parent?:   BaseComponent,
   *   container: HTMLElement,
   *   node:      object|null,
   *   people:    object[],
   *   accounts:  object[],
   *   onSave:    function(object): void,
   *   onDelete:  function(string): void,
   * }}
   */
  constructor({ parent, container, node, people = [], accounts = [], onSave, onDelete,
                links = null, onParamChange = null, onOpenParam = null, primeRates = null }) {
    super({ parent });
    this._container = container;
    this._node      = node;
    this._people    = people;
    this._accounts  = accounts;
    this.onSave     = onSave   ?? null;
    this.onDelete   = onDelete ?? null;
    this._links     = links;          // ParamFieldLinks (design/32)
    this.onParamChange = onParamChange ?? null;
    this.onOpenParam   = onOpenParam   ?? null;
    this._linkedFields = new Set();
    // Per-country Prime rates (design 56) — used to render the mortgage rate as an
    // ABSOLUTE the bank quotes and to convert it back to a stored `mortgagePrimeSpread`.
    this._primeRates   = primeRates;  // { US: number, AU: number } | null
  }

  /** Format a decimal rate as a percent string, e.g. 0.06 → "6.00%". */
  _fmtPct(x) { return `${(x * 100).toFixed(2)}%`; }

  /**
   * The absolute mortgage rate a property currently implies (design 56): Prime(country) +
   * mortgagePrimeSpread when Prime-linked, else the fixed absolute mortgageInterestRate.
   */
  _mortgageRateAbsolute(node, country) {
    const prime = this._primeRates?.[country];
    if (node?.mortgagePrimeSpread != null && prime != null) return prime + node.mortgagePrimeSpread;
    return node?.mortgageInterestRate ?? 0;
  }

  /** Refresh the "= Prime (x%) + spread" hint under the mortgage-rate input. */
  _updateMortgageRateHint(el) {
    const hint = el.querySelector('[data-id="mortgageRateHint"]');
    if (!hint) return;
    const country = el.querySelector('[data-id="country"]').value;
    const prime   = this._primeRates?.[country];
    const raw     = el.querySelector('[data-id="mortgageInterestRate"]').value;
    if (raw === '' || raw == null)   { hint.textContent = ''; return; }
    if (prime == null) { hint.textContent = 'Prime not configured — stored as an absolute rate'; return; }
    const spread = Number(raw) - prime;
    const sign   = spread >= 0 ? '+' : '−';
    hint.textContent = `= Prime (${this._fmtPct(prime)}) ${sign} ${this._fmtPct(Math.abs(spread))}`;
  }

  render() {
    const el     = this._getTemplate('tpl-real-property-editor');
    const isEdit = !!(this._node?.id);
    this._applyInheritedBadge(el, this._node);

    el.querySelector('[data-id="name"]').value              = this._node?.name              ?? '';
    el.querySelector('[data-id="value"]').value             = this._node?.value             ?? 0;
    el.querySelector('[data-id="costBasis"]').value         = this._node?.costBasis         ?? 0;
    el.querySelector('[data-id="country"]').value           = this._node?.country           ?? 'US';

    // Native currency (design 10 §Phase 5): default by country, overridable.
    const curSelect = el.querySelector('[data-id="currency"]');
    curSelect.value = this._node?.currency?.code ?? _countryCurrency(this._node?.country ?? 'US');
    this.listen(el.querySelector('[data-id="country"]'), 'change', (e) => {
      curSelect.value = _countryCurrency(e.target.value);
    });

    el.querySelector('[data-id="appreciationRate"]').value  = this._node?.appreciationRate  ?? 0.035;
    el.querySelector('[data-id="isPrimaryResidence"]').checked = this._node?.isPrimaryResidence ?? false;
    el.querySelector('[data-id="mortgageBalance"]').value   = this._node?.mortgageBalance   ?? 0;
    el.querySelector('[data-id="monthlyMortgage"]').value   = this._node?.monthlyMortgage   ?? 0;

    const saleYearInput = el.querySelector('[data-id="plannedSaleYear"]');
    saleYearInput.value = this._node?.plannedSaleYear ?? '';

    el.querySelector('[data-id="ownershipType"]').value = this._node?.ownershipType ?? 'sole';

    // Rental income (design 48)
    el.querySelector('[data-id="rentalEnabled"]').checked      = this._node?.rentalEnabled      ?? false;
    el.querySelector('[data-id="monthlyRent"]').value          = this._node?.monthlyRent          ?? 0;
    el.querySelector('[data-id="occupancyRate"]').value        = this._node?.occupancyRate         ?? 0.95;
    el.querySelector('[data-id="rentalExpenseRatio"]').value   = this._node?.rentalExpenseRatio    ?? 0.25;
    // Mortgage rate: show the ABSOLUTE the bank quotes (Prime + spread when linked, design 56).
    el.querySelector('[data-id="mortgageInterestRate"]').value =
      this._mortgageRateAbsolute(this._node, this._node?.country ?? 'US');
    this._updateMortgageRateHint(el);
    this.listen(el.querySelector('[data-id="mortgageInterestRate"]'), 'input', () => this._updateMortgageRateHint(el));
    this.listen(el.querySelector('[data-id="country"]'), 'change', () => this._updateMortgageRateHint(el));
    el.querySelector('[data-id="landValueRatio"]').value       = this._node?.landValueRatio         ?? 0.2;
    el.querySelector('[data-id="annualDepreciationOverride"]').value =
      this._node?.annualDepreciationOverride ?? '';

    // Owner-occupied running cost + stochastic repairs (design 75) — a holding cost distinct
    // from the rental opex above. Defaults mirror the RealProperty class / serializer (all 0 ⇒
    // inert, except repairSigma 0.6 and repairModel NONE).
    el.querySelector('[data-id="annualRunningCost"]').value    = this._node?.annualRunningCost    ?? 0;
    el.querySelector('[data-id="runningCostValuePct"]').value  = this._node?.runningCostValuePct  ?? 0;
    el.querySelector('[data-id="runningCostGrowth"]').value    = this._node?.runningCostGrowth    ?? 0;
    el.querySelector('[data-id="repairModel"]').value          = this._node?.repairModel          ?? 'NONE';
    el.querySelector('[data-id="repairProb"]').value           = this._node?.repairProb           ?? 0;
    el.querySelector('[data-id="repairLambda"]').value         = this._node?.repairLambda         ?? 0;
    el.querySelector('[data-id="repairMedian"]').value         = this._node?.repairMedian         ?? 0;
    el.querySelector('[data-id="repairValuePct"]').value       = this._node?.repairValuePct       ?? 0;
    el.querySelector('[data-id="repairSigma"]').value          = this._node?.repairSigma          ?? 0.6;
    el.querySelector('[data-id="capitalizeRepairs"]').value    = this._node?.capitalizeRepairs    ?? 0;

    this._populateOwnerSelect(el, this._people, this._node?.ownerId ?? null);
    this._populateAccountSelect(el, this._accounts, this._node?.saleDestinationAccount ?? null);

    const deleteBtn = el.querySelector('[data-id="deleteBtn"]');
    deleteBtn.style.display = isEdit ? '' : 'none';

    this.listen(el.querySelector('[data-id="saveBtn"]'), 'click', () => {
      if (this.onSave) this.onSave(this._readForm(el));
    });

    this.listen(deleteBtn, 'click', () => {
      if (this.onDelete && this._node?.id) this.onDelete(this._node.id);
    });

    this._bindParamLinks(el);

    this._container.replaceChildren(el);
    this._rootEl = el;
  }

  /**
   * Route param-backed real-property fields through their param (design/32, design 55 §14.3).
   * All three generated real-property fields (value, appreciationRate, plannedSaleYear) are
   * bound so a direct edit writes the param (the source of truth) rather than only the record —
   * otherwise the param→record cascade clobbers the edit on the next Rebuild.
   */
  _bindParamLinks(el) {
    this._linkedFields = new Set();
    const stateKey = this._node?.stateKey;
    if (!stateKey || !this._links) return;

    const bindField = (field, dataId, coerce) => {
      const param = this._links.getParamFor('realProperty', stateKey, field);
      if (!param) return;
      const input   = el.querySelector(`[data-id="${dataId}"]`);
      const labelEl = input?.closest('.node-field')?.querySelector('label');
      bindParamLinkedField({
        input, labelEl, param, coerce,
        onChange: () => this.onParamChange?.(),
        onOpen:   (p) => this.onOpenParam?.(p),
      });
      this._linkedFields.add(field);
    };

    bindField('value',            'value',            (raw) => Number(raw));
    bindField('appreciationRate', 'appreciationRate', (raw) => Number(raw));
    bindField('plannedSaleYear',  'plannedSaleYear',
      (raw) => (raw === '' || raw == null) ? null : Math.round(Number(raw)));
  }

  _readForm(el) {
    const saleYearRaw = el.querySelector('[data-id="plannedSaleYear"]').value;
    const data = {
      id:                   this._node?.id ?? null,
      name:                 el.querySelector('[data-id="name"]').value.trim(),
      value:                +el.querySelector('[data-id="value"]').value,
      costBasis:            +el.querySelector('[data-id="costBasis"]').value,
      country:              el.querySelector('[data-id="country"]').value,
      currency:             el.querySelector('[data-id="currency"]').value, // code; mapped to descriptor on save
      appreciationRate:     +el.querySelector('[data-id="appreciationRate"]').value,
      isPrimaryResidence:   el.querySelector('[data-id="isPrimaryResidence"]').checked,
      mortgageBalance:      +el.querySelector('[data-id="mortgageBalance"]').value,
      monthlyMortgage:      +el.querySelector('[data-id="monthlyMortgage"]').value,
      plannedSaleYear:      saleYearRaw ? +saleYearRaw : null,
      saleDestinationAccount: el.querySelector('[data-id="saleDestinationAccount"]').value || null,
      ownershipType:        el.querySelector('[data-id="ownershipType"]').value,
      ownerId:              el.querySelector('[data-id="ownerId"]').value || null,
      // Rental income (design 48)
      rentalEnabled:        el.querySelector('[data-id="rentalEnabled"]').checked,
      monthlyRent:          +el.querySelector('[data-id="monthlyRent"]').value,
      occupancyRate:        +el.querySelector('[data-id="occupancyRate"]').value,
      rentalExpenseRatio:   +el.querySelector('[data-id="rentalExpenseRatio"]').value,
      mortgageInterestRate: +el.querySelector('[data-id="mortgageInterestRate"]').value,
      landValueRatio:       +el.querySelector('[data-id="landValueRatio"]').value,
      annualDepreciationOverride:
        el.querySelector('[data-id="annualDepreciationOverride"]').value === ''
          ? null
          : +el.querySelector('[data-id="annualDepreciationOverride"]').value,
      // Owner-occupied running cost + stochastic repairs (design 75)
      annualRunningCost:    +el.querySelector('[data-id="annualRunningCost"]').value,
      runningCostValuePct:  +el.querySelector('[data-id="runningCostValuePct"]').value,
      runningCostGrowth:    +el.querySelector('[data-id="runningCostGrowth"]').value,
      repairModel:          el.querySelector('[data-id="repairModel"]').value,
      repairProb:           +el.querySelector('[data-id="repairProb"]').value,
      repairLambda:         +el.querySelector('[data-id="repairLambda"]').value,
      repairMedian:         +el.querySelector('[data-id="repairMedian"]').value,
      repairValuePct:       +el.querySelector('[data-id="repairValuePct"]').value,
      repairSigma:          +el.querySelector('[data-id="repairSigma"]').value,
      capitalizeRepairs:    +el.querySelector('[data-id="capitalizeRepairs"]').value,
    };
    // Prime-relative mortgage rate (design 56 Phase 3): the input is the ABSOLUTE rate
    // the bank quotes; store it as `mortgagePrimeSpread = absolute − Prime(country)` so a
    // Prime move re-rates the loan (mortgagePrimeSpread wins over the absolute in
    // resolveLoanRate, so the linked mortgage clears its absolute). Blank → unset. When no
    // Prime is configured, fall back to the fixed absolute mortgageInterestRate (back-compat).
    const mtgRaw = el.querySelector('[data-id="mortgageInterestRate"]').value;
    const prime  = this._primeRates?.[data.country];
    if (mtgRaw === '' || mtgRaw == null) {
      data.mortgagePrimeSpread  = null;
      data.mortgageInterestRate = 0;
    } else if (prime != null) {
      data.mortgagePrimeSpread  = Number(mtgRaw) - prime;
      data.mortgageInterestRate = 0;
    } else {
      data.mortgagePrimeSpread  = null;
      data.mortgageInterestRate = Number(mtgRaw);
    }
    // Param-backed fields are owned by their scenario param (design/32).
    for (const f of this._linkedFields) delete data[f];
    return data;
  }

  _populateOwnerSelect(el, people, selectedId) {
    const sel = el.querySelector('[data-id="ownerId"]');
    sel.innerHTML = '<option value="">— none —</option>';
    for (const p of people) {
      const opt = document.createElement('option');
      opt.value       = p.id;
      opt.textContent = p.name || p.id;
      if (p.id === selectedId) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  /**
   * Fill the sale-destination select. The option value is always the account's
   * **stateKey** — the only form the engine can resolve, since runtime account
   * state carries `stateKey` but not `id`. The former `a.stateKey ?? a.id`
   * fallback persisted an id whenever the account had none yet, and that value
   * silently never matched at sale time: the proceeds fell back to the country
   * cash pool (design 72 §2). An account with no stateKey has no state to credit
   * at all, so it is not offered. A legacy value stored as a bare id still
   * selects its account here, so re-saving migrates it.
   */
  _populateAccountSelect(el, accounts, selectedKey) {
    const sel = el.querySelector('[data-id="saleDestinationAccount"]');
    sel.innerHTML = '<option value="">— none —</option>';
    for (const a of accounts) {
      if (!a.stateKey) continue;
      const opt = document.createElement('option');
      opt.value       = a.stateKey;
      opt.textContent = a.name || a.stateKey;
      if (a.stateKey === selectedKey || a.id === selectedKey) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  destroy() {
    this._rootEl?.remove();
    super.destroy();
  }
}
