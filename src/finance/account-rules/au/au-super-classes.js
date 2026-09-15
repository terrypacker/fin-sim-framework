/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY, AccountServiceReducer } from '../../../simulation-framework/reducers.js';
import { HandlerEntry }       from '../../../simulation-framework/handlers.js';
import { RecordBalanceAction } from '../../../simulation-framework/actions.js';
import { getBirthDate } from '../../residency-utils.js';
import { resolveCashKey } from '../cash-routing.js';
import { debitLedgerForLoss } from '../../assets/investment-account.js';
import { SUPER_TAX_RATE, superEarningsTaxRate } from '../../tax/au/super-tax-rate.js';
import { scaleHoldings, lotVintage } from '../../holdings/holding-utils.js';
import { auFinancialYearOf } from '../../payroll/au-super-caps.js';

/** Resolve the AU cash pool (legacy tail; prefer resolveCashKey for routing). */
const auCash = (state) => state.auSavingsAccount ?? state.checkingAccount;

/** Returns age in whole years as of asOfDate. */
function getAge(birthDate, asOfDate) {
  const years = asOfDate.getUTCFullYear() - birthDate.getUTCFullYear();
  const hadBirthday =
    asOfDate.getUTCMonth() > birthDate.getUTCMonth() ||
    (asOfDate.getUTCMonth() === birthDate.getUTCMonth() &&
     asOfDate.getUTCDate() >= birthDate.getUTCDate());
  return hadBirthday ? years : years - 1;
}

// ─── Reducers ─────────────────────────────────────────────────────────────────

/**
 * EVT-20: Super contribution — debit AU cash pool, credit contributionBasis.
 * Chains SUPER_CONTRIBUTION_TAX (AU super tax at 15%).
 *
 * Design 77 §5.2 — the 15% contributions tax is levied on the FUND (ITAA 1997
 * Div 295), which deducts it from the contribution as it is received. So the
 * member contributes the gross amount out of AU cash but only the NET lands in
 * their super balance and contributionBasis. Before design 77 the gross was
 * credited and the tax was later debited from AU cash at the annual settle, which
 * both overstated the super balance and charged the member's own cash for a tax
 * they never legally owed.
 */
export class SuperContributionApplyReducer extends AccountServiceReducer {
  static type        = 'SuperContributionApplyReducer';
  static description = 'Debits the AU cash pool for the gross contribution, credits superAccount with the amount net of the 15% Div 295 contributions tax; chains SUPER_CONTRIBUTION_TAX. An employerFunded contribution (Super Guarantee) skips the cash debit — it never reached the member.';
  static actionType  = 'SUPER_CONTRIBUTION_APPLY';

  constructor({ accountService, stateRegistry }) {
    super('Super Contribution Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes   = ['SUPER_CONTRIBUTION_APPLY'];
    // SUPER_PERSONAL_DEDUCTION is chained for a `deductible` contribution (design 95
    // §9.1). Declared so the graph carries the deduction leg — the payload-schema
    // scan only checks that CLAIMED types are registered, so an omission here is
    // invisible to it and shows up as a missing link in the visualization.
    this.generatedActionTypes = ['SUPER_CONTRIBUTION_TAX', 'SUPER_PERSONAL_DEDUCTION'];
  }

  reduce(state, action) {
    // The Superannuation Guarantee is an EMPLOYER charge on top of the quoted salary:
    // it never reaches the member's cash pool, so it cannot be debited from it, and
    // it is outside their assessable income (only the fund's Div 295 tax below
    // applies). A member's own contribution is the pre-existing path and unchanged.
    const employerFunded = action.employerFunded === true;
    const auCashKey = resolveCashKey(this.stateRegistry, 'AU', state);
    if (!employerFunded) {
      this.accountService.transaction(state[auCashKey], -action.amount, null);
    }
    // Design 95 §9.1 phase 6b — a personal DEDUCTIBLE contribution (s290-150) takes
    // this same path for cash and for Div 295; what it adds is the deduction leg,
    // chained below. Without `deductible` this is an after-tax contribution that pays
    // the fund's 15% and gets nothing back on the return — the worst of both streams,
    // and a plausible-looking number nothing would flag.
    const deductible = action.deductible === true && !employerFunded;
    // Design 87 §14.4 item 3 — the AUD leaving the cash pool is disposed of, and the
    // super account it funds is NOT the other half of a same-currency transfer: design 87
    // §5 puts super outside this design entirely (a super interest is a pension/trust
    // interest, not a bank deposit, and its cross-border treatment is design 83's Art. 18
    // and design 84's s99B work). `isCurrencyLotPool` excludes `type: 'super'` for that
    // reason, so without this declaration the debit would read as a bare withdrawal and
    // realize nothing.
    //
    // PERSONAL, and this is a recorded choice rather than an obvious one. Making a
    // retirement contribution has no expenses properly allocable to it that meet §162 or
    // §212 — the two provisions §988(e)(3) names by number. `§1.988-1(a)(9)(ii)`
    // Example 1 does hold that buying an income-producing ASSET with nonfunctional
    // currency stays inside §988, but its facts are a bond bought directly, where custody
    // and advisory costs are the taxpayer's own §212 expenses. A fund interest's expenses
    // are borne by the FUND, and whatever deduction a contribution attracts comes from
    // the retirement provisions rather than from §212. So this falls to the capital
    // branch with the \$200 exclusion — the over-disallowing direction the rest of this
    // design takes when the answer is arguable.
    // …and only when AUD actually left the pool. An employer contribution disposes of
    // nothing the member held, so stamping it would realize a phantom §988 gain on
    // currency that was never theirs.
    if (!employerFunded) {
      action.section988 = { kind: 'DISPOSE', accountKey: auCashKey, businessFraction: 0 };
    }
    // Per-account (design 55 §7 / 76 Gap C): honor a handler-stamped stateKey so a
    // household with two super accounts credits — and taxes — the right member's.
    // Falls back to the canonical key for legacy dispatchers and pre-stateKey saves.
    // Mirrors SuperEarningsApplyReducer, which already resolves this way.
    const key = action.stateKey ?? 'superAccount';
    const sa = state[key];
    // Net of the fund's Div 295 contributions tax. `contributionBasis` takes the
    // same net figure so the basis invariant (balance === contributionBasis +
    // earningsBasis) survives the withholding — the tax leaves the fund, it does
    // not become earnings.
    const tax = +(action.amount * SUPER_TAX_RATE).toFixed(2);
    const net = +(action.amount - tax).toFixed(2);
    this.accountService.transaction(sa, net, null);
    return this.newState(
      state,
      {
        [key]: { ...sa, contributionBasis: sa.contributionBasis + net },
      },
      // The classifier is handed the GROSS contribution: it is the base the 15% is
      // levied on, and keeping the rate in the year-versioned tax module is what
      // lets a future FY change it in one place.
      [{ type: 'SUPER_CONTRIBUTION_TAX', amount: action.amount, stateKey: key },
       // s290-150 §9.1 — GROSS again, and for a different reason: the deduction is
       // the amount CONTRIBUTED, not the amount that survived the fund's tax. The
       // member pays 15% inside the fund and deducts the whole contribution outside
       // it, which is exactly where the concession lives for anyone whose marginal
       // rate exceeds 15%.
       ...(deductible
         ? [{ type: 'SUPER_PERSONAL_DEDUCTION', amount: action.amount,
              stateKey: key, personKey: action.personKey ?? null }]
         : [])]
    );
  }
}

/**
 * Salary sacrifice (design 95 §9.1, phase 6b).
 *
 * ─── why this is not `SUPER_CONTRIBUTION_APPLY` with employerFunded ──────────
 * On cash and on Div 295 the two are identical: nothing is debited, and the fund
 * takes 15% on the way in. They part company everywhere ELSE. A sacrificed amount
 * is a *concessional contribution of the member's* — it consumes their Div 291 cap
 * and counts as a low-tax contribution for Div 293 — while the SG is the employer's
 * charge. Phase 7 caps both against the member's own cap, and a stream that could
 * not be told from the SG in the journal could not be capped separately from it.
 *
 * ─── what does NOT happen here, and where it does ────────────────────────────
 * The WAGE reduction is the whole point of sacrifice, and it is `PayrollHandler`'s
 * job, not this reducer's: the handler subtracts the sacrificed amount before it
 * emits `AU_WAGES_INCOME_APPLY`, so both the cash credited and the assessable
 * income booked are already net of it. By the time this reducer runs the money has
 * simply never existed as the member's pay. That is why there is no §988 stamp
 * either — no AUD of theirs was disposed of (design 87 §14.4 item 3).
 */
export class SuperSacrificeApplyReducer extends AccountServiceReducer {
  static type        = 'SuperSacrificeApplyReducer';
  static description = 'Credits the member\'s super account with a salary-sacrificed contribution, net of the 15% Div 295 tax; chains SUPER_CONTRIBUTION_TAX. No cash debit — the wage was already reduced at source by PayrollHandler.';
  static actionType  = 'SUPER_SACRIFICE_APPLY';

  constructor({ accountService, stateRegistry }) {
    super('Super Sacrifice Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes   = ['SUPER_SACRIFICE_APPLY'];
    this.generatedActionTypes = ['SUPER_CONTRIBUTION_TAX'];
  }

  reduce(state, action) {
    const key = action.stateKey ?? 'superAccount';
    const sa  = state[key];
    if (!sa || !(action.amount > 0)) return this.newState(state);

    // Same arithmetic as a concessional member contribution: 15% to the fund's tax,
    // the net to balance AND contributionBasis together so the basis invariant
    // (balance === contributionBasis + earningsBasis) survives the withholding.
    const tax = +(action.amount * SUPER_TAX_RATE).toFixed(2);
    const net = +(action.amount - tax).toFixed(2);
    this.accountService.transaction(sa, net, null);
    return this.newState(
      state,
      { [key]: { ...sa, contributionBasis: sa.contributionBasis + net } },
      [{ type: 'SUPER_CONTRIBUTION_TAX', amount: action.amount, stateKey: key }]
    );
  }
}

/**
 * Non-concessional contribution (design 95 §9.1, phase 6b).
 *
 * After-tax money, and **no Div 295 at all** — it arrives in the fund in full. That
 * single difference is why it cannot ride on `SuperContributionApplyReducer`, which
 * would shave 15% off it: the member already paid tax on this money at their
 * marginal rate, and taxing it again on the way in is the double charge the
 * non-concessional cap exists to ration in the first place.
 *
 * `SuperDownsizerContributionApplyReducer` is the same shape for the same reason,
 * and its comment says it in the same words. The two must agree — a downsizer
 * contribution and an ordinary non-concessional one are both after-tax money in the
 * same pool, and splitting their character would show up later as a fund whose
 * taxable/tax-free proportions depend on which action put the money there.
 */
export class SuperNonConcessionalApplyReducer extends AccountServiceReducer {
  static type        = 'SuperNonConcessionalApplyReducer';
  static description = 'Debits the AU cash pool and credits the member\'s super account with a non-concessional contribution IN FULL — no Div 295 15% withholding and no deduction (Div 292 cap only).';
  static actionType  = 'SUPER_NON_CONCESSIONAL_APPLY';

  constructor({ accountService, stateRegistry }) {
    super('Super Non-Concessional Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes = ['SUPER_NON_CONCESSIONAL_APPLY'];
  }

  reduce(state, action) {
    const key = action.stateKey ?? 'superAccount';
    const sa  = state[key];
    if (!sa || !(action.amount > 0)) return this.newState(state);

    const auCashKey = resolveCashKey(this.stateRegistry, 'AU', state);
    this.accountService.transaction(state[auCashKey], -action.amount, null);
    // Design 87 §14.4 item 3 — the AUD leaving the cash pool is disposed of, on
    // exactly the terms `SuperContributionApplyReducer` sets out: super is outside
    // design 87 (§5) so there is no carryover leg, and a retirement contribution has
    // no §162/§212 expenses allocable to it, so it falls to the personal branch.
    action.section988 = { kind: 'DISPOSE', accountKey: auCashKey, businessFraction: 0 };

    this.accountService.transaction(sa, action.amount, null);
    return this.newState(
      state,
      { [key]: { ...sa, contributionBasis: sa.contributionBasis + action.amount } },
    );
  }
}

/**
 * The one place `auSuperCapsByPerson` is written during the year (design 95 §9.2-9.5,
 * phase 7).
 *
 * ─── why one reducer and not four accumulations ─────────────────────────────
 * Div 291 rations THREE streams against ONE pool, and Div 292 a fourth against
 * another. Four separate accumulations, each living beside the reducer that moves
 * that stream's money, is four chances for the pool to be counted differently — and
 * the failure mode is silent, because a cap that is fed too little simply never
 * binds. So every stream that consumes a cap reports here, and this is the only
 * writer between one 30 June and the next. The settle owns the year boundary
 * (`_auSuperCapsRoll`), and owns it alone for the same reason the Div 36 loss pool
 * does: the roll is not an accumulation and must happen exactly once.
 *
 * The record is per person and shaped `{ concessionalYTD, sgYTD, nonConcessionalYTD,
 * qualifyingEarningsYTD, unusedByFy, tsbAtFyStart, bringForward }`. The first four
 * reset each financial year; the last three deliberately survive it.
 *
 * **A contribution with no `personKey` is ignored, not attributed to anybody.** The
 * standalone `SuperContributionHandler` (EVT-20, a hand-authored event) emits one,
 * and the caps are per-INDIVIDUAL: guessing an owner would ration one member's cap
 * against another's contributions.
 */
export class AuSuperCapsAccumulateReducer extends Reducer {
  static type        = 'AuSuperCapsAccumulateReducer';
  static category    = 'reducer';
  static description = 'Accumulates each person\'s concessional, non-concessional and qualifying-earnings totals for the AU financial year (design 95 phase 7).';
  static actionType  = null;

  static ACTION_TYPES = [
    'SUPER_CONTRIBUTION_APPLY', 'SUPER_SACRIFICE_APPLY',
    'SUPER_NON_CONCESSIONAL_APPLY', 'AU_QUALIFYING_EARNINGS_APPLY',
  ];

  constructor() {
    super('AU Super Caps Accumulate', PRIORITY.METRICS);
    this.reducedActionTypes = [...AuSuperCapsAccumulateReducer.ACTION_TYPES];
  }

  /**
   * Which running totals this action feeds. Usually one; the Super Guarantee feeds
   * TWO, because `superGuaranteeAnnualCap` is a cap on the EMPLOYER's contribution
   * and the concessional pool is shared with the member's own streams. Measuring an
   * employer cap against the shared pool made it bind every month on a scenario
   * whose SG was nowhere near it.
   *
   * @returns {string[]}
   */
  static fieldsFor(action) {
    switch (action.type) {
      case 'SUPER_CONTRIBUTION_APPLY':
        return action.employerFunded === true
          ? ['concessionalYTD', 'sgYTD']
          : ['concessionalYTD'];
      case 'SUPER_SACRIFICE_APPLY':        return ['concessionalYTD'];
      case 'SUPER_NON_CONCESSIONAL_APPLY': return ['nonConcessionalYTD'];
      case 'AU_QUALIFYING_EARNINGS_APPLY': return ['qualifyingEarningsYTD'];
      default:                             return [];
    }
  }

  reduce(state, action) {
    const fields = AuSuperCapsAccumulateReducer.fieldsFor(action);
    const key    = action.personKey;
    const amount = action.amount ?? 0;
    if (fields.length === 0 || key == null || !(amount > 0)) return this.newState(state);

    const all  = state.auSuperCapsByPerson ?? {};
    const prev = all[key] ?? {};
    const rec  = { ...prev };
    for (const f of fields) rec[f] = +(((prev[f] ?? 0) + amount).toFixed(2));
    // Remember WHICH fund this person's contributions went to. The settle needs it to
    // snapshot their total superannuation balance, and it has no StateRegistry to
    // resolve the role with — so recording the key the handler already resolved beats
    // reconstructing it from a naming convention that is wrong for any scenario whose
    // super account is named something else.
    if (action.stateKey != null) rec.superKey = action.stateKey;
    return this.newState({
      ...state,
      auSuperCapsByPerson: { ...all, [key]: rec },
    });
  }
}

/**
 * EVT-21: Super contribution withdrawal — age-gated (blocked before 60).
 * No tax on successful withdrawal.
 */
export class SuperWithdrawalContribApplyReducer extends AccountServiceReducer {
  static type        = 'SuperWithdrawalContribApplyReducer';
  static description = 'Credits the AU cash pool and debits superAccount contributionBasis; blocks withdrawal if person is under 60.';
  static actionType  = 'SUPER_WITHDRAWAL_CONTRIB_APPLY';

  constructor({ accountService, stateRegistry }) {
    super('Super Contribution Withdrawal Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes = ['SUPER_WITHDRAWAL_CONTRIB_APPLY'];
  }

  reduce(state, action) {
    const { amount, blocked } = action;
    if (blocked) {
      return this.newState(state, { superWithdrawalBlocked: true });
    }
    this.accountService.transaction(state[resolveCashKey(this.stateRegistry, 'AU', state)], amount, null);
    const sa = state.superAccount;
    this.accountService.transaction(sa, -amount, null);
    return this.newState(state, {
      superWithdrawalBlocked: false,
      superAccount: { ...sa, contributionBasis: sa.contributionBasis - amount },
    });
  }
}

/**
 * EVT-22: Super earnings withdrawal — age-gated.
 * Chains SUPER_WITHDRAWAL_EARNINGS_TAX (US ordinary income).
 */
export class SuperWithdrawalEarningsApplyReducer extends AccountServiceReducer {
  static type        = 'SuperWithdrawalEarningsApplyReducer';
  static description = 'Credits the AU cash pool and debits superAccount earningsBasis; chains SUPER_WITHDRAWAL_EARNINGS_TAX; blocks if under 60.';
  static actionType  = 'SUPER_WITHDRAWAL_EARNINGS_APPLY';

  constructor({ accountService, stateRegistry }) {
    super('Super Withdrawal Earnings Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes   = ['SUPER_WITHDRAWAL_EARNINGS_APPLY'];
    this.generatedActionTypes = ['SUPER_WITHDRAWAL_EARNINGS_TAX'];
  }

  reduce(state, action) {
    const { amount, blocked } = action;
    if (blocked) {
      return this.newState(state, { superWithdrawalBlocked: true });
    }
    this.accountService.transaction(state[resolveCashKey(this.stateRegistry, 'AU', state)], amount, null);
    const sa = state.superAccount;
    this.accountService.transaction(sa, -amount, null);
    return this.newState(
      state,
      {
        superWithdrawalBlocked: false,
        superAccount: { ...sa, earningsBasis: sa.earningsBasis - amount },
      },
      [{ type: 'SUPER_WITHDRAWAL_EARNINGS_TAX', amount }]
    );
  }
}

/**
 * EVT-23: Super earnings accrual — stay in account.
 * Chains SUPER_EARNINGS_TAX (AU super tax at 15%).
 *
 * Design 77 §5.1 — `action.amount` arrives already NET of the fund's 15% earnings
 * tax (SuperEarningsHandler withholds it by growing the holdings at
 * `rate × (1 − taxRate)`), so this reducer credits the net and the balance never
 * carries a tax the fund has in fact already paid. `action.grossAmount` is the
 * pre-tax base, forwarded to the classifier so `auSuperTaxYTD` records the levy.
 * Absent on pre-77 serialized actions ⇒ falls back to `amount`, reproducing the
 * old (gross-credit, gross-base) arithmetic exactly.
 *
 * Design 90 §8.4 — `action.frankingCredit` is the gross franking credit on the fund's AU
 * dividends. `amount` already includes the part of it the member keeps; it is forwarded
 * so the classifier can book the fund's refund. Absent ⇒ 0, the pre-§8.4 arithmetic.
 */
export class SuperEarningsApplyReducer extends AccountServiceReducer {
  static type        = 'SuperEarningsApplyReducer';
  static description = 'Adds earnings NET of the 15% Div 295 fund earnings tax to superAccount balance and earningsBasis; chains SUPER_EARNINGS_TAX on the gross.';
  static actionType  = 'SUPER_EARNINGS_APPLY';

  constructor({ accountService, stateRegistry }) {  // accountService unused but accepted for API symmetry
    super('Super Earnings Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes   = ['SUPER_EARNINGS_APPLY'];
    this.generatedActionTypes = ['SUPER_EARNINGS_TAX'];
  }

  reduce(state, action) {
    const key = action.stateKey ?? 'superAccount';
    const sa = state[key];
    // Negative year: charge the loss to earnings before corpus (design 84 G12). The
    // handler sends `grossAmount: 0` on a loss, so the chained SUPER_EARNINGS_TAX
    // below is levied on a zero base rather than refunding a phantom Div 295 credit.
    const ledger = action.amount < 0
      ? debitLedgerForLoss(sa, -action.amount)
      : { earningsBasis: sa.earningsBasis + action.amount, contributionBasis: sa.contributionBasis };
    return this.newState(
      state,
      {
        [key]: {
          ...sa,
          ...ledger,
          balance: Math.max(0, sa.balance + action.amount),
        },
      },
      [{
        type: 'SUPER_EARNINGS_TAX',
        amount: action.grossAmount ?? action.amount,
        frankingCredit: action.frankingCredit ?? 0,
        stateKey: key,
        taxRate: action.taxRate,
      }]
    );
  }
}

/**
 * The discount a complying super fund takes on a discount capital gain: one third,
 * ITAA 1997 s115-100(b). 15% × (1 − ⅓) is the familiar 10%.
 */
export const SUPER_CGT_DISCOUNT = 1 / 3;

/**
 * A complying fund's net capital gain for the income year so far (design 105), by the
 * s102-5(1) method statement:
 *
 *   Step 1 — this year's capital losses reduce this year's capital gains;
 *   Step 2 — the net capital losses carried from earlier years (s102-10, applied in
 *            the order made, s102-15) reduce what is left;
 *   Step 5 — the discount (s115-100(b)) applies to the discount gains that remain.
 *            Steps 3–4 quarantine residential amounts, which a fund's shares never are.
 *
 * Losses are applied to NON-discount gains first. That order leaves the most discount
 * standing, and Step 1's Note 3 leaves the order within a category to the taxpayer: a
 * fund's shares all fall in the single non-residential category.
 *
 * @returns {number} the net capital gain, never negative
 */
export function superNetCapitalGain({ discountableGain = 0, otherGain = 0, capitalLoss = 0, carriedLoss = 0 } = {}) {
  let losses       = Math.max(0, capitalLoss) + Math.max(0, carriedLoss);
  const other      = Math.max(0, otherGain - losses);
  losses           = Math.max(0, losses - otherGain);
  const discounted = Math.max(0, discountableGain - losses);
  return other + discounted * (1 - SUPER_CGT_DISCOUNT);
}

/** The loss an income year carries forward: its unused carried loss plus its own net loss. */
function _lossCarriedOutOf(ytd) {
  if (!ytd) return 0;
  return Math.max(0, +((ytd.carriedLoss ?? 0) + (ytd.capitalLoss ?? 0)
    - (ytd.discountableGain ?? 0) - (ytd.otherGain ?? 0)).toFixed(2));
}

/**
 * The fund's tax rate on INCOME derived on `date` for the member of `account`: 15% in
 * accumulation, 0% in pension phase (the age-60 proxy, `superEarningsTaxRate`). Shared by
 * the reducers that tax fund income they did not compute in a super handler: bond
 * coupons and accretion (design 105 §8).
 */
export function superFundTaxRateOn(state, account, date) {
  const asOf = date instanceof Date ? date : (date != null ? new Date(date) : null);
  return superEarningsTaxRate(_memberAgeOn(state, account, asOf));
}

/** The fund member's whole years of age on `asOf`; 0 when unknown (accumulation). */
function _memberAgeOn(state, account, asOf) {
  if (!asOf) return 0;
  const people    = state.people ?? {};
  const keys      = Object.keys(people);
  const personKey = keys.find(k => people[k]?.id != null && people[k].id === account?.ownerId)
    ?? (account?.ownerId != null && people[account.ownerId] ? account.ownerId : keys[0]);
  const bd = personKey != null ? getBirthDate(state, personKey) : null;
  if (!bd) return 0;
  const years = asOf.getUTCFullYear() - bd.getUTCFullYear();
  const hadBirthday = asOf.getUTCMonth() > bd.getUTCMonth()
    || (asOf.getUTCMonth() === bd.getUTCMonth() && asOf.getUTCDate() >= bd.getUTCDate());
  return hadBirthday ? years : years - 1;
}

/**
 * Design 105 — a super fund's capital gains, taxed on REALISATION.
 *
 * SUPER_CAPITAL_GAIN comes from the rebalancer's sale of super lots: the gain on each
 * lot, split by the 12-month discount test (s115-25), with losses kept. This reducer adds
 * it to the fund's income-year tally (`capitalGainsYTD`), re-works the year's net capital
 * gain (`superNetCapitalGain`), and withholds 15% of the CHANGE from the fund. So a
 * later loss in the same year gives back tax an earlier gain drew.
 *
 * A BOND lot's gain or loss is not capital (design 105 §8): s295-85(3)(b)(i) lets the
 * ordinary-income rules apply to a fund's bond, and TOFA (s230-15) does the same for a
 * fund of 100 million or more. It arrives as a signed `revenueGain`, is taxed at 15% with
 * no discount, and a revenue LOSS reduces the year's taxable income, capital gains
 * included, so it is refunded at 15% straight away (a fund always has other income for it
 * to absorb). A capital loss never reduces revenue gains, which the arithmetic keeps:
 * `netGain` is floored at 0 before `revenueGain` is added.
 *
 * The fund pays from fund assets (design 77 §5.1): balance and holdings fall pro rata,
 * and the tax comes off earnings first. The change is chained as SUPER_EARNINGS_TAX, so
 * it reaches `auPersonSuperTaxYTD`, `fundTax` and `cumulativeTaxesPaid` with the rest of
 * the fund's tax.
 *
 * Pension phase (member ≥ 60, the model's proxy): the gain AND the loss are disregarded
 * (s118-320), so nothing is recorded.
 *
 * The tally rolls over lazily, on the first disposal in a new AU income year, carrying
 * forward whatever loss the old year did not use.
 */
export class SuperCapitalGainApplyReducer extends Reducer {
  static type        = 'SuperCapitalGainApplyReducer';
  static description = 'Nets a super fund\'s realised capital gain into its income-year tally (one-third discount, losses carried forward), withholds 15% of the change in net capital gain from the fund and chains SUPER_EARNINGS_TAX; disregarded in pension phase.';
  static actionType  = 'SUPER_CAPITAL_GAIN';

  constructor() {
    super('Super Capital Gain Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes   = ['SUPER_CAPITAL_GAIN'];
    this.generatedActionTypes = ['SUPER_EARNINGS_TAX'];
  }

  reduce(state, action, date) {
    const key = action.stateKey ?? 'superAccount';
    const sa  = state[key];
    if (!sa) return this.newState(state);
    const asOf = date instanceof Date ? date : (date != null ? new Date(date) : null);
    if (superEarningsTaxRate(_memberAgeOn(state, sa, asOf)) === 0) return this.newState(state);

    const prev = sa.capitalGainsYTD ?? null;
    const fy   = asOf ? auFinancialYearOf(asOf) : (prev?.fy ?? null);
    const base = prev && prev.fy === fy ? prev
      : { fy, discountableGain: 0, otherGain: 0, capitalLoss: 0, carriedLoss: _lossCarriedOutOf(prev), netGain: 0, revenueGain: 0 };
    const next = {
      ...base,
      discountableGain: +(base.discountableGain + (action.discountableGain ?? 0)).toFixed(2),
      otherGain:        +(base.otherGain        + (action.otherGain        ?? 0)).toFixed(2),
      capitalLoss:      +(base.capitalLoss      + (action.capitalLoss      ?? 0)).toFixed(2),
      revenueGain:      +((base.revenueGain ?? 0) + (action.revenueGain    ?? 0)).toFixed(2),
    };
    next.netGain = +superNetCapitalGain(next).toFixed(2);
    // The year's taxable amount from disposals: the net capital gain (never negative) plus
    // the signed revenue gain on bonds.
    const gainDelta = +((next.netGain + next.revenueGain) - (base.netGain + (base.revenueGain ?? 0))).toFixed(2);
    const tax       = +(gainDelta * SUPER_TAX_RATE).toFixed(2);
    if (tax === 0) return this.newState(state, { [key]: { ...sa, capitalGainsYTD: next } });

    const newBalance = +(sa.balance - tax).toFixed(2);
    const ledger = tax > 0
      ? debitLedgerForLoss(sa, tax)
      : { earningsBasis: +((sa.earningsBasis ?? 0) - tax).toFixed(2) };
    return this.newState(
      state,
      {
        [key]: {
          ...sa, ...ledger,
          balance:  newBalance,
          holdings: scaleHoldings(sa.holdings, sa.balance, newBalance, lotVintage(state, sa)),
          capitalGainsYTD: next,
        },
      },
      [{ type: 'SUPER_EARNINGS_TAX', amount: gainDelta, stateKey: key, taxRate: SUPER_TAX_RATE }],
    );
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export class SuperContributionHandler extends HandlerEntry {
  static type        = 'SuperContributionHandler';
  static description = 'Dispatches SUPER_CONTRIBUTION_APPLY.';
  static eventType   = 'SUPER_CONTRIBUTION';

  constructor() {
    super(null, 'Super Contribution');
    this.generatedActionTypes = ['SUPER_CONTRIBUTION_APPLY', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    if (state?.contributionsSuspended) return [];
    return [
      { type: 'SUPER_CONTRIBUTION_APPLY', amount: data.amount },
      new RecordBalanceAction('superAccount.balance', 'superAccount'),
    ];
  }
}

export class SuperWithdrawalContributionsHandler extends HandlerEntry {
  static type        = 'SuperWithdrawalContributionsHandler';
  static description = 'Age-gates the request (blocks under 60) and dispatches SUPER_WITHDRAWAL_CONTRIB_APPLY.';
  static eventType   = 'SUPER_WITHDRAWAL_CONTRIBUTIONS';

  constructor({ ownerId = null } = {}) {
    super(null, 'Super Withdrawal Contributions');
    this.ownerId = ownerId;
    this.generatedActionTypes = ['SUPER_WITHDRAWAL_CONTRIB_APPLY', 'RECORD_BALANCE'];
  }

  static fromJSON(d, ctx) { const h = new this({ ownerId: d.ownerId ?? null }); h.id = d.id; return h; }
  toJSON() { return { ...super.toJSON(), ownerId: this.ownerId }; }

  call({ date, state, data }) {
    const personKey = this.ownerId ?? Object.keys(state.people ?? {})[0];
    const birthDate = getBirthDate(state, personKey);
    const age     = birthDate ? getAge(birthDate, date) : 0;
    const blocked = age < 60;
    return [
      { type: 'SUPER_WITHDRAWAL_CONTRIB_APPLY', amount: data.amount, blocked },
      new RecordBalanceAction('superAccount.balance', 'superAccount'),
    ];
  }
}

export class SuperWithdrawalEarningsHandler extends HandlerEntry {
  static type        = 'SuperWithdrawalEarningsHandler';
  static description = 'Age-gates the request (blocks under 60) and dispatches SUPER_WITHDRAWAL_EARNINGS_APPLY.';
  static eventType   = 'SUPER_WITHDRAWAL_EARNINGS';

  constructor({ ownerId = null } = {}) {
    super(null, 'Super Withdrawal Earnings');
    this.ownerId = ownerId;
    this.generatedActionTypes = ['SUPER_WITHDRAWAL_EARNINGS_APPLY', 'RECORD_BALANCE'];
  }

  static fromJSON(d, ctx) { const h = new this({ ownerId: d.ownerId ?? null }); h.id = d.id; return h; }
  toJSON() { return { ...super.toJSON(), ownerId: this.ownerId }; }

  call({ date, state, data }) {
    const personKey = this.ownerId ?? Object.keys(state.people ?? {})[0];
    const birthDate = getBirthDate(state, personKey);
    const age     = birthDate ? getAge(birthDate, date) : 0;
    const blocked = age < 60;
    return [
      { type: 'SUPER_WITHDRAWAL_EARNINGS_APPLY', amount: data.amount, blocked },
      new RecordBalanceAction('superAccount.balance', 'superAccount'),
    ];
  }
}

export class SuperEarningsDirectHandler extends HandlerEntry {
  static type        = 'SuperEarningsDirectHandler';
  static description = 'Dispatches SUPER_EARNINGS_APPLY from a direct SUPER_EARNINGS event (as opposed to the scheduled INTL_SUPER_EARNINGS path).';
  static eventType   = 'SUPER_EARNINGS';

  constructor() {
    super(null, 'Super Earnings');
    this.generatedActionTypes = ['SUPER_EARNINGS_APPLY', 'RECORD_BALANCE'];
  }

  /**
   * `data.amount` is GROSS fund earnings, matching the scheduled
   * INTL_SUPER_EARNINGS path. Design 77 §5.1 applies the same pension-phase gate
   * and the same net crediting here, so an injected earnings event and a computed
   * one cannot disagree about what the member ends up with. Without the gate this
   * path taxed a 70-year-old's fund earnings at 15%.
   */
  call({ data, state, date }) {
    const gross     = data.amount;
    const personKey = Object.keys(state?.people ?? {})[0];
    const birthDate = getBirthDate(state, personKey);
    const age       = birthDate && date ? getAge(birthDate, date) : 0;
    const taxRate   = superEarningsTaxRate(age);
    const net       = +(gross * (1 - taxRate)).toFixed(2);
    return [
      { type: 'SUPER_EARNINGS_APPLY', amount: net, grossAmount: gross, taxRate },
      new RecordBalanceAction('superAccount.balance', 'superAccount'),
    ];
  }
}
