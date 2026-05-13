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
import fs from 'fs';
import { fileURLToPath } from 'url';

// ─────────────────────────────────────────────────────────────────────────────
// DOM setup
// ─────────────────────────────────────────────────────────────────────────────
export function loadHtml(htmlFile) {

  const htmlPath = fileURLToPath(
      new URL(htmlFile, import.meta.url)
  );
  document.body.innerHTML = fs.readFileSync(htmlPath, 'utf8');
}

export function makeMockGraphRenderer() {
  return {
    relayoutAll: jest.fn(),
    _graphQueryApi: {
      getRelated: jest.fn(() => []),
    },
  };
}

export function makeMockContainer() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return container;
}
