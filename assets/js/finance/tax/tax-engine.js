/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseTaxModule } from './base-tax-module.js';

/**
 * TaxEngine — registry for BaseTaxModule instances keyed by countryCode + year.
 *
 * Lookup uses the highest registered year <= the requested year, falling back
 * to the earliest registered year for that country when none qualifies.
 */
export class TaxEngine {
  constructor() {
    /** @type {Record<string, BaseTaxModule>} */
    this._modules = {};
  }

  /**
   * @param {BaseTaxModule} module
   */
  register(module) {
    if (!(module instanceof BaseTaxModule)) {
      throw new Error('TaxEngine.register: module must extend BaseTaxModule');
    }
    const key = `${module.countryCode}_${module.year}`;
    this._modules[key] = module;
    console.log(`[TaxEngine] Registered module: ${key}`);
  }

  /**
   * Returns the module for countryCode whose year is the highest available <= year.
   * Falls back to the earliest registered module for that country if year is before
   * all known years.
   * @param {string} countryCode
   * @param {number} year
   * @returns {BaseTaxModule}
   */
  get(countryCode, year) {
    const available = Object.keys(this._modules)
      .filter(k => k.startsWith(countryCode + '_'))
      .map(k => parseInt(k.split('_')[1]))
      .sort((a, b) => a - b);

    if (available.length === 0) {
      throw new Error(`[TaxEngine] No tax module registered for country: ${countryCode}`);
    }

    const best = available.filter(y => y <= year).pop() ?? available[0];
    return this._modules[`${countryCode}_${best}`];
  }

  /** @returns {BaseTaxModule[]} */
  getAll() {
    return Object.values(this._modules);
  }

  /**
   * Returns the sorted union of all registered years across all countries.
   * @returns {number[]}
   */
  getAvailableYears() {
    const years = new Set(
      Object.keys(this._modules).map(k => parseInt(k.split('_')[1]))
    );
    return Array.from(years).sort((a, b) => a - b);
  }

  /**
   * @param {string} countryCode
   * @returns {boolean}
   */
  hasModule(countryCode) {
    return Object.keys(this._modules).some(k => k.startsWith(countryCode + '_'));
  }
}
