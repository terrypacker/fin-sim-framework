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
 * shock-path — the emergent equity path of a shock, measured by running the real engine.
 * Shared by `scripts/probes/shock-path-engine.mjs` (the calibration table) and
 * `scripts/probes/fit-shock-presets.mjs` (the fit, design 127 phase 3).
 *
 * One Roth account on the US market, no spending, no tax, no inflation: the only thing
 * moving the balance is the shock. A sleeve other than US is measured by remapping its
 * adjustments onto EQUITY_US and running at that sleeve's base rate (`asSleeve`), which is
 * the same arithmetic on a different key.
 */
import { ServiceRegistry } from '../../src/services/service-registry.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }    from '../../src/index.js';

export const START_YEAR = 2026;
export const YEARS      = 20;
export const BASE       = 0.07;

/**
 * What each preset is calibrated to, transcribed from docs/economic-shocks/MEASUREMENTS.md.
 * Monthly averages, and months counted from the pre-shock peak. LOST_DECADE_2000 is judged
 * on its ten-year cumulative instead of its trough — that is the whole point of it.
 * `au` is the OECD AU broad index for the same episode, where one is measured (§1).
 */
export const TARGETS = {
  MARKET_CRASH_2008_LITE: { episode: 'GFC (Oct 2007 – Mar 2009)',   depth: -0.508, trough: 17, back: 65, cum10:  0.661,
                            au: { depth: -0.493, trough: 17, back: 141 } },
  STAGFLATION_1970S_LITE: { episode: 'Stagflation (1973 – 1974)',   depth: -0.434, trough: 23, back: 90, cum10:  0.219,
                            au: { depth: -0.541, trough: 21, back: 80 } },
  // cumAt: the S&P price index from the Jan 2020 peak to Sep 2024, the last month on disk:
  // +68.4 % in 56 months (Shiller-SP500-monthly.csv). The library's COVID comment cited it as
  // "year 5", which it is not.
  COVID_2020_LITE:        { episode: 'COVID (Jan – Mar 2020)',      depth: -0.191, trough: 2,  back: 7,
                            cumAt: { months: 56, value: 0.684 },
                            au: { depth: -0.238, trough: 2, back: 14 } },
  MILD_CORRECTION:        { episode: '2018 Q4 correction',          depth: -0.115, trough: 3,  back: 7  },
  // Dot-com's own +10y is −26.8 %, but that window RUNS INTO THE GFC — which is precisely
  // why LOST_DECADE_2000 exists as a separate preset. Left blank rather than bake one
  // episode's tail into another's calibration. AU's own bust (Feb 2002 – Mar 2003) is the
  // preset's `equity-au` leg.
  DOTCOM_2000_LITE:       { episode: 'Dot-com (Aug 2000 – Feb 2003)', depth: -0.437, trough: 30, back: 81,
                            au: { depth: -0.185, trough: 13, back: 28 } },
  LOST_DECADE_2000:       { episode: 'Lost decade (Mar 2000 – Mar 2010)', depth: null, trough: null, back: 156, cum10: -0.201 },
  // Shiller/Cowles monthly, Aug 1892 → Aug 1896 (MEASUREMENTS §1, §10).
  RAILROAD_PANIC_1893:    { episode: 'Panic of 1893 (Aug 1892 – Aug 1896)', depth: -0.322, trough: 48, back: 76 },
  // From Aug 1873, the last pre-panic month (MEASUREMENTS §11).
  RAILROAD_PANIC_1873:    { episode: 'Panic of 1873 (Aug 1873 – Jun 1877)', depth: -0.451, trough: 46, back: 77 },
};

/** The library default base total returns (design 99), by sleeve. */
export const SLEEVE_BASE = { EQUITY_US: 0.07, EQUITY_AU: 0.067, EQUITY_INTL_EX_US: 0.069, EQUITY_INTL_EX_AU: 0.075 };

/** The probe's one person and its two accounts (also used by the probe's rate-path check). */
export const SHOCK_PROBE_PERSONS = [{ __type: 'Person', id: 'primary', name: 'P', birthDate: '1975-04-15', citizen: ['US'],
  lifeExpectancy: 120, monthlyWage: 0, retirementDate: '2025-01-01', socialSecurityMonthly: 0 }];
export const SHOCK_PROBE_ACCOUNTS = [
  { __type: 'SavingsAccount', id: 'checking', name: 'C', role: 'us-savings', stateKey: 'checkingAccount',
    initialValue: 50000, ownershipType: 'sole', ownerId: 'primary', minimumBalance: 0, country: 'US',
    currency: { code: 'USD', symbol: '$' } },
  { __type: 'RothAccount', stateKey: 'rothAccount', role: 'roth-ira', name: 'R', initialValue: 100000,
    contributionBasis: 0, ownerId: 'primary', drawdownPriority: 5, country: 'US',
    currency: { code: 'USD', symbol: '$' } },
];

function config({ base = BASE, cadence = 'MONTHLY' } = {}) {
  return {
    toolsets: ['US_BANKING', 'US_TAX', 'US_RETIREMENT', 'ECONOMIC_REGIMES'],
    simStart: `${START_YEAR}-01-01`, simEnd: `${START_YEAR + YEARS}-01-01`,
    parameters: {
      monthlyExpenses: 0, inflationAdjust: false, inflationRate: 0,
      // The Roth is the only equity account, so the US market total IS its rate (design 99).
      usEquityGrowthRate: base,
      fixedIncomeInterestRate: 0, usSavingsInterestRate: 0,
      // Design 127 — the presets are calibrated under MONTHLY crediting, which integrates the
      // recovery curve month by month. ANNUAL shows the old 31 Dec sampling.
      equityEarningsCadence: cadence,
    },
    persons:  SHOCK_PROBE_PERSONS,
    accounts: SHOCK_PROBE_ACCOUNTS,
  };
}

/**
 * Run the probe scenario under `shocks` and return the Roth balance on the 1st of every
 * month, from the start through YEARS years.
 *
 * @param {object[]} shocks
 * @param {{ base?: number, cadence?: 'MONTHLY'|'ANNUAL' }} [opts]
 * @returns {number[]}
 */
export function runPath(shocks, opts = {}) {
  ServiceRegistry.resetAll();
  const cfg = structuredClone(config(opts));
  cfg.parameters.shocks = shocks;
  const services = ServiceRegistry.getInstance();
  const sc = new BaseScenario({
    context: services.simulationContext,
    simStart: new Date(`${START_YEAR}-01-01`), simEnd: new Date(`${START_YEAR + YEARS}-01-01`),
  });
  sc.buildSim({ telemetry: 'off' });
  new ScenarioLoader().load(cfg, services);
  const out = [];
  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  try {
    for (let m = 0; m <= YEARS * 12; m++) {
      sc.sim.stepTo(new Date(Date.UTC(START_YEAR, m, 1)));
      out.push(sc.sim.state.rothAccount.balance);
    }
  } finally { console.log = log; console.warn = warn; }
  return out;
}

/**
 * Trough / back-to-peak / gap-vs-counterfactual, read off a shocked vs unshocked pair.
 * `shockMonth` is the index of the last observation BEFORE the shock lands — every figure
 * is stated relative to that pre-shock peak, and every month is counted from it.
 */
export function summarizePath(none, shocked, shockMonth) {
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
    cum10: shocked[shockMonth + 120] / shocked[shockMonth] - 1,
    /** Cumulative change `months` after the pre-shock peak. */
    cumAt: (months) => shocked[shockMonth + months] / shocked[shockMonth] - 1,
  };
}

/**
 * A shock as one sleeve sees it, remapped onto EQUITY_US so the US-only probe can measure
 * it: each leg keeps only that sleeve's equity adjustment (renamed EQUITY_US), the level
 * break keeps only that sleeve's multiplier, and non-equity legs are dropped. Run it with
 * `runPath(..., { base: SLEEVE_BASE[sleeve] })`.
 */
export function asSleeve(shock, sleeve) {
  if (sleeve === 'EQUITY_US') return shock;
  if (shock.preset) throw new Error('asSleeve: pass the full shock object, not a { preset } reference');
  const level = (shock.levelEffects?.equityRevaluation ?? []).filter(e => e.rateKeys.includes(sleeve));
  const legs = (shock.legs ?? []).flatMap(l => {
    const v = l.regime?.returnAdjustment?.[sleeve];
    return v == null ? [] : [{ ...l, tags: [], regime: { returnAdjustment: { EQUITY_US: v } } }];
  });
  return {
    ...shock,
    shockId: `${shock.shockId}@${sleeve}`,
    levelEffects: level.length ? { equityRevaluation: level.map(e => ({ rateKeys: ['EQUITY_US'], multiplier: e.multiplier })) } : undefined,
    legs,
  };
}
