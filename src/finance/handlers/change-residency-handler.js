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
import { RecordBalanceAction } from '../../simulation-framework/actions.js';

/**
 * Handles CHANGE_RESIDENCY events.
 *
 * Triggered as a one-off event on the date the simulation person moves from
 * the US to AU. Emits the residency-change sequence:
 *
 *   1. CHANGE_RESIDENCY_APPLY — flips residency to 'AU' on all people and snapshots
 *      investment account balances (citizen arrays are NOT modified).
 *
 *   2. RecordBalanceAction — captures the post-change stateAfter snapshot.
 *
 * Deliberately does NOT settle US tax on the move date. The scenario models a
 * US *citizen*, who is taxed by the US on worldwide income for the full calendar
 * year regardless of residence — there is no mid-year US cutoff. The normal
 * end-of-year UsTaxSettleHandler (Dec 31) settles the full calendar year with
 * H1 income intact. Settling here would (a) reset usOrdinaryIncomeYTD /
 * usCapitalGainsYTD / ftcYTD mid-year, discarding income the Dec 31 return still
 * needs, and (b) is conceptually a dual-status/expatriation event that does not
 * apply to a citizen.
 *
 * The AU side likewise needs nothing on the move date: AU income accrual is
 * residency-gated and the AU fiscal-year settle (Jun 30) taxes only the resident
 * portion. This relies on the move being pinned to Jul 1 (the AU FY boundary in
 * us-au-cross-border-toolset.js). If the move date is ever made arbitrary, a
 * part-year-resident pro-rated tax-free threshold must be added in the AU tax
 * module — not here; Australia does not settle on the move date either.
 */
export class ChangeResidencyHandler extends HandlerEntry {
  static description = 'Emits CHANGE_RESIDENCY_APPLY + RECORD_BALANCE on the move date; does NOT settle US tax (citizen taxed on full calendar year by Dec 31 settle).';
  static type        = 'ChangeResidencyHandler';
  static eventType   = 'CHANGE_RESIDENCY';

  constructor() {
    super(null, 'Change Residency');
    this.generatedActionTypes = ['CHANGE_RESIDENCY_APPLY', 'RECORD_BALANCE'];
  }

  call() {
    return [
      { type: 'CHANGE_RESIDENCY_APPLY' },
      new RecordBalanceAction(),
    ];
  }
}
