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
   * Returns TaxDocument[] when personTaxDetails is present (per-person AU filing) or
   *   when capital gain sale records exist for a US filing (Form 1040 + Schedule D + Form 8949).
   * Returns TaxDocument for single-filer US entries with no capital gains.
   *
   * @param {object}   journalEntry
   * @param {object[]} [journal]     - Full journal array; required for Form 8949 extraction.
   * @returns {TaxDocument|TaxDocument[]|null}
   */
  generate(journalEntry, journal) {
    const data = journalEntry.action.data ?? {};
    const cc = data.cc ?? _ccFromActionType(journalEntry.action?.type);
    const { taxDetail, personTaxDetails } = data;
    const period = journal ? _extractPeriod(journalEntry, journal, cc) : null;

    if (personTaxDetails?.length > 0) {
      const taxYear    = personTaxDetails[0]?.taxDetail?.taxYear ?? new Date(journalEntry.date).getUTCFullYear();
      const module     = this._get(cc, taxYear);
      const saleRecords = cc === 'AU' && journal ? _extractAuSaleRecords(journalEntry, journal) : [];
      return personTaxDetails.flatMap(({ personKey, personName, taxDetail: pd }) => {
        const result = module.generate(pd, taxYear, saleRecords, period);
        const docs   = Array.isArray(result) ? result : [result];
        docs[0].personKey  = personKey;
        docs[0].personName = personName;
        // For supplementary docs (e.g. CGT Schedule) label them under the same person.
        for (let i = 1; i < docs.length; i++) {
          docs[i].personKey  = personKey;
          docs[i].personName = `${personName} — ${docs[i].title.split('—')[0].trim()}`;
        }
        return docs;
      });
    }

    if (!taxDetail) return null;
    const taxYear    = taxDetail.taxYear ?? new Date(journalEntry.date).getUTCFullYear();
    const module     = this._get(cc, taxYear);
    const saleRecords = journal
      ? cc === 'US' ? _extractUsSaleRecords(journalEntry, journal)
      : cc === 'AU' ? _extractAuSaleRecords(journalEntry, journal)
      : []
      : [];
    return module.generate(taxDetail, taxYear, saleRecords, period);
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

// ─── Module-level helpers ─────────────────────────────────────────────────────

function _ccFromActionType(type) {
  if (!type) return null;
  if (type.startsWith('US_')) return 'US';
  if (type.startsWith('AU_')) return 'AU';
  return null;
}

/**
 * Return { fromEntryId, toEntryId } identifying the tax period boundaries for
 * the given TAX_SETTLE_APPLY entry.  Used to populate drillReport.params.period
 * on drillable line items so the Journal Report plugin can reconstruct the range.
 *
 * toEntryId   = currentEntry.id
 * fromEntryId = the previous TAX_SETTLE_APPLY for the same cc (null if first year)
 */
function _extractPeriod(currentEntry, journal, cc) {
  const currentIdx = journal.indexOf(currentEntry);
  if (currentIdx < 0) return null;

  let fromEntryId = null;
  for (let i = currentIdx - 1; i >= 0; i--) {
    const e = journal[i];
    if (e.action?.type === `${cc}_TAX_SETTLE_APPLY`) {
      fromEntryId = e.id;
      break;
    }
  }

  return { fromEntryId, toEntryId: currentEntry.id };
}

/**
 * Collect AU_STOCK_WITHDRAWAL_TAX and AU_HOUSE_SALE_TAX journal entries that carry
 * sale detail (proceeds field) between the previous AU TAX_SETTLE_APPLY and the current one.
 *
 * @param {object}   currentEntry  - The TAX_SETTLE_APPLY journal entry being reported.
 * @param {object[]} journal       - Full journal entry array.
 * @returns {{ description, dateAcquired, dateSold, proceeds, costBasis, gain }[]}
 */
function _extractAuSaleRecords(currentEntry, journal) {
  const currentIdx = journal.indexOf(currentEntry);
  if (currentIdx < 0) return [];

  let yearStartIdx = 0;
  for (let i = currentIdx - 1; i >= 0; i--) {
    const e = journal[i];
    if (e.action?.type === 'AU_TAX_SETTLE_APPLY') {
      yearStartIdx = i + 1;
      break;
    }
  }

  const records = [];
  for (let i = yearStartIdx; i < currentIdx; i++) {
    const e = journal[i];
    const t = e.action?.type;
    const d = e.action?.data;
    if (!d?.proceeds) continue;

    // Explicit AU stock or property sale via AU-specific action types.
    const isAuSaleAction = t === 'AU_STOCK_WITHDRAWAL_TAX' || t === 'AU_HOUSE_SALE_TAX';
    // Replenish-savings drawdown from any brokerage for an AU resident
    // (STOCK_WITHDRAWAL_TAX with isAuResident covers both AU and US brokerage drawdowns;
    //  AU residents are taxed on worldwide capital gains).
    const isAuResidentSale = t === 'STOCK_WITHDRAWAL_TAX' && d.residency === 'AUS';

    if (!isAuSaleAction && !isAuResidentSale) continue;

    records.push({
      description:  d.description ?? (t === 'AU_HOUSE_SALE_TAX' ? 'AU Real Property' : 'Investment Account'),
      dateAcquired: 'Various',
      dateSold:     new Date(e.date),
      proceeds:     d.proceeds,
      costBasis:    d.costBasis ?? (d.proceeds - (d.gain ?? 0)),
      gain:         d.gain ?? 0,
    });
  }
  return records;
}

/**
 * Collect all STOCK_WITHDRAWAL_TAX journal entries that carry sale detail
 * (proceeds field) between the previous US TAX_SETTLE_APPLY and the current one.
 * These entries are emitted by StockWithdrawalApplyReducer (explicit sales) and
 * AccountService.replenishSavings (brokerage drawdowns).
 *
 * @param {object}   currentEntry  - The TAX_SETTLE_APPLY journal entry being reported.
 * @param {object[]} journal       - Full journal entry array.
 * @returns {{ description, dateAcquired, dateSold, proceeds, costBasis, gain }[]}
 */
function _extractUsSaleRecords(currentEntry, journal) {
  const currentIdx = journal.indexOf(currentEntry);
  if (currentIdx < 0) return [];

  // Find the previous US TAX_SETTLE_APPLY to define year start.
  let yearStartIdx = 0;
  for (let i = currentIdx - 1; i >= 0; i--) {
    const e = journal[i];
    if (e.action?.type === 'US_TAX_SETTLE_APPLY') {
      yearStartIdx = i + 1;
      break;
    }
  }

  const records = [];
  for (let i = yearStartIdx; i < currentIdx; i++) {
    const e = journal[i];
    if (e.action?.type === 'STOCK_WITHDRAWAL_TAX' && e.action.data?.proceeds != null) {
      const d = e.action.data;
      records.push({
        description:  d.description ?? 'Investment Account',
        dateAcquired: 'Various',
        dateSold:     new Date(e.date),
        proceeds:     d.proceeds,
        costBasis:    d.costBasis ?? (d.proceeds - (d.gain ?? 0)),
        gain:         d.gain ?? 0,
      });
    }
  }
  return records;
}
