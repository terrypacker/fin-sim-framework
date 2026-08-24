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
 * bond-par-conservation.test.mjs — design 93 §7. The invariant behind the
 * `bond-par-conservation` golden, asserted directly.
 *
 * ── why this exists alongside the golden ─────────────────────────────────────
 *
 * The golden fixture DOES catch every defect this file catches — reintroducing the
 * rebalancer's par leak moves 51 fields and $20,480 of net worth. But it catches them as
 * "51 fields differ", which is a puzzle rather than a diagnosis; the eight defects of
 * design 66 §10.6b each took a long session to localise from exactly that kind of signal.
 * This test names the reducer instead.
 *
 * ── the invariant ────────────────────────────────────────────────────────────
 *
 * A holding's value changes for two physically different reasons (design 93 §2.1):
 *
 *   UNIT change  — you own more or less of the instrument (buy, sell, deposit,
 *                  withdrawal, rollover, conversion, lot merge, rescale). `faceValue`
 *                  MUST move with `marketValue`.
 *   PRICE change — same instruments, different quote (rate mark, pull-to-par, shock
 *                  revaluation, CPI accretion). `faceValue` MUST NOT move.
 *
 * `faceValue` is authoritative twice over — `BondPriceAdjustReducer` pulls a bond's price
 * TOWARD it every period and `BondMaturityReducer` redeems AT it — so a par that no longer
 * describes its position is not a mislabel, it is a target the engine converges the
 * position onto forever. Both signs were observed in practice: a deposit against frozen
 * par destroyed value every period after it, and a rebalancer sell against frozen par had
 * pull-to-par regenerating ~92% of everything sold.
 *
 * So: **no reducer may move BOND market value while par stands still.** The test wraps
 * every live reducer instance and fails naming any that does.
 *
 * ── the one legitimate exception ─────────────────────────────────────────────
 *
 * TIPS accretion. An inflation-linked bond indexes its PRINCIPAL to CPI, so marketValue
 * rises while `faceValue` — the original issue face, held only as the deflation floor —
 * correctly stands still. It arrives via HoldingTransactReducer. It is excluded by name,
 * and narrowly: only when the state actually contains an inflation-linked bond.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { ServiceRegistry }  from '../../src/services/service-registry.js';
import { BaseScenario }     from '../../src/scenarios/base-scenario.js';
import { ScenarioLoader }   from '../../src/scenarios/scenario-loader.js';
import { specByName }       from '../helpers/golden-specs.js';
import { buildGoldenCfg }   from '../helpers/golden-harness.js';

/** Σ marketValue and Σ faceValue over every BOND holding that carries a par. */
function parSnapshot(state) {
  let mv = 0, face = 0;
  for (const v of Object.values(state ?? {})) {
    if (!v || typeof v !== 'object' || !Array.isArray(v.holdings)) continue;
    for (const h of v.holdings) {
      if (h?.allocation !== 'BOND' || h.faceValue == null) continue;
      mv   += h.marketValue ?? 0;
      face += h.faceValue   ?? 0;
    }
  }
  return { mv: +mv.toFixed(2), face: +face.toFixed(2) };
}

const hasTips = (state) => {
  for (const v of Object.values(state ?? {})) {
    if (!v || typeof v !== 'object' || !Array.isArray(v.holdings)) continue;
    if (v.holdings.some(h => h?.allocation === 'BOND' && h.inflationLinked)) return true;
  }
  return false;
};

/**
 * Run the golden with every reducer wrapped, tallying steps that moved BOND market value
 * while par stood still. Returns `[{ reducer, steps, netMv }]`, worst first.
 */
function parLeaks(spec) {
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
  const sim = scenario.sim;

  const tally = new Map();
  // Wrap INSTANCES, not Reducer.prototype: every subclass defines its own `reduce`, which
  // shadows the base method — a prototype patch silently observes nothing.
  for (const r of services.reducerService.getAll()) {
    const orig = r.reduce.bind(r);
    const name = r.constructor.type ?? r.constructor.name;
    r.reduce = (state, action) => {
      const before = parSnapshot(state);
      const out    = orig(state, action);
      const after  = parSnapshot(out?.state ?? out);
      const dMv    = +(after.mv - before.mv).toFixed(2);
      const dFace  = +(after.face - before.face).toFixed(2);
      // >$1 of value moved with par within a cent of unchanged.
      if (Math.abs(dMv) > 1 && Math.abs(dFace) < 0.01
          && !(name === 'HoldingTransactReducer' && hasTips(state))) {
        const t = tally.get(name) ?? { reducer: name, steps: 0, netMv: 0 };
        t.steps++; t.netMv = +(t.netMv + dMv).toFixed(2);
        tally.set(name, t);
      }
      return out;
    };
  }

  const log = console.log, warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { sim.stepTo(new Date(cfg.simEnd)); } finally { console.log = log; console.warn = warn; }

  return [...tally.values()].sort((a, b) => Math.abs(b.netMv) - Math.abs(a.netMv));
}

/**
 * Every reducer that leaves a UNITISED holding whose stored `marketValue` disagrees with
 * `units x pricePerUnit` (design 93 §5b). Reports only the TRANSITION — the holding was
 * consistent going in and is not coming out — so the reducer named is the writer rather
 * than every reducer that ran afterwards.
 */
function unitLeaks(spec) {
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

  const consistency = (state) => {
    const m = new Map();
    for (const [k, a] of Object.entries(state ?? {})) {
      if (!a || !Array.isArray(a.holdings)) continue;
      for (const h of a.holdings) {
        if (h?.units == null) continue;
        const derived = +(h.units * (h.pricePerUnit ?? 0)).toFixed(2);
        m.set(`${k}.${h.id}`, { ok: Math.abs(derived - (h.marketValue ?? 0)) <= 0.02, h, derived });
      }
    }
    return m;
  };

  const found = new Map();
  // Wrap INSTANCES, not Reducer.prototype — every subclass shadows `reduce`, so a
  // prototype patch observes nothing (the same note `parLeaks` carries above).
  for (const r of services.reducerService.getAll()) {
    const orig = r.reduce.bind(r);
    const name = r.constructor.type ?? r.constructor.name;
    r.reduce = (state, action) => {
      const before = consistency(state);
      const out    = orig(state, action);
      for (const [key, v] of consistency(out?.state ?? out)) {
        // Only the TRANSITION: consistent going in, inconsistent coming out. Without
        // this every reducer that merely ran after the writer reports the same desync.
        if (v.ok || before.get(key)?.ok !== true) continue;
        const id = `${name}|${key}`;
        if (!found.has(id)) {
          found.set(id, { reducer: name, key, units: v.h.units, price: v.h.pricePerUnit,
                          derived: v.derived, stored: v.h.marketValue });
        }
      }
      return out;
    };
  }

  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  try { scenario.sim.stepTo(new Date(cfg.simEnd)); }
  finally { console.log = log; console.warn = warn; }

  const unitised = [...consistency(scenario.sim.state).keys()].length;
  return { leaks: [...found.values()], unitised };
}

// Both ladder goldens, because the two instruments break the invariant differently: a
// nominal bond's par IS its redemption amount, a TIPS's is only its deflation FLOOR, and
// design 66 §10.6b's defect #8 was exactly that one field meaning both things.
const LADDER_GOLDENS = ['bond-par-conservation', 'tips-ladder-conservation'];

for (const goldenName of LADDER_GOLDENS) {
describe(`bond par conservation — ${goldenName} (design 93 §7)`, () => {
  test('no reducer moves BOND market value while par stands still', () => {
    const leaks = parLeaks(specByName(goldenName));
    assert.deepEqual(
      leaks, [],
      'par leak(s) — a value move that did not carry faceValue with it:\n'
      + leaks.map(l => `    ${l.reducer}: ${l.steps} step(s), net market value `
                     + `${l.netMv > 0 ? '+' : ''}${l.netMv.toLocaleString()} with par frozen`).join('\n')
      + '\n\n  Whichever reducer is named moves value for a UNIT reason and must scale\n'
      + '  faceValue by the same ratio (design 93 §2.1). If it genuinely changes only\n'
      + '  PRICE, par is right to stand still and the exclusion list needs the case.\n');
  });

  test('no reducer leaves a unitised holding disagreeing with its own unit count', () => {
    // design 93 §5b. §7's invariant catches a par that stopped describing its position;
    // this one catches the failure the UNITISED representation introduces, which is one
    // layer earlier: a raw `marketValue` write that leaves `units` behind. The value is
    // derived from the count, so the next `syncHolding` recomputes it from the stale
    // count and silently undoes the write.
    //
    // This is not hypothetical. Flipping the bond paths to units while the ladder's
    // absorption still wrote `marketValue` by hand evaporated 40% of the golden's
    // 401(k) — and the whole-state fixture reported it as "355 fields differ", the same
    // undiagnosable signal §7 exists to replace. The representation is only
    // unfalsifiable if something asserts the derivation.
    //
    // What it can and cannot see: this golden's unitised lots are written by exactly
    // three reducers (BondLadder, RebalanceToTargetApply, BondMaturity), so those are the
    // three it covers. Verified by reintroducing a raw write in the ladder's absorption
    // merge — the test names the reducer AND the lot. It cannot see a write that is
    // followed by a `syncHolding`, because that repairs consistency while keeping the
    // stale count; §7's par invariant is what catches that shape.
    const { leaks: bad, unitised } = unitLeaks(specByName(goldenName));
    // Non-vacuity, the same guard §7 carries: if the golden ever drifts back to bonds
    // with no unit count, the assertion below passes over an empty set.
    assert.ok(unitised > 0,
      'the golden ended with no unitised holdings at all — this test is vacuous');
    assert.deepEqual(
      bad, [],
      'unit desync(es) — a holding whose stored value disagrees with units x pricePerUnit:\n'
      + bad.map(b => `    ${b.reducer}: ${b.key} — units ${b.units} x ${b.price} = `
                   + `${b.derived}, stored ${b.stored}`).join('\n')
      + '\n\n  Whichever reducer is named writes marketValue directly on a unitised lot.\n'
      + '  Use resize() (the count changed), reprice() (the price did) or establish()\n'
      + '  (there was nothing there) — or move `units` by hand, as the account-service\n'
      + '  apportionment loop does for its own rounding reasons.\n');
  });

  test('the golden actually holds instruments with par — otherwise the test above is vacuous', () => {
    ServiceRegistry.resetAll();
    const services = ServiceRegistry.getInstance();
    const cfg      = buildGoldenCfg(specByName(goldenName));
    const scenario = new BaseScenario({
      context:      services.simulationContext,
      initialState: cfg.initialState ?? {},
      simStart:     new Date(cfg.simStart),
      simEnd:       new Date(cfg.simEnd),
    });
    scenario.buildSim({ telemetry: 'off' });
    new ScenarioLoader().load(cfg, services);
    const log = console.log; console.log = () => {};
    try { scenario.sim.stepTo(new Date(cfg.simEnd)); } finally { console.log = log; }

    const { mv, face } = parSnapshot(scenario.sim.state);
    // The whole reason the eight defects survived months of green suites is that the
    // default scenario's bonds are perpetual FUNDS carrying no par at all, so every
    // par-handling path was unreachable. If this golden ever drifts back to that, the
    // test above passes for the wrong reason.
    assert.ok(face > 100_000,
      `golden holds only ${face} of par — dated bonds have gone missing from it, which `
      + 'makes the conservation test above vacuous');
    assert.ok(mv > 100_000, 'golden holds no bond market value');
  });
});
}

// ── design 93 §5b: the ratchet, forbidden directly ───────────────────────────

describe('the deflation floor moves only with the unit count (design 93 §5b)', () => {
  test('no reducer raises a unitised bond\'s faceValue without acquiring units', () => {
    // Defect #4, stated as an invariant rather than as a repair.
    //
    // §7's walk catches value moving while par stands still. This is the MIRROR, and it is
    // the one that ran away: par moving while the unit count stands still. On a TIPS
    // `faceValue` is the ORIGINAL issue par, held only as the Treasury deflation floor
    // that redemption takes a max() against — so a floor that grows on anything other than
    // buying more of the instrument becomes the redemption value, and every roll ratchets
    // it higher. Measured at 266 of 1750 paths past $1e12 at 75% equity, one reaching
    // 1e+63.
    //
    // Under the unitised representation `faceValue = units × parPerUnit`, so this
    // invariant is supposed to hold by CONSTRUCTION. That is exactly why it is worth
    // asserting: it is the check that everything really goes through the derivation.
    const bad = floorLeaks(specByName('tips-ladder-conservation'));
    assert.deepEqual(
      bad, [],
      'deflation-floor leak(s) — par rose on a step that acquired no units:\n'
      + bad.map(b => `    ${b.reducer}: ${b.key} — par ${b.faceBefore} → ${b.faceAfter} `
                   + `while units ${b.unitsBefore} → ${b.unitsAfter}`).join('\n')
      + '\n\n  Par per unit is a constant of the instrument. If the floor moved, either the\n'
      + '  unit count moved with it (fine — that is a purchase) or something wrote par by\n'
      + '  hand (not fine — that is the ratchet).\n');
  });
});

/**
 * Every reducer that raises a unitised bond's `faceValue` by a larger proportion than it
 * raised `units`. Reports the transition, so the reducer named is the writer.
 *
 * A ROLL legitimately re-faces a TIPS — it re-issues at the principal it just repaid, with
 * a fresh unit count — but it moves both together, so it needs no exclusion: the check is
 * on the RATIO, not on par alone.
 */
function floorLeaks(spec) {
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

  const snap = (state) => {
    const m = new Map();
    for (const [k, a] of Object.entries(state ?? {})) {
      if (!a || !Array.isArray(a.holdings)) continue;
      for (const h of a.holdings) {
        if (h?.units == null || h.faceValue == null) continue;
        m.set(`${k}.${h.id}`, h);
      }
    }
    return m;
  };

  const found = new Map();
  for (const r of services.reducerService.getAll()) {
    const orig = r.reduce.bind(r);
    const name = r.constructor.type ?? r.constructor.name;
    r.reduce = (state, action) => {
      const before = snap(state);
      const out    = orig(state, action);
      for (const [key, h] of snap(out?.state ?? out)) {
        const p = before.get(key);
        if (!p) continue;
        const dFace  = (h.faceValue ?? 0) - (p.faceValue ?? 0);
        if (dFace <= 0.01) continue;
        // Par may only have grown in proportion to the units that grew with it. A cent of
        // slack for the rounding at the derivation.
        const expected = (p.units ?? 0) > 0
          ? (p.faceValue ?? 0) * ((h.units ?? 0) / p.units)
          : (h.faceValue ?? 0);
        if (Math.abs((h.faceValue ?? 0) - expected) <= 0.01) continue;
        const id = `${name}|${key}`;
        if (!found.has(id)) {
          found.set(id, { reducer: name, key,
                          faceBefore: p.faceValue, faceAfter: h.faceValue,
                          unitsBefore: p.units, unitsAfter: h.units });
        }
      }
      return out;
    };
  }

  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  try { scenario.sim.stepTo(new Date(cfg.simEnd)); }
  finally { console.log = log; console.warn = warn; }

  return [...found.values()];
}
