import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { TypeRegistry, ValueType } from '../../src/simulation-framework/type-registry.js';
import { HandlerEntry } from '../../src/simulation-framework/handlers.js';
import { Reducer, NoOpReducer } from '../../src/simulation-framework/reducers.js';
import { Action } from '../../src/simulation-framework/actions.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRegistry() {
  return new TypeRegistry();
}

class TestHandler extends HandlerEntry {
  static type     = 'TestHandler';
  static category = 'handler';
}

class TestReducer extends Reducer {
  static type     = 'TestReducer';
  static category = 'reducer';
  reduce(s) { return s; }
}

// ─── registerClass ────────────────────────────────────────────────────────────

describe('TypeRegistry.registerClass', () => {
  test('stores by type name', () => {
    const reg = makeRegistry();
    reg.registerClass(TestHandler);
    assert.strictEqual(reg.get('TestHandler'), TestHandler);
  });

  test('buckets by category', () => {
    const reg = makeRegistry();
    reg.registerClass(TestHandler);
    assert.ok(reg.byCategory('handler').includes(TestHandler));
  });

  test('ignores ctors with no static type', () => {
    const reg = makeRegistry();
    class NoType {}
    reg.registerClass(NoType);
    assert.strictEqual(reg.get(undefined), null);
    assert.deepEqual(reg.byCategory('handler'), []);
  });

  test('multiple categories are independent', () => {
    const reg = makeRegistry();
    reg.registerClass(TestHandler);
    reg.registerClass(TestReducer);
    assert.ok(reg.byCategory('handler').includes(TestHandler));
    assert.ok(reg.byCategory('reducer').includes(TestReducer));
    assert.ok(!reg.byCategory('handler').includes(TestReducer));
  });
});

// ─── registerActionType ───────────────────────────────────────────────────────

describe('TypeRegistry.registerActionType', () => {
  test('stores entry by type string', () => {
    const reg = makeRegistry();
    const entry = { type: 'FOO_ACTION', fields: { amount: ValueType.currency('USD') } };
    reg.registerActionType(entry);
    assert.strictEqual(reg.getAction('FOO_ACTION'), entry);
  });

  test('indexes by family', () => {
    const reg = makeRegistry();
    reg.registerActionType({ type: 'US_TAX_DEBIT', family: 'TAX_DEBIT', cc: 'US', fields: {} });
    reg.registerActionType({ type: 'AU_TAX_DEBIT', family: 'TAX_DEBIT', cc: 'AU', fields: {} });
    const types = reg.familyTypes('TAX_DEBIT');
    assert.deepEqual(types.sort(), ['AU_TAX_DEBIT', 'US_TAX_DEBIT']);
  });

  test('entries without family are not in any family', () => {
    const reg = makeRegistry();
    reg.registerActionType({ type: 'LONE_ACTION', fields: {} });
    assert.deepEqual(reg.familyTypes('LONE_ACTION'), []);
  });
});

// ─── registerToolset ─────────────────────────────────────────────────────────

describe('TypeRegistry.registerToolset', () => {
  test('walks all three buckets', () => {
    const reg = makeRegistry();
    const toolset = {
      id: 'TEST',
      types: {
        handlers: [TestHandler],
        reducers: [TestReducer],
        actions: [
          { type: 'TOOL_ACTION', fields: { amount: ValueType.currency('USD') } },
        ],
      },
    };
    reg.registerToolset(toolset);
    assert.strictEqual(reg.get('TestHandler'), TestHandler);
    assert.strictEqual(reg.get('TestReducer'), TestReducer);
    assert.ok(reg.getAction('TOOL_ACTION') != null);
  });

  test('no-ops when types is absent', () => {
    const reg = makeRegistry();
    reg.registerToolset({ id: 'BARE' });
    assert.deepEqual(reg.byCategory('handler'), []);
  });
});

// ─── byFamily / familyTypes ───────────────────────────────────────────────────

describe('TypeRegistry.byFamily / familyTypes', () => {
  test('byFamily returns all entries for family', () => {
    const reg = makeRegistry();
    reg.registerActionType({ type: 'US_WD', family: 'WITHDRAWAL', cc: 'US', fields: {} });
    reg.registerActionType({ type: 'AU_WD', family: 'WITHDRAWAL', cc: 'AU', fields: {} });
    assert.strictEqual(reg.byFamily('WITHDRAWAL').length, 2);
  });

  test('byFamily filters by cc', () => {
    const reg = makeRegistry();
    reg.registerActionType({ type: 'US_WD', family: 'WITHDRAWAL', cc: 'US', fields: {} });
    reg.registerActionType({ type: 'AU_WD', family: 'WITHDRAWAL', cc: 'AU', fields: {} });
    const us = reg.byFamily('WITHDRAWAL', { cc: 'US' });
    assert.strictEqual(us.length, 1);
    assert.strictEqual(us[0].type, 'US_WD');
  });

  test('byFamily returns [] for unknown family', () => {
    const reg = makeRegistry();
    assert.deepEqual(reg.byFamily('UNKNOWN'), []);
  });

  test('familyTypes returns type strings', () => {
    const reg = makeRegistry();
    reg.registerActionType({ type: 'US_WD', family: 'WITHDRAWAL', cc: 'US', fields: {} });
    assert.deepEqual(reg.familyTypes('WITHDRAWAL'), ['US_WD']);
  });

  test('familyTypes with cc filter', () => {
    const reg = makeRegistry();
    reg.registerActionType({ type: 'US_WD', family: 'WITHDRAWAL', cc: 'US', fields: {} });
    reg.registerActionType({ type: 'AU_WD', family: 'WITHDRAWAL', cc: 'AU', fields: {} });
    assert.deepEqual(reg.familyTypes('WITHDRAWAL', { cc: 'AU' }), ['AU_WD']);
  });
});

// ─── pickPayload — registered type ───────────────────────────────────────────

describe('TypeRegistry.pickPayload (registered type)', () => {
  test('returns only declared fields that are present', () => {
    const reg = makeRegistry();
    reg.registerActionType({
      type: 'PAY_ACTION',
      fields: {
        amount: ValueType.currency('USD'),
        personKey: ValueType.text(),
      },
    });
    const action = {
      type: 'PAY_ACTION', id: 'a1', name: 'Pay',
      amount: 100, personKey: 'alice', extraField: 'should-be-ignored',
    };
    const result = reg.pickPayload(action);
    assert.deepEqual(result, { amount: 100, personKey: 'alice' });
  });

  test('omits null/undefined fields even if declared', () => {
    const reg = makeRegistry();
    reg.registerActionType({ type: 'X', fields: { amount: ValueType.number(), note: ValueType.text() } });
    const result = reg.pickPayload({ type: 'X', amount: 42, note: null });
    assert.deepEqual(result, { amount: 42 });
  });
});

// ─── pickPayload — fallback (permissive) ─────────────────────────────────────

describe('TypeRegistry.pickPayload (fallback permissive)', () => {
  test('excludes FRAMEWORK_FIELDS', () => {
    const reg = makeRegistry();
    reg.setStrict(false);
    const action = {
      type: 'UNREGISTERED', id: 'a1', name: 'X', kind: 'action', layer: 'config',
      amount: 50,
    };
    const result = reg.pickPayload(action);
    assert.ok(!('id'    in result), 'id should be excluded');
    assert.ok(!('type'  in result), 'type should be excluded');
    assert.ok(!('name'  in result), 'name should be excluded');
    assert.ok(!('kind'  in result), 'kind should be excluded');
    assert.ok(!('layer' in result), 'layer should be excluded');
    assert.strictEqual(result.amount, 50);
  });

  test('excludes underscore-prefixed fields', () => {
    const reg = makeRegistry();
    reg.setStrict(false);
    const action = {
      type: 'UNREGISTERED',
      _instanceId: 'uuid-1', _actionId: 'aid', _repeaterCounter: 3,
      amount: 99,
    };
    const result = reg.pickPayload(action);
    assert.ok(!('_instanceId'     in result));
    assert.ok(!('_actionId'       in result));
    assert.ok(!('_repeaterCounter' in result));
    assert.strictEqual(result.amount, 99);
  });

  test('warns once per unknown type', () => {
    const reg = makeRegistry();
    reg.setStrict(false);
    const warnings = [];
    const orig = console.warn;
    console.warn = (...a) => warnings.push(a[0]);
    reg.pickPayload({ type: 'UNKNOWN_A', amount: 1 });
    reg.pickPayload({ type: 'UNKNOWN_A', amount: 2 });
    reg.pickPayload({ type: 'UNKNOWN_B', amount: 3 });
    console.warn = orig;
    assert.strictEqual(warnings.filter(w => w.includes('UNKNOWN_A')).length, 1);
    assert.strictEqual(warnings.filter(w => w.includes('UNKNOWN_B')).length, 1);
  });
});

// ─── pickPayload — strict mode ────────────────────────────────────────────────

describe('TypeRegistry.pickPayload (strict)', () => {
  test('throws for unregistered action type', () => {
    const reg = makeRegistry();
    // strict is true by default
    assert.throws(
      () => reg.pickPayload({ type: 'MISSING_TYPE', amount: 1 }),
      /MISSING_TYPE/
    );
  });

  test('does not throw for registered type', () => {
    const reg = makeRegistry();
    reg.registerActionType({ type: 'KNOWN', fields: { amount: ValueType.number() } });
    assert.doesNotThrow(() => reg.pickPayload({ type: 'KNOWN', amount: 5 }));
  });
});

// ─── Framework block-list correctness ─────────────────────────────────────────

describe('Framework field block-list', () => {
  test('all post-Phase-0 framework fields are excluded by fallback', () => {
    const reg = makeRegistry();
    reg.setStrict(false);
    const action = {
      type: 'T', id: 'x', name: 'X', kind: 'action', layer: 'config',
      _instanceId: 'u1', _parentInstanceId: 'u0', _rootInstanceId: 'u0',
      _actionId: 'aid', _emittedByNodeId: 'n1', _repeaterCounter: 0,
      amount: 7,
    };
    const result = reg.pickPayload(action);
    assert.deepEqual(result, { amount: 7 });
  });
});

// ─── base class statics ───────────────────────────────────────────────────────

describe('Framework base class statics', () => {
  test('Action has static type and category', () => {
    assert.strictEqual(Action.type, 'Action');
    assert.strictEqual(Action.category, 'action');
  });

  test('HandlerEntry has static type, category, toJSON and fromJSON', () => {
    assert.strictEqual(HandlerEntry.type, 'HandlerEntry');
    assert.strictEqual(HandlerEntry.category, 'handler');
    assert.strictEqual(typeof HandlerEntry.prototype.toJSON, 'function');
    assert.strictEqual(typeof HandlerEntry.fromJSON, 'function');
  });

  test('Reducer has static type, category, toJSON and fromJSON', () => {
    assert.strictEqual(Reducer.type, 'Reducer');
    assert.strictEqual(Reducer.category, 'reducer');
    assert.strictEqual(typeof Reducer.prototype.toJSON, 'function');
    assert.strictEqual(typeof Reducer.fromJSON, 'function');
  });

  test('NoOpReducer inherits category from Reducer', () => {
    assert.strictEqual(NoOpReducer.type, 'NoOpReducer');
    assert.strictEqual(NoOpReducer.category, 'reducer');
  });

  test('HandlerEntry.toJSON includes __type from static type', () => {
    const h = new HandlerEntry(null, 'my-handler');
    h.id = 'h-1';
    const json = h.toJSON();
    assert.strictEqual(json.__type, 'HandlerEntry');
    assert.strictEqual(json.id, 'h-1');
    assert.strictEqual(json.name, 'my-handler');
  });

  test('HandlerEntry.fromJSON round-trips id', () => {
    const h = HandlerEntry.fromJSON({ __type: 'HandlerEntry', id: 'h-2', name: 'test' }, {});
    assert.strictEqual(h.id, 'h-2');
    assert.ok(h instanceof HandlerEntry);
  });

  test('subclass fromJSON returns subclass instance', () => {
    const h = TestHandler.fromJSON({ __type: 'TestHandler', id: 'th-1', name: 'T' }, {});
    assert.ok(h instanceof TestHandler);
    assert.strictEqual(h.id, 'th-1');
  });
});
