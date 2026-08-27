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
 * wash-sale-substitute.test.mjs — design 94 step 7a, §8.1h.
 *
 * R2 (§8.1f) measured the tax-loss harvester constructing §1091's disallowed fact pattern
 * every time it acted, and then measured why it barely mattered: the strategy could hardly
 * act at all. Two artefacts, both fixed here, plus the identity relation that lets the model
 * AVOID the wash rather than learn to price it.
 *
 *   1. `taxLossHarvestCap` defaulted to \$3,000 — §1211(b)'s ORDINARY-income deduction
 *      limit, applied a second time and in the wrong place. The return already enforces it,
 *      with the §1212(b) carryforward, in `_computeCapitalLossLimitation`.
 *   2. `resolveSubstitute` could only offer a lot the account ALREADY held, so after one
 *      full harvest the sleeve held a single lot, a single lot has no partner, and every
 *      later harvest was skipped — silently, via a `console.warn`.
 *   3. The partner it picked shared the sold lot's `rateKey`, which is the same market in
 *      the model's own terms. Now it prefers a different §1091 identity group, and can open
 *      a fresh position in a SECURITY the account does not yet hold.
 *
 * (2) and (1) interact, which is why they are fixed together and tested together: removing
 * the cap ALONE makes the strategy worse, because an uncapped harvest consumes the whole
 * underwater lot in one go and the account is left with nothing to rotate into. The cap was
 * propping the harvester up by never letting it finish a sale.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { TaxLossHarvestHandler }  from '../../src/finance/behavioral/tax-loss-harvest-handler.js';
import { StockHarvestApplyReducer } from '../../src/finance/behavioral/stock-harvest-apply-reducer.js';
import { resolveSubstitute, resolveSubstituteSecurity } from '../../src/finance/behavioral/substitute-holding.js';
import { buildSecurityRegistry, syntheticEquitySecurities, identityGroupOf } from '../../src/finance/holdings/security.js';
import { RATE_KEYS } from '../../src/finance/economic-regimes/rate-keys.js';

const US = RATE_KEYS.EQUITY_US;

const lot = (id, securityId, mv, basis) => ({
  id, securityId, allocation: 'EQUITY', rateKey: US,
  marketValue: mv, costBasis: basis, units: mv / 100, pricePerUnit: 100,
  purchaseDate: new Date(Date.UTC(2026, 0, 1)),
});

const REGISTRY = buildSecurityRegistry([
  ...syntheticEquitySecurities(),
  { id: 'sec-emp', rateKey: US },
  { id: 'sec-alt', rateKey: US },
  // Two share classes of one thing: the case §8.1c says can only be DECLARED.
  { id: 'sec-emp-b', rateKey: US, identityGroup: 'grp-emp' },
  { id: 'sec-emp-a', rateKey: US, identityGroup: 'grp-emp' },
]);

describe('identity is declared, not derived (§8.1c)', () => {
  test('a security is substantially identical to itself, by default', () => {
    assert.equal(identityGroupOf({ securityId: 'sec-emp' }, REGISTRY), 'sec-emp');
  });

  test('a declared group overrides the default', () => {
    assert.equal(identityGroupOf({ securityId: 'sec-emp-a' }, REGISTRY), 'grp-emp');
    assert.equal(identityGroupOf({ securityId: 'sec-emp-b' }, REGISTRY), 'grp-emp');
  });

  test('an un-securitised lot has NO identity — it matches nothing', () => {
    // Not "its rateKey". A lot that names no instrument makes no claim about identity, and
    // §8.1c is explicit that deriving one from the rate key is the same assumption
    // unlabelled — which is precisely the assumption the old substitute rule made.
    assert.equal(identityGroupOf({ rateKey: US }, REGISTRY), null);
  });
});

describe('resolveSubstitute prefers a legally distinct partner (§8.1h)', () => {
  test('a different identity group wins over an identical one', () => {
    const holdings = [
      lot('sold', 'sec-emp', 1000, 1500),
      lot('same', 'sec-emp', 1000, 1000),   // same security ⇒ a wash
      lot('other', 'sec-alt', 1000, 1000),  // distinct ⇒ a legal harvest
    ];
    assert.equal(resolveSubstitute(holdings, holdings[0], REGISTRY), 'other');
  });

  test('two share classes of one issuer are NOT distinct when declared so', () => {
    const holdings = [lot('sold', 'sec-emp-a', 1000, 1500), lot('b', 'sec-emp-b', 1000, 1000)];
    assert.equal(resolveSubstitute(holdings, holdings[0], REGISTRY, { requireDistinct: true }), null);
  });

  test('an un-securitised book behaves exactly as it did', () => {
    // Step 3 of the algorithm. No securities in hand ⇒ no identity to compare ⇒ the first
    // same-rateKey partner, which is what the rule has always returned.
    const holdings = [lot('sold', null, 1000, 1500), lot('partner', null, 1000, 1000)];
    assert.equal(resolveSubstitute(holdings, holdings[0], null), 'partner');
  });

  test('an explicit taxLossPartner still wins over everything', () => {
    const holdings = [
      { ...lot('sold', 'sec-emp', 1000, 1500), taxLossPartner: 'same' },
      lot('same', 'sec-emp', 1000, 1000),
      lot('other', 'sec-alt', 1000, 1000),
    ];
    assert.equal(resolveSubstitute(holdings, holdings[0], REGISTRY), 'same');
  });
});

describe('a substitute the account does not hold yet (§8.1h)', () => {
  test('resolves a SECURITY in the same market and a different group', () => {
    const sold = lot('sold', 'sec-emp', 1000, 1500);
    assert.equal(resolveSubstituteSecurity(sold, REGISTRY), 'sec-alt');
  });

  test('never the sold lot\'s own group', () => {
    const sold = lot('sold', 'sec-emp-a', 1000, 1500);
    const got  = resolveSubstituteSecurity(sold, REGISTRY);
    assert.notEqual(got, 'sec-emp-b', 'a declared share-class sibling is not a substitute');
  });

  test('null for an un-securitised lot, and for an empty registry', () => {
    assert.equal(resolveSubstituteSecurity(lot('sold', null, 1000, 1500), REGISTRY), null);
    assert.equal(resolveSubstituteSecurity(lot('sold', 'sec-emp', 1000, 1500), null), null);
  });

  test('the harvester reaches for it when the account holds no distinct lot', () => {
    // The one-shot defect, in miniature: ONE underwater lot, nothing to rotate into among
    // the holdings. Before §8.1h this was a skip; now it is a rotation into the registry.
    const state = {
      securities: REGISTRY,
      usStockAccount: { balance: 1000, holdings: [lot('sold', 'sec-emp', 1000, 1500)] },
      people: { primary: { residency: 'US' } },
    };
    const actions = new TaxLossHarvestHandler({ taxableStateKeys: ['usStockAccount'] }).call({ state });
    const harvest = actions.find(a => a.type === 'STOCK_HARVEST_APPLY');
    assert.ok(harvest, 'the harvest must no longer be skipped');
    assert.equal(harvest.substituteHoldingId, null, 'no existing lot was suitable');
    assert.equal(harvest.substituteSecurityId, 'sec-alt');
  });

  test('and the reducer OPENS that position', () => {
    const state = {
      securities: REGISTRY,
      usStockAccount: { balance: 1000, holdings: [lot('sold', 'sec-emp', 1000, 1500)] },
    };
    const next = new StockHarvestApplyReducer().reduce(state, {
      type: 'STOCK_HARVEST_APPLY', stateKey: 'usStockAccount', sellAmount: 1000,
      sourceHoldingId: 'sold', substituteSecurityId: 'sec-alt', purpose: 'LOSS', residency: 'US',
    }, new Date(Date.UTC(2030, 11, 31)));

    const holdings = (next.state ?? next).usStockAccount.holdings;
    assert.equal(holdings.length, 1, 'the sold lot is gone and one fresh lot replaces it');
    const fresh = holdings[0];
    assert.equal(fresh.securityId, 'sec-alt');
    assert.equal(fresh.marketValue, 1000);
    assert.equal(fresh.costBasis, 1000, 'a fresh buy is at basis = market');
    assert.ok(fresh.units > 0, 'and it is a POSITION — units, not a scalar (§9.4)');
    assert.equal(new Date(fresh.purchaseDate).getUTCFullYear(), 2030,
      'dated today, so its holding period starts now rather than inheriting the sold lot\'s');
  });
});

describe('the cap is a policy lever, not the statute (§8.1h)', () => {
  const state = () => ({
    securities: REGISTRY,
    usStockAccount: { balance: 50_000, holdings: [
      lot('sold', 'sec-emp', 50_000, 70_000),   // a $20,000 loss
      lot('other', 'sec-alt', 10_000, 10_000),
    ] },
    people: { primary: { residency: 'US' } },
  });

  test('uncapped by default — the whole loss is harvested', () => {
    // §1211(b)'s $3,000 is the ORDINARY-income deduction limit and the return applies it,
    // with the §1212(b) carryforward, in `_computeCapitalLossLimitation`. Capping the
    // HARVEST at the same figure limited the same loss twice, and the carryforward — most
    // of what the strategy is for — could never accumulate.
    const [harvest] = new TaxLossHarvestHandler({ taxableStateKeys: ['usStockAccount'] }).call({ state: state() });
    assert.equal(harvest.sellAmount, 50_000, 'the full position, for the full $20,000 loss');
  });

  test('an explicit cap still binds', () => {
    const [harvest] = new TaxLossHarvestHandler({
      taxableStateKeys: ['usStockAccount'], taxLossHarvestCap: 3000,
    }).call({ state: state() });
    assert.ok(harvest.sellAmount < 50_000, 'a policy cap partially harvests, as before');
  });
});
