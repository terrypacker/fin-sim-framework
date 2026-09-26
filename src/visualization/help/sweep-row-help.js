/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { loadHelpIndex }  from './help-index-source.js';
import { ScenarioLoader } from '../../scenarios/scenario-loader.js';

/**
 * Put the help on a Monte Carlo or Optimize variable row.
 *
 * A row is keyed by the param it sweeps, and every row already has words written for it
 * somewhere in the generated index — but not always under its own key. Four shapes:
 *
 *   a schema param         `inflationRate`            → that param
 *   a legacy alias         `rothBalance`              → whatever its successor resolves to
 *   a generated record key `acct.<id>.minimumBalance` → the field on that node's edit form
 *                          (design 111), since the record template's description IS the
 *                          field's help — the index builder files it there
 *   a graph or array axis  `pool.<id>.targetScale`,   → the concept topic that explains it;
 *                          `shocks[0].severity`         there is no form and no schema entry
 *
 * So nothing new is written for a row: this only routes it. A row that resolves to nothing
 * gets no `?` rather than one that opens "No parameter …", and `tests/viz/sweep-row-help`
 * fails when a lever either panel offers has nowhere to go.
 */

/** Generated-key namespace → the edit form (`index.nodes[].kind`) that owns the field. */
const NODE_KIND_BY_PREFIX = Object.freeze({
  acct:    'account',
  person:  'person',
  people:  'person',          // `people.<id>.lifeExpectancy`, the mortality rows
  prop:    'real-property',
  coll:    'collectible',
  equity:  'company',
  bequest: 'bequest',
  raAsset: 'account',         // an inherited retirement account; the index files it there
});

/**
 * A generated field whose form control has a different name. `balanceTarget` is the
 * compile-only lever behind the Balance box — `hidden`, so it has no control of its own.
 */
const FIELD_RENAMES = Object.freeze({ balanceTarget: 'balance' });

/** Axes with no record and no schema entry → the topic that explains them. */
const TOPIC_BY_PREFIX = Object.freeze({
  pool:   'searching-pool-levers',
  shape:  'searching-pool-levers',
  gate:   'searching-pool-levers',
  shocks: 'economic-shocks',
});

/**
 * Where a row's `?` should go, and the words for its hover.
 *
 * @param {string} paramKey
 * @param {object} index    the generated help index
 * @param {Map<string, string|null>} [aliases]  legacy key → generated successor
 * @returns {{ ref: object, description: string|null } | null}  `ref` is a HELP_OPEN payload
 */
export function sweepRowHelp(paramKey, index, aliases = new Map()) {
  if (!index || typeof paramKey !== 'string') return null;

  const param = index.params?.find(p => p.key === paramKey);
  if (param) return { ref: { param: paramKey }, description: param.description ?? null };

  const successor = aliases.get(paramKey);
  if (successor && successor !== paramKey) return sweepRowHelp(successor, index, new Map());

  const prefix = paramKey.match(/^([A-Za-z]+)[.[]/)?.[1];
  if (!prefix) return null;

  const topicId = TOPIC_BY_PREFIX[prefix];
  if (topicId) {
    const topic = index.topics?.find(t => t.id === topicId);
    return topic ? { ref: { topic: topicId }, description: null } : null;
  }

  const kind = NODE_KIND_BY_PREFIX[prefix];
  const node = kind && index.nodes?.find(n => n.kind === kind);
  if (!node) return null;
  const last  = paramKey.split('.').at(-1);
  const field = node.fields.find(f => f.field === (FIELD_RENAMES[last] ?? last));
  // A field the form does not show still has a form: the node's own page is the honest
  // answer, not no answer.
  return field
    ? { ref: { node: kind, field: field.field }, description: field.description ?? null }
    : { ref: { node: kind }, description: null };
}

/**
 * Decorate built sweep rows once the index resolves: the description as the label's hover,
 * and a `?` beside the label that opens the Help panel.
 *
 * Asynchronous and never awaited by the table, like `decorateNodeFields`: the index is a
 * gitignored build artifact and jsdom has no `fetch`, so it can be absent, and then the
 * rows keep the hover they were built with and get no `?`.
 *
 * The description is also written to `labelEl.dataset.label`, which is what the MC panel
 * restores the hover to when a row stops being flagged as diverged from the scenario.
 *
 * @param {Array<{ cfg: object, refs: { labelEl?: HTMLElement } }>} rows
 * @param {{ onOpenHelp?: (ref: object) => void, aliases?: Map<string, string|null> }} [opts]
 * @returns {Promise<number>} how many rows were decorated — for tests
 */
export async function decorateSweepRows(rows, { onOpenHelp = null, aliases = null } = {}) {
  const index = await loadHelpIndex();
  if (!index) return 0;
  const aliasMap = aliases ?? ScenarioLoader.paramAliasesFor(null);

  let decorated = 0;
  for (const { cfg, refs } of rows) {
    const labelEl = refs?.labelEl;
    if (!labelEl) continue;
    const help = sweepRowHelp(cfg?.paramKey, index, aliasMap);
    if (!help) continue;

    if (help.description) {
      labelEl.title         = help.description;
      labelEl.dataset.label = help.description;
    }
    if (onOpenHelp && !labelEl.parentElement?.querySelector('.param-help-btn')) {
      // The Parameters panel's `?`: one affordance in this app, not two that look alike.
      // Beside the label, not inside it — the label ellipsizes, and would clip it.
      const btn = document.createElement('button');
      btn.type        = 'button';
      btn.className   = 'param-help-btn';
      btn.textContent = '?';
      btn.title       = `Help: ${cfg.label ?? cfg.paramKey}`;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpenHelp(help.ref);
      });
      labelEl.after(btn);
    }
    decorated++;
  }
  return decorated;
}
