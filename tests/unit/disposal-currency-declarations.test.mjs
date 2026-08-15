/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * disposal-currency-declarations.test.mjs — design 91 §8.6 step 4.
 *
 * A disposal action's money fields are denominated in the ACTION TYPE's country
 * currency, not in whatever its field names suggest: `auGain` on a US brokerage
 * disposal is USD, because the emitter works in the asset's currency and the AU tax
 * module converts on the way into its own accumulator. Nothing enforced that. The
 * fact lived in three places at once — literals in the tax modules
 * (`toAUD(auGain, 'USD', state)`), a private table in tax-document-registry
 * (AU_DISPOSAL_CURRENCY, added after the AU CGT schedule shipped printing USD as A$),
 * and, since §8.4, the toolset manifests.
 *
 * These tests make the manifest's answer checkable against the other two:
 *
 *   1. INFERRED vs DECLARED — run each disposal through its real tax-module reducer
 *      with a distinctive FX rate and read back which currency the module treated the
 *      payload as. Compare that to the manifest. This derives the truth from
 *      behaviour rather than restating the table a fourth time.
 *   2. FALLBACK vs MANIFEST — the AU CGT worksheet built with a TypeRegistry and
 *      without one must agree, so the no-registry fallback map cannot drift.
 *   3. The detector works — a registry declaring a DIFFERENT currency must change the
 *      worksheet, or tests 1-2 would pass on a lookup nobody reads.
 *
 * Run with: node --test tests/unit/disposal-currency-declarations.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { TypeRegistry }        from '../../src/simulation-framework/type-registry.js';
import { JournalEntry }        from '../../src/simulation-framework/journal.js';
import { UsTaxModule2026 }     from '../../src/finance/tax/us/us-tax-module-2026.js';
import { AuTaxModule2026 }     from '../../src/finance/tax/au/au-tax-module-2026.js';
import { TaxDocumentRegistry } from '../../src/finance/tax/tax-document-registry.js';
import { AuTaxRates2025 }      from '../../src/finance/tax/au/au-tax-rates-2025.js';

import { US_BROKERAGE }     from '../../src/scenarios/toolsets/us-brokerage-toolset.js';
import { AU_BROKERAGE }     from '../../src/scenarios/toolsets/au-brokerage-toolset.js';
import { US_REAL_PROPERTY } from '../../src/scenarios/toolsets/us-real-property-toolset.js';
import { AU_REAL_PROPERTY } from '../../src/scenarios/toolsets/au-real-property-toolset.js';
import { US_COLLECTIBLES }  from '../../src/scenarios/toolsets/us-collectibles-toolset.js';
import { US_INCOME }        from '../../src/scenarios/toolsets/us-income-toolset.js';

// A rate far from 1 so "converted" and "not converted" cannot be confused, and not a
// round multiple of the gain so an accidental factor shows up as an odd number.
const RATE = 2.5;
const GAIN = 1000;

function typeRegistry() {
  const reg = new TypeRegistry();
  for (const t of [US_BROKERAGE, AU_BROKERAGE, US_REAL_PROPERTY, AU_REAL_PROPERTY,
                   US_COLLECTIBLES, US_INCOME]) {
    reg.registerToolset(t);
  }
  return reg;
}

/**
 * Every AU-assessable disposal type, with the accumulator that reveals the unit.
 *
 * A US-cc disposal booked for an AU resident writes the AU accumulator, so the AU
 * accumulator's value relative to the payload says whether the module converted. An
 * AU-cc disposal is the mirror: it writes the US accumulator.
 */
const CASES = [
  { type: 'STOCK_WITHDRAWAL_TAX',    module: 'US', watch: 'auCapitalGainsYTD' },
  { type: 'US_HOUSE_SALE_TAX',       module: 'US', watch: 'auCapitalGainsYTD' },
  { type: 'COLLECTIBLE_SALE_TAX',    module: 'US', watch: 'auCapitalGainsYTD' },
  { type: 'COMPANY_SALE_TAX',        module: 'US', watch: 'auCapitalGainsYTD' },
  { type: 'AU_STOCK_WITHDRAWAL_TAX', module: 'AU', watch: 'usCapitalGainsYTD' },
  { type: 'AU_HOUSE_SALE_TAX',       module: 'AU', watch: 'usCapitalGainsYTD' },
];

/** State an AU-resident disposal reducer needs, with every watched bucket at zero. */
function baseState() {
  return {
    people: { primary: { residency: 'AU' } },
    effectiveExchangeRates: { USD_AUD: RATE },
    usCapitalGainsYTD: 0, usCollectibleGainsYTD: 0, usOrdinaryIncomeYTD: 0,
    usShortTermCapitalGainsYTD: 0, usLongTermCapitalGainsYTD: 0,
    usNetInvestmentIncomeYTD: 0, usUnrecaptured1250GainYTD: 0,
    auCapitalGainsYTD: 0, auDiscountableGainsYTD: 0, auRealCapitalGainsYTD: 0,
    auOrdinaryIncomeYTD: 0, auNonResidentWithholdingYTD: 0,
    auDiscountAllowanceYTD: 0, auDiscountApportionedBaseYTD: 0,
    foreignGeneralIncomeYTD: 0, foreignPassiveIncomeYTD: 0,
    usSourceOrdinaryUsdYTD: 0, usSourceCapGainsUsdYTD: 0,
    usSourceOrdinaryAudYTD: 0, usSourceCapGainsAudYTD: 0,
    usSourceRealCapGainsAudYTD: 0,
  };
}

const disposalAction = type => ({
  type,
  gain: GAIN, auGain: GAIN, auIndexedGain: GAIN, auDiscountableGain: GAIN,
  proceeds: GAIN * 3, costBasis: GAIN * 2,
  residency: 'AU', description: 'probe', isGold: false,
});

/**
 * Which currency the tax module treated this action's payload as, inferred from how
 * far the watched accumulator moved: a payload in the accumulator's own currency lands
 * 1:1, one in the other currency lands scaled by the rate.
 */
function inferPayloadCurrency({ type, module, watch }) {
  const fns   = (module === 'US' ? new UsTaxModule2026() : new AuTaxModule2026()).getReducerFns();
  const fn    = fns.get(type);
  assert.ok(fn, `${type} must have a reducer fn in the ${module} tax module`);

  const before = baseState();
  const after  = fn(before, disposalAction(type));
  const moved  = (after[watch] ?? 0) - (before[watch] ?? 0);
  assert.notStrictEqual(moved, 0, `${type} must move ${watch} for this probe to say anything`);

  const ratio = Math.abs(moved) / GAIN;
  // Ratio ~1 ⇒ the payload was already in the accumulator's currency.
  // Ratio ~RATE (US payload → AUD bucket) or ~1/RATE (AUD payload → USD bucket) ⇒ converted.
  const accumulatorCcy = watch.startsWith('au') ? 'AUD' : 'USD';
  const otherCcy       = accumulatorCcy === 'AUD' ? 'USD' : 'AUD';
  const near = (a, b) => Math.abs(a - b) < 0.01;

  if (near(ratio, 1))                        return accumulatorCcy;
  if (near(ratio, RATE) || near(ratio, 1 / RATE)) return otherCcy;
  assert.fail(`${type}: ${watch} moved by ${ratio}× the payload — neither 1, ${RATE} nor ${1 / RATE}, ` +
              'so the unit cannot be inferred. Has the accumulator gained another term?');
}

// ─── 1. The manifest agrees with what the tax modules actually do ─────────────

test('every disposal type declares the currency its tax module converts from', () => {
  const reg = typeRegistry();
  const mismatches = [];

  for (const c of CASES) {
    // Probe whichever money field the type declares, preferring `proceeds`. The
    // fallback to `gain` is what let this loop cover COLLECTIBLE_SALE_TAX back when it
    // declared no proceeds at all — the defect this test surfaced (design 91 §8.9),
    // since fixed. Kept so a future type that carries only gains is still checked.
    const field    = ['proceeds', 'gain'].find(f => reg.fieldCurrency(c.type, f)) ?? 'proceeds';
    const declared = reg.fieldCurrency(c.type, field);
    assert.ok(declared, `${c.type} must declare a currency on a money field (design 91 §8.4)`);
    const inferred = inferPayloadCurrency(c);
    if (declared !== inferred) {
      mismatches.push(`  ${c.type}.${field}: manifest says ${declared}, but the ${c.module} ` +
                      `tax module treats the payload as ${inferred} (watched ${c.watch})`);
    }
  }

  assert.equal(mismatches.length, 0,
    'a disposal type declares a currency its own tax module disagrees with:\n' + mismatches.join('\n'));
});

test('the `au*` gain fields on a US disposal are USD, not AUD', () => {
  // The specific trap design 91 §8.1 exists to prevent: `auGain` means "measured on
  // the AU basis", not "denominated in AUD". Stated as its own test because the loop
  // above would still pass if someone typed the au* fields differently from `proceeds`.
  const reg = typeRegistry();
  for (const field of ['auGain', 'auDiscountableGain', 'auShortTermGain', 'auLongTermGain']) {
    assert.strictEqual(reg.fieldCurrency('STOCK_WITHDRAWAL_TAX', field), 'USD',
      `STOCK_WITHDRAWAL_TAX.${field} is USD — a US brokerage disposal is measured in USD ` +
      'whichever country is assessing it');
  }
  for (const field of ['usShortTermGain', 'usLongTermGain']) {
    assert.strictEqual(reg.fieldCurrency('AU_HOUSE_SALE_TAX', field), 'AUD',
      `AU_HOUSE_SALE_TAX.${field} is AUD — the mirror of the same rule`);
  }
});

// ─── 2/3. The AU CGT worksheet reads the manifest, and the fallback agrees ────

let _seq = 0;
const entry = ({ actionType, data, date }) => new JournalEntry({
  id: `e-${_seq}`, seq: _seq++, date: date ?? new Date(Date.UTC(2033, 5, 15)),
  executionId: 'e1.1',
  event:  { nodeId: null, type: 'EVT', name: 'Evt', color: null },
  action: { instanceId: `i-${_seq}`, parentId: null, rootId: null, siblingIndex: 0,
            nodeId: null, type: actionType, name: actionType, data },
  reducer: { nodeId: null, name: 'R' }, stateDiff: [], emittedInstanceIds: [], emittedTypes: [],
});

/** A settled AU return with CGT activity — what the worksheet hangs off. */
const auTaxDetail = () => ({
  ...new AuTaxRates2025().computeTax({
    people: { primary: { residency: 'AU' } },
    auOrdinaryIncomeYTD: 80_000, auCapitalGainsYTD: 20_000,
    auNonResidentWithholdingYTD: 0, auSuperTaxYTD: 0, auFrankingCreditYTD: 0,
  }),
  taxYear: 2033,
});

/** A journal holding one USD disposal, closed by the AU settle that reports it. */
function journalWithUsDisposal() {
  const disposal = entry({
    actionType: 'STOCK_WITHDRAWAL_TAX',
    data: { gain: GAIN, auGain: GAIN, proceeds: GAIN * 3, costBasis: GAIN * 2,
            residency: 'AU', description: 'usStockAccount', stateKey: 'usStockAccount' },
  });
  const settle = entry({
    actionType: 'AU_TAX_SETTLE_APPLY',
    date: new Date(Date.UTC(2033, 11, 31)),
    data: { cc: 'AU', fxRate: RATE, taxDetail: auTaxDetail() },
  });
  return { journal: [disposal, settle], settle };
}

/**
 * The "Capital Proceeds" cell of the CGT Worksheet's first row.
 *
 * That worksheet is a `table` of columns/rows rather than the `sections`/`lineItems`
 * shape the ITR uses, and the proceeds cell is where the disposal's own currency
 * shows up: the extractor scales every native figure by the rate it resolved for the
 * disposal, so an unconverted USD row and a converted one differ by that rate.
 */
function worksheetProceeds(docs) {
  const list = Array.isArray(docs) ? docs : [docs];
  const doc  = list.find(d => d?.table?.columns?.includes('Capital Proceeds'));
  if (!doc) return null;
  const col = doc.table.columns.indexOf('Capital Proceeds');
  return doc.table.rows?.[0]?.[col] ?? null;
}

test('the AU CGT worksheet reads the disposal currency off the manifest', () => {
  const { journal, settle } = journalWithUsDisposal();

  const fromManifest = new TaxDocumentRegistry({ typeRegistry: typeRegistry() })
    .generate(settle, journal);
  const fromFallback = new TaxDocumentRegistry().generate(settle, journal);

  const a = worksheetProceeds(fromManifest);
  const b = worksheetProceeds(fromFallback);
  assert.ok(a != null, 'the worksheet must carry a proceeds figure for this probe to mean anything');
  assert.strictEqual(a, b,
    'the no-registry fallback table must agree with the manifest — two answers to ' +
    '"what currency is this disposal in" is exactly the drift design 91 §8.6 step 3 removes');
});

test('a registry declaring a different currency changes the worksheet (detector control)', () => {
  // Without this, the test above would pass even if the registry were ignored entirely.
  const { journal, settle } = journalWithUsDisposal();
  const lying = typeRegistry();
  const real  = lying.fieldCurrency.bind(lying);
  lying.fieldCurrency = (t, f) => (t === 'STOCK_WITHDRAWAL_TAX' ? 'AUD' : real(t, f));

  const truthful = worksheetProceeds(new TaxDocumentRegistry({ typeRegistry: typeRegistry() }).generate(settle, journal));
  const lied     = worksheetProceeds(new TaxDocumentRegistry({ typeRegistry: lying }).generate(settle, journal));

  assert.notStrictEqual(truthful, lied,
    'declaring the disposal AUD must stop the worksheet converting it — if this passes ' +
    'unchanged, TaxDocumentRegistry is not consulting the registry at all');
});

test('a collectible disposal reaches the AU CGT worksheet', () => {
  // Design 91 §8.9. `_extractAuDisposals` skips any disposal with no `proceeds`, and
  // neither collectible emitter sent one — so an AU resident's gold sale was assessed
  // and taxed while appearing on no worksheet row at all. The gain was never in doubt;
  // the disclosure was missing.
  const journal = [
    entry({
      actionType: 'COLLECTIBLE_SALE_TAX',
      data: { gain: GAIN, auGain: GAIN, auIndexedGain: GAIN, isGold: true,
              proceeds: GAIN * 3, costBasis: GAIN * 2,
              residency: 'AU', description: 'collectibleAccount', stateKey: 'collectibleAccount' },
    }),
    entry({
      actionType: 'AU_TAX_SETTLE_APPLY',
      date: new Date(Date.UTC(2033, 11, 31)),
      data: { cc: 'AU', fxRate: RATE, taxDetail: auTaxDetail() },
    }),
  ];
  const docs = new TaxDocumentRegistry({ typeRegistry: typeRegistry() })
    .generate(journal[1], journal);

  const proceeds = worksheetProceeds(docs);
  assert.ok(proceeds != null, 'the collectible disposal must appear as a worksheet row');
  assert.strictEqual(proceeds, GAIN * 3 * RATE,
    'a USD collectible converts onto the AUD worksheet like any other US-domiciled disposal');

  const list = Array.isArray(docs) ? docs : [docs];
  const table = list.find(d => d?.table?.columns?.includes('Capital Proceeds'))?.table;
  // NOT "Collectables" — this row is `isGold`. s108-10(2) makes a collectable an
  // artwork/coin/etc "used or kept mainly for your personal use or enjoyment", which
  // investment bullion is not, and the category carries the s108-10(1) loss
  // quarantine and the s118-10(1) $500 exemption with it. See _auAssetCategory.
  assert.strictEqual(table.rows[0][1], 'Other CGT assets',
    'bullion is an ordinary AU CGT asset, not an ATO collectable');
});

test('a TRUE collectable is categorised as one, and bullion is not', () => {
  // The two halves of s108-10(2), on the one action type that can be either. The US
  // side calls both "collectibles" (§408(m) covers bullion for the 28% rate), so the
  // AU category cannot be read off the action type — only off `isGold`.
  const category = (isGold) => {
    const journal = [
      entry({
        actionType: 'COLLECTIBLE_SALE_TAX',
        data: { gain: GAIN, auGain: GAIN, auIndexedGain: GAIN, isGold,
                proceeds: GAIN * 3, costBasis: GAIN * 2,
                residency: 'AU', description: 'collectibleAccount', stateKey: 'collectibleAccount' },
      }),
      entry({
        actionType: 'AU_TAX_SETTLE_APPLY',
        date: new Date(Date.UTC(2033, 11, 31)),
        data: { cc: 'AU', fxRate: RATE, taxDetail: auTaxDetail() },
      }),
    ];
    const docs = new TaxDocumentRegistry({ typeRegistry: typeRegistry() })
      .generate(journal[1], journal);
    const list = Array.isArray(docs) ? docs : [docs];
    return list.find(d => d?.table?.columns?.includes('Capital Proceeds'))?.table.rows[0][1];
  };

  assert.strictEqual(category(false), 'Collectables',
    'a non-bullion collectible is an ATO collectable (item 11)');
  assert.strictEqual(category(true),  'Other CGT assets',
    'bullion is not (item 12) — otherwise the row asserts a loss quarantine that does not apply to it');
});
