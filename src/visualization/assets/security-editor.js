/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseComponent } from '../components/base-component.js';
import { rateKeyOptionsHtml } from '../accounts/rate-key-options.js';
import { SECURITY_FIELDS, makeSecurity, SYNTHETIC_SECURITY_PREFIX } from '../../finance/holdings/security.js';

/**
 * SecurityEditor — author a `Security`, the INSTRUMENT a position is held in (design 94
 * §4). Closes §10.2e, which shipped step 9's picker with nothing able to fill it.
 *
 * ─── three properties this form is built around ─────────────────────────────────────
 *
 * **1. Absent is not null (design 94 §4 rule 2).** `instrumentOf` merges
 * `{ ...holding, ...security }`, so a key merely PRESENT on the security wins — an
 * explicit `null` included. A form that wrote every box it rendered would therefore
 * silence every lot's inline value the moment a security was named, whether or not the
 * author meant to say anything about that field. So every instrument field carries a
 * DECLARE toggle: off writes no key at all (the instrument is silent and the lot's own
 * value stands); on with an empty box writes an explicit `null` ("this instrument has
 * none"), which is a different and equally authorable statement. That tri-state is not
 * decoration — it is the entity's merge rule made visible, and a `??`-shaped form cannot
 * express it.
 *
 * **2. Only fields the ENGINE reads are offered.** §10.2b's rule: an editable box the
 * engine ignores is a lie, and it is invisible — the number stays plausible and the money
 * stays right. `SECURITY_FIELDS` carries five forward-declared fields no reader consumes
 * today (`qualifiedDividends`, `frankingCredit`, `currency`, `country`, `isGold`), so
 * this form does not render them. It does not DROP them either: a value authored in JSON
 * round-trips untouched, because the save starts from the record and edits it rather than
 * rebuilding it from the visible controls.
 *
 * **3. `id` is stable; `symbol` is decoration (rule 3).** A symbol change is a corporate
 * action (design 94 §7). The id is what every lot names, so it is settable at creation
 * and read-only afterwards — renaming it in place would orphan every position holding it,
 * silently, and `instrumentOf` would fall back to the lot with no error anywhere.
 *
 * Communicates outward via callbacks:
 *   onSave(spec)   — a plain security spec; the host writes it to `cfg.securities`
 *   onDelete(id)   — user clicked Delete
 */

/**
 * The fields this form offers, in `SECURITY_FIELDS` order, and — the load-bearing part —
 * ONLY those with a live reader. Each entry names where the engine reads it, because
 * that citation is what stops the next author adding a control for a field nothing
 * consumes (property 2 above).
 *
 * `declarable: false` is for the booleans alone. A reader tests `inst.zeroCoupon` for
 * truthiness, so "declared false" and "silent" are the same statement to the engine, and
 * a tri-state that cannot be observed is a control that teaches the reader a distinction
 * the model does not have.
 */
const FIELD_SPECS = Object.freeze([
  { field: 'symbol', label: 'Symbol', kind: 'text', declarable: false, section: 'id', hint: 'e.g. VTI',
    title: 'Ticker — decoration. A symbol CHANGE is a corporate action (design 94 §7), not an edit here.' },
  { field: 'name', label: 'Name', kind: 'text', declarable: false, section: 'id', hint: 'e.g. Total US market ETF',
    title: 'Display name. Shown wherever a symbol is absent.' },

  { field: 'rateKey', label: 'Market', kind: 'rateKey', section: 'equity',
    title: 'The market-return series this instrument tracks. Must lie inside the ALLOCATION class '
         + 'of any lot that names it (assertAllocationMatch) — a BOND lot may not name an equity market.' },
  { field: 'beta', label: 'Beta (vs sleeve)', kind: 'number', step: '0.05', section: 'equity',
    title: 'Loading on the sleeve’s own deviation, NOT on the market. 1.0 is the identity: the '
         + 'instrument does exactly what its sleeve does (design 94 §6.2).' },
  { field: 'idioVol', label: 'Idiosyncratic vol', kind: 'number', step: '0.01', section: 'equity',
    title: '⚠ A security with idioVol > 0 takes a random draw EVERY tick whether or not any '
         + 'position holds it — the draw set is the registry, not the portfolio (design 94 §6.2). '
         + 'Declaring one perturbs the whole run. 0 (or silent) draws nothing.' },
  { field: 'dividendYield', label: 'Dividend yield', kind: 'number', step: '0.001', section: 'equity',
    title: 'Overrides the lot’s inline yield; the account rate stays the floor '
         + '(inst.dividendYield ?? h.dividendYield ?? account rate — design 94 D11).' },
  { field: 'identityGroup', label: 'Identity group', kind: 'text', section: 'equity',
    title: '§1091 "substantially identical" (design 94 §8.1c). Two DIFFERENT securities are related '
         + 'only when an author says so — give both the same group. Silent ⇒ identical to itself only.' },

  { field: 'taxExemption', label: 'Coupon tax treatment', kind: 'select', section: 'bond',
    options: [['none', 'Taxable'], ['state', 'Treasury (state-exempt)'],
              ['federal', 'Municipal (federal-exempt)'], ['both', 'Muni (all-state)']],
    title: 'Read for bond coupons (design 66 §G2). A declared value overrides the lot’s.' },
  { field: 'issuingState', label: 'Issuing state', kind: 'text', maxlength: 2, section: 'bond',
    title: 'Municipal issuer — the coupon is state-exempt only when it matches the resident’s state.' },
  { field: 'parPerUnit', label: 'Par per unit', kind: 'number', step: '1', section: 'bond',
    title: 'Face value of one unit (design 93 §5). The units substrate’s par walk checks against it.' },
  { field: 'couponRate', label: 'Coupon rate', kind: 'number', step: '0.001', section: 'bond',
    title: 'Annual coupon as a decimal. Silent ⇒ the lot’s own, then the prevailing rate.' },
  { field: 'couponFrequency', label: 'Coupon frequency', kind: 'select', section: 'bond',
    options: [['1', 'Annual'], ['2', 'Semi-annual'], ['4', 'Quarterly']], coerce: 'int',
    title: 'Payments per year; each firing pays couponRate / frequency (design 66 §G10a).' },
  { field: 'maturityDate', label: 'Maturity', kind: 'date', section: 'bond',
    title: 'Set ⇒ an individual bond (pulls to par, redeems at maturity). Silent ⇒ a perpetual bond fund.' },
  { field: 'duration', label: 'Duration (yr)', kind: 'number', step: '0.1', section: 'bond',
    title: 'Modified duration — how far a rate move marks the price.' },
  { field: 'zeroCoupon', label: 'Zero-coupon / OID', kind: 'check', declarable: false, section: 'bond',
    title: 'No cash coupon; the price accretes to par and the annual OID is imputed ordinary income (design 66 §G6).' },
  { field: 'inflationLinked', label: 'Inflation-linked (TIPS)', kind: 'check', declarable: false, section: 'bond',
    title: 'Principal indexes to CPI; the accretion is imputed ordinary income (design 66 §G5).' },
]);

const SECTIONS = Object.freeze([
  { key: 'id',     label: 'Identity' },
  { key: 'equity', label: 'Instrument' },
  { key: 'bond',   label: 'Fixed income' },
]);

/**
 * Fields carried on the record but NOT rendered, and why. Named here rather than left
 * implicit so the next author sees a decision instead of an oversight — and so adding a
 * reader for one of them is a two-line change (move it into FIELD_SPECS, delete it here).
 */
export const UNREAD_SECURITY_FIELDS = Object.freeze(
  SECURITY_FIELDS.filter(f => !FIELD_SPECS.some(s => s.field === f)));

export class SecurityEditor extends BaseComponent {
  /**
   * @param {{
   *   parent?:     BaseComponent,
   *   container:   HTMLElement,
   *   node:        object|null,   - the security spec being edited, or null to create
   *   existingIds: string[],      - ids already in the scenario, for the uniqueness check
   *   onSave:      function(object): void,
   *   onDelete:    function(string): void,
   * }}
   */
  constructor({ parent, container, node = null, existingIds = [], onSave, onDelete }) {
    super({ parent });
    this._container   = container;
    // An id-less node is the launcher's placeholder ("New Security"), not a record: the
    // add button has to hand the modal SOMETHING to title itself with. Treating it as a
    // record would seed the Name box with the word "New Security" and, worse, count as
    // a DECLARATION of that field — `in`, not `!= null`, is the whole rule here.
    this._node        = node?.id ? node : null;
    this._existingIds = new Set(existingIds ?? []);
    this.onSave       = onSave   ?? null;
    this.onDelete     = onDelete ?? null;
  }

  /** True when this record already exists (id fixed, Delete offered). */
  get _isEdit() { return !!this._node?.id; }

  render() {
    const el     = this._getTemplate('tpl-security-editor');
    const fields = el.querySelector('[data-id="fields"]');

    fields.appendChild(this._idFieldEl());
    for (const section of SECTIONS) {
      const specs = FIELD_SPECS.filter(s => s.section === section.key);
      if (!specs.length) continue;
      if (section.key !== 'id') fields.appendChild(_sectionHeadEl(section.label));
      for (const spec of specs) fields.appendChild(this._fieldEl(spec));
    }

    const deleteBtn = el.querySelector('[data-id="deleteBtn"]');
    deleteBtn.style.display = this._isEdit ? '' : 'none';
    this.listen(deleteBtn, 'click', () => {
      if (this.onDelete && this._node?.id) this.onDelete(this._node.id);
    });

    this.listen(el.querySelector('[data-id="saveBtn"]'), 'click', () => this._save(el));

    this._container.replaceChildren(el);
    this._rootEl = el;
  }

  // ── Fields ──────────────────────────────────────────────────────────────

  /**
   * The id row. Editable exactly once — at creation — and read-only thereafter (rule 3):
   * every lot names the id, and renaming it here would orphan them all with no error
   * anywhere, because `instrumentOf` falls back to the lot when a securityId resolves
   * to nothing.
   */
  _idFieldEl() {
    const wrap = document.createElement('div');
    wrap.className = 'node-field';
    const label = document.createElement('label');
    label.textContent = 'Id';
    const input = document.createElement('input');
    input.dataset.id    = 'id';
    input.value         = this._node?.id ?? '';
    input.placeholder   = 'e.g. sec-employer-stock';
    input.disabled      = this._isEdit;
    input.title = this._isEdit
      ? 'The id every position names. Fixed once created — a rename would orphan every lot holding it (design 94 §4 rule 3).'
      : 'Stable identity. Every lot names this, so pick something durable; a ticker change is a corporate action, not an id change.';
    wrap.append(label, input);
    return wrap;
  }

  /**
   * One field row: a DECLARE toggle plus the control it gates (property 1).
   *
   * The control stays rendered-but-disabled when undeclared rather than hidden, for the
   * same reason §10.2b keeps an inherited field visible in the holdings editor: a control
   * that vanishes leaves the reader unable to see what the instrument says.
   */
  _fieldEl(spec) {
    const wrap = document.createElement('div');
    wrap.className = 'node-field';
    wrap.dataset.field = spec.field;
    if (spec.title) wrap.title = spec.title;

    const declared = this._declared(spec.field);

    const label = document.createElement('label');
    label.textContent = spec.label;

    if (spec.declarable === false) {
      wrap.append(label, this._controlEl(spec, declared));
      return wrap;
    }

    const toggle = document.createElement('input');
    toggle.type    = 'checkbox';
    toggle.checked = declared;
    toggle.dataset.declare = spec.field;
    toggle.title = 'Declare this on the instrument. Off = silent: the position’s own value stands. '
                 + 'On with an empty box = an explicit null, which OVERRIDES the position (design 94 §4 rule 2).';
    // The toggle rides in the caption so the row keeps the one-control-per-field shape
    // every other editor in this app uses.
    const declareWrap = document.createElement('span');
    declareWrap.className = 'sec-declare';
    declareWrap.append(toggle, document.createTextNode(' declares'));
    label.appendChild(declareWrap);

    const control = this._controlEl(spec, declared);
    control.disabled = !declared;
    this.listen(toggle, 'change', () => { control.disabled = !toggle.checked; });

    wrap.append(label, control);
    return wrap;
  }

  /** Is `field` PRESENT on the record — `in`, never `!= null` (design 94 §4 rule 2). */
  _declared(field) {
    return !!this._node && field in this._node;
  }

  _controlEl(spec, declared) {
    const raw = declared ? this._node[spec.field] : undefined;
    let el;
    if (spec.kind === 'rateKey') {
      el = document.createElement('select');
      el.innerHTML = rateKeyOptionsHtml(raw ?? '', '— none (null) —');
    } else if (spec.kind === 'select') {
      el = document.createElement('select');
      el.innerHTML = [`<option value="">— none (null) —</option>`,
        ...spec.options.map(([v, t]) =>
          `<option value="${_esc(v)}"${String(raw) === v ? ' selected' : ''}>${_esc(t)}</option>`)].join('');
    } else if (spec.kind === 'check') {
      el = document.createElement('input');
      el.type    = 'checkbox';
      el.checked = raw === true;
    } else {
      el = document.createElement('input');
      el.type = spec.kind === 'number' ? 'number' : spec.kind === 'date' ? 'date' : 'text';
      if (spec.step)      el.step      = spec.step;
      if (spec.maxlength) el.maxLength = spec.maxlength;
      // The placeholder says what an EMPTY box means, and that differs by field: a blank
      // declarable field is an explicit null (property 1), while a blank symbol or name is
      // simply nothing to display. Printing "null" under Symbol would read as a value.
      el.placeholder = spec.declarable === false ? (spec.hint ?? '') : 'null';
      el.value = raw == null ? '' : (spec.kind === 'date' ? _dateValue(raw) : String(raw));
    }
    el.dataset.f = spec.field;
    return el;
  }

  // ── Save ────────────────────────────────────────────────────────────────

  /**
   * Build the spec and hand it up.
   *
   * Starts from the RECORD, not from the form: the five fields §10.2b's rule keeps off
   * this page (`UNREAD_SECURITY_FIELDS`) must survive an edit rather than be silently
   * deleted by a form that never showed them.
   */
  _save(el) {
    const spec = { ...(this._node ?? {}) };
    delete spec.__frozenSecurity;   // a frozen registry record would refuse the rebuild
    delete spec.kind;               // the list-node shape, not part of the instrument

    const id = this._isEdit ? this._node.id : el.querySelector('[data-id="id"]').value.trim();
    spec.id = id;

    for (const s of FIELD_SPECS) {
      const control = el.querySelector(`[data-f="${s.field}"]`);
      if (!control) continue;
      if (s.kind === 'check') {
        // Silent and false are indistinguishable to every reader, so write the key only
        // when it is true. Writing `false` would be a declaration the engine cannot tell
        // apart from silence — and one that would then override a lot that said true.
        if (control.checked) spec[s.field] = true;
        else delete spec[s.field];
        continue;
      }
      const value = _readValue(s, control.value);
      if (s.declarable === false) {
        // Not gated by a toggle (symbol / name — decoration, never merged over a lot),
        // so an empty box means "say nothing" rather than "declare null".
        if (value == null) delete spec[s.field];
        else               spec[s.field] = value;
        continue;
      }
      if (!el.querySelector(`[data-declare="${s.field}"]`)?.checked) { delete spec[s.field]; continue; }
      spec[s.field] = value;
    }

    const problem = this._validate(spec);
    if (problem) { this._showError(el, problem); return; }
    this._showError(el, null);
    this.onSave?.(spec);
  }

  /**
   * Reject what the registry would reject, HERE, where the author can still fix it.
   *
   * `buildSecurityRegistry` throws on a missing or duplicate id and on the reserved
   * prefix, and it throws at LOAD — i.e. after the modal has closed, on a scenario that
   * no longer opens. Same rules, applied at the keystroke that breaks them.
   */
  _validate(spec) {
    if (!spec.id) return 'An id is required — it is what every position names.';
    if (spec.id.startsWith(SYNTHETIC_SECURITY_PREFIX)) {
      return `'${SYNTHETIC_SECURITY_PREFIX}' is reserved for the four synthetic market securities `
           + '(design 94 §9.1). An authored record shadowing one would silently change what every '
           + 'un-securitised lot in that market resolves to.';
    }
    if (!this._isEdit && this._existingIds.has(spec.id)) {
      return `A security with id '${spec.id}' already exists — ids are what lots name, so they must be unique.`;
    }
    // The constructor is the authority on the shape; run it rather than re-deriving its rules.
    try { makeSecurity(spec); } catch (e) { return e.message; }
    return null;
  }

  _showError(el, message) {
    const box = el.querySelector('[data-id="error"]');
    if (!box) return;
    box.textContent   = message ?? '';
    box.style.display = message ? '' : 'none';
  }

  destroy() {
    this._rootEl?.remove();
    super.destroy();
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function _sectionHeadEl(text) {
  const head = document.createElement('div');
  head.className   = 'sec-section-head';
  head.textContent = text;
  return head;
}

/**
 * An empty declared box is an explicit `null` — "this instrument has none" — which is a
 * real statement and not the same as leaving the field undeclared. That is the whole
 * point of the DECLARE toggle, so blank must not coerce to 0 or to ''.
 */
function _readValue(spec, raw) {
  const v = String(raw ?? '').trim();
  if (v === '') return null;
  if (spec.kind === 'number') { const n = Number(v); return Number.isFinite(n) ? n : null; }
  if (spec.coerce === 'int')  { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
  return v;
}

/** A `maturityDate` may be persisted as a Date or an ISO string; the input wants yyyy-mm-dd. */
function _dateValue(raw) {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? '' : raw.toISOString().slice(0, 10);
  return String(raw).slice(0, 10);
}

function _esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
