/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * downsizer-contribution.js — ITAA97 s292-102, the downsizer super contribution.
 *
 * The lever that makes an Australian downsize worth more than the cash it releases: on
 * selling a main residence held ten years or more, a person aged 55 or over may put up
 * to A\$300,000 of the proceeds into superannuation **outside the contribution caps**,
 * with no work test and no total-super-balance limit on making it. For a couple that is
 * up to A\$600,000 moved from a taxed environment into a concessionally taxed one, in a
 * single transaction, at exactly the age when nothing else can get money into super.
 *
 * ─── it is NOT the ordinary contribution path, and the difference is the point ──
 * A concessional contribution is taxed 15% going in (Div 295) and counts against a cap.
 * A downsizer contribution is neither: it is made from after-tax money, arrives in the
 * fund **in full**, and is a non-concessional amount that does not consume the
 * non-concessional cap. Routing it through `SuperContributionApplyReducer` would shave
 * 15% off it and quietly understate the whole strategy, which is why it has its own
 * action rather than reusing one that looks close enough.
 *
 * ─── the eligibility coupling worth knowing before modelling a sale ────────────
 * s292-102(1)(b) requires that the dwelling qualified — **at least partly** — for the
 * main residence CGT exemption. So this is the same lever as design 83 G7's
 * `mainResidenceFrom`: a dwelling that was never the taxpayer's main residence produces
 * no exemption, and therefore no downsizer contribution either. For a rented dwelling
 * the decision to move in before selling buys two things at once — a slice of s118-185
 * and the whole downsizer entitlement — and the second is often the larger of the two.
 * A model that granted the contribution unconditionally would hide exactly that.
 *
 * ─── the US side gets nothing, which is the cross-border sting ────────────────
 * A US person has no super exemption. Moving after-tax proceeds into an Australian fund
 * is not a US deduction, does not defer US tax, and leaves the fund's earnings inside
 * the s99B / design-84 machinery. So the contribution is US-tax-NEUTRAL at the moment
 * it is made — it books nothing on the US return — and its benefit is entirely
 * Australian. That asymmetry is stated here rather than assumed, because the intuition
 * "money into super is money sheltered" is a domestic one and does not survive the
 * border.
 *
 * ─── figures are UNVERIFIED against the ATO ──────────────────────────────────
 * The age threshold moved 65 → 60 → 55 across 2018–2023 and the cap has been
 * A\$300,000 since introduction. Both are transcribed from secondary knowledge, not from
 * an ATO publication on disk — ato.gov.au blocks automated fetches, and this repository
 * has been burned before by bases taken from anywhere but the authority. Verify before
 * relying on a result that turns on them.
 */

import { ageAt } from '../../mpc/harvest.js';

/** s292-102(1): minimum age at the time of the contribution. */
export const DOWNSIZER_MIN_AGE = 55;

/** s292-102(2): maximum per person, per lifetime-eligible disposal. */
export const DOWNSIZER_CAP_AUD = 300_000;

/** s292-102(1)(a): the dwelling must have been held for at least this long. */
export const DOWNSIZER_MIN_OWNERSHIP_YEARS = 10;

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

/**
 * How much of a sale's proceeds each owner may contribute under s292-102.
 *
 * Every gate returns a reason rather than a bare zero, because a downsizer contribution
 * that silently does not happen looks identical to one the plan never asked for — and
 * the most likely cause is the main-residence gate, which is a modelling decision the
 * reader needs told rather than discovered.
 *
 * @param {object} opts
 * @param {object}  opts.prop            property state entry
 * @param {number}  opts.proceeds        gross sale price, AUD
 * @param {number}  opts.exemptFraction  the s118-185 result for this sale
 * @param {?number} opts.acquisitionMs
 * @param {?number} opts.saleMs
 * @param {Array<{personKey: string, birthDate: *, residency: *, fraction: number}>} opts.owners
 * @returns {{contributions: Array<{personKey: string, amount: number}>, total: number, reason: string}}
 */
export function downsizerContributions({ prop, proceeds, exemptFraction, acquisitionMs, saleMs, owners }) {
  const none = (reason) => ({ contributions: [], total: 0, reason });

  if (prop?.claimDownsizerContribution !== true) return none('not-claimed');
  if (prop?.country !== 'AU') return none('not-an-australian-dwelling');
  // s292-102(1)(b): "at least partly" — a wholly assessable dwelling is not a main
  // residence for this purpose, so the same field that decides G7's exemption decides
  // eligibility here.
  if (!(exemptFraction > 0)) return none('no-main-residence-exemption');
  if (acquisitionMs == null || saleMs == null) return none('unknown-ownership-period');
  if ((saleMs - acquisitionMs) < DOWNSIZER_MIN_OWNERSHIP_YEARS * YEAR_MS) {
    return none('held-under-ten-years');
  }
  if (!(proceeds > 0)) return none('no-proceeds');

  // Per-person cap, then the joint proceeds ceiling: s292-102(2) also limits the TOTAL
  // across both members of a couple to the sale price, so a modest home cannot fund
  // A$600,000 between two people.
  const eligible = (owners ?? []).filter(o => {
    const age = ageAt(o.birthDate, new Date(saleMs));
    return age != null && age >= DOWNSIZER_MIN_AGE;
  });
  if (eligible.length === 0) return none('nobody-meets-the-age-test');

  let remaining = proceeds;
  const contributions = [];
  for (const o of eligible) {
    if (remaining <= 0) break;
    const amount = +Math.min(DOWNSIZER_CAP_AUD, remaining).toFixed(2);
    if (amount <= 0) continue;
    contributions.push({ personKey: o.personKey, amount });
    remaining -= amount;
  }
  const total = +contributions.reduce((s, c) => s + c.amount, 0).toFixed(2);
  return { contributions, total, reason: total > 0 ? 'eligible' : 'no-capacity' };
}

// ─── Reducer ─────────────────────────────────────────────────────────────────

import { AccountServiceReducer, PRIORITY } from '../../../simulation-framework/reducers.js';
import { RecordBalanceAction } from '../../../simulation-framework/actions.js';
import { resolveCashKey } from '../cash-routing.js';
import { ACCOUNT_ROLES } from '../../state/account-roles.js';

/**
 * Moves a downsizer contribution from the AU cash pool into the member's super fund.
 *
 * **No 15% withholding.** That is the whole difference from `SuperContributionApply`,
 * and it is the reason this is a separate reducer rather than a flag on that one: a
 * downsizer contribution is a non-concessional amount made from money already taxed, so
 * Div 295 does not touch it and the fund receives the full figure.
 *
 * The full amount also lands on `contributionBasis`, not `earningsBasis` — it is
 * contributed capital by definition. Getting that split wrong would misprice every
 * later withdrawal, since the taxable proportion of a super benefit is driven by the
 * ratio between the two.
 */
export class SuperDownsizerContributionApplyReducer extends AccountServiceReducer {
  static type        = 'SuperDownsizerContributionApplyReducer';
  static category    = 'reducer';
  static description = 'Debits the AU cash pool and credits the member\'s super account with a downsizer contribution IN FULL — no Div 295 15% withholding, and no contribution-cap consumption (s292-102).';
  static actionType  = 'SUPER_DOWNSIZER_CONTRIBUTION_APPLY';

  constructor({ accountService, stateRegistry }) {
    super('Super Downsizer Contribution Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes   = ['SUPER_DOWNSIZER_CONTRIBUTION_APPLY'];
    this.generatedActionTypes = ['RECORD_BALANCE'];
  }

  reduce(state, action) {
    const { amount, personKey } = action;
    if (!(amount > 0)) return this.newState(state);

    const superKey = action.stateKey
      ?? this.stateRegistry?.getStateKey?.(ACCOUNT_ROLES.SUPER, personKey)
      ?? 'superAccount';
    const sa = state[superKey];
    if (!sa) return this.newState(state);

    const cashKey = resolveCashKey(this.stateRegistry, 'AU', state);
    const cash    = state[cashKey];
    // Debit only what is there. The proceeds land in the same pool moments earlier (the
    // sale reducer runs first at the same priority), so this is normally fully funded;
    // capping rather than going negative keeps a mis-sized contribution visible as a
    // smaller super balance instead of as impossible cash.
    const debited = Math.min(Math.max(0, cash?.balance ?? 0), amount);
    if (cash && debited > 0) this.accountService.transaction(cash, -debited, null);
    if (debited > 0) this.accountService.transaction(sa, debited, null);

    return this.newState(
      state,
      { [superKey]: { ...state[superKey],
                      contributionBasis: (state[superKey].contributionBasis ?? 0) + debited } },
      [new RecordBalanceAction(`${superKey}.balance`, superKey),
       new RecordBalanceAction(`${cashKey}.balance`, cashKey)],
    );
  }
}
