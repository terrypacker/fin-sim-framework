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
import { EChartsGraphRenderer } from "../../src/visualization/components/echarts-graph-renderer.js";
import { loadHtml, mockGraphRoot } from "../helpers/viz-utils.js";

global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeBuilderView(elements) {
  loadHtml('../../index.html');
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
// ─── DOM helpers ──────────────────────────────────────────────────────────────
function makeElements() {
  const graphRoot = mockGraphRoot();
  document.body.appendChild(graphRoot);
  return { graphRoot };
}

// ─── Graph Renderer stub ───────────────────────────────────────────────────────────────
function makeGraphRenderer(elements = makeElements()) {
  const registry = ServiceRegistry.getInstance();
  return new EChartsGraphRenderer({
    parent: null,
    graphQueryApi: registry.graphQueryApi,
    graphRoot: elements.graphRoot,
  });
}

function makePresenter() {
  const tpl = document.createElement('template');
  tpl.id = 'tpl-empty';
  tpl.innerHTML = '<div class="tl-empty">Select a node</div>';
  document.body.appendChild(tpl);
  ServiceRegistry.resetAll();
  const registry = ServiceRegistry.getInstance();
  return new GraphBuilderPresenter({
    graphRenderer:  makeGraphRenderer(),
    eventService:   registry.eventService,
    handlerService: registry.handlerService,
    actionService:  registry.actionService,
    reducerService: registry.reducerService,
  });
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
  const view = makeBuilderView();
  const container = document.createElement('div');
  view.createAndRenderEditor(makeHandlerNode('HandlerEntry'), container);

  const select = container.querySelector('[data-id="handlerClass"]');
  const options = Array.from(select.options).map(o => o.value);

  expect(options).toEqual(Object.keys(HANDLER_CLASSES));
});

test('handler editor: select value reflects the node handlerClass', () => {
  const view = makeBuilderView();
  const container = document.createElement('div');
  view.createAndRenderEditor(makeHandlerNode('MonthlyExpensesHandler'), container);

  const select = container.querySelector('[data-id="handlerClass"]');
  expect(select.value).toBe('MonthlyExpensesHandler');
});

test('handler editor: domain type (not in registry) renders as read-only badge, not select', () => {
  const view = makeBuilderView();
  const container = document.createElement('div');
  view.createAndRenderEditor(makeHandlerNode('SuperContributionHandler'), container);

  // The <select> should have been replaced by a <span> badge
  expect(container.querySelector('[data-id="handlerClass"]')).toBeNull();
  const badge = container.querySelector('.type-badge--domain');
  expect(badge).not.toBeNull();
  expect(badge.textContent).toBe('SuperContributionHandler');
});

test('handler editor: domain type badge has tooltip hint', () => {
  const view = makeBuilderView();
  const container = document.createElement('div');
  view.createAndRenderEditor(makeHandlerNode('SuperContributionHandler'), container);

  const badge = container.querySelector('.type-badge--domain');
  expect(badge.title).toMatch(/domain type/i);
});

test('handler editor: onHandlerClassChange fires when select changes', () => {
  const view = makeBuilderView();
  const container = document.createElement('div');

  let capturedId    = null;
  let capturedClass = null;
  view.onHandlerClassChange = (nodeId, newClass) => {
    capturedId    = nodeId;
    capturedClass = newClass;
  };

  view.createAndRenderEditor(makeHandlerNode('HandlerEntry'), container);

  const select = container.querySelector('[data-id="handlerClass"]');
  select.value = 'MonthlyExpensesHandler';
  select.dispatchEvent(new Event('change'));

  expect(capturedId).toBe('h1');
  expect(capturedClass).toBe('MonthlyExpensesHandler');
});


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
