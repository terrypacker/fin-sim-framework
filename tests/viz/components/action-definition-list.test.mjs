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

import { ActionDefinitionList } from '../../../src/visualization/components/action-definition-list.js';

import {
  makeMockContainer,
} from '../../helpers/viz-utils.js';

import {
  ACTION_TEMPLATES,
} from '../../../src/simulation-framework/action-templates.js';

describe('ActionDefinitionList', () => {

  function makeNode() {
    return {
      id: 'node1',
      generatedActionDefinitions: [
        {
          id: 'def1',
          type: 'ADD_CASH',
          config: {
            actionClass: 'AmountAction',
          },
        },
        {
          id: 'def2',
          type: 'RECORD_METRIC',
          config: {
            actionClass: 'FieldAction',
          },
        },
      ],
    };
  }

  function makeComponent(node = makeNode()) {
    return new ActionDefinitionList({
      parent: null,
      container: makeMockContainer(),
      node,
    });
  }

  test('constructs without error', () => {
    expect(() => makeComponent()).not.toThrow();
  });

  test('renders existing action definitions', () => {
    const component = makeComponent();

    component.render();

    const inputs = component._container.querySelectorAll('input');

    expect(inputs.length).toBeGreaterThanOrEqual(2);

    expect(inputs[0].value).toBe('ADD_CASH');
    expect(inputs[1].value).toBe('RECORD_METRIC');
  });

  test('renders remove buttons for each definition', () => {
    const component = makeComponent();

    component.render();

    const buttons = [
      ...component._container.querySelectorAll('button'),
    ].filter(btn => btn.textContent === '✕');

    expect(buttons.length).toBe(2);
  });

  test('calls onUpdate when type input changes', () => {
    const node = makeNode();

    const component = makeComponent(node);

    component.onUpdate = jest.fn();

    component.render();

    const input = component._container.querySelector('input');

    input.value = 'UPDATED_ACTION';

    input.dispatchEvent(
        new Event('input', { bubbles: true }),
    );

    expect(component.onUpdate).toHaveBeenCalledWith(
        node,
        'def1',
        'type',
        'UPDATED_ACTION',
    );
  });

  test('calls onRemove when remove button clicked', () => {
    const node = makeNode();

    const component = makeComponent(node);

    component.onRemove = jest.fn();

    component.render();

    const removeBtn = [
      ...component._container.querySelectorAll('button'),
    ].find(btn => btn.textContent === '✕');

    removeBtn.click();

    expect(component.onRemove).toHaveBeenCalledWith(
        node,
        'def1',
    );
  });

  test('renders add form select options from ACTION_TEMPLATES', () => {
    const component = makeComponent();

    component.render();

    const select = component._container.querySelector('select');

    expect(select).not.toBeNull();

    expect(select.options.length).toBe(
        ACTION_TEMPLATES.length,
    );
  });

  test('renders add button', () => {
    const component = makeComponent();

    component.render();

    const addBtn = [
      ...component._container.querySelectorAll('button'),
    ].find(btn => btn.textContent === '+ Add');

    expect(addBtn).not.toBeNull();
  });

  test('calls onAdd with normalized action type', () => {
    const node = makeNode();

    const component = makeComponent(node);

    component.onAdd = jest.fn();

    component.render();

    const select = component._container.querySelector('select');

    const textInputs = [
      ...component._container.querySelectorAll('input'),
    ];

    // last input belongs to add form
    const typeInput = textInputs[textInputs.length - 1];

    const addBtn = [
      ...component._container.querySelectorAll('button'),
    ].find(btn => btn.textContent === '+ Add');

    const template = ACTION_TEMPLATES[0];

    select.value = template.id;

    typeInput.value = 'my custom action';

    addBtn.click();

    expect(component.onAdd).toHaveBeenCalledWith(
        node,
        {
          type: 'MY_CUSTOM_ACTION',
          config: {
            actionClass: template.actionClass,
            ...template.defaultConfig,
          },
        },
    );
  });

  test('clears add form input after successful add', () => {
    const component = makeComponent();

    component.onAdd = jest.fn();

    component.render();

    const textInputs = [
      ...component._container.querySelectorAll('input'),
    ];

    const typeInput = textInputs[textInputs.length - 1];

    const addBtn = [
      ...component._container.querySelectorAll('button'),
    ].find(btn => btn.textContent === '+ Add');

    typeInput.value = 'new action';

    addBtn.click();

    expect(typeInput.value).toBe('');
  });

  test('does not call onAdd when type input is empty', () => {
    const component = makeComponent();

    component.onAdd = jest.fn();

    component.render();

    const addBtn = [
      ...component._container.querySelectorAll('button'),
    ].find(btn => btn.textContent === '+ Add');

    addBtn.click();

    expect(component.onAdd).not.toHaveBeenCalled();
  });

  test('does not throw when generatedActionDefinitions is missing', () => {
    const component = makeComponent({
      id: 'node1',
    });

    expect(() => component.render()).not.toThrow();
  });

  test('renders only add form when generatedActionDefinitions is empty', () => {
    const component = makeComponent({
      id: 'node1',
      generatedActionDefinitions: [],
    });

    component.render();

    const removeButtons = [
      ...component._container.querySelectorAll('button'),
    ].filter(btn => btn.textContent === '✕');

    expect(removeButtons.length).toBe(0);

    const addBtn = [
      ...component._container.querySelectorAll('button'),
    ].find(btn => btn.textContent === '+ Add');

    expect(addBtn).not.toBeNull();
  });

});
