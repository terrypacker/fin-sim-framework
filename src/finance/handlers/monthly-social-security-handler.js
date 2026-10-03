/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HandlerEntry } from '../../simulation-framework/handlers.js';
import { FieldValueAction, RecordBalanceAction } from '../../simulation-framework/actions.js';
import { ACCOUNT_ROLES } from '../state/account-roles.js';
import { entitlementMonth, monthIndex, monthIndexToMs, ownFactor, spousalFactor, spousalPayable }
  from '../account-rules/us/us-social-security-rules.js';

/** A person's own entitlement month: their stamp once made, else their claim age's. */
function claimMonth(person) {
  return person.ssEntitledMs != null ? monthIndex(person.ssEntitledMs)
    : entitlementMonth(person.birthDate, person.ssClaimAge ?? null);
}

/**
 * Handles the MONTHLY_SS_INCOME event.
 *
 * Iterates over all people in state.people and dispatches SS_INCOME_APPLY for each
 * person whose socialSecurityMonthly (their PIA) > 0 once they are entitled. Work does
 * not gate the benefit (design 118 §5.1, was design 116 D6): someone still employed past
 * the claiming age draws a wage and a benefit in the same month, which is the law from
 * full retirement age on. Before it the retirement earnings test applies, which is not
 * modelled (design 118 §10).
 *
 * Entitlement and the amount come from `us-social-security-rules.js` (design 118 §5.2):
 * the person's `ssClaimAge` (blank = full retirement age) fixes the first month, and the
 * PIA is scaled by the early-claim reduction or the delayed retirement credits. That
 * month is stamped on the person as `ssEntitledMs` the first time they are paid (D7),
 * and from then on the stamp, not `ssClaimAge`, decides the factor: a claim once made is
 * not re-timed by a lever that changes later.
 *
 * The spousal benefit (design 118 §5.4, phase 3). In a household of exactly two people,
 * each is the other's spouse (D8). A person whose own PIA is under half their spouse's
 * is also paid the spousal top-up, from the later of their own entitlement and their
 * spouse's: claiming their own benefit is deemed to claim the spousal one too (D9), and
 * a spousal benefit cannot start before the worker is entitled. A person with no record
 * of their own is entitled on the spousal benefit alone, from that same later month,
 * and that month is their stamp. The top-up ends when the spouse leaves `state.people`.
 *
 * The SsIncomeApplyReducer (registered via the US account module) handles the
 * actual cash credit and tax chaining (85% of SS is taxable ordinary income).
 *
 * @param {object} [opts]
 * @param {import('../services/state-registry.js').StateRegistry} opts.stateRegistry
 */
export class MonthlySocialSecurityHandler extends HandlerEntry {
  static description = 'Credits the US cash pool with Social Security income for each eligible person from their claiming age, whether or not they are still working: the PIA reduced for an early claim or raised by delayed retirement credits, plus any spousal top-up on the other spouse\'s record.';
  static type        = 'MonthlySocialSecurityHandler';
  static eventType   = 'MONTHLY_SS_INCOME';

  constructor({ stateRegistry } = {}) {
    super(null, 'Monthly Social Security');
    this.stateRegistry      = stateRegistry;
    this.generatedActionTypes = ['SS_ENTITLEMENT_APPLY', 'SS_INCOME_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  static fromJSON(d, services) {
    const h = new this({ stateRegistry: services?.stateRegistry });
    h.id = d.id;
    return h;
  }

  call({ date, state }) {
    const actions = [];
    const cashKey = this.stateRegistry?.getStateKey(ACCOUNT_ROLES.US_SAVINGS) ?? 'usSavingsAccount';
    const nowMi   = monthIndex(date);

    const entries = Object.entries(state.people ?? {});
    for (const [key, person] of entries) {
      const pia    = person.socialSecurityMonthly ?? 0;
      // D8: a household of exactly two is a married couple; anything else has no spouse.
      const spouse = entries.length === 2 ? entries.find(([k]) => k !== key)[1] : null;
      const workerPia = spouse?.socialSecurityMonthly ?? 0;
      const workerMi  = workerPia > 0 ? claimMonth(spouse) : Infinity;
      const spousal   = workerPia / 2 > pia;   // 404.330(d)
      if (pia <= 0 && !spousal) continue;

      const stamped    = person.ssEntitledMs != null;
      // No record of their own: entitled only once the worker is (42 U.S.C. 402(b)(1)).
      const entitledMi = pia > 0 || stamped ? claimMonth(person)
        : Math.max(claimMonth(person), workerMi);
      if (nowMi < entitledMi) continue;

      // A claim month before sim start (someone already collecting) is stamped as that
      // past month, so their factor is the one they actually claimed at.
      if (!stamped) {
        actions.push({ type: 'SS_ENTITLEMENT_APPLY', personKey: key, entitledMs: monthIndexToMs(entitledMi) });
      }

      const factor = pia > 0 ? ownFactor(person.birthDate, entitledMi, nowMi) : 0;
      const own    = pia * factor;
      const top    = spousal && nowMi >= workerMi
        ? spousalPayable({ ownPia: pia, workerPia, ownBenefit: own,
            ownBenefitNoDrc: pia * Math.min(1, factor),
            factor: spousalFactor(person.birthDate, Math.max(entitledMi, workerMi)) })
        : 0;
      const ssMonthly = own + top;
      if (ssMonthly <= 0) continue;
      actions.push(
        // Design 76 Gap B: stamp WHOSE benefit this is — Social Security is
        // per-recipient by definition and the two people have different
        // entitlements, so it must never be halved across a household.
        //
        // Design 83 G11: no AU return currently consumes either stamp. Art. 18(2)
        // reserves US Social Security to the United States, so the classifier books
        // it identically whatever `residency` says. Both fields stay on the action:
        // they describe the payment, and a country that *may* assess a foreign
        // public pension would need exactly them.
        { type: 'SS_INCOME_APPLY', amount: ssMonthly, residency: person.residency ?? null, personKey: key,
          own, spousal: top },
        new FieldValueAction(`ss_income_${key}`, `${person.name || key} Social Security`, ssMonthly),
      );
    }

    if (actions.length > 0) {
      actions.push(new RecordBalanceAction(`${cashKey}.balance`, cashKey));
    }

    return actions;
  }
}
