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
 * glidepath-corners.mjs — audit a baked glidepath for anchors that zero an asset
 * class, and price each one against a counterfactual (design 61 §12.1 D5).
 *
 * Two shapes get flagged, and the point of this script is that they are NOT the
 * same finding:
 *
 *   ROUND TRIP  a class goes material → exactly 0 → material again. D5 filed these
 *               as the defect ("realizes CGT on a whole class and buys it straight
 *               back"). On the reference plan they do NOT price as friction —
 *               smoothing them LOSES money, and by no more than a matched edit to
 *               an ordinary non-corner rung does. Hence the CONTROL arms below:
 *               without them, any corner delta reads as a corner cost when it is
 *               really the ordinary sensitivity of a 40-year allocation path.
 *
 *   TERMINAL    the LAST anchor zeroes a class the plan was still holding.
 *               `interpolateGlidepath` clamps above its last anchor, so a mix the
 *               controller committed for ONE epoch becomes policy for every
 *               remaining year — the mirror of the harvest's leading-anchor rule
 *               (design 39 §13.6.4 rule 4), which has no trailing counterpart.
 *               This is the one that costs.
 *
 * ─── read the CONTROL rows before believing any corner row ───────────────────
 * Every arm here is an allocation edit, and allocation edits move terminal wealth
 * by millions on their own. A corner arm is only evidence if its delta stands
 * outside the band the control arms trace out. Run with `--seeds` too: the saved
 * scenario is usually deterministic (`equityReturnStochastic: false`), and on a
 * mean path more equity mechanically wins, which flatters every arm that adds it.
 *
 * Usage:
 *   node scripts/lab/glidepath-corners.mjs                       # audit only
 *   node scripts/lab/glidepath-corners.mjs --run                 # + counterfactual
 *   node scripts/lab/glidepath-corners.mjs --run --seeds 12      # + stochastic
 *
 *   --scenario <file>  Workbench export (default scenarios/fin-sim-scenarios.json).
 *   --name <name>      Scenario inside that file (default: first with a glidepath).
 *   --run              Price each corner against a smoothed counterfactual.
 *   --seeds <n>        Re-price over n stochastic seeds (implies --run).
 *   --material <f>     Share at or above which a class counts as a position (0.05).
 */

import { loadScenario, withParams } from '../lib/scenario-probe.mjs';
import { run } from '../lib/run.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const has  = n => argv.includes(`--${n}`);

const FILE     = flag('scenario', 'scenarios/fin-sim-scenarios.json');
const SEEDS    = Number(flag('seeds', 0));
const MATERIAL = Number(flag('material', 0.05));
const DO_RUN   = has('run') || SEEDS > 0;

const CLASSES = ['EQUITY', 'BOND', 'CASH', 'GOLD'];
const clone   = o => JSON.parse(JSON.stringify(o));
const pct     = v => `${Math.round(v * 100)}%`;

// ── load ────────────────────────────────────────────────────────────────────
const cfg = loadScenario(FILE, flag('name', null));
const gp  = (cfg.params ?? []).find(p => (p.key ?? p.name) === 'allocationGlidepath');
if (!gp?.value?.length) {
  console.error(`no allocationGlidepath in ${cfg.name ?? FILE} — nothing to audit.`);
  process.exit(1);
}
const anchors = gp.value;

// ── structure ───────────────────────────────────────────────────────────────
/** Runs of consecutive anchors carrying an identical mix — the step-faithful pairs. */
function groups(list) {
  const g = [];
  for (let i = 0; i < list.length; i++) {
    const w = list[i].weights, last = g.at(-1);
    if (last && CLASSES.every(c => Math.abs((last.weights[c] ?? 0) - (w[c] ?? 0)) < 1e-9)) last.idx.push(i);
    else g.push({ weights: w, idx: [i] });
  }
  return g;
}

/**
 * Per class, maximal runs of groups where the class is exactly 0. Keyed on the
 * CLASS, not on group equality: a zero run may span several groups because the
 * other classes keep moving inside it (the reference plan's BOND/CASH exit at 79
 * spans two, which is why a group-equality detector misses it).
 */
function zeroRuns(list) {
  const g = groups(list);
  const out = [];
  for (const c of CLASSES) {
    let k = 0;
    while (k < g.length) {
      if ((g[k].weights[c] ?? 0) !== 0) { k++; continue; }
      let end = k;
      while (end + 1 < g.length && (g[end + 1].weights[c] ?? 0) === 0) end++;
      const before = k > 0 ? (g[k - 1].weights[c] ?? 0) : null;
      const after  = end + 1 < g.length ? (g[end + 1].weights[c] ?? 0) : null;
      const ages   = [list[g[k].idx[0]].age, list[g[end].idx.at(-1)].age];
      if (before != null && before >= MATERIAL) {
        if (after != null && after >= MATERIAL) out.push({ kind: 'ROUND TRIP', cls: c, from: k, to: end, before, after, ages });
        else if (end === g.length - 1)          out.push({ kind: 'TERMINAL',   cls: c, from: k, to: end, before, after, ages });
      }
      k = end + 1;
    }
  }
  return { g, out };
}

const { g, out } = zeroRuns(anchors);
console.log(`\n${cfg.name ?? FILE} — ${anchors.length} anchors, ${g.length} distinct mixes\n`);
for (const x of g) {
  console.log(`  ${String(anchors[x.idx[0]].age).padStart(6)}–${String(anchors[x.idx.at(-1)].age).padEnd(6)}  `
    + CLASSES.map(c => `${c[0]}${String(Math.round((x.weights[c] ?? 0) * 100)).padStart(3)}`).join(' '));
}
console.log();
if (!out.length) console.log('  no zeroed material classes.\n');
for (const x of out) {
  console.log(`  ${x.kind.padEnd(11)} ${x.cls.padEnd(6)} ages ${String(x.ages[0]).padStart(5)}–${String(x.ages[1]).padEnd(6)} `
    + `${pct(x.before)} → 0` + (x.after != null ? ` → ${pct(x.after)}` : ' → (end of schedule; CLAMPED forever)'));
}
if (!DO_RUN) { console.log('\n  (--run to price these against a counterfactual)\n'); process.exit(0); }

// ── counterfactuals ─────────────────────────────────────────────────────────
/** Replace anchors in [lo,hi] with the mix carried immediately before lo. */
function holdThrough(list, lo, hi) {
  const next = clone(list);
  const before = [...list].filter(a => a.age < lo).at(-1);
  if (!before) return next;
  for (const a of next) if (a.age >= lo && a.age <= hi) a.weights = { ...before.weights };
  return next;
}

/** Force class `c` to share `w` across [lo,hi], renormalizing the rest — the CONTROL. */
function setShare(list, lo, hi, c, w) {
  const next = clone(list);
  for (const a of next) {
    if (a.age < lo || a.age > hi) continue;
    const rest = CLASSES.filter(x => x !== c);
    const sum  = rest.reduce((s, x) => s + (a.weights[x] ?? 0), 0);
    const o = { [c]: w };
    for (const x of rest) o[x] = sum > 0 ? (a.weights[x] ?? 0) * (1 - w) / sum : (1 - w) / rest.length;
    a.weights = o;
  }
  return next;
}

const arms = [['baseline', anchors]];
for (const x of out) {
  arms.push([`${x.kind === 'TERMINAL' ? 'TERM' : 'trip'} ${x.cls}@${x.ages[0]}`,
    holdThrough(anchors, x.ages[0], x.kind === 'TERMINAL' ? Infinity : x.ages[1])]);
}
// CONTROLS: the widest non-corner group, pushed both ways by a comparable amount.
const plain = g.filter(x => CLASSES.every(c => (x.weights[c] ?? 0) > 0 || (x.weights[c] ?? 0) === 0)
                         && !out.some(o2 => o2.from <= g.indexOf(x) && g.indexOf(x) <= o2.to))
  .sort((a, b) => (b.idx.length - a.idx.length))[0];
if (plain) {
  const lo = anchors[plain.idx[0]].age, hi = anchors[plain.idx.at(-1)].age;
  const e  = plain.weights.EQUITY ?? 0;
  arms.push([`CONTROL E→0 @${lo}`,  setShare(anchors, lo, hi, 'EQUITY', 0)]);
  arms.push([`CONTROL E→${Math.round(Math.min(1, e + 0.4) * 100)} @${lo}`, setShare(anchors, lo, hi, 'EQUITY', Math.min(1, e + 0.4))]);
}

const med = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN; };
const seedList = SEEDS > 0 ? Array.from({ length: SEEDS }, (_, i) => i + 1) : [null];

const rows = new Map(arms.map(([l]) => [l, []]));
for (const seed of seedList) {
  for (const [label, val] of arms) {
    rows.get(label).push(run(withParams(cfg, {
      allocationGlidepath: val,
      ...(seed == null ? {} : { equityReturnStochastic: true, randomSeed: seed }),
    })));
  }
}

console.log(`\n${seedList.length} ${SEEDS > 0 ? 'stochastic seeds' : 'run (deterministic — read the caveat above)'}\n`);
console.log('  ' + 'arm'.padEnd(24) + 'med afterTaxNW'.padStart(15) + 'Δ vs base'.padStart(12) + 'wins'.padStart(9) + 'med tax'.padStart(10));
const base = rows.get('baseline');
for (const [label, rs] of rows) {
  const d = rs.map((r, i) => (r.afterTaxNW ?? 0) - (base[i].afterTaxNW ?? 0));
  console.log('  ' + label.padEnd(24)
    + `${(med(rs.map(r => r.afterTaxNW ?? 0)) / 1e6).toFixed(2)}M`.padStart(15)
    + `${(med(d) / 1e6).toFixed(2)}M`.padStart(12)
    + `${d.filter(v => v > 0).length}/${rs.length}`.padStart(9)
    + `${(med(rs.map(r => r.taxPaid)) / 1e6).toFixed(2)}M`.padStart(10)
    + (rs.some(r => r.failed) ? `   ${rs.filter(r => r.failed).length} FAILED` : ''));
}
console.log('\n  A corner arm is evidence only if its Δ sits OUTSIDE the CONTROL band.\n');
