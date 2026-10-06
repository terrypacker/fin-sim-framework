/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * msbs-classes.js — the preserved MSBS employer benefit through the run, before the
 * election (design 119 §6.4, phase 4). The rules are in `msbs.js`.
 *
 *   - `MsbsFundedEarningsHandler` + `MsbsFundedEarningsApplyReducer`: the funded part earns
 *     the Balanced option's return once a year, on the same year-end event as the member's
 *     fund, so the two sleeves move on the same dates.
 *   - `MsbsUnfundedIndexReducer`: on the AU period advance (1 July, r 61D(b)), the unfunded
 *     part rises by CPI on the never-falls rule (r 61A). It runs after the inflation
 *     reducer, so it reads the year's new CPI level.
 *
 * Both stop at the election. From then (phase 5):
 *
 *   - `MsbsPensionHandler`, monthly: at the first month-end on or after the election it
 *     emits MSBS_ELECTION_APPLY (`MsbsElectionApplyReducer`), and each month after it the
 *     pension payment, MSBS_PENSION_APPLY (`MsbsPensionApplyReducer`). When the pensioner
 *     has died it emits MSBS_PENSION_REVERT (`MsbsPensionRevertReducer`) first.
 *   - `MsbsUnfundedIndexReducer` also raises a paid pension each 1 July (r 56, r 58).
 */

import { HandlerEntry } from '../../../simulation-framework/handlers.js';
import { Reducer, AccountServiceReducer, PRIORITY } from '../../../simulation-framework/reducers.js';
import { isMsbs, msbsElectionMs, fundedSleeveReturn, indexUnfundedBenefit,
  MSBS_DEFAULT_FUNDED_ALLOCATION, msbsElection, partYearIncrease, msbsPensionIncrease,
  pensionPaymentTax, lumpSumTax, MSBS_SPOUSE_SHARE, MSBS_FULL_RATE_PAYMENTS } from './msbs.js';
import { superMemberKey, auSuperReleaseMs, preservationAge } from './super-release.js';
import { auSuperKeyFor } from './super-fund-key.js';
import { resolveCashKey } from '../cash-routing.js';
import { SUPER_TAX_RATE } from '../../tax/au/super-tax-rate.js';

/** Whole months from `fromMs` to `toMs`, a part month of half or more counting (r 58(5)). */
function monthsBetween(fromMs, toMs) {
  const a = new Date(fromMs), b = new Date(toMs);
  let m = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() - a.getUTCDate() < -14) m -= 1;
  return Math.max(0, m);
}

/** Is the benefit still preserved on `date` (no election yet)? */
function preservedOn(state, account, date) {
  const key = superMemberKey(state, account?.ownerId ?? null);
  const election = msbsElectionMs(account, key != null ? state.people[key]?.birthDate : null);
  return election == null || +date < election;
}

export class MsbsFundedEarningsHandler extends HandlerEntry {
  static type        = 'MsbsFundedEarningsHandler';
  static description = 'Grows a preserved MSBS funded employer benefit by a year of the Balanced option\'s return, net of the fund\'s 15% on income, and emits MSBS_FUNDED_EARNINGS_APPLY.';
  static eventType   = 'INTL_SUPER_EARNINGS';

  constructor({ stateKey = null } = {}) {
    super(null, 'MSBS Funded Earnings');
    this.stateKey = stateKey;
    this.generatedActionTypes = ['MSBS_FUNDED_EARNINGS_APPLY'];
  }

  static fromJSON(d) {
    const h = new this({ stateKey: d.stateKey ?? null });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return { ...super.toJSON(), stateKey: this.stateKey };
  }

  call({ state, date }) {
    const a  = state?.[this.stateKey];
    const eb = a?.employerBenefit;
    if (!isMsbs(a) || !eb || !(eb.funded > 0) || !preservedOn(state, a, date)) return [];
    const rate   = fundedSleeveReturn(state, eb.fundedAllocation ?? MSBS_DEFAULT_FUNDED_ALLOCATION);
    const amount = +(eb.funded * rate).toFixed(2);
    return amount === 0 ? [] : [{ type: 'MSBS_FUNDED_EARNINGS_APPLY', stateKey: this.stateKey, amount, rate }];
  }
}

export class MsbsFundedEarningsApplyReducer extends Reducer {
  static type        = 'MsbsFundedEarningsApplyReducer';
  static description = 'Credits a year\'s net return to a preserved MSBS funded employer benefit (never below zero).';
  static actionType  = 'MSBS_FUNDED_EARNINGS_APPLY';

  constructor() {
    super('MSBS Funded Earnings Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes = ['MSBS_FUNDED_EARNINGS_APPLY'];
  }

  reduce(state, action) {
    const a = state[action.stateKey];
    if (!a?.employerBenefit) return this.newState(state);
    const funded = Math.max(0, +(a.employerBenefit.funded + action.amount).toFixed(2));
    return this.newState(state, {
      [action.stateKey]: { ...a, employerBenefit: { ...a.employerBenefit, funded } },
    });
  }
}

export class MsbsUnfundedIndexReducer extends Reducer {
  static type        = 'MsbsUnfundedIndexReducer';
  static description = 'On each AU period advance (1 July), raises every preserved MSBS unfunded employer benefit, and every MSBS pension in payment, by the rise in AU CPI over its highest earlier level, rounded to 0.1% (MSBS Rules r 56, 58, 61A, 61E(3)).';
  static actionType  = null;

  constructor() {
    // After InflationAdjustReducer (PRE_PROCESS + 2), which advances `cpiAccumulator`.
    super('MSBS Unfunded Index', PRIORITY.PRE_PROCESS + 3);
    this.reducedActionTypes = ['AU_PERIOD_ADVANCE'];
  }

  reduce(state, action, date) {
    const cpiNow = state.cpiAccumulator?.AU;
    if (!(cpiNow > 0)) return this.newState(state);
    const patch = {};
    for (const [key, a] of Object.entries(state)) {
      const eb = a?.employerBenefit;
      if (!isMsbs(a) || !eb) continue;
      if (a.pension?.annual > 0) {
        // r 56, once a year; r 58's share for a pension under a year old.
        const p = a.pension;
        const months = monthsBetween(p.startMs, +date);
        const next = msbsPensionIncrease(p.annual, cpiNow, p.cpiPeak ?? 1, months < 12 ? months : null);
        const reversion = p.reversionAnnual != null
          ? msbsPensionIncrease(p.reversionAnnual, cpiNow, p.cpiPeak ?? 1).annual : null;
        if (next.cpiPeak !== p.cpiPeak) {
          patch[key] = { ...a, pension: { ...p, annual: next.annual, cpiPeak: next.cpiPeak,
            ...(reversion != null && { reversionAnnual: reversion }) } };
        }
        continue;
      }
      if (eb.electedMs != null || !preservedOn(state, a, date)) continue;
      const next = indexUnfundedBenefit(eb.unfunded ?? 0, cpiNow, eb.cpiPeak ?? 1);
      if (next.cpiPeak === eb.cpiPeak && next.unfunded === eb.unfunded) continue;
      patch[key] = { ...a, employerBenefit: { ...eb, unfunded: next.unfunded, cpiPeak: next.cpiPeak } };
    }
    return this.newState(state, patch);
  }
}

// ─── Phase 5: the election and the pension ─────────────────────────────────────

export class MsbsPensionHandler extends HandlerEntry {
  static type        = 'MsbsPensionHandler';
  static description = 'Each month-end: makes a preserved MSBS benefit\'s election once its date has come (MSBS_ELECTION_APPLY), and pays its pension (MSBS_PENSION_APPLY), reverting it to a surviving spouse when the pensioner has died (MSBS_PENSION_REVERT).';
  static eventType   = 'MSBS_PENSION';

  constructor({ stateKey = null } = {}) {
    super(null, 'MSBS Pension');
    this.stateKey = stateKey;
    this.generatedActionTypes = ['MSBS_ELECTION_APPLY', 'MSBS_PENSION_APPLY', 'MSBS_PENSION_REVERT'];
  }

  static fromJSON(d) {
    const h = new this({ stateKey: d.stateKey ?? null });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return { ...super.toJSON(), stateKey: this.stateKey };
  }

  call({ state, date }) {
    const a = state?.[this.stateKey];
    if (!isMsbs(a) || !a.employerBenefit || !date) return [];
    if (a.employerBenefit.electedMs == null) return this._elect(state, a, date);
    const p = a.pension;
    if (!(p?.annual > 0)) return [];
    const out = [];
    let recipient = p.recipientKey, annual = p.annual, full = p.fullRatePaymentsLeft ?? 0;
    if (state.people?.[recipient] == null) {
      // The pensioner has died. A surviving spouse takes the pension (r 42); with none,
      // it stops (the r 43 final benefit is not modelled).
      const spouse = !p.survivor ? Object.keys(state.people ?? {}).find(k => k !== recipient) ?? null : null;
      out.push({ type: 'MSBS_PENSION_REVERT', stateKey: this.stateKey, toPersonKey: spouse });
      if (spouse == null) return out;
      recipient = spouse;
      full = MSBS_FULL_RATE_PAYMENTS;
    }
    const person = state.people[recipient];
    const born = person?.birthDate != null ? new Date(person.birthDate) : null;
    const age  = born ? wholeYears(born, date) : 0;
    out.push({
      type: 'MSBS_PENSION_APPLY', stateKey: this.stateKey, personKey: recipient,
      amount: +(annual / 12).toFixed(2), taxedShare: p.taxedShare,
      age, preservationAge: born ? preservationAge(born) : 60, fullRate: full > 0,
    });
    return out;
  }

  _elect(state, a, date) {
    const ownerKey = superMemberKey(state, a.ownerId ?? null);
    const owner = ownerKey != null ? state.people?.[ownerKey] : null;
    if (owner?.birthDate == null) return [];
    const electionMs = msbsElectionMs(a, owner.birthDate);
    if (electionMs == null || +date < electionMs) return [];
    const eb = a.employerBenefit;
    // r 61B: the part-year increase since the last 1 July (r 61D(a): from the election).
    const unfunded = partYearIncrease(eb.unfunded ?? 0,
      state.effectiveInflationRates?.AU ?? state.inflationRates?.AU ?? 0, monthsSinceJuly(electionMs));
    const r = msbsElection({ funded: eb.funded ?? 0, unfunded, pensionShare: a.pensionShare ?? 1,
      birthDate: owner.birthDate, electionMs });
    const released = (auSuperReleaseMs(owner, owner.birthDate) ?? Infinity) <= +date;
    return [{
      type: 'MSBS_ELECTION_APPLY', stateKey: this.stateKey, personKey: ownerKey, electionMs,
      annual: r.annual, taxedShare: r.taxedShare, converted: r.converted,
      lumpTaxed: r.lumpTaxed, lumpUntaxed: r.lumpUntaxed, lumpTo: released ? 'cash' : 'super',
      cpiLevel: state.cpiAccumulator?.AU ?? 1,
    }];
  }
}

function wholeYears(born, date) {
  const d = new Date(date);
  let y = d.getUTCFullYear() - born.getUTCFullYear();
  if (d.getUTCMonth() < born.getUTCMonth()
    || (d.getUTCMonth() === born.getUTCMonth() && d.getUTCDate() < born.getUTCDate())) y -= 1;
  return y;
}

/** Whole months from the 1 July on or before `ms` to `ms`. */
function monthsSinceJuly(ms) {
  const d = new Date(ms);
  return (d.getUTCMonth() - 6 + 12) % 12;
}

export class MsbsElectionApplyReducer extends AccountServiceReducer {
  static type        = 'MsbsElectionApplyReducer';
  static description = 'Converts an MSBS employer benefit at its election: the pension share into a pension on the account, the rest a lump sum — to AU cash less 15% on its untaxed element if the member is released, otherwise rolled into their super fund, which pays that 15%.';
  static actionType  = 'MSBS_ELECTION_APPLY';

  constructor({ accountService, stateRegistry }) {
    super('MSBS Election Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes   = ['MSBS_ELECTION_APPLY'];
    this.generatedActionTypes = ['SUPER_EARNINGS_TAX'];
  }

  reduce(state, action) {
    const a = state[action.stateKey];
    if (!isMsbs(a) || !a.employerBenefit) return this.newState(state);
    const patch = {
      [action.stateKey]: {
        ...a,
        employerBenefit: { ...a.employerBenefit, funded: 0, unfunded: 0, electedMs: action.electionMs },
        ...(action.annual > 0 && { pension: {
          annual: action.annual, taxedShare: action.taxedShare, startMs: action.electionMs,
          cpiPeak: action.cpiLevel ?? 1, recipientKey: action.personKey, survivor: false,
          fullRatePaymentsLeft: 0, reversionAnnual: null,
        } }),
      },
    };
    const lump = +((action.lumpTaxed ?? 0) + (action.lumpUntaxed ?? 0)).toFixed(2);
    const chained = [];
    if (lump > 0 && action.lumpTo === 'cash') {
      const tax = lumpSumTax(action);
      const cashKey = resolveCashKey(this.stateRegistry, 'AU', state);
      if (state[cashKey]) this.accountService.transaction(state[cashKey], +(lump - tax).toFixed(2), null);
      patch.auSuperLumpSumTaxYTD = +((state.auSuperLumpSumTaxYTD ?? 0) + tax).toFixed(2);
    } else if (lump > 0) {
      // Rolled over (r 84): the receiving fund pays 15% on the element untaxed in the
      // fund, booked as fund tax like any other.
      const fundKey = auSuperKeyFor({ state, stateRegistry: this.stateRegistry, personKey: action.personKey });
      const tax = +(SUPER_TAX_RATE * (action.lumpUntaxed ?? 0)).toFixed(2);
      if (fundKey && state[fundKey]) {
        this.accountService.transaction(state[fundKey], +(lump - tax).toFixed(2), null);
        if (tax > 0) chained.push({ type: 'SUPER_EARNINGS_TAX', amount: action.lumpUntaxed, stateKey: fundKey, taxRate: SUPER_TAX_RATE });
      }
    }
    return this.newState(state, patch, chained);
  }
}

export class MsbsPensionApplyReducer extends AccountServiceReducer {
  static type        = 'MsbsPensionApplyReducer';
  static description = 'Pays a month of MSBS pension into the AU cash pool and accrues its tax facts (Div 301, 303) for the recipient\'s return; after a survivor\'s full-rate months, drops the pension to the spouse\'s share.';
  static actionType  = 'MSBS_PENSION_APPLY';

  constructor({ accountService, stateRegistry }) {
    super('MSBS Pension Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes = ['MSBS_PENSION_APPLY'];
  }

  reduce(state, action) {
    const a = state[action.stateKey];
    if (!a?.pension || !(action.amount > 0)) return this.newState(state);
    const cashKey = resolveCashKey(this.stateRegistry, 'AU', state);
    if (state[cashKey]) this.accountService.transaction(state[cashKey], action.amount, null);

    const t = pensionPaymentTax(action);
    const prev = state.auPersonSuperStreamYTD?.[action.personKey] ?? {};
    const sum = k => +((prev[k] ?? 0) + t[k]).toFixed(4);
    const ytd = { assessable: sum('assessable'), offset: sum('offset'), offset60: sum('offset60'),
      taxed60: sum('taxed60'), total60: sum('total60') };

    let pension = a.pension;
    if ((pension.fullRatePaymentsLeft ?? 0) > 0) {
      const left = pension.fullRatePaymentsLeft - 1;
      pension = { ...pension, fullRatePaymentsLeft: left,
        ...(left === 0 && pension.reversionAnnual != null && { annual: pension.reversionAnnual }) };
    }
    return this.newState(state, {
      auPersonSuperStreamYTD: { ...(state.auPersonSuperStreamYTD ?? {}), [action.personKey]: ytd },
      ...(pension !== a.pension && { [action.stateKey]: { ...a, pension } }),
    });
  }
}

export class MsbsPensionRevertReducer extends Reducer {
  static type        = 'MsbsPensionRevertReducer';
  static description = 'On a pensioner\'s death, passes the MSBS pension to the surviving spouse at 67% after three full-rate months (MSBS Rules r 42, Sch 4), or ends it when there is none.';
  static actionType  = 'MSBS_PENSION_REVERT';

  constructor() {
    super('MSBS Pension Revert', PRIORITY.CASH_FLOW - 1);
    this.reducedActionTypes = ['MSBS_PENSION_REVERT'];
  }

  reduce(state, action) {
    const a = state[action.stateKey];
    if (!a?.pension) return this.newState(state);
    const p = a.pension;
    const pension = action.toPersonKey == null
      ? { ...p, annual: 0 }
      : { ...p, recipientKey: action.toPersonKey, survivor: true,
          fullRatePaymentsLeft: MSBS_FULL_RATE_PAYMENTS,
          reversionAnnual: +(p.annual * MSBS_SPOUSE_SHARE).toFixed(2) };
    return this.newState(state, { [action.stateKey]: { ...a, pension } });
  }
}
