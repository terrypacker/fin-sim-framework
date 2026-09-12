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
 * probe-regold-additive.mjs — is a regold ONLY added keys? (design 101 §6.3)
 *
 * A change that is meant to add state and move nothing — the market index, design 101
 * M1 — must re-gold as pure additions. Any existing field that moves or disappears means
 * the change perturbed the run (for a new event: re-resolved same-date ties, see the
 * event-queue memory), and that has to be traced, not regolded past.
 *
 * Compares each working-tree golden fixture with the committed one (`git show HEAD:…`),
 * flattened to dotted leaves, and reports per fixture: added keys (grouped by top-level
 * key), and any changed or removed leaf. Exit code 1 when anything but an addition is found.
 *
 * Usage (after `REGOLD=1 node --test tests/unit/golden-scenarios.test.mjs`):
 *     node scripts/probes/probe-regold-additive.mjs
 *
 * Removals-only mode (design 101 M2/M3): a change meant only to STOP writing some
 * fields must regold as removals of exactly those fields. Any added or changed leaf, or
 * a removal the flag does not name, fails.
 *     node scripts/probes/probe-regold-additive.mjs --removals=balance-copies
 *         allowed: `metrics.<k>` where the committed fixture has `<k>.balance` (M2)
 *     node scripts/probes/probe-regold-additive.mjs --removals='^metrics\.(roth_earnings|dividends)$'
 *         allowed: removals matching the regex (M3)
 */

import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync }              from 'node:child_process';
import { join }                      from 'node:path';

const DIR = 'tests/fixtures';

function flatten(v, p = '', out = {}) {
  if (v !== null && typeof v === 'object') {
    const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x]) : Object.entries(v);
    if (entries.length === 0) out[p] = Array.isArray(v) ? '[]' : '{}';
    for (const [k, x] of entries) flatten(x, p ? `${p}.${k}` : k, out);
  } else out[p] = v;
  return out;
}

const removalsArg = process.argv.find(x => x.startsWith('--removals='))?.slice('--removals='.length) ?? null;
/** (key, committed flat map) → whether this removal is one the change was meant to make. */
const expectedRemoval = removalsArg == null ? null
  : removalsArg === 'balance-copies'
    ? (k, a) => { const m = /^metrics\.([^.]+)$/.exec(k); return !!m && `${m[1]}.balance` in a; }
    : ((re) => (k) => re.test(k))(new RegExp(removalsArg));

let bad = 0;
for (const file of readdirSync(DIR).filter(f => /^golden-.*\.json$/.test(f)).sort()) {
  const path = join(DIR, file);
  let committed;
  try { committed = JSON.parse(execFileSync('git', ['show', `HEAD:${path}`], { encoding: 'utf8', maxBuffer: 64 << 20 })); }
  catch { console.log(`${file}: not committed yet — skipped`); continue; }
  const a = flatten(committed);
  const b = flatten(JSON.parse(readFileSync(path, 'utf8')));
  const added = Object.keys(b).filter(k => !(k in a));
  const removed = Object.keys(a).filter(k => !(k in b));
  const changed = Object.keys(a).filter(k => k in b && !Object.is(a[k], b[k]));
  if (expectedRemoval) {
    const stray = removed.filter(k => !expectedRemoval(k, a));
    console.log(`${file}: removed ${removed.length} (${removed.length - stray.length} expected)  added ${added.length}  changed ${changed.length}`);
    for (const k of added.slice(0, 5))   console.log(`    added    ${k}`);
    for (const k of changed.slice(0, 5)) console.log(`    changed  ${k}: ${JSON.stringify(a[k])} → ${JSON.stringify(b[k])}`);
    for (const k of stray.slice(0, 5))   console.log(`    removed  ${k}  (not an expected removal)`);
    if (added.length || changed.length || stray.length) bad++;
    continue;
  }
  const byTop = {};
  for (const k of added) { const t = k.split('.')[0]; byTop[t] = (byTop[t] ?? 0) + 1; }
  const tops = Object.entries(byTop).map(([t, n]) => `${t}(${n})`).join(' ') || '—';
  console.log(`${file}: +${added.length} [${tops}]  changed ${changed.length}  removed ${removed.length}`);
  for (const k of [...changed.slice(0, 5)]) console.log(`    changed  ${k}: ${JSON.stringify(a[k])} → ${JSON.stringify(b[k])}`);
  for (const k of [...removed.slice(0, 5)]) console.log(`    removed  ${k}`);
  if (changed.length || removed.length) bad++;
}
if (expectedRemoval) {
  console.log(bad ? `\n${bad} fixture(s) gained, moved or lost something unexpected: NOT removals-only.`
                  : '\nRemovals-only: every fixture lost only the expected fields.');
} else {
  console.log(bad ? `\n${bad} fixture(s) moved or lost an existing field: NOT additive-only.` : '\nAdditive-only: every fixture only gained keys.');
}
process.exit(bad ? 1 : 0);
