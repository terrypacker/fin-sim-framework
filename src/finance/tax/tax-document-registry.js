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
import { AuTaxDocument2027 }     from './au/au-tax-document-2027.js';
import { TAX_FX_PAIR }           from './tax-fx.js';

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
      new AuTaxDocument2027(),
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
        return docs.map(d => _withFx(d, data));
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
    const result = module.generate(taxDetail, taxYear, saleRecords, period);
    return Array.isArray(result)
      ? result.map(d => _withFx(d, data))
      : _withFx(result, data);
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

/**
 * Stamp the settlement's FX rate onto a generated document, in place.
 *
 * Done HERE rather than inside each document module for the same reason
 * `personKey` is: the rate is a property of the settlement, not of the return's
 * layout, and threading it through every module's `generate()` signature would
 * touch seven classes to add one field none of them reason about. Supplementary
 * forms (Schedule D, the CGT Schedule) get it too, so a reader who exports only
 * the schedule still knows the rate.
 *
 * Absent on a settlement predating this field, or in a single-country run where
 * no rate was ever recorded — the document then simply carries no FX line.
 */
function _withFx(doc, data) {
  if (!doc || data?.fxRate == null) return doc;
  doc.fxRate = data.fxRate;
  doc.fxPair = TAX_FX_PAIR;
  return doc;
}

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
 * Collapse the action×reducer fan-out while walking raw journal entries.
 *
 * The journal records one entry per action PER CONSUMING REDUCER, and a disposal has
 * several consumers (`dynamic:US:…`, `state:classify:…`, `dynamic:AU:…`), so the same
 * sale appears N times under one shared `action.instanceId`. The extractors below
 * iterate raw entries — the aggregate reports go through `JournalQueryApi`, which
 * already collapses this — so without a filter every proceeds/basis/gain total on
 * Schedule D, Form 8949 and the AU CGT Schedule is multiplied by N. Form 1040 line 6
 * is unaffected: it reads the YTD accumulator, which is written once.
 *
 * Returns a stateful predicate: first sighting of an instanceId passes, later ones
 * are dropped. Entries carrying **no** instanceId always pass — hand-built journals
 * in tests, and any legacy entry predating the field, have no fan-out to collapse and
 * must not be silently merged into one another.
 *
 * @returns {(entry: object) => boolean}
 */
function _firstEntryPerAction() {
  const seen = new Set();
  return (entry) => {
    const id = entry.action?.instanceId;
    if (id == null) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  };
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
  const isFirstForAction = _firstEntryPerAction();
  for (let i = yearStartIdx; i < currentIdx; i++) {
    const e = journal[i];
    const t = e.action?.type;
    const d = e.action?.data;
    if (!d?.proceeds) continue;

    // Explicit AU stock or property sale via AU-specific action types.
    const isAuSaleAction = t === 'AU_STOCK_WITHDRAWAL_TAX' || t === 'AU_HOUSE_SALE_TAX';
    // Replenish-savings drawdown from any brokerage for an AU resident
    // (STOCK_WITHDRAWAL_TAX with residency='AU' covers both AU and US brokerage drawdowns;
    //  AU residents are taxed on worldwide capital gains).
    const isAuResidentSale = t === 'STOCK_WITHDRAWAL_TAX' && d.residency === 'AU';

    if (!isAuSaleAction && !isAuResidentSale) continue;
    if (!isFirstForAction(e)) continue;

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
 * Every disposal type that feeds `usCapitalGainsYTD`, i.e. Form 1040 line 6.
 *
 * `STOCK_WITHDRAWAL_TAX` covers explicit sales (StockWithdrawalApplyReducer) and
 * brokerage drawdowns (`AccountService.replenishSavings`). The other two used to be
 * missing, so Schedule D silently omitted the house and company-equity disposals
 * while Form 1040 counted them — the reason CY2026 read `L6 650,000` against a
 * Schedule D of `0.00`. Collectibles are deliberately absent: they carry their own
 * 28% rate and their own Form 1040 line (§1(h)(4)), not line 6.
 */
const US_DISPOSAL_ACTION_TYPES = new Set([
  'STOCK_WITHDRAWAL_TAX', 'US_HOUSE_SALE_TAX', 'COMPANY_SALE_TAX',
]);

/**
 * Form 8949 column (g) — the adjustment that reconciles a disposal's economic gain
 * to its taxable gain, with the column (f) code that explains it.
 *
 * A disposal action reports `proceeds`, `costBasis` and the **taxable** `gain`. For
 * an ordinary sale those agree (`gain = proceeds − costBasis`) and the adjustment is
 * zero. For a main home the §121 exclusion drives them apart, and a real return does
 * NOT quietly report a smaller gain — per the Form 8949 instructions it reports the
 * sale gross and carries the exclusion as a negative column (g) entry under code H:
 *
 *   "Report the sale or exchange on Form 8949 as you would if you weren't taking the
 *    exclusion. Then enter the amount of excluded (nontaxable) gain as a negative
 *    number (in parentheses) in column (g)."
 *
 * Schedule D then foots as (d) − (e) + (g), which is exactly its column (h).
 *
 * @returns {{ adjustment: number, code: string }}
 */
function _saleAdjustment(actionType, proceeds, costBasis, gain) {
  const adjustment = Math.round(((gain - (proceeds - costBasis)) + Number.EPSILON) * 100) / 100;
  if (adjustment === 0) return { adjustment: 0, code: '' };
  // H is specifically the main-home exclusion; anything else is a real reconciling
  // difference we have no authority to label, so it stays coded blank rather than
  // borrowing a code that would misstate why the return differs.
  return { adjustment, code: actionType === 'US_HOUSE_SALE_TAX' ? 'H' : '' };
}

/**
 * Collect the US disposal journal entries carrying sale detail (a `proceeds` field)
 * between the previous US TAX_SETTLE_APPLY and the current one.
 *
 * @param {object}   currentEntry  - The TAX_SETTLE_APPLY journal entry being reported.
 * @param {object[]} journal       - Full journal entry array.
 * @returns {{ description, dateAcquired, dateSold, proceeds, costBasis, gain, adjustment, code }[]}
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
  const isFirstForAction = _firstEntryPerAction();
  for (let i = yearStartIdx; i < currentIdx; i++) {
    const e = journal[i];
    const t = e.action?.type;
    const d = e.action?.data;
    if (!US_DISPOSAL_ACTION_TYPES.has(t) || d?.proceeds == null) continue;
    if (!isFirstForAction(e)) continue;

    const proceeds  = d.proceeds;
    const costBasis = d.costBasis ?? (d.proceeds - (d.gain ?? 0));
    const gain      = d.gain ?? 0;
    records.push({
      description:  d.description ?? 'Investment Account',
      dateAcquired: 'Various',
      dateSold:     new Date(e.date),
      proceeds,
      costBasis,
      gain,
      ..._saleAdjustment(t, proceeds, costBasis, gain),
    });
  }
  return records;
}
