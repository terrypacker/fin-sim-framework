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
 * house-cost-mc.test.mjs — design 75 Phase 4 (MC integration for the house path & running cost).
 *
 * Covers the Phase-4 pieces:
 *   - B. Global MC scalers — the per-property return/repair inputs live in cfg.realProperties and
 *        can't be swept directly, so three cfg.parameters scalars are the MC seam:
 *          · propertyReturnIdioScale → PropertyReturnTickHandler.idioScale (housing-vol axis)
 *          · repairSeverityScale     → RealPropertyRepairTickHandler.severityScale
 *          · repairFreqScale         → RealPropertyRepairTickHandler.freqScale
 *        All default 1.0 ⇒ inert; cursor discipline (design 74 §4) preserved when scaling.
 *   - B. The three scalers are exposed as opt-in MC variables centred on 1.0.
 *   - C. House-path diagnostics — computePathShape adds houseCagr/houseMaxDrawdown from the
 *        houseValueUsd series; summary.pathShape adds the house medians + repair-spend percentiles.
 *   - A. Per-iteration seed — property flag ON + scalars off ⇒ iterations diverge (own house path).
 *
 * Maps to §6.4 A/B/C exit criteria.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { RealPropertyRepairTickHandler } from '../../src/finance/handlers/real-property-repair-tick-handler.js';
import { PropertyReturnTickHandler }     from '../../src/finance/economic-regimes/property-return-tick-handler.js';
import { IntlRetirementMcRunner, computePathShape, computeHouseValueUsd } from '../../src/finance/monte-carlo/intl-retirement-mc-runner.js';
import { IntlRetirementMcConfig }        from '../../src/finance/monte-carlo/intl-retirement-mc-config.js';

const mkRng = (seed = 42) => {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
};

const mkRegistry = (usKey = 'usCash', auKey = 'auCash') => ({
  resolveTransactionAccountKey: (country) => (country === 'AU' ? auKey : usKey),
  getStateKey: () => usKey,
});

const baseState = (over = {}) => ({
  people: { p1: { id: 'p1', residency: 'US' } },
  effectiveExchangeRates: { USD_AUD: 1.5, AUD_USD: 1 / 1.5 },
  usCash: { balance: 1_000_000, minimumBalance: 0, currency: { code: 'USD' } },
  auCash: { balance: 1_000_000, minimumBalance: 0, currency: { code: 'AUD' } },
  house:  { value: 500000, currency: { code: 'USD' }, country: 'US', repairModel: 'BERNOULLI', repairProb: 0.2, repairMedian: 10000, repairSigma: 0.6, capitalizeRepairs: 0 },
  ...over,
});

const mkRepairHandler = ({ severityScale = 1, freqScale = 1, propertyKeys = ['house'] } = {}) =>
  new RealPropertyRepairTickHandler({
    stateRegistry: mkRegistry(), propertyKeys,
    usRole: 'US_SAVINGS', usOwnerId: 'p1', auRole: 'AU_SAVINGS', auOwnerId: 'p1',
    severityScale, freqScale,
  });

const applyOf = (actions, key = 'house') => actions.find(a => a.type === 'HOUSE_REPAIR_APPLY' && a.stateKey === key);

// ─── B. repair severity/frequency scalers ────────────────────────────────────────

describe('RealPropertyRepairTickHandler MC scalers', () => {
  test('severityScale multiplies the repair amount at a fixed seed (prob 1)', () => {
    const st = () => baseState({ house: { ...baseState().house, repairProb: 1 } });
    const base = applyOf(mkRepairHandler().call({ sim: { rng: mkRng(1) }, state: st() })).amount;
    const scaled = applyOf(mkRepairHandler({ severityScale: 2 }).call({ sim: { rng: mkRng(1) }, state: st() })).amount;
    // Same seed ⇒ same lognormal z ⇒ exactly 2× the median-scaled severity.
    assert.ok(Math.abs(scaled - 2 * base) < 1e-6, `expected 2×${base}, got ${scaled}`);
  });

  test('scale = 1 is byte-identical to the un-scaled default', () => {
    const st = () => baseState({ house: { ...baseState().house, repairProb: 0.5 } });
    const a = mkRepairHandler().call({ sim: { rng: mkRng(9) }, state: st() });
    const b = mkRepairHandler({ severityScale: 1, freqScale: 1 }).call({ sim: { rng: mkRng(9) }, state: st() });
    assert.deepEqual(a, b);
  });

  test('freqScale raises how often a Bernoulli repair lands (long run)', () => {
    const st = () => baseState({ house: { ...baseState().house, repairProb: 0.1 } });
    const count = (handler) => {
      const rng = mkRng(2026);
      let hits = 0;
      for (let i = 0; i < 4000; i++) if (applyOf(handler.call({ sim: { rng }, state: st() }))) hits++;
      return hits;
    };
    const lo = count(mkRepairHandler());                    // freqScale 1 ⇒ ≈10%
    const hi = count(mkRepairHandler({ freqScale: 3 }));    // freqScale 3 ⇒ ≈30%
    assert.ok(hi > lo * 2, `freqScale should roughly triple hits: base ${lo}, scaled ${hi}`);
  });

  test('cursor discipline — scaling a NONE property still draws nothing', () => {
    const rng = mkRng(3);
    const st = baseState({ house: { ...baseState().house, repairModel: 'NONE' } });
    assert.deepEqual(mkRepairHandler({ severityScale: 5, freqScale: 5 }).call({ sim: { rng }, state: st }), []);
    assert.equal(rng(), mkRng(3)(), 'a NONE property must not advance the RNG cursor even when scaled');
  });

  test('freqScale does not change the DRAW STRUCTURE (still one uniform per configured Bernoulli year)', () => {
    // A base-configured property draws exactly one uniform for the trial regardless of freqScale,
    // so the cursor after a no-hit year is the same whether freqScale is 1 or 0.5.
    const st = () => baseState({ house: { ...baseState().house, repairProb: 0.01 } }); // almost always a no-hit
    const rngA = mkRng(101); mkRepairHandler({ freqScale: 1 }).call({ sim: { rng: rngA }, state: st() });
    const rngB = mkRng(101); mkRepairHandler({ freqScale: 0.5 }).call({ sim: { rng: rngB }, state: st() });
    assert.equal(rngA(), rngB(), 'the Bernoulli trial draws one uniform independent of freqScale');
  });
});

// ─── B. propertyReturnIdioScale on the return tick ───────────────────────────────

describe('PropertyReturnTickHandler idioScale', () => {
  const mkHandler = (idioScale = 1) => new PropertyReturnTickHandler({
    marketVol: 0.18, beta: {}, idioVol: {}, idioScale,
    driftComp: 'GEOMETRIC', shareMarketFactor: true,
  });
  const st = () => ({ equityReturnMarketDev: 0 });   // market shock 0 ⇒ dev is PURELY idiosyncratic

  test('idioScale = 2 doubles the idiosyncratic deviation at a fixed seed', () => {
    const base   = mkHandler(1).call({ sim: { rng: mkRng(7) }, state: st() })[0].deviation;
    const scaled = mkHandler(2).call({ sim: { rng: mkRng(7) }, state: st() })[0].deviation;
    for (const sleeve of Object.keys(base)) {
      assert.ok(Math.abs(scaled[sleeve] - 2 * base[sleeve]) < 1e-9, `${sleeve}: expected 2× idio dev`);
    }
  });

  test('idioScale = 1 is inert (byte-identical to omitting it)', () => {
    const a = mkHandler(1).call({ sim: { rng: mkRng(5) }, state: st() });
    const b = new PropertyReturnTickHandler({ marketVol: 0.18, shareMarketFactor: true }).call({ sim: { rng: mkRng(5) }, state: st() });
    assert.deepEqual(a, b);
  });

  test('driftComp scales with idioScale² (variance grows as scale²)', () => {
    const d1 = mkHandler(1).call({ sim: { rng: mkRng(1) }, state: st() })[0].driftComp;
    const d2 = mkHandler(2).call({ sim: { rng: mkRng(1) }, state: st() })[0].driftComp;
    // driftComp = ((β·σ)² + (idio·scale)²)/2. With β≈0 the idio term dominates ⇒ ≈4× at scale 2.
    for (const sleeve of Object.keys(d1)) {
      assert.ok(d2[sleeve] > 3 * d1[sleeve], `${sleeve}: idio-dominated driftComp should ~quadruple`);
    }
  });
});

// ─── B. MC config exposes the three scalers ──────────────────────────────────────

describe('house-cost MC variables', () => {
  test('all three scalers appear, disabled by default, centred on 1.0', () => {
    const vars = new IntlRetirementMcConfig().buildVariables({ endDate: new Date(Date.UTC(2036, 0, 1)) });
    for (const key of ['propertyReturnIdioScale', 'repairSeverityScale', 'repairFreqScale']) {
      const v = vars.find(x => x.paramKey === key);
      assert.ok(v, `${key} not exposed as an MC variable`);
      assert.equal(v.enabled, false, `${key} should be opt-in`);
      assert.ok(Math.abs(v.mean - 1.0) < 1e-9, `${key} should centre on 1.0`);
    }
  });
});

// ─── C. house-path diagnostics (pure) ────────────────────────────────────────────

describe('computeHouseValueUsd', () => {
  test('sums gross real-property value, FX-converted to USD; ignores non-property', () => {
    const state = {
      effectiveExchangeRates: { USD_AUD: 1.5 },
      usHouse: { kind: 'real-property', value: 500000, currency: { code: 'USD' }, mortgageBalance: 200000 },
      auHouse: { kind: 'real-property', value: 600000, currency: { code: 'AUD' } },
      cash:    { balance: 999, currency: { code: 'USD' } },
    };
    // Gross (not equity): 500000 USD + 600000/1.5 AUD→USD = 500000 + 400000 = 900000.
    assert.ok(Math.abs(computeHouseValueUsd(state) - 900000) < 1e-6);
  });

  test('no property ⇒ 0', () => {
    assert.equal(computeHouseValueUsd({ cash: { balance: 100 } }), 0);
  });
});

describe('computePathShape house metrics', () => {
  const ts = (nw, house) => nw.map((v, i) => ({ date: new Date(Date.UTC(2026 + i, 0, 1)), netWorthUsd: v, houseValueUsd: house[i] }));

  test('houseCagr is the geometric growth over the pre-sale window', () => {
    // House 400 → 484 over 2 years ⇒ 10%/yr. Net worth arbitrary.
    const { houseCagr } = computePathShape(ts([100, 110, 120], [400, 440, 484]));
    assert.ok(Math.abs(houseCagr - 0.1) < 1e-9);
  });

  test('the sale-to-zero is excluded from house CAGR/drawdown (truncated at first zero)', () => {
    // House 400 → 440 → 484 then SOLD (0). CAGR/drawdown measured over 400→484 only.
    const shape = computePathShape(ts([100, 110, 120, 130], [400, 440, 484, 0]));
    assert.ok(Math.abs(shape.houseCagr - 0.1) < 1e-9, 'CAGR must ignore the sale-to-zero');
    assert.equal(shape.houseMaxDrawdown, 0, 'a monotone-up house then sold has no market drawdown');
  });

  test('houseMaxDrawdown captures a mid-hold dip', () => {
    const { houseMaxDrawdown } = computePathShape(ts([100, 100, 100, 100], [400, 500, 400, 450]));
    assert.ok(Math.abs(houseMaxDrawdown - 0.2) < 1e-9, 'peak 500 → trough 400 = 20%');
  });

  test('no house series ⇒ null house metrics (not NaN)', () => {
    const shape = computePathShape([{ netWorthUsd: 100 }, { netWorthUsd: 110 }]);
    assert.equal(shape.houseCagr, null);
    assert.equal(shape.houseMaxDrawdown, null);
  });
});

// ─── A + C. runner integration (e2e; slower) ─────────────────────────────────────

// Short-horizon runner with every default scalar variable disabled, so the ONLY source of
// per-iteration variation is the in-loop sim.rng path (mirrors equity-return-mc.test.mjs).
function seedOnlyRunner(n = 4) {
  const runner = new IntlRetirementMcRunner({ n, simEnd: new Date(Date.UTC(2036, 0, 1)) });
  for (const v of IntlRetirementMcConfig.contributors[0]()) {
    runner.mcConfig.applyOverride(v.paramKey, { enabled: false });
  }
  return runner;
}

describe('MC house path integration', () => {
  test('property flag ON + scalars off ⇒ iterations diverge (own house path each)', async () => {
    const { runs } = await seedOnlyRunner(4).run({ propertyReturnStochastic: true, equityReturnVol: 0.18 });
    const houseCagrs = runs.map(r => r.pathShape.houseCagr).filter(x => x != null);
    assert.ok(houseCagrs.length > 0, 'expected a house CAGR per run');
    assert.ok(new Set(houseCagrs.map(x => Math.round(x * 1e6))).size > 1, 'house paths did not diverge across iterations');
  });

  test('summary.pathShape carries the house + repair-spend readout keys', async () => {
    const { summary } = await seedOnlyRunner(4).run({ propertyReturnStochastic: true });
    for (const k of ['medianHouseCagr', 'medianHouseMaxDrawdown', 'medianRepairSpend', 'p90RepairSpend', 'p10RepairSpend']) {
      assert.ok(k in summary.pathShape, `summary.pathShape missing ${k}`);
    }
  });
});
