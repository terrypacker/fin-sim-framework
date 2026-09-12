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
  const byTop = {};
  for (const k of added) { const t = k.split('.')[0]; byTop[t] = (byTop[t] ?? 0) + 1; }
  const tops = Object.entries(byTop).map(([t, n]) => `${t}(${n})`).join(' ') || '—';
  console.log(`${file}: +${added.length} [${tops}]  changed ${changed.length}  removed ${removed.length}`);
  for (const k of [...changed.slice(0, 5)]) console.log(`    changed  ${k}: ${JSON.stringify(a[k])} → ${JSON.stringify(b[k])}`);
  for (const k of [...removed.slice(0, 5)]) console.log(`    removed  ${k}`);
  if (changed.length || removed.length) bad++;
}
console.log(bad ? `\n${bad} fixture(s) moved or lost an existing field: NOT additive-only.` : '\nAdditive-only: every fixture only gained keys.');
process.exit(bad ? 1 : 0);
