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
 *    that cites it.
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
    this._loading = null;          // the in-flight load promise, so two mounts share one
    this._view    = null;          // { kind: 'topic'|'param'|'panel'|'group', key }
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

    this._runtime.bus.subscribe(WB_EVENTS.HELP_OPEN, ({ param, group, topic }) => {
      if (param)      this._go({ kind: 'param', key: param });
      else if (group) this._go({ kind: 'group', key: group });
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

  /** Load `help-index.json` once per session. Resolves even on failure — see `_paint`. */
  _ensureIndex() {
    if (this._index)   return Promise.resolve(this._index);
    if (this._loading) return this._loading;

    // No `fetch` is a real environment, not an impossible one: jsdom has none, and the
    // workbench boots under it in tests. Mounting a panel must never throw — the whole
    // shell is built in one synchronous pass, so a throw here takes every other panel
    // with it (which is exactly what `workbench-boot-with-closed-tabs` guards).
    if (typeof fetch !== 'function') {
      this._loading = Promise.resolve(null);
      return this._loading;
    }

    const base = (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '/';
    this._loading = fetch(`${base}help/help-index.json`)
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((idx) => { this._index = idx; return idx; });
    return this._loading;
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

    const param = a.dataset.helpParam;
    const topic = a.dataset.helpTopic;
    const group = a.dataset.helpGroup;
    if (param || topic || group) {
      e.preventDefault();
      this._go(param ? { kind: 'param', key: param }
             : group ? { kind: 'group', key: group }
             :         { kind: 'topic', key: topic });
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
