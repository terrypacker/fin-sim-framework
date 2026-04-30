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
 * Logic lives in PersonService (src/services/person-service.js).
 */
export class Person {
  /**
   * @param {string|null} id       - Unique identifier; null until assigned by PersonService
   * @param {Date}        birthDate - Date of birth (used for age-gated rules)
   * @param {object}      [opts]
   * @param {string}      [opts.name='']
   * @param {string[]}    [opts.citizen=['US']] - ISO country codes (e.g. 'US', 'AUS')
   * @param {boolean}     [opts.isAuResident]   - AU tax-resident flag; defaults to citizen.includes('AUS')
   * @param {number}      [opts.lifeExpectancy=90]         - Expected years to live
   * @param {number}      [opts.socialSecurityMonthly=2800] - USD/month of SS at full retirement age
   */
  constructor(id, birthDate, opts = {}) {
    this.id                    = id ?? null;
    this.birthDate             = birthDate;
    this.name                  = opts.name                  ?? '';
    this.citizen               = opts.citizen               ?? ['US'];
    this.isAuResident          = opts.isAuResident          ?? this.citizen.includes('AUS');
    this.lifeExpectancy        = opts.lifeExpectancy        ?? 90;
    this.socialSecurityMonthly = opts.socialSecurityMonthly ?? 2800;
  }
}
