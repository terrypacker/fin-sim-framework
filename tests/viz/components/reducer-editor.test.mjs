/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { jest } from '@jest/globals';

import { ReducerEditor } from '../../../src/visualization/components/reducer-editor.js';

import {
  loadHtml,
  makeMockContainer,
  makeMockGraphRenderer,
} from '../../helpers/viz-utils.js';

import {
  PRIORITY,
  REDUCER_CLASSES,
} from '../../../src/simulation-framework/reducers.js';

describe('ReducerEditor', () => {

  beforeEach(() => {
    loadHtml('../../index.html');
  });

  function makeReducerNode() {
    return {
      id: 'reducer1',
      name: 'Metric Reducer',
      reducerType: 'FieldValueReducer',
      priority: PRIORITY.METRICS,

      fieldName: 'balance',
      value: 100,

      generatedActionDefinitions: [
        {
          id: 'def1',
          type: 'ADD_CASH',
          config: {
            actionClass: 'AmountAction',
          },
        },
      ],

      getDescription() {
        return 'Reducer description';
      },
    };
  }

  function makeEditor(node = makeReducerNode()) {
    return new ReducerEditor({
      parent: null,
      container: makeMockContainer(),
      graphRenderer: makeMockGraphRenderer(),
      node,
    });
  }

  test('constructs without error', () => {
    expect(() => makeEditor()).not.toThrow();
  });

  test('renders description', () => {
    const editor = makeEditor();

    editor.render();

    expect(
        editor._container.querySelector(
            '[data-id="description"]',
        ).innerText,
    ).toBe('Reducer description');
  });

  test('renders reducer type select', () => {
    const editor = makeEditor();

    editor.render();

    const select = editor._container.querySelector(
        '[data-id="type"]',
    );

    expect(select).not.toBeNull();

    expect(select.options.length).toBe(
        Object.keys(REDUCER_CLASSES).length,
    );
  });

  test('renders selected reducer type', () => {
    const editor = makeEditor();

    editor.render();

    const select = editor._container.querySelector(
        '[data-id="type"]',
    );

    expect(select.value).toBe('FieldValueReducer');
  });

  test('calls onReducerTypeChange when reducer type changes', () => {
    const editor = makeEditor();

    editor.onReducerTypeChange = jest.fn();

    editor.render();

    const select = editor._container.querySelector(
        '[data-id="type"]',
    );

    expect(select.isConnected).toBe(true);

    const newValue =
        [...select.options]
        .map(o => o.value)
        .find(v => v !== 'FieldValueReducer');

    if (!newValue) {
      return;
    }

    select.value = newValue;

    select.dispatchEvent(
        new Event('change', { bubbles: true }),
    );

    expect(editor.onReducerTypeChange).toHaveBeenCalledWith(
        'reducer1',
        newValue,
    );
  });

  test('renders name field', () => {
    const editor = makeEditor();

    editor.render();

    expect(
        editor._container.querySelector(
            '[data-id="name"]',
        ).value,
    ).toBe('Metric Reducer');
  });

  test('calls onFieldChange when name changes', () => {
    const editor = makeEditor();

    editor.onFieldChange = jest.fn();

    editor.render();

    const input = editor._container.querySelector(
        '[data-id="name"]',
    );

    input.value = 'Updated Reducer';

    input.dispatchEvent(
        new Event('input', { bubbles: true }),
    );

    expect(editor.onFieldChange).toHaveBeenCalledWith(
        expect.any(Object),
        'name',
        'Updated Reducer',
    );
  });

  test('renders priority select', () => {
    const editor = makeEditor();

    editor.render();

    const select = editor._container.querySelector(
        '[data-id="priority"]',
    );

    expect(select).not.toBeNull();

    expect(select.options.length).toBe(
        editor.PRIORITY_OPTIONS.length,
    );
  });

  test('renders selected priority', () => {
    const editor = makeEditor();

    editor.render();

    const select = editor._container.querySelector(
        '[data-id="priority"]',
    );

    expect(select.value).toBe(
        String(PRIORITY.METRICS),
    );
  });

  test('parses priority values as numbers', () => {
    const editor = makeEditor();

    editor.onFieldChange = jest.fn();

    editor.render();

    const select = editor._container.querySelector(
        '[data-id="priority"]',
    );

    select.value = String(PRIORITY.LOGGING);

    select.dispatchEvent(
        new Event('change', { bubbles: true }),
    );

    expect(editor.onFieldChange).toHaveBeenCalledWith(
        expect.any(Object),
        'priority',
        PRIORITY.LOGGING,
    );
  });

  test('renders FieldReducer config', () => {
    const editor = makeEditor({
      ...makeReducerNode(),
      reducerType: 'FieldReducer',
      fieldName: 'shares',
    });

    editor.render();

    const input = editor._container.querySelector(
        '[data-field="fieldName"]',
    );

    expect(input).not.toBeNull();

    expect(input.value).toBe('shares');
  });

  test('renders FieldValueReducer config', () => {
    const editor = makeEditor();

    editor.render();

    const fieldInput = editor._container.querySelector(
        '[data-field="fieldName"]',
    );

    const valueInput = editor._container.querySelector(
        '[data-field="value"]',
    );

    expect(fieldInput.value).toBe('balance');
    expect(valueInput.value).toBe('100');
  });

  test('renders AccountTransactionReducer config', () => {
    const editor = makeEditor({
      ...makeReducerNode(),
      reducerType: 'AccountTransactionReducer',
      accountKey: 'brokerage',
    });

    editor.render();

    const input = editor._container.querySelector(
        '[data-field="accountKey"]',
    );

    expect(input).not.toBeNull();

    expect(input.value).toBe('brokerage');
  });

  test('renders ScriptedReducer config', () => {
    const editor = makeEditor({
      ...makeReducerNode(),
      reducerType: 'ScriptedReducer',
      fieldName: 'balance',
      script: 'return state;',
    });

    editor.render();

    expect(
        editor._container.querySelector(
            '[data-field="fieldName"]',
        ).value,
    ).toBe('balance');

    expect(
        editor._container.querySelector(
            '[data-field="script"]',
        ).value,
    ).toBe('return state;');
  });

  test('calls onFieldChange for reducer config text fields', () => {
    const editor = makeEditor({
      ...makeReducerNode(),
      reducerType: 'FieldReducer',
    });

    editor.onFieldChange = jest.fn();

    editor.render();

    const input = editor._container.querySelector(
        '[data-field="fieldName"]',
    );

    input.value = 'updatedField';

    input.dispatchEvent(
        new Event('input', { bubbles: true }),
    );

    expect(editor.onFieldChange).toHaveBeenCalledWith(
        expect.any(Object),
        'fieldName',
        'updatedField',
    );
  });

  test('parses numeric reducer config values', () => {
    const editor = makeEditor();

    editor.onFieldChange = jest.fn();

    editor.render();

    const input = editor._container.querySelector(
        '[data-field="value"]',
    );

    input.value = '55.25';

    input.dispatchEvent(
        new Event('input', { bubbles: true }),
    );

    expect(editor.onFieldChange).toHaveBeenCalledWith(
        expect.any(Object),
        'value',
        55.25,
    );
  });

  test('sets numeric reducer config value to null when empty', () => {
    const editor = makeEditor();

    editor.onFieldChange = jest.fn();

    editor.render();

    const input = editor._container.querySelector(
        '[data-field="value"]',
    );

    input.value = '';

    input.dispatchEvent(
        new Event('input', { bubbles: true }),
    );

    expect(editor.onFieldChange).toHaveBeenCalledWith(
        expect.any(Object),
        'value',
        null,
    );
  });

  test('script validate button shows success result', () => {
    const editor = makeEditor({
      ...makeReducerNode(),
      reducerType: 'ScriptedReducer',
      fieldName: 'balance',
      script: 'return { ok: true };',
    });

    editor.render();

    const btn = editor._container.querySelector(
        '.script-validate-button',
    );

    btn.click();

    const result = editor._container.querySelector(
        '.code-test-result',
    );

    expect(result.style.display).toBe('block');

    expect(result.innerText.length)
    .toBeGreaterThan(0);
  });

  test('script validate button shows error result', () => {
    const editor = makeEditor({
      ...makeReducerNode(),
      reducerType: 'ScriptedReducer',
      fieldName: 'balance',
      script: 'INVALID {{{',
    });

    editor.render();

    const btn = editor._container.querySelector(
        '.script-validate-button',
    );

    btn.click();

    const result = editor._container.querySelector(
        '.code-test-result',
    );

    expect(result.innerText)
    .toContain('Error:');
  });

  test('renderConfig safely handles unknown reducer type', () => {
    const editor = makeEditor({
      ...makeReducerNode(),
      reducerType: 'UnknownReducer',
    });

    expect(() => editor.render()).not.toThrow();
  });

  test('renders reducer reduced actions multiselect section', () => {
    const editor = makeEditor();

    editor.render();

    expect(
        editor._container.querySelector(
            '#reducer-reduced-actions',
        ),
    ).not.toBeNull();

    expect(
        editor._container.querySelector(
            '#reducer-reduced-actions-count',
        ),
    ).not.toBeNull();
  });

  test('renders generated actions section', () => {
    const editor = makeEditor();

    editor.render();

    expect(
        editor._container.querySelector(
            '#reducer-generated-actions',
        ),
    ).not.toBeNull();
  });

  test('forwards ActionDefinitionList onAdd events', () => {
    const editor = makeEditor();

    editor.onActionDefinitionAdd = jest.fn();

    editor.render();

    const container = editor._container.querySelector(
        '#reducer-generated-actions',
    );

    const select = container.querySelector('select');

    const inputs = container.querySelectorAll('input');

    const typeInput = inputs[inputs.length - 1];

    const addBtn = [
      ...container.querySelectorAll('button'),
    ].find(btn => btn.textContent === '+ Add');

    select.selectedIndex = 0;

    typeInput.value = 'generated action';

    addBtn.click();

    expect(editor.onActionDefinitionAdd)
    .toHaveBeenCalled();
  });

  test('forwards ActionDefinitionList onRemove events', () => {
    const editor = makeEditor();

    editor.onActionDefinitionRemove = jest.fn();

    editor.render();

    const container = editor._container.querySelector(
        '#reducer-generated-actions',
    );

    const removeBtn = [
      ...container.querySelectorAll('button'),
    ].find(btn => btn.textContent === '✕');

    removeBtn.click();

    expect(editor.onActionDefinitionRemove)
    .toHaveBeenCalledWith(
        expect.any(Object),
        'def1',
    );
  });

  test('forwards ActionDefinitionList onUpdate events', () => {
    const editor = makeEditor();

    editor.onActionDefinitionUpdate = jest.fn();

    editor.render();

    const container = editor._container.querySelector(
        '#reducer-generated-actions',
    );

    const input = container.querySelector('input');

    input.value = 'UPDATED_ACTION';

    input.dispatchEvent(
        new Event('input', { bubbles: true }),
    );

    expect(editor.onActionDefinitionUpdate)
    .toHaveBeenCalledWith(
        expect.any(Object),
        'def1',
        'type',
        'UPDATED_ACTION',
    );
  });

});
