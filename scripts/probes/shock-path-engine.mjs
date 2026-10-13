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
 * shock-path-engine — the EMERGENT equity path of every shock preset, measured by running
 * the real engine, against the measured episode it is calibrated to.
 *
 *   node scripts/probes/shock-path-engine.mjs
 *   node scripts/probes/shock-path-engine.mjs --start-sensitivity
 *   node scripts/probes/shock-path-engine.mjs --write   # rewrite CALIBRATION.md
 *
 * ── Why an ENGINE probe and not arithmetic ────────────────────────────────────
 * It is tempting to compose a preset's path on paper: level break, then compound at
 * `base + drag × recoveryFactor(t)` month by month. That is wrong, and wrong in a way that
 * flatters the presets. Equity earnings fire on a **year-end EventSeries** and apply
 * `balance × rate × 1` — simple, annual. The recovery factor is recomputed monthly by
 * ECONOMIC_RECOVERY_TICK, but for equity it is only ever SAMPLED on 31 December, so a
 * decline is only expressible in whole years and most of a short curve is invisible.
 * Only the engine knows that. Everything printed here comes out of a real simulation.
 *
 * One account, one holding, no spending, no tax, no inflation — so the only thing moving
 * the balance is the shock.
 */
import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ServiceRegistry } from '../../src/services/service-registry.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }    from '../../src/index.js';
import { SHOCK_LIBRARY }   from '../../src/finance/economic-shocks/shock-library.js';
import { parseFlags } from '../lib/cli.mjs';

const opts = parseFlags(process.argv.slice(2), {
  usage: 'node scripts/probes/shock-path-engine.mjs [--write] [--start-sensitivity]\n\n'
       + 'shock-path-engine — trace what each shock preset does to the return path.',
  write:            { type: 'flag', help: 'write the generated table back into the source file' },
  startSensitivity: { type: 'flag', help: 'also report sensitivity to the start date' },
});


/**
 * What each preset is calibrated to, transcribed from docs/economic-shocks/MEASUREMENTS.md.
 * Monthly averages, and months counted from the pre-shock peak. LOST_DECADE_2000 is judged
 * on its ten-year cumulative instead of its trough — that is the whole point of it.
 */
const TARGETS = {
  MARKET_CRASH_2008_LITE: { episode: 'GFC (Oct 2007 – Mar 2009)',   depth: -0.508, trough: 17, back: 65, cum10:  0.661 },
  STAGFLATION_1970S_LITE: { episode: 'Stagflation (1973 – 1974)',   depth: -0.434, trough: 23, back: 90, cum10:  0.219 },
  COVID_2020_LITE:        { episode: 'COVID (Jan – Mar 2020)',      depth: -0.191, trough: 2,  back: 7  },
  MILD_CORRECTION:        { episode: '2018 Q4 correction',          depth: -0.115, trough: 3,  back: 7  },
  // Dot-com's own +10y is −26.8 %, but that window RUNS INTO THE GFC — which is precisely
  // why LOST_DECADE_2000 exists as a separate preset. Left blank rather than bake one
  // episode's tail into another's calibration.
  DOTCOM_2000_LITE:       { episode: 'Dot-com (Aug 2000 – Feb 2003)', depth: -0.437, trough: 30, back: 81 },
  LOST_DECADE_2000:       { episode: 'Lost decade (Mar 2000 – Mar 2010)', depth: null, trough: null, back: 156, cum10: -0.201 },
  // Shiller/Cowles monthly, Aug 1892 → Aug 1896 (MEASUREMENTS §1, §10).
  RAILROAD_PANIC_1893:    { episode: 'Panic of 1893 (Aug 1892 – Aug 1896)', depth: -0.322, trough: 48, back: 76 },
  // From Aug 1873, the last pre-panic month (MEASUREMENTS §11).
  RAILROAD_PANIC_1873:    { episode: 'Panic of 1873 (Aug 1873 – Jun 1877)', depth: -0.451, trough: 46, back: 77 },
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const START_YEAR = 2026;
const YEARS      = 20;
const BASE       = 0.07;

const CFG = {
  toolsets: ['US_BANKING', 'US_TAX', 'US_RETIREMENT', 'ECONOMIC_REGIMES'],
  simStart: `${START_YEAR}-01-01`, simEnd: `${START_YEAR + YEARS}-01-01`,
  parameters: {
    monthlyExpenses: 0, inflationAdjust: false, inflationRate: 0,
    // The Roth is the only equity account, so the US market total IS its rate (design 99).
    usEquityGrowthRate: BASE,
    fixedIncomeInterestRate: 0, usSavingsInterestRate: 0,
  },
  persons: [{ __type: 'Person', id: 'primary', name: 'P', birthDate: '1975-04-15', citizen: ['US'],
    lifeExpectancy: 120, monthlyWage: 0, retirementDate: '2025-01-01', socialSecurityMonthly: 0 }],
  accounts: [
    { __type: 'SavingsAccount', id: 'checking', name: 'C', role: 'us-savings', stateKey: 'checkingAccount',
      initialValue: 50000, ownershipType: 'sole', ownerId: 'primary', minimumBalance: 0, country: 'US',
      currency: { code: 'USD', symbol: '$' } },
    { __type: 'RothAccount', stateKey: 'rothAccount', role: 'roth-ira', name: 'R', initialValue: 100000,
      contributionBasis: 0, ownerId: 'primary', drawdownPriority: 5, country: 'US',
      currency: { code: 'USD', symbol: '$' } },
  ],
};

/** Run one configuration and return the monthly Roth balance path. */
function run(shocks) {
  ServiceRegistry.resetAll();
  const cfg = structuredClone(CFG);
  cfg.parameters.shocks = shocks;
  const services = ServiceRegistry.getInstance();
  const sc = new BaseScenario({
    context: services.simulationContext,
    simStart: new Date(`${START_YEAR}-01-01`), simEnd: new Date(`${START_YEAR + YEARS}-01-01`),
  });
  sc.buildSim();
  new ScenarioLoader().load(cfg, services);
  const out = [];
  for (let m = 0; m <= YEARS * 12; m++) {
    sc.sim.stepTo(new Date(Date.UTC(START_YEAR, m, 1)));
    out.push(sc.sim.state.rothAccount.balance);
  }
  return out;
}

/**
 * Trough / back-to-peak / gap-vs-counterfactual, read off a shocked vs unshocked pair.
 * `shockMonth` is the index of the last observation BEFORE the shock lands — every figure
 * is stated relative to that pre-shock peak, and every month is counted from it.
 */
function summarize(none, shocked, shockMonth) {
  const t0 = shocked[shockMonth];
  let trough = { t: shockMonth, v: t0 };
  for (let t = shockMonth; t < shocked.length; t++) if (shocked[t] < trough.v) trough = { t, v: shocked[t] };
  let backToPeak = null;
  for (let t = trough.t; t < shocked.length; t++) { if (shocked[t] >= t0) { backToPeak = t; break; } }
  // The gap versus the world where the shock never happened — this one NEVER closes,
  // because a recovery curve can only fade a drag to zero, never overshoot it.
  const endGap = shocked[shocked.length - 1] / none[none.length - 1] - 1;
  return {
    depth: trough.v / t0 - 1,
    troughMonth: trough.t - shockMonth,
    backToPeak: backToPeak == null ? null : backToPeak - shockMonth,
    endGap,
  };
}

const pct = (x, dp = 1) => (x == null ? '—' : `${(x * 100).toFixed(dp)} %`);
const mo  = (x) => (x == null ? 'never' : `${x} mo`);

const out = [];
const emit = (...a) => out.push(a.join(' '));

const none = run([]);

emit('# Shock preset calibration — engine-measured path vs measured episode');
emit('');
emit('Generated by `scripts/probes/shock-path-engine.mjs --write`. Do not hand-edit.');
emit('');
emit(`Generated: ${new Date().toISOString().slice(0, 10)}`);
emit('');
emit('Every figure below comes out of a real simulation, not from composing the preset on');
emit('paper. Targets are from `MEASUREMENTS.md`.');
emit('');
emit('**`durationMonths` is none of these columns.** It is the life of the depressed-return');
emit('regime. The trough is where `base + drag × recoveryFactor(t)` crosses zero; the return');
emit('to the prior peak is wherever compounding — including any rebound tailwind — gets back');
emit('there. Both are emergent, and both are what this file checks.');
emit('');

console.log('# Engine-measured shock paths');
console.log('');
console.log(`One Roth account, ${pct(BASE, 0)} baseline, no spending. Shock on 15 Jan ${START_YEAR + 1}.`);
console.log('Equity earnings fire year-end, so the recovery factor is only SAMPLED on 31 Dec.');
console.log('');
console.log('| preset | depth | trough | back to peak | gap vs no-shock @20y |');
console.log('|---|---|---|---|---|');

const presets = Object.keys(SHOCK_LIBRARY).filter(k => {
  const s = SHOCK_LIBRARY[k];
  const legs = s.legs ?? [{ regime: s.regime }];
  return s.levelEffects?.equityRevaluation
      || legs.some(l => l.regime?.returnAdjustment && Object.keys(l.regime.returnAdjustment)
           .some(rk => rk.startsWith('EQUITY')));
});

emit('| preset | | depth | trough | back to peak | 10-yr cum |');
emit('|---|---|---|---|---|---|');

for (const key of presets) {
  const p = run([{ preset: key, startDate: `${START_YEAR + 1}-01-15` }]);
  const s = summarize(none, p, 12);
  const cum10 = p[12 + 120] / p[12] - 1;
  console.log(`| ${key} | ${pct(s.depth)} | ${mo(s.troughMonth)} | ${mo(s.backToPeak)} | ${pct(s.endGap)} |`);

  const t = TARGETS[key];
  emit(`| **${key}** | model | ${pct(s.depth)} | ${mo(s.troughMonth)} | ${mo(s.backToPeak)} | ${pct(cum10)} |`);
  if (t) {
    emit(`| _${t.episode}_ | measured | ${t.depth == null ? '—' : pct(t.depth)} `
       + `| ${t.trough == null ? '—' : mo(t.trough)} | ${mo(t.back)} `
       + `| ${t.cum10 == null ? '—' : pct(t.cum10)} |`);
  }
}
emit('');
emit('The trough column reads in whole years for every composed preset, because equity');
emit('growth is applied once a year. A 17-month slide is expressible only as "two year-ends",');
emit('which is why the GFC preset bottoms at 24 months against a measured 17.');
emit('');
// ── Stagflation: money by phase (design 121 §4-5) ─────────────────────────────────

/**
 * Measured targets for the stagflation's rate phases, transcribed from MEASUREMENTS §12.
 * US FI is the 5-year, US policy is fed funds; AU FI is the 10-year, AU policy the 3-month bill.
 */
const PHASES = [
  { label: '0–120 mo',   from: 0,   to: 120, episode: 'US 1973–80 · AU 1973–80',
    us: { fi: -1.0, policy: -0.8 }, au: { fi: -2.0, policy: -1.6 } },
  { label: '120–180 mo', from: 120, to: 180, episode: 'US 1981–85 · AU 1981–90',
    us: { fi: 7.2, policy: 6.4 },   au: { fi: 5.5, policy: 6.6 } },
  { label: '180–240 mo', from: 180, to: 240, episode: 'US 1986–90 · AU 1981–90',
    us: { fi: 4.0, policy: 3.5 },   au: { fi: 5.5, policy: 6.6 } },
  { label: '240–348 mo', from: 240, to: 348, episode: 'US — · AU 1991–99',
    us: null,                       au: { fi: 6.0, policy: 4.4 } },
];

/** Gold, London annual average deflated by CPI-U (MEASUREMENTS §12c). */
const GOLD_REAL = { run: { multiple: 5.35, years: 8 }, bust: { multiple: 0.39, years: 10 } };

/**
 * The monthly effective rates a scenario at the LIBRARY DEFAULT bases sees under `shocks`, one
 * row per month from the shock's start. No rate overrides: the preset's legs are computed
 * against those defaults, so that is the only base this check is meaningful at.
 */
function ratePath(shocks, monthsOut) {
  ServiceRegistry.resetAll();
  const end   = new Date(Date.UTC(START_YEAR + 1, monthsOut + 1, 1));
  const cfg = {
    toolsets: ['US_BANKING', 'US_TAX', 'US_RETIREMENT', 'AU_BANKING', 'ECONOMIC_REGIMES'],
    simStart: `${START_YEAR}-01-01`, simEnd: end.toISOString().slice(0, 10),
    parameters: { shocks },
    persons: CFG.persons,
    accounts: [CFG.accounts[0]],
  };
  const services = ServiceRegistry.getInstance();
  const sc = new BaseScenario({ context: services.simulationContext,
    simStart: new Date(`${START_YEAR}-01-01`), simEnd: end });
  sc.buildSim();
  new ScenarioLoader().load(cfg, services);
  const rows = [];
  for (let m = 0; m < monthsOut; m++) {
    // Mid-month, so a leg that starts on the 1st is read inside its own month.
    sc.sim.stepTo(new Date(Date.UTC(START_YEAR + 1, m, 15)));
    const s = sc.sim.state;
    rows.push({
      fiUs: s.effectiveInterestRates.FIXED_INCOME_US, primeUs: s.effectiveInterestRates.PRIME_US,
      fiAu: s.effectiveInterestRates.FIXED_INCOME_AU, primeAu: s.effectiveInterestRates.PRIME_AU,
      infUs: s.effectiveInflationRates.US, infAu: s.effectiveInflationRates.AU,
      gold: s.effectiveGrowthRates.GOLD,
    });
  }
  return rows;
}

const avg = (rows, from, to, f) => rows.slice(from, to).reduce((x, r) => x + f(r), 0) / (to - from);
const rp  = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}`;
const tp  = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(1)}`;
/** Real multiple of an asset growing at the monthly `gold` rate against `infUs`, months [from, to). */
const realMultiple = (rows, from, to) => rows.slice(from, to)
  .reduce((x, r) => x * (1 + r.gold) ** (1 / 12) / (1 + r.infUs) ** (1 / 12), 1);

const stag = ratePath([{ preset: 'STAGFLATION_1970S_LITE', startDate: `${START_YEAR + 1}-01-01` }], 348);

emit('## STAGFLATION_1970S_LITE — rates, inflation and gold by phase');
emit('');
emit('Real = phase average of the effective rate minus the phase average of effective');
emit('inflation, at the library default bases (US/AU fixed income 4 %, policy 4.5 % / 4.35 %,');
emit('inflation 3 %). Targets from `MEASUREMENTS.md` §12. The legs are additive, so a plan on');
emit('other bases shifts every row by its own base real rate (design 121 §4).');
emit('');
emit('| window | | US infl. | US FI real | US policy real | AU infl. | AU FI real | AU policy real |');
emit('|---|---|--:|--:|--:|--:|--:|--:|');
for (const ph of PHASES) {
  const a = (f) => avg(stag, ph.from, ph.to, f);
  const infUs = a(r => r.infUs), infAu = a(r => r.infAu);
  emit(`| **${ph.label}** | model | ${(infUs * 100).toFixed(1)} | ${rp(a(r => r.fiUs) - infUs)} `
    + `| ${rp(a(r => r.primeUs) - infUs)} | ${(infAu * 100).toFixed(1)} | ${rp(a(r => r.fiAu) - infAu)} `
    + `| ${rp(a(r => r.primeAu) - infAu)} |`);
  emit(`| _${ph.episode}_ | measured | | ${ph.us ? tp(ph.us.fi) : '—'} | ${ph.us ? tp(ph.us.policy) : '—'} `
    + `| | ${tp(ph.au.fi)} | ${tp(ph.au.policy)} |`);
}
emit('');
emit('The 180–240 row is the US fade (U/120 holds five years, then fades over five), so it');
emit('sits between the 1981–85 step and base; its average is close to 1986–90.');
emit('');

// The historical gold shape as a custom shock to run ALONGSIDE the preset. Each leg's
// adjustment is what lifts the preset's own gold rate to the measured real return, given the
// preset's inflation in that window.
const runReal  = GOLD_REAL.run.multiple ** (1 / GOLD_REAL.run.years) - 1;
const bustReal = GOLD_REAL.bust.multiple ** (1 / GOLD_REAL.bust.years) - 1;
const runMonths = GOLD_REAL.run.years * 12, bustMonths = GOLD_REAL.bust.years * 12;
const adjFor = (real, from, to) => {
  const infl = avg(stag, from, to, r => r.infUs), gold = avg(stag, from, to, r => r.gold);
  return Math.round(((1 + real) * (1 + infl) - 1 - gold) * 1000) / 1000;
};
const goldShock = {
  shockId: 'GOLD_1970S_HISTORICAL', name: 'Gold, 1972-90 shape', startDate: `${START_YEAR + 1}-01-01`,
  legs: [
    { id: 'run', regime: { returnAdjustment: { GOLD: adjFor(runReal, 0, runMonths) } },
      recovery: { profile: 'L', durationMonths: runMonths } },
    { id: 'bustInInflation', startMonths: runMonths,
      regime: { returnAdjustment: { GOLD: adjFor(bustReal, runMonths, 120) } },
      recovery: { profile: 'L', durationMonths: 120 - runMonths } },
    { id: 'bust', startMonths: 120,
      regime: { returnAdjustment: { GOLD: adjFor(bustReal, 120, runMonths + bustMonths) } },
      recovery: { profile: 'L', durationMonths: runMonths + bustMonths - 120 } },
  ],
};
const both = ratePath([{ preset: 'STAGFLATION_1970S_LITE', startDate: `${START_YEAR + 1}-01-01` }, goldShock],
  runMonths + bustMonths);

emit('### Gold');
emit('');
emit('The preset\'s `inflation` leg adds +5 pp to `GOLD`, one-for-one with the US inflation');
emit('leg, so gold keeps its base real return through the decade (+2 %/yr at the library');
emit('defaults) instead of losing about 3 %/yr to the inflation leg (design 121 §5). It does not');
emit('reproduce history, on purpose: much of 1972-80 was the one-off re-pricing after Bretton');
emit('Woods, and building it in would make gold the guaranteed winner of every stagflation draw.');
emit('');
emit('| window | preset alone | preset + historical shock | measured |');
emit('|---|--:|--:|--:|');
emit(`| 0–${runMonths} mo, real × | ${realMultiple(stag, 0, runMonths).toFixed(2)} `
  + `| ${realMultiple(both, 0, runMonths).toFixed(2)} | ${GOLD_REAL.run.multiple.toFixed(2)} (1972 → 1980) |`);
emit(`| ${runMonths}–${runMonths + bustMonths} mo, real × | ${realMultiple(stag, runMonths, runMonths + bustMonths).toFixed(2)} `
  + `| ${realMultiple(both, runMonths, runMonths + bustMonths).toFixed(2)} | ${GOLD_REAL.bust.multiple.toFixed(2)} (1980 → 1990) |`);
emit('');
emit('For the upper bound, add this custom shock to `shocks` beside the preset, with the same');
emit('`startDate`. Its adjustments are sized against the preset\'s own gold and inflation legs, so');
emit('it is only right in that pairing, and only at the library default bases.');
emit('');
emit('```json');
emit(JSON.stringify(goldShock, null, 2));
emit('```');
emit('');

emit('**Not covered here:** `SF_BAY_HOUSING_CRASH` (real property, not equity) and the three');
emit('`CURVE_*` presets (pure term-structure, no equity path). The housing preset is');
emit('calibrated the same way — 1 % of San Francisco\'s fall was front-loaded, so a −0.6 %');
emit('break plus a −31.75 pp drag over three year-ends composes to the measured −45.3 % —');
emit('but that composition is arithmetic, not a simulation, because this probe\'s scenario');
emit('holds no property. Treat it as one notch less verified than the rows above.');
emit('');

if (opts.write) {
  const dest = path.join(ROOT, 'docs/economic-shocks/CALIBRATION.md');
  fs.writeFileSync(dest, out.join('\n') + '\n');
  console.log(`\nwrote ${dest}`);
}

if (opts.startSensitivity) {
  console.log('');
  console.log('## Start-date sensitivity');
  console.log('');
  console.log('The same shock, moved around the calendar. Equity growth is applied once a year at');
  console.log('year-end, so what a shock does to equity depends on WHERE ITS RECOVERY CURVE SITS');
  console.log('on 31 December — not on the curve\'s whole area.');
  console.log('');
  console.log('| preset | Jan 15 | Apr 15 | Jul 15 | Oct 15 | spread |');
  console.log('|---|---|---|---|---|---|');
  for (const key of presets) {
    const depths = ['01-15', '04-15', '07-15', '10-15'].map(md => {
      const p = run([{ preset: key, startDate: `${START_YEAR + 1}-${md}` }]);
      return summarize(none, p, 12).depth;
    });
    const spread = Math.max(...depths) - Math.min(...depths);
    console.log(`| ${key} | ${depths.map(d => pct(d)).join(' | ')} | ${pct(spread)} |`);
  }
}
