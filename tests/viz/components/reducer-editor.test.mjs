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
import { ReducerEditor } from "../../../src/visualization/components/reducer-editor.js";

describe('ReducerEditor', () => {

  function makeEditor() {
    const root = document.createElement('div');

    return new ReducerEditor({
      root,
      graphRenderer: {
        relayoutAll: jest.fn()
      },
      graphQueryApi: {},
      reducerNode: {
        id: 'reducer1',
        name: 'Balance Reducer',
        type: 'FIELD_REDUCER'
      }
    });
  }

  test('constructs without error', () => {
    expect(() => makeEditor()).not.toThrow();
  });

  test('renders reducer name', () => {
    const editor = makeEditor();

    editor.render();

    expect(editor.root.innerHTML).toContain('Balance Reducer');
  });

});
