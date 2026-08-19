/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HandlerEntry }        from '../../simulation-framework/handlers.js';
import { RecordBalanceAction } from '../../simulation-framework/actions.js';
import { ACCOUNT_ROLES }       from '../state/account-roles.js';

/**
 * retirement-contribution-handler.js — payroll contributions during working life.
 *
 * ─── why this exists ─────────────────────────────────────────────────────────
 *
 * The contribution machinery (K401/IRA/Roth/Super contribution handlers, apply
 * reducers and their tax classifiers) has been complete and unreachable: no toolset
 * ever scheduled a contribution event, so `K401_CONTRIBUTION_APPLY` and its five
 * siblings sat in the golden coverage manifest's KNOWN_GAPS with the note "the
 * reference golden accumulates but barely decumulates". The pre-existing handlers
 * take a FIXED `data.amount` baked into a one-off event and ignore the earner's
 * retirement date, which is fine for hand-authored events in the ConfigBuilder and
 * useless for "a 45-year-old defers 10% of pay until 65".
 *
 * So these two handlers are the payroll counterpart of `MonthlyWagesHandler`: they
 * iterate `state.people`, contribute for anyone still earning, and stop the month a
 * person retires — from the same wage figure and the same retirement date the wage
 * credit itself reads, so a contribution can never outlive the salary funding it.
 *
 * ─── employer money is not the employee's money ──────────────────────────────
 *
 * `employerFunded` on a contribution action means the employer paid it: it never
 * debits the member's cash pool and it is not the member's deduction. Two cases
 * need it and both would be wrong without it:
 *
 *   - a 401(k) employer MATCH — money that never passed through the paycheque, so
 *     debiting checking would charge the household for it twice and deducting it
 *     would hand them relief on income they never had; and
 *   - Australian Super Guarantee — an employer charge on top of the quoted salary
 *     that never enters the member's assessable income. Modelled as a cash debit it
 *     would be taxed at the member's marginal rate AND at the fund's 15% Div 295
 *     rate, taxing the same dollar twice.
 *
 * The employee's own 401(k) deferral is the opposite case and keeps the existing
 * behaviour exactly: it leaves the cash pool (the wage was credited gross) and
 * chains `K401_CONTRIBUTION_TAX`, the pre-tax deduction.
 *
 * ─── annual figures, monthly instalments ─────────────────────────────────────
 *
 * Percentages are of ANNUAL pay and caps are annual, but the events fire monthly,
 * so each month contributes a twelfth of the capped annual figure. Deriving the
 * instalment from the annual number rather than accumulating a year-to-date total
 * keeps the cap exact without a YTD accumulator in state — one less field that
 * could survive a rewind or a branch in a stale condition.
 *
 * Contributions are scheduled at `order(1)`, i.e. after wages AND expenses (both
 * order 0) on the same month-end date. Later is the safe side: a contribution that
 * runs before the month's spending can overdraw the cash pool and escalate into the
 * drawdown cascade, selling assets to fund a deferral.
 */

/** Cents, so a rate times a wage cannot leave sub-cent dust in an account balance. */
const cents = n => +n.toFixed(2);

/**
 * The annual contribution implied by a rate on pay, capped.
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
 * Everyone in state.people who is still drawing the wage this contribution rides on,
 * paid in `currency`.
 *
 * The currency filter is not cosmetic: `MonthlyWagesHandler` routes the wage itself
 * by `wageCurrency`, so an AUD-paid person's salary never reaches the US cash pool.
 * Deferring a slice of it into a 401(k) would debit USD that person was never paid.
 */
function* earners(state, date, currency) {
  for (const [key, person] of Object.entries(state.people ?? {})) {
    const wage = person?.monthlyWage ?? 0;
    if (wage <= 0) continue;
    if ((person.wageCurrency ?? 'USD') !== currency) continue;
    if (person.retirementDate && date >= person.retirementDate) continue;
    yield [key, person, wage];
  }
}

/**
 * Handles US_RETIREMENT_CONTRIBUTION — monthly 401(k) deferral, employer match, and
 * IRA / Roth contributions for every employed person.
 *
 * Account routing is by ROLE + owner (design 53's tier-1 wiring), so a household
 * with two 401(k)s credits each person's own. A person with no account in a given
 * role simply contributes nothing there — a scenario with a Roth and no IRA is
 * ordinary, not an error.
 *
 * @param {object}  opts
 * @param {import('../services/state-registry.js').StateRegistry} opts.stateRegistry
 * @param {number}  [opts.k401DeferralPct=0]     employee deferral, fraction of annual pay
 * @param {number}  [opts.k401EmployerMatchPct=0] employer match, fraction of annual pay
 * @param {?number} [opts.k401AnnualCap=null]     annual cap applied to deferral and match separately
 * @param {number}  [opts.iraAnnualContribution=0]
 * @param {number}  [opts.rothAnnualContribution=0]
 */
export class UsRetirementContributionHandler extends HandlerEntry {
  static description = 'Contributes each employed person\'s monthly 401(k) deferral (pre-tax, from cash), the employer match (employer-funded), and their IRA / Roth contributions; stops at their retirementDate.';
  static type        = 'UsRetirementContributionHandler';
  static eventType   = 'US_RETIREMENT_CONTRIBUTION';

  constructor({
    stateRegistry,
    k401DeferralPct        = 0,
    k401EmployerMatchPct   = 0,
    k401AnnualCap          = null,
    iraAnnualContribution  = 0,
    rothAnnualContribution = 0,
  } = {}) {
    super(null, 'US Retirement Contributions');
    this.stateRegistry          = stateRegistry;
    this.k401DeferralPct        = k401DeferralPct;
    this.k401EmployerMatchPct   = k401EmployerMatchPct;
    this.k401AnnualCap          = k401AnnualCap;
    this.iraAnnualContribution  = iraAnnualContribution;
    this.rothAnnualContribution = rothAnnualContribution;
    this.generatedActionTypes   = [
      'K401_CONTRIBUTION_APPLY', 'IRA_CONTRIBUTION_APPLY', 'ROTH_CONTRIBUTION_APPLY',
      'RECORD_BALANCE',
    ];
  }

  static fromJSON(d, { stateRegistry }) {
    const h = new this({
      stateRegistry,
      k401DeferralPct:        d.k401DeferralPct        ?? 0,
      k401EmployerMatchPct:   d.k401EmployerMatchPct   ?? 0,
      k401AnnualCap:          d.k401AnnualCap          ?? null,
      iraAnnualContribution:  d.iraAnnualContribution  ?? 0,
      rothAnnualContribution: d.rothAnnualContribution ?? 0,
    });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      k401DeferralPct:        this.k401DeferralPct,
      k401EmployerMatchPct:   this.k401EmployerMatchPct,
      k401AnnualCap:          this.k401AnnualCap,
      iraAnnualContribution:  this.iraAnnualContribution,
      rothAnnualContribution: this.rothAnnualContribution,
    };
  }

  /** The state key of `personKey`'s account in `role`, or null when they have none. */
  _accountKey(role, personKey, state) {
    const key = this.stateRegistry?.getStateKey?.(role, personKey)
             ?? this.stateRegistry?.getStateKey?.(role);
    return (key != null && state[key] != null) ? key : null;
  }

  call({ date, state }) {
    if (state?.contributionsSuspended) return [];
    const actions = [];

    for (const [personKey, , wage] of earners(state, date, 'USD')) {
      const annualPay = wage * 12;

      const k401Key = this._accountKey(ACCOUNT_ROLES.K401, personKey, state);
      if (k401Key) {
        const deferral = cents(
          annualContribution(annualPay, this.k401DeferralPct, this.k401AnnualCap) / 12);
        const match = cents(
          annualContribution(annualPay, this.k401EmployerMatchPct, this.k401AnnualCap) / 12);
        // Two separate actions rather than one summed contribution: they differ in
        // who paid and in whether the amount is deductible, and the journal has to
        // be able to say which is which.
        if (deferral > 0) {
          actions.push({ type: 'K401_CONTRIBUTION_APPLY', amount: deferral, stateKey: k401Key });
        }
        if (match > 0) {
          actions.push({ type: 'K401_CONTRIBUTION_APPLY', amount: match, stateKey: k401Key,
                         employerFunded: true });
        }
        if (deferral > 0 || match > 0) {
          actions.push(new RecordBalanceAction(`${k401Key}.balance`, k401Key));
        }
      }

      const iraKey = this._accountKey(ACCOUNT_ROLES.IRA, personKey, state);
      const ira    = cents((this.iraAnnualContribution ?? 0) / 12);
      if (iraKey && ira > 0) {
        actions.push({ type: 'IRA_CONTRIBUTION_APPLY', amount: ira, stateKey: iraKey });
        actions.push(new RecordBalanceAction(`${iraKey}.balance`, iraKey));
      }

      const rothKey = this._accountKey(ACCOUNT_ROLES.ROTH, personKey, state);
      const roth    = cents((this.rothAnnualContribution ?? 0) / 12);
      if (rothKey && roth > 0) {
        actions.push({ type: 'ROTH_CONTRIBUTION_APPLY', amount: roth, stateKey: rothKey });
        actions.push(new RecordBalanceAction(`${rothKey}.balance`, rothKey));
      }
    }

    return actions;
  }
}

/**
 * Handles AU_SUPER_GUARANTEE — the employer's compulsory Superannuation Guarantee
 * contribution for every employed person, at `guaranteePct` of ordinary earnings.
 *
 * Always `employerFunded`: the SG is an employer charge on top of the quoted salary,
 * outside the member's assessable income. The fund still pays contributions tax on
 * it, which `SuperContributionApplyReducer` withholds and `SUPER_CONTRIBUTION_TAX`
 * attributes to the member.
 *
 * The rate is a parameter and NOT a rate transcribed from an authority — the
 * legislated SG percentage is a schedule that steps by financial year, and this
 * model has no such schedule on disk. A scenario states the rate it assumes.
 *
 * @param {object}  opts
 * @param {import('../services/state-registry.js').StateRegistry} opts.stateRegistry
 * @param {number}  [opts.guaranteePct=0]  fraction of annual pay
 * @param {?number} [opts.annualCap=null]  annual dollar cap; null ⇒ uncapped
 */
export class AuSuperGuaranteeHandler extends HandlerEntry {
  static description = 'Contributes each employed person\'s employer Superannuation Guarantee to their super account (employer-funded, never debits member cash); stops at their retirementDate.';
  static type        = 'AuSuperGuaranteeHandler';
  static eventType   = 'AU_SUPER_GUARANTEE';

  constructor({ stateRegistry, guaranteePct = 0, annualCap = null } = {}) {
    super(null, 'AU Super Guarantee');
    this.stateRegistry        = stateRegistry;
    this.guaranteePct         = guaranteePct;
    this.annualCap            = annualCap;
    this.generatedActionTypes = ['SUPER_CONTRIBUTION_APPLY', 'RECORD_BALANCE'];
  }

  static fromJSON(d, { stateRegistry }) {
    const h = new this({
      stateRegistry,
      guaranteePct: d.guaranteePct ?? 0,
      annualCap:    d.annualCap    ?? null,
    });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return { ...super.toJSON(), guaranteePct: this.guaranteePct, annualCap: this.annualCap };
  }

  call({ date, state }) {
    if (state?.contributionsSuspended) return [];
    const actions = [];

    for (const [personKey, , wage] of earners(state, date, 'AUD')) {
      const superKey = this.stateRegistry?.getStateKey?.(ACCOUNT_ROLES.SUPER, personKey)
                    ?? this.stateRegistry?.getStateKey?.(ACCOUNT_ROLES.SUPER);
      if (superKey == null || state[superKey] == null) continue;

      const amount = cents(
        annualContribution(wage * 12, this.guaranteePct, this.annualCap) / 12);
      if (amount <= 0) continue;

      actions.push({ type: 'SUPER_CONTRIBUTION_APPLY', amount, stateKey: superKey,
                     employerFunded: true });
      actions.push(new RecordBalanceAction(`${superKey}.balance`, superKey));
    }

    return actions;
  }
}
