/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * shock-library-tags-and-sleeves.test.mjs — two holes in the preset library that made
 * configured features silently do nothing (design 21 / design 29 §4.1).
 *
 * 1. **No preset carried tags.** Six behavioral strategies gate on `regime.tags`
 *    (`PANIC_SELL`, `CASH_BUCKET_DRAWDOWN`, `DOWNTURN_ROTH_CONVERSION`,
 *    `CONTRIBUTION_SUSPENSION`, `OPPORTUNISTIC_REBALANCE`, and the crash-entry path of
 *    `TARGET_ALLOCATION`). With every preset untagged, all six were configurable and inert:
 *    a user could turn PanicSell on, run a GFC, and watch nothing happen.
 * 2. **Sleeve coverage was partial.** `effectiveDividendAdjustments` is keyed by the
 *    HOLDING's rate key, so a sleeve a preset does not name keeps paying its full yield
 *    straight through the crash. Naming only EQUITY_US/EQUITY_AU was a hole, not a claim.
 *
 * SHOCKTAG-1: every tagged preset tags exactly ONE leg, with values from REGIME_TAG
 * SHOCKTAG-2: tags are LEG-scoped — the GFC's 84-month rates leg does NOT inherit them
 * SHOCKTAG-3: the stress window is the tagged leg's own, and it is the SHORTEST leg
 * SHOCKTAG-4: end-to-end — a preset shock puts a TAGGED regime on the live stack, and
 *             PanicSellReducer fires off it (the wiring that used to be dead)
 * SHOCKTAG-5: the stress window EXPIRES on its own clock while the price legs live on
 * SHOCKTAG-6: a preset that cuts dividends on one equity sleeve cuts them on all four
 * SHOCKTAG-7: a preset that shocks EQUITY_US also shocks EQUITY_INTL_EX_AU (~70 % US)
 * SHOCKTAG-8: the non-equity presets stay untagged, only the SHARP falls carry
 *             PANIC_SELL_TRIGGER, and the control arm is held back by its SEVERITY
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ServiceRegistry }      from '../../src/services/service-registry.js';
import { ScenarioLoader }       from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }         from '../../src/index.js';
import { SHOCK_LIBRARY }        from '../../src/finance/economic-shocks/shock-library.js';
import { EconomicShockHandler } from '../../src/finance/economic-regimes/economic-shock-handler.js';
import { REGIME_TAG }           from '../../src/finance/economic-regimes/regime-tag.js';
import { PanicSellReducer }     from '../../src/finance/behavioral/panic-sell-reducer.js';
import { ACCOUNT_ROLES }        from '../../src/finance/state/account-roles.js';

beforeEach(() => ServiceRegistry.resetAll());

const EQUITY_SLEEVES = ['EQUITY_US', 'EQUITY_AU', 'EQUITY_INTL_EX_US', 'EQUITY_INTL_EX_AU'];

/** Every leg of a shock, in the same shape the handler reads (a leg-less shock is one leg). */
const legsOf = (s) => (Array.isArray(s.legs) && s.legs.length)
  ? s.legs
  : [{ id: null, tags: s.tags, regime: s.regime, recovery: s.recovery }];

const taggedLegs   = (s) => legsOf(s).filter(l => (l.tags ?? []).length > 0);
const isEquityShock = (s) => legsOf(s).some(l =>
  Object.keys(l.regime?.returnAdjustment ?? {}).some(k => EQUITY_SLEEVES.includes(k)));

// ─── the library's own shape ─────────────────────────────────────────────────

test('SHOCKTAG-1: every tagged preset tags exactly one leg, with values from REGIME_TAG', () => {
  const known = new Set(Object.values(REGIME_TAG));
  let tagged = 0;

  for (const [id, shock] of Object.entries(SHOCK_LIBRARY)) {
    const legs = taggedLegs(shock);
    if (legs.length === 0) continue;
    tagged++;
    assert.equal(legs.length, 1,
      `${id} tags ${legs.length} legs — a tag names ONE window, so two tagged legs is two `
      + 'overlapping stress windows for one episode');
    for (const t of legs[0].tags) {
      assert.ok(known.has(t), `${id} carries unknown tag ${t}; add it to REGIME_TAG first`);
    }
    assert.ok(legs[0].recovery?.durationMonths > 0,
      `${id}'s tagged leg must state its own window — that window IS the stress period`);
  }

  // The regression this file exists for: an empty answer here is the bug.
  assert.ok(tagged >= 5, `expected the crash presets to be tagged, only ${tagged} are`);
});

test('SHOCKTAG-2: tags are LEG-scoped — the GFC rates leg does not inherit them', () => {
  const handler = new EconomicShockHandler({ rateKeyToStateKeys: {}, allAccountStateKeys: [] });
  const shock   = { ...SHOCK_LIBRARY.MARKET_CRASH_2008_LITE, startDate: new Date('2030-01-01') };
  const regimes = handler.call({ data: { shock } })
    .filter(a => a.type === 'ADD_REGIME_APPLY').map(a => a.regime);

  const byId = Object.fromEntries(regimes.map(r => [r.id, r]));
  assert.deepEqual(byId['regime-MARKET_CRASH_2008_LITE-stress'].tags,
    [REGIME_TAG.ECONOMIC_STRESS, REGIME_TAG.PANIC_SELL_TRIGGER]);

  // The reason the handler reads tags per leg at all. Stamped shock-wide, the 84-month
  // easing leg would keep ContributionSuspension on for years past the crash.
  for (const legId of ['equity', 'markets', 'rates']) {
    assert.deepEqual(byId[`regime-MARKET_CRASH_2008_LITE-${legId}`].tags, [],
      `the ${legId} leg must not carry the stress tag`);
  }
});

test('SHOCKTAG-3: the stress window is its own, and shorter than the price legs it sits beside', () => {
  const gfc     = SHOCK_LIBRARY.MARKET_CRASH_2008_LITE;
  const months  = (id) => gfc.legs.find(l => l.id === id).recovery.durationMonths;

  assert.equal(months('stress'), 17, 'the measured S&P/OECD peak→trough (MEASUREMENTS §1)');
  assert.ok(months('stress') < months('equity'), 'shorter than the 72-month price path');
  assert.ok(months('stress') < months('rates'),  'and far shorter than the 84-month easing');

  // A tag-only leg carries no rates of its own — it must not move the economy.
  const stress = gfc.legs.find(l => l.id === 'stress');
  assert.equal(stress.regime, undefined,
    'the stress leg states a WINDOW, not an adjustment; giving it rates would double-count');
});

// ─── end to end: the wiring that used to be dead ─────────────────────────────

const SIM_START = new Date('2026-01-01');

const BASE_CFG = {
  toolsets:   ['US_BANKING', 'US_TAX', 'US_RETIREMENT', 'ECONOMIC_REGIMES'],
  simStart:   '2026-01-01',
  simEnd:     '2032-01-01',
  parameters: {
    monthlyExpenses: 0, inflationAdjust: false, inflationRate: 0,
    rothGrowthRate: 0, iraGrowthRate: 0, k401GrowthRate: 0,
    brokerageGrowthRate: 0, brokerageDividendRate: 0,
    fixedIncomeInterestRate: 0, usSavingsInterestRate: 0,
  },
  persons: [{
    __type: 'Person', id: 'primary', name: 'Primary',
    birthDate: '1975-04-15', citizen: ['US'], lifeExpectancy: 90,
    monthlyWage: 0, retirementDate: '2025-01-01', socialSecurityMonthly: 0,
  }],
  accounts: [
    {
      __type: 'SavingsAccount', id: 'checking', name: 'Checking',
      role: 'us-savings', stateKey: 'checkingAccount',
      initialValue: 50000, ownershipType: 'sole', ownerId: 'primary',
      minimumBalance: 0, country: 'US', currency: { code: 'USD', symbol: '$' },
    },
    {
      __type: 'RothAccount', stateKey: 'rothAccount', role: 'roth-ira',
      name: 'Roth IRA', initialValue: 100000,
      contributionBasis: 0, ownerId: 'primary',
      drawdownPriority: 5, country: 'US', currency: { code: 'USD', symbol: '$' },
    },
  ],
};

function loadScenario(extraParams = {}, simEnd = '2032-01-01') {
  const cfg = structuredClone(BASE_CFG);
  cfg.parameters = { ...BASE_CFG.parameters, ...extraParams };
  cfg.simEnd = simEnd;
  const services = ServiceRegistry.getInstance();
  const scenario = new BaseScenario({
    context: services.simulationContext, simStart: SIM_START, simEnd: new Date(simEnd),
  });
  scenario.buildSim();
  new ScenarioLoader().load(cfg, services);
  return scenario.sim;
}

test('SHOCKTAG-4: a preset shock puts a TAGGED regime on the live stack, and PanicSell fires off it', () => {
  const sim = loadScenario({ shocks: [{ preset: 'MARKET_CRASH_2008_LITE', startDate: '2027-03-01' }] });
  sim.stepTo(new Date('2027-06-01'));

  const tagged = (sim.state.activeRegimes ?? []).filter(r => (r.tags ?? []).length > 0);
  assert.equal(tagged.length, 1, 'exactly one tagged regime is live during the crash');
  assert.ok(tagged[0].tags.includes(REGIME_TAG.PANIC_SELL_TRIGGER));

  // The strategy is not enabled in this scenario, so drive it directly against the live
  // stack: what is being proved is that a LIBRARY preset now satisfies its trigger, which
  // is exactly what no preset did before.
  const reducer = new PanicSellReducer({
    allAccounts: [{ stateKey: 'rothAccount', role: ACCOUNT_ROLES.ROTH }],
  });
  const fired = reducer.reduce(sim.state, { type: 'US_PERIOD_ADVANCE' }).next
    .filter(a => a.type === 'BEHAVIORAL_PANIC_SELL_APPLY');
  assert.ok(fired.length > 0, 'PanicSell must now fire off a library preset');
});

test('SHOCKTAG-5: the stress window expires on its own clock while the price legs live on', () => {
  const sim = loadScenario({ shocks: [{ preset: 'MARKET_CRASH_2008_LITE', startDate: '2027-03-01' }] });
  // 17-month stress window ends Aug 2028; the equity leg runs to 2033 and rates to 2034.
  sim.stepTo(new Date('2029-06-01'));

  const live = sim.state.activeRegimes ?? [];
  assert.ok(live.length > 0, 'the price legs are still live two years on');
  assert.equal(live.filter(r => (r.tags ?? []).length > 0).length, 0,
    'but the household is no longer in crisis posture — the stress window has closed');
});

// ─── sleeve coverage ─────────────────────────────────────────────────────────

test('SHOCKTAG-6: a preset that cuts dividends on one equity sleeve cuts them on all four', () => {
  for (const [id, shock] of Object.entries(SHOCK_LIBRARY)) {
    for (const leg of legsOf(shock)) {
      const div = leg.regime?.dividendAdjustment;
      if (!div) continue;
      const named = Object.keys(div).filter(k => EQUITY_SLEEVES.includes(k));
      if (named.length === 0) continue;
      const missing = EQUITY_SLEEVES.filter(k => !(k in div));
      assert.deepEqual(missing, [],
        `${id} cuts dividends on ${named.join('/')} but not ${missing.join('/')} — `
        + 'effectiveDividendAdjustments is keyed by the HOLDING\'s rate key, so an unnamed '
        + 'sleeve takes the price hit and keeps paying its full yield');
    }
  }
});

test('SHOCKTAG-7: a preset that shocks EQUITY_US also shocks EQUITY_INTL_EX_AU', () => {
  // EQUITY_INTL_EX_AU is a global-ex-Australia basket, ~70 % US by weight. A US equity
  // shock that skips it means an AU household whose growth sleeve is a global fund feels
  // nothing at all — which is what MILD_CORRECTION used to do.
  for (const [id, shock] of Object.entries(SHOCK_LIBRARY)) {
    const level = [].concat(shock.levelEffects?.equityRevaluation ?? [])
      .flatMap(e => e?.rateKeys ?? []);
    if (level.includes('EQUITY_US')) {
      assert.ok(level.includes('EQUITY_INTL_EX_AU'), `${id} breaks EQUITY_US but not EQUITY_INTL_EX_AU`);
    }
    for (const leg of legsOf(shock)) {
      const ret = leg.regime?.returnAdjustment ?? {};
      if ('EQUITY_US' in ret) {
        assert.ok('EQUITY_INTL_EX_AU' in ret,
          `${id} leg '${leg.id}' drags EQUITY_US but not EQUITY_INTL_EX_AU`);
      }
    }
  }
});

test('SHOCKTAG-8: only the sharp falls trigger panic, and the control arm is held back by severity', () => {
  const tagsOf = (id) => taggedLegs(SHOCK_LIBRARY[id]).flatMap(l => l.tags);

  // The control arm IS tagged; what keeps it from breaking a plan is its severity sitting
  // below every strategy's default threshold (design 21 §24). Stated as a tag omission this
  // was untunable and invisible to a severity sweep.
  assert.deepEqual(tagsOf('MILD_CORRECTION'), [REGIME_TAG.ECONOMIC_STRESS]);
  assert.ok(SHOCK_LIBRARY.MILD_CORRECTION.severity < 0.25,
    'and it must stay below the default threshold, or the control arm starts reacting');

  for (const id of Object.keys(SHOCK_LIBRARY)) {
    if (!isEquityShock(SHOCK_LIBRARY[id])) {
      assert.deepEqual(tagsOf(id), [], `${id} has no equity leg, so it states no household stress`);
    }
  }

  // PanicSell is an ENTRY reaction — nobody panics into year six of a lost decade.
  const panics = Object.keys(SHOCK_LIBRARY)
    .filter(id => tagsOf(id).includes(REGIME_TAG.PANIC_SELL_TRIGGER)).sort();
  assert.deepEqual(panics, ['COVID_2020_LITE', 'DOTCOM_2000_LITE', 'MARKET_CRASH_2008_LITE']);

  // …but every equity preset except the control arm is at least STRESSED.
  const stressed = Object.keys(SHOCK_LIBRARY)
    .filter(id => tagsOf(id).includes(REGIME_TAG.ECONOMIC_STRESS)).sort();
  assert.deepEqual(stressed, ['COVID_2020_LITE', 'DOTCOM_2000_LITE', 'LOST_DECADE_2000',
    'MARKET_CRASH_2008_LITE', 'MILD_CORRECTION', 'STAGFLATION_1970S_LITE']);
});
