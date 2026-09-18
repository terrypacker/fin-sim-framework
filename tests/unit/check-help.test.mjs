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
 * check-help.test.mjs — design 108 §6, the tier-2 gate.
 *
 * The gate's whole claim is that a topic cannot quietly stop being true. Each test here is
 * one way that could happen, so a change that weakens the gate fails rather than merely
 * making it quieter — a gate nobody checks is the three drifted indexes of §2.1 again, one
 * level up.
 *
 * Checks run against a SYNTHETIC index and fixture topics on disk, not the live registries:
 * a test that asserted on the real 221 params would fail the day someone edits a
 * description, which is exactly the noise the per-reference stamp design avoids.
 */

import { test, describe, before, after } from 'node:test';
import assert                            from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir }                        from 'node:os';
import { join }                          from 'node:path';
import { execFileSync }                  from 'node:child_process';
import { fileURLToPath }                 from 'node:url';

import {
  parseFrontmatter, readTopics, checkTopics, stampFor, sharedRun, countWords, BUDGETS,
} from '../../scripts/lib/help-topics.mjs';

/* ─────────────────────────────── the fixture ─────────────────────────────── */

const INDEX = {
  params: [
    { key: 'poolGraph', group: 'Spending',
      description: 'The liquidity graph: which account refills which, and in what priority order when several could.' },
    { key: 'lonelyParam', group: 'Nobody', description: 'Has no topic.' },
  ],
  panels:  [{ id: 'pools', title: 'Liquidity Pools', category: null }],
  actions: [{ type: 'POOL_REFILL' }],
  tools:   [{ path: 'scripts/lab/frontier.mjs' }],
};

let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), 'help-topics-')); });
after(()  => { rmSync(dir, { recursive: true, force: true }); });

/** Write one topic file and return the check result for the whole fixture tree. */
function withTopic(frontmatter, body, { name = 'topic.md' } = {}) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `---\n${frontmatter}\n---\n\n${body}\n`);
  const topics = readTopics(dir);
  return { topics, ...checkTopics({ topics, index: INDEX, root: dir }) };
}

const GOOD_BODY = 'Pools decide which account pays before another is touched, which is a '
  + 'placement policy rather than a spending one.';

const msgs = (r) => r.errors.map(e => e.msg).join('\n');

/** Only what the TOPIC got wrong — the fixture index always has an uncovered panel. */
const topicMsgs = (r) => r.errors.filter(e => e.id !== 'pools').map(e => e.msg).join('\n');

/* ────────────────────────────── structural ───────────────────────────────── */

describe('check-help — structural failures', () => {
  test('a topic naming a nonexistent param fails', () => {
    // The worst kind of stale: the topic is ABOUT something that no longer exists, so a
    // reader trusts a page describing a lever they cannot set.
    const r = withTopic(
      'id: t\nkind: concept\ntitle: T\nparams: [poolGraph, ghostParam]\nstamps:\n  param:poolGraph: x',
      GOOD_BODY);
    assert.match(msgs(r), /params: "ghostParam" is not a param/);
    assert.doesNotMatch(msgs(r), /poolGraph" is not/, 'the live param must not be flagged');
  });

  test('a topic naming a nonexistent panel, action, tool or design doc fails', () => {
    const r = withTopic(
      'id: t\nkind: concept\ntitle: T\npanels: [ghost]\nactions: [GHOST_ACTION]\n'
      + 'tools: [scripts/ghost.mjs]\ndesign: [999-ghost.md]\nstamps:',
      GOOD_BODY);
    assert.match(msgs(r), /panels: "ghost" is not a panel id/);
    assert.match(msgs(r), /actions: "GHOST_ACTION" is not an action type/);
    assert.match(msgs(r), /tools: "scripts\/ghost.mjs" is not a script path/);
    assert.match(msgs(r), /design: "999-ghost.md" does not exist/);
  });

  test('a topic over budget fails, and code blocks do not count against it', () => {
    const over = `${'word '.repeat(BUDGETS.concept + 1)}`;
    assert.match(topicMsgs(withTopic('id: t\nkind: concept\ntitle: T\nstamps:', over)),
      new RegExp(`over the ${BUDGETS.concept}-word concept budget`));

    // A budget is on EXPLANATION. Counting a pasted config example against it would push
    // authors to drop the example, which is the half a reader most needs.
    const fenced = `${'word '.repeat(50)}\n\`\`\`\n${'x '.repeat(500)}\n\`\`\`\n`;
    assert.equal(topicMsgs(withTopic('id: t\nkind: concept\ntitle: T\nstamps:', fenced)), '');
  });

  test('a 12-word paste from a cited description fails', () => {
    // The non-restatement rule (§5). Crude on purpose: a shared run catches PASTE, which
    // is the only way restatement actually happens.
    const pasted = 'Pools are useful. which account refills which, and in what priority '
      + 'order when several could. That is the idea.';
    const r = withTopic(
      'id: t\nkind: concept\ntitle: T\nparams: [poolGraph]\nstamps:\n  param:poolGraph: x', pasted);
    assert.match(msgs(r), /restates 12\+ words of param:poolGraph/);
  });

  test('a paste is caught through re-casing and re-wrapping', () => {
    const sneaky = 'WHICH ACCOUNT REFILLS WHICH, AND IN WHAT\nPRIORITY ORDER WHEN SEVERAL COULD.';
    assert.match(msgs(withTopic(
      'id: t\nkind: concept\ntitle: T\nparams: [poolGraph]\nstamps:\n  param:poolGraph: x', sneaky)),
      /restates 12\+ words/);
  });

  test('an unquoted paraphrase of the same param passes', () => {
    // The rule must not make citing a param impossible, or authors stop citing params.
    assert.equal(topicMsgs(withTopic(
      'id: t\nkind: concept\ntitle: T\nparams: [poolGraph]\nstamps:\n  param:poolGraph: x',
      'The graph names a refill order. Set it when one account should be drained before another.')),
      '');
  });

  test('a registered panel with no `kind: panel` topic fails', () => {
    // §2.1: 14 panels were undocumented because nothing failed when a commit added one.
    const r = withTopic('id: t\nkind: concept\ntitle: T\npanels: [pools]\nstamps:\n  panel:pools: x',
      GOOD_BODY);
    assert.match(msgs(r), /panel "pools" \(Liquidity Pools\) has no `kind: panel` topic/,
      'a concept MENTIONING a panel does not document it — only a kind: panel topic does');

    const covered = withTopic('id: t\nkind: panel\ntitle: T\npanels: [pools]\nstamps:\n  panel:pools: x',
      GOOD_BODY);
    assert.doesNotMatch(msgs(covered), /has no `kind: panel` topic/);
  });

  test('a bad kind, a missing id and a duplicate id all fail', () => {
    assert.match(msgs(withTopic('id: t\nkind: essay\ntitle: T\nstamps:', GOOD_BODY)),
      /kind "essay" is not one of panel, concept, workflow/);
    assert.match(msgs(withTopic('kind: concept\ntitle: T\nstamps:', GOOD_BODY)), /no `id:`/);

    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const n of ['a.md', 'b.md']) {
      writeFileSync(join(dir, n), `---\nid: same\nkind: concept\ntitle: T\nstamps:\n---\n\n${GOOD_BODY}\n`);
    }
    const topics = readTopics(dir);
    assert.match(checkTopics({ topics, index: INDEX, root: dir }).errors.map(e => e.msg).join('\n'),
      /duplicate id/);
  });

  test('more than two sources fails', () => {
    // The highest-noise stamp, so the budget is small and the author picks them (§6).
    const three = 'sources: [scripts/lib/cli.mjs, scripts/lib/format.mjs, scripts/lib/run.mjs]';
    assert.match(msgs(withTopic(`id: t\nkind: concept\ntitle: T\n${three}\nstamps:`, GOOD_BODY)),
      /3 sources; the budget is 2/);
  });

  test('unparseable frontmatter is reported, not thrown', () => {
    // One broken topic must not hide the other findings; the gate should report all of it.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'broken.md'), 'no frontmatter at all\n');
    const topics = readTopics(dir);
    assert.equal(topics[0].error !== null, true);
    assert.match(checkTopics({ topics, index: INDEX, root: dir }).errors.map(e => e.msg).join('\n'),
      /must open with a --- frontmatter block/);
  });
});

/* ──────────────────────────────── stamps ─────────────────────────────────── */

describe('check-help — stamps', () => {
  const stampOf = (key) => stampFor(`param:${key}`, INDEX);

  test('a changed description fails the stamp check', () => {
    const good = withTopic(
      `id: t\nkind: concept\ntitle: T\nparams: [poolGraph]\nstamps:\n  param:poolGraph: ${stampOf('poolGraph')}`,
      GOOD_BODY);
    assert.deepEqual(good.drift, [], 'a matching stamp is silent');

    const stale = withTopic(
      'id: t\nkind: concept\ntitle: T\nparams: [poolGraph]\nstamps:\n  param:poolGraph: 000000',
      GOOD_BODY);
    assert.equal(stale.drift.length, 1);
    assert.equal(stale.drift[0].ref, 'param:poolGraph');
    assert.equal(stale.drift[0].reason, 'moved');
  });

  test('a reference with no stamp at all is reported separately from one that moved', () => {
    // Different work: an unstamped reference is a topic being written, a moved one is a
    // claim to re-read. Reporting them together would bury the second in the first.
    const r = withTopic('id: t\nkind: concept\ntitle: T\nparams: [poolGraph]\nstamps:', GOOD_BODY);
    assert.equal(r.drift[0].reason, 'unstamped');
  });

  test('a stamp for a reference the topic no longer cites is a structural error', () => {
    // Otherwise a dropped `params:` entry leaves a stamp behind that silently passes.
    assert.match(msgs(withTopic(
      'id: t\nkind: concept\ntitle: T\nstamps:\n  param:poolGraph: abc123', GOOD_BODY)),
      /stamps: "param:poolGraph" is stamped but not referenced/);
  });

  test('re-wrapping a description does NOT move its stamp', () => {
    // Stamps are on meaning, not layout. A stamp that fired on re-flowing a comment would
    // teach blind re-stamping, which destroys the signal everywhere else.
    const wrapped = { ...INDEX, params: [{ ...INDEX.params[0],
      description: INDEX.params[0].description.replace(/ /g, '\n  ') }] };
    assert.equal(stampFor('param:poolGraph', wrapped), stampOf('poolGraph'));
  });

  test('a panel stamp catches a retitle', () => {
    const renamed = { ...INDEX, panels: [{ id: 'pools', title: 'Pools', category: null }] };
    assert.notEqual(stampFor('panel:pools', renamed), stampFor('panel:pools', INDEX));
  });

  test('a source stamp moves when the file changes', () => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const rel = 'src/thing.js';
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, rel), 'a');
    const before = stampFor(rel, INDEX, dir);
    writeFileSync(join(dir, rel), 'b');
    assert.notEqual(stampFor(rel, INDEX, dir), before);
  });

  test('a reference that does not resolve yields no stamp rather than a matchable one', () => {
    // Hashing "missing" would let a dead reference carry a stamp that keeps matching.
    assert.equal(stampFor('param:ghostParam', INDEX), null);
    assert.equal(stampFor('panel:ghost', INDEX), null);
    assert.equal(stampFor('src/nope.js', INDEX, dir), null);
  });
});

/* ──────────────────────────────── backlog ────────────────────────────────── */

describe('check-help — the backlog reports without failing', () => {
  test('an uncited param is backlog, named, and never an error', () => {
    // Counted per PARAM, not per group: Q4 settled on per-mechanic topics, and a per-group
    // count would call a 52-param group covered the moment one topic cited one of its
    // params — a number that reports success while the surface stays unexplained.
    const r = withTopic('id: t\nkind: panel\ntitle: T\npanels: [pools]\nstamps:\n  panel:pools: x',
      GOOD_BODY);
    const nobody = r.backlog.find(b => b.id === 'Nobody');
    assert.ok(nobody, 'the uncited param\'s group must be reported');
    assert.deepEqual(nobody.keys, ['lonelyParam'], 'and it must NAME the uncited params');
    assert.doesNotMatch(msgs(r), /lonelyParam/, 'an uncited param must never be an error');
  });

  test('citing a param clears it from the backlog', () => {
    const r = withTopic(
      'id: t\nkind: concept\ntitle: T\nparams: [lonelyParam]\nstamps:\n  param:lonelyParam: x',
      GOOD_BODY);
    assert.equal(r.backlog.find(b => b.id === 'Nobody'), undefined);
  });
});

/* ────────────────────────────── frontmatter ──────────────────────────────── */

describe('check-help — the frontmatter reader', () => {
  test('a stamp key containing colons round-trips', () => {
    // `panel:journal-report: e88448` split at the FIRST colon gives the key "panel" and a
    // value that can never match — an unstamped reference reported as a stamped one.
    const { data } = parseFrontmatter(
      '---\nid: t\nstamps:\n  panel:journal-report: e88448\n  src/a/b.js: c6d854\n---\nbody');
    assert.deepEqual(data.stamps, { 'panel:journal-report': 'e88448', 'src/a/b.js': 'c6d854' });
  });

  test('flow lists parse, and an unknown line throws rather than being skipped', () => {
    const { data, body } = parseFrontmatter('---\nparams: [a, b]\n---\n\nhello');
    assert.deepEqual(data.params, ['a', 'b']);
    assert.equal(body.trim(), 'hello');
    assert.throws(() => parseFrontmatter('---\nthis is not a key\n---\n'), /expected "key: value"/);
    assert.throws(() => parseFrontmatter('---\nid: t\n'), /never closed/);
  });

  test('countWords ignores punctuation-only tokens', () => {
    assert.equal(countWords('one two — three'), 3);
  });

  test('sharedRun needs a full run, not scattered words', () => {
    assert.equal(sharedRun('a b c d e f g h i j k l', 'a b c d e f g h i j k l'),
      'a b c d e f g h i j k l');
    assert.equal(sharedRun('a b c d e f g h i j k', 'a b c d e f g h i j k'), null);
  });
});

describe('check-help — the template it hands an author', () => {
  test('every kind\'s template parses', () => {
    // A template that emits a file the gate then rejects is worse than no template, and
    // the first one did exactly that: a trailing `# comment` after `panels: []` was
    // swallowed into the flow list. Round-trip it instead of eyeballing it.
    for (const kind of Object.keys(BUDGETS)) {
      const out = execFileSync(process.execPath,
        [fileURLToPath(new URL('../../scripts/dev/check-help.mjs', import.meta.url)),
         '--template', kind], { encoding: 'utf8' });
      const { data, body } = parseFrontmatter(out, `template:${kind}`);
      assert.equal(data.kind, kind);
      assert.deepEqual(data.stamps, {}, 'the stamps block must parse as an empty map');
      for (const f of ['panels', 'params', 'actions', 'tools', 'design', 'sources']) {
        assert.deepEqual(data[f], [], `${f} must parse as an empty list`);
      }
      assert.match(body, new RegExp(`${BUDGETS[kind]} words max`));
    }
  });
});

/* ─────────────────────────── the real topic tree ─────────────────────────── */

describe('check-help — the committed help/ tree', () => {
  test('every topic in help/ parses and carries the fields the gate needs', () => {
    // Warn mode (phase 3) means the gate does not fail npm test yet, so nothing else would
    // notice a topic that stopped parsing. This does.
    for (const t of readTopics()) {
      assert.equal(t.error, null, `${t.path}: ${t.error}`);
      assert.ok(t.id, `${t.path}: no id`);
      assert.ok(BUDGETS[t.kind], `${t.path}: kind "${t.kind}"`);
      assert.ok(t.words > 0, `${t.path}: empty body`);
    }
  });

  test('panel and concept are both complete and CLEAN — both are enforced', () => {
    // design 108 phase 4 is done: every panel has a topic and every param is cited, so
    // `npm test` runs the gate with `--enforce panel,concept`. Asserting it here too means
    // a failure names the topic rather than only failing a shell step.
    const gate = execFileSync(process.execPath,
      [fileURLToPath(new URL('../../scripts/dev/check-help.mjs', import.meta.url)),
       '--quiet', '--enforce', 'panel,concept'], { encoding: 'utf8' });
    assert.match(gate, /32 panel/);
    assert.match(gate, /0 structural · 0 stamp/);
    assert.match(gate, /0 params uncited/,
      'Q4 settled on per-mechanic topics covering the whole param surface');
  });

  test('the seed topic is stamped against the live registries', () => {
    // If this fails, `npm run help:restamp -- <id>` after reading what moved.
    const text = readFileSync(new URL('../../help/concepts/event-sourcing.md', import.meta.url), 'utf8');
    const { data } = parseFrontmatter(text);
    assert.ok(Object.keys(data.stamps).length >= 4, 'the seed topic must carry its stamps');
  });
});
