/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/** The account editor's Drawdown hint: a Roth ranked ahead of taxed accounts, as typed. */
import { loadHtml, makeMockContainer } from '../../helpers/viz-utils.js';
import { AccountEditor } from '../../../src/visualization/accounts/account-editor.js';

const SIBLINGS = [
  { id: 'b1', stateKey: 'broker', name: 'Brokerage', type: 'brokerage', drawdownPriority: 4 },
  { id: 'i1', stateKey: 'ira',    name: 'IRA',       type: 'ira',       drawdownPriority: 5 },
];

function editorFor(node) {
  const editor = new AccountEditor({ container: makeMockContainer(), node, people: [],
    accounts: [...SIBLINGS, node] });
  editor.render();
  return editor;
}

describe('flag 19 — drawdown order hint', () => {
  beforeEach(() => loadHtml('../../index.html'));

  test('a Roth at 3 is told it is spent before the brokerage and the IRA', () => {
    const root = editorFor({ id: 'r1', stateKey: 'roth', name: 'Roth', type: 'roth', drawdownPriority: 3 })._rootEl;
    expect(root.querySelector('[data-id="drawdownHint"]').textContent)
      .toMatch(/^Spent before Brokerage \(4\), IRA \(5\)\./);
  });

  test('the hint follows the typed priority, not the saved one', () => {
    const root = editorFor({ id: 'r1', stateKey: 'roth', name: 'Roth', type: 'roth', drawdownPriority: 3 })._rootEl;
    const input = root.querySelector('[data-id="drawdownPriority"]');
    input.value = '6';
    input.dispatchEvent(new Event('input'));
    expect(root.querySelector('[data-id="drawdownHint"]').textContent).toBe('');
  });
});
