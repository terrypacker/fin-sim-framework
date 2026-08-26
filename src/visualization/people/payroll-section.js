/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import {
  PAYROLL_ELECTION_META, ELECTION_KIND, householdParamFor, inheritedValue,
} from '../../finance/payroll/payroll-election-meta.js';
import { SPLIT_MODE, isDepositable } from '../../finance/payroll/wage-splits.js';
import { buildRowListEditor, readRowList } from '../components/row-list-editor.js';
import { bindParamLinkedField } from '../scenario/param-linked-field.js';

/**
 * payroll-section.js — design 95 §17 phase 10, gaps G1-G3.
 *
 * The person editor's "Payroll" section: the thirteen per-person elections design
 * 95 phase 1 built and nothing could reach. Rendered here rather than in a modal of
 * its own (§17.3 U1) because every one of them is read against `monthlyWage` and
 * `retirementDate`, which live on this form.
 *
 * ─── blank means INHERIT, and it must never round-trip as 0 (U2) ─────────────
 *
 * `elect()` in the payroll handler is `person[field] ?? householdValue`, `??` and
 * not `||`, deliberately: `null` on a person means "no preference — inherit the
 * household default" and `0` means "elect nothing", and those must not collapse
 * (design 95 §13.2). Every scenario the user already has was saved with `null` in
 * all thirteen fields, so an editor that wrote `0` for an untouched field would
 * silently convert every one of them from "inherit" into "opt out" on the first
 * save — with no error, and the symptom is contributions quietly stopping in a
 * scenario nobody thought they had edited (§17.6).
 *
 * So: the input starts BLANK, its **placeholder shows the inherited value**, and
 * `readElections` maps a blank back to `null`. An explicit `0` typed by the user is
 * a real opt-out and survives, which is the same assertion PAY-14 makes at the model
 * layer.
 *
 * ─── the two list elections share one widget (G1/G3) ─────────────────────────
 *
 * `wageSplits` and `k401MatchTiers` are both lists of small objects, so they share
 * `row-list-editor.js`. `k401MatchTiers` was declared `type: 'Json'` and the
 * scenario panel cannot draw one, which made D3's "safe-harbor becomes data, not
 * code" true only in the sense that hand-typed JSON is data.
 *
 * ─── the split destination is a stateKey, never an id ────────────────────────
 *
 * `splitWage` resolves `state[destinationKey]`, and runtime account state carries
 * `stateKey` but not `id`. Offering an id would persist a value that silently never
 * matches — the share falls back to the transaction account and the plan quietly
 * differs (the design 72 §2 defect, in a new place). Accounts with no stateKey are
 * not offered at all, and neither are accounts in a currency other than the wage's:
 * `splitWage` refuses those as an unmodelled FX leg, so the editor must not be able
 * to author one.
 */

/** Elections whose value is a scalar the number inputs hold. */
const SCALAR_KINDS = new Set([ELECTION_KIND.PERCENT, ELECTION_KIND.MONEY]);

/** Section groupings, in render order. */
const GROUPS = [
  { country: null, title: 'Pay Routing' },
  { country: 'US', title: 'US — 401(k) / IRA' },
  { country: 'AU', title: 'AU — Superannuation' },
];

export class PayrollSection {
  /**
   * @param {object} o
   * @param {HTMLElement} o.container         the section body to render into
   * @param {object|null} o.node              the Person graph node being edited
   * @param {object}      [o.householdParams] the scenario parameter BAG (`cfg.parameters`)
   * @param {Array<object>} [o.accounts]      sibling accounts, for the split destinations
   * @param {object}      [o.links]           ParamFieldLinks (design/32)
   * @param {function}    [o.onParamChange]
   * @param {function}    [o.onOpenParam]
   * @param {function(): string} [o.wageCurrency] reads the form's CURRENT wage currency
   */
  constructor({ container, node, householdParams = {}, accounts = [], links = null,
                onParamChange = null, onOpenParam = null, wageCurrency = null }) {
    this._container       = container;
    this._node            = node;
    this._householdParams = householdParams ?? {};
    this._accounts        = accounts ?? [];
    this._links           = links;
    this._onParamChange   = onParamChange;
    this._onOpenParam     = onOpenParam;
    this._wageCurrency    = wageCurrency;

    // The list elections are edited IN PLACE by the row editor, so they are cloned
    // off the node up front: a live reference would mutate the Person before Save,
    // and cancelling the modal would not undo it.
    this._splits = (this._node?.wageSplits ?? []).map(r => ({ ...r }));
    this._tiers  = (this._node?.k401MatchTiers ?? []).map(r => ({ ...r }));

    /** Election fields owned by a scenario param (design/32) — excluded from Save. */
    this.linkedFields = new Set();
  }

  render() {
    this._container.replaceChildren();

    const note = document.createElement('div');
    note.className = 'payroll-inherit-note';
    note.dataset.id = 'inheritNote';
    note.textContent =
      'Blank inherits the household default (shown greyed in each field). '
      + 'Type 0 to opt this person out entirely.';
    this._container.appendChild(note);

    for (const { country, title } of GROUPS) {
      const fields = PAYROLL_ELECTION_META.filter(m => m.country === country);
      if (fields.length === 0) continue;

      const heading = document.createElement('div');
      heading.className = 'payroll-group-heading';
      heading.textContent = title;
      this._container.appendChild(heading);

      for (const meta of fields) {
        this._container.appendChild(
          SCALAR_KINDS.has(meta.kind) ? this._scalarField(meta) : this._listField(meta));
      }
    }
  }

  /** A number input whose EMPTY state is "inherit" and whose 0 is an opt-out. */
  _scalarField(meta) {
    const row = document.createElement('div');
    row.className = 'node-field';

    const label = document.createElement('label');
    label.textContent = meta.label;
    label.title       = meta.hint;
    row.appendChild(label);

    const input = document.createElement('input');
    input.type       = 'number';
    input.dataset.id = electionFieldId(meta.field);
    input.title      = meta.hint;
    input.step       = meta.kind === ELECTION_KIND.PERCENT ? '0.01' : '100';
    input.min        = '0';
    // `?? ''` — NOT `|| ''`. An explicit 0 election is a real opt-out and has to
    // render as 0, or reopening the editor would show it as "inherit" and saving
    // would silently restore the household default.
    input.value       = this._node?.[meta.field] ?? '';
    input.placeholder = this._placeholderFor(meta);
    row.appendChild(input);

    // Param-owned when the scenario carries a param for this field (design/32):
    // the param→node cascade would otherwise overwrite a form edit on Rebuild.
    const param = this._node?.id
      ? this._links?.getParamFor('person', this._node.id, meta.field) ?? null
      : null;
    if (param) {
      bindParamLinkedField({
        input, labelEl: label, param,
        // The nullable coercion, at the param layer this time. A blank must reach
        // the param as null so the cascade writes null onto the record.
        coerce: (raw) => nullableNum(raw),
        onChange: () => this._onParamChange?.(),
        onOpen:   (p) => this._onOpenParam?.(p),
      });
      this.linkedFields.add(meta.field);
    }
    return row;
  }

  /**
   * The inherited value, as placeholder text.
   *
   * Three distinct states, and collapsing any two of them misleads: an election with
   * NO household parameter at all (nothing to inherit), one whose household default
   * is unset (inherits, but inherits nothing), and one with a real default. Reading
   * `undefined` off the bag cannot tell the first two apart — an absent key and an
   * absent parameter look identical — so the parameter's EXISTENCE is asked
   * separately.
   */
  _placeholderFor(meta) {
    if (householdParamFor(meta.field) == null) return '';   // no household default exists
    const inherited = inheritedValue(meta.field, this._householdParams);
    if (inherited == null) return 'inherit (unset)';
    return `inherit ${formatInherited(meta, inherited)}`;
  }

  /** A repeating-row list election (`wageSplits`, `k401MatchTiers`). */
  _listField(meta) {
    const block = document.createElement('div');
    block.className = 'node-field payroll-list-field';
    block.dataset.id = `${electionFieldId(meta.field)}Block`;

    const label = document.createElement('label');
    label.textContent = meta.label;
    label.title       = meta.hint;
    block.appendChild(label);

    const editor = meta.field === 'wageSplits' ? this._splitEditor() : this._tierEditor();
    editor.dataset.id = electionFieldId(meta.field);
    block.appendChild(editor);
    return block;
  }

  _splitEditor() {
    const options = this._destinationOptions();
    const el = buildRowListEditor({
      rows:    this._splits,
      columns: [
        { field: 'destinationKey', label: 'Destination', type: 'select', options, width: '2fr' },
        { field: 'mode',  label: 'Mode', type: 'select', width: '1.1fr',
          options: [[SPLIT_MODE.PERCENT, '% of net'], [SPLIT_MODE.FIXED, 'Fixed']] },
        { field: 'value', label: 'Value', step: '0.01', min: '0', width: '1fr' },
      ],
      // A new row defaults to a PERCENT of nothing rather than to the first account:
      // an unfinished row must not quietly reroute pay the moment it is added.
      newRow:    () => ({ destinationKey: null, mode: SPLIT_MODE.PERCENT, value: null }),
      addLabel:  '+ Add Destination',
      emptyText: 'All net pay goes to this person\'s transaction account.',
    });
    this._splitEditorEl = el;
    return el;
  }

  _tierEditor() {
    return buildRowListEditor({
      rows:    this._tiers,
      columns: [
        { field: 'matchRate',     label: 'Match Rate',  step: '0.05', min: '0' },
        { field: 'uptoPctOfComp', label: 'Up to % Pay', step: '0.01', min: '0' },
      ],
      newRow:    () => ({ matchRate: null, uptoPctOfComp: null }),
      addLabel:  '+ Add Tier',
      emptyText: 'No formula — the flat match rate above applies.',
    });
  }

  /**
   * Destination options: `[stateKey, name]` for every account a paycheque can
   * actually be deposited into.
   *
   * Three filters, and each one removes a split the model would mishandle rather
   * than refuse:
   *
   *  - **no stateKey** — nothing in runtime state to credit, so an id persisted here
   *    silently never matches (design 72 §2).
   *  - **wrong currency** — `splitWage` refuses one, because a cross-currency split
   *    is an international transfer with an FX leg and a §988 disposal attached.
   *  - **not depositable** — a 401(k)/IRA/Roth/super is reachable only through a
   *    CONTRIBUTION, and a loan's positive balance is debt, so crediting either from
   *    a wage split books money nothing accounted for. See `DEPOSITABLE_ROLES`.
   */
  _destinationOptions() {
    const wageCur = this._currentWageCurrency();
    const opts = [['', '— choose —']];
    for (const a of this._accounts) {
      if (!a?.stateKey) continue;
      if (!isDepositable(a)) continue;
      const code = typeof a.currency === 'string' ? a.currency : a.currency?.code ?? null;
      if (wageCur && code && code !== wageCur) continue;
      opts.push([a.stateKey, a.name || a.stateKey]);
    }
    return opts;
  }

  _currentWageCurrency() {
    const live = this._wageCurrency?.();
    return live ?? this._node?.wageCurrency ?? null;
  }

  /**
   * Re-draw the destination options after the form's wage currency changed, so the
   * offered accounts always match the currency the wage is actually paid in. Rows
   * already authored are kept: the row editor marks a value with no matching option
   * "(not found)" rather than silently re-pointing it at the first account.
   */
  refreshSplitDestinations() {
    const previous = this._splitEditorEl;
    if (!previous) return;
    // `_splitEditor()` re-points `_splitEditorEl` at the new element, so the old one
    // is captured first — otherwise this replaces the replacement with itself and
    // the stale options stay on screen.
    const replacement = this._splitEditor();
    replacement.dataset.id = electionFieldId('wageSplits');
    previous.replaceWith(replacement);
  }

  /**
   * The elections to save, `null` for every field left blank.
   *
   * Param-owned fields are omitted entirely (their param is the source of truth and
   * the service payload must not carry a second copy), exactly as the person
   * editor's other linked fields are.
   *
   * @returns {object} a partial Person patch
   */
  readElections() {
    const out = {};
    for (const meta of PAYROLL_ELECTION_META) {
      if (this.linkedFields.has(meta.field)) continue;
      if (SCALAR_KINDS.has(meta.kind)) {
        const input = this._container.querySelector(`[data-id="${electionFieldId(meta.field)}"]`);
        out[meta.field] = nullableNum(input?.value);
      }
    }
    // A row is kept only when it is complete. A half-typed split (an account with no
    // amount, or an amount with no account) is not an election, and `splitWage`
    // would drop it anyway — persisting it would leave the editor showing a row that
    // does nothing.
    out.wageSplits = readRowList(this._splits,
      r => r?.destinationKey != null && r.destinationKey !== '' && Number(r.value) > 0);
    out.k401MatchTiers = readRowList(this._tiers,
      r => Number(r?.matchRate) > 0 && Number(r?.uptoPctOfComp) > 0);
    return out;
  }
}

/** The `data-id` for an election input — namespaced so it cannot collide with a form field. */
export function electionFieldId(field) { return `pe_${field}`; }

/**
 * Blank ⇒ `null` (inherit). A typed `0` ⇒ `0` (elect nothing).
 *
 * The whole of U2 is this function being `??`-shaped rather than `||`-shaped. Mirrors
 * `_nullableNum` in accounts-controller.js, which exists for the same reason on the
 * loan fields.
 */
export function nullableNum(v) {
  if (v == null) return null;
  const raw = String(v).trim();
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Render an inherited household value the way its own input would show it. */
function formatInherited(meta, value) {
  if (meta.kind === ELECTION_KIND.PERCENT) {
    return `${(value * 100).toFixed(value * 100 % 1 === 0 ? 0 : 2)}%`;
  }
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 });
}
