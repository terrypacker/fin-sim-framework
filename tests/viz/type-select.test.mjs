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
 * type-select.test.mjs
 *
 * Guards against the timing dependency between handler-service.js augmenting
 * HANDLER_CLASSES and GraphBuilderView reading it in the constructor.
 *
 * The concern: GraphBuilderView snapshots Object.keys(HANDLER_CLASSES) in its
 * constructor.  HANDLER_CLASSES is augmented via Object.assign in
 * handler-service.js.  If the module execution order changes (e.g., the import
 * chain from graph-builder-controller → service-registry → handler-service is
 * broken), the view would only see ["HandlerEntry"] at construction time.
 *
 * The tests below construct GraphBuilderView in the same module-load context
 * that GraphBuilderPresenter uses and assert the type lists match the live
 * registries.
 *
 * Run with: npm run test:viz
 */

// HandlerService import triggers Object.assign that augments HANDLER_CLASSES.
// GraphBuilderPresenter imports this transitively via GraphBuilderController →
// ServiceRegistry → HandlerService.  Importing it here replicates that chain.
import { GraphBuilderPresenter } from '../../src/visualization/graph-builder/graph-builder-presenter.js';
import { GraphBuilderView }      from '../../src/visualization/graph-builder/graph-builder-view.js';
import { HANDLER_CLASSES } from '../../src/simulation-framework/handlers.js';
import { REDUCER_CLASSES } from '../../src/simulation-framework/reducers.js';
import { ACTION_CLASSES }  from '../../src/simulation-framework/actions.js';
import { ServiceRegistry } from '../../src/services/service-registry.js';
import {
  GraphRenderer
} from "../../src/visualization/components/graph-renderer.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeBuilderView(elements) {
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

// ─── Type list snapshot matches live registries ───────────────────────────────
//
// If HANDLER_CLASSES was not yet augmented when the constructor ran, HANDLER_TYPES
// would only contain ["HandlerEntry"] instead of the full domain class set.

test('GraphBuilderView.HANDLER_TYPES matches Object.keys(HANDLER_CLASSES) at construction time', () => {
  const view = makeBuilderView();
  expect(view.HANDLER_TYPES).toEqual(Object.keys(HANDLER_CLASSES));
});

test('GraphBuilderView.HANDLER_TYPES includes domain handler subclasses (not just HandlerEntry)', () => {
  const view = makeBuilderView();
  expect(view.HANDLER_TYPES).toContain('UsSavingsInterestMonthlyHandler');
  expect(view.HANDLER_TYPES).toContain('MonthlyExpensesHandler');
  expect(view.HANDLER_TYPES).toContain('ChangeResidencyHandler');
  expect(view.HANDLER_TYPES).toContain('OutOfFundsHandler');
});

test('GraphBuilderView.REDUCER_TYPES matches Object.keys(REDUCER_CLASSES)', () => {
  const view = makeBuilderView();
  expect(view.REDUCER_TYPES).toEqual(Object.keys(REDUCER_CLASSES));
});

test('GraphBuilderView.ACTION_TYPES matches Object.keys(ACTION_CLASSES)', () => {
  const view = makeBuilderView();
  expect(view.ACTION_TYPES).toEqual(Object.keys(ACTION_CLASSES));
});

// ─── Handler type select renders correctly ────────────────────────────────────
//
// Verifies that _renderHandlerEditor populates the <select data-id="handlerClass">
// with one <option> per registered class, and that the current value reflects
// the node's handlerClass.

function makeHandlerTemplate() {
  const tpl = document.createElement('template');
  tpl.id = 'tpl-handler-editor';
  tpl.innerHTML = `
    <div data-handler-editor>
      <div class="node">
        <div class="node-body">
          <span data-id="description"></span>
          <select data-id="handlerClass"></select>
          <input data-id="name" />
          <div id="handler-event-count"></div>
          <div id="handler-events"></div>
          <div id="handler-action-count"></div>
          <div id="handler-actions"></div>
        </div>
      </div>
    </div>`;
  return tpl;
}

function makeDeleteTemplate() {
  const tpl = document.createElement('template');
  tpl.id = 'tpl-delete-button';
  tpl.innerHTML = '<button class="delete-node-btn">Delete</button>';
  return tpl;
}

function makeHandlerNode(handlerClass = 'HandlerEntry') {
  return {
    id:   'h1',
    kind: 'handler',
    name: 'test handler',
    handlerClass,
    handledEvents:              [],
    generatedActionTypes:       [],
    generatedActionDefinitions: [],
    getDescription() { return `${handlerClass} description`; },
  };
}

test('handler editor: select is populated with all HANDLER_CLASSES keys', () => {
  document.body.appendChild(makeHandlerTemplate());
  document.body.appendChild(makeDeleteTemplate());

  const view = makeBuilderView();
  view.editNode(makeHandlerNode('HandlerEntry'));

  const select = view._canvas.querySelector('[data-id="handlerClass"]');
  const options = Array.from(select.options).map(o => o.value);

  expect(options).toEqual(Object.keys(HANDLER_CLASSES));
});

test('handler editor: select value reflects the node handlerClass', () => {
  const view = makeBuilderView();
  view.editNode(makeHandlerNode('MonthlyExpensesHandler'));

  const select = view._canvas.querySelector('[data-id="handlerClass"]');
  expect(select.value).toBe('MonthlyExpensesHandler');
});

test('handler editor: domain type (not in registry) renders as read-only badge, not select', () => {
  const view = makeBuilderView();
  view.editNode(makeHandlerNode('SuperContributionHandler'));

  // The <select> should have been replaced by a <span> badge
  expect(view._canvas.querySelector('[data-id="handlerClass"]')).toBeNull();
  const badge = view._canvas.querySelector('.type-badge--domain');
  expect(badge).not.toBeNull();
  expect(badge.textContent).toBe('SuperContributionHandler');
});

test('handler editor: domain type badge has tooltip hint', () => {
  const view = makeBuilderView();
  view.editNode(makeHandlerNode('SuperContributionHandler'));

  const badge = view._canvas.querySelector('.type-badge--domain');
  expect(badge.title).toMatch(/domain type/i);
});

test('handler editor: onHandlerClassChange fires when select changes', () => {
  document.body.appendChild(makeHandlerTemplate());
  const view = makeBuilderView();

  let capturedId    = null;
  let capturedClass = null;
  view.onHandlerClassChange = (nodeId, newClass) => {
    capturedId    = nodeId;
    capturedClass = newClass;
  };

  view.editNode(makeHandlerNode('HandlerEntry'));

  const select = view._canvas.querySelector('[data-id="handlerClass"]');
  select.value = 'MonthlyExpensesHandler';
  select.dispatchEvent(new Event('change'));

  expect(capturedId).toBe('h1');
  expect(capturedClass).toBe('MonthlyExpensesHandler');
});

// ─── Presenter wires onHandlerClassChange ─────────────────────────────────────

// ─── DOM helpers ──────────────────────────────────────────────────────────────
function makeElements() {
  const builderCanvas = document.createElement('div');
  const graphRoot  = document.createElement('div');
  graphRoot.id = 'graphRoot';
  const graphViewPort = document.createElement('div');
  graphViewPort.id = 'graphViewport';
  const graphEdges = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  graphEdges.id = 'graphEdges';
  const graphNodes = document.createElement('div');
  graphNodes.id = 'graphNodes';
  const selectionBox = document.createElement('div');
  selectionBox.classList.add('selection-box');

  const nodeDetailsTemplate = document.createElement('template');

  document.body.appendChild(graphRoot);
  graphRoot.appendChild(graphViewPort);
  graphViewPort.appendChild(graphEdges);
  graphViewPort.appendChild(graphNodes);
  graphViewPort.appendChild(selectionBox);

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

// ─── Graph Renderer stub ───────────────────────────────────────────────────────────────
function makeGraphRenderer(elements = makeElements()) {
  const registry = ServiceRegistry.getInstance();
  return new GraphRenderer({
    parent: null,
    graph: registry.graph,
    graphQueryApi: registry.graphQueryApi,
    graphRoot: elements.graphRoot,
    graphNodes: elements.graphNodes,
    graphEdges: elements.graphEdges,
    nodeDetailsTemplate: elements.nodeDetailsTemplate,
    displayNodeStateChanges: (changes) => {}
  });
}

function makePresenter() {
  const tpl = document.createElement('template');
  tpl.id = 'tpl-empty';
  tpl.innerHTML = '<div class="tl-empty">Select a node</div>';
  document.body.appendChild(tpl);
  ServiceRegistry.reset();
  const registry = ServiceRegistry.getInstance();
  return new GraphBuilderPresenter({
    graphRenderer:         makeGraphRenderer(),
    builderCanvas: document.createElement('div'),
    eventService: registry.eventService,
    handlerService: registry.handlerService,
    actionService: registry.actionService,
    reducerService: registry.reducerService
  });
}

test('GraphBuilderPresenter: replaceHandler is called when onHandlerClassChange fires', () => {
  const presenter = makePresenter();
  const { handlerService } = ServiceRegistry.getInstance();

  const original = handlerService.createHandler(null, 'h-test');

  let replacedId    = null;
  let replacedClass = null;
  const origReplace = handlerService.replaceHandler.bind(handlerService);
  handlerService.replaceHandler = (id, cls) => {
    replacedId    = id;
    replacedClass = cls;
    return origReplace(id, cls);
  };

  // Simulate the presenter's onHandlerClassChange path directly
  presenter._view.onHandlerClassChange(original.id, 'MonthlyExpensesHandler');

  handlerService.replaceHandler = origReplace;

  expect(replacedId).toBe(original.id);
  expect(replacedClass).toBe('MonthlyExpensesHandler');
});
