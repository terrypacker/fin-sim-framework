/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HandlerEntry }                           from '../../simulation-framework/handlers.js';
import { FieldValueAction, RecordBalanceAction }  from '../../simulation-framework/actions.js';
import { ACCOUNT_ROLES }                          from '../state/account-roles.js';
import { ageAt }                                  from '../mpc/harvest.js';
import { splitWage }                              from '../payroll/wage-splits.js';
import { monthlyK401 }                            from '../payroll/k401-limits.js';
import { ficaOnWage }                             from '../tax/us/fica-rates.js';
import { monthlyAuSuper, auFinancialYearOf }      from '../payroll/au-super-caps.js';

/**
 * payroll-handler.js — design 95 phase 0. One pipeline, two queue positions.
 *
 * ─── what this replaced ──────────────────────────────────────────────────────
 *
 * Three unrelated handlers each re-derived the same facts from `state.people`:
 * `MonthlyWagesHandler` (who is earning, in what currency, into which account),
 * `UsRetirementContributionHandler` and `AuSuperGuaranteeHandler` (who is earning,
 * in what currency, and how much of it is diverted). Three copies of "is this
 * person still working on this date" is three chances for them to disagree — and
 * they already differed in one respect, since only the wage path branched on
 * `selfEmployed`.
 *
 * **All three were DELETED in phase 6.** They are named throughout this file
 * because the reasoning only makes sense against what it replaced, but nothing
 * imports them any more. A saved scenario that still carries one as a persisted
 * node is recompiled from its toolsets and never deserializes it; a pre-toolsets
 * export cannot be, and `_RETIRED_TYPES` in `scenario-serializer.js` makes that
 * failure say so.
 *
 * `computePayroll()` derives all of it once. The handler emits a SLICE of that
 * result depending on which event fired.
 *
 * ─── why two events and not one ──────────────────────────────────────────────
 *
 * Design 95 §5.2 originally called for a single `PAYROLL` event, on the argument
 * that the pipeline's ordering should be structural rather than a convention
 * enforced by `order(n)`. Measurement killed that. The month-end sequence is:
 *
 *     wages(0) → expenses(0) → savings interest → contributions(1)
 *
 * and `UsSavingsInterestMonthlyHandler` reads the LIVE balance
 * (`us-savings-interest-handler.js:59`), not a period-start snapshot. A single
 * event fires at one queue position, so it cannot straddle expenses and interest.
 * Moving contributions ahead of the interest credit lowers the balance interest
 * accrues on by the whole deferral — about \$2.50 a month on the reference
 * household, every month, compounding. That is a real arithmetic change, not a
 * heap tie-break, and the exact-match goldens catch it every time.
 *
 * So the COMPUTATION is unified and the EMISSION is split. `computePayroll` is a
 * pure function of (date, state, params) with no memoisation and no writes, so
 * calling it once per stage is safe and cheap — and specifically it does NOT
 * stash figures in state between the two events, which was the fragility that
 * argued against keeping three handlers in the first place.
 *
 * ─── how it got here ─────────────────────────────────────────────────────────
 *
 * Phase 0 changed NOTHING about the numbers: every action emitted was
 * byte-identical to the three legacy handlers', in the same order, with the same
 * fields, verified by running them side by side. That is what made it safe to
 * change behaviour in phases 1-5 and to delete the old path in phase 6 — at no
 * point was there a single change that both moved numbers and removed the thing
 * the new numbers were checked against. `evt-payroll-pipeline.test.mjs` now
 * carries the emitted stream as a frozen shape, since there is no longer a second
 * implementation to compare with.
 */

/**
 * How much of the paycheque is withheld before it reaches the household (design 95
 * §8.2, phase 5).
 *
 * `FICA_ONLY` is the default and the honest one: FICA is EXACT — a rate times a base
 * — so it can be withheld to the cent with no estimate involved. Income-tax
 * withholding is not: real withholding follows the Form W-4 / Pub 15-T tables, which
 * are not on disk and are not worth transcribing to make a projection's monthly cash
 * marginally smoother. So income tax keeps settling annually, as every other tax in
 * this model does, and the setting says plainly what it does and does not cover.
 *
 * `NONE` is the pre-phase-5 behaviour, retained so a saved scenario or a golden can
 * be re-run unchanged.
 *
 * `PRIOR_YEAR_SAFE_HARBOR` (§8.2) is NOT implemented. It withholds FICA plus a
 * twelfth of the prior year's income-tax liability, which can OVER-withhold when
 * income falls — and an over-withholding has to come back as a refund. The tax
 * payment reducer debits cash and replenishes from investments when short; it has no
 * credit path, so a refund needs machinery phase 5 deliberately does not build. FICA
 * alone can never over-withhold: the liability it is credited against always
 * includes it.
 */
export const WITHHOLDING_METHOD = {
  /** Withhold FICA exactly; income tax still settles annually. */
  FICA_ONLY: 'FICA_ONLY',
  /** Credit the wage gross; every tax settles annually. Pre-phase-5 behaviour. */
  NONE:      'NONE',
};

/** Which slice of the pipeline an event asks for. */
export const PAYROLL_STAGE = {
  /** Wages / self-employment income into the cash pool. Queue order 0. */
  INCOME:        'INCOME',
  /** Retirement contributions out of it. Queue order 1, after expenses. */
  CONTRIBUTIONS: 'CONTRIBUTIONS',
};

/** Cents, so a rate times a wage cannot leave sub-cent dust in a balance. */
const cents = n => +n.toFixed(2);

/**
 * Does anyone contribute anything, from either the household default or their own
 * election? (design 95 §7.1, phase 1)
 *
 * The toolsets use this to decide whether to schedule `PAYROLL_CONTRIBUTIONS` at
 * all. Before phase 1 the gate read household parameters ONLY, which was correct
 * while the household was the only place an election could live — and became a
 * silent trap the moment `Person` could carry one: set a person's deferral, leave
 * the household default at 0, and no event is scheduled, so the election never
 * reaches anything. The field is written, saved, shown in the UI, and inert.
 *
 * That is the `config-field-in-state-is-not-read` failure mode, and the reason this
 * predicate lives beside the resolver that consumes the same fields rather than
 * being spelled out separately in each toolset.
 *
 * Caps are deliberately NOT gating fields: a cap alone contributes nothing.
 *
 * @param {Array<object>} people   the household
 * @param {object}        params   toolset parameters (household defaults)
 * @param {string[]}      fields   election names that imply a contribution
 */
export function hasPayrollContributions(people, params, fields) {
  const positive = (src) => fields.some(f => (src?.[f] ?? 0) > 0);
  const earning  = (people ?? []).filter(p => (p?.monthlyWage ?? 0) > 0);
  if (earning.length === 0) return false;
  // A household default only counts if SOMEONE can inherit it — a person who has
  // explicitly elected 0 in every gating field is opted out, not merely silent.
  return earning.some(p => positive(p) || fields.some(f => p?.[f] == null && (params?.[f] ?? 0) > 0));
}

/** Gating elections for the US stream. */
export const US_CONTRIBUTION_FIELDS = [
  'k401DeferralPct', 'k401EmployerMatchPct',
  // A non-elective employer contribution happens even when the employee defers
  // nothing, so it must gate scheduling on its own (design 95 §7.2).
  'k401NonElectivePct',
  'iraAnnualContribution', 'rothAnnualContribution',
];

/** Gating elections for the AU stream. */
export const AU_CONTRIBUTION_FIELDS = [
  'superGuaranteePct',
  // Design 95 §9.1 phase 6b. On this list because it is a SCHEDULING gate: a
  // person who elects only a salary sacrifice must still get a
  // PAYROLL_CONTRIBUTIONS event, and P1's defect was exactly an election that
  // scheduled no event and was therefore consumed by nothing.
  'superSalarySacrificePct',
  'superPersonalDeductibleContribution',
  'superNonConcessionalContribution',
];

/**
 * The annual contribution implied by a rate on pay, capped.
 *
 * Carried over verbatim from `retirement-contribution-handler.js`. Phase 3
 * replaces this with the real §402(g) / §415(c) / §401(a)(17) machinery; until
 * then the cap stays a scenario assumption applied to deferral and match
 * separately, which is what the existing goldens encode.
 *
 * @param {number}      annualPay
 * @param {number}      rate       fraction of pay (0.10 = 10%)
 * @param {number|null} cap        annual dollar cap; null ⇒ uncapped
 */
function annualContribution(annualPay, rate, cap) {
  if (!(rate > 0) || !(annualPay > 0)) return 0;
  const raw = annualPay * rate;
  return cap == null ? raw : Math.min(raw, cap);
}

/**
 * Does an election bag express any AU super intent, for this person or as a household
 * default? (design 95 §9.1/§9.2.)
 *
 * The four AU streams and the qualifying-earnings accumulator belong to whichever
 * `PayrollHandler` instance carries the AU elections. An instance configured only with
 * US elections must stay out of the AU pipeline entirely, even though it evaluates it.
 */
function _ownsAuStream(person, au = {}) {
  return (elect(person, 'superGuaranteePct',                   au.guaranteePct ?? 0)                   > 0)
      || (elect(person, 'superSalarySacrificePct',             au.salarySacrificePct ?? 0)             > 0)
      || (elect(person, 'superPersonalDeductibleContribution', au.personalDeductibleContribution ?? 0) > 0)
      || (elect(person, 'superNonConcessionalContribution',    au.nonConcessionalContribution ?? 0)    > 0);
}

/**
 * Is `person` drawing employment income on `date`?
 *
 * The single definition. The three handlers this replaced each had their own
 * copy; they agreed, but nothing made them agree.
 */
function isEarning(person, date) {
  if ((person?.monthlyWage ?? 0) <= 0) return false;
  return person.retirementDate ? date < person.retirementDate : true;
}

/**
 * One payroll election, resolved (design 95 §7.1, phase 1).
 *
 * A person's own election wins; absent one, the household default applies.
 *
 * **`??`, deliberately, not `||`.** `null`/`undefined` on the person means "no
 * preference expressed — inherit"; `0` means "elect nothing" and MUST override a
 * non-zero household default. With `||` a person who had explicitly opted out of
 * the 401(k) would silently re-acquire the household's deferral rate, which is
 * both wrong and invisible: the resulting contribution looks entirely plausible.
 *
 * @param {object} person        the earner
 * @param {string} field         election name, e.g. 'k401DeferralPct'
 * @param {*}      householdValue the toolset-level default
 */
function elect(person, field, householdValue) {
  return person?.[field] ?? householdValue;
}

/**
 * Resolve `personKey`'s account in `role`, or null when they have none.
 *
 * A person with no account in a role simply contributes nothing there — a plan
 * with a Roth and no IRA is ordinary, not an error.
 */
function accountKey(stateRegistry, role, personKey, state) {
  const key = stateRegistry?.getStateKey?.(role, personKey)
           ?? stateRegistry?.getStateKey?.(role);
  return (key != null && state[key] != null) ? key : null;
}

/**
 * Derive the whole payroll picture for one month, for every earning person.
 *
 * Pure: reads `state`, writes nothing, and returns the same result for the same
 * inputs. Iterates `Object.entries(state.people)` so downstream emission order
 * matches the legacy handlers exactly.
 *
 * @param {object} opts
 * @param {Date}   opts.date
 * @param {object} opts.state
 * @param {import('../services/state-registry.js').StateRegistry} opts.stateRegistry
 * @param {object} [opts.us]  US election params (see PayrollHandler)
 * @param {object} [opts.au]  AU election params
 * @returns {{ people: Array<object>, contributionsSuspended: boolean }}
 */
export function computePayroll({ date, state, stateRegistry, us = {}, au = {},
                                withholding = WITHHOLDING_METHOD.NONE }) {
  const people = [];
  // US limits are per TAXABLE YEAR, which for an individual is the calendar year.
  // Taken from the event date rather than from a period record so the pipeline stays
  // a pure function of (date, state) and can be evaluated twice per tick.
  const taxYear = new Date(date).getUTCFullYear();
  // Design 95 §10 phase 9 — cumulative inflation SINCE each country's last published
  // limit year, maintained by InflationAdjustReducer. 1.0 inside the published range,
  // so a run that never passes the horizon reads the transcribed tables exactly.
  const usIndexFactor = state.limitIndexAccumulator?.US ?? 1;
  const auIndexFactor = state.limitIndexAccumulator?.AU ?? 1;

  for (const [personKey, person] of Object.entries(state.people ?? {})) {
    if (!isEarning(person, date)) continue;

    const wage      = person.monthlyWage ?? 0;
    const isAud     = person.wageCurrency === 'AUD';
    const annualPay = wage * 12;

    // ── Stage 4 destination (design 55 §7) ───────────────────────────────────
    // Wages land in the designated transaction account, preferring the earner's
    // own flagged account, then the household's, then the country savings role.
    const country   = isAud ? 'AU' : 'US';
    const role      = isAud ? ACCOUNT_ROLES.AU_SAVINGS : ACCOUNT_ROLES.US_SAVINGS;
    const targetKey = stateRegistry?.resolveTransactionAccountKey?.(country, personKey)
      ?? stateRegistry?.getStateKey?.(role, personKey)
      ?? stateRegistry?.getStateKey?.(role)
      ?? (isAud ? 'auSavingsAccount' : 'usSavingsAccount');

    // Design 69: a self-employed person's monthlyWage is self-employment income,
    // routed through the SE apply path (SECA on the US side) instead of wages.
    const isSelfEmployed = !!person.selfEmployed;
    const applyType = isSelfEmployed
      ? (isAud ? 'SE_INCOME_AU_APPLY' : 'SE_INCOME_US_APPLY')
      : (isAud ? 'AU_WAGES_INCOME_APPLY' : 'WAGES_INCOME_APPLY');

    const entry = {
      personKey, person, wage, isAud, isSelfEmployed, targetKey, applyType,
      label:     isSelfEmployed ? 'Self-Employment' : 'Wages',
      residency: person.residency ?? null,
      // Where the work is actually performed (design 73 Gap 1). Unset ⇒ the earner
      // works where they live, resolved at accrual so it tracks a mid-sim move.
      workCountry: person.workCountry ?? person.residency ?? null,
      k401: null, ira: null, roth: null, super: null,
      // Design 95 §9.1 phase 6b — the three member AU streams.
      sacrifice: null, superDeductible: null, superNonConcessional: null,
      // Phase 7 — the whole capped result, including the clamp names.
      auCaps: null,
      // Whether THIS instance carries the AU elections — see `_ownsAuStream`.
      ownsAuStream: false,
      withholding: 0,
      // Direct deposit (design 95 §6, phase 2). null ⇒ the whole credit lands in
      // targetKey, which is the phase-1 action shape exactly. `splitWage` returns
      // null for every degenerate case — no list, nothing resolvable, or a list that
      // allocates solely to the transaction account anyway — so a scenario without
      // splits emits a byte-identical action.
      //
      splits: null,
    };

    // ── Stage 2: statutory withholding (design 95 §5, phase 5) ───────────────
    // US only. Australia's PAYG is a Div 45 instalment regime this model does not
    // carry, so an AUD wage is still credited gross and settles annually.
    if (!isAud && withholding === WITHHOLDING_METHOD.FICA_ONLY) {
      // The running per-person total is what makes the monthly withholding foot
      // EXACTLY to the annual charge — OASDI stops mid-year at the base for a high
      // earner, and a withholding that kept going would over-withhold and need the
      // refund path phase 5 does not build.
      const ytdWages = state.usSsWagesByPersonYTD?.[personKey] ?? 0;
      entry.withholding = ficaOnWage(wage, ytdWages, taxYear).total;
    }

    // ── Stage 4: split what actually reaches the household ───────────────────
    // NET pay, so a direct-deposit allocation divides money the household really
    // receives rather than a gross figure nobody is ever paid. The tax chain still
    // carries the gross (see `_incomeActions`) — splitting has no tax consequence.
    entry.netPay = cents(Math.max(0, wage - entry.withholding));
    entry.splits = splitWage(entry.netPay, person.wageSplits, targetKey, {
      state, wageCurrency: person.wageCurrency ?? (isAud ? 'AUD' : 'USD'),
      personLabel: person.name || personKey,
    });

    // ── Stage 1/3 contributions ──────────────────────────────────────────────
    // Currency is the gate, and it is not cosmetic: the wage itself is routed by
    // `wageCurrency`, so deferring a slice of an AUD salary into a 401(k) would
    // debit USD that person was never paid.
    // Elections resolve per person, falling back to the household default when the
    // person expresses no preference (design 95 §7.1). A scenario that sets none of
    // them on any Person reproduces the pre-phase-1 household-scalar behaviour
    // exactly, which is what keeps this phase byte-identical.
    if (!isAud) {
      const cap = elect(person, 'k401AnnualCap', us.k401AnnualCap ?? null);
      const k401Key = accountKey(stateRegistry, ACCOUNT_ROLES.K401, personKey, state);
      if (k401Key) {
        // Design 95 §7, phase 3. The tiered match, the §401(a)(17) compensation cap
        // and the §402(g)/§414(v)/§415(c) ceilings, measured against this person's
        // running totals for the tax year.
        const ytd = state.k401ContributionsYTD?.[personKey] ?? {};
        const k = monthlyK401({
          annualPay,
          deferralPct:    elect(person, 'k401DeferralPct',      us.k401DeferralPct      ?? 0),
          matchTiers:     elect(person, 'k401MatchTiers',       us.k401MatchTiers       ?? null),
          legacyMatchPct: elect(person, 'k401EmployerMatchPct', us.k401EmployerMatchPct ?? 0),
          nonElectivePct: elect(person, 'k401NonElectivePct',   us.k401NonElectivePct   ?? 0),
          // Age ATTAINED during the tax year — "attains age 50 before the close of
          // the taxable year" (§414(v)), not age on the contribution date.
          age:            ageAt(person.birthDate, new Date(Date.UTC(taxYear, 11, 31))),
          taxYear,
          indexFactor:    usIndexFactor,
          deferralYTD:    ytd.deferral  ?? 0,
          additionsYTD:   ytd.additions ?? 0,
          scenarioCap:    cap,
        });
        entry.k401 = {
          stateKey: k401Key,
          deferral: k.deferral, match: k.match, nonElective: k.nonElective,
          clamps:   k.clamps,
        };
      }
      const iraKey = accountKey(stateRegistry, ACCOUNT_ROLES.IRA, personKey, state);
      const ira    = cents(
        elect(person, 'iraAnnualContribution', us.iraAnnualContribution ?? 0) / 12);
      if (iraKey && ira > 0) entry.ira = { stateKey: iraKey, amount: ira };

      const rothKey = accountKey(stateRegistry, ACCOUNT_ROLES.ROTH, personKey, state);
      const roth    = cents(
        elect(person, 'rothAnnualContribution', us.rothAnnualContribution ?? 0) / 12);
      if (rothKey && roth > 0) entry.roth = { stateKey: rothKey, amount: roth };
    } else {
      const superKey = stateRegistry?.getStateKey?.(ACCOUNT_ROLES.SUPER, personKey)
                    ?? stateRegistry?.getStateKey?.(ACCOUNT_ROLES.SUPER);
      if (superKey != null && state[superKey] != null) {
        // Does THIS instance own the AU stream? Two `PayrollHandler`s sit on the
        // PAYROLL_CONTRIBUTIONS event — one per country's toolset — and each computes
        // the WHOLE pipeline while carrying only its own country's elections. So the
        // US-configured instance reaches this block for an AUD earner with every AU
        // election at zero, and must contribute nothing at all from it: not a stream,
        // and not the s10A(6) qualifying-earnings accumulator either. Emitting that
        // accumulator from both instances doubled it, which brought the maximum
        // contributions base forward to half the earner's true pay and stopped their
        // SG mid-year with a spurious clamp.
        //
        // Read off the ELECTION BAG rather than off the computed amounts: the
        // accumulator has to keep running in a month where every stream was clamped
        // to nothing, or the base would never be reached at all.
        entry.ownsAuStream = _ownsAuStream(person, au);
        // Design 95 §9.2-9.5 phase 7 — every AU cap, applied in one place.
        //
        // The AU financial year, NOT `taxYear`: the caps are annual figures keyed by
        // FY start, and the US calendar year the rest of this function uses would
        // shift each of them by six months. `monthlyAuSuper` rations the three
        // concessional streams against one pool in the order SG → sacrifice →
        // deductible, truncates qualifying earnings at the s10A(5) base first, and
        // names whatever bound each month.
        const fy = auFinancialYearOf(date);
        const au7 = monthlyAuSuper({
          fyStartYear:     fy,
          monthlyEarnings: wage,
          annualEarnings:  annualPay,
          // EMPLOYEES ONLY, for the same reason sacrifice is (below): the SGAA
          // obliges an EMPLOYER to contribute for an EMPLOYEE, and this model's
          // `selfEmployed` flag means a sole trader routed through the SE income
          // path — someone with no employer to owe it. Leaving it on gave them an
          // employer contribution that never debited anyone's cash, which is money
          // created from nothing. A self-employed person's route into super is
          // s290-150, which stays open to them.
          guaranteePct: isSelfEmployed ? 0
            : elect(person, 'superGuaranteePct', au.guaranteePct ?? 0),
          guaranteeAnnualCap:  elect(person, 'superAnnualCap',    au.annualCap    ?? null),
          // EMPLOYEES ONLY. Sacrifice is a forgone entitlement under an arrangement
          // with an employer; a self-employed person has no employer to arrange it
          // with, and gets the same outcome through s290-150 instead.
          sacrificePct: isSelfEmployed ? 0
            : elect(person, 'superSalarySacrificePct', au.salarySacrificePct ?? 0),
          deductibleAnnual: elect(person, 'superPersonalDeductibleContribution',
                                  au.personalDeductibleContribution ?? 0),
          nonConcessionalAnnual: elect(person, 'superNonConcessionalContribution',
                                       au.nonConcessionalContribution ?? 0),
          caps: state.auSuperCapsByPerson?.[personKey] ?? {},
          // s292-85(3)(c) — the bring-forward is unavailable from the year you turn 75.
          age: ageAt(person.birthDate, new Date(Date.UTC(fy + 1, 5, 30))),
          indexFactor: auIndexFactor,
        });
        // `clamps` rides on every action this month emits, so the journal can say
        // WHICH limit stopped a contribution rather than leaving a smaller number to
        // be inferred (D8). Undefined when nothing bound, so an unclamped scenario
        // emits the phase-6b action shape unchanged.
        const clamped = au7.clamps.length ? { clamps: au7.clamps } : {};
        entry.auCaps = au7;

        if (au7.sg > 0) entry.super = { stateKey: superKey, amount: au7.sg, ...clamped };
        if (au7.sacrifice > 0) {
          entry.sacrifice = { stateKey: superKey, amount: au7.sacrifice, ...clamped };
        }
        if (au7.deductible > 0) {
          entry.superDeductible = { stateKey: superKey, amount: au7.deductible, ...clamped };
        }
        if (au7.nonConcessional > 0) {
          entry.superNonConcessional = {
            stateKey: superKey, amount: au7.nonConcessional, ...clamped };
        }
      }
    }

    // ── Stage 1 applied: sacrifice reduces the wage itself ──────────────────
    //
    // Done AFTER the contribution block so the SG above reads pre-sacrifice pay
    // (s10A(1)(h)). Withholding and the split have ALREADY run above, on the
    // pre-sacrifice wage, which is why both are recomputed here rather than merely
    // ordered around — everything downstream (assessable income, PAYG, and the cash
    // that reaches the household) must see the reduced figure. Harmless today only
    // because withholding is US-only and sacrifice AU-only; whoever wires AU PAYG
    // needs the recompute, not the ordering. The pre-sacrifice figure rides on the
    // apply action as `sacrificed`, so the journal can explain a wage that
    // dropped instead of just showing a smaller number (the P5 `alreadyNetted`
    // lesson: a payload that moves money has to be able to say why).
    if (entry.sacrifice) {
      entry.wage      = cents(entry.wage - entry.sacrifice.amount);
      entry.netPay    = cents(Math.max(0, entry.wage - entry.withholding));
      entry.splits    = splitWage(entry.netPay, person.wageSplits, targetKey, {
        state, wageCurrency: person.wageCurrency ?? 'AUD',
        personLabel: person.name || personKey,
      });
    }

    people.push(entry);
  }

  return { people, contributionsSuspended: !!state?.contributionsSuspended };
}

/**
 * Handles `PAYROLL` (stage INCOME) and `PAYROLL_CONTRIBUTIONS` (stage
 * CONTRIBUTIONS) — the same handler class, wired to two events at two queue
 * orders. See the file header for why the split is necessary.
 *
 * @param {object}  opts
 * @param {import('../services/state-registry.js').StateRegistry} opts.stateRegistry
 * @param {string}  [opts.stage=INCOME]
 * @param {number}  [opts.k401DeferralPct=0]      employee deferral, fraction of annual pay
 * @param {number}  [opts.k401EmployerMatchPct=0] employer match, fraction of annual pay
 * @param {?number} [opts.k401AnnualCap=null]     annual cap, applied to each separately
 * @param {number}  [opts.iraAnnualContribution=0]
 * @param {number}  [opts.rothAnnualContribution=0]
 * @param {number}  [opts.superGuaranteePct=0]    AU SG, fraction of annual pay
 * @param {?number} [opts.superAnnualCap=null]
 * @param {number}  [opts.salarySacrificePct=0]             pre-tax sacrifice, fraction of annual pay
 * @param {number}  [opts.personalDeductibleContribution=0] s290-150, annual AUD
 * @param {number}  [opts.nonConcessionalContribution=0]    Div 292 stream, annual AUD
 */
export class PayrollHandler extends HandlerEntry {
  static description = 'Derives the whole month\'s payroll once — who is earning, where their pay lands, and what is diverted from it — and emits either the income slice (stage INCOME, queue order 0) or the retirement-contribution slice (stage CONTRIBUTIONS, queue order 1, after expenses).';
  static type        = 'PayrollHandler';
  static eventType   = 'PAYROLL';

  constructor({
    stateRegistry,
    stage                  = PAYROLL_STAGE.INCOME,
    withholding            = WITHHOLDING_METHOD.NONE,
    k401DeferralPct        = 0,
    k401EmployerMatchPct   = 0,
    k401MatchTiers         = null,
    k401NonElectivePct     = 0,
    k401AnnualCap          = null,
    iraAnnualContribution  = 0,
    rothAnnualContribution = 0,
    superGuaranteePct      = 0,
    superAnnualCap         = null,
    // Design 95 §9.1 phase 6b — the member's own AU streams, as household defaults.
    salarySacrificePct             = 0,
    personalDeductibleContribution = 0,
    nonConcessionalContribution    = 0,
  } = {}) {
    super(null, stage === PAYROLL_STAGE.CONTRIBUTIONS
      ? 'Payroll Contributions' : 'Payroll');
    this.stateRegistry          = stateRegistry;
    this.stage                  = stage;
    this.withholding            = withholding;
    this.k401DeferralPct        = k401DeferralPct;
    this.k401EmployerMatchPct   = k401EmployerMatchPct;
    this.k401MatchTiers         = k401MatchTiers;
    this.k401NonElectivePct     = k401NonElectivePct;
    this.k401AnnualCap          = k401AnnualCap;
    this.iraAnnualContribution  = iraAnnualContribution;
    this.rothAnnualContribution = rothAnnualContribution;
    this.superGuaranteePct      = superGuaranteePct;
    this.superAnnualCap         = superAnnualCap;
    this.salarySacrificePct             = salarySacrificePct;
    this.personalDeductibleContribution = personalDeductibleContribution;
    this.nonConcessionalContribution    = nonConcessionalContribution;
    this.generatedActionTypes   = stage === PAYROLL_STAGE.CONTRIBUTIONS
      ? ['K401_CONTRIBUTION_APPLY', 'IRA_CONTRIBUTION_APPLY', 'ROTH_CONTRIBUTION_APPLY',
         'SUPER_CONTRIBUTION_APPLY', 'SUPER_SACRIFICE_APPLY',
         'SUPER_NON_CONCESSIONAL_APPLY', 'AU_QUALIFYING_EARNINGS_APPLY',
         'RECORD_BALANCE']
      : ['WAGES_INCOME_APPLY', 'AU_WAGES_INCOME_APPLY', 'SE_INCOME_US_APPLY',
         'SE_INCOME_AU_APPLY', 'WAGES_WITHHELD_APPLY', 'RECORD_FIELD_VALUE',
         'RECORD_BALANCE'];
  }

  static fromJSON(d, { stateRegistry }) {
    const h = new this({
      stateRegistry,
      stage:                  d.stage                  ?? PAYROLL_STAGE.INCOME,
      withholding:            d.withholding            ?? WITHHOLDING_METHOD.NONE,
      k401DeferralPct:        d.k401DeferralPct        ?? 0,
      k401EmployerMatchPct:   d.k401EmployerMatchPct   ?? 0,
      k401MatchTiers:         d.k401MatchTiers         ?? null,
      k401NonElectivePct:     d.k401NonElectivePct     ?? 0,
      k401AnnualCap:          d.k401AnnualCap          ?? null,
      iraAnnualContribution:  d.iraAnnualContribution  ?? 0,
      rothAnnualContribution: d.rothAnnualContribution ?? 0,
      superGuaranteePct:      d.superGuaranteePct      ?? 0,
      superAnnualCap:         d.superAnnualCap         ?? null,
      salarySacrificePct:             d.salarySacrificePct             ?? 0,
      personalDeductibleContribution: d.personalDeductibleContribution ?? 0,
      nonConcessionalContribution:    d.nonConcessionalContribution    ?? 0,
    });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      stage:                  this.stage,
      withholding:            this.withholding,
      k401DeferralPct:        this.k401DeferralPct,
      k401EmployerMatchPct:   this.k401EmployerMatchPct,
      k401MatchTiers:         this.k401MatchTiers,
      k401NonElectivePct:     this.k401NonElectivePct,
      k401AnnualCap:          this.k401AnnualCap,
      iraAnnualContribution:  this.iraAnnualContribution,
      rothAnnualContribution: this.rothAnnualContribution,
      superGuaranteePct:      this.superGuaranteePct,
      superAnnualCap:         this.superAnnualCap,
      salarySacrificePct:             this.salarySacrificePct,
      personalDeductibleContribution: this.personalDeductibleContribution,
      nonConcessionalContribution:    this.nonConcessionalContribution,
    };
  }

  /** The computed pipeline for this tick. */
  _pipeline(date, state) {
    return computePayroll({
      date, state, stateRegistry: this.stateRegistry,
      us: {
        k401DeferralPct:        this.k401DeferralPct,
        k401EmployerMatchPct:   this.k401EmployerMatchPct,
        k401MatchTiers:         this.k401MatchTiers,
        k401NonElectivePct:     this.k401NonElectivePct,
        k401AnnualCap:          this.k401AnnualCap,
        iraAnnualContribution:  this.iraAnnualContribution,
        rothAnnualContribution: this.rothAnnualContribution,
      },
      au: { guaranteePct: this.superGuaranteePct, annualCap: this.superAnnualCap,
            salarySacrificePct:             this.salarySacrificePct,
            personalDeductibleContribution: this.personalDeductibleContribution,
            nonConcessionalContribution:    this.nonConcessionalContribution },
      withholding: this.withholding,
    });
  }

  call({ date, state }) {
    const pipeline = this._pipeline(date, state);
    return this.stage === PAYROLL_STAGE.CONTRIBUTIONS
      ? this._contributionActions(pipeline)
      : this._incomeActions(pipeline);
  }

  /**
   * Stage INCOME — the wage credits.
   *
   * Emission order, carried over from `MonthlyWagesHandler`: per person an apply
   * then a field-value record, and only afterwards one RECORD_BALANCE per
   * DISTINCT touched cash pool. Two earners sharing a transaction account
   * produce one balance record, not two.
   */
  _incomeActions({ people }) {
    const actions = [];
    const touched = new Set();

    for (const e of people) {
      // `amount` stays the GROSS wage on the action whether or not it is split —
      // the tax chain reads it, and splitting has no tax consequence (design 95 §6.3).
      // `splits` is omitted entirely when absent so the action shape, and therefore
      // every saved scenario and golden, is unchanged.
      const apply = { type: e.applyType, amount: e.wage, residency: e.residency,
                      personKey: e.personKey, targetKey: e.targetKey,
                      workCountry: e.workCountry };
      if (e.splits) apply.splits = e.splits;
      // Design 95 §9.1 phase 6b — how much of the package was diverted to super
      // before this wage existed. `amount` is ALREADY net of it (unlike the US
      // withholding below, which nets the cash but not the assessable figure),
      // because sacrifice reduces assessable income as well as cash. Stamped only
      // when non-zero, so a scenario that sacrifices nothing keeps the phase-5
      // action shape exactly.
      if (e.sacrifice) apply.sacrificed = e.sacrifice.amount;
      // `amount` is the GROSS wage — the tax chain reads it, and neither withholding
      // nor splitting changes what is assessable. `netAmount` is what actually
      // reaches the household's accounts. Stamped only when they differ, so an
      // un-withheld scenario emits the phase-4 action shape unchanged.
      if (e.withholding > 0) apply.netAmount = e.netPay;
      actions.push(
        apply,
        new FieldValueAction(`wages_${e.personKey}`,
          `${e.person.name || e.personKey} ${e.label}`, e.wage),
      );
      // One RECORD_BALANCE per DISTINCT account actually credited — a split that
      // names the same account twice, or two earners sharing one, records it once.
      // The withheld amount never entered the household's cash, so this action is
      // BOOKKEEPING: `alreadyNetted` tells the reducer to accumulate `usWithheldYTD`
      // without debiting anything. Debiting would take the money twice — once by
      // never crediting it, once again here.
      if (e.withholding > 0) {
        actions.push({ type: 'WAGES_WITHHELD_APPLY', amount: e.withholding,
                       personKey: e.personKey, alreadyNetted: true });
      }
      if (e.splits) for (const sp of e.splits) touched.add(sp.targetKey);
      else                                     touched.add(e.targetKey);
    }

    for (const cashKey of touched) {
      actions.push(new RecordBalanceAction(`${cashKey}.balance`, cashKey));
    }
    return actions;
  }

  /**
   * Stage CONTRIBUTIONS — what payroll diverts.
   *
   * `employerFunded` is the load-bearing field. An employer match and the AU
   * Super Guarantee never passed through the member's paycheque: they must not
   * debit their cash pool and are not their deduction. Modelled as a member
   * contribution, an SG dollar would be taxed at the member's marginal rate AND
   * at the fund's 15% Div 295 rate.
   */
  _contributionActions({ people, contributionsSuspended }) {
    if (contributionsSuspended) return [];
    const actions = [];

    for (const e of people) {
      if (e.k401) {
        const { stateKey, deferral, match, nonElective, clamps } = e.k401;
        // Separate actions rather than one summed contribution: they differ in who
        // paid and in whether the amount is deductible, and the journal has to be
        // able to say which is which.
        //
        // `personKey` (phase 3) is what lets the reducer accumulate this person's
        // running totals — §402(g) is a per-INDIVIDUAL limit across all their plans,
        // so a household-level total would be the wrong quantity entirely.
        //
        // `clamps` names the limits that bound this month, so a contribution that
        // stopped in September reads as "§402(g)" in the journal instead of as an
        // unexplained smaller number (design 95 D8).
        const clamped = clamps?.length ? { clamps } : {};
        if (deferral > 0) {
          actions.push({ type: 'K401_CONTRIBUTION_APPLY', amount: deferral, stateKey,
                         personKey: e.personKey, ...clamped });
        }
        if (match > 0) {
          actions.push({ type: 'K401_CONTRIBUTION_APPLY', amount: match, stateKey,
                         personKey: e.personKey, employerFunded: true, ...clamped });
        }
        // A non-elective employer contribution is NOT a match — it does not depend on
        // the employee deferring anything — but it is employer money on the same
        // terms: no cash debit, no deduction, and it counts to §415(c).
        if (nonElective > 0) {
          actions.push({ type: 'K401_CONTRIBUTION_APPLY', amount: nonElective, stateKey,
                         personKey: e.personKey, employerFunded: true,
                         nonElective: true, ...clamped });
        }
        if (deferral > 0 || match > 0 || nonElective > 0) {
          actions.push(new RecordBalanceAction(`${stateKey}.balance`, stateKey));
        }
      }
      if (e.ira) {
        actions.push({ type: 'IRA_CONTRIBUTION_APPLY', amount: e.ira.amount,
                       stateKey: e.ira.stateKey });
        actions.push(new RecordBalanceAction(`${e.ira.stateKey}.balance`, e.ira.stateKey));
      }
      if (e.roth) {
        actions.push({ type: 'ROTH_CONTRIBUTION_APPLY', amount: e.roth.amount,
                       stateKey: e.roth.stateKey });
        actions.push(new RecordBalanceAction(`${e.roth.stateKey}.balance`, e.roth.stateKey));
      }
      // ── The four AU super streams (design 95 §9.1) ────────────────────────
      //
      // Four actions, not one summed contribution, and the reason is the same as
      // for the 401(k) trio above only sharper: these differ in whether cash moves,
      // whether the fund takes 15% on the way in, and whether the member gets a
      // deduction — three independent axes. A single action with the amounts added
      // together could not be taxed correctly by any reducer, and a `stream` field
      // on one action type would be invisible to every report that groups by action
      // type. `downsizer-contribution.js` set the precedent: a contribution whose
      // tax mechanics differ gets its own action rather than reusing one that looks
      // close enough.
      //
      // Order is deliberate — employer money, then pre-tax, then the two paid out of
      // the member's own cash. It is also the order of increasing cash impact, so a
      // month that runs the pool dry fails on the discretionary stream last.
      // `clamps` (design 95 D8, phase 7) names whichever cap bound this month, and
      // rides on every stream the month emitted — the caps ration ONE pool between
      // them, so "Div 291 stopped you in March" is a fact about the month, not about
      // whichever stream happened to give way. Omitted entirely when nothing bound.
      const auClamped = {
        ...(e.auCaps?.clamps?.length     ? { clamps: e.auCaps.clamps }             : {}),
        // Relief, not restriction — see `monthlyAuSuper`. Stamped so a year that
        // contributed more than the basic cap can say WHY it was allowed to.
        ...(e.auCaps?.carriedForward > 0 ? { carriedForward: e.auCaps.carriedForward } : {}),
      };

      const superStreams = [];
      if (e.super) {
        superStreams.push({ type: 'SUPER_CONTRIBUTION_APPLY', amount: e.super.amount,
                            stateKey: e.super.stateKey, employerFunded: true,
                            personKey: e.personKey, ...auClamped });
      }
      if (e.sacrifice) {
        // No cash debit and no §988 disposal: the money was never the member's to
        // dispose of. Div 295 applies, so the reducer chains SUPER_CONTRIBUTION_TAX
        // exactly as the SG does.
        superStreams.push({ type: 'SUPER_SACRIFICE_APPLY', amount: e.sacrifice.amount,
                            stateKey: e.sacrifice.stateKey, personKey: e.personKey,
                            ...auClamped });
      }
      if (e.superDeductible) {
        // The pre-existing member-contribution path — gross out of AU cash, net of
        // Div 295 into the fund — plus the s290-150 deduction leg, which is what
        // `deductible` turns on. Without it this is an after-tax contribution that
        // pays the 15% and gets nothing back, i.e. the worst of both streams.
        superStreams.push({ type: 'SUPER_CONTRIBUTION_APPLY',
                            amount: e.superDeductible.amount,
                            stateKey: e.superDeductible.stateKey,
                            personKey: e.personKey, deductible: true, ...auClamped });
      }
      if (e.superNonConcessional) {
        superStreams.push({ type: 'SUPER_NON_CONCESSIONAL_APPLY',
                            amount: e.superNonConcessional.amount,
                            stateKey: e.superNonConcessional.stateKey,
                            personKey: e.personKey, ...auClamped });
      }
      // Design 95 §9.2 phase 7 — the qualifying earnings this month, AFTER the
      // s10A(5) truncation. Emitted whenever the person earned anything, even when
      // every stream was clamped to nothing: the accumulator has to keep running or
      // the base would never be reached and the SG would never stop. This is also
      // the D9 seam — a second employer becomes a second action with its own key,
      // not a rewrite of the accumulator.
      if (e.ownsAuStream && e.auCaps && e.auCaps.countableEarnings > 0) {
        superStreams.push({ type: 'AU_QUALIFYING_EARNINGS_APPLY',
                            amount: e.auCaps.countableEarnings,
                            personKey: e.personKey, ...auClamped });
      }
      if (superStreams.length > 0) {
        actions.push(...superStreams);
        // One record per DISTINCT fund, matching the 401(k) block: four streams into
        // one account are one balance record, not four.
        for (const key of new Set(superStreams.map(a => a.stateKey).filter(Boolean))) {
          actions.push(new RecordBalanceAction(`${key}.balance`, key));
        }
      }
    }
    return actions;
  }
}
