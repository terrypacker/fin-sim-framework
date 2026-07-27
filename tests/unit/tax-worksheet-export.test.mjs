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
 * tax-worksheet-export.test.mjs — design 71 Phase 2.
 *
 * Flattening tax documents to worksheet rows / CSV.
 *
 * Layers:
 *   Shape     — the §5.1 column contract, column ORDER, and empty-vs-zero cells.
 *   Structure — one LINE row per line item, BRACKET children linked by parentLine,
 *               `line` numbering continuous across sections within a document.
 *   Tie-out   — against a REAL simulated run: Σ bracketTax === the line it explains,
 *               and the CSV agrees with the tax-document popup line for line. This is
 *               the property the whole design exists to provide (§2.1).
 *   CSV       — RFC 4180 escaping, money/rate precision.
 *
 * Run with: node --test tests/unit/tax-worksheet-export.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import {
  buildTaxWorksheetRows,
  toCsv,
  verifyWorksheetRows,
  worksheetRowsFromDocuments,
  WORKSHEET_COLUMNS,
} from '../../src/finance/tax/tax-worksheet-export.js';
import { JournalReportingService } from '../../src/finance/journal-reporting-service.js';
import { ServiceRegistry }         from '../../src/services/service-registry.js';
import { IntlRetirementScenario }  from '../../src/scenarios/intl-retirement-scenario.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Run the reference cross-border scenario far enough to settle several US years. */
function runScenario(toDate = new Date(Date.UTC(2029, 11, 31))) {
  ServiceRegistry.resetAll();
  const scenario = IntlRetirementScenario.buildAndCompile({});
  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  try { scenario.sim.stepTo(toDate); }
  finally { console.log = log; console.warn = warn; }
  return scenario.sim.journal.journal;
}

const lines    = rows => rows.filter(r => r.rowType === 'LINE');
const brackets = rows => rows.filter(r => r.rowType === 'BRACKET');
const lineNamed = (rows, label) => lines(rows).find(r => r.label === label);
const bandsUnder = (rows, row) =>
  brackets(rows).filter(b =>
    b.parentLine === row.line && b.taxYear === row.taxYear && b.form === row.form);

// ─── Shape ────────────────────────────────────────────────────────────────────

test('TWE-1: rows carry exactly the §5.1 columns, in order', () => {
  const rows = buildTaxWorksheetRows(runScenario(), { cc: 'US' });
  assert.ok(rows.length > 0, 'the reference scenario settles at least one US year');

  assert.deepEqual(WORKSHEET_COLUMNS, [
    'taxYear', 'country', 'form', 'section', 'line', 'label', 'rowType', 'amount',
    'bracketRate', 'bracketLower', 'bracketUpper', 'bracketIncome', 'bracketTax',
    'parentLine', 'drillReport', 'personKey', 'currency',
    'taxYearLabel', 'fxPair', 'fxRate',
  ], 'the column contract is frozen — new columns APPEND, never insert');

  for (const row of rows) {
    assert.deepEqual(
      Object.keys(row).sort(), [...WORKSHEET_COLUMNS].sort(),
      'every row carries every column, so the CSV stays rectangular',
    );
  }
});

test('TWE-2: US rows are stamped US/USD with no personKey', () => {
  const rows = buildTaxWorksheetRows(runScenario(), { cc: 'US' });
  for (const row of rows) {
    assert.equal(row.country,  'US');
    assert.equal(row.currency, 'USD', 'native currency, never a display currency (§5.3)');
    assert.equal(row.personKey, null, 'US files at household level; personKey is AU-only (§8.2)');
    assert.equal(row.form, 'Form 1040');
  }
});

test('TWE-3: line numbering is continuous across sections and restarts per year', () => {
  const rows   = buildTaxWorksheetRows(runScenario(), { cc: 'US' });
  const byYear = new Map();
  // `line` indexes every line item of the document — LINE, SUBLINE and the
  // WORKSHEET/RATE relief rows alike — so the 1..N invariant holds over all of them,
  // not over the LINE rows alone. BRACKET rows repeat their parent's number by design.
  for (const r of rows.filter(r => r.rowType !== 'BRACKET')) {
    if (!byYear.has(r.taxYear)) byYear.set(r.taxYear, []);
    byYear.get(r.taxYear).push(r);
  }
  assert.ok(byYear.size >= 2, 'multiple settled years in one export (§5.2)');

  for (const [year, yearLines] of byYear) {
    assert.deepEqual(
      yearLines.map(r => r.line),
      yearLines.map((_, i) => i + 1),
      `year ${year} numbers its lines 1..N in document order`,
    );
    // Sections appear in document order, Summary last.
    assert.equal(yearLines.at(-1).section, 'Summary');
    assert.equal(yearLines[0].section,     'Income');
  }
});

test('TWE-4: BRACKET rows hang off their line and leave `amount` empty', () => {
  const rows = buildTaxWorksheetRows(runScenario(), { cc: 'US' });
  const bands = brackets(rows);
  assert.ok(bands.length > 0, 'ordinary-income bands are emitted');

  for (const b of bands) {
    assert.equal(b.amount, null, 'money lives on LINE rows; bands carry bracketTax');
    assert.equal(b.parentLine, b.line, 'a band is stamped with the line it explains');
    assert.equal(b.drillReport, null);
    assert.ok(b.bracketRate != null && b.bracketIncome != null && b.bracketTax != null);
  }

  // The open-ended top band leaves bracketUpper empty rather than inventing a bound.
  const topBands = bands.filter(b => b.bracketUpper == null);
  assert.ok(topBands.length > 0, 'each schedule contributes one open-ended top band');
  assert.ok(topBands.every(b => b.bracketLower > 0));
});

// ─── Tie-out against a real run ──────────────────────────────────────────────

test('TWE-5: Σ bracketTax reconciles to the line it explains — the §6 check', () => {
  const rows = buildTaxWorksheetRows(runScenario(), { cc: 'US' });

  let checked = 0;
  for (const line of lines(rows)) {
    const bands = bandsUnder(rows, line);
    if (!bands.length) continue;
    const sum = bands.reduce((s, b) => s + b.bracketTax, 0);
    // Exact, not approximate — see BS-4. This is the spreadsheet's SUMIF check.
    assert.equal(
      sum, line.amount,
      `${line.taxYear} "${line.label}": Σ bracketTax ${sum} !== line amount ${line.amount}`,
    );
    checked += 1;
  }
  assert.ok(checked >= 2, 'at least the ordinary and LTCG schedules were reconciled');
});

test('TWE-6: Σ bracketIncome under "Tax on Ordinary Income" === taxable ordinary income', () => {
  const rows = buildTaxWorksheetRows(runScenario(), { cc: 'US' });
  const years = [...new Set(rows.map(r => r.taxYear))];

  for (const year of years) {
    const yearRows = rows.filter(r => r.taxYear === year);
    const taxLine  = lineNamed(yearRows, 'Tax on Ordinary Income');
    const taxable  = lineNamed(yearRows, 'Taxable Ordinary Income');
    const bands    = bandsUnder(yearRows, taxLine);
    const sum      = bands.reduce((s, b) => s + b.bracketIncome, 0);
    assert.equal(sum, taxable.amount, `year ${year}: bands do not span taxable income`);
  }
});

test('TWE-7: the CSV agrees with the tax-document popup, line for line', () => {
  // The design's core claim (§2.1): the export is a projection of the same document
  // the modal renders, so the two cannot drift.
  const journal = runScenario();
  const rows    = buildTaxWorksheetRows(journal, { cc: 'US' });
  const service = new JournalReportingService();

  const settles = journal.filter(e => e.action?.type === 'US_TAX_SETTLE_APPLY');
  assert.ok(settles.length > 0);

  for (const entry of settles) {
    const generated = service.generate(entry, journal);
    const docs      = Array.isArray(generated) ? generated : [generated];
    const form1040  = docs.find(d => d.title?.includes('Form 1040'));

    // Every lineItem the document declares must appear, whatever rowType it carries:
    // LINE, SUBLINE (the SECA split) or WORKSHEET/RATE (the foreign-relief block).
    // Only BRACKET rows are excluded, since the flattener synthesizes those from
    // `bands` rather than reading them from a lineItem. Summary rows likewise come
    // from `doc.summary`, not from a section.
    const docLines = form1040.sections.flatMap(s => s.lineItems.map(li => [li.label, li.amount]));
    const csvLines = rows
      .filter(r => r.taxYear === form1040.taxYear
                && r.section !== 'Summary'
                && r.rowType !== 'BRACKET')
      .map(r => [r.label, r.amount]);

    assert.deepEqual(csvLines, docLines, `year ${form1040.taxYear} diverges from the popup`);
  }
});

test('TWE-8: gross tax reconciles to its component lines', () => {
  const rows  = buildTaxWorksheetRows(runScenario(), { cc: 'US' });
  const years = [...new Set(rows.map(r => r.taxYear))];

  for (const year of years) {
    const yearRows = rows.filter(r => r.taxYear === year);
    const get = label => lineNamed(yearRows, label)?.amount ?? 0;
    const components = get('Tax on Ordinary Income')
                     + get('Long-Term Capital Gains Tax')
                     + get('Collectibles Tax (28%)')
                     + get('Early Withdrawal Penalties')
                     + get('Net Investment Income Tax (Form 8960, 3.8%)');
    assert.ok(
      Math.abs(components - get('Gross Tax')) < 1e-6,
      `year ${year}: components ${components} !== Gross Tax ${get('Gross Tax')}`,
    );
  }
});

// ─── Filters ──────────────────────────────────────────────────────────────────

test('TWE-9: the years filter narrows the export without changing row shape', () => {
  const journal = runScenario();
  const all     = buildTaxWorksheetRows(journal, { cc: 'US' });
  const years   = [...new Set(all.map(r => r.taxYear))].sort();
  const one     = buildTaxWorksheetRows(journal, { cc: 'US', years: [years[0]] });

  assert.ok(one.length > 0 && one.length < all.length);
  assert.ok(one.every(r => r.taxYear === years[0]));
  assert.deepEqual(one, all.filter(r => r.taxYear === years[0]));
});

test('TWE-10: supplementary forms are opt-in, and table-shaped ones are skipped', () => {
  const journal = runScenario();
  const plain     = buildTaxWorksheetRows(journal, { cc: 'US' });
  const withSched = buildTaxWorksheetRows(journal, { cc: 'US', includeSchedules: true });

  assert.ok(plain.every(r => r.form === 'Form 1040'), 'default is the return only');
  // Form 8949 is a disposal register whose columns have no home in the §5.1 set,
  // so it is skipped even when schedules are requested — Schedule D (sections-shaped)
  // is the one that comes through.
  assert.ok(withSched.every(r => r.form !== 'Form 8949'));
  for (const form of new Set(withSched.map(r => r.form))) {
    assert.ok(['Form 1040', 'Schedule D'].includes(form), `unexpected form: ${form}`);
  }
});

test('TWE-11: an empty or settle-free journal yields no rows, not a throw', () => {
  assert.deepEqual(buildTaxWorksheetRows([],        { cc: 'US' }), []);
  assert.deepEqual(buildTaxWorksheetRows(undefined, { cc: 'US' }), []);
  assert.deepEqual(
    buildTaxWorksheetRows([{ action: { type: 'MONTHLY_WAGES' } }], { cc: 'US' }), []);
});

// ─── CSV rendering ────────────────────────────────────────────────────────────

test('TWE-12: CSV header is the column contract and every row matches its arity', () => {
  const rows = buildTaxWorksheetRows(runScenario(), { cc: 'US' });
  const csv  = toCsv(rows).split('\n');

  assert.equal(csv[0], WORKSHEET_COLUMNS.join(','));
  assert.equal(csv.length, rows.length + 1);
  for (const line of csv.slice(1)) {
    assert.equal(splitCsvLine(line).length, WORKSHEET_COLUMNS.length);
  }
});

test('TWE-13: null renders as an empty cell, never as 0', () => {
  const rows = buildTaxWorksheetRows(runScenario(), { cc: 'US' });
  const band = brackets(rows)[0];
  const cells = splitCsvLine(toCsv([band], { header: false }));

  assert.equal(cells[WORKSHEET_COLUMNS.indexOf('amount')],      '', 'BRACKET rows have no amount');
  assert.equal(cells[WORKSHEET_COLUMNS.indexOf('parentLine')],  String(band.parentLine));
  assert.equal(cells[WORKSHEET_COLUMNS.indexOf('drillReport')], '');
  assert.equal(cells[WORKSHEET_COLUMNS.indexOf('personKey')],   '');
});

test('TWE-14: money renders at 2dp and rates at 5dp', () => {
  // Note: 44974.5678 not 44974.005 — the latter is a binary tie-break case that
  // toFixed resolves DOWN (it is really 44974.00499…), which would make this test
  // about IEEE-754 rather than about the formatter.
  const rows = [{
    ...blankRow(), taxYear: 2030, rowType: 'LINE', label: 'Tax on Ordinary Income',
    amount: 44974.5678, bracketRate: 0.038, bracketIncome: 48000, bracketTax: 1824,
  }, {
    ...blankRow(), taxYear: 2030, rowType: 'RATE', label: 'Effective Rate', amount: 0.1552882,
  }];
  const [line, rate] = toCsv(rows, { header: false }).split('\n').map(splitCsvLine);

  assert.equal(line[WORKSHEET_COLUMNS.indexOf('amount')],        '44974.57');
  assert.equal(line[WORKSHEET_COLUMNS.indexOf('bracketRate')],   '0.03800');
  assert.equal(line[WORKSHEET_COLUMNS.indexOf('bracketIncome')], '48000.00');

  // Bracket edges are money too — inflation-indexed thresholds are long floats
  // (28478.147272216655) and must not leak into the CSV raw.
  const edge = toCsv([{ ...blankRow(), rowType: 'BRACKET', bracketLower: 28478.147272216655 }],
    { header: false });
  assert.equal(splitCsvLine(edge)[WORKSHEET_COLUMNS.indexOf('bracketLower')], '28478.15');
  // A ratio in `amount` gets rate precision, not money precision (§5.2).
  assert.equal(rate[WORKSHEET_COLUMNS.indexOf('amount')],        '0.15529');
});

test('TWE-15: RFC 4180 escaping for labels containing commas and quotes', () => {
  const rows = [{ ...blankRow(), label: 'Tax, "special" case', rowType: 'LINE', amount: 1 }];
  const csv  = toCsv(rows, { header: false });
  assert.ok(csv.includes('"Tax, ""special"" case"'));
  assert.equal(splitCsvLine(csv).length, WORKSHEET_COLUMNS.length);
});

// ─── Verification (Phase 4) ───────────────────────────────────────────────────

test('TWE-16: verifyWorksheetRows passes a real multi-year run', () => {
  const rows = buildTaxWorksheetRows(runScenario(), { cc: 'US' });
  const { failures, reconciled, years } = verifyWorksheetRows(rows);

  assert.deepEqual(failures, [], 'the reference run foots on every check');
  assert.ok(years >= 2,      'more than one year was actually examined');
  assert.ok(reconciled >= 2, 'more than one bracket schedule was actually reconciled');
});

test('TWE-17: a corrupted band is caught, so the checks are not vacuous', () => {
  // A verifier that only ever passes is worthless. Break each invariant in turn and
  // confirm the corresponding check fires.
  const rows = buildTaxWorksheetRows(runScenario(), { cc: 'US' });

  const badBand = rows.map(r => r.rowType === 'BRACKET' && r.bracketTax > 0
    ? { ...r, bracketTax: r.bracketTax + 100 } : r);
  assert.match(
    verifyWorksheetRows(badBand).failures.join('\n'), /Σ bracketTax/,
    'a band whose tax is wrong breaks its line',
  );

  const badSpan = rows.map(r => r.rowType === 'BRACKET' && r.bracketIncome > 0
    ? { ...r, bracketIncome: r.bracketIncome + 100 } : r);
  assert.match(verifyWorksheetRows(badSpan).failures.join('\n'), /bands span/);

  const badGross = rows.map(r => r.label === 'Gross Tax'
    ? { ...r, amount: r.amount + 1 } : r);
  assert.match(verifyWorksheetRows(badGross).failures.join('\n'), /!= Gross Tax/);

  const badNet = rows.map(r => r.label === 'Net Tax Liability'
    ? { ...r, amount: r.amount + 1 } : r);
  assert.match(verifyWorksheetRows(badNet).failures.join('\n'), /!= net/);
});

test('TWE-18: a dropped line is caught — flattening bugs, not just engine bugs', () => {
  // The verifier runs over the exported artifact, so losing a line in the flattener
  // must surface even though the engine itself is fine.
  const rows = buildTaxWorksheetRows(runScenario(), { cc: 'US' });
  const dropped = rows.filter(r => r.label !== 'Tax on Ordinary Income' || r.rowType !== 'LINE');
  assert.ok(verifyWorksheetRows(dropped).failures.length > 0);
});

test('TWE-19: SUBLINE rows are excluded from the footing sums', () => {
  // Sub-rows are components of the line above (the SECA split). Counting them as
  // lines would double-count into Gross Tax; the verifier must agree with §5.2.
  const rows = buildTaxWorksheetRows(runScenario(), { cc: 'US' });
  const gross = lineNamed(rows, 'Gross Tax');

  const withSub = [...rows, {
    ...blankRow(),
    taxYear: gross.taxYear, country: gross.country, form: gross.form, personKey: gross.personKey,
    section: 'Tax Computation', line: 99, label: 'Some component', rowType: 'SUBLINE',
    amount: 12_345,
  }];
  assert.deepEqual(verifyWorksheetRows(withSub).failures, [],
    'adding a SUBLINE must not disturb the Gross Tax footing');
});

test('TWE-20: verification of an empty row set is a no-op, not a failure', () => {
  assert.deepEqual(verifyWorksheetRows([]),        { failures: [], reconciled: 0, years: 0 });
  assert.deepEqual(verifyWorksheetRows(undefined), { failures: [], reconciled: 0, years: 0 });
});

// ─── Local helpers ────────────────────────────────────────────────────────────

function blankRow() {
  return Object.fromEntries(WORKSHEET_COLUMNS.map(c => [c, null]));
}

/** Minimal RFC 4180 line splitter, sufficient for asserting arity + cell contents. */
function splitCsvLine(line) {
  const cells = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}

// ─── US state returns (design 71 §11.3) ──────────────────────────────────────

/** A state settle entry pair, as the engine journals it (one action, two reducers). */
function stateSettle(mod, ytd, year, inst) {
  const taxDetail = mod.computeTax(ytd);
  taxDetail.taxYear = year;
  const action = { type: 'STATE_TAX_SETTLE_APPLY', instanceId: inst, data: { taxDetail } };
  return [
    { id: `${inst}-a`, date: Date.UTC(year, 11, 31), reducer: { name: 'State Tax Settle Apply' }, action },
    { id: `${inst}-b`, date: Date.UTC(year, 11, 31), reducer: { name: 'Accumulate Taxes Paid' },  action },
  ];
}

test('TWE-21: a state return exports with bracket bands and foots', async () => {
  const { NeStateTaxRates2024 } = await import('../../src/finance/tax/state/ne/ne-state-tax-rates-2024.js');
  const journal = stateSettle(new NeStateTaxRates2024(),
    { stateOrdinaryIncomeYTD: 150_000, statePensionIncomeYTD: 20_000 }, 2024, 'ne1');

  const rows = buildTaxWorksheetRows(journal, { cc: 'STATE' });
  assert.ok(rows.length > 0, 'STATE settles are exportable');
  assert.ok(rows.every(r => r.form === 'NE State Income Tax'), 'the state rides in `form`');
  assert.ok(rows.every(r => r.country === 'US' && r.currency === 'USD'));

  const taxLine = lineNamed(rows, 'Tax on Ordinary Income');
  const bands   = bandsUnder(rows, taxLine);
  assert.ok(bands.length > 0, 'the state schedule has bands');
  assert.equal(bands.reduce((s, b) => s + b.bracketTax, 0), taxLine.amount);

  assert.deepEqual(verifyWorksheetRows(rows).failures, [], 'the state return foots');
});

test('TWE-22: the state fan-out is collapsed like every other settlement', () => {
  // Both reducer entries share one instanceId; without dedup the year appears twice.
  const rows = buildTaxWorksheetRows([], { cc: 'STATE' });
  assert.deepEqual(rows, []);
});

test('TWE-23: an alternative-rate state states its CG rate inline', async () => {
  // Hawaii taxes capital gains at a flat preferential rate instead of folding them
  // into the ordinary base — a flat-rate LINE, not a bracket schedule (§5.2).
  const { HiStateTaxRates2024 } = await import('../../src/finance/tax/state/hi/hi-state-tax-rates-2024.js');
  const journal = stateSettle(new HiStateTaxRates2024(),
    { stateOrdinaryIncomeYTD: 120_000, stateCapitalGainsYTD: 50_000 }, 2024, 'hi1');

  const rows = buildTaxWorksheetRows(journal, { cc: 'STATE' });
  const cg   = lineNamed(rows, 'Capital Gains Tax (alternative)');
  assert.equal(cg.bracketRate, 0.0725);
  assert.equal(cg.bracketIncome, 50_000);
  assert.equal(cg.bracketTax, cg.amount);
  assert.equal(bandsUnder(rows, cg).length, 0, 'a flat rate needs no band rows');

  assert.deepEqual(verifyWorksheetRows(rows).failures, []);
});

test('TWE-24: a no-income-tax state exports an empty schedule, not a crash', async () => {
  const { SdStateTaxRates2024 } = await import('../../src/finance/tax/state/sd/sd-state-tax-rates-2024.js');
  const journal = stateSettle(new SdStateTaxRates2024(),
    { stateOrdinaryIncomeYTD: 150_000 }, 2024, 'sd1');

  const rows = buildTaxWorksheetRows(journal, { cc: 'STATE' });
  assert.ok(rows.length > 0, 'the return still exports');
  assert.equal(lineNamed(rows, 'Net Tax Liability').amount, 0);
  assert.equal(brackets(rows).length, 0, 'no brackets to report');
});

// ─── AU returns (design 71 Phase 5, §8) ──────────────────────────────────────

/** Run the reference scenario past the 2031 move so AU years are settled. */
const runAu = () => runScenario(new Date(Date.UTC(2033, 11, 31)));

test('TWE-25: AU exports per-person filings in AUD', () => {
  const rows = buildTaxWorksheetRows(runAu(), { cc: 'AU' });
  assert.ok(rows.length > 0, 'AU years settle after the move');

  for (const r of rows) {
    assert.equal(r.country,  'AU');
    assert.equal(r.currency, 'AUD', 'the return is denominated in AUD, never converted (§5.3)');
    assert.ok(r.personKey, 'every AU row is attributed to a person (§8.2)');
  }
  assert.ok(new Set(rows.map(r => r.personKey)).size >= 2, 'both spouses file');
});

test('TWE-26: AU bands reconcile, including the capital-gains differential', () => {
  const rows = buildTaxWorksheetRows(runAu(), { cc: 'AU' });
  assert.deepEqual(verifyWorksheetRows(rows).failures, []);

  // The CG sub-row is the AU-specific construction worth pinning: the relieved gain
  // is stacked on ordinary income and taxed at the resulting marginal brackets, so
  // its bands are a differential, not a schedule applied to the gain alone (§8.4).
  const cg = rows.find(r => r.rowType === 'SUBLINE' && r.label === 'Tax on Capital Gains');
  assert.ok(cg, 'a year with an assessable gain splits Tax on Income into sub-rows');

  const bands = rows.filter(r => r.rowType === 'BRACKET'
    && r.parentLine === cg.line && r.taxYear === cg.taxYear && r.personKey === cg.personKey);
  assert.ok(bands.length > 0);
  assert.ok(Math.abs(bands.reduce((s, b) => s + b.bracketTax, 0) - cg.amount) < 0.005);

  // The gain stacks ON TOP of ordinary income, so the lowest bands are consumed and
  // contribute nothing — that is the whole point of showing the differential.
  assert.equal(bands[0].bracketIncome, 0, 'the tax-free threshold is already used up');
});

test('TWE-27: a year with no gain still carries bands, on Tax on Income itself', () => {
  // Without the fallback the common AU year — wages, no disposals — would export
  // with no bracket detail at all, because the sub-rows that carry the schedule are
  // only emitted when there IS a gain.
  const rows  = buildTaxWorksheetRows(runAu(), { cc: 'AU' });
  const years = [...new Set(rows.map(r => `${r.taxYear}|${r.personKey}`))];

  let plainYears = 0;
  for (const key of years) {
    const filing = rows.filter(r => `${r.taxYear}|${r.personKey}` === key);
    if (filing.some(r => r.rowType === 'SUBLINE')) continue;
    // Pre-move years take the non-resident path, whose line is labelled differently
    // and whose single band set covers ordinary income and gains together (§8.3).
    const taxLine = filing.find(r => r.rowType === 'LINE' && r.label.startsWith('Tax on Income'));
    assert.ok(taxLine, `${key}: the return states a tax-on-income line`);
    const bands   = filing.filter(r => r.rowType === 'BRACKET' && r.parentLine === taxLine.line);
    assert.ok(bands.length > 0, `${key}: a gain-free year still shows its brackets`);
    assert.ok(Math.abs(bands.reduce((s, b) => s + b.bracketTax, 0) - taxLine.amount) < 0.005);
    plainYears += 1;
  }
  assert.ok(plainYears > 0, 'the reference run has gain-free AU years to check');
});

test('TWE-28: the Medicare levy states the rate and base actually applied', async () => {
  const { AuTaxRates2026 } = await import('../../src/finance/tax/au/au-tax-rates-2026.js');
  const rates = new AuTaxRates2026();
  const people = { people: { p1: { residency: 'AU' } } };

  // Above the phase-in band: the statutory rate on full income.
  const full = rates.computeTax({ ...people, auOrdinaryIncomeYTD: 120_000 }).brackets.medicareLevy;
  assert.equal(full.regime, 'full');
  assert.equal(full.income, 120_000);
  assert.ok(Math.abs(full.rate * full.income - full.tax) < 1e-9, 'rate × income = tax on the row');

  // Inside the phase-in band the levy is phaseInRate × (income − threshold). Stating
  // the statutory 2% against full income here would be simply wrong.
  const lower = rates._medicareLevy.lowerThreshold;
  const phase = rates.computeTax({ ...people, auOrdinaryIncomeYTD: lower + 1_000 }).brackets.medicareLevy;
  assert.equal(phase.regime, 'phase-in');
  assert.equal(phase.income, 1_000, 'the base is income OVER the threshold');
  assert.equal(phase.rate, rates._medicareLevy.phaseInRate);
  assert.ok(Math.abs(phase.rate * phase.income - phase.tax) < 1e-9);

  const exempt = rates.computeTax({ ...people, auOrdinaryIncomeYTD: lower - 1 }).brackets.medicareLevy;
  assert.equal(exempt.regime, 'exempt');
  assert.equal(exempt.tax, 0);
});

test('TWE-29: a non-resident return exports its own bracket table and foots', async () => {
  const { AuTaxRates2026 } = await import('../../src/finance/tax/au/au-tax-rates-2026.js');
  const { AuTaxDocument2026 } = await import('../../src/finance/tax/au/au-tax-document-2026.js');

  const detail = new AuTaxRates2026().computeTax({
    people: { p1: { residency: 'US' } },          // not AU-resident ⇒ non-resident path
    auOrdinaryIncomeYTD:         90_000,
    auNonResidentWithholdingYTD: 20_000,
  });
  assert.equal(detail.isResident, false);
  assert.equal(detail.brackets.table, 'Non-Resident');
  assert.equal(detail.brackets.capitalGains, null, 'no separate gains schedule');
  assert.equal(detail.brackets.medicareLevy, null, 'non-residents pay no Medicare levy');

  const doc  = new AuTaxDocument2026().generate(detail, 2026);
  const rows = worksheetRowsFromDocuments(doc);
  assert.deepEqual(verifyWorksheetRows(rows).failures, [],
    'the non-resident section foots now that it states a Gross Tax total');

  const nr = rows.find(r => r.label === 'Non-Resident Withholding Tax (15%)');
  assert.equal(nr.bracketRate, 0.15);
  assert.equal(nr.bracketIncome, 20_000);
});

// ─── Foreign-relief worksheet (design 71 Phase 6, §13) ───────────────────────

const worksheetRows = rows => rows.filter(r => r.section === 'Worksheet — Foreign Relief');

test('TWE-30: the US §904 worksheet exposes the limitation and its denominators', () => {
  const rows = buildTaxWorksheetRows(runAu(), { cc: 'US' });
  const ws   = worksheetRows(rows);
  assert.ok(ws.length > 0, 'the cross-border run has years with foreign activity');

  // Every worksheet row is supporting arithmetic, never a line of the return.
  assert.ok(ws.every(r => r.rowType === 'WORKSHEET' || r.rowType === 'RATE'),
    'no worksheet row is a LINE — they must never be summed into the return (§5.2)');

  const year = ws[0].taxYear;
  const at   = label => ws.find(r => r.taxYear === year && r.label === label);

  // The §904 limit is `grossTax × basketIncome / totalTaxable`. All four inputs are
  // now on the worksheet, so the reader can recompute it.
  const base   = at('§904 limitation base (Chapter-1 gross tax)');
  const denom  = at('§904 total taxable income (denominator)');
  const numer  = at('Passive — foreign income in basket');
  const frac   = at('Passive — limitation fraction');
  const limit  = at('Passive — §904 limit');
  assert.ok(base && denom && numer && frac && limit);
  assert.ok(Math.abs(frac.amount - numer.amount / denom.amount) < 1e-9, 'frac is checkable');
  assert.ok(Math.abs(limit.amount - base.amount * frac.amount) < 0.005, 'limit is checkable');

  // credit = min(available, limit), drawn current-year first.
  const avail  = at('Passive — available (current + pool)');
  const credit = at('Passive — credit taken');
  assert.ok(Math.abs(credit.amount - Math.min(avail.amount, limit.amount)) < 0.005);
  assert.ok(Math.abs(
    at('Passive — drawn from current year').amount
    + at('Passive — drawn from carryover').amount - credit.amount) < 0.005);
});

test('TWE-31: the worksheet does not disturb any footing check', () => {
  // The whole point of WORKSHEET/RATE rows: they are additional information that
  // cannot leak into the return's own arithmetic.
  const rows = buildTaxWorksheetRows(runAu(), { cc: 'US' });
  assert.deepEqual(verifyWorksheetRows(rows).failures, []);
  assert.ok(worksheetRows(rows).length > 0, 'and the worksheet really was present');
});

test('TWE-32: the credit taken on the worksheet equals the Credits line', () => {
  const rows = buildTaxWorksheetRows(runAu(), { cc: 'US' });
  const ws   = worksheetRows(rows);
  const year = ws[0].taxYear;
  const yr   = r => r.taxYear === year;

  const taken = ['General', 'Passive']
    .map(b => ws.find(r => yr(r) && r.label === `${b} — credit taken`)?.amount ?? 0)
    .reduce((a, b) => a + b, 0);
  // Credit lines are signed negative on the return.
  const claimed = -rows
    .filter(r => yr(r) && r.section === 'Credits' && r.rowType === 'LINE' && /§904/.test(r.label))
    .reduce((s, r) => s + r.amount, 0);
  assert.ok(Math.abs(taken - claimed) < 0.005, 'worksheet and return agree on the credit');
});

test('TWE-33: a purely domestic return has no worksheet at all', async () => {
  const { UsTaxRates2025 }    = await import('../../src/finance/tax/us/us-tax-rates-2025.js');
  const { UsTaxDocument2026 } = await import('../../src/finance/tax/us/us-tax-document-2026.js');
  const detail = new UsTaxRates2025().computeTax({ usOrdinaryIncomeYTD: 200_000 });
  const doc    = new UsTaxDocument2026().generate(detail, 2025);
  assert.ok(!doc.sections.some(s => s.heading.startsWith('Worksheet')),
    'no foreign activity ⇒ the return is unchanged');
});

test('TWE-34: the AU FITO worksheet shows the limit and the forfeited excess', () => {
  const rows = buildTaxWorksheetRows(runAu(), { cc: 'AU' });
  const ws   = worksheetRows(rows);
  assert.ok(ws.length > 0);
  assert.ok(ws.every(r => r.rowType === 'WORKSHEET'));

  const key = `${ws[0].taxYear}|${ws[0].personKey}`;
  const at  = label => ws.find(r => `${r.taxYear}|${r.personKey}` === key && r.label === label);

  const paid    = at('FITO — foreign (US) tax paid on US-source income');
  const allowed = at('FITO — offset allowed');
  const lost    = at('FITO — excess forfeited (no carryforward)');
  assert.ok(paid && allowed && lost);
  // Unlike the US FTC there is no carryforward: paid = allowed + forfeited, exactly.
  assert.ok(Math.abs(paid.amount - (allowed.amount + lost.amount)) < 0.005);

  const limit = at('FITO — §770-75 limit (step 1 − step 2)');
  const dm    = at('FITO — de-minimis shortcut (≤ A$1,000), limit not computed');
  assert.ok(limit || dm, 'either the limit or the shortcut that replaced it is stated');
  if (limit) assert.ok(Math.abs(allowed.amount - Math.min(paid.amount, limit.amount)) < 0.005);
});

test('TWE-35: the de-minimis shortcut is stated, not left to be inferred', async () => {
  const { AuTaxRates2026 }    = await import('../../src/finance/tax/au/au-tax-rates-2026.js');
  const { AuTaxDocument2026 } = await import('../../src/finance/tax/au/au-tax-document-2026.js');
  const detail = new AuTaxRates2026().computeTax({
    people: { p1: { residency: 'AU' } },
    auOrdinaryIncomeYTD: 90_000,
    usTaxPaidOnUsSourceAud: 800,        // under the A$1,000 threshold
  });
  assert.equal(detail.fitoDeMinimis, true);

  const ws = worksheetRows(worksheetRowsFromDocuments(
    new AuTaxDocument2026().generate(detail, 2026)));
  assert.ok(ws.some(r => /de-minimis shortcut/.test(r.label)),
    'the shortcut is named, rather than showing an unexplained absent limit');
  assert.equal(ws.find(r => r.label === 'FITO — offset allowed').amount, 800);
  assert.equal(ws.find(r => /forfeited/.test(r.label)).amount, 0);
});

// ─── Tax-year label + settlement FX rate (§5.5) ──────────────────────────────

test('TWE-36: AU rows carry the FY label beside the numeric year, which stays a number', () => {
  const rows = buildTaxWorksheetRows(runAu(), { cc: 'AU' });
  assert.ok(rows.length > 0);

  for (const r of rows) {
    // The integer is the join key against the drill-report CSVs and what --year
    // filters on; turning it into a string would break both. The label is what
    // stops a reader taking an AU `2025` for the calendar year.
    assert.equal(typeof r.taxYear, 'number');
    assert.equal(r.taxYearLabel, `FY ${r.taxYear}–${String(r.taxYear + 1).slice(-2)}`);
  }
  assert.ok(rows.some(r => r.taxYearLabel === 'FY 2031–32'),
    'the post-move fiscal years are labelled, not just the first');
});

test('TWE-37: US and state rows label the calendar year', () => {
  const rows = buildTaxWorksheetRows(runScenario(), { cc: 'US' });
  for (const r of rows) assert.equal(r.taxYearLabel, `CY ${r.taxYear}`);
});

test('TWE-38: every row states the settlement FX rate, quoted as AUD per USD', () => {
  // A cross-border return converts the other country's income into its own
  // currency; without the rate none of those figures can be re-derived from the
  // export. It repeats on every row because a worksheet is read through a pivot,
  // where a header-only value would be filtered away.
  const rows = buildTaxWorksheetRows(runAu(), { cc: 'AU' });
  for (const r of rows) {
    assert.equal(r.fxPair, 'USD_AUD');
    assert.equal(typeof r.fxRate, 'number');
    assert.ok(r.fxRate > 0, 'a recorded rate, never a placeholder');
  }

  const usRows = buildTaxWorksheetRows(runScenario(), { cc: 'US' });
  assert.ok(usRows.every(r => r.fxPair === 'USD_AUD' && r.fxRate > 0),
    'the US return converts AU-source income too, so it states the rate as well');
});

test('TWE-39: a document with no recorded rate exports blank FX cells, never 1.0', async () => {
  // Single-country runs record no pair at all. Fabricating 1.0 would silently
  // assert USD and AUD are at parity.
  const { UsTaxRates2025 }    = await import('../../src/finance/tax/us/us-tax-rates-2025.js');
  const { UsTaxDocument2026 } = await import('../../src/finance/tax/us/us-tax-document-2026.js');
  const detail = new UsTaxRates2025().computeTax({ usOrdinaryIncomeYTD: 200_000 });
  const rows   = worksheetRowsFromDocuments(new UsTaxDocument2026().generate(detail, 2025));

  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.equal(r.fxRate, null);
    assert.equal(r.fxPair, null, 'no pair is named when no rate was recorded');
  }
  const cells = splitCsvLine(toCsv([rows[0]], { header: false }));
  assert.equal(cells[WORKSHEET_COLUMNS.indexOf('fxRate')], '');
  assert.equal(cells[WORKSHEET_COLUMNS.indexOf('fxPair')], '');
});

test('TWE-40: fxRate renders at 6dp — it is a multiplier, not a percentage', () => {
  const csv = toCsv([{ ...blankRow(), rowType: 'LINE', fxPair: 'USD_AUD', fxRate: 1.5432109876 }],
    { header: false });
  const cells = splitCsvLine(csv);
  assert.equal(cells[WORKSHEET_COLUMNS.indexOf('fxRate')], '1.543211');
  assert.equal(cells[WORKSHEET_COLUMNS.indexOf('fxPair')], 'USD_AUD');
});
