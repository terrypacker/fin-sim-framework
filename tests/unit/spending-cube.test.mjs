/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * spending-cube.test.mjs — design 89 phase 2 (§7, §8, §11).
 *
 * The classification is what makes the spending chart mean anything, and it can be
 * wrong in two directions that look identical from the outside: a debit counted in the
 * wrong band, and a debit counted in none. §7(a) is the invariant that catches the
 * second, and it is worth more than any per-category assertion because it keeps
 * holding when a future design adds an action type nobody here anticipated.
 *
 *   SC7-1..4    §7(a) — classification is TOTAL over every negative balance delta,
 *               with the fractions of a split summing to one and UNCLASSIFIED drawn.
 *   CLS-1..7    the rules, as units: the two splits, the two loan legs, and the
 *               refusals (an unstamped EXPENSE_DEBIT is not quietly LIVING).
 *   CUBE-1..4   the cube on a real run: units, the loan currency fallback, coverage,
 *               and §10's 3x fan-out counted once.
 *
 * Run with: node --test tests/unit/spending-cube.test.mjs
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { ServiceRegistry } from '../../src/services/service-registry.js';
import { BaseScenario }    from '../../src/scenarios/base-scenario.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';
import { buildSpendingCube, checkClassificationTotal, spendingSummary, loanBalanceKeys }
  from '../../src/finance/spending-reporting/spending-cube.js';
import { classifyDebit, classifiedActionTypes, REPORT_CATEGORY, SPEND_TIER, CATEGORY_TIER }
  from '../../src/finance/spending-reporting/spending-classification.js';
import { SPEND_CATEGORY } from '../../src/finance/spending/spend-category.js';

const USD = { code: 'USD', symbol: '$' };

/**
 * A plan that fires every category this design can classify.
 *
 * Written out rather than taken from `scenario-harness.js`, and that is the point:
 * measured, the default International Retirement scenario has **no loan and no
 * property**, so `DEBT_PRINCIPAL`, `INTEREST`, both housing categories and
 * `ASSET_IMPROVEMENT` never fire on it. Every loan- and property-dependent assertion
 * below would have passed over an empty set — the vacuous-pass failure
 * `action-payload-schema.test.mjs` grew its own guard for.
 *
 * Deliberately in it: a mortgage that is really amortising (so the cash leg splits and
 * the loan leg fires), running costs AND a repair model with `capitalizeRepairs`, and
 * two expense events — one plain, one half-capitalized against the property.
 */
function propertyPlanConfig() {
  return {
    toolsets: ['US_RETIREMENT', 'US_REAL_PROPERTY', 'US_TAX'],
    simStart: '2026-01-01', simEnd: '2032-01-01',
    parameters: {
      monthlyExpenses: 4_000,
      spendingStrategy: ['FIXED', 'EXPENSE_EVENTS'],
      expenseEvents: [
        // Half-capitalized against the property: DISCRETIONARY and ASSET_IMPROVEMENT
        // from ONE authored event, which is the §8.1 split end to end.
        { date: '2028-06-01', amount: 30_000, category: 'reno',
          propertyKey: 'usHouseProperty', capitalize: 0.5 },
        { date: '2029-03-01', amount: 15_000, category: 'travel' },
      ],
    },
    persons: [{
      __type: 'Person', id: 'primary', name: 'P', birthDate: '1960-04-15',
      lifeExpectancy: 95, citizen: ['US'], residency: 'US', monthlyWage: 0,
      retirementDate: '2025-01-01', socialSecurityMonthly: 0,
    }],
    accounts: [{
      __type: 'SavingsAccount', id: 'us-savings', name: 'US Savings', type: 'savings',
      role: 'us-savings', stateKey: 'usSavingsAccount', initialValue: 2_000_000,
      ownershipType: 'sole', ownerId: 'primary', minimumBalance: 0, country: 'US', currency: USD,
    }],
    realProperties: [{
      __type: 'RealProperty', id: 're1', name: 'US Home', country: 'US',
      appreciationRate: 0.02, costBasis: 600_000, value: 900_000,
      mortgageBalance: 300_000, monthlyMortgage: 2_200, mortgageInterestRate: 0.055,
      isPrimaryResidence: true, ownerId: 'primary', owners: [], ownershipType: 'sole',
      plannedSaleYear: null, saleDestinationAccount: 'usSavingsAccount',
      stateKey: 'usHouseProperty', currency: USD,
      annualRunningCost: 14_000, runningCostValuePct: 0, runningCostGrowth: 0,
      repairModel: 'CONTINUOUS', repairMedian: 12_000, repairSigma: 0.4, capitalizeRepairs: 0.3,
    }],
  };
}

// Built once. `ServiceRegistry.resetAll()` is global, so the registry the cube reads
// must belong to the run it walks — sharing one loaded sim is what keeps that true.
let _run = null;
function run() {
  if (!_run) {
    const config = propertyPlanConfig();
    ServiceRegistry.resetAll();
    const services = ServiceRegistry.getInstance();
    const scenario = new BaseScenario({
      context:  services.simulationContext,
      simStart: new Date(config.simStart),
      simEnd:   new Date(config.simEnd),
    });
    scenario.buildSim();
    new ScenarioLoader().load(structuredClone(config), services);
    scenario.sim.stepTo(new Date('2031-12-31'));
    _run = { sim: scenario.sim, services };
  }
  return _run;
}

const cubeOf = (opts = {}) => {
  const { sim, services } = run();
  return buildSpendingCube({ journal: sim.journal, state: sim.state, services, currency: 'USD', ...opts });
};

/** Every negative `.balance` delta in the journal, at face value — §7(a)'s right-hand side. */
function rawDebits(journal) {
  const rows = [];
  for (const entry of journal.journal ?? []) {
    for (const d of entry.stateDiff ?? []) {
      if (!d.field?.endsWith('.balance')) continue;
      if (!((d.delta ?? 0) < 0)) continue;
      rows.push({ actionType: entry.action?.type ?? null, stateKey: d.field, amount: -d.delta });
    }
  }
  return rows;
}

describe('§7(a) — classification is total', () => {

  test('SC7-1 every category sums back to the whole debit total', () => {
    const cube  = cubeOf();
    const check = checkClassificationTotal(cube);
    assert.ok(cube.total > 0, 'the run must actually move money');
    assert.ok(check.ok,
      `Σ categories ${check.sum} ≠ Σ debits ${check.total} (drift ${check.drift})`);
  });

  test('SC7-2 the cube covers exactly the raw negative-delta universe', () => {
    // Not the scoped one. §3.1 measured that the shipped reports narrow to
    // `accountBalanceKeys()` and the loan accounts are not in it, so scoping here would
    // make SC7-1 vacuous over precisely the legs §4 is about.
    const { sim } = run();
    const raw     = rawDebits(sim.journal);
    const cube    = cubeOf();

    const rawFace  = raw.reduce((a, r) => a + r.amount, 0);
    const cubeFace = cube.rows.reduce((a, r) => a + r.amountLocal, 0);
    assert.ok(Math.abs(cubeFace - rawFace) / rawFace < 1e-9,
      `cube covers ${cubeFace} of ${rawFace} at face value`);
    assert.ok(Math.abs(cube.rawTotal - rawFace) / rawFace < 1e-9);
  });

  test('SC7-3 the shares of any single debit sum to exactly one', () => {
    // The split rules are the only way a row can lose or gain money, and both of them
    // (loan interest, capitalized expense) are fractions computed from a payload.
    for (const [actionType, data] of [
      ['LOAN_PAYMENT_APPLY', { loanKey: 'l', payment: 1000, interest: 250 }],
      ['LOAN_PAYMENT_APPLY', { loanKey: 'l', payment: 1000, interest: 0 }],
      ['LOAN_PAYMENT_APPLY', { loanKey: 'l', payment: 1000, interest: 1000 }],
      ['EXPENSE_DEBIT',      { spendCategory: SPEND_CATEGORY.HOUSING_REPAIR, capitalFraction: 0.4 }],
      ['EXPENSE_DEBIT',      { spendCategory: SPEND_CATEGORY.LIVING,         capitalFraction: 0   }],
      ['EXPENSE_DEBIT',      { spendCategory: SPEND_CATEGORY.DISCRETIONARY,  capitalFraction: 1   }],
      ['HOLDING_TRANSACT',   {}],
      ['A_TYPE_NOBODY_WROTE', {}],
    ]) {
      const shares = classifyDebit({ actionType, stateKey: 'cash.balance', data });
      const sum    = shares.reduce((a, s) => a + s.fraction, 0);
      assert.ok(Math.abs(sum - 1) < 1e-12, `${actionType} shares sum to ${sum}`);
      for (const s of shares) assert.equal(s.tier, CATEGORY_TIER[s.category], `${s.category} tier`);
    }
  });

  test('SC7-4 an unknown action type is DRAWN as UNCLASSIFIED, never dropped', () => {
    // §7(a)'s reason for existing: a new type from a future design must appear as a
    // visible band on its first run rather than vanish from a total.
    const shares = classifyDebit({ actionType: 'QUANTUM_DIVIDEND_APPLY', stateKey: 'cash.balance' });
    assert.deepEqual(shares, [{ category: REPORT_CATEGORY.UNCLASSIFIED,
                                tier: SPEND_TIER.NOT_SPENDING, fraction: 1 }]);
  });
});

describe('the classification rules', () => {

  test('CLS-1 EXPENSE_DEBIT reads the emitted category — all four of them', () => {
    const at = (spendCategory) =>
      classifyDebit({ actionType: 'EXPENSE_DEBIT', stateKey: 'cash.balance', data: { spendCategory } })[0].category;

    assert.equal(at(SPEND_CATEGORY.LIVING),          REPORT_CATEGORY.LIVING);
    assert.equal(at(SPEND_CATEGORY.HOUSING_RUNNING), REPORT_CATEGORY.HOUSING_RUNNING);
    assert.equal(at(SPEND_CATEGORY.HOUSING_REPAIR),  REPORT_CATEGORY.HOUSING_REPAIR);
    assert.equal(at(SPEND_CATEGORY.DISCRETIONARY),   REPORT_CATEGORY.DISCRETIONARY);
    for (const c of Object.values(SPEND_CATEGORY))
      assert.equal(CATEGORY_TIER[at(c)], SPEND_TIER.SPENDING, `${c} must be tier 1`);
  });

  test('CLS-2 an EXPENSE_DEBIT with no category is UNCLASSIFIED, not LIVING', () => {
    // The refusal that matters. Folding an unstamped debit into LIVING would be exactly
    // the pre-phase-1 state the field exists to end, and it would be wrong precisely for
    // whichever emitter someone forgot to stamp.
    for (const data of [undefined, {}, { spendCategory: null }, { spendCategory: 'GROCERIES' }]) {
      assert.equal(classifyDebit({ actionType: 'EXPENSE_DEBIT', stateKey: 'cash.balance', data })[0].category,
        REPORT_CATEGORY.UNCLASSIFIED, `${JSON.stringify(data)} must not be guessed`);
    }
  });

  test('CLS-3 capitalFraction moves that share out of tier 1', () => {
    const shares = classifyDebit({
      actionType: 'EXPENSE_DEBIT', stateKey: 'cash.balance',
      data: { spendCategory: SPEND_CATEGORY.HOUSING_REPAIR, capitalFraction: 0.4 },
    });
    const by = Object.fromEntries(shares.map(s => [s.category, s.fraction]));
    assert.equal(by[REPORT_CATEGORY.ASSET_IMPROVEMENT], 0.4);
    assert.ok(Math.abs(by[REPORT_CATEGORY.HOUSING_REPAIR] - 0.6) < 1e-12);
    assert.equal(CATEGORY_TIER[REPORT_CATEGORY.ASSET_IMPROVEMENT], SPEND_TIER.NOT_SPENDING,
      'a capitalized repair is wealth moved, not consumed — design 89 §8.1');
  });

  test('CLS-4 a loan payment splits INTEREST from DEBT_PRINCIPAL by RATIO', () => {
    // By ratio, not by subtracting `interest` from the delta: `payment` and `interest`
    // are in the LOAN's currency while the delta is in the cash pool's, so on a
    // cross-currency facility the subtraction is off by the exchange rate.
    const shares = classifyDebit({
      actionType: 'LOAN_PAYMENT_APPLY', stateKey: 'auOffsetAccount.balance',
      data: { loanKey: 'auLoan', payment: 4000, interest: 1000 },
    });
    const by = Object.fromEntries(shares.map(s => [s.category, s.fraction]));
    assert.equal(by[REPORT_CATEGORY.INTEREST],       0.25);
    assert.equal(by[REPORT_CATEGORY.DEBT_PRINCIPAL], 0.75);
    assert.equal(CATEGORY_TIER[REPORT_CATEGORY.INTEREST], SPEND_TIER.SPENDING,
      '§4 — the interest portion is a real cost; the principal is a transfer');
  });

  test('CLS-5 the loan ACCOUNT\'s own leg is wholly principal', () => {
    // §4's double count, made harmless: both this leg and the cash leg's principal share
    // are real negative deltas, so §7(a) needs both, and tier 2 is what keeps them out
    // of the spending total.
    const shares = classifyDebit({
      actionType: 'LOAN_PAYMENT_APPLY', stateKey: 'auLoan.balance',
      data: { loanKey: 'auLoan', payment: 4000, interest: 1000 },
    });
    assert.deepEqual(shares, [{ category: REPORT_CATEGORY.DEBT_PRINCIPAL,
                                tier: SPEND_TIER.NOT_SPENDING, fraction: 1 }]);
  });

  test('CLS-6 a sale payoff is asserted from loanKeys, not inherited from report scope', () => {
    // §3.1's trap: the shipped reports drop these keys by accident today, and registering
    // them for any unrelated reason would silently bring the double-count back. The rule
    // must stand on its own — so it is tested with the key PRESENT.
    const loanKeys = new Set(['usHousePropertyLoan.balance']);
    assert.equal(classifyDebit({ actionType: 'US_HOUSE_SALE_APPLY',
                                 stateKey: 'usHousePropertyLoan.balance', loanKeys })[0].category,
      REPORT_CATEGORY.DEBT_PRINCIPAL);
    // …and without the loan identity it degrades VISIBLY rather than into spending.
    assert.equal(classifyDebit({ actionType: 'US_HOUSE_SALE_APPLY',
                                 stateKey: 'usHousePropertyLoan.balance' })[0].category,
      REPORT_CATEGORY.UNCLASSIFIED);
  });

  test('CLS-7 loanBalanceKeys finds the liability accounts off live state', () => {
    const { sim } = run();
    const keys = loanBalanceKeys(sim.state);
    for (const k of keys) {
      assert.ok(k.endsWith('.balance'));
      assert.equal(sim.state[k.slice(0, -'.balance'.length)].type, 'loan');
    }
    // The absence case is a real one — a plan with no loan is the common shape — so the
    // helper must return an empty set rather than throw on a stateless call.
    assert.equal(loanBalanceKeys(null).size, 0);
    assert.equal(loanBalanceKeys({ a: { type: 'checking' } }).size, 0);
  });
});

describe('the cube on a real run', () => {

  test('CUBE-0 the run actually fires every category the rules can produce', () => {
    // The guard against every assertion below passing over an empty set. Measured: the
    // default harness scenario has no loan and no property, so this file used to prove
    // nothing about the split rules — which are the rules most worth proving.
    const present = new Set(cubeOf().rows.map(r => r.category));
    for (const category of [
      REPORT_CATEGORY.LIVING, REPORT_CATEGORY.HOUSING_RUNNING, REPORT_CATEGORY.HOUSING_REPAIR,
      REPORT_CATEGORY.DISCRETIONARY, REPORT_CATEGORY.TAX_US_FEDERAL, REPORT_CATEGORY.INTEREST,
      REPORT_CATEGORY.DEBT_PRINCIPAL, REPORT_CATEGORY.ASSET_IMPROVEMENT,
    ]) assert.ok(present.has(category), `${category} never fired — the fixture stopped covering it`);
  });

  test('CUBE-1 every row carries a finite magnitude and a resolved unit', () => {
    const cube = cubeOf();
    assert.ok(cube.rows.length > 0);
    for (const row of cube.rows) {
      assert.ok(Number.isFinite(row.amount), `${row.actionType} ${row.stateKey} amount`);
      assert.ok(row.amount >= 0, 'a debit share is a magnitude');
      assert.ok(Number.isFinite(row.ts) && row.year > 1900);
      assert.ok(row.currency, `${row.stateKey} was counted with no unit`);
    }
    assert.equal(cube.unconverted, 0, 'nothing fell out of the fold for want of a rate');
  });

  test('CUBE-2 a loan balance gets a unit the SCHEMA does not declare', () => {
    // Measured: `usHousePropertyLoan.balance` resolves to kind `currency` with a NULL
    // code. A converter trusting the schema alone would treat it as already-in-target,
    // which for an AUD loan understates the principal by the exchange rate. The fallback
    // is the account's own descriptor — an object, never a bare string.
    const { sim, services } = run();
    const loans = [...loanBalanceKeys(sim.state)];
    assert.ok(loans.length > 0, 'the fixture must have a loan for this to mean anything');

    let fellBack = 0;
    for (const key of loans) {
      const vt = services.schemaRegistry?.resolve?.(key);
      if (vt?.currencyCode) continue;                     // schema declared it after all
      fellBack++;
      assert.ok(sim.state[key.slice(0, -'.balance'.length)]?.currency?.code,
        `${key} has no unit from either source`);
    }
    assert.ok(fellBack > 0,
      'the schema now declares a code for every loan — this test is no longer testing the fallback');
  });

  test('CUBE-3 coverage names what the shipped reports cannot see', () => {
    // §3.1, kept live rather than quoted: the report scope is an annotation here, so the
    // day a loan account gets registered this number changes instead of the
    // classification silently changing meaning.
    const cube = cubeOf();
    assert.ok(cube.coverage.registeredKeys > 0, 'the registry must be bound');

    const debited = new Set(cube.rows.map(r => r.stateKey));
    let checked = 0;
    for (const key of loanBalanceKeys(run().sim.state)) {
      if (!debited.has(key)) continue;
      checked++;
      assert.ok(cube.coverage.outOfScope.some(o => o.stateKey === key),
        `${key} carries debits but is not reported as out of scope`);
    }
    assert.ok(checked > 0, 'no loan account carried a debit — §3.1 is untested here');
  });

  test('CUBE-3b one authored event splits 50/50 across both tiers', () => {
    // The §8.1 arithmetic end to end: the $30k event with `capitalize: 0.5` must put
    // exactly half in DISCRETIONARY and half in ASSET_IMPROVEMENT.
    //
    // Isolated by `instanceId`, not by category totals — a repair capitalizes into the
    // SAME category from the SAME action type, so summing ASSET_IMPROVEMENT across the
    // run measures the repairs too. One action's shares are the only clean unit here.
    const byInstance = new Map();
    for (const row of cubeOf().rows.filter(r => r.actionType === 'EXPENSE_DEBIT')) {
      if (!byInstance.has(row.instanceId)) byInstance.set(row.instanceId, []);
      byInstance.get(row.instanceId).push(row);
    }
    const reno = [...byInstance.values()].find(shares =>
      shares.some(s => s.category === REPORT_CATEGORY.DISCRETIONARY) &&
      shares.some(s => s.category === REPORT_CATEGORY.ASSET_IMPROVEMENT));
    assert.ok(reno, 'no single expense event split across both tiers');

    const at = (category) => reno.filter(s => s.category === category)
      .reduce((a, s) => a + s.amount, 0);
    assert.ok(Math.abs(at(REPORT_CATEGORY.DISCRETIONARY)     - 15_000) < 1, 'the consumed half');
    assert.ok(Math.abs(at(REPORT_CATEGORY.ASSET_IMPROVEMENT) - 15_000) < 1, 'the capitalized half');

    // And the plain event stays whole — a control, so a rule that split EVERY event
    // 50/50 could not pass the pair.
    const plain = [...byInstance.values()].find(shares => shares.length === 1
      && shares[0].category === REPORT_CATEGORY.DISCRETIONARY
      && Math.abs(shares[0].amount - 15_000) < 1);
    assert.ok(plain, 'the uncapitalized event did not land wholly in DISCRETIONARY');
  });

  test('CUBE-4 EXPENSE_DEBIT is counted ONCE despite the 3x journal fan-out', () => {
    // §10. The type is journaled once per consuming reducer and only the first entry
    // moves money; reading `stateDelta` makes that structural rather than a division by
    // a constant a fourth reducer would silently break.
    const { sim } = run();
    const cube    = cubeOf();

    let entries = 0, payloadSum = 0;
    for (const e of sim.journal.journal ?? []) {
      if (e.action?.type !== 'EXPENSE_DEBIT') continue;
      entries++;
      payloadSum += e.action.data?.amount ?? 0;
    }
    const cubeSum = cube.rows.filter(r => r.actionType === 'EXPENSE_DEBIT')
      .reduce((a, r) => a + r.amountLocal, 0);

    assert.ok(entries > 0, 'the run must fire expenses');
    assert.ok(payloadSum / cubeSum > 2.5,
      `payload/realized is ${payloadSum / cubeSum}; the fan-out should make it ~3x`);
  });

  test('CUBE-5 the summary states the overstatement §3 is about', () => {
    const cube    = cubeOf();
    const summary = spendingSummary(cube);
    assert.ok(summary.spending > 0 && summary.notSpending > 0,
      'a plan with no tier-2 debits would make the whole design pointless');
    assert.ok(Math.abs(summary.spending + summary.notSpending - cube.total) / cube.total < 1e-9);
    assert.ok(summary.overstatement > 0,
      'summing all debits must overstate the cost of the plan — that is §3\'s finding');
  });

  test('CUBE-6 the allowlist still covers every type this run actually fires', () => {
    // The ratchet. UNCLASSIFIED is drawn on purpose (§7 a), but a type reaching it is a
    // decision someone should make deliberately rather than discover in a chart.
    const cube    = cubeOf();
    const unknown = new Set(cube.rows.filter(r => r.category === REPORT_CATEGORY.UNCLASSIFIED)
      .map(r => r.actionType));
    assert.deepEqual([...unknown].sort(), [],
      `unclassified action types: ${[...unknown].join(', ')}\n` +
      `Add each to spending-classification.js (the allowlist is ${classifiedActionTypes().length} types), ` +
      'or record deliberately that it belongs in UNCLASSIFIED.');
  });
});
