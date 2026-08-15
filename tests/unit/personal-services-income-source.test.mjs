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
 * personal-services-income-source.test.mjs — design 73 §6b.
 *
 * AUD-denominated personal services income — wages (`AU_WAGES_INCOME_TAX`) and
 * self-employment (`AU_SE_INCOME_TAX`) — classified against residency × source.
 *
 * The defect these pin: each classifier used to collapse two independent axes into
 * one test, in opposite directions. Wages branched on SOURCE alone, so an AU
 * resident performing the work in the US fell off it with nothing on the AU return.
 * SE branched on RESIDENCY alone, so a foreign resident's Australian-performed fees
 * were assessed nowhere, while an AU resident's US-performed fees fed the §904
 * general numerator and the §911 FEIE cap — both reserved for genuinely foreign
 * income. Each was right in exactly the half the other got wrong.
 *
 * The axes, and the authority for each:
 *   assessable in AU   ⇔ AU-resident (s6-5(2), worldwide) OR AU-sourced (s6-5(3))
 *   §904 general       ⇔ AU-sourced only        — genuinely foreign income
 *   Art 22(2) removal  ⇔ US-sourced + AU-res    — the US is source State, AU credits
 *   §911 FEIE cap      ⇔ AU-sourced AND AU-res  — foreign EARNED income, tax home abroad
 *
 * Treaty: Art 15(1) (employment) and Art 14 (independent services) both ADD a
 * source-State right without removing the residence State's — which is why the
 * first axis has two limbs and the second has one. Neither article is touched by
 * the 2001 Protocol.
 *
 *   PSI-1..4  wages, all four residency × source cells
 *   PSI-5..8  self-employment, same four cells
 *   PSI-9     the two classifiers agree cell for cell (the anti-divergence guard)
 *   PSI-10    workCountry unset ⇒ follows residency ⇒ pre-§6b behaviour is unchanged
 *   PSI-11    AuSeIncomeApplyReducer forwards workCountry to the tax action
 *   PSI-12    AU SE income still never reaches the SECA base (totalization)
 *
 * Run with: node --test tests/unit/personal-services-income-source.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { AuTaxModule2026 } from '../../src/finance/tax/au/au-tax-module-2026.js';
import { AuSeIncomeApplyReducer } from '../../src/finance/account-rules/au/au-income-classes.js';
import { makeAccount, makeServices } from '../helpers/reducer-fixtures.js';

const RATE   = 1.55;      // 1 USD = 1.55 AUD
const AMOUNT = 60_000;    // AUD
const USD    = AMOUNT / RATE;
const PERSON = 'primary';

const auFns = new Map(new AuTaxModule2026().getReducerFns());
const WAGES = 'AU_WAGES_INCOME_TAX';
const SE    = 'AU_SE_INCOME_TAX';

/** Per-person maps present ⇒ the classifiers take their per-person path. */
const zeroState = () => ({
  effectiveExchangeRates: { USD_AUD: RATE },
  usOrdinaryIncomeYTD:      0,
  auOrdinaryIncomeYTD:      0,
  foreignGeneralIncomeYTD:  0,
  usSourceOrdinaryUsdYTD:   0,
  usSourceGeneralUsdYTD:    0,
  usSourceOrdinaryAudYTD:   0,
  auPersonOrdinaryIncomeYTD:         { [PERSON]: 0 },
  auPersonUsSourceOrdinaryAudYTD:    { [PERSON]: 0 },
  auPersonEarnedIncomeYTD:           { [PERSON]: 0 },
});

/** Classify one action and reduce the result to the six figures under test. */
function classify(type, { residency, workCountry }, state = zeroState()) {
  const next = auFns.get(type)(state, { type, amount: AMOUNT, residency, personKey: PERSON, workCountry });
  return {
    usOrdinary:    next.usOrdinaryIncomeYTD,
    auAssessable:  (next.auOrdinaryIncomeYTD ?? 0) + (next.auPersonOrdinaryIncomeYTD?.[PERSON] ?? 0),
    generalBasket: next.foreignGeneralIncomeYTD ?? 0,
    removalUsd:    next.usSourceOrdinaryUsdYTD ?? 0,
    removalAud:    (next.usSourceOrdinaryAudYTD ?? 0) + (next.auPersonUsSourceOrdinaryAudYTD?.[PERSON] ?? 0),
    feieBase:      next.auPersonEarnedIncomeYTD?.[PERSON] ?? 0,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// PSI-1..4 — wages
// ══════════════════════════════════════════════════════════════════════════════

test('PSI-1 (wages, AU-res / AU work): assessed in AU, general basket, FEIE base', () => {
  const r = classify(WAGES, { residency: 'AU', workCountry: 'AU' });
  assert.strictEqual(r.auAssessable,  AMOUNT, 's6-5(2) and (3) both reach it');
  assert.strictEqual(r.generalBasket, USD,    'genuinely foreign-source income');
  assert.strictEqual(r.feieBase,      AMOUNT, 'foreign earned income, tax home abroad');
  assert.strictEqual(r.removalUsd,    0,      'not a US-source item');
  assert.strictEqual(r.removalAud,    0);
});

test('PSI-2 (wages, AU-res / US work): assessed in AU under s6-5(2), with FITO relief attached', () => {
  // The §6b fix on the wage side. Art 15(1) hands the US a source-State right when
  // the employment is exercised there; it does not take Australia's residence-State
  // right away, and s6-5(2) assesses a resident on income "from all sources, whether
  // in or out of Australia". This used to book NOTHING to the AU return.
  const r = classify(WAGES, { residency: 'AU', workCountry: 'US' });
  assert.strictEqual(r.auAssessable, AMOUNT, 's6-5(2): resident assessed on worldwide ordinary income');
  assert.strictEqual(r.removalAud,   AMOUNT, 'the US-source slice that sizes the s770-75 FITO limit');
  assert.strictEqual(r.removalUsd,   USD,    'and its USD twin, for the Art 22(2) base');
  assert.strictEqual(r.generalBasket, 0,     'US-source income must not inflate the §904 general limitation');
  assert.strictEqual(r.feieBase,      0,     'US-performed work is not foreign EARNED income');
});

test('PSI-3 (wages, non-res / AU work): assessed in AU under s6-5(3), general basket, no FEIE', () => {
  const r = classify(WAGES, { residency: 'US', workCountry: 'AU' });
  assert.strictEqual(r.auAssessable,  AMOUNT, 's6-5(3): foreign resident, Australian source');
  assert.strictEqual(r.generalBasket, USD);
  assert.strictEqual(r.feieBase,      0, 'no AU tax home ⇒ no §911 exclusion to accrue');
  assert.strictEqual(r.removalAud,    0);
});

test('PSI-4 (wages, non-res / US work): nothing on the AU return at all', () => {
  const r = classify(WAGES, { residency: 'US', workCountry: 'US' });
  assert.strictEqual(r.auAssessable,  0, 'neither limb of s6-5 is reached');
  assert.strictEqual(r.generalBasket, 0);
  assert.strictEqual(r.removalUsd,    0, 'a US resident needs no Art 22(2) removal set');
  assert.strictEqual(r.usOrdinary,    USD, 'but it is still US worldwide ordinary income');
});

// ══════════════════════════════════════════════════════════════════════════════
// PSI-5..8 — self-employment. Same four cells; s6-5 draws no line between
// employment and independent services income, and Art 14 mirrors Art 15(1).
// ══════════════════════════════════════════════════════════════════════════════

test('PSI-5 (SE, AU-res / AU work): assessed in AU, general basket, FEIE base', () => {
  const r = classify(SE, { residency: 'AU', workCountry: 'AU' });
  assert.strictEqual(r.auAssessable,  AMOUNT);
  assert.strictEqual(r.generalBasket, USD);
  assert.strictEqual(r.feieBase,      AMOUNT);
});

test('PSI-6 (SE, AU-res / US work): US-source ⇒ removal set, NOT the general basket or the FEIE cap', () => {
  // The half the SE classifier got wrong by branching on residency alone. Feeding
  // foreignGeneralIncomeYTD here inflates the §904 limitation with US-source income;
  // feeding the FEIE cap lets a US citizen exclude income earned in the US, and
  // _computeFeie's own residency gate cannot catch it — this earner IS AU-resident.
  const r = classify(SE, { residency: 'AU', workCountry: 'US' });
  assert.strictEqual(r.auAssessable,  AMOUNT, 's6-5(2) still assesses the resident');
  assert.strictEqual(r.generalBasket, 0,      'US-source income out of the §904 general numerator');
  assert.strictEqual(r.feieBase,      0,      'not foreign earned income — no §911 exclusion');
  assert.strictEqual(r.removalAud,    AMOUNT);
  assert.strictEqual(r.removalUsd,    USD);
});

test('PSI-7 (SE, non-res / AU work): Australian-performed fees ARE assessable here', () => {
  // The other half: s6-5(3) assesses a foreign resident on ordinary income from all
  // Australian sources, and Art 14 gives Australia the taxing right over independent
  // services performed there (>183 days present, or a fixed base — a year-long
  // workCountry satisfies the first). This used to book nothing anywhere.
  const r = classify(SE, { residency: 'US', workCountry: 'AU' });
  assert.strictEqual(r.auAssessable,  AMOUNT, 'assessed at foreign-resident marginal rates');
  assert.strictEqual(r.generalBasket, USD,    'and the foreign tax on it is creditable');
  assert.strictEqual(r.feieBase,      0);
});

test('PSI-8 (SE, non-res / US work): nothing on the AU return at all', () => {
  const r = classify(SE, { residency: 'US', workCountry: 'US' });
  assert.strictEqual(r.auAssessable,  0);
  assert.strictEqual(r.generalBasket, 0);
  assert.strictEqual(r.usOrdinary,    USD);
});

// ══════════════════════════════════════════════════════════════════════════════
// PSI-9..12 — invariants
// ══════════════════════════════════════════════════════════════════════════════

test('PSI-9: the wage and SE classifiers agree cell for cell', () => {
  // The anti-divergence guard. These two were written out separately and drifted
  // into opposite mistakes; nothing in s6-5, Art 14/15 or §904 distinguishes a wage
  // from a sole trader's fee for any of these bookings. If a future change means to
  // split them, it has to say so here first.
  for (const residency of ['AU', 'US']) {
    for (const workCountry of ['AU', 'US']) {
      assert.deepStrictEqual(
        classify(SE,    { residency, workCountry }),
        classify(WAGES, { residency, workCountry }),
        `residency=${residency} workCountry=${workCountry}`,
      );
    }
  }
});

test('PSI-10: workCountry unset falls back to residency (pre-§6b behaviour preserved)', () => {
  // Every scenario that never sets workCountry must classify exactly as it did
  // before design 73 — the earner works where they live.
  for (const [type, residency] of [[WAGES, 'AU'], [WAGES, 'US'], [SE, 'AU'], [SE, 'US']]) {
    assert.deepStrictEqual(
      classify(type, { residency, workCountry: undefined }),
      classify(type, { residency, workCountry: residency }),
      `${type} residency=${residency}`,
    );
  }
});

test('PSI-11: AuSeIncomeApplyReducer forwards workCountry to AU_SE_INCOME_TAX', () => {
  // §6b's plumbing half: the reducer destructured four fields and rebuilt the tax
  // action from those alone, dropping the source attribute one hop after
  // MonthlyWagesHandler computed it.
  const state = { auSavingsAccount: makeAccount({ stateKey: 'auSavingsAccount', currency: 'AUD', holdings: [{ id: 'h', marketValue: 10_000, costBasis: 10_000 }] }) };
  const out = new AuSeIncomeApplyReducer(makeServices()).reduce(state,
    { type: 'SE_INCOME_AU_APPLY', amount: 4000, residency: 'US', personKey: PERSON, workCountry: 'AU' },
    new Date('2030-06-15'));
  const tax = (out.next ?? []).find(a => a?.type === SE);
  assert.ok(tax, 'the reducer must chain AU_SE_INCOME_TAX');
  assert.strictEqual(tax.workCountry, 'AU', 'workCountry must survive the hop to the tax action');
});

test('PSI-12: AU self-employment income never reaches the US SECA base (totalization)', () => {
  // Unchanged by §6b, and easy to break while editing the booking: SECA does not
  // reach AU sole-trader earnings on any of the four cells.
  for (const residency of ['AU', 'US']) {
    for (const workCountry of ['AU', 'US']) {
      const next = auFns.get(SE)(zeroState(), { type: SE, amount: AMOUNT, residency, personKey: PERSON, workCountry });
      assert.strictEqual(next.usSeEarningsYTD ?? 0, 0, `residency=${residency} workCountry=${workCountry}`);
    }
  }
});
