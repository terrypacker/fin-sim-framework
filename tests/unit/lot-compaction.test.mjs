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
 * lot-compaction.test.mjs — design 93 §5.5.
 *
 * Compaction is the other half of the lot rule. §5.0a says a purchase is a new lot, which
 * followed honestly makes the holdings array grow once per purchase forever; without a
 * policy that merges them back down, §5.0a is a memory leak with a tax rationale.
 *
 * What the tests below are actually protecting is the CONDITION, not the arithmetic. A
 * merge is legitimate only when nothing downstream can distinguish the two lots — now or
 * ever after — so the seasoning gate and the build-by-exclusion key are the load-bearing
 * parts, and each has its own test. The arithmetic (sums, the harmonic level blend) is
 * checked for conservation, because a merge is not a disposal and must not create or
 * destroy basis.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { compactLots, LOT_POLICIES, promoteToUnitised } from '../../src/finance/holdings/holding-utils.js';

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const NOW     = Date.UTC(2040, 0, 1);
const aged    = years => new Date(NOW - years * YEAR_MS);

const lot = (id, over = {}) => ({
  id, allocation: 'EQUITY', marketValue: 10_000, costBasis: 8_000,
  rateKey: 'EQ', purchaseDate: aged(3), acquisitionPriceLevel: 1.2,
  label: '', dividendYield: 0.02, couponRate: null, duration: null,
  taxExemption: 'none', issuingState: null, costBaseByCountry: null,
  ...over,
});

const compact = (hs, policy = LOT_POLICIES.REINVEST) => compactLots(hs, { asOfMs: NOW, policy });

describe('lot compaction — when a merge is legitimate (design 93 §5.5)', () => {
  test('both lots must be seasoned past twelve months', () => {
    // The load-bearing condition. Past twelve months no holding-period rule can tell the
    // lots apart — AU Division 115, US §1222, the post-2027 indexation clock — so the
    // arithmetic below is allowed to blend them. Inside twelve months it is not.
    const old  = lot('reinvest-a', { purchaseDate: aged(3) });
    const fresh = lot('reinvest-b', { purchaseDate: aged(0.5) });
    assert.equal(compact([old, fresh]).length, 2, 'an unseasoned lot is never merged');
    assert.equal(compact([old, lot('reinvest-b', { purchaseDate: aged(2) })]).length, 1);
  });

  test('twelve months is 365 days — the same year the holding-period rules use', () => {
    // The two hand-written copies this policy replaced disagreed: one used 365 days, the
    // other 365.25, which is the bond files' MATURITY constant and not a holding period at
    // all. `holding-period.js` owns the question for the whole codebase (`isLongTerm`, the
    // FIFO discount gate), so the policy defers to it.
    const justOver  = new Date(NOW - YEAR_MS - 1);
    const justUnder = new Date(NOW - YEAR_MS + 1);
    assert.equal(compact([lot('reinvest-a', { purchaseDate: justOver }),
                          lot('reinvest-b', { purchaseDate: justOver })]).length, 1);
    assert.equal(compact([lot('reinvest-a', { purchaseDate: justOver }),
                          lot('reinvest-b', { purchaseDate: justUnder })]).length, 2);
  });

  test('a policy only ever merges its OWN family', () => {
    // Design 61's discipline, and the reason compaction has never merged something it
    // should not have. Three families now share this function; each still owns its prefix.
    const mine   = [lot('reinvest-a'), lot('reinvest-b')];
    const theirs = [lot('reb-a'), lot('ladder-b'), lot('authored-c')];
    assert.equal(compact([...mine, ...theirs]).length, 4, 'three foreign lots survive, mine merge');
    assert.equal(compact(mine, LOT_POLICIES.LADDER).length, 2, 'the ladder policy does not touch reinvest lots');
    assert.equal(compact([lot('reb-a'), lot('reb-b')], LOT_POLICIES.REBALANCE).length, 1);
  });

  test('a zero-value lot is never merged away', () => {
    // It has nothing to contribute, and merging it would quietly delete a row the journal
    // may still reference.
    const out = compact([lot('reinvest-a'), lot('reinvest-b', { marketValue: 0, costBasis: 0 })]);
    assert.equal(out.length, 2);
  });

  test('the key is built by EXCLUSION, so an unhandled field prevents the merge', () => {
    // The property that keeps this safe as `Holding` grows: a field the merge has no rule
    // for is automatically part of the key. Being too strict costs a longer array; being
    // too loose loses tax history.
    for (const patch of [{ allocation: 'BOND' }, { rateKey: 'OTHER' }, { taxExemption: 'state' },
                         { issuingState: 'NE' }, { costBaseByCountry: { AU: 100 } },
                         { someFutureField: 7 }]) {
      const out = compact([lot('reinvest-a'), lot('reinvest-b', patch)]);
      assert.equal(out.length, 2, `lots differing in ${Object.keys(patch)[0]} must not merge`);
    }
  });

  test('a blended field\'s NULL-ness is part of the key, not something to average', () => {
    // A lot whose coupon floats is a different instrument from one that locked a rate,
    // however close the numbers are.
    const floating = lot('reinvest-a', { allocation: 'BOND', couponRate: null });
    const locked   = lot('reinvest-b', { allocation: 'BOND', couponRate: 0.04 });
    assert.equal(compact([floating, locked]).length, 2);
  });
});

describe('lot compaction — what the merge conserves (design 93 §5.5)', () => {
  test('value and basis are conserved; the survivor is the EARLIEST lot', () => {
    const a = lot('reinvest-a', { purchaseDate: aged(5), marketValue: 10_000, costBasis: 8_000 });
    const b = lot('reinvest-b', { purchaseDate: aged(2), marketValue: 30_000, costBasis: 25_000 });
    const [m, ...rest] = compact([b, a]);   // deliberately out of order
    assert.equal(rest.length, 0);
    assert.equal(m.id, 'reinvest-a', 'earliest wins, so FIFO order across the boundary is unchanged');
    assert.equal(m.purchaseDate.getTime(), aged(5).getTime());
    assert.equal(m.marketValue, 40_000);
    assert.equal(m.costBasis,   33_000, 'a merge is not a disposal — basis is conserved exactly');
  });

  test('acquisitionPriceLevel is the basis-weighted HARMONIC mean, which is exact', () => {
    // The AU indexed cost base is Σ basisᵢ × (levelNow / levelᵢ). Setting the merged level
    // to Σbasisᵢ / Σ(basisᵢ / levelᵢ) reproduces that sum precisely from one basis and one
    // level; an arithmetic mean would not, and leaving the level in the key would make
    // every vintage unique and stop compaction dead.
    const a = lot('reinvest-a', { costBasis: 10_000, acquisitionPriceLevel: 1.0 });
    const b = lot('reinvest-b', { costBasis: 30_000, acquisitionPriceLevel: 1.5 });
    const [m] = compact([a, b]);

    const levelNow = 2.0;
    const before = 10_000 * (levelNow / 1.0) + 30_000 * (levelNow / 1.5);
    const after  = m.costBasis * (levelNow / m.acquisitionPriceLevel);
    assert.ok(Math.abs(before - after) < 0.01,
      `indexed cost base must survive the merge: ${before} vs ${after}`);
  });

  test('blended fields are weighted by market value, which is what consumes them', () => {
    const a = lot('reinvest-a', { allocation: 'BOND', marketValue: 10_000, couponRate: 0.02, duration: 2 });
    const b = lot('reinvest-b', { allocation: 'BOND', marketValue: 30_000, couponRate: 0.06, duration: 6 });
    const [m] = compact([a, b]);
    assert.equal(m.couponRate, 0.05, 'mv × rate is what the coupon path consumes, so the blend is exact');
    assert.equal(m.duration,   5);
  });

  test('a UNITISED lot sums units and RE-DERIVES value — never sums value directly', () => {
    // design 93 §5: both modes are first-class, and the dispatch is on the lot rather than
    // on config. Summing marketValue on a unitised lot would leave the count behind, which
    // is the failure the whole substrate exists to make unrepresentable.
    const mk = (id, over) => promoteToUnitised({
      id, allocation: 'BOND', marketValue: 10_000, costBasis: 10_000, faceValue: 10_000,
      maturityDate: new Date(Date.UTC(2044, 0, 1)), couponRate: 0.04, rateKey: 'FI',
      purchaseDate: aged(3), acquisitionPriceLevel: 1.2, label: '',
      taxExemption: 'state', issuingState: null, ...over,
    });
    const [m] = compactLots([mk('ladder-a'), mk('ladder-b', { purchaseDate: aged(2) })],
                            { asOfMs: NOW, policy: LOT_POLICIES.LADDER });
    assert.equal(m.units,        200);
    assert.equal(m.marketValue,  20_000, 'derived from the count');
    assert.equal(m.faceValue,    20_000, 'and so is par — they cannot disagree');
    assert.equal(m.parPerUnit,   100,    'par per unit is a constant of the instrument');
  });

  test('the LADDER policy sums per-country bases; the others keep them in the key', () => {
    // The one genuine difference between the three. A ladder rebuild's carryover
    // legitimately produces rungs differing only in how a step-up was apportioned across
    // them; a reinvest or rebalance vintage differing that way is a residency step-up that
    // must not be blended.
    const a = { ...lot('x-a'), costBaseByCountry: { AU: 5_000 } };
    const b = { ...lot('x-b'), costBaseByCountry: { AU: 3_000 } };
    const ladder = compactLots([{ ...a, id: 'ladder-a' }, { ...b, id: 'ladder-b' }],
                               { asOfMs: NOW, policy: LOT_POLICIES.LADDER });
    assert.equal(ladder.length, 1);
    assert.equal(ladder[0].costBaseByCountry.AU, 8_000, 'summed');

    const reinvest = compactLots([{ ...a, id: 'reinvest-a' }, { ...b, id: 'reinvest-b' }],
                                 { asOfMs: NOW, policy: LOT_POLICIES.REINVEST });
    assert.equal(reinvest.length, 2, 'a step-up is never blended across reinvest vintages');
  });

  test('nothing to merge returns the SAME array — no state write, no journal churn', () => {
    const hs = [lot('reinvest-a'), lot('reb-b')];
    assert.equal(compact(hs), hs);
    assert.equal(compactLots([], { asOfMs: NOW, policy: LOT_POLICIES.REINVEST }).length, 0);
  });
});
