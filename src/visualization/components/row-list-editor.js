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
 * @param {Array<{field: string, label: string, type?: 'number'|'select'|'text'|'checkset',
 *                step?: string|function(object): string,
 *                min?: string|function(object): string,
 *                max?: string|function(object): string,
 *                options?: Array<[value: string, label: string]>
 *                         | function(): Array<[value: string, label: string]>,
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
 * @returns {HTMLElement} the container, carrying a `.refresh()` that re-renders it.
 *        Needed when a column's options depend on ANOTHER editor's rows (the pool ids a
 *        claim or a flow names): that editor's `onChange` calls this one's `refresh`, so a
 *        renamed pool is not silently orphaned in the sibling table.
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
        rowEl.appendChild(buildCell(col, row, changed, resort, render));
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
  container.refresh = render;
  return container;
}

/** Dispatch a column to its cell builder. */
function buildCell(col, row, changed, resort, rerender) {
  // `rerender: true` re-draws the whole list after this cell changes. For columns whose
  // value decides what ANOTHER column in the same row may offer — picking a savings account
  // means that row has no sleeves to narrow — this is what keeps the impossible choice off
  // the screen instead of letting it be typed and rejected at Rebuild.
  const after = col.rerender ? () => { if (resort) resort(); else rerender(); } : resort;
  switch (col.type) {
    case 'select':   return buildSelect(col, row, changed, after);
    case 'text':     return buildText(col, row, changed, after);
    case 'checkset': return buildCheckSet(col, row, changed);
    default:         return buildNumber(col, row, changed, after);
  }
}

/**
 * A column's options, which may be a live function — of nothing (a list that depends on a
 * sibling editor's rows) or of the row (a list that depends on another cell in the same row).
 */
function optionsOf(col, row = null) {
  const raw = typeof col.options === 'function' ? col.options(row) : col.options;
  return Array.isArray(raw) ? raw : NO_OPTIONS;
}

/**
 * A free-text cell — for the one field a closed list cannot supply: an identity the user
 * invents (a pool id, a flow id). Blank writes `col.blankValue ?? null` on the same rule as
 * a numeric cell, so an unfinished row is filtered out by `readRowList` rather than saved
 * as an empty-string key that nothing can reference.
 */
function buildText(col, row, changed, resort = null) {
  const input = document.createElement('input');
  input.type       = 'text';
  input.className  = 'age-band-input';
  input.dataset.id = col.field;
  if (col.placeholder != null) input.placeholder = col.placeholder;
  input.value = row[col.field] ?? '';
  input.addEventListener('change', () => {
    const raw = input.value.trim();
    row[col.field] = raw === '' ? (col.blankValue ?? null) : raw;
    changed();
    if (resort) resort();
  });
  return input;
}

/**
 * A checkbox SET cell — an array-valued column over a closed list (the ALLOCATION sleeves a
 * pool claim narrows to).
 *
 * A set, deliberately, not an ordered multi-select. `EnumMulti` expresses order by CHECK
 * ORDER, which under-serves an order-valued param and over-serves a set-valued one; sleeves
 * within a claim are unordered (the sell order inside a pool is design-65's `sleeveOrder`,
 * a different lever), so ticking is exactly the right control here.
 *
 * Blank (nothing ticked) writes `col.blankValue ?? null`, and for a claim that null is
 * meaningful: it means "the WHOLE account", not "no sleeves". Rendering it as every box
 * unticked is honest — the pool is not narrowed.
 */
function buildCheckSet(col, row, changed) {
  const wrap = document.createElement('div');
  wrap.className  = 'row-list-checkset';
  wrap.dataset.id = col.field;

  const options = optionsOf(col, row);
  if (options.length === 0) {
    // No options for THIS row (the account it names holds no sleeves). Say so, rather than
    // rendering an empty cell that reads as a control that failed to draw.
    const note = document.createElement('span');
    note.className   = 'row-list-note';
    note.textContent = col.emptyText ?? '—';
    wrap.appendChild(note);
    return wrap;
  }

  const selected = new Set(Array.isArray(row[col.field]) ? row[col.field] : []);
  for (const [value, label] of options) {
    const lab = document.createElement('label');
    lab.className = 'enum-multi-option';
    const cb = document.createElement('input');
    cb.type    = 'checkbox';
    cb.value   = value;
    cb.checked = selected.has(value);
    cb.dataset.id = `${col.field}:${value}`;
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(value); else selected.delete(value);
      row[col.field] = selected.size ? [...selected] : (col.blankValue ?? null);
      changed();
    });
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(label));
    wrap.appendChild(lab);
  }
  return wrap;
}

/**
 * A column attribute that may depend on the ROW — `min`, `max`, `step`, `placeholder`.
 *
 * A pool's size is the case: the same cell means a fraction of the book under PERCENT, a
 * number of years under YEARS_OF_SPEND and a currency figure under AMOUNT, and those three
 * do not share a range. One static `max` would either permit the value the compiler rejects
 * or forbid one it requires, so the bound is read per row, from the row's own mode.
 */
function attrOf(col, key, row) {
  const raw = col[key];
  return typeof raw === 'function' ? raw(row) : raw;
}

/**
 * A numeric cell. Blank writes `col.blankValue` — `null` by default, never 0 (see
 * `readRowList`). A column whose consumer requires the key PRESENT (an allocation
 * weight, where an absent key and a deliberate 0 mean different things) declares
 * `blankValue: 0` instead.
 *
 * `min`/`max` are ENFORCED, not merely advertised. A bare `max` attribute stops the
 * spinner and fails form validation, and this editor is in no form — so a typed 100 in a
 * cell bounded at 1 was written to the row, saved, and only rejected by the compiler at the
 * NEXT page load, where the editor that could fix it no longer renders (design 97; the
 * `scenario-load-error-overlay` is the surface built for exactly that trip). Clamping here
 * is the cheap half of the fix: the value the cell shows is a value the compiler accepts.
 */
function buildNumber(col, row, changed, resort = null) {
  const input = document.createElement('input');
  input.type      = 'number';
  input.className = 'age-band-input';
  input.dataset.id = col.field;
  const step = attrOf(col, 'step', row);
  const min  = attrOf(col, 'min',  row);
  const max  = attrOf(col, 'max',  row);
  const placeholder = attrOf(col, 'placeholder', row);
  if (step        != null) input.step        = step;
  if (min         != null) input.min         = min;
  if (max         != null) input.max         = max;
  if (placeholder != null) input.placeholder = placeholder;
  if (col.title   != null) input.title       = attrOf(col, 'title', row) ?? '';
  input.value = row[col.field] ?? '';
  input.addEventListener('change', () => {
    const raw = input.value.trim();
    if (raw === '') {
      row[col.field] = col.blankValue ?? null;
    } else {
      let n = Number(raw);
      if (min != null && Number.isFinite(Number(min))) n = Math.max(Number(min), n);
      if (max != null && Number.isFinite(Number(max))) n = Math.min(Number(max), n);
      row[col.field] = n;
      // Show the clamp. Writing a different number than the one on screen is how a value
      // silently disagrees with its own control.
      if (n !== Number(raw)) input.value = n;
    }
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
  for (const [value, label] of optionsOf(col, row)) {
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
