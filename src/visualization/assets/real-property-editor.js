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

/** Map a country code to its default currency code (US→USD, AU/AUS→AUD). */
function _countryCurrency(country) {
  return (country === 'AU' || country === 'AUS') ? 'AUD' : 'USD';
}

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
  constructor({ parent, container, node, people = [], accounts = [], onSave, onDelete }) {
    super({ parent });
    this._container = container;
    this._node      = node;
    this._people    = people;
    this._accounts  = accounts;
    this.onSave     = onSave   ?? null;
    this.onDelete   = onDelete ?? null;
  }

  render() {
    const el     = this._getTemplate('tpl-real-property-editor');
    const isEdit = !!(this._node?.id);

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

    this._container.replaceChildren(el);
    this._rootEl = el;
  }

  _readForm(el) {
    const saleYearRaw = el.querySelector('[data-id="plannedSaleYear"]').value;
    return {
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
    };
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

  _populateAccountSelect(el, accounts, selectedId) {
    const sel = el.querySelector('[data-id="saleDestinationAccount"]');
    sel.innerHTML = '<option value="">— none —</option>';
    for (const a of accounts) {
      const opt = document.createElement('option');
      opt.value       = a.stateKey ?? a.id;
      opt.textContent = a.name || a.id;
      if ((a.stateKey ?? a.id) === selectedId) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  destroy() {
    this._rootEl?.remove();
    super.destroy();
  }
}
