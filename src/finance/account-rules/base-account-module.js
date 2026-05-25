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
 * BaseAccountModule — abstract base for country+year account rule providers.
 *
 * Subclasses expose query hooks (e.g. getEarlyWithdrawalRules) consumed by the
 * AccountRulesEngine at runtime.  Handler and reducer registration is handled
 * exclusively by toolsets — modules do not instantiate handlers or reducers.
 */
export class BaseAccountModule {
  /** @returns {string}  e.g. 'US' or 'AU' */
  get countryCode() {
    throw new Error(`${this.constructor.name}: countryCode not implemented`);
  }

  /** @returns {number}  e.g. 2025 or 2026 */
  get year() {
    throw new Error(`${this.constructor.name}: year not implemented`);
  }

  /**
   * Returns early-withdrawal penalty rules for the given account type.
   * Returns null for account types that don't support early withdrawal, or for
   * country modules where no early-withdrawal rules apply (e.g. AU).
   *
   * @param {string} accountType - ACCOUNT_TYPE value
   * @returns {{ penaltyRate: number, ageThreshold: number } | null}
   */
  getEarlyWithdrawalRules(_accountType) {
    return null;
  }

  /**
   * Returns Social Security eligibility rules for this country and year.
   * Returns null for countries where SS does not apply.
   *
   * @returns {{ minAge: number } | null}
   */
  getSsEligibilityRules() {
    return null;
  }

  /**
   * Returns IRA Required Minimum Distribution rules for this country and year.
   * Returns null for countries where IRA RMDs do not apply.
   *
   * @returns {{ rmdAge: number } | null}
   */
  getIraRmdRules() {
    return null;
  }
}
