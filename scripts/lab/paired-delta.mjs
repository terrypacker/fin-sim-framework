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
 * paired-delta.mjs — re-report a `variant-grid` run as PAIRED DIFFERENCES.
 *
 * Some decisions are small effects living inside large ones. Design 84 P5 is the
 * worked example: sliding the residency year moves terminal wealth by tens of
 * percent, deleting a dated crash roughly doubles it, and the decision under test —
 * whether to empty a Roth before moving — is worth about four. Tabling the LEVELS of
 * such a grid produces a table where the thing you are studying is invisible, and
 * where a confound that moves every cell looks like a result.
 *
 * Pairing fixes that. Nominate one axis as the DECISION (it must have exactly two
 * values: the control and the treatment). Every other axis defines a world. The cell
 * reported is `treatment − control` within the same world, so anything that shifts
 * both halves equally cancels and what survives is the decision's own effect.
 *
 * Two things this makes visible that a level table cannot:
 *
 *   · **A confound that is genuinely neutral.** If the delta barely moves across a
 *     control axis while the levels move hugely, that axis is not driving the
 *     decision — the strongest thing a study can say about a suspected confound.
 *   · **A sign that flips.** A decision that wins in one world and loses in another
 *     is not a recommendation, it is a bet on which world you are in. That is easy
 *     to miss when both worlds' levels differ by more than the effect.
 *
 * A control cell that is not constant where it must be is also the cheapest bug
 * detector available: two arms differing in nothing must produce identical numbers,
 * and when they do not the lever is leaking. That is how design 84's `rothDecant`
 * was caught stamping a destination onto years it did not own.
 *
 * Usage:
 *   node scripts/lab/paired-delta.mjs --spec <spec.json> --results <results.json> \
 *        --pair <axisName> [--metric afterTaxNW]
 *
 * `--results` is what `variant-grid --out` wrote. Re-reporting is deliberately a
 * separate step from running: an 80-cell grid costs a minute, a report costs
 * milliseconds, and the report is the part you rewrite ten times.
 */

import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

if (argv.includes('--help') || argv.includes('-h') || !flag('spec') || !flag('results')) {
  console.log('usage: paired-delta.mjs --spec <spec.json> --results <results.json> '
    + '--pair <axisName> [--metric afterTaxNW]');
  process.exit(argv.includes('--help') || argv.includes('-h') ? 0 : 1);
}

const spec    = JSON.parse(readFileSync(flag('spec'), 'utf8'));
const rawRes  = JSON.parse(readFileSync(flag('results'), 'utf8'));
const results = Array.isArray(rawRes) ? rawRes : (rawRes.results ?? rawRes.rows ?? []);
const metric  = flag('metric', 'afterTaxNW');
const pairAxis = flag('pair');

const axisNames = Object.keys(spec.axes ?? {});
if (!axisNames.includes(pairAxis)) {
  console.error(`paired-delta: --pair "${pairAxis}" is not an axis (have: ${axisNames.join(', ')})`);
  process.exit(1);
}
const pairValues = spec.axes[pairAxis].values ?? [];
if (pairValues.length !== 2) {
  // Three arms have no single difference: which pair would the cell be?
  console.error(`paired-delta: --pair "${pairAxis}" has ${pairValues.length} values; `
    + 'pairing needs exactly 2 (control first, treatment second).');
  process.exit(1);
}

const labelsOf = (name) => spec.axes[name].labels
  ?? (spec.axes[name].values ?? []).map(v => JSON.stringify(v));

/** "a=0|b=1|…" → { a: 0, b: 1, … } — the id `variant-grid` stamps on each result. */
const parseId = (id) => Object.fromEntries(
  String(id).split('|').map(p => { const [k, v] = p.split('='); return [k, Number(v)]; }));

const byKey = new Map();
for (const r of results) {
  const idx = parseId(r.id);
  byKey.set(axisNames.map(a => `${a}=${idx[a]}`).join('|'), r);
}

const others = axisNames.filter(a => a !== pairAxis);
// Rows: the first non-pair axis. Cols: the second. Anything further becomes a panel,
// so an N-axis grid still renders as a stack of 2-D tables.
const rowAxis  = others[0] ?? null;
const colAxis  = others[1] ?? null;
const panelAxes = others.slice(2);

const money = (n) => (n == null ? '—'
  : (n < 0 ? '-' : '+') + '$' + Math.abs(Math.round(n)).toLocaleString());

const cellFor = (fixed) => {
  const at = (pairIdx) => byKey.get(
    axisNames.map(a => `${a}=${a === pairAxis ? pairIdx : fixed[a]}`).join('|'));
  const control = at(0), treatment = at(1);
  if (!control || !treatment || control.error || treatment.error) return { text: '?' };
  if (control.failed || treatment.failed) return { text: 'FAIL' };
  const c = control[metric], t = treatment[metric];
  if (!Number.isFinite(c) || !Number.isFinite(t)) {
    return { text: '?', warn: `metric "${metric}" missing — is it in summarize()?` };
  }
  return { text: money(t - c), pct: c === 0 ? null : (t - c) / c * 100 };
};

const panelCombos = panelAxes.reduce(
  (acc, a) => acc.flatMap(base => labelsOf(a).map((_, i) => ({ ...base, [a]: i }))), [{}]);

const [ctrlLabel, treatLabel] = labelsOf(pairAxis);
console.log(`\n${spec.title ?? 'paired delta'}`);
console.log(`Δ ${metric}  =  "${treatLabel}" − "${ctrlLabel}"  (paired within every other axis)`);

const warns = new Set();
for (const panel of panelCombos) {
  if (panelAxes.length) {
    console.log(`\n── ${panelAxes.map(a => `${a}: ${labelsOf(a)[panel[a]]}`).join('  ·  ')} ──`);
  }
  const rowLabels = rowAxis ? labelsOf(rowAxis) : ['(all)'];
  const colLabels = colAxis ? labelsOf(colAxis) : ['(all)'];
  const w = Math.max(16, ...colLabels.map(c => c.length + 2));
  const lw = Math.max(...rowLabels.map(r => r.length)) + 2;

  console.log('\n' + ''.padEnd(lw) + colLabels.map(c => c.padStart(w)).join(''));
  console.log('─'.repeat(lw + w * colLabels.length));
  for (let ri = 0; ri < rowLabels.length; ri++) {
    const cells = colLabels.map((_, ci) => {
      const fixed = { ...panel };
      if (rowAxis) fixed[rowAxis] = ri;
      if (colAxis) fixed[colAxis] = ci;
      const c = cellFor(fixed);
      if (c.warn) warns.add(c.warn);
      return c.text.padStart(w);
    });
    console.log(rowLabels[ri].padEnd(lw) + cells.join(''));
  }
  // Percentages against a base that itself moves between cells — the absolute
  // delta alone hides whether an effect is growing or the base is shrinking.
  console.log('\n' + ''.padEnd(lw) + colLabels.map(c => (c + ' %').padStart(w)).join(''));
  for (let ri = 0; ri < rowLabels.length; ri++) {
    const cells = colLabels.map((_, ci) => {
      const fixed = { ...panel };
      if (rowAxis) fixed[rowAxis] = ri;
      if (colAxis) fixed[colAxis] = ci;
      const c = cellFor(fixed);
      return (c.pct == null ? '—' : `${c.pct >= 0 ? '+' : ''}${c.pct.toFixed(2)}%`).padStart(w);
    });
    console.log(rowLabels[ri].padEnd(lw) + cells.join(''));
  }
}

for (const w of warns) console.log(`\n!! ${w}`);
console.log('\nSign changes across a control axis mean the decision is a BET on that axis,');
console.log('not a recommendation. A delta that barely moves while the levels move a lot');
console.log('means that axis is genuinely not driving the decision.');
