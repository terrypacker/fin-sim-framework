#!/usr/bin/env node
/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * probe-988-method-dispersion.mjs — design 87 G6's DECIDING measurement.
 *
 * `§1.988-2(a)(2)(iii)(B)(1)` lets a taxpayer consume currency lots by "any reasonable
 * method that is consistently applied from year to year … to all accounts", and names
 * FIFO, LIFO and pro rata. Design 87 built two of them and left the CHOICE open. This is
 * the measurement §14.2 says would settle it, and which had never been run:
 *
 * > run both conventions across MC rate paths on a plan with a `moveYear` and compare
 * > DISPERSION, not a point estimate.
 *
 * ─── why dispersion and not a winner ────────────────────────────────────────────────
 *
 * Over a pool's whole life the two methods AGREE: both consume 100% of the basis, so
 * method never changes a lifetime total. It only decides which DISPOSITION each dollar of
 * basis attaches to, and therefore which year, which business fraction and which
 * residency. So the question is never "which method won on the path that happened" — the
 * election is locked at adoption and binds every later year, which makes the criterion
 * robustness across paths. A point estimate on one FX path answers the wrong question.
 *
 * ─── the two traps this probe is built to avoid ─────────────────────────────────────
 *
 * 1. **A pinned FX rate measures nothing** (design 87 §7 trap 5). §988 measures
 *    acquisition → disposition, so `fxProcessModel: NONE` freezes the RATE OF gain, not
 *    the gain, and every disposition then measures a rate against itself. This probe
 *    forces a live process model and refuses to run without one.
 * 2. **A scenario can be structurally unable to separate the methods** (design 87 §14.2).
 *    They converge on a pool that is nearly a single lot, and the historical study
 *    measured exactly that shape and concluded "immaterial" — twice, once from a stale
 *    number. So the report prints the SEPARABILITY diagnostics next to the answer:
 *    how much §988 was recognized at all, how it split ordinary/capital, and whether the
 *    arms differ on any seed. A zero spread means one of two very different things, and
 *    the probe says which.
 *
 * Usage:
 *   node scripts/probes/probe-988-method-dispersion.mjs [--scenario plan.json] \
 *        [--seeds 40] [--vol 0.10] [--move-year 2032] [--json out.json]
 *
 * With no `--scenario` this runs the synthetic default, which answers a question about
 * the ENGINE (does method move anything at all, and in which direction) rather than about
 * a plan. Say which you ran.
 */

import { writeFileSync } from 'node:fs';

import { loadBaseConfig } from '../lib/scenario-source.mjs';
import { buildVariant, allParams } from '../lib/variant.mjs';
import { openSim, quiet } from '../lib/run.mjs';
import { computeAfterTaxNetWorth, afterTaxOptionsFromParams }
  from '../../src/finance/derived-metrics/after-tax.js';
import { LEDGER_METHOD } from '../../src/finance/account-rules/currency-lots.js';

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const num  = (n, d) => { const v = flag(n); return v == null ? d : Number(v); };

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`usage: probe-988-method-dispersion.mjs [--scenario plan.json] [--index 0]
       [--seeds 40] [--vol 0.10] [--reversion 0.5] [--move-year <y>]
       [--au-rental] [--json out.json]`);
  process.exit(0);
}

const SEEDS     = num('seeds', 40);
const VOL       = num('vol', 0.10);
const REVERSION = num('reversion', 0.5);
const MOVE_YEAR = flag('move-year') != null ? Number(flag('move-year')) : null;
// Make the AU property an income-producing rental with running costs, so the §212
// (ORDINARY) branch of §988 actually fires — see armCfg for why nothing else can.
const AU_RENTAL = argv.includes('--au-rental');
const METHODS   = [LEDGER_METHOD.PRO_RATA, LEDGER_METHOD.FIFO];

const { cfg: base, source, synthetic } = loadBaseConfig({
  file: flag('scenario'), index: num('index', 0),
});

/**
 * One arm's cfg. Everything except `fxBasisMethod` is held identical across the two
 * methods at a given seed — common random numbers, so a paired difference isolates the
 * election instead of FX noise. [[rng-shared-by-all-stochastic-consumers]]: the seed
 * drives every draw, so changing anything else here would decouple the pair.
 */
function armCfg(method, seed) {
  const levers = {
    params: {
      randomSeed:       seed,
      fxProcessModel:   'MEAN_REVERTING',
      fxVolatility:     VOL,
      fxReversionSpeed: REVERSION,
      fxBasisMethod:    method,
    },
  };
  if (MOVE_YEAR != null) levers.moveYear = MOVE_YEAR;
  const cfg = buildVariant(base, levers);

  // `--au-rental` turns the ORDINARY branch on, and without it a large part of the
  // question is not being asked. §14.2 names the `moveYear` as the strongest separator of
  // the two methods, because §988(a)(3)(B) sources by tax home, so method decides how much
  // basis is consumed while US-source versus foreign-source — different §904 baskets,
  // different FTC. But that axis exists only for the ORDINARY share: a personal
  // disposition is not a §988 transaction at all (`§1.988-1(a)(9)`), so it carries no
  // source and cannot exercise the basket at all.
  //
  // And a household plan has NO ordinary share. Every emitter that fires on a default
  // scenario DECLARES `businessFraction: 0` — living expenses by `§1.988-1(a)(9)(ii)`
  // Example 2, tax payments by the `§988(e)(3)(B)` carve-out, conversions because a
  // conversion has no allocable expense. The account's own `deductibleFraction` is only a
  // FALLBACK and never gets consulted, which is why authoring it on the pool changes
  // nothing (measured; do not re-derive). The ordinary branch needs a property whose
  // expenses are §212, so this flag makes the AU house a rental with running costs and
  // lets `HouseRunningCostHandler` debit the AU pool at fraction 1.
  if (AU_RENTAL) {
    for (const rec of cfg.realProperties ?? []) {
      if (rec.country !== 'AU') continue;
      rec.rentalEnabled     = true;
      rec.monthlyRent       = rec.monthlyRent ?? 4000;
      rec.annualRunningCost = rec.annualRunningCost || 24000;
    }
    for (const st of Object.values(cfg.initialState ?? {})) {
      if (st?.kind === 'real-property' && st.country === 'AU') {
        st.rentalEnabled     = true;
        st.monthlyRent       = st.monthlyRent ?? 4000;
        st.annualRunningCost = st.annualRunningCost || 24000;
      }
    }
  }
  return cfg;
}

/** Sum every SECTION_988_GAIN the run booked, by where it lands on the return. */
function section988Totals(sim) {
  const t = { ordinary: 0, capital: 0, disallowed: 0, deMinimis: 0, count: 0,
              foreignSource: 0, usSource: 0 };
  for (const entry of sim.journal?.journal ?? []) {
    if (entry.action?.type !== 'SECTION_988_GAIN') continue;
    // `data` is the DECLARED payload — `_pickPayload` keeps only fields in the toolset's
    // manifest, which is why design 87 §7 trap 1 matters: an undeclared field reads as
    // undefined here and silently sums to zero.
    const d = entry.action.data ?? {};
    t.count      += 1;
    t.ordinary   += d.amount ?? 0;
    t.capital    += d.capitalGain ?? 0;
    t.disallowed += d.disallowedLoss ?? 0;
    t.deMinimis  += d.deMinimis ?? 0;
    // §988(a)(3)(B)(i)(I) sources by TAX HOME, so the same pool changes basket at the
    // move. This split is the whole reason §14.2 says the historical study — which is
    // single-residency — could not settle the question.
    if ((d.residency ?? null) === 'AU') t.foreignSource += d.amount ?? 0;
    else t.usSource += d.amount ?? 0;
  }
  return t;
}

function runArm(method, seed) {
  const cfg = armCfg(method, seed);
  // `journal` rather than `off`: the §988 items are actions, and the YTD accumulators
  // are reset each year so state cannot report a lifetime figure.
  const sim = openSim(cfg, { telemetry: 'journal' });
  quiet(() => sim.stepTo(new Date(cfg.simEnd)));
  const s = sim.state;
  return {
    ...section988Totals(sim),
    taxPaid:    Math.round(s.cumulativeTaxesPaid ?? 0),
    netWorth:   Math.round(s.metrics?.netWorth ?? 0),
    afterTaxNW: Math.round(
      computeAfterTaxNetWorth(s, sim.currentDate, afterTaxOptionsFromParams(allParams(cfg)))),
    failed:     s.scenarioFailed ?? false,
  };
}

// ─── statistics ──────────────────────────────────────────────────────────────────────
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const sd   = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};
const pct  = (xs, p) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
};
const usd  = (v) => (v < 0 ? '-' : '') + '$' + Math.abs(Math.round(v)).toLocaleString('en-US');

// ─── run ─────────────────────────────────────────────────────────────────────────────
const rows = { [LEDGER_METHOD.PRO_RATA]: [], [LEDGER_METHOD.FIFO]: [] };
for (let seed = 1; seed <= SEEDS; seed++) {
  for (const method of METHODS) rows[method].push({ seed, ...runArm(method, seed) });
  process.stderr.write(`\r  seed ${seed}/${SEEDS}`);
}
process.stderr.write('\r' + ' '.repeat(24) + '\r');

const pr = rows[LEDGER_METHOD.PRO_RATA];
const fi = rows[LEDGER_METHOD.FIFO];

console.log(`\n§988 lot-consumption method — dispersion across ${SEEDS} FX paths`);
console.log(`source        : ${source}${synthetic ? '  (SYNTHETIC — an engine answer, not a plan answer)' : ''}`);
console.log(`FX            : MEAN_REVERTING, vol ${VOL}, reversion ${REVERSION}`);
console.log(`moveYear      : ${MOVE_YEAR ?? (allParams(base).moveYear ?? 'none')}`);
console.log(`§212 branch   : ${AU_RENTAL ? 'ON (AU house made a rental with running costs)' : 'off — every disposition is PERSONAL'}`);
console.log('');

// ── separability first, because a spread of zero has two very different causes ──────
const totalActions = mean(pr.map(r => r.count));
console.log('SEPARABILITY (design 87 §14.2 — can this scenario tell the methods apart?)');
console.log(`  §988 items per run (mean) : ${totalActions.toFixed(1)}`);
console.log(`  ordinary   (mean)         : ${usd(mean(pr.map(r => r.ordinary)))}`);
console.log(`  capital    (mean)         : ${usd(mean(pr.map(r => r.capital)))}`);
console.log(`  disallowed (mean)         : ${usd(mean(pr.map(r => r.disallowed)))}`);
console.log(`  de minimis (mean)         : ${usd(mean(pr.map(r => r.deMinimis)))}`);
console.log(`  foreign-source ordinary   : ${usd(mean(pr.map(r => r.foreignSource)))}`);
if (totalActions === 0) {
  console.log('\n  ** NO §988 ITEMS AT ALL. The methods cannot differ because nothing was');
  console.log('     recognized. Check that a disposition emitter fires on this plan and');
  console.log('     that the FX path is live — design 87 §7 trap 5.');
}
console.log('');

const METRICS = [
  ['§988 ordinary',  r => r.ordinary],
  ['§988 capital',   r => r.capital],
  ['§988 disallowed', r => r.disallowed],
  ['lifetime tax',   r => r.taxPaid],
  ['after-tax NW',   r => r.afterTaxNW],
];

console.log('PAIRED DELTAS  (FIFO − pro-rata, same seed ⇒ same FX path)');
console.log('metric            mean Δ        sd Δ       p10 Δ       p90 Δ   seeds differing');
const out = { source, seeds: SEEDS, vol: VOL, reversion: REVERSION, metrics: {} };
for (const [name, get] of METRICS) {
  const deltas = pr.map((row, i) => get(fi[i]) - get(row));
  const differing = deltas.filter(d => Math.abs(d) > 0.5).length;
  out.metrics[name] = { mean: mean(deltas), sd: sd(deltas), p10: pct(deltas, 10), p90: pct(deltas, 90), differing };
  console.log(
    name.padEnd(16)
    + usd(mean(deltas)).padStart(11)
    + usd(sd(deltas)).padStart(12)
    + usd(pct(deltas, 10)).padStart(12)
    + usd(pct(deltas, 90)).padStart(12)
    + String(`${differing}/${SEEDS}`).padStart(18));
}

console.log('\nLEVELS  (mean across paths, for scale)');
for (const [name, get] of METRICS) {
  console.log(`  ${name.padEnd(16)} pro-rata ${usd(mean(pr.map(get))).padStart(12)}   fifo ${usd(mean(fi.map(get))).padStart(12)}`);
}

// ── the reading ────────────────────────────────────────────────────────────────────
const taxDelta = out.metrics['lifetime tax'];
console.log('\nREADING');
if (totalActions === 0) {
  console.log('  Inconclusive: nothing to consume. Not evidence that method is free.');
} else if (taxDelta.differing === 0) {
  console.log('  The two methods produced IDENTICAL tax on every path. On this scenario the');
  console.log('  pool shape is convergent (few large lots), which is the case design 87 §14.2');
  console.log('  predicts the methods agree on. Pro-rata wins on cost alone — but this is a');
  console.log('  statement about THIS pool, not about the election in general.');
} else {
  const rel = Math.abs(taxDelta.mean) / Math.max(1, mean(pr.map(r => r.taxPaid)));
  console.log(`  The methods separate on ${taxDelta.differing}/${SEEDS} paths.`);
  console.log(`  Mean lifetime-tax delta ${usd(taxDelta.mean)} (${(rel * 100).toFixed(3)}% of tax paid),`);
  console.log(`  sd ${usd(taxDelta.sd)}, p10..p90 ${usd(taxDelta.p10)}..${usd(taxDelta.p90)}.`);
  console.log('  The election is locked at adoption, so read the SPREAD: a delta whose sign');
  console.log('  flips across paths is a bet on which world you get, not a recommendation.');
}

if (flag('json')) {
  writeFileSync(flag('json'), JSON.stringify({ ...out, rows }, null, 2));
  console.log(`\nwrote ${flag('json')}`);
}
