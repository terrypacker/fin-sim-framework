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
 * check-help.mjs — the tier-2 gate (design 108 §6).
 *
 * Reports three classes, which are three different kinds of work:
 *
 *   structural  a dead reference, a budget overrun, a paste from a description, or a
 *               registered panel with no topic — the 14 missing panels of §2.1 are the
 *               whole reason this exists.  → edit the topic, or write one.
 *   stamp drift a param's description moved under a topic that cites it.
 *               → LOOK, then `npm run help:restamp -- <topic-id>`.
 *   backlog     a param GROUP with no concept topic.
 *               → never fatal. Q4 has not settled which of the 21 groups deserve a topic
 *                 of their own, and a gate on work nobody has scoped teaches people to
 *                 switch the gate off, which costs more than the backlog does.
 *
 * `--strict` makes the first two fatal. **Phase 3 runs WITHOUT it** — the gate reports
 * while the topics are still being written, because a gate that fails before there is
 * anything to check is a gate everyone learns to skip. D5 turns it on per kind in phase 4,
 * as each kind completes, at which point it fails `npm test` locally and not only in CI.
 *
 *   npm run help:gate                        report
 *   npm run help:gate -- --strict            and exit 1 on structural errors or drift
 *   npm run help:gate -- --strict --kinds panel   one kind at a time, which is how
 *                                                 phase 4 turns it on
 *   npm run help:gate -- --backlog           just the backlog, for planning phase 4
 */

import { buildHelpIndex, ROOT } from '../lib/help-index.mjs';
import { readTopics, checkTopics, BUDGETS } from '../lib/help-topics.mjs';
import { parseFlags } from '../lib/cli.mjs';

const opts = parseFlags(process.argv.slice(2), {
  usage: 'node scripts/dev/check-help.mjs [--strict] [--backlog]\n\n'
       + 'check-help — does the hand-written help/ tree still describe the code?',
  strict:  { type: 'flag', help: 'exit 1 on structural errors or stamp drift (design 108 D5)' },
  kinds:   { type: 'list', help: 'restrict the report to these topic kinds — phase 4 enforces one kind at a time' },
  backlog: { type: 'flag', help: 'print only the backlog of param groups with no concept topic' },
  quiet:   { type: 'flag', help: 'the one-line summary only, no per-item detail (what `npm test` runs)' },
  template: { type: 'string', choices: Object.keys(BUDGETS),
              help: 'print a blank topic of this kind and exit' },
});

// Generated from the same constants the gate reads, so the skeleton it hands an author can
// never be a stale copy of the frontmatter shape — which is the failure mode of every
// "see the example above" convention.
if (opts.template) {
  // Full-line `#` comments only: the frontmatter reader skips those, and a TRAILING comment
  // after `panels: []` would be swallowed into the flow list and fail to parse. A template
  // that emits a file the gate then rejects is worse than no template.
  console.log([
    '---',
    '# id must match the filename.',
    'id: <kebab-id>',
    `kind: ${opts.template}`,
    'title: <Title Case>',
    '# What this topic documents. Every entry here must exist, and gets a stamp.',
    'panels: []',
    'params: []',
    'actions: []',
    'tools: []',
    '# design/*.md filenames. Referenced, never stamped — they are edited constantly.',
    'design: []',
    '# 0-2 src/ files: "I am a claim about this code". The highest-signal stamp.',
    'sources: []',
    '# npm run help:restamp -- <id> fills these in.',
    'stamps:',
    '---',
    '',
    `<${BUDGETS[opts.template]} words max. Do NOT restate a param description: tier 1 already`,
    'emits it exactly, and a 12-word shared run fails the gate. Say what tier 1 cannot —',
    'why it exists, when you would reach for it, what it deliberately does not do.>',
  ].join('\n'));
  process.exit(0);
}

const index  = await buildHelpIndex();
const topics = readTopics();
const all    = checkTopics({ topics, index, root: ROOT });

// Phase 4 turns the gate on ONE KIND AT A TIME, so `panel` can be fatal while the concept
// topics are still being written. With no --kinds, everything is in scope.
const inScope = (k) => !opts.kinds?.length || opts.kinds.includes(k);
const byId    = new Map(topics.map(t => [t.id, t]));
const errors  = all.errors.filter(e => inScope(e.kind));
const drift   = all.drift.filter(d => inScope(byId.get(d.id)?.kind ?? 'topic'));
const backlog = all.backlog;

const plural = (n, s) => `${n} ${s}${n === 1 ? '' : 's'}`;

if (opts.backlog) {
  for (const b of backlog) console.log(`  ${b.kind.padEnd(6)} ${String(b.id).padEnd(28)} ${b.what}`);
  console.log(`\n${plural(backlog.length, 'item')} with no topic yet.`);
  process.exit(0);
}

// `--quiet` keeps the SUMMARY and drops the detail. Phase 3 has 32 uncovered panels by
// construction, and printing all of them on every `npm test` would train people to scroll
// past the block — which is how a real failure gets missed once phase 4 makes it fatal.
const detail = !opts.quiet;

if (detail && errors.length) {
  console.error(`\n${plural(errors.length, 'structural error')}:\n`);
  for (const e of errors) console.error(`  ${e.path}\n    ${e.msg}\n    → ${e.fix}`);
}

if (detail && drift.length) {
  const unstamped = drift.filter(d => d.reason === 'unstamped');
  const moved     = drift.filter(d => d.reason === 'moved');
  if (moved.length) {
    console.error(`\n${plural(moved.length, 'stamp')} no longer`
      + `${moved.length === 1 ? ' matches' : ' match'} the code:\n`);
    for (const d of moved) {
      console.error(`  ${d.path}  ${d.ref}\n    stamped ${d.have}, now ${d.now}`
        + `\n    → read it, then: npm run help:restamp -- ${d.id}`);
    }
  }
  if (unstamped.length) {
    console.error(`\n${plural(unstamped.length, 'reference')} carry no stamp yet:\n`);
    for (const d of unstamped) console.error(`  ${d.path}  ${d.ref}`);
    console.error('\n  → npm run help:restamp -- <topic-id>');
  }
}

{
  const kinds = Object.keys(BUDGETS)
    .map(k => `${topics.filter(t => t.kind === k).length} ${k}`).join(' · ');
  const scope = opts.kinds?.length ? `  [kinds: ${opts.kinds.join(', ')}]` : '';
  console.log(`\n${plural(topics.length, 'topic')} (${kinds})`
    + ` · ${errors.length} structural · ${drift.length} stamp`
    + ` · ${backlog.length} backlog (--backlog to list)${scope}`);
}

if (opts.strict && (errors.length || drift.length)) process.exit(1);

if (errors.length || drift.length) {
  console.log(`warn mode — design 108 phase 3. \`--strict\` makes ${detail ? 'the above' : 'this'} fatal.`
    + (detail ? '' : '  Run `npm run help:gate` for the detail.'));
}
