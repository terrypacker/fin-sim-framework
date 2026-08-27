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
 * corporate-actions.test.mjs — design 94 §7 / step 8's gate.
 *
 * ── what is worth testing here, and what is not ──────────────────────────────
 *
 * Not "the code runs". The value in this file is that **the two countries disagree**, and
 * the disagreements are the part a plausible implementation gets wrong by assuming one rule
 * generalises. Three of the tests below are the statutes' OWN worked examples, transcribed
 * from the files on disk, so a regression is measured against the authority rather than
 * against whatever this engine happened to produce first:
 *
 *   - `s124-790`'s Ken example: 100 Aim shares, cost base \$2 each, taken out for 1 LBZ
 *     share (market value \$4) plus \$1 cash per share. **Australia assesses \$60.** On the
 *     same facts §356(a)(1) recognizes the lesser of the realized gain (\$300) and the boot
 *     (\$100) — **\$100** — and §358(a)(1) leaves \$200 of basis where s124-785 leaves \$160.
 *   - `s125-80`'s Peter example: 400 A shares at a \$4.60 cost base, B worth 5% of the
 *     group. The Act works it to **\$3.83 per B share and \$4.37 per A share**.
 *   - §301(c)(2)-(3) against s104-135(3): both apply the payment against basis first and
 *     tax only the excess, and neither can produce a loss.
 *
 * The remaining tests are conservation walks — a corporate action that changes what you
 * hold must not change what you are WORTH — plus the one structural claim step 8 makes that
 * nothing else in the engine does: a spin-off ADDS A SECURITY MID-RUN, and `state.securities`
 * is shared by reference across every snapshot in the run (design 94 §6.4), so it must be
 * REPLACED and never written to.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import {
  CORPORATE_ACTION_KIND, applyCorporateAction, normalizeCorporateAction, registryPatchFor,
} from '../../src/finance/holdings/corporate-action.js';
import {
  CorporateActionHandler, CorporateActionApplyReducer,
} from '../../src/finance/holdings/corporate-action-classes.js';
import { buildSecurityRegistry } from '../../src/finance/holdings/security.js';
import { ALLOCATION } from '../../src/finance/holdings/allocation.js';
import { ServiceRegistry }   from '../../src/services/service-registry.js';
import { BaseScenario }      from '../../src/scenarios/base-scenario.js';
import { ScenarioLoader }    from '../../src/scenarios/scenario-loader.js';
import { ScenarioSerializer } from '../../src/scenarios/scenario-serializer.js';
import { specByName }        from '../helpers/golden-specs.js';
import { buildGoldenCfg }    from '../helpers/golden-harness.js';

const CTX = { dateMs: Date.UTC(2032, 5, 1), auPriceLevel: 1, auCpiRate: 0 };
const BOUGHT = Date.UTC(2020, 0, 1);

/** A unitised equity position: `units` shares at `price`, basis `basis` (total). */
function lot({ units = 100, price = 5, basis = 200, securityId = 'sec-aim', ...rest } = {}) {
  return {
    id: 'lot-1', allocation: ALLOCATION.EQUITY, rateKey: 'EQUITY_US', securityId,
    units, pricePerUnit: price, marketValue: +(units * price).toFixed(2),
    costBasis: basis, costBaseByCountry: null,
    purchaseDate: new Date(BOUGHT).toISOString(),
    acquisitionDateByCountry: null, acquisitionPriceLevel: null,
    ...rest,
  };
}

const worth = (...hs) => +hs.filter(Boolean).reduce((s, h) => s + (h.marketValue ?? 0), 0).toFixed(2);

// ─── validation ──────────────────────────────────────────────────────────────

describe('an authored corporate action is validated, not silently skipped (§7)', () => {
  test('an unknown kind throws', () => {
    assert.throws(() => normalizeCorporateAction({ kind: 'REVERSE_MERGER', securityId: 'x', date: '2030-01-01' }),
      /unknown kind/);
  });

  test('a missing securityId throws — the action has to name the instrument it happens TO', () => {
    assert.throws(() => normalizeCorporateAction({ kind: 'SPLIT', date: '2030-01-01', ratio: 2 }),
      /securityId is required/);
  });

  test('a fraction outside [0,1] throws', () => {
    assert.throws(() => normalizeCorporateAction(
      { kind: 'SPIN_OFF', securityId: 'a', date: '2030-01-01', fmvFraction: 1.4, newSecurity: { id: 'b' } }),
      /fraction in \[0,1\]/);
  });

  test('a stock-leg merger with no acquirer throws', () => {
    assert.throws(() => normalizeCorporateAction(
      { kind: 'MERGER', securityId: 'a', date: '2030-01-01', cashFraction: 0.2 }),
      /needs acquirerSecurityId/);
  });

  test('a spin-off with no new instrument throws — the controlled corporation IS a new security', () => {
    assert.throws(() => normalizeCorporateAction(
      { kind: 'SPIN_OFF', securityId: 'a', date: '2030-01-01', fmvFraction: 0.05 }),
      /newSecurity\.id is required/);
  });
});

// ─── SPLIT (§305(a); ITAA97 s109-55 item 9) ──────────────────────────────────

describe('a split moves the count and nothing else', () => {
  const h = lot();
  const { position, cash, tax } = applyCorporateAction(h, { kind: CORPORATE_ACTION_KIND.SPLIT, ratio: 2 }, CTX);

  test('twice the units at half the price, same value', () => {
    assert.equal(position.units, 200);
    assert.equal(position.pricePerUnit, 2.5);
    assert.equal(position.marketValue, h.marketValue);
  });

  test('§305(a) puts no amount in gross income, and s109-55 item 9 keeps the date', () => {
    assert.equal(tax, null);
    assert.equal(cash, 0);
    assert.equal(position.costBasis, h.costBasis);
    assert.equal(position.purchaseDate, h.purchaseDate);
  });

  test('a SCALAR lot is a no-op, which is the honest answer and not a gap', () => {
    // Design 93 §4 recorded this as the argument FOR storing units: with no count there is
    // nothing a split can write. Confined to the mode that has no units is the fix.
    const scalar = { id: 's', allocation: ALLOCATION.EQUITY, marketValue: 500, costBasis: 200 };
    const r = applyCorporateAction(scalar, { kind: CORPORATE_ACTION_KIND.SPLIT, ratio: 2 }, CTX);
    assert.deepEqual(r.position, scalar);
  });
});

// ─── RENAME — the registry, copy-on-write ────────────────────────────────────

describe('a rename touches the registry and no position (§4 rule 3)', () => {
  const before = buildSecurityRegistry([
    { id: 'sec-aim', symbol: 'AIM', rateKey: 'EQUITY_US' },
    { id: 'sec-lbz', symbol: 'LBZ', rateKey: 'EQUITY_US' },
  ]);
  const specs = registryPatchFor(before, { kind: 'RENAME', securityId: 'sec-aim', symbol: 'AIM2' });
  const after = buildSecurityRegistry(specs);

  test('the id is stable and the symbol is decoration — a rename orphans nothing', () => {
    assert.equal(after['sec-aim'].symbol, 'AIM2');
    assert.equal(after['sec-aim'].id, 'sec-aim');
  });

  test('the OLD map is untouched, because every past snapshot still points at it', () => {
    // The whole safety argument for `SHARED_STATE_KEYS` (design 94 §6.4). An in-place write
    // here would not corrupt one state — it would retroactively rewrite the run.
    assert.equal(before['sec-aim'].symbol, 'AIM');
    assert.notEqual(before, after);
    assert.ok(Object.isFrozen(before) && Object.isFrozen(after));
  });

  test('renaming a security the registry does not have is a no-op, not a mint', () => {
    assert.equal(registryPatchFor(before, { kind: 'RENAME', securityId: 'sec-ghost', symbol: 'X' }), null);
  });
});

// ─── SPIN_OFF — §355/§358 vs ITAA97 Div 125 ──────────────────────────────────

describe("a spin-off apportions basis by market value — s125-80's own worked example", () => {
  // Peter: 400 shares in A, cost base \$4.60 each (\$1,840 total). Company A advises that
  // B is 5% of the market value of the group. The Act works it to \$92 over 24 B shares
  // (\$3.83 each) and \$1,748 over 400 A shares (\$4.37 each).
  const peter = lot({ units: 400, price: 10, basis: 1840, securityId: 'sec-a' });
  const spec = {
    kind: CORPORATE_ACTION_KIND.SPIN_OFF, securityId: 'sec-a', fmvFraction: 0.05,
    unitsPerShare: 24 / 400,
    newSecurity: { id: 'sec-b', symbol: 'B', rateKey: 'EQUITY_US' },
  };
  const { position, spun, cash, tax } = applyCorporateAction(peter, spec, CTX);

  test('the Act\'s numbers, to the cent', () => {
    assert.equal(spun.units, 24);
    assert.equal(+(spun.costBasis / spun.units).toFixed(2), 3.83);
    assert.equal(position.units, 400);
    assert.equal(+(position.costBasis / position.units).toFixed(2), 4.37);
  });

  test('the same instruction is §1.358-2(a)(2)(iv)\'s — total basis is conserved', () => {
    assert.equal(+(position.costBasis + spun.costBasis).toFixed(2), peter.costBasis);
  });

  test('wealth is conserved and no gain is recognized either side', () => {
    assert.equal(worth(position, spun), peter.marketValue);
    assert.equal(tax, null);
    assert.equal(cash, 0);
  });

  test('the parent is REPRICED, not resized — the holder still owns 400 shares', () => {
    // Resizing instead would silently cut the count §1091 share matching and the
    // per-security drawdown selection both read, while conserving every dollar.
    assert.equal(position.units, peter.units);
    assert.equal(position.pricePerUnit, 9.5);
  });

  test('§1223(1)(B) tacks the US clock; Div 125 does not tack the AU one', () => {
    // The single most consequential asymmetry in this file. §1223(1)(B) expressly treats a
    // §355 distribution as an exchange, so the parent's period is INCLUDED. Australia
    // deems nothing: Div 125 is silent and s115-30's table reaches same-asset and
    // replacement-asset roll-overs only, which a demerger is neither.
    assert.equal(spun.purchaseDate, peter.purchaseDate);
    assert.equal(spun.acquisitionDateByCountry.AU, CTX.dateMs);
  });

  test('the new lot is a position in the NEW security, and carries nothing instrument-level from the parent', () => {
    assert.equal(spun.securityId, 'sec-b');
    assert.notEqual(spun.id, peter.id);
    assert.equal(spun.allocation, peter.allocation);
  });
});

// ─── MERGER — §354/§356/§358 vs Subdiv 124-M ─────────────────────────────────

describe('a stock-for-stock merger is not a disposal (§354)', () => {
  const h = lot({ units: 100, price: 5, basis: 200 });
  const spec = { kind: CORPORATE_ACTION_KIND.MERGER, securityId: 'sec-aim',
                 cashFraction: 0, acquirerSecurityId: 'sec-lbz', exchangeRatio: 0.8 };
  const { position, cash, tax } = applyCorporateAction(h, spec, CTX);

  test('no gain, no cash, carryover basis', () => {
    assert.equal(tax, null);
    assert.equal(cash, 0);
    assert.equal(position.costBasis, 200);
    assert.equal(position.marketValue, h.marketValue);
  });

  test('the exchange ratio moves the count; §1223(1) keeps the clock', () => {
    assert.equal(position.units, 80);
    assert.equal(position.pricePerUnit, 6.25);
    assert.equal(position.purchaseDate, h.purchaseDate);
  });

  test('a NEW lot id — a position may never be relabelled in place (§11\'s fourth walk)', () => {
    assert.notEqual(position.id, h.id);
    assert.equal(position.securityId, 'sec-lbz');
  });
});

describe("boot: the two countries genuinely disagree — s124-790's Ken example", () => {
  // Ken owns 100 Aim shares with a cost base of \$2 (\$200). LBZ offers 1 share (market
  // value \$4) plus \$1 cash for each Aim share: total consideration \$500, of which \$100
  // is cash. The Act: cost base of the ineligible part is \$200 x (100/500) = \$40, and
  // "Ken makes a capital gain of \$100 − \$40 = \$60".
  const ken  = lot({ units: 100, price: 5, basis: 200 });
  const spec = { kind: CORPORATE_ACTION_KIND.MERGER, securityId: 'sec-aim',
                 cashFraction: 0.2, acquirerSecurityId: 'sec-lbz', exchangeRatio: 1 };
  const { position, cash, tax } = applyCorporateAction(ken, spec, CTX);

  test('Australia assesses \$60 — the cash less the cost base attributable to it', () => {
    assert.equal(cash, 100);
    assert.equal(tax.auGain, 60);
  });

  test('§356(a)(1) recognizes \$100 — the LESSER of the realized gain (\$300) and the boot', () => {
    // Not an approximation of the AU answer, and neither is an approximation of the other:
    // one rule caps recognition at the boot, the other strikes a gain on an apportioned
    // basis. Modelling one and calling it "the" answer would be wrong in one country.
    assert.equal(tax.gain, 100);
  });

  test('§358(a)(1) substitutes where s124-785 apportions: \$200 of US basis, \$160 of AU', () => {
    assert.equal(position.costBaseByCountry.US, 200);   // 200 − 100 cash + 100 recognized
    assert.equal(position.costBaseByCountry.AU, 160);   // 200 x (1 − 0.2)
  });

  test('the per-country map is stamped even though the lot had none — the event SPLITS one basis into two', () => {
    // `costBaseByCountry?.AU ?? costBasis` is how every consumer reads this. Leaving the
    // map null would have handed the AU return the US number, which is a wrong answer
    // rather than an unknown one (design/inconsistencies §4.11's whole thesis).
    assert.equal(ken.costBaseByCountry, null);
    assert.ok(position.costBaseByCountry);
  });

  test('the stock leg is worth what is left, and wealth is conserved', () => {
    assert.equal(worth(position) + cash, ken.marketValue);
  });

  test('the disposal carries every field the tax modules read through a `??`', () => {
    for (const f of ['gain', 'auGain', 'auIndexedGain', 'auDiscountableGain',
                     'usShortTermGain', 'usLongTermGain', 'auShortTermGain', 'auLongTermGain',
                     'proceeds', 'costBasis']) {
      assert.ok(f in tax, `missing ${f}`);
    }
    // Held since 2020, disposed 2032 — long-term both sides, and so Div 115 discountable.
    assert.equal(tax.usLongTermGain, 100);
    assert.equal(tax.usShortTermGain, 0);
    assert.equal(tax.auDiscountableGain, 60);
  });
});

describe('an all-cash acquisition is simply a disposal', () => {
  const h = lot({ units: 100, price: 5, basis: 200 });
  const spec = { kind: CORPORATE_ACTION_KIND.MERGER, securityId: 'sec-aim', cashFraction: 1 };
  const { position, cash, tax } = applyCorporateAction(h, spec, CTX);

  test('the position ends and the whole gain is recognized', () => {
    assert.equal(position, null);
    assert.equal(cash, 500);
    assert.equal(tax.gain, 300);
    assert.equal(tax.auGain, 300);
  });

  test('and its LOSS is deductible, because §356(c) is not in play without a stock leg', () => {
    const underwater = lot({ units: 100, price: 5, basis: 900 });
    const r = applyCorporateAction(underwater, spec, CTX);
    assert.equal(r.tax.gain, -400);
    assert.equal(r.tax.usLongTermGain, -400);
  });

  test('whereas the same loss with a stock leg is floored — §356(c) allows none', () => {
    const underwater = lot({ units: 100, price: 5, basis: 900 });
    const r = applyCorporateAction(underwater, {
      kind: CORPORATE_ACTION_KIND.MERGER, securityId: 'sec-aim',
      cashFraction: 0.2, acquirerSecurityId: 'sec-lbz',
    }, CTX);
    assert.equal(r.tax.gain, 0);
  });
});

// ─── RETURN OF CAPITAL — §301(c) vs s104-135 ─────────────────────────────────

describe('a return of capital reduces basis first, and only the excess is a gain', () => {
  test('§301(c)(2) / s104-135: within basis, no income and no gain', () => {
    const h = lot({ units: 100, price: 5, basis: 200 });
    const { position, cash, tax } = applyCorporateAction(h,
      { kind: CORPORATE_ACTION_KIND.RETURN_OF_CAPITAL, securityId: 'sec-aim', fmvFraction: 0.2 }, CTX);
    assert.equal(cash, 100);
    assert.equal(tax, null);
    assert.equal(position.costBasis, 100);
    assert.equal(position.marketValue, 400);
    // A PRICE change: the company paid money out, the holder's share count did not move.
    assert.equal(position.units, 100);
  });

  test('§301(c)(3)(A) / s104-135(3): above basis, the excess is a gain and the base goes to nil', () => {
    const h = lot({ units: 100, price: 5, basis: 60 });
    const { position, tax } = applyCorporateAction(h,
      { kind: CORPORATE_ACTION_KIND.RETURN_OF_CAPITAL, securityId: 'sec-aim', fmvFraction: 0.2 }, CTX);
    assert.equal(position.costBasis, 0);
    assert.equal(tax.gain, 40);
    assert.equal(tax.auGain, 40);
  });

  test("s104-135 Note 1 — 'You cannot make a capital loss' — and §301(c)(3) cannot either", () => {
    // The only thing either provision recognizes is the EXCESS over basis. A distribution
    // smaller than basis is not a small loss; it is nothing.
    const h = lot({ units: 100, price: 5, basis: 1000 });
    const { tax } = applyCorporateAction(h,
      { kind: CORPORATE_ACTION_KIND.RETURN_OF_CAPITAL, securityId: 'sec-aim', fmvFraction: 0.2 }, CTX);
    assert.equal(tax, null);
  });
});

// ─── the engine seam ─────────────────────────────────────────────────────────

describe('the handler/reducer pair (design 94 §7)', () => {
  const securities = buildSecurityRegistry([
    { id: 'sec-aim', symbol: 'AIM', rateKey: 'EQUITY_US' },
  ]);
  const baseState = () => ({
    securities,
    people: { p1: { residency: 'US' } },
    usStockAccount: {
      stateKey: 'usStockAccount', country: 'US',
      holdings: [lot({ units: 100, price: 5, basis: 200 })],
      balance: 500,
    },
    otherAccount: { stateKey: 'otherAccount', holdings: [], balance: 0 },
  });

  test('the handler names only the accounts that hold the security', () => {
    const out = new CorporateActionHandler().call({
      state: baseState(),
      data: { action: { kind: 'SPLIT', securityId: 'sec-aim', ratio: 2 } },
    });
    assert.deepEqual(out[0].stateKeys, ['usStockAccount']);
    assert.equal(out[0].residency, 'US');
  });

  test('an action on a security nobody holds emits nothing', () => {
    const out = new CorporateActionHandler().call({
      state: baseState(),
      data: { action: { kind: 'SPLIT', securityId: 'sec-ghost', ratio: 2 } },
    });
    assert.deepEqual(out, []);
  });

  test('a RENAME still fires with no holder — the security exists and its symbol changed', () => {
    const out = new CorporateActionHandler().call({
      state: { securities, people: {} },
      data: { action: { kind: 'RENAME', securityId: 'sec-aim', symbol: 'AIM2' } },
    });
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].stateKeys, []);
  });

  test('a spin-off adds a security MID-RUN, by replacement — the only path in the engine that does', () => {
    const state = baseState();
    const spec  = { kind: 'SPIN_OFF', securityId: 'sec-aim', fmvFraction: 0.05,
                    newSecurity: { id: 'sec-spin', symbol: 'SPN', rateKey: 'EQUITY_US' } };
    const next = new CorporateActionApplyReducer().reduce(
      state, { type: 'CORPORATE_ACTION_APPLY', kind: spec.kind, securityId: spec.securityId,
               stateKeys: ['usStockAccount'], spec, residency: 'US' },
      new Date(CTX.dateMs));

    assert.ok(next.securities['sec-spin']);
    assert.ok(Object.isFrozen(next.securities));
    // The pre-spin-off registry is intact, which is what makes `cloneState`'s
    // by-reference sharing safe (design 94 §6.4).
    assert.equal(state.securities['sec-spin'], undefined);
    assert.equal(next.usStockAccount.holdings.length, 2);
    assert.equal(next.usStockAccount.balance, 500);
  });

  test('cash from a return of capital lands in the account it came out of', () => {
    const state = baseState();
    const spec  = { kind: 'RETURN_OF_CAPITAL', securityId: 'sec-aim', fmvFraction: 0.2 };
    const next = new CorporateActionApplyReducer().reduce(
      state, { type: 'CORPORATE_ACTION_APPLY', kind: spec.kind, securityId: spec.securityId,
               stateKeys: ['usStockAccount'], spec, residency: 'US' },
      new Date(CTX.dateMs));

    const cashLot = next.usStockAccount.holdings.find(h => h.allocation === ALLOCATION.CASH);
    assert.equal(cashLot.marketValue, 100);
    // Design 87 §11 — a cash sleeve's basis IS its value.
    assert.equal(cashLot.costBasis, 100);
    // Wealth is conserved: the shares are worth \$100 less and the account holds \$100 cash.
    assert.equal(next.usStockAccount.balance, 500);
  });

  test('a recognized gain chains STOCK_WITHDRAWAL_TAX with the account\'s own currency and stateKey', () => {
    const state = baseState();
    state.usStockAccount.holdings = [lot({ units: 100, price: 5, basis: 60 })];
    const spec = { kind: 'RETURN_OF_CAPITAL', securityId: 'sec-aim', fmvFraction: 0.2 };
    const next = new CorporateActionApplyReducer().reduce(
      state, { type: 'CORPORATE_ACTION_APPLY', kind: spec.kind, securityId: spec.securityId,
               stateKeys: ['usStockAccount'], spec, residency: 'AU' },
      new Date(CTX.dateMs));

    const tax = next.next.find(a => a.type === 'STOCK_WITHDRAWAL_TAX');
    assert.ok(tax, 'no disposal was chained');
    assert.equal(tax.gain, 40);
    assert.equal(tax.residency, 'AU');
    assert.equal(tax.stateKey, 'usStockAccount');
    assert.equal(tax.currency, 'USD');
  });

  test('a stock-for-stock merger chains NOTHING — §354 recognizes no gain', () => {
    const state = baseState();
    const spec  = { kind: 'MERGER', securityId: 'sec-aim', cashFraction: 0,
                    acquirerSecurityId: 'sec-lbz',
                    newSecurity: { id: 'sec-lbz', symbol: 'LBZ', rateKey: 'EQUITY_US' } };
    const next = new CorporateActionApplyReducer().reduce(
      state, { type: 'CORPORATE_ACTION_APPLY', kind: spec.kind, securityId: spec.securityId,
               stateKeys: ['usStockAccount'], spec, residency: 'US' },
      new Date(CTX.dateMs));

    assert.equal(next.next.filter(a => a.type === 'STOCK_WITHDRAWAL_TAX').length, 0);
    assert.ok(next.securities['sec-lbz'], 'the acquirer has to reach the registry');
    assert.equal(next.usStockAccount.balance, 500);
  });
});

// ─── end to end, on a real plan ──────────────────────────────────────────────

/**
 * Everything above drives the handler and the reducer directly, which proves the ARITHMETIC
 * and proves nothing about the wiring. Design 94 §10.1c is the reason that distinction is
 * worth a separate file's worth of setup: step 6 discovered its levers were unreachable
 * headlessly only when something ran them through the loader.
 *
 * `two-security-concentration` is the golden this belongs on because it is the only one
 * whose lots name AUTHORED securities — everywhere else every equity lot names the synthetic
 * for its own market, so a corporate action would have to hit a whole market at once to be
 * expressible at all. `sec-emp` is held in two accounts, which is also the case that matters
 * here: an issuer's action reaches every holder of the instrument, and an implementation that
 * quietly handled the first account would look correct on any single-account fixture.
 */
describe('end to end through ScenarioLoader (design 94 §10.1c\'s lesson)', () => {
  const run = (corporateActions) => {
    ServiceRegistry.resetAll();
    const services = ServiceRegistry.getInstance();
    const spec = specByName('two-security-concentration');
    const cfg  = buildGoldenCfg(spec);
    if (corporateActions) {
      cfg.toolsets = [...cfg.toolsets, 'CORPORATE_ACTIONS'];
      cfg.corporateActions = corporateActions;
    }
    const scenario = new BaseScenario({
      context:      services.simulationContext,
      initialState: cfg.initialState ?? {},
      simStart:     new Date(cfg.simStart),
      simEnd:       new Date(cfg.simEnd),
    });
    // Default (full) telemetry: the conservation assertion below reads `stateDiff`,
    // which is attached at EXECUTION_END and suppressed at lower levels.
    scenario.buildSim();
    new ScenarioLoader().load(cfg, services);
    const { log, warn } = console;
    console.log = () => {}; console.warn = () => {};
    try { scenario.sim.stepTo(new Date(cfg.simEnd)); }
    finally { console.log = log; console.warn = warn; }
    return { sim: scenario.sim, cfg };
  };

  test('the toolset is INERT for a scenario that authors nothing (design 94 F5)', () => {
    // Not politeness. F5 measured that the event queue's comparator is not a total order, so
    // adding ANY event re-resolves ties among unrelated events elsewhere — 560 fields across
    // eleven goldens. A toolset that scheduled unconditionally would re-gold the repo for a
    // feature nobody switched on, which is why `schedules()` returns [] with no input.
    const withToolsetOnly = (() => {
      ServiceRegistry.resetAll();
      const services = ServiceRegistry.getInstance();
      const cfg = buildGoldenCfg(specByName('two-security-concentration'));
      cfg.toolsets = [...cfg.toolsets, 'CORPORATE_ACTIONS'];
      const scenario = new BaseScenario({
        context: services.simulationContext, initialState: cfg.initialState ?? {},
        simStart: new Date(cfg.simStart), simEnd: new Date(cfg.simEnd),
      });
      scenario.buildSim({ telemetry: 'off' });
      new ScenarioLoader().load(cfg, services);
      return cfg;
    })();
    assert.equal(withToolsetOnly.events.filter(e => e.type === 'CORPORATE_ACTION').length, 0);
    assert.equal(withToolsetOnly.reducers.filter(r => r.type === 'CorporateActionApplyReducer').length, 0);
  });

  test('a spin-off reaches BOTH accounts holding the security, and conserves wealth', () => {
    const at = '2029-06-01';
    const { sim } = run([{
      kind: 'SPIN_OFF', date: at, securityId: 'sec-emp', fmvFraction: 0.1, unitsPerShare: 0.5,
      newSecurity: { id: 'sec-spin', symbol: 'SPN', name: 'SpinCo', rateKey: 'EQUITY_US',
                     beta: 1.0, idioVol: 0 },
    }]);

    const entries = sim.journal.getActions('CORPORATE_ACTION_APPLY');
    // By instance, not by row: the journal records an action at more than one point in its
    // life, so a row count answers a different question than "how many times did it fire".
    assert.equal(new Set(entries.map(e => e.action.instanceId)).size, 1,
      'the event fired exactly once');
    // The journal keeps a declared payload under `action.data` (design 91's manifest gate).
    const applied = entries[0].action.data;
    assert.deepEqual([...applied.stateKeys].sort(), ['k401Account', 'usStockAccount']);

    // Balance is untouched in both: a spin-off changes what you hold, not what you are
    // worth. Any drift here is money minted or destroyed by a reducer that is not allowed
    // to do either.
    for (const key of applied.stateKeys) {
      const diffs = entries[0].stateDiff.filter(d => d.field === `${key}.balance`);
      for (const d of diffs) assert.ok(Math.abs(d.delta ?? 0) < 0.02, `${key} moved ${d.delta}`);
    }

    // The instrument exists from here on, and the positions in it do too.
    assert.ok(sim.state.securities['sec-spin']);
    for (const key of applied.stateKeys) {
      const spun = sim.state[key].holdings.filter(h => h.securityId === 'sec-spin');
      // One PER PARENT LOT, and an account may hold several — the rebalancer establishes a
      // fresh lot on every buy. What matters is that every holder got some and that the ids
      // are distinct, which is the design-61 collision this could otherwise reproduce.
      assert.ok(spun.length >= 1, `${key} should hold a SpinCo position`);
      assert.equal(new Set(spun.map(h => h.id)).size, spun.length, 'colliding lot ids');
      assert.ok(spun.every(h => h.units > 0));
    }
  });

  test('a return of capital in excess of basis is assessed on the return', () => {
    // The end-to-end claim that matters: the chained STOCK_WITHDRAWAL_TAX is not just
    // emitted, it is CONSUMED — it reaches the year's capital-gains accumulator like every
    // other disposal, with no new plumbing on the tax side. Asserted on the action's OWN
    // state diff rather than by comparing two runs' terminal wealth: a return of capital
    // turns equity into cash, so the two arms hold different portfolios from that day on
    // and their ending balances answer a question about growth, not about tax.
    const { sim } = run([{ kind: 'RETURN_OF_CAPITAL', date: '2029-06-01',
                           securityId: 'sec-emp', fmvFraction: 0.95 }]);

    const disposals = sim.journal.getActions('STOCK_WITHDRAWAL_TAX')
      .filter(e => e.action?.data?.description?.startsWith('Return of capital'));
    assert.ok(disposals.length > 0, 'no corporate-action disposal reached the journal');
    assert.ok(disposals.every(e => e.action.data.gain > 0));
    assert.ok(disposals.every(e => e.action.data.stateKey && e.action.data.currency));

    // …and ONLY out of the taxable brokerage. `sec-emp` is held in a 401(k) too, where the
    // same distribution is realised by the WRAPPER and the holder is taxed on distribution
    // instead. An implementation that ignored the wrapper would produce rows here.
    assert.deepEqual([...new Set(disposals.map(e => e.action.data.stateKey))], ['usStockAccount']);

    const moved = disposals.flatMap(e => e.stateDiff ?? [])
      .filter(d => d.field === 'usCapitalGainsYTD' && (d.delta ?? 0) > 0);
    assert.ok(moved.length > 0,
      'the disposal never reached usCapitalGainsYTD — it was recorded, not assessed');
  });

  test('a scenario carrying corporate actions round-trips', () => {
    const actions = [{ kind: 'SPLIT', date: '2029-06-01', securityId: 'sec-emp', ratio: 2 }];
    const { cfg } = run(actions);
    const out = ScenarioSerializer.serializeScenario(cfg);
    assert.deepEqual(out.corporateActions, actions);
  });

  test('a malformed action fails the LOAD rather than running a plan nobody wrote', () => {
    assert.throws(() => run([{ kind: 'SPIN_OFF', date: '2029-06-01', securityId: 'sec-emp',
                               fmvFraction: 0.1 }]),
      /newSecurity\.id is required/);
  });
});
