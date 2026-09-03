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
 * security-editor.test.mjs — design 94 step 10, closing §10.2e.
 *
 * Step 9 shipped the picker and left nothing able to fill it. What is worth pinning about
 * the form that fills it is not "inputs render". It is the one property a conventional
 * editor gets wrong, every time:
 *
 *   **absent is not null.** `instrumentOf` merges `{ ...holding, ...security }`, so a key
 *   merely PRESENT on the security wins — an explicit `null` included (design 94 §4 rule
 *   2). A form that wrote every box it rendered would silence every lot's inline value
 *   the moment a security was named. So the tri-state — silent / declared-null /
 *   declared-value — has to survive a round trip through the DOM, and that is what most
 *   of this file checks.
 *
 * Plus the two things that are silent when wrong: a field the engine never reads must not
 * be offered (§10.2b), and one authored in JSON must not be dropped by a form that never
 * showed it.
 */

import { loadHtml, makeMockContainer } from '../../helpers/viz-utils.js';
import { SecurityEditor, UNREAD_SECURITY_FIELDS } from '../../../src/visualization/assets/security-editor.js';
import { SECURITY_FIELDS } from '../../../src/finance/holdings/security.js';

function editorFor(node, { existingIds = [] } = {}) {
  const saved = [];
  const editor = new SecurityEditor({
    container: makeMockContainer(), node, existingIds,
    onSave: (spec) => saved.push(spec),
  });
  editor.render();
  return { editor, root: editor._rootEl, saved };
}

const save     = (root) => root.querySelector('[data-id="saveBtn"]').click();
const control  = (root, f) => root.querySelector(`[data-f="${f}"]`);
const idInput  = (root) => root.querySelector('[data-id="id"]');
const declare  = (root, f) => root.querySelector(`[data-declare="${f}"]`);
const errorText = (root) => root.querySelector('[data-id="error"]').textContent;

describe('securities editor — the declare tri-state (design 94 §4 rule 2)', () => {
  beforeEach(() => loadHtml('../../index.html'));

  test('an undeclared field writes NO key — the instrument stays silent', () => {
    const { root, saved } = editorFor(null);
    idInput(root).value = 'sec-emp';
    save(root);
    expect(saved).toHaveLength(1);
    // Not `dividendYield: null`, not `dividendYield: 0` — absent. A present null would
    // override every lot's inline yield with "pays nothing".
    expect('dividendYield' in saved[0]).toBe(false);
    expect('rateKey' in saved[0]).toBe(false);
  });

  test('a declared-but-empty field writes an explicit null', () => {
    const { root, saved } = editorFor(null);
    idInput(root).value = 'sec-nil';
    declare(root, 'dividendYield').checked = true;
    declare(root, 'dividendYield').dispatchEvent(new Event('change'));
    save(root);
    expect('dividendYield' in saved[0]).toBe(true);
    expect(saved[0].dividendYield).toBeNull();
  });

  test('an existing explicit null reads back as DECLARED, not as unset', () => {
    // This is the case a `?? fallback` gets wrong every time: the value is nullish, so a
    // form built on `??` shows the box unticked and then DELETES the author's statement
    // on the first save.
    const { root } = editorFor({ id: 'sec-nil', dividendYield: null });
    expect(declare(root, 'dividendYield').checked).toBe(true);
    expect(control(root, 'dividendYield').disabled).toBe(false);
  });

  test('un-ticking a declared field deletes the key', () => {
    const { root, saved } = editorFor({ id: 'sec-emp', dividendYield: 0.006 });
    expect(declare(root, 'dividendYield').checked).toBe(true);
    declare(root, 'dividendYield').checked = false;
    save(root);
    expect('dividendYield' in saved[0]).toBe(false);
  });

  test('a declared value round-trips through the DOM unchanged', () => {
    const { root, saved } = editorFor({ id: 'sec-emp', rateKey: 'EQUITY_US', beta: 1.4, idioVol: 0.22 });
    save(root);
    expect(saved[0]).toMatchObject({ id: 'sec-emp', rateKey: 'EQUITY_US', beta: 1.4, idioVol: 0.22 });
  });

  test('a boolean has no declare toggle — silent and false are the same statement', () => {
    // Every reader tests `inst.zeroCoupon` for truthiness, so a tri-state here would teach
    // a distinction the engine cannot observe.
    const { root, saved } = editorFor({ id: 'sec-b' });
    expect(declare(root, 'zeroCoupon')).toBeNull();
    expect(control(root, 'zeroCoupon').type).toBe('checkbox');
    save(root);
    expect('zeroCoupon' in saved[0]).toBe(false);
  });
});

describe('securities editor — what it refuses, and what it keeps', () => {
  beforeEach(() => loadHtml('../../index.html'));

  test('offers only fields the engine actually reads', () => {
    const { root } = editorFor(null);
    // §10.2b: an editable box the engine ignores is a lie, and an invisible one — the
    // number stays plausible and the money stays right. These five are forward-declared
    // on SECURITY_FIELDS and have no reader anywhere.
    expect(UNREAD_SECURITY_FIELDS).toEqual(
      expect.arrayContaining(['qualifiedDividends', 'frankingCredit', 'currency', 'country', 'isGold']));
    for (const f of UNREAD_SECURITY_FIELDS) expect(control(root, f)).toBeNull();
    // …and every OTHER security field is offered, so adding one to the entity without a
    // reader is a decision somebody has to make here rather than an accident.
    for (const f of SECURITY_FIELDS) {
      if (UNREAD_SECURITY_FIELDS.includes(f)) continue;
      expect(control(root, f)).not.toBeNull();
    }
  });

  test('a field it does not render survives an edit', () => {
    // Authored in JSON, invisible in this form. A save that rebuilt the record from the
    // visible controls would silently delete it.
    const { root, saved } = editorFor({ id: 'sec-au', symbol: 'AU', frankingCredit: 0.3, isGold: true });
    control(root, 'symbol').value = 'AUX';
    save(root);
    expect(saved[0]).toMatchObject({ frankingCredit: 0.3, isGold: true, symbol: 'AUX' });
  });

  test('the id is fixed once created — a rename would orphan every lot naming it', () => {
    const { root } = editorFor({ id: 'sec-emp' });
    expect(idInput(root).disabled).toBe(true);
    expect(root.querySelector('[data-id="deleteBtn"]').style.display).not.toBe('none');
  });

  test('refuses the reserved synthetic prefix, and says why', () => {
    const { root, saved } = editorFor(null);
    idInput(root).value = 'sec-auto-EQUITY_US';
    save(root);
    expect(saved).toHaveLength(0);
    expect(errorText(root)).toMatch(/reserved/i);
  });

  test('refuses a duplicate id and a missing one', () => {
    const dup = editorFor(null, { existingIds: ['sec-emp'] });
    idInput(dup.root).value = 'sec-emp';
    save(dup.root);
    expect(dup.saved).toHaveLength(0);
    expect(errorText(dup.root)).toMatch(/already exists/i);

    const blank = editorFor(null);
    save(blank.root);
    expect(blank.saved).toHaveLength(0);
    expect(errorText(blank.root)).toMatch(/id is required/i);
  });
});
