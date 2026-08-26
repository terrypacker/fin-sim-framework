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
 * row-list-editor.js — a repeating-row editor over a list of small objects.
 *
 * Design 95 §17.4 asks for this once and uses it twice: `wageSplits`
 * (`{destinationKey, mode, value}`) and `k401MatchTiers`
 * (`{matchRate, uptoPctOfComp}`) are the same widget over different columns. The
 * scenario panel already has three near-copies of this shape (`RothScheduleList`,
 * `PrimeScheduleList`, `EarlyWithdrawalScheduleList`); rather than add a fourth and
 * a fifth, the two design-95 lists share one, and it reuses those editors' CSS so
 * the two surfaces look like one product.
 *
 * ─── it owns its array, and mutates it in place ──────────────────────────────
 *
 * `rows` is the caller's array and is edited in place, so the caller reads the
 * current value straight off the array it passed in — there is no getter to forget
 * to call and no copy to fall out of date. The caller is responsible for cloning
 * before handing an array in when the source must not be mutated (a schema default,
 * a record still being displayed elsewhere).
 *
 * ─── an empty list is a real, distinct state ─────────────────────────────────
 *
 * Removing the last row leaves `[]`, and `[]` is NOT the same as "no election" for
 * every consumer: `splitWage` collapses an empty list to the single-destination
 * path, and `monthlyK401` falls back to the flat match rate. Both are the
 * no-election behaviour, so an emptied list is safe — but the caller decides
 * whether to persist `[]` or `null`, because on a Person those two differ in what a
 * later household default would do. See `readRowList`.
 */

const NO_OPTIONS = [];

/**
 * Build a repeating-row editor.
 *
 * @param {object} opts
 * @param {Array<object>} opts.rows        the list being edited, mutated IN PLACE
 * @param {Array<{field: string, label: string, type?: 'number'|'select',
 *                step?: string, min?: string, max?: string,
 *                options?: Array<[value: string, label: string]>,
 *                placeholder?: string, blankValue?: *,
 *                width?: string}>} opts.columns
 * @param {function(): object} opts.newRow  factory for the row "+ Add" appends
 * @param {string} [opts.addLabel='+ Add']
 * @param {function(): void} [opts.onChange] called after every edit/add/remove
 * @param {string} [opts.emptyText]         shown in place of the header when empty
 * @param {function(object, object): number} [opts.sortBy] comparator; when given, the
 *        list is re-sorted and re-rendered after any cell edit, so an ordering
 *        invariant the consumer relies on (ascending year, ascending tenor) holds
 *        for whatever the user types, not just for what they typed in order.
 * @param {boolean} [opts.reorderable=false] add a "move up" button per row, for lists
 *        whose ORDER is the datum (a preference ranking) rather than incidental.
 * @returns {HTMLElement}
 */
export function buildRowListEditor({ rows, columns, newRow, addLabel = '+ Add',
                                     onChange = null, emptyText = null,
                                     sortBy = null, reorderable = false }) {
  const container = document.createElement('div');
  container.className = 'age-band-list-editor row-list-editor';

  // The remove button's fixed 26px column is the shared band-editor convention.
  const grid = [...columns.map(c => c.width ?? '1fr'),
                ...(reorderable ? ['26px'] : []), '26px'].join(' ');

  const changed = () => { if (onChange) onChange(); };

  const render = () => {
    container.innerHTML = '';

    if (rows.length === 0 && emptyText) {
      const empty = document.createElement('div');
      empty.className = 'row-list-empty';
      empty.textContent = emptyText;
      container.appendChild(empty);
    } else {
      const header = document.createElement('div');
      header.className = 'age-band-row age-band-header';
      header.style.gridTemplateColumns = grid;
      for (const { label } of columns) {
        const h = document.createElement('span');
        h.className = 'age-band-col-label';
        h.textContent = label;
        header.appendChild(h);
      }
      // One spacer per trailing button track (move-up, remove) so the header
      // labels stay aligned over their own columns.
      if (reorderable) header.appendChild(document.createElement('span'));
      header.appendChild(document.createElement('span'));  // spacer over remove
      container.appendChild(header);
    }

    rows.forEach((row, idx) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'age-band-row';
      rowEl.style.gridTemplateColumns = grid;

      // A cell edit re-sorts and re-renders when the caller declared an ordering,
      // so the row the user just retyped moves to where the consumer will read it.
      const resort = sortBy ? () => { rows.sort(sortBy); render(); } : null;
      for (const col of columns) {
        rowEl.appendChild(col.type === 'select' ? buildSelect(col, row, changed, resort)
                                                : buildNumber(col, row, changed, resort));
      }

      if (reorderable) {
        const up = document.createElement('button');
        up.type = 'button';
        up.className = 'btn age-band-remove row-list-move';
        up.textContent = '\u25b2';
        up.title = 'Move up';
        up.dataset.id = 'moveRowUp';
        up.disabled = idx === 0;
        up.addEventListener('click', () => {
          if (idx === 0) return;
          [rows[idx - 1], rows[idx]] = [rows[idx], rows[idx - 1]];
          render();
          changed();
        });
        rowEl.appendChild(up);
      }

      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'btn btn-warn age-band-remove';
      rm.textContent = '✕';
      rm.title = 'Remove row';
      rm.dataset.id = 'removeRow';
      rm.addEventListener('click', () => { rows.splice(idx, 1); render(); changed(); });
      rowEl.appendChild(rm);

      container.appendChild(rowEl);
    });

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'btn btn-sm age-band-add-btn';
    add.dataset.id = 'addRow';
    add.textContent = addLabel;
    add.addEventListener('click', () => { rows.push(newRow()); render(); changed(); });
    container.appendChild(add);
  };

  render();
  return container;
}

/**
 * A numeric cell. Blank writes `col.blankValue` — `null` by default, never 0 (see
 * `readRowList`). A column whose consumer requires the key PRESENT (an allocation
 * weight, where an absent key and a deliberate 0 mean different things) declares
 * `blankValue: 0` instead.
 */
function buildNumber(col, row, changed, resort = null) {
  const input = document.createElement('input');
  input.type      = 'number';
  input.className = 'age-band-input';
  input.dataset.id = col.field;
  if (col.step        != null) input.step        = col.step;
  if (col.min         != null) input.min         = col.min;
  if (col.max         != null) input.max         = col.max;
  if (col.placeholder != null) input.placeholder = col.placeholder;
  input.value = row[col.field] ?? '';
  input.addEventListener('change', () => {
    const raw = input.value.trim();
    row[col.field] = raw === '' ? (col.blankValue ?? null) : Number(raw);
    changed();
    if (resort) resort();
  });
  return input;
}

/** A select cell over `[value, label]` pairs. */
function buildSelect(col, row, changed, resort = null) {
  const sel = document.createElement('select');
  sel.className   = 'age-band-input';
  sel.dataset.id  = col.field;
  for (const [value, label] of (col.options ?? NO_OPTIONS)) {
    const opt = document.createElement('option');
    opt.value       = value;
    opt.textContent = label;
    sel.appendChild(opt);
  }
  // A stored value with no matching option (a deleted account, a renamed mode)
  // would otherwise silently select the FIRST option and re-save as that — a
  // different plan the user never chose. Keep it, marked, so it is visible and
  // survives a save that did not touch this row.
  const current = row[col.field];
  if (current != null && ![...sel.options].some(o => o.value === current)) {
    const orphan = document.createElement('option');
    orphan.value       = current;
    orphan.textContent = `${current} (not found)`;
    sel.appendChild(orphan);
  }
  sel.value = current ?? '';
  sel.addEventListener('change', () => {
    row[col.field] = sel.value === '' ? null : sel.value;
    changed();
    if (resort) resort();
  });
  return sel;
}

/**
 * What to persist for a list-valued election: the list, or `null` when it is empty.
 *
 * Design 95 §13.2's rule for the scalar elections is that blank means INHERIT and 0
 * means elect nothing. The list elections have no such ambiguity to preserve — an
 * empty list and a null both mean "no election here" to `splitWage` and
 * `monthlyK401` — so they normalise to `null`, which is the shape a Person carries
 * by default and the one both serializer halves already round-trip. Persisting `[]`
 * would work identically today and differ the moment anything distinguishes "an
 * empty list I authored" from "never set".
 *
 * @param {Array<object>} rows
 * @param {function(object): boolean} isComplete  a row worth keeping
 * @returns {Array<object>|null}
 */
export function readRowList(rows, isComplete) {
  const kept = (rows ?? []).filter(isComplete);
  return kept.length > 0 ? kept : null;
}
