/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { buildRowListEditor } from '../components/row-list-editor.js';

/**
 * bonuses-section.js — the person editor's Bonuses table.
 *
 * One row per dated one-off bonus, joined to the person by `personId` in `cfg.bonuses`. The
 * job the person holds on the date pays it, so a row needs only a date and an amount; the
 * host validates the rows against the person's jobs as they will be saved.
 */

/**
 * The table's columns, as the help generator reads them (design 111: `NODE_EDITORS.bonus`).
 * `dataId` is `bonus_<field>` so a cell never collides with a person field on the same form.
 */
export const BONUS_FORM_FIELDS = Object.freeze([
  { field: 'date',   label: 'Date',   kind: 'date' },
  { field: 'amount', label: 'Amount', kind: 'number' },
]);

/** The DOM id prefix of a bonus cell. */
export const BONUS_ID_PREFIX = 'bonus_';

const COLUMN_EXTRAS = {
  date:   { width: '1.3fr' },
  amount: { step: '1000', min: '0', width: '1fr', blankValue: 0 },
};

const dateStr = v => (v == null || v === '' ? null
  : String(v instanceof Date ? v.toISOString() : v).slice(0, 10));

export class BonusesSection {
  /**
   * @param {object} o
   * @param {HTMLElement} o.container
   * @param {Array<object>} o.bonuses  this person's `cfg.bonuses` rows (copied, never mutated)
   * @param {function(): void} [o.onChange]  after every add, remove or edit
   */
  constructor({ container, bonuses = [], onChange = null }) {
    this._container = container;
    this._rows      = (bonuses ?? []).map(b => ({ ...b }));
    this._onChange  = onChange;
  }

  render() {
    const columns = BONUS_FORM_FIELDS.map(f => ({
      field:  f.field,
      label:  f.label,
      type:   f.kind === 'number' ? undefined : f.kind,
      dataId: `${BONUS_ID_PREFIX}${f.field}`,
      ...COLUMN_EXTRAS[f.field],
    }));
    const el = buildRowListEditor({
      rows:      this._rows,
      columns,
      newRow:    () => ({ date: null, amount: 0 }),
      addLabel:  '+ Add Bonus',
      emptyText: 'No bonuses. A bonus is paid once, on its date, by the job held then.',
      sortBy:    (a, b) => (a.date ?? '').localeCompare(b.date ?? ''),
      onChange:  () => this._onChange?.(),
    });
    el.classList.add('bonuses-table');
    this._container.replaceChildren(el);
  }

  /** The rows to persist: the date as 'YYYY-MM-DD', the amount as a number. */
  readBonuses() {
    return this._rows.map(r => ({
      ...(r.id != null && { id: r.id }),
      date:   dateStr(r.date),
      amount: Number(r.amount ?? 0) || 0,
    }));
  }
}
