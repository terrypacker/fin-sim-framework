/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * evt-downsizer-contribution.test.mjs — ITAA97 s292-102.
 *
 * The lever that makes an Australian downsize worth more than the equity it releases:
 * up to A$300,000 per person, from the sale of a main residence held ten years or more,
 * into super, outside the caps.
 *
 * The assertion that matters most is **DOWN-4**: eligibility requires the dwelling to
 * have qualified at least partly for the main-residence exemption, so a rental that was
 * never lived in produces nothing. That makes the downsizer entitlement and design 83
 * G7's `mainResidenceFrom` the SAME lever — moving in before selling buys a slice of
 * s118-185 and the whole downsizer capacity together, and the second is frequently
 * larger. A model that granted the contribution unconditionally would hide precisely
 * the interaction that decides whether moving in is worth doing.
 *
 * ⚠ The thresholds here (age 55, A$300,000, ten years) are transcribed from secondary
 * knowledge, NOT from an ATO publication on disk. Verify before relying on a result
 * that turns on them.
 *
 * Run with: node --test tests/unit/evt-downsizer-contribution.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { downsizerContributions, DOWNSIZER_CAP_AUD, DOWNSIZER_MIN_AGE }
  from '../../src/finance/account-rules/au/downsizer-contribution.js';

const Y = (y, m = 0, d = 1) => Date.UTC(y, m, d);
const ACQ = Y(2006), SALE = Y(2035);

const prop = (over = {}) => ({ country: 'AU', claimDownsizerContribution: true, ...over });
const owner = (personKey, birthYear) => ({ personKey, birthDate: `${birthYear}-01-01`, fraction: 0.5 });

const call = (over = {}) => downsizerContributions({
  prop: prop(), proceeds: 1_200_000, exemptFraction: 0.1,
  acquisitionMs: ACQ, saleMs: SALE,
  owners: [owner('primary', 1975), owner('spouse', 1977)],
  ...over,
});

describe('s292-102 eligibility', () => {
  test('DOWN-1: two eligible owners each get the cap', () => {
    const r = call();
    assert.equal(r.total, 2 * DOWNSIZER_CAP_AUD);
    assert.deepEqual(r.contributions.map(c => c.personKey), ['primary', 'spouse']);
    assert.equal(r.reason, 'eligible');
  });

  test('DOWN-2: opting out is the default — nothing happens unless claimed', () => {
    const r = call({ prop: prop({ claimDownsizerContribution: false }) });
    assert.equal(r.total, 0);
    assert.equal(r.reason, 'not-claimed');
  });

  test('DOWN-3: under 55 at the sale date is ineligible', () => {
    // Age is tested at the CONTRIBUTION, which this model collapses to the sale date.
    const young = call({ owners: [owner('primary', 2005), owner('spouse', 2006)] });
    assert.equal(young.total, 0);
    assert.equal(young.reason, 'nobody-meets-the-age-test');

    // …and one of two qualifying gets one cap, not two.
    const mixed = call({ owners: [owner('primary', 1975), owner('spouse', 2005)] });
    assert.equal(mixed.total, DOWNSIZER_CAP_AUD);
    assert.equal(mixed.contributions.length, 1);
    assert.equal(mixed.contributions[0].personKey, 'primary');
  });

  test('DOWN-4: no main-residence exemption ⇒ no downsizer contribution', () => {
    // s292-102(1)(b), and the coupling this suite exists to state: the dwelling must
    // have qualified AT LEAST PARTLY for the main-residence exemption. A property
    // rented for its whole life qualifies for none, so it funds no contribution — and
    // the decision to move in before selling therefore buys the s118-185 fraction AND
    // the entire A$600,000 of super capacity at once.
    const never = call({ exemptFraction: 0 });
    assert.equal(never.total, 0);
    assert.equal(never.reason, 'no-main-residence-exemption');

    // Even a sliver of exemption opens the whole entitlement — "at least partly" is a
    // gate, not a proportion, so the contribution is NOT scaled by the fraction.
    const sliver = call({ exemptFraction: 0.01 });
    assert.equal(sliver.total, 2 * DOWNSIZER_CAP_AUD);
  });

  test('DOWN-5: held under ten years is ineligible', () => {
    const r = call({ acquisitionMs: Y(2030) });
    assert.equal(r.total, 0);
    assert.equal(r.reason, 'held-under-ten-years');
  });

  test('DOWN-6: the couple total is capped at the sale proceeds', () => {
    // s292-102(2): a modest home cannot fund A$600,000 between two people. The second
    // owner takes only what is left, which is the branch a per-person-only cap misses.
    const r = call({ proceeds: 450_000 });
    assert.equal(r.total, 450_000);
    assert.equal(r.contributions[0].amount, DOWNSIZER_CAP_AUD);
    assert.equal(r.contributions[1].amount, 150_000);
  });

  test('DOWN-7: an overseas dwelling is ineligible', () => {
    const r = call({ prop: prop({ country: 'US' }) });
    assert.equal(r.total, 0);
    assert.equal(r.reason, 'not-an-australian-dwelling');
  });

  test('DOWN-8: an unknown acquisition date denies rather than guesses', () => {
    // Same rule as G7's exemption: a missing ownership period cannot be filled in from
    // the simulation start without inventing a hold long enough to qualify.
    const r = call({ acquisitionMs: null });
    assert.equal(r.total, 0);
    assert.equal(r.reason, 'unknown-ownership-period');
  });

  test('DOWN-9: every rejection names its gate', () => {
    // A contribution that silently does not happen looks identical to one the plan
    // never asked for. The reason strings are what make the difference visible.
    const reasons = [
      call({ prop: prop({ claimDownsizerContribution: false }) }),
      call({ exemptFraction: 0 }),
      call({ acquisitionMs: Y(2030) }),
      call({ owners: [] }),
      call({ proceeds: 0 }),
    ].map(r => r.reason);
    assert.equal(new Set(reasons).size, reasons.length, 'each gate reports a distinct reason');
    assert.ok(reasons.every(r => typeof r === 'string' && r.length > 0));
  });

  test('DOWN-10: the age threshold is the statutory one', () => {
    assert.equal(DOWNSIZER_MIN_AGE, 55, 'moved 65 → 60 → 55 across 2018–2023');
    assert.equal(DOWNSIZER_CAP_AUD, 300_000);
  });
});

// ── End to end ───────────────────────────────────────────────────────────────

test('DOWN-11: end to end — selling the AU dwelling moves A$300k into super', async () => {
  const { loadScenarioSim } = await import('../helpers/scenario-harness.js');

  const arm = (claim) => loadScenarioSim({
    params: { moveYear: 2027 },
    simStart: '2026-01-01', simEnd: '2040-01-01',
    mutateCfg: (cfg) => {
      const au = cfg.realProperties.find(p => p.stateKey === 'auHouseProperty');
      au.plannedSaleYear = 2036;                    // primary is 55+ by then
      au.acquisitionDate = Date.UTC(2006, 0, 1);    // a thirty-year hold
      au.mainResidenceFrom = Date.UTC(2028, 0, 1);  // moved in after returning
      au.claimDownsizerContribution = claim;
    },
    stepTo: '2036-06-01',
  }).sim;

  const on  = arm(true);
  const off = arm(false);

  assert.equal(on.journal.getActions('SUPER_DOWNSIZER_CONTRIBUTION_APPLY').length, 1,
    'one eligible owner ⇒ exactly one contribution');
  assert.equal(off.journal.getActions('SUPER_DOWNSIZER_CONTRIBUTION_APPLY').length, 0,
    'and none at all when it is not claimed');

  // The fund receives it IN FULL — no Div 295 15% haircut. That is the whole reason
  // this does not reuse SuperContributionApplyReducer, and a 15% shave would be easy to
  // miss in a balance that also grew.
  const delta = on.state.superAccount.balance - off.state.superAccount.balance;
  assert.ok(delta > 290_000,
    `expected the full A$300k (plus growth) in super, got ${delta.toFixed(0)}`);

  // …and it came out of the AU cash the sale had just credited, not from nowhere.
  assert.ok(on.state.auSavingsAccount.balance < off.state.auSavingsAccount.balance,
    'the contribution is funded from the proceeds');
});
