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

import { MSBS_PRESERVED_FACTORS } from './msbs-valuation-factors.js';
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

/**
 * What an MSBS state entry counts toward its member's total superannuation balance on
 * `asOf`, or its balance when the member's age is unknown.
 */
export function msbsTotalSuperBalance(account, birthDate, asOf) {
  const member = Math.max(0, account?.balance ?? 0);
  if (toMs(birthDate) == null || toMs(asOf) == null) return member;
  const eb = account?.employerBenefit ?? {};
  const { years, months } = completedAge(birthDate, asOf);
  return msbsPreservedValue({
    member, funded: eb.funded ?? 0, unfunded: eb.unfunded ?? 0,
    years, months, officer: !!account?.officerOnExit,
  });
}
