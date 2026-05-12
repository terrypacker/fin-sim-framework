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
import { HandlerEditor } from "../../../src/visualization/components/handler-editor.js";

describe('HandlerEditor', () => {

  function makeEditor() {
    const root = document.createElement('div');

    return new HandlerEditor({
      root,
      graphRenderer: {
        relayoutAll: jest.fn()
      },
      graphQueryApi: {},
      handlerNode: {
        id: 'handler1',
        name: 'Salary Handler',
        description: 'Processes salary events'
      }
    });
  }

  test('constructs without error', () => {
    expect(() => makeEditor()).not.toThrow();
  });

  test('renders handler name', () => {
    const editor = makeEditor();

    editor.render();

    expect(editor.root.innerHTML).toContain('Salary Handler');
  });

});
