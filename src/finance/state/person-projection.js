/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { PAYROLL_ELECTION_FIELDS } from '../person.js';

/**
 * person-projection.js — the ONE projection of a `Person` record into `state.people`.
 *
 * ─── why this is a module and not three inline loops ─────────────────────────
 *
 * It used to be three: `US_RETIREMENT.state()`, `AU_RETIREMENT.state()` and
 * `US_AU_CROSS_BORDER.state()` each built the same map, and each had drifted to a
 * different field list. The cross-border copy was complete; the other two dropped
 * `residencyState` and `incomeSupportRecipient`.
 *
 * That is not a cosmetic difference, because `state.people` is what every consumer
 * reads — `residency-utils`, the wage handler, the tax settle. Dropping
 * `residencyState` meant `StateTaxSettleService.computeStateTax` found no state
 * code and returned zero, so **US state income tax was silently unreachable in any
 * scenario that did not also include the cross-border toolset** — even though
 * `US_STATE_TAX` depends on nothing but `US_TAX` and is offered to every US
 * scenario. Nothing threw; the state return simply never appeared in the journal.
 *
 * A single projector makes a new person field a one-line change that reaches every
 * scenario, instead of three places where two can be forgotten.
 *
 * ─── what the callers still decide ───────────────────────────────────────────
 *
 * Only the defaults that genuinely differ by country, plus residency:
 *
 *   - `residency` — US_AU_CROSS_BORDER overrides it with the scenario's
 *     `startingResidency` (everyone starts on the same side of the move,
 *     whatever their citizenship says); AU_RETIREMENT pins 'AU'; US_RETIREMENT
 *     lets the person's own field, then their first citizenship, decide.
 *   - `defaultWageCurrency` / `defaultCitizen` — an unstated wage in an
 *     AU-only scenario is AUD, and in a US-only scenario USD.
 *
 * Merge note: `_mergeStatePatches` merges `people` at the KEY level, so whichever
 * toolset writes a person last replaces that person's whole entry. Every projection
 * therefore has to be complete — a partial patch would delete fields, which is the
 * comment that has sat in the cross-border copy since it was written.
 */

/**
 * Project one Person record into its `state.people[id]` entry.
 *
 * @param {object}  person
 * @param {object}  [opts]
 * @param {string}  [opts.residency]            forced residency; omit to use the
 *                                              person's own, then their first citizenship
 * @param {string}  [opts.defaultWageCurrency='USD']
 * @param {string}  [opts.defaultCitizen='US']
 * @returns {object} the state entry
 */
export function projectPerson(person, {
  residency = undefined,
  defaultWageCurrency = 'USD',
  defaultCitizen = 'US',
} = {}) {
  const citizen = person.citizen ?? [defaultCitizen];
  return {
    id:                    person.id,
    name:                  person.name,
    birthDate:             person.birthDate,
    monthlyWage:           person.monthlyWage           ?? 0,
    // Self-employment flag (design 69) — routes monthlyWage through the SE path.
    selfEmployed:          person.selfEmployed          ?? false,
    // Native currency of the wage (design 50) — drives PayrollHandler's US vs
    // AU routing. MUST be projected or every wage reads as the default.
    wageCurrency:          person.wageCurrency          ?? defaultWageCurrency,
    // Where the employment is exercised (design 73 Gap 1) — the attribute that
    // actually determines the source of employment income. null ⇒ the earner works
    // where they live, resolved per accrual so it tracks a mid-sim move.
    workCountry:           person.workCountry           ?? null,
    retirementDate:        person.retirementDate        ?? null,
    socialSecurityMonthly: person.socialSecurityMonthly ?? 0,
    lifeExpectancy:        person.lifeExpectancy        ?? 90,
    citizen,
    residency:             residency ?? person.residency ?? citizen[0] ?? 'US',
    // US state of residency (design 34) — the field StateTaxSettleService reads to
    // pick a state rates module. Absent ⇒ no state income tax at all.
    residencyState:        person.residencyState         ?? null,
    // AU CGT 30% minimum-tax exemption (design 57 §6.6).
    incomeSupportRecipient: person.incomeSupportRecipient ?? false,
    // Payroll elections (design 95 §7.1, phase 1). `computePayroll` resolves each as
    // `state.people[k][field] ?? householdDefault`, so an unprojected field would
    // make every personal election silently inert — the person carries it, the
    // toolset gate schedules the event on the strength of it, and then the handler
    // reads `state.people` and cannot see it. Exactly the failure this module was
    // extracted to prevent, and it happened here before the projection was updated.
    //
    // `?? null` and NOT `?? 0`: null means "inherit the household default" and 0
    // means "elect nothing". Projecting a missing election as 0 would opt every
    // existing person out of every household rate.
    ...Object.fromEntries(
      PAYROLL_ELECTION_FIELDS.map(f => [f, person[f] ?? null])),
  };
}

/**
 * Project every person in a compiler context into a `state.people`-shaped map.
 *
 * @param {Array<object>} people
 * @param {object} [opts] — forwarded to {@link projectPerson}
 */
export function projectPeople(people, opts) {
  const out = {};
  for (const person of people ?? []) out[person.id] = projectPerson(person, opts);
  return out;
}
