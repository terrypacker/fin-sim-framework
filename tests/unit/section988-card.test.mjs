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
 * section988-card.test.mjs — deriving a card payment's business fraction from the card's
 * own statement. Design 87 §12.
 *
 * The fraction is the §988(e)(3) "to the extent" split of ONE disposition, so the whole
 * job is bookkeeping: work out which purchases each payment retired. Everything that can
 * go wrong here goes wrong quietly — the fractions stay plausible while the money stops
 * adding up — so CARD-1 is the conservation identity and most of the rest are the cases
 * that broke it.
 *
 *   CARD-1..2   conservation: every payment dollar lands on a purchase or stays unspent.
 *   CARD-3..5   the split itself, both methods, and the refund/prepayment carries.
 *   CARD-6..8   matching payments to account rows, and refusing to guess.
 *   CARD-9..11  reading a real export: preamble, ordering, day-aggregated footing.
 *
 * Run with: node --test tests/unit/section988-card.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readCardStatementCsv, footCardStatement, allocateCardPayments,
  matchCardPayments, applyCardFractions, CARD_METHOD,
} from '../../scripts/lib/section988-card.mjs';
import { footLedger } from '../../scripts/lib/section988-source.mjs';

const CFG = {
  businessCategory: '^(ATO|Business Expenses)(:|$)',
  paymentCategory: '^Transfer:\\[',
};

const dir = mkdtempSync(join(tmpdir(), 'sec988card-'));
let seq = 0;

/** Build statement rows without going through a file. */
const rows = (...specs) => specs.map(([date, category, amount], i) => ({
  card: 'test', sourceLine: i + 2, date, payee: '', category, amount, balance: null,
}));

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.01, `${msg}: ${a} vs ${b}`);

test('CARD-1 a payment splits by the mix of what is outstanding', () => {
  const r = allocateCardPayments(rows(
    ['2024-01-05', 'ATO:Repairs', -300],
    ['2024-01-06', 'Food & Dining', -100],
    ['2024-01-20', 'Transfer:[Offset]', 400],
  ), CFG);

  assert.equal(r.allocations.length, 1);
  near(r.allocations[0].businessFraction, 0.75, '300 business of 400 outstanding');
  assert.equal(r.conservation.balanced, true);
  near(r.conservation.actual, 0, 'card is clear');
});

test('CARD-2 conservation holds when payments run ahead of purchases', () => {
  // The regression this whole design exists for. Flooring the buckets at zero loses the
  // overpayment: plausible fractions, silently missing money.
  const r = allocateCardPayments(rows(
    ['2024-01-05', 'ATO:Repairs', -100],
    ['2024-01-10', 'Transfer:[Offset]', 500],      // 400 more than owed
    ['2024-02-01', 'Food & Dining', -300],         // consumes 300 of the prepayment
  ), CFG);

  assert.equal(r.conservation.balanced, true, r.conservation.gap);
  near(r.conservation.expected, -100, 'card is 100 in credit');
  near(r.residual.unspentPrepayments, 100, 'and 100 of the payment is still unspent');

  // The prepayment bought the personal item, so the payment is NOT 100% business.
  near(r.allocations[0].businessFraction, 0.25, '100 business of the 400 it ended up buying');
});

test('CARD-3 a refund of an already-paid purchase re-points that payment', () => {
  // Pay for a business repair, get refunded, spend the credit on groceries. The AUD that
  // left the pool ultimately bought groceries, and the fraction has to say so.
  const r = allocateCardPayments(rows(
    ['2024-01-05', 'ATO:Repairs', -500],
    ['2024-01-10', 'Transfer:[Offset]', 500],
    ['2024-02-01', 'ATO:Repairs', 500],            // refund, card now in credit
    ['2024-03-01', 'Food & Dining', -500],         // credit spent on personal
  ), CFG);

  assert.equal(r.conservation.balanced, true, r.conservation.gap);
  near(r.allocations[0].businessFraction, 0, 'the payment ended up funding a personal purchase');
});

test('CARD-4 a refund against an unpaid purchase just cancels it', () => {
  const r = allocateCardPayments(rows(
    ['2024-01-05', 'ATO:Repairs', -500],
    ['2024-01-06', 'ATO:Repairs', 500],            // refunded before it was ever paid
    ['2024-01-07', 'Food & Dining', -200],
    ['2024-01-20', 'Transfer:[Offset]', 200],
  ), CFG);

  assert.equal(r.conservation.balanced, true, r.conservation.gap);
  near(r.allocations[0].businessFraction, 0, 'only the groceries were ever outstanding');
});

test('CARD-5 FIFO and pro-rata differ on timing but not on the total', () => {
  const script = rows(
    ['2024-01-05', 'ATO:Repairs', -400],           // oldest: business
    ['2024-02-05', 'Food & Dining', -400],
    ['2024-02-20', 'Transfer:[Offset]', 400],      // partial: FIFO takes the repair
    ['2024-03-20', 'Transfer:[Offset]', 400],
  );
  const pro = allocateCardPayments(script, { ...CFG, method: CARD_METHOD.PRO_RATA });
  const fifo = allocateCardPayments(script, { ...CFG, method: CARD_METHOD.FIFO });

  near(fifo.allocations[0].businessFraction, 1, 'FIFO retires the oldest purchase first');
  near(pro.allocations[0].businessFraction, 0.5, 'pro-rata retires half of each');

  for (const r of [pro, fifo]) {
    assert.equal(r.conservation.balanced, true);
    near(r.allocations.reduce((s, a) => s + a.businessPaid, 0), 400,
      'both methods pay for the same 400 of business in the end');
  }
});

test('CARD-6 payments match account rows on date and amount, exactly', () => {
  const r = allocateCardPayments(rows(
    ['2024-01-05', 'ATO:Repairs', -300],
    ['2024-01-06', 'Food & Dining', -100],
    ['2024-01-20', 'Transfer:[Offset]', 400],
  ), CFG);

  const classified = [
    { date: '2024-01-20', amount: -400, kind: null, needsDecision: true, error: 'needs the statement' },
    { date: '2024-01-20', amount: -399.99, kind: null, needsDecision: true, error: 'needs the statement' },
  ];
  const m = matchCardPayments(classified, r.allocations);
  assert.equal(m.matched.length, 1, 'a cent off is a different payment, not a rounding error');
  assert.equal(m.matched[0].row.amount, -400);

  applyCardFractions(m.matched);
  assert.equal(classified[0].kind, 'DISPOSE');
  near(classified[0].businessFraction, 0.75, 'fraction lands on the row');
  assert.equal(classified[0].error, undefined, 'and the open decision is closed');
  assert.equal(classified[1].kind, null, 'the near miss is left alone');
});

test('CARD-6b same date, same amount: the OPEN row is the payment', () => {
  // Date and amount stop being unique once the whole pool is ingested. On one real day a
  // transfer between two of your own accounts was the same size as the card payment;
  // taking the first match grabbed the transfer, called it a conflict, and left the
  // actual payment undecided — silently, since the conflict looked like a broken rule.
  const r = allocateCardPayments(rows(
    ['2024-01-05', 'ATO:Repairs', -400],
    ['2024-01-20', 'Transfer:[Offset]', 400],
  ), CFG);

  const transfer = { date: '2024-01-20', amount: -400, kind: 'INTERNAL', via: 'rule#33' };
  const payment = { date: '2024-01-20', amount: -400, kind: null, needsDecision: true, error: 'needs the statement' };
  const m = matchCardPayments([transfer, payment], r.allocations);
  applyCardFractions(m.matched);

  assert.equal(m.conflicts.length, 0, 'the transfer is not the payment and is not a conflict');
  assert.equal(m.matched.length, 1);
  assert.equal(m.matched[0].row, payment, 'the open row is the one awaiting a statement');
  assert.equal(transfer.kind, 'INTERNAL', 'the transfer is untouched');
  assert.equal(payment.kind, 'DISPOSE');
});

test('CARD-7 a hand-typed override outranks the statement', () => {
  const r = allocateCardPayments(rows(
    ['2024-01-05', 'ATO:Repairs', -400],
    ['2024-01-20', 'Transfer:[Offset]', 400],
  ), CFG);
  const row = { date: '2024-01-20', amount: -400, kind: 'DISPOSE', businessFraction: 0.1, via: 'csv-override' };

  const m = matchCardPayments([row], r.allocations);
  applyCardFractions(m.matched);
  assert.equal(m.matched.length, 0);
  assert.equal(m.conflicts.length, 1, 'and the disagreement is reported, not swallowed');
  assert.equal(row.businessFraction, 0.1, 'what you typed stands');
});

test('CARD-7b an override that AGREES is confirmation, not conflict', () => {
  // The emitted sheet is meant to be fed straight back in, so the second run sees its own
  // answers as csv-overrides. If agreement counted as a conflict, the ordinary round trip
  // would raise a blocking finding on every card payment it had just resolved correctly.
  const r = allocateCardPayments(rows(
    ['2024-01-05', 'ATO:Repairs', -300],
    ['2024-01-06', 'Food & Dining', -100],
    ['2024-01-20', 'Transfer:[Offset]', 400],
  ), CFG);
  const row = { date: '2024-01-20', amount: -400, kind: 'DISPOSE', businessFraction: 0.75, via: 'csv-override' };

  const m = matchCardPayments([row], r.allocations);
  assert.equal(m.conflicts.length, 0);
  assert.equal(m.confirmed.length, 1);

  row.businessFraction = 0.5;
  assert.equal(matchCardPayments([row], r.allocations).conflicts.length, 1,
    'control: a real difference IS a conflict');
});

test('CARD-8 a rule calling the payment something else is a conflict, not an overwrite', () => {
  const r = allocateCardPayments(rows(
    ['2024-01-05', 'ATO:Repairs', -400],
    ['2024-01-20', 'Transfer:[Offset]', 400],
  ), CFG);
  // Paying a card is NOT a transfer inside the currency pool, but a broad transfer rule
  // will happily say it is. Overwriting would hide the broken rule.
  const row = { date: '2024-01-20', amount: -400, kind: 'INTERNAL', via: 'rule#26' };

  const m = matchCardPayments([row], r.allocations);
  assert.equal(m.matched.length, 0);
  assert.equal(m.conflicts.length, 1);
  assert.match(m.conflicts[0].why, /INTERNAL/);
  assert.equal(row.kind, 'INTERNAL', 'left exactly as the rule had it');
});

test('CARD-9 a real export is read past its preamble and into chronological order', () => {
  const file = join(dir, `c${seq++}.csv`);
  writeFileSync(file, [
    'NAB CC Report Created: 2026-08-09',
    ',',
    'Filter Criteria:,All Dates',
    ',',
    ',"Scheduled","Split","Date","Payee","Category","Tags","Amount","Balance","Memo/Notes"',
    'Balance:,,,,,,,,   -129.00',
    ',,,"2/10/2024","Woolworths","Food & Dining","","-50.00","-50.00",',   // newest first
    ',,,"1/10/2024","Bunnings","ATO:Repairs","","-1,171.66","-1171.66",',
    'Total Inflows:,,,,,,,  0.00',
  ].join('\n'));

  const s = readCardStatementCsv(file, 'nab');
  assert.equal(s.rows.length, 2, 'preamble, totals and the Balance: marker are not data');
  assert.deepEqual(s.rows.map((r) => r.date), ['2024-01-10', '2024-02-10'],
    'reversed into chronological order — every calculation is a running balance');
  assert.equal(s.rows[0].amount, -1171.66, 'thousands separators inside quotes survive');
});

test('CARD-10 footing is day-aggregated, so intra-day order is not a break', () => {
  // Exports do not preserve intra-day sequence; a row-by-row check cries wolf on every
  // multi-purchase day, and a gate that always fires is a gate nobody reads.
  const sameDay = rows(
    ['2024-01-05', 'ATO:Repairs', -100],
    ['2024-01-05', 'Food & Dining', -50],
    ['2024-01-06', 'ATO:Repairs', -25],
  );
  sameDay[0].balance = -50;     // the balances run in the other order within the day
  sameDay[1].balance = -150;
  sameDay[2].balance = -175;

  assert.ok(footLedger(sameDay).length > 0,
    'control: row by row these DO break — that is why the day is aggregated');
  assert.deepEqual(footCardStatement(sameDay), []);

  // A genuinely missing row still shows up as an unexplained day.
  sameDay[2].balance = -500;
  const breaks = footCardStatement(sameDay);
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0].date, '2024-01-06');
});

test('CARD-11 the two category tests have no defaults', () => {
  for (const missing of ['businessCategory', 'paymentCategory']) {
    const cfg = { ...CFG };
    delete cfg[missing];
    assert.throws(() => allocateCardPayments(rows(['2024-01-05', 'ATO:Repairs', -100]), cfg),
      new RegExp(missing),
      `${missing} must be stated — guessing it skews every fraction invisibly`);
  }
  assert.throws(() => allocateCardPayments([], { ...CFG, method: 'newest-first' }), /method must be/);
});
