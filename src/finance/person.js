/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import {SimGraphNode} from "../graph/sim-graph-node.js";
import {defaultCurrencyForCountry} from "./country-codes.js";

/**
 * Person — plain data class representing a simulation participant.
 * No methods; safe for structuredClone snapshots.
 * Logic lives in PersonService (src/services/person-service.js).
 */
export class Person extends SimGraphNode {
  /**
   * @param {string|null} id       - Unique identifier; null until assigned by PersonService
   * @param {Date}        birthDate - Date of birth (used for age-gated rules)
   * @param {object}      [opts]
   * @param {string}      [opts.name='']
   * @param {string[]}    [opts.citizen=['US']] - ISO country codes (e.g. 'US', 'AU'); stable, never mutated by a move
   * @param {string}      [opts.residency]      - Current country of tax residency (e.g. 'US', 'AU'); defaults to citizen[0]
   * @param {string|null} [opts.residencyState=null] - US residency state (sub-jurisdiction of residency='US'),
   *                                                   e.g. 'NE'|'HI'|'SD'. null = no US state configured.
   *                                                   Household active state is derived from the primary (design 34).
   * @param {number}      [opts.lifeExpectancy=90]         - Expected years to live
   * @param {number}      [opts.socialSecurityMonthly=2800] - USD/month of SS at full retirement age
   * @param {number}      [opts.monthlyWage=0]             - gross wages/month in wageCurrency (0 = not employed)
   * @param {boolean}     [opts.selfEmployed=false]        - When true, monthlyWage is self-employment income
   *                                                         (sole trader / 1099) routed through the SE path
   *                                                         instead of wages; incurs US SECA tax (design 69)
   * @param {Date}        [opts.retirementDate]            - Date wages stop; defaults to 2040-01-01
   * @param {string}      [opts.wageCurrency]              - Native currency of monthlyWage; defaults from residency
   * @param {string}      [opts.ssCurrency]                - Native currency of socialSecurityMonthly; defaults from residency
   */
  constructor(id = null, birthDate, opts = {}) {
    super({id: id, kind: 'person', layer: 'config', name: opts.name ?? ''});
    this.birthDate             = birthDate;
    this.citizen               = opts.citizen               ?? ['US'];
    this.residency             = opts.residency             ?? this.citizen[0] ?? 'US';
    this.residencyState        = opts.residencyState        ?? null;
    this.lifeExpectancy        = opts.lifeExpectancy        ?? 90;
    this.socialSecurityMonthly = opts.socialSecurityMonthly ?? 2800;
    this.monthlyWage           = opts.monthlyWage           ?? 0;
    // Self-employment flag (design 69): when true, monthlyWage is treated as
    // self-employment income (sole trader / 1099) — routed through the SE path
    // by MonthlyWagesHandler and subject to US SECA tax.
    this.selfEmployed          = opts.selfEmployed          ?? false;
    this.retirementDate        = opts.retirementDate        ?? new Date(Date.UTC(2040, 0, 1));
    // Per-field native currency (design 10 §Phase 5), individually overridable;
    // each defaults to the residency/citizenship currency.
    this.wageCurrency          = opts.wageCurrency          ?? defaultCurrencyForCountry(this.residency);
    this.ssCurrency            = opts.ssCurrency            ?? defaultCurrencyForCountry(this.residency);
    // AU CGT reform (design 57 §6.6): recipients of means-tested income support
    // (Age Pension / JobSeeker) are exempt from the 30% CGT minimum tax.
    this.incomeSupportRecipient = opts.incomeSupportRecipient ?? false;
  }
}
