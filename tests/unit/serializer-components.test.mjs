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
 * serializer-components.test.mjs  — Level 1 of the serialization test pyramid
 *
 * Pure serialize/deserialize unit tests for each component type in
 * ScenarioSerializer.  No simulation is run; we only verify that the
 * `_serializeX` / `_makeX` round-trip preserves every field.
 *
 * Catches type-check bugs (like the 'OneOff' vs 'OneOffEvent' mistake) before
 * they can produce mysterious balance mismatches in the Level 4 integration
 * tests.
 *
 * Run with: node --test tests/unit/serializer-components.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { ScenarioSerializer }  from '../../src/scenarios/scenario-serializer.js';
import { EventSeries }         from '../../src/simulation-framework/events/event-series.js';
import { OneOffEvent }         from '../../src/simulation-framework/events/one-off-event.js';
import { HandlerEntry }        from '../../src/simulation-framework/handlers.js';
import {
  AmountAction, Action, FieldAction, FieldValueAction, ScriptedAction,
} from '../../src/simulation-framework/actions.js';
import {
  FieldReducer, NumericSumReducer, ArrayReducer, MultiplicativeReducer,
  NoOpReducer, ScriptedReducer,
} from '../../src/simulation-framework/reducers.js';
import { ReducerBuilder }      from '../../src/simulation-framework/builders/reducer-builder.js';
import { Account, SavingsAccount } from '../../src/finance/assets/account.js';
import {
  RothAccount, TraditionalIRAAccount, FourOhOneKAccount, BrokerageAccount,
  SuperannuationAccount,
} from '../../src/finance/assets/investment-account.js';
import { Person }              from '../../src/finance/person.js';

// ─── Regression: serializer must not require a FinSimLib browser global ───────
// Before the Vite ESM migration, ScenarioSerializer._serializeAction and
// _makeAction referenced `FinSimLib.Engine` as a browser global.  This test
// ensures that path never regresses — if FinSimLib is absent, all round-trips
// must still succeed.
test('no FinSimLib global needed — _serializeAction/_makeAction work standalone', () => {
  const action = new AmountAction('EXPENSE', 'Monthly Bills', 3500);
  const d = ScenarioSerializer._serializeAction(action);
  assert.strictEqual(d.__type, 'AmountAction');
  assert.strictEqual(d.value, 3500);
  const restored = ScenarioSerializer._makeAction(d);
  assert.ok(restored instanceof AmountAction);
  assert.strictEqual(restored.value, 3500);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Serialize then immediately deserialize an event back to an event instance. */
function eventRoundTrip(event) {
  const d = ScenarioSerializer._serializeEvent(event);
  return { d, event: ScenarioSerializer._makeEvent(d) };
}

/** Serialize then immediately deserialize an action. */
function actionRoundTrip(action) {
  const d = ScenarioSerializer._serializeAction(action);
  return { d, action: ScenarioSerializer._makeAction(d) };
}

/** Serialize then immediately deserialize a reducer. */
function reducerRoundTrip(reducer) {
  const d = ScenarioSerializer._serializeReducer(reducer);
  d.reducedActionTypes   = reducer.reducedActionTypes   ?? [];
  d.generatedActionTypes = reducer.generatedActionTypes ?? [];
  d.generatedActionDefinitions = [];
  return { d, reducer: ScenarioSerializer._makeReducer(d, {}) };
}

/** Serialize then immediately deserialize a person. */
function personRoundTrip(person) {
  const d = ScenarioSerializer._serializePerson(person);
  return { d, person: ScenarioSerializer._makePerson(d) };
}

/** Serialize then immediately deserialize an account. */
function accountRoundTrip(account) {
  const d = ScenarioSerializer._serializeAccount(account);
  return { d, account: ScenarioSerializer._makeAccount(d) };
}

// ═════════════════════════════════════════════════════════════════════════════
// Events
// ═════════════════════════════════════════════════════════════════════════════

test('event: EventSeries serializes with __type "EventSeries"', () => {
  const ev = new EventSeries({ id: 'e1', name: 'Month End', type: 'MONTH_END',
    interval: 'month-end', startOffset: 0, enabled: true, color: '#F44336' });
  const { d } = eventRoundTrip(ev);
  assert.strictEqual(d.__type, 'EventSeries');
});

test('event: EventSeries round-trip preserves all fields', () => {
  const ev = new EventSeries({ id: 'e1', name: 'Quarter End', type: 'QUARTER_END',
    interval: 'quarterly', startOffset: 2, enabled: false, color: '#60a5fa' });
  const { event: restored } = eventRoundTrip(ev);
  assert.strictEqual(restored.id,          'e1');
  assert.strictEqual(restored.name,        'Quarter End');
  assert.strictEqual(restored.type,        'QUARTER_END');
  assert.strictEqual(restored.interval,    'quarterly');
  assert.strictEqual(restored.startOffset, 2);
  assert.strictEqual(restored.enabled,     false);
  assert.strictEqual(restored.color,       '#60a5fa');
});

test('event: EventSeries round-trip produces an EventSeries instance', () => {
  const ev = new EventSeries({ id: 'e1', name: 'Monthly', type: 'MONTHLY',
    interval: 'monthly', enabled: true, color: '#888888' });
  const { event: restored } = eventRoundTrip(ev);
  assert.ok(restored instanceof EventSeries, 'should be EventSeries instance');
  assert.ok(!(restored instanceof OneOffEvent), 'must NOT be OneOffEvent');
});

test('event: OneOffEvent serializes with __type "OneOffEvent" — not "EventSeries"', () => {
  const date = new Date(Date.UTC(2031, 6, 1));
  const ev = new OneOffEvent({ id: 'e2', name: 'Move to AU', type: 'CHANGE_RESIDENCY',
    date, enabled: true, color: '#ff0000' });
  const { d } = eventRoundTrip(ev);
  assert.strictEqual(d.__type, 'OneOffEvent',
    `__type must be 'OneOffEvent' but got '${d.__type}' — ` +
    "check that _serializeEvent compares against 'OneOffEvent' not 'OneOff'");
});

test('event: OneOffEvent round-trip preserves the date', () => {
  const date = new Date(Date.UTC(2031, 6, 1));
  const ev = new OneOffEvent({ id: 'e2', name: 'Move to AU', type: 'CHANGE_RESIDENCY',
    date, enabled: true, color: '#ff0000' });
  const { event: restored } = eventRoundTrip(ev);
  assert.ok(restored.date instanceof Date, 'restored date should be a Date');
  assert.strictEqual(restored.date.toISOString(), date.toISOString());
});

test('event: OneOffEvent round-trip does NOT carry an interval field', () => {
  const ev = new OneOffEvent({ id: 'e2', name: 'Move to AU', type: 'CHANGE_RESIDENCY',
    date: new Date(Date.UTC(2031, 6, 1)), enabled: true });
  const { d } = eventRoundTrip(ev);
  assert.ok(!('interval' in d),
    'serialized OneOffEvent must not have an interval field');
});

test('event: OneOffEvent round-trip produces a OneOffEvent instance', () => {
  const ev = new OneOffEvent({ id: 'e3', name: 'Retire', type: 'RETIRE',
    date: new Date(Date.UTC(2040, 0, 1)), enabled: true });
  const { event: restored } = eventRoundTrip(ev);
  assert.ok(restored instanceof OneOffEvent, 'should be OneOffEvent instance');
  assert.ok(!(restored instanceof EventSeries) || restored instanceof OneOffEvent,
    'must not silently become an EventSeries');
});

test('event: disabled OneOffEvent round-trip preserves enabled=false', () => {
  const ev = new OneOffEvent({ id: 'e4', name: 'Disabled', type: 'DISABLED_EVT',
    date: new Date(Date.UTC(2030, 0, 1)), enabled: false });
  const { event: restored } = eventRoundTrip(ev);
  assert.strictEqual(restored.enabled, false);
});

// ═════════════════════════════════════════════════════════════════════════════
// Actions
// ═════════════════════════════════════════════════════════════════════════════

test('action: AmountAction round-trip preserves type, name, value', () => {
  const a = new AmountAction('EXPENSE_DEBIT', 'Debit Expenses', 6000);
  a.id = 'a1';
  const { action: restored } = actionRoundTrip(a);
  assert.strictEqual(restored.__type ?? 'AmountAction', 'AmountAction');
  assert.strictEqual(restored.type,  'EXPENSE_DEBIT');
  assert.strictEqual(restored.name,  'Debit Expenses');
  assert.strictEqual(restored.value, 6000);
  assert.strictEqual(restored.id,    'a1');
});

test('action: FieldAction round-trip preserves fieldName', () => {
  const a = new FieldAction('RECORD_FIELD', 'Record Field', 'metrics.amount');
  a.id = 'a2';
  const { action: restored } = actionRoundTrip(a);
  assert.strictEqual(restored.fieldName, 'metrics.amount');
});

test('action: FieldValueAction round-trip preserves fieldName and value', () => {
  const a = new FieldValueAction('SET_FLAG', 'Set Flag', 'isAuResident', true);
  a.id = 'a3';
  const { action: restored } = actionRoundTrip(a);
  assert.strictEqual(restored.fieldName, 'isAuResident');
  assert.strictEqual(restored.value,     true);
});

test('action: ScriptedAction round-trip preserves script', () => {
  const script = 'return { ...state, total: state.total + action.value }';
  const a = new ScriptedAction('SCRIPTED', 'Scripted Action', 'total', script);
  a.id = 'a4';
  const { action: restored } = actionRoundTrip(a);
  assert.strictEqual(restored.script,    script);
  assert.strictEqual(restored.fieldName, 'total');
});

// ═════════════════════════════════════════════════════════════════════════════
// Reducers (framework)
// ═════════════════════════════════════════════════════════════════════════════

test('reducer: FieldReducer round-trip preserves __type, fieldName, priority', () => {
  const r = ReducerBuilder.field('metrics.total').name('Total').priority(90).build();
  r.id = 'r1';
  r.reducedActionTypes = ['PAY'];
  const { reducer: restored } = reducerRoundTrip(r);
  assert.strictEqual(restored.constructor.name, 'FieldReducer');
  assert.strictEqual(restored.fieldName, 'metrics.total');
  assert.strictEqual(restored.priority,  90);
});

test('reducer: NumericSumReducer round-trip preserves __type and fieldName', () => {
  const r = ReducerBuilder.numericSum('metrics.salary').name('Sum Salary').priority(80).build();
  r.id = 'r2';
  r.reducedActionTypes = ['ADD_SALARY'];
  const { reducer: restored } = reducerRoundTrip(r);
  assert.strictEqual(restored.constructor.name, 'NumericSumReducer');
  assert.strictEqual(restored.fieldName, 'metrics.salary');
});

test('reducer: ArrayReducer round-trip preserves __type', () => {
  const r = ReducerBuilder.array('metrics.entries').name('Log Entry').priority(70).build();
  r.id = 'r3';
  r.reducedActionTypes = ['LOG'];
  const { reducer: restored } = reducerRoundTrip(r);
  assert.strictEqual(restored.constructor.name, 'ArrayReducer');
});

test('reducer: NoOpReducer round-trip preserves __type', () => {
  const r = ReducerBuilder.noOp().name('No-op').priority(50).build();
  r.id = 'r4';
  r.reducedActionTypes = ['NOOP'];
  const { reducer: restored } = reducerRoundTrip(r);
  assert.strictEqual(restored.constructor.name, 'NoOpReducer');
});

test('reducer: ScriptedReducer round-trip preserves script, fieldName, priority', () => {
  const script = 'return { state: { ...state, x: state.x + action.value } }';
  const r = new ScriptedReducer('Scripted', 60, 'x', script);
  r.id = 'r5';
  r.reducedActionTypes = ['INC_X'];
  const { reducer: restored } = reducerRoundTrip(r);
  assert.strictEqual(restored.constructor.name, 'ScriptedReducer');
  assert.strictEqual(restored.script,    script);
  assert.strictEqual(restored.fieldName, 'x');
  assert.strictEqual(restored.priority,  60);
});

test('reducer: MetricReducer round-trip preserves __type', () => {
  const r = ReducerBuilder.metric('metrics.amount').name('Record Amount').priority(40).build();
  r.id = 'r6';
  r.reducedActionTypes = ['RECORD_METRIC'];
  const { d } = reducerRoundTrip(r);
  assert.strictEqual(d.__type, 'MetricReducer');
});

// ═════════════════════════════════════════════════════════════════════════════
// Persons
// ═════════════════════════════════════════════════════════════════════════════

test('person: round-trip preserves name, birthDate, citizen, lifeExpectancy, socialSecurityMonthly', () => {
  const p = new Person('p1', new Date(Date.UTC(1978, 3, 15)), {
    name: 'Alice', citizen: ['US', 'AU'], lifeExpectancy: 88, socialSecurityMonthly: 3000,
  });
  const { person: restored } = personRoundTrip(p);
  assert.strictEqual(restored.name, 'Alice');
  assert.deepStrictEqual(restored.citizen, ['US', 'AU']);
  assert.strictEqual(restored.lifeExpectancy, 88);
  assert.strictEqual(restored.socialSecurityMonthly, 3000);
  assert.strictEqual(new Date(restored.birthDate).getUTCFullYear(), 1978);
});

test('person: birthDate serializes as full ISO 8601 string', () => {
  const p = new Person('p2', new Date(Date.UTC(1990, 5, 20)), { name: 'Bob' });
  const { d } = personRoundTrip(p);
  // Design 15: all dates emit full ISO 8601 (with time component) end-to-end so
  // simStart/simEnd/birthDate/retirementDate share one canonical format.
  assert.strictEqual(d.birthDate, '1990-06-20T00:00:00.000Z');
});

// ═════════════════════════════════════════════════════════════════════════════
// Accounts
// ═════════════════════════════════════════════════════════════════════════════

test('account: SavingsAccount round-trip preserves balance, minimumBalance, stateKey', () => {
  const a = new SavingsAccount(30000, {
    id: 'acc1', name: 'US Savings', minimumBalance: 3000,
  });
  a.stateKey = 'usSavingsAccount';
  const { account: restored } = accountRoundTrip(a);
  assert.strictEqual(restored.balance,        30000);
  assert.strictEqual(restored.minimumBalance, 3000);
  assert.strictEqual(restored.stateKey,       'usSavingsAccount');
});

test('account: RothAccount round-trip preserves contributionBasis', () => {
  const a = new RothAccount(80000, {
    id: 'acc2', name: 'Roth IRA', contributionBasis: 60000,
  });
  a.stateKey = 'rothAccount';
  const { account: restored } = accountRoundTrip(a);
  assert.strictEqual(restored.balance,           80000);
  assert.strictEqual(restored.contributionBasis, 60000);
  assert.strictEqual(restored.stateKey,          'rothAccount');
});

test('account: BrokerageAccount round-trip preserves loanBalance (design 53 §2 regression guard)', () => {
  // Brokerage lost its basis ledger in design 53 §2; the serializer must NOT gate
  // loanBalance (the AU margin loan) on the now-absent contributionBasis field.
  const a = new BrokerageAccount(50000, { id: 'accB', name: 'AU Margin', country: 'AU', loanBalance: 12000 });
  a.stateKey = 'auStockAccount';
  const { d, account: restored } = accountRoundTrip(a);
  assert.strictEqual(d.loanBalance,       12000, 'loanBalance is serialized');
  assert.strictEqual(restored.loanBalance, 12000, 'loanBalance survives the round-trip');
  assert.ok(!('contributionBasis' in restored), 'brokerage carries no basis ledger');
});

test('account: stateKey null when not set', () => {
  const a = new SavingsAccount(1000, { id: 'acc3', name: 'No Key' });
  const { d } = accountRoundTrip(a);
  assert.strictEqual(d.stateKey, null);
});

test('account: round-trip reconstructs correct class', () => {
  const a = new FourOhOneKAccount(300000, {
    id: 'acc4', name: '401k', contributionBasis: 200000,
  });
  const { account: restored } = accountRoundTrip(a);
  assert.ok(restored instanceof FourOhOneKAccount,
    'restored account should be a FourOhOneKAccount instance');
});

// ═════════════════════════════════════════════════════════════════════════════
// Design 15 — Canonical date format across the serializer
//
// Regression guard: every date field emitted by ScenarioSerializer must be a
// full ISO 8601 string (`YYYY-MM-DDTHH:mm:ss.sssZ`), not the short YYYY-MM-DD
// form. simStart/simEnd, Person.birthDate/retirementDate, and OneOffEvent.date
// all share this one canonical representation — UI inputs slice to 10 chars
// only for `<input type="date">` display.
// ═════════════════════════════════════════════════════════════════════════════

/** Match the full ISO 8601 with milliseconds + UTC zone marker. */
const FULL_ISO_RX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test('dates: toDateStr produces full ISO from Date input', () => {
  const iso = ScenarioSerializer.toDateStr(new Date(Date.UTC(1985, 5, 15)));
  assert.match(iso, FULL_ISO_RX, `expected full ISO, got ${iso}`);
});

test('dates: toDateStr produces full ISO from YYYY-MM-DD input', () => {
  const iso = ScenarioSerializer.toDateStr('1985-06-15');
  assert.match(iso, FULL_ISO_RX, `expected full ISO, got ${iso}`);
  assert.strictEqual(iso, '1985-06-15T00:00:00.000Z');
});

test('dates: _serializePerson emits full ISO for birthDate and retirementDate', () => {
  const p = new Person('p1', new Date(Date.UTC(1978, 3, 15)), {
    name: 'Alice',
    retirementDate: new Date(Date.UTC(2045, 11, 31)),
  });
  const d = ScenarioSerializer._serializePerson(p);
  assert.match(d.birthDate,      FULL_ISO_RX, `birthDate truncated: ${d.birthDate}`);
  assert.match(d.retirementDate, FULL_ISO_RX, `retirementDate truncated: ${d.retirementDate}`);
});

test('dates: _serializePerson falls back to full ISO when retirementDate is missing', () => {
  // Person without retirementDate gets Date(2040-01-01) from the Person ctor —
  // the fallback in _serializePerson should never produce a short ISO.
  const p = new Person('p1', new Date(Date.UTC(1978, 3, 15)));
  p.retirementDate = null;
  const d = ScenarioSerializer._serializePerson(p);
  assert.match(d.retirementDate, FULL_ISO_RX, `fallback retirementDate truncated: ${d.retirementDate}`);
});

test('dates: _serializeEvent emits full ISO for OneOffEvent.date', () => {
  const ev = new OneOffEvent({
    id: 'one1', name: 'One', type: 'BONUS', date: new Date(Date.UTC(2027, 6, 4)),
  });
  const d = ScenarioSerializer._serializeEvent(ev);
  assert.match(d.date, FULL_ISO_RX, `OneOffEvent.date truncated: ${d.date}`);
});
