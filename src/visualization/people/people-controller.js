/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { PAYROLL_ELECTION_FIELDS } from '../../finance/person.js';

/**
 * Carry the per-person payroll elections (design 95 §7.1) through from the editor.
 *
 * Whitelisted rather than spread, because `create()` builds an explicit shape and a
 * field absent from it is silently dropped — which is precisely how a payroll
 * election ends up "written, saved, shown in the UI, consumed by nothing" (the
 * phase-1 defect, design 95 §13.2). Driven off the exported field list so this is
 * not a sixth place to keep in sync by hand.
 *
 * **`??`, not `||`.** `undefined` (the editor did not send the field at all — it is
 * param-owned) means leave the Person's value alone; `null` means "inherit the
 * household default"; `0` means "elect nothing". Coercing here with `||` would turn
 * every explicit opt-out back into the household rate.
 */
function _elections(data) {
  const out = {};
  for (const f of PAYROLL_ELECTION_FIELDS) {
    if (data?.[f] !== undefined) out[f] = data[f];
  }
  return out;
}

/**
 * PeopleController — pure domain layer for Person CRUD.
 * No DOM, no bus, no globals — all dependencies injected.
 */
export class PeopleController {
  /** @param {{ personService: import('../../finance/services/person-service.js').PersonService }} */
  constructor({ personService }) {
    this._service = personService;
  }

  /**
   * @param {{ name: string, birthDate: string, citizen: string[],
   *           residencyState: string|null,
   *           lifeExpectancy: number, socialSecurityMonthly: number,
   *           monthlyWage: number, retirementDate: string }} data
   * @returns {import('../../finance/person.js').Person}
   */
  create(data) {
    return this._service.createPerson(new Date(data.birthDate), {
      name:                  data.name,
      citizen:               data.citizen,
      residencyState:        data.residencyState ?? null,   // US state of residency (design 34); null = none
      lifeExpectancy:        Number(data.lifeExpectancy),
      socialSecurityMonthly: Number(data.socialSecurityMonthly),
      monthlyWage:           Number(data.monthlyWage ?? 0),
      selfEmployed:          Boolean(data.selfEmployed),
      retirementDate:        data.retirementDate ? new Date(data.retirementDate) : new Date(Date.UTC(2040, 0, 1)),
      wageCurrency:          data.wageCurrency,
      workCountry:           data.workCountry ?? null,  // design 73 Gap 1
      ssCurrency:            data.ssCurrency,
      // Payroll elections (design 95 §17 phase 10) — null-preserving; see `_elections`.
      ..._elections(data),
    });
  }

  /**
   * @param {string} id
   * @param {object} changes  — same shape as create data, all optional
   */
  update(id, changes) {
    const normalized = { ...changes };
    if (normalized.birthDate)                     normalized.birthDate             = new Date(normalized.birthDate);
    if (normalized.lifeExpectancy        != null) normalized.lifeExpectancy        = Number(normalized.lifeExpectancy);
    if (normalized.socialSecurityMonthly != null) normalized.socialSecurityMonthly = Number(normalized.socialSecurityMonthly);
    if (normalized.monthlyWage           != null) normalized.monthlyWage           = Number(normalized.monthlyWage);
    if (normalized.selfEmployed          != null) normalized.selfEmployed          = Boolean(normalized.selfEmployed);
    if (normalized.retirementDate)                normalized.retirementDate        = new Date(normalized.retirementDate);
    // '' (the editor's "None" option) means no state of residency — store the
    // null Person uses, so state-tax lookups see one shape only.
    if (normalized.residencyState === '')         normalized.residencyState        = null;
    return this._service.updatePerson(id, normalized);
  }

  /** @param {string} id */
  delete(id) {
    return this._service.deletePerson(id);
  }

  /** @returns {import('../../finance/person.js').Person[]} */
  list() {
    return this._service.getAll();
  }
}
