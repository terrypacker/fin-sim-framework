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
 * section988-card.mjs — derive the business fraction of a credit-card payment from the
 * card's own statement. Design 87 §12, the companion to `section988-source.mjs`.
 *
 * ─── what the taxable event actually is ─────────────────────────────────────────────
 *
 * A card payment is the single worst row in a foreign-currency ledger, because the row
 * that moves the money says nothing about what the money bought. The tempting fix — drop
 * the payment row and substitute the card's purchases — books the wrong event three times
 * over:
 *
 *   1. AUD leaves the pool when the CARD IS PAID, not when the card is used. The card
 *      issuer paid the merchant; you owed the issuer. Purchase-dated dispositions apply
 *      the exchange rate of the wrong day.
 *   2. It invents disposition volume the pool never had, which is what
 *      {@link measurePoolStructure}'s turnover reads to decide how far FIFO and pro-rata
 *      can diverge.
 *   3. Worst: §988(e)(2)'s $200 exclusion is PER TRANSACTION. Splitting one $2,000
 *      payment into forty purchases puts every slice under the threshold that the single
 *      payment clears. That is not a rounding difference, it is the exclusion swallowing
 *      the whole disposition.
 *
 * The purchases are evidence about a *fraction*, not events in their own right.
 * §988(e)(3) is written "to the extent", so one payment is legitimately part
 * ordinary-§988 and part capital, and `businessFraction` already carries exactly that.
 *
 * ─── which purchases a payment paid for ─────────────────────────────────────────────
 *
 * If the card were always paid in full, the answer would be "the ones since the last
 * payment" and there would be nothing to decide. Real cards are not: payments are round
 * numbers, they lag, they overshoot. So the card balance is a POOL of mixed business and
 * personal purchases, and a payment retires some of each — the same problem §988 has with
 * the currency pool itself, and it takes the same two answers:
 *
 *   PRO_RATA (default) — a payment retires business and personal in proportion to the
 *                        balance outstanding when it lands.
 *   FIFO               — a payment retires the oldest purchases first.
 *
 * Neither is "the" right answer; `§1.988-2(a)(2)(iii)(B)(1)` demands only that whichever
 * you pick is applied consistently, so the method is recorded on every allocation and
 * reported. Over the life of the card they agree — they differ only in which side of a
 * year boundary a given dollar falls on.
 */

import { readFileSync } from 'node:fs';
import { stripBom, splitCsvLine, parseNumber, requireDate } from './section988-source.mjs';

export const CARD_METHOD = { PRO_RATA: 'pro-rata', FIFO: 'fifo' };

export const CARD_SCHEMA = `
Add a "card" block to the rules file (it stays in gitignored scenarios/, because the
category names are your own bookkeeping):

{
  "card": {
    "businessCategory": "^(ATO|Business Expenses)(:|$)",  // regex over the Category column
    "paymentCategory":  "^Transfer:\\\\[",                  // regex marking a PAYMENT credit
    "method": "pro-rata"                                  // or "fifo"
  },
  "rules": [ ... ]
}

businessCategory decides the §162/§212 share of each PURCHASE — the "expenses properly
allocable to a trade or business" test of §988(e)(3), applied to the thing bought.

paymentCategory separates the credits that are PAYMENTS from the credits that are
REFUNDS. They are opposites: a payment retires balance from the pool, a refund reverses
a purchase and belongs back in the bucket it came from. Getting this wrong silently
skews every fraction, so there is no default.
`;

/* ─────────────────────────────────── parsing ───────────────────────────────────── */

/**
 * Read a card statement. Card exports bury the table under a preamble (report title,
 * filter criteria) and close it with totals, so the header row is FOUND rather than
 * assumed to be line 1, and any row without a readable date is treated as furniture.
 *
 * Rows come back in CHRONOLOGICAL order. Exports are conventionally newest-first, and
 * every calculation here is a running balance, so the order is not cosmetic.
 */
export function readCardStatementCsv(file, label) {
  const lines = stripBom(readFileSync(file, 'utf8')).split(/\r?\n/);

  let headerAt = -1;
  let idx = null;
  for (let i = 0; i < Math.min(lines.length, 60); i++) {
    const cells = splitCsvLine(lines[i]).map((c) => c.trim().toLowerCase());
    const find = (...names) => cells.findIndex((c) => names.includes(c));
    const date = find('date', 'transaction date');
    const amount = find('amount');
    if (date < 0 || amount < 0) continue;
    headerAt = i;
    idx = {
      date,
      amount,
      payee: find('payee', 'description', 'merchant'),
      category: find('category'),
      balance: find('balance'),
      memo: find('memo/notes', 'memo', 'notes'),
    };
    break;
  }
  if (headerAt < 0) {
    throw new Error(`${file}: no header row with both Date and Amount columns in the first 60 lines`);
  }
  if (idx.category < 0) {
    throw new Error(`${file}: no Category column — there is nothing to judge business use from`);
  }

  const rows = [];
  for (let i = headerAt + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const cells = splitCsvLine(lines[i]);
    // Totals and section markers carry no date. Skip them silently — unlike the account
    // reader, this file is KNOWN to be padded top and bottom, so a dateless row here is
    // expected furniture rather than the mangled-date accident that reader guards.
    if (!(cells[idx.date] ?? '').trim()) continue;
    const amount = parseNumber(cells[idx.amount]);
    if (amount == null) continue;
    rows.push({
      card: label,
      sourceLine: i + 1,
      date: requireDate(cells[idx.date], `${file} line ${i + 1}`),
      payee: (cells[idx.payee] ?? '').trim(),
      category: (cells[idx.category] ?? '').trim(),
      amount,
      balance: idx.balance >= 0 ? parseNumber(cells[idx.balance]) : null,
    });
  }
  if (rows.length === 0) throw new Error(`${file}: header found at line ${headerAt + 1} but no data rows below it`);

  const ascending = rows[0].date <= rows[rows.length - 1].date;
  return { card: label, rows: ascending ? rows : rows.reverse(), headerAt: headerAt + 1 };
}

/**
 * Does the card statement foot?
 *
 * Same gate as the account ledger and for the same reason — a missing purchase row moves
 * the fraction — but the comparison is made DAY BY DAY rather than row by row. Card
 * exports do not preserve intra-day sequence: several purchases on one date come back in
 * an order that has nothing to do with the running balance, so a row-by-row check reports
 * a break at every multi-purchase day. Aggregating the day removes that noise without
 * hiding a genuinely missing row, which still shows up as an unexplained day.
 */
export function footCardStatement(rows, tolerance = 0.005) {
  const byDay = new Map();
  for (const row of rows) {
    if (row.balance == null) continue;
    if (!byDay.has(row.date)) byDay.set(row.date, []);
    byDay.get(row.date).push(row);
  }
  const breaks = [];
  let prev = null;
  for (const [date, day] of byDay) {
    const amount = day.reduce((s, r) => s + r.amount, 0);
    const closing = day[day.length - 1].balance;
    if (prev != null) {
      const gap = (closing - prev) - amount;
      if (Math.abs(gap) > tolerance) breaks.push({ date, gap, amount, closing, rows: day.length });
    }
    prev = closing;
  }
  return breaks;
}

/* ────────────────────────────────── allocation ─────────────────────────────────── */

/**
 * Walk the statement chronologically, carrying the outstanding balance as two buckets,
 * and split each payment between them.
 *
 * The buckets are the whole model: `business` and `personal` are what is currently owed
 * on the card for each purpose, purchases add to one of them, refunds subtract, and a
 * payment draws down both by whichever convention is in force.
 *
 * ─── overpayment, and why it cannot just be dropped ─────────────────────────────────
 *
 * Real payments routinely exceed the balance outstanding — they are round numbers, and
 * they land before the month's purchases have posted. The naive treatment is to allocate
 * what the payment could reach and floor the buckets at zero, which silently destroys the
 * excess: on this data that lost $1,819 of $49,427 in payments, and the residual stopped
 * agreeing with the statement's own closing balance.
 *
 * So an overpayment is CARRIED as a prepayment instead. A later purchase consumes it, and
 * when it does, the purchase's purpose is credited back to the payment that prepaid it —
 * the fraction of that earlier payment is revised, because we now know what it bought.
 * Every payment dollar therefore ends up in exactly one of two places: matched to a
 * purchase, or still unspent at the end of the statement. That identity is checked by
 * {@link checkCardConservation}, whose residual should reproduce the closing balance.
 */
export function allocateCardPayments(rows, options) {
  const { businessCategory, paymentCategory, method = CARD_METHOD.PRO_RATA } = options ?? {};
  if (!businessCategory) throw new Error('card: businessCategory is required (see --card-schema)');
  if (!paymentCategory) throw new Error('card: paymentCategory is required (see --card-schema)');
  if (!Object.values(CARD_METHOD).includes(method)) {
    throw new Error(`card: method must be one of ${Object.values(CARD_METHOD).join(', ')}`);
  }
  const isBusiness = new RegExp(businessCategory, 'i');
  const isPayment = new RegExp(paymentCategory, 'i');

  let business = 0;             // owed on the card, by purpose
  let personal = 0;
  const lots = [];              // FIFO: outstanding purchases, oldest first
  const prepaid = [];           // payments that ran ahead of the purchases, oldest first
  const allocations = [];
  const warnings = [];
  let purchases = 0;
  let refunds = 0;

  const paidKey = (biz) => (biz ? 'businessPaid' : 'personalPaid');

  /**
   * Credit a purchase to whichever payment(s) already paid for it.
   *
   * A credit carrying `allocation: null` came from a refund with no payment behind it —
   * consuming it funds the purchase out of the refund rather than out of the AUD pool, so
   * no payment is credited and no §988 disposition is implied.
   */
  const consumePrepaid = (amount, biz) => {
    let left = amount;
    while (left > 0.005 && prepaid.length) {
      const head = prepaid[0];
      const take = Math.min(left, head.remaining);
      head.remaining -= take;
      left -= take;
      if (head.allocation != null) allocations[head.allocation][paidKey(biz)] += take;
      if (head.remaining <= 0.005) prepaid.shift();
    }
    return amount - left;       // how much was already paid for
  };

  /**
   * Retire `amount` of one purpose from the outstanding lots.
   *
   * Both methods call this, which is the point. `lots` and the two buckets are the same
   * debt counted two ways — FIFO reads the lots, pro-rata reads the buckets — and letting
   * only one of them move is how they drift apart. They did: pro-rata used to pay down
   * the buckets alone, leaving fully-paid purchases sitting in `lots`, and a later refund
   * matched against that stale lot drove its bucket negative. The clamp back to zero then
   * INVENTED $383 of debt, which showed up as a conservation failure and nowhere else.
   */
  const drawLots = (amount, biz) => {
    let left = amount;
    for (const lot of lots) {
      if (left <= 0.005) break;
      if (lot.business !== biz || lot.remaining <= 0) continue;
      const take = Math.min(left, lot.remaining);
      lot.remaining -= take;
      left -= take;
    }
    while (lots.length && lots[0].remaining <= 0.005) lots.shift();
  };

  /**
   * A refund reverses a purchase — but which one depends on whether it had been paid yet.
   *
   * Against an OUTSTANDING purchase it simply cancels the debt, and nothing has moved in
   * or out of the AUD pool. Against one that has already been PAID it puts the card in
   * credit, and that is the case worth getting right: the payment which funded the
   * refunded purchase did not, in the end, buy what it appeared to. Its attribution is
   * withdrawn and carried forward as a credit, so that whatever the credit eventually
   * buys is what that payment is recorded as having bought.
   */
  const refund = (amount, biz) => {
    // The BUCKET is the authority on what is still owed for this purpose — never the
    // lots, which a pro-rata run only keeps for FIFO's benefit.
    const cancel = Math.min(amount, Math.max(0, biz ? business : personal));
    if (biz) business -= cancel; else personal -= cancel;
    drawLots(cancel, biz);

    let left = amount - cancel;
    const key = paidKey(biz);
    while (left > 0.005) {
      let i = allocations.length - 1;
      while (i >= 0 && allocations[i][key] <= 0.005) i--;
      if (i < 0) { prepaid.push({ allocation: null, remaining: left }); break; }
      const take = Math.min(left, allocations[i][key]);
      allocations[i][key] -= take;
      prepaid.push({ allocation: i, remaining: take });
      left -= take;
    }
  };

  for (const row of rows) {
    const biz = isBusiness.test(row.category);

    if (isPayment.test(row.category)) {
      if (row.amount <= 0) {
        // A negative row on a payment category is money going the other way — a reversed
        // or bounced payment. Naming it is better than absorbing it into purchases.
        warnings.push(`${row.date}: ${row.category} with a negative amount (${row.amount.toFixed(2)}) — reversed payment?`);
        continue;
      }
      const outstanding = business + personal;
      const applied = Math.min(row.amount, outstanding);
      const excess = row.amount - applied;

      const alloc = {
        card: row.card,
        date: row.date,
        amount: row.amount,
        businessPaid: 0,
        personalPaid: 0,
        applied,
        excess,
        outstanding,
        method,
        sourceLine: row.sourceLine,
      };

      if (applied > 0.005 && method === CARD_METHOD.PRO_RATA) {
        const share = business / outstanding;
        alloc.businessPaid = applied * share;
        alloc.personalPaid = applied * (1 - share);
      } else if (applied > 0.005) {
        // FIFO: oldest purchases first, whatever their purpose.
        let left = applied;
        for (const lot of lots) {
          if (left <= 0.005) break;
          if (lot.remaining <= 0) continue;
          const take = Math.min(left, lot.remaining);
          left -= take;
          if (lot.business) alloc.businessPaid += take; else alloc.personalPaid += take;
        }
      }
      business -= alloc.businessPaid;
      personal -= alloc.personalPaid;
      drawLots(alloc.businessPaid, true);
      drawLots(alloc.personalPaid, false);

      allocations.push(alloc);
      if (excess > 0.005) {
        prepaid.push({ allocation: allocations.length - 1, remaining: excess });
        warnings.push(`${row.date}: payment of ${row.amount.toFixed(2)} exceeds the ${outstanding.toFixed(2)} outstanding by ${excess.toFixed(2)} — carried as a prepayment; its fraction is set by the purchases that consume it`);
      }
      continue;
    }

    if (row.amount < 0) {
      const amount = -row.amount;
      purchases += amount;
      const alreadyPaid = consumePrepaid(amount, biz);
      const owed = amount - alreadyPaid;
      if (owed > 0.005) {
        if (biz) business += owed; else personal += owed;
        lots.push({ date: row.date, remaining: owed, business: biz });
      }
    } else if (row.amount > 0) {
      refunds += row.amount;
      refund(row.amount, biz);
    }
  }

  for (const a of allocations) {
    const paid = a.businessPaid + a.personalPaid;
    // A payment that never met a purchase determined nothing, and a fraction of 0 would
    // be a claim (all personal) rather than the absence of one.
    a.businessFraction = paid <= 0.005 ? null : round4(a.businessPaid / paid);
    a.businessPaid = round2(a.businessPaid);
    a.personalPaid = round2(a.personalPaid);
    a.unallocated = round2(a.amount - paid);
    if (a.businessFraction == null) {
      warnings.push(`${a.date}: payment of ${a.amount.toFixed(2)} never met a purchase — nothing determines its business share`);
    }
  }

  const unspent = prepaid.reduce((s, p) => s + p.remaining, 0);
  return {
    allocations,
    warnings,
    residual: { business: round2(business), personal: round2(personal), unspentPrepayments: round2(unspent) },
    totals: { purchases: round2(purchases), refunds: round2(refunds), payments: allocations.length },
    conservation: checkCardConservation({ allocations, purchases, refunds, business, personal, unspent }),
    method,
  };
}

/**
 * Every dollar of every payment must land somewhere: against a purchase, or unspent.
 *
 * This is the card's Gate 1. The identity is
 *
 *   purchases − refunds − payments  =  business owed + personal owed − unspent prepayments
 *
 * and the right-hand side should reproduce the statement's own closing balance. It is
 * worth checking because the failure it catches is invisible: an allocator that floors a
 * bucket at zero, or drops an overpayment, still produces plausible-looking fractions on
 * every row while quietly losing money — here it lost $1,819 of $49,427 before the
 * prepayment carry was added, and no fraction looked wrong.
 */
export function checkCardConservation({ allocations, purchases, refunds, business, personal, unspent }, tolerance = 0.01) {
  const payments = allocations.reduce((s, a) => s + a.amount, 0);
  const expected = purchases - refunds - payments;
  const actual = business + personal - unspent;
  const gap = actual - expected;
  return { expected: round2(expected), actual: round2(actual), gap: round2(gap), balanced: Math.abs(gap) <= tolerance };
}

const round4 = (n) => Math.round(n * 1e4) / 1e4;
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Tie each allocation to the account row that actually paid it, on date + magnitude.
 *
 * Exact-only, deliberately. A near miss here is not a rounding problem, it is a different
 * payment — and a card payment mismatched by a few dollars would attach a fraction
 * derived from the wrong month's purchases, which is invisible in every downstream report.
 * Anything that does not match exactly is REPORTED as uncovered and left for you.
 */
export function matchCardPayments(classified, allocations, tolerance = 0.005) {
  const byDate = new Map();
  for (const row of classified) {
    if (!row.date || !(row.amount < 0)) continue;
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push(row);
  }

  /**
   * How willing a row is to be the payment, lowest first.
   *
   * Date and amount alone stop being unique once the whole pool is ingested: a transfer
   * between two of your own accounts can be the same size on the same day as the card
   * payment, and taking whichever came first in the file matched the transfer, reported
   * it as a conflict, and left the real payment undecided. An OPEN row is what a card
   * payment awaiting its statement looks like, so it wins; a row already decided to be
   * something other than a disposition is the last resort and still reports a conflict.
   */
  const preference = (row) => {
    if (!row.kind) return 0;
    if (row.kind === 'DISPOSE') return 1;
    return 2;
  };

  const matched = [];
  const conflicts = [];
  const confirmed = [];
  const used = new Set();
  const unused = [];

  for (const allocation of allocations) {
    const candidates = (byDate.get(allocation.date) ?? [])
      .filter((r) => !used.has(r) && Math.abs(allocation.amount + r.amount) <= tolerance)
      .sort((a, b) => preference(a) - preference(b));
    const row = candidates[0];
    if (!row) { unused.push(allocation); continue; }
    used.add(row);

    // An allocation with no fraction determined nothing; leave the row as it was.
    if (allocation.businessFraction == null) continue;

    // A row you typed an answer for is not up for revision — the override channel is the
    // last word by design. But an override that AGREES is not a disagreement: the emitted
    // sheet is meant to be fed straight back in, and if agreement counted as a conflict
    // then the normal round trip would raise a blocking finding on every card payment it
    // had just resolved correctly. Only a real difference is worth a word.
    if (row.via === 'csv-override') {
      const agrees = row.kind === 'DISPOSE'
        && Math.abs((row.businessFraction ?? -1) - allocation.businessFraction) < 5e-5;
      if (agrees) confirmed.push({ row, allocation: allocation });
      else conflicts.push({ row, allocation: allocation, why: `csv-override says ${row.kind} ${row.businessFraction ?? '—'}, statement says DISPOSE ${allocation.businessFraction} — the override wins` });
      continue;
    }
    // A row a RULE decided is a genuine disagreement worth naming: the rule says this
    // payment is (say) INTERNAL while the statement says it paid for purchases. Silently
    // preferring either one would hide a broken rule.
    if (row.kind && row.kind !== 'DISPOSE') {
      conflicts.push({ row, allocation: allocation, why: `already classified ${row.kind} by ${row.via}` });
      continue;
    }
    matched.push({ row, allocation: allocation });
  }

  return { matched, conflicts, confirmed, unusedAllocations: unused };
}

/**
 * Stamp the matched fractions onto their rows, in place.
 *
 * A payment is a DISPOSE — AUD left the pool to settle a debt — and the fraction is the
 * §988(e)(3) "to the extent" split. `via` records the card and the method so the number
 * is traceable to the statement it came from rather than looking hand-entered.
 */
export function applyCardFractions(matched) {
  for (const { row, allocation } of matched) {
    row.kind = 'DISPOSE';
    row.businessFraction = allocation.businessFraction;
    row.via = `card:${allocation.card}/${allocation.method}`;
    row.note = `business share of the card balance this payment retired (${allocation.method}); statement line ${allocation.sourceLine}`;
    delete row.error;
    delete row.needsDecision;
  }
  return matched.length;
}
