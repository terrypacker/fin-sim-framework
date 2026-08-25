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
   * @param {string|null} [opts.workCountry=null]          - Country where the employment is actually EXERCISED
   *                                                         ('US'|'AU'). This — not the payment currency, the
   *                                                         payer's residence, or the account the money lands in
   *                                                         — determines the source of employment income
   *                                                         (FCT v French (1957) 98 CLR 398; AU–US treaty Art 15).
   *                                                         null = follow the earner's residency as it stands when
   *                                                         the wage accrues, which is the common case and keeps
   *                                                         existing scenarios unchanged (design 73 Gap 1).
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
    // by PayrollHandler and subject to US SECA tax.
    this.selfEmployed          = opts.selfEmployed          ?? false;
    this.retirementDate        = opts.retirementDate        ?? new Date(Date.UTC(2040, 0, 1));
    // Per-field native currency (design 10 §Phase 5), individually overridable;
    // each defaults to the residency/citizenship currency.
    this.wageCurrency          = opts.wageCurrency          ?? defaultCurrencyForCountry(this.residency);
    // Design 73 Gap 1: source of employment income is the place the services are
    // performed. Currency was standing in for it, which is not a proxy at all —
    // an Australian employer can pay AUD to someone who never sets foot in
    // Australia. Left null the earner is assumed to work where they live; set it
    // to model a cross-border commuter or a remote worker paid from abroad.
    this.workCountry           = opts.workCountry           ?? null;
    this.ssCurrency            = opts.ssCurrency            ?? defaultCurrencyForCountry(this.residency);
    // AU CGT reform (design 57 §6.6): recipients of means-tested income support
    // (Age Pension / JobSeeker) are exempt from the 30% CGT minimum tax.
    this.incomeSupportRecipient = opts.incomeSupportRecipient ?? false;

    // ── Payroll elections (design 95 §7.1, phase 1) ──────────────────────────
    //
    // A contribution election belongs to a PERSON, not a household. Before this
    // they were toolset parameters, so every earner in a household necessarily
    // deferred the same percentage into their own plan and one spouse could not
    // salary-sacrifice while the other did not.
    //
    // **`null` means "inherit the household default", `0` means "elect nothing".**
    // The distinction is load-bearing and is why every one of these defaults to
    // null rather than 0: a person who has explicitly opted out must not silently
    // re-acquire the household rate, and a person who has expressed no preference
    // must not silently opt out. Resolution is `person.X ?? householdParam.X`, so
    // a scenario that sets none of them behaves exactly as it did before.
    //
    // Phase 3 added `matchTiers` here; phase 6b added the AU member-contribution
    // streams below. The rest mirror the existing toolset parameters one for one,
    // which is what made phase 1 pure plumbing with no new semantics.
    this.k401DeferralPct        = opts.k401DeferralPct        ?? null;
    this.k401EmployerMatchPct   = opts.k401EmployerMatchPct   ?? null;
    this.k401AnnualCap          = opts.k401AnnualCap          ?? null;
    // Design 95 §7.2 phase 3. `matchTiers` is the general match formula —
    // [{matchRate, uptoPctOfComp}] consumed in order — and supersedes
    // k401EmployerMatchPct, which is now read as a 100% match on the first N%.
    // `k401NonElectivePct` is the genuinely non-elective employer contribution: it
    // does not depend on the employee deferring anything, so it is NOT a match and
    // gets its own field rather than being faked as a tier.
    this.k401MatchTiers         = opts.k401MatchTiers         ?? null;
    this.k401NonElectivePct     = opts.k401NonElectivePct     ?? null;
    this.iraAnnualContribution  = opts.iraAnnualContribution  ?? null;
    this.rothAnnualContribution = opts.rothAnnualContribution ?? null;
    // AU. Named for the handler's constructor rather than the toolset parameter
    // (`superGuaranteeAnnualCap`), because this is an election on a person and the
    // toolset key is a household default that happens to feed it.
    this.superGuaranteePct      = opts.superGuaranteePct      ?? null;
    this.superAnnualCap         = opts.superAnnualCap         ?? null;
    // Design 95 §9.1 phase 6b — the member's own three streams. See
    // PAYROLL_ELECTION_FIELDS for what separates them; the short version is that
    // sacrifice never touches the member's cash, the other two are paid out of it,
    // and only the non-concessional one escapes the fund's 15% Div 295 tax.
    this.superSalarySacrificePct             = opts.superSalarySacrificePct             ?? null;
    this.superPersonalDeductibleContribution = opts.superPersonalDeductibleContribution ?? null;
    this.superNonConcessionalContribution    = opts.superNonConcessionalContribution    ?? null;

    // Direct deposit across several accounts (design 95 §6, phase 2). An ordered
    // list of {destinationKey, mode: 'PERCENT'|'FIXED', value}; null or empty means
    // the whole wage lands in the transaction account, which is the pre-phase-2
    // behaviour and what every existing scenario does.
    //
    // This is CASH ROUTING with no tax consequence — the tax chain keeps carrying
    // the gross wage regardless of where the money lands.
    this.wageSplits             = opts.wageSplits             ?? null;
  }
}

/**
 * The per-person payroll election fields (design 95 §7.1).
 *
 * Exported as a list because four places have to agree on it — the constructor
 * above, the serializer's two halves, and `computePayroll`'s resolution. A new
 * election added to only three of them is the defect class that left handler pins
 * unserialized: correct in a fresh compile, silently gone after a reload.
 */
export const PAYROLL_ELECTION_FIELDS = [
  // Design 95 §6 phase 2. An array rather than a scalar, but it belongs on this list
  // for exactly the same reason: the constructor, both serializer halves and the
  // state projection all have to carry it, and a field present in three of the four
  // is inert in a way nothing errors on.
  'wageSplits',
  'k401DeferralPct',
  'k401EmployerMatchPct',
  'k401AnnualCap',
  'k401MatchTiers',
  'k401NonElectivePct',
  'iraAnnualContribution',
  'rothAnnualContribution',
  'superGuaranteePct',
  'superAnnualCap',
  // Design 95 §9.1 phase 6b — the three MEMBER super streams, alongside the
  // employer's SG above. They differ in where the money comes from and in what tax
  // it attracts on the way in, which is why they are three fields and not one:
  //   sacrifice   — pre-tax, never reaches the member's cash, 15% Div 295
  //   deductible  — after-tax cash out, 15% Div 295, deducted on the return (s290-150)
  //   nonConcess. — after-tax cash out, NO Div 295, no deduction (Div 292 only)
  // Sacrifice is a RATE because it is a standing arrangement with the employer
  // deducted every payday; the other two are ANNUAL AMOUNTS paid from cash the
  // member already holds, which is the same shape as the IRA/Roth elections above.
  'superSalarySacrificePct',
  'superPersonalDeductibleContribution',
  'superNonConcessionalContribution',
];
