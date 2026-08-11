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
 * capital-loss-term-split.test.mjs — design 90 §3.1.
 *
 * `consumeHoldings` gains a SIGNED realized-gain tally split by holding period and by
 * country. Three properties, and each one is a defect this replaces:
 *
 *   1. **A disposal below basis produces a recorded LOSS.** Every consumer upstream
 *      computed `Math.max(0, proceeds − basis)`, so a sale below basis booked zero and
 *      the loss was discarded. Measured on a real 44-year run: 1,400+ disposals, zero
 *      negative gains, through a −40% shock.
 *
 *   2. **Character is per LOT, not per disposal.** A draw consuming a short-term loss
 *      lot and a long-term gain lot is *both*, and IRC §1212(b)(1)(A)/(B) carries the
 *      two forward as separate pools. Netting them before they leave here destroys the
 *      information the statute needs.
 *
 *   3. **The long-term test is per COUNTRY, and the two differ at the boundary.**
 *      AU Div 115 is "at least 12 months" (inclusive); IRC §1222(3) is "more than 1
 *      year" (exclusive). A lot held exactly 365 days is AU-discountable and US
 *      short-term at the same instant.
 *
 * Plus the guarantee that makes this landable on its own: **omitting `terms` changes
 * nothing.** Steps 1–2 of design 90 §9 are behaviour-preserving by construction, and
 * that is only true if the new path is genuinely inert when unasked-for.
 *
 * Run with: node --test tests/unit/capital-loss-term-split.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { consumeHoldings, consumeHoldingsFifo } from '../../src/finance/holdings/holdings-fifo.js';
import { ALLOCATION } from '../../src/finance/holdings/allocation.js';

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const DAY_MS  = 24 * 60 * 60 * 1000;
const SALE_MS = Date.UTC(2030, 0, 1);

/** A lot bought `yearsAgo` before the sale date, with the given basis and market value. */
function lot({ yearsAgo, costBasis, marketValue, allocation = ALLOCATION.EQUITY,
               costBaseByCountry = null, acquisitionDateByCountry = null, id = 'h' }) {
  return {
    id, allocation, costBasis, marketValue,
    purchaseDate: new Date(SALE_MS - yearsAgo * YEAR_MS),
    costBaseByCountry, acquisitionDateByCountry, acquisitionPriceLevel: null,
  };
}

const TERMS = { asOfMs: SALE_MS, countries: ['US', 'AU'] };

// ─── 1. A disposal below basis produces a recorded loss ──────────────────────

test('design 90 §3: a disposal below basis books a NEGATIVE gain, not zero', () => {
  // Bought at 100k, now worth 60k, sold entirely. The old floor made this 0.
  const r = consumeHoldings([lot({ yearsAgo: 5, costBasis: 100_000, marketValue: 60_000 })],
                            60_000, { terms: TERMS });

  assert.equal(r.realizedGainByCountryAndTerm.US.long, -40_000);
  assert.equal(r.realizedGainByCountryAndTerm.AU.long, -40_000);
  assert.equal(r.realizedGainByCountryAndTerm.US.short, 0);
});

test('design 90 §3: a partial disposal below basis books a pro-rata loss', () => {
  // Half the position: half the basis, half the loss.
  const r = consumeHoldings([lot({ yearsAgo: 5, costBasis: 100_000, marketValue: 60_000 })],
                            30_000, { terms: TERMS });

  assert.equal(r.realizedGainByCountryAndTerm.US.long, -20_000);
  assert.equal(r.consumed, 30_000);
});

// ─── 2. Character is per lot, and gains and losses do not net here ───────────

test('design 90 §3.1: a short-term LOSS and a long-term GAIN in one disposal stay separate', () => {
  // This is the case §1212(b)(1)(A)/(B) needs and a netted scalar cannot express.
  const holdings = [
    lot({ id: 'old', yearsAgo: 8,   costBasis:  20_000, marketValue: 50_000 }),  // +30k long
    lot({ id: 'new', yearsAgo: 0.5, costBasis:  40_000, marketValue: 25_000 }),  // −15k short
  ];
  // Consume both lots entirely (50k + 25k).
  const r = consumeHoldings(holdings, 75_000, { terms: TERMS });

  assert.equal(r.realizedGainByCountryAndTerm.US.long,  30_000);
  assert.equal(r.realizedGainByCountryAndTerm.US.short, -15_000);
  // The netted figure (+15k) is recoverable from these two; the reverse is not, which
  // is precisely why the split lives here rather than at the consumer.
  assert.equal(r.realizedGainByCountryAndTerm.US.long + r.realizedGainByCountryAndTerm.US.short,
               15_000);
});

// ─── 3. The long-term test is per country and differs at the boundary ────────

test('design 90 §6: a lot held exactly 12 months is AU-long and US-short', () => {
  // Div 115 "at least 12 months" includes the boundary; §1222(3) "more than 1 year"
  // excludes it. Same lot, same instant, two answers — and both are what the Act says.
  const r = consumeHoldings([lot({ yearsAgo: 1, costBasis: 10_000, marketValue: 15_000 })],
                            15_000, { terms: TERMS });

  assert.equal(r.realizedGainByCountryAndTerm.AU.long,  5_000, 'AU: inclusive ⇒ long');
  assert.equal(r.realizedGainByCountryAndTerm.AU.short, 0);
  assert.equal(r.realizedGainByCountryAndTerm.US.short, 5_000, 'US: exclusive ⇒ short');
  assert.equal(r.realizedGainByCountryAndTerm.US.long,  0);
});

test('design 90 §6: one day past the boundary, both countries agree it is long-term', () => {
  const holdings = [{
    ...lot({ yearsAgo: 0, costBasis: 10_000, marketValue: 15_000 }),
    purchaseDate: new Date(SALE_MS - YEAR_MS - DAY_MS),
  }];
  const r = consumeHoldings(holdings, 15_000, { terms: TERMS });

  assert.equal(r.realizedGainByCountryAndTerm.US.long, 5_000);
  assert.equal(r.realizedGainByCountryAndTerm.AU.long, 5_000);
});

// ─── The per-country basis and clock are independent ─────────────────────────

test('design 90 §3.1: each country uses its OWN cost base and its OWN acquisition date', () => {
  // A lot bought 8 years ago at 20k, stepped up by AU (s855-45) to 90k at a move 6
  // months before the sale. The US keeps its original basis and its original clock;
  // AU takes the stepped-up base and restarts the clock at the move.
  const moveMs = SALE_MS - 0.5 * YEAR_MS;
  const holdings = [lot({
    yearsAgo: 8, costBasis: 20_000, marketValue: 100_000,
    costBaseByCountry:        { AU: 90_000 },
    acquisitionDateByCountry: { AU: moveMs },
  })];
  const r = consumeHoldings(holdings, 100_000, { terms: TERMS });

  assert.equal(r.realizedGainByCountryAndTerm.US.long,  80_000, 'US: original basis, long-held');
  assert.equal(r.realizedGainByCountryAndTerm.US.short, 0);
  assert.equal(r.realizedGainByCountryAndTerm.AU.short, 10_000, 'AU: stepped-up basis, clock restarted');
  assert.equal(r.realizedGainByCountryAndTerm.AU.long,  0);
});

// ─── Collectibles are tallied separately, but their LOSSES are still tracked ─

test('design 90 §3.1: the GOLD slice tallies into its own signed bucket', () => {
  // Collectible gain has its own 28% bucket (§1(h)(4)), so it must not land in the
  // ordinary tally — but a collectible LOSS is still a capital loss and must survive.
  const holdings = [
    lot({ id: 'eq',   yearsAgo: 5, costBasis: 10_000, marketValue: 15_000 }),
    lot({ id: 'gold', yearsAgo: 5, costBasis: 30_000, marketValue: 20_000, allocation: ALLOCATION.GOLD }),
  ];
  const r = consumeHoldings(holdings, 35_000, { terms: TERMS });

  assert.equal(r.realizedGainByCountryAndTerm.US.long,     5_000,  'equity gain only');
  assert.equal(r.collectibleGainByCountryAndTerm.US.long, -10_000, 'gold loss is recorded');
});

// ─── CASH realizes nothing, and the zero is by construction ──────────────────

test('design 90 §3.1: a CASH sleeve contributes exactly zero to the term tally', () => {
  // Design 87 §11 — a unit of currency is disposed of for its face, so basis == proceeds
  // and there is no price to have moved. Note the lot carries a deliberately WRONG
  // costBasis to prove the invariant is asserted rather than inherited.
  const holdings = [lot({ yearsAgo: 5, costBasis: 999, marketValue: 50_000, allocation: ALLOCATION.CASH })];
  const r = consumeHoldings(holdings, 50_000, { terms: TERMS });

  assert.equal(r.realizedGainByCountryAndTerm.US.long,  0);
  assert.equal(r.realizedGainByCountryAndTerm.US.short, 0);
});

// ─── Inertness: the whole point of landing this on its own ───────────────────

test('design 90 §9 step 1: omitting `terms` leaves the result byte-identical', () => {
  const holdings = () => [
    lot({ id: 'a', yearsAgo: 8,   costBasis: 20_000, marketValue: 50_000 }),
    lot({ id: 'b', yearsAgo: 0.5, costBasis: 40_000, marketValue: 25_000 }),
  ];
  const withTerms = consumeHoldings(holdings(), 60_000, { terms: TERMS });
  const without   = consumeHoldings(holdings(), 60_000);

  // Every pre-existing field is untouched...
  for (const k of ['realizedBasis', 'consumed', 'collectibleProceeds', 'collectibleBasis']) {
    assert.deepEqual(withTerms[k], without[k], `${k} must not move`);
  }
  assert.deepEqual(withTerms.newHoldings, without.newHoldings);
  assert.deepEqual(withTerms.realizedDiscountableGainByCountry, without.realizedDiscountableGainByCountry);
  // ...and the new ones are absent rather than zero-filled, so a consumer that reads
  // them without asking gets `undefined` (a crash) rather than a plausible zero.
  assert.deepEqual(without.realizedGainByCountryAndTerm,    {});
  assert.deepEqual(without.collectibleGainByCountryAndTerm, {});
});

test('design 90 §9 step 1: consumeHoldingsFifo (the historic entry point) is unchanged', () => {
  const r = consumeHoldingsFifo([lot({ yearsAgo: 5, costBasis: 100_000, marketValue: 60_000 })], 60_000);
  assert.deepEqual(r.realizedGainByCountryAndTerm, {});
  assert.equal(r.realizedBasis, 100_000);
});

test('design 90 §3.1: an empty/zero disposal returns empty term tallies, not undefined', () => {
  // The early-return path is easy to forget and its shape must match the main path,
  // or a consumer that spreads the result gets a hole only on the empty-account branch.
  for (const r of [consumeHoldings([], 1_000, { terms: TERMS }),
                   consumeHoldings([lot({ yearsAgo: 5, costBasis: 1, marketValue: 1 })], 0, { terms: TERMS })]) {
    assert.deepEqual(r.realizedGainByCountryAndTerm,    {});
    assert.deepEqual(r.collectibleGainByCountryAndTerm, {});
  }
});

// ─── The AU discount slice must not have drifted ─────────────────────────────

test('design 90 §3.1: the Div 115 discountable slice is unchanged by the term split', () => {
  // The two answer different questions (floored-and-eligible vs signed-and-charactered)
  // and must not be quietly unified. A loss lot contributes 0 to the discountable slice
  // and −15k to the signed one, in the same call.
  const holdings = [
    lot({ id: 'gain', yearsAgo: 5,   costBasis: 20_000, marketValue: 50_000 }),
    lot({ id: 'loss', yearsAgo: 5,   costBasis: 40_000, marketValue: 25_000 }),
  ];
  const r = consumeHoldings(holdings, 75_000, {
    indexation: { asOfMs: SALE_MS, country: 'AU' },
    terms: TERMS,
  });

  // Discountable: the gain lot's +30k, and the loss lot floored to 0 ⇒ 30k.
  assert.equal(r.realizedDiscountableGainByCountry.AU, 30_000);
  // Signed: +30k and −15k, netting to +15k but reported separately.
  assert.equal(r.realizedGainByCountryAndTerm.AU.long, 15_000);
});
