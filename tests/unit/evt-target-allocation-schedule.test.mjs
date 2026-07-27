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
 * evt-target-allocation-schedule.test.mjs — design 61 Phase 3 (Lever B, time variation).
 *
 * The target mix varies over the plan via `allocationSchedule`:
 *   - STATIC       — one mix (back-compat; already covered elsewhere);
 *   - GLIDEPATH    — interpolate {age, weights} anchors by the primary's age;
 *   - REGIME_CONDITIONED — a distinct mix per active economic-regime tag, reverting
 *     when the regime clears.
 * Drives the real RebalanceToTargetReducer.resolveScheduledTarget + reduce pipeline.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import {
  RebalanceToTargetReducer, ALLOCATION_SCHEDULE,
  interpolateGlidepath, resolveRegimeTarget, ageAsOf,
} from '../../src/finance/behavioral/rebalance-to-target-reducer.js';
import { RebalanceToTargetApplyReducer } from '../../src/finance/behavioral/rebalance-to-target-apply-reducer.js';
import { ACCOUNT_ROLES } from '../../src/finance/state/account-roles.js';
import { ALLOCATION }    from '../../src/finance/holdings/allocation.js';
import { REGIME_TAG }    from '../../src/finance/economic-regimes/regime-tag.js';

const near = (a, b, e = 1e-3) => Math.abs(a - b) <= e;
const sum  = o => Object.values(o).reduce((s, v) => s + v, 0);

// ── Pure resolvers ───────────────────────────────────────────────────────────

test('SCHED-1: glidepath clamps below the first / above the last anchor', () => {
  const anchors = [{ age: 50, weights: { EQUITY: 0.8, BOND: 0.2 } },
                   { age: 75, weights: { EQUITY: 0.4, BOND: 0.6 } }];
  assert.deepStrictEqual(interpolateGlidepath(anchors, 40), { EQUITY: 0.8, BOND: 0.2 });
  assert.deepStrictEqual(interpolateGlidepath(anchors, 90), { EQUITY: 0.4, BOND: 0.6 });
});

test('SCHED-2: glidepath interpolates linearly between anchors and stays on the simplex', () => {
  const anchors = [{ age: 50, weights: { EQUITY: 0.8, BOND: 0.2 } },
                   { age: 70, weights: { EQUITY: 0.4, BOND: 0.6 } }];
  const mid = interpolateGlidepath(anchors, 60);   // halfway
  assert.ok(near(mid.EQUITY, 0.6), `equity mid: ${mid.EQUITY}`);
  assert.ok(near(mid.BOND,   0.4), `bond mid: ${mid.BOND}`);
  assert.ok(near(sum(mid), 1));
  // Monotonic glide: equity share strictly decreases with age.
  assert.ok(interpolateGlidepath(anchors, 55).EQUITY > interpolateGlidepath(anchors, 65).EQUITY);
});

test('SCHED-3: glidepath falls back when unconfigured; ageAsOf matches the birthday convention', () => {
  const fb = { EQUITY: 0.6, BOND: 0.4 };
  assert.strictEqual(interpolateGlidepath(null, 60, fb), fb);
  assert.strictEqual(interpolateGlidepath([], 60, fb), fb);
  assert.strictEqual(ageAsOf(new Date(Date.UTC(1978, 3, 15)), Date.UTC(2030, 3, 14)), 51); // day before b'day
  assert.strictEqual(ageAsOf(new Date(Date.UTC(1978, 3, 15)), Date.UTC(2030, 3, 15)), 52); // on b'day
});

test('SCHED-4: regime target picks the active tag, reverts to NORMAL, and honors priority', () => {
  const rt = {
    NORMAL:             { EQUITY: 0.6, BOND: 0.4 },
    ECONOMIC_STRESS:    { EQUITY: 0.3, BOND: 0.3, CASH: 0.2, GOLD: 0.2 },
    PANIC_SELL_TRIGGER: { EQUITY: 0.1, CASH: 0.9 },
  };
  assert.deepStrictEqual(resolveRegimeTarget(rt, [], null), { EQUITY: 0.6, BOND: 0.4 });
  assert.deepStrictEqual(resolveRegimeTarget(rt, [{ tags: [REGIME_TAG.ECONOMIC_STRESS] }], null),
    { EQUITY: 0.3, BOND: 0.3, CASH: 0.2, GOLD: 0.2 });
  // ECONOMIC_STRESS outranks PANIC_SELL_TRIGGER when both are active.
  assert.deepStrictEqual(
    resolveRegimeTarget(rt, [{ tags: [REGIME_TAG.PANIC_SELL_TRIGGER, REGIME_TAG.ECONOMIC_STRESS] }], null),
    { EQUITY: 0.3, BOND: 0.3, CASH: 0.2, GOLD: 0.2 });
  // Unconfigured → fallback.
  assert.strictEqual(resolveRegimeTarget(null, [], 'FB'), 'FB');
});

// ── End-to-end through the reducer ────────────────────────────────────────────

function scheduledTarget(opts, state, action = { type: 'US_PERIOD_ADVANCE' }) {
  return new RebalanceToTargetReducer(opts).resolveScheduledTarget(state, action);
}

const peopleState = (birthYear, extra = {}) => ({
  people: { p1: { birthDate: new Date(Date.UTC(birthYear, 0, 1)), residency: 'US' } },
  currentPeriods: { US: { startMs: Date.UTC(2030, 0, 1) }, AU: { startMs: Date.UTC(2030, 0, 1) } },
  activeRegimes: [], regimeActions: {},
  ...extra,
});

test('SCHED-5: reducer resolves the GLIDEPATH target from the primary\'s age', () => {
  const opts = {
    accounts: [], scheduleMode: ALLOCATION_SCHEDULE.GLIDEPATH,
    glidepath: [{ age: 50, weights: { EQUITY: 0.8, BOND: 0.2 } },
                { age: 70, weights: { EQUITY: 0.4, BOND: 0.6 } }],
    targetAllocation: { EQUITY: 0.6, BOND: 0.4 },
  };
  // Born 1970 → age 60 as of 2030-01-01 → halfway → 0.6/0.4.
  const t = scheduledTarget(opts, peopleState(1970));
  assert.ok(near(t.EQUITY, 0.6) && near(t.BOND, 0.4), JSON.stringify(t));
});

test('SCHED-6: reducer resolves REGIME_CONDITIONED and reverts when the regime clears', () => {
  const opts = {
    accounts: [], scheduleMode: ALLOCATION_SCHEDULE.REGIME_CONDITIONED,
    regimeTargets: { NORMAL: { EQUITY: 0.6, BOND: 0.4 },
                     ECONOMIC_STRESS: { EQUITY: 0.3, BOND: 0.3, CASH: 0.2, GOLD: 0.2 } },
    targetAllocation: { EQUITY: 0.6, BOND: 0.4 },
  };
  const calm   = scheduledTarget(opts, peopleState(1970));
  const stress = scheduledTarget(opts, peopleState(1970, { activeRegimes: [{ shockId: 's1', tags: [REGIME_TAG.ECONOMIC_STRESS] }] }));
  assert.ok(near(calm.EQUITY, 0.6), 'NORMAL mix when calm');
  assert.ok(near(stress.EQUITY, 0.3) && near(stress.CASH, 0.2), 'stress mix under ECONOMIC_STRESS');
  // Revert: regime clears → back to NORMAL.
  assert.deepStrictEqual(scheduledTarget(opts, peopleState(1970)), calm);
});

test('SCHED-7: STATIC (default) is unchanged and ignores age/regime', () => {
  const opts = { accounts: [], targetAllocation: { EQUITY: 0.7, BOND: 0.3 } };  // scheduleMode defaults STATIC
  const t = scheduledTarget(opts, peopleState(1970, { activeRegimes: [{ tags: [REGIME_TAG.ECONOMIC_STRESS] }] }));
  assert.deepStrictEqual(t, { EQUITY: 0.7, BOND: 0.3 });
});

test('SCHED-8: GLIDEPATH end-to-end — an older primary holds less equity after rebalance', () => {
  const apply = new RebalanceToTargetApplyReducer();
  const glidepath = [{ age: 50, weights: { EQUITY: 0.8, BOND: 0.2 } },
                     { age: 80, weights: { EQUITY: 0.2, BOND: 0.8 } }];
  const runFor = (birthYear) => {
    const state = peopleState(birthYear, {
      iraAccount: { balance: 100000, role: ACCOUNT_ROLES.IRA, holdings: [
        { id: 'e0', allocation: ALLOCATION.EQUITY, marketValue: 100000, costBasis: 80000 }] },
    });
    const reducer = new RebalanceToTargetReducer({
      accounts: [{ stateKey: 'iraAccount', role: ACCOUNT_ROLES.IRA }],
      scheduleMode: ALLOCATION_SCHEDULE.GLIDEPATH, glidepath,
      targetAllocation: { EQUITY: 0.6, BOND: 0.4 }, driftBandSheltered: 0.02,
    });
    const res = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });
    let next = state; for (const a of (res.next ?? [])) next = apply.reduce(next, a);
    const hs = next.iraAccount.holdings; const tot = hs.reduce((s, h) => s + h.marketValue, 0);
    return hs.filter(h => h.allocation === ALLOCATION.EQUITY).reduce((s, h) => s + h.marketValue, 0) / tot;
  };
  const youngEquity = runFor(1975);  // age 55 → ~0.7 equity
  const oldEquity   = runFor(1955);  // age 75 → ~0.3 equity
  assert.ok(youngEquity > oldEquity + 0.2, `young ${youngEquity.toFixed(2)} should hold much more equity than old ${oldEquity.toFixed(2)}`);
});
