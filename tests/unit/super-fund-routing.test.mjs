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
 * super-fund-routing.test.mjs — design 119 phase 1: more than one super fund per person.
 *
 *   SFR-1: a contribution goes to the fund the job names
 *   SFR-2: a named fund that is not the person's own is ignored
 *   SFR-3: a person with no fund gets nothing — never the spouse's fund
 *   SFR-4: an owner-less fund is the person's only in a one-person household
 *   SFR-5: payroll routes the in-force job's SG to its fund
 *   SFR-6: the total super balance sums every fund the member owns
 *   SFR-7: the loader rejects a job naming a fund that is missing, not super, or another's
 *   SFR-8: the Jobs editor offers only the person's own funds
 *
 * Run with: node --test tests/unit/super-fund-routing.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { auSuperKeyFor, auSuperKeysOf } from '../../src/finance/account-rules/au/super-fund-key.js';
import { PayrollHandler, PAYROLL_STAGE } from '../../src/finance/handlers/payroll-handler.js';
import { buildSpells, validateJobs }    from '../../src/finance/payroll/employment.js';
import { AuTaxSettleApplyReducer }      from '../../src/finance/tax/tax-settle-classes.js';
import { superFundOptions }             from '../../src/visualization/people/jobs-section.js';
import { ACCOUNT_ROLES }                from '../../src/finance/state/account-roles.js';

const SUPER = ACCOUNT_ROLES.SUPER;

/** A registry over `accounts`, honouring the owner filter as the real one does. */
function registry(accounts) {
  return {
    getStateKey: (role, owner = null) => accounts.find(a =>
      a.role === role && (owner === null || a.ownerId === owner))?.stateKey ?? null,
    resolveTransactionAccountKey: () => null,
  };
}

const fund = (stateKey, ownerId, balance = 100_000) =>
  ({ stateKey, role: SUPER, ownerId, balance, contributionBasis: balance, earningsBasis: 0 });

function stateWith(people, funds) {
  const state = { people: Object.fromEntries(people.map(p => [p, {}])) };
  for (const f of funds) state[f.stateKey] = f;
  return state;
}

// ─── SFR-1..4: resolving the fund ────────────────────────────────────────────

test('SFR-1 a contribution goes to the fund the job names', () => {
  const funds = [fund('retailSuper', 'primary'), fund('industrySuper', 'primary')];
  const state = stateWith(['primary'], funds);
  const reg   = registry(funds);

  assert.equal(auSuperKeyFor({ state, stateRegistry: reg, personKey: 'primary',
                               preferredKey: 'industrySuper' }), 'industrySuper');
  // Control: with nothing named it is the first fund, so the case above is the job's
  // choice at work and not the registry's order.
  assert.equal(auSuperKeyFor({ state, stateRegistry: reg, personKey: 'primary' }), 'retailSuper');
});

test('SFR-2 a named fund that is not the person\'s own is ignored', () => {
  const funds = [fund('primarySuper', 'primary'), fund('spouseSuper', 'spouse')];
  const state = stateWith(['primary', 'spouse'], funds);

  assert.equal(auSuperKeyFor({ state, stateRegistry: registry(funds), personKey: 'primary',
                               preferredKey: 'spouseSuper' }), 'primarySuper');
});

test('SFR-3 a person with no fund gets nothing, never the spouse\'s fund', () => {
  // The defect phase 1 removes: `getStateKey(SUPER)` with no owner returned the
  // spouse's fund, and the fundless member's SG was paid into it.
  const funds = [fund('spouseSuper', 'spouse')];
  const state = stateWith(['primary', 'spouse'], funds);

  assert.equal(auSuperKeyFor({ state, stateRegistry: registry(funds), personKey: 'primary' }), null);
  assert.equal(auSuperKeyFor({ state, stateRegistry: registry(funds), personKey: 'spouse' }),
    'spouseSuper', 'control: the owner still resolves it');
});

test('SFR-4 an owner-less fund is the person\'s only in a one-person household', () => {
  const funds = [fund('superAccount', undefined)];
  const reg   = registry(funds);

  assert.equal(auSuperKeyFor({ state: stateWith(['primary'], funds), stateRegistry: reg,
                               personKey: 'primary' }), 'superAccount');
  assert.equal(auSuperKeyFor({ state: stateWith(['primary', 'spouse'], funds), stateRegistry: reg,
                               personKey: 'primary' }), null,
    'with two people, an owner-less fund could be either, so it is neither');
});

// ─── SFR-5: payroll ──────────────────────────────────────────────────────────

test('SFR-5 payroll pays the in-force job\'s SG into the fund that job names', () => {
  const funds = [fund('retailSuper', 'primary'), fund('industrySuper', 'primary')];
  const spells = buildSpells([
    { id: 'old', personId: 'primary', startDate: '2020-01-01', endDate: '2028-01-01',
      monthlyWage: 10_000, wageCurrency: 'AUD' },
    { id: 'new', personId: 'primary', startDate: '2028-01-01', monthlyWage: 10_000,
      wageCurrency: 'AUD', superAccountKey: 'industrySuper' },
  ], { id: 'primary', wageCurrency: 'AUD' }, new Date(Date.UTC(2026, 0, 1)));
  const state = {
    ...stateWith(['primary'], funds),
    auSavingsAccount: { balance: 50_000 },
  };
  state.people.primary = { name: 'Primary', residency: 'AU', wageCurrency: 'AUD', spells };

  const handler = new PayrollHandler({ stateRegistry: registry(funds),
    stage: PAYROLL_STAGE.CONTRIBUTIONS, superGuaranteePct: 0.12 });
  const sgTo = date => handler.call({ date, state })
    .find(a => a?.type === 'SUPER_CONTRIBUTION_APPLY' && a.employerFunded === true)?.stateKey;

  assert.equal(sgTo(new Date(Date.UTC(2027, 5, 30))), 'retailSuper',
    'the old job names no fund, so its SG goes to the first');
  assert.equal(sgTo(new Date(Date.UTC(2028, 5, 30))), 'industrySuper',
    'the new job names its fund');
  assert.ok(!('superAccountKey' in spells[0]),
    'a job naming no fund adds no field to state');
});

// ─── SFR-6: total superannuation balance ─────────────────────────────────────

test('SFR-6 the total super balance sums every fund the member owns', () => {
  const reducer = new AuTaxSettleApplyReducer({});
  const caps = () => ({ concessionalYTD: 0, nonConcessionalYTD: 0, unusedByFy: {}, tsbAtFyStart: 0 });
  const state = {
    ...stateWith(['primary', 'spouse'], [
      fund('retailSuper', 'primary', 600_000),
      fund('industrySuper', 'primary', 300_000),
      fund('spouseSuper', 'spouse', 250_000),
    ]),
    auSuperCapsByPerson: { primary: caps(), spouse: caps() },
    effectiveExchangeRates: { USD_AUD: 1 }, baseExchangeRates: { USD_AUD: 1 },
  };
  const patch = reducer._extraStatePatches(state, {
    type: 'AU_TAX_SETTLE_APPLY', tax: 0, fxRate: 1, fyStartYear: 2026,
    limitIndexFactor: 1, personTaxDetails: [{ personKey: 'primary', taxDetail: {} }],
  });

  // s307-230(1)(a): "each of … a superannuation interest of yours". Before phase 1
  // the snapshot read one fund at most, found by key convention, so a member with two
  // funds was understated by at least one of them.
  assert.equal(patch.auSuperCapsByPerson.primary.tsbAtFyStart, 900_000);
  assert.equal(patch.auSuperCapsByPerson.spouse.tsbAtFyStart, 250_000,
    'and none of it leaks into the spouse\'s');
  assert.deepEqual(auSuperKeysOf(state, 'primary'), ['retailSuper', 'industrySuper']);
});

// ─── SFR-7: loader validation ────────────────────────────────────────────────

test('SFR-7 a job must name one of its own person\'s super funds', () => {
  const persons  = [{ id: 'primary' }, { id: 'spouse' }];
  const accounts = [
    { stateKey: 'primarySuper', role: SUPER, ownerId: 'primary' },
    { stateKey: 'spouseSuper',  role: SUPER, ownerId: 'spouse' },
    { stateKey: 'auSavings',    role: ACCOUNT_ROLES.AU_SAVINGS, ownerId: 'primary' },
  ];
  const job = superAccountKey => [{ id: 'j', personId: 'primary', superAccountKey }];

  assert.deepEqual(validateJobs(job('primarySuper'), persons, accounts), []);
  assert.match(validateJobs(job('nowhere'),     persons, accounts)[0], /names no account/);
  assert.match(validateJobs(job('auSavings'),   persons, accounts)[0], /is not a super account/);
  assert.match(validateJobs(job('spouseSuper'), persons, accounts)[0], /belongs to "spouse"/);
  assert.deepEqual(validateJobs(job('spouseSuper'), persons), [],
    'without the account list (the editor\'s per-person check) the key is not judged');
});

// ─── SFR-8: the editor ───────────────────────────────────────────────────────

test('SFR-8 the Jobs editor offers only the person\'s own super funds', () => {
  const accounts = [
    { stateKey: 'primarySuper', role: SUPER, ownerId: 'primary', name: 'Retail' },
    { stateKey: 'spouseSuper',  role: SUPER, ownerId: 'spouse',  name: 'Spouse fund' },
    { stateKey: 'auSavings',    role: ACCOUNT_ROLES.AU_SAVINGS, ownerId: 'primary' },
  ];
  assert.deepEqual(superFundOptions(accounts, 'primary'),
    [['', 'First fund'], ['primarySuper', 'Retail']]);
});
