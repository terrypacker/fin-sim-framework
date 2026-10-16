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
 * earnings-cadence.test.mjs — design 127, time-weighted investment earnings (phase 1).
 *
 * The arithmetic (§3.2, §3.3):
 * CAD-1  The period rate: n = 1 is the annual rate untouched; twelve periods compound to the
 *        year; a rate at or below −100% floors at −1.
 * CAD-2  A wrapper lot held all year ends it at exactly (1 + T); a taxable lot with its
 *        quarterly dividends reinvested ends it at (1 + T) as well (the multiplicative split).
 * CAD-3  Timing: a lot bought on 1 November ends the year at (1 + T)^(2/12); a lot sold on
 *        30 June took (1 + T)^(6/12) with it.
 * CAD-4  A drawn-down account earns about rate × W / 2 a year more under MONTHLY.
 * CAD-5  The floor: a composed rate of −1.2 takes a lot to zero, not below, and the apply
 *        action says so.
 *
 * The calendar (§3.1, §4.5):
 * CAD-6  The quarter-end interval fires on 31 Mar, 30 Jun, 30 Sep and 31 Dec from any start.
 * CAD-7  ANNUAL schedules exactly the pre-127 year-end series; MONTHLY schedules month-end
 *        growth and quarter-end dividends in their order bands.
 * CAD-8  A run that starts on 1 September credits four months in its first year, and pays
 *        its first dividend at the September quarter-end.
 * CAD-9  31 December keeps ANNUAL's sequence: growth, then dividends, before the day's
 *        order-0 events, and the hedge stamp and index step after them.
 *
 * What depends on equity being annual (§4):
 * CAD-10 §4.1 — with no US advance, ANNUAL takes the year's draw on 1 July; MONTHLY takes it
 *        on 1 January, so every month of a calendar year credits one draw.
 * CAD-11 §4.2 — twelve monthly index steps match a buy-and-hold lot, and the period advance
 *        after them steps nothing.
 * CAD-12 §4.3 — the hedge overlay under MONTHLY: h = 0 on a flat rate is the unhedged lot;
 *        twelve monthly marks compound to the year's FX move; ALIGNED and INCOME lots hold
 *        the same value at every quarter-end.
 * CAD-13 Super: the month's income is taxed at the month's rate, so a draw date in April
 *        taxes January to March at 15% and April onward at 0%.
 *
 * The shape of the months inside a year (§4.7, phase 2b):
 * CAD-14 The tick's month shape is drawn off its own keyed streams: the year's deviations
 *        are identical with it on or off, every sleeve and gold get twelve months summing to
 *        zero, and the same seed draws the same shape.
 * CAD-15 A bootstrap year's market shape is that historical year's own months, at the
 *        bootstrap's rescale and the monthly-average correction.
 * CAD-16 A lot credited through a shaped year still ends it at exactly 1 + T, and a
 *        per-account rate key takes its sleeve's shape.
 * CAD-17 The market index steps through the same shaped months as the lots.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import {
  periodRate, multiplicativePrice, isQuarterEnd, earningsSchedule,
  MONTHLY_GROWTH_ORDER, MONTHLY_DIVIDEND_ORDER,
} from '../../src/finance/holdings/earnings-cadence.js';
import { computeHoldingsGrowth, computeHoldingsDividends } from '../../src/finance/holdings/holdings-earnings.js';
import { buildSecurityRegistry } from '../../src/finance/holdings/security.js';
import { IntlRothEarningsHandler, SuperEarningsHandler } from '../../src/finance/handlers/earnings-handlers.js';
import { HedgeYearEndHandler, HedgeYearEndReducer } from '../../src/finance/fx/hedge-year-end.js';
import {
  MarketIndexReducer, seedIndexLevels,
} from '../../src/finance/economic-regimes/market-index.js';
import { intervalFns, startSnapFns } from '../../src/simulation-framework/simulation/simulation-adapter.js';
import { runGolden, buildGoldenCfg } from '../helpers/golden-harness.js';
import { EquityReturnTickHandler, MONTHLY_AVERAGE_SD_RATIO, HISTORICAL_BOOTSTRAP_SERIES } from '../../src/finance/economic-regimes/equity-return-tick-handler.js';
import { HISTORICAL_EQUITY_RETURNS } from '../../src/finance/economic-regimes/historical-equity-returns.js';
import { EQUITY_SLEEVES } from '../../src/finance/economic-regimes/rate-keys.js';
import { keyedRng } from '../../src/simulation-framework/simulation.js';
import { runReducer, assertStateUnchanged } from '../helpers/reducer-postconditions.js';
import { makeAction } from '../helpers/reducer-fixtures.js';
import { AuSingleHomeownerScenario } from '../../src/scenarios/au-single-homeowner-scenario.js';
import { ServiceRegistry } from '../../src/services/service-registry.js';
import { BaseScenario }    from '../../src/scenarios/base-scenario.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';

const ms   = (y, m = 1, d = 1) => Date.UTC(y, m - 1, d);
const at   = (y, m = 1, d = 1) => new Date(ms(y, m, d));
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const T = 0.08, Y = 0.03;

/** One account, one lot of `mv`, no regimes: the market's total return `T` and yield `Y`. */
function oneLot(mv, { allocation = 'EQUITY', rateKey = 'EQUITY_US' } = {}) {
  return {
    acct: { holdings: [{ id: 'h1', allocation, rateKey, marketValue: mv }] },
    effectiveGrowthRates: { [rateKey]: T },
    marketDividendYields: { [rateKey]: Y },
  };
}
const credit = (state, delta) => { state.acct.holdings[0].marketValue = +(state.acct.holdings[0].marketValue + delta).toFixed(2); };
const mvOf   = state => state.acct.holdings[0].marketValue;
const growth = (state, extra = {}) => computeHoldingsGrowth({ state, stateKey: 'acct', fallbackRateKey: 'EQUITY_US', ...extra });

// ── The arithmetic ──────────────────────────────────────────────────────────────────

test('CAD-1: the period rate', () => {
  assert.equal(periodRate(0.0731, 1), 0.0731, 'n = 1 is the annual rate, to the bit');
  assert.ok(near((1 + periodRate(T, 12)) ** 12, 1 + T, 1e-12), 'twelve periods compound to the year');
  assert.ok(near((1 + periodRate(-0.35, 4)) ** 4, 0.65, 1e-12), 'a loss compounds the same way');
  assert.equal(periodRate(-1, 12), -1);
  assert.equal(periodRate(-1.2, 12), -1, 'floored, not NaN');
  assert.ok(near((1 + multiplicativePrice(T, Y)) * (1 + Y), 1 + T, 1e-12));
});

test('CAD-2: a year held — the wrapper and the taxable lot both end at 1 + T', () => {
  // Wrapper: the whole total, monthly.
  const w = oneLot(100_000);
  for (let m = 0; m < 12; m++) credit(w, growth(w, { periodsPerYear: 12 }).amount);
  assert.ok(near(mvOf(w), 100_000 * (1 + T), 0.10), `wrapper ${mvOf(w)}`);

  // Taxable: the price monthly, and a quarter's dividend reinvested every third month.
  const t = oneLot(100_000);
  for (let m = 1; m <= 12; m++) {
    credit(t, growth(t, { periodsPerYear: 12, yieldPaidSeparately: true }).amount);
    if (m % 3 === 0) credit(t, computeHoldingsDividends({ state: t, stateKey: 'acct', fallbackRateKey: 'EQUITY_US', periodsPerYear: 4 }).amount);
  }
  assert.ok(near(mvOf(t), 100_000 * (1 + T), 0.10), `taxable ${mvOf(t)}`);

  // And ANNUAL is today's additive split: price T − Y, dividend Y.
  const a = oneLot(100_000);
  assert.equal(growth(a, { yieldPaidSeparately: true }).amount, 5000);
  assert.equal(computeHoldingsDividends({ state: a, stateKey: 'acct', fallbackRateKey: 'EQUITY_US' }).amount, 3000);
});

test('CAD-3: a lot earns for the months it was held', () => {
  // Bought on 1 November: credited at the November and December month-ends.
  const nov = oneLot(10_000);
  for (let m = 0; m < 2; m++) credit(nov, growth(nov, { periodsPerYear: 12 }).amount);
  assert.ok(near(mvOf(nov), 10_000 * (1 + T) ** (2 / 12), 0.02));

  // Sold on 30 June, after that day's credit: six months.
  const jun = oneLot(10_000);
  for (let m = 0; m < 6; m++) credit(jun, growth(jun, { periodsPerYear: 12 }).amount);
  assert.ok(near(mvOf(jun), 10_000 * (1 + T) ** (6 / 12), 0.02));

  // ANNUAL credited the November lot a full year on 31 Dec.
  assert.equal(growth(oneLot(10_000)).amount, 800);
});

test('CAD-4: a drawn-down account earns about rate × W / 2 more a year', () => {
  const B = 1_000_000, W = 120_000;
  const annual = oneLot(B);
  for (let m = 0; m < 12; m++) credit(annual, -W / 12);
  credit(annual, growth(annual).amount);

  const monthly = oneLot(B);
  for (let m = 0; m < 12; m++) {
    credit(monthly, -W / 12);
    credit(monthly, growth(monthly, { periodsPerYear: 12 }).amount);
  }
  const gap = mvOf(monthly) - mvOf(annual);
  // W/2 on average, less half a month of draws (each month's draw leaves before its credit).
  assert.ok(gap > T * W * 0.4 && gap < T * W * 0.5, `gap ${gap.toFixed(0)} vs rate × W / 2 = ${T * W / 2}`);
});

test('CAD-5: the floor — a lot loses all of its value and no more', () => {
  const s = oneLot(50_000);
  s.effectiveGrowthRates.EQUITY_US = -1.2;
  const g = growth(s, { periodsPerYear: 12 });
  assert.equal(g.amount, -50_000);
  assert.equal(g.flooredLots, 1);

  // The apply action carries the count; an ordinary month carries nothing.
  const h = new IntlRothEarningsHandler({ stateRegistry: null, role: 'roth', stateKey: 'acct' });
  const [apply] = h.call({ state: s, data: { periodsPerYear: 12 } });
  assert.equal(apply.flooredLots, 1);
  const [plain] = h.call({ state: oneLot(50_000), data: { periodsPerYear: 12 } });
  assert.equal(plain.flooredLots, undefined);

  // ANNUAL is left as it was (§7 Q5): a separate fix.
  assert.equal(growth(s).amount, -60_000);
});

// ── The calendar ────────────────────────────────────────────────────────────────────

test('CAD-6: the quarter-end interval', () => {
  const iso = d => d.toISOString().slice(0, 10);
  assert.equal(iso(startSnapFns['quarter-end'](at(2026, 9, 15))), '2026-09-30');
  assert.equal(iso(startSnapFns['quarter-end'](at(2026, 3, 31))), '2026-03-31');
  let d = startSnapFns['quarter-end'](at(2026, 1, 2));
  const seen = [];
  for (let i = 0; i < 5; i++) { seen.push(iso(d)); d = intervalFns['quarter-end'](d); }
  assert.deepEqual(seen, ['2026-03-31', '2026-06-30', '2026-09-30', '2026-12-31', '2027-03-31']);
  assert.ok(isQuarterEnd(at(2026, 6, 30)) && isQuarterEnd(at(2026, 12, 31)));
  assert.ok(!isQuarterEnd(at(2026, 6, 29)) && !isQuarterEnd(at(2026, 5, 31)));
});

const AU = {
  name: 'cad-au', cls: AuSingleHomeownerScenario,
  simStart: new Date(Date.UTC(2026, 8, 1)), simEnd: new Date(Date.UTC(2028, 0, 1)),
};
const monthly = (spec, params = {}) => ({ ...spec, params: { equityEarningsCadence: 'MONTHLY', ...params } });
const datesOf = (run, type, stateKey) => run.sim.journal.journal
  .filter(e => e.action?.type === type && (stateKey == null || e.action.data?.stateKey === stateKey))
  .map(e => new Date(e.date).toISOString().slice(0, 10));

test('CAD-7: the schedules, by cadence', () => {
  assert.deepEqual(earningsSchedule({}), { growth: { interval: 'year-end' }, dividend: { interval: 'year-end' } },
    'ANNUAL adds no order and no data, so its queue is the pre-127 queue');
  assert.throws(() => earningsSchedule({ equityEarningsCadence: 'WEEKLY' }), /equityEarningsCadence/);

  const ev = type => runGolden(monthly(AU)).cfg.events.find(e => e.type === type);
  const g = ev('INTL_SUPER_EARNINGS'), d = ev('INTL_AU_STOCK_DIVIDEND');
  assert.deepEqual([g.interval, g.order, g.data.periodsPerYear], ['month-end', MONTHLY_GROWTH_ORDER, 12]);
  assert.deepEqual([d.interval, d.order, d.data.periodsPerYear], ['quarter-end', MONTHLY_DIVIDEND_ORDER, 4]);
  assert.equal(ev('MARKET_INDEX_STEP').interval, 'month-end');
  assert.equal(ev('EQUITY_YEAR_OPEN'), undefined, 'the 1 January carrier only with a stochastic path');
});

test('CAD-8: a September start credits four months in its first year', () => {
  const run = runGolden(monthly(AU));
  const first = datesOf(run, 'SUPER_EARNINGS_APPLY', 'superAccount').filter(d => d < '2027');
  assert.deepEqual(first, ['2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31']);
  const divs = datesOf(run, 'AU_DIVIDEND_FRANKED_RESIDENT_APPLY', 'auStockAccount');
  assert.deepEqual([...new Set(divs)].filter(d => d < '2027'), ['2026-09-30', '2026-12-31']);
  // ANNUAL: one 31 Dec credit for the stub.
  const annual = datesOf(runGolden(AU), 'SUPER_EARNINGS_APPLY', 'superAccount').filter(d => d < '2027');
  assert.deepEqual(annual, ['2026-12-31']);
});

test('CAD-9: 31 December keeps ANNUAL\'s sequence', () => {
  const hedged = spec => ({
    ...spec,
    params: { ...spec.params, fxProcessModel: 'MEAN_REVERTING', randomSeed: 3 },
  });
  const seqOn = (run, day) => run.sim.journal.journal
    .filter(e => new Date(e.date).toISOString().slice(0, 10) === day)
    .map(e => e.action?.type);
  const firstIdx = (seq, re) => seq.findIndex(t => re.test(t ?? ''));
  for (const run of [runGolden(hedged(AU)), runGolden(hedged(monthly(AU)))]) {
    const seq = seqOn(run, '2026-12-31');
    const growthAt = firstIdx(seq, /^(SUPER|AU_STOCK)_EARNINGS_APPLY$/);
    const divAt    = firstIdx(seq, /^AU_DIVIDEND_/);
    const expenses = firstIdx(seq, /^MONTHLY_EXPENSE|^EXPENSE/);
    const hedgeAt  = firstIdx(seq, /^HEDGE_YEAR_END_APPLY$/);
    assert.ok(growthAt >= 0 && divAt > growthAt, `growth then dividends: ${growthAt}, ${divAt}`);
    if (expenses >= 0) assert.ok(divAt < expenses, 'both before the month\'s expenses');
    assert.ok(hedgeAt > divAt, 'the hedge stamp after them');
  }
});

// ── What depends on equity being annual ─────────────────────────────────────────────

/** AU Single Homeowner with its US advance unscheduled: the AU-only clock, month by month. */
function auOnlyRates(cadence) {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  const cfg = buildGoldenCfg({
    cls: AuSingleHomeownerScenario,
    simStart: new Date(Date.UTC(2026, 0, 1)), simEnd: new Date(Date.UTC(2029, 0, 1)),
    params: { equityEarningsCadence: cadence, equityReturnStochastic: true, randomSeed: 5 },
  });
  const sc = new BaseScenario({ context: services.simulationContext, initialState: cfg.initialState ?? {},
    simStart: new Date(cfg.simStart), simEnd: new Date(cfg.simEnd) });
  sc.buildSim({ telemetry: 'off' });
  new ScenarioLoader().load(cfg, services);
  sc.sim.unschedule('PERIOD_ADVANCE_US');
  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  const rates = [];
  try {
    for (let m = 0; m < 12; m++) {
      sc.sim.stepTo(new Date(Date.UTC(2028, m + 1, 0)));
      rates.push(sc.sim.state.effectiveGrowthRates.EQUITY_AU);
    }
  } finally { console.log = log; console.warn = warn; }
  return rates;
}

test('CAD-10: §4.1 — MONTHLY folds the year\'s draw on 1 January without a US advance', () => {
  const annual = auOnlyRates('ANNUAL');
  assert.notEqual(annual[0], annual[11], 'ANNUAL: the 2027 draw lands on 1 July 2028');
  assert.equal(annual[5], annual[0]);
  assert.equal(annual[6], annual[11]);
  const m = auOnlyRates('MONTHLY');
  assert.equal(new Set(m).size, 1, `MONTHLY: one draw for the calendar year (${[...new Set(m)]})`);
  assert.equal(m[0], annual[11], 'and it is the same draw');
});

test('CAD-11: §4.2 — twelve monthly index steps match a buy-and-hold lot', () => {
  const base = {
    baseGrowthRates: { EQUITY_US: T }, effectiveGrowthRates: { EQUITY_US: T },
    marketDividendYields: { EQUITY_US: Y }, securities: {},
  };
  let s = { ...base, ...seedIndexLevels(base, ms(2026)) };
  const r = new MarketIndexReducer();
  for (let m = 1; m <= 12; m++) {
    s = runReducer(r, s, makeAction('MARKET_INDEX_STEP_APPLY', { periodsPerYear: 12 }), new Date(Date.UTC(2026, m, 0)));
  }
  assert.ok(near(s.marketIndex.EQUITY_US.total, 100 * (1 + T), 1e-9));
  assert.ok(near(s.marketIndex.EQUITY_US.price, 100 * (1 + T) / (1 + Y), 1e-9));
  assert.equal(s.marketIndexAsOfMs, ms(2026, 12, 31));
  assertStateUnchanged(s, runReducer(r, s, makeAction('US_PERIOD_ADVANCE', {}), at(2027, 1, 1)));
  assertStateUnchanged(s, runReducer(r, s, makeAction('AU_PERIOD_ADVANCE', {}), at(2027, 7, 1)));
});

/** One AUD account with one ex-AU lot of security `s`, the overlay's state, both marks. */
function hedgedLot({ security = {}, rate = 1.5, mark = 1.5 } = {}) {
  const rk = 'EQUITY_INTL_EX_AU';
  return {
    acct: { currency: { code: 'AUD' },
            holdings: [{ id: 'h1', allocation: 'EQUITY', rateKey: rk, securityId: 's', marketValue: 100_000 }] },
    securities:             buildSecurityRegistry([{ id: 's', rateKey: rk, ...security }]),
    effectiveGrowthRates:   { [rk]: 0.07 },
    marketDividendYields:   { [rk]: 0.02 },
    effectiveInterestRates: { PRIME_AU: 0.05, PRIME_US: 0.03 },
    effectiveExchangeRates: { USD_AUD: rate },
    hedgeOverlay:           { foreignCashRate: 0.04, cost: 0.00025, fxMark: { USD_AUD: mark }, fxMarkDist: { USD_AUD: mark } },
  };
}
const monthlyGrowth = (state, date = at(2026, 1, 31)) => computeHoldingsGrowth({
  state, stateKey: 'acct', fallbackRateKey: 'EQUITY_AU', yieldPaidSeparately: true,
  periodsPerYear: 12, distributionDue: isQuarterEnd(date),
}).amount;

test('CAD-12: §4.3 — the hedge overlay, monthly', () => {
  // h = 0 on a flat rate is the silent lot.
  assert.equal(monthlyGrowth(hedgedLot({ security: { hedgeRatio: 0 } })), monthlyGrowth(hedgedLot()));

  // Twelve monthly marks compound to the year's FX move: the AUD price of a dollar walks
  // 1.50 → 1.65 in equal log steps, the stamp marks each month, and an unhedged lot ends at
  // (1 + g)(1 + f_year) with f the basket-scaled move.
  const s = hedgedLot({ security: { hedgeRatio: 0 } });
  const stamp = new HedgeYearEndHandler(), mark = new HedgeYearEndReducer();
  let st = s;
  for (let m = 1; m <= 12; m++) {
    const d = new Date(Date.UTC(2026, m, 0));
    st = { ...st, effectiveExchangeRates: { USD_AUD: 1.5 * (1.1 ** (m / 12)) } };
    const g = monthlyGrowth(st, d);
    st = { ...st, acct: { ...st.acct, holdings: [{ ...st.acct.holdings[0], marketValue: +(st.acct.holdings[0].marketValue + g).toFixed(2) }] } };
    const [a] = stamp.call({ state: st, data: { periodsPerYear: 12 }, date: d });
    st = mark.reduce(st, a);
    assert.equal(st.hedgeOverlay.fxMark.USD_AUD, st.effectiveExchangeRates.USD_AUD, 'marked every month');
    if (m % 3 === 0) assert.equal(st.hedgeOverlay.fxMarkDist.USD_AUD, st.effectiveExchangeRates.USD_AUD, 'and each quarter');
    else assert.notEqual(st.hedgeOverlay.fxMarkDist.USD_AUD, st.effectiveExchangeRates.USD_AUD);
  }
  const fYear = Math.exp(0.86 * Math.log(1.1)) - 1;
  const price = (1.07 / 1.02) - 1;
  assert.ok(near(st.acct.holdings[0].marketValue, 100_000 * (1 + price) * (1 + fYear), 0.20),
    `${st.acct.holdings[0].marketValue} vs ${100_000 * (1 + price) * (1 + fYear)}`);

  // ALIGNED and INCOME lots hold the same value at a quarter-end: the INCOME price keeps
  // d − D′ and the distribution pays D′.
  const INCOME = { hedgeRatio: 1, hedgeTaxTreatment: 'INCOME' };
  const qEnd = at(2026, 3, 31);
  const quarterTotal = st => monthlyGrowth(st, qEnd)
    + computeHoldingsDividends({ state: st, stateKey: 'acct', fallbackRateKey: 'EQUITY_AU', periodsPerYear: 4 }).amount;
  for (const rate of [1.35, 1.5, 1.65]) {
    for (const carried of [0, 0.004, 0.03]) {
      const al  = hedgedLot({ security: { hedgeRatio: 1, hedgeTaxTreatment: 'ALIGNED' }, rate });
      const inc = hedgedLot({ security: INCOME, rate });
      inc.hedgeOverlay.carriedLoss = { s: carried };
      assert.ok(Math.abs(quarterTotal(al) - quarterTotal(inc)) <= 0.01,
        `rate ${rate}, L ${carried}: ${quarterTotal(al)} vs ${quarterTotal(inc)}`);
    }
  }
  // Off a quarter-end the INCOME lot is priced like the ALIGNED one.
  const al  = hedgedLot({ security: { hedgeRatio: 1, hedgeTaxTreatment: 'ALIGNED' }, rate: 1.65 });
  const inc = hedgedLot({ security: INCOME, rate: 1.65 });
  assert.equal(monthlyGrowth(inc, at(2026, 2, 28)), monthlyGrowth(al, at(2026, 2, 28)));
});

test('CAD-13: super — each month\'s income at that month\'s tax rate', () => {
  const state = {
    people: { p1: { id: 'p1', birthDate: '1960-01-01' } },
    superAccount: {
      ownerId: 'p1', role: 'super', drawStartDate: '2026-04-01',
      holdings: [{ id: 'h1', allocation: 'EQUITY', rateKey: 'EQUITY_AU', marketValue: 100_000 }],
    },
    effectiveGrowthRates: { EQUITY_AU: T },
    marketDividendYields: { EQUITY_AU: Y },
  };
  const h = new SuperEarningsHandler({ stateRegistry: null, role: 'super', stateKey: 'superAccount', frankedPercent: 0 });
  const rateOn = d => h.call({ state, data: { periodsPerYear: 12 }, date: d })[0].taxRate;
  assert.equal(rateOn(at(2026, 3, 31)), 0.15, 'accumulation before the draw date');
  assert.equal(rateOn(at(2026, 4, 30)), 0, 'pension phase from it');
  const [apply] = h.call({ state, data: { periodsPerYear: 12 }, date: at(2026, 3, 31) });
  assert.ok(near(apply.grossAmount, 100_000 * periodRate(Y, 12), 0.01), 'a month of income');
});

// ── The shape of the months inside a year (§4.7) ────────────────────────────────────

/** A tick `sim` stub: a seeded cursor, the run's keyed streams, and a 31 Dec draw date. */
const tickSim = (seed = 7) => ({ rng: keyedRng(seed, 'cursor', 0), keyedRng: (l, y) => keyedRng(seed, l, y), currentDate: at(2026, 12, 31) });
const sum = xs => xs.reduce((a, x) => a + x, 0);

test('CAD-14: the tick\'s month shape — its own streams, zero-sum, reproducible', () => {
  const opts = { model: 'WHITE_NOISE', vol: 0.18, gold: { vol: 0.15, correlation: 0.2 } };
  const off = new EquityReturnTickHandler(opts).call({ sim: tickSim(), state: {} })[0];
  const on  = new EquityReturnTickHandler({ ...opts, monthShape: true }).call({ sim: tickSim(), state: {} })[0];
  assert.equal(off.monthShape, undefined, 'ANNUAL draws no shape');
  assert.deepEqual(on.deviation, off.deviation, 'the year\'s draws do not move');
  for (const k of [...EQUITY_SLEEVES, 'GOLD']) {
    assert.equal(on.monthShape[k].length, 12, k);
    assert.ok(Math.abs(sum(on.monthShape[k])) < 1e-12, `${k} sums to zero`);
    assert.ok(on.monthShape[k].some(x => Math.abs(x) > 1e-3), `${k} is not a straight line`);
  }
  const again = new EquityReturnTickHandler({ ...opts, monthShape: true }).call({ sim: tickSim(), state: {} })[0];
  assert.deepEqual(again.monthShape, on.monthShape);
  const other = new EquityReturnTickHandler({ ...opts, monthShape: true }).call({ sim: tickSim(8), state: {} })[0];
  assert.notDeepEqual(other.monthShape, on.monthShape, 'another seed, another shape');
});

test('CAD-15: a bootstrap year\'s shape is that year\'s real months', () => {
  const { sd } = HISTORICAL_BOOTSTRAP_SERIES;
  const h = new EquityReturnTickHandler({ model: 'HISTORICAL_BOOTSTRAP', vol: 0.18, monthShape: true,
    beta: { EQUITY_US: 1 }, idioVol: { EQUITY_US: 0 }, auReplay: false });
  const a = h.call({ sim: tickSim(), state: {} })[0];
  const i = a.bootstrap.index;
  const ys = HISTORICAL_EQUITY_RETURNS.months.slice(12 * i, 12 * i + 12);
  const mean = sum(ys) / 12;
  const k = (0.18 / sd) / MONTHLY_AVERAGE_SD_RATIO;
  ys.forEach((y, m) => assert.ok(near(a.monthShape.EQUITY_US[m], (y - mean) * k, 1e-12), `month ${m}`));
});

test('CAD-16: a shaped year compounds to exactly 1 + T', () => {
  const shape = [0.06, -0.02, 0.03, -0.09, 0.01, 0.04, -0.05, 0.02, 0.0, 0.03, -0.04, 0.01];
  for (const [rateKey, label] of [['EQUITY_US', 'sleeve key'], ['EQUITY_US::acct', 'per-account key']]) {
    const s = oneLot(100_000, { rateKey });
    s.effectiveGrowthRates[rateKey] = T;
    s.equityMonthShape = { EQUITY_US: shape };
    const credits = [];
    for (let m = 0; m < 12; m++) {
      const g = growth(s, { periodsPerYear: 12, monthIndex: m }).amount;
      credits.push(g); credit(s, g);
    }
    assert.ok(near(mvOf(s), 100_000 * (1 + T), 0.10), `${label}: ${mvOf(s)}`);
    assert.ok(credits[3] < 0 && credits[0] > credits[1], `${label}: the months move`);
  }
});

test('CAD-17: the index steps through the same shaped months', () => {
  const shape = [0.06, -0.02, 0.03, -0.09, 0.01, 0.04, -0.05, 0.02, 0.0, 0.03, -0.04, 0.01];
  const base = { baseGrowthRates: { EQUITY_US: T }, effectiveGrowthRates: { EQUITY_US: T },
                 marketDividendYields: { EQUITY_US: 0 }, securities: {}, equityMonthShape: { EQUITY_US: shape } };
  let s = { ...base, ...seedIndexLevels(base, ms(2026)) };
  const lot = oneLot(100, { rateKey: 'EQUITY_US' });
  lot.marketDividendYields.EQUITY_US = 0;
  lot.equityMonthShape = { EQUITY_US: shape };
  const r = new MarketIndexReducer();
  for (let m = 1; m <= 12; m++) {
    s = runReducer(r, s, makeAction('MARKET_INDEX_STEP_APPLY', { periodsPerYear: 12 }), new Date(Date.UTC(2026, m, 0)));
    lot.acct.holdings[0].marketValue += computeHoldingsGrowth({ state: lot, stateKey: 'acct', fallbackRateKey: 'EQUITY_US',
      periodsPerYear: 12, monthIndex: m - 1 }).amount;
    assert.ok(near(s.marketIndex.EQUITY_US.total, lot.acct.holdings[0].marketValue, 0.01), `month ${m}`);
  }
});
