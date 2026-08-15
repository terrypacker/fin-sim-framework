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
import { characterizeAuCapitalGain } from './capital-gain-character.js';

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
  /**
   * @param {object} [opts]
   * @param {import('../../simulation-framework/type-registry.js').TypeRegistry} [opts.typeRegistry]
   *   Source of truth for the currency a disposal's `proceeds` is denominated in
   *   (design 91 §8.6 step 3). Optional: without it the module falls back to
   *   AU_DISPOSAL_CURRENCY below, which a test pins against the manifest so the two
   *   cannot disagree.
   */
  constructor({ typeRegistry = null } = {}) {
    this._typeRegistry = typeRegistry;
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
      // Extracted ONCE and then split per person. Previously the same unfiltered
      // household list was handed to every person's `generate()`, so one taxpayer's
      // supplementary form listed the other's accounts.
      const disposals = cc === 'AU' && journal
        ? _extractAuDisposals(journalEntry, journal, data.fxRate, this._typeRegistry)
        : null;
      return personTaxDetails.flatMap(({ personKey, personName, taxDetail: pd }) => {
        const saleRecords = disposals ? _worksheetRowsFor(disposals, personKey) : [];
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
      // No per-person context, so every disposal belongs to the single filer.
      : cc === 'AU' ? _worksheetRowsFor(_extractAuDisposals(journalEntry, journal, data.fxRate, this._typeRegistry), null)
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
 * The ATO asset category each disposal belongs to — the same nine buckets NAT 4151
 * groups worksheets by, and item 1 of the CGT schedule lists.
 *
 * Foreign-listed shares are **"Other shares"**, not row 1, which the worksheet says
 * in as many words: *"shares listed on a foreign securities exchange and not on an
 * Australian securities exchange. For example, shares listed on the New York Stock
 * Exchange."* So a US brokerage disposal is "Other shares" even though it is the
 * household's main equity holding — and an AU brokerage disposal is not.
 */
const AU_ASSET_CATEGORY = {
  AU_STOCK_WITHDRAWAL_TAX: 'Listed shares (ASX)',
  STOCK_WITHDRAWAL_TAX:    'Other shares',
  COMPANY_SALE_TAX:        'Other shares',
  COLLECTIBLE_SALE_TAX:    'Collectables',
  AU_HOUSE_SALE_TAX:       'Real estate in Australia',
  US_HOUSE_SALE_TAX:       'Other real estate',
};

/**
 * The category for ONE disposal — the map above, except where the payload says the
 * asset is not what its action type suggests.
 *
 * **Bullion is not a collectable, and the category is not cosmetic.** s108-10(2)
 * defines a collectable as artwork, jewellery, an antique, a coin or medallion, a
 * rare folio/manuscript/book, or a stamp/first day cover *"that is used or kept
 * mainly for your (or your associate's) personal use or enjoyment"*. Investment
 * bullion is none of those things and is not kept for enjoyment — which is the same
 * conclusion design 57 Part 2 Item C already reached on the assessment side, where
 * `isGold` routes the gain through ordinary CGT indexation rather than the
 * collectable treatment.
 *
 * Listing it under Collectables anyway asserts two rules that do not apply to it:
 * *"You can only use capital losses from collectables to offset capital gains from
 * collectables"* (s108-10(1), and NAT 4151 item 11 says it in those words), and the
 * s118-10(1) \$500 exemption. A bullion loss offsets ordinary capital gains, so the
 * row belongs in item 12, "Other CGT assets and any other CGT events".
 *
 * The US side of the same disposal reaches the opposite answer, correctly: §408(m)
 * makes *"metals (such as gold, silver, and platinum bullion)"* a collectible for
 * the 28% rate (docs/us-tax/IRS-Schedule-D-Instructions-2025.txt), with no
 * personal-use test. One asset, two definitions — the action type is named for the
 * US one, so the AU document has to read `isGold` rather than the type.
 */
function _auAssetCategory(actionType, data) {
  if (actionType === 'COLLECTIBLE_SALE_TAX' && data?.isGold) return 'Other CGT assets';
  return AU_ASSET_CATEGORY[actionType] ?? 'Other CGT assets';
}

/**
 * FALLBACK ONLY — the currency each AU-assessable disposal's `proceeds` / `costBasis`
 * is denominated in, used when no TypeRegistry was handed to TaxDocumentRegistry.
 *
 * The currency is what the old CGT schedule got wrong: `STOCK_WITHDRAWAL_TAX` carries
 * USD figures (it is a US brokerage disposal) and the schedule printed them straight
 * onto an AUD-denominated document, so the modal formatted USD as A$.
 *
 * Design 91 §8 moved the authority for this into the toolset manifests, where every
 * disposal money field now declares `ValueType.currency(code)` — so `_disposalCurrency`
 * below reads the registry first and this map is only the no-registry path. It is kept
 * (rather than deleted) because several callers construct the registry bare, and
 * pinned against the manifests by tax-worksheet-export.test.mjs so it cannot drift
 * back into being a second opinion.
 */
const AU_DISPOSAL_CURRENCY = {
  AU_STOCK_WITHDRAWAL_TAX: 'AUD',
  AU_HOUSE_SALE_TAX:       'AUD',
  STOCK_WITHDRAWAL_TAX:    'USD',
  US_HOUSE_SALE_TAX:       'USD',
  COMPANY_SALE_TAX:        'USD',
  COLLECTIBLE_SALE_TAX:    'USD',
};

/** Per-person AU capital-gain accumulator, as it appears in a journal state diff. */
const AU_PERSON_GAIN_FIELD = 'auPersonCapitalGainsYTD';

/**
 * Collect the AU-assessable disposals between the previous AU TAX_SETTLE_APPLY and
 * this one, each attributed to the person(s) whose return actually assessed it.
 *
 * **Where the attribution comes from, and why it cannot come from anywhere else.**
 * A tax document is built from `(journalEntry, journal)` and nothing more — the
 * registry has no simulation state. That is not an oversight to route around: state
 * is the WRONG source here, because a document is generated for a settle that may be
 * decades in the past, and by the end of a run people have died and accounts have
 * changed hands. Reading today's `usStockAccount.ownerId` to attribute a 2032 disposal
 * gives the wrong owner with total confidence.
 *
 * The journal, however, already records the answer. When a disposal is booked for an
 * AU resident, `bookAuResident` advances `auPersonCapitalGainsYTD[personKey]`, and the
 * entry's state diff carries that movement per person, in AUD, as assessed. So the
 * attribution here is not a re-derivation of ownership — it is a read of what the
 * return did, which is why the worksheet foots to the summary worksheet by
 * construction rather than by agreement.
 *
 * **The one gap.** A disposal producing no AU gain at all writes no diff key, so it
 * has no attribution of its own. Common right after a residency move, where the
 * s855-45 step-up leaves nothing to tax. Those rows are placed by the ownership split
 * observed for the same `stateKey` elsewhere in the journal — dense in practice,
 * because any account that ever books a gain reveals its owners — and a row that
 * still cannot be placed is reported as unattributed rather than silently dropped or
 * quietly handed to the first taxpayer.
 *
 * @param {object}   currentEntry  - The TAX_SETTLE_APPLY journal entry being reported.
 * @param {object[]} journal       - Full journal entry array.
 * @param {number}   [settleRate]  - USD→AUD at settlement, for rows with no gain to imply one from.
 * @returns {{ disposals: object[], shareByStateKey: Map<string, object> }}
 */
function _extractAuDisposals(currentEntry, journal, settleRate, typeRegistry = null) {
  const currentIdx = journal.indexOf(currentEntry);
  if (currentIdx < 0) return { disposals: [], shareByStateKey: new Map() };

  let yearStartIdx = 0;
  for (let i = currentIdx - 1; i >= 0; i--) {
    if (journal[i].action?.type === 'AU_TAX_SETTLE_APPLY') { yearStartIdx = i + 1; break; }
  }

  const byInstance = _indexByInstance(journal);
  // Ownership learned from the WHOLE journal, not just this year's window: an account
  // that made no taxable gain this year may well have made one in another, and a
  // wider sample is strictly better here because ownership is a property of the
  // account rather than of the year.
  const shareByStateKey = _learnOwnershipShares(journal, byInstance);

  const disposals = [];
  const isFirstForAction = _firstEntryPerAction();
  for (let i = yearStartIdx; i < currentIdx; i++) {
    const e = journal[i];
    const t = e.action?.type;
    const d = e.action?.data;
    if (!d?.proceeds) continue;
    if (!_isAuAssessableDisposal(t, d)) continue;
    if (!isFirstForAction(e)) continue;

    // The AU-measure gain, split into its Division 115 discount-eligible slice and the
    // rest — the same split `characterizeAuCapitalGain` hands the tax module, so the
    // two columns below are the ones the return was actually assessed on. NOT
    // `d.gain`: that is the US gain, measured from the US cost base, and it ignores
    // the s855-45 residency step-up entirely.
    const auChar      = characterizeAuCapitalGain(d, d.auGain ?? 0);
    const nativeGain  = auChar.short + auChar.long;
    const shares      = _personSharesFor(e, byInstance);
    const audTotal    = Object.values(shares).reduce((s, v) => s + v, 0);
    const currency    = _disposalCurrency(typeRegistry, t);

    // Prefer the rate the booking IMPLIES — audTotal / nativeGain is exactly the rate
    // `toAUD` used at that moment, so proceeds and cost base convert on the same
    // footing as the gain rather than on a year-end approximation. Falls back to the
    // settle rate when there is no gain to imply one from.
    const impliedRate = (currency === 'AUD') ? 1
      : (nativeGain !== 0 && audTotal !== 0) ? audTotal / nativeGain
      : (settleRate ?? 1);

    disposals.push({
      stateKey:    d.stateKey ?? null,
      description: d.description
                   ?? (t === 'AU_HOUSE_SALE_TAX' ? 'AU Real Property' : null)
                   ?? DEFAULT_DISPOSAL_DESCRIPTION[t] ?? 'Investment Account',
      category:    _auAssetCategory(t, d),
      dateSold:    new Date(e.date),
      proceeds:    d.proceeds,
      rate:        impliedRate,
      // Native-currency AU figures; the display layer scales by rate × the person's share.
      discountable: auChar.long,
      other:        auChar.short,
      shares:       Object.keys(shares).length > 0 ? shares : null,
      audTotal,
    });
  }
  return { disposals, shareByStateKey };
}

/** Whether a disposal action is assessable on an AU RESIDENT's return. */
/**
 * The currency a disposal action's money fields are denominated in: the manifest's
 * declaration when a TypeRegistry is available, else the pinned fallback map.
 *
 * `proceeds` is the probe field because every AU-assessable disposal type declares it
 * and it is the figure the worksheet actually prints. Design 91 §8.1: the answer is the
 * ACTION TYPE's currency, so any money field on the type would give the same answer.
 */
function _disposalCurrency(typeRegistry, actionType) {
  return typeRegistry?.fieldCurrency?.(actionType, 'proceeds')
      ?? AU_DISPOSAL_CURRENCY[actionType]
      ?? 'USD';
}

function _isAuAssessableDisposal(type, data) {
  // AU-specific action types are AU-source and always assessable here.
  if (type === 'AU_STOCK_WITHDRAWAL_TAX' || type === 'AU_HOUSE_SALE_TAX') return true;
  // Everything else is AU-assessable only while the taxpayer is an AU resident —
  // residents are taxed on worldwide capital gains, non-residents only on taxable
  // Australian property (s855-10), which the two types above already cover.
  return AU_DISPOSAL_CURRENCY[type] != null && data?.residency === 'AU';
}

/**
 * `instanceId` → the journal entries sharing it, built once per document.
 *
 * Without it, `_personSharesFor` scans the whole journal per disposal, which on the
 * reference plan is ~1,000 disposals × 38,726 entries — 1.17 SECONDS to open one tax
 * document, growing quadratically with the run length. The same shape of defect
 * design 78 found in `getAll()`, and a modal that hangs for a second on click is a
 * user-visible one.
 */
function _indexByInstance(journal) {
  const byId = new Map();
  for (const e of journal) {
    const id = e.action?.instanceId;
    if (id == null) continue;
    const list = byId.get(id);
    if (list) list.push(e); else byId.set(id, [e]);
  }
  return byId;
}

/**
 * Per-person AUD amounts this disposal booked, read from the state diffs of every
 * journal entry sharing its `instanceId`.
 *
 * Summed across entries rather than taken from the first: an action fans out to one
 * entry per consuming reducer, and which of them books the AU gain depends on the
 * action type (`dynamic:US:STOCK_WITHDRAWAL_TAX` for a US disposal, the AU module's
 * reducer for an AU one). Only one reducer ever writes this accumulator per action,
 * so the sum cannot double-count.
 */
function _personSharesFor(entry, byInstance) {
  const id = entry.action?.instanceId;
  const entries = id == null ? [entry] : (byInstance.get(id) ?? [entry]);
  const shares = {};
  for (const e of entries) {
    for (const f of e.stateDiff ?? []) {
      if (!f.field?.startsWith(`${AU_PERSON_GAIN_FIELD}.`)) continue;
      const key = f.field.slice(AU_PERSON_GAIN_FIELD.length + 1);
      const delta = f.delta ?? ((f.after ?? 0) - (f.before ?? 0));
      if (delta) shares[key] = (shares[key] ?? 0) + delta;
    }
  }
  return shares;
}

/**
 * stateKey → normalised ownership fractions, learned from every disposal in the
 * journal that DID book a per-person gain.
 *
 * This exists only to place the zero-gain rows described in `_extractAuDisposals`.
 * It is an inference, not a record, so it is deliberately kept to the narrowest job:
 * it never overrides a row's own booked attribution, and it contributes no gain — the
 * rows it places carry zero in every gain column by construction.
 */
function _learnOwnershipShares(journal, byInstance) {
  const totals = new Map();
  const seen = _firstEntryPerAction();
  for (const e of journal) {
    const d = e.action?.data;
    if (!d?.stateKey || !d?.proceeds) continue;
    if (!seen(e)) continue;
    const shares = _personSharesFor(e, byInstance);
    const sum = Object.values(shares).reduce((s, v) => s + Math.abs(v), 0);
    if (sum === 0) continue;
    const acc = totals.get(d.stateKey) ?? {};
    for (const [k, v] of Object.entries(shares)) acc[k] = (acc[k] ?? 0) + Math.abs(v);
    totals.set(d.stateKey, acc);
  }

  const out = new Map();
  for (const [key, acc] of totals) {
    const sum = Object.values(acc).reduce((s, v) => s + v, 0);
    if (sum > 0) out.set(key, Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, v / sum])));
  }
  return out;
}

/**
 * Turn extracted disposals into the rows of ONE taxpayer's worksheet.
 *
 * `personKey === null` means "no per-person context" — the legacy single-`taxDetail`
 * settle — and yields whole-disposal rows, which is correct there because there is
 * only one filer to attribute them to.
 *
 * @returns {{ rows: object[], unattributed: { count: number, proceeds: number } }}
 */
function _worksheetRowsFor({ disposals, shareByStateKey }, personKey) {
  const rows = [];
  const unattributed = { count: 0, proceeds: 0 };

  for (const d of disposals) {
    let fraction = 1;
    if (personKey != null) {
      const shares = d.shares ?? shareByStateKey.get(d.stateKey) ?? null;
      if (!shares) {
        // Neither booked nor inferable. Disclosed identically on every worksheet —
        // the count is a property of the settle, not of who is reading it.
        unattributed.count += 1;
        unattributed.proceeds += d.proceeds * d.rate;
        continue;
      }
      // This person's share of what the disposal actually assessed. Taken on
      // magnitudes so a loss splits between owners exactly as a gain does.
      const total = Object.values(shares).reduce((s, v) => s + Math.abs(v), 0);
      fraction = total === 0 ? 0 : Math.abs(shares[personKey] ?? 0) / total;
      if (fraction === 0) continue;
    }

    const proceeds     = d.proceeds * d.rate * fraction;
    const discountable = d.discountable * d.rate * fraction;
    const other        = d.other * d.rate * fraction;
    const signedGain   = discountable + other;
    rows.push({
      // Both, deliberately. `stateKey` is the account's durable identity and the only
      // thing a display name can be resolved FROM (design 70: show the name, keep the
      // key); `description` is the emitter's `account.name || stateKey`, which is the
      // stateKey itself whenever the account carries no explicit name — the reason
      // these rows read `usStockAccount` instead of "US Brokerage (Terry)".
      stateKey:     d.stateKey,
      description:  d.description,
      category:     d.category,
      dateSold:     d.dateSold,
      proceeds,
      // The AU cost base — capital proceeds less the AU-measure gain, i.e. the
      // s855-45 stepped-up base, NOT the US basis the disposal also carries.
      costBase:     proceeds - signedGain,
      discountGain: Math.max(0, discountable),
      otherGain:    Math.max(0, other),
      // NAT 4151 computes a loss in its own column, from the REDUCED cost base rather
      // than the cost base. We do not track a reduced cost base separately, so a loss
      // here is the negative gain — correct wherever the two bases agree, which is
      // every asset the model builds (no recouped or deductible expenditure).
      loss:         Math.max(0, -signedGain),
    });
  }
  return { rows, unattributed };
}

/**
 * Every disposal reported on Form 8949 / Schedule D.
 *
 * `STOCK_WITHDRAWAL_TAX` covers explicit sales (StockWithdrawalApplyReducer) and
 * brokerage drawdowns (`AccountService.replenishSavings`). The house and company
 * types used to be missing, so Schedule D silently omitted those disposals while
 * Form 1040 counted them — the reason CY2026 read `L6 650,000` against a Schedule D
 * of `0.00`.
 *
 * **Collectibles belong here too, and used to be excluded on a wrong premise** — that
 * a 28% asset has "its own Form 1040 line, not line 6". It does not. The 28% rate of
 * §1(h)(4) is a RATE segregation, not a separate reporting channel: a collectible is
 * reported on Form 8949 like any other sale and reaches Schedule D inside the Part II
 * totals, and the 28% Rate Gain Worksheet then pulls it back out for the rate
 * computation. The instructions say both halves in as many words:
 *
 *   "28% Rate Gain Worksheet—Line 18 … 1. Enter the total of all collectibles gain or
 *    (loss) from items you reported on Form 8949, Part II"
 *      — docs/us-tax/IRS-Schedule-D-Instructions-2025.txt
 *
 *   "You disposed of collectibles … [code] C … Enter -0- in column (g). Report the
 *    disposition on Form 8949 as you would report any sale or exchange."
 *      — docs/us-tax/IRS-Form-8949-Instructions-2025.txt
 *
 * The US accumulator a collectible feeds (`usCollectibleGainsYTD`) is separate from
 * `usCapitalGainsYTD`, which is why this set is no longer described as "the types
 * that feed line 6" — membership is about what the schedules disclose, not about
 * which bucket the rate computation reads.
 */
const US_DISPOSAL_ACTION_TYPES = new Set([
  'STOCK_WITHDRAWAL_TAX', 'US_HOUSE_SALE_TAX', 'COMPANY_SALE_TAX', 'COLLECTIBLE_SALE_TAX',
]);

/**
 * Column (a) fallback when the emitter sends no `description` and the row has no
 * `stateKey` to resolve a display name from. `COLLECTIBLE_SALE_TAX` is the case that
 * needs it: neither emitter declares `description`, and "Investment Account" on a
 * gold row is worse than a generic label — it names the wrong kind of asset on the
 * one row whose asset class is the reason it is coded C.
 */
const DEFAULT_DISPOSAL_DESCRIPTION = {
  COLLECTIBLE_SALE_TAX: 'Collectible',
};

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
 * **Code C carries no adjustment.** A collectibles disposition is coded even though
 * column (g) is zero — the code is what identifies the row as 28%-rate property for
 * the 28% Rate Gain Worksheet, so unlike H it is a property of the ASSET rather than
 * of a reconciling difference: *"You disposed of collectibles … C … Enter -0- in
 * column (g)"* (docs/us-tax/IRS-Form-8949-Instructions-2025.txt). Codes are entered
 * in alphabetical order when more than one applies; the two cannot co-occur here (a
 * main home is not a collectible), but the sort keeps that true by construction
 * rather than by luck.
 *
 * @returns {{ adjustment: number, code: string }}
 */
function _saleAdjustment(actionType, proceeds, costBasis, gain) {
  const adjustment = Math.round(((gain - (proceeds - costBasis)) + Number.EPSILON) * 100) / 100;
  const codes = [];
  if (actionType === 'COLLECTIBLE_SALE_TAX') codes.push('C');
  // H is specifically the main-home exclusion; any OTHER non-zero adjustment is a real
  // reconciling difference we have no authority to label, so it stays coded blank
  // rather than borrowing a code that would misstate why the return differs.
  if (adjustment !== 0 && actionType === 'US_HOUSE_SALE_TAX') codes.push('H');
  return { adjustment, code: codes.sort().join('') };
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
      // Carried for the same reason the AU worksheet carries it: Form 8949 and
      // Schedule D describe the same accounts and would otherwise print raw stateKeys
      // beside an AU worksheet that prints names.
      stateKey:     d.stateKey,
      description:  d.description ?? DEFAULT_DISPOSAL_DESCRIPTION[t] ?? 'Investment Account',
      dateAcquired: 'Various',
      dateSold:     new Date(e.date),
      proceeds,
      costBasis,
      gain,
      // What the 28% Rate Gain Worksheet selects on. Kept as a record flag rather
      // than re-derived from the code letter in the document module: the code is a
      // presentation detail of column (f), the 28%-rate character is the fact.
      collectible:  t === 'COLLECTIBLE_SALE_TAX',
      ..._saleAdjustment(t, proceeds, costBasis, gain),
    });
  }
  return records;
}
