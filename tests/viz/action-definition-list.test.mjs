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
 * Tests for ActionDefinitionList config-field editing.
 *
 * A handler emits actions from its generatedActionDefinitions, and the emitted
 * value comes from each definition's config. Before this change the row only let
 * you edit the definition's `type`, so an AmountAction could never be given a
 * non-zero `value` from the UI (it stayed 0 → the FieldReducer wrote undefined).
 */

import { test, expect } from '@jest/globals';
import { ActionDefinitionList } from '../../src/visualization/components/action-definition-list.js';
import { ACTION_TEMPLATES } from '../../src/simulation-framework/action-templates.js';

function setup(def) {
  const container = document.createElement('div');
  const countSpan = document.createElement('span');
  const node = { id: 'h1', kind: 'handler', generatedActionDefinitions: [def], generatedActionTypes: [def.type] };
  const list = new ActionDefinitionList({ countSpan, container, node });
  const updates = [];
  list.onUpdate = (n, defId, field, value) => updates.push({ defId, field, value });
  list.render();
  return { container, list, node, updates };
}

test('renders an input for each editable config field (value, name)', () => {
  const def = { id: 'd1', type: 'NEW_ACTION', config: { actionClass: 'AmountAction', name: '', value: 0 } };
  const { container } = setup(def);
  const labels = [...container.querySelectorAll('label.action-definition-config')].map(l => l.firstChild.textContent);
  expect(labels).toEqual(['name', 'value']);
});

test('actionClass and internal (_-prefixed) config keys are not editable', () => {
  const def = { id: 'd1', type: 'NEW_ACTION', config: { actionClass: 'AmountAction', _actionId: 'a2', value: 0 } };
  const { container } = setup(def);
  const labels = [...container.querySelectorAll('label.action-definition-config')].map(l => l.firstChild.textContent);
  expect(labels).toEqual(['value']);
});

test('editing a numeric field coerces the value to a number', () => {
  const def = { id: 'd1', type: 'NEW_ACTION', config: { actionClass: 'AmountAction', name: '', value: 0 } };
  const { container, updates } = setup(def);
  const valueInput = [...container.querySelectorAll('label.action-definition-config')]
    .find(l => l.firstChild.textContent === 'value')
    .querySelector('input');
  valueInput.value = '100';
  valueInput.dispatchEvent(new Event('input'));
  expect(updates.at(-1)).toEqual({ defId: 'd1', field: 'value', value: 100 });
});

test('a $-expression in a numeric field is passed through as a string', () => {
  const def = { id: 'd1', type: 'NEW_ACTION', config: { actionClass: 'AmountAction', value: 0 } };
  const { container, updates } = setup(def);
  const input = container.querySelector('label.action-definition-config input');
  input.value = '$data.amount';
  input.dispatchEvent(new Event('input'));
  expect(updates.at(-1)).toEqual({ defId: 'd1', field: 'value', value: '$data.amount' });
});

test('AmountAction is discoverable in the add-template dropdown by class name', () => {
  const def = { id: 'd1', type: 'NEW_ACTION', config: { actionClass: 'AmountAction', value: 0 } };
  const { container } = setup(def);
  const optionLabels = [...container.querySelectorAll('select option')].map(o => o.textContent);
  expect(optionLabels).toContain('Transfer Amount (AmountAction)');
  // every template advertises its action class
  for (const tpl of ACTION_TEMPLATES) {
    expect(tpl.label).toContain(tpl.actionClass);
  }
});
