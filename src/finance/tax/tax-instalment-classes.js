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
 * Design 107 §6–§8 — PAYING TAX IN INSTALMENTS.
 *
 * Both countries get the same three pieces, differing only in calendar and arithmetic:
 * an event on the statutory due dates, a required-payment basis carried in state from the
 * last settle, and a credit at the settle so only the true-up moves.
 *
 * ─── why this is not "a nicer tax schedule" ──────────────────────────────────
 *
 * Without it the whole year's liability is one debit on the settle date, funded by a
 * `replenishSavings` draw on that same date. One date's market price therefore sets what the
 * household must liquidate to pay a bill computed on the *previous* twelve months, in every
 * path, by construction — a crash landing in December is met by selling at the bottom. Real
 * taxpayers in both countries pay across the year, and the law says exactly how much to pay
 * to avoid a penalty.
 *
 * ─── the two regimes are NOT the same idea in different words ────────────────
 *
 *   US §6654(d)(1)(B)(ii): four instalments of 25% of the lesser of 90% of this year's tax
 *   or **100% of last year's**, and (C)(i) substitutes **110%** when the prior return's AGI
 *   exceeded \$150,000. That basis is last year's whole tax, capital gains included — so the
 *   prior-year safe harbour is a COMPLETE answer: pay it and no addition to tax can arise
 *   however large this year's gain.
 *
 *   AU s 45-400(2): 25/50/75/100% of GDP-adjusted notional tax, cumulative. But s 45-330(1)(a)
 *   **excludes net capital gain from the base**, and s 45-5(3) says so as policy. So the AU
 *   regime deliberately under-collects from a retiree funding spending by realising gains, and
 *   expects a balancing payment at assessment. A cross-border household experiences both.
 *
 * Sources on disk, and nothing here is quoted from memory:
 * `docs/us-tax/USCODE-2024-title26-subtitleF-chap68-subchapA-partI-sec6654.txt`,
 * `docs/au-tax/TAA-1953/C2026C00393VOL02.txt` (Division 45).
 */

import { HandlerEntry } from '../../simulation-framework/handlers.js';
import { Reducer, PRIORITY } from '../../simulation-framework/reducers.js';
import { ACCOUNT_ROLES } from '../state/account-roles.js';

/**
 * §6654(e)(1) — no addition to tax where the year's tax, reduced by the §31 credit, is under
 * \$1,000. Modelled as a floor below which no instalment is raised at all: a household under
 * it has nothing to gain from paying early and the real one does not bother.
 */
export const US_DE_MINIMIS_TAX = 1000;

/**
 * The share of the required annual payment due by the END of each instalment quarter.
 *
 * Both regimes are stated cumulatively and both come to the same four numbers, which is a
 * coincidence of arithmetic rather than a shared rule: §6654(d)(1)(A) says each of the four
 * required instalments is 25% of the required annual payment, while s 45-400(2)'s table says
 * the n-th instalment is n×25% of GDP-adjusted notional tax *reduced by what was already
 * paid*. Expressed cumulatively they coincide, and expressing them that way is what makes a
 * mid-year change of basis self-correcting — which s 45-400(2) intends and §6654 does not
 * forbid.
 */
const CUMULATIVE_SHARE = [0.25, 0.50, 0.75, 1.00];

/**
 * What the household must have paid by instalment `n` (1-based), given the year's basis.
 * Returns the INCREMENT for that instalment, never negative: an earlier over-payment reduces
 * the next instalment to zero rather than generating a refund mid-year, which is what both
 * regimes do.
 */
export function instalmentIncrement(basisAmount, n, alreadyPaid) {
  const share = CUMULATIVE_SHARE[Math.min(Math.max(n, 1), 4) - 1];
  return Math.max(0, basisAmount * share - Math.max(0, alreadyPaid));
}

/**
 * The US required annual payment — §6654(d)(1)(B)(ii) with (C)(i)'s uplift.
 *
 * Returns 0 when there is no prior-year basis. That is not a failure: §6654(e)(2) waives the
 * addition entirely where the preceding year was a full 12 months with NO liability, and a
 * household with no basis at all — the first year of the run, or the first year of US filing —
 * is in the same position of having nothing to compute from. The balance simply falls due at
 * the settle, which is what actually happens to a new filer.
 */
export function usRequiredAnnualPayment(basis) {
  const tax = basis?.tax ?? 0;
  if (!(tax > US_DE_MINIMIS_TAX)) return 0;
  // (C)(i): "$150,000" on the PRIOR year's return, and it is AGI, not taxable income.
  const uplift = (basis?.agi ?? 0) > 150_000 ? 1.10 : 1.00;
  return tax * uplift;
}

/**
 * AU GDP-adjusted notional tax — s 45-405(1)–(3).
 *
 * `notionalTaxOf` is the caller's re-taxing of the base year's adjusted taxable income; this
 * function only applies the uplift, because that is the whole of what s 45-405 adds to
 * s 45-325. The uplift is authored (`auGdpUplift`) rather than derived: the model has AU CPI
 * and no real-GDP series, and the settle trues up exactly (s 45-30), so the figure moves only
 * the TIMING of cash and is not worth a new state dependency. See design 107 §15.2.
 */
export function auGdpAdjustedNotionalTax(notionalTax, gdpUplift) {
  // s 45-405(3)(b): a negative GDP adjustment reads as 0%, never as a reduction.
  return Math.max(0, notionalTax) * (1 + Math.max(0, gdpUplift ?? 0));
}

/**
 * Fires on each statutory instalment date and raises the payment.
 *
 * It carries the QUARTER, not an amount: the amount depends on what earlier instalments
 * already paid, and that lives in state where the settle can credit it. Computing it here
 * would put the running total in two places.
 */
export class TaxInstalmentHandlerBase extends HandlerEntry {
  static cc;
  static actionType;

  constructor({ quarter = 1 } = {}) {
    super(null, `${new.target.cc} Tax Instalment Q${quarter}`);
    this.quarter = quarter;
    this.generatedActionTypes = [new.target.actionType];
  }

  toJSON() { return { ...super.toJSON(), quarter: this.quarter }; }

  static fromJSON(d) {
    const h = new this({ quarter: d.quarter ?? 1 });
    h.id = d.id;
    return h;
  }

  call({ state }) {
    const amount = this.constructor.amountFor(state, this.quarter);
    if (!(amount > 0.01)) return [];
    return [{ type: this.constructor.actionType, amount: +amount.toFixed(2), quarter: this.quarter }];
  }
}

export class UsTaxInstalmentHandler extends TaxInstalmentHandlerBase {
  static type        = 'UsTaxInstalmentHandler';
  static category    = 'handler';
  static cc          = 'US';
  // A fallback only — `_wireHandler` prefers `handledEvents`, which the tax service fills
  // with this instance's own quarter (`TAX_INSTALMENT_US_Q1`…`_Q4`, one type each).
  static eventType   = 'TAX_INSTALMENT_US_Q1';
  static actionType  = 'US_TAX_INSTALMENT_DEBIT';
  static description = 'Design 107 §7: raises one of the four §6654(c)(2) estimated-tax instalments, sized from the prior year\'s return under §6654(d)(1)(B)(ii) and (C)(i).';

  static amountFor(state, quarter) {
    const required = usRequiredAnnualPayment(state?.taxBasis?.US);
    return instalmentIncrement(required, quarter, state?.taxInstalmentsPaid?.US ?? 0);
  }
}

export class AuTaxInstalmentHandler extends TaxInstalmentHandlerBase {
  static type        = 'AuTaxInstalmentHandler';
  static category    = 'handler';
  static cc          = 'AU';
  static eventType   = 'TAX_INSTALMENT_AU_Q1';
  static actionType  = 'AU_TAX_INSTALMENT_DEBIT';
  static description = 'Design 107 §8: raises one of the four s 45-61 PAYG instalments, sized from GDP-adjusted notional tax (s 45-400(2), s 45-405) on a base that EXCLUDES net capital gain (s 45-330(1)(a)).';

  /**
   * Summed across the living members, because the basis is per person (each gets their own
   * instalment rate from the Commissioner) while the household pays from one pool of cash.
   *
   * `auNotionalTaxRate` is a flat re-taxing of the base-year income. s 45-325 wants the base
   * year's ADJUSTED TAX on that income, i.e. the progressive scale applied again — which the
   * settle service could compute exactly. Doing that here would mean re-entering the AU tax
   * engine on a counterfactual state from inside a handler, and the error a flat rate makes is
   * absorbed completely by the balancing payment (s 45-30). Stated, not hidden.
   */
  static amountFor(state, quarter) {
    const perPerson = state?.taxBasis?.AU ?? {};
    const rate      = state?.auNotionalTaxRate ?? 0;
    let notional = 0;
    for (const key of Object.keys(perPerson)) {
      if (state?.people?.[key] == null) continue;      // dropped at death; never resurrect one
      notional += Math.max(0, perPerson[key]?.instalmentBase ?? 0) * rate;
    }
    const required = auGdpAdjustedNotionalTax(notional, state?.auGdpUplift);
    return instalmentIncrement(required, quarter, state?.taxInstalmentsPaid?.AU ?? 0);
  }
}

/**
 * Records an instalment as paid, then hands the cash movement to the country's ordinary tax
 * payment debit.
 *
 * Re-emitting `<CC>_TAX_PAYMENT_DEBIT` rather than moving the money here is the point. That
 * reducer already funds a shortfall through `replenishSavings`, already emits the drawdown tax
 * actions so that selling to pay tax is itself taxed, already handles the cross-border
 * escalation, and already stamps the §988 disposition for paying out of a foreign-currency
 * deposit. A second debit path that bypassed any of that would produce a believable untaxed
 * number, which this repo has found three separate times.
 */
export class TaxInstalmentDebitReducerBase extends Reducer {
  static cc;
  static actionType;
  static paymentActionType;

  constructor() {
    const cc = new.target.cc;
    super(`${cc} Tax Instalment`, PRIORITY.TAX_APPLY + 1);
    this.reducedActionTypes   = [new.target.actionType];
    this.generatedActionTypes = [new.target.paymentActionType];
  }

  static fromJSON(d) {
    const r = new this();
    r.id = d.id;
    return r;
  }

  reduce(state, action) {
    const cc     = this.constructor.cc;
    const amount = Math.max(0, action.amount ?? 0);
    if (!(amount > 0)) return this.newState(state);
    return this.newState(state, {
      taxInstalmentsPaid: { ...(state.taxInstalmentsPaid ?? {}), [cc]: (state.taxInstalmentsPaid?.[cc] ?? 0) + amount },
    }, [{ type: this.constructor.paymentActionType, amount }]);
  }
}

export class UsTaxInstalmentDebitReducer extends TaxInstalmentDebitReducerBase {
  static type              = 'UsTaxInstalmentDebitReducer';
  static category          = 'reducer';
  static cc                = 'US';
  static actionType        = 'US_TAX_INSTALMENT_DEBIT';
  static paymentActionType = 'US_TAX_PAYMENT_DEBIT';
  static description       = 'Accumulates state.taxInstalmentsPaid.US and chains US_TAX_PAYMENT_DEBIT so the instalment is funded through the same draw, tax and §988 path as any other tax payment.';
}

export class AuTaxInstalmentDebitReducer extends TaxInstalmentDebitReducerBase {
  static type              = 'AuTaxInstalmentDebitReducer';
  static category          = 'reducer';
  static cc                = 'AU';
  static actionType        = 'AU_TAX_INSTALMENT_DEBIT';
  static paymentActionType = 'AU_TAX_PAYMENT_DEBIT';
  static description       = 'Accumulates state.taxInstalmentsPaid.AU and chains AU_TAX_PAYMENT_DEBIT so the instalment is funded through the same draw, tax and §988 path as any other tax payment.';
}

/**
 * Credits a tax refund back to the country's cash account.
 *
 * The mirror of `TaxPaymentDebitReducerBase` and deliberately much smaller: a refund needs no
 * `replenishSavings` (money is arriving, not leaving), no cross-border escalation and no
 * OUT_OF_FUNDS path. It DOES need the §988 declaration for the same reason the debit does —
 * receiving foreign currency establishes basis in it — which `transaction()` handles as an
 * ordinary credit without a disposition to declare.
 */
export class TaxRefundCreditReducerBase extends Reducer {
  static cc;
  static actionType;
  static savingsRole;

  constructor({ accountService, stateRegistry }) {
    super(`${new.target.cc} Tax Refund Credit`, PRIORITY.TAX_APPLY + 1);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes   = [new.target.actionType];
    this.generatedActionTypes = ['RECORD_BALANCE'];
  }

  static fromJSON(d, services) {
    const r = new this(services);
    r.id = d.id;
    return r;
  }

  reduce(state, action, date) {
    const amount = Math.max(0, action.amount ?? 0);
    if (!(amount > 0)) return this.newState(state);
    const accountKey  = this.stateRegistry.getStateKey(this.constructor.savingsRole);
    const cashAccount = state[accountKey];
    // No account to refund INTO is not an insolvency — nothing is owed. The money simply has
    // nowhere to land, which is a configuration gap, so it is dropped rather than invented
    // somewhere else.
    if (!cashAccount) return this.newState(state);
    this.accountService.transaction(cashAccount, amount, date);
    return this.newState(state, { [accountKey]: { ...cashAccount } });
  }
}

export class UsTaxRefundCreditReducer extends TaxRefundCreditReducerBase {
  static type        = 'UsTaxRefundCreditReducer';
  static category    = 'reducer';
  static cc          = 'US';
  static actionType  = 'US_TAX_REFUND_CREDIT';
  static savingsRole = ACCOUNT_ROLES.US_SAVINGS;
  static description = 'Credits an over-payment of US estimated tax back to the US cash account at the settle — the refund path the prior-year safe harbour makes routine.';
}

export class AuTaxRefundCreditReducer extends TaxRefundCreditReducerBase {
  static type        = 'AuTaxRefundCreditReducer';
  static category    = 'reducer';
  static cc          = 'AU';
  static actionType  = 'AU_TAX_REFUND_CREDIT';
  static savingsRole = ACCOUNT_ROLES.AU_SAVINGS;
  static description = 'Credits an over-payment of AU PAYG instalments back to the AU cash account at the assessment (s 45-30).';
}
