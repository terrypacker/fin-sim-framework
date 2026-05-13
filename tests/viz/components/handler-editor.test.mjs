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

import { HandlerEditor } from '../../../src/visualization/components/handler-editor.js';

import {
  loadHtml,
  makeMockContainer,
  makeMockGraphRenderer,
} from '../../helpers/viz-utils.js';

import {
  HANDLER_CLASSES,
} from '../../../src/simulation-framework/handlers.js';

describe('HandlerEditor', () => {

  beforeEach(() => {
    loadHtml('../../index.html');
  });

  function makeHandlerNode() {
    return {
      id: 'handler1',
      name: 'Income Handler',
      handlerClass: 'HandlerEntry',

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
        return 'Test handler description';
      },
    };
  }

  function makeEditor(node = makeHandlerNode()) {
    return new HandlerEditor({
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
    ).toBe('Test handler description');
  });

  test('renders handler class select', () => {
    const editor = makeEditor();

    editor.render();

    const select = editor._container.querySelector(
        '[data-id="handlerClass"]',
    );

    expect(select).not.toBeNull();

    expect(select.options.length).toBe(
        Object.keys(HANDLER_CLASSES).length,
    );
  });

  test('renders selected handler class', () => {
    const editor = makeEditor({
      ...makeHandlerNode(),
      handlerClass: 'HandlerEntry',
    });

    editor.render();

    const select = editor._container.querySelector(
        '[data-id="handlerClass"]',
    );

    expect(select.value).toBe('HandlerEntry');
  });

  test('calls onHandlerClassChange when selection changes', () => {
    const editor = makeEditor();

    editor.onHandlerClassChange = jest.fn();

    editor.render();

    const select = editor._container.querySelector(
        '[data-id="handlerClass"]',
    );

    expect(select.isConnected).toBe(true);

    const newValue =
        [...select.options]
        .map(o => o.value)
        .find(v => v !== 'HandlerEntry');

    if (!newValue) {
      return;
    }

    select.value = newValue;

    select.dispatchEvent(
        new Event('change', { bubbles: true }),
    );

    expect(editor.onHandlerClassChange).toHaveBeenCalledWith(
        'handler1',
        newValue,
    );
  });

  test('renders name field', () => {
    const editor = makeEditor();

    editor.render();

    const input = editor._container.querySelector(
        '[data-id="name"]',
    );

    expect(input.value).toBe('Income Handler');
  });

  test('calls onFieldChange when name changes', () => {
    const editor = makeEditor();

    editor.onFieldChange = jest.fn();

    editor.render();

    const input = editor._container.querySelector(
        '[data-id="name"]',
    );

    input.value = 'Updated Handler';

    input.dispatchEvent(
        new Event('input', { bubbles: true }),
    );

    expect(editor.onFieldChange).toHaveBeenCalledWith(
        expect.any(Object),
        'name',
        'Updated Handler',
    );
  });

  test('renders handler event multiselect section', () => {
    const editor = makeEditor();

    editor.render();

    expect(
        editor._container.querySelector('#handler-events'),
    ).not.toBeNull();

    expect(
        editor._container.querySelector('#handler-event-count'),
    ).not.toBeNull();
  });

  test('renders ActionDefinitionList section', () => {
    const editor = makeEditor();

    editor.render();

    expect(
        editor._container.querySelector('#handler-actions'),
    ).not.toBeNull();
  });

  test('renders existing action definitions', () => {
    const editor = makeEditor();

    editor.render();

    const actionContainer = editor._container.querySelector(
        '#handler-actions',
    );

    expect(
        actionContainer.innerHTML.length,
    ).toBeGreaterThan(0);

    const inputs = actionContainer.querySelectorAll('input');

    expect(inputs.length).toBeGreaterThan(0);

    expect(inputs[0].value).toBe('ADD_CASH');
  });

  test('forwards ActionDefinitionList onAdd events', () => {
    const editor = makeEditor();

    editor.onActionDefinitionAdd = jest.fn();

    editor.render();

    const actionContainer = editor._container.querySelector(
        '#handler-actions',
    );

    const select = actionContainer.querySelector('select');

    const inputs = actionContainer.querySelectorAll('input');

    const typeInput = inputs[inputs.length - 1];

    const addBtn = [
      ...actionContainer.querySelectorAll('button'),
    ].find(btn => btn.textContent === '+ Add');

    select.selectedIndex = 0;

    typeInput.value = 'new action';

    addBtn.click();

    expect(editor.onActionDefinitionAdd)
    .toHaveBeenCalled();
  });

  test('forwards ActionDefinitionList onRemove events', () => {
    const editor = makeEditor();

    editor.onActionDefinitionRemove = jest.fn();

    editor.render();

    const actionContainer = editor._container.querySelector(
        '#handler-actions',
    );

    const removeBtn = [
      ...actionContainer.querySelectorAll('button'),
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

    const actionContainer = editor._container.querySelector(
        '#handler-actions',
    );

    const input = actionContainer.querySelector('input');

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

  test('render handles missing generatedActionDefinitions', () => {
    const editor = makeEditor({
      id: 'handler1',
      name: 'Handler',
      handlerClass: 'HandlerEntry',

      getDescription() {
        return 'Description';
      },
    });

    expect(() => editor.render()).not.toThrow();
  });

});
