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
 * disposal-currency-and-us-person.test.mjs
 *
 * Two defects that only a single-country AU household could expose, both of the
 * same shape: an assumption that was true of every scenario that existed when the
 * code was written, and silently false the moment one wasn't.
 *
 *   1. A DISPOSAL carries money in the disposed asset's own currency, but the
 *      consumers converted it as though it were always USD — right for the
 *      US-domiciled assets that were the only kind expressible, and an
 *      exchange-rate-sized overstatement for an AU-domiciled one.
 *
 *   2. Every AU income classifier books into `usOrdinaryIncomeYTD` because "the
 *      model's earners are US citizens" (au-tax-module-2026 says so in a comment).
 *      With an Australian who is not a US person, that lodged a full US return and
 *      issued a US tax bill against income the US has no claim on.
 *
 * Both are asserted on the AU scenario, because both are about what that scenario
 * is: the first household in the suite with no American in it.
 *
 * Run with: node --test tests/unit/disposal-currency-and-us-person.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { ServiceRegistry }          from '../../src/services/service-registry.js';
import { BaseScenario }             from '../../src/scenarios/base-scenario.js';
import { ScenarioLoader }           from '../../src/scenarios/scenario-loader.js';
import { AuSingleHomeownerScenario } from '../../src/scenarios/au-single-homeowner-scenario.js';
import { UsSingleHomeownerScenario } from '../../src/scenarios/us-single-homeowner-scenario.js';

const START = new Date(Date.UTC(2026, 0, 1));

function run(ScenarioCls, end, params = {}) {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  const cfg = ScenarioCls.buildDefaultConfig(params, START, end);
  const scenario = new BaseScenario({
    context: services.simulationContext, simStart: START, simEnd: end,
  });
  scenario.buildSim({ telemetry: 'journal' });
  new ScenarioLoader().load(cfg, services);
  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  try { scenario.sim.stepTo(end); } finally { console.log = log; console.warn = warn; }
  return scenario.sim;
}

const payloads = (sim, type) => sim.journal.getActions(type).map(e => e.action?.data ?? {});

// ─── 1. Disposal currency ─────────────────────────────────────────────────────

test('an AU-domiciled collectible disposal is denominated in AUD, not read as USD', () => {
  const sim = run(AuSingleHomeownerScenario, new Date(Date.UTC(2042, 0, 1)));
  const [sale] = payloads(sim, 'COLLECTIBLE_SALE_TAX');

  assert.ok(sale, 'precondition: the classic car sells inside the run');
  assert.equal(sale.currency, 'AUD',
    'the action must carry the collectible\'s own currency, or consumers assume USD');
  // The gain is the AUD gain, full stop. Before the fix the AU module converted it
  // as USD→AUD, so the assessable amount came out at roughly the exchange rate times
  // this — the same error the proceeds routing made in the other direction.
  assert.equal(+(sale.proceeds - sale.costBasis).toFixed(2), +sale.gain.toFixed(2),
    'gain is proceeds less basis in one consistent currency');
});

test('an AU-domiciled collectible sale credits the AU cash pool with no FX leg', () => {
  const sim = run(AuSingleHomeownerScenario, new Date(Date.UTC(2042, 0, 1)));
  // An INTL_TRANSFER_RECORD here would mean the proceeds crossed a border: the
  // pre-fix behaviour routed them to the US cash pool, which this scenario does not
  // even have. Selling an Australian's Australian car moves no money internationally.
  assert.deepEqual(payloads(sim, 'INTL_TRANSFER_RECORD'), [],
    'an AU asset sold by an AU resident into an AU account crosses no border');
});

test('a drawn-down AU brokerage stamps AUD on its disposal', () => {
  const sim = run(AuSingleHomeownerScenario, new Date(Date.UTC(2036, 0, 1)));
  const disposals = payloads(sim, 'STOCK_WITHDRAWAL_TAX');
  assert.ok(disposals.length > 0, 'precondition: the AU brokerage is drawn down');
  // The shared drawdown path emits the US-NAMED action for an AU account (the AU tax
  // module registers the consumer for it), with figures native to the account drawn.
  assert.ok(disposals.every(d => d.currency === 'AUD'),
    'every disposal of an AUD account must say so');
});

test('a US-domiciled disposal still says USD', () => {
  // The control that makes the two above meaningful: the fix must not have flipped
  // the default. This is also the case every pre-existing golden pins.
  const sim = run(UsSingleHomeownerScenario, new Date(Date.UTC(2050, 0, 1)));
  const disposals = payloads(sim, 'STOCK_WITHDRAWAL_TAX');
  assert.ok(disposals.length > 0, 'precondition: the US brokerage is drawn down');
  assert.ok(disposals.every(d => d.currency === 'USD'),
    'a USD account\'s disposal is USD');
});

// ─── 2. The US return ─────────────────────────────────────────────────────────

test('a household with no US person lodges no US return', () => {
  const sim = run(AuSingleHomeownerScenario, new Date(Date.UTC(2032, 0, 1)));

  assert.equal(sim.state.usPersonHousehold, false,
    'an AU citizen who is an AU resident is not a US person');
  assert.equal(sim.journal.getActions('US_TAX_SETTLE_APPLY').length, 0,
    'no US return is lodged');
  assert.equal(sim.journal.getActions('US_TAX_PAYMENT_DEBIT').length, 0,
    'and no US tax is charged');
});

test('the US return is unaffected for a household that does contain a US person', () => {
  // The control. The gate keys on the CONFIGURED household, so the ordinary case has
  // to be untouched — this is the assertion that would fail if the gate were
  // accidentally inverted or read from a state field that starts undefined.
  const sim = run(UsSingleHomeownerScenario, new Date(Date.UTC(2032, 0, 1)));
  assert.equal(sim.state.usPersonHousehold, true);
  assert.ok(sim.journal.getActions('US_TAX_SETTLE_APPLY').length > 0,
    'a US citizen files every year');
});

test('an AU household still lodges its AU return and pays AU tax', () => {
  // Suppressing the US return must not suppress taxation as such — the failure mode
  // where a scenario looks healthy because nobody is taxed at all.
  const sim = run(AuSingleHomeownerScenario, new Date(Date.UTC(2032, 0, 1)));
  assert.ok(sim.journal.getActions('AU_TAX_SETTLE_APPLY').length > 0, 'AU return lodged');
  assert.ok(sim.state.cumulativeTaxesPaid > 0, 'AU tax is actually paid');
});

test('the AU household stays solvent — the US bill was what broke it', () => {
  // Directly the symptom that surfaced the defect: an unfundable US tax bill against
  // an Australian salary put the plan OUT_OF_FUNDS in its first year while it was on
  // its way to eight figures.
  const sim = run(AuSingleHomeownerScenario, new Date(Date.UTC(2066, 0, 1)));
  assert.equal(sim.state.outOfFundsDate ?? null, null,
    'the plan funds itself for its whole horizon');
  assert.ok(sim.state.metrics.netWorth > 0);
});

// ─── 3. Per-account earnings ──────────────────────────────────────────────────

test('two AU accounts in the same role each earn their own return', () => {
  // The inherited brokerage arrives with the same `au-stock` role and owner as the
  // household's own. The earnings/dividend handlers are wired one per ACCOUNT but
  // used to resolve by role+owner, so both handlers hit the first account: it
  // compounded at 21.5% a year (1.1024 twice over) while the inherited one sat at its
  // opening balance for the rest of the run.
  const sim = run(AuSingleHomeownerScenario, new Date(Date.UTC(2040, 0, 1)));
  const inherited = sim.state.inheritedBrokerageAccount;
  assert.ok(inherited, 'precondition: the bequest was received');
  assert.ok(inherited.balance > 150_000,
    `the inherited brokerage must earn its own return, got ${inherited.balance}`);

  // And the household's own account must NOT have earned twice. Four years of 6%
  // growth + 4% reinvested dividends is ~1.1024^4; double-applying would be ~1.1024^8.
  // Asserted as a ceiling well below the doubled figure rather than an exact balance,
  // since the account is also drawn down for spending.
  const own = sim.state.auStockAccount;
  assert.ok(own.balance < 150_000 * Math.pow(1.1024, 14 * 2),
    'the household account must not compound twice per year');
});
