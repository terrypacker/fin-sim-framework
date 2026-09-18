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
 * help-render.mjs — render the tier-1 index as `help/REFERENCE.md` (design 108 §7).
 *
 * This file is written for two readers and the format is a compromise neither would pick
 * alone. An LLM driving the app headlessly wants the whole surface in ONE read, so there
 * is no pagination and no cross-file indirection. A human reviewing a pull request wants
 * a legible diff, so every fact sits on its own line: changing one param's description
 * changes exactly one line here, which is the review signal design 108 §4 is built on.
 *
 * That second requirement is why descriptions are never put in table cells. A 1,901-character
 * description (the longest in the schema) in a cell is unreadable, and re-wrapping one would
 * rewrite unrelated lines in the diff.
 */

/**
 * Markdown-escape a description harvested from source.
 *
 * Only the dollar sign matters in practice: a pair of them on one line renders as LaTeX
 * math in most viewers, so `"die with zero, or with $XX"` silently swallows the rest of
 * the sentence. Three descriptions contain one today.
 */
const esc = (s) => String(s ?? '').replace(/\$/g, '\\$').replace(/\s+/g, ' ').trim();

/** Table-cell-safe: pipes would open a new column. */
const cell = (s) => esc(s).replace(/\|/g, '\\|');

const code = (v) => (v === null || v === undefined || v === '' ? '—' : `\`${String(v).replace(/`/g, "'")}\``);

function renderParams(params) {
  const groups = new Map();
  for (const p of params) {
    const g = p.group ?? '(ungrouped)';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  }

  const out = [`## Parameters (${params.length})`, '',
    'Every configurable parameter, from `IntlRetirementScenario.buildFullParamSchema()`.',
    'A **sweep** column entry means the param is exposed to that engine: `mc` to Monte Carlo,',
    '`opt` to the optimizer. `via` names the toolset that contributed it (`SCENARIO` = the',
    'scenario\'s own schema), which is where to go to change it.', ''];

  for (const [group, entries] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push(`### ${group} (${entries.length})`, '');
    for (const p of [...entries].sort((a, b) => a.key.localeCompare(b.key))) {
      const bits = [`\`${p.type ?? '?'}\``, `default ${code(p.defaultValue)}`];
      if (p.defaultCurrency)        bits.push(p.defaultCurrency);
      if (p.min != null || p.max != null) bits.push(`range ${p.min ?? '−∞'}…${p.max ?? '∞'}`);
      if (p.options?.length)        bits.push(`one of ${p.options.map(o => code(o)).join(', ')}`);
      const sweep = [p.mc && 'mc', p.opt && 'opt'].filter(Boolean).join('+');
      if (sweep)                    bits.push(`sweep: ${sweep}`);
      if (p.visibleWhen)            bits.push('conditional');
      bits.push(`via ${p.contributedBy ?? '?'}`);

      out.push(`- **\`${p.key}\`** — ${esc(p.label ?? p.key)} · ${bits.join(' · ')}`);
      if (p.description) out.push(`  ${esc(p.description)}`);
    }
    out.push('');
  }
  return out;
}

function renderPanels(panels) {
  const out = [`## Workbench panels (${panels.length})`, '',
    'From `FINANCE_PLUGINS`. **Pane** is where the default layout opens the tab.',
    'Every `category` is empty because these descriptors are plain object literals that',
    'never pass through `definePlugin()`, so the SDK defaults are never applied — that is a',
    'true statement about the registry, not a gap in this file.', '',
    '| id | title | pane | source |', '|---|---|---|---|'];
  for (const p of panels) {
    out.push(`| \`${p.id}\` | ${cell(p.title)} | ${p.layoutPane ?? '—'} | ${p.source ? `\`${p.source}\`` : '—'} |`);
  }
  out.push('');
  return out;
}

function renderActions(actions) {
  const out = [`## Journal action types (${actions.length})`, '',
    'Every action a toolset declares, with its payload shape. A type declared by more than',
    'one toolset is one row: the toolsets compose into a single run, so it is one action in',
    'the journal. Reducers that CONSUME each type are deliberately not listed — see design',
    '108 D7.', '',
    '| type | payload | declared by |', '|---|---|---|'];
  for (const a of actions) {
    const fields = Object.entries(a.fields).map(([n, k]) => `${n}: ${k}`).join(', ') || '—';
    out.push(`| \`${a.type}\` | ${cell(fields)} | ${a.declaredBy.join(', ')} |`);
  }
  out.push('');
  return out;
}

function renderTools(tools) {
  const byGroup = new Map();
  for (const t of tools) {
    if (!byGroup.has(t.group)) byGroup.set(t.group, []);
    byGroup.get(t.group).push(t);
  }
  const missing = tools.filter(t => !t.purpose).length;
  const entry   = tools.filter(t => t.entryPoint);
  const onSpec  = entry.filter(t => t.flags || t.positional);

  const out = [`## Headless tools (${tools.length})`, '',
    'Command-line entry points under `scripts/`. **Purpose** is harvested from each script\'s',
    'docblock, not re-authored here. Arguments come from each script\'s declarative',
    `\`parseFlags\` spec: ${onSpec.length} of ${entry.length} entry points carry one`
      + `${onSpec.length === entry.length ? ' (design 108 D6 — all of them).'
        : ', and design 108 D6 migrates the rest.'}`,
    missing ? `${missing} scripts carry no docblock naming themselves and show \`(undocumented)\`.` : '', ''];

  for (const [group, entries] of [...byGroup].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push(`### scripts/${group}/`, '');
    for (const t of entries) {
      const run = t.npmScript ? ` — \`npm run ${t.npmScript}\`` : '';
      out.push(`- **\`${t.path}\`**${run}`);
      out.push(`  ${t.purpose ? esc(t.purpose) : '_(undocumented — no docblock names this file)_'}`);
      if (t.positional) {
        const p    = t.positional;
        const meta = [p.type, p.variadic ? 'repeatable' : null, p.required ? 'required' : null,
          p.default != null ? `default ${code(p.default)}` : null,
          p.choices?.length ? `one of ${p.choices.join('|')}` : null].filter(Boolean).join(', ');
        out.push(`    - \`<${p.name}>\` (${meta})${p.help ? ` — ${esc(p.help)}` : ''}`);
      }
      for (const f of t.flags ?? []) {
        const meta = [f.type, f.default != null ? `default ${code(f.default)}` : null,
          f.choices?.length ? `one of ${f.choices.join('|')}` : null].filter(Boolean).join(', ');
        out.push(`    - \`--${f.name}\` (${meta || 'flag'})${f.help ? ` — ${esc(f.help)}` : ''}`);
      }
    }
    out.push('');
  }
  return out;
}

function renderState(state) {
  const out = [`## State field types (${state.length})`, '',
    'The scenario-INDEPENDENT half of `StateSchemaRegistry`: the globs and exact paths it',
    'installs in its own constructor, with the value type that decides how each formats.',
    'Per-account paths are absent by design — they belong to a loaded plan, not to the',
    'framework, so listing one plan\'s accounts would be wrong for every other plan.', '',
    '| path | kind |', '|---|---|'];
  for (const s of state) out.push(`| \`${s.path}\` | ${s.kind} |`);
  out.push('');
  return out;
}

function renderTopics(topics) {
  const out = [`## Topics (${topics.length})`, '',
    'Tier 2 — the hand-written prose under `help/`, listed by what it CITES rather than',
    'summarised. A topic may not restate a param description (design 108 §3), so there is',
    'nothing here to duplicate: the row points at the file, and the file says the thing',
    'tier 1 cannot. **Cites** is the frontmatter, which is also what the gate checks and',
    'what the in-app panel keys on.', '',
    '| topic | kind | words | cites |', '|---|---|---|---|'];
  for (const t of topics) {
    const cites = [
      t.panels.length  && `${t.panels.length} panel${t.panels.length > 1 ? 's' : ''}`,
      t.params.length  && `${t.params.length} param${t.params.length > 1 ? 's' : ''}`,
      t.actions.length && `${t.actions.length} action${t.actions.length > 1 ? 's' : ''}`,
      t.tools.length   && `${t.tools.length} tool${t.tools.length > 1 ? 's' : ''}`,
      t.design.length  && `design ${t.design.map(d => d.split('-')[0]).join(', ')}`,
    ].filter(Boolean).join(' · ') || '—';
    out.push(`| [${cell(t.title)}](${t.path.replace(/^help\//, '')}) | ${t.kind} | ${t.words} | ${cites} |`);
  }
  out.push('');
  return out;
}

function renderDesign(design) {
  const out = [`## Design documents (${design.length})`, '',
    'Tier 3 — the full argument behind each mechanic, in `design/`. The title is each',
    'file\'s own H1, read out of it; there is no summary column, because a one-line precis',
    'of an argument is a second copy of that argument and the argument is what changes.',
    'Numbered order, not alphabetical: this is a series, and sorting it as text puts 100',
    'between 10 and 11.', '',
    '| doc | title |', '|---|---|'];
  for (const d of design) {
    out.push(`| [\`${d.path}\`](../design/${d.path}) | ${cell(d.title ?? '_(no title)_')} |`);
  }
  out.push('');
  return out;
}

/** The whole reference, as one markdown document. */
export function renderReferenceMarkdown(index) {
  const c = index.counts;
  return [
    '# FinSim reference',
    '',
    '**Generated — do not edit.** Every fact below is read out of the source by',
    '`scripts/dev/build-help-index.mjs`; run `npm run help:build` to regenerate it. Editing',
    'this file by hand creates exactly the second copy that design 108 §2.1 exists to kill.',
    '',
    'This is tier 1 of the help system (design 108): the complete, exact surface, with no',
    'prose about it. For *why* a mechanic exists and when to reach for it, follow the design',
    'doc named in the relevant parameter description, or read the tier-2 topic under `help/`',
    'that cites it — the last section of this file lists every one.',
    '',
    `${c.params} parameters · ${c.panels} panels · ${c.actions} action types · ${c.tools} tools · ${c.state} state field types · ${c.topics} topics · ${c.design} design docs`,
    '',
    '---',
    '',
    ...renderParams(index.params),
    '---', '',
    ...renderPanels(index.panels),
    '---', '',
    ...renderTools(index.tools),
    '---', '',
    ...renderActions(index.actions),
    '---', '',
    ...renderState(index.state),
    '---', '',
    ...renderTopics(index.topics),
    '---', '',
    ...renderDesign(index.design),
  ].join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}
