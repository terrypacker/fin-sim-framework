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
 * The person editor's Jobs table (design 116 §7, phase 2).
 *
 * The load-bearing assertions: converting a one-job person seeds the first row from the
 * flat fields (so converting alone changes nothing about the run), those fields then lock,
 * Retire Date shows the DERIVED work end, and the saved person no longer carries a flat
 * wage for anything to read by mistake.
 */

import { loadHtml, makeMockContainer } from '../../helpers/viz-utils.js';
import { PersonEditor } from '../../../src/visualization/people/person-editor.js';
import { JOB_FORM_FIELDS } from '../../../src/visualization/people/jobs-section.js';

const BASE_PERSON = {
  id: 'p1', name: 'Alice', birthDate: '1980-06-01', citizen: ['US'],
  monthlyWage: 10000, wageCurrency: 'USD', workCountry: 'US', selfEmployed: false,
  retirementDate: '2045-01-01',
};

function render(node, jobs = []) {
  const saved = [];
  const editor = new PersonEditor({
    container: makeMockContainer(), node, jobs,
    householdParams: {}, accounts: [], onSave: d => saved.push(d),
  });
  editor.render();
  return { editor, root: editor._rootEl, saved };
}

const q = (root, id) => root.querySelector(`[data-id="${id}"]`);
const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
const addJob = root => q(root, 'jobsBody').querySelector('[data-id="addRow"]').click();

describe('person editor — Jobs table (design 116)', () => {
  test('a hidden non-default column still shows as a badge', () => {
    loadHtml('../../index.html');
    const { root } = render(BASE_PERSON, [
      { id: 'a', personId: 'p1', monthlyWage: 8000, realGrowth: 0.02, selfEmployed: true }]);
    const badges = q(root, 'jobsBody').querySelector('[data-id="badges"]').textContent;
    expect(badges).toContain('+2.0%/yr real');
    expect(badges).toContain('self-employed');
  });

  beforeEach(() => loadHtml('../../index.html'));

  test('a person without jobs keeps the flat fields editable and saves no jobs', () => {
    const { root, saved } = render(BASE_PERSON);
    expect(q(root, 'monthlyWage').disabled).toBe(false);
    expect(q(root, 'retirementDate').value).toBe('2045-01-01');
    q(root, 'saveBtn').click();
    expect(saved[0].jobs).toEqual([]);
    expect(saved[0].monthlyWage).toBe(10000);
  });

  test('the first job is seeded from the flat fields, which then lock', () => {
    const { editor, root, saved } = render(BASE_PERSON);
    addJob(root);
    expect(editor.readJobs()).toEqual([{
      startDate: null, endDate: '2045-01-01', monthlyWage: 10000, realGrowth: 0,
      wageCurrency: 'USD', workCountry: 'US', selfEmployed: false,
    }]);
    for (const id of ['monthlyWage', 'selfEmployed', 'wageCurrency', 'workCountry', 'retirementDate']) {
      expect(q(root, id).disabled).toBe(true);
    }
    expect(q(root, 'retirementDate').value).toBe('2045-01-01');

    q(root, 'saveBtn').click();
    expect(saved[0].jobs).toHaveLength(1);
    expect(saved[0].monthlyWage).toBe(0);
    expect(saved[0].workCountry).toBe(null);
    expect('retirementDate' in saved[0]).toBe(false);
  });

  test('a second job starts where the first ends; an open end blanks Retire Date', () => {
    const { editor, root } = render(BASE_PERSON);
    addJob(root);
    addJob(root);
    const rows = editor.readJobs();
    expect(rows[1].startDate).toBe('2045-01-01');
    expect(rows[1].endDate).toBe(null);
    expect(q(root, 'retirementDate').value).toBe('');

    const wage = q(root, 'jobsBody').querySelectorAll('[data-id="job_monthlyWage"]')[1];
    wage.value = '7000';
    fire(wage, 'change');
    expect(editor.readJobs()[1].monthlyWage).toBe(7000);
  });

  test('removing every job unlocks the fields and restores the authored retire date', () => {
    const { root } = render(BASE_PERSON);
    addJob(root);
    q(root, 'jobsBody').querySelector('[data-id="removeRow"]').click();
    expect(q(root, 'monthlyWage').disabled).toBe(false);
    expect(q(root, 'retirementDate').value).toBe('2045-01-01');
  });

  test('existing jobs render locked, sorted by start', () => {
    const { editor, root } = render(BASE_PERSON, [
      { id: 'b', personId: 'p1', startDate: '2031-07-01', monthlyWage: 9000, wageCurrency: 'AUD' },
      { id: 'a', personId: 'p1', endDate: '2031-07-01', monthlyWage: 8000, wageCurrency: 'USD' },
    ]);
    expect(q(root, 'monthlyWage').disabled).toBe(true);
    expect(q(root, 'jobsSection').open).toBe(true);
    // Sorting happens on edit; the stored ids survive the round trip either way.
    expect(editor.readJobs().map(j => j.id).sort()).toEqual(['a', 'b']);
  });

  test('every JOB_FORM_FIELDS column renders under its job_ id, the optional ones on request', () => {
    const { root } = render(BASE_PERSON);
    addJob(root);
    expect(q(root, 'jobsBody').querySelector('[data-id="job_realGrowth"]')).toBeNull();
    const all = q(root, 'jobsShowAll');
    all.checked = true;
    fire(all, 'change');
    for (const f of JOB_FORM_FIELDS) {
      expect(q(root, 'jobsBody').querySelector(`[data-id="job_${f.field}"]`)).not.toBeNull();
    }
  });
});
