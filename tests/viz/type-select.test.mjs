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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMinimalGraph() {
  return {
    // graphRoot without a parentElement → _buildControls() returns early (no error)
    graphRoot: document.createElement('div'),
    _graph: ServiceRegistry.getInstance().graph,
    _graphQueryApi: ServiceRegistry.getInstance().graphQueryApi
  };
}

function makeView() {
  return new GraphBuilderView({
    builderCanvas: document.createElement('div'),
    graph: makeMinimalGraph(),
  });
}

// ─── Type list snapshot matches live registries ───────────────────────────────
//
// If HANDLER_CLASSES was not yet augmented when the constructor ran, HANDLER_TYPES
// would only contain ["HandlerEntry"] instead of the full domain class set.

test('GraphBuilderView.HANDLER_TYPES matches Object.keys(HANDLER_CLASSES) at construction time', () => {
  const view = makeView();
  expect(view.HANDLER_TYPES).toEqual(Object.keys(HANDLER_CLASSES));
});

test('GraphBuilderView.HANDLER_TYPES includes domain handler subclasses (not just HandlerEntry)', () => {
  const view = makeView();
  expect(view.HANDLER_TYPES).toContain('UsSavingsInterestMonthlyHandler');
  expect(view.HANDLER_TYPES).toContain('MonthlyExpensesHandler');
  expect(view.HANDLER_TYPES).toContain('ChangeResidencyHandler');
  expect(view.HANDLER_TYPES).toContain('OutOfFundsHandler');
});

test('GraphBuilderView.REDUCER_TYPES matches Object.keys(REDUCER_CLASSES)', () => {
  const view = makeView();
  expect(view.REDUCER_TYPES).toEqual(Object.keys(REDUCER_CLASSES));
});

test('GraphBuilderView.ACTION_TYPES matches Object.keys(ACTION_CLASSES)', () => {
  const view = makeView();
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
  const canvas = document.createElement('div');
  document.body.appendChild(makeHandlerTemplate());
  document.body.appendChild(makeDeleteTemplate());

  const view = new GraphBuilderView({ builderCanvas: canvas, graph: makeMinimalGraph() });
  view.editNode(makeHandlerNode('HandlerEntry'));

  const select = canvas.querySelector('[data-id="handlerClass"]');
  const options = Array.from(select.options).map(o => o.value);

  expect(options).toEqual(Object.keys(HANDLER_CLASSES));
});

test('handler editor: select value reflects the node handlerClass', () => {
  const canvas = document.createElement('div');
  const view = new GraphBuilderView({ builderCanvas: canvas, graph: makeMinimalGraph() });
  view.editNode(makeHandlerNode('MonthlyExpensesHandler'));

  const select = canvas.querySelector('[data-id="handlerClass"]');
  expect(select.value).toBe('MonthlyExpensesHandler');
});

test('handler editor: domain type (not in registry) renders as read-only badge, not select', () => {
  const canvas = document.createElement('div');
  const view = new GraphBuilderView({ builderCanvas: canvas, graph: makeMinimalGraph() });
  view.editNode(makeHandlerNode('SuperContributionHandler'));

  // The <select> should have been replaced by a <span> badge
  expect(canvas.querySelector('[data-id="handlerClass"]')).toBeNull();
  const badge = canvas.querySelector('.type-badge--domain');
  expect(badge).not.toBeNull();
  expect(badge.textContent).toBe('SuperContributionHandler');
});

test('handler editor: domain type badge has tooltip hint', () => {
  const canvas = document.createElement('div');
  const view = new GraphBuilderView({ builderCanvas: canvas, graph: makeMinimalGraph() });
  view.editNode(makeHandlerNode('SuperContributionHandler'));

  const badge = canvas.querySelector('.type-badge--domain');
  expect(badge.title).toMatch(/domain type/i);
});

test('handler editor: onHandlerClassChange fires when select changes', () => {
  const canvas = document.createElement('div');
  const view = new GraphBuilderView({ builderCanvas: canvas, graph: makeMinimalGraph() });

  let capturedId    = null;
  let capturedClass = null;
  view.onHandlerClassChange = (nodeId, newClass) => {
    capturedId    = nodeId;
    capturedClass = newClass;
  };

  view.editNode(makeHandlerNode('HandlerEntry'));

  const select = canvas.querySelector('[data-id="handlerClass"]');
  select.value = 'MonthlyExpensesHandler';
  select.dispatchEvent(new Event('change'));

  expect(capturedId).toBe('h1');
  expect(capturedClass).toBe('MonthlyExpensesHandler');
});

// ─── Presenter wires onHandlerClassChange ─────────────────────────────────────

function makeGraph() {
  const nodes = [];
  return {
    graphRoot: document.createElement('div'),
    nodes,
    getNode(id)        { return nodes.find(n => n.id === id); },
    getKind(kind)      { return nodes.filter(n => n.kind === kind); },
    addNode(n)         { nodes.push(n); },
    replaceNode(id, n) { const i = nodes.findIndex(x => x.id === id); if (i >= 0) nodes[i] = n; },
    removeNode(id)     { const i = nodes.findIndex(x => x.id === id); if (i >= 0) nodes.splice(i, 1); },
    addEdge()          {},
    removeEdge()       {},
    getNodesToKindFromMe() { return []; },
    getNodesFromKindToMe() { return []; },
    render()           {},
    registerNodeClickListener() {},
    selectNode()       {},
    getAll() { return nodes; }
  };
}

function makePresenter() {
  const tpl = document.createElement('template');
  tpl.id = 'tpl-empty';
  tpl.innerHTML = '<div class="tl-empty">Select a node</div>';
  document.body.appendChild(tpl);
  ServiceRegistry.reset();
  const registry = ServiceRegistry.getInstance();
  return new GraphBuilderPresenter({
    graph:         makeGraph(),
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
