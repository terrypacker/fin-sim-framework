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
 * restamp-help.mjs — the re-gold half of the tier-2 gate (design 108 §6).
 *
 * `check-help` says a stamp moved; this clears it, once you have read what changed. It is
 * the same workflow the golden fixtures already run — a hash moves, the gate fails, you
 * look, you re-gold — and the point of it is that the cleared stamp lands in the DIFF.
 * "Cleared without reading" is then visible at review, instead of being invisible forever
 * the way the three drifted indexes in §2.1 were.
 *
 * So it restamps ONE NAMED TOPIC by default. `--all` exists for a mechanical change that
 * really did touch everything (a bulk description re-wrap), and prints how many stamps it
 * moved so an unexpectedly large number is noticed rather than committed.
 *
 *   npm run help:restamp -- liquidity-pools
 *   npm run help:restamp -- liquidity-pools --ref param:drawdownSequence
 *   npm run help:restamp -- --all
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildHelpIndex, ROOT }                 from '../lib/help-index.mjs';
import { readTopics, refsOf, stampFor, parseFrontmatter } from '../lib/help-topics.mjs';
import { parseFlags } from '../lib/cli.mjs';

const opts = parseFlags(process.argv.slice(2), {
  usage: 'npm run help:restamp -- <topic-id> [--ref param:key]\n'
       + 'npm run help:restamp -- --all\n\n'
       + 'restamp-help — clear a stamp check-help reported, after reading what moved.',
  positional: { name: 'topic', type: 'string', help: 'the topic id to restamp' },
  ref: { type: 'string', help: 'restamp only this one reference' },
  all: { type: 'flag',   help: 'restamp every topic (a bulk change that really did touch everything)' },
  dryRun: { type: 'flag', help: 'report what would change and write nothing' },
});

if (!opts.topic && !opts.all) {
  console.error('\nnpm run help:restamp -- <topic-id>   (or --all)  (-h for options)\n');
  process.exit(2);
}

const index  = await buildHelpIndex();
const topics = readTopics();

const chosen = opts.all ? topics : topics.filter(t => t.id === opts.topic);
if (!chosen.length) {
  console.error(`\nno topic with id "${opts.topic}".`
    + `  known: ${topics.map(t => t.id).filter(Boolean).join(', ') || '(none yet)'}\n`);
  process.exit(2);
}

let moved = 0;
for (const t of chosen) {
  if (t.error) { console.error(`  ${t.path}: ${t.error} — fix the frontmatter first`); continue; }

  const stamps = {};
  for (const ref of refsOf(t)) {
    const now = stampFor(ref, index, ROOT);
    if (now === null) {
      console.error(`  ${t.path}: ${ref} does not resolve — fix the reference, not the stamp`);
      continue;
    }
    // `--ref` keeps an unrelated stamp at its old value, so one review clears one claim.
    stamps[ref] = (opts.ref && ref !== opts.ref) ? (t.stamps[ref] ?? now) : now;
    if (stamps[ref] !== t.stamps[ref]) {
      moved++;
      console.log(`  ${t.id}  ${ref}  ${t.stamps[ref] ?? '(new)'} → ${stamps[ref]}`);
    }
  }
  if (!opts.dryRun) writeStamps(join(ROOT, t.path), stamps);
}

console.log(`\n${moved} stamp${moved === 1 ? '' : 's'} ${opts.dryRun ? 'would move' : 'restamped'}`
  + ` across ${chosen.length} topic${chosen.length === 1 ? '' : 's'}.`);
if (moved > 10 && !opts.dryRun) {
  console.log('That is a lot to have read. If it was a bulk re-wrap, say so in the commit.');
}

/**
 * Rewrite just the `stamps:` block, leaving every other frontmatter line byte-identical.
 *
 * Not a re-serialisation of the parsed object: that would reformat the author's file on
 * every restamp and bury the one line that actually moved in a whole-block diff — the diff
 * being the entire reason this tool exists.
 */
function writeStamps(path, stamps) {
  const text  = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  const end   = lines.indexOf('---', 1);

  const block = ['stamps:', ...Object.entries(stamps).map(([k, v]) => `  ${k}: ${v}`)];

  const start = lines.findIndex((l, i) => i > 0 && i < end && /^stamps:\s*$/.test(l));
  if (start < 0) {
    lines.splice(end, 0, ...block);
  } else {
    let stop = start + 1;
    while (stop < end && /^\s+\S/.test(lines[stop])) stop++;
    lines.splice(start, stop - start, ...block);
  }
  writeFileSync(path, lines.join('\n'));

  // A written file that no longer parses would poison every later run, so prove it.
  parseFrontmatter(readFileSync(path, 'utf8'), path);
}
