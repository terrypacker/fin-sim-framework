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
 * study-report.mjs — read a finished study directory and render it as one HTML page.
 *
 * A study directory is what `regenerate.sh` leaves behind: some number of
 * `out-*.json` grid runs and one or more `mc-out…` directories of Monte Carlo arms.
 * Reading it today means opening six fixed-width text reports and holding the
 * comparisons in your head. This renders the same numbers as one scannable page, so
 * a re-run after editing the scenario can be reviewed in a minute instead of an hour.
 *
 * Usage:
 *   node scripts/lab/study-report.mjs --dir scenarios/2026/july/v3
 *   node scripts/lab/study-report.mjs --dir <dir> --out /tmp/review.html --open
 *
 *   --dir <dir>       REQUIRED. The study directory.
 *   --out <file>      Output path (default `<dir>/report.html`).
 *   --scenario <file> Scenario to freshness-check against. Default: whatever the
 *                     grids recorded as their source.
 *   --pairs <list>    `a:b,c:d` MC arm pairs. Default: `report-config.json`'s, else
 *                     every arm against the first.
 *   --open            Open the result when done (macOS).
 *
 * ─── it reports on the INPUTS as well as the numbers ─────────────────────────
 *
 * The failure mode this tool exists to prevent is quoting a stale number. A study
 * directory is written incrementally — `ONLY=grids` leaves the Monte Carlo untouched,
 * a killed run leaves half the arms behind — so the files beside each other are NOT
 * necessarily from the same world. Every section therefore carries the mtime of what
 * it was built from, and anything older than the scenario file is flagged at the top
 * rather than rendered as if it were current.
 *
 * ─── what it will NOT do ─────────────────────────────────────────────────────
 *
 * It does not interpret. It computes the same frontier the terminal report computes
 * (via lib/grid-report.mjs — deliberately shared, so the two can't disagree), ranks
 * the axes by how much they move it, and stops. The marginal lever values in the
 * headline are a WHERE-TO-LOOK index, not a finding: an axis can top that chart
 * entirely on an interaction with a dated shock, which is a thing this page cannot
 * see and a human reading the panels can.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

import { buildGridModel } from '../lib/grid-report.mjs';
import { pairedRescues, pairedMetric, failureRate, failureByBand, failureDrivers } from '../lib/mc-analysis.mjs';
import { percentile, moneyAuto } from '../lib/format.mjs';

const USAGE = `
study-report.mjs — render a study directory as one HTML page.

  node scripts/lab/study-report.mjs --dir <study-dir> [options]

  --dir <dir>       REQUIRED. Directory of out-*.json grids and mc-out*/ arm dirs.
  --out <file>      Output path (default <dir>/report.html).
  --scenario <file> Scenario file to freshness-check against.
  --pairs <list>    "a:b,c:d" MC arm pairs (default: report-config.json, else vs first arm).
  --open            Open the result when done (macOS).
`;

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

const askedForHelp = argv.includes('-h') || argv.includes('--help');
if (askedForHelp || !flag('--dir')) {
  console.log(USAGE);
  process.exit(askedForHelp ? 0 : 2);   // asking for help is not an error
}

const dir = resolve(flag('--dir'));
if (!existsSync(dir)) { console.error(`no such directory: ${dir}`); process.exit(2); }
const outFile = flag('--out') ?? join(dir, 'report.html');

// Optional per-study configuration. Everything in it is a display choice; a study
// without one still renders, just with the generic defaults.
const cfgPath = join(dir, 'report-config.json');
const studyCfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {};

// ─── load: grids ─────────────────────────────────────────────────────────────

const mtime = (p) => { try { return statSync(p).mtimeMs; } catch { return null; } };
const when = (ms) => (ms == null ? 'missing' : new Date(ms).toISOString().slice(0, 16).replace('T', ' '));

const gridFiles = readdirSync(dir).filter(f => /^out-.*\.json$/.test(f)).sort();
const grids = [];
for (const f of gridFiles) {
  const path = join(dir, f);
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); }
  catch (err) { console.error(`** skipping ${f}: ${err.message}`); continue; }
  if (!raw.spec || !raw.results) { console.error(`** skipping ${f}: not a grid run`); continue; }
  try {
    grids.push({
      key: basename(f, '.json').replace(/^out-/, ''),
      file: f, mtimeMs: mtime(path), source: raw.source ?? null,
      model: buildGridModel(raw),
    });
  } catch (err) {
    console.error(`** skipping ${f}: ${err.message}`);
  }
}

// ─── load: monte carlo ───────────────────────────────────────────────────────

const mcDirs = readdirSync(dir, { withFileTypes: true })
  .filter(d => d.isDirectory() && d.name.startsWith('mc-out'))
  .map(d => d.name).sort();

const mcSets = [];
for (const name of mcDirs) {
  const path = join(dir, name);
  const files = readdirSync(path).filter(f => f.endsWith('.json'));
  if (!files.length) continue;
  const arms = {};
  let newest = null;
  for (const f of files) {
    try {
      const d = JSON.parse(readFileSync(join(path, f), 'utf8'));
      arms[d.arm ?? basename(f, '.json')] = d;
      newest = Math.max(newest ?? 0, mtime(join(path, f)) ?? 0);
    } catch (err) { console.error(`** skipping ${name}/${f}: ${err.message}`); }
  }
  const keys = Object.keys(arms).sort((a, b) =>
    (arms[a].order ?? Number.MAX_SAFE_INTEGER) - (arms[b].order ?? Number.MAX_SAFE_INTEGER)
    || a.localeCompare(b));
  if (!keys.length) continue;
  mcSets.push({ name, arms, keys, mtimeMs: newest, meta: arms[keys[0]] });
}

// ─── freshness ───────────────────────────────────────────────────────────────
//
// The scenario is the input every output here derives from, so anything older than it
// is suspect. Resolved relative to the repo root because that is how the grids record
// it — a bare "scenarios/x.json" in the JSON is repo-relative, not study-relative.

const REPO = resolve(new URL('../..', import.meta.url).pathname);
const scenarioPath = flag('--scenario')
  ?? (grids.find(g => g.source)?.source ?? mcSets.find(s => s.meta.source)?.meta.source ?? null);
// The recorded source carries the scenario INDEX (`…json#0`); that is provenance, not
// part of the filename, and leaving it on makes every freshness check report "missing".
const scenarioFile = scenarioPath ? scenarioPath.replace(/#\d+$/, '') : null;
const scenarioAbs = scenarioFile
  ? (existsSync(resolve(scenarioFile)) ? resolve(scenarioFile) : resolve(REPO, scenarioFile))
  : null;
const scenarioMtime = scenarioAbs ? mtime(scenarioAbs) : null;

// The scenario is not the only input that can invalidate an output. Editing a spec or
// an arms file is the MORE common way a directory goes inconsistent, because it does
// not touch the scenario at all: the numbers stay plausible, the file dates stay
// recent, and only the pairing of output-to-definition has silently broken. Both are
// checked, and the specific newer inputs are named rather than just flagged.
const dirEntries = readdirSync(dir);
const specFiles = dirEntries.filter(f => /^spec-.*\.json$/.test(f));
const armsFiles = dirEntries.filter(f => /^arms-.*\.json$/.test(f));
const inputFiles = [...specFiles, ...armsFiles, ...dirEntries.filter(f => f === 'regenerate.sh')]
  .map(f => ({ file: f, mtimeMs: mtime(join(dir, f)) }));

const scenarioInput = scenarioAbs
  ? { file: scenarioFile, mtimeMs: scenarioMtime, isScenario: true }
  : null;
if (scenarioInput) inputFiles.push(scenarioInput);

/**
 * Which inputs actually DEFINE this output.
 *
 * Naming every file in the directory is technically true and useless — a grid does not
 * become stale because a different grid's spec was edited, and telling the reader it
 * did trains them to ignore the banner. `out-X` is defined by `spec-X`; an
 * `mc-out-X` directory by `arms-X`; a bare `mc-out` by whichever arms file no
 * suffixed directory has claimed. Fall back to the whole class only when that
 * mapping does not resolve, and say so by being conservative rather than silent.
 */
function definingInputs(a) {
  if (a.kind === 'grid') {
    const exact = `spec-${a.label}.json`;
    if (specFiles.includes(exact)) return inputFiles.filter(i => i.file === exact || i.isScenario);
    return inputFiles.filter(i => specFiles.includes(i.file) || i.isScenario);
  }
  const suffix = a.label.replace(/^mc-out-?/, '');
  const exact = suffix ? `arms-${suffix}.json` : null;
  if (exact && armsFiles.includes(exact)) return inputFiles.filter(i => i.file === exact || i.isScenario);
  if (!suffix) {
    const claimed = mcDirs.filter(n => n !== a.label)
      .map(n => `arms-${n.replace(/^mc-out-?/, '')}.json`);
    const free = armsFiles.filter(f => !claimed.includes(f));
    if (free.length === 1) return inputFiles.filter(i => i.file === free[0] || i.isScenario);
  }
  return inputFiles.filter(i => armsFiles.includes(i.file) || i.isScenario);
}

/** Defining inputs written after this output. */
const newerInputs = (a) => definingInputs(a)
  .filter(i => i.mtimeMs != null && a.mtimeMs != null && i.mtimeMs > a.mtimeMs)
  .sort((x, y) => y.mtimeMs - x.mtimeMs);

const artefacts = [
  ...grids.map(g => ({ kind: 'grid', label: g.key, file: g.file, mtimeMs: g.mtimeMs })),
  ...mcSets.map(s => ({ kind: 'mc', label: s.name, file: `${s.name}/`, mtimeMs: s.mtimeMs })),
];
for (const a of artefacts) a.newer = newerInputs(a);
const stale = artefacts.filter(a => a.newer.length);

// Outputs written far apart from each other are the other staleness tell: the grids
// and the MC may simply be from different runs of the same scenario.
const times = artefacts.map(a => a.mtimeMs).filter(Boolean);
const spreadHours = times.length > 1 ? (Math.max(...times) - Math.min(...times)) / 36e5 : 0;

if (!grids.length && !mcSets.length) {
  console.error(`nothing to report on in ${dir} — expected out-*.json and/or mc-out*/`);
  process.exit(2);
}

// ─── headline model ──────────────────────────────────────────────────────────

/**
 * Marginal lever values across every grid, pooled and ranked.
 *
 * Each grid contributes one entry per swept axis. They are NOT summed across grids —
 * the same axis in two grids is two different measurements under two different bases,
 * and averaging them would invent a number neither grid supports.
 */
const levers = grids.flatMap(g =>
  g.model.leverValues
    .filter(l => l.spread > 0)
    .map(l => ({ ...l, grid: g.key, gridTitle: g.model.title, unit: g.model.reduceAxis })))
  .sort((a, b) => b.spread - a.spread);

const money = (n) => (n == null ? '—' : '$' + Math.round(n).toLocaleString());
const compact = (n) => {
  if (n == null) return '—';
  const a = Math.abs(n);
  if (a >= 1000) return '$' + (n / 1000).toFixed(a % 1000 === 0 ? 0 : 1) + 'k';
  return '$' + Math.round(n);
};
const pctS = (r, dp = 1) => (r == null ? '—' : `${(r * 100).toFixed(dp)}%`);
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ─── html ────────────────────────────────────────────────────────────────────

const HEAT_LIGHT = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#5598e7', '#2a78d6', '#184f95'];
const HEAT_DARK  = ['#0d366b', '#104281', '#184f95', '#1c5cab', '#2a78d6', '#3987e5', '#6da7ec'];
// Where the ramp gets dark enough (light mode) / light enough (dark mode) that the
// label has to flip. Below this index the label stays ink-coloured.
const FLIP_LIGHT = 4, FLIP_DARK = 5;

/** Bin a value onto the 7-step ramp using the grid's own min/max. */
function heatBin(value, min, max) {
  if (value == null || min == null || max == null) return null;
  if (max === min) return 3;
  const t = (value - min) / (max - min);
  return Math.max(0, Math.min(6, Math.round(t * 6)));
}

function heatTable(g) {
  const m = g.model;
  const out = [];
  for (const panel of m.panels) {
    out.push(`<figure class="panel">`);
    if (panel.label) out.push(`<figcaption class="panel-cap">${esc(panel.label)}</figcaption>`);
    out.push(`<div class="scroll"><table class="heat"><thead><tr>`);
    out.push(`<th class="corner" scope="col">${esc(m.rowAxis)}<span class="slash">\\</span>${esc(m.colAxis ?? '')}</th>`);
    for (const c of panel.cols) out.push(`<th scope="col">${esc(c)}</th>`);
    out.push(`</tr></thead><tbody>`);
    panel.rows.forEach((rowLabel, ri) => {
      out.push(`<tr><th scope="row">${esc(rowLabel)}</th>`);
      panel.cols.forEach((colLabel, ci) => {
        const cell = panel.cells[ri][ci];
        const bin = heatBin(cell.value, m.min, m.max);
        const cls = ['cellv'];
        if (bin == null) cls.push('nodata');
        if (cell.flips > 1) cls.push('flip');
        if (cell.offGridHigh) cls.push('offhi');
        if (cell.offGridLow) cls.push('offlo');
        const tip = [
          `${m.rowAxis} ${rowLabel}`,
          m.colAxis ? `${m.colAxis} ${colLabel}` : null,
          panel.label || null,
          `${m.metric}: ${cell.text}`,
          cell.flips > 1 ? `⚠ ${cell.flips} pass/fail flips — not a single boundary` : null,
          cell.offGridHigh ? '⚠ still passing at the top of the sweep' : null,
          cell.offGridLow ? '⚠ failed at the very first value' : null,
        ].filter(Boolean).join(' · ');
        out.push(`<td class="${cls.join(' ')}"${bin == null ? '' : ` data-bin="${bin}"`}`
          + ` tabindex="0" data-tip="${esc(tip)}">${esc(cell.text)}</td>`);
      });
      out.push(`</tr>`);
    });
    out.push(`</tbody></table></div></figure>`);
  }
  return out.join('');
}

/**
 * A data table built from a COLUMN SPEC.
 *
 * Alignment is declared once per column and applied to the header and every body cell
 * together. Writing the `<th>`s and `<td>`s separately is what put right-aligned
 * numbers under left-aligned headers in the first version — the two drifted because
 * nothing tied them to each other. Here a column is either numeric or it is not, and
 * both rows of the rendering read that one flag.
 *
 * The first column is rendered as a row header (`<th scope="row">`) so the table stays
 * navigable; `get` returns finished HTML, so callers escape their own text.
 *
 * @param {Array}  cols `[{ head, num?, wrap?, get(row) }]`
 * @param {Array}  rows
 */
function dataTable(cols, rows) {
  const cls = (c) => [c.num ? 'num' : '', c.wrap ? 'wrap' : ''].filter(Boolean).join(' ');
  const head = cols.map(c => `<th scope="col" class="${cls(c)}">${esc(c.head)}</th>`).join('');
  const body = rows.map(r => '<tr>' + cols.map((c, i) => (i === 0
    ? `<th scope="row" class="${cls(c)}">${c.get(r)}</th>`
    : `<td class="${cls(c)}">${c.get(r)}</td>`)).join('') + '</tr>').join('');
  return `<div class="scroll"><table class="plain"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/** Horizontal bars, one hue. Values are direct-labelled so color is never the only channel. */
function barList(items, { max, fmt = compact, tone = 'series' } = {}) {
  const hi = max ?? Math.max(...items.map(i => Math.abs(i.value ?? 0)), 1);
  return `<ul class="bars">` + items.map(i => `
    <li>
      <span class="bar-label" title="${esc(i.title ?? i.label)}">${esc(i.label)}</span>
      <span class="bar-track"><span class="bar-fill ${tone}" style="width:${(Math.abs(i.value ?? 0) / hi * 100).toFixed(1)}%"></span></span>
      <span class="bar-val">${esc(fmt(i.value))}</span>
    </li>`).join('') + `</ul>`;
}

/**
 * Paired rescues as a diverging bar about zero.
 *
 * Rescues and reverse-rescues are opposite-signed outcomes of the same change, which
 * is the diverging job exactly. Reverse-rescues get the red arm and are never hidden
 * when small — a lever with a good average and a nonzero reverse count has
 * state-dependent harm, and that is the finding, not the noise.
 */
function pairedChart(pairs) {
  const hi = Math.max(...pairs.map(p => Math.max(p.res.rescues, p.res.reverseRescues)), 1);
  return `<ul class="diverge">` + pairs.map(p => `
    <li>
      <span class="bar-label" title="${esc(p.a)} → ${esc(p.b)}">${esc(p.a)} → ${esc(p.b)}</span>
      <span class="dv-track">
        <span class="dv-neg"><span class="dv-fill rev" style="width:${(p.res.reverseRescues / hi * 100).toFixed(1)}%"></span></span>
        <span class="dv-axis"></span>
        <span class="dv-pos"><span class="dv-fill res" style="width:${(p.res.rescues / hi * 100).toFixed(1)}%"></span></span>
      </span>
      <span class="bar-val">${p.res.rescues > 0 ? '+' : ''}${p.res.rescues}<span class="vs">/</span><span class="${p.res.reverseRescues ? 'neg' : 'muted'}">${p.res.reverseRescues ? '−' : ''}${p.res.reverseRescues}</span></span>
    </li>`).join('') + `</ul>`;
}

// ─── sections ────────────────────────────────────────────────────────────────

const sections = [];

// Freshness banner — first, because it decides whether anything below is quotable.
{
  const rows = scenarioAbs
    ? [{ kind: 'scenario', file: scenarioFile, mtimeMs: scenarioMtime, newer: [], isScenario: true }]
    : [];
  // Name at most two culprits inline; the rest is a count. A banner nobody finishes
  // reading is a banner nobody reads.
  const behind = (a) => {
    const names = a.newer.map(i => i.file);
    const shown = names.slice(0, 2).map(n => `<code>${esc(n)}</code>`).join(', ');
    return names.length > 2 ? `${shown} <span class="muted">+${names.length - 2} more</span>` : shown;
  };
  rows.push(...artefacts);
  const alerts = [];
  if (stale.length) {
    alerts.push(`<div class="alert crit"><strong>${stale.length} output${stale.length > 1 ? 's were' : ' was'} written before ${stale.length > 1 ? 'their defining inputs' : 'its defining input'} last changed.</strong>
      ${stale.map(s => `<code>${esc(s.file)}</code> is behind ${behind(s)}`).join('; ')}.
      Re-run before quoting ${stale.length > 1 ? 'those sections' : 'that section'} — ${stale.length > 1 ? 'they describe' : 'it describes'} the previous definition.</div>`);
  }
  if (spreadHours > 6) {
    alerts.push(`<div class="alert warn"><strong>Outputs span ${spreadHours.toFixed(1)} hours.</strong>
      The grids and the Monte Carlo in this directory may be from different runs; sections are not necessarily comparable.</div>`);
  }
  sections.push(`<section id="provenance"><h2>Provenance</h2>${alerts.join('')}
    ${dataTable([
      { head: 'kind',         get: r => esc(r.kind) },
      { head: 'file',         get: r => `<span class="mono">${esc(r.file)}</span>` },
      { head: 'written (UTC)', get: r => `<span class="mono">${esc(when(r.mtimeMs))}</span>` },
      { head: 'state', wrap: true, get: r => (r.isScenario ? ''
        : r.newer.length
          ? `<span class="badge crit">stale</span> <span class="muted">behind</span> ${behind(r)}`
          : '<span class="badge ok">current</span>') },
    ], rows)}</section>`);
}

// Companion pages — the study's other HTML outputs, linked rather than inlined.
//
// A study directory grows self-contained pages this report cannot absorb: the
// allocation-over-time page and the Monte Carlo mix distribution (design 82) are
// chart-first and megabytes each. Inlining them would double the size of a page whose
// job is the overview. Linking them means the overview stays the entry point and the
// reader can still find them — a generated page nobody knows exists is a page nobody
// opens. Freshness is checked against the scenario only, since nothing here knows
// which spec (if any) defined them.
let hasCompanions = false;
{
  const pages = readdirSync(dir)
    .filter(f => /\.html?$/i.test(f) && resolve(dir, f) !== resolve(outFile))
    .sort()
    .map(f => ({ file: f, mtimeMs: mtime(join(dir, f)) }));
  if (pages.length) {
    hasCompanions = true;
    sections.push(`<section id="companions"><h2>Companion pages</h2>
      <p class="lede">Self-contained pages written into this directory by the same run. They are linked, not summarised —
        each answers a different question from the grids and arms below.</p>
      ${dataTable([
        { head: 'page', get: r => `<a href="${esc(r.file)}"><span class="mono">${esc(r.file)}</span></a>` },
        { head: 'written (UTC)', get: r => `<span class="mono">${esc(when(r.mtimeMs))}</span>` },
        { head: 'state', get: r => (scenarioMtime != null && r.mtimeMs != null && scenarioMtime > r.mtimeMs
          ? '<span class="badge crit">stale</span> <span class="muted">older than the scenario</span>'
          : '<span class="badge ok">current</span>') },
      ], pages)}</section>`);
  }
}

// Headline cards — one per grid, plus one per MC set.
{
  const cards = [];
  for (const g of grids) {
    const m = g.model;
    const ref = m.panels[0]?.cells[0]?.[0];
    const top = m.leverValues[0];
    cards.push(`<article class="card">
      <p class="card-kicker">${esc(g.key)}</p>
      <p class="hero">${esc(ref?.text ?? '—')}</p>
      <p class="card-sub">${esc(m.panels[0]?.rows[0] ?? '')}${m.colAxis ? ' · ' + esc(m.panels[0]?.cols[0] ?? '') : ''}${m.panels[0]?.label ? ' · ' + esc(m.panels[0].label) : ''}</p>
      <dl class="card-facts">
        <div><dt>range</dt><dd>${esc(compact(m.min))} – ${esc(compact(m.max))}</dd></div>
        ${top ? `<div><dt>biggest axis</dt><dd>${esc(top.axis)} (${esc(compact(top.spread))})</dd></div>` : ''}
        <div><dt>cells</dt><dd>${m.total}${m.errors ? ` <span class="badge crit">${m.errors} errored</span>` : ''}</dd></div>
      </dl>
      ${m.warnings.length ? `<p class="card-warn">${m.warnings.length} non-monotone cell${m.warnings.length > 1 ? 's' : ''}</p>` : ''}
    </article>`);
  }
  for (const s of mcSets) {
    const rates = s.keys.map(k => ({ k, r: failureRate(s.arms[k].rows) })).filter(x => x.r != null);
    const best = rates.length ? rates.reduce((a, b) => (a.r <= b.r ? a : b)) : null;
    const worst = rates.length ? rates.reduce((a, b) => (a.r >= b.r ? a : b)) : null;
    cards.push(`<article class="card">
      <p class="card-kicker">${esc(s.name)}</p>
      <p class="hero">${esc(best ? pctS(best.r) : '—')}</p>
      <p class="card-sub">best arm — ${esc(best?.k ?? '')}</p>
      <dl class="card-facts">
        <div><dt>worst arm</dt><dd>${esc(worst ? `${pctS(worst.r)} (${worst.k})` : '—')}</dd></div>
        <div><dt>arms × paths</dt><dd>${s.keys.length} × ${s.meta.n ?? '?'}</dd></div>
      </dl>
    </article>`);
  }
  sections.push(`<section id="headlines"><h2>Headlines</h2>
    <p class="lede">Each grid's reference cell is its first row, first column, first panel — by spec convention the base case. The range is across every cell in that grid.</p>
    <div class="cards">${cards.join('')}</div></section>`);
}

// What moves the answer — pooled marginal lever values.
if (levers.length) {
  const items = levers.slice(0, 12).map(l => ({
    label: `${l.axis} · ${l.grid}`,
    title: `${l.gridTitle ?? l.grid} — ${l.axis}: best ${l.best}, worst ${l.worst}`,
    value: l.spread,
  }));
  sections.push(`<section id="levers"><h2>What moves the answer</h2>
    <p class="lede">Median frontier spread between the best and worst level of each swept axis, in units of
      <code>${esc(levers[0].unit ?? 'the reduce axis')}</code>. Marginalised over the other axes, so a single unlucky
      slice cannot inflate an axis. <strong>This is a where-to-look index, not a finding</strong> — an axis can top it
      purely by interacting with a dated shock, which this page cannot see and the panels below can.</p>
    ${barList(items)}
    ${dataTable([
      { head: 'axis',        get: l => esc(l.axis) },
      { head: 'grid',        get: l => esc(l.grid) },
      { head: 'best level',  get: l => esc(l.best) },
      { head: 'worst level', get: l => esc(l.worst) },
      { head: 'spread', num: true, get: l => esc(compact(l.spread)) },
    ], levers)}</section>`);
}

// One section per grid.
for (const g of grids) {
  const m = g.model;
  const flags = [];
  if (m.offGridLow)  flags.push(`<div class="alert warn"><strong>Off-grid low.</strong> At least one cell failed at the very first ${esc(m.reduceAxis)} value — its true frontier is below the sweep and is not a measured number.</div>`);
  if (m.offGridHigh) flags.push(`<div class="alert warn"><strong>Off-grid high (<code>+</code>).</strong> At least one cell was still passing at the last ${esc(m.reduceAxis)} value — its frontier is beyond the sweep. Widen the axis before quoting it.</div>`);
  if (m.warnings.length) flags.push(`<div class="alert warn"><strong>Non-monotone cells.</strong> The frontier is not a single boundary — there is a passing region beyond a failing one, so "last passing" understates it.
    <ul>${m.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>`);
  if (m.errors) flags.push(`<div class="alert crit"><strong>${m.errors} of ${m.total} cells errored</strong> and render as <code>?</code>. e.g. ${esc(m.firstError)}</div>`);

  sections.push(`<section id="grid-${esc(g.key)}"><h2>${esc(m.title ?? g.key)}</h2>
    <p class="meta">${esc(g.file)} · ${m.total} cells · written ${esc(when(g.mtimeMs))}</p>
    ${m.notes ? `<p class="notes">${esc(m.notes)}</p>` : ''}
    ${flags.join('')}
    <p class="lede">Cells are the <strong>${esc(m.metric)}</strong>. Shading is scaled across
      <em>every panel in this grid</em>, so panels are directly comparable. Values are printed in
      every cell — the color is a second channel, never the only one.</p>
    ${heatTable(g)}
    <div class="legend"><span class="legend-lab">${esc(compact(m.min))}</span>
      ${HEAT_LIGHT.map((_, i) => `<span class="legend-swatch" data-bin="${i}"></span>`).join('')}
      <span class="legend-lab">${esc(compact(m.max))}</span></div>
  </section>`);
}

// Monte Carlo.
for (const s of mcSets) {
  const rm = s.meta.riskModel ?? {};
  const notes = [];
  if (!rm.paths) notes.push(`<div class="alert warn"><strong>No stochastic paths.</strong> One average return was held for the whole horizon, so there is no sequence risk and these failure rates are <em>understated</em>.</div>`);
  if (rm.shock) notes.push(`<div class="alert warn"><strong>Manufactured crash (<code>--shock</code>).</strong> Absolute rates are inflated; only the contrast between arms is meaningful.</div>`);
  if (new Set(s.keys.map(k => s.arms[k].n)).size > 1) notes.push(`<div class="alert crit"><strong>Arms have different path counts</strong> — the paired view below is only valid on shared seeds.</div>`);
  for (const k of s.keys) {
    const p = s.arms[k].provenance;
    if (p && !p.fromScenario && p.syntheticCenters?.length) {
      notes.push(`<div class="alert crit"><strong>${esc(k)} sampled around framework defaults</strong> for: ${esc(p.syntheticCenters.join(', '))} — these are not your plan's numbers.</div>`);
    }
  }

  const rateItems = s.keys.map(k => ({ label: k, value: failureRate(s.arms[k].rows) }));
  const cfgPairs = studyCfg.pairs?.[s.name] ?? studyCfg.pairs;
  const pairSpec = flag('--pairs')
    ? flag('--pairs').split(',').map(x => x.split(':').map(y => y.trim()))
    : (Array.isArray(cfgPairs) ? cfgPairs.map(x => (Array.isArray(x) ? x : x.split(':').map(y => y.trim())))
                               : s.keys.slice(1).map(k => [s.keys[0], k]));
  const pairs = pairSpec
    .filter(([a, b]) => s.arms[a] && s.arms[b])
    .map(([a, b]) => ({ a, b, res: pairedRescues(s.arms[a].rows, s.arms[b].rows) }));

  // Design 84 §6.4b — the money-metric pairing. The rescue view above classifies each
  // seed by the `failed` flag, which is the right question for ruin and an empty one
  // for "where should this money sit": arms that mostly do not fail give near-zero
  // rescue counts and say nothing. Rendered only when the rows carry `afterTaxNW`,
  // so arm files written before that field existed degrade to the old page.
  const moneyMetric = 'afterTaxNW';
  const moneyPairs = pairs
    .filter(({ a, b }) => s.arms[a].rows?.some(r => Number.isFinite(r[moneyMetric]))
                       && s.arms[b].rows?.some(r => Number.isFinite(r[moneyMetric])))
    .map(({ a, b }) => ({ a, b, m: pairedMetric(s.arms[a].rows, s.arms[b].rows, moneyMetric) }))
    .filter(({ m }) => m.n > 0);

  const shape = s.keys.filter(k => s.arms[k].pathShape?.medianNetWorthCagr != null);
  const bandKey = rm.paths ? 'netWorthCagr' : 'growth';
  const EDGES = [0, 0.04, 0.05, 0.06, 0.07, 0.08, 0.10, 0.12, 1];

  sections.push(`<section id="mc-${esc(s.name)}"><h2>Monte Carlo — ${esc(s.name)}</h2>
    <p class="meta">${s.keys.length} arms × ${s.meta.n ?? '?'} paths · written ${esc(when(s.mtimeMs))}
      · ${rm.paths ? `year-by-year returns (vol ${esc(rm.vol)}, drift ${esc(rm.drift)})` : 'average return only'}${rm.propertyPaths ? ' + property path' : ''}${rm.shock ? ' + manufactured crash' : ''}</p>
    ${notes.join('')}

    <h3>Failure rate by arm</h3>
    ${barList(rateItems, { max: Math.max(...rateItems.map(i => i.value ?? 0), 0.05), fmt: (v) => pctS(v) })}

    <h3>Terminal net worth percentiles</h3>
    <p class="lede">No mean is shown. A single lucky draw compounded over forty years dominates an average of terminal wealth and carries no economic content; the low percentiles are what survive that.</p>
    ${(() => {
      const m$ = (v) => (v == null ? '—' : '$' + (v / 1e6).toFixed(1) + 'm');
      const nwOf = (k) => s.arms[k].rows.map(r => r.nw);
      return dataTable([
        { head: 'arm',   get: k => esc(k) },
        { head: 'fail%', num: true, get: k => esc(pctS(failureRate(s.arms[k].rows))) },
        ...[5, 10, 25, 50].map(p => ({
          head: p === 50 ? 'median' : `p${p}`, num: true,
          get: k => esc(m$(percentile(nwOf(k), p))),
        })),
      ], s.keys);
    })()}

    ${pairs.length ? `<h3>Paired — what each change rescues, world by world</h3>
    <p class="lede">Arms share the seed sequence, so world <em>i</em> is the same world in both and the individual flips can be counted. <span class="key"><span class="dot res"></span>rescued</span> <span class="key"><span class="dot rev"></span>broken</span> — a nonzero broken count is state-dependent harm and matters more than its size suggests.</p>
    ${pairedChart(pairs)}
    ${pairs.some(p => p.res.reverseRescues > 0)
      ? `<div class="alert warn"><strong>Some changes break worlds they don't rescue.</strong> ${pairs.filter(p => p.res.reverseRescues > 0).map(p => `<code>${esc(p.a)}→${esc(p.b)}</code>`).join(', ')} — understand the mechanism before acting on the average.</div>`
      : `<div class="alert ok">No reverse-rescues in any pair — on this evidence every change shown weakly dominates.</div>`}` : ''}

        ${moneyPairs.length ? `<h3>Paired — after-tax net worth, world by world</h3>
    <p class="lede">The same pairing asked of <em>wealth</em> rather than survival, and for any decision about where money sits this is the decisive table. Scored on after-tax net worth: nominal net worth prices a Roth dollar at par with a pre-tax one, which mis-scores every arm that moves wealth between wrappers. <strong>The loss count is the finding</strong> — a favourable median sitting on top of a nonzero loss count is state-dependent harm, and a sign that flips is a bet, not a recommendation.</p>
    ${dataTable([
      { head: 'pair',    get: r => `<code>${esc(r.a)} → ${esc(r.b)}</code>` },
      { head: 'ahead',   num: true, get: r => esc(`${r.m.wins}/${r.m.n}`) },
      { head: 'ahead %', num: true, get: r => esc(pctS(r.m.winRate)) },
      { head: 'BEHIND',  num: true, get: r => esc(String(r.m.losses)) },
      { head: 'behind %',num: true, get: r => esc(pctS(r.m.lossRate)) },
      { head: 'p10 Δ',   num: true, get: r => esc(moneyAuto(r.m.p10)) },
      { head: 'median Δ',num: true, get: r => esc(moneyAuto(r.m.p50)) },
      { head: 'p90 Δ',   num: true, get: r => esc(moneyAuto(r.m.p90)) },
    ], moneyPairs)}
    <p class="meta">Percentiles are of the paired DIFFERENCE within a world, not of either arm's level. No mean is shown.</p>` : ''}

${shape.length ? `<h3>Sequence risk</h3>
    <p class="lede"><code>fail|lo10</code> and <code>fail|hi10</code> are failure rates among paths whose <em>first decade</em> finished below / above the cross-path median. A wide gap is sequence risk stated directly: the same long-run average is survivable or fatal depending on when the bad years land.</p>
    ${dataTable([
      { head: 'arm',       get: k => esc(k) },
      { head: 'med CAGR',  num: true, get: k => esc(pctS(s.arms[k].pathShape.medianNetWorthCagr)) },
      { head: 'worst 5y',  num: true, get: k => esc(pctS(s.arms[k].pathShape.medianWorst5yrCagr)) },
      { head: 'max DD',    num: true, get: k => esc(pctS(s.arms[k].pathShape.medianMaxDrawdown, 0)) },
      { head: 'fail|lo10', num: true, get: k => esc(pctS(s.arms[k].pathShape.failureRateBelowMedianDecade)) },
      { head: 'fail|hi10', num: true, get: k => esc(pctS(s.arms[k].pathShape.failureRateAboveMedianDecade)) },
    ], shape)}` : ''}

    <h3>Failure rate by ${bandKey === 'growth' ? 'sampled mean return' : 'realized net-worth CAGR'}</h3>
    <p class="lede">This is the readout to quote: it converts "12% of paths fail" into a <em>return threshold</em> you can hold an opinion about. Cell shows the rate, with the path count in that band.</p>
    ${dataTable([
      { head: 'band', get: b => `${esc(pctS(b.lo, 0))}–${esc(pctS(b.hi, 0))}` },
      ...s.keys.map(k => ({
        head: k, num: true,
        get: (b) => {
          const r = failureByBand(s.arms[k].rows, bandKey, [b.lo, b.hi])[0];
          return r.n ? `${esc(pctS(r.rate, 0))} <span class="muted">(${r.n})</span>` : '·';
        },
      })),
    ], EDGES.slice(0, -1).map((lo, i) => ({ lo, hi: EDGES[i + 1] })))}

    <h3>What distinguishes a failing world</h3>
    ${(() => {
      // Precomputed per arm: failureDrivers scans every row, and calling it once per
      // CELL would rescan the same 400 paths six times over.
      const drivers = s.keys.map(k => {
        const d = failureDrivers(s.arms[k].rows, ['netWorthCagr', 'worst5yrCagr']);
        return { k, d, n: s.arms[k].rows.length, f: (key) => d.fields.find(x => x.key === key) };
      });
      // An arm with no failures has nothing to contrast, so its cells are em-dashes
      // rather than a colspan — the columns stay aligned down the whole table.
      const cell = (r, v) => (r.d.nFailed ? v() : '<span class="muted">—</span>');
      // Runs written before the mc.mjs `oof` fix stored the date with its year sliced
      // off, so no year can be recovered from them. A whole column of em-dashes would
      // read as "nothing went out of funds", which is the opposite of the truth — drop
      // it and say why instead.
      const hasOof = drivers.some(r => r.d.oofYears.length);
      const anyFailures = drivers.some(r => r.d.nFailed);
      return dataTable([
        { head: 'arm', get: r => esc(r.k) },
        { head: 'failed / survived', num: true,
          get: r => (r.d.nFailed ? `${r.d.nFailed} / ${r.d.nSurvived}`
                                 : `<span class="muted">0 / ${r.n}</span>`) },
        { head: 'realized CAGR (fail)',    num: true, get: r => cell(r, () => esc(pctS(r.f('netWorthCagr')?.failed, 2))) },
        { head: 'realized CAGR (survive)', num: true, get: r => esc(pctS(r.f('netWorthCagr')?.survived, 2)) },
        { head: 'worst 5y (fail)',         num: true, get: r => cell(r, () => esc(pctS(r.f('worst5yrCagr')?.failed, 2))) },
        ...(hasOof ? [{ head: 'median OOF year', num: true,
          get: r => cell(r, () => percentile(r.d.oofYears, 50)) }] : []),
      ], drivers) + (!hasOof && anyFailures
        ? `<p class="lede"><span class="badge crit">note</span> Median out-of-funds year is omitted: this run stored
           <code>oof</code> without its year (fixed in <code>scripts/lib/mc.mjs</code>). It populates on the next Monte Carlo run.</p>`
        : '');
    })()}
  </section>`);
}

// ─── page ────────────────────────────────────────────────────────────────────

const nav = [
  { id: 'provenance', label: 'Provenance' },
  ...(hasCompanions ? [{ id: 'companions', label: 'Companion pages' }] : []),
  { id: 'headlines', label: 'Headlines' },
  ...(levers.length ? [{ id: 'levers', label: 'What moves it' }] : []),
  ...grids.map(g => ({ id: `grid-${g.key}`, label: g.key })),
  ...mcSets.map(s => ({ id: `mc-${s.name}`, label: s.name })),
];

const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(basename(dir))} — study review</title>
<style>
:root{
  color-scheme: light dark;
  --surface:#fcfcfb; --plane:#f9f9f7; --ink:#0b0b0b; --ink2:#52514e; --muted:#898781;
  --grid:#e1e0d9; --rule:#c3c2b7; --border:rgba(11,11,11,.10);
  --series:#2a78d6; --res:#2a78d6; --rev:#e34948;
  --good:#0ca30c; --warn:#fab219; --crit:#d03b3b;
  --heat-0:${HEAT_LIGHT[0]};--heat-1:${HEAT_LIGHT[1]};--heat-2:${HEAT_LIGHT[2]};--heat-3:${HEAT_LIGHT[3]};--heat-4:${HEAT_LIGHT[4]};--heat-5:${HEAT_LIGHT[5]};--heat-6:${HEAT_LIGHT[6]};
  --heat-flip:${FLIP_LIGHT};
  --on-heat-lo:#0b0b0b; --on-heat-hi:#ffffff;
}
@media (prefers-color-scheme: dark){ :root:where(:not([data-theme="light"])){
  --surface:#1a1a19; --plane:#0d0d0d; --ink:#fff; --ink2:#c3c2b7; --muted:#898781;
  --grid:#2c2c2a; --rule:#383835; --border:rgba(255,255,255,.10);
  --series:#3987e5; --res:#3987e5; --rev:#e66767;
  --heat-0:${HEAT_DARK[0]};--heat-1:${HEAT_DARK[1]};--heat-2:${HEAT_DARK[2]};--heat-3:${HEAT_DARK[3]};--heat-4:${HEAT_DARK[4]};--heat-5:${HEAT_DARK[5]};--heat-6:${HEAT_DARK[6]};
  --on-heat-lo:#ffffff; --on-heat-hi:#0b0b0b;
}}
:root[data-theme="dark"]{
  --surface:#1a1a19; --plane:#0d0d0d; --ink:#fff; --ink2:#c3c2b7; --muted:#898781;
  --grid:#2c2c2a; --rule:#383835; --border:rgba(255,255,255,.10);
  --series:#3987e5; --res:#3987e5; --rev:#e66767;
  --heat-0:${HEAT_DARK[0]};--heat-1:${HEAT_DARK[1]};--heat-2:${HEAT_DARK[2]};--heat-3:${HEAT_DARK[3]};--heat-4:${HEAT_DARK[4]};--heat-5:${HEAT_DARK[5]};--heat-6:${HEAT_DARK[6]};
  --on-heat-lo:#ffffff; --on-heat-hi:#0b0b0b;
}
*{box-sizing:border-box}
body{margin:0;background:var(--plane);color:var(--ink);
  font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;
  -webkit-font-smoothing:antialiased}
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
h3{font-size:14px;margin:26px 0 8px;font-weight:620;text-transform:uppercase;
  letter-spacing:.06em;color:var(--ink2)}
.meta{color:var(--muted);font-size:12.5px;margin:0 0 12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.lede{color:var(--ink2);font-size:13.5px;margin:0 0 14px;max-width:76ch}
.notes{color:var(--ink2);font-size:13.5px;margin:0 0 14px;max-width:82ch;
  border-left:2px solid var(--rule);padding-left:12px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;
  background:var(--plane);padding:1px 4px;border-radius:3px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.muted{color:var(--muted)}
.scroll{overflow-x:auto;max-width:100%}

/* alerts */
.alert{font-size:13.5px;padding:10px 13px;border-radius:8px;margin:0 0 12px;
  border:1px solid var(--border);border-left-width:3px}
.alert ul{margin:6px 0 0 18px;padding:0}
.alert.crit{border-left-color:var(--crit);background:color-mix(in srgb,var(--crit) 7%,transparent)}
.alert.warn{border-left-color:var(--warn);background:color-mix(in srgb,var(--warn) 9%,transparent)}
.alert.ok{border-left-color:var(--good);background:color-mix(in srgb,var(--good) 7%,transparent)}
.alert.crit::before{content:"⛔ ";}
.alert.warn::before{content:"⚠ ";}
.alert.ok::before{content:"✓ ";}
.badge{font-size:11px;padding:2px 7px;border-radius:999px;border:1px solid var(--border);
  white-space:nowrap}
.badge.ok{color:var(--good)} .badge.crit{color:var(--crit)}

/* cards */
.cards{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(215px,1fr))}
.card{border:1px solid var(--border);border-radius:10px;padding:14px 15px;background:var(--plane)}
.card-kicker{margin:0;font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;
  color:var(--muted);font-weight:600}
.hero{margin:6px 0 2px;font-size:34px;line-height:1.05;font-weight:640;letter-spacing:-.02em}
.card-sub{margin:0 0 10px;font-size:12px;color:var(--ink2)}
.card-facts{margin:0;display:grid;gap:3px}
.card-facts div{display:flex;justify-content:space-between;gap:8px;font-size:12.5px}
.card-facts dt{color:var(--muted)} .card-facts dd{margin:0;font-variant-numeric:tabular-nums}
.card-warn{margin:9px 0 0;font-size:12px;color:var(--crit)}

/* tables */
table{border-collapse:separate;border-spacing:0;font-size:13px}
table.plain{width:100%}
table.plain th,table.plain td{text-align:left;padding:6px 10px;
  border-bottom:1px solid var(--grid);white-space:nowrap}
table.plain td.wrap{white-space:normal;min-width:260px}
table.plain thead th{color:var(--muted);font-weight:600;font-size:11.5px;
  text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid var(--rule)}
table.plain tbody th{font-weight:550}
/* Alignment is per COLUMN — the header and the body cells must carry the same rule or
   the numbers sit under a header that points somewhere else. dataTable() stamps the
   class on both, so these two selectors always fire together. */
table.plain th.num,table.plain td.num{text-align:right;font-variant-numeric:tabular-nums}

/* heatmap */
.panel{margin:0 0 18px}
.panel-cap{font-size:12px;color:var(--ink2);margin:0 0 6px;font-weight:600}
table.heat{border-spacing:2px;border-collapse:separate}
/* Column headers share the DATA cell's horizontal padding and right alignment, so the
   header and the figures below it share a right edge. Centring them looked tidy in
   isolation and misaligned in every row that mattered. */
table.heat th{font-size:11.5px;color:var(--muted);font-weight:600;padding:4px 8px;
  white-space:nowrap;text-align:right}
table.heat thead th{text-align:right;padding-right:12px}
table.heat th.corner{text-align:left;color:var(--muted);padding-right:8px}
table.heat th.corner .slash{opacity:.5;padding:0 2px}
table.heat td{padding:7px 12px;text-align:right;border-radius:4px;
  font-variant-numeric:tabular-nums;background:var(--grid);color:var(--ink2);
  min-width:62px;cursor:default;position:relative}
table.heat td:focus{outline:2px solid var(--ink);outline-offset:1px}
table.heat td[data-bin="0"]{background:var(--heat-0)} table.heat td[data-bin="1"]{background:var(--heat-1)}
table.heat td[data-bin="2"]{background:var(--heat-2)} table.heat td[data-bin="3"]{background:var(--heat-3)}
table.heat td[data-bin="4"]{background:var(--heat-4)} table.heat td[data-bin="5"]{background:var(--heat-5)}
table.heat td[data-bin="6"]{background:var(--heat-6)}
table.heat td[data-bin]{color:var(--on-heat-lo)}
table.heat td[data-bin="4"],table.heat td[data-bin="5"],table.heat td[data-bin="6"]{color:var(--on-heat-hi)}
table.heat td.flip::after{content:"";position:absolute;top:3px;right:3px;width:5px;height:5px;
  border-radius:50%;background:var(--warn)}
table.heat td.nodata{background:repeating-linear-gradient(45deg,var(--grid),var(--grid) 4px,transparent 4px,transparent 8px);color:var(--muted)}
.legend{display:flex;align-items:center;gap:3px;margin-top:2px}
.legend-lab{font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}
.legend-swatch{width:26px;height:9px;border-radius:2px;margin:0 1px}
.legend-swatch[data-bin="0"]{background:var(--heat-0)} .legend-swatch[data-bin="1"]{background:var(--heat-1)}
.legend-swatch[data-bin="2"]{background:var(--heat-2)} .legend-swatch[data-bin="3"]{background:var(--heat-3)}
.legend-swatch[data-bin="4"]{background:var(--heat-4)} .legend-swatch[data-bin="5"]{background:var(--heat-5)}
.legend-swatch[data-bin="6"]{background:var(--heat-6)}

/* bars */
ul.bars,ul.diverge{list-style:none;margin:0 0 6px;padding:0;display:grid;gap:5px}
ul.bars li,ul.diverge li{display:grid;grid-template-columns:minmax(120px,230px) 1fr 84px;
  align-items:center;gap:12px}
.bar-label{font-size:12.5px;color:var(--ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-track{background:var(--grid);border-radius:3px;height:12px;overflow:hidden}
.bar-fill{display:block;height:100%;border-radius:3px;background:var(--series);min-width:2px}
.bar-val{font-size:12.5px;text-align:right;font-variant-numeric:tabular-nums;color:var(--ink)}
.dv-track{display:grid;grid-template-columns:1fr 1px 1fr;align-items:center;height:12px}
.dv-neg{display:flex;justify-content:flex-end;height:100%;background:var(--grid);border-radius:3px 0 0 3px}
.dv-pos{display:flex;height:100%;background:var(--grid);border-radius:0 3px 3px 0}
.dv-axis{height:16px;background:var(--rule)}
.dv-fill{display:block;height:100%}
.dv-fill.res{background:var(--res);border-radius:0 3px 3px 0}
.dv-fill.rev{background:var(--rev);border-radius:3px 0 0 3px}
.bar-val .vs{color:var(--muted);padding:0 2px}
.bar-val .neg{color:var(--rev)}
.key{font-size:12px;color:var(--ink2);margin-right:10px;white-space:nowrap}
.key .dot{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px;vertical-align:baseline}
.key .dot.res{background:var(--res)} .key .dot.rev{background:var(--rev)}

/* tooltip */
#tip{position:fixed;z-index:50;pointer-events:none;opacity:0;transition:opacity .08s;
  background:var(--ink);color:var(--surface);font-size:12px;line-height:1.4;
  padding:6px 9px;border-radius:6px;max-width:320px}
#tip.on{opacity:1}
@media print{nav.toc{display:none}section{break-inside:avoid;border:none;padding:0}}
</style>
</head><body>
<div id="tip" role="tooltip"></div>
<div class="wrap">
<header class="top">
  <h1>${esc(basename(dir))} — study review</h1>
  <p class="sub">${grids.length} grid${grids.length === 1 ? '' : 's'}, ${mcSets.length} Monte Carlo set${mcSets.length === 1 ? '' : 's'}
    ${scenarioPath ? `· scenario <code>${esc(scenarioPath)}</code>` : ''}
    · rendered ${esc(when(Date.now()))} UTC</p>
</header>
<nav class="toc">${nav.map(n => `<a href="#${esc(n.id)}">${esc(n.label)}</a>`).join('')}</nav>
${sections.join('\n')}
</div>
<script>
// Hover/focus tooltip for heat cells. The value is already printed in the cell, so
// this only adds the axis context — it never gates a number behind a hover.
(function(){
  var tip=document.getElementById('tip');
  function show(e,t){tip.textContent=t;tip.classList.add('on');move(e);}
  function move(e){
    var r=tip.getBoundingClientRect();
    var x=(e.clientX!=null?e.clientX:0)+14, y=(e.clientY!=null?e.clientY:0)+14;
    if(x+r.width>innerWidth-8)x=innerWidth-r.width-8;
    if(y+r.height>innerHeight-8)y=(e.clientY||0)-r.height-12;
    tip.style.left=x+'px';tip.style.top=y+'px';
  }
  function hide(){tip.classList.remove('on');}
  document.addEventListener('mouseover',function(e){
    var el=e.target.closest('[data-tip]'); if(el)show(e,el.dataset.tip);
  });
  document.addEventListener('mousemove',function(e){
    if(tip.classList.contains('on'))move(e);
  });
  document.addEventListener('mouseout',function(e){
    if(e.target.closest('[data-tip]'))hide();
  });
  document.addEventListener('focusin',function(e){
    var el=e.target.closest('[data-tip]');
    if(el){var r=el.getBoundingClientRect();show({clientX:r.left,clientY:r.bottom},el.dataset.tip);}
  });
  document.addEventListener('focusout',hide);
  document.addEventListener('keydown',function(e){if(e.key==='Escape')hide();});
})();
</script>
</body></html>`;

writeFileSync(outFile, html);
console.log(`study report → ${outFile}`);
console.log(`  ${grids.length} grids, ${mcSets.length} monte carlo set(s)`);
if (stale.length) console.log(`  ** ${stale.length} output(s) OLDER than the scenario — flagged in the report`);
if (argv.includes('--open')) {
  try { execFileSync('open', [outFile]); } catch { /* not macOS, or no opener — the path is printed above */ }
}
