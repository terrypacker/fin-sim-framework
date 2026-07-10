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
 * evt-prime-timevarying.test.mjs
 *
 * Design 56 Phase 2b — time-varying Prime WITHIN a run (the runtime propagation).
 *
 * Phase 1 bakes `SAVINGS_*::<stateKey> = Prime_seed + spread` into `baseInterestRates`
 * once at compile, so a Prime move *within a run* (a shock/schedule that hikes PRIME_US
 * mid-sim) never reached the cash accounts — `RegimeApplyReducer` only moved
 * `effectiveInterestRates[PRIME_*]`, which no handler reads. PrimeRelinkReducer closes
 * this by adding the runtime Prime delta onto every linked cash key each period.
 *
 *   PRIME-TV-1: a mid-run PRIME_US hike lifts the linked US cash effective rate by
 *               exactly the hike, and credits more US savings interest over the run.
 *   PRIME-TV-2: a spread-less (non-linked) US savings account is unchanged by the hike.
 *   PRIME-TV-3: a PRIME_US hike does NOT touch the AU cash account (PRIME_AU independent).
 *   PRIME-TV-4: no Prime move ⇒ PrimeRelinkReducer is a no-op (byte-for-byte identical).
 *   PRIME-TV-5: an optional Prime *schedule* param compiles into a scheduled PRIME_US
 *               step that lands on the linked US cash account at the scheduled year.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioSerializer }     from '../../src/scenarios/scenario-serializer.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';
import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { PrimeRelinkReducer }     from '../../src/finance/economic-regimes/prime-relink-reducer.js';

const SS = new Date(Date.UTC(2026, 0, 1));
const SE = new Date(Date.UTC(2032, 0, 1));

/** Build the default config, apply `mutate(cfg)`, run to SE, return sim.state. */
function run(mutate = () => {}) {
  ServiceRegistry.resetAll();
  const reg = ServiceRegistry.getInstance();
  const sc  = new IntlRetirementScenario({ context: reg.simulationContext, simStart: SS, simEnd: SE });
  sc.buildSim();
  const cfg = ScenarioSerializer.serializeScenario(IntlRetirementScenario.buildDefaultConfig({}, SS, SE));
  cfg.parameters = { ...(cfg.parameters ?? {}) };
  mutate(cfg);
  new ScenarioLoader().load(cfg, reg);
  sc.sim.silent = true; sc.sim.journal.enabled = false;
  sc.sim.stepTo(SE);
  return sc.sim.state;
}

const rate    = (state, key) => state.effectiveInterestRates?.[key] ?? NaN;
const metric  = (state, m)   => state.metrics?.[m]?.value ?? state.metrics?.[m] ?? -1;

const US_KEY = 'SAVINGS_US::usSavingsAccount';
const AU_KEY = 'SAVINGS_AU::auSavingsAccount';

const US_SAVINGS = 0.03,  US_PRIME = 0.045;   // prebuilt US spread = -0.015
const AU_SAVINGS = 0.045;                      // prebuilt AU spread = +0.0015

/**
 * A permanent (L-profile) mid-run hike to PRIME_US, authored as a custom shock so the
 * regime carries `interestRateAdjustment: { PRIME_US: +delta }`. It starts partway
 * through the run and never recovers (durationMonths ≫ run length).
 */
function primeHike(delta, startDate = '2029-01-01') {
  return {
    shockId:   'PRIME_HIKE',
    name:      'Prime Hike',
    startDate,
    regime:    { interestRateAdjustment: { PRIME_US: delta } },
    recovery:  { profile: 'L', durationMonths: 600 },
  };
}

test('PRIME-TV-1: a mid-run PRIME_US hike lifts the linked US cash rate and credits more interest', () => {
  const base = run();
  const hike = run(cfg => { cfg.parameters.shocks = [primeHike(0.03)]; });

  // The linked account's effective rate at run end is Prime(hiked) + spread.
  assert.ok(Math.abs(rate(base, US_KEY) - US_SAVINGS) < 1e-9,
    `baseline US rate must be the seeded ${US_SAVINGS}, got ${rate(base, US_KEY)}`);
  assert.ok(Math.abs(rate(hike, US_KEY) - (US_SAVINGS + 0.03)) < 1e-9,
    `a +3% mid-run Prime hike must lift the US cash rate to ${US_SAVINGS + 0.03}, got ${rate(hike, US_KEY)}`);

  // And that live rate credits strictly more interest over the run.
  assert.ok(metric(hike, 'us_savings_interest') > metric(base, 'us_savings_interest'),
    `a mid-run Prime hike must credit more US savings interest (base ${metric(base, 'us_savings_interest')}, hike ${metric(hike, 'us_savings_interest')})`);
});

test('PRIME-TV-2: a spread-less (non-linked) US savings account does not track a Prime hike', () => {
  // Unlink the US savings account (primeSpread=null ⇒ it falls back to its absolute
  // interestRate and produces NO primeLink), then hike PRIME_US mid-run. The account must
  // NOT track Prime — PrimeRelinkReducer only touches keys it has a link for. We assert
  // this on the effective rate directly (a same-run, unconfounded check); comparing
  // *credited interest* across a with-shock vs no-shock run is not a valid isolation,
  // because injecting any shock's recovery-tick events perturbs event ordering by a few
  // cents regardless of the rate (verified: a ~0-magnitude EQUITY shock drifts it the
  // same way). The rate is the precise signal for "did Prime reach this account".
  const hike = run(cfg => {
    cfg.accounts.find(x => x.stateKey === 'usSavingsAccount').primeSpread = null;
    cfg.parameters.shocks = [primeHike(0.03)];
  });

  // The Prime move (PRIME_US → +3%) must leave the unlinked account at its absolute rate.
  assert.ok(Math.abs(rate(hike, US_KEY) - US_SAVINGS) < 1e-9,
    `a spread-less US account must stay at its absolute rate ${US_SAVINGS} despite a Prime hike, got ${rate(hike, US_KEY)}`);
  // And the guard's cause: no primeLink references the unlinked account.
  const links = hike.primeLinks ?? [];
  assert.ok(!links.some(l => l.stateKey === 'usSavingsAccount'),
    'an unlinked (spread-less) account must produce no primeLink');
});

test('PRIME-TV-3: a PRIME_US hike does NOT touch the AU cash account (independent PRIME_AU)', () => {
  const base = run();
  const hike = run(cfg => { cfg.parameters.shocks = [primeHike(0.03)]; });

  assert.ok(Math.abs(rate(hike, AU_KEY) - AU_SAVINGS) < 1e-9,
    `a Fed move must leave the AU cash rate at ${AU_SAVINGS}, got ${rate(hike, AU_KEY)}`);
  assert.ok(Math.abs(metric(hike, 'au_savings_interest') - metric(base, 'au_savings_interest')) < 1e-6,
    'a Fed move must not change AU savings interest');
});

test('PRIME-TV-4: no Prime move ⇒ PrimeRelinkReducer is a no-op (byte-for-byte identical)', () => {
  // A benign non-rate shock (nothing touching PRIME_*) must leave every linked cash rate
  // exactly at its Phase-1 seeded value — the delta path never fires.
  const base = run();
  const other = run(cfg => {
    cfg.parameters.shocks = [{
      shockId:  'EQ_DIP',
      name:     'Equity Dip',
      startDate:'2029-01-01',
      regime:   { returnAdjustment: { EQUITY_US: -0.02 } },
      recovery: { profile: 'L', durationMonths: 600 },
    }];
  });
  assert.ok(Math.abs(rate(other, US_KEY) - rate(base, US_KEY)) < 1e-12,
    'a non-Prime shock must leave the US cash rate untouched');
  assert.ok(Math.abs(rate(other, AU_KEY) - rate(base, AU_KEY)) < 1e-12,
    'a non-Prime shock must leave the AU cash rate untouched');
});

test('PRIME-TV-5: a Prime schedule param compiles into a scheduled step onto linked cash', () => {
  // The schedule expresses an ABSOLUTE Prime path; the 2029 step (0.045 → 0.07, +2.5%)
  // must lift the linked US cash rate to spread + 0.07 by run end and credit more interest.
  const base = run();
  const sched = run(cfg => {
    cfg.parameters.primeSchedule = [
      { year: 2029, PRIME_US: US_PRIME + 0.025 },   // step Prime up mid-run
    ];
  });

  assert.ok(Math.abs(rate(sched, US_KEY) - (US_SAVINGS + 0.025)) < 1e-9,
    `a scheduled Prime step to ${US_PRIME + 0.025} must lift the US cash rate to ${US_SAVINGS + 0.025}, got ${rate(sched, US_KEY)}`);
  assert.ok(metric(sched, 'us_savings_interest') > metric(base, 'us_savings_interest'),
    'a scheduled Prime hike must credit more US savings interest');
});

// ── Isolated PrimeRelinkReducer postcondition tests (reduce() called directly) ──

/** Minimal state a PrimeRelinkReducer.reduce() reads: base + effective interest + links. */
function primeState({ primeBase = 0.045, primeEff, savBase = 0.03, savEff, links } = {}) {
  return {
    primeLinks: links ?? [{ stateKey: 'a', savKey: 'SAVINGS_US', primeKey: 'PRIME_US', spread: -0.015 }],
    baseInterestRates:      { PRIME_US: primeBase, 'SAVINGS_US::a': savBase },
    effectiveInterestRates: { PRIME_US: primeEff ?? primeBase, 'SAVINGS_US::a': savEff ?? savBase },
  };
}
const relink = (state) => new PrimeRelinkReducer().reduce(state, { type: 'US_PERIOD_ADVANCE' }, new Date());

test('PRIME-TVU-1: adds the Prime delta (effective − base) onto the linked cash key', () => {
  // Prime moved +0.02 (0.045 → 0.065); the linked key (seeded 0.03) rises by exactly 0.02.
  const out = relink(primeState({ primeEff: 0.065 }));
  assert.ok(Math.abs(out.effectiveInterestRates['SAVINGS_US::a'] - 0.05) < 1e-12,
    `linked key must be seed + prime delta = 0.05, got ${out.effectiveInterestRates['SAVINGS_US::a']}`);
});

test('PRIME-TVU-2: composes with a savings-market shock already on the per-account key', () => {
  // RegimeApplyReducer already fanned a +0.005 SAVINGS shock (0.03 → 0.035); a +0.02 Prime
  // move must ADD on top (0.055), not overwrite with Prime+spread (which would drop the shock).
  const out = relink(primeState({ primeEff: 0.065, savEff: 0.035 }));
  assert.ok(Math.abs(out.effectiveInterestRates['SAVINGS_US::a'] - 0.055) < 1e-12,
    `Prime move must compose with the savings shock (0.055), got ${out.effectiveInterestRates['SAVINGS_US::a']}`);
});

test('PRIME-TVU-3: no Prime move ⇒ no-op (effective map returned unchanged)', () => {
  const state = primeState({ primeEff: 0.045 });            // delta 0
  const out   = relink(state);
  assert.strictEqual(out.effectiveInterestRates, state.effectiveInterestRates,
    'a zero delta must leave the effective map reference untouched (no needless clone)');
});

test('PRIME-TVU-4: a link with no seeded per-account key is skipped (defensive)', () => {
  const state = primeState({ primeEff: 0.065 });
  delete state.effectiveInterestRates['SAVINGS_US::a'];
  delete state.baseInterestRates['SAVINGS_US::a'];
  const out = relink(state);
  assert.ok(!('SAVINGS_US::a' in out.effectiveInterestRates),
    'an unseeded link must not fabricate a per-account key');
});
