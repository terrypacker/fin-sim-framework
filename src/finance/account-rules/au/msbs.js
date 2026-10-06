/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * msbs.js — a PRESERVED Military Superannuation and Benefits Scheme benefit (design 119
 * §6.4, phase 4). The member has left the ADF; the account is authored from a CSC statement.
 *
 * An `MsbsAccount` is a super account (type `super`), so its invested balance — the
 * **member benefit**, with the ancillary benefit folded in — is gated, taxed and counted like
 * any fund. The **employer benefit** is not a balance the household holds, and lives beside
 * it on the state entry as `employerBenefit`:
 *
 *   - `funded`   — the funded employer benefit, invested in CSC's Balanced option whatever
 *                  the member chose (PDS §3). Grown once a year at the Balanced mix's
 *                  return, net of the fund's 15% on income, which is how CSC credits it.
 *                  In net worth; never drawn, rebalanced or pooled.
 *   - `unfunded` — the rest of the employer benefit, indexed each 1 July by CPI on the
 *                  never-falls rule (r 61A, 61D(b)) and rounded to a tenth of a per cent
 *                  (r 61E(3)). Not in net worth: nothing backs it until it is paid.
 *
 * All rule (r) references are to the MSBS Rules, Schedule to the Military Superannuation
 * and Benefits Trust Deed, compilation No. 19 (`docs/au-tax/MSB-Trust-Deed/`).
 */

import { MSBS_PRESERVED_FACTORS, MSBS_PENSION_FACTORS } from './msbs-valuation-factors.js';
import { SUPER_TAX_RATE } from '../../tax/au/super-tax-rate.js';

export const MSBS_SCHEME = 'MSBS';

/**
 * CSC's Balanced option, target allocation at 31 Oct 2025 (PDS ed. 10 §5): cash 13%, fixed
 * interest 12.5%, equities 58%, property 3.5%, infrastructure 7.5%, alternatives 5.5%. The
 * model's classes are equity, bonds and cash, so the growth assets (74.5%) are equity. The
 * PDS does not split equities by market; half Australian and half international is an
 * assumption, editable on the account.
 */
export const MSBS_DEFAULT_FUNDED_ALLOCATION = Object.freeze({
  EQUITY_AU:         0.3725,
  EQUITY_INTL_EX_AU: 0.3725,
  FIXED_INCOME_AU:   0.125,
  SAVINGS_AU:        0.13,
});

/** Rate keys whose return is an interest rate rather than an equity total. */
const INTEREST_KEYS = new Set(['FIXED_INCOME_AU', 'SAVINGS_AU']);

export const isMsbs = a => a != null && a.scheme === MSBS_SCHEME;

const toMs = v => {
  if (v == null || v === '') return null;
  const t = v instanceof Date ? v.getTime() : (typeof v === 'number' ? v : Date.parse(v));
  return Number.isFinite(t) ? t : null;
};

function birthdayMs(bornMs, years) {
  const b = new Date(bornMs);
  return Date.UTC(b.getUTCFullYear() + years, b.getUTCMonth(), b.getUTCDate());
}

/**
 * The window an election may fall in (§5.4): from the later of the 55th birthday (r 52(1))
 * and the end of service (r 52(1A)), to the 65th birthday, when an unelected benefit is
 * paid as a lump sum (r 53(1)). Null without a birth date.
 *
 * @returns {{ openMs: number, closeMs: number }|null}
 */
export function msbsDrawWindow(account, birthDate) {
  const born = toMs(birthDate);
  if (born == null) return null;
  const closeMs = birthdayMs(born, 65);
  const openMs  = Math.min(closeMs, Math.max(birthdayMs(born, 55), toMs(account?.serviceEndDate) ?? -Infinity));
  return { openMs, closeMs };
}

/**
 * The election date (D6): the account's `drawStartDate` clamped into the draw window, or
 * the window's start when blank.
 *
 * @returns {number|null}
 */
export function msbsElectionMs(account, birthDate) {
  const w = msbsDrawWindow(account, birthDate);
  if (w == null) return null;
  const chosen = toMs(account?.drawStartDate) ?? w.openMs;
  return Math.min(w.closeMs, Math.max(w.openMs, chosen));
}

/**
 * One r 61A increase. `cpiNow` and `cpiPeak` are levels of the AU CPI index; the benefit
 * rises only when `cpiNow` beats every earlier level, by that margin rounded to a tenth of
 * a per cent (r 61E(3): a fraction of 0.05% or more rounds up).
 *
 * @returns {{ unfunded: number, cpiPeak: number, pct: number }}
 */
export function indexUnfundedBenefit(unfunded, cpiNow, cpiPeak) {
  if (!(cpiNow > cpiPeak)) return { unfunded, cpiPeak, pct: 0 };
  const pct = Math.round(((cpiNow - cpiPeak) / cpiPeak) * 1000 + 1e-9) / 1000;
  return { unfunded: +(unfunded * (1 + pct)).toFixed(2), cpiPeak: cpiNow, pct };
}

/**
 * The funded sleeve's annual return: the allocation's weighted market returns, less the
 * fund's 15% on income (an equity market's dividend yield; all of a cash or bond rate).
 * Franking credits are not modelled on the sleeve.
 *
 * @param {object} state       carries `effectiveGrowthRates`, `marketDividendYields` and
 *                             `effectiveInterestRates`
 * @param {object} allocation  rate key → weight
 * @returns {number}
 */
export function fundedSleeveReturn(state, allocation = MSBS_DEFAULT_FUNDED_ALLOCATION) {
  let r = 0;
  for (const [key, w] of Object.entries(allocation ?? {})) {
    if (!(w > 0)) continue;
    if (INTEREST_KEYS.has(key)) {
      const rate = state?.effectiveInterestRates?.[key];
      if (rate == null) throw new Error(`MSBS funded sleeve: no interest rate for '${key}'`);
      r += w * rate * (1 - SUPER_TAX_RATE);
    } else {
      const total = state?.effectiveGrowthRates?.[key];
      if (total == null) throw new Error(`MSBS funded sleeve: no growth rate for '${key}'`);
      r += w * (total - SUPER_TAX_RATE * (state?.marketDividendYields?.[key] ?? 0));
    }
  }
  return r;
}

/** The model's allocation class for a funded-sleeve rate key. */
const ALLOCATION_OF = { FIXED_INCOME_AU: 'BOND', SAVINGS_AU: 'CASH' };

/**
 * The funded employer benefit split by its mix, `[{ rateKey, allocation, value }]`, the
 * weights normalised and the last part taking the rounding so the parts sum to `funded`
 * exactly. What net worth's allocation cube shows for the sleeve.
 */
export function fundedSleeveParts(employerBenefit) {
  const funded = employerBenefit?.funded ?? 0;
  const mix = Object.entries(employerBenefit?.fundedAllocation ?? MSBS_DEFAULT_FUNDED_ALLOCATION)
    .filter(([, w]) => w > 0);
  const total = mix.reduce((s, [, w]) => s + w, 0);
  if (!(funded !== 0) || !(total > 0)) return [];
  let left = funded;
  return mix.map(([rateKey, w], i) => {
    const value = i === mix.length - 1 ? +left.toFixed(2) : +(funded * w / total).toFixed(2);
    left -= value;
    return { rateKey, allocation: ALLOCATION_OF[rateKey] ?? 'EQUITY', value };
  });
}

/** Completed years and the complete months past them, at `asOf`. */
export function completedAge(birthDate, asOf) {
  const b = new Date(toMs(birthDate)), d = new Date(toMs(asOf));
  let months = (d.getUTCFullYear() - b.getUTCFullYear()) * 12 + (d.getUTCMonth() - b.getUTCMonth());
  if (d.getUTCDate() < b.getUTCDate()) months -= 1;
  return { years: Math.floor(months / 12), months: months % 12 };
}

/** Table 1 factor at completed `years`; "20 or less" below, the 65 row above. */
function factorRow(years) {
  const first = MSBS_PRESERVED_FACTORS[0][0];
  const last  = MSBS_PRESERVED_FACTORS[MSBS_PRESERVED_FACTORS.length - 1][0];
  return MSBS_PRESERVED_FACTORS[Math.min(last, Math.max(first, years)) - first];
}

/**
 * The family law value of a preserved interest (Approval Sch 1 Pt 4 item 2.1):
 *
 *   FDB × FDBF(y+m) + UDB × UDBF(y+m) + MB,   F(y+m) = (F(y) × (12 − m) + F(y+1) × m) / 12
 *
 * read as male (ITAR reg 307-230A.04(3)(g)). Phase 4's total-super-balance value of an
 * MSBS account (§5.6 item 7).
 *
 * @returns {number}
 */
export function msbsPreservedValue({ member = 0, funded = 0, unfunded = 0, years, months = 0, officer = false }) {
  const [, fo0, fx0, uo0, ux0] = factorRow(years);
  const [, fo1, fx1, uo1, ux1] = factorRow(years + 1);
  const blend = (a, b) => (a * (12 - months) + b * months) / 12;
  const fdbf = officer ? blend(fo0, fo1) : blend(fx0, fx1);
  const udbf = officer ? blend(uo0, uo1) : blend(ux0, ux1);
  return funded * fdbf + unfunded * udbf + member;
}

/** Table 4A single-life factor for an age pension at `years` and `months` (item 3.1). */
export function msbsPensionFactor(years, months = 0) {
  const first = MSBS_PENSION_FACTORS[0][0];
  const last  = MSBS_PENSION_FACTORS[MSBS_PENSION_FACTORS.length - 1][0];
  const row = y => MSBS_PENSION_FACTORS[Math.min(last, Math.max(first, y)) - first][1];
  return (row(years) * (12 - months) + row(years + 1) * months) / 12;
}

/**
 * What an MSBS state entry counts toward its member's total superannuation balance on
 * `asOf`, or its balance when the member's age is unknown. Before the election, the
 * preserved value (Table 1); once the pension is paid, `P × PF` (Table 4A, the reversion
 * term dropped under reg 307-230A.04(3)(h)), plus the member benefit.
 */
export function msbsTotalSuperBalance(account, birthDate, asOf) {
  const member = Math.max(0, account?.balance ?? 0);
  if (toMs(birthDate) == null || toMs(asOf) == null) return member;
  const eb = account?.employerBenefit ?? {};
  const { years, months } = completedAge(birthDate, asOf);
  if (account?.pension?.annual > 0) return member + account.pension.annual * msbsPensionFactor(years, months);
  return msbsPreservedValue({
    member, funded: eb.funded ?? 0, unfunded: eb.unfunded ?? 0,
    years, months, officer: !!account?.officerOnExit,
  });
}

// ─── Phase 5: the election and the pension ─────────────────────────────────────

/** The r 65B minimum employer benefit for a pension: 25 × the \$200 SIS preservation
 *  threshold amount (SIS Regs Sch 1 item 104, column 2; design 119 §5.7 item 2). */
export const MSBS_PENSION_MINIMUM = 25 * 200;

/** The survivor's share of a deceased pensioner's pension: a spouse with no eligible
 *  child (r 42(1), Sch 4 Table 1). Children are not modelled. */
export const MSBS_SPOUSE_SHARE = 0.67;

/** Monthly payments a surviving spouse receives at the full rate before the 67%
 *  applies: r 42(2)'s seven fortnightly pension paydays, about three months. */
export const MSBS_FULL_RATE_PAYMENTS = 3;

/** Is `share` a pension share the Rules allow: 0 (all lump sum), or 0.5 to 1 (r 52(1)(c))? */
export const isValidPensionShare = share => share === 0 || (share >= 0.5 && share <= 1);

/**
 * The nearest share the Rules allow. The loader rejects an authored share outside them;
 * this is for a swept one, which the optimizer may land between 0 and 0.5 or past 1.
 */
export function normalizePensionShare(share) {
  const x = Number(share);
  if (!Number.isFinite(x)) return 1;
  if (x < 0.25) return 0;
  return Math.min(1, Math.max(0.5, x));
}

/**
 * Errors in authored MSBS accounts: a share outside the Rules, or a pension asked of an
 * employer benefit below the r 65B minimum (r 52(2)).
 *
 * @param {Array<object>} accounts  cfg account records
 * @returns {string[]}
 */
export function validateMsbsAccounts(accounts) {
  const errors = [];
  for (const a of accounts ?? []) {
    if (!(a?.__type === 'MsbsAccount' || a?.scheme === MSBS_SCHEME)) continue;
    const label = `MSBS account "${a.stateKey ?? a.name ?? '?'}"`;
    const share = a.pensionShare ?? 1;
    if (!isValidPensionShare(share)) {
      errors.push(`${label}: pensionShare ${share} must be 0, or from 0.5 to 1 (MSBS Rules r 52(1)(c)).`);
    }
    const benefit = (Number(a.fundedEmployerBenefit) || 0) + (Number(a.unfundedEmployerBenefit) || 0);
    if (share > 0 && benefit < MSBS_PENSION_MINIMUM) {
      errors.push(`${label}: an employer benefit under $${MSBS_PENSION_MINIMUM} cannot become a `
        + 'pension (r 52(2), r 65B); set pensionShare to 0.');
    }
  }
  return errors;
}

/**
 * The Schedule 5 conversion factor at the election date: 10 at 65, plus 0.2 for each
 * year under 65, less the same 0.2 pro rata for the days past the last birthday.
 */
export function msbsConversionFactor(birthDate, electionMs) {
  const born = new Date(toMs(birthDate));
  const at   = toMs(electionMs);
  let years  = new Date(at).getUTCFullYear() - born.getUTCFullYear();
  let last   = birthdayMs(born.getTime(), years);
  if (last > at) { years -= 1; last = birthdayMs(born.getTime(), years); }
  if (years >= 65) return 10;
  const next = birthdayMs(born.getTime(), years + 1);
  return 10 + 0.2 * (65 - years) - 0.2 * (at - last) / (next - last);
}

/**
 * The election (r 52(1), r 65, r 65A, Sch 5): `pensionShare` of the employer benefit
 * becomes a pension, funded part first, and the rest is a lump sum. Below the r 65B
 * minimum the whole benefit is a lump sum (r 52(2)).
 *
 * @returns {{ annual: number, taxedShare: number, converted: number,
 *             lumpTaxed: number, lumpUntaxed: number }}
 */
export function msbsElection({ funded = 0, unfunded = 0, pensionShare = 1, birthDate, electionMs }) {
  const benefit = funded + unfunded;
  const share   = benefit >= MSBS_PENSION_MINIMUM ? normalizePensionShare(pensionShare) : 0;
  const converted         = +(benefit * share).toFixed(2);
  const convertedFunded   = Math.min(funded, converted);
  const convertedUnfunded = +(converted - convertedFunded).toFixed(2);
  const annual = converted > 0 ? +(converted / msbsConversionFactor(birthDate, electionMs)).toFixed(2) : 0;
  return {
    annual,
    taxedShare:  converted > 0 ? convertedFunded / converted : 0,
    converted,
    lumpTaxed:   +(funded - convertedFunded).toFixed(2),
    lumpUntaxed: +(unfunded - convertedUnfunded).toFixed(2),
  };
}

/**
 * The r 61B part-year increase on the unfunded part when the benefit becomes payable:
 * the rise since the last 1 July, which the model's annual CPI cannot see, is taken as
 * the year's AU inflation rate pro rata by whole months, rounded to 0.1% (r 61E(3)).
 */
export function partYearIncrease(unfunded, annualRate, monthsSinceJuly) {
  if (!(annualRate > 0) || !(monthsSinceJuly > 0)) return unfunded;
  const pct = Math.round(annualRate * monthsSinceJuly / 12 * 1000 + 1e-9) / 1000;
  return +(unfunded * (1 + pct)).toFixed(2);
}

/**
 * The yearly r 56 increase. The Rules index twice a year; the model's CPI is annual, so
 * the pension rises once, on 1 July, by the CPI rise over its highest earlier level. A
 * pension that started in the past year gets the r 58(3) share — whole months paid over
 * the period's — and none if it started in its last fortnight (r 58(2), after 16 June).
 *
 * @param {number} monthsPaid  months since the pension started, if under a year; else null
 * @returns {{ annual: number, cpiPeak: number }}
 */
export function msbsPensionIncrease(annual, cpiNow, cpiPeak, monthsPaid = null) {
  if (!(cpiNow > cpiPeak)) return { annual, cpiPeak };
  let pct = Math.round(((cpiNow - cpiPeak) / cpiPeak) * 1000 + 1e-9) / 1000;
  if (monthsPaid != null && monthsPaid < 12) pct = monthsPaid <= 0 ? 0 : pct * monthsPaid / 12;
  return { annual: +(annual * (1 + pct)).toFixed(2), cpiPeak: cpiNow };
}

/**
 * One pension payment's tax facts for the recipient's return (ITAA 1997 Div 301, 303):
 *
 *   - under preservation age: the whole payment is assessable, no offset;
 *   - preservation age to 59: assessable, with 15% off the taxed element (s301-25,
 *     s301-110);
 *   - 60 or over: the taxed element is not assessable (s301-10); the untaxed element is,
 *     with a 10% offset (s301-100). Both count toward the defined benefit income cap,
 *     which the settle applies (`superIncomeStreamTax`).
 *
 * @returns {{ assessable: number, offset: number, offset60: number, taxed60: number, total60: number }}
 */
export function pensionPaymentTax({ amount, taxedShare, age, preservationAge }) {
  const taxed = amount * taxedShare, untaxed = amount - taxed;
  const zero = { assessable: 0, offset: 0, offset60: 0, taxed60: 0, total60: 0 };
  if (age >= 60) return { ...zero, assessable: untaxed, offset60: 0.10 * untaxed, taxed60: taxed, total60: amount };
  if (age >= preservationAge) return { ...zero, assessable: amount, offset: 0.15 * taxed };
  return { ...zero, assessable: amount };
}

/**
 * A year's income-stream tax from the accrued payment facts, with the defined benefit
 * income cap (s303-4: the general transfer balance cap ÷ 16, rounded up): half the taxed
 * element over the cap is assessable (s303-2), and the 10% offsets fall by 10% of the
 * whole stream over the cap, not below zero (s303-3).
 *
 * @param {object|null} ytd  `{ assessable, offset, offset60, taxed60, total60 }`
 * @param {number} cap       the year's defined benefit income cap
 * @returns {{ assessable: number, offset: number }}
 */
export function superIncomeStreamTax(ytd, cap) {
  if (!ytd) return { assessable: 0, offset: 0 };
  const over  = x => Math.max(0, x - cap);
  const assessable = (ytd.assessable ?? 0) + 0.5 * over(ytd.taxed60 ?? 0);
  const offset60   = Math.max(0, (ytd.offset60 ?? 0) - 0.10 * over(ytd.total60 ?? 0));
  return { assessable, offset: (ytd.offset ?? 0) + offset60 };
}

/**
 * Final tax withheld from a lump sum paid in cash to a released member. The taxed element
 * is tax-free from 60 (s301-10), and at preservation age to 59 is taken to sit under the
 * low rate cap (0%, s301-20). The untaxed element is taxed at 15%: s301-95 below the
 * untaxed plan cap from 60, s301-105 below the low rate cap before it. Neither cap is
 * modelled, so a lump sum above them is under-taxed.
 */
export function lumpSumTax({ lumpUntaxed = 0 }) {
  return +(0.15 * lumpUntaxed).toFixed(2);
}
