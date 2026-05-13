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

import { EventEditor } from '../../../src/visualization/components/event-editor.js';

import {
  loadHtml,
  makeMockGraphRenderer,
  makeMockContainer,
} from '../../helpers/viz-utils.js';

describe('EventEditor', () => {

  beforeEach(() => {
    loadHtml('../../index.html');
  });

  function makeEditor(eventNode = makeEventSeries()) {
    return new EventEditor({
      parent: null,
      container: makeMockContainer(),
      graphRenderer: makeMockGraphRenderer(),
      node: eventNode,
    });
  }

  function makeEventSeries() {
    return {
      id: 'event1',
      name: 'Monthly Income',
      eventType: 'EventSeries',
      interval: 'monthly',
      startOffset: 2,
      color: '#00ff00',
      enabled: true,
    };
  }

  function makeOneOffEvent() {
    return {
      id: 'event2',
      name: 'Tax Payment',
      eventType: 'OneOffEvent',
      date: new Date('2026-04-15'),
      color: '#ff0000',
      enabled: false,
    };
  }

  test('constructs without error', () => {
    expect(() => makeEditor()).not.toThrow();
  });

  test('renders base fields', () => {
    const editor = makeEditor();

    editor.render();

    expect(
        editor._container.querySelector('[data-id="name"]').value,
    ).toBe('Monthly Income');

    expect(
        editor._container.querySelector('[data-id="type"]').value,
    ).toBe('EventSeries');

    expect(
        editor._container.querySelector('[data-field="color"]').value,
    ).toBe('#00ff00');

    expect(
        editor._container.querySelector('[data-field="enabled"]').checked,
    ).toBe(true);
  });

  test('renders event type options', () => {
    const editor = makeEditor();

    editor.render();

    const select = editor._container.querySelector(
        '[data-id="type"]',
    );

    expect(select.options.length).toBe(2);

    expect(
        [...select.options].map(o => o.value),
    ).toEqual([
      'EventSeries',
      'OneOffEvent',
    ]);
  });

  test('calls onEventTypeChange when type changes', () => {
    const editor = makeEditor();

    editor.onEventTypeChange = jest.fn();

    editor.render();

    const select = editor._container.querySelector(
        '[data-id="type"]',
    );

    expect(select.isConnected).toBe(true);

    select.value = 'OneOffEvent';

    select.dispatchEvent(
        new Event('change', { bubbles: true }),
    );

    expect(editor.onEventTypeChange).toHaveBeenCalledWith(
        'event1',
        'OneOffEvent',
    );
  });

  test('renders EventSeries config', () => {
    const editor = makeEditor();

    editor.render();

    const interval = editor._container.querySelector(
        '[data-field="interval"]',
    );

    const offset = editor._container.querySelector(
        '[data-field="startOffset"]',
    );

    expect(interval).not.toBeNull();
    expect(interval.value).toBe('monthly');

    expect(offset).not.toBeNull();
    expect(offset.value).toBe('2');
  });

  test('renders EventSeries interval options', () => {
    const editor = makeEditor();

    editor.render();

    const select = editor._container.querySelector(
        '[data-field="interval"]',
    );

    expect(
        [...select.options].map(o => o.value),
    ).toEqual([
      'monthly',
      'quarterly',
      'annually',
      'month-end',
      'year-end',
    ]);
  });

  test('renders OneOffEvent config', () => {
    const editor = makeEditor(makeOneOffEvent());

    editor.render();

    const dateInput = editor._container.querySelector(
        '[data-field="date"]',
    );

    expect(dateInput).not.toBeNull();

    // yyyy-mm-dd
    expect(dateInput.value).toContain('2026-04-15');
  });

  test('calls onFieldChange for select fields', () => {
    const editor = makeEditor();

    editor.onFieldChange = jest.fn();

    editor.render();

    const select = editor._container.querySelector(
        '[data-field="interval"]',
    );

    select.value = 'annually';

    select.dispatchEvent(new Event('input'));

    expect(editor.onFieldChange).toHaveBeenCalledWith(
        expect.any(Object),
        'interval',
        'annually',
    );
  });

  test('parses number fields', () => {
    const editor = makeEditor();

    editor.onFieldChange = jest.fn();

    editor.render();

    const input = editor._container.querySelector(
        '[data-field="startOffset"]',
    );

    input.value = '10';

    input.dispatchEvent(new Event('input'));

    expect(editor.onFieldChange).toHaveBeenCalledWith(
        expect.any(Object),
        'startOffset',
        10,
    );
  });

  test('parses checkbox fields', () => {
    const editor = makeEditor();

    editor.onFieldChange = jest.fn();

    editor.render();

    const checkbox = editor._container.querySelector(
        '[data-field="enabled"]',
    );

    checkbox.checked = false;

    checkbox.dispatchEvent(new Event('input'));

    expect(editor.onFieldChange).toHaveBeenCalledWith(
        expect.any(Object),
        'enabled',
        false,
    );
  });

  test('parses date fields', () => {
    const editor = makeEditor(makeOneOffEvent());

    editor.onFieldChange = jest.fn();

    editor.render();

    const input = editor._container.querySelector(
        '[data-field="date"]',
    );

    input.value = '2027-01-01';

    input.dispatchEvent(new Event('input'));

    expect(editor.onFieldChange).toHaveBeenCalledWith(
        expect.any(Object),
        'date',
        expect.any(Date),
    );
  });

  test('renderConfig safely handles unknown event type', () => {
    const editor = makeEditor({
      eventType: 'UnknownEvent',
    });

    expect(() => editor.render()).not.toThrow();
  });

  test('renders linkable multiselect section', () => {
    const editor = makeEditor();

    editor.render();

    expect(
        editor._container.querySelector('#event-handlers'),
    ).not.toBeNull();
  });

});
