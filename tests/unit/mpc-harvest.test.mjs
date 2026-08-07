/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { harvestDecisions, pointHarvest, HARVEST_FORMS, COLLAPSE_RULES,
         collapseConsecutive, ageAt, requiresIncludes } from '../../src/finance/mpc/harvest.js';
import { applyHarvestPlan, upsertParam, readParamValue } from '../../src/finance/mpc/harvest-apply.js';
import { resolveStaticLevers, foldScheduleBakes, mergeResolved } from '../../src/finance/mpc/harvest-resolve.js';
import { COCKPIT_CONTROLS } from '../../src/finance/mpc/cockpit-controller.js';
import { recordDecisionRecord, readDecisionRecords, readDecisionRuns } from '../../src/finance/mpc/apply-forward.js';
import { DecisionRecordRegistry } from '../../src/finance/mpc/decision-record-registry.js';
import { Graph } from '../../src/graph/graph.js';

/*
 * Design 39 §13 — harvest a completed MPC run back into scenario params.
 *
 * The unit under test is the projection from a run's decision log onto params:
 * SCHEDULE bakes where the plant has a time-keyed param, POINT (with a mandatory
 * quantified warning) where it doesn't, and a write path that upserts rather than
 * silently dropping.
 */

const BIRTH = { birthDate: '1978-04-15' };          // age 48 in 2026
const CONTROLS = COCKPIT_CONTROLS;

/** A decision record as the cockpit writes it (design 39 §13.2). */
function rec({ year, key, candidate, vars, runId = 'run:1' }) {
  return {
    id: `mpc:${key}:${year}`,
    asOfDate: new Date(Date.UTC(year, 0, 1)).toISOString(),
    move: 'x', result: null, goalMetric: null,
    runId, controlKeys: [key],
    controlVars: vars.map(v => ({ ...v, _controlKey: key })),
    controlParams: candidate,
  };
}

/** Spending epochs: one decision per year, amounts as given. */
function spendingRun(amounts, { startYear = 2026, bandIndex = 0 } = {}) {
  return amounts.map((amount, i) => rec({
    year: startYear + i, key: 'SPENDING',
    candidate: { [`spendingExpenseBands[${bandIndex}].monthlyAmount`]: amount },
    vars: [{ paramKey: `spendingExpenseBands[${bandIndex}].monthlyAmount`, _bandIndex: bandIndex }],
  }));
}

describe('design 39 §13.6.1 — SPENDING bakes to age bands', () => {
  test('one band per epoch, keyed by the primary’s age at that epoch', () => {
    const plan = harvestDecisions(spendingRun([5000, 6000, 7000]), {
      controlsByKey: CONTROLS, baseParams: {}, birth: BIRTH,
    });
    const entry = plan.entries.find(e => e.paramKey === 'spendingExpenseBands');
    assert.equal(entry.form, HARVEST_FORMS.SCHEDULE);
    assert.deepEqual(entry.to, [
      { startAge: 47, monthlyAmount: 5000 },   // Jan 2026, birthday in April ⇒ still 47
      { startAge: 48, monthlyAmount: 6000 },
      { startAge: 49, monthlyAmount: 7000 },
    ]);
  });

  test('consecutive equal amounts collapse into one band', () => {
    const plan = harvestDecisions(spendingRun([5000, 5000, 5000, 9000]), {
      controlsByKey: CONTROLS, birth: BIRTH,
    });
    const bands = plan.entries.find(e => e.paramKey === 'spendingExpenseBands').to;
    assert.deepEqual(bands, [
      { startAge: 47, monthlyAmount: 5000 },
      { startAge: 50, monthlyAmount: 9000 },
    ]);
    assert.match(plan.warnings.join(' '), /collapsed to 2 band/);
  });

  test('pre-run bands below the first epoch’s age are PRESERVED', () => {
    // The run never re-decided those years; deleting them would rewrite the past.
    const prior = [{ startAge: 30, monthlyAmount: 3000 }, { startAge: 60, monthlyAmount: 9999 }];
    const plan = harvestDecisions(spendingRun([5000]), {
      controlsByKey: CONTROLS, baseParams: { spendingExpenseBands: prior }, birth: BIRTH,
    });
    const bands = plan.entries.find(e => e.paramKey === 'spendingExpenseBands').to;
    assert.deepEqual(bands, [
      { startAge: 30, monthlyAmount: 3000 },   // kept: below the run
      { startAge: 47, monthlyAmount: 5000 },   // harvested
    ]);
    // The age-60 band was ABOVE the run's first age, so the run owns that range.
    assert.ok(!bands.some(b => b.startAge === 60));
  });

  test('a decision aimed at a not-yet-entered band keys at that band’s startAge', () => {
    const records = [rec({
      year: 2026, key: 'SPENDING',
      candidate: { 'spendingExpenseBands[1].monthlyAmount': 4200 },
      vars: [{ paramKey: 'spendingExpenseBands[1].monthlyAmount', _bandIndex: 1, _future: true, _startAge: 65 }],
    })];
    const bands = harvestDecisions(records, { controlsByKey: CONTROLS, birth: BIRTH })
      .entries.find(e => e.paramKey === 'spendingExpenseBands').to;
    assert.deepEqual(bands, [{ startAge: 65, monthlyAmount: 4200 }]);
  });

  test('requires spendingStrategy to INCLUDE EXPLICIT_BANDS without clobbering siblings', () => {
    const plan = harvestDecisions(spendingRun([5000]), {
      controlsByKey: CONTROLS, baseParams: { spendingStrategy: ['FIXED', 'HEALTHCARE'] }, birth: BIRTH,
    });
    const req = plan.requires.find(r => r.paramKey === 'spendingStrategy');
    assert.deepEqual(req.to, requiresIncludes('EXPLICIT_BANDS'));

    const scenario = { params: [{ name: 'spendingStrategy', type: 'EnumMulti', value: ['FIXED', 'HEALTHCARE'] }] };
    applyHarvestPlan(scenario, plan);
    assert.deepEqual(readParamValue(scenario, 'spendingStrategy'), ['FIXED', 'HEALTHCARE', 'EXPLICIT_BANDS']);
  });

  test('an already-satisfied requirement is not listed', () => {
    const plan = harvestDecisions(spendingRun([5000]), {
      controlsByKey: CONTROLS, baseParams: { spendingStrategy: ['EXPLICIT_BANDS'] }, birth: BIRTH,
    });
    assert.equal(plan.requires.find(r => r.paramKey === 'spendingStrategy'), undefined);
  });
});

describe('design 39 §13.6.2 — per-year schedules', () => {
  test('ROTH bakes the union of decided years, dropping non-conversion years', () => {
    const records = [
      rec({ year: 2026, key: 'ROTH', candidate: { 'rothConversionSchedule[0].incomeTarget': 90000 },
            vars: [{ paramKey: 'rothConversionSchedule[0].incomeTarget', _year: 2027 }] }),
      rec({ year: 2027, key: 'ROTH', candidate: { 'rothConversionSchedule[1].incomeTarget': 0 },
            vars: [{ paramKey: 'rothConversionSchedule[1].incomeTarget', _year: 2028 }] }),
      rec({ year: 2028, key: 'ROTH', candidate: { 'rothConversionSchedule[2].incomeTarget': 120000 },
            vars: [{ paramKey: 'rothConversionSchedule[2].incomeTarget', _year: 2029 }] }),
    ];
    const entry = harvestDecisions(records, { controlsByKey: CONTROLS })
      .entries.find(e => e.paramKey === 'rothConversionSchedule');
    assert.equal(entry.form, HARVEST_FORMS.SCHEDULE);
    assert.deepEqual(entry.to, [
      { year: 2027, incomeTarget: 90000 },
      { year: 2029, incomeTarget: 120000 },
    ]);
  });

  test('a later zero CANCELS an earlier target for the same year', () => {
    const mk = (y, target) => rec({ year: y, key: 'ROTH',
      candidate: { 'rothConversionSchedule[0].incomeTarget': target },
      vars: [{ paramKey: 'rothConversionSchedule[0].incomeTarget', _year: 2030 }] });
    const entry = harvestDecisions([mk(2026, 80000), mk(2027, 0)], { controlsByKey: CONTROLS })
      .entries.find(e => e.paramKey === 'rothConversionSchedule');
    assert.deepEqual(entry.to, []);
  });

  test('EARLY_WITHDRAWAL bakes both class amounts per year', () => {
    const records = [rec({ year: 2026, key: 'EARLY_WITHDRAWAL',
      candidate: {
        'earlyWithdrawalSchedule[0].taxDeferredAmount': 40000,
        'earlyWithdrawalSchedule[0].rothAmount': 5000,
      },
      vars: [
        { paramKey: 'earlyWithdrawalSchedule[0].taxDeferredAmount', _year: 2027 },
        { paramKey: 'earlyWithdrawalSchedule[0].rothAmount',        _year: 2027 },
      ] })];
    const entry = harvestDecisions(records, { controlsByKey: CONTROLS })
      .entries.find(e => e.paramKey === 'earlyWithdrawalSchedule');
    assert.deepEqual(entry.to, [{ year: 2027, taxDeferredAmount: 40000, rothAmount: 5000 }]);
  });
});

describe('design 39 §13.6.4 — ALLOCATION_MIX bakes to GLIDEPATH anchors', () => {
  const allocRun = (mixes, { startYear = 2026 } = {}) => mixes.map((w, i) => rec({
    year: startYear + i, key: 'ALLOCATION_MIX',
    candidate: { 'allocWeight::EQUITY': w.e, 'allocWeight::BOND': w.b, 'allocWeight::CASH': w.c },
    vars: [
      { paramKey: 'allocWeight::EQUITY', _class: 'EQUITY' },
      { paramKey: 'allocWeight::BOND',   _class: 'BOND'   },
      { paramKey: 'allocWeight::CASH',   _class: 'CASH'   },
    ],
  }));

  test('anchors carry the synthesized MIX (summing to 1), not the raw weights', () => {
    const entry = harvestDecisions(allocRun([{ e: 0.9, b: 0.5, c: 0.5 }]), {
      controlsByKey: CONTROLS, birth: BIRTH,
    }).entries.find(e => e.paramKey === 'allocationGlidepath');
    assert.equal(entry.form, HARVEST_FORMS.SCHEDULE);
    const total = Object.values(entry.to[0].weights).reduce((s, v) => s + v, 0);
    assert.ok(Math.abs(total - 1) < 1e-6, `mix should sum to 1, got ${total}`);
  });

  test('step-faithful by default — a paired anchor holds the mix flat to the next age', () => {
    const anchors = harvestDecisions(allocRun([{ e: 0.9, b: 0.5, c: 0.5 }, { e: 0.2, b: 0.5, c: 0.5 }]), {
      controlsByKey: CONTROLS, birth: BIRTH,
    }).entries.find(e => e.paramKey === 'allocationGlidepath').to;
    // age 47 mix, then a twin just below 48 carrying the SAME mix (the step), then age 48.
    assert.equal(anchors.length, 3);
    assert.deepEqual(anchors[0].weights, anchors[1].weights);
    assert.ok(anchors[1].age > anchors[0].age && anchors[1].age < anchors[2].age);
  });

  test('smooth mode emits one anchor per decision instead', () => {
    const anchors = harvestDecisions(allocRun([{ e: 0.9, b: 0.5, c: 0.5 }, { e: 0.2, b: 0.5, c: 0.5 }]), {
      controlsByKey: CONTROLS, birth: BIRTH, epsilon: { allocationSmooth: true },
    }).entries.find(e => e.paramKey === 'allocationGlidepath').to;
    assert.equal(anchors.length, 2);
  });

  test('a leading anchor at the plan start age preserves the pre-run mix', () => {
    // interpolateGlidepath CLAMPS below the first anchor, so without this the
    // first MPC mix would be applied to the whole realized past.
    const anchors = harvestDecisions(allocRun([{ e: 0.2, b: 0.5, c: 0.5 }], { startYear: 2040 }), {
      controlsByKey: CONTROLS, birth: BIRTH,
      simStart: new Date(Date.UTC(2026, 0, 1)),
      baseParams: { rebalanceTargetAllocation: { EQUITY: 0.6, BOND: 0.4 } },
    }).entries.find(e => e.paramKey === 'allocationGlidepath').to;
    assert.equal(anchors[0].age, 47);                       // plan start age
    assert.deepEqual(anchors[0].weights, { EQUITY: 0.6, BOND: 0.4 });
    assert.ok(anchors[anchors.length - 1].age > 47);
  });

  test('near-identical consecutive mixes collapse (L1 ≤ ε)', () => {
    const anchors = harvestDecisions(
      allocRun([{ e: 0.5, b: 0.5, c: 0.5 }, { e: 0.502, b: 0.5, c: 0.5 }, { e: 0.5, b: 0.5, c: 0.5 }]),
      { controlsByKey: CONTROLS, birth: BIRTH, epsilon: { allocationSmooth: true } },
    ).entries.find(e => e.paramKey === 'allocationGlidepath').to;
    assert.equal(anchors.length, 1);
  });

  test('requires TARGET_ALLOCATION + allocationSchedule=GLIDEPATH', () => {
    const plan = harvestDecisions(allocRun([{ e: 0.5, b: 0.5, c: 0.5 }]), {
      controlsByKey: CONTROLS, birth: BIRTH, baseParams: { behavioralStrategies: [] },
    });
    const keys = plan.requires.map(r => r.paramKey).sort();
    assert.deepEqual(keys, ['allocationSchedule', 'behavioralStrategies']);
    assert.equal(plan.requires.find(r => r.paramKey === 'allocationSchedule').to, 'GLIDEPATH');
  });

  // ── design 61 §12.1 D5 — zeroed-class diagnostics ──
  // `allocRun` weights are raw stick-breaking inputs, so drive the mixes through
  // synthesizeTargetAllocation semantics: EQUITY takes `e`, BOND takes `b` of the
  // remainder, CASH the rest. e=1 ⇒ a pure-equity corner; e=0,b=1 ⇒ pure bond.
  const warnOf = (mixes, extra = {}) => harvestDecisions(allocRun(mixes), {
    controlsByKey: CONTROLS, birth: BIRTH, epsilon: { allocationSmooth: true }, ...extra,
  }).warnings.join(' | ');

  test('a terminal anchor that zeroes a held class is warned about (the CLAMP)', () => {
    // ... → 60/40 equity/bond → all-bond at the last anchor. The glidepath clamps
    // above its last anchor, so that becomes policy for every remaining year.
    const w = warnOf([{ e: 0.6, b: 1, c: 1 }, { e: 0.6, b: 1, c: 1 }, { e: 0, b: 1, c: 1 }]);
    assert.match(w, /FINAL anchor/);
    assert.match(w, /CLAMPS above its last anchor/);
    assert.match(w, /Equity \(60% → 0\)/);
  });

  test('a terminal anchor that holds every class is not warned about', () => {
    const w = warnOf([{ e: 0.6, b: 1, c: 1 }, { e: 0.5, b: 1, c: 1 }, { e: 0.4, b: 1, c: 1 }]);
    assert.doesNotMatch(w, /FINAL anchor/);
  });

  test('a round-trip corner is reported as INFORMATION, not as friction', () => {
    // equity 60% → 0 → 60%: the shape D5 filed, which did not measure as a defect.
    const w = warnOf([{ e: 0.6, b: 1, c: 1 }, { e: 0, b: 1, c: 1 }, { e: 0.6, b: 1, c: 1 }]);
    assert.match(w, /leaves the plan entirely/);
    assert.match(w, /Informational/);
    assert.match(w, /NOT measured as pure friction/);
    // A round trip returns, so it must NOT be reported as a terminal clamp.
    assert.doesNotMatch(w, /FINAL anchor/);
  });

  test('a class below the material floor is not treated as a position', () => {
    // 2% equity → 0 is a remnant, not a liquidation; no round-trip warning.
    const w = warnOf([{ e: 0.02, b: 1, c: 1 }, { e: 0, b: 1, c: 1 }, { e: 0.02, b: 1, c: 1 }]);
    assert.doesNotMatch(w, /leaves the plan entirely/);
  });

  test('a single-anchor bake warns about neither', () => {
    const w = warnOf([{ e: 0, b: 1, c: 1 }]);
    assert.doesNotMatch(w, /FINAL anchor/);
    assert.doesNotMatch(w, /leaves the plan entirely/);
  });
});

describe('design 39 §13.6.3 — POINT levers never collapse silently', () => {
  const xborderRun = (modes) => modes.map((m, i) => rec({
    year: 2026 + i, key: 'DRAWDOWN_XBORDER',
    candidate: { crossBorderDrawdown: m },
    vars: [{ paramKey: 'crossBorderDrawdown' }],
  }));

  test('a constant lever harvests quietly', () => {
    const plan = harvestDecisions(xborderRun(['GLOBAL', 'GLOBAL', 'GLOBAL']), { controlsByKey: CONTROLS });
    const entry = plan.entries.find(e => e.paramKey === 'crossBorderDrawdown');
    assert.equal(entry.form, HARVEST_FORMS.POINT);
    assert.equal(entry.to, 'GLOBAL');
    assert.equal(entry.varied, false);
    assert.equal(plan.warnings.length, 0);
  });

  test('a varying lever warns with the epoch counts and the frozen value', () => {
    const plan = harvestDecisions(xborderRun(['GLOBAL', 'LOCAL_FIRST', 'GLOBAL', 'LOCAL_FIRST']),
      { controlsByKey: CONTROLS });
    const entry = plan.entries.find(e => e.paramKey === 'crossBorderDrawdown');
    assert.equal(entry.to, 'LOCAL_FIRST');            // last
    assert.equal(entry.varied, true);
    assert.match(plan.warnings.join(' '), /changed in 3 of 4 epochs/);
    assert.match(plan.warnings.join(' '), /re-run will differ/);
  });

  test('the modal collapse rule picks the most-held value instead', () => {
    const plan = harvestDecisions(xborderRun(['GLOBAL', 'GLOBAL', 'GLOBAL', 'LOCAL_FIRST']),
      { controlsByKey: CONTROLS, collapse: COLLAPSE_RULES.MODAL });
    assert.equal(plan.entries.find(e => e.paramKey === 'crossBorderDrawdown').to, 'GLOBAL');
  });

  test('numeric levers report the observed range in the warning', () => {
    const records = [3, 9, 5].map((n, i) => rec({
      year: 2026 + i, key: 'BOND_LADDER',
      candidate: { bondLadderRungs: n }, vars: [{ paramKey: 'bondLadderRungs' }],
    }));
    const plan = harvestDecisions(records, { controlsByKey: CONTROLS });
    assert.equal(plan.entries.find(e => e.paramKey === 'bondLadderRungs').to, 5);
    assert.match(plan.warnings.join(' '), /range 3–9/);
  });
});

describe('design 39 §13.4 — plan assembly', () => {
  test('a multi-lever epoch routes each paramKey to its owning lever', () => {
    const r = {
      id: 'mpc:0', asOfDate: new Date(Date.UTC(2030, 0, 1)).toISOString(),
      move: 'x', result: null, runId: 'run:1',
      controlKeys: ['SPENDING', 'DRAWDOWN_XBORDER'],
      controlVars: [
        { paramKey: 'spendingExpenseBands[0].monthlyAmount', _bandIndex: 0, _controlKey: 'SPENDING' },
        { paramKey: 'crossBorderDrawdown', _controlKey: 'DRAWDOWN_XBORDER' },
      ],
      controlParams: { 'spendingExpenseBands[0].monthlyAmount': 6000, crossBorderDrawdown: 'GLOBAL' },
    };
    const plan = harvestDecisions([r], { controlsByKey: CONTROLS, birth: BIRTH });
    const byKey = Object.fromEntries(plan.entries.map(e => [e.paramKey, e]));
    assert.equal(byKey['spendingExpenseBands'].leverKey, 'SPENDING');
    assert.equal(byKey['crossBorderDrawdown'].leverKey, 'DRAWDOWN_XBORDER');
    assert.equal(byKey['spendingExpenseBands'].form, HARVEST_FORMS.SCHEDULE);
    assert.equal(byKey['crossBorderDrawdown'].form, HARVEST_FORMS.POINT);
  });

  test('an unregistered lever is reported, not silently dropped', () => {
    const r = { id: 'x', asOfDate: '2030-01-01', controlKeys: ['GONE'],
                controlVars: [{ paramKey: 'k', _controlKey: 'GONE' }], controlParams: { k: 1 } };
    const plan = harvestDecisions([r], { controlsByKey: CONTROLS });
    assert.equal(plan.entries.length, 0);
    assert.match(plan.warnings.join(' '), /no longer registered/);
  });

  test('the plan carries the run’s identity and epoch range', () => {
    const plan = harvestDecisions(spendingRun([1, 2, 3]), { controlsByKey: CONTROLS, birth: BIRTH });
    assert.equal(plan.runId, 'run:1');
    assert.equal(plan.epochs, 3);
    assert.equal(plan.epochRange[0].slice(0, 4), '2026');
    assert.equal(plan.epochRange[1].slice(0, 4), '2028');
  });

  test('records are read oldest-first regardless of input order', () => {
    const rows = spendingRun([5000, 6000, 7000]).reverse();
    const bands = harvestDecisions(rows, { controlsByKey: CONTROLS, birth: BIRTH })
      .entries.find(e => e.paramKey === 'spendingExpenseBands').to;
    assert.deepEqual(bands.map(b => b.monthlyAmount), [5000, 6000, 7000]);
  });
});

describe('design 39 §13.5 — writing into the scenario', () => {
  test('an existing param is updated in place (one store: cfg.params)', () => {
    const scenario = { params: [{ name: 'bondLadderRungs', type: 'Number', value: 5 }] };
    const plan = { entries: [{ paramKey: 'bondLadderRungs', to: 9 }], requires: [] };
    const res = applyHarvestPlan(scenario, plan);
    assert.deepEqual(res.applied, ['bondLadderRungs']);
    assert.deepEqual(res.created, []);
    assert.equal(scenario.params.length, 1);
    assert.equal(readParamValue(scenario, 'bondLadderRungs'), 9);
    assert.equal(scenario.parameters, undefined, 'must not write the second store');
  });

  test('a MISSING param is created, not silently dropped', () => {
    // The `if (p) p.value = v` idiom this replaces would have lost this write.
    const scenario = { params: [] };
    const res = applyHarvestPlan(scenario, {
      entries: [{ paramKey: 'allocationGlidepath', to: [{ age: 60, weights: { EQUITY: 1 } }] }], requires: [],
    });
    assert.deepEqual(res.created, ['allocationGlidepath']);
    assert.equal(scenario.params.length, 1);
    assert.equal(scenario.params[0].type, 'Object');
  });

  test('created schedule params get their table-editor type, not a JSON blob', () => {
    const scenario = { params: [] };
    applyHarvestPlan(scenario, {
      entries: [{ paramKey: 'spendingExpenseBands', to: [{ startAge: 60, monthlyAmount: 1 }] }], requires: [],
    });
    assert.equal(scenario.params[0].type, 'ExpenseBandList');
  });

  test('a param key matching the scenario class schema inherits its metadata', () => {
    const scenario = {
      params: [],
      scenarioClass: { getParamSchema: () => [
        { key: 'moveYear', label: 'Move Year', type: 'Number', group: 'Residency', description: 'd' },
      ] },
    };
    applyHarvestPlan(scenario, { entries: [{ paramKey: 'moveYear', to: 2031 }], requires: [] });
    assert.equal(scenario.params[0].label, 'Move Year');
    assert.equal(scenario.params[0].group, 'Residency');
  });

  test('enabling params are applied in the same pass as the values', () => {
    const scenario = { params: [
      { name: 'drawdownWeight::ira', type: 'Number', value: 0.5 },
      { name: 'drawdownStrategy',    type: 'Enum',   value: 'SEQUENTIAL' },
    ] };
    applyHarvestPlan(scenario, {
      entries:  [{ paramKey: 'drawdownWeight::ira', to: 0.1 }],
      requires: [{ paramKey: 'drawdownStrategy', from: 'SEQUENTIAL', to: 'WEIGHTED' }],
    });
    assert.equal(readParamValue(scenario, 'drawdownWeight::ira'), 0.1);
    assert.equal(readParamValue(scenario, 'drawdownStrategy'), 'WEIGHTED',
      'without this the harvested weights are inert');
  });

  test('applyRequires:false leaves the enabling params alone', () => {
    const scenario = { params: [{ name: 'drawdownStrategy', type: 'Enum', value: 'SEQUENTIAL' }] };
    applyHarvestPlan(scenario, { entries: [], requires: [{ paramKey: 'drawdownStrategy', to: 'WEIGHTED' }] },
      { applyRequires: false });
    assert.equal(readParamValue(scenario, 'drawdownStrategy'), 'SEQUENTIAL');
  });

  test('provenance is stamped on the scenario', () => {
    const scenario = { params: [] };
    const res = applyHarvestPlan(scenario, {
      runId: 'run:7', levers: ['SPENDING'], epochs: 4,
      epochRange: ['2026-01-01', '2029-01-01'],
      goal: { key: 'finalNetLiquidity', label: 'Net Liquidity' },
      entries: [], requires: [],
    });
    assert.equal(scenario.harvestedFrom.runId, 'run:7');
    assert.deepEqual(scenario.harvestedFrom.levers, ['SPENDING']);
    assert.equal(scenario.harvestedFrom.epochs, 4);
    assert.ok(scenario.harvestedFrom.date);
    assert.equal(res.provenance.goal.key, 'finalNetLiquidity');
  });

  test('an entry with no harvested value is skipped and reported', () => {
    const scenario = { params: [] };
    const res = applyHarvestPlan(scenario, { entries: [{ paramKey: 'x', to: undefined }], requires: [] });
    assert.equal(res.applied.length, 0);
    assert.equal(res.skipped.length, 1);
    assert.equal(res.skipped[0].paramKey, 'x');
  });

  test('upsert matches both param key shapes (`key` and `name`)', () => {
    const scenario = { params: [{ key: 'a', value: 1 }, { name: 'b', value: 2 }] };
    upsertParam(scenario, 'a', 10);
    upsertParam(scenario, 'b', 20);
    assert.equal(scenario.params.length, 2);
    assert.equal(readParamValue(scenario, 'a'), 10);
    assert.equal(readParamValue(scenario, 'b'), 20);
  });
});

describe('design 39 §13.2 — the decision log is the harvest source', () => {
  test('records carry runId / controlKeys / controlVars', () => {
    const graph = new Graph();
    recordDecisionRecord({
      graph, id: 'mpc:0', asOfDate: new Date(Date.UTC(2030, 0, 1)),
      controlParams: { a: 1 }, runId: 'run:9', controlKeys: ['SPENDING'],
      controlVars: [{ paramKey: 'a', _controlKey: 'SPENDING' }],
    });
    const [r] = readDecisionRecords(graph);
    assert.equal(r.runId, 'run:9');
    assert.deepEqual(r.controlKeys, ['SPENDING']);
    assert.equal(r.controlVars[0].paramKey, 'a');
    assert.deepEqual(r.controlParams, { a: 1 });
  });

  test('readDecisionRecords filters to one run', () => {
    const graph = new Graph();
    const mk = (id, runId, y) => recordDecisionRecord({
      graph, id, runId, asOfDate: new Date(Date.UTC(y, 0, 1)), controlParams: {} });
    mk('a', 'run:1', 2030); mk('b', 'run:2', 2031); mk('c', 'run:1', 2032);
    assert.deepEqual(readDecisionRecords(graph, { runId: 'run:1' }).map(r => r.id), ['a', 'c']);
  });

  test('readDecisionRuns groups by run, newest activity first', () => {
    const graph = new Graph();
    const mk = (id, runId, y, keys) => recordDecisionRecord({
      graph, id, runId, asOfDate: new Date(Date.UTC(y, 0, 1)), controlParams: {}, controlKeys: keys });
    mk('a', 'run:1', 2030, ['SPENDING']);
    mk('b', 'run:1', 2031, ['SPENDING']);
    mk('c', 'run:2', 2040, ['ROTH']);
    const runs = readDecisionRuns(graph);
    assert.deepEqual(runs.map(r => r.runId), ['run:2', 'run:1']);
    assert.equal(runs[1].epochs, 2);
    assert.deepEqual(runs[1].levers, ['SPENDING']);
  });

  test('unstamped legacy records collect under a null run, sorted last', () => {
    const graph = new Graph();
    recordDecisionRecord({ graph, id: 'old', asOfDate: new Date(Date.UTC(2050, 0, 1)), controlParams: {} });
    recordDecisionRecord({ graph, id: 'new', runId: 'run:1', asOfDate: new Date(Date.UTC(2030, 0, 1)), controlParams: {} });
    assert.deepEqual(readDecisionRuns(graph).map(r => r.runId), ['run:1', null]);
  });

  test('records survive a reload via their OWN storage — never fin-sim-scenarios', () => {
    const saved = [];
    const storage = { load: () => ({ records: saved[0]?.records ?? [] }), save: (d) => { saved[0] = d; } };
    const g1 = new Graph();
    const reg1 = new DecisionRecordRegistry(storage, g1);
    recordDecisionRecord({ graph: g1, id: 'mpc:0', runId: 'run:1',
      asOfDate: new Date(Date.UTC(2030, 0, 1)), controlParams: { a: 1 },
      controlKeys: ['SPENDING'], controlVars: [{ paramKey: 'a' }] });
    reg1.persist();

    // A fresh session re-hydrates the layer from storage.
    const g2 = new Graph();
    new DecisionRecordRegistry(storage, g2);
    const [r] = readDecisionRecords(g2);
    assert.equal(r.id, 'mpc:0');
    assert.equal(r.runId, 'run:1');
    assert.equal(g2.byLayer('scenario').length, 0, 'must never enter the scenario layer');
  });

  test('clearRun drops one run and keeps the others', () => {
    const graph = new Graph();
    const storage = { load: () => ({ records: [] }), save: () => {} };
    const reg = new DecisionRecordRegistry(storage, graph);
    for (const [id, runId] of [['a', 'r1'], ['b', 'r2']]) {
      recordDecisionRecord({ graph, id, runId, asOfDate: new Date(Date.UTC(2030, 0, 1)), controlParams: {} });
    }
    reg.clearRun('r1');
    assert.deepEqual(readDecisionRecords(graph).map(r => r.id), ['b']);
  });
});

describe('design 39 §13 — shared helpers', () => {
  test('collapseConsecutive drops within-ε neighbours only', () => {
    const pts = [{ key: 1, value: 10 }, { key: 2, value: 10.5 }, { key: 3, value: 20 }, { key: 4, value: 20 }];
    const out = collapseConsecutive(pts, (a, b) => Math.abs(a - b), 1);
    assert.deepEqual(out.map(p => p.key), [1, 3]);
  });

  test('ageAt respects the birthday within the year', () => {
    assert.equal(ageAt('1978-04-15', '2026-01-01'), 47);
    assert.equal(ageAt('1978-04-15', '2026-04-15'), 48);
    assert.equal(ageAt('1978-04-15', '2026-12-31'), 48);
    assert.equal(ageAt(null, '2026-01-01'), null);
  });

  test('pointHarvest is exported for direct use by future levers', () => {
    const out = pointHarvest({ epochs: [
      { candidate: { k: 1 }, vars: [{ paramKey: 'k' }] },
      { candidate: { k: 2 }, vars: [{ paramKey: 'k' }] },
    ] });
    assert.equal(out.form, HARVEST_FORMS.POINT);
    assert.equal(out.params.k, 2);
    assert.equal(out.warnings.length, 1);
  });
});

describe('design 39 §13.6.6 — RESOLVE: the best static value for the whole run', () => {
  const spendingPlan = () => harvestDecisions(spendingRun([5000, 6000]), {
    controlsByKey: CONTROLS, birth: BIRTH,
  });

  /** A solver stub that records what it was asked and returns a fixed best. */
  function stubSolver(best) {
    const seen = {};
    return {
      seen,
      makeSolver: () => ({
        solve: async (problem, opts) => {
          seen.problem = problem;
          seen.start   = opts.start;
          return { best: { candidate: best, score: 42 }, candidates: [], evaluations: 7 };
        },
      }),
    };
  }

  test('only POINT levers are re-solved; SCHEDULE bakes are left alone', async () => {
    const plan = harvestDecisions([
      ...spendingRun([5000, 6000]),
      ...['GLOBAL', 'LOCAL_FIRST'].map((m, i) => rec({
        year: 2026 + i, key: 'DRAWDOWN_XBORDER',
        candidate: { crossBorderDrawdown: m }, vars: [{ paramKey: 'crossBorderDrawdown' }],
      })),
    ], { controlsByKey: CONTROLS, birth: BIRTH });

    const s = stubSolver({ crossBorderDrawdown: 'GLOBAL' });
    const out = await resolveStaticLevers({
      plan, controlsByKey: CONTROLS, baseParams: {},
      simStart: new Date(Date.UTC(2026, 0, 1)), simEnd: new Date(Date.UTC(2046, 0, 1)),
      makeSolver: s.makeSolver,
    });
    assert.deepEqual(Object.keys(out.params), ['crossBorderDrawdown']);
    assert.equal(out.entries[0].form, HARVEST_FORMS.RESOLVE);
    // The spending schedule is untouched by the resolve.
    assert.ok(!('spendingExpenseBands' in out.params));
  });

  test('the MPC’s committed values are the warm start', async () => {
    const plan = harvestDecisions(
      [3, 9, 5].map((n, i) => rec({ year: 2026 + i, key: 'BOND_LADDER',
        candidate: { bondLadderRungs: n }, vars: [{ paramKey: 'bondLadderRungs' }] })),
      { controlsByKey: CONTROLS });
    const s = stubSolver({ bondLadderRungs: 7 });
    await resolveStaticLevers({
      plan, controlsByKey: CONTROLS,
      simStart: new Date(Date.UTC(2026, 0, 1)), simEnd: new Date(Date.UTC(2046, 0, 1)),
      makeSolver: s.makeSolver,
    });
    assert.deepEqual(s.seen.start, { bondLadderRungs: 5 }, 'warm-started from the last committed value');
  });

  test('the solve runs from t₀ (open-loop), not from a snapshot', async () => {
    const plan = harvestDecisions(
      [rec({ year: 2026, key: 'BOND_LADDER', candidate: { bondLadderRungs: 4 },
             vars: [{ paramKey: 'bondLadderRungs' }] })], { controlsByKey: CONTROLS });
    const s = stubSolver({ bondLadderRungs: 4 });
    await resolveStaticLevers({
      plan, controlsByKey: CONTROLS,
      simStart: new Date(Date.UTC(2026, 0, 1)), simEnd: new Date(Date.UTC(2046, 0, 1)),
      makeSolver: s.makeSolver,
    });
    assert.equal(s.seen.problem.initialState.kind, 'compile',
      'a whole-run static value is an open-loop question, not a from-now one');
  });

  test('schedule bakes are folded into baseParams BEFORE resolving', () => {
    const plan = spendingPlan();
    const folded = foldScheduleBakes({ inflationRate: 0.03 }, plan);
    assert.equal(folded.inflationRate, 0.03);
    assert.deepEqual(folded.spendingExpenseBands.map(b => b.monthlyAmount), [5000, 6000]);
  });

  test('mergeResolved swaps the POINT rows for RESOLVE rows, keeping the rest', () => {
    const plan = harvestDecisions([
      ...spendingRun([5000]),
      rec({ year: 2026, key: 'BOND_LADDER', candidate: { bondLadderRungs: 4 },
            vars: [{ paramKey: 'bondLadderRungs' }] }),
    ], { controlsByKey: CONTROLS, birth: BIRTH });
    const merged = mergeResolved(plan, {
      entries: [{ paramKey: 'bondLadderRungs', form: HARVEST_FORMS.RESOLVE, to: 11 }],
      warnings: ['note'], score: 1, evaluations: 3,
    });
    const byKey = Object.fromEntries(merged.entries.map(e => [e.paramKey, e]));
    assert.equal(byKey['bondLadderRungs'].to, 11);
    assert.equal(byKey['bondLadderRungs'].form, HARVEST_FORMS.RESOLVE);
    assert.equal(byKey['spendingExpenseBands'].form, HARVEST_FORMS.SCHEDULE);
    assert.ok(merged.warnings.includes('note'));
  });

  test('a plan with no POINT levers resolves to nothing, with a note', async () => {
    const out = await resolveStaticLevers({ plan: spendingPlan(), controlsByKey: CONTROLS });
    assert.deepEqual(out.entries, []);
    assert.match(out.warnings.join(' '), /every lever baked as a schedule/);
  });
});

describe('design 39 §13 — the controller must not mutate the caller’s params', () => {
  test('committing a nested path does NOT rewrite the scenario’s band table', async () => {
    const { CockpitController } = await import('../../src/finance/mpc/cockpit-controller.js');
    // The exact shape the cockpit passes: a flat map whose VALUES are the live
    // scenario's arrays. A spread would share them, so `set()` on a nested path
    // would rewrite the active scenario in place — outside actuate/harvest.
    const bands = [{ startAge: 45, monthlyAmount: 9000 }];
    const scenarioParams = { spendingStrategy: ['EXPLICIT_BANDS'], spendingExpenseBands: bands };

    const c = new CockpitController({
      simStart: new Date(Date.UTC(2026, 0, 1)),
      simEnd:   new Date(Date.UTC(2050, 0, 1)),
      baseParams: scenarioParams,
    });
    c.setSnapshot({ date: new Date(Date.UTC(2041, 0, 1)), state: {}, queue: [] });
    // Simulate what apply() commits, without paying for a rollout.
    const { set } = await import('../../src/finance/monte-carlo/mc-param-paths.js');
    set(c.committed, 'spendingExpenseBands[0].monthlyAmount', 3000);

    assert.equal(bands[0].monthlyAmount, 9000, 'the caller’s array is untouched');
    assert.equal(scenarioParams.spendingExpenseBands[0].monthlyAmount, 9000);
    assert.equal(c.committed.spendingExpenseBands[0].monthlyAmount, 3000, 'the controller owns its copy');
    assert.equal(c.baseParams.spendingExpenseBands[0].monthlyAmount, 9000, 'the pre-run reference is preserved');
  });
});
