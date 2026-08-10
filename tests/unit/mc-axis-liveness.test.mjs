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
 * mc-axis-liveness.test.mjs — every enabled Monte Carlo axis must be able to
 * change the answer.
 *
 * design/inconsistencies §4.10. Four `spouse*GrowthRate` params shipped as
 * `enabled: true` MC axes with `stdDev: 0.03`, and not one of them could move a
 * single field of the end state: growth is keyed by account TYPE
 * (`collectBaseGrowthRates`), so one rate per wrapper already covered both people
 * and a per-owner key had nowhere to land. Nothing failed, because a dead lever
 * fails silently — it just quietly narrows the sampled distribution while the
 * report still names it as a source of uncertainty.
 *
 * The detection recipe is the cheap part and generalises to every axis, so it is
 * a gate rather than a one-off probe: perturb the axis, diff the whole normalized
 * end state, count moved fields. Zero moved fields on a plan that exercises the
 * axis's own domain means the lever is disconnected.
 *
 * Two things this deliberately does NOT do:
 *
 *  - It writes to `cfg.parameters`, which is where IntlRetirementMcRunner merges
 *    a sample — NOT to `buildDefaultConfig(params)`. The two layers are not
 *    interchangeable: buildDefaultConfig's enumerated block renames some keys
 *    (`usStockGrowthRate` → `brokerageGrowthRate`) and its passthrough skips any
 *    key that block already owns, so a param can be live at one layer and inert
 *    at the other. §4.10's `superGrowthRate` was inert at the params layer and
 *    live at the MC layer; `spouseSuperGrowthRate` was the exact inverse. A gate
 *    measured at the wrong layer would have certified the wrong name.
 *  - It does not police `enabled: false` axes. Several (equityReturnVol,
 *    propertyReturnIdioScale, repairSeverityScale, repairFreqScale) legitimately
 *    move nothing here because they are volatility knobs on a stochastic process
 *    the reference plan leaves set to NONE — an absence test with no
 *    working-detector control. Enabling one in this scenario would prove nothing
 *    either way, so they are out of scope rather than waived.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { DEFAULT_MC_VARIABLE_CONFIGS }
  from '../../src/finance/monte-carlo/intl-retirement-mc-config.js';
import { runGolden, normalizeState } from '../helpers/golden-harness.js';

/**
 * A short run of the reference plan — long enough to cross the default moveYear
 * (so the AU-side axes have something to act on), short enough that ~15 full
 * simulations cost about a second.
 */
const SPEC = {
  name:     'mc-axis-liveness',
  simStart: new Date(Date.UTC(2026, 0, 1)),
  simEnd:   new Date(Date.UTC(2034, 0, 1)),
};

/** Flatten a normalized state into `dotted.path → JSON` so fields can be counted. */
function flatten(value, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(value ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = JSON.stringify(v);
  }
  return out;
}

/** End state of the reference plan with `paramKey` written at the MC runner's layer. */
function endStateWith(paramKey, value) {
  const spec = paramKey == null
    ? SPEC
    : { ...SPEC, mutateCfg: cfg => { cfg.parameters[paramKey] = value; } };
  return flatten(normalizeState(runGolden(spec).state));
}

/** Count of state fields that differ between two flattened end states. */
function movedFields(a, b) {
  let moved = 0;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[k] !== b[k]) moved++;
  }
  return moved;
}

const ENABLED = DEFAULT_MC_VARIABLE_CONFIGS.filter(c => c.enabled !== false);

test('MC-LIVE-1: every enabled MC axis carries a numeric center this gate can perturb', () => {
  // Balance levers resolve their center from the account record rather than a
  // `mean` (design 55 §13), and shock axes are array paths generated per-scenario.
  // Neither is enabled by default today. If one becomes enabled, it needs its own
  // perturbation shape here rather than being skipped into a false pass.
  for (const cfg of ENABLED) {
    assert.ok(typeof cfg.mean === 'number' && Number.isFinite(cfg.mean),
      `${cfg.paramKey} is enabled but has no numeric mean — extend this gate`);
    assert.ok(!cfg.paramKey.includes('['),
      `${cfg.paramKey} is enabled but is an array path — extend this gate`);
  }
});

test('MC-LIVE-2: every enabled MC axis moves the end state (no dead sampling dimensions)', () => {
  const base = endStateWith(null);
  const dead = [];

  for (const cfg of ENABLED) {
    // +50% and a nudge: large enough that a compounding lever is unmistakable,
    // and non-zero even for an axis whose mean is 0.
    const moved = movedFields(base, endStateWith(cfg.paramKey, cfg.mean * 1.5 + 0.011));
    if (moved === 0) dead.push(cfg.paramKey);
  }

  assert.deepStrictEqual(dead, [],
    'these axes are sampled every MC run but cannot change the outcome — either wire '
    + 'them to something or retire them (design/inconsistencies §4.10)');
});

test('MC-LIVE-3: the retired spouse growth axes are gone, and super has a working one', () => {
  const keys = DEFAULT_MC_VARIABLE_CONFIGS.map(c => c.paramKey);
  for (const retired of ['spouseRothGrowthRate', 'spouseIraGrowthRate',
    'spouseK401GrowthRate', 'spouseSuperGrowthRate']) {
    assert.ok(!keys.includes(retired), `${retired} should be retired (§4.10)`);
  }
  // Super growth is not merely renamed away — it must still be sampled, under the
  // one key the compiler reads. Before §4.10 it had no working axis at all.
  assert.ok(keys.includes('superGrowthRate'), 'superGrowthRate must be an MC axis');
  assert.ok(ENABLED.some(c => c.paramKey === 'superGrowthRate'),
    'superGrowthRate must be enabled by default, as the four dead spouse axes were');
});
