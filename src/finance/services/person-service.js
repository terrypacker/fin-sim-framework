/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseService } from '../../services/base-service.js';
import { Person } from '../person.js';

/**
 * PersonService — manages Person instances and provides stateless age helpers.
 *
 * Extends BaseService so persons are stored in a Map<id, Person> and
 * participate in the ServiceActionEvent lifecycle (CREATE / UPDATE / DELETE).
 * Persons are persisted as part of the scenario configuration via
 * ScenarioSerializer but are not wired into the Simulation directly — they
 * are referenced by tax / account rules at scenario build time.
 */
export class PersonService extends BaseService {
  constructor(bus) {
    super(bus, 'p');
  }

  // ─── Create ───────────────────────────────────────────────────────────────

  /**
   * Create a new Person, assign a service-generated id, and publish CREATE.
   *
   * @param {Date}   birthDate
   * @param {object} [opts]    - Same options as the Person constructor
   * @returns {Person}
   */
  createPerson(birthDate, opts = {}) {
    const item = new Person(null, birthDate, opts);
    item.id = this._generateId(this._idPrefix);
    this._register(item);
    this._publish('CREATE', 'Person', item);
    return item;
  }

  // ─── Update ───────────────────────────────────────────────────────────────

  /**
   * Apply `changes` to an existing person and publish UPDATE.
   *
   * @param {string|Person} idOrPerson
   * @param {object}        changes
   * @returns {Person}
   */
  updatePerson(idOrPerson, changes = {}) {
    const person = this._resolve(idOrPerson);
    const originalItem = { ...person };
    Object.assign(person, changes);
    this._publish('UPDATE', 'Person', person, originalItem);
    return person;
  }

  // ─── Delete ───────────────────────────────────────────────────────────────

  /**
   * Remove a person from the service map and publish DELETE.
   *
   * @param {string|Person} idOrPerson
   * @returns {Person}
   */
  deletePerson(idOrPerson) {
    const person = this._resolve(idOrPerson);
    this._unregister(person.id);
    this._publish('DELETE', 'Person', person, person);
    return person;
  }

  // ─── Age helpers ──────────────────────────────────────────────────────────

  /**
   * Returns age in whole years as of asOfDate.
   * Used for age-60 gates (Roth, IRA, Superannuation).
   *
   * @param {Person} person
   * @param {Date}   asOfDate
   * @returns {number}
   */
  getAge(person, asOfDate) {
    const years = asOfDate.getUTCFullYear() - person.birthDate.getUTCFullYear();
    const hadBirthday =
      asOfDate.getUTCMonth() > person.birthDate.getUTCMonth() ||
      (asOfDate.getUTCMonth() === person.birthDate.getUTCMonth() &&
       asOfDate.getUTCDate()  >= person.birthDate.getUTCDate());
    return hadBirthday ? years : years - 1;
  }

  /**
   * Returns age as a decimal (fractional years) as of asOfDate.
   * Used for the age-59.5 gate (401k, IRA).
   *
   * @param {Person} person
   * @param {Date}   asOfDate
   * @returns {number}
   */
  getAgeDecimal(person, asOfDate) {
    const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
    return (asOfDate - person.birthDate) / msPerYear;
  }
}
