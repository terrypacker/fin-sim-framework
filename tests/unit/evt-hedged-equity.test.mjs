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
 * evt-hedged-equity.test.mjs — design 120, currency-hedged and unhedged foreign equity.
 *
 * Phase 1 (§5.3) — the FX process lives in ECONOMIC_REGIMES:
 * EVT-HDG-1  An AU-only plan with the model at NONE carries no FX state and no FX tick, as
 *            before the move.
 * EVT-HDG-2  An AU-only plan can switch the FX process on: the rate walks.
 * EVT-HDG-3  A cross-border plan with both toolsets schedules the FX tick and its reducers
 *            exactly once.
 *
 * Phase 2 (§5.1, §5.6, §5.7 ALIGNED) — the overlay:
 * EVT-HDG-4  Overlay identities on one lot (§7): h = 0 with a flat rate is today exactly;
 *            h = 1 with a flat rate is today plus carry less cost; h = 0 with a moving rate
 *            is (1+g)(1+f)−1 to the cent; a silent security and a domestic market get none.
 * EVT-HDG-5  On AU Single Homeowner, VGS at h = 0 with FX off grows exactly as the silent
 *            VGS does; at h = 1 its lots gain carry − cost a year and nothing else moves.
 * EVT-HDG-6  The year-end FX mark: the reducer is pure, and a run with FX on and a hedged
 *            security stamps every 31 Dec's rate, so f is measured year to year.
 * EVT-HDG-7  A security's hedge ratio and tax treatment are validated where it is built.
 *
 * Phase 3 (§5.4, §5.5) — FX–equity correlation and the local-currency sleeve:
 * EVT-HDG-8  The FX tick's annual move correlates with the year's market shock at ρ, less
 *            the mean-reversion dilution, and its volatility is unchanged against ρ = 0.
 * EVT-HDG-9  In a run, the shock drawn on 31 Dec drives the next calendar year's FX path;
 *            the equity path is byte-identical with ρ on or off, the FX path is not.
 * EVT-HDG-10 The re-base: with a hedged security and FX on, the ex-AU sleeve takes its
 *            local-currency idio vol and a silent ex-AU lot runs unhedged; otherwise neither.
 * EVT-HDG-11 The §3 shape, on the engine's own handlers: at ρ = −0.54 unhedged ex-AU is the
 *            lower-volatility and better-diversifying holding and h* is low; at ρ = +0.16
 *            the volatility ordering reverses.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { runGolden }                 from '../helpers/golden-harness.js';
import { AuSingleHomeownerScenario } from '../../src/scenarios/au-single-homeowner-scenario.js';
import { IntlRetirementScenario }    from '../../src/scenarios/intl-retirement-scenario.js';
import { computeHoldingsGrowth }     from '../../src/finance/holdings/holdings-earnings.js';
import { buildSecurityRegistry, makeSecurity } from '../../src/finance/holdings/security.js';
import { HedgeFxMarkReducer }        from '../../src/finance/fx/hedge-fx-mark.js';
import { FxTickHandler }             from '../../src/finance/fx/fx-tick-handler.js';
import { FX_PROCESS_MODELS }         from '../../src/finance/fx/fx-process-models.js';
import { EquityReturnTickHandler }   from '../../src/finance/economic-regimes/equity-return-tick-handler.js';
import { DEFAULT_EQUITY_IDIO_LOCAL } from '../../src/finance/economic-regimes/rate-keys.js';

const AU_SPEC = {
  name: 'hdg-au', cls: AuSingleHomeownerScenario,
  simStart: new Date(Date.UTC(2026, 0, 1)), simEnd: new Date(Date.UTC(2031, 0, 1)),
};

const withParams = (spec, params) => ({
  ...spec, mutateCfg: cfg => Object.assign(cfg.parameters, params),
});

test('EVT-HDG-1: an AU-only plan with FX at NONE carries no FX state and no FX tick', () => {
  const run = runGolden(AU_SPEC);
  for (const key of ['baseExchangeRates', 'effectiveExchangeRates', 'fxDeviation', 'baseFxVol']) {
    assert.equal(run.state[key], undefined, `${key} should be absent`);
  }
  assert.ok(!run.firedActionTypes.has('FX_STEP_APPLY'));
});

test('EVT-HDG-2: an AU-only plan can switch the FX process on, and the rate walks', () => {
  const run = runGolden(withParams(AU_SPEC, { fxProcessModel: 'MEAN_REVERTING', randomSeed: 7 }));
  assert.ok(run.firedActionTypes.has('FX_STEP_APPLY'), 'the FX tick fired');
  assert.notEqual(run.state.fxDeviation.USD_AUD, 0);
  assert.ok(Math.abs(run.state.effectiveExchangeRates.USD_AUD - 1.55) > 1e-9,
    'the composed rate moved off its anchor');
  // No transfer layer without the cross-border toolset.
  assert.equal(run.state.baseFxFees, undefined);
});

test('EVT-HDG-3: a cross-border plan schedules the FX tick and its reducers once', () => {
  const run = runGolden({
    name: 'hdg-intl', cls: IntlRetirementScenario,
    simStart: new Date(Date.UTC(2026, 0, 1)), simEnd: new Date(Date.UTC(2027, 0, 1)),
    params: { fxProcessModel: 'MEAN_REVERTING' },
  });
  const count = type => (run.cfg.reducers ?? []).filter(r => r.__type === type).length;
  for (const type of ['FxRefreshReducer', 'FxProcessReducer', 'FxStepApplyReducer', 'FxTransferApplyReducer']) {
    assert.equal(count(type), 1, `${type} registered once`);
  }
  assert.equal((run.cfg.events ?? []).filter(e => e.type === 'FX_TICK').length, 1);
  assert.equal((run.cfg.handlers ?? []).filter(h => h.__type === 'FxTickHandler').length, 1);
  assert.ok(run.state.baseFxFees, 'the transfer layer is still there');
  assert.ok(run.firedActionTypes.has('FX_STEP_APPLY'));
});

// ── Phase 2 ──────────────────────────────────────────────────────────────────────────

/** One AUD account holding one ex-AU lot of security `s`, plus the overlay's state. */
function lotState({ security = {}, rate = 1.5, mark = 1.5, rateKey = 'EQUITY_INTL_EX_AU' } = {}) {
  return {
    acct: {
      currency: { code: 'AUD' },
      holdings: [{ id: 'h1', allocation: 'EQUITY', rateKey, securityId: 's', marketValue: 100_000 }],
    },
    securities:             buildSecurityRegistry([{ id: 's', rateKey, ...security }]),
    effectiveGrowthRates:   { [rateKey]: 0.07 },
    marketDividendYields:   { [rateKey]: 0.02 },
    effectiveInterestRates: { PRIME_AU: 0.05, PRIME_US: 0.03 },
    effectiveExchangeRates: { USD_AUD: rate },
    hedgeOverlay:           { foreignCashRate: 0.04, cost: 0.00025, fxMark: { USD_AUD: mark } },
  };
}

const grow = state => computeHoldingsGrowth({
  state, stateKey: 'acct', fallbackRateKey: 'EQUITY_AU', yieldPaidSeparately: true,
}).amount;

test('EVT-HDG-4: overlay identities on one lot', () => {
  const today = grow(lotState());                                   // silent security
  assert.equal(today, 5000);                                        // price rate 0.07 − 0.02

  // h = 0, flat rate: exactly today.
  assert.equal(grow(lotState({ security: { hedgeRatio: 0 } })), today);

  // h = 1, flat rate: today plus carry (PRIME_AU − PRIME_US) less cost.
  assert.equal(grow(lotState({ security: { hedgeRatio: 1 } })),
    +(100_000 * (0.05 + 0.05 - 0.03 - 0.00025)).toFixed(2));

  // h = 0, rate up 10%: (1+g)(1+f)−1 with f the basket-scaled move.
  const f = Math.exp(0.86 * Math.log(1.65 / 1.5)) - 1;
  assert.equal(grow(lotState({ security: { hedgeRatio: 0 }, rate: 1.65 })),
    +(100_000 * ((1.05) * (1 + f) - 1)).toFixed(2));

  // h = 1 is indifferent to the rate's move.
  assert.equal(grow(lotState({ security: { hedgeRatio: 1 }, rate: 1.65 })),
    grow(lotState({ security: { hedgeRatio: 1 } })));

  // A silent security ignores the move; a domestic market gets no overlay at all.
  assert.equal(grow(lotState({ rate: 1.65 })), today);
  assert.equal(grow(lotState({ security: { hedgeRatio: 0 }, rate: 1.65, rateKey: 'EQUITY_AU' })),
    grow(lotState({ rateKey: 'EQUITY_AU' })));

  // No US prime in the plan: the foreign cash rate stands in.
  const noUs = lotState({ security: { hedgeRatio: 1 } });
  delete noUs.effectiveInterestRates.PRIME_US;
  assert.equal(grow(noUs), +(100_000 * (0.05 + 0.05 - 0.04 - 0.00025)).toFixed(2));
});

const withVgs = (spec, fields, params = {}) => ({
  ...spec,
  mutateCfg: cfg => {
    cfg.securities = cfg.securities.map(s => (s.id === 'sec-vgs' ? { ...s, ...fields } : s));
    Object.assign(cfg.parameters, params);
  },
});

const vgsValue = state => state.auStockAccount.holdings
  .filter(h => h.securityId === 'sec-vgs').reduce((a, h) => a + h.marketValue, 0);

test('EVT-HDG-5: VGS unhedged at FX off is today; hedged gains carry − cost a year', () => {
  const silent = runGolden(AU_SPEC).state;
  const h0     = runGolden(withVgs(AU_SPEC, { hedgeRatio: 0 })).state;
  const h1     = runGolden(withVgs(AU_SPEC, { hedgeRatio: 1 })).state;

  // h = 0 with no FX layer: every account balance is unchanged to the cent.
  for (const key of ['auStockAccount', 'superAccount', 'auSavingsAccount', 'checkingAccount']) {
    assert.equal(h0[key].balance, silent[key].balance, `${key} unchanged at h = 0`);
  }
  assert.equal(vgsValue(h0), vgsValue(silent));
  assert.ok(h0.hedgeOverlay, 'the overlay state is seeded once a security declares a ratio');
  assert.equal(h0.effectiveExchangeRates, undefined, 'no FX layer is switched on by it');

  // h = 1: the gap is the carry the plan's own rates give, less cost, compounding.
  const carry = h1.effectiveInterestRates.PRIME_AU - h1.hedgeOverlay.foreignCashRate - h1.hedgeOverlay.cost;
  const diff  = vgsValue(h1) - vgsValue(silent);
  assert.notEqual(diff, 0);
  assert.equal(Math.sign(diff), Math.sign(carry), 'VGS moves the way the carry points');
  // Super holds no hedged security, so it does not move.
  assert.equal(h1.superAccount.balance, silent.superAccount.balance);
});

test('EVT-HDG-6: the year-end FX mark', () => {
  // Isolated: a pure write, input untouched.
  const before = Object.freeze({ hedgeOverlay: Object.freeze({ cost: 0.1, fxMark: { USD_AUD: 1 } }) });
  const after  = new HedgeFxMarkReducer().reduce(before, { type: 'HEDGE_FX_MARK_APPLY', rates: { USD_AUD: 1.7 } });
  assert.equal(after.hedgeOverlay.fxMark.USD_AUD, 1.7);
  assert.equal(after.hedgeOverlay.cost, 0.1);
  assert.equal(before.hedgeOverlay.fxMark.USD_AUD, 1);

  // In a run: the mark is the rate as of the last 31 Dec, and FX moves VGS.
  const fxOn = { fxProcessModel: 'MEAN_REVERTING', randomSeed: 11 };
  const run  = runGolden(withVgs(AU_SPEC, { hedgeRatio: 0 }, fxOn));
  assert.ok(run.firedActionTypes.has('HEDGE_FX_MARK_APPLY'));
  const marks = run.sim.journal.journal.filter(e => e.action?.type === 'HEDGE_FX_MARK_APPLY');
  assert.equal(marks.length, 5, 'one mark per year-end');
  for (const e of marks) {
    const d = new Date(e.date);
    assert.deepEqual([d.getUTCMonth(), d.getUTCDate()], [11, 31], 'stamped on 31 Dec');
  }
  assert.deepEqual(run.state.hedgeOverlay.fxMark, marks.at(-1).action.data.rates);
  // Each mark is a different rate: the year's f is measured from the one before.
  assert.equal(new Set(marks.map(e => e.action.data.rates.USD_AUD)).size, 5);
  // The first year's VGS growth: the silent lot ignores the AUD's move, the unhedged lot
  // takes it. (The plan sells its VGS early, so a terminal balance would not show it.)
  const vgsGrowth2026 = r => r.sim.journal.journal.find(e => e.action?.type === 'HOLDING_TRANSACT'
    && e.action.data?.holdingId === 'h-vgs' && e.event?.type === 'INTL_AU_STOCK_EARNINGS').action.data.marketValueDelta;
  const silentFx = runGolden(withParams(AU_SPEC, fxOn));
  assert.notEqual(vgsGrowth2026(run), vgsGrowth2026(silentFx), 'an unhedged lot now carries the AUD move');
});

test('EVT-HDG-7: hedge fields are validated where the security is built', () => {
  assert.throws(() => makeSecurity({ id: 'x', hedgeRatio: 1.5 }), /between 0 and 1/);
  assert.throws(() => makeSecurity({ id: 'x', hedgeRatio: -0.1 }), /between 0 and 1/);
  assert.throws(() => makeSecurity({ id: 'x', hedgeTaxTreatment: 'CAPITAL' }), /ALIGNED or INCOME/);
  assert.equal(makeSecurity({ id: 'x', hedgeRatio: 0.255, hedgeTaxTreatment: 'INCOME' }).hedgeRatio, 0.255);
});

// ── Phase 3 ──────────────────────────────────────────────────────────────────────────

/** Deterministic uniform [0,1) — mulberry32. */
function seededRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd   = xs => { const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)); };
const corr = (xs, ys) => {
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
};

/**
 * Years of the engine's own handlers: each year the equity tick draws on 31 Dec of Y − 1
 * (stamping Y's shock) and the FX tick walks Y's twelve months against it.
 */
function simulateYears({ rho, years = 4000, seed = 1, idioVol = DEFAULT_EQUITY_IDIO_LOCAL }) {
  const rng    = seededRng(seed);
  const equity = new EquityReturnTickHandler({ vol: 0.18, idioVol, stampMarketShock: true });
  const fx     = new FxTickHandler({ model: 'MEAN_REVERTING', equityCorrelation: rho });
  let dev = 0;
  const out = [];
  for (let y = 0; y < years; y++) {
    const year = 2000 + y;
    const [step] = equity.call({ sim: { rng, currentDate: new Date(Date.UTC(year - 1, 11, 31)) }, state: {} });
    const state = { equityMarketShock: step.marketShock, effectiveFxVol: { USD_AUD: 0.1142 } };
    const dev0 = dev;
    for (let m = 0; m < 12; m++) {
      state.fxDeviation = { USD_AUD: dev };
      dev = fx.call({ sim: { rng, currentDate: new Date(Date.UTC(year, m, 1)) }, state })[0].deviation;
    }
    out.push({ z: step.marketShock.z, shockYear: step.marketShock.year, year, dlog: dev - dev0,
               exAu: step.deviation.EQUITY_INTL_EX_AU, au: step.deviation.EQUITY_AU });
  }
  return out;
}

test('EVT-HDG-8: the FX move correlates with the year\'s shock at ρ; its vol is unchanged', () => {
  const on  = simulateYears({ rho: -0.54 });
  const off = simulateYears({ rho: 0 });
  assert.ok(on.every(r => r.shockYear === r.year), 'the shock is labelled with the year it drives');
  const r = corr(on.map(x => x.dlog), on.map(x => x.z));
  // Mean reversion adds last year's level to this year's move, which nothing correlates
  // with. At k = 0.114 that dilution is too small to see in 4,000 years (measured −0.537).
  assert.ok(r < -0.50 && r > -0.58, `realised annual correlation ${r.toFixed(3)} ≈ −0.54`);
  assert.ok(Math.abs(corr(off.map(x => x.dlog), off.map(x => x.z))) < 0.05, 'ρ = 0 is independent');
  const ratio = sd(on.map(x => x.dlog)) / sd(off.map(x => x.dlog));
  assert.ok(Math.abs(ratio - 1) < 0.04, `FX volatility unchanged (ratio ${ratio.toFixed(3)})`);
  // ρ = 0 reads no shock at all: a step without one is the plain draw.
  const [a] = new FxTickHandler({ equityCorrelation: 0 }).call({
    sim: { rng: seededRng(9), currentDate: new Date(Date.UTC(2030, 0, 1)) },
    state: { equityMarketShock: { year: 2030, z: 3 }, effectiveFxVol: { USD_AUD: 0.1 } } });
  const [b] = new FxTickHandler({ equityCorrelation: 0 }).call({
    sim: { rng: seededRng(9), currentDate: new Date(Date.UTC(2030, 0, 1)) },
    state: { effectiveFxVol: { USD_AUD: 0.1 } } });
  assert.equal(a.deviation, b.deviation);
});

const STOCH = { fxProcessModel: 'MEAN_REVERTING', equityReturnStochastic: true, equityReturnModel: 'WHITE_NOISE' };
const LONG_AU = { ...AU_SPEC, simEnd: new Date(Date.UTC(2046, 0, 1)) };
const journalOf = (run, type) => run.sim.journal.journal.filter(e => e.action?.type === type);

test('EVT-HDG-9: in a run the 31 Dec shock steers the next year; equity is unmoved by ρ', () => {
  const rs = [];
  const zs = [];
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const run = runGolden(withVgs(LONG_AU, { hedgeRatio: 0 }, { ...STOCH, randomSeed: seed }));
    const shocks = new Map(journalOf(run, 'EQUITY_RETURN_STEP_APPLY')
      .map(e => [e.action.data.marketShock.year, e.action.data.marketShock.z]));
    const marks  = journalOf(run, 'HEDGE_FX_MARK_APPLY')
      .map(e => [new Date(e.date).getUTCFullYear(), e.action.data.rates.USD_AUD]);
    for (let i = 1; i < marks.length; i++) {
      const [year, rate] = marks[i];
      if (!shocks.has(year)) continue;
      rs.push(Math.log(rate / marks[i - 1][1]));
      zs.push(shocks.get(year));
    }
  }
  const r = corr(rs, zs);
  assert.ok(rs.length >= 80, `enough year pairs (${rs.length})`);
  assert.ok(r < -0.3, `annual FX move correlates with the shock that drives the year (${r.toFixed(2)})`);

  // ρ on vs off, one seed: the equity path is the same draw by draw, the FX path is not.
  const at = rho => runGolden(withVgs(AU_SPEC, { hedgeRatio: 0 },
    { ...STOCH, randomSeed: 4, fxEquityCorrelation: rho }));
  const on = at(-0.54), off = at(0);
  assert.deepEqual(journalOf(on, 'EQUITY_RETURN_STEP_APPLY').map(e => e.action.data.deviation),
                   journalOf(off, 'EQUITY_RETURN_STEP_APPLY').map(e => e.action.data.deviation));
  assert.equal(off.state.equityMarketShock, undefined, 'ρ = 0 stamps no shock');
  assert.notEqual(on.state.fxDeviation.USD_AUD, off.state.fxDeviation.USD_AUD);
});

test('EVT-HDG-10: the local-currency re-base and the unhedged default it brings', () => {
  const idio = run => run.cfg.handlers.find(h => h.__type === 'EquityReturnTickHandler')?.idioVol ?? {};
  const rebased = runGolden(withVgs(AU_SPEC, { hedgeRatio: 1 }, { ...STOCH, randomSeed: 1 }));
  assert.equal(idio(rebased).EQUITY_INTL_EX_AU, 0.04);
  assert.equal(rebased.state.hedgeOverlay.rebased, true);
  // No hedged security, or FX at NONE: the AUD calibration stays and nothing is re-based.
  assert.equal(idio(runGolden(withParams(AU_SPEC, { ...STOCH, randomSeed: 1 }))).EQUITY_INTL_EX_AU, undefined);
  const flat = runGolden(withVgs(AU_SPEC, { hedgeRatio: 1 }, { equityReturnStochastic: true, randomSeed: 1 }));
  assert.equal(idio(flat).EQUITY_INTL_EX_AU, undefined);
  assert.equal(flat.state.hedgeOverlay.rebased, undefined);
  // An authored per-market idio vol still wins over the local default.
  const authored = runGolden(withVgs(AU_SPEC, { hedgeRatio: 1 },
    { ...STOCH, randomSeed: 1, equityReturnIdioVol: { EQUITY_INTL_EX_AU: 0.03 } }));
  assert.equal(idio(authored).EQUITY_INTL_EX_AU, 0.03);

  // A silent ex-AU lot is unhedged once re-based: it takes the rate's move.
  const silentLot = { rate: 1.65 };
  const before = grow(lotState(silentLot));
  const st = lotState(silentLot);
  st.hedgeOverlay.rebased = true;
  assert.equal(grow(st), grow(lotState({ ...silentLot, security: { hedgeRatio: 0 } })));
  assert.notEqual(grow(st), before);
});

test('EVT-HDG-11: the §3 shape on the engine\'s own handlers', () => {
  const G = 0.075, CARRY = 0.0435 - 0.045 - 0.00025;
  const stats = rho => {
    const ys  = simulateYears({ rho, seed: 3 });
    const f   = ys.map(y => Math.exp(0.86 * y.dlog) - 1);            // the basket's move
    const rL  = ys.map(y => G + y.exAu);
    const unh = rL.map((r, i) => (1 + r) * (1 + f[i]) - 1);
    const hed = rL.map(r => r + CARRY);
    const au  = ys.map(y => y.au);
    const hStar = 1 + corr(f, rL) * sd(rL) / sd(f);
    return { unh: sd(unh), hed: sd(hed), cU: corr(unh, au), cH: corr(hed, au), hStar };
  };
  const recent = stats(-0.54);
  assert.ok(recent.unh < recent.hed, `unhedged is the lower-vol holding at −0.54 (${recent.unh.toFixed(3)} < ${recent.hed.toFixed(3)})`);
  assert.ok(recent.cU < recent.cH, 'and diversifies the AU market better');
  // §4's check: h* = 1 + ρ·σ_L/σ_F, predicted 0.19 at −0.54 and 0.74 at −0.17 (measured
  // 0.19 and 0.73), where super funds hold 0.20–0.26.
  assert.ok(recent.hStar > 0.12 && recent.hStar < 0.26, `h* is low (${recent.hStar.toFixed(2)}), where super funds hedge`);
  const avg = stats(-0.17).hStar;
  assert.ok(avg > 0.64 && avg < 0.84, `h* at the 40-year −0.17 is ${avg.toFixed(2)}`);
  const early = stats(0.16);
  assert.ok(early.unh > early.hed, `at +0.16 hedged is the lower-vol holding (${early.hed.toFixed(3)} < ${early.unh.toFixed(3)})`);
  assert.ok(early.hStar > 1, `h* above 1 at +0.16 (${early.hStar.toFixed(2)})`);
});
