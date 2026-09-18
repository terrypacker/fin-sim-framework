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
 * help-topics.mjs — tier 2, and the gate that keeps it TRUE (design 108 §5, §6).
 *
 * Tier 1 cannot go stale: it is generated from the registries, so a param added to a
 * toolset appears in `help/REFERENCE.md` with no one having remembered anything. Tier 2
 * is hand-written prose, which can, and a presence check ("does every panel have a
 * topic?") does not help — it keeps the documentation COMPLETE while saying nothing
 * about whether it is still true. A topic about `drawdownSequence` goes quietly wrong
 * the day the param's meaning changes underneath it.
 *
 * So topics are STAMPED, per reference rather than per topic, and the gate names the one
 * thing that moved:
 *
 *   param:<key>   hash of the whitespace-normalised description
 *   panel:<id>    hash of title + category — catches a rename
 *   src/<path>    optional, author-chosen, at most two. "I am a claim about this code."
 *
 * Design docs are referenced and never stamped: they are long and edited constantly, so a
 * stamp on one would fire on every paragraph and teach blind re-stamping, which destroys
 * the signal everywhere else.
 *
 * This is deliberately the workflow the repo already runs for golden fixtures — a hash
 * moves, the gate fails, you look, you re-gold — and `npm run help:restamp` is the
 * re-gold. The cleared stamp shows up in the diff, so "cleared without reading" is
 * visible at review rather than invisible forever.
 */

import { createHash }                      from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve }         from 'node:path';

import { ROOT } from './help-index.mjs';

export const TOPICS_DIR = join(ROOT, 'help');

/** Word budgets by kind (design 108 §5). A topic over its budget is restating tier 1. */
export const BUDGETS = Object.freeze({ panel: 250, concept: 400, workflow: 600 });

/** The longest run of words a topic may share with a description it cites. */
export const PASTE_RUN = 12;

/* ─────────────────────────────── frontmatter ─────────────────────────────── */

/**
 * Parse the frontmatter block of a topic.
 *
 * Deliberately a strict reader of the one shape design 108 §5 defines, rather than a YAML
 * parser: `scalar`, `[flow, list]`, and the single nested `stamps:` map. It THROWS on a
 * line it does not understand instead of skipping it, because a silently dropped `params:`
 * is a topic the gate then never checks — which is the failure this whole file exists to
 * prevent, reintroduced one level down.
 *
 * @returns {{ data: object, body: string }}
 */
export function parseFrontmatter(text, where = '<topic>') {
  const lines = text.split('\n');
  if (lines[0].trim() !== '---') throw new Error(`${where}: must open with a --- frontmatter block`);

  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Error(`${where}: frontmatter block is never closed`);

  const data = {};
  let nested = null;   // the key whose indented block we are inside

  for (let i = 1; i < end; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith('#')) continue;

    const indented = /^\s+/.test(raw);
    if (indented) {
      if (!nested) throw new Error(`${where}:${i + 1}: indented line with no parent key`);
      // GREEDY up to the last colon: a stamp key is `param:poolGraph` or a source path,
      // both of which contain colons or slashes of their own. Splitting on the first
      // colon silently yields the key "param" and a value that can never match — an
      // unstamped reference reported as a stamped one, which is the drift this file exists
      // to catch, reintroduced in the reader.
      const m = raw.trim().match(/^(.*):\s+(\S+)$/) ?? raw.trim().match(/^(.*):\s*$/);
      if (!m) throw new Error(`${where}:${i + 1}: expected "key: value", got "${raw.trim()}"`);
      data[nested][m[1].trim()] = scalar(m[2] ?? '');
      continue;
    }

    const m = raw.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!m) throw new Error(`${where}:${i + 1}: expected "key: value", got "${raw}"`);
    const [, key, rest] = m;

    if (rest === '') { nested = key; data[key] = {}; continue; }
    nested = null;
    data[key] = rest.startsWith('[') ? flowList(rest, where, i + 1) : scalar(rest);
  }
  return { data, body: lines.slice(end + 1).join('\n') };
}

const scalar = (s) => {
  const v = s.trim().replace(/^["']|["']$/g, '');
  return v;
};

function flowList(s, where, line) {
  const inner = s.trim();
  if (!inner.endsWith(']')) throw new Error(`${where}:${line}: unclosed [ list`);
  return inner.slice(1, -1).split(',').map(x => scalar(x)).filter(Boolean);
}

/* ───────────────────────────────── reading ───────────────────────────────── */

/** Every `.md` under `help/`, excluding the generated REFERENCE.md. */
export function topicFiles(dir = TOPICS_DIR) {
  let entries;
  try { entries = readdirSync(dir, { recursive: true }); } catch { return []; }
  return entries
    .map(String)
    .filter(rel => rel.endsWith('.md') && rel !== 'REFERENCE.md')
    .map(rel => join(dir, rel))
    .filter(p => statSync(p).isFile())
    .sort();
}

/**
 * Read and parse every topic. A file that cannot be parsed comes back as a topic with
 * `error` set rather than throwing the whole run away: the gate should report all of it.
 */
export function readTopics(dir = TOPICS_DIR) {
  return topicFiles(dir).map((path) => {
    const rel  = relative(ROOT, path);
    const text = readFileSync(path, 'utf8');
    try {
      const { data, body } = parseFrontmatter(text, rel);
      return {
        path: rel,
        id:      data.id ?? null,
        kind:    data.kind ?? null,
        title:   data.title ?? null,
        panels:  asList(data.panels),
        params:  asList(data.params),
        actions: asList(data.actions),
        tools:   asList(data.tools),
        design:  asList(data.design),
        sources: asList(data.sources),
        stamps:  data.stamps ?? {},
        body,
        words:   countWords(body),
        error:   null,
      };
    } catch (e) {
      return { path: rel, id: null, stamps: {}, body: '', words: 0, error: e.message,
               panels: [], params: [], actions: [], tools: [], design: [], sources: [] };
    }
  });
}

const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);

/** Prose words. Fenced code blocks do not count against a budget meant for explanation. */
export function countWords(body) {
  return body.replace(/```[\s\S]*?```/g, ' ')
    .split(/\s+/).filter(w => /[A-Za-z0-9]/.test(w)).length;
}

/* ───────────────────────────────── stamps ────────────────────────────────── */

const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 6);

/** Whitespace-normalised, so re-wrapping a description is not a change of meaning. */
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * The stamp a given reference should carry right now.
 *
 * @returns {?string} null when the reference does not exist — a structural error the
 *   caller reports, not something to hash into a stamp that could then "match".
 */
export function stampFor(ref, index, root = ROOT) {
  if (ref.startsWith('param:')) {
    const p = index.params.find(x => x.key === ref.slice(6));
    return p ? hash(norm(p.description)) : null;
  }
  if (ref.startsWith('panel:')) {
    const p = index.panels.find(x => x.id === ref.slice(6));
    return p ? hash(`${norm(p.title)}|${norm(p.category)}`) : null;
  }
  // A source file. Hashed whole: this is the stamp that catches drift a description edit
  // would miss, which is exactly why its budget is two files and the author picks them.
  try { return hash(readFileSync(resolve(root, ref), 'utf8')); } catch { return null; }
}

/** Every reference a topic must stamp: its params, its panels, and its chosen sources. */
export function refsOf(topic) {
  return [
    ...topic.params.map(k => `param:${k}`),
    ...topic.panels.map(k => `panel:${k}`),
    ...topic.sources,
  ];
}

/* ───────────────────────────────── the gate ──────────────────────────────── */

/**
 * Check the topic tree against the live index.
 *
 * Three classes, deliberately separated (design 108 §6):
 *
 *   errors    structural — a dead reference, a budget overrun, a paste, or a registered
 *             panel with no `kind: panel` topic. Edit the topic, or write one.
 *   drift     a stamp no longer matches. Look, then `npm run help:restamp -- <id>`.
 *   backlog   a param GROUP with no concept topic. REPORTED, never fatal: Q4 has not
 *             settled which of the 21 groups deserve a topic of their own — Economic
 *             Shocks at 52 params plainly needs several and some small groups need none —
 *             and a gate on work nobody has scoped teaches people to disable the gate.
 *
 * Each error carries a `kind`, because phase 4 flips the gate to failing ONE KIND AT A
 * TIME: `panel` can be enforced while `concept` topics are still being written.
 *
 * @returns {{ errors: object[], drift: object[], backlog: object[], topics: object[] }}
 */
export function checkTopics({ topics, index, root = ROOT }) {
  const errors = [], drift = [], backlog = [];
  const at = (t, msg, fix) =>
    errors.push({ path: t.path, id: t.id, kind: t.kind ?? 'topic', msg, fix });

  const paramByKey = new Map(index.params.map(p => [p.key, p]));
  const panelById  = new Map(index.panels.map(p => [p.id, p]));
  const actionSet  = new Set(index.actions.map(a => a.type));
  const toolSet    = new Set(index.tools.map(t => t.path));
  const seenId     = new Map();

  for (const t of topics) {
    if (t.error) { at(t, t.error, 'fix the frontmatter'); continue; }

    if (!t.id)    at(t, 'no `id:`', 'add one, matching the filename');
    if (!t.title) at(t, 'no `title:`', 'add one');
    if (!BUDGETS[t.kind]) {
      at(t, `kind "${t.kind}" is not one of ${Object.keys(BUDGETS).join(', ')}`, 'pick one');
    }
    if (t.id) {
      if (seenId.has(t.id)) at(t, `duplicate id, also in ${seenId.get(t.id)}`, 'rename one');
      seenId.set(t.id, t.path);
    }

    const budget = BUDGETS[t.kind];
    if (budget && t.words > budget) {
      at(t, `${t.words} words over the ${budget}-word ${t.kind} budget`,
        'cut it — over budget is usually tier 1 restated');
    }

    // Dead references. A key that no longer exists means the topic is about something
    // that is gone, which is worse than no topic at all.
    for (const k of t.params)  if (!paramByKey.has(k)) at(t, `params: "${k}" is not a param`, 'remove or correct it');
    for (const k of t.panels)  if (!panelById.has(k))  at(t, `panels: "${k}" is not a panel id`, 'remove or correct it');
    for (const k of t.actions) if (!actionSet.has(k))  at(t, `actions: "${k}" is not an action type`, 'remove or correct it');
    for (const k of t.tools)   if (!toolSet.has(k))    at(t, `tools: "${k}" is not a script path`, 'remove or correct it');
    for (const d of t.design)  if (!exists(join(root, 'design', d))) at(t, `design: "${d}" does not exist`, 'remove or correct it');

    if (t.sources.length > 2) {
      at(t, `${t.sources.length} sources; the budget is 2`,
        'a topic claiming more than two files is claiming too much');
    }
    for (const s of t.sources) if (!exists(join(root, s))) at(t, `sources: "${s}" does not exist`, 'remove or correct it');

    // The non-restatement rule. Crude on purpose: a shared run of words catches PASTE,
    // which is the only way restatement actually happens.
    for (const k of t.params) {
      const p = paramByKey.get(k);
      const run = p && sharedRun(t.body, p.description, PASTE_RUN);
      if (run) {
        at(t, `restates ${PASTE_RUN}+ words of param:${k} — "${run}"`,
          'cite the param and say something tier 1 does not');
      }
    }

    // Stamps: one per reference, no more and no fewer.
    const want = refsOf(t);
    for (const ref of want) {
      const now  = stampFor(ref, index, root);
      const have = t.stamps[ref];
      if (now === null) continue;                       // already reported as a dead ref
      if (have === undefined) {
        drift.push({ path: t.path, id: t.id, ref, have: null, now, reason: 'unstamped' });
      } else if (have !== now) {
        drift.push({ path: t.path, id: t.id, ref, have, now, reason: 'moved' });
      }
    }
    for (const ref of Object.keys(t.stamps)) {
      if (!want.includes(ref)) at(t, `stamps: "${ref}" is stamped but not referenced`, 'run help:restamp');
    }
  }

  // Panel coverage is STRUCTURAL (§6): the 14 undocumented panels in §2.1 are the whole
  // reason this design exists, and every one of them was added by a commit that could have
  // written a topic and did not, because nothing failed when it didn't.
  const coveredPanels = new Set(
    topics.filter(t => t.kind === 'panel').flatMap(t => t.panels));
  for (const p of index.panels) {
    if (!coveredPanels.has(p.id)) {
      errors.push({ path: `help/panels/${p.id}.md`, id: p.id, kind: 'panel',
        msg: `panel "${p.id}" (${p.title}) has no \`kind: panel\` topic`,
        fix: 'write one — 250 words: what it shows, when to open it, what it needs loaded' });
    }
  }

  const coveredParams = new Set(topics.flatMap(t => t.params));
  const groups = new Map();
  for (const p of index.params) {
    if (!p.group) continue;
    const g = groups.get(p.group) ?? { total: 0, covered: 0 };
    g.total++;
    if (coveredParams.has(p.key)) g.covered++;
    groups.set(p.group, g);
  }
  for (const [group, g] of [...groups].sort((a, b) => b[1].total - a[1].total)) {
    if (!g.covered) backlog.push({ kind: 'group', id: group, what: `${g.total} params, no topic` });
  }

  return { errors, drift, backlog, topics };
}

const exists = (p) => { try { statSync(p); return true; } catch { return false; } };

/**
 * The first run of `n`+ consecutive words shared by a topic body and a description.
 *
 * Compared on lowercased word sequences so re-casing or re-wrapping a paste does not slip
 * past, and returns the run itself so the gate can point at the sentence.
 */
export function sharedRun(body, description, n = PASTE_RUN) {
  const words = (s) => String(s ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const a = words(body), b = words(description);
  if (a.length < n || b.length < n) return null;

  const seen = new Set();
  for (let i = 0; i + n <= b.length; i++) seen.add(b.slice(i, i + n).join(' '));
  for (let i = 0; i + n <= a.length; i++) {
    const run = a.slice(i, i + n).join(' ');
    if (seen.has(run)) return run;
  }
  return null;
}
