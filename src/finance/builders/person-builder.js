/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Person } from '../person.js';

/**
 * Fluent builder for Person instances.
 *
 * Usage:
 *   const person = PersonBuilder.person()
 *     .name('Alice')
 *     .birthDate(new Date(Date.UTC(1980, 5, 15)))
 *     .citizen(['US'])
 *     .lifeExpectancy(90)
 *     .socialSecurityMonthly(2400)
 *     .build();
 *
 *   // Register with PersonService to get a service-assigned id:
 *   const saved = personService.register(person);
 */
class PersonBuilderInstance {
  constructor() {
    this._id                    = null;
    this._birthDate             = new Date(Date.UTC(1980, 0, 1));
    this._name                  = '';
    this._citizen               = ['US'];
    this._lifeExpectancy        = 90;
    this._socialSecurityMonthly = 2800;
    this._monthlyWage           = 0;
    this._selfEmployed          = false;
    this._retirementDate        = new Date(Date.UTC(2040, 0, 1));
    // Design 95 §7.1 phase 1 — per-person payroll elections. Undefined here rather
    // than null so that `build()` can omit them entirely and let Person apply its
    // own null default, keeping one definition of "unset".
    this._elections             = {};
  }

  /** Pre-assign an id (normally left null so PersonService assigns one). */
  id(v)                    { this._id = v;                    return this; }
  birthDate(v)             { this._birthDate = v;             return this; }
  name(v)                  { this._name = v;                  return this; }
  /** @param {string[]} v - ISO country codes, e.g. ['US'], ['AU'], ['US','AU'] */
  citizen(v)               { this._citizen = v;               return this; }
  lifeExpectancy(v)        { this._lifeExpectancy = v;        return this; }
  socialSecurityMonthly(v) { this._socialSecurityMonthly = v; return this; }
  monthlyWage(v)           { this._monthlyWage = v;           return this; }
  /** @param {boolean} v - true = monthlyWage is self-employment income (design 69) */
  selfEmployed(v)          { this._selfEmployed = v;          return this; }
  retirementDate(v)        { this._retirementDate = v;        return this; }

  /**
   * Set one or more payroll elections (design 95 §7.1). Merges, so successive
   * calls accumulate rather than replace.
   *
   * `null` for a field means "inherit the household default"; `0` means "elect
   * nothing". They are different, and the difference is the point.
   *
   * @param {{k401DeferralPct?: number, k401EmployerMatchPct?: number,
   *          k401AnnualCap?: ?number, iraAnnualContribution?: number,
   *          rothAnnualContribution?: number, superGuaranteePct?: number,
   *          superAnnualCap?: ?number}} v
   */
  payroll(v)               { Object.assign(this._elections, v); return this; }

  /**
   * Direct-deposit allocation for this person's pay (design 95 §6).
   * @param {Array<{destinationKey: string, mode: 'PERCENT'|'FIXED', value: number}>} v
   */
  wageSplits(v)            { this._elections.wageSplits = v;   return this; }

  build() {
    return new Person(this._id, this._birthDate, {
      name:                  this._name,
      citizen:               this._citizen,
      lifeExpectancy:        this._lifeExpectancy,
      socialSecurityMonthly: this._socialSecurityMonthly,
      monthlyWage:           this._monthlyWage,
      selfEmployed:          this._selfEmployed,
      retirementDate:        this._retirementDate,
      ...this._elections,
    });
  }
}

export class PersonBuilder {
  /** Start building a new Person. */
  static person() { return new PersonBuilderInstance(); }
}
