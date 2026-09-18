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
 * build-help-index.mjs — regenerate the tier-1 help reference (design 108 phase 1).
 *
 * Writes two artifacts from one index, deliberately treated differently:
 *
 *   help/REFERENCE.md          COMMITTED. The LLM/human surface, and the review signal —
 *                              a PR that changes a param description shows that change in
 *                              a reviewable place for the first time.
 *   public/help/help-index.json  GITIGNORED build artifact, consumed by the in-app Help
 *                              panel (phase 5) and by `npm run help`. Out of git so PRs do
 *                              not carry a large mechanical diff, regenerated on `prebuild`
 *                              so a deploy can never ship a stale one.
 *
 * `--check` writes nothing and exits 1 if `help/REFERENCE.md` is not what this run would
 * produce. That is the phase-1 half of the sync gate: a param added without regenerating
 * fails, which is the failure the three drifted indexes in design 108 §2.1 never had.
 *
 *   node scripts/dev/build-help-index.mjs
 *   node scripts/dev/build-help-index.mjs --check
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join }                                      from 'node:path';

import { buildHelpIndex, ROOT }       from '../lib/help-index.mjs';
import { renderReferenceMarkdown }    from '../lib/help-render.mjs';

const REFERENCE = join(ROOT, 'help/REFERENCE.md');
const INDEX     = join(ROOT, 'public/help/help-index.json');

const write = (path, body) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
};

const index    = await buildHelpIndex();
const markdown = renderReferenceMarkdown(index);
const json     = `${JSON.stringify(index, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const current = existsSync(REFERENCE) ? readFileSync(REFERENCE, 'utf8') : null;
  if (current === markdown) {
    console.log(`help/REFERENCE.md is up to date (${index.counts.params} params, ${index.counts.panels} panels).`);
    process.exit(0);
  }
  console.error(current === null
    ? 'help/REFERENCE.md is missing.'
    : 'help/REFERENCE.md is stale — the source has changed since it was generated.');
  console.error('Run `npm run help:build` and commit the result.');
  process.exit(1);
}

write(REFERENCE, markdown);
write(INDEX, json);

const { params, panels, actions, tools, toolsWithFlags, state } = index.counts;
console.log(`help/REFERENCE.md          ${params} params · ${panels} panels · ${actions} actions · ${tools} tools · ${state} state types`);
console.log(`public/help/help-index.json  ${(json.length / 1024).toFixed(0)} KB`);

const undocumented = index.tools.filter(t => !t.purpose);
if (undocumented.length) {
  console.log(`\n${undocumented.length} scripts carry no docblock naming themselves:`);
  for (const t of undocumented) console.log(`  ${t.path}`);
}
console.log(`\n${tools - toolsWithFlags} of ${tools} tools are not on the parseFlags spec (design 108 D6).`);
