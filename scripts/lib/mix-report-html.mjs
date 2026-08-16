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
 * mix-report-html.mjs — the Monte Carlo mix distribution as one self-contained page
 * (design 82 §8.2).
 *
 * The terminal report in `mc-report.mjs` can state a threshold probability, but it
 * cannot show a band moving over 45 years, and "when does the shape turn?" is most of
 * what Phase 4 exists to answer. So the same reduction gets a second presentation —
 * the same relationship `lib/grid-report.mjs` has with the terminal grid report.
 *
 * Every band is computed in node through `src/finance/allocation-reporting/
 * mix-distribution.js`; the browser only picks which precomputed object to draw. The
 * page never re-derives a share, for the reason design 82 §5 gives: two implementations
 * of one pivot can disagree, and there is no way to tell which is right.
 *
 * ─── the two rules this page must not break ──────────────────────────────────
 *
 * **Never stack the bands.** They are MARGINAL — the p90 EQUITY band and the p90
 * REAL_ESTATE band come from different paths, so they do not sum to 1. One chart per
 * class, and the page says so where a reader would otherwise assume otherwise.
 *
 * **Post-ruin path-years are excluded, visibly.** A path with zero gross assets has no
 * mix (0/0); folding it in would let "90% house" quietly absorb every ruined path. The
 * excluded count is drawn as its own series rather than mentioned in a footnote.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import {
  mixBands, mixByOutcome, thresholdProbabilities, DEFAULT_MIX_THRESHOLDS,
} from '../../src/finance/allocation-reporting/mix-distribution.js';
import { ASSET_CLASS_COLOR } from '../../src/finance/allocation-reporting/allocation-palette.js';
import { PALETTE_CYCLE }     from '../../src/finance/reporting-common/palette-cycle.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (r, dp = 1) => (r == null ? '—' : `${(r * 100).toFixed(dp)}%`);
const when = ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

const PCTL = [0.10, 0.50, 0.90];

/** Reduce one arm's matrix to everything the page draws for it. @private */
function reduceArm(mixSeries, thresholds) {
  const all   = mixBands(mixSeries, { percentiles: PCTL });
  const split = mixByOutcome(mixSeries, { percentiles: PCTL });

  const view = (b) => ({
    bands: b.bands, n: b.n, excluded: b.excluded, paths: b.paths,
  });

  return {
    years:   all.years,
    classes: all.classes,
    // Classes that are zero at every percentile at every year carry no information and
    // would fill the grid with flat lines at 0. A class that is merely zero LATE keeps
    // its chart — "equity is gone by 2063" is the finding, not noise.
    active: all.classes.filter(c =>
      PCTL.some(p => all.bands[c][p].some(v => v != null && v > 0.0005))),
    outcomes: { all: view(all), failed: view(split.failed), survived: view(split.survived) },
    nFailed: split.nFailed,
    nSurvived: split.nSurvived,
    thresholds: thresholdProbabilities(mixSeries, thresholds),
  };
}

/**
 * Render the page.
 *
 * @param {object}   o
 * @param {object}   o.arms       `{ [armKey]: armRecord }`, arm records as written by mc-run
 * @param {string[]} o.keys       arm keys in spec order
 * @param {object}   [o.meta]     the baseline arm record, for the header
 * @param {Array}    [o.thresholds]
 * @returns {string} a complete HTML document
 */
export function renderMixReport({ arms, keys, meta = null, thresholds = DEFAULT_MIX_THRESHOLDS }) {
  const withMix = keys.filter(k => arms[k]?.mixSeries?.paths?.length);
  if (withMix.length === 0) {
    throw new Error('no arm carries a mixSeries — re-run mc-run.mjs with --mix');
  }

  const reduced = {};
  for (const k of withMix) reduced[k] = reduceArm(arms[k].mixSeries, thresholds);

  const rm = meta?.riskModel ?? {};
  const first = reduced[withMix[0]];

  const require = createRequire(import.meta.url);
  const echartsJs = readFileSync(require.resolve('echarts/dist/echarts.min.js'), 'utf8')
    .replace(/<\/script>/gi, '<\\/script>');   // never let the payload close its own tag

  const payload = {
    arms: reduced,
    keys: withMix,
    classColor: ASSET_CLASS_COLOR,
    cycle: PALETTE_CYCLE,
  };

  const thresholdTable = `
  <div class="scroll"><table class="plain">
    <thead><tr><th>readout</th><th class="num">window</th>
      ${withMix.map(k => `<th class="num">${esc(k)}</th>`).join('')}</tr></thead>
    <tbody>${thresholds.map(spec => {
      const row = withMix.map(k => reduced[k].thresholds.find(t => t.key === spec.key));
      return `<tr>
        <th>${esc(spec.label)}</th>
        <td class="num mono">${row[0] ? `${row[0].fromYear}–${row[0].toYear}` : '—'}</td>
        ${row.map(t => `<td class="num">${t ? pct(t.rate, 0) : '—'}
          <span class="muted">(${t ? t.n : 0})</span></td>`).join('')}
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;

  const nav = [
    { id: 'provenance', label: 'How to read this' },
    { id: 'thresholds', label: 'Threshold probabilities' },
    { id: 'bands',      label: 'Mix bands' },
    { id: 'outcome',    label: 'Conditioned on failure' },
  ];

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Monte Carlo — asset mix distribution</title>
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
table{border-collapse:separate;border-spacing:0;font-size:13px}
table.plain{width:100%}
table.plain th,table.plain td{text-align:left;padding:6px 10px;
  border-bottom:1px solid var(--grid);white-space:nowrap}
table.plain thead th{color:var(--muted);font-weight:600;font-size:11.5px;
  text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid var(--rule)}
table.plain tbody th{font-weight:550;white-space:normal}
table.plain th.num,table.plain td.num{text-align:right;font-variant-numeric:tabular-nums}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(330px,1fr))}
.tile{border:1px solid var(--border);border-radius:10px;padding:10px 12px 4px;background:var(--plane)}
.tile-cap{font-size:12px;font-weight:600;color:var(--ink2);margin:0 0 2px;
  display:flex;align-items:center;gap:6px}
.swatch{width:9px;height:9px;border-radius:2px;display:inline-block}
.tile-sub{font-size:11.5px;color:var(--muted);margin:0}
.chart{height:210px;width:100%}
.chart.tall{height:300px}
.controls{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 12px}
.seg{display:inline-flex;border:1px solid var(--border);border-radius:999px;overflow:hidden}
.seg button{font:inherit;font-size:12px;padding:3px 11px;border:0;cursor:pointer;
  background:transparent;color:var(--ink2)}
.seg button.on{background:var(--ink);color:var(--surface)}
.seg-label{font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600}
@media print{nav.toc{display:none}section{break-inside:avoid;border:none;padding:0}}
</style>
</head><body>
<div class="wrap">
<header class="top">
  <h1>Asset mix, as a distribution</h1>
  <p class="sub"><code>${esc(meta?.source ?? 'unknown')}</code> · n=${esc(meta?.n ?? '?')}/arm ·
    ${withMix.length} arm${withMix.length === 1 ? '' : 's'} ·
    ${first.years[0]}–${first.years.at(-1)} · rendered ${esc(when(Date.now()))} UTC</p>
</header>
<nav class="toc">${nav.map(n => `<a href="#${esc(n.id)}">${esc(n.label)}</a>`).join('')}</nav>

<section id="provenance"><h2>How to read this</h2>
  <p class="lede">The allocation report answers "on the central path, what shape does this plan
  take?". This answers <strong>how often it takes that shape</strong> — which is usually the more
  decision-relevant of the two. "Ends 90% house" is alarming; "ends ≥60% house in 80% of paths" is
  actionable, and "in 8%" is noise.</p>
  <div class="alert warn"><strong>The bands are marginal — do not add them up.</strong> The p90
  <code>EQUITY</code> band and the p90 <code>REAL_ESTATE</code> band come from
  <em>different paths</em>, so they do not sum to 100%. That is why each class gets its own chart
  and nothing here is stacked: a stacked rendering would assert a mix no path ever held.</div>
  <div class="alert ok"><strong>Post-ruin path-years are excluded, not counted as zero.</strong>
  A path holding nothing has no mix (0/0), so it drops out of that year's percentiles and is
  counted in the <em>excluded</em> line instead. Without that, "90% house" would silently absorb
  every ruined path.</div>
  <p class="notes">Samples are taken at the year boundary — the state after the last event dated
  in year Y — the same instant the allocation report and the workbench panel use. The investment
  family is dated 31 December, so each sample carries a complete year of growth, spending and tax;
  real-asset appreciation lands on 1 January, so every mix understates the real-asset share by
  about one appreciation cycle. That is a level bias, not a trend one — every point sits at the
  same place in the annual cycle, so the series is self-consistent.
  ${rm.paths
    ? `Returns are stochastic year by year (vol ${esc(rm.vol)}, drift ${esc(rm.drift)}).`
    : `<strong>Returns are a single long-run average per path</strong> — there is no
       sequence-of-returns risk in these worlds, so the spread of shapes here is narrower than
       reality.`}</p>
</section>

<section id="thresholds"><h2>Threshold probabilities</h2>
  <p class="lede">The readouts worth quoting. Each cell is the share of paths meeting the
  condition, with the number of paths that had a mix to test in parentheses — a path excluded for
  holding nothing is not counted as a miss.</p>
  ${thresholdTable}
  <p class="notes">These live in a file, not in code: <code>--thresholds &lt;file.json&gt;</code>
  replaces the set without re-running an arm. That is the whole reason the per-path matrix is
  kept raw in the arm output rather than pre-reduced to bands.</p>
</section>

<section id="bands"><h2>Mix bands</h2>
  <p class="lede">Each class's share of gross assets over the plan: the solid line is the median
  path, the shaded band p10–p90. A band that widens is a shape the plan does not control; a band
  that drifts as one is a shape the plan is choosing.</p>
  <div class="controls">
    <span class="seg-label">arm</span>
    <span class="seg" id="arm-seg">${withMix.map((k, i) =>
      `<button data-arm="${esc(k)}"${i === 0 ? ' class="on"' : ''}>${esc(k)}</button>`).join('')}</span>
    <span class="seg-label">paths</span>
    <span class="seg" id="outcome-seg">
      <button data-outcome="all" class="on">all</button>
      <button data-outcome="failed">failed</button>
      <button data-outcome="survived">survived</button>
    </span>
  </div>
  <div id="band-grid" class="grid"></div>
  <p class="notes" id="band-note"></p>
</section>

<section id="outcome"><h2>Conditioned on failure</h2>
  <p class="lede">The median mix of the paths that ran out of money against the paths that did
  not. <strong>This is the number that decides which conversation to have.</strong> If the failing
  paths are the house-heavy paths, the shape <em>is</em> the failure mechanism and the target
  overlay in the allocation report is where to intervene. If they are not, the shape is a
  bequest-composition question and not a solvency one.</p>
  <div class="controls">
    <span class="seg-label">arm</span>
    <span class="seg" id="gap-seg">${withMix.map((k, i) =>
      `<button data-arm="${esc(k)}"${i === 0 ? ' class="on"' : ''}>${esc(k)}</button>`).join('')}</span>
  </div>
  <div id="gap-body"></div>
</section>
</div>
<script>${echartsJs}</script>
<script>
const DATA = ${JSON.stringify(payload)};

const dark = () => (document.documentElement.dataset.theme === 'dark') ||
  (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
const ink  = () => (dark() ? '#c3c2b7' : '#52514e');
const line = () => (dark() ? '#2c2c2a' : '#e1e0d9');
const pct  = (v, dp = 1) => (v == null ? '—' : (v * 100).toFixed(dp) + '%');

function colorFor(key, index) {
  return DATA.classColor[key] || DATA.cycle[index % DATA.cycle.length];
}

const state = { arm: DATA.keys[0], outcome: 'all', gapArm: DATA.keys[0] };
const charts = {};

/**
 * One class's band. p10–p90 is drawn as a transparent floor plus a stacked delta —
 * the standard way to get a filled interval out of a line chart — and the median rides
 * on top UNSTACKED, so it reads as the value it is rather than as a cumulative sum.
 */
function bandOption(arm, cls, index) {
  const A = DATA.arms[arm];
  const o = A.outcomes[state.outcome];
  const b = o.bands[cls];
  const color = colorFor(cls, index);
  const years = A.years.map(String);
  const lo = b['0.1'] ?? b[0.1];
  const mid = b['0.5'] ?? b[0.5];
  const hi = b['0.9'] ?? b[0.9];
  const delta = hi.map((v, i) => (v == null || lo[i] == null ? null : v - lo[i]));

  return {
    animation: false,
    backgroundColor: 'transparent',
    textStyle: { color: ink(), fontFamily: 'system-ui,-apple-system,sans-serif' },
    grid: { left: 46, right: 12, top: 10, bottom: 24 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: ink(), opacity: .35 } },
      formatter(params) {
        if (!params.length) return '';
        const i = params[0].dataIndex;
        return '<strong>' + years[i] + '</strong><br>' +
          'p50 <strong>' + pct(mid[i]) + '</strong><br>' +
          '<span style="opacity:.7">p10–p90 ' + pct(lo[i]) + ' – ' + pct(hi[i]) + '</span><br>' +
          '<span style="opacity:.7">' + o.n[i] + ' paths' +
          (o.excluded[i] ? ', ' + o.excluded[i] + ' excluded' : '') + '</span>';
      },
    },
    xAxis: {
      type: 'category', boundaryGap: false, data: years,
      axisLine: { lineStyle: { color: line() } },
      axisLabel: { color: ink(), fontSize: 10 },
    },
    yAxis: {
      type: 'value', min: 0, max: 1,
      splitLine: { lineStyle: { color: line() } },
      axisLabel: { color: ink(), fontSize: 10, formatter: v => Math.round(v * 100) + '%' },
    },
    series: [
      { name: 'p10', type: 'line', stack: cls + '-band', showSymbol: false,
        lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 }, silent: true, data: lo },
      { name: 'p10–p90', type: 'line', stack: cls + '-band', showSymbol: false,
        lineStyle: { opacity: 0 }, areaStyle: { color, opacity: .20 }, silent: true, data: delta },
      { name: 'p50', type: 'line', showSymbol: false, smooth: false,
        lineStyle: { width: 2, color }, itemStyle: { color }, data: mid },
    ],
  };
}

function drawBands() {
  const A = DATA.arms[state.arm];
  const o = A.outcomes[state.outcome];
  const host = document.getElementById('band-grid');

  for (const c of Object.values(charts)) c.dispose();
  for (const k of Object.keys(charts)) delete charts[k];
  host.innerHTML = '';

  if (o.paths === 0) {
    host.innerHTML = '<div class="alert warn"><strong>No paths in this subset.</strong> ' +
      (state.outcome === 'failed' ? 'Nothing failed in this arm.' : 'Every path failed in this arm.') +
      '</div>';
    document.getElementById('band-note').textContent = '';
    return;
  }

  A.active.forEach((cls, i) => {
    const id = 'band-' + cls;
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.innerHTML =
      '<p class="tile-cap"><span class="swatch" style="background:' + colorFor(cls, i) + '"></span>' +
      cls + '</p>' +
      '<p class="tile-sub">p50 ' + pct(o.bands[cls]['0.5'][A.years.length - 1]) +
      ' at ' + A.years[A.years.length - 1] + '</p>' +
      '<div class="chart" id="' + id + '"></div>';
    host.appendChild(tile);
    charts[id] = echarts.init(document.getElementById(id), null, { renderer: 'canvas' });
    charts[id].setOption(bandOption(state.arm, cls, i), true);
  });

  const worst = Math.max(...o.excluded);
  document.getElementById('band-note').textContent =
    o.paths + ' paths in this subset. ' +
    (worst > 0
      ? 'Up to ' + worst + ' of them hold nothing in some year and are excluded from that year\\'s percentiles — a path with no assets has no mix.'
      : 'Every path holds assets at every year, so nothing is excluded.');
}

function drawGap() {
  const A = DATA.arms[state.gapArm];
  const f = A.outcomes.failed, s = A.outcomes.survived;
  const host = document.getElementById('gap-body');
  const y = A.years.length - 1;

  if (A.nFailed === 0) {
    host.innerHTML = '<div class="alert ok"><strong>No path failed in this arm.</strong> ' +
      'There is nothing to condition on — which is itself the answer: the shape is not a ' +
      'solvency question here.</div>';
    return;
  }

  const rows = A.classes.map(cls => {
    const a = f.bands[cls]['0.5'][y], b = s.bands[cls]['0.5'][y];
    return { cls, failed: a, survived: b, gap: (a == null || b == null) ? null : a - b };
  }).filter(r => (r.failed ?? 0) > 0.0005 || (r.survived ?? 0) > 0.0005)
    .sort((a, b) => Math.abs(b.gap ?? 0) - Math.abs(a.gap ?? 0));

  host.innerHTML =
    '<div class="scroll"><table class="plain"><thead><tr>' +
    '<th>class</th><th class="num">failed paths</th><th class="num">surviving paths</th>' +
    '<th class="num">gap</th></tr></thead><tbody>' +
    rows.map(r =>
      '<tr><th>' + r.cls + '</th>' +
      '<td class="num">' + pct(r.failed) + '</td>' +
      '<td class="num">' + pct(r.survived) + '</td>' +
      '<td class="num">' + (r.gap == null ? '—' : (r.gap >= 0 ? '+' : '−') + pct(Math.abs(r.gap))) +
      '</td></tr>').join('') +
    '</tbody></table></div>' +
    '<p class="notes">Median share at ' + A.years[y] + ', over ' + A.nFailed + ' failed and ' +
    A.nSurvived + ' surviving paths. A large positive gap on an illiquid class is the finding to ' +
    'act on: it says the paths that ran out of money are the ones whose wealth ended up somewhere ' +
    'it could not be spent.</p>';
}

document.querySelectorAll('#arm-seg button').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('#arm-seg button').forEach(b => b.classList.remove('on'));
  btn.classList.add('on'); state.arm = btn.dataset.arm; drawBands();
}));
document.querySelectorAll('#outcome-seg button').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('#outcome-seg button').forEach(b => b.classList.remove('on'));
  btn.classList.add('on'); state.outcome = btn.dataset.outcome; drawBands();
}));
document.querySelectorAll('#gap-seg button').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('#gap-seg button').forEach(b => b.classList.remove('on'));
  btn.classList.add('on'); state.gapArm = btn.dataset.arm; drawGap();
}));

drawBands();
drawGap();

addEventListener('resize', () => { for (const c of Object.values(charts)) c.resize(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => drawBands());
</script>
</body></html>`;
}
