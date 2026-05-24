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
   *           lifeExpectancy: number, socialSecurityMonthly: number }} data
   * @returns {import('../../finance/person.js').Person}
   */
  create(data) {
    return this._service.createPerson(new Date(data.birthDate), {
      name:                  data.name,
      citizen:               data.citizen,
      lifeExpectancy:        Number(data.lifeExpectancy),
      socialSecurityMonthly: Number(data.socialSecurityMonthly),
    });
  }

  /**
   * @param {string} id
   * @param {object} changes  — same shape as create data, all optional
   */
  update(id, changes) {
    const normalized = { ...changes };
    if (normalized.birthDate)             normalized.birthDate             = new Date(normalized.birthDate);
    if (normalized.lifeExpectancy        != null) normalized.lifeExpectancy        = Number(normalized.lifeExpectancy);
    if (normalized.socialSecurityMonthly != null) normalized.socialSecurityMonthly = Number(normalized.socialSecurityMonthly);
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
