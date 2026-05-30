/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import {
  GraphBuilderView
} from "../../src/visualization/graph-builder/graph-builder-view.js";
import { EChartsGraphRenderer } from "../../src/visualization/components/echarts-graph-renderer.js";
import { ServiceRegistry } from "../../src/services/service-registry.js";
import { mockGraphRoot } from "../helpers/viz-utils.js";

global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

/**
 * Skeleton test to be filled out in #137
 *
 * Run with: npm run test:viz
 */
// ─── DOM helpers ──────────────────────────────────────────────────────────────

function makeElements() {
  const graphRoot = mockGraphRoot();
  document.body.appendChild(graphRoot);
  return { graphRoot };
}

function makBuilderView(elements) {
  ServiceRegistry.resetAll();
  const registry = ServiceRegistry.getInstance();
  const { graphRoot } = elements ?? makeElements();
  return new GraphBuilderView({
    graphRenderer: new EChartsGraphRenderer({
      parent: null,
      graphQueryApi: registry.graphQueryApi,
      graphRoot,
    })
  });
}

test('GraphBuilderView: constructs without error', () => {
  expect(() => makBuilderView()).not.toThrow();
});
