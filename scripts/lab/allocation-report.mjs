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
 * allocation-report.mjs — asset allocation over time, as one HTML page.
 *
 * Runs a scenario, samples the allocation cube at every calendar year-end, and renders
 * the three requested views — total, per country, per account — plus the return-series
 * (rateKey) cut, from ONE fact table.
 *
 * Usage:
 *   node scripts/lab/allocation-report.mjs [--scenario <file.json>] [options]
 *
 *   --scenario <file> Workbench export to run. Omitted ⇒ the built-in synthetic
 *                     default (round numbers, no private data, ~15y horizon).
 *   --index <n>       Which scenario inside that file (default 0).
 *   --out <file>      Output path (default scenarios/allocation-report.html).
 *   --csv             Also write the raw cube beside the page as .csv.
 *   --nominal         Label figures nominal (the default). See the note below.
 *   --open            Open the result when done (macOS).
 *
 * ─── why year-ends, and not history snapshots ────────────────────────────────
 *
 * SimulationHistory takes a snapshot every N *events* (`snapshotInterval`, default 12),
 * NOT on a calendar. Reading the cube off snapshots is nearly free and gives an x-axis
 * whose sample dates drift with event volume and differ between scenarios, so two runs
 * cannot be laid side by side. This samples each calendar year-end instead: comparable
 * across runs, aligned with the rebalance/tax cadence, ~45 samples.
 *
 * It gets them from the RUN, via `samplerCadence: 'year-boundary'` (design 82 §4/§5.1b),
 * not from a private stepTo loop — the same seam the workbench plugin and Monte Carlo
 * sample through, so the page and the app cannot disagree about *when* they looked. The
 * instant is identical either way (the state after the last event dated in year Y), which
 * is why the conversion left every figure unchanged.
 *
 * One property to hold while reading any chart here — the year boundary splits the annual
 * cycle in two (design 82 §5.2). Dated 31 DECEMBER: the whole investment family (account
 * earnings, dividends, coupons, RMDs) plus the year's expenses and tax settles. Dated
 * 1 JANUARY: real-asset appreciation, and the PERIOD_ADVANCE cascade that fires the
 * rebalance. So a 31 December sample carries a COMPLETE year of investment growth, spending
 * and tax — but real assets carry none of that year's appreciation, so every mix here
 * understates the real-asset share by about one appreciation cycle. That is a level bias,
 * not a trend one: every point sits at the same place in the annual cycle. A terminal sample
 * at a mid-year horizon is the exception — it covers a partial year AND sits on the far side
 * of the cascade. The Provenance section calls out any sample that is not a 31 December
 * boundary.
 *
 * ─── what it will NOT do ─────────────────────────────────────────────────────
 *
 * Figures are NOMINAL base-currency (USD), converted at each sample date's effective
 * rate. Two consequences worth holding: a flat AUD sleeve shrinks on this chart as USD
 * strengthens, and a 2070 dollar is not a 2026 dollar. The 100% view is immune to both
 * (shares are unitless), which is the main reason it leads the page. Real-terms
 * restatement is deliberately out of scope here — see design 79 (renumbered from 60, which
 * collided with the cash-sleeve-yield design).
 *
 * It also does not interpret. Every number is a group-by of the cube, computed with the
 * same src/finance/allocation-reporting modules the workbench plugin will use, so the
 * page and the app cannot disagree about a share.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve, basename }                         from 'node:path';
import { execFileSync }                                       from 'node:child_process';
import { createRequire }                                      from 'node:module';

import { loadBaseConfig, parseSourceArgs } from '../lib/scenario-source.mjs';
import { openSim, quiet }         from '../lib/run.mjs';
import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { buildAllocationSeries, mixAt } from '../../src/finance/allocation-reporting/allocation-grouping.js';
import { ASSET_CLASS }            from '../../src/finance/allocation-reporting/asset-class.js';
import { createAllocationSampler, samplesToRows, samplesToTargetRows, lastYearEndIndex } from '../../src/finance/allocation-reporting/allocation-sampler.js';
import { targetedStateKeys, driftAgainstTarget } from '../../src/finance/allocation-reporting/target-cube.js';
import { ASSET_CLASS_COLOR }      from '../../src/finance/allocation-reporting/allocation-palette.js';
import { PALETTE_CYCLE }          from '../../src/finance/reporting-common/palette-cycle.js';

const USAGE = `
allocation-report.mjs — asset allocation over time, as one HTML page.

  node scripts/lab/allocation-report.mjs [--scenario <file.json>] [options]

  --scenario <file> Workbench export to run (default: built-in synthetic scenario).
  --index <n>       Which scenario inside that file (default 0).
  --out <file>      Output path (default scenarios/allocation-report.html).
  --csv             Also write the raw cube beside the page as .csv.
  --open            Open the result when done (macOS).
`;

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const has  = (n) => argv.includes(n);

if (has('-h') || has('--help')) { console.log(USAGE); process.exit(0); }

const { file: scenarioFile, index: scenarioIndex } = parseSourceArgs(argv);
const outFile      = resolve(flag('--out') ?? 'scenarios/allocation-report.html');
const BASE         = 'USD';

// ─── run + sample ────────────────────────────────────────────────────────────

const { cfg, source } = loadBaseConfig({ file: scenarioFile, index: scenarioIndex });
const start = new Date(cfg.simStart);
const end   = new Date(cfg.simEnd);

const rows      = [];   // the cube, every sample date concatenated
const tieOut    = [];   // per-sample reconciliation against net worth
const nameByKey = new Map();

// The sampler is SHARED with the workbench panel (allocation-sampler.js), not written
// here: design 82 §4 binds every consumer to one sample instant, and §5.1's module
// binds them to one record shape, so the page and the app cannot disagree about a
// share. This replaced a private loop that re-`stepTo`'d each 31 December — identical
// instant, identical numbers, one fewer way to drift.
const sim = openSim(cfg, {
  telemetry: 'off',
  sampler: createAllocationSampler({
    baseCurrency: BASE,
    displayNameFor: k => reg.displayNameFor(k),
  }),
  samplerCadence: 'year-boundary',
});
const reg = ServiceRegistry.getInstance().schemaRegistry;

process.stderr.write(`sampling ${source} year-ends ${start.getUTCFullYear()}…${end.getUTCFullYear()}\n`);

quiet(() => sim.stepTo(end));

rows.push(...samplesToRows(sim.samples));
const targetRows = samplesToTargetRows(sim.samples);
for (const row of rows) nameByKey.set(row.stateKey, row.name);
for (const sample of sim.samples) {
  const { rows: _rows, ...tie } = sample;
  tieOut.push(tie);
}

if (rows.length === 0) { console.error('no samples produced — check simStart/simEnd'); process.exit(2); }

// ─── pivots (all computed here, in node, via the SHARED module) ──────────────
//
// The page ships PRECOMPUTED series, never the grouping logic. If the browser
// re-derived a share it could disagree with the app, and there would be no way to
// tell which was right.

const view = (opts) => {
  const built = buildAllocationSeries(rows, opts);
  return {
    dates:  built.dates.map(d => d.toISOString().slice(0, 10)),
    keys:   built.keys,
    series: built.series,
    totals: built.totals,
  };
};

const hasRateSeries = r => r.rateKey != null;

const accountKeys = [...new Set(rows
  .filter(r => r.assetClass !== ASSET_CLASS.LIABILITY && r.kind === 'account')
  .map(r => r.stateKey))].sort((a, b) => (nameByKey.get(a) ?? a).localeCompare(nameByKey.get(b) ?? b));

const views = {
  total:      { abs: view({}),                                     pct: view({ normalize: true }) },
  net:        { abs: view({ excludeLiabilities: false }),           pct: view({ excludeLiabilities: false, normalize: true }) },
  domicile:   { abs: view({ by: ['domicileCountry', 'assetClass'] }), pct: view({ by: ['domicileCountry', 'assetClass'], normalize: true }) },
  exposure:   { abs: view({ by: ['exposureCountry', 'assetClass'] }), pct: view({ by: ['exposureCountry', 'assetClass'], normalize: true }) },
  // Restricted to rows that HAVE a return series. A house, a company stake and a
  // collectible carry no rateKey, so including them buries the diagnostic under one
  // enormous `(none)` band that says nothing — they are covered by every other chart.
  rateKey:    { abs: view({ by: ['rateKey'], filter: hasRateSeries }),
                pct: view({ by: ['rateKey'], filter: hasRateSeries, normalize: true }) },
  byAccount:  { abs: view({ by: ['name'] }),                         pct: view({ by: ['name'], normalize: true }) },
};

// ─── target vs realized (design 82 §7) ───────────────────────────────────────
//
// Both sides are held to the SAME accounts — the ones the rebalancer manages. Measuring a
// portfolio target against a book that also holds a house and a company stake would report
// a "drift" that is really two different questions side by side.
const targeted   = targetedStateKeys(targetRows);
const inTargeted = r => targeted.has(r.stateKey);
const targetViews = targetRows.length === 0 ? null : {
  // Realized uses holdings only: that is the reducer's own basis, and a reconciliation
  // residual would show drift it was never looking at.
  actual: view({ filter: r => inTargeted(r) && r.source === 'holding', normalize: true }),
  target: (() => {
    const built = buildAllocationSeries(targetRows, { filter: inTargeted, normalize: true });
    return {
      dates:  built.dates.map(d => d.toISOString().slice(0, 10)),
      keys:   built.keys,
      series: built.series,
      totals: built.totals,
    };
  })(),
};

const perAccount = {};
for (const key of accountKeys) {
  perAccount[key] = {
    label: nameByKey.get(key) ?? key,
    abs:   view({ filter: r => r.stateKey === key }),
    pct:   view({ filter: r => r.stateKey === key, normalize: true }),
  };
}

// ─── headline facts ──────────────────────────────────────────────────────────

const firstMix = mixAt(rows, { at: rows[0].date });
const lastMix  = mixAt(rows);
const drift = Object.keys({ ...firstMix, ...lastMix })
  .map(k => ({ key: k, from: firstMix[k] ?? 0, to: lastMix[k] ?? 0 }))
  .map(d => ({ ...d, move: d.to - d.from }))
  .sort((a, b) => Math.abs(b.move) - Math.abs(a.move));

const worstTie   = tieOut.reduce((w, t) => (Math.abs(t.delta) > Math.abs(w.delta) ? t : w), tieOut[0]);
// Samples that are NOT a 31 December year boundary — i.e. the terminal flush when the
// run's horizon falls mid-year. Named on the page rather than silently drawn: that
// point covers a partial year, so the step into it is not comparable with the others.
const offBoundary = tieOut.filter(t => t.at.getUTCMonth() !== 11 || t.at.getUTCDate() !== 31);
const inferredAny  = tieOut.some(t => t.inferred > 0);
const reconciledAny = tieOut.some(t => t.reconciled > 0.5);

// Domicile and exposure only diverge where a holding's rate series names a different
// country than its wrapper. When no such sleeve exists the two charts are byte-identical,
// and offering a toggle between them without saying so invites the reader to hunt for a
// difference that is not there. Detect it and say it instead.
const countryViewsAgree =
  JSON.stringify(views.domicile.pct.keys)   === JSON.stringify(views.exposure.pct.keys) &&
  JSON.stringify(views.domicile.pct.series) === JSON.stringify(views.exposure.pct.series);

// ─── page ────────────────────────────────────────────────────────────────────

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => (n == null ? '—' : (n < 0 ? '−' : '') + '$' + Math.abs(Math.round(n)).toLocaleString());
const pct   = (r, dp = 1) => (r == null ? '—' : `${(r * 100).toFixed(dp)}%`);
const when  = ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

// Fixed colour per asset class, so a band never changes colour between charts — and,
// via the shared module, means the same class in the workbench panel (§6). The light
// tuning is the one for this page's background.
const CLASS_COLOR = ASSET_CLASS_COLOR;
const CYCLE       = PALETTE_CYCLE;

const require   = createRequire(import.meta.url);
const echartsJs = readFileSync(require.resolve('echarts/dist/echarts.min.js'), 'utf8')
  .replace(/<\/script>/gi, '<\\/script>');   // never let the payload close its own tag

const payload = {
  views, perAccount, targetViews,
  accountOrder: accountKeys,
  classColor: CLASS_COLOR,
  cycle: CYCLE,
  base: BASE,
};

const chartBlock = (id, label, options) => `
  <div class="chart-head">
    <span class="chart-cap">${esc(label)}</span>
    <span class="seg" data-seg="${esc(id)}">
      <button class="on" data-mode="pct">share</button><button data-mode="abs">${esc(BASE)}</button>
    </span>
    ${options ?? ''}
  </div>
  <div class="chart" id="${esc(id)}"></div>`;

const sections = [];

// Provenance first — the page is only quotable if the cube ties out.
sections.push(`<section id="provenance"><h2>Provenance</h2>
  <p class="lede">Every figure below is a group-by of one fact table, sampled at each calendar
  year-end and converted to ${esc(BASE)} at that date's effective rate. The cube is only
  trustworthy if it decomposes net worth exactly — a denominator missing an asset misstates
  <em>every</em> slice, not just the missing one, so that check runs first.</p>
  ${Math.abs(worstTie.delta) < 1
    ? `<div class="alert ok"><strong>Ties out.</strong> The cube total equals
       <code>computeNetWorth</code> at all ${tieOut.length} year-ends (worst gap
       ${money(worstTie.delta)}).</div>`
    : `<div class="alert crit"><strong>Does not tie out.</strong> Worst gap ${money(worstTie.delta)}
       in ${worstTie.year}. An asset class is being dropped or double-counted; do not quote
       any share on this page until it is found.</div>`}
  ${reconciledAny
    ? `<div class="alert warn"><strong>Holdings do not sum to the account balance somewhere.</strong>
       The gap is charted as <code>UNKNOWN</code> rather than absorbed, so the total still ties —
       but the mix is wrong by that amount wherever it appears.</div>` : ''}
  ${inferredAny && !reconciledAny
    ? `<div class="alert warn"><strong>Some accounts carry no holdings.</strong> Their class is
       inferred from the account role/type rather than read, and is charted as a single band.</div>` : ''}
  ${offBoundary.length > 0
    ? `<div class="alert warn"><strong>${offBoundary.length} sample${offBoundary.length > 1 ? 's are' : ' is'} not a
       31 December boundary</strong> (${esc(offBoundary.map(t => t.at.toISOString().slice(0, 10)).join(', '))}).
       That is the state at the run's horizon, kept because the end of the plan is the most-quoted
       point on the page — but it covers a partial year and sits <em>after</em> the 1 January
       period-advance cascade that credits the year's investment growth, so the step into it is
       not a year-over-year move like every other step on these charts.</div>` : ''}
  <table class="plain"><tbody>
    <tr><th>source</th><td class="mono">${esc(source)}</td></tr>
    <tr><th>horizon</th><td class="mono">${esc(start.toISOString().slice(0, 10))} → ${esc(end.toISOString().slice(0, 10))} · ${tieOut.length} year-end samples</td></tr>
    <tr><th>cube</th><td class="mono">${rows.length.toLocaleString()} rows · ${accountKeys.length} accounts · ${views.total.abs.keys.length} asset classes</td></tr>
    <tr><th>rendered</th><td class="mono">${esc(when(Date.now()))} UTC</td></tr>
  </tbody></table>
</section>`);

// Headlines.
sections.push(`<section id="headlines"><h2>Headlines</h2>
  <div class="cards">
    <div class="card">
      <p class="card-kicker">Net worth ${tieOut.at(-1).year}</p>
      <p class="hero">${money(tieOut.at(-1).netWorth)}</p>
      <p class="card-sub">from ${money(tieOut[0].netWorth)} in ${tieOut[0].year}, nominal ${esc(BASE)}</p>
    </div>
    <div class="card">
      <p class="card-kicker">Mix ${tieOut[0].year}</p>
      <dl class="card-facts">${drift.slice(0, 5).map(d =>
        `<div><dt>${esc(d.key)}</dt><dd>${pct(d.from)}</dd></div>`).join('')}</dl>
    </div>
    <div class="card">
      <p class="card-kicker">Mix ${tieOut.at(-1).year}</p>
      <dl class="card-facts">${drift.slice(0, 5).map(d =>
        `<div><dt>${esc(d.key)}</dt><dd>${pct(d.to)}</dd></div>`).join('')}</dl>
    </div>
    <div class="card">
      <p class="card-kicker">Largest drift</p>
      <p class="hero">${drift[0].move >= 0 ? '+' : '−'}${pct(Math.abs(drift[0].move), 0)}</p>
      <p class="card-sub">${esc(drift[0].key)} · ${pct(drift[0].from)} → ${pct(drift[0].to)}</p>
    </div>
  </div>
  <p class="notes">Drift is measured on gross assets (liabilities excluded), first sample to last.
  It is the readout the three charts below exist to explain: whether the plan's shape is being
  chosen, or is simply what the drawdown order left behind.</p>
</section>`);

sections.push(`<section id="total"><h2>Total allocation</h2>
  <p class="lede">Every asset, all accounts and both countries, by class. <strong>Share</strong>
  answers "is my shape drifting"; <strong>${esc(BASE)}</strong> answers "is it growing" — the two
  routinely disagree and the toggle is the point.</p>
  ${chartBlock('chart-total', 'Gross assets by class',
    `<label class="chk"><input type="checkbox" data-net="chart-total"> include liabilities (net worth)</label>`)}
</section>`);

// The overlay that makes the page diagnostic instead of descriptive (design 82 §7).
// Read at the last 31 DECEMBER, not the last sample. The rebalance fires on the 1 January
// period advance, so a horizon sample dated 1 January reports 0.0% drift for every class —
// perfectly on policy at the one instant it cannot be otherwise.
const driftIdx = targetViews
  ? lastYearEndIndex(targetViews.actual.dates.map(d => new Date(d + 'T00:00:00Z')))
  : -1;
const driftDate = driftIdx >= 0 ? targetViews.actual.dates[driftIdx] : null;
const driftNow = targetViews
  ? driftAgainstTarget(
      Object.fromEntries(targetViews.actual.keys.map(k => [k, targetViews.actual.series[k][driftIdx]])),
      Object.fromEntries(targetViews.target.keys.map(k => {
        const j = targetViews.target.dates.indexOf(driftDate);
        return [k, j >= 0 ? targetViews.target.series[k][j] : 0];
      })),
      targetRows)
  : null;

sections.push(`<section id="target"><h2>Target vs realized</h2>
  ${targetViews ? `
  <p class="lede">Solid is what the plan HOLDS; dashed is what it was AIMING at
  (<code>account.targetComposition</code>, stamped every period by the rebalancer). The gap is
  drift — and where it exceeds the rebalancer's own band, the book is out of policy at that
  sample.</p>
  <div class="alert ok"><strong>Both sides cover the same ${targeted.size} rebalanced
  account${targeted.size === 1 ? '' : 's'}.</strong> A target exists only where the rebalancer
  manages the money, so the house, the company stake and the collectibles are excluded from
  <em>both</em> lines. Comparing a portfolio target against the whole book would report a gap
  that is really two different questions.</div>
  ${chartBlock('chart-target', 'Realized (solid) vs target (dashed)', '')}
  <p class="notes">Samples are 31 December, and the rebalance fires on the 1 January period
  advance — so each point is the drift accumulated over that year, read just BEFORE it is
  corrected. That is the useful instant: it shows how far the band actually let the book move.
  ${driftNow?.band != null ? `Band shown: ±${pct(driftNow.band)} (the tightest in play; sheltered
  accounts run tighter than taxable ones).` : ''}</p>
  <div class="scroll"><table class="plain">
    <thead><tr><th>class</th><th class="num">realized</th><th class="num">target</th>
      <th class="num">drift</th><th>status</th></tr></thead>
    <tbody>${driftNow.rows.filter(r => r.realized > 0.0005 || r.target > 0.0005).map(r => `<tr>
      <th>${esc(r.key)}</th>
      <td class="num">${pct(r.realized)}</td>
      <td class="num">${pct(r.target)}</td>
      <td class="num">${(r.drift >= 0 ? '+' : '−')}${pct(Math.abs(r.drift))}</td>
      <td>${r.breach ? '<strong>out of band</strong>' : 'within band'}</td>
    </tr>`).join('')}</tbody>
  </table></div>
  <p class="notes">Figures at the last <strong>year-end</strong> (${esc(driftDate ?? '')}), not at the
  run horizon: a horizon sample dated 1 January is taken immediately after the rebalance and
  reports 0.0% drift for every class — perfectly on policy at the one instant it cannot be
  otherwise.</p>
  ` : `
  <div class="alert warn"><strong>No account carries a target composition in this run.</strong>
  Nothing stamped <code>account.targetComposition</code>, so there is nothing to compare against
  — set an allocation strategy to make this section report drift rather than nothing.</div>
  `}
</section>`);

sections.push(`<section id="country"><h2>By country</h2>
  <p class="lede"><strong>Domicile</strong> is where the wrapper is — the tax and jurisdiction
  view. <strong>Exposure</strong> is what market the money tracks, read from each holding's rate
  series. They disagree wherever a sleeve is held outside its own market, and the gap between
  these two charts is exactly that.</p>
  ${countryViewsAgree
    ? `<div class="alert ok"><strong>The two views are identical in this plan.</strong> Every
       holding's rate series names its own wrapper's country — no sleeve is held outside its home
       market — so domicile and exposure coincide and the toggle below changes nothing. That is a
       fact about the plan, not a broken control.</div>`
    : ''}
  ${chartBlock('chart-country', 'Class within country',
    `<span class="seg" data-seg2="chart-country">
       <button class="on" data-src="domicile">domicile</button><button data-src="exposure">exposure</button>
     </span>`)}
</section>`);

sections.push(`<section id="account"><h2>By account</h2>
  <p class="lede">The whole book by account, or one account's own mix. A wrapper whose share of
  the book is collapsing is being drained; a wrapper whose internal mix is drifting is being
  drained <em>unevenly</em>.</p>
  ${chartBlock('chart-account', 'Allocation by account',
    `<select class="sel" data-account="chart-account">
       <option value="__all__">every account (by wrapper)</option>
       ${accountKeys.map(k => `<option value="${esc(k)}">${esc(nameByKey.get(k) ?? k)}</option>`).join('')}
     </select>`)}
</section>`);

sections.push(`<section id="ratekey"><h2>By return series</h2>
  <p class="lede">The diagnostic cut: which rate series actually carries the money. Finer than
  class — it splits a wrapper's own equity sleeve from another's — and the granularity at which
  shocks and per-sleeve betas apply, so this is the chart to read when asking <em>why</em> a
  year moved. <span class="muted">Holdings only: property, company equity and collectibles carry
  no rate series and are excluded here.</span></p>
  ${chartBlock('chart-ratekey', 'Market value by rate series', '')}
</section>`);

// The numbers behind the top chart, for anyone who wants to check one.
const mixTable = views.total.pct;
sections.push(`<section id="table"><h2>Year-end mix</h2>
  <p class="lede">The top chart as figures. Net worth is shown alongside, since a share can fall
  while its dollar value rises.</p>
  <div class="scroll"><table class="plain">
    <thead><tr><th>year</th>${mixTable.keys.map(k => `<th class="num">${esc(k)}</th>`).join('')}
      <th class="num">gross</th><th class="num">net worth</th></tr></thead>
    <tbody>${mixTable.dates.map((d, i) => `<tr>
      <th>${esc(d.slice(0, 4))}</th>
      ${mixTable.keys.map(k => `<td class="num">${pct(mixTable.series[k][i])}</td>`).join('')}
      <td class="num">${money(views.total.abs.totals[i])}</td>
      <td class="num">${money(tieOut[i]?.netWorth)}</td>
    </tr>`).join('')}</tbody>
  </table></div>
</section>`);

const nav = [
  { id: 'provenance', label: 'Provenance' },
  { id: 'headlines',  label: 'Headlines' },
  { id: 'total',      label: 'Total' },
  { id: 'target',     label: 'Target vs realized' },
  { id: 'country',    label: 'By country' },
  { id: 'account',    label: 'By account' },
  { id: 'ratekey',    label: 'By return series' },
  { id: 'table',      label: 'Year-end mix' },
];

const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(basename(source))} — allocation over time</title>
<style>
:root{
  color-scheme: light dark;
  --surface:#fcfcfb; --plane:#f9f9f7; --ink:#0b0b0b; --ink2:#52514e; --muted:#898781;
  --grid:#e1e0d9; --rule:#c3c2b7; --border:rgba(11,11,11,.10);
  --good:#0ca30c; --warn:#fab219; --crit:#d03b3b;
}
@media (prefers-color-scheme: dark){ :root:where(:not([data-theme="light"])){
  --surface:#1a1a19; --plane:#0d0d0d; --ink:#fff; --ink2:#c3c2b7; --muted:#898781;
  --grid:#2c2c2a; --rule:#383835; --border:rgba(255,255,255,.10);
}}
:root[data-theme="dark"]{
  --surface:#1a1a19; --plane:#0d0d0d; --ink:#fff; --ink2:#c3c2b7; --muted:#898781;
  --grid:#2c2c2a; --rule:#383835; --border:rgba(255,255,255,.10);
}
*{box-sizing:border-box}
body{margin:0;background:var(--plane);color:var(--ink);
  font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:1180px;margin:0 auto;padding:0 20px 96px}
header.top{padding:40px 0 8px}
h1{font-size:28px;line-height:1.2;margin:0 0 4px;font-weight:650;letter-spacing:-.01em}
.sub{color:var(--ink2);margin:0 0 20px}
.sub code{font-size:13px}
nav.toc{position:sticky;top:0;z-index:5;background:var(--plane);
  border-bottom:1px solid var(--border);padding:10px 0;margin-bottom:8px;
  display:flex;gap:6px;flex-wrap:wrap}
nav.toc a{font-size:12.5px;color:var(--ink2);text-decoration:none;
  padding:4px 9px;border:1px solid var(--border);border-radius:999px;white-space:nowrap}
nav.toc a:hover{color:var(--ink);border-color:var(--rule)}
section{background:var(--surface);border:1px solid var(--border);border-radius:12px;
  padding:22px 24px;margin:20px 0}
h2{font-size:19px;margin:0 0 6px;font-weight:620;letter-spacing:-.005em}
.lede{color:var(--ink2);font-size:13.5px;margin:0 0 14px;max-width:82ch}
.notes{color:var(--ink2);font-size:13.5px;margin:14px 0 0;max-width:82ch;
  border-left:2px solid var(--rule);padding-left:12px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;
  background:var(--plane);padding:1px 4px;border-radius:3px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.muted{color:var(--muted)}
.scroll{overflow-x:auto;max-width:100%}
.alert{font-size:13.5px;padding:10px 13px;border-radius:8px;margin:0 0 12px;
  border:1px solid var(--border);border-left-width:3px}
.alert.crit{border-left-color:var(--crit);background:color-mix(in srgb,var(--crit) 7%,transparent)}
.alert.warn{border-left-color:var(--warn);background:color-mix(in srgb,var(--warn) 9%,transparent)}
.alert.ok{border-left-color:var(--good);background:color-mix(in srgb,var(--good) 7%,transparent)}
.alert.crit::before{content:"⛔ ";} .alert.warn::before{content:"⚠ ";} .alert.ok::before{content:"✓ ";}
.cards{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(215px,1fr))}
.card{border:1px solid var(--border);border-radius:10px;padding:14px 15px;background:var(--plane)}
.card-kicker{margin:0;font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;
  color:var(--muted);font-weight:600}
.hero{margin:6px 0 2px;font-size:32px;line-height:1.05;font-weight:640;letter-spacing:-.02em}
.card-sub{margin:0 0 4px;font-size:12px;color:var(--ink2)}
.card-facts{margin:8px 0 0;display:grid;gap:3px}
.card-facts div{display:flex;justify-content:space-between;gap:8px;font-size:12.5px}
.card-facts dt{color:var(--muted)} .card-facts dd{margin:0;font-variant-numeric:tabular-nums}
table{border-collapse:separate;border-spacing:0;font-size:13px}
table.plain{width:100%}
table.plain th,table.plain td{text-align:left;padding:6px 10px;
  border-bottom:1px solid var(--grid);white-space:nowrap}
table.plain thead th{color:var(--muted);font-weight:600;font-size:11.5px;
  text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid var(--rule)}
table.plain tbody th{font-weight:550}
table.plain th.num,table.plain td.num{text-align:right;font-variant-numeric:tabular-nums}
.chart{height:380px;width:100%}
.chart-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 6px}
.chart-cap{font-size:12px;color:var(--ink2);font-weight:600;margin-right:auto}
.seg{display:inline-flex;border:1px solid var(--border);border-radius:999px;overflow:hidden}
.seg button{font:inherit;font-size:12px;padding:3px 11px;border:0;cursor:pointer;
  background:transparent;color:var(--ink2)}
.seg button.on{background:var(--ink);color:var(--surface)}
.sel{font:inherit;font-size:12px;padding:3px 8px;border:1px solid var(--border);
  border-radius:6px;background:var(--plane);color:var(--ink)}
.chk{font-size:12px;color:var(--ink2);display:inline-flex;align-items:center;gap:5px}
@media print{nav.toc{display:none}section{break-inside:avoid;border:none;padding:0}}
</style>
</head><body>
<div class="wrap">
<header class="top">
  <h1>Allocation over time</h1>
  <p class="sub"><code>${esc(source)}</code> · ${tieOut[0].year}–${tieOut.at(-1).year} year-ends
    · nominal ${esc(BASE)} · rendered ${esc(when(Date.now()))} UTC</p>
</header>
<nav class="toc">${nav.map(n => `<a href="#${esc(n.id)}">${esc(n.label)}</a>`).join('')}</nav>
${sections.join('\n')}
</div>
<script>${echartsJs}</script>
<script>
const DATA = ${JSON.stringify(payload)};

const dark = () => (document.documentElement.dataset.theme === 'dark') ||
  (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
const ink  = () => (dark() ? '#c3c2b7' : '#52514e');
const line = () => (dark() ? '#2c2c2a' : '#e1e0d9');

const money = n => (n < 0 ? '−' : '') + '$' + Math.abs(Math.round(n)).toLocaleString();
const compact = n => {
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(1) + 'm';
  if (a >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(Math.round(n));
};

/** Colour for a series key: fixed per asset class, else a stable cycle position. */
function colorFor(key, index) {
  if (DATA.classColor[key]) return DATA.classColor[key];
  const tail = String(key).split(' · ').pop();      // "US · EQUITY" → "EQUITY"
  if (DATA.classColor[tail]) return DATA.classColor[tail];
  return DATA.cycle[index % DATA.cycle.length];
}

function optionFor(view, mode) {
  const share = mode === 'pct';
  return {
    animation: false,
    backgroundColor: 'transparent',
    textStyle: { color: ink(), fontFamily: 'system-ui,-apple-system,sans-serif' },
    grid: { left: 62, right: 18, top: 12, bottom: 68 },
    legend: {
      type: 'scroll', bottom: 0, itemHeight: 9, itemWidth: 12,
      textStyle: { color: ink(), fontSize: 11 },
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: ink(), opacity: .35 } },
      formatter(params) {
        if (!params.length) return '';
        const i = params[0].dataIndex;
        const head = '<strong>' + params[0].axisValue.slice(0, 4) + '</strong>' +
          (share ? ' <span style="opacity:.6">of ' + money(view.totals[i]) + '</span>' : '');
        // Descending, and zero series dropped: a 12-line tooltip where 5 read 0.0%
        // is how a reader stops opening the tooltip at all.
        const lines = params
          .filter(p => Math.abs(p.value) > (share ? 0.0005 : 0.5))
          .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
          .map(p => p.marker + ' ' + p.seriesName +
            ' <strong>' + (share ? (p.value * 100).toFixed(1) + '%' : money(p.value)) + '</strong>');
        return head + '<br>' + lines.join('<br>');
      },
    },
    xAxis: {
      type: 'category', boundaryGap: false,
      data: view.dates.map(d => d.slice(0, 4)),
      axisLine: { lineStyle: { color: line() } },
      axisLabel: { color: ink(), fontSize: 11 },
    },
    yAxis: {
      type: 'value',
      max: share ? 1 : null,
      splitLine: { lineStyle: { color: line() } },
      axisLabel: {
        color: ink(), fontSize: 11,
        formatter: v => (share ? Math.round(v * 100) + '%' : compact(v)),
      },
    },
    series: view.keys.map((key, i) => ({
      name: key, type: 'line', stack: 'all', smooth: false,
      showSymbol: false, lineStyle: { width: 1 },
      areaStyle: { opacity: .85 },
      itemStyle: { color: colorFor(key, i) },
      emphasis: { focus: 'series' },
      data: view.series[key],
    })),
  };
}

const charts = {};
const state  = {
  'chart-total':   { mode: 'pct', src: 'total' },
  'chart-country': { mode: 'pct', src: 'domicile' },
  'chart-account': { mode: 'pct', src: '__all__' },
  'chart-ratekey': { mode: 'pct', src: 'rateKey' },
};
// Only registered when the run produced targets; otherwise the section renders a note.
if (DATA.targetViews) state['chart-target'] = { mode: 'pct', src: '__target__' };

function viewFor(id) {
  const s = state[id];
  if (id === 'chart-account') {
    return s.src === '__all__' ? DATA.views.byAccount[s.mode] : DATA.perAccount[s.src][s.mode];
  }
  return DATA.views[s.src][s.mode];
}

/**
 * Realized vs target (design 82 §7): lines, not stacked areas.
 *
 * Two stacked areas cannot be compared by eye — it asks the reader to judge band
 * thicknesses at different offsets — and the question here is each class's distance from
 * its target, which is exactly what a solid line against a dashed one shows.
 */
function targetOptionFor(mode) {
  const share = mode === 'pct';
  const T = DATA.targetViews;
  const dates = T.actual.dates;
  const at = new Map(T.target.dates.map((d, i) => [d, i]));
  const align = key => dates.map(d => {
    const i = at.get(d);
    return i === undefined ? null : T.target.series[key][i];
  });
  const fmt = v => (v == null ? '—' : share ? (v * 100).toFixed(1) + '%' : money(v));
  const keys = [...new Set([...T.actual.keys, ...T.target.keys])];

  return {
    animation: false,
    backgroundColor: 'transparent',
    textStyle: { color: ink(), fontFamily: 'system-ui,-apple-system,sans-serif' },
    grid: { left: 62, right: 18, top: 12, bottom: 68 },
    legend: { type: 'scroll', bottom: 0, itemHeight: 9, itemWidth: 12,
              textStyle: { color: ink(), fontSize: 11 } },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: ink(), opacity: .35 } },
      formatter(params) {
        if (!params.length) return '';
        const byKey = new Map();
        for (const p of params) {
          const key = p.seriesName.replace(/ (actual|target)$/, '');
          const slot = byKey.get(key) || { marker: p.marker };
          slot[p.seriesName.endsWith('target') ? 'target' : 'actual'] = p.value;
          byKey.set(key, slot);
        }
        const lines = [...byKey.entries()]
          .filter(([, v]) => (v.actual || 0) > 0 || (v.target || 0) > 0)
          .map(([key, v]) => v.marker + ' ' + key + ' <strong>' + fmt(v.actual) +
            '</strong> <span style="opacity:.65">vs ' + fmt(v.target) + '</span>');
        return '<strong>' + params[0].axisValue.slice(0, 4) + '</strong><br>' + lines.join('<br>');
      },
    },
    xAxis: { type: 'category', boundaryGap: false, data: dates.map(d => d.slice(0, 4)),
             axisLine: { lineStyle: { color: line() } },
             axisLabel: { color: ink(), fontSize: 11 } },
    yAxis: { type: 'value', min: 0, max: share ? 1 : null,
             splitLine: { lineStyle: { color: line() } },
             axisLabel: { color: ink(), fontSize: 11,
                          formatter: v => (share ? Math.round(v * 100) + '%' : compact(v)) } },
    series: keys.flatMap((key, i) => {
      const color = colorFor(key, i);
      return [
        { name: key + ' actual', type: 'line', showSymbol: false, smooth: false,
          lineStyle: { width: 2, color }, itemStyle: { color },
          emphasis: { focus: 'series' }, data: T.actual.series[key] || dates.map(() => 0) },
        { name: key + ' target', type: 'line', showSymbol: false, smooth: false,
          lineStyle: { width: 1, type: 'dashed', color }, itemStyle: { color },
          emphasis: { focus: 'series' }, data: align(key) },
      ];
    }),
  };
}

function draw(id) {
  if (!charts[id]) charts[id] = echarts.init(document.getElementById(id), null, { renderer: 'canvas' });
  const option = id === 'chart-target'
    ? targetOptionFor(state[id].mode)
    : optionFor(viewFor(id), state[id].mode);
  charts[id].setOption(option, true);
}

for (const id of Object.keys(state)) draw(id);

document.querySelectorAll('[data-seg]').forEach(seg => {
  const id = seg.dataset.seg;
  seg.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
    seg.querySelectorAll('button').forEach(b => b.classList.remove('on'));
    btn.classList.add('on');
    state[id].mode = btn.dataset.mode;
    draw(id);
  }));
});

document.querySelectorAll('[data-seg2]').forEach(seg => {
  const id = seg.dataset.seg2;
  seg.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
    seg.querySelectorAll('button').forEach(b => b.classList.remove('on'));
    btn.classList.add('on');
    state[id].src = btn.dataset.src;
    draw(id);
  }));
});

document.querySelectorAll('[data-account]').forEach(sel => {
  const id = sel.dataset.account;
  sel.addEventListener('change', () => { state[id].src = sel.value; draw(id); });
});

document.querySelectorAll('[data-net]').forEach(box => {
  const id = box.dataset.net;
  box.addEventListener('change', () => { state[id].src = box.checked ? 'net' : 'total'; draw(id); });
});

addEventListener('resize', () => { for (const c of Object.values(charts)) c.resize(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  for (const id of Object.keys(charts)) draw(id);
});
</script>
</body></html>`;

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, html);
console.log(`wrote ${outFile}  (${(html.length / 1024 / 1024).toFixed(2)} MB, ${rows.length} cube rows)`);

if (has('--csv')) {
  const csvPath = outFile.replace(/\.html?$/i, '') + '.csv';
  const cols = ['date', 'stateKey', 'name', 'source', 'kind', 'role', 'type', 'domicileCountry',
    'exposureCountry', 'currency', 'assetClass', 'allocation', 'rateKey', 'holdingCount',
    'marketValueLocal', 'marketValue', 'costBasisLocal', 'costBasis', 'inferred'];
  const cell = v => {
    if (v == null) return '';
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // UTF-8 BOM so Excel opens it as UTF-8 rather than mangling the account names.
  writeFileSync(csvPath, '﻿' + [cols.join(','),
    ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n'));
  console.log(`wrote ${csvPath}`);
}

if (Math.abs(worstTie.delta) >= 1) {
  console.error(`** cube does NOT tie to net worth (worst gap ${money(worstTie.delta)} in ${worstTie.year})`);
}

if (has('--open') && existsSync(outFile)) {
  try { execFileSync('open', [outFile]); } catch { /* not macOS, or no opener */ }
}
