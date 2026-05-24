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
  }

  /** Pre-assign an id (normally left null so PersonService assigns one). */
  id(v)                    { this._id = v;                    return this; }
  birthDate(v)             { this._birthDate = v;             return this; }
  name(v)                  { this._name = v;                  return this; }
  /** @param {string[]} v - ISO country codes, e.g. ['US'], ['AUS'], ['US','AUS'] */
  citizen(v)               { this._citizen = v;               return this; }
  lifeExpectancy(v)        { this._lifeExpectancy = v;        return this; }
  socialSecurityMonthly(v) { this._socialSecurityMonthly = v; return this; }

  build() {
    return new Person(this._id, this._birthDate, {
      name:                  this._name,
      citizen:               this._citizen,
      lifeExpectancy:        this._lifeExpectancy,
      socialSecurityMonthly: this._socialSecurityMonthly,
    });
  }
}

export class PersonBuilder {
  /** Start building a new Person. */
  static person() { return new PersonBuilderInstance(); }
}
