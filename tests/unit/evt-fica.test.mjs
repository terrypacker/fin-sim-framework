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
 * evt-fica.test.mjs — design 95 §8.1, phase 4. Employee FICA (IRC §3101).
 *
 * Before this phase the model charged SECA, the 0.9% Additional Medicare surtax and
 * NIIT — but no employee FICA at all. A W-2 earner paid income tax and nothing else,
 * so every US working-year projection this model ever produced overstated take-home
 * by up to 7.65% of pay.
 *
 * FICA-4 is the most important test in the file, and in the phase. §3121(a) defines
 * wages for Chapter 21 WITHOUT the §402(g) exclusion, so an elective 401(k) deferral
 * reduces income tax and does NOT reduce the FICA base. Australia has the mirror-image
 * rule pointing the other way (salary sacrifice reduces PAYG but not the Super
 * Guarantee), so a single "taxable pay" figure feeding everything downstream is wrong
 * in four distinct ways — and is the obvious thing to build.
 *
 * Run with: node --test tests/unit/evt-fica.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { UsTaxRates2026 } from '../../src/finance/tax/us/us-tax-rates-2026.js';

const rates = new UsTaxRates2026();
const BASE  = rates._ficaWageBase;          // §3121(a)(1), \$184,500 for 2026
const OASDI = rates._ficaSsRate;            // §3101(a)   6.2%
const HI    = rates._ficaMedicareRate;      // §3101(b)(1) 1.45%

/** A state with only the fields FICA reads; everything else zeroed. */
function usState(over = {}) {
  return {
    usOrdinaryIncomeYTD: 0, usNegativeIncomeYTD: 0, usCapitalGainsYTD: 0,
    usCollectibleGainsYTD: 0, usNetInvestmentIncomeYTD: 0, usPenaltyYTD: 0,
    usShortTermCapitalGainsYTD: 0, usSeEarningsYTD: 0, usSsWagesYTD: 0,
    usFilingSingle: true, ...over,
  };
}

/** The FICA component of a computed liability. */
function fica(over) {
  const r = rates.computeTax(usState(over));
  return { total: r.ficaTax, oasdi: r.ficaSsTax, medicare: r.ficaMedicareTax, all: r };
}

const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps;

// ─── The tax exists ───────────────────────────────────────────────────────────

test('FICA-1 wages under the base are charged 6.2% + 1.45%', () => {
  const wages = 100_000;
  const f = fica({ usOrdinaryIncomeYTD: wages, usSsWagesYTD: wages });

  assert.ok(near(f.oasdi,    wages * OASDI), `OASDI ${f.oasdi}`);
  assert.ok(near(f.medicare, wages * HI),    `HI ${f.medicare}`);
  assert.ok(near(f.total,    wages * 0.0765),
    'the combined employee rate below the base is 7.65%');

  // Control: with no wages there is no FICA, so the assertions above are about
  // wages rather than about a constant the module always returns.
  assert.equal(fica({ usOrdinaryIncomeYTD: wages }).total, 0,
    'control: ordinary income that is not WAGES attracts no FICA');
});

test('FICA-2 OASDI stops at the §3121(a)(1) base; Medicare does not', () => {
  const wages = BASE * 3;
  const f = fica({ usOrdinaryIncomeYTD: wages, usSsWagesYTD: wages });

  assert.ok(near(f.oasdi, BASE * OASDI), 'OASDI is capped at the contribution and benefit base');
  assert.ok(near(f.medicare, wages * HI), 'Medicare is uncapped');

  // The property, stated as a comparison rather than as a single figure: doubling
  // pay above the base doubles Medicare and leaves OASDI exactly where it was.
  const dbl = fica({ usOrdinaryIncomeYTD: wages * 2, usSsWagesYTD: wages * 2 });
  assert.ok(near(dbl.oasdi, f.oasdi),        'OASDI does not move above the base');
  assert.ok(near(dbl.medicare, f.medicare * 2), 'Medicare scales with every dollar');
});

// ─── The base is PER PERSON ───────────────────────────────────────────────────

test('FICA-3 each earner gets their OWN wage base', () => {
  // §3121(a)(1) applies the base to each employee separately. Pooling two earners
  // against one base under-charges every two-earner household from the moment their
  // combined pay passes it — which for a real couple is most of their career.
  const each  = 165_000;                    // under the base individually…
  const total = each * 2;                   // …but well over it together
  const perPerson = fica({
    usOrdinaryIncomeYTD: total, usSsWagesYTD: total,
    usSsWagesByPersonYTD: { primary: each, spouse: each },
  });

  assert.ok(near(perPerson.oasdi, total * OASDI),
    'both earners are under the base, so ALL their wages are OASDI-covered');

  // The household-pooled answer, which is what the accumulator alone would give.
  const pooled = fica({ usOrdinaryIncomeYTD: total, usSsWagesYTD: total });
  assert.ok(near(pooled.oasdi, BASE * OASDI));
  assert.ok(perPerson.oasdi > pooled.oasdi * 1.5,
    `pooling under-charges badly: ${pooled.oasdi.toFixed(0)} vs ${perPerson.oasdi.toFixed(0)}`);

  // …and a single earner over the base is still capped, per person.
  const one = fica({ usOrdinaryIncomeYTD: total, usSsWagesYTD: total,
                     usSsWagesByPersonYTD: { primary: total } });
  assert.ok(near(one.oasdi, BASE * OASDI), 'one earner, one base');
});

test('FICA-3b an absent per-person map falls back to the household total', () => {
  // Every action saved before phase 4 replays without a personKey, so the map is
  // empty. The fallback is the single-earner answer, which is also the pre-phase-4
  // behaviour — a missing map must not mean "no OASDI".
  const wages = 100_000;
  const a = fica({ usOrdinaryIncomeYTD: wages, usSsWagesYTD: wages });
  const b = fica({ usOrdinaryIncomeYTD: wages, usSsWagesYTD: wages, usSsWagesByPersonYTD: {} });
  assert.ok(near(a.oasdi, wages * OASDI));
  assert.ok(near(b.oasdi, wages * OASDI), 'an empty map falls back rather than zeroing');
});

// ─── The asymmetry (design 95 §5.1) ───────────────────────────────────────────

test('FICA-4 a 401(k) deferral reduces income tax but NOT the FICA base', () => {
  const wages   = 150_000;
  const deferral = 20_000;

  // The wage classifier feeds `usSsWagesYTD` the GROSS wage; the deferral is booked
  // ONLY as negative ordinary income. So this is the state the reducers produce.
  const noDefer  = fica({ usOrdinaryIncomeYTD: wages, usSsWagesYTD: wages,
                          usSsWagesByPersonYTD: { primary: wages } });
  const deferred = fica({ usOrdinaryIncomeYTD: wages, usNegativeIncomeYTD: deferral,
                          usSsWagesYTD: wages, usSsWagesByPersonYTD: { primary: wages } });

  // Control FIRST: the deferral must actually reduce SOMETHING, or the equality
  // below is a statement about an inert input.
  assert.ok(deferred.all.ordinaryTax < noDefer.all.ordinaryTax,
    'control: the deferral does reduce income tax');

  assert.ok(near(deferred.total, noDefer.total),
    'but FICA is identical — §3121(a) has no §402(g) exclusion, so the deferral is '
    + 'wages for Chapter 21 even though it is excluded from gross income');

  // Stated as the money: deferring $20,000 saves income tax and saves NO FICA.
  const ficaSaved = noDefer.total - deferred.total;
  assert.ok(near(ficaSaved, 0),
    `deferring should save \$0 of FICA, saved \$${ficaSaved.toFixed(2)} — if this is `
    + `non-zero the model is letting a deferral shrink the Chapter 21 base`);
});

// ─── No double counting ───────────────────────────────────────────────────────

test('FICA-5 the 0.9% surtax is charged ON TOP of the 1.45%, not instead', () => {
  const wages = 400_000;                    // over the $200,000 single threshold
  const f = fica({ usOrdinaryIncomeYTD: wages, usSsWagesYTD: wages,
                   usSsWagesByPersonYTD: { primary: wages } });

  assert.ok(near(f.medicare, wages * HI), 'the FICA HI component stays at 1.45%');
  assert.ok(near(f.all.additionalMedicareTax,
                 (wages - rates._addlMedicareThresholdSingle) * rates._addlMedicareRate),
    'and the surtax is computed separately on the excess');

  // The failure mode this guards is folding 0.9% into the FICA rate, which would
  // charge it on the WHOLE wage instead of on the excess over the threshold.
  const wrong = wages * (HI + rates._addlMedicareRate);
  assert.ok(f.medicare + f.all.additionalMedicareTax < wrong,
    'total Medicare must be less than 2.35% of every dollar');
});

test('FICA-6 self-employment income attracts SECA, not FICA', () => {
  const se = 100_000;
  const f  = fica({ usOrdinaryIncomeYTD: se, usSeEarningsYTD: se });

  assert.equal(f.total, 0, 'SE earnings are not §3121 wages — no employee FICA');
  assert.ok(f.all.selfEmploymentTax > 0, 'control: SECA is charged instead');
});

test('FICA-7 wages fill the OASDI base ahead of SE earnings (SECA coordination)', () => {
  // Pre-existing design 69 behaviour, re-checked because phase 4 now reads the same
  // accumulator: a person with both W-2 and SE income pays SECA's OASDI half only on
  // whatever base their wages left unused.
  const wages = BASE;                       // fills the base exactly
  const f = fica({ usOrdinaryIncomeYTD: wages + 50_000, usSsWagesYTD: wages,
                   usSsWagesByPersonYTD: { primary: wages }, usSeEarningsYTD: 50_000 });

  assert.ok(near(f.oasdi, BASE * OASDI), 'the employee pays OASDI up to the base');
  // SECA's SS portion has no base left, so only its Medicare half remains.
  const seNet = 50_000 * rates._seNetFactor;
  assert.ok(near(f.all.selfEmploymentTax, seNet * rates._seMedicareRate),
    'SECA charges no second OASDI on a base the wages already filled');
});

// ─── It reaches the liability ─────────────────────────────────────────────────

test('FICA-8 FICA is added to the liability and is not creditable by the FTC', () => {
  const wages = 120_000;
  const f = fica({ usOrdinaryIncomeYTD: wages, usSsWagesYTD: wages,
                   usSsWagesByPersonYTD: { primary: wages } });

  assert.ok(f.all.grossTax > f.all.regularTax, 'FICA raises gross tax above the regular tax');
  assert.ok(f.all.netLiability > 0);
  assert.ok(near(f.all.grossTax - f.all.regularTax, f.total),
    'and the whole of the difference is FICA (nothing else is charged in this state)');

  // A Chapter 21 tax sits outside the §904 limitation base, exactly as SECA and the
  // surtax already do — it is added on top of net liability, never netted against a
  // foreign tax credit.
  const labels = (f.all.lineItems ?? []).map(r => r.label);
  assert.ok(labels.some(l => /FICA .* Social Security/.test(l)),
    'the return shows FICA as its own line, not buried in income tax');
  assert.ok(labels.some(l => /FICA .* Medicare/.test(l)));
});

// ═══════════════════════════════════════════════════════════════════════════════
// Design 95 §8.2, phase 5 — withholding and the true-up
//
// FICA is withheld from each paycheque and credited against the annual liability.
// The one thing that must be true is that the household pays it ONCE: withholding
// monthly and then charging the full liability at the settle would double it, and
// the symptom — roughly 7.65% of wages of extra lifetime tax — looks exactly like
// "FICA is working" unless you compare against an arm that does not withhold.
// ═══════════════════════════════════════════════════════════════════════════════

import { ServiceRegistry } from '../../src/services/service-registry.js';
import { BaseScenario }    from '../../src/scenarios/base-scenario.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';
import { ficaOnWage, ficaWageBase, FICA_SS_RATE, FICA_MEDICARE_RATE }
  from '../../src/finance/tax/us/fica-rates.js';

const USD2 = { code: 'USD', symbol: '$' };

function scenario(withholdingMethod) {
  return {
    toolsets: ['US_RETIREMENT', 'US_TAX', 'US_BANKING'],
    simStart: '2026-01-01', simEnd: '2030-01-01',
    parameters: {
      monthlyExpenses: 0, inflationAdjust: false, usSavingsInterestRate: 0,
      withholdingMethod,
    },
    persons: [{ __type: 'Person', id: 'primary', name: 'A', birthDate: '1981-04-15',
                citizen: ['US'], monthlyWage: 10_000, retirementDate: '2040-01-01',
                socialSecurityMonthly: 0 }],
    accounts: [{ __type: 'SavingsAccount', id: 'a', name: 'S', type: 'savings',
                 role: 'us-savings', stateKey: 'usSavingsAccount', initialValue: 500_000,
                 ownershipType: 'sole', ownerId: 'primary', country: 'US', currency: USD2 }],
  };
}

function runTo(cfg, to) {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  const sc = new BaseScenario({ context: services.simulationContext,
    simStart: new Date(cfg.simStart), simEnd: new Date(cfg.simEnd) });
  sc.buildSim({ telemetry: 'journal' });
  new ScenarioLoader().load(structuredClone(cfg), services);
  const { log, warn } = console; console.log = () => {}; console.warn = () => {};
  try { sc.sim.stepTo(to); } finally { console.log = log; console.warn = warn; }
  return sc.sim;
}

test('FICA-9 withholding does not change the tax owed, only when it is paid', () => {
  const END = new Date(Date.UTC(2029, 11, 31));
  const withheld = runTo(scenario('FICA_ONLY'), END);
  const gross    = runTo(scenario('NONE'),      END);

  // Control: the two arms really are different runs — one withholds, one does not.
  const wh = withheld.journal.journal.filter(e => e.action?.type === 'WAGES_WITHHELD_APPLY');
  assert.ok(wh.length > 0, 'control: the FICA_ONLY arm withholds every month');
  assert.equal(
    gross.journal.journal.filter(e => e.action?.type === 'WAGES_WITHHELD_APPLY').length, 0,
    'control: the NONE arm withholds nothing');

  // Interest is pinned to 0 in this scenario, so the ONLY thing withholding can
  // change is the timing of the cash — and by the end of a settled year, nothing.
  const a = withheld.state.cumulativeTaxesPaid, b = gross.state.cumulativeTaxesPaid;
  assert.ok(Math.abs(a - b) < 1,
    `lifetime tax must be identical either way; withheld ${a.toFixed(2)} vs gross ${b.toFixed(2)}`);
  assert.ok(Math.abs(withheld.state.usSavingsAccount.balance
                     - gross.state.usSavingsAccount.balance) < 1,
    'and so must the cash, once the year has settled');

  // The failure this guards: withholding AND charging the full liability would add
  // roughly 7.65% of wages to lifetime tax — which looks like FICA working.
  const wages = 10_000 * 12 * 4;
  assert.ok(a < b + wages * 0.05,
    'a double charge would show up as several percent of wages of extra tax');
});

test('FICA-10 the withheld amount is exactly the FICA on that month\'s wage', () => {
  const sim = runTo(scenario('FICA_ONLY'), new Date(Date.UTC(2026, 2, 15)));
  const rows = sim.journal.journal
    .filter(e => e.action?.type === 'WAGES_WITHHELD_APPLY')
    .map(e => e.action.data);

  assert.ok(rows.length >= 2, 'control: at least two months have been paid');
  const expected = ficaOnWage(10_000, 0, 2026).total;
  assert.ok(Math.abs(rows[0].amount - expected) < 0.01,
    `month 1 withholding ${rows[0].amount} should be ${expected}`);
  assert.equal(rows[0].alreadyNetted, true,
    'the flag that stops the reducer debiting cash that was never credited');
});

test('FICA-11 monthly withholding foots EXACTLY to the annual charge', () => {
  // A high earner whose OASDI stops mid-year. A withholding that kept going would
  // over-withhold, and phase 5 has no refund path — so this must foot to the cent.
  const base = ficaWageBase(2026);
  const wage = base;                    // one month's wage IS the whole base
  let ytd = 0, total = 0;
  for (let m = 0; m < 12; m++) {
    const f = ficaOnWage(wage, ytd, 2026);
    ytd += wage; total += f.total;
  }
  const annual = base * FICA_SS_RATE + (wage * 12) * FICA_MEDICARE_RATE;
  assert.ok(Math.abs(total - annual) < 0.05,
    `withheld ${total.toFixed(2)} vs charged ${annual.toFixed(2)} — a gap here becomes a `
    + `balance due or an unrefundable over-withholding`);

  // Control: OASDI really did stop, so the equality is about the cap and not about
  // a scenario where the cap never binds.
  assert.equal(ficaOnWage(wage, base, 2026).ss, 0, 'control: OASDI stops at the base');
  assert.ok(ficaOnWage(wage, base, 2026).medicare > 0, 'control: Medicare does not');
});

test('FICA-12 usWithheldYTD is credited and then reset', () => {
  // Before phase 5 this field was written by the wages reducer and read by NOTHING,
  // and was not even in the settle's reset list — it accumulated for the life of the
  // run. Both halves of that are now wired.
  const mid = runTo(scenario('FICA_ONLY'), new Date(Date.UTC(2026, 5, 30)));
  assert.ok(mid.state.usWithheldYTD > 0, 'it accumulates during the year');

  const after = runTo(scenario('FICA_ONLY'), new Date(Date.UTC(2027, 0, 31)));
  assert.ok(after.state.usWithheldYTD < mid.state.usWithheldYTD,
    'and the settle resets it — otherwise it would grow monotonically forever');
});
