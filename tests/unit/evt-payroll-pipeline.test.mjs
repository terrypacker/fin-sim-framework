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
 * evt-payroll-pipeline.test.mjs — design 95, phases 0-6.
 *
 * Phase 0 unified three handlers into one `PayrollHandler` that derives the whole
 * month's payroll in a single pass and emits a SLICE of it per queue position.
 * PAY-1 to PAY-3 were written then as EQUIVALENCE tests: run `MonthlyWagesHandler`,
 * `UsRetirementContributionHandler` and `AuSuperGuaranteeHandler` alongside the new
 * one and demand identical action streams.
 *
 * **Phase 6 retired those three handlers**, so there is nothing left to compare
 * against and the equivalence form died with them. What it was PROTECTING has not:
 * the emitted stream — type, amount, destination, owner, employer-funded flag, and
 * ORDER — is the pipeline's whole observable contract, and the goldens can only say
 * "the final numbers match". So the same three tests are now FROZEN STREAMS: the
 * expected shape written out in full, one readable line per action.
 *
 * A frozen stream cannot go vacuous the way an equivalence test can (two handlers
 * that both emit nothing are trivially "identical" — the reason every assertion
 * below used to carry a working-detector control). It fails on silence, on a
 * reordering, and on a dropped field, and it says which. Re-cut it ONLY alongside a
 * deliberate change, and read the diff: these are small enough to actually read,
 * which is the point of the compact form over a serialized object dump.
 *
 * Run with: node --test tests/unit/evt-payroll-pipeline.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { PayrollHandler, PAYROLL_STAGE, computePayroll }
  from '../../src/finance/handlers/payroll-handler.js';
import { ACCOUNT_ROLES } from '../../src/finance/state/account-roles.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * One action, reduced to one readable line: what it is, how much, where it lands,
 * whose it is, and whether the employer funded it. Everything design 95 can move.
 *
 * Framework bookkeeping (`layer`, `meta`, `kind`, `data`) is deliberately out: no
 * phase of this design touches it, and including it turned a reviewable four-line
 * diff into a hundred-line object dump nobody reads before re-cutting.
 */
function shapeOf(actions) {
  return actions.map(a => {
    const cls = a?.constructor?.name;
    if (cls === 'RecordBalanceAction') return `RECORD_BALANCE ${a.fieldPath}`;
    if (cls === 'FieldValueAction')    return `FIELD ${a.type} = ${a.fieldName} "${a.name}"`;
    const dest = a.targetKey ?? a.stateKey;
    const bits = [a.type, String(a.amount)];
    // Not every action has a destination: design 95 phase 7's qualifying-earnings
    // accumulator moves no money and names no account.
    if (dest != null) bits.push(`→${dest}`);
    if (a.personKey)      bits.push(`(${a.personKey})`);
    if (a.employerFunded) bits.push('employer');
    return bits.join(' ');
  });
}

/**
 * Fields that differ between two structurally identical Action instances — object
 * identity and wall-clock — and so must not take part in the comparison.
 */
const VOLATILE = new Set([
  '_instanceId', '_parentInstanceId', '_rootInstanceId', 'timestamp', 'id', 'definitionId',
]);

/** An action reduced to its meaningful shape, class name included. */
function normalize(a) {
  const out = { __class: a?.constructor?.name ?? '(plain)' };
  for (const k of Object.keys(a).sort()) {
    if (VOLATILE.has(k)) continue;
    const v = a[k];
    if (v === undefined) continue;
    out[k] = (v && typeof v === 'object') ? JSON.parse(JSON.stringify(v)) : v;
  }
  return out;
}

const streamOf = actions => actions.map(normalize);

/**
 * A StateRegistry stub. Role→key lookup is a flat table keyed `role` or
 * `role::owner`; `resolveTransactionAccountKey` returns null so resolution falls
 * through to the savings role, which is the common configuration.
 */
function registry(table, txnKey = null) {
  return {
    getStateKey: (role, owner = null) =>
      table[`${role}::${owner}`] ?? table[role] ?? null,
    resolveTransactionAccountKey: () => txnKey,
  };
}

// Keyed off the real enum rather than hand-written slugs. ACCOUNT_ROLES.ROTH is
// 'roth-ira', not 'roth' — a hardcoded table silently produced a handler that
// emitted no Roth contribution at all, which the PAY-2 control caught.
const ROLES = {
  [ACCOUNT_ROLES.US_SAVINGS]: 'usSavingsAccount',
  [ACCOUNT_ROLES.AU_SAVINGS]: 'auSavingsAccount',
  [ACCOUNT_ROLES.K401]:       'k401Account',
  [ACCOUNT_ROLES.IRA]:        'iraAccount',
  [ACCOUNT_ROLES.ROTH]:       'rothAccount',
  [ACCOUNT_ROLES.SUPER]:      'superAccount',
};

/** A household with one USD earner and one AUD earner, and every wrapper present. */
function baseState(overrides = {}) {
  return {
    people: {
      primary: { name: 'Primary', monthlyWage: 8000, wageCurrency: 'USD',
                 residency: 'US', retirementDate: new Date(Date.UTC(2040, 0, 1)) },
      spouse:  { name: 'Spouse',  monthlyWage: 5000, wageCurrency: 'AUD',
                 residency: 'AU', retirementDate: new Date(Date.UTC(2040, 0, 1)) },
    },
    usSavingsAccount: { balance: 10_000 },
    auSavingsAccount: { balance: 10_000 },
    k401Account:      { balance: 100_000, contributionBasis: 0 },
    iraAccount:       { balance: 50_000,  contributionBasis: 0 },
    rothAccount:      { balance: 25_000,  contributionBasis: 0 },
    superAccount:     { balance: 75_000,  contributionBasis: 0 },
    ...overrides,
  };
}

const DATE = new Date(Date.UTC(2028, 5, 30));

const US_ELECTION = {
  k401DeferralPct:        0.10,
  k401EmployerMatchPct:   0.03,
  k401AnnualCap:          23_500,
  iraAnnualContribution:  7_000,
  rothAnnualContribution: 7_000,
};

// ─── PAY-1: the income stage ─────────────────────────────────────────────────

test('PAY-1 stage INCOME emits the wage stream, in order', () => {
  const sr    = registry(ROLES);
  const state = baseState();

  const unified = new PayrollHandler({ stateRegistry: sr, stage: PAYROLL_STAGE.INCOME })
    .call({ date: DATE, state });

  // A USD earner and an AUD earner: two different apply types, two different
  // destination accounts, each followed by its field record, then both balances.
  assert.deepEqual(shapeOf(unified), [
    'WAGES_INCOME_APPLY 8000 →usSavingsAccount (primary)',
    'FIELD wages_primary = 8000 "Primary Wages"',
    'AU_WAGES_INCOME_APPLY 5000 →auSavingsAccount (spouse)',
    'FIELD wages_spouse = 5000 "Spouse Wages"',
    'RECORD_BALANCE usSavingsAccount.balance',
    'RECORD_BALANCE auSavingsAccount.balance',
  ]);

  // `shapeOf` reads five fields; a sixth could be dropped without it noticing, and
  // exactly that happened twice in phase 5 (`splits` and `netAmount` went undeclared
  // and were silently stripped from the journal payload). So pin the field SET too.
  const wage = unified.find(a => a.type === 'WAGES_INCOME_APPLY');
  assert.deepEqual(Object.keys(wage).sort(),
    ['amount', 'personKey', 'residency', 'targetKey', 'type', 'workCountry']);
  assert.equal(wage.residency,   'US');
  assert.equal(wage.workCountry, 'US');
});

test('PAY-1b a self-employed earner routes to the SE path, not wages', () => {
  const sr    = registry(ROLES);
  const state = baseState();
  state.people.primary.selfEmployed = true;

  const unified = new PayrollHandler({ stateRegistry: sr, stage: PAYROLL_STAGE.INCOME })
    .call({ date: DATE, state });

  // Only the primary's line changes: same money, same account, different action type
  // and a different field label. The AUD spouse is untouched.
  assert.deepEqual(shapeOf(unified), [
    'SE_INCOME_US_APPLY 8000 →usSavingsAccount (primary)',
    'FIELD wages_primary = 8000 "Primary Self-Employment"',
    'AU_WAGES_INCOME_APPLY 5000 →auSavingsAccount (spouse)',
    'FIELD wages_spouse = 5000 "Spouse Wages"',
    'RECORD_BALANCE usSavingsAccount.balance',
    'RECORD_BALANCE auSavingsAccount.balance',
  ]);
  assert.ok(!unified.some(a => a.type === 'WAGES_INCOME_APPLY'),
    'a self-employed person must not also produce a wage apply');
});

// ─── PAY-2: the contribution stage, US ────────────────────────────────────────

test('PAY-2 stage CONTRIBUTIONS emits deferral, match, IRA and Roth', () => {
  const sr    = registry(ROLES);
  const state = baseState();

  const unified = new PayrollHandler({
    stateRegistry: sr, stage: PAYROLL_STAGE.CONTRIBUTIONS, ...US_ELECTION,
  }).call({ date: DATE, state });

  // $96,000 × 10% ÷ 12 = $800 deferred; the match is "100% of the first 3%", which
  // a 10% deferral covers in full: $96,000 × 3% ÷ 12 = $240. IRA and Roth are annual
  // figures spread evenly, $7,000 ÷ 12 = $583.33 each. The employer match is FLAGGED,
  // and that flag is load-bearing — an unflagged match would be treated as the
  // member's own money.
  assert.deepEqual(shapeOf(unified), [
    'K401_CONTRIBUTION_APPLY 800 →k401Account (primary)',
    'K401_CONTRIBUTION_APPLY 240 →k401Account (primary) employer',
    'RECORD_BALANCE k401Account.balance',
    'IRA_CONTRIBUTION_APPLY 583.33 →iraAccount',
    'RECORD_BALANCE iraAccount.balance',
    'ROTH_CONTRIBUTION_APPLY 583.33 →rothAccount',
    'RECORD_BALANCE rothAccount.balance',
    // NOTHING for the AUD spouse. This handler carries US elections only, and the
    // s10A(6) qualifying-earnings accumulator belongs to whichever instance owns the
    // AU stream — see PAY-3, where an AU-configured instance does emit it.
    //
    // It used to appear here, and that was a real defect: both instances sit on the
    // PAYROLL_CONTRIBUTIONS event and both evaluate the whole pipeline, so the
    // accumulator was emitted TWICE a month in any cross-border scenario. Doubling it
    // brings the SGAA s10A(5) maximum contributions base forward to half the earner's
    // true pay and stops their Super Guarantee mid-year with a spurious clamp.
  ]);
  assert.ok(!shapeOf(unified).some(l => l.startsWith('AU_QUALIFYING_EARNINGS_APPLY')),
    'a US-only instance must stay out of the AU pipeline entirely');

  // personKey on every 401(k) line is phase 3's addition — the §402(g) accumulator is
  // per individual, so a contribution that cannot say whose it is cannot be capped.
  assert.ok(unified.filter(a => a.type === 'K401_CONTRIBUTION_APPLY')
                   .every(a => a.personKey === 'primary'));
});

test('PAY-2b the match depends on the deferral (the phase-3 change)', () => {
  const sr    = registry(ROLES);
  const state = baseState();
  // Deferring 1% into a plan matching "the first 3%" earns a 1% match, not 3%.
  state.people.primary.k401DeferralPct = 0.01;

  const unified = new PayrollHandler({
    stateRegistry: sr, stage: PAYROLL_STAGE.CONTRIBUTIONS, ...US_ELECTION,
  }).call({ date: DATE, state });

  // $96,000 × 1% ÷ 12 = $80, and the match matches it rather than paying the full
  // 3% regardless — which is what the flat-percentage model this replaced did.
  assert.deepEqual(shapeOf(unified).slice(0, 2), [
    'K401_CONTRIBUTION_APPLY 80 →k401Account (primary)',
    'K401_CONTRIBUTION_APPLY 80 →k401Account (primary) employer',
  ]);
});

// ─── PAY-3: the contribution stage, AU ────────────────────────────────────────

test('PAY-3 stage CONTRIBUTIONS emits the Super Guarantee, employer-funded', () => {
  const sr    = registry(ROLES);
  const state = baseState();

  const unified = new PayrollHandler({
    stateRegistry: sr, stage: PAYROLL_STAGE.CONTRIBUTIONS,
    superGuaranteePct: 0.12, superAnnualCap: null,
  }).call({ date: DATE, state });

  // A$5,000 × 12% = A$600. `employer` is not cosmetic: the SG sits on top of salary
  // and never reaches the member, so a member-funded SG would be taxed twice.
  assert.deepEqual(shapeOf(unified), [
    // `(spouse)` is phase 7: the SG now carries a personKey, because Div 291 rations
    // ONE cap per individual and a contribution that cannot say whose it is cannot
    // be counted against anybody's.
    'SUPER_CONTRIBUTION_APPLY 600 →superAccount (spouse) employer',
    'AU_QUALIFYING_EARNINGS_APPLY 5000 (spouse)',
    'RECORD_BALANCE superAccount.balance',
  ]);
});

// ─── PAY-4: the two countries' instances stay out of each other's way ─────────

test('PAY-4 a US-only election emits no AU stream, and vice versa', () => {
  const sr    = registry(ROLES);
  const state = baseState();

  // This is exactly how the toolsets wire it: two PayrollHandler instances on the
  // same PAYROLL_CONTRIBUTIONS event, each carrying only its own country's params.
  const usOnly = new PayrollHandler({
    stateRegistry: sr, stage: PAYROLL_STAGE.CONTRIBUTIONS, ...US_ELECTION,
  }).call({ date: DATE, state });
  const auOnly = new PayrollHandler({
    stateRegistry: sr, stage: PAYROLL_STAGE.CONTRIBUTIONS, superGuaranteePct: 0.12,
  }).call({ date: DATE, state });

  assert.ok(usOnly.length > 0 && auOnly.length > 0, 'control: both must emit something');

  assert.equal(usOnly.filter(a => a.type === 'SUPER_CONTRIBUTION_APPLY').length, 0,
    'the US instance must not emit Super — its SG rate is zero');
  assert.equal(auOnly.filter(a => a.type?.startsWith('K401')).length, 0,
    'the AU instance must not emit 401(k) — its deferral rate is zero');
  assert.equal(auOnly.filter(a => a.type === 'SUPER_CONTRIBUTION_APPLY').length, 1,
    'the AU instance emits exactly one SG contribution, for the one AUD earner');
});

// ─── PAY-5: a contribution stops with the wage that funds it ──────────────────

test('PAY-5 contributions stop at the earner\'s retirement date', () => {
  const sr     = registry(ROLES);
  const state  = baseState();
  const retire = new Date(Date.UTC(2030, 0, 1));
  state.people.primary.retirementDate = retire;
  state.people.spouse.retirementDate  = retire;

  const before = new PayrollHandler({
    stateRegistry: sr, stage: PAYROLL_STAGE.CONTRIBUTIONS, ...US_ELECTION,
  }).call({ date: new Date(Date.UTC(2029, 11, 31)), state });
  const after = new PayrollHandler({
    stateRegistry: sr, stage: PAYROLL_STAGE.CONTRIBUTIONS, ...US_ELECTION,
  }).call({ date: new Date(Date.UTC(2030, 0, 31)), state });

  assert.ok(before.length > 0, 'control: contributions flow while the wage does');
  assert.equal(after.length, 0, 'a contribution cannot outlive the salary funding it');

  // …and the wage itself stops on the same boundary, from the same date field.
  const wagesAfter = new PayrollHandler({ stateRegistry: sr, stage: PAYROLL_STAGE.INCOME })
    .call({ date: new Date(Date.UTC(2030, 0, 31)), state });
  assert.equal(wagesAfter.length, 0, 'the wage stops on the same boundary');
});

// ─── PAY-6: the suspension gate ───────────────────────────────────────────────

test('PAY-6 contributionsSuspended silences contributions but not wages', () => {
  const sr    = registry(ROLES);
  const state = baseState({ contributionsSuspended: true });

  const contrib = new PayrollHandler({
    stateRegistry: sr, stage: PAYROLL_STAGE.CONTRIBUTIONS, ...US_ELECTION,
  }).call({ date: DATE, state });
  const income = new PayrollHandler({ stateRegistry: sr, stage: PAYROLL_STAGE.INCOME })
    .call({ date: DATE, state });

  assert.equal(contrib.length, 0, 'suspension stops contributions');
  assert.ok(income.length > 0,
    'control: suspension must NOT stop the wage — the household still gets paid');
});

// ─── PAY-7: one derivation, not three ─────────────────────────────────────────

test('PAY-7 computePayroll is pure and agrees with both stages', () => {
  const sr    = registry(ROLES);
  const state = baseState();
  const args  = { date: DATE, state, stateRegistry: sr, us: US_ELECTION,
                  au: { guaranteePct: 0.12 } };

  const a = computePayroll(args);
  const b = computePayroll(args);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)),
    'two calls on the same inputs must agree — the stages call it once each, and a '
    + 'handler that memoised or mutated would desync the two queue positions');

  assert.equal(a.people.length, 2, 'control: both earners are in the pipeline');
  // The USD earner carries the US wrappers, the AUD earner carries Super. Currency
  // is the gate: deferring an AUD salary into a 401(k) would debit USD never paid.
  const [us, au] = a.people;
  assert.ok(us.k401 && !us.super, 'the USD earner defers into a 401(k), not Super');
  assert.ok(au.super && !au.k401, 'the AUD earner contributes to Super, not a 401(k)');
});

// ─── PAY-8: serialization round-trip ─────────────────────────────────────────

test('PAY-8 PayrollHandler round-trips its stage and every election', () => {
  const sr = registry(ROLES);
  const h  = new PayrollHandler({
    stateRegistry: sr, stage: PAYROLL_STAGE.CONTRIBUTIONS,
    ...US_ELECTION, superGuaranteePct: 0.12, superAnnualCap: 30_000,
  });
  const back = PayrollHandler.fromJSON(JSON.parse(JSON.stringify(h.toJSON())),
                                       { stateRegistry: sr });

  // A handler that loses its stage on reload would emit the WRONG slice at the
  // wrong queue position — silently, and only in a saved scenario. That is the
  // defect class that left the AU earnings handlers resolving by role after a
  // reload, and the one that left these two contribution handlers out of the
  // serializer's class registry entirely until design 95 phase 0.
  assert.equal(back.stage, PAYROLL_STAGE.CONTRIBUTIONS, 'stage must survive the round-trip');
  for (const [k, v] of Object.entries(US_ELECTION)) {
    assert.equal(back[k], v, `${k} must survive the round-trip`);
  }
  assert.equal(back.superGuaranteePct, 0.12);
  assert.equal(back.superAnnualCap,    30_000);

  const state = baseState();
  assert.deepEqual(
    streamOf(back.call({ date: DATE, state })),
    streamOf(h.call({ date: DATE, state })),
    'a deserialized handler emits the same stream as the one it was saved from');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Design 95 phase 1 — per-person elections
//
// Elections moved from toolset parameters (one rate for the whole household) onto
// Person. Resolution is `person.X ?? householdDefault`, and the `??` is the whole
// of the semantics: null inherits, 0 opts out. Phase 1 adds no new behaviour, so
// a household that sets nothing must be indistinguishable from before.
// ═══════════════════════════════════════════════════════════════════════════════

/** The deferral this handler emits for `personKey`, or 0 if it emits none. */
function deferralFor(actions, stateKey) {
  const a = actions.find(x => x.type === 'K401_CONTRIBUTION_APPLY'
                           && x.stateKey === stateKey && !x.employerFunded);
  return a?.amount ?? 0;
}

test('PAY-9 an absent election inherits the household default', () => {
  const sr    = registry(ROLES);
  const state = baseState();
  // primary sets nothing — every election field is null.

  const actions = new PayrollHandler({
    stateRegistry: sr, stage: PAYROLL_STAGE.CONTRIBUTIONS, ...US_ELECTION,
  }).call({ date: DATE, state });

  // 10% of $96,000 = $9,600/yr, under the $23,500 cap, so $800/mo.
  assert.equal(deferralFor(actions, 'k401Account'), 800,
    'with no personal election the household rate applies unchanged');
});

test('PAY-10 a personal election overrides the household default', () => {
  const sr    = registry(ROLES);
  const state = baseState();
  state.people.primary.k401DeferralPct = 0.20;

  const actions = new PayrollHandler({
    stateRegistry: sr, stage: PAYROLL_STAGE.CONTRIBUTIONS, ...US_ELECTION,
  }).call({ date: DATE, state });

  // 20% of $96,000 = $19,200/yr, still under the cap ⇒ $1,600/mo.
  assert.equal(deferralFor(actions, 'k401Account'), 1600,
    'the person\'s own rate wins over the household default');
});

test('PAY-11 an explicit ZERO opts out and does not inherit', () => {
  const sr    = registry(ROLES);
  const state = baseState();
  state.people.primary.k401DeferralPct = 0;

  const actions = new PayrollHandler({
    stateRegistry: sr, stage: PAYROLL_STAGE.CONTRIBUTIONS, ...US_ELECTION,
  }).call({ date: DATE, state });

  // The distinction `??` protects. With `||` this person would silently re-acquire
  // the household's 10% and contribute $800/mo — a plausible-looking number that no
  // balance assertion would flag as wrong.
  assert.equal(deferralFor(actions, 'k401Account'), 0,
    'an explicit 0 means "defer nothing", NOT "no preference"');

  // Phase 3: opting out of the deferral ALSO stops the match, because a match is a
  // function of the deferral. Under the pre-phase-3 flat model this person still
  // received 3% of pay for deferring nothing, which is not what a match is.
  assert.equal(actions.filter(a => a.type === 'K401_CONTRIBUTION_APPLY').length, 0,
    'no deferral ⇒ no match; the employer matches contributions, not employment');

  // Control: the opt-out is specific to the 401(k), not a blanket silencing — the
  // IRA election is independent and still inherits the household amount.
  assert.ok(actions.some(a => a.type === 'IRA_CONTRIBUTION_APPLY'),
    'control: the IRA election still inherits the household amount');
});

test('PAY-12 two earners can hold different elections', () => {
  const sr = registry({ ...ROLES, 'k401::spouse': 'spouseK401Account' });
  const state = baseState({ spouseK401Account: { balance: 10_000, contributionBasis: 0 } });
  // Both USD earners now, so both reach the 401(k) path.
  state.people.spouse.wageCurrency = 'USD';
  state.people.spouse.residency    = 'US';
  state.people.primary.k401DeferralPct = 0.20;
  state.people.spouse.k401DeferralPct  = 0.05;

  const actions = new PayrollHandler({
    stateRegistry: sr, stage: PAYROLL_STAGE.CONTRIBUTIONS, ...US_ELECTION,
  }).call({ date: DATE, state });

  // primary: 20% of $96,000 = $1,600/mo. spouse: 5% of $60,000 = $250/mo.
  assert.equal(deferralFor(actions, 'k401Account'),       1600);
  assert.equal(deferralFor(actions, 'spouseK401Account'),  250);

  // The thing a household scalar structurally could not express, stated directly.
  assert.notEqual(deferralFor(actions, 'k401Account'),
                  deferralFor(actions, 'spouseK401Account'),
    'two earners in one household must be able to defer at different rates');
});

test('PAY-13 an AU earner\'s SG rate is electable per person', () => {
  const sr    = registry(ROLES);
  const state = baseState();
  state.people.spouse.superGuaranteePct = 0.15;   // salary-package above the SG

  const actions = new PayrollHandler({
    stateRegistry: sr, stage: PAYROLL_STAGE.CONTRIBUTIONS, superGuaranteePct: 0.12,
  }).call({ date: DATE, state });

  const sg = actions.find(a => a.type === 'SUPER_CONTRIBUTION_APPLY');
  assert.ok(sg, 'control: an SG contribution must be emitted');
  // 15% of $60,000 = $9,000/yr ⇒ $750/mo, not the household 12% ($600).
  assert.equal(sg.amount, 750, 'the person\'s own SG rate wins');
  assert.equal(sg.employerFunded, true,
    'control: it is still employer-funded — electing a rate does not make it the member\'s money');
});

test('PAY-14 elections survive a Person round-trip through the serializer', async () => {
  const { ScenarioSerializer } = await import('../../src/scenarios/scenario-serializer.js');
  const { Person, PAYROLL_ELECTION_FIELDS } = await import('../../src/finance/person.js');

  const values = {
    k401DeferralPct: 0.2, k401EmployerMatchPct: 0.04, k401AnnualCap: 23_500,
    iraAnnualContribution: 7_000, rothAnnualContribution: 0,
    superGuaranteePct: 0.15, superAnnualCap: 30_000,
    // Design 95 §9.1 phase 6b — the three member streams. `superNonConcessionalContribution`
    // is 0 on purpose, alongside `rothAnnualContribution` below, so the null-vs-zero
    // guard covers an AU field too.
    superSalarySacrificePct: 0.05, superPersonalDeductibleContribution: 5_000,
    superNonConcessionalContribution: 0,
    // Design 95 §6 phase 2 — an array on the same round-trip list, because the
    // same four places have to carry it.
    wageSplits: [{ destinationKey: 'usSavingsAccount', mode: 'PERCENT', value: 0.6 }],
    // Design 95 §7.2 phase 3.
    k401MatchTiers: [{ matchRate: 1, uptoPctOfComp: 0.03 },
                     { matchRate: 0.5, uptoPctOfComp: 0.02 }],
    k401NonElectivePct: 0.02,
  };
  const person = new Person('p1', new Date(Date.UTC(1980, 0, 1)),
    { name: 'P', monthlyWage: 8000, ...values });

  const back = ScenarioSerializer._makePerson(
    JSON.parse(JSON.stringify(ScenarioSerializer._serializePerson(person))));

  for (const f of PAYROLL_ELECTION_FIELDS) {
    assert.deepEqual(back[f], values[f], `${f} must survive the round-trip`);
  }
  // rothAnnualContribution is 0 above ON PURPOSE: a serializer that defaults with
  // `|| null` would turn that opt-out back into "inherit", which is the same
  // null-vs-zero confusion PAY-11 guards in the resolver.
  assert.equal(back.rothAnnualContribution, 0,
    'an explicit 0 must not be serialized away into null');
  assert.equal(back.superNonConcessionalContribution, 0,
    'and the same for the AU streams — an opt-out is not an absent election');

  // Control: a person who elected nothing round-trips as nothing, not as zeros —
  // otherwise every existing saved scenario would silently opt out of everything
  // on its next load.
  const bare = ScenarioSerializer._makePerson(
    JSON.parse(JSON.stringify(ScenarioSerializer._serializePerson(
      new Person('p2', new Date(Date.UTC(1980, 0, 1)), { name: 'Q' })))));
  for (const f of PAYROLL_ELECTION_FIELDS) {
    assert.equal(bare[f], null, `${f} must round-trip as null when unset`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PAY-15: the retired handlers
//
// Phase 6 deleted `MonthlyWagesHandler`, `UsRetirementContributionHandler` and
// `AuSuperGuaranteeHandler`. Every saved scenario on disk still names the first of
// them in its persisted `handlers[]`, and every one keeps loading — because a
// scenario carrying a `toolsets` array is RECOMPILED from those toolsets and its
// persisted handler nodes are never deserialized at all.
//
// A pre-toolsets export has no such branch, and there the class really is gone.
// This pins the failure mode: it must be an error that NAMES the retirement and the
// way out, never a silent skip. Silently dropping this particular handler would
// produce a household that earns no wages and a run that merely looks pessimistic.
// ═══════════════════════════════════════════════════════════════════════════════

test('PAY-15 a retired handler type fails loudly, and says what replaced it', async () => {
  const { ScenarioSerializer } = await import('../../src/scenarios/scenario-serializer.js');

  for (const [type, replacement] of [
    ['MonthlyWagesHandler',             'stage INCOME'],
    ['UsRetirementContributionHandler', 'stage CONTRIBUTIONS'],
    ['AuSuperGuaranteeHandler',         'stage CONTRIBUTIONS'],
  ]) {
    assert.throws(
      () => ScenarioSerializer._makeHandler({ __type: type, id: 'h1' }, null),
      err => {
        assert.match(err.message, /Retired handler type/);
        assert.match(err.message, new RegExp(type));
        assert.match(err.message, new RegExp(`PayrollHandler \\(${replacement}\\)`));
        assert.match(err.message, /Rebuild/, 'and tell the reader how to recover');
        return true;
      },
      `${type} must be reported as retired, not merely unknown`);
  }

  // Control: an ordinary typo is still an ordinary "unknown type", so the retired
  // list is a genuine special case rather than a catch-all rewording.
  assert.throws(
    () => ScenarioSerializer._makeHandler({ __type: 'NoSuchHandler', id: 'h1' }, null),
    /Unknown handler type: NoSuchHandler/);
});
