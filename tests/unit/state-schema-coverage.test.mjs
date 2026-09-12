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
 * state-schema-coverage.test.mjs — design 101 R1, the untyped-leaf gate.
 *
 * Every numeric leaf in every golden's final state must resolve to a typed
 * ParameterValueType. An `unknown` leaf renders as a plausible-looking `1,234.56`
 * whatever it really is (a timestamp, a rate, a year, money in a currency the
 * display toggle cannot convert), so the gap is invisible in the UI. Before R1 there
 * were 5,136 such leaves in 215 shapes across the goldens.
 *
 * Paths are built the way the State panel builds them (`holdings[id=h1]`, design 31
 * R11.3), so the gate also covers the bracketed form the panel actually resolves.
 *
 * The registry is the one ScenarioLoader stamps (per-account currencies etc.), built
 * by loading each golden's cfg without running it — about 0.2 s for all of them.
 *
 * FIXING A FAILURE: register the field's type in StateSchemaRegistry. Add an
 * ALLOWED_UNKNOWN row only when the type genuinely cannot be decided yet, with why.
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { GOLDEN_SPECS }                  from '../helpers/golden-specs.js';
import { buildGoldenCfg, readFixture }   from '../helpers/golden-harness.js';
import { ServiceRegistry }               from '../../src/services/service-registry.js';
import { BaseScenario }                  from '../../src/scenarios/base-scenario.js';
import { ScenarioLoader }                from '../../src/scenarios/scenario-loader.js';

/** Numeric leaves allowed to stay `unknown`, each with the reason it cannot be typed yet. */
const ALLOWED_UNKNOWN = [
  { glob: 'washPendingLosses.*.longLoss',  why: 'Wash-sale loss amounts: currency not pinned by wash-sale.js.' },
  { glob: 'washPendingLosses.*.shortLoss', why: 'Wash-sale loss amounts: currency not pinned by wash-sale.js.' },
  { glob: 'washSaleLedger.*.deferred',        why: 'Wash-sale ledger amounts: as above.' },
  { glob: 'washSaleLedger.*.disallowedLong',  why: 'Wash-sale ledger amounts: as above.' },
  { glob: 'washSaleLedger.*.disallowedShort', why: 'Wash-sale ledger amounts: as above.' },
];

function globToRegex(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*\*/g, '.+').replace(/\*/g, '[^.]+')}$`);
}
const ALLOWED = ALLOWED_UNKNOWN.map(a => ({ ...a, re: globToRegex(a.glob) }));

/** The stamped registry for a golden: build + load its cfg, no run. */
function stampedRegistry(spec) {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  const cfg = buildGoldenCfg(spec);
  const scenario = new BaseScenario({
    context:      services.simulationContext,
    initialState: cfg.initialState ?? {},
    simStart:     new Date(cfg.simStart),
    simEnd:       new Date(cfg.simEnd),
  });
  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  try {
    scenario.buildSim();
    new ScenarioLoader().load(cfg, services);
  } finally { console.log = log; console.warn = warn; }
  return services.schemaRegistry;
}

/**
 * Numeric leaf paths, addressed as StatePanelView._collectLeafPaths addresses them:
 * an array of objects by `[id=…]` when the element has an id, else by position.
 */
function panelLeafPaths(node, prefix, out = []) {
  if (Array.isArray(node)) {
    node.forEach((item, i) => {
      if (item === null || typeof item !== 'object') return;
      panelLeafPaths(item, item.id != null ? `${prefix}[id=${item.id}]` : `${prefix}.${i}`, out);
    });
    return out;
  }
  if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) panelLeafPaths(v, prefix ? `${prefix}.${k}` : k, out);
    return out;
  }
  if (typeof node === 'number' && Number.isFinite(node)) out.push(prefix);
  return out;
}

/** Collapse ids and indices so a failure lists one line per field, not per lot. */
const shapeOf = p => p.replace(/\[id=[^\]]+\]/g, '[id]').replace(/\.\d+(?=\.|$)/g, '.<n>');

const results = GOLDEN_SPECS.map(spec => {
  const reg   = stampedRegistry(spec);
  const state = readFixture(spec.name);
  const unknown = state ? panelLeafPaths(state, '').filter(p => reg.resolve(p).kind === 'unknown') : [];
  return { spec, hasFixture: state != null, unknown };
});

for (const { spec, hasFixture, unknown } of results) {
  test(`golden '${spec.name}': every numeric leaf has a schema type`, () => {
    assert.ok(hasFixture, `no fixture for ${spec.name}`);
    const offenders = unknown.filter(p => !ALLOWED.some(a => a.re.test(p.replace(/\[id=([^\]]+)\]/g, '.$1'))));
    const shapes = [...new Set(offenders.map(shapeOf))].sort();
    assert.deepEqual(shapes, [],
      `${offenders.length} numeric leaf(s) resolve to 'unknown' — register their type in `
      + `StateSchemaRegistry:\n  ${shapes.join('\n  ')}`);
  });
}

test('ALLOWED_UNKNOWN has no stale rows (each still matches an untyped leaf)', () => {
  const all = results.flatMap(r => r.unknown).map(p => p.replace(/\[id=([^\]]+)\]/g, '.$1'));
  const stale = ALLOWED.filter(a => !all.some(p => a.re.test(p))).map(a => a.glob);
  assert.deepEqual(stale, [], `now typed or gone — delete these allow-list rows: ${stale.join(', ')}`);
});
