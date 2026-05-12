/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */
import { jest }            from '@jest/globals';
import { EventEditor } from "../../../src/visualization/components/event-editor.js";

describe('EventEditor', () => {

  function makeEditor() {
    const root = document.createElement('div');

    return new EventEditor({
      root,
      graphRenderer: {
        relayoutAll: jest.fn()
      },
      graphQueryApi: {},
      eventBus: {},
      eventNode: {
        id: 'event1',
        name: 'Monthly Salary',
        type: 'series'
      }
    });
  }

  test('constructs without error', () => {
    expect(() => makeEditor()).not.toThrow();
  });

  test('renders event name', () => {
    const editor = makeEditor();

    editor.render();

    expect(editor.root.innerHTML).toContain('Monthly Salary');
  });

});
