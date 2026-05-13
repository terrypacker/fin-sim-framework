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

import { ActionEditor } from '../../../src/visualization/components/action-editor.js';
import { loadHtml, makeMockGraphRenderer, makeMockContainer } from '../../helpers/viz-utils.js';
import {
  ActionBuilder
} from "../../../src/simulation-framework/builders/action-builder.js";
import {
  DEFAULT_ACTIONS,
  ScriptedAction
} from "../../../src/simulation-framework/actions.js";


describe('ActionEditor', () => {

  beforeEach(() => {
    loadHtml('../../index.html');
  });

  function makeEditor(actionNode = makeAmountAction()) {
    return new ActionEditor({
      parent: null,
      container: makeMockContainer(),
      graphRenderer: makeMockGraphRenderer(),
      node: actionNode,
    });
  }

  function makeAmountAction() {
    return ActionBuilder.amount()
    .type('ADD_CASH')
    .name('Credit')
    .value(500).build();
  }


  test('constructs without error', () => {
    expect(() => makeEditor()).not.toThrow();
  });

  test('renders base fields', () => {
    const editor = makeEditor();

    editor.render();

    expect(
        editor._container.querySelector('[data-id="name"]').value,
    ).toBe('Credit');

    expect(
        editor._container.querySelector('[data-id="type"]').value,
    ).toBe('ADD_CASH');
  });

  test('renders action class select options', () => {
    const editor = makeEditor();

    editor.render();

    const select = editor._container.querySelector(
        '[data-id="actionClass"]',
    );

    expect(select.options.length).toBeGreaterThan(0);
  });

  test('renders selected action class', () => {
    const fieldAction = ActionBuilder.fieldAction(DEFAULT_ACTIONS.RECORD_METRIC)
    .name('test name')
    .fieldName('balance').build()
    const editor = makeEditor(fieldAction);

    editor.render();

    const select = editor._container.querySelector(
        '[data-id="actionClass"]',
    );

    expect(select.value).toBe('FieldAction');
  });

  test('calls onActionClassChange when class changes', () => {
    const editor = makeEditor();
    editor._node.id = 'action1';

    editor.onActionClassChange = jest.fn();

    editor.render();

    const select = editor._container.querySelector(
        '[data-id="actionClass"]',
    );
    // ensure it's the live DOM node
    expect(select.isConnected).toBe(true);

    select.value = 'FieldAction';

    select.dispatchEvent(new Event('change', { bubbles: true }));

    expect(editor.onActionClassChange).toHaveBeenCalledWith(
        'action1',
        'FieldAction',
    );
  });

  test('renders AmountAction config', () => {
    const editor = makeEditor();

    editor.render();

    const valueInput = editor._container.querySelector(
        '[data-field="value"]',
    );

    expect(valueInput).not.toBeNull();
    expect(valueInput.value).toBe('500');
  });

  test('renders FieldAction config', () => {
    const fieldAction = ActionBuilder.fieldAction(DEFAULT_ACTIONS.RECORD_METRIC)
      .name('test name')
      .fieldName('balance').build()
    const editor = makeEditor(fieldAction);

    editor.render();

    const fieldInput = editor._container.querySelector(
        '[data-field="fieldName"]',
    );

    expect(fieldInput).not.toBeNull();
    expect(fieldInput.value).toBe('balance');
  });

  test('renders FieldValueAction config', () => {
    const fieldValueAction = ActionBuilder.fieldValueAction(DEFAULT_ACTIONS.RECORD_METRIC)
      .name('Metric')
      .fieldName('balance')
      .value(100).build();
    const editor = makeEditor(fieldValueAction);

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

  test('renders ScriptedAction config', () => {
    const scriptedAction = new ScriptedAction(
        'SCRIPTED', 'scripted name',
        'balance',
        'return 123;'
    );
    const editor = makeEditor(scriptedAction);

    editor.render();

    expect(
        editor._container.querySelector('[data-field="fieldName"]').value,
    ).toBe('balance');

    expect(
        editor._container.querySelector('[data-field="script"]').value,
    ).toBe('return 123;');
  });

  test('calls onFieldChange for text fields', () => {

    const editor = makeEditor({
      actionClass: 'FieldAction',
      fieldName: 'balance',
    });

    editor.onFieldChange = jest.fn();

    editor.render();

    const input = editor._container.querySelector(
        '[data-field="fieldName"]',
    );

    input.value = 'newBalance';

    input.dispatchEvent(new Event('input'));

    expect(editor.onFieldChange).toHaveBeenCalledWith(
        expect.any(Object),
        'fieldName',
        'newBalance',
    );
  });

  test('parses numeric value fields', () => {
    const editor = makeEditor();

    editor.onFieldChange = jest.fn();

    editor.render();

    const input = editor._container.querySelector(
        '[data-field="value"]',
    );

    input.value = '55.25';

    input.dispatchEvent(new Event('input'));

    expect(editor.onFieldChange).toHaveBeenCalledWith(
        expect.any(Object),
        'value',
        55.25,
    );
  });

  test('sets numeric value to null when empty', () => {

    const editor = makeEditor();

    editor.onFieldChange = jest.fn();

    editor.render();

    const input = editor._container.querySelector(
        '[data-field="value"]',
    );

    input.value = '';

    input.dispatchEvent(new Event('input'));

    expect(editor.onFieldChange).toHaveBeenCalledWith(
        expect.any(Object),
        'value',
        null,
    );
  });

  test('script validate button shows success result', () => {
    const editor = makeEditor({
      actionClass: 'ScriptedAction',
      fieldName: 'balance',
      script: 'return 5;',
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
    expect(result.innerText.length).toBeGreaterThan(0);
  });

  test('script validate button shows error result', () => {
    const editor = makeEditor({
      actionClass: 'ScriptedAction',
      fieldName: 'balance',
      script: 'INVALID JS {{{',
    });

    editor.render();

    const btn = editor._container.querySelector(
        '.script-validate-button',
    );

    btn.click();
    const result = editor._container.querySelector(
        '.code-test-result',
    );
    expect(result.innerText).toContain('Error:');
  });

  test('renderConfig safely handles unknown action class', () => {
    const editor = makeEditor({
      actionClass: 'UnknownAction',
    });

    expect(() => editor.render()).not.toThrow();
  });

  test('renders linkable multiselect sections', () => {
    const editor = makeEditor();

    editor.render();

    expect(
        editor._container.querySelector('#action-handlers'),
    ).not.toBeNull();

    expect(
        editor._container.querySelector('#action-reducers'),
    ).not.toBeNull();
  });

});
