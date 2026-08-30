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
    rothGrowthRate: BASE, iraGrowthRate: 0, k401GrowthRate: 0,
    brokerageGrowthRate: 0, brokerageDividendRate: 0,
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
emit('**Not covered here:** `SF_BAY_HOUSING_CRASH` (real property, not equity) and the three');
emit('`CURVE_*` presets (pure term-structure, no equity path). The housing preset is');
emit('calibrated the same way — 1 % of San Francisco\'s fall was front-loaded, so a −0.6 %');
emit('break plus a −31.75 pp drag over three year-ends composes to the measured −45.3 % —');
emit('but that composition is arithmetic, not a simulation, because this probe\'s scenario');
emit('holds no property. Treat it as one notch less verified than the rows above.');
emit('');

if (process.argv.includes('--write')) {
  const dest = path.join(ROOT, 'docs/economic-shocks/CALIBRATION.md');
  fs.writeFileSync(dest, out.join('\n') + '\n');
  console.log(`\nwrote ${dest}`);
}

if (process.argv.includes('--start-sensitivity')) {
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
