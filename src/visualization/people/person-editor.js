/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseComponent } from '../components/base-component.js';
import { bindParamLinkedField } from '../scenario/param-linked-field.js';
import { defaultCurrencyForCountry } from '../../finance/country-codes.js';
import { usStateOptionPairs } from '../../finance/tax/state/us-states.js';

/**
 * PersonEditor — renders the person edit form from tpl-person-editor into a
 * given container (typically a modal body).
 *
 * Communicates outward via callbacks:
 *   onSave(data)   — user clicked Save
 *   onDelete(id)   — user clicked Delete
 */
export class PersonEditor extends BaseComponent {
  /**
   * @param {{
   *   parent?:   BaseComponent,
   *   container: HTMLElement,
   *   node:      object|null,   — Person graph node, or null for a new person
   *   onSave:    function(object): void,
   *   onDelete:  function(string): void,
   * }}
   */
  constructor({ parent, container, node, onSave, onDelete,
                links = null, onParamChange = null, onOpenParam = null }) {
    super({ parent });
    this._container = container;
    this._node      = node;
    this.onSave     = onSave   ?? null;
    this.onDelete   = onDelete ?? null;
    this._links     = links;          // ParamFieldLinks (design/32)
    this.onParamChange = onParamChange ?? null;
    this.onOpenParam   = onOpenParam   ?? null;
    this._linkedFields = new Set();
  }

  render() {
    const el = this._getTemplate('tpl-person-editor');

    const isEdit = !!(this._node?.id);

    // Populate fields
    el.querySelector('[data-id="name"]').value = this._node?.name ?? '';

    const bd = this._node?.birthDate;
    el.querySelector('[data-id="birthDate"]').value =
      bd instanceof Date ? bd.toISOString().slice(0, 10)
                        : (bd ? String(bd).slice(0, 10) : '');

    const citizenSel = el.querySelector('[data-id="citizen"]');
    const citizens   = this._node?.citizen ?? ['US'];
    for (const opt of citizenSel.options) opt.selected = citizens.includes(opt.value);

    // US state of residency (design 34) — optional, options from the shared
    // US_STATES list. null/undefined selects the blank "None" option; it must not
    // fall back to a state, or an unconfigured person would silently acquire a
    // state income tax.
    const stateSel = el.querySelector('[data-id="residencyState"]');
    for (const [value, label] of usStateOptionPairs({ blankLabel: 'None', labelStyle: 'codeAndName' })) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      stateSel.appendChild(opt);
    }
    stateSel.value = this._node?.residencyState ?? '';

    el.querySelector('[data-id="lifeExpectancy"]').value        = this._node?.lifeExpectancy        ?? 90;
    el.querySelector('[data-id="socialSecurityMonthly"]').value = this._node?.socialSecurityMonthly ?? 2800;
    el.querySelector('[data-id="monthlyWage"]').value           = this._node?.monthlyWage           ?? 0;
    el.querySelector('[data-id="selfEmployed"]').checked         = this._node?.selfEmployed          ?? false;

    // Per-field native currency (design 10 §Phase 5). Default from residency /
    // citizenship when the person carries no explicit code.
    const defaultCur = defaultCurrencyForCountry(this._node?.residency ?? this._node?.citizen?.[0]);
    el.querySelector('[data-id="ssCurrency"]').value   = this._node?.ssCurrency   ?? defaultCur;
    el.querySelector('[data-id="wageCurrency"]').value = this._node?.wageCurrency ?? defaultCur;

    // Where the work is performed (design 73 Gap 1) — the source attribute, kept
    // separate from the wage's denomination. Empty string is the "" option, i.e.
    // follow residency; it must not be coerced to a country here or the default
    // would silently become a claim about where someone works.
    el.querySelector('[data-id="workCountry"]').value = this._node?.workCountry ?? '';

    const rd = this._node?.retirementDate;
    el.querySelector('[data-id="retirementDate"]').value =
      rd instanceof Date ? rd.toISOString().slice(0, 10)
                        : (rd ? String(rd).slice(0, 10) : '2040-01-01');

    // Show Delete only when editing an existing person
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

  /** Route param-backed person fields through their param (design/32). */
  _bindParamLinks(el) {
    this._linkedFields = new Set();
    const id = this._node?.id;
    if (!id || !this._links) return;

    const candidates = [
      { dataId: 'monthlyWage',    field: 'monthlyWage',    coerce: (raw) => Number(raw) || 0 },
      { dataId: 'retirementDate', field: 'retirementDate', coerce: (raw) => raw },
      // The scenario's `residencyState` param links to the PRIMARY person only
      // (its Enum options are '' plus US_STATE_CODES, so blank stays '' rather
      // than null here). A person with no such param — the spouse — edits the
      // field directly.
      { dataId: 'residencyState', field: 'residencyState', coerce: (raw) => raw || '' },
    ];
    for (const { dataId, field, coerce } of candidates) {
      const param = this._links.getParamFor('person', id, field);
      if (!param) continue;
      const input   = el.querySelector(`[data-id="${dataId}"]`);
      const labelEl = input?.closest('.node-field')?.querySelector('label');
      bindParamLinkedField({
        input, labelEl, param, coerce,
        onChange: () => this.onParamChange?.(),
        onOpen:   (p) => this.onOpenParam?.(p),
      });
      this._linkedFields.add(field);
    }
  }

  _readForm(el) {
    const citizenSel = el.querySelector('[data-id="citizen"]');
    const data = {
      id:                    this._node?.id ?? null,
      name:                  el.querySelector('[data-id="name"]').value.trim(),
      birthDate:             el.querySelector('[data-id="birthDate"]').value,
      citizen:               [...citizenSel.selectedOptions].map(o => o.value),
      // "" ⇒ no state of residency. Normalised to null to match Person's default
      // shape, which primaryResidencyState() reads as "no state income tax".
      residencyState:        el.querySelector('[data-id="residencyState"]').value || null,
      lifeExpectancy:        Number(el.querySelector('[data-id="lifeExpectancy"]').value),
      socialSecurityMonthly: Number(el.querySelector('[data-id="socialSecurityMonthly"]').value),
      monthlyWage:           Number(el.querySelector('[data-id="monthlyWage"]').value),
      selfEmployed:          el.querySelector('[data-id="selfEmployed"]').checked,
      retirementDate:        el.querySelector('[data-id="retirementDate"]').value,
      ssCurrency:            el.querySelector('[data-id="ssCurrency"]').value,
      wageCurrency:          el.querySelector('[data-id="wageCurrency"]').value,
      // "" ⇒ follow residency. Normalised to null so the stored shape matches
      // Person's default rather than carrying an empty string through the config.
      workCountry:           el.querySelector('[data-id="workCountry"]').value || null,
    };
    // Param-backed fields are owned by their scenario param (design/32).
    for (const f of this._linkedFields) delete data[f];
    return data;
  }

  destroy() {
    this._rootEl?.remove();
    super.destroy();
  }
}
