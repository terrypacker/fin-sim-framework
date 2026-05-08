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
import {
  GraphRenderer
} from "../../src/visualization/components/graph-renderer.js";
import {ServiceRegistry} from "../../src/services/service-registry.js";


/**
 * Skeleton test to be filled out in #137
 *
 * Run with: npm run test:viz
 */
// ─── DOM helpers ──────────────────────────────────────────────────────────────

function makeElements() {
  const builderCanvas = document.createElement('div');
  const graphRoot  = document.createElement('div');
  const graphNodes = document.createElement('div');
  const graphEdges = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const nodeDetailsTemplate = document.createElement('template');
  document.body.appendChild(graphRoot);
  graphRoot.appendChild(graphNodes);
  graphRoot.appendChild(graphEdges);

  nodeDetailsTemplate.innerHTML = '<div class="g-node">\n'
      + '    <div class="g-header">\n'
      + '      <span class="g-header-text"></span>\n'
      + '      <span class="node-state-badge badge-green" data-id="stateChangeIndicator" style="display:none"></span>\n'
      + '      <span class="node-fired-badge badge-green" data-id="firedIndicator"></span>\n'
      + '    </div>\n'
      + '    <div class="g-title">\n'
      + '      <span class="g-title-text"></span>\n'
      + '    </div>\n'
      + '\n'
      + '    <div class="g-port in"></div>\n'
      + '    <div class="g-port out"></div>\n'
      + '  </div>'
  document.body.appendChild(nodeDetailsTemplate);
  return { builderCanvas, graphRoot, graphNodes, graphEdges , nodeDetailsTemplate};
}

function makBuilderView(elements) {
  ServiceRegistry.reset();
  const registry = ServiceRegistry.getInstance();
  const { builderCanvas, graphRoot, graphNodes, graphEdges, nodeDetailsTemplate } = elements ?? makeElements();
  return new GraphBuilderView({
    builderCanvas,
    graphRenderer: new GraphRenderer({
      parent: null,
      graph: registry.graph,
      graphQueryApi: registry.graphQueryApi,
      graphRoot,
      graphNodes,
      graphEdges,
      nodeDetailsTemplate,
      displayNodeStateChanges: (changes) => {}
    })
  });
}

test('GraphBuilderView: constructs without error', () => {
  expect(() => makBuilderView()).not.toThrow();
});
