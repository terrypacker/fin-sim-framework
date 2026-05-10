/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseTaxDocumentModule } from './base-tax-document-module.js';
import { UsTaxDocument2024 }     from './us/us-tax-document-2024.js';
import { UsTaxDocument2025 }     from './us/us-tax-document-2025.js';
import { UsTaxDocument2026 }     from './us/us-tax-document-2026.js';
import { AuTaxDocument2024 }     from './au/au-tax-document-2024.js';
import { AuTaxDocument2025 }     from './au/au-tax-document-2025.js';
import { AuTaxDocument2026 }     from './au/au-tax-document-2026.js';

/**
 * TaxDocumentRegistry — registry for BaseTaxDocumentModule instances.
 *
 * Uses the same countryCode+year keying and highest-year-<= fallback
 * as TaxEngine and TaxSettleService.
 *
 * generate(journalEntry) is called by JournalReportingService on
 * TAX_SETTLE_APPLY entries; it reads cc and taxDetail from action,
 * resolves the correct document module, and returns a TaxDocument.
 */
export class TaxDocumentRegistry {
  constructor() {
    /** @type {Record<string, BaseTaxDocumentModule>} */
    this._modules = {};

    for (const m of [
      new UsTaxDocument2024(),
      new UsTaxDocument2025(),
      new UsTaxDocument2026(),
      new AuTaxDocument2024(),
      new AuTaxDocument2025(),
      new AuTaxDocument2026(),
    ]) {
      this._modules[`${m.countryCode}_${m.year}`] = m;
    }
  }

  /**
   * Generate a TaxDocument (or array of TaxDocuments) from a TAX_SETTLE_APPLY entry.
   *
   * Returns null when the entry has no taxDetail and no personTaxDetails.
   * Returns TaxDocument[] when personTaxDetails is present (per-person AU filing).
   * Returns TaxDocument for single-filer or US entries.
   *
   * @param {object} journalEntry
   * @returns {TaxDocument|TaxDocument[]|null}
   */
  generate(journalEntry) {
    const { cc, taxDetail, personTaxDetails } = journalEntry.action;

    if (personTaxDetails?.length > 0) {
      const taxYear = personTaxDetails[0]?.taxDetail?.taxYear ?? new Date(journalEntry.date).getUTCFullYear();
      const module  = this._get(cc, taxYear);
      return personTaxDetails.map(({ personKey, personName, taxDetail: pd }) => {
        const doc = module.generate(pd, taxYear);
        doc.personKey  = personKey;
        doc.personName = personName;
        return doc;
      });
    }

    if (!taxDetail) return null;
    const taxYear = taxDetail.taxYear ?? new Date(journalEntry.date).getUTCFullYear();
    const module  = this._get(cc, taxYear);
    return module.generate(taxDetail, taxYear);
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  _get(cc, year) {
    const available = Object.keys(this._modules)
      .filter(k => k.startsWith(cc + '_'))
      .map(k => parseInt(k.split('_')[1], 10))
      .sort((a, b) => a - b);

    if (available.length === 0) {
      throw new Error(`[TaxDocumentRegistry] No document module registered for country: ${cc}`);
    }

    const best = available.filter(y => y <= year).pop() ?? available[0];
    return this._modules[`${cc}_${best}`];
  }
}
