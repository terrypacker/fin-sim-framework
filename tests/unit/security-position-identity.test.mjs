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
 * security-position-identity.test.mjs — design 94 §11's FOURTH walk, step 5's gate.
 *
 * ── the rule ─────────────────────────────────────────────────────────────────
 *
 * **No reducer may change a position's `securityId` in place.**
 *
 * A position is a position IN something. Changing what it is in, while keeping its id, its
 * basis and its acquisition date, silently relabels history: the lot still says it was
 * bought in 2028 at that basis, but it now claims to have been a different instrument the
 * whole time. Every downstream question — §1091 substantial identity, specific
 * identification (§8.3), per-security reporting — reads the CURRENT id against a HISTORIC
 * basis, so the two disagree with no evidence left that they ever agreed.
 *
 * It is the equity analogue of the par desync design 93 chased for eight defects, and it
 * has the same signature: **every number is conserved**. A relabelled lot is worth exactly
 * what it was worth, so no balance invariant, no golden total and no unit walk sees it.
 *
 * A merger or an exchange that genuinely replaces one security with another is a
 * DISPOSAL AND AN ACQUISITION (§7) — two lots, two dates, a realised gain if the country
 * says so — not a field write.
 *
 * ── how it is checked ────────────────────────────────────────────────────────
 *
 * Reducer instances are wrapped and the before/after states compared per lot, so the
 * reducer NAMED is the one that made the change rather than every reducer that ran
 * afterwards — the same reporting discipline as `equity-position-birth.test.mjs`, and for
 * the same diagnostic reason.
 *
 * Two directions count as a change and one does not:
 *   - `sec-a` → `sec-b`, and `sec-a` → absent, are violations.
 *   - absent → `sec-a` is a BIRTH being completed, which is the other walk's subject.
 *
 * Run against `two-security-concentration` above all, because it is the only golden whose
 * lots name authored securities — everywhere else every equity lot names the synthetic for
 * its own market, so a relabelling reducer would have to move a lot between MARKETS to be
 * visible at all.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { ServiceRegistry }  from '../../src/services/service-registry.js';
import { BaseScenario }     from '../../src/scenarios/base-scenario.js';
import { ScenarioLoader }   from '../../src/scenarios/scenario-loader.js';
import { specByName }       from '../helpers/golden-specs.js';
import { buildGoldenCfg }   from '../helpers/golden-harness.js';

/** `account.lotId → securityId` for every holding that has one. */
function positions(state) {
  const out = new Map();
  for (const [k, a] of Object.entries(state ?? {})) {
    if (!a || typeof a !== 'object' || !Array.isArray(a.holdings)) continue;
    for (const h of a.holdings) {
      if (!h?.id) continue;
      out.set(`${k}.${h.id}`, h.securityId ?? null);
    }
  }
  return out;
}

function runWalk(name) {
  const spec = specByName(name);
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  const cfg      = buildGoldenCfg(spec);
  const scenario = new BaseScenario({
    context:      services.simulationContext,
    initialState: cfg.initialState ?? {},
    simStart:     new Date(cfg.simStart),
    simEnd:       new Date(cfg.simEnd),
  });
  scenario.buildSim({ telemetry: 'off' });
  new ScenarioLoader().load(cfg, services);

  const changes = new Map();
  // Instances, not `Reducer.prototype`: every subclass shadows `reduce`, so a prototype
  // patch would observe nothing.
  for (const r of services.reducerService.getAll()) {
    const orig = r.reduce.bind(r);
    const name = r.constructor.type ?? r.constructor.name;
    r.reduce = (state, action, date) => {
      const before = positions(state);
      const out    = orig(state, action, date);
      for (const [key, after] of positions(out?.state ?? out)) {
        const was = before.get(key);
        if (was === undefined) continue;        // a BIRTH — the other walk's subject
        if (was === null || was === after) continue;
        const id = `${name}|${was}->${after}`;
        if (!changes.has(id)) changes.set(id, { reducer: name, key, was, now: after, hits: 0 });
        changes.get(id).hits++;
      }
      return out;
    };
  }

  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  try { scenario.sim.stepTo(new Date(cfg.simEnd)); }
  finally { console.log = log; console.warn = warn; }

  return { changes: [...changes.values()], state: scenario.sim.state };
}

// Every golden, because the relabelling risk lives in whichever paths a scenario runs —
// the rebalancer's buy, a bequest's inherited lot, a partial sale's remainder, a
// residency change rewriting cost bases across a whole book.
const GOLDENS = ['two-security-concentration', 'cross-border-reference',
                 'cross-border-disposals', 'us-single-homeowner', 'au-single-homeowner',
                 'bond-par-conservation'];

for (const goldenName of GOLDENS) {
describe(`a position's security is immutable — ${goldenName} (design 94 §11)`, () => {
  const result = runWalk(goldenName);

  test('no reducer relabels a position', () => {
    assert.deepEqual(
      result.changes, [],
      'a position was moved to a different security in place:\n'
      + result.changes.map(c =>
          `    ${c.reducer}: ${c.key} ${c.was} → ${c.now} (${c.hits}x)`).join('\n')
      + '\n\n  A position is a position IN something. A merger or exchange that genuinely\n'
      + '  replaces one security with another is a DISPOSAL AND AN ACQUISITION (§7), not a\n'
      + '  field write — the basis and the acquisition date have to move with it.\n');
  });
});
}

/**
 * The other half of step 5: the golden has to actually REACH the per-security path, or the
 * walk above is a walk over nothing. These read the committed end state rather than the
 * fixture file, so they say what the fixture MEANS.
 */
describe('the step-5 golden reaches the per-security path (design 94 §11)', () => {
  const { state } = runWalk('two-security-concentration');

  const lot = (k, id) => state[k].holdings.find(h => h.id === id);

  test('one security, two accounts, two DIFFERENT prices — §4 D4 made observable', () => {
    // The decision this golden exists to make checkable. `sec-emp` is one instrument; the
    // brokerage and the 401(k) hold it at their own prices because each is priced off its
    // own design 55 §8 per-account rate. A shared price on the security would collapse
    // these two numbers into one and delete that feature silently.
    const brokerage = lot('usStockAccount', 'h-us-equity');
    const k401      = lot('k401Account',    'h-401k-equity');
    assert.equal(brokerage.securityId, 'sec-emp');
    assert.equal(k401.securityId,      'sec-emp');
    assert.notEqual(brokerage.pricePerUnit, k401.pricePerUnit);
  });

  test('the concentrated position separated from its own sleeve', () => {
    // β 1.35 + 35% idio vol against β 1.0 / σ 0 on the same market. If the overlay were
    // not reaching the growth path both would sit at the same multiple of their start.
    const emp = lot('usStockAccount', 'h-us-equity');
    const au  = state.auStockAccount.holdings[0];
    assert.equal(au.securityId, 'sec-auto-EQUITY_AU', 'the AU lot stays on its synthetic');
    assert.ok(Math.abs(emp.pricePerUnit - au.pricePerUnit) > 1,
      'the concentrated position is tracking its sleeve exactly — the overlay is inert');
  });

  test('the overlay is PUBLISHED in state, and only for the authored securities', () => {
    const ids = Object.keys(state.securityReturnOverlay ?? {}).sort();
    assert.deepEqual(ids, ['sec-emp', 'sec-exus'],
      'the four synthetic market securities are identities and must never appear here');
  });

  test('D10, both branches: a UNANIMOUS sleeve buys more of its security', () => {
    // The 401(k)'s equity sleeve is one security, so the lot the rebalancer establishes
    // there is a position in THAT security — a rebalance buy is "more of the same thing".
    const bought = state.k401Account.holdings.filter(h => h.id.startsWith('reb-') && h.allocation === 'EQUITY');
    assert.ok(bought.length > 0, 'the rebalancer never bought equity in the 401(k)');
    for (const h of bought) assert.equal(h.securityId, 'sec-emp');
  });

  test('D10, both branches: a MIXED sleeve buys the generic market position', () => {
    // The brokerage's equity sleeve holds `sec-emp` AND `sec-exus`. There is no honest
    // answer to "more of which?", so the buy establishes the synthetic market security
    // rather than an arbitrary sibling's — which is what makes the branch above meaningful
    // rather than "the rebalancer copies whatever it finds first".
    const bought = state.usStockAccount.holdings.filter(h => h.id.startsWith('reb-') && h.allocation === 'EQUITY');
    assert.ok(bought.length > 0, 'the rebalancer never bought equity in the brokerage');
    for (const h of bought) assert.equal(h.securityId, 'sec-auto-EQUITY_US');
  });

  test('unanimity is judged on the INSTRUMENT — step 6', () => {
    // `h-401k-equity` carries NO inline `dividendYield`; `sec-emp`, which it names, pays
    // 0.006. Judged as records the sleeve agrees on "nothing" and the new lot would be
    // established paying nothing; judged as instruments it agrees on 0.006. This is the
    // observable half of D10's collapse: one security answered a question that used to be
    // asked field by field of the records.
    const bought = state.k401Account.holdings.find(h => h.id.startsWith('reb-') && h.allocation === 'EQUITY');
    assert.equal(bought.dividendYield, 0.006);
  });

  test('the registry survived the run frozen and complete', () => {
    assert.equal(Object.keys(state.securities).length, 6);   // 4 synthetic + 2 authored
    assert.ok(Object.isFrozen(state.securities['sec-emp']));
    assert.equal(state.securities['sec-emp'].idioVol, 0.35);
  });
});
