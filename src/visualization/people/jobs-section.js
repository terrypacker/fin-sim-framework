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
 * jobs-section.js — the person editor's Jobs table (design 116 §7).
 *
 * One row per employment spell, joined to the person by `personId` in `cfg.jobs`. A flat
 * table, never a JSON box: start · end · wage · real growth · currency · work country ·
 * self-employed.
 *
 * ─── converting a one-job person ─────────────────────────────────────────────
 *
 * A person with no jobs runs on the flat fields above the table (wage, currency, work
 * country, self-employed, retire date). The FIRST "+ Add Job" seeds its row from those
 * fields, ending at the retire date, so converting changes nothing about the run until the
 * author edits the row. From then on the flat fields are locked — the engine ignores them
 * for a person with jobs, and an editable box nothing reads is a silent wrong answer.
 * Nothing converts on load: a legacy scenario stays legacy until its author does this.
 */

/**
 * The table's columns, as the help generator reads them (design 111: `NODE_EDITORS.job`).
 * `dataId` is `job_<field>` so a cell never collides with the person's own field of the
 * same name on the same form.
 */
export const JOB_FORM_FIELDS = Object.freeze([
  { field: 'startDate',    label: 'Start',         kind: 'date' },
  { field: 'endDate',      label: 'End',           kind: 'date' },
  { field: 'monthlyWage',  label: 'Wage /mo',      kind: 'number' },
  { field: 'realGrowth',   label: 'Real Growth',   kind: 'number' },
  { field: 'wageCurrency', label: 'Currency',      kind: 'select' },
  { field: 'workCountry',  label: 'Work Country',  kind: 'select' },
  { field: 'selfEmployed', label: 'Self-employed', kind: 'checkbox' },
  // Phase 3 — employer terms. Blank inherits the person's value, then the household's.
  { field: 'k401EmployerMatchPct', label: '401(k) Match',   kind: 'number' },
  { field: 'k401NonElectivePct',   label: 'Non-Elective',   kind: 'number' },
  { field: 'superGuaranteePct',    label: 'Super Guarantee', kind: 'number' },
]);

/** The employer-term columns: nullable fractions, where blank means "inherit". */
const TERM_FIELDS = ['k401EmployerMatchPct', 'k401NonElectivePct', 'superGuaranteePct'];

/** The DOM id prefix of a job cell. */
export const JOB_ID_PREFIX = 'job_';

const COLUMN_EXTRAS = {
  startDate:    { width: '1.3fr' },
  endDate:      { width: '1.3fr' },
  monthlyWage:  { step: '100', min: '0', width: '1fr', blankValue: 0 },
  realGrowth:   { step: '0.005', min: '-0.5', max: '0.5', width: '0.8fr', placeholder: '0',
                  optional: true,
                  badge: r => (Number(r.realGrowth) ? `+${(Number(r.realGrowth) * 100).toFixed(1)}%/yr real` : null) },
  wageCurrency: { type: 'select', width: '0.8fr', options: [['USD', 'USD'], ['AUD', 'AUD']] },
  workCountry:  { type: 'select', width: '1.1fr', optional: true,
                  options: [['', 'Residency'], ['US', 'US'], ['AU', 'AU']],
                  badge: r => (r.workCountry ? `works in ${r.workCountry}` : null) },
  selfEmployed: { width: '0.6fr', optional: true, badge: r => (r.selfEmployed ? 'self-employed' : null) },
  ...Object.fromEntries(TERM_FIELDS.map(f => [f, {
    step: '0.005', min: '0', max: '1', width: '0.8fr', placeholder: 'inherit', optional: true,
    badge: r => (r[f] != null ? `${JOB_FORM_FIELDS.find(x => x.field === f).label} ${(r[f] * 100).toFixed(1)}%` : null),
  }])),
};

const dateStr = v => (v == null || v === '' ? null
  : String(v instanceof Date ? v.toISOString() : v).slice(0, 10));

export class JobsSection {
  /**
   * @param {object} o
   * @param {HTMLElement} o.container
   * @param {Array<object>} o.jobs   this person's `cfg.jobs` rows (copied, never mutated)
   * @param {function(): object} o.readFlat  the form's CURRENT flat job fields
   *        `{ monthlyWage, wageCurrency, workCountry, selfEmployed, retirementDate }`,
   *        which seed the first row
   * @param {function(): void} [o.onChange]  after every add, remove or edit
   */
  constructor({ container, jobs = [], readFlat, onChange = null }) {
    this._container = container;
    this._rows      = (jobs ?? []).map(j => ({ ...j }));
    this._readFlat  = readFlat;
    this._onChange  = onChange;
    // The edit pane is narrow: growth, work country and self-employed are drawn only on
    // request, and a non-default value in a hidden column still shows as a badge.
    this._showAll   = false;
  }

  /** Does the person have any job rows (and so locked flat fields)? */
  get hasJobs() { return this._rows.length > 0; }

  render() {
    const columns = JOB_FORM_FIELDS.map(f => ({
      field:  f.field,
      label:  f.label,
      type:   f.kind === 'number' ? undefined : f.kind,
      dataId: `${JOB_ID_PREFIX}${f.field}`,
      ...COLUMN_EXTRAS[f.field],
    }));
    const toggle = document.createElement('label');
    toggle.className = 'row-list-toggle';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.id = 'jobsShowAll';
    cb.checked = this._showAll;
    toggle.append(cb, document.createTextNode(' More columns'));
    const el = buildRowListEditor({
      showOptional: () => this._showAll,
      rows:      this._rows,
      columns,
      newRow:    () => this._newRow(),
      addLabel:  '+ Add Job',
      emptyText: 'One job, from the fields above, until the Retire Date. '
        + 'Add a job to give this person a sequence of jobs instead.',
      // By start, the order the engine reads them in; a blank start is the run's start.
      sortBy:    (a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? ''),
      onChange:  () => this._onChange?.(),
    });
    cb.addEventListener('change', () => { this._showAll = cb.checked; el.refresh(); });
    el.classList.add('jobs-table');
    this._container.replaceChildren(toggle, el);
  }

  /**
   * The row "+ Add Job" appends. The first one converts the person: it carries the flat
   * fields and ends at the retire date. A later one starts where the last row ends, in
   * the last row's currency — the common case is "the next job".
   */
  _newRow() {
    if (this._rows.length === 0) {
      const f = this._readFlat?.() ?? {};
      return {
        startDate:    null,
        endDate:      dateStr(f.retirementDate),
        monthlyWage:  Number(f.monthlyWage ?? 0),
        realGrowth:   0,
        wageCurrency: f.wageCurrency ?? 'USD',
        workCountry:  f.workCountry || null,
        selfEmployed: !!f.selfEmployed,
      };
    }
    const last = this._rows[this._rows.length - 1];
    return {
      startDate:    last.endDate ?? null,
      endDate:      null,
      monthlyWage:  0,
      realGrowth:   0,
      wageCurrency: last.wageCurrency ?? 'USD',
      workCountry:  last.workCountry ?? null,
      selfEmployed: false,
    };
  }

  /**
   * The rows to persist, normalised: dates as 'YYYY-MM-DD' or null, numbers as numbers,
   * an empty work country as null ("where they live").
   */
  readJobs() {
    return this._rows.map(r => ({
      ...(r.id != null && { id: r.id }),
      startDate:    dateStr(r.startDate),
      endDate:      dateStr(r.endDate),
      monthlyWage:  Number(r.monthlyWage ?? 0) || 0,
      realGrowth:   Number(r.realGrowth ?? 0) || 0,
      wageCurrency: r.wageCurrency ?? 'USD',
      workCountry:  r.workCountry || null,
      selfEmployed: !!r.selfEmployed,
      // Blank stays null — "inherit" — and never becomes 0, which would opt the job out
      // of the household's rate (design 95 §13.2's rule, applied per job).
      ...Object.fromEntries(TERM_FIELDS
        .filter(f => r[f] != null && r[f] !== '').map(f => [f, Number(r[f])])),
      ...(Array.isArray(r.k401MatchTiers) && { k401MatchTiers: r.k401MatchTiers }),
    }));
  }
}
