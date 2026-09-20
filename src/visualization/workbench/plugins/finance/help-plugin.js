/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { WorkbenchComponent } from '../../component.js';
import { WB_EVENTS }          from '../../workbench-runtime.js';
import { loadHelpIndex }      from '../../../help/help-index-source.js';

/**
 * Help — the in-app half of the design-108 help system (§8).
 *
 * Two jobs, and they are the two failure modes §1 records:
 *
 * 1. **Panels have no documentation.** This panel follows the active tab
 *    (`WB_EVENTS.TAB_ACTIVATED`) and renders that panel's tier-2 topic with no user
 *    action at all. Help you have to go and ask for is help nobody reads.
 * 2. **The tooltip truncates.** Param descriptions run to 1,901 characters and arrive as
 *    a native browser tooltip, which cuts them off. The `?` beside a param label
 *    publishes `WB_EVENTS.HELP_OPEN` and the whole description lands here, laid out, next
 *    to the default, the range, the sweepability, the owning toolset, and every topic
 *    that cites it. Design 111 extended the same `?` to every control on a node EDIT FORM,
 *    which had the identical problem and, for half its ~164 fields, no tooltip at all.
 *
 * ### It renders, it does not author
 *
 * Everything shown comes from `public/help/help-index.json`, which the generator writes
 * from the registries and from `help/*.md` (design 108 §4, D2). Markdown is already HTML
 * by the time it gets here: there is no markdown renderer in the browser bundle, no
 * runtime dependency, and no path by which untrusted text reaches `innerHTML` — the only
 * HTML inserted is what `marked` produced at build time from files in this repo.
 *
 * The index is a GITIGNORED build artifact, so a checkout that has never run a build has
 * none. That is a real state, not an error state, and it renders as a line telling you to
 * run `npm run help:build` rather than as an empty panel that looks broken.
 */
export class HelpPlugin extends WorkbenchComponent {
  /**
   * @param {object} runtime — the WorkbenchRuntime; its bus carries TAB_ACTIVATED/HELP_OPEN.
   * @param {{ index?: object }} [opts] — a pre-loaded index, which is how tests avoid
   *   `fetch`. Production passes nothing and the panel loads the JSON on first mount.
   */
  constructor(runtime, { index = null } = {}) {
    super();
    this._runtime = runtime;
    this._index   = index;
    this._view    = null;          // { kind: 'topic'|'param'|'panel'|'group'|'node'|'nodeField', key }
    this._history = [];            // previous views, for the back button
  }

  render() {
    const root = document.createElement('div');
    root.className = 'wb-plugin-fill help-plugin';
    root.innerHTML = `
      <div class="help-nav">
        <button class="help-back wb-btn" type="button" title="Back" disabled>←</button>
        <span class="help-crumb" data-id="crumb">Help</span>
      </div>
      <div class="help-body" data-id="body"></div>
    `;
    return root;
  }

  onInit() {
    // The panel follows the workbench even while it is CLOSED: subscriptions are made at
    // init and survive unmount, so re-opening the tab shows where you actually are rather
    // than where you were when you last closed it.
    this._runtime.bus.subscribe(WB_EVENTS.TAB_ACTIVATED, ({ tab }) => {
      // Activating Help itself must not blow away what Help was asked to show. The `?`
      // affordance publishes HELP_OPEN and then activates this tab, and without this the
      // activation would arrive last and overwrite the param with this panel's own topic.
      if (tab === 'help') return;
      this._go({ kind: 'panel', key: tab }, { replace: true });
    });

    this._runtime.bus.subscribe(WB_EVENTS.HELP_OPEN, ({ param, group, topic, node, field }) => {
      if (param)      this._go({ kind: 'param', key: param });
      else if (group) this._go({ kind: 'group', key: group });
      else if (node && field) this._go({ kind: 'nodeField', key: `${node}.${field}` });
      else if (node)  this._go({ kind: 'node', key: node });
      else if (topic) this._go({ kind: 'topic', key: topic });
    });
  }

  onMount() {
    this.el.querySelector('.help-back').addEventListener('click', () => this._back());

    // One delegated listener rather than one per link: the body is replaced on every
    // navigation, so per-link listeners would have to be re-attached each time.
    this.el.querySelector('[data-id="body"]').addEventListener('click', (e) => this._onBodyClick(e));

    if (!this._view && this._runtime.activeTab?.tab && this._runtime.activeTab.tab !== 'help') {
      this._view = { kind: 'panel', key: this._runtime.activeTab.tab };
    }
    this._ensureIndex().then(() => this._paint());
  }

  // ── The index ───────────────────────────────────────────────────────────────

  /**
   * The index, once per session — shared with the node-field decorator, which shows the
   * SAME descriptions as tooltips and must not be able to disagree with this panel.
   * Resolves to null rather than rejecting when there is none; see `_paint`.
   */
  _ensureIndex() {
    return loadHelpIndex(this._index).then((idx) => { this._index = idx; return idx; });
  }

  // ── Navigation ──────────────────────────────────────────────────────────────

  /**
   * Show a view.
   *
   * `replace` is for views the USER did not ask for — following the active tab. Pushing
   * those onto the history would make Back walk the tabs you happened to click through,
   * which is not what anyone means by back in a help panel.
   */
  _go(view, { replace = false } = {}) {
    if (this._view && !replace) this._history.push(this._view);
    this._view = view;
    this._ensureIndex().then(() => this._paint());
  }

  _back() {
    if (!this._history.length) return;
    this._view = this._history.pop();
    this._paint();
  }

  _onBodyClick(e) {
    const a = e.target.closest('a');
    if (!a) return;

    const param     = a.dataset.helpParam;
    const topic     = a.dataset.helpTopic;
    const group     = a.dataset.helpGroup;
    const node      = a.dataset.helpNode;
    const nodeField = a.dataset.helpNodeField;
    if (param || topic || group || node || nodeField) {
      e.preventDefault();
      this._go(param     ? { kind: 'param', key: param }
             : group     ? { kind: 'group', key: group }
             : nodeField ? { kind: 'nodeField', key: nodeField }
             : node      ? { kind: 'node', key: node }
             :             { kind: 'topic', key: topic });
      return;
    }

    // A relative `*.md` link between topics, exactly as it was authored. Resolved by
    // basename: every topic id matches its filename, and leaving the href untouched in
    // the index keeps the same link working when the file is read on disk.
    const href = a.getAttribute('href') ?? '';
    if (!href.endsWith('.md')) return;
    e.preventDefault();
    const id = href.split('/').pop().replace(/\.md$/, '');
    if (this._topic(id)) this._go({ kind: 'topic', key: id });
  }

  // ── Lookups ─────────────────────────────────────────────────────────────────

  _topic(id)        { return this._index?.topics?.find(t => t.id === id) ?? null; }
  _panel(id)        { return this._index?.panels?.find(p => p.id === id) ?? null; }
  _param(key)       { return this._index?.params?.find(p => p.key === key) ?? null; }
  _node(kind)       { return this._index?.nodes?.find(n => n.kind === kind) ?? null; }
  /** The `kind: panel` topic that claims a panel id — what the gate guarantees exists. */
  _topicForPanel(id) {
    return this._index?.topics?.find(t => t.kind === 'panel' && t.panels?.includes(id)) ?? null;
  }
  /** Every topic citing a param, of any kind — a param is usually explained by a concept. */
  _topicsForParam(key) {
    return this._index?.topics?.filter(t => t.params?.includes(key)) ?? [];
  }

  // ── Painting ────────────────────────────────────────────────────────────────

  _paint() {
    if (!this.el) return;
    const body  = this.el.querySelector('[data-id="body"]');
    const crumb = this.el.querySelector('[data-id="crumb"]');
    const back  = this.el.querySelector('.help-back');
    back.disabled = this._history.length === 0;

    if (!this._index) {
      crumb.textContent = 'Help';
      body.innerHTML = `<p class="help-empty">No help index. Run <code>npm run help:build</code>
        — <code>public/help/help-index.json</code> is a build artifact and is not committed.</p>`;
      return;
    }

    const v = this._view;
    if (!v) {
      crumb.textContent = 'Help';
      body.innerHTML = '<p class="help-empty">Click a tab, or the <b>?</b> beside a parameter.</p>';
      return;
    }

    const painted =
      v.kind === 'topic' ? this._paintTopic(v.key)
      : v.kind === 'panel' ? this._paintPanel(v.key)
      : v.kind === 'param' ? this._paintParam(v.key)
      : v.kind === 'group' ? this._paintGroup(v.key)
      : v.kind === 'node'  ? this._paintNode(v.key)
      : v.kind === 'nodeField' ? this._paintNodeField(v.key)
      : null;

    crumb.textContent = painted?.crumb ?? 'Help';
    body.innerHTML    = painted?.html  ?? '<p class="help-empty">Nothing to show.</p>';
  }

  _paintTopic(id) {
    const t = this._topic(id);
    if (!t) return { crumb: 'Help', html: `<p class="help-empty">No topic <code>${esc(id)}</code>.</p>` };
    return {
      crumb: t.title,
      html: `<div class="help-topic">${t.html}</div>${this._citesFooter(t)}`,
    };
  }

  /**
   * A panel's topic, or — for a panel that has none — what tier 1 knows about it.
   *
   * The gate makes the second branch unreachable for a REGISTERED panel, and it is here
   * anyway: a panel added in the same commit as this file's next edit, before its topic
   * is written, must show something rather than throw inside a bus subscriber.
   */
  _paintPanel(id) {
    const t = this._topicForPanel(id);
    if (t) return this._paintTopic(t.id);

    const p = this._panel(id);
    if (!p) return { crumb: 'Help', html: `<p class="help-empty">No help for <code>${esc(id)}</code>.</p>` };
    return {
      crumb: p.title,
      html: `<h3>${esc(p.title)}</h3>
        <p class="help-empty">No topic yet for this panel.</p>
        ${p.source ? `<p class="help-meta">Source: <code>${esc(p.source)}</code></p>` : ''}`,
    };
  }

  /** The fix for the truncated tooltip: the whole description, with its tier-1 facts. */
  _paintParam(key) {
    const p = this._param(key);
    if (!p) return { crumb: 'Help', html: `<p class="help-empty">No parameter <code>${esc(key)}</code>.</p>` };

    const facts = [
      ['Type',    p.type],
      ['Default', p.defaultValue === null ? '—'
        : `${fmt(p.defaultValue)}${p.defaultCurrency ? ` ${p.defaultCurrency}` : ''}`],
      (p.min != null || p.max != null) && ['Range', `${p.min ?? '−∞'} … ${p.max ?? '∞'}`],
      p.options?.length && ['One of', p.options.join(', ')],
      ['Sweepable', [p.mc && 'Monte Carlo', p.opt && 'optimizer'].filter(Boolean).join(', ') || 'no'],
      ['Contributed by', p.contributedBy ?? '—'],
      p.visibleWhen && ['Shown when', p.visibleWhen],
    ].filter(Boolean);

    const topics = this._topicsForParam(key);
    return {
      crumb: p.label ?? p.key,
      html: `
        <h3 class="help-param-title">${esc(p.label ?? p.key)}</h3>
        <p class="help-param-key"><code>${esc(p.key)}</code>${p.group
          ? ` · <a href="#" data-help-group="${esc(p.group)}">${esc(p.group)}</a>` : ''}</p>
        <p class="help-param-desc">${esc(p.description || 'No description.')}</p>
        <dl class="help-facts">${facts
          .map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(String(val))}</dd>`).join('')}</dl>
        ${topics.length ? `<p class="help-meta">Explained in ${topics.map(linkTopic).join(', ')}.</p>` : ''}`,
    };
  }

  /**
   * A param GROUP — what the `?` on a group header opens.
   *
   * A group gets a list of its params rather than a page of prose, because design 108 Q4
   * settled that the 21 groups are an arrangement of the Parameters panel and not of the
   * engine: "Economic Shocks" is five unrelated mechanics. The topics that explain those
   * mechanics are gathered underneath from what they cite, which is how a group of 52
   * params reaches its five topics without anyone maintaining a group→topic table.
   */
  _paintGroup(group) {
    const params = this._index.params.filter(p => p.group === group);
    if (!params.length) return { crumb: 'Help', html: `<p class="help-empty">No group <code>${esc(group)}</code>.</p>` };

    const topics = [...new Map(params
      .flatMap(p => this._topicsForParam(p.key))
      .map(t => [t.id, t])).values()];

    return {
      crumb: group,
      html: `
        <h3>${esc(group)}</h3>
        <p class="help-meta">${params.length} parameter${params.length > 1 ? 's' : ''}.</p>
        ${topics.length
          ? `<p class="help-meta">Explained in ${topics.map(linkTopic).join(', ')}.</p>`
          : '<p class="help-meta">No topic cites these yet.</p>'}
        <ul class="help-param-list">${params.map(p =>
          `<li><a href="#" data-help-param="${esc(p.key)}">${esc(p.label ?? p.key)}</a></li>`).join('')}</ul>`,
    };
  }

  /**
   * A node KIND: its topic's overview, then every field on its form.
   *
   * The field list is built from tier 1 rather than from the topic, so a control the topic
   * has not caught up with is still listed — with its description missing, which is what
   * the gate is failing on and what the reader should see.
   */
  _paintNode(kind) {
    const n = this._node(kind);
    if (!n) return { crumb: 'Help', html: `<p class="help-empty">No node type <code>${esc(kind)}</code>.</p>` };
    const t = n.topic ? this._topic(n.topic) : null;

    return {
      crumb: n.label,
      html: `${t ? `<div class="help-topic">${t.html}</div>` : `<h3>${esc(n.label)}</h3>`}
        <h4 class="help-node-fields">Fields (${n.fields.length})</h4>
        <ul class="help-param-list">${n.fields.map(f =>
          `<li><a href="#" data-help-node-field="${esc(kind)}.${esc(f.field)}">${esc(f.label ?? f.field)}</a>
            <span class="help-meta"><code>${esc(f.field)}</code></span></li>`).join('')}</ul>
        ${t ? this._citesFooter(t) : ''}`,
    };
  }

  /** One field of one form — the fix for the truncated tooltip, on this half of the app. */
  _paintNodeField(key) {
    const kind  = key.slice(0, key.indexOf('.'));
    const name  = key.slice(kind.length + 1);
    const n     = this._node(kind);
    const f     = n?.fields.find(x => x.field === name);
    if (!f) return { crumb: 'Help', html: `<p class="help-empty">No field <code>${esc(key)}</code>.</p>` };

    const facts = [
      ['Field',   f.field],
      ['Control', f.inputType],
      ['Node',    n.label],
      ['Documented in',
        f.describedBy === 'param' ? 'its record parameter' : `help/nodes/${kind}.md`],
    ].filter(Boolean);

    return {
      crumb: f.label ?? f.field,
      html: `
        <h3 class="help-param-title">${esc(f.label ?? f.field)}</h3>
        <p class="help-param-key"><a href="#" data-help-node="${esc(kind)}">${esc(n.label)}</a></p>
        <p class="help-param-desc">${esc(f.description || 'No description.')}</p>
        <dl class="help-facts">${facts
          .map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(String(val))}</dd>`).join('')}</dl>
        ${f.param ? `<p class="help-meta">This field is a scenario <b>parameter</b>: each record
          gets its own, under the record's name in the Parameters panel, and an edit here
          writes the parameter rather than the record. That is also where its range, its
          default and its sweepability live.</p>` : ''}`,
    };
  }

  /** What a topic cites, as links — the topic's own frontmatter, rendered. */
  _citesFooter(t) {
    const bits = [];
    if (t.params?.length) {
      bits.push(`<div class="help-cites-row"><span>Parameters</span>${t.params
        .map(k => `<a href="#" data-help-param="${esc(k)}">${esc(this._param(k)?.label ?? k)}</a>`)
        .join('')}</div>`);
    }
    if (t.design?.length) {
      bits.push(`<div class="help-cites-row"><span>Design</span>${t.design
        .map(d => `<code>design/${esc(d)}</code>`).join(' ')}</div>`);
    }
    if (!bits.length) return '';
    return `<div class="help-cites">${bits.join('')}</div>`;
  }
}

const linkTopic = (t) => `<a href="#" data-help-topic="${esc(t.id)}">${esc(t.title)}</a>`;

const fmt = (v) => (typeof v === 'object' ? JSON.stringify(v) : String(v));

/**
 * Escape text bound for `innerHTML`.
 *
 * Param labels and descriptions are source-authored, but they are interpolated into
 * markup here rather than pre-rendered by the generator, and at least one description
 * already contains a `<`. Escaping keeps this panel's one legitimate `innerHTML` path —
 * `topic.html`, produced by `marked` at build time — the only one.
 */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
