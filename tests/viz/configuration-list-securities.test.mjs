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
 * configuration-list-securities.test.mjs — design 94 step 10.
 *
 * §10.2e said a securities editor "would need a graph node kind, a modal, and a launch
 * point". It got the modal and the launch point and NOT the node kind, deliberately: a
 * `Security` is plain frozen cfg data on the scenario record (design 94 §4), and giving it
 * a service — the only way onto the config graph — would have created a second live copy
 * of the same truth, which is the shape this repo has been bitten by twice.
 *
 * So the list takes an injected row provider for that one kind. What is worth pinning is
 * that the injection is scoped: every other kind still comes from the graph, and a
 * scenario record that cannot be read must not blank the panel.
 */

import assert from 'node:assert/strict';
import { ConfigurationListComponent } from '../../src/visualization/configuration/configuration-list.js';

const BUS = { subscribe: () => () => {} };

// The list coalesces repaints onto an animation frame. jsdom supplies none, so run the
// callback inline — this file is about WHICH rows are rendered, not when.
const _raf = [];
global.requestAnimationFrame = (cb) => { _raf.push(cb); return _raf.length; };
const flush = () => { while (_raf.length) _raf.shift()(); };

function makeList({ itemsByKind = null, nodes = {} } = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const list = new ConfigurationListComponent({
    container, bus: BUS, itemsByKind,
    graphQueryApi: { getByKind: (k) => nodes[k] ?? [] },
  });
  flush();
  return { list, container };
}

const select = (list) => list._container.querySelector('select');
const rowText = (list) => [...list._container.querySelectorAll('.config-list-row')].map(r => r.textContent);
const addBtn  = (list) => list._container.querySelector('button');

function pickKind(list, kind) {
  const sel = select(list);
  sel.value = kind;
  sel.dispatchEvent(new Event('change'));
  flush();
}

test('the Securities kind is offered and reads the injected rows', () => {
  const { list } = makeList({
    itemsByKind: { security: () => [{ id: 'sec-emp', name: 'Employer stock', symbol: 'EMP', rateKey: 'EQUITY_US' }] },
  });
  assert.ok([...select(list).options].some(o => o.value === 'security'), 'the kind must be selectable');

  pickKind(list, 'security');
  assert.equal(rowText(list).length, 1);
  // The subtitle is the market: it decides which lots may legally name this instrument
  // (assertAllocationMatch), and it is the field an author gets wrong.
  assert.match(rowText(list)[0], /Employer stock/);
  assert.match(rowText(list)[0], /EMP · EQUITY_US/);
});

test('the Add button is not "+ Add Securitie"', () => {
  // The trailing-'s' rule that produces "+ Add Person" from "People"'s siblings gets this
  // one wrong, and a label like that is never edited back.
  const { list } = makeList({ itemsByKind: { security: () => [] } });
  pickKind(list, 'security');
  assert.equal(addBtn(list).textContent, '+ Add Security');
});

test('every OTHER kind still comes from the graph', () => {
  const { list } = makeList({
    itemsByKind: { security: () => [{ id: 'sec-a', name: 'A' }] },
    nodes: { person: [{ id: 'p1', name: 'Alice', citizen: ['US'] }] },
  });
  pickKind(list, 'person');
  assert.deepEqual(rowText(list).map(t => t.replace(/US$/, '')), ['Alice']);
});

test('a provider that throws leaves the list empty, not broken', () => {
  // A malformed scenario record is a bug worth fixing; taking the whole left panel down
  // with it means the user cannot get to the record to fix it.
  const { list } = makeList({ itemsByKind: { security: () => { throw new Error('bad cfg'); } } });
  pickKind(list, 'security');
  assert.equal(rowText(list).length, 0);
  assert.match(list._container.textContent, /No items/);
});
