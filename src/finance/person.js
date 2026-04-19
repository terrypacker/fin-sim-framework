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
 * Person — plain data class representing a simulation participant.
 * No methods; safe for structuredClone snapshots.
 * Logic lives in PersonService.
 */
export class Person {
  /**
   * @param {string} id         - Unique identifier (e.g. 'primary', 'spouse')
   * @param {Date}   birthDate  - Date of birth (used for age-gated rules)
   * @param {object} [opts]
   * @param {string}  [opts.name='']
   * @param {boolean} [opts.isAuResident=false]
   */
  constructor(id, birthDate, opts = {}) {
    this.id           = id;
    this.birthDate    = birthDate;
    this.name         = opts.name         ?? '';
    this.isAuResident = opts.isAuResident ?? false;
  }
}

/**
 * PersonService — stateless age calculations.
 * Centralises the getAge / getAgeDecimal helpers that were previously
 * duplicated in every evt-*.test.mjs file.
 */
export class PersonService {
  /**
   * Returns age in whole years as of asOfDate.
   * Used for age-60 gates (Roth, IRA, Superannuation).
   *
   * @param {Person} person
   * @param {Date}   asOfDate
   * @returns {number}
   */
  getAge(person, asOfDate) {
    const years = asOfDate.getFullYear() - person.birthDate.getFullYear();
    const hadBirthday =
      asOfDate.getMonth() > person.birthDate.getMonth() ||
      (asOfDate.getMonth() === person.birthDate.getMonth() &&
       asOfDate.getDate()  >= person.birthDate.getDate());
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
