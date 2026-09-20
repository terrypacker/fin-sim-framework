/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { loadHelpIndex } from './help-index-source.js';

/**
 * Put the help on a node edit form (design 111 §6).
 *
 * Before this, half the ~164 controls across the eleven edit forms carried nothing at all,
 * and the half that did carried a hand-written `title=` in `index.html` — the same failure
 * design 108 §2 recorded for parameters. A native tooltip truncates, cannot be laid out,
 * and is invisible to anyone reading the repo rather than the app.
 *
 * So the prose moved to `help/nodes/<kind>.md` and arrives here through the generated
 * index, which gives each field the two affordances a param already had:
 *
 *   hover  the whole description as the `title` — right for the short ones
 *   `?`    the same words in the Help panel, laid out, beside the field's type and the
 *          parameter that backs it
 *
 * Wired ONCE, in the shared editor factory, so it covers the modal and the Nodes→Edit pane
 * and every kind, rather than eleven editors each remembering to call it.
 *
 * ### Degrading
 *
 * The index is a gitignored build artifact and jsdom has no `fetch`, so it can legitimately
 * be absent. Then this attaches nothing: no tooltip, no `?`, no throw. An edit form that
 * threw because its documentation was missing would be a far worse bug than an undocumented
 * one, and this runs inside `editorFactory`, which the modal calls synchronously.
 *
 * @param {HTMLElement} root  the rendered editor's root element
 * @param {string}      kind  the NODE_EDITORS kind — `real-property`, `account`, …
 * @param {{ onOpenHelp?: (ref: {node: string, field: string}) => void }} [opts]
 * @returns {Promise<number>} how many fields were decorated — for tests, and for nothing else
 */
export async function decorateNodeFields(root, kind, { onOpenHelp = null } = {}) {
  if (!root || !kind) return 0;

  const index = await loadHelpIndex();
  const node  = index?.nodes?.find(n => n.kind === kind);
  if (!node) return 0;

  // The element is gone by the time the index resolves when the user closed the editor
  // mid-fetch. `isConnected` is false then, and decorating a detached tree is harmless but
  // pointless; bailing keeps the count honest.
  if (!root.isConnected && !root.ownerDocument) return 0;

  let decorated = 0;
  for (const f of node.fields) {
    if (!f.description) continue;

    // `domId` and `field` differ only where a section prefixes its controls (the payroll
    // elections' `pe_`). Both attributes are in use across the templates, and which one a
    // given control carries is not a fact about the field.
    const control = root.querySelector(
      `[data-id="${f.domId}"], [data-field="${f.domId}"], [data-f="${f.domId}"]`);
    if (!control) continue;

    control.title = f.description;

    const labelEl = control.closest('.node-field')?.querySelector('label');
    if (labelEl && onOpenHelp && !labelEl.querySelector('.param-help-btn')) {
      // The same affordance, class and behaviour the Parameters panel already uses on a
      // param label — one `?` in this app, not two that look alike and act differently.
      const btn = document.createElement('button');
      btn.type        = 'button';
      btn.className   = 'param-help-btn';
      btn.textContent = '?';
      btn.title       = `Help: ${f.label ?? f.field}`;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        // The label of a checkbox row WRAPS its input, so a click here would otherwise
        // toggle the box you were asking about.
        e.stopPropagation();
        onOpenHelp({ node: kind, field: f.field });
      });
      labelEl.appendChild(btn);
    }
    decorated++;
  }
  return decorated;
}
