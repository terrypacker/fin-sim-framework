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
 * The `rothDecant` lever (design 84 P2) — scheduled pre-move Roth drawdown.
 *
 * The merge behaviour is the whole point of the lever existing: the tax-deferred leg
 * of `earlyWithdrawalSchedule` is a SEPARATE decision competing for the same pre-move
 * years, and the generic `params` escape hatch would overwrite the array wholesale.
 * These tests pin that, plus the two traps every lever in this module can fall into —
 * writing only one param store, and being silently inert against the real toolset.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildVariant, applyRothDecant, makeSetParam } from '../../scripts/lib/variant.mjs';
import { loadBaseConfig } from '../../scripts/lib/scenario-source.mjs';
import { openSim, quiet }  from '../../scripts/lib/run.mjs';

/** A cfg carrying an AUTHORED tax-deferred schedule, as a workbench export would. */
const cfgWithTaxDeferred = () => ({
  params: [
    { name: 'earlyWithdrawalEnabled', value: false },
    { name: 'earlyWithdrawalSchedule', value: [
      { year: 2028, taxDeferredAmount: 40_000, rothAmount: 0 },
      { year: 2029, taxDeferredAmount: 10_000, rothAmount: 0 },
      { year: 2035, taxDeferredAmount: 25_000, rothAmount: 0, destinationKey: 'someOtherAccount' },
    ] },
  ],
  parameters: {},
});

const scheduleOf = (cfg) => cfg.params.find(p => p.name === 'earlyWithdrawalSchedule').value;
const yearIn     = (cfg, y) => scheduleOf(cfg).find(e => e.year === y);

describe('rothDecant — merge semantics', () => {
  test('preserves the authored tax-deferred leg on overlapping years', () => {
    const cfg = cfgWithTaxDeferred();
    applyRothDecant(cfg, makeSetParam(cfg), { startYear: 2028, endYear: 2029, annual: 15_000 });
    assert.equal(yearIn(cfg, 2028).taxDeferredAmount, 40_000, 'tax-deferred leg survived');
    assert.equal(yearIn(cfg, 2029).taxDeferredAmount, 10_000);
    assert.equal(yearIn(cfg, 2028).rothAmount, 15_000);
    assert.equal(yearIn(cfg, 2029).rothAmount, 15_000);
  });

  test('leaves years outside the range completely untouched', () => {
    const cfg = cfgWithTaxDeferred();
    applyRothDecant(cfg, makeSetParam(cfg), { startYear: 2028, endYear: 2029, annual: 15_000 });
    assert.deepEqual(yearIn(cfg, 2035),
      { year: 2035, taxDeferredAmount: 25_000, rothAmount: 0, destinationKey: 'someOtherAccount' });
  });

  test('creates absent years with a zero tax-deferred leg, and keeps the list sorted', () => {
    const cfg = cfgWithTaxDeferred();
    applyRothDecant(cfg, makeSetParam(cfg), { startYear: 2026, endYear: 2030, annual: 5_000 });
    const years = scheduleOf(cfg).map(e => e.year);
    assert.deepEqual(years, [2026, 2027, 2028, 2029, 2030, 2035]);
    assert.equal(yearIn(cfg, 2027).taxDeferredAmount, 0, 'new year gets an explicit 0');
    assert.equal(yearIn(cfg, 2027).rothAmount, 5_000);
  });

  test('endYear defaults to startYear — a single-year decant', () => {
    const cfg = cfgWithTaxDeferred();
    applyRothDecant(cfg, makeSetParam(cfg), { startYear: 2030, annual: 9_000 });
    assert.equal(yearIn(cfg, 2030).rothAmount, 9_000);
    assert.equal(yearIn(cfg, 2031), undefined);
  });

  test("'EMPTY' (the default) writes a sentinel the reducer will cap at the balance", () => {
    const cfg = cfgWithTaxDeferred();
    applyRothDecant(cfg, makeSetParam(cfg), { startYear: 2030 });
    assert.ok(yearIn(cfg, 2030).rothAmount > 1e9,
      'a sentinel far above any plausible balance — keeps private figures out of specs');
  });

  test('destinationKey overrides when given, and the authored one survives when not', () => {
    const cfg = cfgWithTaxDeferred();
    applyRothDecant(cfg, makeSetParam(cfg),
      { startYear: 2028, endYear: 2028, annual: 1_000, destinationKey: 'taxableAccount' });
    assert.equal(yearIn(cfg, 2028).destinationKey, 'taxableAccount');

    const cfg2 = cfgWithTaxDeferred();
    applyRothDecant(cfg2, makeSetParam(cfg2), { startYear: 2035, endYear: 2035, annual: 1_000 });
    assert.equal(yearIn(cfg2, 2035).destinationKey, 'someOtherAccount', 'authored destination kept');
  });
});

describe('rothDecant — switches and stores', () => {
  test('writes BOTH param stores (the two-param-stores trap)', () => {
    // A lever that writes only the authored list works against a saved plan and is
    // SILENTLY INERT against buildDefaultConfig(), which populates only the flat bag.
    const cfg = cfgWithTaxDeferred();
    applyRothDecant(cfg, makeSetParam(cfg), { startYear: 2030, annual: 1_000 });
    assert.ok(Array.isArray(cfg.parameters.earlyWithdrawalSchedule), 'bag written');
    assert.equal(cfg.parameters.earlyWithdrawalEnabled, true);
    assert.equal(cfg.parameters.earlyWithdrawalOwner, 'both');
    assert.deepEqual(cfg.parameters.earlyWithdrawalSchedule, scheduleOf(cfg), 'stores agree');
  });

  test('enables the master switch — the schedule is inert without it', () => {
    const cfg = cfgWithTaxDeferred();
    assert.equal(cfg.params[0].value, false);
    applyRothDecant(cfg, makeSetParam(cfg), { startYear: 2030, annual: 1_000 });
    assert.equal(cfg.params.find(p => p.name === 'earlyWithdrawalEnabled').value, true);
  });

  test('annual: 0 does NOT enable the lever — the control arm stays a control', () => {
    // Otherwise a "no decant" cell would switch on a lever the scenario deliberately
    // left off, and the whole grid would be measured against a moved baseline.
    const cfg = cfgWithTaxDeferred();
    applyRothDecant(cfg, makeSetParam(cfg), { startYear: 2030, annual: 0 });
    assert.equal(cfg.params.find(p => p.name === 'earlyWithdrawalEnabled').value, false);
  });

  test('owners is passed through and validated', () => {
    const cfg = cfgWithTaxDeferred();
    applyRothDecant(cfg, makeSetParam(cfg), { startYear: 2030, annual: 1, owners: 'spouse' });
    assert.equal(cfg.parameters.earlyWithdrawalOwner, 'spouse');
  });
});

describe('rothDecant — fails loud rather than silently inert', () => {
  const bad = (o) => {
    const cfg = cfgWithTaxDeferred();
    assert.throws(() => applyRothDecant(cfg, makeSetParam(cfg), o), /rothDecant:/);
  };
  test('rejects a missing or non-numeric startYear', () => { bad({ annual: 1 }); bad({ startYear: '2030' }); });
  test('rejects an inverted range',                   () => bad({ startYear: 2030, endYear: 2029 }));
  test('rejects an unknown owners value',             () => bad({ startYear: 2030, owners: 'everyone' }));
  test('rejects a negative or non-numeric annual',    () => {
    bad({ startYear: 2030, annual: -1 });
    bad({ startYear: 2030, annual: 'ALL' });   // near-miss for 'EMPTY'
  });
});

describe('rothDecant — absent is a faithful no-op', () => {
  test('buildVariant without the lever leaves the schedule alone', () => {
    const before = cfgWithTaxDeferred();
    const after  = buildVariant(before, {});
    assert.deepEqual(scheduleOf(after), scheduleOf(before));
    assert.equal(after.params.find(p => p.name === 'earlyWithdrawalEnabled').value, false);
  });
});

// ── Actuation: the lever reaches the real toolset ────────────────────────────────
//
// Every assertion above is about the cfg. None of them would catch the lever writing a
// param the toolset does not read, or writing it in a shape `schedules()` skips — the
// failure mode that produces a study where every cell is identical and nobody notices.
// Synthetic default on purpose: this is a question about the ENGINE, not about a plan.
describe('rothDecant — actuates through the toolset (not silently inert)', () => {
  const rothEvents = (cfg) => {
    let sim;
    quiet(() => { sim = openSim(cfg, { telemetry: 'off' }); });
    return (sim.queue?.data ?? [])
      .filter(e => e?.type === 'SCHEDULED_EARLY_WITHDRAWAL' && (e.data?.rothAmount ?? 0) > 0);
  };

  test('scheduled events carry a positive rothAmount and a Roth source key', () => {
    const { cfg } = loadBaseConfig({});                    // synthetic default
    const base = rothEvents(cfg);
    assert.equal(base.length, 0, 'baseline schedules no Roth decant');

    const withDecant = buildVariant(cfg, {
      rothDecant: { startYear: 2028, endYear: 2029, annual: 10_000, owners: 'primary' },
    });
    const events = rothEvents(withDecant);
    assert.ok(events.length > 0, 'the lever produced SCHEDULED_EARLY_WITHDRAWAL events');
    for (const e of events) {
      assert.ok(e.data.rothKey,         'event names the Roth to draw from');
      assert.ok(e.data.destinationKey,  'event names somewhere to land the cash');
      assert.ok(e.data.rothAmount > 0);
    }
    const years = [...new Set(events.map(e => new Date(e.date).getUTCFullYear()))].sort();
    assert.deepEqual(years, [2028, 2029]);
  });

  test('amounts are compounded to nominal, so they are REAL base-year inputs', () => {
    // If the toolset ever stopped compounding, a caller pre-inflating to compensate
    // would double-count. Pin the direction: a later year draws strictly more nominal.
    const { cfg } = loadBaseConfig({});
    const events = rothEvents(buildVariant(cfg, {
      rothDecant: { startYear: 2028, endYear: 2032, annual: 10_000, owners: 'primary' },
    }));
    const byYear = new Map(events.map(e => [new Date(e.date).getUTCFullYear(), e.data.rothAmount]));
    assert.ok(byYear.get(2032) > byYear.get(2028),
      `nominal grows with the price level: 2032=${byYear.get(2032)} 2028=${byYear.get(2028)}`);
  });

  test("owners: 'both' schedules a draw PER PERSON, not a household total", () => {
    const { cfg } = loadBaseConfig({});
    const dest = 'usStockAccount';   // explicit, so both owners have somewhere to land
    const one  = rothEvents(buildVariant(cfg, {
      rothDecant: { startYear: 2028, annual: 10_000, owners: 'primary', destinationKey: dest } }));
    const both = rothEvents(buildVariant(cfg, {
      rothDecant: { startYear: 2028, annual: 10_000, owners: 'both', destinationKey: dest } }));
    assert.equal(one.length, 1);
    assert.equal(both.length, 2, "'both' draws `annual` from EACH person's Roth");
    assert.equal(both[0].data.rothAmount, both[1].data.rothAmount, 'same per-owner figure');
    assert.notEqual(both[0].data.rothKey, both[1].data.rothKey, 'different source wrappers');
  });

  test('a per-owner destination map routes each decant to its own account (design 84 G6)', () => {
    // The reason the map exists: the fallback resolves by ROLE, first match wins, so an
    // owner whose only us-stock account is a special-purpose sleeve would silently have
    // their decant land there — changing its post-move growth, and the answer, with
    // nothing visible in the schedule.
    const { cfg } = loadBaseConfig({});
    const events = rothEvents(buildVariant(cfg, {
      rothDecant: {
        startYear: 2028, annual: 10_000, owners: 'both',
        destinationKey: { primary: 'usStockAccount', spouse: 'iraAccount' },
      },
    }));
    assert.equal(events.length, 2);
    const dests = new Map(events.map(e => [e.data.owner, e.data.destinationKey]));
    assert.equal(dests.get('primary'), 'usStockAccount');
    assert.equal(dests.get('spouse'),  'iraAccount', "spouse routed to their OWN destination");
  });

  test('an owner absent from the map still falls back to the role lookup', () => {
    const { cfg } = loadBaseConfig({});
    const events = rothEvents(buildVariant(cfg, {
      rothDecant: { startYear: 2028, annual: 10_000, owners: 'primary',
                    destinationKey: { spouse: 'iraAccount' } },
    }));
    assert.equal(events.length, 1);
    assert.equal(events[0].data.destinationKey, 'usStockAccount', 'fell back to the role lookup');
  });

  test('an explicit destination re-routes EVERY year with a Roth leg, not just the range', () => {
    // Confining routing to the lever's range leaves the authored years pointing wherever
    // the role lookup put them — a split-destination decant, which is the silent
    // mis-routing G6 is about. Years with no Roth leg keep their own destination.
    const cfg = {
      params: [{ name: 'earlyWithdrawalSchedule', value: [
        { year: 2030, taxDeferredAmount: 1_000, rothAmount: 50_000 },   // authored Roth leg
        { year: 2031, taxDeferredAmount: 2_000, rothAmount: 0, destinationKey: 'untouched' },
      ] }],
      parameters: {},
      persons:  [{ id: 'primary' }],
      accounts: [{ role: 'roth-ira', ownerId: 'primary', stateKey: 'rothAccount' },
                 { role: 'us-stock', ownerId: 'primary', stateKey: 'chosenAccount' },
                 { role: 'us-stock', ownerId: 'primary', stateKey: 'untouched' }],
    };
    applyRothDecant(cfg, makeSetParam(cfg),
      { startYear: 2028, endYear: 2028, annual: 1_000, owners: 'primary', destinationKey: 'chosenAccount' });

    assert.equal(yearIn(cfg, 2028).destinationKey, 'chosenAccount', 'the range');
    assert.equal(yearIn(cfg, 2030).destinationKey, 'chosenAccount', 'the authored Roth year too');
    assert.equal(yearIn(cfg, 2030).rothAmount, 50_000, 'its AMOUNT is untouched');
    assert.equal(yearIn(cfg, 2031).destinationKey, 'untouched', 'no Roth leg ⇒ left alone');
  });

  test('a zero-decant arm never re-routes the tax-deferred leg (control stays a control)', () => {
    // Caught by a grid whose two "hold" cells differed when they could not: the lever
    // was stamping destinationKey on every year in range, including years carrying only
    // a TAX-DEFERRED decant, so varying the (inert) Roth window moved where the
    // tax-deferred proceeds landed. Two arms that differ in nothing must run identically.
    const mk = (startYear) => {
      const cfg = {
        params: [{ name: 'earlyWithdrawalSchedule', value: [
          { year: 2028, taxDeferredAmount: 38_000, rothAmount: 0 },
        ] }],
        parameters: {},
        persons:  [{ id: 'primary' }],
        accounts: [{ role: 'roth-ira', ownerId: 'primary', stateKey: 'rothAccount' },
                   { role: 'us-stock', ownerId: 'primary', stateKey: 'chosenAccount' }],
      };
      applyRothDecant(cfg, makeSetParam(cfg),
        { startYear, endYear: 2030, annual: 0, owners: 'primary', destinationKey: 'chosenAccount' });
      return cfg;
    };
    // Declaring a zero Roth leg for an extra year is fine — the toolset skips
    // zero/zero years. What must NOT differ is anything with economic content.
    const active = (cfg) => scheduleOf(cfg)
      .filter(e => (e.taxDeferredAmount ?? 0) > 0 || (e.rothAmount ?? 0) > 0);
    assert.deepEqual(active(mk(2027)), active(mk(2029)),
      'an inert Roth window must not perturb any year that does anything');
    assert.equal(yearIn(mk(2027), 2028).destinationKey, undefined,
      'the tax-deferred leg keeps its own routing');
  });

  test('a destination naming no account is rejected (design/72 Gap 2 — key, not id)', () => {
    const { cfg } = loadBaseConfig({});
    assert.throws(
      () => buildVariant(cfg, { rothDecant: {
        startYear: 2028, annual: 10_000, owners: 'primary', destinationKey: 'not-an-account' } }),
      /is not an account in this scenario/);
  });

  test('an owner with a Roth but no landing account is rejected, not silently skipped', () => {
    // The synthetic default gives the spouse a Roth and NO us-stock account, so the
    // toolset's `keyOf(...) → continue` would drop their decant without a word. That
    // reads downstream as "decanting the spouse's Roth does nothing" — a tax conclusion
    // drawn from a missing account. This is the guard for that.
    const { cfg } = loadBaseConfig({});
    const spouseHasNoBrokerage = !(cfg.accounts ?? [])
      .some(a => a.role === 'us-stock' && a.ownerId === 'spouse');
    assert.ok(spouseHasNoBrokerage, 'precondition: the default spouse has nowhere to land cash');

    assert.throws(
      () => buildVariant(cfg, { rothDecant: { startYear: 2028, annual: 10_000, owners: 'both' } }),
      /no us-stock account to receive the decant/);

    // …and an explicit destination is the documented way through.
    assert.doesNotThrow(() => buildVariant(cfg, {
      rothDecant: { startYear: 2028, annual: 10_000, owners: 'both', destinationKey: 'usStockAccount' },
    }));
  });
});
