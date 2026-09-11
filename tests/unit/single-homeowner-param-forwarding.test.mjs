/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

// The US and AU single-homeowner plans' buildDefaultConfig used to drop every
// toolset-contributed override — the market totals and yields among them — so
// buildDefaultConfig({ auEquityGrowthRate: 0.07 }) ran at the default rate. Found by
// design 99 P5b's attribution probe (four "different" runs came out identical). They now
// forward exactly as the intl plan does (toolset-param-forwarding.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UsSingleHomeownerScenario } from '../../src/scenarios/us-single-homeowner-scenario.js';
import { AuSingleHomeownerScenario } from '../../src/scenarios/au-single-homeowner-scenario.js';
import { IntlRetirementScenario }    from '../../src/scenarios/intl-retirement-scenario.js';
import { runGolden }                 from '../helpers/golden-harness.js';

const PLANS = [
  { cls: UsSingleHomeownerScenario, market: 'usEquityGrowthRate' },
  { cls: AuSingleHomeownerScenario, market: 'auEquityGrowthRate' },
];

for (const { cls, market } of [...PLANS, { cls: IntlRetirementScenario }]) {
  test(`PFWD-1 ${cls.scenarioId()}: _paramToolsets() mirrors getToolsets()`, () => {
    // The forwarded key set is built from the objects; a toolset added to one list and
    // not the other would silently drop its params again.
    assert.deepEqual(cls._paramToolsets().map(t => t.id), cls.getToolsets());
  });
  if (!market) continue;

  test(`PFWD-2 ${cls.scenarioId()}: market total and yield overrides reach cfg.parameters`, () => {
    const cfg = cls.buildDefaultConfig({ [market]: 0.05, usEquityDividendYield: 0.03 });
    assert.equal(cfg.parameters[market], 0.05);
    assert.equal(cfg.parameters.usEquityDividendYield, 0.03);
  });

  test(`PFWD-3 ${cls.scenarioId()}: nothing is emitted without an override, typos are not leaked`, () => {
    const cfg = cls.buildDefaultConfig({ notARealParam: 42 });
    assert.ok(!(market in cfg.parameters));
    assert.ok(!('shocks' in cfg.parameters));
    assert.ok(!('notARealParam' in cfg.parameters));
  });

  test(`PFWD-4 ${cls.scenarioId()}: the forwarded market total changes the run`, () => {
    // The effect, not the field: a key on cfg.parameters that nothing reads is the bug
    // this file exists for, one level down.
    const spec = { cls, simStart: new Date(Date.UTC(2026, 0, 1)), simEnd: new Date(Date.UTC(2029, 0, 1)) };
    const base  = runGolden(spec).snapshot;
    const moved = runGolden({ ...spec, params: { [market]: 0.03 } }).snapshot;
    assert.notDeepEqual(moved, base);
  });
}
