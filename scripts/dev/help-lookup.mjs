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
 * help-lookup.mjs — search the help index from the command line (design 108 §7).
 *
 * `help/REFERENCE.md` is the whole surface in one file, which is the right shape when the
 * question is "what is there". This is for when it is not: 221 params is a lot to read to
 * find the three that mention harvesting.
 *
 *   npm run help -- --find pool
 *   npm run help -- --find withholding --kind params
 *   npm run help -- --find TAX_SETTLE --kind actions
 *
 * It takes flags rather than a bare word because `parseFlags` refuses positionals outright
 * (cli.mjs: "This script takes flags only"), and design 108 D6 puts every entry point on
 * that spec. Carving an exception for the first new tool written after that decision would
 * be a poor start.
 *
 * Builds the index in memory when `public/help/help-index.json` is absent, so this works
 * on a fresh checkout — the JSON is a gitignored build artifact by design.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join }                     from 'node:path';

import { parseFlags }     from '../lib/cli.mjs';
import { buildHelpIndex, ROOT } from '../lib/help-index.mjs';

const KINDS = ['all', 'params', 'panels', 'actions', 'tools', 'state', 'topics', 'design'];

const opts = parseFlags(process.argv.slice(2), {
  usage: 'npm run help -- --find <text> [--kind params|panels|actions|tools|state|topics|design] [--limit n]',
  find:  { type: 'string',                     help: 'text to search for (case-insensitive)' },
  kind:  { type: 'string', default: 'all', choices: KINDS, help: 'restrict to one surface' },
  limit: { type: 'number', default: 25,        help: 'max matches per surface' },
  brief: { type: 'flag',                       help: 'omit descriptions — just the keys' },
});

if (!opts.find) {
  console.error('\nnpm run help -- --find <text>   (--help for options)\n');
  process.exit(2);
}

const cached = join(ROOT, 'public/help/help-index.json');
const index  = existsSync(cached)
  ? JSON.parse(readFileSync(cached, 'utf8'))
  : await buildHelpIndex();

const needle = opts.find.toLowerCase();
const hit    = (...fields) => fields.some(f => String(f ?? '').toLowerCase().includes(needle));
const want   = (kind) => opts.kind === 'all' || opts.kind === kind;

/** The topics citing a thing, as `title (path)` — tier 2 reached from a tier-1 hit. */
const citedBy = (pred) => (index.topics ?? []).filter(pred)
  .map(t => `${t.title} (${t.path})`).join(', ');

/** Print a surface's matches, or say plainly that it has none. */
function section(kind, title, matches, render) {
  if (!want(kind)) return 0;
  if (!matches.length) return 0;
  console.log(`\n${title} (${matches.length}${matches.length > opts.limit ? `, showing ${opts.limit}` : ''})`);
  for (const m of matches.slice(0, opts.limit)) render(m);
  return matches.length;
}

let total = 0;

total += section('params', 'PARAMETERS',
  index.params.filter(p => hit(p.key, p.label, p.group, p.description)),
  (p) => {
    const sweep = [p.mc && 'mc', p.opt && 'opt'].filter(Boolean).join('+');
    console.log(`  ${p.key}  [${p.type}${p.defaultValue !== null ? `, default ${JSON.stringify(p.defaultValue)}` : ''}]`
      + `  ${p.group ?? ''} · via ${p.contributedBy}${sweep ? ` · sweep: ${sweep}` : ''}`);
    if (p.options?.length) console.log(`      one of: ${p.options.join(', ')}`);
    if (!opts.brief && p.description) console.log(`      ${p.description}`);
    // The tier-2 half of the answer (design 108 §7): what to read when the description
    // says what the param DOES and the question was why you would move it.
    const cites = citedBy(t => t.params.includes(p.key));
    if (cites) console.log(`      explained in: ${cites}`);
  });

total += section('panels', 'PANELS',
  index.panels.filter(p => hit(p.id, p.title, p.component)),
  (p) => {
    console.log(`  ${p.id}  "${p.title}"  pane: ${p.layoutPane ?? '—'}\n      ${p.source ?? ''}`);
    const cites = citedBy(t => t.panels.includes(p.id));
    if (cites) console.log(`      explained in: ${cites}`);
  });

total += section('tools', 'TOOLS',
  index.tools.filter(t => hit(t.path, t.purpose, t.npmScript)),
  (t) => {
    console.log(`  ${t.path}${t.npmScript ? `   (npm run ${t.npmScript})` : ''}`);
    if (!opts.brief) console.log(`      ${t.purpose ?? '(undocumented)'}`);
    for (const f of t.flags ?? []) console.log(`      --${f.name}${f.help ? `  ${f.help}` : ''}`);
  });

total += section('actions', 'ACTION TYPES',
  index.actions.filter(a => hit(a.type, Object.keys(a.fields).join(' '), a.declaredBy.join(' '))),
  (a) => console.log(`  ${a.type}  {${Object.entries(a.fields).map(([n, k]) => `${n}: ${k}`).join(', ')}}`
    + `\n      declared by ${a.declaredBy.join(', ')}`));

total += section('topics', 'TOPICS',
  (index.topics ?? []).filter(t => hit(t.id, t.title, t.kind, t.path)),
  (t) => {
    console.log(`  ${t.path}  "${t.title}"  [${t.kind}, ${t.words} words]`);
    const cites = [t.panels.length && `${t.panels.length} panels`,
      t.params.length && `${t.params.length} params`,
      t.design.length && `design ${t.design.join(', ')}`].filter(Boolean).join(' · ');
    if (!opts.brief && cites) console.log(`      cites: ${cites}`);
  });

total += section('design', 'DESIGN DOCUMENTS',
  (index.design ?? []).filter(d => hit(d.path, d.title)),
  (d) => console.log(`  design/${d.path}\n      ${d.title ?? '(no title)'}`));

total += section('state', 'STATE FIELDS',
  index.state.filter(s => hit(s.path, s.kind)),
  (s) => console.log(`  ${s.path}  →  ${s.kind}`));

if (!total) {
  console.log(`\nNo match for "${opts.find}"`
    + `${opts.kind === 'all' ? '' : ` in ${opts.kind}`}.`
    + `\nThe whole surface is in help/REFERENCE.md.\n`);
  process.exit(1);
}
console.log('');
