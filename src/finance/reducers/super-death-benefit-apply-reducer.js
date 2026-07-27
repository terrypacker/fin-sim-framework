/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY } from '../../simulation-framework/reducers.js';

/**
 * SuperDeathBenefitApplyReducer — AU superannuation death benefit paid to a
 * NON-dependant (design/68 Gap 4, mirroring design 63 §6.4's external-decedent
 * path).
 *
 * A surviving spouse is a death-benefit *dependant*, so their retitled super is
 * tax-free — the MortalityHandler simply swaps ownerId in that case and emits
 * nothing here. This reducer fires only for the LAST-survivor death, where the
 * super passes to the estate / non-dependant beneficiaries: the taxable
 * component is a FINAL tax of 15% (+2% Medicare only when paid direct to the
 * beneficiary, not via the estate). The tax is withheld from the account (the
 * estate inherits the net), and recorded in auSuperDeathTaxYTD via the
 * SUPER_DEATH_BENEFIT_TAX classifier (reporting; not a marginal-rate addition).
 *
 * Runs at POSITION_UPDATE — after the person is removed (PRE_PROCESS) and before
 * the terminal tax settle flushed by the run loop (design/68 Gap 2). Balance is
 * reduced copy-on-write (journal purity); this is the estate's terminal snapshot,
 * so holdings are not re-synced.
 *
 * Action: SUPER_DEATH_BENEFIT_APPLY { stateKey, taxable, paidViaEstate }
 */
export class SuperDeathBenefitApplyReducer extends Reducer {
  static description = 'Withholds the AU super death-benefit tax (non-dependant, 15% + 2% Medicare if paid direct) from a deceased super account and records auSuperDeathTaxYTD.';
  static type        = 'SuperDeathBenefitApplyReducer';
  static actionType  = 'SUPER_DEATH_BENEFIT_APPLY';

  constructor() {
    super('Super Death Benefit Apply', PRIORITY.POSITION_UPDATE);
    this.reducedActionTypes   = ['SUPER_DEATH_BENEFIT_APPLY'];
    this.generatedActionTypes = ['SUPER_DEATH_BENEFIT_TAX'];
  }

  reduce(state, action) {
    const { stateKey, taxable, paidViaEstate } = action;
    const acct = state[stateKey];
    if (acct == null) return this.newState(state, {}, []);

    const medicare = paidViaEstate ? 0 : 0.02;
    const tax = +(Math.max(0, taxable ?? 0) * (0.15 + medicare)).toFixed(2);
    if (tax <= 0) return this.newState(state, {}, []);

    const newBalance = Math.max(0, (acct.balance ?? 0) - tax);
    return this.newState(
      { ...state, [stateKey]: { ...acct, balance: newBalance } },
      {},
      [{ type: 'SUPER_DEATH_BENEFIT_TAX', amount: tax }],
    );
  }
}
