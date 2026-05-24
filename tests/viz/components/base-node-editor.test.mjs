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
import { BaseNodeEditor } from "../../../src/visualization/components/base-node-editor.js";
import { makeMockContainer } from '../../helpers/viz-utils.js';

describe('BaseNodeEditor', () => {

  class TestEditor extends BaseNodeEditor {
    render() {
      const div = document.createElement('div');
      this.mount(div);
    }
  }

  function makeEditor() {
    const container = makeMockContainer();

    return new TestEditor({
      parent: null,
      container: container,
      graphRenderer: {
        relayoutAll: jest.fn()
      }
    });
  }

  test('constructs without error', () => {
    expect(() => makeEditor()).not.toThrow();
  });

  test('cleanup removes listeners', () => {
    const editor = makeEditor();

    editor.render();

    const button = document.createElement('button');
    const handler = jest.fn();

    editor.listen(button, 'click', handler);

    button.click();
    expect(handler).toHaveBeenCalledTimes(1);

    editor.destroy();

    button.click();
    expect(handler).toHaveBeenCalledTimes(1);
  });

});
