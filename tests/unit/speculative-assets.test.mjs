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
 * speculative-assets.test.mjs — design 88 phase 1 (recognition).
 *
 * EVERY ABSENCE TEST HERE IS PAIRED WITH A CONTROL. "The stake does not appear in
 * net worth" passes just as happily when the asset was never loaded, when the state
 * projection dropped the flag, or when the toolset failed to compile — which is how
 * the offset-yield work spent a session reading a green absence test that was
 * measuring nothing at all. So each exclusion is asserted against an otherwise
 * identical run with `speculative: false`, and the DIFFERENCE is what is pinned.
 *
 * The paired arms are the same scenario the goldens run (see golden-specs.js);
 * `runGolden` is reused rather than re-derived so the arms cannot drift from the
 * fixtures they are explaining.
 */

import { test }   from 'node:test';
import assert     from 'node:assert/strict';

import { runGolden }   from '../helpers/golden-harness.js';
import { specByName }  from '../helpers/golden-specs.js';

import { computeNetWorth, computeNetWorthInclSpeculative }
  from '../../src/finance/derived-metrics/net-worth.js';
import { computeNetLiquidity }        from '../../src/finance/derived-metrics/net-liquidity.js';
import { computeAfterTaxNetWorth, computeAfterTaxNetLiquidity }
  from '../../src/finance/derived-metrics/after-tax.js';
import { buildAllocationCube }        from '../../src/finance/allocation-reporting/allocation-cube.js';
import { CompanyEquity }              from '../../src/finance/assets/company-equity.js';
import { RealProperty }               from '../../src/finance/assets/real-property.js';
import { Collectible }                from '../../src/finance/assets/collectible.js';
import { ScenarioSerializer }         from '../../src/scenarios/scenario-serializer.js';
import { ServiceRegistry }            from '../../src/services/service-registry.js';

const SIM_END = new Date(Date.UTC(2032, 0, 1));
const round2  = n => +n.toFixed(2);

/**
 * Run the design-88 golden scenario with the stake flagged / unflagged. The
 * unflagged arm is the CONTROL: it is the pre-88 behaviour, and every exclusion
 * assertion below is a difference against it.
 */
function arm(name, { speculative, saleYear = null }) {
  const spec = {
    name,
    simStart:  new Date(Date.UTC(2026, 0, 1)),
    simEnd:    SIM_END,
    ...(saleYear != null ? { params: { companySaleYear: saleYear } } : {}),
    mutateCfg: cfg => { cfg.companyEquities[0].speculative = speculative; },
  };
  return runGolden(spec);
}

// Each `runGolden` resets the ServiceRegistry, so the arms are built up-front and
// sequentially; the returned states are plain objects and outlive the reset.
const flagged   = arm('spec88-flagged',   { speculative: true  });
const control   = arm('spec88-control',   { speculative: false });
const converted = arm('spec88-converted', { speculative: true, saleYear: 2029 });

const STAKE_KEY = 'companyEquityAccount';

// ── The flag reaches STATE at all (design 88 §7 trap 2) ─────────────────────
// First, because every assertion below is meaningless if the projection dropped it
// — and a dropped projection fails NOTHING else here: it reads as "not speculative",
// which is exactly the status quo.

test('88: the flag survives the config → state projection', () => {
  assert.equal(flagged.state[STAKE_KEY].speculative, true,
    'speculative never reached state — the metrics read STATE, not the config record');
  assert.ok(!('speculative' in control.state[STAKE_KEY]),
    'the unflagged arm must not gain the key at all (D2 byte-identity)');
});

test('88: a speculative asset still appreciates — the flag suppresses value, not mechanics', () => {
  assert.ok(flagged.state[STAKE_KEY].value > 500_000,
    'the stake stopped compounding; the flag is suppressing the MECHANICS, not the carrying value');
  assert.equal(flagged.state[STAKE_KEY].value, control.state[STAKE_KEY].value,
    'flagged and unflagged stakes must follow the identical value path');
});

// ── Recognition (D5) ─────────────────────────────────────────────────────────

test('88: netWorth excludes the stake by exactly its value — CONTROL: the unflagged arm includes it', () => {
  const stake = flagged.state[STAKE_KEY].value;
  const nwFlagged = computeNetWorth(flagged.state, 'USD');
  const nwControl = computeNetWorth(control.state, 'USD');

  assert.equal(round2(nwControl - nwFlagged), round2(stake),
    'the two arms must differ by exactly the stake, and by nothing else');
  // The control half: without this, a run that silently loaded no company equity
  // at all would satisfy the exclusion assertion above.
  assert.ok(nwControl > nwFlagged, 'CONTROL FAILED: the unflagged arm does not recognise the stake');
});

test('88 D7: netWorthInclSpeculative discloses exactly what netWorth withholds', () => {
  const stake = flagged.state[STAKE_KEY].value;
  const worth = computeNetWorth(flagged.state, 'USD');
  const incl  = computeNetWorthInclSpeculative(flagged.state, 'USD');

  assert.equal(round2(incl - worth), round2(stake));
  // …and the disclosure figure equals what the whole plan was worth before the flag.
  assert.equal(round2(incl), round2(computeNetWorth(control.state, 'USD')));
  // On a plan with nothing flagged the two functions are the same number.
  assert.equal(computeNetWorthInclSpeculative(control.state, 'USD'),
               computeNetWorth(control.state, 'USD'));
});

test('88: deriveNetWorth publishes the second metric only when something is flagged', () => {
  assert.equal(flagged.state.metrics.netWorthInclSpeculative,
               round2(computeNetWorthInclSpeculative(flagged.state, 'USD')));
  assert.ok(!('netWorthInclSpeculative' in control.state.metrics),
    'an unflagged plan must publish ONE honest number, not two identical ones');
});

// ── The control scope must NOT move (design 88 §5, verification item 6) ──────

test('88 §5: net liquidity is identical in both arms — CONTROL: net worth is not', () => {
  assert.equal(computeNetLiquidity(flagged.state, SIM_END, 'USD'),
               computeNetLiquidity(control.state, SIM_END, 'USD'),
    'the control metric moved: an Asset was never in the lever-reachable pool, '
    + 'so flagging it can change nothing there');
  assert.equal(computeAfterTaxNetLiquidity(flagged.state, SIM_END),
               computeAfterTaxNetLiquidity(control.state, SIM_END));

  // The working detector: if the two arms were identical for some unrelated reason
  // (same state object, a no-op mutateCfg, a dead toolset), this fails too.
  assert.notEqual(computeNetWorth(flagged.state, 'USD'),
                  computeNetWorth(control.state, 'USD'),
    'CONTROL FAILED: the two arms are indistinguishable, so the equalities above prove nothing');
});

// ── After-tax (D5 / the §4.12 bug) ──────────────────────────────────────────

test('88 D5: afterTaxNetWorth now counts a NON-speculative stake, and excludes a flagged one', () => {
  const atFlagged = computeAfterTaxNetWorth(flagged.state, SIM_END);
  const atControl = computeAfterTaxNetWorth(control.state, SIM_END);
  const stake     = flagged.state[STAKE_KEY].value;

  // The control that catches D5 being half-done: before design 88, `_sumAfterTax`
  // had no `company` branch at all, so this delta was ZERO and after-tax worth
  // disagreed with net worth by the stake's entire carrying value.
  assert.equal(round2(atControl - atFlagged), round2(stake),
    'after-tax net worth does not see company equity — the design/inconsistencies §4.12 bug');
  assert.ok(atControl > 0);
});

test('88 D5: after-tax and pre-tax worth agree about WHICH assets exist', () => {
  // They must not "hold different opinions about what a dollar is" — the flagged
  // stake is absent from both, the unflagged stake present in both.
  const inclusionDeltaPreTax  = computeNetWorth(control.state, 'USD')
                              - computeNetWorth(flagged.state, 'USD');
  const inclusionDeltaAfterTax = computeAfterTaxNetWorth(control.state, SIM_END)
                              - computeAfterTaxNetWorth(flagged.state, SIM_END);
  assert.equal(round2(inclusionDeltaPreTax), round2(inclusionDeltaAfterTax));
});

// ── The cube: one invariant becomes two (design 88 §6) ──────────────────────

test('88 §6: Σ cube rows === netWorthInclSpeculative (disclosure)', () => {
  const rows  = buildAllocationCube(flagged.state, { baseCurrency: 'USD' });
  const total = round2(rows.reduce((s, r) => s + r.marketValue, 0));
  assert.equal(total, round2(computeNetWorthInclSpeculative(flagged.state, 'USD')));
});

test('88 §6: Σ cube rows where !speculative === netWorth (recognition)', () => {
  const rows  = buildAllocationCube(flagged.state, { baseCurrency: 'USD' });
  const total = round2(rows.filter(r => !r.speculative)
                           .reduce((s, r) => s + r.marketValue, 0));
  assert.equal(total, round2(computeNetWorth(flagged.state, 'USD')));

  // D6: the row is KEPT, not dropped — the cube is the disclosure half, and a
  // position invisible in the one view whose job is showing where the money is
  // would be the worst of both designs.
  const stakeRow = rows.find(r => r.stateKey === STAKE_KEY);
  assert.ok(stakeRow, 'the speculative stake lost its cube row');
  assert.equal(stakeRow.speculative, true);
  assert.equal(stakeRow.marketValue, round2(flagged.state[STAKE_KEY].value));
});

test('88 §6: every non-asset row carries speculative:false, never undefined', () => {
  const rows = buildAllocationCube(control.state, { baseCurrency: 'USD' });
  assert.ok(rows.length > 0);
  assert.ok(rows.every(r => r.speculative === false),
    'a row with an absent flag would silently pass a `!r.speculative` filter and '
    + 'silently fail a `r.speculative === false` one');
});

test('88 D3: the flag on an ACCOUNT is inert, and does not break the cube invariants', () => {
  // `Account extends Asset`, so accounts inherit the field whether or not it means
  // anything yet (OQ2). An inert flag must stay inert: if the cube honoured it while
  // computeNetWorth (correctly) did not, the recognition invariant would break on a
  // setting that is supposed to do nothing at all.
  const state = structuredClone(control.state);
  const acctKey = Object.keys(state).find(
    k => typeof state[k]?.balance === 'number' && state[k].balance > 0 && state[k].type !== 'loan');
  state[acctKey].speculative = true;

  assert.equal(computeNetWorth(state, 'USD'), computeNetWorth(control.state, 'USD'),
    'flagging an account changed net worth — accounts are out of scope for phase 1');

  const rows  = buildAllocationCube(state, { baseCurrency: 'USD' });
  const recognised = round2(rows.filter(r => !r.speculative)
                                .reduce((s, r) => s + r.marketValue, 0));
  assert.equal(recognised, round2(computeNetWorth(state, 'USD')));
});

// ── Conversion: recognition switches on when the asset becomes cash (§2) ────

test('88 §2: a speculative stake still SELLS, and its proceeds are recognised in full', () => {
  assert.equal(converted.state[STAKE_KEY].value, 0, 'the stake never sold');
  const worth = computeNetWorth(converted.state, 'USD');
  const incl  = computeNetWorthInclSpeculative(converted.state, 'USD');

  // Post-sale the two measures converge: there is no unrecognised carrying value
  // left, only proceeds sitting in an ordinary account.
  assert.equal(worth, incl);
  assert.equal(converted.state.metrics.netWorthInclSpeculative,
               converted.state.metrics.netWorth,
    'the disclosure metric went stale instead of following the sale');

  // Recognition switched ON: the converted plan is worth materially more than the
  // never-sold plan, by roughly the after-tax proceeds.
  assert.ok(worth > computeNetWorth(flagged.state, 'USD'),
    'the sale added nothing to recognised worth — proceeds were not recognised');
});

test('88 D2 CONTROL: the sale is taxed normally — a speculative asset is not tax-free', () => {
  // If "speculative" had been implemented as "skip the mechanics", the stake would
  // have vanished or sold without a CGT bill. It is the same COMPANY_SALE →
  // COMPANY_SALE_TAX path as any other stake.
  assert.ok(converted.state.cumulativeTaxesPaid > flagged.state.cumulativeTaxesPaid,
    'selling the flagged stake assessed no additional tax');
});

// ── D4: the flag and drawdown eligibility are contradictory ─────────────────

test('88 D4: speculative + a non-null drawdownPriority is rejected at construction', () => {
  assert.throws(
    () => new CompanyEquity(100, { name: 'Startup', speculative: true, drawdownPriority: 1 }),
    /speculative/i);
  assert.throws(
    () => new RealProperty(100, { name: 'Lot', speculative: true, drawdownPriority: 2 }),
    /drawdownPriority/);
  assert.throws(
    () => new Collectible(100, { name: 'Art', speculative: true, drawdownPriority: 3 }),
    /design 88 D4/);

  // Either half alone is fine — the rule is about the PAIR.
  assert.doesNotThrow(() => new CompanyEquity(100, { speculative: true }));
  assert.doesNotThrow(() => new CompanyEquity(100, { drawdownPriority: 1 }));
});

test('88 D4: the pair is rejected on the UPDATE path too, not only at construction', () => {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  const eq = services.companyEquityService.createCompanyEquity(
    new CompanyEquity(100, { name: 'Startup', speculative: true }));

  assert.throws(
    () => services.companyEquityService.updateCompanyEquity(eq, { drawdownPriority: 1 }),
    /speculative/i,
    'the editor could still create the contradictory pair after construction');
});

// ── Round-trip (design 88 §7 trap 1) ────────────────────────────────────────

test('88: the flag round-trips through serialize → deserialize on all three kinds', () => {
  const eq   = new CompanyEquity(500, { id: 'com1', name: 'Startup', speculative: true });
  const prop = new RealProperty(900, { id: 'p1',   name: 'Lot',     speculative: true });
  const col  = new Collectible(100,   { id: 'c1',  name: 'Art',     speculative: true });

  const eqD   = ScenarioSerializer._serializeCompanyEquity(eq);
  const propD = ScenarioSerializer._serializeRealProperty(prop);
  const colD  = ScenarioSerializer._serializeCollectible(col);

  assert.equal(eqD.speculative, true);
  assert.equal(propD.speculative, true);
  assert.equal(colD.speculative, true);

  assert.equal(ScenarioSerializer._makeCompanyEquity(eqD).speculative, true,
    'the flag was lost on reload — the same shape as design 72 §3 losing costBaseByCountry');
  assert.equal(ScenarioSerializer._makeRealProperty(propD).speculative, true);
  assert.equal(ScenarioSerializer._makeCollectible(colD).speculative, true);
});

test('88 D2: an unflagged asset emits NO speculative key (byte-for-byte round trip)', () => {
  const eq = new CompanyEquity(500, { id: 'com2', name: 'Startup' });
  const d  = ScenarioSerializer._serializeCompanyEquity(eq);
  assert.ok(!('speculative' in d),
    'a pre-88 scenario must re-serialize unchanged');
  assert.equal(ScenarioSerializer._makeCompanyEquity(d).speculative, false);

  const p = ScenarioSerializer._serializeRealProperty(new RealProperty(1, { id: 'p2' }));
  assert.ok(!('speculative' in p));
  const c = ScenarioSerializer._serializeCollectible(new Collectible(1, { id: 'c2' }));
  assert.ok(!('speculative' in c));
});
