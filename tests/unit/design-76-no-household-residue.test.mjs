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
 * design-76-no-household-residue.test.mjs
 *
 * Design 76 Phase 5 — the check that makes the migration stick.
 *
 * Every other test in this design asserts that some specific income type attributes
 * correctly. This one asserts the *negative space*: across a full multi-decade run,
 * NO AU-assessable income reaches the settle without an owner. It is the only test
 * that fails when someone adds a twenty-first income type and forgets to attribute
 * it, because it does not enumerate the types — it watches the residue.
 *
 * Why this matters more than a golden: an unattributed dollar still produces the
 * right household TOTAL (computeAuTaxPerPerson divides it by headcount and the parts
 * sum back), so lifetime tax barely moves and every totals-based lock stays green.
 * The error is entirely in the split, and only a residue check sees it.
 *
 * Run with: node --test tests/unit/design-76-no-household-residue.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { TaxSettleService }       from '../../src/finance/tax-settle-service.js';

/**
 * Household AU scalars that design 76 migrated to per-person maps. `auSuperTaxYTD`
 * and the withholding buckets are excluded: they are flat-rate and split-invariant,
 * and the AU module still books them through the scalar on some paths.
 */
const MIGRATED = [
  'auOrdinaryIncomeYTD',
  'auCapitalGainsYTD',
  'auDiscountableGainsYTD',
  'usSourceOrdinaryAudYTD',
  'usSourceCapGainsAudYTD',
  // The FY2027 CGT-reform real buckets. Omitted from the first version of this
  // list, which is exactly why the suite missed that the 2027 module's US-source
  // paths still wrote household scalars — the runtime warning caught it on a real
  // scenario instead. Anything with a per-person twin belongs here.
  'auRealCapitalGainsYTD',
  'usSourceRealCapGainsAudYTD',
];

/**
 * Run the default cross-border scenario and return, for each AU settle, the value
 * each migrated household scalar held *going in*.
 *
 * Read from the journal's stateDiff rather than from final state: the settle's apply
 * reducer zeroes these buckets, so end-of-run state is 0 whether or not attribution
 * works. `before` on the diff entry is the value the handler actually assessed — and
 * a scalar that is 0 both sides produces no diff entry at all, which is the passing
 * shape. (An earlier version of this test read final state and was vacuous: it passed
 * against the pre-migration module.)
 */
function auSettleResidues(simEnd = new Date(Date.UTC(2050, 0, 1))) {
  ServiceRegistry.resetAll();
  const scenario = IntlRetirementScenario.buildAndCompile({ simEnd });
  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  try { scenario.sim.stepTo(simEnd); }
  finally { console.log = log; console.warn = warn; }

  const residues = [];   // { year, field, before }
  const settles  = [];   // { year, perPerson: [{ key, assessed }] }
  for (const e of scenario.sim.journal.journal) {
    if (e.action?.type !== 'AU_TAX_SETTLE_APPLY') continue;
    const year = new Date(e.date).getUTCFullYear();
    for (const d of e.stateDiff ?? []) {
      if (!MIGRATED.includes(d.field)) continue;
      if (Math.abs(d.before ?? 0) > 0.005) residues.push({ year, field: d.field, before: d.before });
    }
    const details = e.action.data?.personTaxDetails;
    if (details?.length) {
      settles.push({
        year,
        perPerson: details.map(d => ({
          key: d.personKey,
          assessed: (d.taxDetail?.inputs?.ordinaryIncome ?? 0) + (d.taxDetail?.inputs?.capitalGains ?? 0),
        })),
      });
    }
  }
  return { residues, settles };
}

describe('design 76 P5 — no AU income reaches settle unattributed', () => {
  test('no migrated household scalar carries a balance into any AU settle', () => {
    const { residues } = auSettleResidues();
    const summary = residues
      .slice(0, 8)
      .map(r => `  FY${r.year} ${r.field} = ${r.before.toFixed(2)}`)
      .join('\n');
    assert.strictEqual(residues.length, 0,
      `${residues.length} household-scalar residue(s) reached an AU settle and were divided by\n`
      + `headcount. Australia has no joint assessment — stamp the emitting action with\n`
      + `personKey / stateKey / owner fields so the income attributes to whoever earns it.\n${summary}`);
  });

  test('at least one AU settle assesses the two people materially unequally', () => {
    // Secondary guard: catches a wholesale revert to the even split, which would
    // leave the residue check above green (nothing on the scalars) while every
    // person's return was still wrong.
    const { settles } = auSettleResidues();
    const withIncome = settles.filter(s => s.perPerson.filter(p => p.assessed > 0).length >= 2);
    assert.ok(withIncome.length > 0, 'expected AU-resident settles with income for both people');

    const topShare = Math.max(...withIncome.map(s => {
      const vals  = s.perPerson.map(p => p.assessed);
      const total = vals.reduce((a, b) => a + b, 0);
      return total > 0 ? Math.max(...vals) / total : 0;
    }));
    assert.ok(topShare > 0.6,
      `most-concentrated AU settle put only ${(topShare * 100).toFixed(0)}% on one person — `
      + 'attribution looks like it has reverted to an even split');
  });
});

describe('design 76 P5 — unattributed income is escalated, not silently split', () => {
  const FY = { startMs: Date.UTC(2030, 6, 1), endMs: Date.UTC(2031, 5, 30) };
  const stateWithResidue = residue => ({
    people: {
      primary: { id: 'primary', name: 'Terry',  residency: 'AU' },
      spouse:  { id: 'spouse',  name: 'Jeanne', residency: 'AU' },
    },
    currentPeriods: { AU: FY, US: FY },
    auPersonOrdinaryIncomeYTD: { primary: 0, spouse: 0 },
    auOrdinaryIncomeYTD: residue,
    inflationAccumulator: { AU: 1.0, US: 1.0 },
    baseExchangeRates: { USD_AUD: 1, AUD_USD: 1 },
    effectiveExchangeRates: { USD_AUD: 1, AUD_USD: 1 },
  });

  const withStrict = (value, fn) => {
    const prev = process.env.AU_ATTRIBUTION_STRICT;
    process.env.AU_ATTRIBUTION_STRICT = value;
    try { return fn(); }
    finally {
      if (prev === undefined) delete process.env.AU_ATTRIBUTION_STRICT;
      else process.env.AU_ATTRIBUTION_STRICT = prev;
    }
  };

  test('a household-scalar residue throws in strict mode, naming the field', () => {
    assert.throws(
      () => withStrict('on', () => new TaxSettleService().computeAuTaxPerPerson(stateWithResidue(50000))),
      /design 76.*auOrdinaryIncomeYTD=50000/s,
      'an income type that skipped attribution must fail loudly where it is introduced');
  });

  test('production still computes rather than throwing — the total is right', () => {
    // The scalar is correct in TOTAL, so a headline figure stays usable. Taking down
    // a user’s simulation over a split-accuracy regression is the wrong trade.
    const details = withStrict('off',
      () => new TaxSettleService().computeAuTaxPerPerson(stateWithResidue(50000)));
    assert.equal(details.length, 2);
    const assessed = details.map(d => d.taxDetail.inputs.ordinaryIncome);
    assert.ok(Math.abs(assessed.reduce((a, b) => a + b, 0) - 50000) < 1,
      'the split parts must still sum to the household total');
  });

  test('a clean state never trips the escalation', () => {
    const clean = stateWithResidue(0);
    clean.auPersonOrdinaryIncomeYTD = { primary: 40000, spouse: 10000 };
    assert.doesNotThrow(
      () => withStrict('on', () => new TaxSettleService().computeAuTaxPerPerson(clean)));
  });
});
