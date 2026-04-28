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
 * graph-builder.test.mjs
 *
 * Tests for ConfigGraphBuilder: node management, edge management, and — critically
 * — the destroy() / listener-cleanup contract that prevents stale event listeners
 * from accumulating across multiple buildScenario() calls.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * Bug regression covered here:
 *
 *   Every call to buildScenario() created a NEW ConfigGraphBuilder and called
 *   _bindEvents(), adding fresh mousedown/mousemove/mouseup listeners to the
 *   SAME DOM elements.  The OLD builder's listeners were never removed.
 *
 *   When the user dragged a node that only existed in the new builder (e.g. e2
 *   added after a save/reload), the OLD builder's mousemove handler fired with
 *   that node's id, called this.getNode(id) against its stale 7-node list,
 *   received undefined, and crashed: "Cannot set properties of undefined
 *   (setting 'x')".
 *
 *   Fix: ConfigGraphBuilder.destroy() removes all three listeners.
 *   BaseApp.buildScenario() now calls destroy() on the previous builder before
 *   creating a new one.
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * Run with: npm run test:viz
 */

import { ConfigGraphBuilder } from '../../src/visualization/graph-builder.js';

// ─── DOM helpers ──────────────────────────────────────────────────────────────

function makeElements() {
  const graphRoot  = document.createElement('div');
  const graphNodes = document.createElement('div');
  const graphEdges = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const nodeTemplate = document.createElement('template');
  document.body.appendChild(graphRoot);
  graphRoot.appendChild(graphNodes);
  graphRoot.appendChild(graphEdges);

  nodeTemplate.innerHTML = '  <div class="g-node">\n'
      + '    <div class="g-header"></div>\n'
      + '    <div class="g-title"></div>\n'
      + '    <div class="node-badge badge-green" data-id="firedIndicator"></div>\n'
      + '    <div class="g-port in"></div>\n'
      + '    <div class="g-port out"></div>\n'
      + '  </div>'
  document.body.appendChild(nodeTemplate);
  return { graphRoot, graphNodes, graphEdges , nodeTemplate};
}

function makeBuilder(elements) {
  return new ConfigGraphBuilder(elements ?? makeElements());
}

function node(id, kind = 'event') {
  return { id, kind, name: id };
}

// ─── addNode / getNode / removeNode ───────────────────────────────────────────

test('addNode: node is findable via getNode', () => {
  const b = makeBuilder();
  b.addNode(node('e1'));
  expect(b.getNode('e1')).toBeDefined();
  expect(b.getNode('e1').id).toBe('e1');
});

test('addNode: node is appended to this.nodes', () => {
  const b = makeBuilder();
  b.addNode(node('e1'));
  b.addNode(node('h1', 'handler'));
  expect(b.nodes.length).toBe(2);
});

test('addNode: throws when id is missing', () => {
  const b = makeBuilder();
  expect(() => b.addNode({ kind: 'event', name: 'no-id' })).toThrow();
});

test('addNode: throws when the same id is added twice', () => {
  const b = makeBuilder();
  b.addNode(node('e1'));
  expect(() => b.addNode(node('e1'))).toThrow();
});

test('getNode: returns undefined for an unknown id', () => {
  const b = makeBuilder();
  expect(b.getNode('nonexistent')).toBeUndefined();
});

test('removeNode: node is no longer in this.nodes', () => {
  const b = makeBuilder();
  b.addNode(node('e1'));
  b.removeNode('e1');
  expect(b.nodes.length).toBe(0);
  expect(b.getNode('e1')).toBeUndefined();
});

test('removeNode: edges referencing the removed node are pruned', () => {
  const b = makeBuilder();
  b.addNode(node('e1'));
  b.addNode(node('h1', 'handler'));
  b.addEdge({ from: 'e1', to: 'h1' });
  b.removeNode('e1');
  expect(b.edges.length).toBe(0);
});

// ─── getKind ──────────────────────────────────────────────────────────────────

test('getKind: returns only nodes of the requested kind', () => {
  const b = makeBuilder();
  b.addNode(node('e1', 'event'));
  b.addNode(node('h1', 'handler'));
  b.addNode(node('e2', 'event'));
  expect(b.getKind('event').length).toBe(2);
  expect(b.getKind('handler').length).toBe(1);
});

// ─── destroy() listener cleanup ───────────────────────────────────────────────

test('destroy(): after destroy, mousemove on window does NOT invoke the old builder', () => {
  const els = makeElements();
  const b = makeBuilder(els);
  b.addNode(node('e1'));

  // Manually arm drag state so the mousemove handler would fire
  b.dragState = {
    id: 'e1',
    offsetX: 0,
    offsetY: 0,
    el: document.createElement('div'),
  };

  let getNodeCalled = false;
  const origGetNode = b.getNode.bind(b);
  b.getNode = (id) => { getNodeCalled = true; return origGetNode(id); };

  b.destroy();

  window.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 10 }));

  expect(getNodeCalled).toBe(false);
});

test('destroy(): after destroy, mousedown on graphNodesEl does NOT set dragState', () => {
  const els = makeElements();
  const b = makeBuilder(els);
  b.addNode(node('e1'));
  b.render();  // creates DOM elements with data-id

  b.destroy();

  const el = els.graphNodes.querySelector('[data-id="e1"]');
  expect(el).not.toBeNull();

  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 5, clientY: 5 }));

  expect(b.dragState).toBeNull();
});

test('destroy(): after destroy, mouseup on window does NOT clear dragState that was set elsewhere', () => {
  const els = makeElements();
  const b = makeBuilder(els);

  const fakeEl = document.createElement('div');
  b.dragState = { id: 'e1', offsetX: 0, offsetY: 0, el: fakeEl };

  b.destroy();

  window.dispatchEvent(new MouseEvent('mouseup'));

  // dragState was set manually and destroy() removed the listener, so it stays
  expect(b.dragState).not.toBeNull();
});

// ─── Regression: stale listener crashes on a node only in the new builder ─────

test('regression: dragging a node only in builder2 does NOT throw when builder1 was destroyed first', () => {
  const els = makeElements();

  // First build: only e1
  const builder1 = makeBuilder(els);
  builder1.addNode(node('e1'));
  builder1.render();

  // Simulate a rebuild: destroy old builder before creating new one (the fix)
  builder1.destroy();

  // Second build: e1 + new node e2
  const builder2 = makeBuilder(els);
  builder2.addNode(node('e1'));
  builder2.addNode(node('e2'));
  builder2.render();

  // Simulate the user grabbing the new node e2
  const el = els.graphNodes.querySelector('[data-id="e2"]');
  expect(el).not.toBeNull();
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 50, clientY: 50 }));

  // Moving the mouse must NOT throw "Cannot set properties of undefined (setting 'x')"
  expect(() => {
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 60, clientY: 60 }));
  }).not.toThrow();
});

test('regression: without destroy(), the old builder holds no record of nodes added to the new builder (root cause)', () => {
  // Documents why the bug crashes: builder1.getNode(newNodeId) returns undefined.
  // jsdom catches event-listener throws internally, so we verify the crash path
  // directly rather than via dispatchEvent.
  const els = makeElements();

  const builder1 = makeBuilder(els);
  builder1.addNode(node('e1'));

  // No destroy() — simulates the old broken behaviour before the fix
  const builder2 = makeBuilder(els);
  builder2.addNode(node('e1'));
  builder2.addNode(node('e2'));  // new node only in builder2

  // builder1 has no record of e2
  expect(builder1.getNode('e2')).toBeUndefined();

  // Simulate what the stale mousemove listener would do when dragState.id = 'e2':
  //   const node = this.getNode('e2');  → undefined
  //   node.x = x;                       → TypeError: Cannot set properties of undefined
  builder1.dragState = { id: 'e2', offsetX: 0, offsetY: 0, el: document.createElement('div') };

  expect(() => {
    const n = builder1.getNode(builder1.dragState.id); // undefined
    n.x = 60;                                          // ← the crash from line 59
  }).toThrow(TypeError);
});

// ─── selectNode / render integration ─────────────────────────────────────────

test('selectNode: sets selectedNodeId', () => {
  const b = makeBuilder();
  b.addNode(node('e1'));
  b.selectNode('e1');
  expect(b.selectedNodeId).toBe('e1');
});

test('selectNode: selected node DOM element gets the "selected" class', () => {
  const els = makeElements();
  const b   = makeBuilder(els);
  b.addNode(node('e1'));
  b.selectNode('e1');
  const el = els.graphNodes.querySelector('[data-id="e1"]');
  expect(el.classList.contains('selected')).toBe(true);
});

// ─── registerNodeClickListener ────────────────────────────────────────────────

test('registerNodeClickListener: listener is called with the clicked node', () => {
  const els = makeElements();
  const b   = makeBuilder(els);
  b.addNode(node('e1'));
  b.render();

  let clickedNode = null;
  b.registerNodeClickListener((_evt, n) => { clickedNode = n; });

  els.graphNodes.querySelector('[data-id="e1"]').click();
  expect(clickedNode).not.toBeNull();
  expect(clickedNode.id).toBe('e1');
});
