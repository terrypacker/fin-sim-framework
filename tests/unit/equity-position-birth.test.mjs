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
 * equity-position-birth.test.mjs — design 94 §9.5c, step 3's gate.
 *
 * ── the finding this exists for ──────────────────────────────────────────────
 *
 * Step 0's spike unitised equity at the config→run boundary and the whole suite stayed
 * green with the book HALF CONVERTED: in `us-single-homeowner`, `iraAccount.holdings.0`
 * gained a unit count while `iraAccount.holdings.6` — a lot created during the run —
 * did not. One account, two representations.
 *
 * Nothing caught it, and nothing could: a scalar lot and a unitised lot of the same value
 * are worth the same money, so every golden, every balance invariant and every par walk
 * agrees. What breaks is only what reads the COUNT — `split()` cannot act on a lot with no
 * units, per-share reporting disagrees between lots in one account, and design 94 §8.3's
 * specific identification has nothing to identify.
 *
 * So "flip equity from scalar to unitised" is two changes, not one: **promote at the
 * config→run boundary AND establish units at every lot BIRTH site.** Design 93's
 * two-modes-are-both-first-class rule makes mixed mode legal; this test makes it
 * TRANSITIONAL rather than the resting state.
 *
 * ── what it asserts ──────────────────────────────────────────────────────────
 *
 * 1. Every EQUITY position in the final state carries a unit count and names a security.
 * 2. No reducer BIRTHS a scalar equity lot — reported as the transition (absent going in,
 *    present-and-scalar coming out), so the reducer named is the one that created it
 *    rather than every reducer that ran afterwards.
 *
 * (2) is what makes a failure diagnosable; (1) is what makes it unfalsifiable — a lot
 * born scalar and later repaired by something else still leaves the count wrong, and only
 * the end-state walk sees that.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { ServiceRegistry }  from '../../src/services/service-registry.js';
import { BaseScenario }     from '../../src/scenarios/base-scenario.js';
import { ScenarioLoader }   from '../../src/scenarios/scenario-loader.js';
import { specByName }       from '../helpers/golden-specs.js';
import { buildGoldenCfg }   from '../helpers/golden-harness.js';

/** Every EQUITY holding in a state, keyed `account.lotId`. */
function equityLots(state) {
  const out = new Map();
  for (const [k, a] of Object.entries(state ?? {})) {
    if (!a || typeof a !== 'object' || !Array.isArray(a.holdings)) continue;
    for (const h of a.holdings) {
      if (h?.allocation !== 'EQUITY') continue;
      out.set(`${k}.${h.id}`, h);
    }
  }
  return out;
}

/**
 * Why a lot is not a position: a missing count, a missing instrument, a par it cannot have,
 * or none of those.
 *
 * The par check is not decoration. Equity has no par, and `faceValue` is authoritative
 * twice over in this engine — `BondPriceAdjustReducer` pulls a price TOWARD it every period
 * and `BondMaturityReducer` redeems AT it — so a share position carrying one is handing two
 * bond reducers and `_syncBalance`'s ghost-par sweep a target to converge shares onto. It
 * caught a real one: `consumeHoldings` derived the remainder's par as `units x (parPerUnit
 * ?? 0)`, which was unreachable while equity was scalar and stamped `faceValue: 0` on every
 * partly-sold share lot the moment it was not.
 */
function defect(h) {
  if (h.units == null)      return 'scalar (no `units`)';
  if (h.securityId == null) return 'no `securityId`';
  if (h.parPerUnit != null) return 'carries a `parPerUnit` — equity has no par';
  if (h.faceValue != null)  return 'carries a `faceValue` — equity has no par';
  return null;
}

function runWalk(spec) {
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

  const births = new Map();
  // Wrap INSTANCES, not Reducer.prototype: every subclass shadows `reduce`, so a
  // prototype patch observes nothing (the note bond-par-conservation.test.mjs carries).
  for (const r of services.reducerService.getAll()) {
    const orig = r.reduce.bind(r);
    const name = r.constructor.type ?? r.constructor.name;
    r.reduce = (state, action) => {
      const before = equityLots(state);
      const out    = orig(state, action);
      for (const [key, h] of equityLots(out?.state ?? out)) {
        // Only lots that did not exist going in — a BIRTH, not every reducer that
        // subsequently ran over one somebody else created.
        if (before.has(key)) continue;
        const why = defect(h);
        if (why == null) continue;
        const id = `${name}|${why}`;
        if (!births.has(id)) births.set(id, { reducer: name, why, key, lots: 0 });
        births.get(id).lots++;
      }
      return out;
    };
  }

  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  try { scenario.sim.stepTo(new Date(cfg.simEnd)); }
  finally { console.log = log; console.warn = warn; }

  const final = equityLots(scenario.sim.state);
  const stragglers = [];
  for (const [key, h] of final) {
    const why = defect(h);
    if (why != null) stragglers.push({ key, why, marketValue: h.marketValue });
  }
  return { births: [...births.values()], stragglers, total: final.size, lots: final,
           securities: scenario.sim.state.securities };
}

/**
 * §11's fifth walk, in the engine — the e2e version design 94 said becomes runnable here.
 *
 * §9.5b measured the defect under step 0's spike: `cross-border-reference` paid and
 * REINVESTED $22,595 of AU dividends into `auStockAccount.holdings.0`, and that lot
 * finished the run holding **exactly the 600 units it was promoted with at boot**, with
 * `pricePerUnit` inflated to 1037.87. Every dollar of reinvested dividend had raised the
 * price of the units already held instead of buying more, because `_patchHolding` routed
 * the credit through `reprice`. Market value was right to the cent, so 5,505 tests saw
 * nothing.
 *
 * Step 2a's `valueKind` discriminator fixed the routing but could not be tested end to end
 * while equity was scalar — on a scalar lot a PRICE move and a UNITS move are the same
 * operation, which is exactly why step 2a moved no golden. Step 3 unitises equity, so the
 * two are now distinguishable and this is the assertion that distinguishes them.
 */
describe('a reinvested dividend buys UNITS — design 94 §9.5b, closed', () => {
  const result = runWalk(specByName('cross-border-reference'));

  test('the AU stock lot ends the run holding more units than it was promoted with', () => {
    const lot = [...result.lots.entries()].find(([k]) => k.startsWith('auStockAccount.'))?.[1];
    assert.ok(lot, 'the golden must still hold an AU stock position');
    // $60,000 at the PAR_PER_UNIT convention (§9.2) is where it starts.
    assert.ok(lot.units > 600,
      `the unit count is still ${lot.units} — a reinvested dividend is being routed through `
      + 'reprice() again, which conserves the money and so fails no other test in the repo');
    assert.ok(result.total > 0);
  });
});

// Every golden, because the birth sites differ by scenario: the rebalancer only fires
// where a target mix is authored, the reinvestment vintage path only where a dividend is
// paid, and a bequest-created account only where somebody dies.
const GOLDENS = ['us-single-homeowner', 'au-single-homeowner', 'cross-border-reference',
                 'cross-border-disposals', 'au-super-streams', 'payroll-limits',
                 'speculative-stake', 'speculative-conversion',
                 'bond-par-conservation', 'tips-ladder-conservation',
                 // Step 5's golden: the only one whose lots name AUTHORED securities, so
                 // it is the only one where `promoteToUnitised`'s "an authored securityId
                 // is never overwritten" branch is under CI.
                 'two-security-concentration'];

for (const goldenName of GOLDENS) {
describe(`equity positions — ${goldenName} (design 94 §9.5c)`, () => {
  const result = runWalk(specByName(goldenName));

  test('the golden actually holds equity — otherwise the walks below are vacuous', () => {
    assert.ok(result.total > 0, 'no EQUITY holdings at all in the final state');
    assert.ok(result.securities != null, 'no `state.securities` — the registry never projected');
  });

  test('no reducer births a scalar equity lot', () => {
    assert.deepEqual(
      result.births, [],
      'equity lot(s) born without a position\'s two facts:\n'
      + result.births.map(b => `    ${b.reducer}: ${b.lots} lot(s) ${b.why} (e.g. ${b.key})`).join('\n')
      + '\n\n  A lot BIRTH site must establish units the same way the config→run boundary\n'
      + '  does — `promoteToUnitised(lot, { price: prevailingPrice(siblings) })`. Minting\n'
      + '  at the convention\'s 100 beside a seasoned lot is NOT the fix: it fabricates the\n'
      + '  unit count and defeats §5.5 compaction.\n');
  });

  test('every equity position in the final state has a unit count and a security', () => {
    assert.deepEqual(
      result.stragglers, [],
      'equity holding(s) still scalar at the end of the run:\n'
      + result.stragglers.map(s => `    ${s.key} — ${s.why}, $${s.marketValue}`).join('\n'));
  });
});
}
