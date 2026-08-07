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
/**
 * Which of design 83 §7b.2c's four histories a stored property is in.
 *
 * Derived rather than stored. The engine reads three fields — `isPrimaryResidence`,
 * `mainResidenceFrom`, `mainResidenceUntil` — and adding a fourth to remember which
 * radio was clicked would create a piece of state that can disagree with them, which is
 * exactly the class of bug the dropdown exists to prevent. A spec-file scenario, or one
 * saved before this UI existed, therefore shows the right option with no migration.
 */
export function _mainResidenceMode(node) {
  const from  = node?.mainResidenceFrom  ?? null;
  const until = node?.mainResidenceUntil ?? null;
  if (from != null)  return 'moved-in';
  if (until != null) return 'moved-out';
  return node?.isPrimaryResidence === true ? 'throughout' : 'never';
}

/**
 * The three stored fields implied by the current dropdown selection.
 *
 * Every mode writes all three, so switching away from "became one later" clears the
 * move-in date rather than leaving it behind to contradict the new answer. `moved-out`
 * deliberately writes NO start date: the start is the acquisition, and the engine's
 * `mainResidenceWindow` reads that combination directly — storing a sentinel to mean
 * "from the beginning" would put a magic constant into saved scenarios.
 */
export function _mainResidenceFields(el) {
  const mode  = el.querySelector('[data-id="mainResidenceMode"]').value;
  const from  = el.querySelector('[data-id="mainResidenceFrom"]').value  || null;
  const until = el.querySelector('[data-id="mainResidenceUntil"]').value || null;
  switch (mode) {
    case 'throughout':
      return { isPrimaryResidence: true,  mainResidenceFrom: null, mainResidenceUntil: null };
    case 'moved-out':
      return { isPrimaryResidence: true,  mainResidenceFrom: null, mainResidenceUntil: until };
    case 'moved-in':
      return { isPrimaryResidence: false, mainResidenceFrom: from, mainResidenceUntil: null };
    case 'never':
    default:
      return { isPrimaryResidence: false, mainResidenceFrom: null, mainResidenceUntil: null };
  }
}

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

  /**
   * Describe the loan's life from the three term fields (design 86 G2/G6), because
   * their interaction is the part that is easy to author wrong:
   *
   *   · IO with no expiry  → interest-only forever, and `monthlyMortgage` is inert.
   *   · IO with an expiry but NO maturity year → `scheduledLoanPayment` has no term to
   *     amortise over, so at expiry it falls back to the authored fixed payment. That
   *     is a real behaviour, not an error, but it is almost never what was meant.
   *   · IO with both → the reversion this whole gap exists to model.
   *   · maturity alone  → the balance is discharged in that year, in one payment.
   */
  _updateMortgageTermHint(el) {
    const hint = el.querySelector('[data-id="mortgageTermHint"]');
    if (!hint) return;
    const io       = el.querySelector('[data-id="mortgageInterestOnly"]').checked;
    const ioUntil  = el.querySelector('[data-id="mortgageInterestOnlyUntilYear"]').value;
    const maturity = el.querySelector('[data-id="mortgageMaturityYear"]').value;

    if (!io && !ioUntil && !maturity) { hint.textContent = ''; return; }
    if (!io) {
      hint.textContent = maturity
        ? `P&I, discharged in full in ${maturity}.`
        : 'IO Until Year applies to an interest-only loan only — tick Interest Only.';
      return;
    }
    if (!ioUntil) { hint.textContent = 'Interest-only for life — Monthly Mtg. is inert.'; return; }
    hint.textContent = maturity
      ? `Interest-only to ${ioUntil}, then P&I re-amortised over the remaining term to ${maturity}.`
      : `Interest-only to ${ioUntil}, then the fixed Monthly Mtg. — set a Maturity Year to re-amortise instead.`;
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
    el.querySelector('[data-id="mortgageBalance"]').value   = this._node?.mortgageBalance   ?? 0;
    el.querySelector('[data-id="monthlyMortgage"]').value   = this._node?.monthlyMortgage   ?? 0;

    const saleYearInput = el.querySelector('[data-id="plannedSaleYear"]');
    saleYearInput.value = this._node?.plannedSaleYear ?? '';

    el.querySelector('[data-id="ownershipType"]').value = this._node?.ownershipType ?? 'sole';

    // Design 88: the recognition switch — see the company-equity editor. A
    // pre-construction lot or a dwelling with no buyer is speculative in exactly the
    // sense a private stake is.
    el.querySelector('[data-id="speculative"]').checked = this._node?.speculative === true;

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
    // Mortgage terms + deductibility (design 86 G2/G3/G6/G7). Every one is blank/off
    // by default, which reproduces the pre-86 loan exactly: no term, no IO, the
    // "deductible iff the property rents" rule, and a §988 booking rate stamped at the
    // first payment. A blank year/fraction must round-trip as null, NOT 0 — 0 is a real
    // maturity year and a real "nothing is deductible" fraction.
    el.querySelector('[data-id="mortgageInterestOnly"]').checked = this._node?.mortgageInterestOnly ?? false;
    el.querySelector('[data-id="mortgageInterestOnlyUntilYear"]').value = this._node?.mortgageInterestOnlyUntilYear ?? '';
    el.querySelector('[data-id="mortgageMaturityYear"]').value          = this._node?.mortgageMaturityYear          ?? '';
    el.querySelector('[data-id="mortgageDeductibleFraction"]').value    = this._node?.mortgageDeductibleFraction    ?? '';
    el.querySelector('[data-id="mortgageBookingFxRate"]').value         = this._node?.mortgageBookingFxRate         ?? '';
    // The IO-expiry / re-amortisation branch needs a term to amortise over, and an IO
    // mortgage derives its own payment, so the payment field goes inert. Both are
    // easy to get silently wrong, so say so under the fields rather than in a tooltip.
    const refreshTerm = () => this._updateMortgageTermHint(el);
    for (const id of ['mortgageInterestOnly', 'mortgageInterestOnlyUntilYear', 'mortgageMaturityYear']) {
      this.listen(el.querySelector(`[data-id="${id}"]`), 'change', refreshTerm);
      this.listen(el.querySelector(`[data-id="${id}"]`), 'input',  refreshTerm);
    }
    refreshTerm();

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
    // Purchase + main-residence history (design 83 G7 and its follow-on). Dates are
    // rendered as yyyy-mm-dd because <input type="date"> accepts nothing else; the
    // model stores epoch ms, an ISO string or a Date interchangeably, so the read side
    // hands back whatever the picker produced and `toMs` normalises it downstream.
    const asDateValue = (v) => {
      if (v == null || v === '') return '';
      const t = typeof v === 'number' ? v : Date.parse(v);
      return Number.isNaN(t) ? '' : new Date(t).toISOString().slice(0, 10);
    };
    el.querySelector('[data-id="purchaseYear"]').value  = this._node?.purchaseYear  ?? '';
    el.querySelector('[data-id="purchasePrice"]').value = this._node?.purchasePrice ?? '';
    el.querySelector('[data-id="purchasePriceIsNominal"]').checked = this._node?.purchasePriceIsNominal ?? false;
    el.querySelector('[data-id="acquisitionDate"]').value    = asDateValue(this._node?.acquisitionDate);
    el.querySelector('[data-id="mainResidenceFrom"]').value  = asDateValue(this._node?.mainResidenceFrom);
    el.querySelector('[data-id="mainResidenceUntil"]').value = asDateValue(this._node?.mainResidenceUntil);
    el.querySelector('[data-id="claimDownsizerContribution"]').checked =
      this._node?.claimDownsizerContribution ?? false;
    // The history dropdown is DERIVED from the stored fields, not stored itself — there
    // is no fifth piece of state to drift out of sync with the three the engine reads,
    // and a scenario authored from a spec file (or by an older build) still shows the
    // right option without a migration.
    const modeSel = el.querySelector('[data-id="mainResidenceMode"]');
    modeSel.value = _mainResidenceMode(this._node);
    const syncRows = () => {
      const mode = modeSel.value;
      el.querySelector('[data-id="mainResidenceMovedInRow"]').style.display  = mode === 'moved-in'  ? '' : 'none';
      el.querySelector('[data-id="mainResidenceMovedOutRow"]').style.display = mode === 'moved-out' ? '' : 'none';
    };
    syncRows();
    this.listen(modeSel, 'change', syncRows);
    this._populatePurchaseFundSelect(el, this._accounts, this._node?.purchaseFundFrom ?? null);

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
   * All generated real-property fields (value, appreciationRate, plannedSaleYear,
   * isPrimaryResidence) are bound so a direct edit writes the param (the source of truth)
   * rather than only the record — otherwise the param→record cascade clobbers the edit on
   * the next Rebuild.
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
    // `isPrimaryResidence` has no field of its own any more: the Main Residence History
    // dropdown owns it (design 83 §7b.2c). A checkbox alongside that dropdown could be
    // set to contradict it — "not a primary residence" ticked against "main residence
    // throughout" — and the two would then disagree about the same property.
  }

  _readForm(el) {
    const saleYearRaw = el.querySelector('[data-id="plannedSaleYear"]').value;
    /** A blank numeric input means "unset" (null), never 0 — see the render comment. */
    const nullableNum = (dataId, round = false) => {
      const raw = el.querySelector(`[data-id="${dataId}"]`).value;
      if (raw === '' || raw == null) return null;
      const n = Number(raw);
      if (!Number.isFinite(n)) return null;
      return round ? Math.round(n) : n;
    };
    const data = {
      id:                   this._node?.id ?? null,
      name:                 el.querySelector('[data-id="name"]').value.trim(),
      value:                +el.querySelector('[data-id="value"]').value,
      costBasis:            +el.querySelector('[data-id="costBasis"]').value,
      country:              el.querySelector('[data-id="country"]').value,
      currency:             el.querySelector('[data-id="currency"]').value, // code; mapped to descriptor on save
      appreciationRate:     +el.querySelector('[data-id="appreciationRate"]').value,
      mortgageBalance:      +el.querySelector('[data-id="mortgageBalance"]').value,
      monthlyMortgage:      +el.querySelector('[data-id="monthlyMortgage"]').value,
      plannedSaleYear:      saleYearRaw ? +saleYearRaw : null,
      saleDestinationAccount: el.querySelector('[data-id="saleDestinationAccount"]').value || null,
      // Purchase (design 83 §10 follow-on). A blank year or price means "no purchase",
      // never 0 — a year 0 purchase and a free house are both real values that differ
      // from "unset", which is the same trap the loan term fields document.
      purchaseYear:           nullableNum('purchaseYear', true),
      purchasePrice:          nullableNum('purchasePrice'),
      purchasePriceIsNominal: el.querySelector('[data-id="purchasePriceIsNominal"]').checked,
      purchaseFundFrom:       el.querySelector('[data-id="purchaseFundFrom"]').value || null,
      // Main-residence history (design 83 G7). Blank dates stay NULL: an absent
      // acquisition date denies the day-count concessions rather than being filled in
      // from the simulation start, and a blank mainResidenceFrom defers to the
      // isPrimaryResidence checkbox above.
      acquisitionDate:    el.querySelector('[data-id="acquisitionDate"]').value || null,
      claimDownsizerContribution: el.querySelector('[data-id="claimDownsizerContribution"]').checked,
      // The dropdown writes ALL THREE stored fields, so a mode change cannot leave a
      // stale date behind from a previous choice. That is the whole point of the dropdown:
      // "moved out before you moved in" is not merely rejected, it is unreachable.
      ..._mainResidenceFields(el),
      ownershipType:        el.querySelector('[data-id="ownershipType"]').value,
      ownerId:              el.querySelector('[data-id="ownerId"]').value || null,
      speculative:          el.querySelector('[data-id="speculative"]').checked,
      // Rental income (design 48)
      rentalEnabled:        el.querySelector('[data-id="rentalEnabled"]').checked,
      monthlyRent:          +el.querySelector('[data-id="monthlyRent"]').value,
      occupancyRate:        +el.querySelector('[data-id="occupancyRate"]').value,
      rentalExpenseRatio:   +el.querySelector('[data-id="rentalExpenseRatio"]').value,
      mortgageInterestRate: +el.querySelector('[data-id="mortgageInterestRate"]').value,
      // Mortgage terms + deductibility (design 86). Years are whole numbers; the
      // deductible fraction is clamped to [0,1] because it is a share, and a stray
      // 50 (percent, not fraction) would otherwise multiply the deduction by fifty.
      mortgageInterestOnly:          el.querySelector('[data-id="mortgageInterestOnly"]').checked,
      mortgageInterestOnlyUntilYear: nullableNum('mortgageInterestOnlyUntilYear', true),
      mortgageMaturityYear:          nullableNum('mortgageMaturityYear', true),
      mortgageDeductibleFraction:    (() => {
        const f = nullableNum('mortgageDeductibleFraction');
        return f == null ? null : Math.min(1, Math.max(0, f));
      })(),
      mortgageBookingFxRate:         nullableNum('mortgageBookingFxRate'),
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

  /**
   * Fill the purchase funding select. Same stateKey-only rule as the sale destination
   * above, and for the same reason design 72 §2 records: runtime account state carries
   * `stateKey` and not `id`, so an id persisted here resolves to nothing at purchase
   * time and the debit falls back to the country cash pool — a silently different plan.
   * Blank is a real, useful choice ("wherever the country's cash lives"), so it stays
   * the first option rather than being forced.
   */
  _populatePurchaseFundSelect(el, accounts, selectedKey) {
    const sel = el.querySelector('[data-id="purchaseFundFrom"]');
    if (!sel) return;
    sel.innerHTML = '<option value="">— country cash pool —</option>';
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
