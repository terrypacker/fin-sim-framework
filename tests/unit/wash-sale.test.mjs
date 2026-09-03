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
 * wash-sale.test.mjs — design 94 steps 7a.2, 7b and 7c (§8.1i, §8.1j, §8.1l).
 *
 * Rev. Rul. 2008-5: a loss washed into the taxpayer's own IRA or Roth IRA is DESTROYED, not
 * deferred — "A's basis in the individual retirement account or Roth IRA is not increased by
 * virtue of § 1091(d)". So the model's job is a subtraction, and the questions worth testing
 * are about WHICH subtraction, from WHERE, and WHEN:
 *
 *   - which:  §1091(b) matches SHARES, so the disallowed fraction is matchedUnits/unitsSold;
 *   - where:  the return FOR THE YEAR OF SALE — §1091 disallows it there and nowhere else;
 *   - when:   at the April filing, by which time every window opened in the filed year has
 *             closed. §8.1i originally clawed it out of a later year's carryforward because
 *             the 31-December settle could not see the answer yet; §8.1l split the tax year's
 *             END from the return's FILING and that whole workaround is gone.
 *
 * The taxable-replacement wash (§1091(d) basis transfer + §1223(3) tack-on) is 7b and is
 * deliberately NOT here: it is a timing effect, and R2 held it.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { resolveWashSales }       from '../../src/finance/tax/us/wash-sale.js';
import { UsTaxFileHandler, UsTaxFileApplyReducer } from '../../src/finance/tax/us/tax-file-classes.js';
import { UsTaxSettleHandler }     from '../../src/finance/tax/tax-settle-classes.js';
import { StockHarvestApplyReducer } from '../../src/finance/behavioral/stock-harvest-apply-reducer.js';
import { buildSecurityRegistry }  from '../../src/finance/holdings/security.js';
import { ACCOUNT_ROLES }          from '../../src/finance/state/account-roles.js';
import { RATE_KEYS }              from '../../src/finance/economic-regimes/rate-keys.js';

const DAY  = 24 * 60 * 60 * 1000;
const SALE = Date.UTC(2032, 11, 31);          // the 31-Dec harvest R2 found dominant
const REGISTRY = buildSecurityRegistry([
  { id: 'sec-emp', rateKey: RATE_KEYS.EQUITY_US },
  { id: 'sec-alt', rateKey: RATE_KEYS.EQUITY_US },
]);

/** An IRA holding `units` of `securityId`, bought `dayOffset` days from the sale. */
const iraWith = (securityId, units, dayOffset, role = ACCOUNT_ROLES.IRA) => ({
  role, balance: 1000, holdings: [{
    id: 'ira-lot', securityId, allocation: 'EQUITY', units, pricePerUnit: 100,
    marketValue: units * 100, costBasis: units * 100,
    purchaseDate: new Date(SALE + dayOffset * DAY),
  }],
});

const stateWith = ({ pending, account, carryLong = 10_000, carryShort = 0 }) => ({
  securities: REGISTRY,
  washPendingLosses: pending,
  usLongTermCapitalLossCarryforward:  carryLong,
  usShortTermCapitalLossCarryforward: carryShort,
  ...(account ? { iraAccount: account } : {}),
});

const entry = (over = {}) => ({
  ms: SALE, group: 'sec-emp', units: 100, shortLoss: 0, longLoss: 5_000,
  stateKey: 'usStockAccount', ...over,
});

/** Resolve the 2032 return's wash sales, the way the April 2033 filing does. */
const resolve = (state) =>
  resolveWashSales(state, Date.UTC(2032, 0, 1), Date.UTC(2033, 0, 1) - 1);

describe('resolving a return\'s wash sales (§8.1i)', () => {
  test('a replacement of 75 against a sale of 100 disallows three quarters', () => {
    // §1.1091-1(h) Example 2, in the model's units: §1091(b) matches SHARES, not dollars.
    const r = resolve(stateWith({ pending: [entry()], account: iraWith('sec-emp', 75, 1) }));
    assert.equal(r.disallowedLong, 3_750);
    assert.equal(r.ledger[0].matchedFraction, 0.75);
  });

  test('a replacement LARGER than the sale disallows all of it, not more', () => {
    const r = resolve(stateWith({ pending: [entry()], account: iraWith('sec-emp', 500, 1) }));
    assert.equal(r.disallowedLong, 5_000);
  });

  test('a purchase OUTSIDE the 61-day window is not a replacement', () => {
    const r = resolve(stateWith({ pending: [entry()], account: iraWith('sec-emp', 100, 45) }));
    assert.equal(r.disallowedLong, 0);
    assert.equal(r.remaining.length, 0, 'the entry retires rather than rotting in the ledger');
  });

  test('30 days BEFORE the sale counts too — the window is symmetric', () => {
    const r = resolve(stateWith({ pending: [entry()], account: iraWith('sec-emp', 100, -20) }));
    assert.equal(r.disallowedLong, 5_000);
  });

  test('a sale in a LATER year is carried, not resolved on this return', () => {
    // It belongs to a return that has not been filed yet. Resolving it here would disallow a
    // loss on a return that never claimed it.
    const later = entry({ ms: Date.UTC(2033, 5, 1) });
    const r = resolve(stateWith({ pending: [later], account: iraWith('sec-emp', 100, 150) }));
    assert.equal(r.disallowedLong, 0);
    assert.deepEqual(r.remaining, [later]);
  });

  test('a DIFFERENT security is not substantially identical', () => {
    // §8.1c: identity is declared. Both of these track EQUITY_US and they are still not the
    // same instrument — the case the old substitute rule got wrong by using `rateKey`.
    const r = resolve(stateWith({ pending: [entry()], account: iraWith('sec-alt', 100, 1) }));
    assert.equal(r.disallowedLong, 0);
  });

  test('a declared identityGroup DOES bind two securities', () => {
    const grouped = buildSecurityRegistry([
      { id: 'sec-emp', rateKey: RATE_KEYS.EQUITY_US, identityGroup: 'grp' },
      { id: 'sec-alt', rateKey: RATE_KEYS.EQUITY_US, identityGroup: 'grp' },
    ]);
    const st = { ...stateWith({ pending: [entry({ group: 'grp' })], account: iraWith('sec-alt', 100, 1) }),
                 securities: grouped };
    assert.equal(resolve(st).disallowedLong, 5_000);
  });

  test('short and long are reported separately (§1212(b) keeps them apart)', () => {
    const r = resolve(stateWith({
      pending: [entry({ shortLoss: 2_000, longLoss: 1_000 })],
      account: iraWith('sec-emp', 100, 1),
    }));
    assert.equal(r.disallowedShort, 2_000);
    assert.equal(r.disallowedLong,  1_000);
  });

  test('nothing pending ⇒ nothing resolved, and no allocation', () => {
    assert.deepEqual(resolve({ securities: REGISTRY }),
      { disallowedShort: 0, disallowedLong: 0, ledger: [], remaining: [], basisAdjustments: [] });
  });
});

describe('§1091(d) + §1223(3): a TAXABLE replacement DEFERS the loss (§8.1p)', () => {
  // Rev. Rul. 2008-5 is the exception, not the rule. §1091(d)'s ordinary case moves the
  // disallowed loss into the replacement's BASIS — the taxpayer keeps it and gets it back on
  // the eventual sale — and §1223(3) tacks the sold shares' holding period onto it so a wash
  // can never turn a long-term position into a short-term one. Both are cross-ACCOUNT here:
  // the harvester's own same-day rebuy is settled on the spot by §8.1j.

  /** A US brokerage holding `units` of `securityId`, bought `dayOffset` days from the sale. */
  const brokerageWith = (securityId, units, dayOffset, over = {}) => ({
    role: ACCOUNT_ROLES.US_STOCK, country: 'US', balance: units * 100,
    holdings: [{
      id: 'brk-lot', securityId, allocation: 'EQUITY', units, pricePerUnit: 100,
      marketValue: units * 100, costBasis: units * 100,
      purchaseDate: new Date(SALE + dayOffset * DAY), ...over,
    }],
  });

  const withBrokerage = ({ pending, account, brokerage }) => ({
    securities: REGISTRY,
    washPendingLosses: pending,
    ...(account   ? { iraAccount: account }        : {}),
    ...(brokerage ? { taxableAccount: brokerage }  : {}),
  });

  const file = (st) => {
    const wash = resolve(st);
    // The apply reducer is what writes basis, so the assertion runs through it rather than
    // over the resolver's report — the report is a plan, and a plan that no reducer honours
    // is the shape of gap §8.1o was written about.
    const action = { type: 'US_TAX_FILE_APPLY', taxYear: 2032, delta: 0,
                     disallowed: wash.disallowedShort + wash.disallowedLong,
                     ledger: wash.ledger, remaining: wash.remaining,
                     basisAdjustments: wash.basisAdjustments };
    return { wash, next: new UsTaxFileApplyReducer().reduce(st, action) };
  };

  test('the loss is disallowed, and lands in the replacement lot\'s basis', () => {
    const st = withBrokerage({ pending: [entry()], brokerage: brokerageWith('sec-emp', 100, 1) });
    const { wash, next } = file(st);

    assert.equal(wash.disallowedLong, 5_000, '§1091(a) disallows it either way');
    assert.equal(wash.ledger[0].deferred, 5_000, 'and §1091(d) says where it went');
    // 100 units at 100 = 10,000 of basis, plus the 5,000 the sale could not deduct.
    assert.equal(next.taxableAccount.holdings[0].costBasis, 15_000);
  });

  test('an IRA replacement DESTROYS it — the basis goes nowhere', () => {
    // The contrast that makes the branch above meaningful. Same sale, same shares, same
    // disallowance; the money simply ceases to exist.
    const st = withBrokerage({ pending: [entry()], account: iraWith('sec-emp', 100, 1) });
    const { wash, next } = file(st);
    assert.equal(wash.disallowedLong, 5_000);
    assert.equal(wash.ledger[0].deferred, undefined, 'nothing is deferred');
    assert.deepEqual(wash.basisAdjustments, []);
    assert.equal(next.iraAccount.holdings[0].costBasis, 10_000, 'Rev. Rul. 2008-5: not increased');
  });

  test('§1223(3): the replacement is back-dated by the sold shares\' holding period', () => {
    // Sold after 400 days held; replaced 10 days later. The replacement must read as having
    // been held those 400 days too, or the wash would have converted long-term into short.
    const st = withBrokerage({
      pending:   [entry({ heldFromMs: SALE - 400 * DAY })],
      brokerage: brokerageWith('sec-emp', 100, 10),
    });
    const { next } = file(st);
    const tacked = next.taxableAccount.holdings[0].purchaseDate.getTime();
    assert.equal(tacked, SALE + 10 * DAY - 400 * DAY);
  });

  test('no holding period on the entry ⇒ basis still moves, the date does not', () => {
    // An entry written before the sold lot had a date. The deferral is the money and must
    // not be forfeited over a missing field; the tack is the bonus and is simply skipped.
    const st = withBrokerage({
      pending:   [entry({ heldFromMs: null })],
      brokerage: brokerageWith('sec-emp', 100, 1),
    });
    const { next } = file(st);
    assert.equal(next.taxableAccount.holdings[0].costBasis, 15_000);
    assert.equal(next.taxableAccount.holdings[0].purchaseDate.getTime(), SALE + DAY);
  });

  test('a PARTIAL match splits the lot: only the matched shares take the basis', () => {
    // 100 sold, 250 bought. §1.1091-1(d) matches 100 of the 250, and the other 150 are an
    // ordinary purchase — raising their basis too would hand the taxpayer a deduction
    // nobody paid for, and tacking their date would age shares that were never sold.
    const st = withBrokerage({ pending: [entry()], brokerage: brokerageWith('sec-emp', 250, 1) });
    const { next } = file(st);
    const lots = next.taxableAccount.holdings;
    assert.equal(lots.length, 2, 'the lot bifurcates');

    const matched   = lots.find(h => h.id === 'brk-lot-1091');
    const untouched = lots.find(h => h.id === 'brk-lot');
    assert.equal(+matched.units.toFixed(6), 100);
    assert.equal(+untouched.units.toFixed(6), 150);
    // The lot's 25,000 of basis splits 100/250 : 150/250 — 10,000 and 15,000 — and only the
    // matched half takes the 5,000 the sale could not deduct.
    assert.equal(matched.costBasis, 10_000 + 5_000);
    assert.equal(untouched.costBasis, 15_000);
    // Value is conserved by the split — only BASIS moved.
    assert.equal(+(matched.marketValue + untouched.marketValue).toFixed(2), 25_000);
  });

  test('the shares are still consumed across kinds — one pool, two consequences', () => {
    // 100 sold; 60 replaced in an IRA and 100 in the brokerage, the IRA's bought first. Per
    // §1.1091-1(c)/(d) acquisition order, the IRA takes 60 and the brokerage 40 — so 60% of
    // the loss is destroyed and 40% is deferred, and the ledger says which is which.
    const st = withBrokerage({
      pending:   [entry()],
      account:   iraWith('sec-emp', 60, 1),
      brokerage: brokerageWith('sec-emp', 100, 5),
    });
    const { wash, next } = file(st);
    assert.equal(wash.disallowedLong, 5_000, 'the whole loss is disallowed either way');
    assert.equal(wash.ledger[0].deferred, 2_000, '40 of the 100 shares were taxable');
    const matched = next.taxableAccount.holdings.find(h => h.id === 'brk-lot-1091');
    assert.equal(+matched.units.toFixed(6), 40);
    assert.equal(matched.costBasis, 4_000 + 2_000);
  });

  test('a replacement SOLD before April: the disallowance stands, the deferral is tallied', () => {
    // The cost of resolving four months late. §1091(a) does not depend on still holding the
    // replacement, so the loss is gone from the return either way — but there is no lot left
    // to carry the basis, and that must be visible rather than silently dropped.
    const st = withBrokerage({ pending: [entry()], brokerage: brokerageWith('sec-emp', 100, 1) });
    const wash = resolve(st);
    const gone = { ...st, taxableAccount: { ...st.taxableAccount, holdings: [] } };
    const next = new UsTaxFileApplyReducer().reduce(gone, {
      type: 'US_TAX_FILE_APPLY', taxYear: 2032, delta: 0, disallowed: 5_000,
      ledger: wash.ledger, remaining: wash.remaining, basisAdjustments: wash.basisAdjustments,
    });
    assert.equal(next.washDeferralUnplaced, 5_000);
  });

  test('an AU-domiciled brokerage is NOT a replacement — the AU basis is measured differently', () => {
    // `costBasis` is the origin/US basis and `costBaseByCountry.AU` is Australia's own
    // (s855-45). There is no §1091 in Australia, so a US rule must not raise a basis the AU
    // return reads. Deliberate under-disallowance, same direction as the 401(k) exclusion.
    const au = { ...brokerageWith('sec-emp', 100, 1), country: 'AU', role: ACCOUNT_ROLES.AU_STOCK };
    const st = withBrokerage({ pending: [entry()], brokerage: au });
    const { wash } = file(st);
    assert.equal(wash.disallowedLong, 0, 'no match at all — the loss stands');
    assert.deepEqual(wash.basisAdjustments, []);
  });
});

describe('replacement shares are consumed — §1.1091-1(e) (§8.1o)', () => {
  // "The acquisition of any share of stock or any security which results in the
  // nondeductibility of a loss ... shall be disregarded in determining the deductibility of
  // any other loss." One IRA purchase can therefore wash ONE sale of the same size, not every
  // sale in the ledger — and until §8.1o the resolver re-counted the same shares for each
  // pending entry it saw.
  const twoSales = (over = {}) => [
    entry({ stateKey: 'brokerage', ...over }),
    entry({ stateKey: 'usStockAccount', ...over }),
  ];

  test('100 replacement shares wash ONE 100-share sale, not both', () => {
    const r = resolve(stateWith({ pending: twoSales(), account: iraWith('sec-emp', 100, 1) }));
    assert.equal(r.disallowedLong, 5_000, 'the second sale has nothing left to be washed by');
    assert.equal(r.ledger.length, 1);
  });

  test('200 replacement shares wash both', () => {
    const r = resolve(stateWith({ pending: twoSales(), account: iraWith('sec-emp', 200, 1) }));
    assert.equal(r.disallowedLong, 10_000);
    assert.equal(r.ledger.length, 2);
  });

  test('150 shares wash the first sale whole and half the second', () => {
    // §1.1091-1(c): the acquired shares are matched with an equal number of the shares sold.
    const r = resolve(stateWith({ pending: twoSales(), account: iraWith('sec-emp', 150, 1) }));
    assert.equal(r.disallowedLong, 7_500);
    assert.deepEqual(r.ledger.map(e => e.matchedFraction), [1, 0.5]);
  });

  test('§1.1091-1(b): the EARLIEST disposition has first call on the shares', () => {
    // Written to the ledger newest-first, resolved oldest-first. The rebalancer writes on
    // 1 January and the harvester on 31 December, so both orders occur in one run.
    const late  = entry({ ms: SALE - 5 * DAY,  stateKey: 'late'  });
    const early = entry({ ms: SALE - 25 * DAY, stateKey: 'early' });
    // Bought between the two sales, so it is inside BOTH 61-day windows; only the earlier
    // disposition may have it.
    const r = resolve(stateWith({ pending: [late, early],
                                  account: iraWith('sec-emp', 100, -15) }));
    assert.equal(r.ledger.length, 1);
    assert.equal(r.ledger[0].stateKey, 'early');
  });

  test('a different identity group draws on its own shares only', () => {
    const mixed = [entry({ group: 'sec-emp' }), entry({ group: 'sec-alt' })];
    const r = resolve(stateWith({ pending: mixed, account: iraWith('sec-emp', 100, 1) }));
    assert.equal(r.disallowedLong, 5_000);
    assert.equal(r.ledger[0].group, 'sec-emp');
  });

  test('an entry filed NEXT year consumes nothing this year', () => {
    // It is carried to its own return, where the same lots are re-tested — the shares are not
    // spent here on a loss this filing is not allowed to disallow.
    const later = entry({ ms: Date.UTC(2033, 5, 1), stateKey: 'later' });
    const r = resolve(stateWith({ pending: [later, entry()], account: iraWith('sec-emp', 100, 1) }));
    assert.equal(r.disallowedLong, 5_000);
    assert.deepEqual(r.remaining, [later]);
  });
});

describe('which wrappers the cited authority reaches (§8.1i)', () => {
  for (const role of [ACCOUNT_ROLES.IRA, ACCOUNT_ROLES.ROTH, ACCOUNT_ROLES.INHERITED_IRA]) {
    test(`${role} destroys the loss`, () => {
      const r = resolve(stateWith({ pending: [entry()], account: iraWith('sec-emp', 100, 1, role) }));
      assert.equal(r.disallowedLong, 5_000);
    });
  }

  test('a 401(k) does NOT — deliberately, because no source on disk says it does', () => {
    // Rev. Rul. 2008-5 and Pub. 550 ch. 4 name the IRA and the Roth IRA. The same "command
    // over the property never left" reasoning would plainly reach a 401(k), and that is
    // exactly why it is NOT extended here: this repo does not quote tax law it has not
    // fetched. A deliberate under-disallowance, recorded rather than assumed away.
    const r = resolve(stateWith({ pending: [entry()], account: iraWith('sec-emp', 100, 1, ACCOUNT_ROLES.K401) }));
    assert.equal(r.disallowedLong, 0);
  });

  test('a taxable brokerage does not either — that is §1091(d), and it is §8.1j', () => {
    const r = resolve(stateWith({ pending: [entry()], account: iraWith('sec-emp', 100, 1, ACCOUNT_ROLES.US_STOCK) }));
    assert.equal(r.disallowedLong, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
// §8.1l — FILING as an event distinct from the tax year ENDING.
//
// The 31-December settle cannot see whether a 31-December sale was a wash; the window closes
// on 30 January. So the settle SCHEDULES an April filing when a window is open, and the
// filing recomputes the return with the answer it can now see.
// ─────────────────────────────────────────────────────────────────────────────────────

describe('the settle schedules the filing — lazily (§8.1l/§8.1m)', () => {
  const settleState = (pending) => ({
    usPersonHousehold: true,
    currentPeriods: { US: { startMs: Date.UTC(2032, 0, 1) } },
    people: { primary: { residency: 'US' } },
    ...(pending ? { washPendingLosses: pending } : {}),
  });

  const scheduled = (state) => {
    const seen = [];
    new UsTaxSettleHandler().call({ sim: { schedule: e => seen.push(e) }, state });
    return seen;
  };

  test('a pending window schedules ONE filing, on 15 April of the following year', () => {
    const [evt] = scheduled(settleState([entry()]));
    assert.equal(evt.type, 'TAX_FILE_US');
    assert.equal(evt.date.toISOString().slice(0, 10), '2033-04-15');
    assert.ok(evt.date.getTime() - Date.UTC(2032, 11, 31) > 30 * DAY,
      'and comfortably after the last window a 2032 sale can open');
  });

  test('NO pending window schedules nothing at all', () => {
    // The whole reason there is no standing EventSeries (§8.1m): the queue orders by
    // `date || order` with no final tie-break, so a permanent annual node re-resolves ties
    // among unrelated same-date events. Measured at 560 moved fields across the goldens.
    assert.deepEqual(scheduled(settleState(null)), []);
  });
});

describe('the filing amends the return (§8.1l)', () => {
  const SNAP = {
    currentPeriods: { US: { startMs: Date.UTC(2032, 0, 1) } },
    usOrdinaryIncomeYTD: 200_000,
    usCapitalGainsYTD:  -5_000,
    usShortTermCapitalGainsYTD: 0,
  };
  const filedState = (over = {}) => ({
    securities: REGISTRY,
    usPersonHousehold: true,
    people: { primary: { residency: 'US' } },
    currentPeriods: { US: { startMs: Date.UTC(2033, 0, 1) } },   // the run has moved on
    usPendingReturn: SNAP,
    washPendingLosses: [entry()],
    iraAccount: iraWith('sec-emp', 100, 1),
    ...over,
  });

  const file = (st) => new UsTaxFileHandler().call({ state: st })[0];

  test('it recomputes the FILED year, not the current one', () => {
    // `computeUsTax` picks its rate module from `currentPeriods.US`, which the 1-January
    // advance has already moved. Without the snapshot carrying the filed period, a 2032
    // return would be recomputed against 2033's brackets.
    const action = file(filedState());
    assert.equal(action.taxYear, 2032);
  });

  test('the disallowance produces a positive balance due', () => {
    const action = file(filedState());
    assert.equal(action.disallowed, 5_000);
    assert.ok(action.delta > 0, `removing a $5,000 loss must raise the liability, got ${action.delta}`);
  });

  test('no wash ⇒ it still files, with a zero delta and no payment', () => {
    // The snapshot has to be retired either way, or next April re-files the same year.
    const action = file(filedState({ iraAccount: iraWith('sec-alt', 100, 1) }));
    assert.equal(action.disallowed, 0);
    assert.equal(action.delta, 0);
  });

  test('no snapshot ⇒ no filing event at all', () => {
    assert.deepEqual(new UsTaxFileHandler().call({ state: { securities: REGISTRY } }), []);
  });

  test('the apply reducer retires the snapshot and banks the ledger', () => {
    const st     = filedState();
    const action = file(st);
    const next   = new UsTaxFileApplyReducer().reduce(st, action);
    assert.ok(!('usPendingReturn' in next), 'retired, or next April re-files the same year');
    assert.ok(!('washPendingLosses' in next), 'the entry is resolved and gone');
    assert.equal(next.washSaleLedger.length, 1);
    assert.equal(next.washSaleLedger[0].filedYear, 2032);
  });

  test('a later year\'s entry survives the filing', () => {
    const later = entry({ ms: Date.UTC(2033, 5, 1) });
    const st    = filedState({ washPendingLosses: [entry(), later] });
    const next  = new UsTaxFileApplyReducer().reduce(st, file(st));
    assert.deepEqual(next.washPendingLosses, [later]);
  });

  test('the balance due is chained as a payment', () => {
    const st   = filedState();
    const out  = new UsTaxFileApplyReducer().reduce(st, file(st));
    const [pay] = out.next ?? [];
    assert.equal(pay?.type, 'US_TAX_PAYMENT_DEBIT');
    assert.ok(pay.amount > 0);
  });

  test('a zero delta chains no payment', () => {
    const st  = filedState({ iraAccount: iraWith('sec-alt', 100, 1) });
    const out = new UsTaxFileApplyReducer().reduce(st, file(st));
    assert.deepEqual(out.next ?? [], []);
  });
});

describe('the harvester writes the pending entry (§8.1i)', () => {
  const harvestState = (securityId) => ({
    securities: REGISTRY,
    usStockAccount: { balance: 10_000, holdings: [
      { id: 'sold', securityId, allocation: 'EQUITY', rateKey: RATE_KEYS.EQUITY_US,
        units: 100, pricePerUnit: 100, marketValue: 10_000, costBasis: 15_000,
        purchaseDate: new Date(Date.UTC(2027, 0, 1)) },
      { id: 'sub', securityId: 'sec-alt', allocation: 'EQUITY', rateKey: RATE_KEYS.EQUITY_US,
        units: 10, pricePerUnit: 100, marketValue: 1_000, costBasis: 1_000,
        purchaseDate: new Date(Date.UTC(2027, 0, 1)) },
    ] },
  });

  const harvest = (st) => new StockHarvestApplyReducer().reduce(st, {
    type: 'STOCK_HARVEST_APPLY', stateKey: 'usStockAccount', sellAmount: 10_000,
    sourceHoldingId: 'sold', substituteHoldingId: 'sub', purpose: 'LOSS', residency: 'US',
  }, new Date(SALE));

  test('a realised LOSS opens an entry carrying the units and the character', () => {
    const next = harvest(harvestState('sec-emp'));
    const [e]  = (next.state ?? next).washPendingLosses;
    assert.equal(e.group, 'sec-emp');
    assert.equal(e.units, 100, 'the SHARE count, because §1091(b) matches shares');
    assert.equal(e.longLoss, 5_000, 'held since 2027 ⇒ long-term');
    assert.equal(e.shortLoss, 0);
  });

  test('an un-securitised lot opens NO entry — it can never be matched', () => {
    // §8.1c: a lot naming no instrument makes no identity claim. An entry for it would sit
    // in the ledger forever, matching nothing and never retiring.
    const st = harvestState(null);
    st.usStockAccount.holdings[0].securityId = undefined;
    const next = harvest(st);
    assert.equal((next.state ?? next).washPendingLosses, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
// design 94 §8.1j, step 7b — the IMMEDIATE wash, where both lots are in hand.
//
// The harvester sells and rebuys in one action, one account, one day. When the replacement
// is in the sold lot's own identity group that is a wash sale, and it is the only one in
// this engine that needs no ledger, no window scan and no lag. It is also the dominant one:
// in an un-securitised book every equity lot shares a market synthetic, so `resolveSubstitute`
// falls through to an identical partner and every harvest lands here.
//
// All THREE consequences apply on this branch, unlike the IRA case:
//   §1091(a) disallow  ·  §1091(d) basis transfer  ·  §1223(3) holding-period tack-on
// ─────────────────────────────────────────────────────────────────────────────────────

describe('the immediate wash — §1091(a)/(d) + §1223(3) (§8.1j)', () => {
  const OLD  = new Date(Date.UTC(2027, 0, 1));   // held > 1 year ⇒ long-term
  const SELL = new Date(Date.UTC(2032, 11, 31));

  /** A taxable brokerage: an underwater lot plus a same-group partner to rebuy into. */
  const book = ({ soldSec = 'sec-emp', subSec = 'sec-emp', subUnits = 10 } = {}) => ({
    securities: REGISTRY,
    usStockAccount: { role: ACCOUNT_ROLES.US_STOCK, balance: 11_000, holdings: [
      { id: 'sold', securityId: soldSec, allocation: 'EQUITY', rateKey: RATE_KEYS.EQUITY_US,
        units: 100, pricePerUnit: 100, marketValue: 10_000, costBasis: 15_000, purchaseDate: OLD },
      { id: 'sub', securityId: subSec, allocation: 'EQUITY', rateKey: RATE_KEYS.EQUITY_US,
        units: subUnits, pricePerUnit: 100, marketValue: subUnits * 100, costBasis: subUnits * 100,
        purchaseDate: OLD },
    ] },
  });

  const harvest = (st, sellAmount = 10_000) => {
    const out = new StockHarvestApplyReducer().reduce(st, {
      type: 'STOCK_HARVEST_APPLY', stateKey: 'usStockAccount', sellAmount,
      sourceHoldingId: 'sold', substituteHoldingId: 'sub', purpose: 'LOSS', residency: 'US',
    }, SELL);
    const next = out.state ?? out;
    return { next, tax: (out.next ?? [])[0], lot: (id) => next.usStockAccount.holdings.find(h => h.id === id) };
  };

  test('§1091(a): a same-group rebuy DISALLOWS the loss on the US return', () => {
    // 100 shares sold at a $5,000 loss, 100 shares of the same security bought the same day.
    // Fully matched ⇒ the whole loss is disallowed and the return shows nothing.
    const { tax } = harvest(book());
    assert.equal(tax.gain, 0);
    assert.equal(tax.usLongTermGain, 0);
  });

  test('§1091(d): and it is NOT destroyed — it lands in the replacement\'s basis', () => {
    // The difference between this branch and the IRA one, and the reason R2 called it
    // timing rather than money: the loss is recovered on the eventual sale.
    const { lot } = harvest(book());
    // $1,000 of pre-existing basis + $10,000 of new money + the $5,000 disallowed loss.
    assert.equal(lot('sub').costBasis, 16_000);
  });

  test('AU is untouched — there is no §1091 in Australia (§8.1d)', () => {
    // TR 2008/1's answer is a Part IVA cancellation: a different mechanism with a different
    // consequence. Stamping the US rule on the AU figure would be the wrong rule in the
    // wrong country, and it is the kind of thing that passes every total-based test.
    const { tax } = harvest(book());
    assert.equal(tax.auGain, -5_000, 'the AU assessment still sees the full loss');
    assert.equal(tax.auLongTermGain, -5_000);
  });

  test('§1091(b): a PARTIAL replacement disallows only the matched share', () => {
    // 100 sold, 25 bought (the substitute lot's price means $10,000 buys 100 — so shrink the
    // sale instead: 25 shares sold, 100 bought ⇒ fully matched. The complementary case is
    // below.) Here: sell 25 shares' worth, buy 25 ⇒ the whole (smaller) loss goes.
    const { tax } = harvest(book(), 2_500);
    assert.equal(tax.gain, 0);
  });

  test('a DIFFERENT security is not a wash at all — the loss stands in full', () => {
    // What 7a.1's substitute preference buys: rotate into something legally distinct and
    // there is nothing to disallow. Avoiding the wash beats pricing it.
    const { tax, lot } = harvest(book({ subSec: 'sec-alt' }));
    assert.equal(tax.gain, -5_000);
    assert.equal(lot('sub').costBasis, 11_000, 'no basis uplift, because no disallowance');
  });

  test('a GAIN harvest is untouched — §1091 is a rule about losses', () => {
    const st = book();
    st.usStockAccount.holdings[0].costBasis = 4_000;      // now a $6,000 gain
    const { tax, lot } = harvest(st);
    assert.equal(tax.gain, 6_000);
    assert.equal(lot('sub').costBasis, 11_000);
  });

  test('§1223(3): a lot BORN here inherits the sold lot\'s holding period', () => {
    // A wash cannot convert long-term into short-term. The fresh lot is dated today, so
    // without the tack-on its next sale would be short-term — the taxpayer would lose the
    // long-term rate for having been washed, which is the opposite of what §1223(3) says.
    const st = { securities: REGISTRY, usStockAccount: { role: ACCOUNT_ROLES.US_STOCK,
      balance: 10_000, holdings: [
        { id: 'sold', securityId: 'sec-emp', allocation: 'EQUITY', rateKey: RATE_KEYS.EQUITY_US,
          units: 100, pricePerUnit: 100, marketValue: 10_000, costBasis: 15_000, purchaseDate: OLD },
      ] } };
    const out  = new StockHarvestApplyReducer().reduce(st, {
      type: 'STOCK_HARVEST_APPLY', stateKey: 'usStockAccount', sellAmount: 10_000,
      sourceHoldingId: 'sold', substituteSecurityId: 'sec-emp', purpose: 'LOSS', residency: 'US',
    }, SELL);
    const fresh = (out.state ?? out).usStockAccount.holdings[0];
    assert.equal(fresh.securityId, 'sec-emp');
    assert.equal(new Date(fresh.purchaseDate).getTime(), OLD.getTime(),
      'the replacement carries the sold lot\'s acquisition date');
    assert.equal(fresh.costBasis, 15_000, '$10,000 of new money + the $5,000 disallowed loss');
  });

  test('an EXISTING lot keeps its own date — the tack-on is not a rewrite', () => {
    // Its basis includes shares that were never sold; moving its acquisition date would
    // tack the sold lot's holding period onto them too.
    const older = new Date(Date.UTC(2020, 0, 1));
    const st = book();
    st.usStockAccount.holdings[1].purchaseDate = older;
    const { lot } = harvest(st);
    assert.equal(new Date(lot('sub').purchaseDate).getTime(), older.getTime());
  });

  test('the disallowed part does NOT also enter the sheltered ledger (§1.1091-1(e))', () => {
    // Shares that have already disallowed one loss are disregarded when testing another.
    // Fully matched here, so nothing is left pending for the IRA scan to find a year later
    // — without which the same dollars would be disallowed twice.
    const { next } = harvest(book());
    assert.equal(next.washPendingLosses, undefined);
  });

  test('and a PARTIALLY disallowed loss leaves only the remainder pending', () => {
    // 100 shares sold, 40 bought back ⇒ 40% disallowed on the spot, 60% still exposed to a
    // replacement bought elsewhere inside the window.
    const st = book({ subUnits: 10 });
    // Sell only $4,000 of the position so the $10,000 rebuy over-covers... instead: shrink
    // the rebuy by selling less and buying at a higher price.
    st.usStockAccount.holdings[1].pricePerUnit = 250;      // $10,000 buys 40 units
    st.usStockAccount.holdings[1].marketValue  = 2_500;
    st.usStockAccount.holdings[1].units        = 10;
    const { tax, next } = harvest(st);
    assert.ok(Math.abs(tax.gain - -3_000) < 0.01, `40% disallowed ⇒ $3,000 left, got ${tax.gain}`);
    const [pending] = next.washPendingLosses;
    assert.ok(Math.abs(pending.longLoss - 3_000) < 0.01);
    assert.ok(Math.abs(pending.units - 60) < 1e-6, 'and only the 60 unmatched shares stay exposed');
  });
});
