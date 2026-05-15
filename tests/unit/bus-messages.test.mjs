/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  EXECUTION_KINDS,
  EXECUTION_PHASES,
  BusMessage,
  SimulationBusMessage,
  ExecutionBusMessage,
  BreakpointHitMessage,
  ServiceActionEvent,
  ServiceEdgeActionEvent,
} from '../../src/simulation-framework/bus-messages.js';
import { EventBus } from '../../src/simulation-framework/event-bus.js';

describe('EXECUTION_KINDS / EXECUTION_PHASES', () => {
  test('EXECUTION_KINDS contains the four expected values', () => {
    assert.deepStrictEqual(Object.values(EXECUTION_KINDS).sort(), ['ACTION', 'EVENT', 'HANDLER', 'REDUCER']);
  });

  test('EXECUTION_PHASES contains BEGIN and END', () => {
    assert.deepStrictEqual(Object.values(EXECUTION_PHASES).sort(), ['BEGIN', 'END']);
  });
});

describe('BusMessage', () => {
  test('sets type, subtype, kind, date', () => {
    const d = new Date();
    const m = new BusMessage({ type: 'EXECUTION_BEGIN', subtype: 'BEGIN', kind: 'EVENT', date: d });
    assert.strictEqual(m.type, 'EXECUTION_BEGIN');
    assert.strictEqual(m.subtype, 'BEGIN');
    assert.strictEqual(m.kind, 'EVENT');
    assert.strictEqual(m.date, d);
  });

  test('subtype and kind default to null', () => {
    const m = new BusMessage({ type: 'SOMETHING', date: null });
    assert.strictEqual(m.subtype, null);
    assert.strictEqual(m.kind, null);
  });
});

describe('ExecutionBusMessage', () => {
  const base = {
    phase: 'BEGIN',
    kind: EXECUTION_KINDS.EVENT,
    executionId: 'e1.1',
    nodeId: 'e1',
    date: new Date(),
    sim: {},
  };

  test('type is EXECUTION_BEGIN for phase BEGIN', () => {
    const m = new ExecutionBusMessage({ ...base, phase: 'BEGIN' });
    assert.strictEqual(m.type, 'EXECUTION_BEGIN');
  });

  test('type is EXECUTION_END for phase END', () => {
    const m = new ExecutionBusMessage({ ...base, phase: 'END' });
    assert.strictEqual(m.type, 'EXECUTION_END');
  });

  test('subtype mirrors phase', () => {
    const m = new ExecutionBusMessage({ ...base, phase: 'BEGIN' });
    assert.strictEqual(m.subtype, 'BEGIN');
  });

  test('kind is set correctly', () => {
    const m = new ExecutionBusMessage({ ...base, kind: EXECUTION_KINDS.REDUCER });
    assert.strictEqual(m.kind, 'REDUCER');
  });

  test('executionId and nodeId are accessible at top level', () => {
    const m = new ExecutionBusMessage({ ...base, executionId: 'e1.1:h2.3', nodeId: 'h2' });
    assert.strictEqual(m.executionId, 'e1.1:h2.3');
    assert.strictEqual(m.nodeId, 'h2');
  });

  test('parentId defaults to null', () => {
    const m = new ExecutionBusMessage({ ...base });
    assert.strictEqual(m.parentId, null);
  });

  test('parentId is set when provided', () => {
    const m = new ExecutionBusMessage({ ...base, parentId: 'e1.1' });
    assert.strictEqual(m.parentId, 'e1.1');
  });

  test('payload contains all execution fields', () => {
    const m = new ExecutionBusMessage({ ...base, parentId: 'e1.1', meta: { reason: 'test' }, data: { x: 1 } });
    assert.strictEqual(m.payload.executionId, base.executionId);
    assert.strictEqual(m.payload.nodeId, base.nodeId);
    assert.strictEqual(m.payload.parentId, 'e1.1');
    assert.deepStrictEqual(m.payload.meta, { reason: 'test' });
    assert.deepStrictEqual(m.payload.data, { x: 1 });
  });

  test('stateDiff and stateSnapshot default to null', () => {
    const m = new ExecutionBusMessage({ ...base });
    assert.strictEqual(m.stateDiff, null);
    assert.strictEqual(m.stateSnapshot, null);
  });

  test('stateDiff and stateSnapshot are set when provided', () => {
    const diff = [{ field: 'x', before: 0, after: 1 }];
    const snap = { x: 1 };
    const m = new ExecutionBusMessage({ ...base, stateDiff: diff, stateSnapshot: snap });
    assert.deepStrictEqual(m.stateDiff, diff);
    assert.deepStrictEqual(m.stateSnapshot, snap);
  });
});

describe('BreakpointHitMessage', () => {
  test('type is BREAKPOINT_HIT', () => {
    const m = new BreakpointHitMessage({ date: new Date(), nodeId: 'e1', kind: 'event', stage: 'event:start' });
    assert.strictEqual(m.type, 'BREAKPOINT_HIT');
  });

  test('carries nodeId, kind, stage', () => {
    const m = new BreakpointHitMessage({ date: new Date(), nodeId: 'h3', kind: 'handler', stage: 'handler:before' });
    assert.strictEqual(m.nodeId, 'h3');
    assert.strictEqual(m.kind, 'handler');
    assert.strictEqual(m.stage, 'handler:before');
  });
});

describe('ServiceActionEvent', () => {
  test('accepts subtype field', () => {
    const m = new ServiceActionEvent({ subtype: 'CREATE', item: {} });
    assert.strictEqual(m.subtype, 'CREATE');
  });

  test('accepts legacy actionType field', () => {
    const m = new ServiceActionEvent({ actionType: 'UPDATE', item: {} });
    assert.strictEqual(m.subtype, 'UPDATE');
    assert.strictEqual(m.actionType, 'UPDATE');
  });

  test('subtype takes precedence over actionType', () => {
    const m = new ServiceActionEvent({ subtype: 'DELETE', actionType: 'CREATE', item: {} });
    assert.strictEqual(m.subtype, 'DELETE');
    assert.strictEqual(m.actionType, 'DELETE');
  });

  test('subtype is mirrored to actionType for backward compat', () => {
    const m = new ServiceActionEvent({ subtype: 'CREATE', item: {} });
    assert.strictEqual(m.actionType, 'CREATE');
  });

  test('classType defaults to null when omitted', () => {
    const m = new ServiceActionEvent({ subtype: 'CREATE', item: {} });
    assert.strictEqual(m.classType, null);
  });

  test('originalItem defaults to null', () => {
    const m = new ServiceActionEvent({ subtype: 'CREATE', item: {} });
    assert.strictEqual(m.originalItem, null);
  });

  test('type is SERVICE_ACTION', () => {
    const m = new ServiceActionEvent({ subtype: 'CREATE', item: {} });
    assert.strictEqual(m.type, 'SERVICE_ACTION');
  });
});

describe('ServiceEdgeActionEvent', () => {
  test('type is SERVICE_EDGE_ACTION', () => {
    const m = new ServiceEdgeActionEvent({ subtype: 'ADD', edge: {} });
    assert.strictEqual(m.type, 'SERVICE_EDGE_ACTION');
  });

  test('subtype ADD carries edge', () => {
    const edge = { id: 'e1->h1', from: 'e1', to: 'h1' };
    const m = new ServiceEdgeActionEvent({ subtype: 'ADD', edge });
    assert.strictEqual(m.subtype, 'ADD');
    assert.strictEqual(m.edge, edge);
  });

  test('subtype REMOVE carries from/to/edgeType', () => {
    const m = new ServiceEdgeActionEvent({ subtype: 'REMOVE', from: 'e1', to: 'h1', edgeType: 'HANDLED_BY' });
    assert.strictEqual(m.subtype, 'REMOVE');
    assert.strictEqual(m.from, 'e1');
    assert.strictEqual(m.to, 'h1');
    assert.strictEqual(m.edgeType, 'HANDLED_BY');
  });

  test('fields default to null when not provided', () => {
    const m = new ServiceEdgeActionEvent({ subtype: 'ADD' });
    assert.strictEqual(m.edge, null);
    assert.strictEqual(m.from, null);
    assert.strictEqual(m.to, null);
    assert.strictEqual(m.edgeType, null);
  });
});

describe('EventBus filtered subscriptions with new message classes', () => {
  test('kind filter routes EXECUTION_END (REDUCER) only to reducer subscriber', () => {
    const bus = new EventBus();
    const receivedReducer = [];
    const receivedEvent   = [];

    bus.subscribe('EXECUTION_END', { kind: EXECUTION_KINDS.REDUCER }, m => receivedReducer.push(m));
    bus.subscribe('EXECUTION_END', { kind: EXECUTION_KINDS.EVENT },   m => receivedEvent.push(m));

    const reducerMsg = new ExecutionBusMessage({ phase: 'END', kind: EXECUTION_KINDS.REDUCER, executionId: 'e1.1:h1.1:a1.1:r1.1', nodeId: 'r1', date: new Date(), sim: {} });
    const eventMsg   = new ExecutionBusMessage({ phase: 'END', kind: EXECUTION_KINDS.EVENT,   executionId: 'e1.1',                    nodeId: 'e1', date: new Date(), sim: {} });

    bus.publish(reducerMsg);
    bus.publish(eventMsg);

    assert.strictEqual(receivedReducer.length, 1);
    assert.strictEqual(receivedReducer[0].kind, EXECUTION_KINDS.REDUCER);
    assert.strictEqual(receivedEvent.length, 1);
    assert.strictEqual(receivedEvent[0].kind, EXECUTION_KINDS.EVENT);
  });

  test('instanceof filter routes ServiceActionEvent to correct subscriber', () => {
    class Account {}
    class Person  {}

    const bus = new EventBus();
    const accountMessages = [];
    const personMessages  = [];

    bus.subscribe('SERVICE_ACTION', { instanceOf: Account }, m => accountMessages.push(m));
    bus.subscribe('SERVICE_ACTION', { instanceOf: Person  }, m => personMessages.push(m));

    bus.publish(new ServiceActionEvent({ subtype: 'CREATE', item: new Account() }));
    bus.publish(new ServiceActionEvent({ subtype: 'CREATE', item: new Person()  }));

    assert.strictEqual(accountMessages.length, 1);
    assert.ok(accountMessages[0].item instanceof Account);
    assert.strictEqual(personMessages.length, 1);
    assert.ok(personMessages[0].item instanceof Person);
  });

  test('subtype filter routes CREATE vs UPDATE independently', () => {
    const bus = new EventBus();
    const creates = [];
    const updates  = [];

    bus.subscribe('SERVICE_ACTION', { subtype: 'CREATE' }, m => creates.push(m));
    bus.subscribe('SERVICE_ACTION', { subtype: 'UPDATE' }, m => updates.push(m));

    bus.publish(new ServiceActionEvent({ subtype: 'CREATE', item: {} }));
    bus.publish(new ServiceActionEvent({ subtype: 'UPDATE', item: {} }));
    bus.publish(new ServiceActionEvent({ subtype: 'DELETE', item: {} }));

    assert.strictEqual(creates.length, 1);
    assert.strictEqual(updates.length, 1);
  });

  test('BREAKPOINT_HIT is received by direct subscriber', () => {
    const bus = new EventBus();
    const hits = [];
    bus.subscribe('BREAKPOINT_HIT', m => hits.push(m));
    bus.publish(new BreakpointHitMessage({ date: new Date(), nodeId: 'e1', kind: 'event', stage: 'event:start' }));
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].nodeId, 'e1');
    assert.strictEqual(hits[0].stage, 'event:start');
  });
});
