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
 * run-mc.mjs — design 97 §20.7/§20.8, the study.
 *
 * Four arms (§20.7) crossed with two return processes (§20.1), on COMMON RANDOM NUMBERS: the
 * same seed means the same market in every arm, so a pairwise difference is the policy's own
 * effect and everything else cancels. That is checked, not assumed — `ratesKey` carries the
 * realized annual equity path and the arms must agree on it exactly.
 *
 * ─── the scoring rule, which is the part §19 got wrong three times ───────────────────
 *
 * Read C − B, PER PATH. Never a difference of two medians: the medians of two distributions
 * are attained on different paths, so their difference is not the effect of anything. And
 * never gross disposal volume, which §19.2c disposed of as a validation metric.
 *
 * `B` is not a formality. §20.5's equivalence says the ungated refill reproduces the control,
 * and B − A is the standing carrying cost of routing spending through the facility at all —
 * a real cost, paid in every year, crash or no crash. C's benefit has to clear it.
 *
 * ─── what a positive answer under WHITE_NOISE would MEAN ─────────────────────────────
 *
 * Not that the strategy works. Under IID returns a down year says nothing about the next, so
 * there is nothing to wait for and the policy is just leverage: borrow at the loan rate, stay
 * invested. That should show as a positive MEDIAN with a fatter LEFT TAIL — which is why the
 * report prints p10 and the rescued/broken counts next to the median and not underneath it.
 *
 * Usage:
 *   node scripts/lab/sequence-risk/run-mc.mjs [--n 300] [--vol 0.18] [--workers 8]
 *                                             [--shock MARKET_CRASH_2008_LITE --crash 2032]
 *                                             [--out results.json]
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runJobsParallel, parseWorkers } from '../../lib/parallel.mjs';
import { arms, PROCESSES } from './arms.mjs';
import { DEFAULTS } from './scenario.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const N       = Number(flag('n', 300));
const VOL     = Number(flag('vol', 0.18));
const SHOCK   = flag('shock', null);
const CRASH   = Number(flag('crash', 2032));
const OUT     = flag('out', null);
const WORKERS = parseWorkers(argv, 8);

const HERE   = dirname(fileURLToPath(import.meta.url));
const ARMS   = arms();

const jobs = [];
for (const p of PROCESSES) {
  for (const a of ARMS) {
    for (let seed = 1; seed <= N; seed++) {
      jobs.push({ id: `${p.key}:${a.key}:${seed}`, armKey: a.key, processKey: p.key,
                  seed, vol: VOL, shock: SHOCK, crashYear: CRASH });
    }
  }
}

const rows = await runJobsParallel({
  jobs, source: {}, worker: join(HERE, 'mc-worker.mjs'),
  workers: WORKERS, label: 'runs',
});

if (OUT) writeFileSync(OUT, JSON.stringify(rows, null, 1));

// ── index, and the pairing integrity check ───────────────────────────────────────────
const byKey = new Map(rows.map(r => [`${r.processKey}:${r.armKey}:${r.seed}`, r]));
let mismatched = 0;
for (const p of PROCESSES) {
  for (let seed = 1; seed <= N; seed++) {
    const ref = byKey.get(`${p.key}:${ARMS[0].key}:${seed}`);
    for (const a of ARMS.slice(1)) {
      const r = byKey.get(`${p.key}:${a.key}:${seed}`);
      if (!ref || !r || r.ratesKey !== ref.ratesKey) mismatched += 1;
    }
  }
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
};
const usd = (v) => v == null ? '—' : `${v < 0 ? '-' : ''}$${Math.abs(Math.round(v)).toLocaleString()}`;

console.log(`\nSEQUENCE RISK — ${N} paired paths per arm, equity vol ${(VOL * 100).toFixed(0)}%`);
console.log(`facility ${usd(DEFAULTS.facility)} @ ${(DEFAULTS.loanRate * 100).toFixed(1)}% interest-only · `
  + `equity ${usd(DEFAULTS.equity)} · spend ${usd(DEFAULTS.monthlySpend)}/mo · `
  + `crash ${SHOCK ? `${SHOCK} @ ${CRASH}` : 'none (the draw is the only risk)'}`);
console.log(`pairing: ${mismatched === 0 ? 'OK — every arm saw the same market on the same seed'
  : `BROKEN — ${mismatched} arm/seed pairs saw a DIFFERENT equity path; nothing below is paired`}`);

for (const p of PROCESSES) {
  console.log(`\n── ${p.key}  (${p.label})`);
  console.log('   arm   median after-tax        p10          failures    median interest');
  for (const a of ARMS) {
    const rs = ARMS.map(x => x).length && rows.filter(r => r.processKey === p.key && r.armKey === a.key);
    console.log(`   ${a.key}    ${usd(median(rs.map(r => r.afterTaxNW))).padStart(14)}`
      + `  ${usd(quantile(rs.map(r => r.afterTaxNW), 0.10)).padStart(14)}`
      + `      ${String(rs.filter(r => r.failed).length).padStart(3)}/${rs.length}`
      + `      ${usd(median(rs.map(r => r.interest))).padStart(10)}`);
  }

  // The paired readings. Each is (treatment − control) within one seed.
  const pair = (t, c) => {
    const d = [];
    let rescued = 0, broken = 0;
    for (let seed = 1; seed <= N; seed++) {
      const a = byKey.get(`${p.key}:${t}:${seed}`);
      const b = byKey.get(`${p.key}:${c}:${seed}`);
      if (!a || !b) continue;
      d.push(a.afterTaxNW - b.afterTaxNW);
      if (b.failed && !a.failed) rescued += 1;
      if (a.failed && !b.failed) broken += 1;
    }
    return { d, rescued, broken };
  };
  console.log('\n   paired, per path            median         p10          p90     wins   rescued  broken');
  // C−A is the HOUSEHOLD's question — adopt the policy, or don't — and it is the sum of the
  // two effects the other rows separate: the carry of routing spending through the facility
  // at all, and the gate's own conditional deferral. Reported together because a decision
  // taken on C−A alone cannot tell which of the two it is buying.
  for (const [t, c, label] of [['B', 'A', 'B−A  the standing carry'],
                               ['C', 'B', 'C−B  the conditional gate'],
                               ['C', 'A', 'C−A  the whole policy'],
                               ['D', 'B', 'D−B  the pure deferral']]) {
    const { d, rescued, broken } = pair(t, c);
    const wins = d.filter(x => x > 0).length;
    console.log(`   ${label.padEnd(24)} ${usd(median(d)).padStart(11)} ${usd(quantile(d, 0.1)).padStart(11)}`
      + ` ${usd(quantile(d, 0.9)).padStart(12)}  ${String(wins).padStart(3)}/${d.length}`
      + `      ${String(rescued).padStart(3)}     ${String(broken).padStart(3)}`);
  }
}
console.log();
