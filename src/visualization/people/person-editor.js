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
import { bindParamLinkedField } from '../scenario/param-linked-field.js';
import { PayrollSection } from './payroll-section.js';
import { JobsSection } from './jobs-section.js';
import { defaultCurrencyForCountry } from '../../finance/country-codes.js';
import { usStateOptionPairs } from '../../finance/tax/state/us-states.js';
import { SS_CLAIM_AGES, fullRetirementAge } from '../../finance/account-rules/us/us-social-security-rules.js';

/** The person's flat job fields, which a person with jobs (design 116) does not use. */
const JOB_OWNED_FIELDS = ['monthlyWage', 'selfEmployed', 'wageCurrency', 'workCountry', 'retirementDate'];

/**
 * PersonEditor — renders the person edit form from tpl-person-editor into a
 * given container (typically a modal body).
 *
 * Communicates outward via callbacks:
 *   onSave(data)   — user clicked Save
 *   onDelete(id)   — user clicked Delete
 */
export class PersonEditor extends BaseComponent {
  /**
   * @param {{
   *   parent?:   BaseComponent,
   *   container: HTMLElement,
   *   node:      object|null,   — Person graph node, or null for a new person
   *   onSave:    function(object): void,
   *   onDelete:  function(string): void,
   * }}
   */
  constructor({ parent, container, node, onSave, onDelete,
                links = null, onParamChange = null, onOpenParam = null,
                householdParams = null, accounts = null, jobs = null }) {
    super({ parent });
    this._container = container;
    this._node      = node;
    this.onSave     = onSave   ?? null;
    this.onDelete   = onDelete ?? null;
    this._links     = links;          // ParamFieldLinks (design/32)
    this.onParamChange = onParamChange ?? null;
    this.onOpenParam   = onOpenParam   ?? null;
    this._linkedFields = new Set();
    // Design 95 §17 phase 10. The household parameter BAG (`cfg.parameters`, not
    // the typed `cfg.params` list — the two stores are easy to confuse and only one
    // of them is keyed by plain param name) backs the "inherit …" placeholders; the
    // sibling accounts back the wage-split destinations.
    this._householdParams = householdParams ?? {};
    this._accounts        = accounts ?? [];
    this._payroll         = null;
    // Design 116 §7 — this person's `cfg.jobs` rows. Copied by JobsSection; the host
    // writes the edited list back to the scenario record on Save.
    this._jobsIn          = jobs ?? [];
    this._jobs            = null;
  }

  render() {
    const el = this._getTemplate('tpl-person-editor');

    const isEdit = !!(this._node?.id);

    // Populate fields
    el.querySelector('[data-id="name"]').value = this._node?.name ?? '';

    const bd = this._node?.birthDate;
    el.querySelector('[data-id="birthDate"]').value =
      bd instanceof Date ? bd.toISOString().slice(0, 10)
                        : (bd ? String(bd).slice(0, 10) : '');

    const citizenSel = el.querySelector('[data-id="citizen"]');
    const citizens   = this._node?.citizen ?? ['US'];
    for (const opt of citizenSel.options) opt.selected = citizens.includes(opt.value);

    // US state of residency (design 34) — optional, options from the shared
    // US_STATES list. null/undefined selects the blank "None" option; it must not
    // fall back to a state, or an unconfigured person would silently acquire a
    // state income tax.
    const stateSel = el.querySelector('[data-id="residencyState"]');
    for (const [value, label] of usStateOptionPairs({ blankLabel: 'None', labelStyle: 'codeAndName' })) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      stateSel.appendChild(opt);
    }
    stateSel.value = this._node?.residencyState ?? '';

    el.querySelector('[data-id="lifeExpectancy"]').value        = this._node?.lifeExpectancy        ?? 90;
    el.querySelector('[data-id="socialSecurityMonthly"]').value = this._node?.socialSecurityMonthly ?? 2800;
    this._renderClaimAge(el);
    el.querySelector('[data-id="monthlyWage"]').value           = this._node?.monthlyWage           ?? 0;
    el.querySelector('[data-id="selfEmployed"]').checked         = this._node?.selfEmployed          ?? false;

    // Per-field native currency (design 10 §Phase 5). Default from residency /
    // citizenship when the person carries no explicit code.
    const defaultCur = defaultCurrencyForCountry(this._node?.residency ?? this._node?.citizen?.[0]);
    el.querySelector('[data-id="ssCurrency"]').value   = this._node?.ssCurrency   ?? defaultCur;
    el.querySelector('[data-id="wageCurrency"]').value = this._node?.wageCurrency ?? defaultCur;

    // Where the work is performed (design 73 Gap 1) — the source attribute, kept
    // separate from the wage's denomination. Empty string is the "" option, i.e.
    // follow residency; it must not be coerced to a country here or the default
    // would silently become a claim about where someone works.
    el.querySelector('[data-id="workCountry"]').value = this._node?.workCountry ?? '';

    const rd = this._node?.retirementDate;
    el.querySelector('[data-id="retirementDate"]').value =
      rd instanceof Date ? rd.toISOString().slice(0, 10)
                        : (rd ? String(rd).slice(0, 10) : '2040-01-01');
    // Blank = roll over on the day they stop work (design 117 D9).
    const kd = this._node?.k401ToIraConversionDate;
    el.querySelector('[data-id="k401ToIraConversionDate"]').value = kd ? String(kd).slice(0, 10) : '';

    // ── Payroll elections (design 95 §17 phase 10) ──────────────────────────
    // Rendered before the param links are bound below because the section binds
    // its own linked fields and reports them back through `_linkedFields`, which
    // `_readForm` uses to keep a param-owned field out of the service payload.
    this._payroll = new PayrollSection({
      container:       el.querySelector('[data-id="payrollBody"]'),
      node:            this._node,
      householdParams: this._householdParams,
      accounts:        this._accounts,
      links:           this._links,
      onParamChange:   () => this.onParamChange?.(),
      onOpenParam:     (p) => this.onOpenParam?.(p),
      // Read LIVE rather than off the node: changing the wage currency has to
      // re-offer the split destinations, since a cross-currency split is refused
      // by `splitWage` and the editor must not be able to author one.
      wageCurrency:    () => el.querySelector('[data-id="wageCurrency"]').value,
    });
    this._payroll.render();

    // ── Jobs (design 116 §7) ─────────────────────────────────────────────────
    // The first job is seeded from the flat fields as they stand on the form NOW, so a
    // wage typed a moment ago is what the converted row carries.
    const flat = (id) => el.querySelector(`[data-id="${id}"]`);
    this._jobs = new JobsSection({
      container: el.querySelector('[data-id="jobsBody"]'),
      jobs:      this._jobsIn,
      readFlat:  () => ({
        monthlyWage:    flat('monthlyWage').value,
        wageCurrency:   flat('wageCurrency').value,
        workCountry:    flat('workCountry').value,
        selfEmployed:   flat('selfEmployed').checked,
        retirementDate: flat('retirementDate').value,
      }),
      onChange: () => this._syncJobLock(el),
    });
    this._jobs.render();
    if (this._jobsIn.length > 0) el.querySelector('[data-id="jobsSection"]').open = true;
    this._syncJobLock(el);
    this.listen(el.querySelector('[data-id="wageCurrency"]'), 'change',
                () => this._payroll.refreshSplitDestinations());

    // Show Delete only when editing an existing person
    const deleteBtn = el.querySelector('[data-id="deleteBtn"]');
    deleteBtn.style.display = isEdit ? '' : 'none';

    this.listen(el.querySelector('[data-id="saveBtn"]'), 'click', () => {
      if (this.onSave) this.onSave(this._readForm(el));
    });

    this.listen(deleteBtn, 'click', () => {
      if (this.onDelete && this._node?.id) this.onDelete(this._node.id);
    });

    this._bindParamLinks(el);

    this._container.replaceChildren(el);
    this._rootEl = el;
  }

  /**
   * The Social Security claim age (design 118): blank is full retirement age, labelled
   * with the FRA this birth date gets, so the form and the sim read the same table.
   */
  _renderClaimAge(el) {
    const sel = el.querySelector('[data-id="ssClaimAge"]');
    sel.innerHTML = '';
    const bd  = this._node?.birthDate;
    const fra = bd ? fullRetirementAge(bd) : null;
    const fraLabel = fra ? `At full retirement age (${fra.years}y ${fra.months}m)` : 'At full retirement age';
    for (const [value, label] of [['', fraLabel], ...SS_CLAIM_AGES.map(a => [String(a), String(a)])]) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      sel.appendChild(opt);
    }
    sel.value = this._node?.ssClaimAge == null ? '' : String(this._node.ssClaimAge);
  }

  /**
   * Lock the flat job fields while the person has jobs (design 116 §5.1): the engine reads
   * the spells and ignores these, so an editable box would be a value nothing reads. The
   * Retire Date shows the DERIVED work end — the last job's end, blank when it runs until
   * death — so the form keeps one source of truth.
   */
  _syncJobLock(el) {
    const locked = !!this._jobs?.hasJobs;
    for (const id of JOB_OWNED_FIELDS) {
      const input = el.querySelector(`[data-id="${id}"]`);
      if (!input) continue;
      input.disabled = locked;
    }
    const rd = el.querySelector('[data-id="retirementDate"]');
    if (locked) {
      if (rd.dataset.authored == null) rd.dataset.authored = rd.value;
      const rows = this._jobs.readJobs()
        .sort((a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? ''));
      rd.value = rows[rows.length - 1]?.endDate ?? '';
      rd.title = rd.value ? 'The end of the last job.' : 'The last job is open-ended: works until death.';
    } else if (rd.dataset.authored != null) {
      rd.value = rd.dataset.authored;
      delete rd.dataset.authored;
      rd.title = '';
    }
  }

  /** This person's edited job rows, for the host to write to `cfg.jobs`. */
  readJobs() {
    return this._jobs?.readJobs() ?? [];
  }

  /** Route param-backed person fields through their param (design/32). */
  _bindParamLinks(el) {
    this._linkedFields = new Set();
    const id = this._node?.id;
    if (!id || !this._links) return;

    const candidates = [
      { dataId: 'monthlyWage',    field: 'monthlyWage',    coerce: (raw) => Number(raw) || 0 },
      { dataId: 'retirementDate', field: 'retirementDate', coerce: (raw) => raw },
      { dataId: 'k401ToIraConversionDate', field: 'k401ToIraConversionDate', coerce: (raw) => raw || null },
      { dataId: 'ssClaimAge', field: 'ssClaimAge', coerce: (raw) => (raw === '' ? null : Number(raw)) },
      // The scenario's `residencyState` param links to the PRIMARY person only
      // (its Enum options are '' plus US_STATE_CODES, so blank stays '' rather
      // than null here). A person with no such param — the spouse — edits the
      // field directly.
      { dataId: 'residencyState', field: 'residencyState', coerce: (raw) => raw || '' },
    ];
    for (const { dataId, field, coerce } of candidates) {
      const param = this._links.getParamFor('person', id, field);
      if (!param) continue;
      const input   = el.querySelector(`[data-id="${dataId}"]`);
      const labelEl = input?.closest('.node-field')?.querySelector('label');
      bindParamLinkedField({
        input, labelEl, param, coerce,
        onChange: () => this.onParamChange?.(),
        onOpen:   (p) => this.onOpenParam?.(p),
      });
      this._linkedFields.add(field);
    }
  }

  _readForm(el) {
    const citizenSel = el.querySelector('[data-id="citizen"]');
    const data = {
      id:                    this._node?.id ?? null,
      name:                  el.querySelector('[data-id="name"]').value.trim(),
      birthDate:             el.querySelector('[data-id="birthDate"]').value,
      citizen:               [...citizenSel.selectedOptions].map(o => o.value),
      // "" ⇒ no state of residency. Normalised to null to match Person's default
      // shape, which primaryResidencyState() reads as "no state income tax".
      residencyState:        el.querySelector('[data-id="residencyState"]').value || null,
      lifeExpectancy:        Number(el.querySelector('[data-id="lifeExpectancy"]').value),
      socialSecurityMonthly: Number(el.querySelector('[data-id="socialSecurityMonthly"]').value),
      ssClaimAge:            el.querySelector('[data-id="ssClaimAge"]').value === ''
                               ? null : Number(el.querySelector('[data-id="ssClaimAge"]').value),
      monthlyWage:           Number(el.querySelector('[data-id="monthlyWage"]').value),
      selfEmployed:          el.querySelector('[data-id="selfEmployed"]').checked,
      retirementDate:        el.querySelector('[data-id="retirementDate"]').value,
      k401ToIraConversionDate: el.querySelector('[data-id="k401ToIraConversionDate"]').value || null,
      ssCurrency:            el.querySelector('[data-id="ssCurrency"]').value,
      wageCurrency:          el.querySelector('[data-id="wageCurrency"]').value,
      // "" ⇒ follow residency. Normalised to null so the stored shape matches
      // Person's default rather than carrying an empty string through the config.
      workCountry:           el.querySelector('[data-id="workCountry"]').value || null,
    };
    // Design 95 §17 phase 10. Blank stays `null` here — "inherit the household
    // default" — and never becomes 0, which would opt the person out (§17.6).
    Object.assign(data, this._payroll?.readElections() ?? {});
    // Design 116 §7: converting to jobs clears the flat job fields, so nothing reads a
    // stale single-job wage. The retire date is kept (a Person always carries one) but is
    // ignored while jobs exist, and the box shows the derived end, not it.
    data.jobs = this.readJobs();
    if (data.jobs.length > 0) {
      data.monthlyWage  = 0;
      data.selfEmployed = false;
      data.workCountry  = null;
      delete data.retirementDate;
    }
    // Param-backed fields are owned by their scenario param (design/32). The
    // payroll section reports its own linked elections, which land in the same set
    // so one deletion loop covers both.
    for (const f of (this._payroll?.linkedFields ?? [])) this._linkedFields.add(f);
    for (const f of this._linkedFields) delete data[f];
    return data;
  }

  destroy() {
    this._rootEl?.remove();
    super.destroy();
  }
}
