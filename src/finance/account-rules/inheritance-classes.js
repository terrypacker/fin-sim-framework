/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY, AccountServiceReducer } from '../../simulation-framework/reducers.js';
import { HandlerEntry }      from '../../simulation-framework/handlers.js';
import { resolvePresentCash } from './cash-routing.js';
import { convertExpenseToAccount } from '../fx/expense-fx.js';
import { inheritedRaStrategy, INHERITED_RA_WINDOW } from './inherited-ra-distribution-strategy.js';

/**
 * inheritance-classes.js — design 63 (Inheritance).
 *
 * The INHERIT one-off event funds the zero-seeded inherited records at the
 * inheritance date and stamps cost basis per country rules. It is the mirror of
 * design 49's COMPANY_SALE (which *zeroes* an asset): INHERIT *funds* one.
 *
 * Flow: INHERIT (event) → InheritHandler → one INHERIT_APPLY action per inherited
 * asset → InheritApplyReducer (funds the record + stamps basis).
 *
 * Phase 2 covers funding + US step-up (§6.1) + AU inherited cost base (§6.3) +
 * cross-border dual basis (§7). Death tax (NE §6.5, AU super §6.4) and the
 * SECURE 10-year inherited-RA drawdown (§6.2) arrive in P3/P4.
 */

// ─── Handler ───────────────────────────────────────────────────────────────────

/**
 * InheritHandler — on the INHERIT event, emit one INHERIT_APPLY per inherited
 * asset, resolving the heir's residency + citizenship at the inheritance date
 * (they decide which side steps up: US step-up for a US citizen, AU inherited
 * base for an AU resident, both for a US-citizen AU-resident — §7).
 */
export class InheritHandler extends HandlerEntry {
  static type        = 'InheritHandler';
  static description  = 'On INHERIT, dispatches one INHERIT_APPLY per inherited asset (+ residency/citizenship) and, for a Nebraska-situs decedent, one NE_INHERITANCE_TAX for the bequest.';
  static eventType    = 'INHERIT';

  constructor() {
    super(null, 'Inherit');
    this.generatedActionTypes = ['INHERIT_APPLY', 'NE_INHERITANCE_TAX'];
  }

  call({ data, state }) {
    const heir = _resolveHeir(state, data?.heirId);
    const usCitizen  = !!heir?.citizen?.includes?.('US');
    const auResident = (heir?.residency ?? null) === 'AU';
    const inheritanceDateMs = data?.inheritanceDateMs ?? null;
    const assets = data?.assets ?? [];

    const actions = assets.map(fd => ({
      type:               'INHERIT_APPLY',
      ...fd,
      usCitizen,
      auResident,
      inheritanceDateMs,
    }));

    // NE inheritance tax (design 63 §6.5): heir-paid, keyed to the DECEDENT's
    // Nebraska situs (not the heir's residency). One per-beneficiary exemption is
    // applied across the class-eligible inherited value of the whole bequest.
    if ((data?.decedentState ?? null) === 'NE') {
      const { exemption, rate } = _neClass(data?.relationship);
      const base = assets.reduce((s, fd) => s + (fd.inheritedValue ?? 0), 0);
      const neTax = Math.max(0, base - exemption) * rate;
      if (neTax > 0) {
        actions.push({ type: 'NE_INHERITANCE_TAX', amount: Math.round(neTax * 100) / 100 });
      }
    }
    return actions;
  }
}

// ─── Reducer ───────────────────────────────────────────────────────────────────

/**
 * InheritApplyReducer — funds one inherited record and stamps cost basis.
 *
 * Basis rules (design 63 §6/§7):
 *   - Universal `costBasis` = FMV at death when the heir is a US citizen (IRC
 *     §1014 step-up); otherwise the deceased's cost base (AU inherited base, no
 *     step-up — §6.3).
 *   - When the heir is an AU resident, additionally stamp `costBaseByCountry.AU`
 *     = deceased's cost base + `acquisitionDateByCountry.AU` = deceased's
 *     acquisition date (design 62 §4 machinery) so the AU CGT-discount /
 *     indexation clock uses the deceased's holding period. A US-citizen
 *     AU-resident heir therefore carries genuine dual basis (§7).
 *   - Holdings-bearing brokerage: seed a single FIFO lot at the funded value with
 *     the stepped-up/inherited basis, so the existing sale/CGT path consumes it
 *     directly (a next-day sale realizes ~zero US gain — §6.1).
 *   - Retirement (IRD) records take no CGT step-up; they are funded pre-tax and
 *     drained by the SECURE 10-year stream (P3). AU super is funded here in P2
 *     and converted to a taxed lump-sum payout in P4.
 */
export class InheritApplyReducer extends Reducer {
  static type        = 'InheritApplyReducer';
  static description  = 'Funds one inherited record at its FMV and stamps cost basis per country rules; AU super is paid out as a taxed lump sum to cash instead of funding an ongoing account.';
  static actionType   = 'INHERIT_APPLY';

  constructor({ accountService, stateRegistry } = {}) {
    super('Inherit Apply', PRIORITY.POSITION_UPDATE);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes   = ['INHERIT_APPLY'];
    this.generatedActionTypes = ['SUPER_DEATH_BENEFIT_TAX'];
  }

  reduce(state, action) {
    const {
      stateKey, name, category, isRetirement, isSuper,
      inheritedValue, deceasedCostBase, deceasedAcquisitionDate,
      inheritedFromMainResidence, taxableComponent, taxFreeComponent, paidViaEstate,
      usCitizen, auResident, inheritanceDateMs,
    } = action;

    const entry = state[stateKey];
    if (entry == null) return this.newState(state, {}, []);

    const fmv           = inheritedValue ?? 0;
    const inheritedBase = deceasedCostBase ?? fmv;          // AU: no step-up
    const universalBase = usCitizen ? fmv : inheritedBase;  // US citizen: §1014 step-up

    // AU super death benefit (design 63 §6.4): a non-dependant cannot retain it in
    // super — it is paid out as a taxed lump sum. Taxable component × 15% (+2%
    // Medicare when paid direct to the beneficiary, not via the estate); the
    // tax-free component is untaxed. Credit the NET lump sum to AU cash; leave the
    // seeded super account at 0 (no ongoing account). auSuperDeathTaxYTD records
    // the (source-withheld) tax via the AU classifier.
    if (isSuper) {
      const taxable   = taxableComponent ?? fmv;   // defaults to the whole balance
      const medicare  = paidViaEstate ? 0 : 0.02;
      const tax       = +(taxable * (0.15 + medicare)).toFixed(2);
      const net       = +(fmv - tax).toFixed(2);
      // Credit the net lump sum to AU cash — or, when the heir banks only in the US
      // (§7), cross-border into US cash (currency-converted). resolvePresentCash never
      // returns an absent key, so this can't strand/crash; null ⇒ no cash anywhere.
      const cash = resolvePresentCash(this.stateRegistry, 'AU', state);
      if (cash != null) {
        this.accountService.transaction(cash.account, convertExpenseToAccount(net, 'AUD', cash.account, state), null);
      }
      return this.newState(state, {}, [{ type: 'SUPER_DEATH_BENEFIT_TAX', amount: tax }]);
    }

    // Copy-on-write (journal purity invariant — never mutate the recorded leaf).
    const updated = { ...entry };

    if (category === 'real-property') {
      updated.value    = fmv;
      updated.costBasis = universalBase;
      if (inheritedFromMainResidence) updated.inheritedFromMainResidence = true;
      _stampAuDualBasis(updated, auResident, inheritedBase, deceasedAcquisitionDate);
    } else if (category === 'collectible') {
      updated.value    = fmv;
      updated.costBasis = universalBase;
      _stampAuDualBasis(updated, auResident, inheritedBase, deceasedAcquisitionDate);
    } else { // account (brokerage / retirement)
      updated.balance = fmv;
      if (!isRetirement) {
        // Brokerage: a single stepped-up lot the FIFO sale path consumes directly.
        updated.holdings = [_inheritedLot(
          stateKey, name, fmv, universalBase, auResident, inheritedBase,
          deceasedAcquisitionDate, inheritanceDateMs,
        )];
      }
      // Retirement carries no CGT step-up (IRD); funded pre-tax. contributionBasis
      // stays 0 so the whole balance is taxable ordinary income on distribution (P3).
    }

    return this.newState(state, { [stateKey]: updated }, []);
  }
}

/**
 * InheritanceNeTaxApplyReducer — pays the heir's Nebraska inheritance tax
 * (design 63 §6.5) from the US cash pool at the inheritance date. Runs alongside
 * the NE_INHERITANCE_TAX classifier (which records neInheritanceTaxYTD). Modeled
 * as an immediate heir payment; aggregating it into the Dec-31 state-tax settle
 * is a documented follow-up.
 */
export class InheritanceNeTaxApplyReducer extends AccountServiceReducer {
  static type        = 'InheritanceNeTaxApplyReducer';
  static description  = 'Debits the US cash pool for the heir-paid Nebraska inheritance tax at the inheritance date.';
  static actionType   = 'NE_INHERITANCE_TAX';

  constructor({ accountService, stateRegistry }) {
    super('NE Inheritance Tax', PRIORITY.TAX_APPLY);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes   = ['NE_INHERITANCE_TAX'];
    this.generatedActionTypes = [];
  }

  reduce(state, action) {
    // Debit US cash for the heir-paid NE tax — or, when the heir banks only in AU,
    // source it cross-border from AU cash (currency-converted). null ⇒ no cash
    // account exists anywhere, so the tax simply goes unpaid (unchanged terminal
    // behavior); neInheritanceTaxYTD still records the liability via the classifier.
    const cash = resolvePresentCash(this.stateRegistry, 'US', state);
    if (cash != null) {
      const debit = convertExpenseToAccount(action.amount ?? 0, 'USD', cash.account, state);
      this.accountService.transaction(cash.account, -debit, null);
    }
    return this.newState(state, {}, []);
  }
}

// ─── US IRD — SECURE 10-year inherited-RA drawdown (design 63 §6.2) ──────────────

/**
 * InheritedRaDistributionHandler — on the year-end INHERITED_RA_DISTRIBUTION
 * event, distributes from each inherited pre-tax IRA/401(k) (or tax-free Roth)
 * per its active strategy (design 63 §6.2). Fires late in the year (high event
 * `order`) so `usOrdinaryIncomeYTD` has already accumulated the year's wages,
 * RMDs, design-58 drawdowns, and Roth conversions — that YTD figure is the
 * competing "other ordinary income" the bracketFill strategy works under.
 *
 * Each account carries `{ stateKey, isRoth, inheritanceYear, heirId, strategyId }`;
 * the tunable params (`fillCeilingReal` real USD, `lumpYear`, `weights`) are
 * global, baked in from context.parameters at compile (the Opt/MC path recompiles
 * per candidate). `yearIndex = year − inheritanceYear`; the strategy's terminal
 * catch-up guarantees full distribution by year 9 (SECURE mandate). Penalty-exempt.
 */
export class InheritedRaDistributionHandler extends HandlerEntry {
  static type        = 'InheritedRaDistributionHandler';
  static description  = 'Year-end SECURE 10-year drawdown of inherited IRA/401(k)/Roth accounts per the active distribution strategy; penalty-exempt.';
  static eventType    = 'INHERITED_RA_DISTRIBUTION';

  constructor({ accounts = [] } = {}) {
    super(null, 'Inherited RA Distribution');
    // Each account carries its own SECURE-drawdown knobs (design 63 §12.3):
    // { stateKey, isRoth, inheritanceYear, heirId, strategyId, fillCeilingReal, lumpYear, weights }
    this.accounts = accounts;
    this.generatedActionTypes = ['INHERITED_RA_DISTRIBUTION_APPLY'];
  }

  call({ date, state }) {
    const year       = date.getUTCFullYear();
    const cpiIndexUS = state.cpiAccumulator?.US ?? state.inflationAccumulator?.US ?? 1;
    const actions    = [];

    for (const acct of this.accounts) {
      const entry = state[acct.stateKey];
      const balance = entry?.balance ?? 0;
      if (!entry || balance <= 0) continue;
      const yearIndex = year - acct.inheritanceYear;
      if (yearIndex < 0) continue;

      const ctx = {
        otherOrdinaryIncome: state.usOrdinaryIncomeYTD ?? 0,
        fillCeilingReal:     acct.fillCeilingReal ?? 0,
        cpiIndexUS,
        lumpYear:            acct.lumpYear ?? 0,
        weights:             acct.weights ?? [],
        WINDOW:              INHERITED_RA_WINDOW,
      };
      const strat  = inheritedRaStrategy(acct.strategyId);
      let   amount = strat.plan(balance, yearIndex, ctx);
      amount = Math.min(balance, Math.max(0, amount));
      amount = Math.round(amount * 100) / 100;
      if (amount <= 0) continue;

      const residency = _resolveHeir(state, acct.heirId)?.residency ?? null;
      actions.push({
        type:      'INHERITED_RA_DISTRIBUTION_APPLY',
        amount,
        stateKey:  acct.stateKey,
        isRoth:    !!acct.isRoth,
        residency,
      });
    }
    return actions;
  }
}

/**
 * InheritedRaDistributionApplyReducer — credits the US cash pool and debits the
 * inherited RA. Traditional (pre-tax) chains INHERITED_RA_DISTRIBUTION_TAX (whole
 * amount ordinary income, penalty-exempt, AU-relieved by FITO when AU-resident);
 * Roth is tax-free (no chained tax action). No EARLY_WITHDRAWAL ever — inherited
 * distributions are penalty-exempt regardless of the heir's age (design 63 §6.2).
 */
export class InheritedRaDistributionApplyReducer extends AccountServiceReducer {
  static type        = 'InheritedRaDistributionApplyReducer';
  static description  = 'Credits US cash and debits the inherited RA; chains INHERITED_RA_DISTRIBUTION_TAX (ordinary income) unless Roth. Penalty-exempt.';
  static actionType   = 'INHERITED_RA_DISTRIBUTION_APPLY';

  constructor({ accountService, stateRegistry }) {
    super('Inherited RA Distribution Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes   = ['INHERITED_RA_DISTRIBUTION_APPLY'];
    this.generatedActionTypes = ['INHERITED_RA_DISTRIBUTION_TAX'];
  }

  reduce(state, action) {
    const { amount, stateKey, isRoth, residency } = action;
    const acct = state[stateKey];
    if (acct == null) return this.newState(state, {}, []);

    const newBalance = Math.max(0, (acct.balance ?? 0) - amount);
    // Credit the distribution to US cash — or, for an AU-resident heir with no US
    // cash (§7), cross-border into AU cash (currency-converted). resolvePresentCash
    // guarantees a present account, closing the former `transaction(undefined)` crash
    // when no US cash pool existed; null ⇒ no cash anywhere, so the proceeds can't land.
    const cash = resolvePresentCash(this.stateRegistry, 'US', state);
    if (cash != null) {
      this.accountService.transaction(cash.account, convertExpenseToAccount(amount, 'USD', cash.account, state), null);
    }
    // Design 76 Gap B: stamp the inherited account so the AU return attributes to
    // the beneficiary who inherited it.
    const chained = isRoth ? [] : [{ type: 'INHERITED_RA_DISTRIBUTION_TAX', amount, residency, stateKey }];
    return this.newState(state, { [stateKey]: { ...acct, balance: newBalance } }, chained);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Nebraska inheritance-tax class → exemption + rate (design 63 §6.5, post-LB310).
 * `relationship` maps: immediate → Class 1 ($100k / 1%), remote → Class 2
 * ($40k / 11%), unrelated → Class 3 ($25k / 15%).
 */
function _neClass(relationship) {
  switch (relationship) {
    case 'remote':    return { exemption: 40_000, rate: 0.11 };
    case 'unrelated': return { exemption: 25_000, rate: 0.15 };
    case 'immediate':
    default:          return { exemption: 100_000, rate: 0.01 };
  }
}

/** Resolve the heir person projection from state.people (falls back to the first). */
function _resolveHeir(state, heirId) {
  const people = state.people ?? {};
  if (heirId && people[heirId]) return people[heirId];
  const firstKey = Object.keys(people)[0];
  return firstKey ? people[firstKey] : null;
}

/**
 * Stamp the AU dual cost base (design 62 §4) onto a real-property/collectible
 * record when the heir is an AU resident: AU keeps the deceased's cost base +
 * acquisition date (no step-up), which the AU sale/CGT path reads.
 */
function _stampAuDualBasis(record, auResident, inheritedBase, deceasedAcquisitionDate) {
  if (!auResident) return;
  record.costBaseByCountry = { ...(record.costBaseByCountry ?? {}), AU: inheritedBase };
  if (deceasedAcquisitionDate != null) {
    record.acquisitionDateByCountry = {
      ...(record.acquisitionDateByCountry ?? {}),
      AU: deceasedAcquisitionDate,
    };
  }
}

/**
 * Build the single inherited brokerage lot. US step-up ⇒ lot `costBasis` = FMV;
 * AU-resident ⇒ per-lot `costBaseByCountry.AU` = deceased base +
 * `acquisitionDateByCountry.AU` = deceased acquisition date (consumeHoldingsFifo
 * reads exactly these — design 57/62).
 */
function _inheritedLot(stateKey, name, fmv, universalBase, auResident, inheritedBase, deceasedAcquisitionDate, inheritanceDateMs) {
  const lot = {
    id:          `${stateKey}-inherited-lot`,
    label:       name || 'Inherited Holding',
    allocation:  'EQUITY',
    marketValue: fmv,
    costBasis:   universalBase,
    // US acquisition (step-up) clock starts at the inheritance date.
    purchaseDate: inheritanceDateMs ?? null,
  };
  if (auResident) {
    lot.costBaseByCountry = { AU: inheritedBase };
    if (deceasedAcquisitionDate != null) {
      lot.acquisitionDateByCountry = { AU: deceasedAcquisitionDate };
    }
  }
  return lot;
}
