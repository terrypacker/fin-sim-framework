/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Tests for ConfigGraphView — specifically the filter-bar lifecycle.
 *
 * Run with: npm run test:viz
 *
 * Note: jest.fn() / jest.spyOn() are unavailable in native ESM under
 * --experimental-vm-modules; all call tracking uses plain closures.
 */

import { ConfigGraphView } from '../../src/visualization/graph-builder/config-graph-view.js';
import { ServiceRegistry }  from '../../src/services/service-registry.js';

// eCharts uses ResizeObserver for auto-resize; jsdom doesn't provide it.
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

// ─── DOM helpers ──────────────────────────────────────────────────────────────

function makeElements() {
  const panel        = document.createElement('div');
  const graphRoot    = document.createElement('div');
  const graphViewPort = document.createElement('div');
  const graphEdges   = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const graphNodes   = document.createElement('div');
  const selectionBox = document.createElement('div');
  selectionBox.classList.add('selection-box');

  const nodeDetailsTemplate = document.createElement('template');
  nodeDetailsTemplate.innerHTML =
    '<div class="g-node">' +
    '  <div class="g-header"><span class="g-header-text"></span>' +
    '    <span class="node-state-badge badge-green" data-id="stateChangeIndicator" style="display:none"></span>' +
    '    <span class="node-fired-badge badge-green" data-id="firedIndicator"></span>' +
    '  </div>' +
    '  <div class="g-title"><span class="g-title-text"></span></div>' +
    '  <div class="g-port in"></div><div class="g-port out"></div>' +
    '</div>';

  panel.appendChild(graphRoot);
  graphRoot.appendChild(graphViewPort);
  graphViewPort.appendChild(graphEdges);
  graphViewPort.appendChild(graphNodes);
  graphViewPort.appendChild(selectionBox);

  document.body.appendChild(panel);
  document.body.appendChild(nodeDetailsTemplate);

  return { panel, graphRoot, graphNodes, graphEdges, nodeDetailsTemplate };
}

function makeConfigGraphView(elements = makeElements()) {
  ServiceRegistry.reset();
  const registry = ServiceRegistry.getInstance();
  return new ConfigGraphView({
    parent:                  null,
    graph:                   registry.graph,
    graphQueryApi:           registry.graphQueryApi,
    graphRoot:               elements.graphRoot,
    graphNodes:              elements.graphNodes,
    graphEdges:              elements.graphEdges,
    nodeDetailsTemplate:     elements.nodeDetailsTemplate,
    displayNodeStateChanges: () => {},
  });
}

afterEach(() => {
  document.body.innerHTML = '';
});

// ─── Construction ─────────────────────────────────────────────────────────────

test('ConfigGraphView: constructs without error', () => {
  expect(() => makeConfigGraphView()).not.toThrow();
});

test('ConfigGraphView: inserts exactly one filter bar into the panel on construction', () => {
  const els = makeElements();
  makeConfigGraphView(els);
  expect(els.panel.querySelectorAll('.graph-filter-bar')).toHaveLength(1);
});

// ─── Filter bar DOM lifecycle ─────────────────────────────────────────────────

test('ConfigGraphView: destroy() removes the filter bar from the DOM', () => {
  const els  = makeElements();
  const view = makeConfigGraphView(els);

  expect(els.panel.querySelectorAll('.graph-filter-bar')).toHaveLength(1);

  view.destroy();

  expect(els.panel.querySelectorAll('.graph-filter-bar')).toHaveLength(0);
});

test('ConfigGraphView: re-creating on the same panel after destroy() leaves exactly one filter bar (regression: scenario reload)', () => {
  // This is the bug scenario: user clicks Load in the Scenario tab, which calls
  // destroyScenario() then initScenario().  Without calling destroy() on the old
  // ConfigGraphView the filter bar DOM is never removed and a second bar is added.
  const els = makeElements();

  const view1 = makeConfigGraphView(els);
  expect(els.panel.querySelectorAll('.graph-filter-bar')).toHaveLength(1);

  view1.destroy();

  const view2 = makeConfigGraphView(els);
  expect(els.panel.querySelectorAll('.graph-filter-bar')).toHaveLength(1);

  view2.destroy();
});
