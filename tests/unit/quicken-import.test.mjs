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
 * quicken-import.test.mjs — the Quicken CSV → scenario accounts importer.
 *
 * The fixture is a literal string rather than a file, and it is synthetic rather than
 * a slice of the real export, because the real one is private (`scenarios/` is
 * gitignored) and because the cases worth pinning are the ones a real export only
 * sometimes contains.
 *
 * What is covered is the set of failures that would produce a **plausible** scenario
 * rather than a broken one — the kind no downstream check catches:
 *
 *   · `Add` (unknown basis) silently read as $0, fabricating a 100% unrealized gain
 *   · a lot's acquisition date lost, making every recent purchase long-term
 *   · a bond with no maturity, which stays scalar and never redeems
 *   · GOLD mapped to an equity rate key, taxing bullion at the wrong rate
 *   · `balance` and Σ`holdings` drifting apart
 *   · a wrapper's `contributionBasis + earningsBasis = balance` breaking on restatement
 *
 * The BOM-on-every-line case is here too: it is invisible in a diff and it shifts the
 * indentation depth the whole parse is built on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseQuickenPortfolio, parseMoney, parseUsDate, parseBondName, splitCsvLine }
  from '../../scripts/lib/quicken-csv.mjs';
import { buildImport, IMPORT_LOT_PREFIX, UNKNOWN_BASIS_POLICY, lotShareScaleMismatches }
  from '../../scripts/lib/quicken-import.mjs';

// ── Fixture ─────────────────────────────────────────────────────────────────

const BOM = '﻿';

/** A Quicken export in the real shape: BOM per line, quoted money, indented levels. */
const CSV = [
  `${BOM}Investing - Portfolio Value - By Account`,
  '',
  `${BOM}Created: 9/4/2026`,
  '',
  `${BOM}Price and Holdings as of: 9/4/2026`,
  '',
  `${BOM},Account,Symbol,Price,Shares,Cost Basis,Market Value,Gain/Loss,Gain/Loss (%),Holding Period,Type`,
  `${BOM}Taxable 001,,,,,"$11,000.00","$13,000.00","$2,000.00","18.2%",,`,
  `${BOM}    BIG INDEX FUND,    Taxable 001,    BIGX,"10.00","800","$6,000.00","$8,000.00","$2,000.00","33.3%",,    Stock`,
  `${BOM}        1/15/2020,        Taxable 001,        BIGX,,"500","$4,000.00","$5,000.00","$1,000.00","25.0%",        Long Term,        Stock`,
  `${BOM}        6/1/2026,        Taxable 001,        BIGX,,"300","$2,000.00","$3,000.00","$1,000.00","50.0%",        Short Term,        Stock`,
  `${BOM}    GOLD TRUST ETF,    Taxable 001,    GLDX,"50.00","20","$800.00","$1,000.00","$200.00","25.0%",,    Stock`,
  `${BOM}        3/2/2021,        Taxable 001,        GLDX,,"20","$800.00","$1,000.00","$200.00","25.0%",        Long Term,        Stock`,
  `${BOM}    US TREASURY BILL26U S T BILL DUE 12/24/26,    Taxable 001,,"99.00","20",Add,"$1,980.00","$0.00","0.0%",,    Bond`,
  `${BOM}        Placeholder,        Taxable 001,,,"20",Add,"$1,980.00","$0.00","0.0%",        Long Term,        Bond`,
  `${BOM}    Cash,,,,,"$2,020.00","$2,020.00","$0.00","0.0%",,`,
  `${BOM}Retirement 002,,,,,"$4,000.00","$5,000.00","$1,000.00","25.0%",,`,
  `${BOM}    BIG INDEX FUND,    Retirement 002,    BIGX,"10.00","500","$4,000.00","$5,000.00","$1,000.00","25.0%",,    Stock`,
  `${BOM}        2/2/2019,        Retirement 002,        BIGX,,"500","$4,000.00","$5,000.00","$1,000.00","25.0%",        Long Term,        Stock`,
  `${BOM}Totals,,,,,"$15,000.00","$18,000.00","$3,000.00","20.0%",,`,
  '',
].join('\n');

const MAPPING = {
  asOf: '2026-09-04',
  accounts: {
    'Taxable 001': { stateKey: 'usStockAccount' },
    'Retirement 002': { stateKey: 'rothAccount' },
  },
  securities: {
    BIGX: { id: 'bigx', name: 'Big Index Fund', allocation: 'EQUITY', rateKey: 'EQUITY_US' },
    GLDX: { id: 'gldx', name: 'Gold Trust ETF', allocation: 'GOLD', rateKey: 'GOLD', isGold: true },
    '@bond': { match: 'TREASURY BILL', allocation: 'BOND', rateKey: 'FIXED_INCOME_US', zeroCoupon: true },
  },
};

/** The target scenario's accounts, as `buildImport` reads them (never mutated). */
const TARGET = [
  { stateKey: 'usStockAccount', balance: 1, holdings: [] },
  {
    stateKey: 'rothAccount', balance: 4000, holdings: [],
    contributionBasis: 3000, earningsBasis: 1000, derivedIncomeBasis: 500,
  },
];

const run = (mapping = MAPPING, targetAccounts = TARGET) =>
  buildImport(parseQuickenPortfolio(CSV), mapping, { targetAccounts });

const clone = (o) => JSON.parse(JSON.stringify(o));
const acct = (r, k) => r.accounts.find(a => a.stateKey === k);
const said = (list, needle) => list.some(d => d.message.includes(needle));

// ── Parsing ─────────────────────────────────────────────────────────────────

test('splitCsvLine keeps commas inside quoted money columns', () => {
  assert.deepEqual(splitCsvLine('a,"$1,267,004.52",b'), ['a', '$1,267,004.52', 'b']);
});

test('parseMoney: Add is null, not zero — the whole point of the distinction', () => {
  assert.equal(parseMoney('"$1,267,004.52"'.replace(/"/g, '')), 1267004.52);
  assert.equal(parseMoney('-$135,930.10'), -135930.1);
  assert.equal(parseMoney('$0.00'), 0);
  assert.equal(parseMoney('Add'), null);
  assert.equal(parseMoney(''), null);
});

test('parseMoney reads a non-USD sign — the AU export is A$, and $-only strips to NaN', () => {
  // The failure this pins is not a wrong number, it is a silent `null`: `A$320,952.90`
  // with the `A` left behind is NaN, every money column in an AU file becomes null, and
  // the importer reads null basis as "unknown" and writes a $0 account with no error.
  assert.equal(parseMoney('A$320,952.90'), 320952.9);
  assert.equal(parseMoney('-A$2,270.20'), -2270.2);
  assert.equal(parseMoney('US$1,000.00'), 1000);
  assert.equal(parseMoney('€1.234,00'.replace(/\./g, '').replace(',', '.')), 1234);
  assert.equal(parseMoney('£250.00'), 250);
  // Bounded: the sign is a prefix, not "any letters anywhere", so junk stays null.
  assert.equal(parseMoney('N/A'), null);
  assert.equal(parseMoney('1,000 AUD'), null);
});

test('the parse reports which currency signs it saw — the export has no currency column', () => {
  assert.deepEqual(parseQuickenPortfolio(CSV).currencySigns, ['$']);
});

test('an export that mixes currency signs is an error, not a summed total', () => {
  const mixed = CSV.replace('"$1,000.00","$200.00"', '"A$1,000.00","A$200.00"');
  const r = buildImport(parseQuickenPortfolio(mixed), MAPPING, { targetAccounts: TARGET });
  assert.ok(r.errors.some(e => /mixes currencies/.test(e.message)));
});

test('mapping.currencySign that disagrees with the file is an error', () => {
  const r = buildImport(parseQuickenPortfolio(CSV), { ...MAPPING, currencySign: 'A$' },
    { targetAccounts: TARGET });
  assert.ok(r.errors.some(e => /currencySign/.test(e.message)));
});

test('a lot with no market value is an error, never an implicit $0', () => {
  // Cost basis has a policy because Quicken legitimately omits it. Market value never is
  // legitimately absent, so a null there means the column did not parse.
  const broken = CSV.replace('"$4,000.00","$5,000.00"', '"$4,000.00",""');
  const r = buildImport(parseQuickenPortfolio(broken), MAPPING, { targetAccounts: TARGET });
  assert.ok(r.errors.some(e => /no market value/.test(e.message)));
});

test('an exact $0.00 cost basis is silent on a wrapper — no role there reads lot basis', () => {
  // A Roth's tax is computed from the ACCOUNT ledgers, not from a lot: rebalances are
  // gated `taxable &&`, withdrawals scale rather than dispose, and the after-tax metric's
  // basis split is on the TAXABLE_BASIS branch. A broker reporting no basis inside a
  // wrapper is the common case, so warning there is noise that trains the eye to skip it.
  const zeroed = CSV.replace('"$9,000.00","$12,000.00"', '"$0.00","$12,000.00"')
    .replace('"$9,000.00","$12,000.00"', '"$0.00","$12,000.00"');
  const r = buildImport(parseQuickenPortfolio(zeroed), MAPPING,
    { targetAccounts: TARGET.map(a => (a.stateKey === 'rothAccount' ? { ...a, role: 'roth-ira' } : a)) });
  assert.ok(!r.warnings.some(w => w.stateKey === 'rothAccount' && /cost basis is exactly/.test(w.message)));
});

test('an exact $0.00 cost basis is warned about — it is not the Add placeholder', () => {
  const zeroed = CSV.replace('"$6,000.00","$8,000.00"', '"$0.00","$8,000.00"')
    .replace('"$4,000.00","$5,000.00"', '"$0.00","$5,000.00"')
    .replace('"$2,000.00","$3,000.00"', '"$0.00","$3,000.00"');
  const r = buildImport(parseQuickenPortfolio(zeroed), MAPPING,
    { targetAccounts: TARGET.map(a => (a.stateKey === 'usStockAccount' ? { ...a, role: 'us-stock' } : a)) });
  assert.equal(r.errors.length, 0);
  assert.ok(r.warnings.some(w => /cost basis is exactly/.test(w.message)));
  // And it is taken literally, because Quicken stated it as a figure.
  const lots = r.accounts.find(a => a.stateKey === 'usStockAccount').holdings
    .filter(h => h.securityId === 'bigx');
  assert.ok(lots.every(h => h.costBasis === 0));
});

test('parseUsDate emits a bare ISO date, and rejects Placeholder', () => {
  assert.equal(parseUsDate('3/13/2026'), '2026-03-13');
  assert.equal(parseUsDate('12/1/2026'), '2026-12-01');
  assert.equal(parseUsDate('Placeholder'), null);
});

test('parseBondName recovers the maturity glued to a T-bill name', () => {
  assert.deepEqual(parseBondName('US TREASURY BILL26U S T BILL DUE 12/24/26'),
    { maturityDate: '2026-12-24' });
  assert.equal(parseBondName('BIG INDEX FUND'), null);
});

test('the BOM on EVERY line does not shift the indentation depth', () => {
  const parsed = parseQuickenPortfolio(CSV);
  assert.equal(parsed.asOf, '2026-09-04');
  assert.deepEqual(parsed.accounts.map(a => a.name), ['Taxable 001', 'Retirement 002']);
  assert.equal(parsed.accounts[0].positions.length, 3);
  assert.equal(parsed.accounts[0].cash, 2020);
  assert.equal(parsed.accounts[0].positions[0].lots.length, 2);
});

test('the Totals footer closes the data rather than parsing as an account', () => {
  assert.equal(parseQuickenPortfolio(CSV).accounts.length, 2);
});

test('a file that is not this report fails loudly', () => {
  assert.throws(() => parseQuickenPortfolio('Date,Payee,Amount\n1/1/2026,X,5'),
    /not look like a Quicken/);
});

// ── Lots ────────────────────────────────────────────────────────────────────

test('each Quicken lot becomes its own holding, dated, with its own basis', () => {
  const equity = acct(run(), 'usStockAccount').holdings.filter(h => h.securityId === 'bigx');
  assert.equal(equity.length, 2);
  assert.deepEqual(equity.map(h => h.purchaseDate), ['2020-01-15', '2026-06-01']);
  assert.deepEqual(equity.map(h => h.costBasis), [4000, 2000]);
  assert.deepEqual(equity.map(h => h.marketValue), [5000, 3000]);
});

test('lot ids are stable across runs and carry the non-compacting import prefix', () => {
  const ids = acct(run(), 'usStockAccount').holdings.map(h => h.id);
  assert.deepEqual(ids, acct(run(), 'usStockAccount').holdings.map(h => h.id));
  assert.ok(ids.every(id => id.startsWith(IMPORT_LOT_PREFIX)));
  // Never a LOT_POLICIES prefix: `compactLots` merges those, and an imported lot's
  // date and basis are exactly what must not be blended away.
  assert.ok(ids.every(id => !/^(reb|ladder|reinvest)-/.test(id)));
});

test('GOLD keeps its own allocation and rate key — bullion is not equity', () => {
  const gold = acct(run(), 'usStockAccount').holdings.find(h => h.securityId === 'gldx');
  assert.equal(gold.allocation, 'GOLD');
  assert.equal(gold.rateKey, 'GOLD');
  assert.equal(run().securities.find(s => s.id === 'gldx').isGold, true);
});

test('a bond gets the maturity and face value promoteToUnitised requires', () => {
  const bond = acct(run(), 'usStockAccount').holdings.find(h => h.allocation === 'BOND');
  assert.equal(bond.maturityDate, '2026-12-24');
  // Quicken's bond "shares" are $100-par units, the same convention as PAR_PER_UNIT.
  assert.equal(bond.faceValue, 2000);
  assert.equal(bond.zeroCoupon, true);
});

test('a bond whose name carries no DUE clause is an error, not a scalar lump', () => {
  const csv = CSV.replace(/US TREASURY BILL26U S T BILL DUE 12\/24\/26/g, 'SOME CORPORATE BOND');
  const mapping = clone(MAPPING);
  mapping.securities['@bond'].match = 'BOND';
  const r = buildImport(parseQuickenPortfolio(csv), mapping, { targetAccounts: TARGET });
  assert.ok(said(r.errors, 'no maturity date'));
});

test('a cash sleeve is emitted with basis equal to value (design 87 §11)', () => {
  const cash = acct(run(), 'usStockAccount').holdings.find(h => h.allocation === 'CASH');
  assert.equal(cash.marketValue, 2020);
  assert.equal(cash.costBasis, 2020);
});

// ── Unknown basis ───────────────────────────────────────────────────────────

test('an "Add" basis warns and defaults to market value, never to a fabricated gain', () => {
  const r = run();
  const bond = acct(r, 'usStockAccount').holdings.find(h => h.allocation === 'BOND');
  assert.equal(bond.costBasis, bond.marketValue);
  assert.ok(said(r.warnings, 'no cost basis'));
});

test('unknownBasisPolicy "zero" is available but must be asked for', () => {
  const r = run({ ...MAPPING, unknownBasisPolicy: UNKNOWN_BASIS_POLICY.ZERO });
  assert.equal(acct(r, 'usStockAccount').holdings.find(h => h.allocation === 'BOND').costBasis, 0);
});

test('a negative cash sleeve is reported as the placeholder plug it is', () => {
  const csv = CSV.replace('    Cash,,,,,"$2,020.00","$2,020.00"', '    Cash,,,,,"-$2,020.00","-$2,020.00"');
  const r = buildImport(parseQuickenPortfolio(csv), MAPPING, { targetAccounts: TARGET });
  assert.ok(said(r.warnings, 'cash is NEGATIVE'));
});

// ── The invariants ──────────────────────────────────────────────────────────

test('balance equals the holdings sum — the desync audit-scenario checks for', () => {
  for (const a of run().accounts) {
    assert.equal(a.balance, +a.holdings.reduce((s, h) => s + h.marketValue, 0).toFixed(2));
  }
  assert.equal(acct(run(), 'usStockAccount').balance, 13000);
});

test('a wrapper keeps contributionBasis + earningsBasis = balance on restatement', () => {
  const roth = acct(run(), 'rothAccount');
  assert.equal(roth.balance, 5000);
  assert.equal(roth.contributionBasis, 3000);       // preserved: Quicken cannot supply it
  assert.equal(roth.earningsBasis, 2000);           // re-derived against the new balance
  assert.equal(roth.contributionBasis + roth.earningsBasis, roth.balance);
});

test('derivedIncomeBasis carries across at its SHARE of earnings, not its dollars', () => {
  // The target was 500 derived of 1000 earnings; earnings restates to 2000, so the
  // derived pool is 1000. Carrying the dollar figure would silently halve the share;
  // carrying a figure ABOVE the new earnings would make _derivedShareOf clamp to 1.
  assert.equal(acct(run(), 'rothAccount').derivedIncomeBasis, 1000);
  assert.ok(acct(run(), 'rothAccount').derivedIncomeBasis <= acct(run(), 'rothAccount').earningsBasis);
});

test('a mapping-supplied contributionBasis wins, and is reported for the param half', () => {
  const mapping = clone(MAPPING);
  mapping.accounts['Retirement 002'].contributionBasis = 4500;
  const r = run(mapping);
  assert.equal(acct(r, 'rothAccount').contributionBasis, 4500);
  assert.equal(acct(r, 'rothAccount').earningsBasis, 500);
  // Design 32: the param owns this field at load, so the CLI must patch both stores.
  assert.deepEqual(r.contributionBasisPatches.find(p => p.stateKey === 'rothAccount'),
    { stateKey: 'rothAccount', value: 4500 });
});

test('a contributionBasis above the new balance floors earnings and says so', () => {
  const mapping = clone(MAPPING);
  mapping.accounts['Retirement 002'].contributionBasis = 9000;
  const r = run(mapping);
  assert.equal(acct(r, 'rothAccount').earningsBasis, 0);
  assert.ok(said(r.warnings, 'exceeds the imported balance'));
});

test('the target scenario is never mutated', () => {
  const target = clone(TARGET);
  buildImport(parseQuickenPortfolio(CSV), MAPPING, { targetAccounts: target });
  assert.deepEqual(target, clone(TARGET));
});

// ── Mapping errors ──────────────────────────────────────────────────────────

test('an unmapped Quicken account is an error, never a silent drop', () => {
  const mapping = clone(MAPPING);
  delete mapping.accounts['Retirement 002'];
  const r = run(mapping);
  assert.ok(said(r.errors, 'not in mapping.accounts'));
  assert.equal(r.accounts.length, 1);
});

test('an unresolvable instrument is an error — a default would tax it wrongly', () => {
  const mapping = clone(MAPPING);
  delete mapping.securities.GLDX;
  assert.ok(said(run(mapping).errors, 'resolves to no entry in mapping.securities'));
});

test('a rateKey outside its allocation class is caught here, not at scenario load', () => {
  const mapping = clone(MAPPING);
  mapping.securities.GLDX.rateKey = 'EQUITY_US';
  assert.ok(said(run(mapping).errors, 'must use rateKey GOLD'));

  const m2 = clone(MAPPING);
  m2.securities.BIGX.rateKey = 'FIXED_INCOME_US';
  assert.ok(said(run(m2).errors, 'is not inside ALLOCATION.EQUITY'));
});

test('the reserved sec-auto- prefix cannot be claimed by an authored security', () => {
  const mapping = clone(MAPPING);
  mapping.securities.BIGX.id = 'sec-auto-EQUITY_US';
  assert.ok(said(run(mapping).errors, 'reserved'));
});

test('two Quicken accounts mapped to one stateKey is an error, not a last-wins', () => {
  const mapping = clone(MAPPING);
  mapping.accounts['Retirement 002'].stateKey = 'usStockAccount';
  assert.ok(said(run(mapping).errors, 'cannot be one scenario account'));
});

test('a stateKey absent from the target scenario is an error', () => {
  const mapping = clone(MAPPING);
  mapping.accounts['Taxable 001'].stateKey = 'noSuchAccount';
  assert.ok(said(run(mapping).errors, 'matches no account in the target scenario'));
});

test('a mapping asOf that disagrees with the CSV is an error — wrong snapshot', () => {
  assert.ok(said(run({ ...MAPPING, asOf: '2026-01-01' }).errors, 'but the CSV was taken'));
});

test('an unused mapping entry is a warning, so a stale map is visible', () => {
  const mapping = clone(MAPPING);
  mapping.securities.NOPE = { id: 'nope', allocation: 'EQUITY', rateKey: 'EQUITY_US' };
  assert.ok(said(run(mapping).warnings, 'matched no position'));
});

test('a clean mapping produces no errors at all', () => {
  assert.deepEqual(run().errors, []);
});

// ── Share scale across accounts ─────────────────────────────────────────────

/**
 * One fund in three accounts. `Taxable 001`'s 2025 lots kept their pre-split share counts
 * through a 7-for-1 split, so they cost 7× per share what the other two paid on nearby
 * dates. The shape of the real export that hid an \$111k understatement as \$80k of losses.
 */
const SPLIT_CSV = [
  `${BOM}Price and Holdings as of: 9/4/2026`,
  '',
  `${BOM},Account,Symbol,Price,Shares,Cost Basis,Market Value,Gain/Loss,Gain/Loss (%),Holding Period,Type`,
  `${BOM}Taxable 001,,,,,"$3,000.00","$474.00",,,,`,
  `${BOM}    BIG INDEX FUND,    Taxable 001,    BIGX,"16.00","29.6",,"$474.00",,,,    Mutual Fund`,
  `${BOM}        1/10/2025,        Taxable 001,        BIGX,,"10","$1,000.00","$160.00",,,        Long Term,        Mutual Fund`,
  `${BOM}        3/10/2025,        Taxable 001,        BIGX,,"9.6","$1,000.00","$153.60",,,        Long Term,        Mutual Fund`,
  `${BOM}        6/10/2025,        Taxable 001,        BIGX,,"10","$1,000.00","$160.00",,,        Long Term,        Mutual Fund`,
  `${BOM}Retirement 002,,,,,"$2,000.00","$2,288.00",,,,`,
  `${BOM}    BIG INDEX FUND,    Retirement 002,    BIGX,"16.00","143",,"$2,288.00",,,,    Mutual Fund`,
  `${BOM}        1/12/2025,        Retirement 002,        BIGX,,"70","$1,000.00","$1,120.00",,,        Long Term,        Mutual Fund`,
  `${BOM}        6/12/2025,        Retirement 002,        BIGX,,"73","$1,000.00","$1,168.00",,,        Long Term,        Mutual Fund`,
  `${BOM}Joint 003,,,,,"$1,000.00","$1,120.00",,,,`,
  `${BOM}    BIG INDEX FUND,    Joint 003,    BIGX,"16.00","70",,"$1,120.00",,,,    Mutual Fund`,
  `${BOM}        3/12/2025,        Joint 003,        BIGX,,"70","$1,000.00","$1,120.00",,,        Long Term,        Mutual Fund`,
  `${BOM}Totals,,,,,"$6,000.00","$3,882.00",,,,`,
  '',
].join('\n');

const SPLIT_MAPPING = {
  accounts: {
    'Taxable 001': { stateKey: 'usStockAccount' },
    'Retirement 002': { stateKey: 'rothAccount' },
    'Joint 003': { stateKey: 'jointAccount' },
  },
  securities: { BIGX: MAPPING.securities.BIGX },
};

test('lots left on pre-split share counts are named, with the split factor', () => {
  const m = lotShareScaleMismatches(parseQuickenPortfolio(SPLIT_CSV));
  assert.equal(m.length, 1);
  assert.equal(m[0].account, 'Taxable 001');
  assert.equal(m[0].lots, 3);
  assert.equal(m[0].from, '2025-01-10');
  assert.equal(m[0].to, '2025-06-10');
  assert.equal(m[0].splitFactor, 7);
  assert.equal(m[0].marketValue, 473.6);
});

test('the share-scale warning is attributed to the outvoted account and states the effect', () => {
  const r = buildImport(parseQuickenPortfolio(SPLIT_CSV), SPLIT_MAPPING);
  const w = r.warnings.filter(d => /per share what the other accounts paid/.test(d.message));
  assert.equal(w.length, 1);
  assert.equal(w[0].stateKey, 'usStockAccount');
  assert.ok(w[0].message.includes('7-for-1 split that was not applied'));
  assert.ok(w[0].message.includes('understated by about 2841.6'));
});

test('one account against one names neither — nothing says which is the wrong one', () => {
  const twoAccounts = SPLIT_CSV.split('\n').filter(l => !/Joint 003/.test(l)).join('\n');
  assert.deepEqual(lotShareScaleMismatches(parseQuickenPortfolio(twoAccounts)), []);
});

test('consistent lots across accounts raise no share-scale warning', () => {
  assert.deepEqual(lotShareScaleMismatches(parseQuickenPortfolio(CSV)), []);
});

// ── Share counts ────────────────────────────────────────────────────────────

test('an equity lot carries the broker share count and a price that reproduces its value', () => {
  const equity = acct(run(), 'usStockAccount').holdings.filter(h => h.securityId === 'bigx');
  assert.deepEqual(equity.map(h => h.units), [500, 300]);
  assert.deepEqual(equity.map(h => h.pricePerUnit), [10, 10]);
  for (const h of equity) assert.equal(+(h.units * h.pricePerUnit).toFixed(2), h.marketValue);
});

test('a lot the printed price does not reproduce to the cent is priced by its own value', () => {
  // The printed price is rounded, so shares × 10.00 is 12,345.68 and not Quicken's figure.
  const csv = CSV.replace('"500","$4,000.00","$5,000.00"', '"1234.5678","$4,000.00","$16,695.10"');
  const [lot] = acct(buildImport(parseQuickenPortfolio(csv), MAPPING, { targetAccounts: TARGET }),
    'usStockAccount').holdings.filter(h => h.securityId === 'bigx');
  assert.equal(lot.units, 1234.5678);
  assert.equal(+(lot.units * lot.pricePerUnit).toFixed(2), 16695.10);
});

test('gold and bond lots carry no imported share count', () => {
  const holdings = acct(run(), 'usStockAccount').holdings;
  assert.equal(holdings.find(h => h.allocation === 'GOLD').units, undefined);
  assert.equal(holdings.find(h => h.allocation === 'BOND').units, undefined);
});
