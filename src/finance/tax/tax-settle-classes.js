/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY }  from '../../simulation-framework/reducers.js';
import { HandlerEntry }        from '../../simulation-framework/handlers.js';
import { TaxSettleService }    from '../tax-settle-service.js';
import { InsufficientFundsError } from '../assets/account.js';
import { ACCOUNT_ROLES } from '../state/account-roles.js';
import { toUSD, toAUD, taxFxRate } from './tax-fx.js';

/** Sum the numeric values of a { key: number } map (per-person accumulators). */
function _sumMap(map) {
  return map ? Object.values(map).reduce((s, v) => s + (v ?? 0), 0) : 0;
}

// YTD fields reset to zero after each annual settlement, keyed by country code.
//
// Design 52 reset asymmetry (§5): the §904/FITO income numerators and the
// current-year foreign-tax handoff reset at their own settle; the carryforward
// pools (ftcPoolGeneral/ftcPoolPassive) and the single-year usTaxPaidOnUsSourceAud
// handoff are DELIBERATELY excluded — the pools carry forward (drawn down + aged
// >10y at the US settle), and usTaxPaidOnUsSourceAud is overwritten each US settle
// and consumed (excess lost) at the next AU settle.
const YTD_FIELDS = {
  US: ['usOrdinaryIncomeYTD', 'usNegativeIncomeYTD', 'usCapitalGainsYTD', 'usCollectibleGainsYTD', 'usNetInvestmentIncomeYTD', 'usPenaltyYTD',
       // design 69 — self-employment tax (SECA) accumulators
       'usSeEarningsYTD', 'usSsWagesYTD',
       'foreignGeneralIncomeYTD', 'foreignPassiveIncomeYTD', 'usSourceOrdinaryUsdYTD', 'usSourceCapGainsUsdYTD',
       'ftcCurrentGeneral', 'ftcCurrentPassive', 'ftcCurrentResourced',
       // design 63 §6.5 — heir-paid NE inheritance tax (reporting bucket; debited at the inheritance date)
       'neInheritanceTaxYTD'],
  AU: ['auOrdinaryIncomeYTD', 'auCapitalGainsYTD', 'auDiscountableGainsYTD', 'auRealCapitalGainsYTD', 'auNonResidentWithholdingYTD', 'auSuperTaxYTD', 'auFrankingCreditYTD',
       // design 73 Gap 2 — per-type non-resident final withholding
       'auNrWithholdingInterestYTD', 'auNrWithholdingUnfrankedDividendYTD',
       'usSourceOrdinaryAudYTD', 'usSourceCapGainsAudYTD', 'usSourceRealCapGainsAudYTD',
       // design 63 §6.4 — AU super death-benefit tax (reporting bucket; withheld from the net lump sum)
       'auSuperDeathTaxYTD'],
};

// Per-person AU accumulator maps reset to zero after each AU settlement.
const PER_PERSON_AU_FIELDS = [
  'auPersonOrdinaryIncomeYTD',
  'auPersonCapitalGainsYTD',
  'auPersonDiscountableGainsYTD',
  'auPersonRealCapitalGainsYTD',
  'auPersonFrankingCreditYTD',
  'auPersonNonResidentWithholdingYTD',
  'auPersonNrWithholdingInterestYTD',
  'auPersonNrWithholdingUnfrankedDividendYTD',
  'auPersonSuperTaxYTD',
  'auPersonEarnedIncomeYTD',
  'auPersonUsSourceOrdinaryAudYTD',
  'auPersonUsSourceCapGainsAudYTD',
  'auPersonUsSourceRealCapGainsAudYTD',
];

// ─── TaxSettleHandler base + per-country subclasses ───────────────────────────

class TaxSettleHandlerBase extends HandlerEntry {
  static cc;
  static settleActionType;

  constructor() {
    super(null, `${new.target.cc} Tax Settle`);
    this._settleService = new TaxSettleService();
    this.generatedActionTypes = [new.target.settleActionType, 'RECORD_BALANCE'];
  }
}

/**
 * Fires at the end of each US tax year (scheduled by TaxService).
 *
 * Computes the US tax liability via TaxSettleService, then emits:
 *   US_TAX_SETTLE_APPLY — resets US YTD fields and chains US_TAX_PAYMENT_DEBIT if tax > 0
 *   RECORD_BALANCE      — captures a post-settlement balance snapshot
 */
export class UsTaxSettleHandler extends TaxSettleHandlerBase {
  static type             = 'UsTaxSettleHandler';
  static category         = 'handler';
  static cc               = 'US';
  static settleActionType = 'US_TAX_SETTLE_APPLY';
  static eventType        = 'TAX_SETTLE_US';
  static description      = 'Computes end-of-year US tax liability and emits US_TAX_SETTLE_APPLY + RECORD_BALANCE.';

  call({ state }) {
    const taxDetail = this._settleService.computeUsTax(state);

    // Design 52 §4.6 — fund the AU FITO. Measure the *marginal* US tax caused by
    // US-source income via a second pure pass (disregard the US-source removal
    // set), and hand it to the AU side in AUD for the next AU FY settle. The
    // with/without pass is exact where a proportional split is not: it holds FEIE
    // and the AU-source FTC constant and reflects that US-source income consumes
    // §904 headroom (removing it raises the foreign fraction in the "without" pass).
    const withoutState = {
      ...state,
      usOrdinaryIncomeYTD: (state.usOrdinaryIncomeYTD ?? 0) - (state.usSourceOrdinaryUsdYTD ?? 0),
      usCapitalGainsYTD:   (state.usCapitalGainsYTD   ?? 0) - (state.usSourceCapGainsUsdYTD ?? 0),
    };
    const usTaxWithout   = this._settleService.computeUsTax(withoutState).netLiability;
    const usTaxOnUsSource = Math.max(0, taxDetail.netLiability - usTaxWithout);
    const usTaxPaidOnUsSourceAud = toAUD(usTaxOnUsSource, 'USD', state);

    return [
      // fxRate rides on the settlement so the return can state the USD/AUD rate
      // behind its converted figures (see taxFxRate for what it does and does
      // not cover). Declared in the US_TAX toolset's action fields, so it
      // survives into `action.data` for the document modules and the CSV export.
      { type: 'US_TAX_SETTLE_APPLY', tax: taxDetail.netLiability, taxDetail, usTaxPaidOnUsSourceAud,
        fxRate: taxFxRate(state) },
      { type: 'RECORD_BALANCE' },
    ];
  }
}

/**
 * Fires at the end of each AU fiscal year (scheduled by TaxService).
 *
 * Computes the AU tax liability via TaxSettleService.  When per-person data is
 * available, uses per-person breakdown; otherwise falls back to household total.
 * Emits:
 *   AU_TAX_SETTLE_APPLY — resets AU YTD fields and chains AU_TAX_PAYMENT_DEBIT if tax > 0
 *   RECORD_BALANCE      — captures a post-settlement balance snapshot
 */
export class AuTaxSettleHandler extends TaxSettleHandlerBase {
  static type             = 'AuTaxSettleHandler';
  static category         = 'handler';
  static cc               = 'AU';
  static settleActionType = 'AU_TAX_SETTLE_APPLY';
  static eventType        = 'TAX_SETTLE_AU';
  static description      = 'Computes end-of-year AU tax liability and emits AU_TAX_SETTLE_APPLY + RECORD_BALANCE.';

  call({ state }) {
    // Same rate on both AU paths as on the US settle — one household, one pair.
    const fxRate = taxFxRate(state);

    // Design 77 §5.4 — the Div 295 fund tax accrued this FY, in AUD. It is NOT part
    // of `tax` (that is the member's own liability, and the only thing
    // AU_TAX_PAYMENT_DEBIT may draw from their cash) but it IS real tax that left
    // the household's wealth, so it rides alongside for `cumulativeTaxesPaid`.
    // Without this the MIN_LIFETIME_TAXES objective would reward shovelling money
    // into super to make a tax it is still paying disappear from the metric.
    const fundTax = (state.auSuperTaxYTD ?? 0) + _sumMap(state.auPersonSuperTaxYTD);

    if (state.auPersonOrdinaryIncomeYTD && Object.keys(state.auPersonOrdinaryIncomeYTD).length > 0) {
      const personTaxDetails = this._settleService.computeAuTaxPerPerson(state);
      if (personTaxDetails.length > 0) {
        const totalTax = personTaxDetails.reduce((sum, p) => sum + p.taxDetail.netLiability, 0);
        return [
          { type: 'AU_TAX_SETTLE_APPLY', tax: totalTax, taxDetail: null, personTaxDetails, fxRate, fundTax },
          { type: 'RECORD_BALANCE' },
        ];
      }
    }
    const taxDetail = this._settleService.computeAuTax(state);
    return [
      { type: 'AU_TAX_SETTLE_APPLY', tax: taxDetail.netLiability, taxDetail, fxRate, fundTax },
      { type: 'RECORD_BALANCE' },
    ];
  }
}

// ─── TaxSettleApplyReducer base + per-country subclasses ─────────────────────

class TaxSettleApplyReducerBase extends Reducer {
  static cc;
  static applyActionType;
  static debitActionType;

  constructor() {
    const cc = new.target.cc;
    super(`${cc} Tax Settle Apply`, PRIORITY.TAX_APPLY);
    this.reducedActionTypes   = [new.target.applyActionType];
    this.generatedActionTypes = [new.target.debitActionType];
  }

  reduce(state, action) {
    const cc = this.constructor.cc;
    const { tax } = action;
    const resets = {};
    for (const field of (YTD_FIELDS[cc] || [])) {
      if (field in state) resets[field] = 0;
    }
    if (cc === 'AU') {
      // design/68 Gap 5: a deceased person's per-person keys must be *dropped*, not
      // just zeroed. computeAuTaxPerPerson already filed their final-year return
      // (Gap 1) before this reducer runs, so by settle time their liability is
      // banked. Leaving a lingering `{deceasedKey: 0}` entry would let any income
      // later mis-attributed to a dead key resurrect a spurious return for someone
      // gone from state.people (Gap 1 signal 2 refiles on any non-zero balance).
      // A person is deceased when they're in state.deceased and no longer living.
      const people   = state.people ?? {};
      const deadKeys = new Set(Object.keys(state.deceased ?? {}).filter(k => people[k] == null));
      for (const field of PER_PERSON_AU_FIELDS) {
        if (state[field]) {
          resets[field] = Object.fromEntries(
            Object.keys(state[field])
              .filter(k => !deadKeys.has(k))
              .map(k => [k, 0]),
          );
        }
      }
    }
    const extra = this._extraStatePatches(state, action);
    if (tax > 0) {
      return this.newState({ ...state, ...resets, ...extra }, {}, [{ type: this.constructor.debitActionType, amount: tax }]);
    }
    return this.newState({ ...state, ...resets, ...extra });
  }

  /**
   * Per-country cross-border-relief state written at the settle, *outside* the
   * YTD reset set (design 52). Default: none. US persists the drawn-down FTC
   * pools + the FITO handoff; AU funds the US §904 current-year foreign tax.
   */
  _extraStatePatches(_state, _action) { return {}; }
}

/**
 * Resets US YTD tax accumulators and, when the computed tax is positive,
 * chains a US_TAX_PAYMENT_DEBIT action to debit the US savings account.
 */
export class UsTaxSettleApplyReducer extends TaxSettleApplyReducerBase {
  static type            = 'UsTaxSettleApplyReducer';
  static category        = 'reducer';
  static cc              = 'US';
  static applyActionType = 'US_TAX_SETTLE_APPLY';
  static debitActionType = 'US_TAX_PAYMENT_DEBIT';
  static description     = 'Resets US YTD tax fields after settlement; persists the drawn-down §904 FTC pools + FITO handoff; chains US_TAX_PAYMENT_DEBIT when tax > 0.';

  /**
   * Persist the per-basket FTC carryforward pools (drawn down + aged in
   * computeTax, design 52 §4.3) and the FITO handoff usTaxPaidOnUsSourceAud
   * (§4.6). ftcCurrent* were consumed and reset with the other YTD fields; their
   * unused remainder is already banked into the pool vintages here.
   */
  _extraStatePatches(state, action) {
    const patches = {};
    const ftc = action.taxDetail?.ftc;
    if (ftc) {
      patches.ftcPoolGeneral   = ftc.nextPoolGeneral   ?? {};
      patches.ftcPoolPassive   = ftc.nextPoolPassive   ?? {};
      patches.ftcPoolResourced = ftc.nextPoolResourced ?? {};
    }
    if (action.usTaxPaidOnUsSourceAud != null) {
      patches.usTaxPaidOnUsSourceAud = action.usTaxPaidOnUsSourceAud;
    }
    return patches;
  }
}

/**
 * Resets AU YTD tax accumulators (including per-person maps) and, when the
 * computed tax is positive, chains an AU_TAX_PAYMENT_DEBIT action to debit
 * the AU savings account.
 */
export class AuTaxSettleApplyReducer extends TaxSettleApplyReducerBase {
  static type            = 'AuTaxSettleApplyReducer';
  static category        = 'reducer';
  static cc              = 'AU';
  static applyActionType = 'AU_TAX_SETTLE_APPLY';
  static debitActionType = 'AU_TAX_PAYMENT_DEBIT';
  static description     = 'Resets AU YTD tax fields after settlement; funds the US §904 current-year foreign tax per basket; chains AU_TAX_PAYMENT_DEBIT when tax > 0.';

  /**
   * Fund the US §904 pools (design 52 §4.4). Apportion the creditable AU liability
   * to the two baskets by AU-source income share, convert to USD, and stage it as
   * the current-year foreign tax the next US settle consumes.
   *
   * One amount is removed before apportioning:
   *
   *   **AU tax on US-SOURCE income** (design 71 §14). Foreign tax on US-source
   *      income is not creditable: §904 exists precisely to stop it, and the US is
   *      the source country here — AU relieves the double tax from its side, via
   *      FITO. `fitoLimit` is exactly this quantity, since the ATO "step 1 − step 2"
   *      calculation is the marginal AU tax on the US-source slice; FITO already
   *   relieved `fito` of it, so `fitoLimit − fito` is what survives inside the AU
   *   net liability.
   *
   * **Super fund tax used to be removed here too, and no longer needs to be.**
   * Design 77 took the Div 295 fund tax out of the AU *member's* net liability
   * entirely (it is withheld inside the fund at accrual), so `action.tax` no longer
   * contains it and subtracting it again would understate the creditable base by
   * the whole amount. The conclusion it encoded is unchanged and still correct: AU
   * super fund tax is **not** a creditable foreign income tax of the member, because
   * §901 credits the person on whom foreign law imposes legal liability
   * (Treas. Reg. §1.901-2(f)) and that person is the fund's trustee, not the member.
   * Design 77 §3.1 carries the reasoning.
   *
   * Removing the US-source amount is the fix for a real over-relief leak. The previous code removed
   * only super tax, on the stated assumption that "FITO has already reduced the AU
   * liability by the US tax on US-source income, so the residual is predominantly
   * AU-source tax". That holds only while FITO fully relieves — i.e. while the US
   * tax on the US-source income is at least the AU tax on it. When AU's rate is the
   * higher one (a large capital gain: ~45% AU against 15–20% US LTCG), most of the
   * AU tax survives FITO and was being staged as creditable foreign tax. The §904
   * limitation then correctly refused to credit it *that year* — but it banked as a
   * 10-year carryforward vintage and was drawn down in later years against genuinely
   * foreign income, so the over-relief was deferred rather than prevented.
   */
  _extraStatePatches(state, action) {
    const usSourceAuTax = _auTaxOnUsSourceIncome(action, state);
    const auCreditable  = Math.max(0, (action.tax ?? 0) - usSourceAuTax);
    const gen   = state.foreignGeneralIncomeYTD ?? 0;
    const pass  = state.foreignPassiveIncomeYTD ?? 0;
    const denom = gen + pass;
    const generalShare = denom > 0 ? gen / denom : 0;
    return {
      ftcCurrentGeneral: toUSD(auCreditable * generalShare,       'AUD', state),
      ftcCurrentPassive: toUSD(auCreditable * (1 - generalShare), 'AUD', state),
      // Design 72 §1 — treaty re-sourcing. The AU tax that FITO did NOT relieve
      // (usSourceAuTax) is AU tax on US-SOURCE income. Excluded from the general/
      // passive baskets above because §904 will not credit foreign tax against
      // US-source income — correct as far as it goes, but previously it was simply
      // DROPPED, so the US and AU taxes on the same gain became additive.
      //
      // The US–AU treaty (Art. 27) re-sources such income to foreign source "as
      // necessary to permit relief from double taxation under Art. 22", for §904
      // limitation purposes only — Form 1116's "certain income re-sourced by
      // treaty" category. So it belongs in its own basket with its own limitation,
      // not in the bin. Result: max(US, AU) rather than US + AU.
      ftcCurrentResourced: toUSD(usSourceAuTax, 'AUD', state),
    };
  }
}

/**
 * AU tax attributable to US-source income that FITO did not relieve, in AUD —
 * the amount the US must not treat as creditable foreign tax (design 71 §14).
 *
 * Sums over the per-person returns (or the single household return). `fitoLimit` is
 * null under the A$1,000 de-minimis shortcut, where the limit is deliberately not
 * computed; those years contribute 0, leaving the prior behavior untouched for
 * amounts too small to matter.
 *
 * @param {object} action  the AU_TAX_SETTLE_APPLY action
 * @returns {number} AUD
 */
function _auTaxOnUsSourceIncome(action, state) {
  const details = action.personTaxDetails?.length > 0
    ? action.personTaxDetails.map(p => p.taxDetail)
    : (action.taxDetail ? [action.taxDetail] : []);
  if (details.length === 0) return 0;

  // Per-person, because the A$1,000 de-minimis test is per-person (design 76 P4).
  //
  // Two ways a person's return can tell us how much of their AU tax sits on
  // US-source income:
  //
  //   (a) fitoLimit computed — the limit IS the AU tax on their US-source income
  //       (ATO "step 1 − step 2"), so the unrelieved part is limit − fito.
  //   (b) fitoLimit null — they fell under the A$1,000 shortcut, where the limit is
  //       deliberately not computed. Apportion their gross AU tax by their own
  //       US-source share of assessable income instead. Approximate (the CGT
  //       discount means gross buckets are not exactly the taxed amounts) but
  //       bounded, and far closer than the zero this used to contribute.
  //
  // This was previously all-or-nothing: the (b) branch fired only when EVERY detail
  // had a null limit, so a MIXED household — one spouse over the threshold, one
  // under — contributed 0 for the under-threshold spouse and silently declared their
  // whole liability to be AU-source, hence creditable. Latent for as long as the
  // even split kept both spouses on the same side of the threshold; design 76 P4's
  // income-share apportionment pushed them apart and FTC-US-9 caught it (~24k of a
  // spouse's AU tax on US-source income leaking into the creditable base).
  const perPersonUsSource = (d) => {
    const usSource = (d?.inputs?.usSourceOrdinary ?? 0) + (d?.inputs?.usSourceCapGains ?? 0);
    const total    = (d?.inputs?.ordinaryIncome   ?? 0) + (d?.inputs?.capitalGains    ?? 0);
    if (!(usSource > 0) || !(total > 0)) return 0;
    const fito     = d?.fito ?? 0;
    const grossTax = (d?.netLiability ?? 0) + fito;
    return Math.max(0, grossTax * Math.min(1, usSource / total) - fito);
  };

  return details.reduce((sum, d) => sum + (d?.fitoLimit != null
    ? Math.max(0, d.fitoLimit - (d.fito ?? 0))   // (a)
    : perPersonUsSource(d)),                     // (b)
    0);
}

// ─── TaxPaymentDebitReducer base + per-country subclasses ────────────────────

class TaxPaymentDebitReducerBase extends Reducer {
  static cc;
  static actionType;
  static savingsRole;

  static fromJSON(d, services) {
    const r = new this(services);
    r.id = d.id;
    return r;
  }

  constructor({ accountService, stateRegistry }) {
    const cc = new.target.cc;
    super(`${cc} Tax Payment Debit`, PRIORITY.TAX_APPLY + 1);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes = [new.target.actionType];
    this.generatedActionTypes = ['INTL_TRANSFER_RECORD', 'INTL_TRANSFER_APPLY', new.target.actionType];
  }

  reduce(state, action, date) {
    const role       = this.constructor.savingsRole;
    const accountKey = this.stateRegistry.getStateKey(role);
    const cashAccount = state[accountKey];
    const currency    = cashAccount?.currency?.code
                        ?? (this.constructor.cc === 'AU' ? 'AUD' : 'USD');

    // Absent-account: this country's canonical savings account may not be wired
    // (e.g. a US person charged a US tax the FTC cannot fully relieve — NIIT — in
    // a scenario holding no US cash account). There is nowhere to draw from, so
    // the entire liability is unpaid — treat it as an OUT_OF_FUNDS event rather
    // than dereferencing an undefined account or silently absorbing the tax.
    if (!cashAccount) {
      return this.newState(state, {}, this._outOfFundsActions(action.amount, currency, date));
    }

    // `escalated` marks the residual debit re-issued AFTER an INTL_TRANSFER_APPLY
    // top-up (below). The cross-border sweep has already run and already reported
    // any still-uncoverable gap as OUT_OF_FUNDS, so this pass only debits what
    // landed — it neither replenishes again nor re-reports the residual (which
    // would double-count and could re-escalate without bound).
    const escalated = action.escalated === true;

    const shortfall   = action.amount - Math.max(0, cashAccount.balance);

    let crossBorderTransfers = [];
    if (shortfall > 0 && !escalated) {
      try {
        // A cross-currency cash sweep here (e.g. AU cash topping up US savings to
        // pay US tax) is journaled via INTL_TRANSFER_RECORD (design 44 Gap A).
        // replenishSavings tops the account up as far as the sources allow before
        // throwing InsufficientFundsError with the uncoverable residual.
        ({ crossBorderTransfers = [] } = this.accountService.replenishSavings(state, accountKey, shortfall, date));
      } catch (e) {
        if (!(e instanceof InsufficientFundsError)) throw e;
        // Proceed to the cross-border escalation below for the uncoverable part.
      }
    }

    const debit = Math.min(action.amount, Math.max(0, cashAccount.balance));
    if (debit > 0) {
      this.accountService.transaction(cashAccount, -debit, date);
    }

    const unpaid = action.amount - debit;

    // Any liability that same-country cash + the inline cross-border *cash* sweep
    // could not cover would strand here: under LOCAL_FIRST that sweep reaches only
    // idle foreign cash, never foreign investments, so an AU tax bill larger than
    // AU liquidity has nowhere left to go. Mirror the spending path
    // (ReplenishSavingsReducer): escalate to INTL_TRANSFER_APPLY, which liquidates
    // the OTHER country's investments and wires the proceeds straight into this tax
    // account (dstKey), then re-issue the debit (escalated) to pay the tax out of
    // the topped-up balance. The transfer reports any part even that cannot cover
    // as OUT_OF_FUNDS, so a genuine insolvency still surfaces — symmetric with
    // spending — without stranding a solvent household across the currency border.
    let residualActions = [];
    if (unpaid > 0.01 && !escalated) {
      residualActions = [
        { type: 'INTL_TRANSFER_APPLY',
          direction:     this.constructor.cc === 'AU' ? 'US_TO_AU' : 'AU_TO_US',
          targetDeficit: unpaid,
          dstKey:        accountKey },
        { type: this.constructor.actionType, amount: unpaid, escalated: true },
      ];
    }

    return this.newState(state, {
      [accountKey]: { ...cashAccount },   // explicit new reference so balance change is visible in state diffs
    }, [...crossBorderTransfers, ...residualActions]);
  }

  /**
   * Build the OUT_OF_FUNDS action for an unpaid tax residual, or [] when the
   * residual is within a cent (float/FX dust). The shared OutOfFundsReducer
   * consumes it (records the deficit metric, accumulates cumulativeDeficit, and
   * stamps outOfFundsDate/scenarioFailed on first occurrence). The 0.01 epsilon
   * matches the spending-side IntlTransferApplyReducer so rounding never trips a
   * spurious insolvency.
   */
  _outOfFundsActions(unpaid, currency, _date) {
    if (!(unpaid > 0.01)) return [];
    return [{ type: 'OUT_OF_FUNDS', deficit: unpaid, currency }];
  }
}

/**
 * Debits the US savings account for the computed tax amount.
 *
 * @param {object} opts
 * @param {import('../services/account-service.js').AccountService} opts.accountService
 * @param {object} opts.stateRegistry
 */
export class UsTaxPaymentDebitReducer extends TaxPaymentDebitReducerBase {
  static type        = 'UsTaxPaymentDebitReducer';
  static category    = 'reducer';
  static cc          = 'US';
  static actionType  = 'US_TAX_PAYMENT_DEBIT';
  static savingsRole = ACCOUNT_ROLES.US_SAVINGS;
  static description = 'Debits the US savings account for the tax amount; replenishes from investment accounts first when the balance is short.';
}

/**
 * Debits the AU savings account for the computed tax amount.
 *
 * @param {object} opts
 * @param {import('../services/account-service.js').AccountService} opts.accountService
 * @param {object} opts.stateRegistry
 */
export class AuTaxPaymentDebitReducer extends TaxPaymentDebitReducerBase {
  static type        = 'AuTaxPaymentDebitReducer';
  static category    = 'reducer';
  static cc          = 'AU';
  static actionType  = 'AU_TAX_PAYMENT_DEBIT';
  static savingsRole = ACCOUNT_ROLES.AU_SAVINGS;
  static description = 'Debits the AU savings account for the tax amount; replenishes from investment accounts first when the balance is short.';
}
