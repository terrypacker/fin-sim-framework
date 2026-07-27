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

const RELATIONSHIPS = [
  ['immediate', 'Immediate (Class 1 — child/parent/sibling)'],
  ['remote',    'Remote (Class 2 — aunt/uncle/niece/nephew)'],
  ['unrelated', 'Unrelated (Class 3)'],
];
const SITUS = [['', '— none —'], ['NE', 'Nebraska'], ['HI', 'Hawaii'], ['SD', 'South Dakota']];
const ASSET_TYPES = [
  ['BrokerageAccount',      'Brokerage'],
  ['TraditionalIRAAccount', 'Traditional IRA'],
  ['FourOhOneKAccount',     '401(k)'],
  ['RothAccount',           'Roth IRA'],
  ['SuperannuationAccount', 'Superannuation (AU)'],
  ['RealProperty',          'Real Property'],
  ['Collectible',           'Collectible'],
];
const STRATEGIES = [['', '— default —'], ['equal', 'Equal'], ['lump', 'Lump'], ['maxDefer', 'Max defer'], ['bracketFill', 'Bracket fill'], ['weights', 'Weights']];

/**
 * BequestEditor — edit form for a Bequest container (design 63). Built
 * programmatically (no HTML template): a decedent section plus a repeatable
 * inherited-asset sub-editor. Emits onSave(data) / onDelete(id).
 */
export class BequestEditor extends BaseComponent {
  constructor({ parent, container, node, people = [], onSave, onDelete }) {
    super({ parent });
    this._container = container;
    this._node      = node;
    this._people    = people;
    this.onSave     = onSave   ?? null;
    this.onDelete   = onDelete ?? null;
    // Working copy of the asset rows.
    this._assets = (node?.assets ?? []).map(a => ({ ...a }));
  }

  render() {
    const root = this._el('div', { class: 'node-editor bequest-editor' });
    const isEdit = !!(this._node?.id);

    root.appendChild(this._el('h3', { text: isEdit ? 'Edit Inheritance' : 'New Inheritance' }));

    this._name        = this._field(root, 'Name',            'text',   this._node?.name ?? '');
    this._decedent    = this._field(root, 'Decedent name',   'text',   this._node?.decedentName ?? '');
    this._relationship = this._select(root, 'Relationship (NE class)', RELATIONSHIPS, this._node?.relationship ?? 'immediate');
    this._decedentState = this._select(root, 'Decedent state (situs)', SITUS, this._node?.decedentState ?? '');
    this._heir        = this._select(root, 'Heir', this._people.map(p => [p.id, p.name || p.id]), this._node?.heirId ?? '');
    this._year        = this._field(root, 'Inheritance year (blank = inert)', 'number', this._node?.inheritanceYear ?? '');
    this._paidViaEstate = this._checkbox(root, 'AU super paid via estate (no +2% Medicare)', !!this._node?.paidViaEstate);

    // ── Inherited assets ──────────────────────────────────────────────────────
    root.appendChild(this._el('h4', { text: 'Inherited assets' }));
    this._assetsBox = this._el('div', { class: 'bequest-assets' });
    root.appendChild(this._assetsBox);
    this._renderAssets();

    const addBtn = this._el('button', { type: 'button', class: 'btn', text: '+ Add asset' });
    this.listen(addBtn, 'click', () => {
      this._assets.push({ __type: 'BrokerageAccount', name: '', inheritedValue: 0 });
      this._renderAssets();
    });
    root.appendChild(addBtn);

    // ── Actions ───────────────────────────────────────────────────────────────
    const actions = this._el('div', { class: 'node-editor-actions' });
    const saveBtn = this._el('button', { type: 'button', class: 'btn btn-primary', text: 'Save' });
    this.listen(saveBtn, 'click', () => this.onSave?.(this._readForm()));
    actions.appendChild(saveBtn);
    if (isEdit) {
      const delBtn = this._el('button', { type: 'button', class: 'btn btn-danger', text: 'Delete' });
      this.listen(delBtn, 'click', () => this._node?.id && this.onDelete?.(this._node.id));
      actions.appendChild(delBtn);
    }
    root.appendChild(actions);

    this._container.replaceChildren(root);
    this._rootEl = root;
  }

  _renderAssets() {
    this._assetsBox.replaceChildren();
    this._assets.forEach((a, i) => {
      const row = this._el('div', { class: 'bequest-asset-row' });
      const type = this._select(row, 'Type', ASSET_TYPES, a.__type ?? 'BrokerageAccount', true);
      this.listen(type, 'change', () => { a.__type = type.value; });
      const name = this._field(row, 'Name', 'text', a.name ?? '', true);
      this.listen(name, 'input', () => { a.name = name.value; });
      const val = this._field(row, 'Value (FMV)', 'number', a.inheritedValue ?? 0, true);
      this.listen(val, 'input', () => { a.inheritedValue = +val.value; });
      const basis = this._field(row, 'Deceased cost base (AU)', 'number', a.deceasedCostBase ?? '', true);
      this.listen(basis, 'input', () => { a.deceasedCostBase = basis.value === '' ? null : +basis.value; });
      const mode = this._select(row, 'RA strategy', STRATEGIES, a.distributionMode ?? '', true);
      this.listen(mode, 'change', () => { a.distributionMode = mode.value || undefined; });

      // Sale year (design 63 §13): a set year liquidates an inherited real property
      // / collectible to cash. Ignored for account types.
      const sale = this._field(row, 'Sale year (property/collectible)', 'number', a.plannedSaleYear ?? '', true);
      this.listen(sale, 'input', () => { a.plannedSaleYear = sale.value === '' ? null : Math.round(Number(sale.value)); });

      const rm = this._el('button', { type: 'button', class: 'btn btn-danger btn-sm', text: '×' });
      this.listen(rm, 'click', () => { this._assets.splice(i, 1); this._renderAssets(); });
      row.appendChild(rm);
      this._assetsBox.appendChild(row);
    });
  }

  _readForm() {
    const yr = this._year.value;
    return {
      id:             this._node?.id ?? null,
      name:           this._name.value.trim(),
      decedentName:   this._decedent.value.trim(),
      relationship:   this._relationship.value,
      decedentState:  this._decedentState.value || null,
      heirId:         this._heir.value || null,
      inheritanceYear: yr === '' ? null : Math.round(Number(yr)),
      paidViaEstate:  this._paidViaEstate.checked,
      assets:         this._assets.map(a => ({ ...a })),
    };
  }

  // ── DOM helpers ─────────────────────────────────────────────────────────────
  _el(tag, { class: cls, text, type } = {}) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (type) e.type = type;
    return e;
  }

  _field(parent, label, type, value, inline = false) {
    const wrap = this._el('div', { class: inline ? 'node-field inline' : 'node-field' });
    wrap.appendChild(this._el('label', { text: label }));
    const input = this._el('input', { type });
    input.value = value;
    wrap.appendChild(input);
    parent.appendChild(wrap);
    return input;
  }

  _select(parent, label, options, value, inline = false) {
    const wrap = this._el('div', { class: inline ? 'node-field inline' : 'node-field' });
    wrap.appendChild(this._el('label', { text: label }));
    const sel = this._el('select');
    for (const [v, l] of options) {
      const o = this._el('option', { text: l });
      o.value = v;
      if (v === value) o.selected = true;
      sel.appendChild(o);
    }
    wrap.appendChild(sel);
    parent.appendChild(wrap);
    return sel;
  }

  _checkbox(parent, label, checked) {
    const wrap = this._el('div', { class: 'node-field checkbox' });
    const input = this._el('input', { type: 'checkbox' });
    input.checked = checked;
    const lab = this._el('label');
    lab.appendChild(input);
    lab.appendChild(document.createTextNode(' ' + label));
    wrap.appendChild(lab);
    parent.appendChild(wrap);
    return input;
  }

  destroy() {
    this._rootEl?.remove();
    super.destroy();
  }
}
