#!/usr/bin/env node
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
 * mc-report.mjs — turn raw Monte Carlo arm output into a decision.
 *
 * Reads the `<armKey>.json` files written by `mc-run.mjs` and prints five views,
 * in increasing order of how much they should influence a decision:
 *
 *   1. DISTRIBUTION   failure rate and low percentiles per arm.
 *   2. PAIRED         per-world rescues between two arms — the decision-relevant one.
 *   3. PATH SHAPE     sequence-risk readouts (only meaningful with --paths runs).
 *   4. DRIVERS        what separates a failing world from a surviving one.
 *   5. MIX            the asset mix as a distribution (only after a --mix run).
 *
 * Usage:
 *   node scripts/montecarlo/mc-report.mjs --dir <dir> [--pairs "a:b,c:d"] [--json]
 *
 *   --dir <dir>     REQUIRED. Directory of arm JSON files from mc-run.mjs.
 *   --pairs <list>  comma-separated `baseline:changed` arm pairs for the paired view.
 *                   Omitted ⇒ every arm is paired against the first one found.
 *   --json          machine-readable output.
 *   --html <file>   also render the mix distribution as a self-contained HTML page.
 *   --thresholds <file.json>
 *                   replace the mix threshold set (design 82 §8.2). An array of
 *                   `{key, label, classes, op, share, when, fromOffset, toOffset}`.
 *                   Thresholds are DATA so they can move without re-running an arm,
 *                   which is why arms carry the raw per-path matrix.
 *
 * ─── why medians and never means ─────────────────────────────────────────────
 *
 * Terminal-wealth MEANS from this model are meaningless. Without stochastic paths a
 * single return is drawn per world and held for the whole horizon, so an unlucky
 * draw at the top of the distribution compounds for forty years into a number with
 * no economic content — and it dominates the average. The median and the low
 * percentiles are the readouts that survive that. This report never prints a mean
 * of terminal wealth, only of explanatory variables.
 *
 * ─── why the paired view outranks the failure rates ──────────────────────────
 *
 * Two arms differing 8% vs 6% could be the lever working, or the same handful of
 * marginal worlds landing differently. Because arms share the seed sequence, world i
 * is the same world in both, so you can count the individual worlds the decision
 * flipped. `rescues` is what the change saves; `reverse` is what it breaks.
 *
 * A nonzero `reverse` is the finding to take seriously even when small. It means the
 * lever has state-dependent harm — there are worlds it makes worse — which is a real
 * risk with a mechanism worth understanding, not noise to be averaged away. A clean
 * zero across a large n is strong evidence the lever weakly dominates, and that is a
 * much stronger claim than any difference in headline rates.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

import { pairedRescues, pairedMetric, failureRate, failureByBand, failureDrivers } from '../lib/mc-analysis.mjs';
import { millions, thousands, money, moneyAuto, pct, percentile, columns } from '../lib/format.mjs';
import { renderMixReport } from '../lib/mix-report-html.mjs';
import {
  mixBands, thresholdProbabilities, outcomeGapAt, DEFAULT_MIX_THRESHOLDS,
} from '../../src/finance/allocation-reporting/mix-distribution.js';

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

const dir = flag('--dir');
if (!dir) { console.error('usage: mc-report.mjs --dir <dir> [--pairs "a:b"] [--metric afterTaxNW] [--json]'); process.exit(2); }

const files = readdirSync(dir).filter(f => f.endsWith('.json'));
if (!files.length) { console.error(`no arm JSON files in ${dir}`); process.exit(2); }

const arms = {};
for (const f of files) {
  const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  arms[d.arm ?? f.replace(/\.json$/, '')] = d;
}

// Spec order, not filesystem order: the first arm is the author's intended baseline
// and the default pairing compares everything else against it.
const keys = Object.keys(arms).sort((a, b) =>
  (arms[a].order ?? Number.MAX_SAFE_INTEGER) - (arms[b].order ?? Number.MAX_SAFE_INTEGER)
  || a.localeCompare(b));
const meta = arms[keys[0]];

// ── Sampler-cadence provenance (design 82 §8.3) ──────────────────────────────
//
// `pathShape` (CAGR, worst-5yr, max drawdown, the decade split) is derived from the
// RECORDED yearly series, and design 82 moved that series off design 78's event
// cadence onto the year boundary. That changed no run outcome — failure rate,
// outOfFundsDate, cumulativeDeficit and finalNetWorthUsd are unaffected exactly —
// which is precisely why the hazard is silent: an arm from either side looks equally
// well-formed, and mixing them in one report compares path shapes read at different
// instants. An arm with no stamp predates the switch.
//
// This is the same class of trap as the directory glob picking up a dropped arm: the
// report is built from whatever JSON is lying around, so provenance has to be checked
// here rather than remembered.
const cadenceOf = (k) => arms[k].samplerCadence ?? 'interval (unstamped — pre-design-82)';
const cadences  = new Set(keys.map(cadenceOf));
if (cadences.size > 1) {
  console.warn(`\n⚠  MIXED SAMPLER CADENCES — pathShape figures are NOT comparable across these arms:`);
  for (const k of keys) console.warn(`     ${k.padEnd(24)} ${cadenceOf(k)}`);
  console.warn(`   Re-run every arm in the batch with the same flags before quoting a pathShape.\n`);
} else if (!arms[keys[0]].samplerCadence) {
  console.warn(`\n⚠  These arms predate design 82's year-boundary cadence; their pathShape was`);
  console.warn(`   read at the old event cadence. Regenerate before comparing against a fresh run.\n`);
}

// Mix distribution (design 82 §8) — present only on arms run with `--mix`. Thresholds
// are DATA, replaceable without re-running an arm; that is the whole reason the arm
// carries the raw per-path matrix rather than pre-reduced bands.
const mixKeys = keys.filter(k => arms[k].mixSeries?.paths?.length);
// A hand-written threshold file is the normal case, so fill the two fields a report
// prints rather than crashing on the one the author left out.
const thresholds = (flag('--thresholds')
  ? JSON.parse(readFileSync(flag('--thresholds'), 'utf8'))
  : DEFAULT_MIX_THRESHOLDS
).map((s, i) => ({ ...s, key: s.key ?? `threshold-${i}`, label: s.label ?? s.key ?? `threshold-${i}` }));

if (argv.includes('--json')) {
  console.log(JSON.stringify({
    arms: Object.fromEntries(keys.map(k => [k, {
      n: arms[k].n, failureRate: failureRate(arms[k].rows), pathShape: arms[k].pathShape,
      provenance: arms[k].provenance ?? null,
      mixThresholds: arms[k].mixSeries
        ? thresholdProbabilities(arms[k].mixSeries, thresholds)
        : null,
    }])),
  }, null, 1));
  process.exit(0);
}

// ─── header ──────────────────────────────────────────────────────────────────

const rm = meta.riskModel ?? {};
console.log('\n════ MONTE CARLO ════');
console.log(`base: ${meta.source ?? 'unknown'}${meta.synthetic ? '  ** SYNTHETIC DEFAULT — illustrative only **' : ''}`);
console.log(`n=${meta.n}/arm across ${keys.length} arms`);
console.log(`sampled: ${rm.paths
  ? `year-by-year equity returns (vol ${rm.vol}, drift ${rm.drift})`
  : 'long-run AVERAGE return only — NO sequence risk, so failure rates are UNDERSTATED'}`
  + `${rm.propertyPaths ? ' + property path' : ''}${rm.shock ? ' + manufactured crash' : ''}`
  + ', plus lifespan, inflation and FX');
if (rm.recentre === false) {
  console.log('** MC centers were NOT verified against the scenario.');
}
// Provenance of the sampled world (design: MC centers follow the loaded scenario).
// Silent when every center traced back to the plan — the normal case — so anything
// printed here is a reason to distrust the rates below.
for (const k of keys) {
  const p = arms[k].provenance;
  if (!p || p.fromScenario) continue;
  if (p.syntheticCenters?.length) {
    console.log(`** ${k}: sampled around FRAMEWORK DEFAULTS (absent from the scenario): `
      + p.syntheticCenters.join(', '));
  }
  for (const d of (p.divergentCenters ?? [])) {
    console.log(`** ${k}: ${d.paramKey} centered ${d.center}, scenario says ${d.scenarioValue}`);
  }
}

// ─── 1. distribution ─────────────────────────────────────────────────────────

const inconsistentN = new Set(keys.map(k => arms[k].n)).size > 1;
columns({
  title: 'DISTRIBUTION — failure rate and low percentiles',
  rows: keys,
  columns: [
    { head: 'ARM', get: k => k, width: 26, align: 'left' },
    { head: 'FAIL%', get: k => pct(failureRate(arms[k].rows)), width: 8 },
    { head: 'p5',     get: k => millions(percentile(arms[k].rows.map(r => r.nw), 5)), width: 10 },
    { head: 'p10',    get: k => millions(percentile(arms[k].rows.map(r => r.nw), 10)), width: 10 },
    { head: 'p25',    get: k => millions(percentile(arms[k].rows.map(r => r.nw), 25)), width: 10 },
    { head: 'MEDIAN', get: k => millions(percentile(arms[k].rows.map(r => r.nw), 50)), width: 11 },
  ],
});
console.log('Terminal net worth percentiles. No mean is shown — see the header note.');
if (inconsistentN) {
  console.log('** arms have DIFFERENT n — the paired view below is only valid on shared seeds.');
}

// ─── 2. paired ───────────────────────────────────────────────────────────────

const pairs = flag('--pairs')
  ? flag('--pairs').split(',').map(s => s.split(':').map(x => x.trim()))
  : keys.slice(1).map(k => [keys[0], k]);

console.log('\n\n════ PAIRED — what each change rescues, world by world ════');
for (const [a, b] of pairs) {
  if (!arms[a] || !arms[b]) { console.log(`\n${a} → ${b}: (missing arm)`); continue; }
  const p = pairedRescues(arms[a].rows, arms[b].rows);
  console.log(`\n${a}  →  ${b}`);
  console.log(`  both fail ${p.both}   only "${a}" fails ${p.rescues}   only "${b}" fails ${p.reverseRescues}`
    + `   neither ${p.neither}   (paired n=${p.n}${p.unpaired ? `, ${p.unpaired} unpaired` : ''})`);
  console.log(`  → rescues ${p.rescues} worlds (${pct(p.rescueRate)}); `
    + `made ${p.reverseRescues} worse (${pct(p.reverseRate)} reverse-rescue)`);
  if (p.reverseRescues > 0) {
    console.log(`  ** state-dependent harm: this change is not a free win — there are worlds it`);
    console.log(`     breaks. Worth understanding the mechanism before acting on the average.`);
  } else if (p.n > 0) {
    console.log(`  (no reverse-rescues — on this evidence the change weakly dominates)`);
  }
}

// ─── 2b. paired MONEY view ───────────────────────────────────────────────────
//
// The rescue counts above answer "will this plan survive". A question about WHERE
// wealth sits — a decant, a conversion, a wrapper swap — runs on plans that mostly do
// not fail either way, so those counts come back near-empty and say nothing. This is
// the same paired discipline asked of wealth instead (design 84 §6.4b).

const moneyMetric = flag('--metric') ?? 'afterTaxNW';
const hasMoney = keys.some(k => arms[k].rows?.some(r => Number.isFinite(r[moneyMetric])));

if (hasMoney) {
  console.log(`\n\n════ PAIRED — ${moneyMetric}, world by world ════`);
  if (moneyMetric === 'nw') {
    console.log('** scoring on NOMINAL net worth: this prices a Roth dollar at par with a');
    console.log('   pre-tax one, so any arm that moves wealth BETWEEN wrappers is mis-scored.');
    console.log('   Use --metric afterTaxNW for wrapper questions.');
  }
  for (const [a, b] of pairs) {
    if (!arms[a] || !arms[b]) { console.log(`\n${a} → ${b}: (missing arm)`); continue; }
    const m = pairedMetric(arms[a].rows, arms[b].rows, moneyMetric);
    if (!m.n) { console.log(`\n${a} → ${b}: (no paired rows carrying ${moneyMetric})`); continue; }
    console.log(`\n${a}  →  ${b}`);
    console.log(`  ahead in ${m.wins}/${m.n} worlds (${pct(m.winRate)}); `
      + `BEHIND in ${m.losses} (${pct(m.lossRate)})`
      + (m.ties ? `; ${m.ties} tied` : '')
      + (m.unpaired ? `  [${m.unpaired} unpaired]` : ''));
    console.log(`  paired delta   p10 ${moneyAuto(m.p10)}   p50 ${moneyAuto(m.p50)}   p90 ${moneyAuto(m.p90)}`);
    console.log(`  worst world ${moneyAuto(m.worst)}   best ${moneyAuto(m.best)}`
      + (m.medianRel != null ? `   median ${(m.medianRel * 100).toFixed(2)}%` : ''));
    if (m.losses > 0) {
      console.log(`  ** not a free win: ${m.losses} worlds end WORSE off. The count is the finding,`);
      console.log(`     not the average — a sign that flips is a bet, not a recommendation.`);
    } else {
      console.log(`  (ahead in every paired world — on this evidence it weakly dominates)`);
    }
  }
  console.log('\nPaired DIFFERENCES within a world, never a mean of terminal wealth.');
}

// ─── 3. path shape ───────────────────────────────────────────────────────────

const hasShape = keys.some(k => arms[k].pathShape?.medianNetWorthCagr != null);
if (hasShape) {
  columns({
    title: 'PATH SHAPE — sequence-of-returns signal',
    rows: keys,
    columns: [
      { head: 'ARM', get: k => k, width: 26, align: 'left' },
      { head: 'medCAGR',   get: k => pct(arms[k].pathShape?.medianNetWorthCagr), width: 9 },
      { head: 'worst5y',   get: k => pct(arms[k].pathShape?.medianWorst5yrCagr), width: 10 },
      { head: 'maxDD',     get: k => pct(arms[k].pathShape?.medianMaxDrawdown, 0), width: 8 },
      { head: 'fail|lo10', get: k => pct(arms[k].pathShape?.failureRateBelowMedianDecade), width: 11 },
      { head: 'fail|hi10', get: k => pct(arms[k].pathShape?.failureRateAboveMedianDecade), width: 11 },
    ],
  });
  console.log('fail|lo10 / fail|hi10 = failure rate among paths whose FIRST DECADE finished below /');
  console.log('above the cross-path median. A wide gap is sequence risk stated directly: the same');
  console.log('long-run average is survivable or fatal depending on when the bad years land.');

  const houseArms = keys.filter(k => arms[k].pathShape?.medianHouseCagr != null);
  if (houseArms.length) {
    columns({
      title: 'PROPERTY PATH — house return and holding cost',
      rows: houseArms,
      columns: [
        { head: 'ARM', get: k => k, width: 26, align: 'left' },
        { head: 'hCAGR',  get: k => pct(arms[k].pathShape.medianHouseCagr), width: 8 },
        { head: 'hMaxDD', get: k => pct(arms[k].pathShape.medianHouseMaxDrawdown, 0), width: 9 },
        { head: 'rep p50', get: k => thousands(arms[k].pathShape.medianRepairSpend), width: 9 },
        { head: 'rep p90', get: k => thousands(arms[k].pathShape.p90RepairSpend), width: 9 },
      ],
    });
    console.log('hMaxDD = worst pre-sale drawdown on the held property; rep = lifetime repair spend.');
  }
}

// ─── 4. drivers ──────────────────────────────────────────────────────────────

console.log('\n\n════ WHAT DISTINGUISHES A FAILING WORLD ════');
const DRIVER_KEYS = ['growth', 'netWorthCagr', 'worst5yrCagr', 'maxDrawdown', 'shockSev', 'repairSpend'];
const LABEL = {
  growth:       'sampled long-run mean return',
  netWorthCagr: 'realized net-worth CAGR',
  worst5yrCagr: 'worst 5-yr window',
  maxDrawdown:  'max drawdown',
  shockSev:     'crash severity',
  repairSpend:  'lifetime repair spend',
};
const isRate = (k) => k !== 'repairSpend' && k !== 'shockSev';

for (const k of keys) {
  const d = failureDrivers(arms[k].rows, DRIVER_KEYS);
  if (!d.nFailed) { console.log(`\n${k}: no failures in ${arms[k].rows.length} paths`); continue; }
  console.log(`\n${k}: ${d.nFailed} failed / ${d.nSurvived} survived`);
  for (const f of d.fields) {
    if (f.failed == null && f.survived == null) continue;
    const fmt = isRate(f.key) ? (v) => pct(v, 2) : money;
    console.log(`    ${LABEL[f.key].padEnd(30)} failed ${fmt(f.failed).padStart(12)}`
      + `   survived ${fmt(f.survived).padStart(12)}`);
  }
  if (d.oofYears.length) {
    console.log(`    ${'out-of-funds year'.padEnd(30)} median ${percentile(d.oofYears, 50)}`
      + `   earliest ${d.oofYears[0]}`);
  }
}

// Failure rate against the sampled return — turns a probability into a threshold.
const bandKey = rm.paths ? 'netWorthCagr' : 'growth';
const EDGES = [0, 0.04, 0.05, 0.06, 0.07, 0.08, 0.10, 0.12, 1];
const anyBanded = keys.some(k => arms[k].rows.some(r => typeof r[bandKey] === 'number'));
if (anyBanded) {
  const bandRows = EDGES.slice(0, -1).map((lo, i) => ({ lo, hi: EDGES[i + 1] }));
  columns({
    title: `FAILURE RATE BY ${bandKey === 'growth' ? 'SAMPLED MEAN RETURN' : 'REALIZED NET-WORTH CAGR'}`,
    rows: bandRows,
    columns: [
      { head: 'BAND', get: b => `${pct(b.lo, 0)}–${pct(b.hi, 0)}`, width: 14, align: 'left' },
      ...keys.map(k => ({
        head: k.length > 12 ? k.slice(0, 12) : k, width: 14,
        get: (b) => {
          const band = failureByBand(arms[k].rows, bandKey, [b.lo, b.hi])[0];
          return band.n ? `${pct(band.rate, 0)} (${band.n})` : '·';
        },
      })),
    ],
  });
  console.log('Cell = failure rate (paths in band). This is the readout to quote: it converts');
  console.log('"12% of paths fail" into a RETURN THRESHOLD you can hold an opinion about.');
}

// ─── 5. mix distribution (design 82 §8) ──────────────────────────────────────
//
// The allocation report answers "on the central path, what shape does this plan take".
// This answers HOW OFTEN it takes that shape, which for a finding like "ends 90% house"
// is the more decision-relevant of the two.

if (mixKeys.length === 0) {
  console.log('\n\n(no arm carries a mix matrix — re-run mc-run.mjs with --mix for the');
  console.log(' asset-mix distribution, bands, thresholds and the failure split.)');
} else {
  console.log('\n\n════ MIX DISTRIBUTION — how often the plan takes each shape ════');
  console.log('Bands are MARGINAL: the p90 of one class and the p90 of another come from');
  console.log('different paths, so they do NOT sum to 100%. Read each class on its own.');
  if (mixKeys.length !== keys.length) {
    console.log(`** only ${mixKeys.length}/${keys.length} arms were run with --mix: `
      + `${mixKeys.join(', ')}`);
  }

  for (const k of mixKeys) {
    const series = arms[k].mixSeries;
    const bands  = mixBands(series, { percentiles: [0.10, 0.50, 0.90] });
    const years  = bands.years;

    // Four checkpoints across the horizon. A full 45-column table is unreadable in a
    // terminal, and the question this view answers ("when does the shape turn?") is
    // answered by the shape of a handful of columns — the HTML page draws them all.
    const at = [...new Set([0, Math.floor(years.length / 3), Math.floor(2 * years.length / 3),
      years.length - 1].filter(i => i >= 0 && i < years.length))];

    const active = bands.classes.filter(c =>
      [0.10, 0.50, 0.90].some(p => at.some(i => (bands.bands[c][p][i] ?? 0) > 0.0005)));

    columns({
      title: `${k} — share of gross assets, p50 (p10–p90)`,
      rows: active,
      columns: [
        { head: 'CLASS', get: c => c, width: 17, align: 'left' },
        ...at.map(i => ({
          head: String(years[i]), width: 20,
          get: (c) => `${pct(bands.bands[c][0.50][i], 0)} `
            + `(${pct(bands.bands[c][0.10][i], 0)}–${pct(bands.bands[c][0.90][i], 0)})`,
        })),
      ],
    });
    console.log(`paths with a mix: ${at.map(i => `${years[i]} ${bands.n[i]}`).join('   ')}`
      + (bands.excluded.some(e => e > 0)
        ? `   (up to ${Math.max(...bands.excluded)} excluded — a path holding nothing has no mix)`
        : ''));
  }

  // The readouts worth quoting. `n` is how many paths had a mix to test — a path
  // excluded for holding nothing is not silently counted as a miss.
  columns({
    title: 'THRESHOLD PROBABILITIES — share of paths meeting each condition',
    rows: thresholds,
    columns: [
      { head: 'READOUT', get: s => s.label.slice(0, 56), width: 58, align: 'left' },
      ...mixKeys.map(k => {
        const probs = thresholdProbabilities(arms[k].mixSeries, thresholds);
        return {
          head: k.length > 12 ? k.slice(0, 12) : k, width: 15,
          get: (s) => {
            const t = probs.find(p => p.key === s.key);
            return t && t.n ? `${pct(t.rate, 0)} (${t.n})` : '·';
          },
        };
      }),
    ],
  });
  console.log('Cell = probability (paths tested). Thresholds are data — pass --thresholds');
  console.log('<file.json> to move them without re-running an arm.');

  // §8.2's third view, and the one that decides which conversation to have: if the
  // failing paths ARE the illiquid paths, the shape is the failure mechanism.
  console.log('\n\n════ MIX CONDITIONED ON FAILURE ════');
  for (const k of mixKeys) {
    const gap = outcomeGapAt(arms[k].mixSeries);
    if (gap.nFailed === 0) {
      console.log(`\n${k}: no path failed — nothing to condition on, which is itself the answer:`);
      console.log('  the shape is not a solvency question in this arm.');
      continue;
    }
    console.log(`\n${k}: median share at ${gap.year} — ${gap.nFailed} failed / ${gap.nSurvived} survived`);
    const rows = gap.rows
      .filter(r => (r.failed ?? 0) > 0.0005 || (r.survived ?? 0) > 0.0005)
      .sort((a, b) => Math.abs(b.gap ?? 0) - Math.abs(a.gap ?? 0));
    for (const r of rows) {
      console.log(`    ${r.key.padEnd(17)} failed ${pct(r.failed).padStart(8)}`
        + `   survived ${pct(r.survived).padStart(8)}`
        + `   gap ${(r.gap == null ? '—' : (r.gap >= 0 ? '+' : '−') + pct(Math.abs(r.gap))).padStart(8)}`);
    }
  }
  console.log('\nA large positive gap on an illiquid class says the paths that ran out of money');
  console.log('are the ones whose wealth ended up somewhere it could not be spent — which makes');
  console.log('the target-vs-realized overlay (design 82 §7) the place to intervene.');
}

// ─── the chart page ──────────────────────────────────────────────────────────

const htmlOut = flag('--html');
if (htmlOut) {
  if (mixKeys.length === 0) {
    console.error('\n** --html needs a mix matrix; re-run mc-run.mjs with --mix.');
  } else {
    const out = resolve(htmlOut);
    mkdirSync(dirname(out), { recursive: true });
    const html = renderMixReport({ arms, keys, meta, thresholds });
    writeFileSync(out, html);
    console.log(`\nwrote ${out}  (${(html.length / 1024 / 1024).toFixed(2)} MB)`);
  }
}
