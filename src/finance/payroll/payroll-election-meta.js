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
 * payroll-election-meta.js — design 95 §17 phase 10. What each per-person payroll
 * election IS, for anything that has to draw one.
 *
 * `PAYROLL_ELECTION_FIELDS` (finance/person.js) is the list of election NAMES that
 * the constructor, both serializer halves and the state projection must agree on.
 * This module is the sibling that says what each one means: its label, the shape of
 * its value, and — the part nothing else records in one place — **which household
 * parameter it inherits from when the person expresses no preference**.
 *
 * ─── the inheritance map is not the identity ─────────────────────────────────
 *
 * Eleven of the twelve scalar elections share a name with their household default.
 * `superAnnualCap` does NOT: the household key is `superGuaranteeAnnualCap`, because
 * at the household level it is explicitly a cap on the EMPLOYER's Super Guarantee
 * (design 95 §13.9 — measuring it against the shared concessional pool was a real
 * defect), while on a Person it sits beside the other per-person caps. A UI that
 * assumed the names matched would show "inherits 0" over a household cap that was
 * really set, which is the same class of silent wrongness as showing an inherited
 * value that is not the one the engine will use.
 *
 * ─── `kind` drives the widget, and the widget decides what null means ────────
 *
 * `PERCENT` and `MONEY` are scalars a number input can hold, and for them BLANK
 * means inherit while an explicit 0 means elect nothing (design 95 §13.2 — `??`,
 * not `||`). `TIERS` and `SPLITS` are lists, and their empty state is an empty list,
 * which `splitWage`/`monthlyK401` already collapse to the no-election behaviour.
 * Nothing here may default a scalar to 0: that converts every saved "inherit" into
 * an opt-out on the first save, silently, and the symptom is contributions quietly
 * stopping (design 95 §17.6).
 */

/** The value shapes an election can take. */
export const ELECTION_KIND = {
  /** Fraction of pay. Rendered as a percentage; stored as a fraction. */
  PERCENT: 'PERCENT',
  /** An annual amount in the person's wage currency. */
  MONEY:   'MONEY',
  /** `[{ matchRate, uptoPctOfComp }]` — the 401(k) match formula (design 95 §7.2). */
  TIERS:   'TIERS',
  /** `[{ destinationKey, mode, value }]` — direct deposit (design 95 §6). */
  SPLITS:  'SPLITS',
};

/**
 * Every per-person payroll election, in the order a person editor should show them.
 *
 * `country` groups them for display only — an election is never gated on residency,
 * because the engine gates on the WAGE CURRENCY (an AUD earner's 401(k) deferral
 * would debit USD they were never paid, design 95 §5). Showing both sets keeps a
 * cross-border household editable in one place.
 *
 * @type {Array<{field: string, label: string, kind: string, country: string|null,
 *               household: string|null, hint: string}>}
 */
export const PAYROLL_ELECTION_META = [
  // ── Routing (no country: it follows the wage wherever it is paid) ──────────
  {
    field: 'wageSplits', label: 'Direct Deposit', kind: ELECTION_KIND.SPLITS,
    country: null, household: null,
    hint: 'Where this person\'s NET pay lands. Fixed amounts are taken first in list '
        + 'order, then percentages of the original net pay; whatever is left goes to '
        + 'their transaction account. Cash routing only — it has no tax consequence.',
  },

  // ── US ─────────────────────────────────────────────────────────────────────
  {
    field: 'k401DeferralPct', label: '401(k) Deferral', kind: ELECTION_KIND.PERCENT,
    country: 'US', household: 'k401DeferralPct',
    hint: 'Employee deferral as a share of annual pay. Pre-tax: it reduces income tax '
        + 'but NOT FICA (§3121(a) has no §402(g) exclusion).',
  },
  {
    field: 'k401EmployerMatchPct', label: '401(k) Match Rate', kind: ELECTION_KIND.PERCENT,
    country: 'US', household: 'k401EmployerMatchPct',
    hint: 'Read as a 100% match on the first N% of pay. Employer-funded: never debits '
        + 'household cash and is not the employee\'s deduction. Superseded for this '
        + 'person by a match formula below, if one is set.',
  },
  {
    field: 'k401MatchTiers', label: '401(k) Match Formula', kind: ELECTION_KIND.TIERS,
    country: 'US', household: 'k401MatchTiers',
    hint: 'The general match, as tiers consumed in order — e.g. 100% of the first 3% '
        + 'then 50% of the next 2% (the safe-harbor basic match). Someone deferring '
        + 'less than the band is matched only what they deferred.',
  },
  {
    field: 'k401NonElectivePct', label: '401(k) Non-Elective', kind: ELECTION_KIND.PERCENT,
    country: 'US', household: 'k401NonElectivePct',
    hint: 'Employer contribution that does NOT depend on the employee deferring '
        + 'anything (profit-sharing / safe-harbor non-elective). Not a match, and it '
        + 'counts toward the §415(c) annual-additions limit.',
  },
  {
    field: 'k401AnnualCap', label: '401(k) Annual Cap', kind: ELECTION_KIND.MONEY,
    country: 'US', household: 'k401AnnualCap',
    hint: 'A SCENARIO assumption applied to the deferral and the match separately — '
        + 'not a statutory limit. §402(g), §414(v), §415(c) and §401(a)(17) apply on '
        + 'top of it and are never disabled by leaving this blank.',
  },
  {
    field: 'iraAnnualContribution', label: 'IRA Contribution', kind: ELECTION_KIND.MONEY,
    country: 'US', household: 'iraAnnualContribution',
    hint: 'Deductible Traditional IRA contribution per year, paid in twelfths from cash.',
  },
  {
    field: 'rothAnnualContribution', label: 'Roth Contribution', kind: ELECTION_KIND.MONEY,
    country: 'US', household: 'rothAnnualContribution',
    hint: 'After-tax Roth contribution per year, paid in twelfths from cash. No income '
        + 'phase-out is modelled.',
  },

  // ── AU ─────────────────────────────────────────────────────────────────────
  {
    field: 'superGuaranteePct', label: 'Super Guarantee', kind: ELECTION_KIND.PERCENT,
    country: 'AU', household: 'superGuaranteePct',
    hint: 'Employer SG as a share of annual pay, on top of salary. Computed on '
        + 'PRE-sacrifice pay (SGAA s10A(1)(h)) and truncated at the s10A(5) maximum '
        + 'contributions base.',
  },
  {
    // The one field whose household key is NOT its own name — see the header.
    field: 'superAnnualCap', label: 'Super Guarantee Cap', kind: ELECTION_KIND.MONEY,
    country: 'AU', household: 'superGuaranteeAnnualCap',
    hint: 'A scenario cap on the EMPLOYER SG alone, measured against this person\'s own '
        + 'SG for the financial year. The Div 291 concessional cap applies separately '
        + 'and is never disabled by leaving this blank.',
  },
  {
    field: 'superSalarySacrificePct', label: 'Salary Sacrifice', kind: ELECTION_KIND.PERCENT,
    country: 'AU', household: 'superSalarySacrificePct',
    hint: 'Pre-tax share of pay sacrificed into super. Never reaches the member\'s cash; '
        + 'reduces PAYG but NOT the SG. Taxed 15% in the fund (Div 295).',
  },
  {
    field: 'superPersonalDeductibleContribution', label: 'Personal Deductible', kind: ELECTION_KIND.MONEY,
    country: 'AU', household: 'superPersonalDeductibleContribution',
    hint: 'Annual after-tax contribution deducted on the return (s290-150). Paid from '
        + 'cash, taxed 15% in the fund, and the deduction is capped by s26-55 at '
        + 'assessable income less other deductions — the excess is lost, not carried.',
  },
  {
    field: 'superNonConcessionalContribution', label: 'Non-Concessional', kind: ELECTION_KIND.MONEY,
    country: 'AU', household: 'superNonConcessionalContribution',
    hint: 'Annual after-tax contribution with NO deduction and NO 15% fund tax. Buys a '
        + 'tax-sheltered location rather than a deduction; bound by the Div 292 cap '
        + 'and its bring-forward.',
  },
];

/** Index by field name, for the editors and reports that resolve one at a time. */
export const PAYROLL_ELECTION_META_BY_FIELD =
  new Map(PAYROLL_ELECTION_META.map(m => [m.field, m]));

/**
 * The household parameter a person's election inherits from, or null when the
 * election has no household default at all (`wageSplits` — routing is inherently
 * per-person, since it names that person's own accounts).
 *
 * @param {string} field
 * @returns {string|null}
 */
export function householdParamFor(field) {
  return PAYROLL_ELECTION_META_BY_FIELD.get(field)?.household ?? null;
}

/**
 * The value this person's election would resolve to if left blank — the household
 * default, exactly as `elect()` in the payroll handler reads it.
 *
 * Returns `undefined` when there is no household parameter to inherit (as opposed
 * to `null`, which is a household default that is genuinely unset), so a caller can
 * tell "nothing to inherit" from "inherits nothing".
 *
 * @param {string} field
 * @param {object} householdParams  the scenario's parameter BAG (`cfg.parameters`)
 */
export function inheritedValue(field, householdParams) {
  const key = householdParamFor(field);
  if (key == null) return undefined;
  return householdParams?.[key];
}
