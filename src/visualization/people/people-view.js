/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * PeopleView — pure DOM layer for the People sidebar panel.
 *
 * Reads / writes the existing HTML elements in index.html:
 *   #peopleList, #personForm, #addPersonBtn, #savePersonBtn, #cancelPersonBtn
 *   and the #personForm* fields.
 *
 * No business logic.  Communicates outward via callback properties set by
 * PeoplePresenter: onSave, onDelete, onEdit, onCancel.
 */
export class PeopleView {
  constructor() {
    /** @type {function({id,name,birthDate,citizen,lifeExpectancy,socialSecurityMonthly})|null} */
    this.onSave   = null;
    /** @type {function(string)|null} */
    this.onDelete = null;
    /** @type {function(import('../../finance/person.js').Person)|null} */
    this.onEdit   = null;
    /** @type {function()|null} */
    this.onCancel = null;

    this._init();
  }

  // ─── DOM wiring ───────────────────────────────────────────────────────────

  _init() {
    document.getElementById('addPersonBtn')?.addEventListener('click', () => {
      this.showForm(null);
    });

    document.getElementById('savePersonBtn')?.addEventListener('click', () => {
      if (this.onSave) this.onSave(this.readForm());
    });

    document.getElementById('cancelPersonBtn')?.addEventListener('click', () => {
      if (this.onCancel) this.onCancel();
    });
  }

  // ─── List rendering ───────────────────────────────────────────────────────

  /**
   * Re-render the people list.
   * @param {import('../../finance/person.js').Person[]} people
   */
  renderList(people) {
    const list = document.getElementById('peopleList');
    list.innerHTML = '';

    for (const person of people) {
      const row = document.createElement('div');
      row.style.cssText =
        'display:flex;align-items:center;gap:4px;padding:3px 4px;' +
        'background:var(--node-bg);border-radius:3px;font-size:11px;';

      const label = document.createElement('span');
      label.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      label.textContent   = person.name || person.id;

      const editBtn = document.createElement('button');
      editBtn.className   = 'btn btn-sm';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => { if (this.onEdit) this.onEdit(person); });

      const delBtn = document.createElement('button');
      delBtn.className   = 'btn btn-sm';
      delBtn.textContent = '✕';
      delBtn.style.color = 'var(--accent-red, #e55)';
      delBtn.addEventListener('click', () => { if (this.onDelete) this.onDelete(person.id); });

      row.append(label, editBtn, delBtn);
      list.appendChild(row);
    }
  }

  // ─── Form show / hide ─────────────────────────────────────────────────────

  /**
   * Show the inline form, optionally pre-populated for editing.
   * @param {import('../../finance/person.js').Person|null} person
   */
  showForm(person) {
    document.getElementById('personFormTitle').textContent = person ? 'Edit Person' : 'New Person';
    document.getElementById('personFormId').value          = person?.id ?? '';
    document.getElementById('personFormName').value        = person?.name ?? '';

    const bd = person?.birthDate;
    document.getElementById('personFormBirthDate').value =
      bd instanceof Date ? bd.toISOString().slice(0, 10)
                         : (bd ? String(bd).slice(0, 10) : '');

    const citizenSel = document.getElementById('personFormCitizen');
    const citizens   = person?.citizen ?? ['US'];
    for (const opt of citizenSel.options) opt.selected = citizens.includes(opt.value);

    document.getElementById('personFormLifeExp').value = person?.lifeExpectancy        ?? 90;
    document.getElementById('personFormSS').value      = person?.socialSecurityMonthly ?? 2800;
    document.getElementById('personForm').style.display = '';
  }

  hideForm() {
    document.getElementById('personForm').style.display = 'none';
    document.getElementById('personFormId').value = '';
  }

  // ─── Form read ────────────────────────────────────────────────────────────

  readForm() {
    const citizenSel = document.getElementById('personFormCitizen');
    const citizen    = [...citizenSel.selectedOptions].map(o => o.value);
    return {
      id:                    document.getElementById('personFormId').value   || null,
      name:                  document.getElementById('personFormName').value.trim(),
      birthDate:             document.getElementById('personFormBirthDate').value,
      citizen,
      lifeExpectancy:        Number(document.getElementById('personFormLifeExp').value),
      socialSecurityMonthly: Number(document.getElementById('personFormSS').value),
    };
  }
}
