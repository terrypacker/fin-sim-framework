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
 * mortality-year-of-death-tax.test.mjs
 *
 * Tests for design/68 Gap 1 — the AU per-person settle must still file a return
 * for a person who died partway through the fiscal year. Before the fix, the
 * deceased was dropped from state.people (by PersonDiedApplyReducer) before the
 * 30 Jun settle, so computeAuTaxPerPerson never visited their key: their accrued
 * final-year AU income went untaxed and was then zeroed by the settle reset.
 *
 *  YOD-1: PersonDiedApplyReducer captures name + incomeSupportRecipient in state.deceased
 *  YOD-2: computeAuTaxPerPerson files a final return for a deceased income-holder
 *  YOD-3: numResidents (shared-pool divisor) counts the deceased — survivor's split unchanged
 *  YOD-4: deceased's Age Pension CGT exemption survives via state.deceased.incomeSupportRecipient
 *
 * Gaps 2/4/5 (design/68) — completed here:
 *  YOD-5: Gap 5 — the AU settle DROPS a deceased's per-person keys (no lingering 0)
 *  YOD-6: Gap 4 — SuperDeathBenefitApplyReducer withholds 15% (via estate) + emits the tax
 *  YOD-7: Gap 4 — MortalityHandler emits SUPER_DEATH_BENEFIT_APPLY only for a last-survivor death
 *  YOD-8: Gap 2 — _flushTerminalTaxSettles fires the earliest pending settle per country, in date order
 *  YOD-9: end-to-end — a last-survivor mid-year death flushes both settles, taxes super, drops keys
 */

import { test }   from 'node:test';
import assert      from 'node:assert/strict';

import { PersonDiedApplyReducer } from '../../src/finance/reducers/person-died-apply-reducer.js';
import { SuperDeathBenefitApplyReducer } from '../../src/finance/reducers/super-death-benefit-apply-reducer.js';
import { AuTaxSettleApplyReducer } from '../../src/finance/tax/tax-settle-classes.js';
import { MortalityHandler }        from '../../src/finance/handlers/mortality-handler.js';
import { ACCOUNT_ROLES }           from '../../src/finance/state/account-roles.js';
import { Simulation }              from '../../src/simulation-framework/simulation.js';
import { TaxSettleService }        from '../../src/finance/tax-settle-service.js';
import { buildAuFiscalYear }       from '../../src/finance/period/period-builder.js';
import { loadScenarioSim }         from '../helpers/scenario-harness.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

// An AU fiscal-year period (FY2027-28: Jul 2027 – Jun 2028) to resolve the module.
const AU_PERIOD = buildAuFiscalYear(2027).periods.find(p => p.type === 'YEAR_AU');

/**
 * State as it looks at the 30 Jun settle AFTER the primary died mid-year:
 * primary is gone from state.people but their accrued per-person AU income is
 * still on the accumulator maps (the settle reset runs later, in the reducer).
 */
function postDeathSettleState(overrides = {}) {
  return {
    people: {
      spouse: { id: 'spouse', name: 'Bob', residency: 'AU', incomeSupportRecipient: false },
    },
    deceased: {
      primary: { date: new Date('2028-03-01'), taxJurisdiction: 'AU', name: 'Alice', incomeSupportRecipient: false },
    },
    currentPeriods: { AU: AU_PERIOD },
    // Both accrued AU ordinary income this fiscal year before the primary's death.
    auPersonOrdinaryIncomeYTD: { primary: 60_000, spouse: 40_000 },
    ...overrides,
  };
}

const svc = new TaxSettleService();

// ── YOD-1 ─────────────────────────────────────────────────────────────────────

test('YOD-1: PersonDiedApplyReducer captures name + incomeSupportRecipient in state.deceased', () => {
  const reducer = new PersonDiedApplyReducer();
  const state = {
    people: {
      primary: { id: 'primary', name: 'Alice', residency: 'AU', incomeSupportRecipient: true },
      spouse:  { id: 'spouse',  name: 'Bob',   residency: 'AU' },
    },
    deceased: {},
  };
  const action = {
    type: 'PERSON_DIED_APPLY', personId: 'primary',
    date: new Date('2028-03-01'), taxJurisdiction: 'AU',
    personName: 'Alice', incomeSupportRecipient: true,
  };
  const next = reducer.reduce(state, action);

  assert.strictEqual(next.deceased.primary.name, 'Alice');
  assert.strictEqual(next.deceased.primary.incomeSupportRecipient, true);
  assert.strictEqual(next.deceased.primary.taxJurisdiction, 'AU');
});

// ── YOD-2 ─────────────────────────────────────────────────────────────────────

test('YOD-2: computeAuTaxPerPerson files a final return for a deceased income-holder', () => {
  const details = svc.computeAuTaxPerPerson(postDeathSettleState());
  const keys = details.map(d => d.personKey).sort();

  assert.deepStrictEqual(keys, ['primary', 'spouse'],
    'both the surviving spouse AND the deceased primary should get a return');

  const primary = details.find(d => d.personKey === 'primary');
  assert.ok(primary, 'deceased primary should have a return');
  assert.ok(primary.taxDetail.netLiability > 0,
    'deceased primary owed AU tax on their final-year income — must not be dropped');
  assert.strictEqual(primary.personName, 'Alice',
    'deceased name should be resolved from state.deceased');
});

// ── YOD-3 ─────────────────────────────────────────────────────────────────────

test('YOD-3: numResidents counts the deceased so the survivor shared-pool split is unchanged', () => {
  // Design 76 P5 escalated an unattributed household scalar to a throw in dev/test.
  // This case deliberately exercises that legacy shared-pool split — still the
  // production fallback, and still correct in TOTAL — so it opts out of the
  // escalation rather than being rewritten to per-person maps, which would stop it
  // testing the thing it exists to test.
  const _prevStrict = process.env.AU_ATTRIBUTION_STRICT;
  process.env.AU_ATTRIBUTION_STRICT = 'off';
  try {

    // Move all AU ordinary income into the *shared* pool (no per-person entries),
    // so the only thing that varies the survivor's tax is the numResidents divisor.
    const state = postDeathSettleState({
      auPersonOrdinaryIncomeYTD: {},          // nothing per-person…
      auOrdinaryIncomeYTD: 100_000,           // …all in the shared pool
    });
    const details = svc.computeAuTaxPerPerson(state);

    // With the deceased counted (numResidents=2) the shared pool splits 50/50,
    // so the survivor is assessed on 50_000, not the full 100_000.
    const spouse = details.find(d => d.personKey === 'spouse');
    assert.ok(spouse, 'survivor should have a return');
    assert.strictEqual(details.length, 2, 'deceased must still be counted as a resident-of-the-year');
  } finally {
    if (_prevStrict === undefined) delete process.env.AU_ATTRIBUTION_STRICT;
    else process.env.AU_ATTRIBUTION_STRICT = _prevStrict;
  }
});

// ── YOD-4 ─────────────────────────────────────────────────────────────────────

test('YOD-4: deceased Age Pension CGT exemption survives via state.deceased.incomeSupportRecipient', () => {
  const state = postDeathSettleState({
    deceased: {
      primary: { date: new Date('2028-03-01'), taxJurisdiction: 'AU', name: 'Alice', incomeSupportRecipient: true },
    },
  });
  const details = svc.computeAuTaxPerPerson(state);
  const primary = details.find(d => d.personKey === 'primary');
  assert.ok(primary, 'deceased primary should have a return even when on income support');
  // The exemption plumbs through to auMinTaxExempt inside the per-person state;
  // presence of the return (not the exact figure) is what YOD-4 guards.
});

// ── YOD-5 (Gap 5) ─────────────────────────────────────────────────────────────

test('YOD-5: AU settle drops a deceased person\'s per-person keys instead of zeroing them', () => {
  const reducer = new AuTaxSettleApplyReducer();
  const state = {
    people:   { spouse:  { id: 'spouse', name: 'Bob', residency: 'AU' } },
    deceased: { primary: { date: new Date('2028-03-01'), taxJurisdiction: 'AU', name: 'Alice' } },
    currentPeriods: { AU: AU_PERIOD },
    auPersonOrdinaryIncomeYTD: { primary: 60_000, spouse: 40_000 },
    auPersonCapitalGainsYTD:   { primary: 5_000,  spouse: 0 },
  };
  // tax:0 keeps the settle a pure reset (its final return was filed earlier).
  const next = reducer.reduce(state, { type: 'AU_TAX_SETTLE_APPLY', tax: 0 });

  // The deceased key is GONE (not lingering as 0); the survivor is zeroed in place.
  assert.ok(!('primary' in next.auPersonOrdinaryIncomeYTD),
    'deceased primary must be removed from the per-person map, not left as 0');
  assert.strictEqual(next.auPersonOrdinaryIncomeYTD.spouse, 0,
    'surviving spouse key is retained and reset to 0');
  assert.ok(!('primary' in next.auPersonCapitalGainsYTD),
    'deceased key removed from every per-person map');
});

// ── YOD-6 (Gap 4 reducer) ──────────────────────────────────────────────────────

test('YOD-6: SuperDeathBenefitApplyReducer withholds 15% (via estate) and emits the tax', () => {
  const reducer = new SuperDeathBenefitApplyReducer();
  const state = { superAccount: { role: ACCOUNT_ROLES.SUPER, balance: 200_000, currency: { code: 'AUD' } } };
  const action = { type: 'SUPER_DEATH_BENEFIT_APPLY', stateKey: 'superAccount', taxable: 200_000, paidViaEstate: true };

  const next = reducer.reduce(state, action);

  // Paid via estate ⇒ no 2% Medicare ⇒ 200_000 × 0.15 = 30_000 withheld.
  assert.strictEqual(next.superAccount.balance, 170_000, 'super balance reduced by the death-benefit tax');
  const taxAction = (next.next ?? []).find(a => a.type === 'SUPER_DEATH_BENEFIT_TAX');
  assert.ok(taxAction, 'emits SUPER_DEATH_BENEFIT_TAX for the auSuperDeathTaxYTD classifier');
  assert.strictEqual(taxAction.amount, 30_000);
});

test('YOD-6b: SuperDeathBenefitApplyReducer adds 2% Medicare when NOT paid via estate', () => {
  const reducer = new SuperDeathBenefitApplyReducer();
  const state = { superAccount: { role: ACCOUNT_ROLES.SUPER, balance: 100_000 } };
  const next = reducer.reduce(state, { type: 'SUPER_DEATH_BENEFIT_APPLY', stateKey: 'superAccount', taxable: 100_000, paidViaEstate: false });
  // 100_000 × (0.15 + 0.02) = 17_000.
  assert.strictEqual(next.superAccount.balance, 83_000);
  assert.strictEqual((next.next ?? []).find(a => a.type === 'SUPER_DEATH_BENEFIT_TAX')?.amount, 17_000);
});

// ── YOD-7 (Gap 4 handler emit) ─────────────────────────────────────────────────

test('YOD-7: MortalityHandler emits SUPER_DEATH_BENEFIT_APPLY only for a last-survivor death', () => {
  const handler = new MortalityHandler();
  const baseState = {
    superAccount: { role: ACCOUNT_ROLES.SUPER, balance: 300_000, ownerId: 'primary' },
    expenses: { essential: 4_000, discretionary: 2_000 },
  };

  // Last-survivor death (no spouse) ⇒ non-dependant estate ⇒ super taxed.
  const soloActions = handler.call({
    state: { ...baseState, people: { primary: { id: 'primary', name: 'Alice', residency: 'AU' } } },
    data:  { personId: 'primary' },
    date:  new Date('2068-04-15'),
  });
  const sdb = soloActions.filter(a => a.type === 'SUPER_DEATH_BENEFIT_APPLY');
  assert.strictEqual(sdb.length, 1, 'last-survivor death taxes the estate super');
  assert.strictEqual(sdb[0].stateKey, 'superAccount');
  assert.strictEqual(sdb[0].taxable, 300_000, 'taxable defaults to the whole balance');
  assert.strictEqual(sdb[0].paidViaEstate, true);

  // Spouse survives ⇒ death-benefit dependant ⇒ tax-free retitle, no SUPER_DEATH_BENEFIT.
  const spouseActions = handler.call({
    state: {
      ...baseState,
      people: {
        primary: { id: 'primary', name: 'Alice', residency: 'AU' },
        spouse:  { id: 'spouse',  name: 'Bob',   residency: 'AU' },
      },
    },
    data: { personId: 'primary' },
    date: new Date('2068-04-15'),
  });
  assert.strictEqual(spouseActions.filter(a => a.type === 'SUPER_DEATH_BENEFIT_APPLY').length, 0,
    'a surviving spouse is a dependant — their inherited super is tax-free');
  assert.ok(spouseActions.some(a => a.type === 'ACCOUNT_RETITLE_APPLY'),
    'the spouse case retitles the super instead');
});

// ── YOD-8 (Gap 2 flush selection) ──────────────────────────────────────────────

test('YOD-8: _flushTerminalTaxSettles fires the earliest pending settle per country, in date order', () => {
  const sim = new Simulation(new Date(Date.UTC(2068, 0, 1)));
  sim.schedule({ type: 'TAX_SETTLE_US', date: new Date(Date.UTC(2068, 11, 31)) });
  sim.schedule({ type: 'TAX_SETTLE_AU', date: new Date(Date.UTC(2068, 5, 30)) });
  sim.schedule({ type: 'TAX_SETTLE_US', date: new Date(Date.UTC(2069, 11, 31)) }); // later — must NOT fire
  sim.schedule({ type: 'OTHER_EVENT',   date: new Date(Date.UTC(2068, 4, 1)) });   // not a settle

  const fired = [];
  sim.execute = (node) => fired.push(`${node.type}@${node.date.toISOString().slice(0, 10)}`);

  sim._flushTerminalTaxSettles();

  // Earliest per type: AU 2068-06-30, US 2068-12-31 — ordered by date (AU first).
  assert.deepStrictEqual(fired, ['TAX_SETTLE_AU@2068-06-30', 'TAX_SETTLE_US@2068-12-31']);

  // Only the two flushed nodes were removed; the later US settle + OTHER remain.
  const remaining = sim.queue.data.map(n => n.type).sort();
  assert.deepStrictEqual(remaining, ['OTHER_EVENT', 'TAX_SETTLE_US']);
});

// ── YOD-9 (end-to-end) ─────────────────────────────────────────────────────────

test('YOD-9: last-survivor mid-year death flushes both settles, taxes the estate super, and drops per-person keys', () => {
  // Primary born 1978-04-15, spouse 1983-09-22, US→AU move 2031. Short life
  // expectancies land both deaths AU-resident, with the spouse (last survivor)
  // dying mid AU FY2033 (2033-09-22) — before the 2034-06-30 settle.
  const { sim } = loadScenarioSim({
    params:  { primaryLifeExpectancy: 54, spouseLifeExpectancy: 50 },
    simEnd:  new Date(Date.UTC(2041, 0, 1)),
  });

  const superTotal = () => Object.values(sim.state)
    .filter(v => v && typeof v === 'object' && v.role === ACCOUNT_ROLES.SUPER)
    .reduce((s, v) => s + (v.balance ?? 0), 0);

  // Capture that the terminal flush actually runs and which settles it fires.
  const origFlush = sim._flushTerminalTaxSettles.bind(sim);
  let flushed = null;
  sim._flushTerminalTaxSettles = function () {
    const origExec = this.execute.bind(this);
    flushed = [];
    this.execute = (node, opts) => {
      if (node?.type === 'TAX_SETTLE_US' || node?.type === 'TAX_SETTLE_AU') flushed.push(node.type);
      return origExec(node, opts);
    };
    const r = origFlush();
    this.execute = origExec;
    return r;
  };

  sim.stepTo(new Date(Date.UTC(2033, 8, 21)));   // day before the spouse's death
  const superBefore = superTotal();
  assert.ok(superBefore > 0, 'estate holds super before the last-survivor death');

  sim.stepTo(new Date(Date.UTC(2041, 0, 1)));    // run to (soft) completion

  // Gap 2 — the terminal flush fired both countries' pending settles.
  assert.ok(sim.state.scenarioComplete, 'last-survivor death terminates the scenario');
  assert.deepStrictEqual([...flushed].sort(), ['TAX_SETTLE_AU', 'TAX_SETTLE_US'],
    'both the AU and US final-year settles fired before the run loop broke');

  // Gap 4 — the estate super was reduced by the 15% (via-estate) death benefit.
  const superAfter = superTotal();
  assert.ok(superAfter < superBefore * 0.86 && superAfter > superBefore * 0.84,
    `estate super dropped ~15% (before=${superBefore.toFixed(0)}, after=${superAfter.toFixed(0)})`);

  // Gap 5 — no deceased per-person keys linger after the final settle.
  assert.deepStrictEqual(Object.keys(sim.state.auPersonOrdinaryIncomeYTD ?? {}), [],
    'deceased per-person AU keys are dropped, not left as 0');
});
