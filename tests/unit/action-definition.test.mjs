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
 * action-definition.test.mjs
 * Tests for ActionDefinition — construction, static values, expression strings,
 * function values, and instantiate() output.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ActionDefinition,
  AmountAction,
  RecordMetricAction,
  ScriptedAction,
  generateActionId,
} from '../../src/simulation-framework/actions.js';

// ─── Construction ─────────────────────────────────────────────────────────────

describe('ActionDefinition construction', () => {
  test('assigns a UUID id', () => {
    const def = new ActionDefinition({ type: 'FOO' });
    assert.ok(typeof def.id === 'string' && def.id.length > 0);
  });

  test('stores type and config', () => {
    const def = new ActionDefinition({ type: 'MY_TYPE', config: { actionClass: 'AmountAction', value: 42 } });
    assert.equal(def.type, 'MY_TYPE');
    assert.equal(def.config.actionClass, 'AmountAction');
    assert.equal(def.config.value, 42);
  });

  test('defaults config to empty object when omitted', () => {
    const def = new ActionDefinition({ type: 'X' });
    assert.deepEqual(def.config, {});
  });
});

// ─── fromAction ───────────────────────────────────────────────────────────────

describe('ActionDefinition.fromAction', () => {
  test('captures actionClass and numeric value from AmountAction', () => {
    const action = new AmountAction('SALARY', 'salary', 5000);
    const def = ActionDefinition.fromAction(action);
    assert.equal(def.type, 'SALARY');
    assert.equal(def.config.actionClass, 'AmountAction');
    assert.equal(def.config.value, 5000);
    assert.equal(def.config.name, 'salary');
  });

  test('captures key and value from RecordMetricAction', () => {
    const action = new RecordMetricAction('savings_rate', 0.05);
    const def = ActionDefinition.fromAction(action);
    assert.equal(def.type, 'RECORD_METRIC');
    assert.equal(def.config.actionClass, 'RecordMetricAction');
    assert.equal(def.config.fieldName, 'savings_rate');
    assert.equal(def.config.value, 0.05);
  });
});

// ─── instantiate(): static values ─────────────────────────────────────────────

describe('ActionDefinition.instantiate() — static values', () => {
  test('creates an AmountAction with static numeric value', () => {
    const def = new ActionDefinition({
      type: 'SALARY_CREDIT',
      config: { actionClass: 'AmountAction', name: 'salary', value: 8000 },
    });
    const instance = def.instantiate();
    assert.equal(instance.type, 'SALARY_CREDIT');
    assert.ok(instance instanceof AmountAction);
    assert.equal(instance.value, 8000);
    assert.equal(instance.name, 'salary');
  });

  test('assigns a UUID _instanceId and null parentage fields', () => {
    const def = new ActionDefinition({
      type: 'T',
      config: { actionClass: 'AmountAction', value: 1 },
    });
    const instance = def.instantiate();
    assert.ok(typeof instance._instanceId === 'string' && instance._instanceId.length > 0);
    assert.equal(instance._parentInstanceId, null);
    assert.equal(instance._rootInstanceId, null);
  });

  test('type discriminator from definition always wins over config', () => {
    const def = new ActionDefinition({
      type: 'CANONICAL_TYPE',
      config: { actionClass: 'AmountAction', value: 0 },
    });
    const instance = def.instantiate();
    assert.equal(instance.type, 'CANONICAL_TYPE');
  });

  test('throws for unknown actionClass', () => {
    const def = new ActionDefinition({
      type: 'X',
      config: { actionClass: 'NoSuchAction' },
    });
    assert.throws(() => def.instantiate(), /unknown actionClass/i);
  });

  test('defaults to Action when actionClass is absent', () => {
    const def = new ActionDefinition({ type: 'BARE', config: {} });
    const instance = def.instantiate();
    assert.equal(instance.type, 'BARE');
  });
});

// ─── instantiate(): function values ───────────────────────────────────────────

describe('ActionDefinition.instantiate() — function values', () => {
  test('calls function with context and uses return value', () => {
    const def = new ActionDefinition({
      type: 'DYNAMIC',
      config: {
        actionClass: 'AmountAction',
        value: (ctx) => ctx.data.amount * 2,
      },
    });
    const instance = def.instantiate({ data: { amount: 100 } });
    assert.equal(instance.value, 200);
  });

  test('function receives full context object', () => {
    let capturedCtx;
    const def = new ActionDefinition({
      type: 'CTX_CHECK',
      config: {
        actionClass: 'AmountAction',
        value: (ctx) => { capturedCtx = ctx; return 1; },
      },
    });
    const context = { data: { x: 1 }, state: { y: 2 }, date: new Date() };
    def.instantiate(context);
    assert.equal(capturedCtx.data.x, 1);
    assert.equal(capturedCtx.state.y, 2);
  });
});

// ─── instantiate(): expression strings ────────────────────────────────────────

describe('ActionDefinition.instantiate() — expression strings ($...)', () => {
  test('$data.amount resolves from context.data', () => {
    const def = new ActionDefinition({
      type: 'EXPR',
      config: { actionClass: 'AmountAction', value: '$data.amount' },
    });
    const instance = def.instantiate({ data: { amount: 250 } });
    assert.equal(instance.value, 250);
  });

  test('$state.salary * 0.3 computes correctly', () => {
    const def = new ActionDefinition({
      type: 'EXPR',
      config: { actionClass: 'AmountAction', value: '$state.salary * 0.3' },
    });
    const instance = def.instantiate({ state: { salary: 1000 } });
    assert.equal(instance.value, 300);
  });

  test('$date is passed and accessible in expression', () => {
    const def = new ActionDefinition({
      type: 'EXPR',
      config: { actionClass: 'AmountAction', value: '$date.getFullYear()' },
    });
    const date = new Date(2026, 0, 15); // Jan 15 2026 local — year is unambiguous
    const instance = def.instantiate({ date });
    assert.equal(instance.value, 2026);
  });

  test('missing context fields default to empty object / null without throwing', () => {
    const def = new ActionDefinition({
      type: 'EXPR',
      config: { actionClass: 'AmountAction', value: '$data.missing ?? 99' },
    });
    const instance = def.instantiate({});
    assert.equal(instance.value, 99);
  });

  test('expression syntax error falls back to raw string and warns', () => {
    const def = new ActionDefinition({
      type: 'EXPR',
      config: { actionClass: 'AmountAction', value: '$((invalid syntax' },
    });
    // Should not throw — falls back to raw string value
    const instance = def.instantiate({});
    assert.equal(instance.value, '$((invalid syntax');
  });

  test('non-$ strings are used as-is (no compilation)', () => {
    const def = new ActionDefinition({
      type: 'EXPR',
      config: { actionClass: 'AmountAction', name: 'plain string' },
    });
    const instance = def.instantiate({});
    assert.equal(instance.name, 'plain string');
  });

  test('$meta and $sim are also bound in expression context', () => {
    const def = new ActionDefinition({
      type: 'EXPR',
      config: { actionClass: 'AmountAction', value: '$meta.rate * $sim.multiplier' },
    });
    const instance = def.instantiate({ meta: { rate: 10 }, sim: { multiplier: 3 } });
    assert.equal(instance.value, 30);
  });
});
