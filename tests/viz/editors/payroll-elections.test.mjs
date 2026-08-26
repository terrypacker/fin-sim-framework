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
 * Per-person payroll elections in the person editor (design 95 §17 phase 10, G1-G3).
 *
 * The load-bearing assertion here is the INHERIT/OPT-OUT round trip (§17.5, U2).
 * Every scenario the user already has was saved with `null` in all thirteen election
 * fields; an editor that wrote `0` for an untouched field would convert every one of
 * them from "inherit the household default" into "elect nothing" on the first save,
 * silently. That is the same distinction PAY-14 pins at the model layer, asserted
 * here at the UI layer where §17.6 says it is easier to get wrong.
 */

import { loadHtml, makeMockContainer } from '../../helpers/viz-utils.js';
import { PersonEditor }     from '../../../src/visualization/people/person-editor.js';
import { PeopleController } from '../../../src/visualization/people/people-controller.js';
import { ParamFieldLinks }  from '../../../src/visualization/scenario/param-field-links.js';
import { electionFieldId }  from '../../../src/visualization/people/payroll-section.js';
import { PAYROLL_ELECTION_FIELDS } from '../../../src/finance/person.js';
import {
  PAYROLL_ELECTION_META, PAYROLL_ELECTION_META_BY_FIELD, ELECTION_KIND,
} from '../../../src/finance/payroll/payroll-election-meta.js';

const ACCOUNTS = [
  { id: 'ac1', name: 'US Checking',   stateKey: 'usSavingsAccount',  role: 'us-savings', currency: { code: 'USD', symbol: '$' } },
  { id: 'ac2', name: 'US Brokerage',  stateKey: 'usStockAccount',    role: 'us-stock',   currency: { code: 'USD', symbol: '$' } },
  { id: 'ac3', name: 'AU Everyday',   stateKey: 'auSavingsAccount',  role: 'au-savings', currency: { code: 'AUD', symbol: '$' } },
  { id: 'ac4', name: 'Unwired',       role: 'us-savings',            currency: { code: 'USD', symbol: '$' } },  // no stateKey
  // Not depositable: a wage split into either would credit a bare balance — money
  // into a wrapper with no contribution accounted for, or debt GROWN by a paycheque.
  { id: 'ac5', name: 'Alice 401(k)',  stateKey: 'k401Account',       role: 'k401',       currency: { code: 'USD', symbol: '$' } },
  { id: 'ac6', name: 'Mortgage',      stateKey: 'usMortgageLoan',    role: 'us-loan',    currency: { code: 'USD', symbol: '$' } },
];

const HOUSEHOLD = {
  k401DeferralPct: 0.10,
  k401EmployerMatchPct: 0.04,
  iraAnnualContribution: 7000,
  superGuaranteePct: 0.12,
  // The one field whose household key is NOT its own name (person `superAnnualCap`).
  superGuaranteeAnnualCap: 30000,
};

function render(node, opts = {}) {
  const editor = new PersonEditor({
    container:       makeMockContainer(),
    node,
    householdParams: HOUSEHOLD,
    accounts:        ACCOUNTS,
    ...opts,
  });
  editor.render();
  return editor;
}

const field = (editor, name) =>
  editor._rootEl.querySelector(`[data-id="${electionFieldId(name)}"]`);

function fire(el, type) { el.dispatchEvent(new Event(type, { bubbles: true })); }

const BASE_PERSON = {
  id: 'p1', name: 'Alice', birthDate: '1980-06-01', citizen: ['US'],
  monthlyWage: 10000, wageCurrency: 'USD', retirementDate: '2045-01-01',
};

describe('payroll elections — the field set', () => {
  beforeEach(() => loadHtml('../../index.html'));

  test('the meta list covers exactly PAYROLL_ELECTION_FIELDS', () => {
    // Design 95 §13.2: four places have to agree on the election list, and a field
    // present in three of them is inert in a way nothing errors on. The editor is
    // the fifth, and it is the one where a missing field is invisible rather than
    // wrong — the election simply cannot be set.
    expect([...PAYROLL_ELECTION_META_BY_FIELD.keys()].sort())
      .toEqual([...PAYROLL_ELECTION_FIELDS].sort());
  });

  test('every election is reachable in the editor', () => {
    const editor = render({ ...BASE_PERSON });
    for (const m of PAYROLL_ELECTION_META) {
      expect(field(editor, m.field)).toBeTruthy();
    }
  });
});

describe('payroll elections — inherit vs opt out (U2)', () => {
  beforeEach(() => loadHtml('../../index.html'));

  test('an unset election renders BLANK, with the household value as placeholder', () => {
    const editor = render({ ...BASE_PERSON });
    const input = field(editor, 'k401DeferralPct');
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('inherit 10%');
    // Money placeholders are not percentages.
    expect(field(editor, 'iraAnnualContribution').placeholder).toBe('inherit 7,000');
  });

  test('superAnnualCap inherits from superGuaranteeAnnualCap, not from its own name', () => {
    const editor = render({ ...BASE_PERSON });
    expect(field(editor, 'superAnnualCap').placeholder).toBe('inherit 30,000');
  });

  test('an election with no household default set says so rather than showing 0', () => {
    const editor = render({ ...BASE_PERSON });
    // rothAnnualContribution is absent from HOUSEHOLD entirely.
    expect(field(editor, 'rothAnnualContribution').placeholder).toBe('inherit (unset)');
  });

  test('an untouched form saves null for every election — never 0', () => {
    const editor = render({ ...BASE_PERSON });
    const data = editor._readForm(editor._rootEl);
    for (const m of PAYROLL_ELECTION_META) {
      expect(data[m.field]).toBeNull();
    }
  });

  test('an explicit 0 survives the round trip as 0, and reopens as 0', () => {
    const editor = render({ ...BASE_PERSON });
    const input = field(editor, 'k401DeferralPct');
    input.value = '0';
    fire(input, 'change');

    const saved = editor._readForm(editor._rootEl);
    expect(saved.k401DeferralPct).toBe(0);

    // Reopening must show the opt-out, not an "inherit" blank — otherwise the next
    // save silently restores the household rate.
    const reopened = render({ ...BASE_PERSON, k401DeferralPct: 0 });
    expect(field(reopened, 'k401DeferralPct').value).toBe('0');
    expect(reopened._readForm(reopened._rootEl).k401DeferralPct).toBe(0);
  });

  test('clearing an election back to blank saves null, not 0', () => {
    const editor = render({ ...BASE_PERSON, k401DeferralPct: 0.15 });
    const input = field(editor, 'k401DeferralPct');
    expect(input.value).toBe('0.15');

    input.value = '';
    fire(input, 'change');
    expect(editor._readForm(editor._rootEl).k401DeferralPct).toBeNull();
  });

  test('a set election round-trips its value', () => {
    const editor = render({ ...BASE_PERSON, superSalarySacrificePct: 0.05,
                            superPersonalDeductibleContribution: 8000 });
    const data = editor._readForm(editor._rootEl);
    expect(data.superSalarySacrificePct).toBe(0.05);
    expect(data.superPersonalDeductibleContribution).toBe(8000);
  });
});

describe('payroll elections — the controller carries them', () => {
  beforeEach(() => loadHtml('../../index.html'));

  function makeController() {
    const created = [];
    const updated = [];
    const service = {
      createPerson: (birthDate, opts) => { created.push({ birthDate, opts }); return { id: 'new', ...opts }; },
      updatePerson: (id, changes)     => { updated.push({ id, changes });     return { id, ...changes }; },
    };
    return { controller: new PeopleController({ personService: service }), created, updated };
  }

  test('create() passes every election through, preserving null and 0', () => {
    const { controller, created } = makeController();
    controller.create({
      name: 'Bob', birthDate: '1985-01-01', citizen: ['US'], lifeExpectancy: 90,
      socialSecurityMonthly: 0, monthlyWage: 8000, retirementDate: '2050-01-01',
      k401DeferralPct: 0, iraAnnualContribution: null,
      wageSplits: [{ destinationKey: 'usStockAccount', mode: 'PERCENT', value: 0.2 }],
    });
    const opts = created[0].opts;
    // `create()` builds an EXPLICIT shape, so an election missing from it is dropped
    // silently — the phase-1 defect shape (written, saved, consumed by nothing).
    expect(opts.k401DeferralPct).toBe(0);
    expect(opts.iraAnnualContribution).toBeNull();
    expect(opts.wageSplits).toEqual([{ destinationKey: 'usStockAccount', mode: 'PERCENT', value: 0.2 }]);
  });

  test('update() carries a cleared election as null', () => {
    const { controller, updated } = makeController();
    controller.update('p1', { k401DeferralPct: null, superSalarySacrificePct: 0 });
    expect(updated[0].changes.k401DeferralPct).toBeNull();
    expect(updated[0].changes.superSalarySacrificePct).toBe(0);
  });
});

describe('wage splits (G1)', () => {
  beforeEach(() => loadHtml('../../index.html'));

  const splitRows = (editor) =>
    [...field(editor, 'wageSplits').querySelectorAll('.age-band-row:not(.age-band-header)')];

  test('destinations are stateKeys only — an unwired account is not offered', () => {
    const editor = render({ ...BASE_PERSON, wageSplits: [{ destinationKey: 'usStockAccount', mode: 'PERCENT', value: 0.2 }] });
    const sel = splitRows(editor)[0].querySelector('[data-id="destinationKey"]');
    // `splitWage` resolves state[destinationKey]; an id never matches and the share
    // silently falls back to the transaction account (design 72 §2's defect class).
    expect([...sel.options].map(o => o.value))
      .toEqual(['', 'usSavingsAccount', 'usStockAccount']);
  });

  test('a tax wrapper and a loan are not offered as destinations', () => {
    // `creditPay` credits a balance and nothing else. Into a 401(k) that is a
    // contribution nothing accounted for — no basis, no deduction, past §402(g).
    // Into a loan, whose positive balance IS the debt (design 54), "send 20% of my
    // pay to the mortgage" would GROW the mortgage.
    const editor = render({ ...BASE_PERSON, wageSplits: [{ destinationKey: 'usStockAccount', mode: 'PERCENT', value: 0.2 }] });
    const values = [...splitRows(editor)[0].querySelector('[data-id="destinationKey"]').options]
      .map(o => o.value);
    expect(values).not.toContain('k401Account');
    expect(values).not.toContain('usMortgageLoan');
  });

  test('a foreign-currency account is not offered — splitWage refuses one', () => {
    const editor = render({ ...BASE_PERSON, wageSplits: [{ destinationKey: 'usStockAccount', mode: 'PERCENT', value: 0.2 }] });
    const values = [...splitRows(editor)[0].querySelector('[data-id="destinationKey"]').options]
      .map(o => o.value);
    expect(values).not.toContain('auSavingsAccount');
  });

  test('changing the wage currency re-offers the destinations', () => {
    const editor = render({ ...BASE_PERSON, wageSplits: [{ destinationKey: 'usStockAccount', mode: 'PERCENT', value: 0.2 }] });
    const cur = editor._rootEl.querySelector('[data-id="wageCurrency"]');
    cur.value = 'AUD';
    fire(cur, 'change');

    // A fresh row is offered the AUD accounts and only those: the wage is now paid
    // in AUD, and `splitWage` refuses a USD destination as an unmodelled FX leg.
    field(editor, 'wageSplits').querySelector('[data-id="addRow"]').click();
    const fresh = [...splitRows(editor)[1].querySelector('[data-id="destinationKey"]').options]
      .map(o => o.value);
    expect(fresh).toEqual(['', 'auSavingsAccount']);

    // The row already authored keeps its destination, marked — re-pointing it at
    // whatever came first would rewrite a plan the user never touched.
    const existing = splitRows(editor)[0].querySelector('[data-id="destinationKey"]');
    expect(existing.value).toBe('usStockAccount');
    expect([...existing.options].find(o => o.value === 'usStockAccount').textContent)
      .toMatch(/not found/);
  });

  test('a stored destination with no matching account is kept, marked, not re-pointed', () => {
    const editor = render({ ...BASE_PERSON, wageSplits: [{ destinationKey: 'goneAccount', mode: 'FIXED', value: 500 }] });
    const sel = splitRows(editor)[0].querySelector('[data-id="destinationKey"]');
    expect(sel.value).toBe('goneAccount');
    expect([...sel.options].find(o => o.value === 'goneAccount').textContent).toMatch(/not found/);
    // And it still saves as itself rather than as whichever account came first.
    expect(editor._readForm(editor._rootEl).wageSplits)
      .toEqual([{ destinationKey: 'goneAccount', mode: 'FIXED', value: 500 }]);
  });

  test('adding a row and filling it saves the split; an incomplete row is dropped', () => {
    const editor = render({ ...BASE_PERSON });
    const editorEl = field(editor, 'wageSplits');
    editorEl.querySelector('[data-id="addRow"]').click();
    editorEl.querySelector('[data-id="addRow"]').click();

    const rows = splitRows(editor);
    const dest = rows[0].querySelector('[data-id="destinationKey"]');
    dest.value = 'usStockAccount';
    fire(dest, 'change');
    const val = rows[0].querySelector('[data-id="value"]');
    val.value = '0.25';
    fire(val, 'change');
    // Row 1 is left half-typed: an account with no amount is not an election, and
    // `splitWage` would drop it anyway.
    const orphan = rows[1].querySelector('[data-id="destinationKey"]');
    orphan.value = 'usSavingsAccount';
    fire(orphan, 'change');

    expect(editor._readForm(editor._rootEl).wageSplits)
      .toEqual([{ destinationKey: 'usStockAccount', mode: 'PERCENT', value: 0.25 }]);
  });

  test('removing the last row saves null rather than an empty list', () => {
    const editor = render({ ...BASE_PERSON, wageSplits: [{ destinationKey: 'usStockAccount', mode: 'PERCENT', value: 0.2 }] });
    splitRows(editor)[0].querySelector('[data-id="removeRow"]').click();
    expect(editor._readForm(editor._rootEl).wageSplits).toBeNull();
  });

  test('editing a split never mutates the Person before Save', () => {
    const node = { ...BASE_PERSON, wageSplits: [{ destinationKey: 'usStockAccount', mode: 'PERCENT', value: 0.2 }] };
    const editor = render(node);
    const val = splitRows(editor)[0].querySelector('[data-id="value"]');
    val.value = '0.9';
    fire(val, 'change');
    expect(node.wageSplits[0].value).toBe(0.2);
  });
});

describe('401(k) match tiers (G3)', () => {
  beforeEach(() => loadHtml('../../index.html'));

  const tierRows = (editor) =>
    [...field(editor, 'k401MatchTiers').querySelectorAll('.age-band-row:not(.age-band-header)')];

  test('an existing formula renders one row per tier', () => {
    const editor = render({ ...BASE_PERSON, k401MatchTiers: [
      { matchRate: 1, uptoPctOfComp: 0.03 }, { matchRate: 0.5, uptoPctOfComp: 0.02 }] });
    const rows = tierRows(editor);
    expect(rows).toHaveLength(2);
    expect(rows[1].querySelector('[data-id="matchRate"]').value).toBe('0.5');
    expect(rows[1].querySelector('[data-id="uptoPctOfComp"]').value).toBe('0.02');
  });

  test('the safe-harbor basic match can be authored without typing JSON', () => {
    const editor = render({ ...BASE_PERSON });
    const el = field(editor, 'k401MatchTiers');
    el.querySelector('[data-id="addRow"]').click();
    el.querySelector('[data-id="addRow"]').click();
    const rows = tierRows(editor);
    const set = (row, id, v) => {
      const input = row.querySelector(`[data-id="${id}"]`);
      input.value = v;
      fire(input, 'change');
    };
    set(rows[0], 'matchRate', '1');
    set(rows[0], 'uptoPctOfComp', '0.03');
    set(rows[1], 'matchRate', '0.5');
    set(rows[1], 'uptoPctOfComp', '0.02');

    expect(editor._readForm(editor._rootEl).k401MatchTiers).toEqual([
      { matchRate: 1, uptoPctOfComp: 0.03 },
      { matchRate: 0.5, uptoPctOfComp: 0.02 },
    ]);
  });
});

describe('payroll elections — param ownership (design/32)', () => {
  beforeEach(() => loadHtml('../../index.html'));

  test('a param-backed election reads, writes and is excluded from the save payload', () => {
    const param = { name: 'person.p1.k401DeferralPct', label: '401(k) Deferral', value: 0.12,
                    node: { type: 'person', id: 'p1', field: 'k401DeferralPct' } };
    let changed = 0;
    const editor = render({ ...BASE_PERSON }, {
      links: new ParamFieldLinks([param]),
      onParamChange: () => { changed++; },
    });

    const input = field(editor, 'k401DeferralPct');
    expect(input.value).toBe('0.12');
    // The 🔗 badge marks it as param-owned, like every other linked field.
    expect(input.closest('.node-field').querySelector('.param-link-badge')).toBeTruthy();

    input.value = '0.2';
    fire(input, 'input');
    expect(param.value).toBe(0.2);
    expect(changed).toBeGreaterThan(0);

    const data = editor._readForm(editor._rootEl);
    expect('k401DeferralPct' in data).toBe(false);
    // The other elections are unaffected and still save null.
    expect(data.k401NonElectivePct).toBeNull();
  });

  test('clearing a param-backed election writes null to the param, not 0', () => {
    const param = { name: 'person.p1.k401DeferralPct', value: 0.12,
                    node: { type: 'person', id: 'p1', field: 'k401DeferralPct' } };
    const editor = render({ ...BASE_PERSON }, { links: new ParamFieldLinks([param]) });
    const input = field(editor, 'k401DeferralPct');
    input.value = '';
    fire(input, 'input');
    expect(param.value).toBeNull();
  });
});

describe('payroll elections — kinds', () => {
  test('every scalar election is a PERCENT or a MONEY, and the lists are the two known ones', () => {
    const lists = PAYROLL_ELECTION_META.filter(m =>
      m.kind === ELECTION_KIND.TIERS || m.kind === ELECTION_KIND.SPLITS).map(m => m.field);
    expect(lists.sort()).toEqual(['k401MatchTiers', 'wageSplits']);
  });
});

/**
 * U5 — this phase changes no number.
 *
 * §17.5's golden-equivalence check, in the smallest form that actually proves it: a
 * person saved through the UI path with nothing touched must produce the SAME
 * payroll as one that never met the editor. This is P0's trick reused — the phase is
 * safe exactly when it cannot move a number — and it is the assertion that would
 * fail the moment a blank field started saving as 0, which is the one defect §17.6
 * says would otherwise be silent.
 */
describe('U5 — the editor cannot move a number', () => {
  beforeEach(() => loadHtml('../../index.html'));

  const HOUSEHOLD_US = { k401DeferralPct: 0.10, k401EmployerMatchPct: 0.04 };

  async function payrollFor(person) {
    const { computePayroll } = await import('../../../src/finance/handlers/payroll-handler.js');
    const state = {
      people:      { p1: person },
      k401Account: { balance: 0, stateKey: 'k401Account' },
      usSavingsAccount: { balance: 0, stateKey: 'usSavingsAccount', currency: { code: 'USD' } },
    };
    const stateRegistry = {
      getStateKey: (role) => (String(role).includes('401') ? 'k401Account' : 'usSavingsAccount'),
      resolveTransactionAccountKey: () => 'usSavingsAccount',
    };
    return computePayroll({
      date: new Date(Date.UTC(2030, 0, 1)), state, stateRegistry, us: HOUSEHOLD_US,
    });
  }

  test('a person saved through the editor untouched pays exactly the household default', async () => {
    const { projectPerson } = await import('../../../src/finance/state/person-projection.js');

    // The UI path: render, touch nothing, save.
    const editor = render({ ...BASE_PERSON });
    const saved  = editor._readForm(editor._rootEl);

    const { controller, created } = (() => {
      const made = [];
      const service = { createPerson: (bd, opts) => { made.push(opts); return { id: 'p1', birthDate: bd, ...opts }; } };
      return { controller: new PeopleController({ personService: service }), created: made };
    })();
    controller.create(saved);

    const viaEditor = projectPerson({
      id: 'p1', name: 'Alice', birthDate: new Date(Date.UTC(1980, 5, 1)),
      monthlyWage: 10000, wageCurrency: 'USD', retirementDate: new Date(Date.UTC(2045, 0, 1)),
      ...created[0],
    });
    // The control: a person the editor never saw, carrying no elections at all.
    const untouched = projectPerson({
      id: 'p1', name: 'Alice', birthDate: new Date(Date.UTC(1980, 5, 1)),
      monthlyWage: 10000, wageCurrency: 'USD', retirementDate: new Date(Date.UTC(2045, 0, 1)),
    });

    for (const f of PAYROLL_ELECTION_FIELDS) {
      expect(viaEditor[f]).toBe(untouched[f]);
    }

    const after  = await payrollFor(viaEditor);
    const before = await payrollFor(untouched);
    expect(after.people[0].k401).toEqual(before.people[0].k401);
    // And it is the household rate that was applied, not zero — a test that only
    // compared two silent handlers would pass on an editor that opted everyone out.
    expect(after.people[0].k401.deferral).toBeGreaterThan(0);
  });

  test('an explicit 0 DOES move the number — the opt-out is real', async () => {
    const { projectPerson } = await import('../../../src/finance/state/person-projection.js');
    const optedOut = projectPerson({
      id: 'p1', name: 'Alice', birthDate: new Date(Date.UTC(1980, 5, 1)),
      monthlyWage: 10000, wageCurrency: 'USD', retirementDate: new Date(Date.UTC(2045, 0, 1)),
      k401DeferralPct: 0,
    });
    const result = await payrollFor(optedOut);
    expect(result.people[0].k401.deferral).toBe(0);
  });
});
