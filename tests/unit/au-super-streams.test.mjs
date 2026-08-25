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
 * au-super-streams.test.mjs — design 95 §9.1, phase 6b.
 *
 * Four ways to put money into an Australian super fund, and the model has to keep
 * them apart because they differ on three INDEPENDENT axes:
 *
 *   stream            cash debit?   Div 295 15%?   deduction?
 *   Super Guarantee       no            yes            no
 *   salary sacrifice      no*           yes            n/a — never income
 *   s290-150              yes           yes            yes
 *   non-concessional      yes           NO             no
 *
 *   * sacrifice moves no cash HERE because PayrollHandler already removed it from
 *     the wage. That is the axis these tests care about most: it is the only stream
 *     whose effect spans both payroll stages, and getting it wrong in either
 *     direction pays the member twice or not at all.
 *
 * `reducer-postconditions-au.test.mjs` holds the two new reducers in isolation.
 * These hold the HANDLER — what payroll emits, and what the wage looks like
 * afterwards — plus the s26-55 clamp on the deduction, which no reducer can see.
 *
 * Run with: node --test tests/unit/au-super-streams.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { PayrollHandler, PAYROLL_STAGE, computePayroll }
  from '../../src/finance/handlers/payroll-handler.js';
import { ACCOUNT_ROLES } from '../../src/finance/state/account-roles.js';
import { AuTaxRates2026 } from '../../src/finance/tax/au/au-tax-rates-2026.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const DATE = new Date(Date.UTC(2028, 5, 30));

function registry() {
  const table = {
    [ACCOUNT_ROLES.AU_SAVINGS]: 'auSavingsAccount',
    [ACCOUNT_ROLES.SUPER]:      'superAccount',
  };
  return {
    getStateKey: (role, owner = null) => table[`${role}::${owner}`] ?? table[role] ?? null,
    resolveTransactionAccountKey: () => null,
  };
}

/** One AUD earner on A$10,000 a month, with a fund to contribute to. */
function auState(person = {}) {
  return {
    people: {
      primary: { name: 'Primary', monthlyWage: 10_000, wageCurrency: 'AUD',
                 residency: 'AU', retirementDate: new Date(Date.UTC(2040, 0, 1)),
                 ...person },
    },
    auSavingsAccount: { balance: 50_000 },
    superAccount:     { balance: 200_000, contributionBasis: 200_000, earningsBasis: 0 },
  };
}

const income  = opts => new PayrollHandler({ stateRegistry: registry(), stage: PAYROLL_STAGE.INCOME, ...opts });
const contrib = opts => new PayrollHandler({ stateRegistry: registry(), stage: PAYROLL_STAGE.CONTRIBUTIONS, ...opts });
const find    = (as, t) => as.find(a => a?.type === t);
const all     = (as, t) => as.filter(a => a?.type === t);

// ─── AUS-1: sacrifice reduces the wage, and only the wage ────────────────────

test('AUS-1 salary sacrifice reduces the wage at source, and says so on the action', () => {
  const state = auState();

  const before = income().call({ date: DATE, state });
  const after  = income({ salarySacrificePct: 0.10 }).call({ date: DATE, state });

  const w0 = find(before, 'AU_WAGES_INCOME_APPLY');
  const w1 = find(after,  'AU_WAGES_INCOME_APPLY');

  // Control first: without the election nothing is stamped at all, so the phase-5
  // action shape — and every golden built on it — is untouched.
  assert.equal(w0.amount, 10_000);
  assert.equal(w0.sacrificed, undefined, 'no election ⇒ no field, not a zero');

  // A$120,000 × 10% ÷ 12 = A$1,000.
  assert.equal(w1.amount, 9_000, 'the wage itself is reduced');
  assert.equal(w1.sacrificed, 1_000, 'and the action can explain why');
});

test('AUS-2 the reduction is to ASSESSABLE income, not just to cash', () => {
  // This is the whole difference from US withholding, which nets the CASH via
  // `netAmount` while `amount` stays gross for the tax chain. A sacrificed amount
  // was never the member's income at all, so there is no gross figure left behind:
  // AuWagesIncomeApplyReducer forwards `amount` to AU_WAGES_INCOME_TAX, and that is
  // the reduced one.
  const actions = income({ salarySacrificePct: 0.10 })
    .call({ date: DATE, state: auState() });
  const wage = find(actions, 'AU_WAGES_INCOME_APPLY');

  assert.equal(wage.amount, 9_000);
  assert.equal(wage.netAmount, undefined,
    'no separate net figure — assessable and cash are the same reduced number');
});

// ─── AUS-3: sacrifice does NOT reduce the Super Guarantee ────────────────────

test('AUS-3 SG is computed on PRE-sacrifice pay (SGAA s10A(1)(h))', () => {
  const state = auState();
  const opts  = { superGuaranteePct: 0.12 };

  const plain     = contrib(opts).call({ date: DATE, state });
  const sacrificed = contrib({ ...opts, salarySacrificePct: 0.10 }).call({ date: DATE, state });

  const sgOf = as => all(as, 'SUPER_CONTRIBUTION_APPLY')
    .find(a => a.employerFunded === true)?.amount ?? 0;

  // A$10,000 × 12% = A$1,200, both times. The anti-avoidance rule is written into
  // the DEFINITION of qualifying earnings, so a sacrificing employee does not cost
  // their employer less — and a model that computed SG on the reduced wage would
  // flatter sacrifice by 12% of every sacrificed dollar.
  assert.equal(sgOf(plain), 1_200);
  assert.equal(sgOf(sacrificed), 1_200,
    'sacrificing must not reduce the employer contribution');

  // …and the control that says the arm really did sacrifice, so the equality above
  // is not two handlers agreeing about nothing.
  assert.equal(find(sacrificed, 'SUPER_SACRIFICE_APPLY')?.amount, 1_000);
  assert.equal(find(plain, 'SUPER_SACRIFICE_APPLY'), undefined);
});

// ─── AUS-4: the four streams are four distinguishable actions ────────────────

test('AUS-4 four streams, four actions, one balance record', () => {
  const actions = contrib({
    superGuaranteePct: 0.12, salarySacrificePct: 0.05,
    personalDeductibleContribution: 6_000, nonConcessionalContribution: 12_000,
  }).call({ date: DATE, state: auState() });

  const money = actions.filter(a => a?.type?.startsWith('SUPER_'));
  assert.deepEqual(money.map(a => `${a.type} ${a.amount}`), [
    'SUPER_CONTRIBUTION_APPLY 1200',       // SG, employer
    'SUPER_SACRIFICE_APPLY 500',           // 10,000 × 5%
    'SUPER_CONTRIBUTION_APPLY 500',        // s290-150, 6,000 ÷ 12
    'SUPER_NON_CONCESSIONAL_APPLY 1000',   // 12,000 ÷ 12
  ], 'employer money first, then pre-tax, then the two paid out of the member\'s cash');

  // The two SUPER_CONTRIBUTION_APPLY rows are told apart by their flags, and must be:
  // one is the employer's and one is the member's own deduction.
  const [sg, deductible] = all(actions, 'SUPER_CONTRIBUTION_APPLY');
  assert.equal(sg.employerFunded, true);
  assert.equal(sg.deductible, undefined);
  assert.equal(deductible.deductible, true);
  assert.equal(deductible.employerFunded, undefined);
  assert.equal(deductible.personKey, 'primary', 'a deduction has to know whose it is');

  // Four streams into one fund is ONE balance record — the same rule the 401(k)
  // block follows, and the reason both build a Set of touched keys.
  assert.equal(actions.filter(a => a?.type === 'RECORD_BALANCE').length, 1);
});

// ─── AUS-5: a self-employed person cannot sacrifice ──────────────────────────

test('AUS-5 a self-employed earner sacrifices nothing, but may still deduct', () => {
  const state = auState({ selfEmployed: true });
  const opts  = { salarySacrificePct: 0.10, personalDeductibleContribution: 6_000 };

  const wages = income(opts).call({ date: DATE, state });
  const contr = contrib(opts).call({ date: DATE, state });

  // No employer, no arrangement to forgo salary under: the SE income is untouched.
  const se = find(wages, 'SE_INCOME_AU_APPLY');
  assert.equal(se.amount, 10_000, 'self-employment income is not reduced');
  assert.equal(se.sacrificed, undefined);
  assert.equal(find(contr, 'SUPER_SACRIFICE_APPLY'), undefined);

  // s290-150 is exactly the route that IS open to them, and it still is.
  assert.equal(find(contr, 'SUPER_CONTRIBUTION_APPLY')?.deductible, true);
});

// ─── AUS-6: sacrifice cannot exceed the wage ─────────────────────────────────

test('AUS-6 an over-set sacrifice rate zeroes the paycheque, never inverts it', () => {
  const actions = income({ salarySacrificePct: 2.0 })
    .call({ date: DATE, state: auState() });
  const wage = find(actions, 'AU_WAGES_INCOME_APPLY');

  assert.equal(wage.amount, 0);
  assert.equal(wage.sacrificed, 10_000, 'clamped to the wage, not to the rate');
  assert.ok(wage.amount >= 0, 'negative pay must never reach the tax chain');
});

// ─── AUS-7: the s26-55 limit on the s290-150 deduction ───────────────────────

test('AUS-7 the deduction is capped at assessable income and cannot create a loss', () => {
  const rates = new AuTaxRates2026();
  const base  = { people: { p: { residency: 'AU' } }, auOrdinaryIncomeYTD: 50_000 };

  const under = rates.computeTax({ ...base, auDeductibleSuperYTD: 20_000 });
  const over  = rates.computeTax({ ...base, auDeductibleSuperYTD: 80_000 });

  // Under the limit: the whole contribution is deductible.
  assert.equal(under.superDeductionContributed, 20_000);
  assert.equal(under.superDeductionAllowed,     20_000);
  assert.equal(under.assessableIncome,          30_000);

  // Over it: s26-55(2) caps the deduction at assessable income before tax losses.
  // Taxable income goes to zero and STOPS — the excess A$30,000 is simply not
  // deductible, and is not carried anywhere.
  assert.equal(over.superDeductionContributed, 80_000);
  assert.equal(over.superDeductionAllowed,     50_000, 'capped at assessable income');
  assert.equal(over.assessableIncome,           0);
  assert.equal(over.closingLossPool,            0, 'and creates NO tax loss');

  // Control: without the deduction there is tax to save, so the two arms above are
  // measuring a real reduction rather than two zeros.
  const none = rates.computeTax({ ...base, auDeductibleSuperYTD: 0 });
  assert.ok(none.netLiability > under.netLiability,
    'the deduction must actually reduce tax');
  assert.ok(under.netLiability > over.netLiability);
});

test('AUS-8 no deductible contribution ⇒ the return is untouched', () => {
  const rates = new AuTaxRates2026();
  const base  = { people: { p: { residency: 'AU' } }, auOrdinaryIncomeYTD: 50_000 };

  const none = rates.computeTax(base);
  assert.equal(none.superDeductionContributed, 0);
  assert.equal(none.superDeductionAllowed,     0);
  assert.equal(none.assessableIncome,          50_000);
  // The worksheet gains no line either, so an ordinary AU return reads as before.
  assert.ok(!none.lineItems.some(l => /s290-150|s26-55/.test(l.label)));
});

// ─── AUS-9: computePayroll stays pure across the two stages ─────────────────

test('AUS-9 both stages agree, and neither writes to state', () => {
  const state = auState();
  const frozen = JSON.stringify(state);
  const opts = { superGuaranteePct: 0.12, salarySacrificePct: 0.05,
                 personalDeductibleContribution: 6_000, nonConcessionalContribution: 12_000 };

  const pipeline = computePayroll({
    date: DATE, state, stateRegistry: registry(),
    au: { guaranteePct: 0.12, salarySacrificePct: 0.05,
          personalDeductibleContribution: 6_000, nonConcessionalContribution: 12_000 },
  });
  const e = pipeline.people[0];

  // The wage the income stage will credit is already net of the sacrifice, while the
  // sacrifice itself is carried for the contribution stage. One evaluation, both
  // answers — which is what lets two handler instances on two events stay consistent
  // with nothing stashed in state between them.
  assert.equal(e.wage, 9_500);
  assert.equal(e.sacrifice.amount, 500);
  assert.equal(e.super.amount, 1_200, 'and the SG still reads pre-sacrifice pay');

  assert.equal(JSON.stringify(state), frozen, 'computePayroll must not write to state');

  // The two handler instances, given the same params, must produce the same figures.
  const wages = income(opts).call({ date: DATE, state });
  assert.equal(find(wages, 'AU_WAGES_INCOME_APPLY').amount, e.wage);
});

// ─── Regressions from the design-95 close-out review ─────────────────────────
//
// Three defects that a green 5,462-test suite did not catch, all in the seam where
// TWO PayrollHandler instances sit on the PAYROLL_CONTRIBUTIONS event and each
// evaluates the whole pipeline while carrying only its own country's elections.

test('AUS-10 both stages reduce the wage and credit the fund by the SAME amount', () => {
  // The wage reduction happens at stage INCOME and the fund credit at stage
  // CONTRIBUTIONS — two separate instances. Sacrifice is rationed against the Div 291
  // cap ALONGSIDE the SG, so an income-stage instance that knew only the sacrifice
  // rate rationed it against an empty pool and arrived at a different figure: the wage
  // was reduced by one number, the fund credited with another, and the difference
  // simply vanished. Measured at A$83.33 a month on the fixture below.
  const opts = { superGuaranteePct: 0.12, salarySacrificePct: 0.10 };

  // Swept across the cap boundary, because the two agreed everywhere the cap did NOT
  // bind — a single unclamped fixture would have passed throughout.
  for (const concessionalYTD of [0, 28_000, 32_000, 40_000]) {
    const state = auState();
    state.people.primary.monthlyWage = 20_833.33;
    state.auSuperCapsByPerson = {
      primary: { concessionalYTD, sgYTD: concessionalYTD, qualifyingEarningsYTD: 0,
                 unusedByFy: {}, tsbAtFyStart: 0 },
    };

    const reduced = find(income(opts).call({ date: DATE, state }), 'AU_WAGES_INCOME_APPLY').sacrificed ?? 0;
    const credited = find(contrib(opts).call({ date: DATE, state }), 'SUPER_SACRIFICE_APPLY')?.amount ?? 0;

    assert.equal(reduced, credited,
      `at concessionalYTD ${concessionalYTD}: wage -${reduced} but fund +${credited}`);
  }
});

test('AUS-11 a US-only instance stays out of the AU pipeline entirely', () => {
  // Both toolsets register a CONTRIBUTIONS-stage handler on the same event. The
  // US-configured one reaches the AU branch for an AUD earner with every AU election
  // at zero, and must contribute nothing from it — not a stream, and not the s10A(6)
  // qualifying-earnings accumulator, which it was emitting. Doubling that accumulator
  // brings the maximum contributions base forward to half the earner's true pay.
  const state = auState();
  const usOnly = contrib({ k401DeferralPct: 0.10, k401EmployerMatchPct: 0.03 })
    .call({ date: DATE, state });
  const auOwner = contrib({ superGuaranteePct: 0.12 }).call({ date: DATE, state });

  assert.deepEqual(usOnly.filter(a => a?.type).map(a => a.type), [],
    'a US-only instance emits nothing at all for an AUD-only household');
  // Control: the AU-configured instance DOES emit it, so the assertion above is not
  // passing because the accumulator stopped working altogether.
  assert.ok(auOwner.some(a => a?.type === 'AU_QUALIFYING_EARNINGS_APPLY'));
});

test('AUS-12 a self-employed AUD earner receives no employer Super Guarantee', () => {
  // The SGAA obliges an EMPLOYER to contribute for an EMPLOYEE. `selfEmployed` means a
  // sole trader routed through the SE income path — nobody owes them an SG, and one
  // credited anyway is money from nowhere, since employer contributions debit no cash.
  const state = auState({ selfEmployed: true });
  const actions = contrib({ superGuaranteePct: 0.12 }).call({ date: DATE, state });

  assert.equal(find(actions, 'SUPER_CONTRIBUTION_APPLY'), undefined);
  // Control: the same election on an EMPLOYEE does produce one.
  assert.ok(find(contrib({ superGuaranteePct: 0.12 }).call({ date: DATE, state: auState() }),
    'SUPER_CONTRIBUTION_APPLY'));
});

test('AUS-13 an over-set sacrifice rate names the clamp instead of shrinking silently', () => {
  const actions = contrib({ salarySacrificePct: 2.0 }).call({ date: DATE, state: auState() });
  const sac = find(actions, 'SUPER_SACRIFICE_APPLY');
  assert.equal(sac.amount, 10_000, 'truncated to the month\'s pay');
  assert.ok(sac.clamps?.includes('sacrifice exceeds pay'),
    `D8 requires the journal to say why: got ${JSON.stringify(sac.clamps)}`);
});
