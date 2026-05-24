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
 * service-registry.test.mjs
 * Tests for ServiceRegistry, ServiceActionEvent, and all configuration services.
 * Run with: node --test tests/service-registry.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ServiceRegistry } from '../../src/services/service-registry.js';
import { ServiceActionEvent } from '../../src/simulation-framework/bus-messages.js';
import { ActionService }  from '../../src/services/action-service.js';
import { EventService }   from '../../src/services/event-service.js';
import { HandlerService } from '../../src/services/handler-service.js';
import { ReducerService } from '../../src/services/reducer-service.js';

import {
  AmountAction,
  Action,
  FieldAction,
  FieldValueAction,
  RecordBalanceAction,
} from '../../src/simulation-framework/actions.js';

import { EventSeries }  from '../../src/simulation-framework/events/event-series.js';
import { OneOffEvent }  from '../../src/simulation-framework/events/one-off-event.js';
import { HandlerEntry } from '../../src/simulation-framework/handlers.js';
import {
  ArrayReducer,
  NumericSumReducer,
  MultiplicativeReducer,
  NoOpReducer,
  FieldReducer,
} from '../../src/simulation-framework/reducers.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Collect all SERVICE_ACTION events from a fresh registry, run work, return events. */
function captureServiceEvents(work) {
  ServiceRegistry.reset();
  const registry = ServiceRegistry.getInstance();
  const events = [];
  registry.bus.subscribe('SERVICE_ACTION', e => events.push(e));
  work(registry);
  return events;
}

// Reset the singleton before every test so tests are fully isolated.
beforeEach(() => ServiceRegistry.reset());

// ─── ServiceRegistry singleton ────────────────────────────────────────────────

test('ServiceRegistry: getInstance returns the same instance', () => {
  const a = ServiceRegistry.getInstance();
  const b = ServiceRegistry.getInstance();
  assert.strictEqual(a, b);
});

test('ServiceRegistry: reset creates a new instance on next call', () => {
  const a = ServiceRegistry.getInstance();
  ServiceRegistry.reset();
  const b = ServiceRegistry.getInstance();
  assert.notStrictEqual(a, b);
});

test('ServiceRegistry: exposes actionService, eventService, handlerService, reducerService', () => {
  const r = ServiceRegistry.getInstance();
  assert.ok(r.actionService  instanceof ActionService);
  assert.ok(r.eventService   instanceof EventService);
  assert.ok(r.handlerService instanceof HandlerService);
  assert.ok(r.reducerService instanceof ReducerService);
});

test('ServiceRegistry: all services share the same EventBus instance', () => {
  const r = ServiceRegistry.getInstance();
  assert.strictEqual(r.actionService.bus,  r.bus);
  assert.strictEqual(r.eventService.bus,   r.bus);
  assert.strictEqual(r.handlerService.bus, r.bus);
  assert.strictEqual(r.reducerService.bus, r.bus);
});

// ─── ServiceActionEvent shape ─────────────────────────────────────────────────

test('ServiceActionEvent: has bus type SERVICE_ACTION', () => {
  const evt = new ServiceActionEvent({ actionType: 'CREATE', classType: 'AmountAction', item: {} });
  assert.strictEqual(evt.type, 'SERVICE_ACTION');
});

test('ServiceActionEvent: CREATE has null originalItem by default', () => {
  const evt = new ServiceActionEvent({ actionType: 'CREATE', classType: 'AmountAction', item: {} });
  assert.strictEqual(evt.originalItem, null);
});

test('ServiceActionEvent: UPDATE carries both item and originalItem', () => {
  const original = { name: 'old' };
  const updated  = { name: 'new' };
  const evt = new ServiceActionEvent({ actionType: 'UPDATE', classType: 'AmountAction', item: updated, originalItem: original });
  assert.strictEqual(evt.item, updated);
  assert.strictEqual(evt.originalItem, original);
});

// ─── ActionService ────────────────────────────────────────────────────────────

test('ActionService: createAmountAction returns an AmountAction', () => {
  const events = captureServiceEvents(({ actionService }) => {
    const a = actionService.createAmountAction('SALARY', 'Salary', 5000);
    assert.ok(a instanceof AmountAction);
    assert.strictEqual(a.type, 'SALARY');
    assert.strictEqual(a.name, 'Salary');
    assert.strictEqual(a.value, 5000);
  });
  assert.strictEqual(events.length, 1);
});

test('ActionService: createAmountAction publishes CREATE ServiceActionEvent', () => {
  const events = captureServiceEvents(({ actionService }) => {
    actionService.createAmountAction('SALARY', 'Salary', 5000);
  });
  const [evt] = events;
  assert.strictEqual(evt.actionType,  'CREATE');
  assert.strictEqual(evt.classType,   'AmountAction');
  assert.ok(evt.item instanceof AmountAction);
  assert.strictEqual(evt.originalItem, null);
});

test('ActionService: createAction returns a Action', () => {
  const events = captureServiceEvents(({ actionService }) => {
    const a = actionService.createAction('REC', 'Record');
    assert.ok(a instanceof Action);
  });
  assert.strictEqual(events[0].classType, 'Action');
});

test('ActionService: createFieldAction returns a FieldAction', () => {
  const events = captureServiceEvents(({ actionService }) => {
    const a = actionService.createFieldAction('REC', 'Record', 'balance');
    assert.ok(a instanceof FieldAction);
  });
  assert.strictEqual(events[0].classType, 'FieldAction');
});

test('ActionService: createFieldValueAction returns a FieldValueAction', () => {
  const events = captureServiceEvents(({ actionService }) => {
    const a = actionService.createFieldValueAction('REC', 'Record', 'balance', 100);
    assert.ok(a instanceof FieldValueAction);
  });
  assert.strictEqual(events[0].classType, 'FieldValueAction');
});

test('ActionService: createRecordBalanceAction returns a RecordBalanceAction', () => {
  captureServiceEvents(({ actionService }) => {
    const a = actionService.createRecordBalanceAction();
    assert.ok(a instanceof RecordBalanceAction);
  });
});

test('ActionService: updateAction mutates in-place and publishes UPDATE event', () => {
  ServiceRegistry.reset();
  const registry = ServiceRegistry.getInstance();
  const a = registry.actionService.createAmountAction('SALARY', 'Salary', 5000);
  const updateEvents = [];
  registry.bus.subscribe('SERVICE_ACTION', e => { if (e.actionType === 'UPDATE') updateEvents.push(e); });
  registry.actionService.updateAction(a, { value: 6000 });
  assert.strictEqual(a.value, 6000);
  assert.strictEqual(updateEvents.length, 1);
  assert.strictEqual(updateEvents[0].actionType,         'UPDATE');
  assert.strictEqual(updateEvents[0].classType,          'AmountAction');
  assert.strictEqual(updateEvents[0].item.value,         6000);
  assert.strictEqual(updateEvents[0].originalItem.value, 5000);
});

test('ActionService: updateAction originalItem is a separate object from item', () => {
  ServiceRegistry.reset();
  const registry = ServiceRegistry.getInstance();
  const a = registry.actionService.createAmountAction('X', 'X', 1);
  let evt;
  registry.bus.subscribe('SERVICE_ACTION', e => { if (e.actionType === 'UPDATE') evt = e; });
  registry.actionService.updateAction(a, { value: 2 });
  assert.notStrictEqual(evt.item, evt.originalItem);
});

test('ActionService: deleteAction publishes DELETE event', () => {
  ServiceRegistry.reset();
  const registry = ServiceRegistry.getInstance();
  const a = registry.actionService.createAmountAction('X', 'X', 0);
  const deleteEvents = [];
  registry.bus.subscribe('SERVICE_ACTION', e => { if (e.actionType === 'DELETE') deleteEvents.push(e); });
  registry.actionService.deleteAction(a);
  assert.strictEqual(deleteEvents.length, 1);
  assert.strictEqual(deleteEvents[0].actionType, 'DELETE');
  assert.strictEqual(deleteEvents[0].classType,  'AmountAction');
  assert.ok(deleteEvents[0].item instanceof AmountAction);
});

// ─── EventService ─────────────────────────────────────────────────────────────

test('EventService: createEventSeries returns an EventSeries and publishes CREATE', () => {
  const events = captureServiceEvents(({ eventService }) => {
    const e = eventService.createEventSeries({
      id: 'e1', name: 'Monthly', type: 'MONTHLY', interval: 'monthly'
    });
    assert.ok(e instanceof EventSeries);
    assert.strictEqual(e.interval, 'monthly');
  });
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].actionType, 'CREATE');
  assert.strictEqual(events[0].classType,  'EventSeries');
});

test('EventService: createOneOffEvent returns a OneOffEvent and publishes CREATE', () => {
  const events = captureServiceEvents(({ eventService }) => {
    const e = eventService.createOneOffEvent({
      id: 'e2', name: 'Bonus', type: 'BONUS', date: new Date(2026, 5, 1)
    });
    assert.ok(e instanceof OneOffEvent);
  });
  assert.strictEqual(events[0].classType, 'OneOffEvent');
});

test('EventService: updateEvent mutates in-place and publishes UPDATE', () => {
  ServiceRegistry.reset();
  const registry = ServiceRegistry.getInstance();
  const e = registry.eventService.createEventSeries({ id: 'e1', name: 'Old', type: 'T', interval: 'monthly' });
  let evt;
  registry.bus.subscribe('SERVICE_ACTION', ev => { if (ev.actionType === 'UPDATE') evt = ev; });
  registry.eventService.updateEvent(e, { name: 'New' });
  assert.strictEqual(e.name,              'New');
  assert.strictEqual(evt.actionType,      'UPDATE');
  assert.strictEqual(evt.item.name,       'New');
  assert.strictEqual(evt.originalItem.name, 'Old');
});

test('EventService: deleteEvent publishes DELETE', () => {
  ServiceRegistry.reset();
  const registry = ServiceRegistry.getInstance();
  const e = registry.eventService.createOneOffEvent({ id: 'e1', name: 'X', type: 'X', date: new Date() });
  let evt;
  registry.bus.subscribe('SERVICE_ACTION', ev => { if (ev.actionType === 'DELETE') evt = ev; });
  registry.eventService.deleteEvent(e);
  assert.strictEqual(evt.actionType, 'DELETE');
  assert.strictEqual(evt.classType,  'OneOffEvent');
});

// ─── HandlerService ───────────────────────────────────────────────────────────

test('HandlerService: createHandler returns a HandlerEntry and publishes CREATE', () => {
  const events = captureServiceEvents(({ handlerService }) => {
    const h = handlerService.createHandler(null, 'My Handler');
    assert.ok(h instanceof HandlerEntry);
    assert.strictEqual(h.name, 'My Handler');
  });
  assert.strictEqual(events[0].actionType, 'CREATE');
  assert.strictEqual(events[0].classType,  'HandlerEntry');
});

test('HandlerService: createHandler with default name', () => {
  captureServiceEvents(({ handlerService }) => {
    const h = handlerService.createHandler();
    assert.strictEqual(h.name, 'New Handler');
  });
});

test('HandlerService: updateHandler mutates in-place and publishes UPDATE', () => {
  ServiceRegistry.reset();
  const registry = ServiceRegistry.getInstance();
  const h = registry.handlerService.createHandler(null, 'Old Name');
  let evt;
  registry.bus.subscribe('SERVICE_ACTION', ev => { if (ev.actionType === 'UPDATE') evt = ev; });
  registry.handlerService.updateHandler(h, { name: 'New Name' });
  assert.strictEqual(h.name,                'New Name');
  assert.strictEqual(evt.actionType,        'UPDATE');
  assert.strictEqual(evt.originalItem.name, 'Old Name');
  assert.strictEqual(evt.item.name,         'New Name');
});

test('HandlerService: deleteHandler publishes DELETE', () => {
  ServiceRegistry.reset();
  const registry = ServiceRegistry.getInstance();
  const h = registry.handlerService.createHandler(null, 'H');
  let evt;
  registry.bus.subscribe('SERVICE_ACTION', ev => { if (ev.actionType === 'DELETE') evt = ev; });
  registry.handlerService.deleteHandler(h);
  assert.strictEqual(evt.actionType, 'DELETE');
  assert.strictEqual(evt.classType,  'HandlerEntry');
});

// ─── ReducerService ───────────────────────────────────────────────────────────

test('ReducerService: createFieldReducer returns a FieldReducer and publishes CREATE', () => {
  const events = captureServiceEvents(({ reducerService }) => {
    const r = reducerService.createFieldReducer('metrics.balance');
    assert.ok(r instanceof FieldReducer);
  });
  assert.strictEqual(events[0].actionType, 'CREATE');
  assert.strictEqual(events[0].classType,  'FieldReducer');
});

test('ReducerService: createArrayReducer returns an ArrayReducer', () => {
  captureServiceEvents(({ reducerService }) => {
    const r = reducerService.createArrayReducer('balances');
    assert.ok(r instanceof ArrayReducer);
  });
});

test('ReducerService: createNumericSumReducer returns correct type', () => {
  captureServiceEvents(({ reducerService }) => {
    const r = reducerService.createNumericSumReducer('total');
    assert.ok(r instanceof NumericSumReducer);
  });
});

test('ReducerService: createMultiplicativeReducer returns correct type', () => {
  captureServiceEvents(({ reducerService }) => {
    const r = reducerService.createMultiplicativeReducer('rate');
    assert.ok(r instanceof MultiplicativeReducer);
  });
});

test('ReducerService: createNoOpReducer returns a NoOpReducer', () => {
  captureServiceEvents(({ reducerService }) => {
    const r = reducerService.createNoOpReducer();
    assert.ok(r instanceof NoOpReducer);
  });
});

test('ReducerService: createFieldReducer returns a FieldReducer', () => {
  captureServiceEvents(({ reducerService }) => {
    const r = reducerService.createFieldReducer('cash');
    assert.ok(r instanceof FieldReducer);
  });
});

test('ReducerService: updateReducer mutates in-place and publishes UPDATE', () => {
  ServiceRegistry.reset();
  const registry = ServiceRegistry.getInstance();
  const r = registry.reducerService.createFieldReducer('metrics.balance');
  let evt;
  registry.bus.subscribe('SERVICE_ACTION', ev => { if (ev.actionType === 'UPDATE') evt = ev; });
  registry.reducerService.updateReducer(r, { name: 'Renamed' });
  assert.strictEqual(r.name,         'Renamed');
  assert.strictEqual(evt.actionType, 'UPDATE');
  assert.strictEqual(evt.classType,  'FieldReducer');
  assert.strictEqual(evt.item.name,  'Renamed');
});

test('ReducerService: deleteReducer publishes DELETE', () => {
  ServiceRegistry.reset();
  const registry = ServiceRegistry.getInstance();
  const r = registry.reducerService.createFieldReducer('metrics.balance');
  let evt;
  registry.bus.subscribe('SERVICE_ACTION', ev => { if (ev.actionType === 'DELETE') evt = ev; });
  registry.reducerService.deleteReducer(r);
  assert.strictEqual(evt.actionType, 'DELETE');
  assert.strictEqual(evt.classType,  'FieldReducer');
});

// ─── Cross-service bus integration ────────────────────────────────────────────

test('All services publish to the same shared bus', () => {
  const events = captureServiceEvents(({ actionService, eventService, handlerService, reducerService }) => {
    actionService.createAmountAction('T', 'T', 0);
    eventService.createEventSeries({ id: 'e1', name: 'E', type: 'E', interval: 'monthly' });
    handlerService.createHandler(null, 'H');
    reducerService.createFieldReducer('metrics.m');
  });
  assert.strictEqual(events.length, 4);
  const classTypes = events.map(e => e.classType);
  assert.ok(classTypes.includes('AmountAction'));
  assert.ok(classTypes.includes('EventSeries'));
  assert.ok(classTypes.includes('HandlerEntry'));
  assert.ok(classTypes.includes('FieldReducer'));
});

test('Wildcard bus subscriber receives all SERVICE_ACTION events', () => {
  ServiceRegistry.reset();
  const registry = ServiceRegistry.getInstance();
  const wildcardEvents = [];
  registry.bus.subscribe('*', e => wildcardEvents.push(e));

  registry.actionService.createAmountAction('X', 'X', 0);
  registry.eventService.createEventSeries({ id: 'e1', name: 'E', type: 'E', interval: 'monthly' });

  assert.strictEqual(wildcardEvents.length, 2);
  assert.ok(wildcardEvents.every(e => e.type === 'SERVICE_ACTION'));
});

test('Bus history contains all published SERVICE_ACTION events', () => {
  ServiceRegistry.reset();
  const registry = ServiceRegistry.getInstance();

  registry.actionService.createAmountAction('A', 'A', 0);
  registry.actionService.createRecordBalanceAction();
  registry.handlerService.createHandler();

  const history = registry.bus.getHistory();
  assert.strictEqual(history.length, 3);
  assert.ok(history.every(e => e instanceof ServiceActionEvent));
});
