/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * regime-severity-threshold.test.mjs — design 21 §24. Intensity is a SCALAR beside the
 * tag, not a rung inside it.
 *
 * A tag says which KIND of downturn is in play; `regime.severity` — the shock's measured
 * trough depth, stamped onto every leg — says how hard. Strategies gate on a threshold they
 * own, so "only suspend contributions in a medium-to-high stress environment" is a tunable
 * number rather than a label frozen in the library.
 *
 * SEV-1: the handler stamps severity onto EVERY leg of a shock
 * SEV-2: the stamped value is the SWEPT one — the reason intensity is not in the tag
 * SEV-3: regimeMeetsSeverity — over, under, and the UNRATED case that must not be read as mild
 * SEV-4: ContributionSuspension fires on a GFC and NOT on a mild correction, from one
 *        threshold and two presets that are both tagged ECONOMIC_STRESS
 * SEV-5: …and the same preset DOES suspend once the household's own threshold drops
 * SEV-6: a severity SWEEP moves the behaviour, which a graded tag could never do
 * SEV-7: CashBucketDrawdown gates on the same scalar, panic tag included
 * SEV-8: the registry defaults are wired (the params are not decorative)
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ServiceRegistry }      from '../../src/services/service-registry.js';
import { ScenarioLoader }       from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }         from '../../src/index.js';
import { ECONOMIC_REGIMES }     from '../../src/scenarios/toolsets/economic-regimes-toolset.js';
import { SHOCK_LIBRARY }        from '../../src/finance/economic-shocks/shock-library.js';
import { EconomicShockHandler } from '../../src/finance/economic-regimes/economic-shock-handler.js';
import { REGIME_TAG }           from '../../src/finance/economic-regimes/regime-tag.js';
import { regimeMeetsSeverity, isStressed } from '../../src/finance/economic-regimes/regime-stress.js';
import { ContributionSuspensionToggleReducer } from '../../src/finance/behavioral/contribution-suspension-toggle-reducer.js';
import { CashBucketDrawdownReducer }           from '../../src/finance/behavioral/cash-bucket-drawdown-reducer.js';
import { BEHAVIORAL_STRATEGY_REGISTRY }        from '../../src/finance/behavioral/behavioral-strategy-registry.js';

beforeEach(() => ServiceRegistry.resetAll());

const handler = () => new EconomicShockHandler({ rateKeyToStateKeys: {}, allAccountStateKeys: [] });
const regimesOf = (shock) => handler().call({ data: { shock } })
  .filter(a => a.type === 'ADD_REGIME_APPLY').map(a => a.regime);

// ─── the channel ─────────────────────────────────────────────────────────────

test('SEV-1: the handler stamps severity onto every leg of a shock', () => {
  const shock   = { ...SHOCK_LIBRARY.MARKET_CRASH_2008_LITE, startDate: new Date('2030-01-01') };
  const regimes = regimesOf(shock);

  assert.equal(regimes.length, 4, 'stress + equity + markets + rates');
  for (const r of regimes) {
    assert.equal(r.severity, 0.51,
      `leg ${r.id} must carry the episode's depth — severity is a property of the SHOCK, and a `
      + 'strategy reads it off whichever regime its tag matched');
  }

  // An unrated shock stamps null rather than inventing a number.
  const curve = { ...SHOCK_LIBRARY.CURVE_INVERSION, startDate: new Date('2030-01-01') };
  assert.equal(regimesOf(curve)[0].severity, null);
});

test('SEV-2: the stamped severity is the SWEPT value, not the library default', () => {
  // This is the whole argument for a scalar over a graded tag. applySeverity rescales the
  // level effects and the drags and leaves `tags` untouched, so a preset that declared its
  // own intensity as STRESS_HIGH would still claim to be severe after a sweep scaled it to
  // a mild dip. The scalar moves; a label cannot.
  const events = ECONOMIC_REGIMES.schedules({
    parameters: { shocks: [{ preset: 'MARKET_CRASH_2008_LITE', startDate: '2030-01-01', severity: 0.12 }] },
    accounts:   [],
  });
  const shock = events.find(e => e.type === 'ECONOMIC_SHOCK').data.shock;
  assert.equal(shock.severity, 0.12, 'the sweep rewrote the shock');
  for (const r of regimesOf(shock)) assert.equal(r.severity, 0.12, 'and every regime followed it');

  // The tags are identical either way — which is exactly why they must not carry magnitude.
  const unswept = regimesOf({ ...SHOCK_LIBRARY.MARKET_CRASH_2008_LITE, startDate: new Date('2030-01-01') });
  assert.deepEqual(regimesOf(shock).map(r => r.tags), unswept.map(r => r.tags));
});

test('SEV-3: regimeMeetsSeverity — over, under, and the unrated case', () => {
  assert.equal(regimeMeetsSeverity({ severity: 0.51 }, 0.25), true);
  assert.equal(regimeMeetsSeverity({ severity: 0.115 }, 0.25), false);
  assert.equal(regimeMeetsSeverity({ severity: 0.25 }, 0.25), true, 'the floor is inclusive');
  assert.equal(regimeMeetsSeverity({ severity: -0.4 }, 0.25), true, 'sign is not magnitude');

  // An absent severity is missing information, not evidence of mildness: the author who
  // tagged an unrated shock made a statement a threshold has no standing to overrule.
  assert.equal(regimeMeetsSeverity({ severity: null }, 0.9), true);
  assert.equal(regimeMeetsSeverity({}, 0.9), true);
  // …and a null threshold is no gate at all (the pre-threshold behaviour).
  assert.equal(regimeMeetsSeverity({ severity: 0.01 }, null), true);
});

// ─── the strategies ──────────────────────────────────────────────────────────

const stressState = (severity, tags = [REGIME_TAG.ECONOMIC_STRESS]) => ({
  activeRegimes: [{ id: 'r', shockId: 's', tags, severity, currentFactor: 1 }],
  regimeActions: {},
});

test('SEV-4: one threshold, two tagged presets — a GFC suspends, a mild correction does not', () => {
  const reducer = new ContributionSuspensionToggleReducer({ minSeverity: 0.25 });

  const gfc = reducer.reduce(stressState(SHOCK_LIBRARY.MARKET_CRASH_2008_LITE.severity), { type: 'US_PERIOD_ADVANCE' });
  assert.equal(gfc.contributionsSuspended, true, 'a 51 % drawdown stops contributions');

  // MILD_CORRECTION carries the SAME tag. What holds it back is its depth — which is the
  // point: the control-arm property is now tunable and swept, not a tag omission.
  const mild = reducer.reduce(stressState(SHOCK_LIBRARY.MILD_CORRECTION.severity), { type: 'US_PERIOD_ADVANCE' });
  assert.notEqual(mild.contributionsSuspended, true, 'an 11.5 % dip does not');

  // COVID sits between them and is the case worth naming: households did not stop
  // contributing through a crash that round-tripped in seven months.
  const covid = reducer.reduce(stressState(SHOCK_LIBRARY.COVID_2020_LITE.severity), { type: 'US_PERIOD_ADVANCE' });
  assert.notEqual(covid.contributionsSuspended, true);
});

test('SEV-5: the same preset suspends once the household lowers its own threshold', () => {
  // The control detector for SEV-4: proves the mild case is held back by the THRESHOLD and
  // not by some unrelated reason the reducer would have refused for anyway.
  const jumpy = new ContributionSuspensionToggleReducer({ minSeverity: 0.10 });
  const out   = jumpy.reduce(stressState(SHOCK_LIBRARY.MILD_CORRECTION.severity), { type: 'US_PERIOD_ADVANCE' });
  assert.equal(out.contributionsSuspended, true);
});

test('SEV-6: a severity sweep moves the behaviour — what a graded tag could not do', () => {
  const reducer = new ContributionSuspensionToggleReducer({ minSeverity: 0.25 });
  const fires = (severity) => {
    const events = ECONOMIC_REGIMES.schedules({
      parameters: { shocks: [{ preset: 'MILD_CORRECTION', startDate: '2030-01-01', severity }] },
      accounts:   [],
    });
    const shock  = events.find(e => e.type === 'ECONOMIC_SHOCK').data.shock;
    const state  = { activeRegimes: regimesOf(shock), regimeActions: {} };
    return reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' }).contributionsSuspended === true;
  };

  assert.equal(fires(0.115), false, 'at its own calibrated depth the control arm is inert');
  assert.equal(fires(0.40),  true,  'swept deeper, the SAME preset starts suspending');
});

test('SEV-7: CashBucketDrawdown gates on the same scalar', () => {
  const reducer = new CashBucketDrawdownReducer({ minSeverity: 0.25 });
  const active  = (s) => reducer.reduce({ activeRegimes: s.activeRegimes, regimeActions: {} },
    { type: 'US_PERIOD_ADVANCE' }).regimeActions?.drawdown_source_override?.active === true;

  assert.equal(active(stressState(0.51)), true);
  assert.equal(active(stressState(0.115)), false);
  // It reacts to a panic tag too, but the depth still governs.
  assert.equal(active(stressState(0.51,  [REGIME_TAG.PANIC_SELL_TRIGGER])), true);
  assert.equal(active(stressState(0.115, [REGIME_TAG.PANIC_SELL_TRIGGER])), false);

  // Sanity on the shared helper: an untagged regime never qualifies, at any depth.
  assert.equal(isStressed([{ tags: [], severity: 0.9 }], { minSeverity: 0.25 }), false);
});

test('SEV-8: the registry wires both thresholds, defaulting to 0.25', () => {
  for (const [key, param] of [
    ['CONTRIBUTION_SUSPENSION', 'contributionSuspensionMinSeverity'],
    ['CASH_BUCKET_DRAWDOWN',    'cashBucketDrawdownMinSeverity'],
  ]) {
    const schema = BEHAVIORAL_STRATEGY_REGISTRY[key].paramSchema();
    const entry  = schema.find(p => p.key === param);
    assert.ok(entry, `${key} must expose ${param}`);
    assert.equal(entry.defaultValue, 0.25);
    assert.deepEqual(entry.visibleWhen, { param: 'behavioralStrategies', includes: key });

    // The param must actually reach the reducer — a schema entry nothing reads is the
    // failure mode this whole change exists to remove.
    const [reducer] = BEHAVIORAL_STRATEGY_REGISTRY[key].reducers({
      parameters: { [param]: 0.42 }, accounts: [],
    });
    assert.equal(reducer.minSeverity, 0.42);
    const [dflt] = BEHAVIORAL_STRATEGY_REGISTRY[key].reducers({ parameters: {}, accounts: [] });
    assert.equal(dflt.minSeverity, 0.25);
  }
});
