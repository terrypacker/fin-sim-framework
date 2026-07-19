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
  constructor({ parent, container, node, people = [], promotedAssets = [], onSave, onDelete,
                links = null, onParamChange = null, onOpenParam = null }) {
    super({ parent });
    this._container = container;
    this._node      = node;
    this._people    = people;
    this.onSave     = onSave   ?? null;
    this.onDelete   = onDelete ?? null;
    this._links        = links;             // ParamFieldLinks (design/32)
    this.onParamChange = onParamChange ?? null;
    this.onOpenParam   = onOpenParam   ?? null;
    this._linkedFields = new Set();
    // Working copy of the INLINE asset rows (retirement / super, and — while the
    // bequest is inert — any not-yet-promoted brokerage / property / collectible).
    this._assets = (node?.assets ?? []).map(a => ({ ...a }));
    // Read-only view of assets already PROMOTED to first-class records (design 63
    // §14): once the bequest is active, its brokerage / property / collectible are
    // real accounts / properties / collectibles, edited in the Accounts / Assets
    // panels. Surfaced here so they stay visible in the bequest's context.
    this._promotedAssets = promotedAssets ?? [];
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

    // ── Promoted (first-class) inherited assets ─────────────────────────────────
    // Design 63 §14: an active bequest's brokerage / property / collectible are real
    // records — edited in the Accounts / Assets panels, tuned by their per-record
    // params. Show them read-only here so they stay visible in the bequest's context.
    if (this._promotedAssets.length > 0) {
      root.appendChild(this._el('h4', { text: 'Promoted assets (edit in Accounts / Assets)' }));
      const box = this._el('div', { class: 'bequest-promoted' });
      for (const p of this._promotedAssets) {
        const v = p.inheritedValue ?? p.value ?? p.balance ?? 0;
        const kind = p.type ?? p.kind ?? p.__type ?? p.constructor?.name ?? 'asset';
        box.appendChild(this._el('div', {
          class: 'bequest-promoted-row',
          text: `${p.name || p.stateKey} — ${kind} · FMV ${Number(v).toLocaleString()}`,
        }));
      }
      root.appendChild(box);
    }

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

    this._bindParamLinks();

    this._container.replaceChildren(root);
    this._rootEl = root;
  }

  /**
   * Route the param-backed `inheritanceYear` field through its generated
   * `bequest.<stateKey>.inheritanceYear` param (design/32, design 55 §14.3): a
   * direct edit writes the param (the source of truth) rather than only the
   * record, and a 🔗 badge jumps to the param in the Scenario panel. Without
   * this, the param→record cascade clobbers a form edit on the next Rebuild.
   */
  _bindParamLinks() {
    this._linkedFields = new Set();
    const stateKey = this._node?.stateKey;
    if (!stateKey || !this._links) return;

    const param = this._links.getParamFor('bequest', stateKey, 'inheritanceYear');
    if (!param) return;
    const labelEl = this._year?.closest('.node-field')?.querySelector('label');
    bindParamLinkedField({
      input: this._year, labelEl, param,
      coerce: (raw) => (raw === '' || raw == null) ? null : Math.round(Number(raw)),
      onChange: () => this.onParamChange?.(),
      onOpen:   (p) => this.onOpenParam?.(p),
    });
    this._linkedFields.add('inheritanceYear');
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
    const data = {
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
    // Param-backed fields are owned by their scenario param (design/32) — the
    // editor wrote the change onto the param; excluding it here keeps the record
    // from carrying a divergent value the cascade would then overwrite.
    for (const f of this._linkedFields) delete data[f];
    return data;
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
