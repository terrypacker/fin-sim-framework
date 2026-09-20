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
 * What each election MEANS is not here: it is in `help/nodes/person.md`, or — for the
 * eight that are also generated parameters — in their record param template. Prose in a
 * registry is prose nothing reviews and nothing checks, and this file carried thirteen
 * descriptions that reached the user only as a truncated `title=` (design 111 §2).
 *
 * @type {Array<{field: string, label: string, kind: string, country: string|null,
 *               household: string|null}>}
 */
export const PAYROLL_ELECTION_META = [
  // ── Routing (no country: it follows the wage wherever it is paid) ──────────
  {
    field: 'wageSplits', label: 'Direct Deposit', kind: ELECTION_KIND.SPLITS,
    country: null, household: null,
  },

  // ── US ─────────────────────────────────────────────────────────────────────
  {
    field: 'k401DeferralPct', label: '401(k) Deferral', kind: ELECTION_KIND.PERCENT,
    country: 'US', household: 'k401DeferralPct',
  },
  {
    field: 'k401EmployerMatchPct', label: '401(k) Match Rate', kind: ELECTION_KIND.PERCENT,
    country: 'US', household: 'k401EmployerMatchPct',
  },
  {
    field: 'k401MatchTiers', label: '401(k) Match Formula', kind: ELECTION_KIND.TIERS,
    country: 'US', household: 'k401MatchTiers',
  },
  {
    field: 'k401NonElectivePct', label: '401(k) Non-Elective', kind: ELECTION_KIND.PERCENT,
    country: 'US', household: 'k401NonElectivePct',
  },
  {
    field: 'k401AnnualCap', label: '401(k) Annual Cap', kind: ELECTION_KIND.MONEY,
    country: 'US', household: 'k401AnnualCap',
  },
  {
    field: 'iraAnnualContribution', label: 'IRA Contribution', kind: ELECTION_KIND.MONEY,
    country: 'US', household: 'iraAnnualContribution',
  },
  {
    field: 'rothAnnualContribution', label: 'Roth Contribution', kind: ELECTION_KIND.MONEY,
    country: 'US', household: 'rothAnnualContribution',
  },

  // ── AU ─────────────────────────────────────────────────────────────────────
  {
    field: 'superGuaranteePct', label: 'Super Guarantee', kind: ELECTION_KIND.PERCENT,
    country: 'AU', household: 'superGuaranteePct',
  },
  {
    // The one field whose household key is NOT its own name — see the header.
    field: 'superAnnualCap', label: 'Super Guarantee Cap', kind: ELECTION_KIND.MONEY,
    country: 'AU', household: 'superGuaranteeAnnualCap',
  },
  {
    field: 'superSalarySacrificePct', label: 'Salary Sacrifice', kind: ELECTION_KIND.PERCENT,
    country: 'AU', household: 'superSalarySacrificePct',
  },
  {
    field: 'superPersonalDeductibleContribution', label: 'Personal Deductible', kind: ELECTION_KIND.MONEY,
    country: 'AU', household: 'superPersonalDeductibleContribution',
  },
  {
    field: 'superNonConcessionalContribution', label: 'Non-Concessional', kind: ELECTION_KIND.MONEY,
    country: 'AU', household: 'superNonConcessionalContribution',
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
