/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */
import { ActionDefinitionList } from "../../../src/visualization/components/action-definition-list.js";

// ─────────────────────────────────────────────────────────────────────────────
// DOM setup
// ─────────────────────────────────────────────────────────────────────────────

function installTemplates() {
  const tmpl = document.createElement('template');

  // Use the actual template id ActionEditor expects.
  // Replace this if your component uses a different id.
  tmpl.id = 'action-editor-template';

  tmpl.innerHTML = `
    <div class="action-editor">
      <div data-id="actionName"></div>
    </div>
  `;

  document.body.appendChild(tmpl);
}

describe('ActionDefinitionList', () => {

  function makeList() {
    const root = document.createElement('div');

    return new ActionDefinitionList({
      root,
      actions: [
        {
          id: 'a1',
          name: 'Deposit'
        },
        {
          id: 'a2',
          name: 'Withdraw'
        }
      ]
    });
  }

  test('constructs without error', () => {
    expect(() => makeList()).not.toThrow();
  });

  test('renders all actions', () => {
    const list = makeList();

    list.render();

    expect(list.root.innerHTML).toContain('Deposit');
    expect(list.root.innerHTML).toContain('Withdraw');
  });

});
