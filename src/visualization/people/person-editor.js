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
  constructor({ parent, container, node, onSave, onDelete }) {
    super({ parent });
    this._container = container;
    this._node      = node;
    this.onSave     = onSave   ?? null;
    this.onDelete   = onDelete ?? null;
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

    el.querySelector('[data-id="lifeExpectancy"]').value        = this._node?.lifeExpectancy        ?? 90;
    el.querySelector('[data-id="socialSecurityMonthly"]').value = this._node?.socialSecurityMonthly ?? 2800;
    el.querySelector('[data-id="monthlyWage"]').value           = this._node?.monthlyWage           ?? 0;

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

    this._container.replaceChildren(el);
    this._rootEl = el;
  }

  _readForm(el) {
    const citizenSel = el.querySelector('[data-id="citizen"]');
    return {
      id:                    this._node?.id ?? null,
      name:                  el.querySelector('[data-id="name"]').value.trim(),
      birthDate:             el.querySelector('[data-id="birthDate"]').value,
      citizen:               [...citizenSel.selectedOptions].map(o => o.value),
      lifeExpectancy:        Number(el.querySelector('[data-id="lifeExpectancy"]').value),
      socialSecurityMonthly: Number(el.querySelector('[data-id="socialSecurityMonthly"]').value),
      monthlyWage:           Number(el.querySelector('[data-id="monthlyWage"]').value),
      retirementDate:        el.querySelector('[data-id="retirementDate"]').value,
    };
  }

  destroy() {
    this._rootEl?.remove();
    super.destroy();
  }
}
