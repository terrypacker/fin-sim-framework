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
 * evt-gold-risk.test.mjs — gold's own return draw and AU-held gold's currency exposure
 * (design 121 §6, §6.1).
 *
 * §6 — the draw:
 * GOLD-1  the drawn deviation has sd ≈ goldReturnVol, mean ≈ 0, and correlates with the
 *         year's market shock at ρ; the σ²/2 compensation is stamped beside it
 * GOLD-2  the gold draw comes from its own keyed stream: equity's draws and the shared
 *         cursor are byte-identical with gold on or off, and rngStreams off still pairs it
 * GOLD-3  goldReturnVol 0 draws nothing and adds no GOLD key
 * GOLD-4  in a run: with the equity path on, gold's effective rate is the anchor plus a
 *         draw; with it off, gold grows at exactly goldGrowthRate (no draw stored)
 *
 * §6.1 — the currency term:
 * GOLD-5  a silent gold lot in an AUD account is unhedged in EVERY role (not super's 0.255
 *         equity default) and grows at (1 + g)(1 + f) − 1 at the pair's full move; in a
 *         USD account, or with no overlay state, nothing changes
 * GOLD-6  the gate: an AUD plan holding gold with FX on gets the overlay state and the
 *         year-end mark and its gold moves with the AUD; the same plan at FX NONE, or
 *         without gold, carries no overlay state
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Simulation }              from '../../src/simulation-framework/simulation.js';
import { EquityReturnTickHandler } from '../../src/finance/economic-regimes/equity-return-tick-handler.js';
import { computeHoldingsGrowth }   from '../../src/finance/holdings/holdings-earnings.js';
import { buildSecurityRegistry }   from '../../src/finance/holdings/security.js';
import { hedgeRatioOf, DEFAULT_GOLD_HEDGE_RATIO } from '../../src/finance/holdings/currency-overlay.js';
import { runGolden }                 from '../helpers/golden-harness.js';
import { AuSingleHomeownerScenario } from '../../src/scenarios/au-single-homeowner-scenario.js';

// ── The draw ─────────────────────────────────────────────────────────────────────────

/** The RNG surface of a Simulation, without building one. */
function simHost(seed, { streams = false } = {}) {
  const host = Object.create(Simulation.prototype);
  host.rng = host.createRNG(seed);
  host.useRngStreams = streams;
  return host;
}

/** Tick `years` years from 2000 and return each year's action. */
function tickYears(handler, host, years) {
  const out = [];
  for (let y = 0; y < years; y++) {
    host.currentDate = new Date(Date.UTC(2000 + y, 11, 31));
    out.push(handler.call({ sim: host, state: {} })[0]);
  }
  return out;
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd   = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const corr = (a, b) => {
  const ma = mean(a), mb = mean(b);
  return a.reduce((x, _, i) => x + (a[i] - ma) * (b[i] - mb), 0) / ((a.length - 1) * sd(a) * sd(b));
};

test('GOLD-1: the gold draw has the requested vol, mean 0, and correlation with the market', () => {
  const N = 4000;
  for (const rho of [0, 0.5, -0.4]) {
    const h = new EquityReturnTickHandler({ vol: 0.18, gold: { vol: 0.15, correlation: rho } });
    const acts = tickYears(h, simHost(11), N);
    const gold = acts.map(a => a.deviation.GOLD);
    const mkt  = acts.map(a => a.marketDev);
    assert.ok(Math.abs(sd(gold) - 0.15) < 0.01, `ρ ${rho}: sd ${sd(gold)}`);
    assert.ok(Math.abs(mean(gold)) < 0.01, `ρ ${rho}: mean ${mean(gold)}`);
    assert.ok(Math.abs(corr(gold, mkt) - rho) < 0.05, `ρ ${rho}: corr ${corr(gold, mkt)}`);
    assert.ok(Math.abs(acts[0].driftComp.GOLD - 0.15 * 0.15 / 2) < 1e-15, 'σ²/2 compensation');
  }
});

test('GOLD-2: gold draws from its own keyed stream and moves nothing else', () => {
  const N = 50;
  const off = new EquityReturnTickHandler({ vol: 0.18, idioVol: { EQUITY_AU: 0.1 } });
  const on  = new EquityReturnTickHandler({ vol: 0.18, idioVol: { EQUITY_AU: 0.1 },
    gold: { vol: 0.15, correlation: 0.3 } });
  const hostOff = simHost(5), hostOn = simHost(5);
  const a = tickYears(off, hostOff, N), b = tickYears(on, hostOn, N);
  for (let i = 0; i < N; i++) {
    const { GOLD, ...eq } = b[i].deviation;
    assert.deepEqual(eq, a[i].deviation, `year ${i}: equity deviations unchanged`);
    assert.ok(Number.isFinite(GOLD));
  }
  assert.equal(hostOn.rng(), hostOff.rng(), 'the shared cursor sits where it did');

  // With rngStreams off, gold's innovation is still a pure function of (seed, year): two hosts
  // whose shared cursors are at DIFFERENT places draw the same ε, so ρ = 0 gives the same gold.
  const g0 = new EquityReturnTickHandler({ vol: 0.18, gold: { vol: 0.15, correlation: 0 } });
  const h1 = simHost(9), h2 = simHost(9);
  h2.rng(); h2.rng();                                   // knock the shared cursor on
  assert.deepEqual(tickYears(g0, h1, 5).map(x => x.deviation.GOLD),
    tickYears(g0, h2, 5).map(x => x.deviation.GOLD));
});

test('GOLD-3: goldReturnVol 0 draws nothing', () => {
  const acts = tickYears(new EquityReturnTickHandler({ vol: 0.18, gold: { vol: 0, correlation: 0 } }), simHost(3), 3);
  for (const a of acts) {
    assert.equal(a.deviation.GOLD, undefined);
    assert.equal(a.driftComp.GOLD, undefined);
  }
});

// ── In a run ─────────────────────────────────────────────────────────────────────────

const AU_SPEC = {
  name: 'gold-au', cls: AuSingleHomeownerScenario,
  simStart: new Date(Date.UTC(2026, 0, 1)), simEnd: new Date(Date.UTC(2031, 0, 1)),
};

const GOLD_LOT = {
  __type: 'Holding', id: 'h-gold', allocation: 'GOLD', rateKey: 'GOLD', label: 'Gold',
  marketValue: 20000, costBasis: 20000,
};

/** AU Single Homeowner with (optionally) a gold lot in its AUD brokerage, plus `params`. */
const auPlan = ({ gold = true, params = {} } = {}) => ({
  ...AU_SPEC,
  mutateCfg: (cfg) => {
    if (gold) {
      const acct = cfg.accounts.find(a => a.stateKey === 'auStockAccount');
      acct.holdings = [...acct.holdings, { ...GOLD_LOT }];
      acct.balance += GOLD_LOT.marketValue;
    }
    Object.assign(cfg.parameters, params);
  },
});

const goldValue = (state) => state.auStockAccount.holdings
  .filter(h => h.rateKey === 'GOLD').reduce((a, h) => a + h.marketValue, 0);

test('GOLD-4: gold takes a draw only when the equity path runs', () => {
  const det = runGolden(auPlan());
  assert.equal(det.state.effectiveGrowthRates.GOLD, 0.05, 'deterministic: exactly goldGrowthRate');
  assert.equal(det.state.equityReturnDev?.GOLD, undefined, 'and no gold draw');

  const sto = runGolden({ ...auPlan({ params: { equityReturnStochastic: true, randomSeed: 21 } }),
    simEnd: new Date(Date.UTC(2029, 0, 1)) });
  assert.ok(Number.isFinite(sto.state.equityReturnDev.GOLD), 'a gold deviation is stored');
  assert.notEqual(sto.state.effectiveGrowthRates.GOLD, 0.05, 'the effective gold rate is the anchor plus the draw');
  assert.notEqual(goldValue(sto.state), goldValue(det.state));
});

// ── The currency term ────────────────────────────────────────────────────────────────

/** One gold lot in an account of `currency`/`role`, with (optionally) the overlay's state. */
function goldLot({ currency = 'AUD', role = 'au-stock', rate = 1.5, mark = 1.5, overlay = true, rebased = false } = {}) {
  return {
    acct: {
      currency: { code: currency }, role,
      holdings: [{ id: 'h1', allocation: 'GOLD', rateKey: 'GOLD', securityId: 'g', marketValue: 100_000 }],
    },
    securities:             buildSecurityRegistry([{ id: 'g', rateKey: 'GOLD' }]),
    effectiveGrowthRates:   { GOLD: 0.05 },
    marketDividendYields:   {},
    effectiveInterestRates: { PRIME_AU: 0.05, PRIME_US: 0.03 },
    effectiveExchangeRates: { USD_AUD: rate },
    ...(overlay ? { hedgeOverlay: { foreignCashRate: 0.04, cost: 0.00025, fxMark: { USD_AUD: mark },
      ...(rebased ? { rebased: true } : {}) } } : {}),
  };
}

const grow = (state) => computeHoldingsGrowth({
  state, stateKey: 'acct', fallbackRateKey: 'GOLD', yieldPaidSeparately: true,
}).amount;

test('GOLD-5: a silent AUD gold lot is unhedged in every role and takes the full AUD move', () => {
  assert.equal(DEFAULT_GOLD_HEDGE_RATIO, 0);
  for (const role of ['au-stock', 'super']) {
    assert.equal(hedgeRatioOf({}, { hedgeOverlay: { rebased: true } }, { role }, 'GOLD'), 0, role);
  }
  assert.equal(hedgeRatioOf({}, {}, { role: 'super' }, 'GOLD'), null, 'no overlay state: silent');
  assert.equal(hedgeRatioOf({ hedgeRatio: 1 }, { hedgeOverlay: {} }, {}, 'GOLD'), 1, 'a stated ratio wins');

  const flat = grow(goldLot());
  assert.equal(flat, 5000, 'a flat rate is exactly the USD gold rate');
  // AUD weakens 10 %: gold in AUD is (1 + g)(1 + f) − 1 with f the pair's FULL move.
  for (const role of ['au-stock', 'super']) {
    assert.equal(grow(goldLot({ rate: 1.65, role, rebased: true })),
      +(100_000 * (1.05 * 1.1 - 1)).toFixed(2), role);
  }
  assert.equal(grow(goldLot({ rate: 1.65, currency: 'USD' })), flat, 'USD account: no currency term');
  assert.equal(grow(goldLot({ rate: 1.65, overlay: false })), flat, 'no overlay state: no currency term');
});

test('GOLD-6: the gate — AUD gold with FX on gets the overlay; FX NONE or no gold does not', () => {
  const FX = { fxProcessModel: 'MEAN_REVERTING', randomSeed: 7 };

  // The prebuilt plan states VGS/VGAD hedge ratios, which switch the overlay on by
  // themselves. Strip them so the only thing that can switch it on is gold.
  const silent = (spec) => ({ ...spec, mutateCfg: (cfg) => {
    cfg.securities = cfg.securities.filter(s => s.id !== 'sec-vgad')
      .map(({ hedgeRatio, hedgeTaxTreatment, ...rest }) => rest);
    spec.mutateCfg(cfg);
  } });

  const fxGold   = runGolden(silent(auPlan({ params: FX })));
  const fxNoGold = runGolden(silent(auPlan({ gold: false, params: FX })));
  const noneGold = runGolden(silent(auPlan()));

  assert.ok(fxGold.state.hedgeOverlay?.fxMark?.USD_AUD > 0, 'overlay state with its mark');
  assert.ok(fxGold.firedActionTypes.has('HEDGE_YEAR_END_APPLY'), 'the year-end mark runs');
  assert.equal(fxGold.state.hedgeOverlay.rebased, undefined, 'gold does not re-base the ex-AU sleeve');
  assert.equal(fxNoGold.state.hedgeOverlay, undefined, 'no gold: no overlay');
  assert.equal(noneGold.state.hedgeOverlay, undefined, 'FX NONE: no overlay');

  // Gold moved with the AUD: its value differs from the same plan's gold at FX NONE.
  assert.notEqual(goldValue(fxGold.state), goldValue(noneGold.state));
});
