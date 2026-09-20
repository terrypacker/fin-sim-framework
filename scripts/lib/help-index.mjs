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
 * help-index.mjs — build the tier-1 help reference by READING THE CODE (design 108 §4).
 *
 * Three hand-maintained indexes in this repo had already drifted before this existed:
 * the README plugin table covered 18 of 32 plugin ids, the README design list 19 of 116
 * files, `design/README.md` 10 of 116 (design 108 §2.1). Every one of them drifted the
 * same way — a commit added the thing and did not update the copy, and nothing failed.
 *
 * So nothing here is a copy. Every collector imports the real registry and reports what
 * it finds: `buildFullParamSchema()` for params, `FINANCE_PLUGINS` for panels, each
 * toolset's `types.actions` for the journal surface, the script docblocks for the CLI.
 * A param added to a toolset appears in the reference the next time this runs, with no
 * one having remembered anything.
 *
 * The index is DETERMINISTIC and carries no timestamp: `help/REFERENCE.md` is committed,
 * and its git diff is the review signal for a changed description (design 108 §4). A
 * generated-at line would make every run a diff and destroy that.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve }             from 'node:path';
import { parse }                               from '@babel/parser';

export const ROOT = resolve(import.meta.dirname, '../..');

/* ─────────────────────────────── params ──────────────────────────────── */

/**
 * The 221-param surface, each stamped with the toolset that contributed it.
 *
 * `contributedBy` reproduces the merge rule `buildFullParamSchema()` and
 * `ScenarioLoader._mergeParamSchema` already share: the scenario's own schema wins, then
 * the FIRST toolset copy of a shared key in `_paramToolsets()` order. The US and AU
 * retirement toolsets both contribute the spending/mortality family, so "first wins" is
 * load-bearing rather than theoretical — see the test of the same name.
 */
export async function collectParams() {
  const { IntlRetirementScenario } = await import(
    `${ROOT}/src/scenarios/intl-retirement-scenario.js`);

  const scenarioKeys = new Set(IntlRetirementScenario.getParamSchema().map(e => e.key));

  // key → first toolset id that names it, walked in the scenario's own order.
  const owner = new Map();
  for (const toolset of IntlRetirementScenario._paramToolsets()) {
    for (const entry of toolset.paramSchema?.({}) ?? []) {
      if (entry?.key && !owner.has(entry.key)) owner.set(entry.key, toolset.id);
    }
  }

  return IntlRetirementScenario.buildFullParamSchema().map(p => ({
    key:           p.key,
    label:         p.label ?? null,
    group:         p.group ?? null,
    type:          p.type ?? null,
    defaultValue:  p.defaultValue ?? null,
    defaultCurrency: p.defaultCurrency ?? null,
    options:       p.options ?? null,
    min:           p.min ?? null,
    max:           p.max ?? null,
    step:          p.step ?? null,
    visibleWhen:   p.visibleWhen ? String(p.visibleWhen) : null,
    mc:            Boolean(p.mc),
    opt:           Boolean(p.opt),
    node:          p.node ?? null,
    description:   p.description ?? '',
    contributedBy: scenarioKeys.has(p.key) ? 'SCENARIO' : (owner.get(p.key) ?? null),
  }));
}

/* ─────────────────────────────── panels ──────────────────────────────── */

/**
 * The workbench panels, from `FINANCE_PLUGINS` itself.
 *
 * `category` and `defaultPane` come back null for every entry today: the descriptors in
 * `finance-plugin-package.js` are plain `{id, title, component}` literals that never go
 * through `definePlugin()`, so the SDK's defaults are never applied. That is reported,
 * not papered over — an empty column here is a true statement about the registry.
 *
 * The source file is recovered from the package's own import statements rather than
 * guessed from the class name, so a renamed file is followed automatically.
 */
export async function collectPanels() {
  const pkgPath = `${ROOT}/src/visualization/workbench/plugins/finance/finance-plugin-package.js`;
  const { FINANCE_PLUGINS, FINANCE_DEFAULT_LAYOUT } = await import(pkgPath);

  const pkgSource = readFileSync(pkgPath, 'utf8');

  // `import { FooPlugin } from './foo-plugin.js';` → FooPlugin → foo-plugin.js
  const fileFor = new Map();
  for (const [, name, file] of pkgSource
    .matchAll(/import\s*\{\s*([A-Za-z0-9_]+)\s*\}\s*from\s*'\.\/([^']+)'/g)) {
    fileFor.set(name, `src/visualization/workbench/plugins/finance/${file}`);
  }

  // id → the identifier the descriptor names, read from the FINANCE_PLUGINS literal.
  //
  // This cannot go through `component.name`: six panels (mc-config, opt-config, the three
  // results panes, host-pane) are produced by the `hostPanePlugin()` FACTORY, so every one
  // of them reports the class name `HostPanePlugin` and would resolve to the same wrong
  // file — or, since nothing imports that name, to none at all. The binding in the
  // descriptor is the only thing that distinguishes them.
  const identFor = new Map();
  for (const [, id, ident] of pkgSource
    .matchAll(/\{\s*id:\s*'([^']+)'[^}]*?component:\s*([A-Za-z0-9_]+)\s*[,}]/g)) {
    identFor.set(id, ident);
  }

  // Which pane the default layout opens each tab in, and whether it is open at all.
  const pane = new Map();
  for (const [key, val] of Object.entries(FINANCE_DEFAULT_LAYOUT)) {
    for (const tab of val?.tabs ?? []) pane.set(tab, key);
  }

  return FINANCE_PLUGINS.map(p => ({
    id:          p.id,
    title:       p.title,
    category:    p.category    ?? null,
    defaultPane: p.defaultPane ?? null,
    layoutPane:  pane.get(p.id) ?? null,
    component:   identFor.get(p.id) ?? p.component?.name ?? null,
    source:      fileFor.get(identFor.get(p.id)) ?? null,
  }));
}

/* ─────────────────────────────── actions ─────────────────────────────── */

/** Every toolset object exported from `src/scenarios/toolsets/*-toolset.js`. */
export async function loadToolsets() {
  const dir   = `${ROOT}/src/scenarios/toolsets`;
  const found = [];
  for (const file of readdirSync(dir).filter(f => f.endsWith('-toolset.js')).sort()) {
    const mod = await import(`${dir}/${file}`);
    for (const value of Object.values(mod)) {
      if (value && typeof value === 'object' && typeof value.id === 'string' && value.types) {
        found.push({ toolset: value, source: `src/scenarios/toolsets/${file}` });
      }
    }
  }
  return found;
}

/**
 * The journal action surface: every declared action type and the shape of its payload.
 *
 * A type declared by more than one toolset is ONE entry listing both — the toolsets are
 * composed into a single run, so two declarations of `SPENDING_STRATEGY_APPLY` are one
 * action in the journal, and printing it twice would misdescribe the ledger.
 */
export async function collectActions() {
  const byType = new Map();
  for (const { toolset, source } of await loadToolsets()) {
    for (const action of toolset.types?.actions ?? []) {
      if (!action?.type) continue;
      const entry = byType.get(action.type) ?? {
        type: action.type, fields: {}, declaredBy: [], sources: [],
      };
      for (const [name, vt] of Object.entries(action.fields ?? {})) {
        entry.fields[name] = vt?.kind
          ? (vt.opts?.code ? `${vt.kind}(${vt.opts.code})` : vt.kind)
          : 'unknown';
      }
      if (!entry.declaredBy.includes(toolset.id)) entry.declaredBy.push(toolset.id);
      if (!entry.sources.includes(source))        entry.sources.push(source);
      byType.set(action.type, entry);
    }
  }
  return [...byType.values()].sort((a, b) => a.type.localeCompare(b.type));
}

/* ──────────────────────────────── tools ──────────────────────────────── */

const TOOL_DIRS = ['scenario', 'lab', 'montecarlo', 'probes', 'tax', 'dev', 'config-converters'];

/**
 * Pull the one-line purpose out of a script's docblock.
 *
 * Every entry point in `scripts/` follows the same convention: a licence comment, then a
 * second block opening `<name>.mjs — <purpose>.` That first sentence is the authoritative
 * one-liner the same way a param's `description` is, so it is harvested rather than
 * re-authored — which is the whole point of tier 1.
 */
export function purposeFromDocblock(text, basename) {
  // Two conventions are in use and both are correct: `name.mjs — purpose.` on one line
  // (frontier.mjs) and `name.mjs`, a blank line, then the prose (run-scenario.mjs).
  // Python converters carry a module docstring with no name line at all.
  const blocks = [
    ...[...text.matchAll(/\/\*\*([\s\S]*?)\*\//g)].map(m => m[1]
      .split('\n').map(l => l.replace(/^\s*\*\s?/, '')).join('\n')),
    ...(basename.endsWith('.py')
      ? [...text.matchAll(/"""([\s\S]*?)"""/g)].map(m => m[1]) : []),
  ];

  const firstSentence = (s) => {
    const cut = s.split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
    const dot = cut.search(/\.(\s|$)/);
    return (dot > 0 ? cut.slice(0, dot) : cut).trim();
  };

  for (const block of blocks) {
    const lines = block.split('\n');
    const idx   = lines.findIndex(l => l.trim());
    if (idx < 0) continue;
    const first = lines[idx].trim();

    // Some blocks name the file without its extension (shock-path-engine.mjs).
    const stem  = basename.replace(/\.[^.]+$/, '');
    const named = [basename, stem].find(n => first.startsWith(n));
    if (!named) {
      // A .py docstring has no name line, so its opening prose IS the purpose.
      if (basename.endsWith('.py')) { const o = firstSentence(block.trim()); if (o) return o; }
      continue;
    }
    // Same line after a dash, else the prose that follows the name line.
    const inline = first.slice(named.length).replace(/^\s*[—–-]\s*/, '').trim();
    const out    = firstSentence(inline || lines.slice(idx + 1).join('\n').trim());
    if (out) return out;
  }
  return null;
}

/**
 * Does this file parse a command line, or is it a module something else imports?
 *
 * `scripts/` holds both — `lab/sequence-risk/arms.mjs` and `scenario.mjs` are shared
 * definitions, not things you run. D6 says every ENTRY POINT declares its flags; a module
 * has no command line to declare, so counting it as missing a spec would make the gate's
 * number permanently unreachable. Reading argv is the honest test: it is precisely what
 * makes a file something you can mistype a flag at.
 */
export function isEntryPoint(text) {
  return /process\.argv|parseFlags/.test(text);
}

/**
 * The `parseFlags` spec, read from the source rather than by running the script.
 *
 * Design 108 D6 put every entry point on it. A script that contributes `flags: null` is
 * therefore a real finding — a new tool that skipped the spec — and what the gate counts.
 * A declared `positional:` comes back as its own field rather than a flag named
 * "positional", because it is not spelled `--positional` on the command line.
 */
export function flagsFromSource(text) {
  return specFromSource(text).flags;
}

/** @returns {{flags: object[]|null, positional: object|null}} */
export function specFromSource(text) {
  const none = { flags: null, positional: null };
  let ast;
  try { ast = parse(text, { sourceType: 'module', errorRecovery: true }); }
  catch { return none; }

  let spec = null;
  const walk = (node) => {
    if (!node || typeof node !== 'object' || spec) return;
    if (node.type === 'CallExpression'
        && /^parseFlags(OrThrow)?$/.test(node.callee?.name ?? '')) {
      spec = node.arguments.find(a => a.type === 'ObjectExpression') ?? null;
      if (spec) return;
    }
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(walk);
      else if (child && typeof child.type === 'string') walk(child);
    }
  };
  walk(ast.program);
  if (!spec) return none;

  const literal = (n) => (n?.type === 'StringLiteral' || n?.type === 'NumericLiteral'
    ? n.value
    : n?.type === 'BooleanLiteral' ? n.value
    : n?.type === 'ArrayExpression' ? n.elements.map(literal)
    : n?.type === 'NullLiteral' ? null : undefined);

  const flags = [];
  let positional = null;
  for (const prop of spec.properties) {
    const name = prop.key?.name ?? prop.key?.value;
    if (!name || name === 'usage') continue;
    const cfg = {};
    for (const p of prop.value?.properties ?? []) {
      const k = p.key?.name ?? p.key?.value;
      if (k) cfg[k] = literal(p.value);
    }
    const entry = {
      name:    (cfg.name ?? name).replace(/[A-Z]/g, c => `-${c.toLowerCase()}`),
      type:    cfg.type ?? null,
      default: cfg.default ?? null,
      choices: cfg.choices ?? null,
      help:    cfg.help ?? null,
    };
    if (name === 'positional') {
      positional = { ...entry, variadic: cfg.variadic ?? false, required: cfg.required ?? false };
    } else {
      flags.push(entry);
    }
  }
  return { flags, positional };
}

/** Every headless entry point under `scripts/`, with its purpose and flag spec. */
export function collectTools(pkgScripts = {}) {
  // npm script name → the file it runs, so the reference prints `npm run sweep` where one
  // exists rather than a path the user then has to translate.
  const npmFor = new Map();
  for (const [name, cmd] of Object.entries(pkgScripts)) {
    const m = cmd.match(/(scripts\/[\w./-]+\.(?:mjs|js))/);
    if (m && !npmFor.has(m[1])) npmFor.set(m[1], name);
  }

  const tools = [];
  for (const dir of TOOL_DIRS) {
    const abs = join(ROOT, 'scripts', dir);
    let entries;
    try { entries = readdirSync(abs, { recursive: true }); } catch { continue; }
    for (const rel of entries) {
      const path = join(abs, String(rel));
      if (!/\.(mjs|js|py)$/.test(path) || !statSync(path).isFile()) continue;
      const repoPath = relative(ROOT, path);
      const basename = repoPath.split('/').pop();
      const text     = readFileSync(path, 'utf8');
      const js       = !basename.endsWith('.py');
      const spec     = js ? specFromSource(text) : { flags: null, positional: null };
      tools.push({
        path:       repoPath,
        group:      dir,
        npmScript:  npmFor.get(repoPath) ?? null,
        purpose:    purposeFromDocblock(text, basename),
        // `entryPoint` gates the D6 count: only a JS file that reads a command line can
        // carry a `parseFlags` spec. A module has no command line; the two Python
        // converters have one but not this parser.
        entryPoint: js && isEntryPoint(text),
        lang:       js ? 'js' : 'py',
        flags:      spec.flags,
        positional: spec.positional,
      });
    }
  }
  return tools.sort((a, b) => a.path.localeCompare(b.path));
}

/* ──────────────────────────────── state ──────────────────────────────── */

/**
 * The scenario-INDEPENDENT half of the state schema: the globs and exact paths the
 * registry installs in its own constructor.
 *
 * Per-account paths (`registerAccount`) are deliberately absent — they are a property of
 * a loaded plan, not of the framework, and a reference that listed one plan's accounts
 * would be wrong for every other plan.
 */
export async function collectState() {
  const { StateSchemaRegistry } = await import(
    `${ROOT}/src/finance/services/state-schema-registry.js`);
  const reg = new StateSchemaRegistry();

  const kind = (vt) => (vt?.currencyCode ? `${vt.kind}(${vt.currencyCode})` : vt?.kind ?? 'unknown');

  return [
    ...reg._patterns.map(p => ({ path: p.glob, exact: false, kind: kind(p.vt) })),
    ...[...reg._exact.entries()].map(([path, vt]) => ({ path, exact: true, kind: kind(vt) })),
  ].sort((a, b) => a.path.localeCompare(b.path));
}

/* ──────────────────────────────── design ─────────────────────────────── */

/**
 * Tier 3 — every design document, with its own H1 as its title (design 108 §11 phase 6).
 *
 * This collector exists because of the OTHER two rows of §2.1. The README's design list
 * covered `0-` through `19-` of 117 files and `design/README.md` covered 10, and both
 * drifted the same way the plugin table did: a design doc was added, and nothing failed
 * when the list was not updated. Nothing here is written down — the title is read out of
 * the file, so a doc added tomorrow is listed the next time this runs.
 *
 * NOT a summary. A one-line precis of an argument is a second copy of that argument, and
 * a design doc's argument changes without its filename changing, which is the exact shape
 * that rotted the old list. A reader gets the title and the path; the doc says the rest.
 *
 * Sorted NUMERICALLY, because these are a numbered series: lexicographic order puts 100
 * between 10 and 11 and makes the list unreadable at exactly the size it now is. The five
 * unnumbered files sort last, by name.
 */
export function collectDesign(root = ROOT) {
  const dir = join(root, 'design');
  return readdirSync(dir)
    .filter(f => f.endsWith('.md') && f !== 'README.md')   // README.md is the index, not a design doc
    .map((file) => {
      const text  = readFileSync(join(dir, file), 'utf8');
      const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
      return { path: file, number: /^\d+/.test(file) ? parseInt(file, 10) : null, title };
    })
    .sort((a, b) => (a.number === null) - (b.number === null)
      || (a.number ?? 0) - (b.number ?? 0)
      || a.path.localeCompare(b.path));
}

/* ──────────────────────────────── topics ─────────────────────────────── */

/**
 * Tier 2, resolved: every hand-written topic under `help/`, with its markdown already
 * rendered to HTML (design 108 §8, D2).
 *
 * Pre-rendering here rather than in the browser is what keeps the in-app panel free of a
 * runtime markdown dependency: `marked` is a devDependency, it runs once per build, and
 * the browser receives HTML it only has to insert. Nothing about the topic tree is
 * re-described — the frontmatter reader the GATE uses is the same one, so a topic the
 * gate accepts is a topic the panel can render, and one it rejects cannot silently ship.
 *
 * `help-topics.mjs` imports `ROOT` from this file, so this import is DYNAMIC: a static
 * one would make the pair a cycle, and `ROOT` is evaluated at module top level.
 *
 * Relative `*.md` links between topics are left exactly as authored. Rewriting them to
 * ids here would bake a navigation scheme into the index; the panel resolves them at
 * click time instead, and the same link keeps working when the file is read on disk.
 */
export async function collectTopics() {
  const { readTopics } = await import('./help-topics.mjs');
  const { marked }     = await import('marked');

  return readTopics()
    .filter(t => !t.error && t.id)
    .map(t => ({
      id:      t.id,
      kind:    t.kind,
      title:   t.title,
      path:    t.path,
      panels:  t.panels,
      params:  t.params,
      actions: t.actions,
      tools:   t.tools,
      design:  t.design,
      words:   t.words,
      node:    t.node ?? null,
      // A node topic's HTML is its OVERVIEW only. Its `## Fields` entries are already in
      // `nodes[]`, keyed per field, which is how the tooltip and the `?` get at one of
      // them; rendering the list here as well would put the same prose on the page twice.
      html:    marked.parse((t.kind === 'node' ? t.overview : t.body).trim(), { async: false }),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/* ──────────────────────────────── index ──────────────────────────────── */

/** The whole tier-1 index. Deterministic: same tree in, byte-identical index out. */
export async function buildHelpIndex() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const [params, panels, actions, state, topics, nodes] = await Promise.all([
    collectParams(), collectPanels(), collectActions(), collectState(), collectTopics(),
    collectNodes(),
  ]);
  const tools  = collectTools(pkg.scripts);
  const design = collectDesign();

  return {
    counts: {
      params: params.length, panels: panels.length, actions: actions.length,
      tools: tools.length,
      // D6 counts ENTRY POINTS. A module under `scripts/` has no command line to declare,
      // so including it would put the target permanently out of reach.
      entryPoints:    tools.filter(t => t.entryPoint).length,
      toolsWithFlags: tools.filter(t => t.entryPoint && (t.flags || t.positional)).length,
      state: state.length,
      topics: topics.length,
      design: design.length,
      nodes: nodes.length,
      nodeFields: nodes.reduce((n, k) => n + k.fields.length, 0),
    },
    params, panels, actions, tools, state, topics, design, nodes,
  };
}

/* ──────────────────────────────── nodes ──────────────────────────────── */

/**
 * The record-param templates that already describe a field, by node kind (design 111 §2).
 *
 * `RECORD_PARAM_TEMPLATES` names which record fields become generated params, and every
 * one of those entries carries a `description` written for the Parameters panel. Those
 * descriptions read correctly as field help — "Current market value of this property." is
 * the same sentence either way — so tier 1 supplies them and a topic MAY NOT restate them.
 * That is design 108's rule, not a new one: nothing is written at two tiers.
 */
async function recordParamDescriptions() {
  const t = await import(`${ROOT}/src/scenarios/params/record-param-templates.js`);
  const flat = (v) => (Array.isArray(v) ? v : Object.values(v ?? {}).flat());
  const byKind = {
    person:          flat(t.PERSON_PARAM_TEMPLATE),
    account:         [...flat(t.ACCOUNT_PARAM_TEMPLATES), ...flat(t.INHERITED_RA_PARAM_TEMPLATE)],
    'real-property': flat(t.REAL_PROPERTY_PARAM_TEMPLATE),
    collectible:     flat(t.COLLECTIBLE_PARAM_TEMPLATE),
    company:         flat(t.COMPANY_EQUITY_PARAM_TEMPLATE),
    bequest:         flat(t.BEQUEST_PARAM_TEMPLATE),
  };
  const out = new Map();
  for (const [kind, entries] of Object.entries(byKind)) {
    const m = new Map();
    for (const e of entries) {
      // `hidden` templates (balanceTarget) are compile-only levers with no control on any
      // form, and the ones without a description are not a source of prose.
      if (!e?.field || !e.description || e.hidden) continue;
      if (!m.has(e.field)) m.set(e.field, { description: e.description, label: e.label ?? null });
    }
    out.set(kind, m);
  }
  return out;
}

/** Text of an HTML fragment: tags dropped, entities un-escaped, whitespace collapsed. */
function _text(html) {
  return String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/**
 * The editable controls of one `<template>` in `index.html`, in document order.
 *
 * Read out of the same file `BaseComponent._getTemplate()` clones at runtime, so this is
 * the form itself rather than a description of it: a field added to the markup appears
 * here on the next build, which is what makes the gate's "undocumented field" error fire
 * without anyone having remembered anything.
 *
 * A control names its field with `data-id` (the record's own fields) or `data-field` (the
 * per-subtype config sub-editors) — both are used, and which one is not a fact about the
 * field. Buttons and the `<div data-id="config">` sub-editor mounts are not controls.
 */
export function templateFields(html, templateId) {
  const body = html.match(
    new RegExp(`<template id="${templateId}">([\\s\\S]*?)</template>`))?.[1];
  if (body == null) return null;

  const fields = [];
  let label = null;
  for (const m of body.matchAll(
    /<label\b[^>]*>([\s\S]*?)<\/label>|<(input|select|textarea)\b([^>]*)>/g)) {
    if (m[1] !== undefined) { label = _text(m[1]) || label; continue; }

    const [, , tag, attrs] = m;
    const field = attrs.match(/\bdata-(?:id|field)="([^"]+)"/)?.[1];
    if (!field) continue;
    const type = attrs.match(/\btype="([^"]+)"/)?.[1] ?? (tag === 'input' ? 'text' : tag);
    if (type === 'button' || type === 'submit' || type === 'hidden') continue;
    fields.push({ field, label, inputType: type, template: templateId });
  }
  return fields;
}

/**
 * Tier 1 for the node edit forms: every kind, and every field its form offers
 * (design 111 §3).
 *
 * The inventory comes from the form, never from prose: HTML templates for the nine
 * template-driven editors, and an exported spec array for the two that build their rows in
 * JS. The DESCRIPTION comes from exactly one of two places — a record param template
 * (tier 1, above) or the kind's `kind: node` topic (tier 2) — and `describedBy` records
 * which, so the gate can insist it is exactly one and never both.
 *
 * A field with no description at all comes back `describedBy: null`. That is not papered
 * over with a placeholder: it is the state the gate fails on, and half the surface was in
 * it when design 111 started.
 */
export async function collectNodes() {
  const { NODE_EDITORS } = await import(
    `${ROOT}/src/visualization/configuration/node-editor-registry.js`);
  const { readTopics } = await import('./help-topics.mjs');

  const html      = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const paramDesc = await recordParamDescriptions();
  const topicFor  = new Map(readTopics()
    .filter(t => !t.error && t.kind === 'node' && t.node)
    .map(t => [t.node, t]));

  const nodes = [];
  for (const [kind, entry] of Object.entries(NODE_EDITORS)) {
    const raw = [];
    for (const id of entry.templates ?? []) {
      const found = templateFields(html, id);
      if (found === null) throw new Error(`NODE_EDITORS.${kind}: no <template id="${id}"> in index.html`);
      raw.push(...found);
    }
    for (const spec of entry.specs ?? []) {
      const [file, name] = spec.module.split('#');
      const mod = await import(`${ROOT}/${file}`);
      if (!mod[name]) throw new Error(`NODE_EDITORS.${kind}: ${file} exports no ${name}`);
      raw.push(...mod[name].map(e => ({
        field: e.field, label: e.label, inputType: e.kind ?? 'text', template: null,
        // The id the control actually carries in the DOM, which is what the in-app
        // decorator matches on. The payroll section prefixes its own (`pe_`), and a field
        // is not renamed by where it happens to be rendered.
        domId: `${spec.idPrefix ?? ''}${e.field}`,
      })));
    }

    const params = paramDesc.get(kind) ?? new Map();
    const topic  = topicFor.get(kind) ?? null;

    // First occurrence wins. A field named by two sub-editors — `fieldName` appears in
    // four of the Action sub-editors — is ONE field of this form, and printing it four
    // times would invite four descriptions of the same box.
    const seen = new Map();
    for (const f of raw) {
      if (seen.has(f.field)) continue;
      const fromParam = params.get(f.field)?.description ?? null;
      const fromTopic = topic?.fields?.[f.field] ?? null;
      seen.set(f.field, {
        domId: f.field,
        ...f,
        param:       fromParam ? true : false,
        description: fromParam ?? fromTopic ?? null,
        describedBy: fromParam ? 'param' : fromTopic ? 'topic' : null,
      });
    }

    nodes.push({
      kind,
      label:  entry.label,
      topic:  topic?.id ?? null,
      fields: [...seen.values()],
    });
  }
  return nodes;
}
