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
import { HandlerEntry }      from '../../simulation-framework/handlers.js';

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
  static description  = 'On INHERIT, dispatches one INHERIT_APPLY per inherited asset with the funding descriptor + heir residency/citizenship.';
  static eventType    = 'INHERIT';

  constructor() {
    super(null, 'Inherit');
    this.generatedActionTypes = ['INHERIT_APPLY'];
  }

  call({ data, state }) {
    const heir = _resolveHeir(state, data?.heirId);
    const usCitizen  = !!heir?.citizen?.includes?.('US');
    const auResident = (heir?.residency ?? null) === 'AU';
    const inheritanceDateMs = data?.inheritanceDateMs ?? null;

    return (data?.assets ?? []).map(fd => ({
      type:               'INHERIT_APPLY',
      ...fd,
      usCitizen,
      auResident,
      inheritanceDateMs,
    }));
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
  static description  = 'Funds one inherited record at its FMV and stamps cost basis per country rules (US step-up / AU inherited base / cross-border dual basis).';
  static actionType   = 'INHERIT_APPLY';

  constructor() {
    super('Inherit Apply', PRIORITY.POSITION_UPDATE);
    this.reducedActionTypes   = ['INHERIT_APPLY'];
    this.generatedActionTypes = [];
  }

  reduce(state, action) {
    const {
      stateKey, name, category, isRetirement, country,
      inheritedValue, deceasedCostBase, deceasedAcquisitionDate,
      inheritedFromMainResidence, usCitizen, auResident, inheritanceDateMs,
    } = action;

    const entry = state[stateKey];
    if (entry == null) return this.newState(state, {}, []);

    const fmv           = inheritedValue ?? 0;
    const inheritedBase = deceasedCostBase ?? fmv;          // AU: no step-up
    const universalBase = usCitizen ? fmv : inheritedBase;  // US citizen: §1014 step-up

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
    } else { // account (brokerage / retirement / super)
      updated.balance = fmv;
      if (!isRetirement) {
        // Brokerage: a single stepped-up lot the FIFO sale path consumes directly.
        updated.holdings = [_inheritedLot(
          stateKey, name, fmv, universalBase, auResident, inheritedBase,
          deceasedAcquisitionDate, inheritanceDateMs,
        )];
      }
      // Retirement/super carry no CGT step-up (IRD); funded pre-tax. contributionBasis
      // stays 0 so the whole balance is taxable ordinary income on distribution (P3).
    }

    return this.newState(state, { [stateKey]: updated }, []);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

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
