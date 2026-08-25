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
 * au-super-caps.test.mjs — design 95 §9.2-9.5, phase 7.
 *
 * The Australian contribution caps. Four limits, one shared concessional pool, and
 * two of them derived from a single published figure rather than transcribed:
 *
 *   - **s291-20** concessional cap, with the five-year carry-forward
 *   - **s292-85** non-concessional cap, with the bring-forward and the hard nil at
 *     the general transfer balance cap
 *   - **SGAA s10A(5)/(6)** maximum contributions base, which truncates the EARNINGS
 *     the Super Guarantee is computed on
 *
 * The anchor test is CAP-1: the ATO's own worked example from Table 2 of
 * *Contributions caps*, replayed year by year. It exercises accrual, expiry, the
 * earliest-first ordering AND the \$500,000 balance gate opening and shutting again —
 * against numbers the regulator published, not against our own arithmetic restated.
 *
 * Run with: node --test tests/unit/au-super-caps.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import {
  concessionalCap, generalNonConcessionalCap, maxContributionsBase,
  transferBalanceCap, countableQualifyingEarnings, superGuaranteeAmount,
  concessionalCapWithCarryForward, rollUnusedConcessionalCap, nonConcessionalCap,
  SG_CHARGE_PERCENTAGE, CARRY_FORWARD_TSB_THRESHOLD,
} from '../../src/finance/tax/au/au-super-limits.js';
import { monthlyAuSuper, auFinancialYearOf } from '../../src/finance/payroll/au-super-caps.js';
import { AuTaxSettleApplyReducer } from '../../src/finance/tax/tax-settle-classes.js';

// ─── CAP-1: the ATO's own worked example ─────────────────────────────────────

test('CAP-1 reproduces the ATO Table 2 carry-forward example, column for column', () => {
  // Transcribed from `docs/au-tax/ato-rates/ato-contributions-caps.txt`, Table 2:
  // the financial year, the balance at 30 June the year before, the concessional
  // contributions made, and the two figures the ATO publishes as the answer.
  const TABLE_2 = [
    { fy: 2017, tsb: 0,       cc: 0,     unusedAvailable: 0,      maxCap: 25_000 },
    { fy: 2018, tsb: 480_000, cc: 3_000, unusedAvailable: 0,      maxCap: 25_000 },
    { fy: 2019, tsb: 490_000, cc: 3_000, unusedAvailable: 22_000, maxCap: 47_000 },
    // The balance crosses \$500,000: the gate SHUTS and the accrued \$44,000 is
    // unreachable this year, even though it is still there.
    { fy: 2020, tsb: 505_000, cc: 0,     unusedAvailable: 44_000, maxCap: 25_000 },
    // …and falls back under it: the gate re-OPENS and all \$69,000 is available
    // again. The gate is an annual test, not a one-way switch.
    { fy: 2021, tsb: 490_000, cc: 0,     unusedAvailable: 69_000, maxCap: 96_500 },
  ];

  let ring = {};
  for (const row of TABLE_2) {
    const available = Object.values(ring).reduce((s, v) => s + v, 0);
    assert.equal(available, row.unusedAvailable,
      `FY${row.fy}: total unused available cap accrued`);

    // "Maximum cap available" is the cap if the member needed all of it, so ask with
    // a demand nothing could satisfy — s291-20(4) otherwise releases only the excess.
    const max = concessionalCapWithCarryForward({
      fyStartYear: row.fy, contributions: 1e9, tsb: row.tsb, unusedByFy: ring });
    assert.equal(max.cap, row.maxCap, `FY${row.fy}: maximum cap available`);

    const actual = concessionalCapWithCarryForward({
      fyStartYear: row.fy, contributions: row.cc, tsb: row.tsb, unusedByFy: ring });
    ring = rollUnusedConcessionalCap({
      fyStartYear: row.fy, contributions: row.cc, unusedByFy: ring, applied: actual.applied });
  }
});

test('CAP-2 the balance gate blocks USE but never blocks ACCRUAL', () => {
  // s291-20(6) has no balance condition — only (3)(b) does. A year spent over the
  // threshold still banks its own unused cap; it just cannot spend anyone else's.
  const ring = rollUnusedConcessionalCap({
    fyStartYear: 2020, contributions: 0, unusedByFy: { 2018: 22_000 }, applied: [] });
  assert.equal(ring[2020], 25_000, 'the over-threshold year still accrues');
  assert.equal(ring[2018], 22_000, 'and spends nothing');
});

test('CAP-3 unused cap expires after five years, oldest first', () => {
  // The ATO: "a 2019-20 unused cap amount that isn't used by the end of 2024-25 will
  // expire." So rolling out of 2024-25 must drop the 2019 vintage and keep 2020's.
  const ring = rollUnusedConcessionalCap({
    fyStartYear: 2024, contributions: 30_000,
    unusedByFy: { 2019: 5_000, 2020: 6_000, 2023: 7_000 }, applied: [] });
  assert.equal(ring[2019], undefined, '2019-20 expires at the end of 2024-25');
  assert.equal(ring[2020], 6_000);
  assert.equal(ring[2023], 7_000);
  assert.equal(ring[2024], undefined, 'a year that used its whole cap accrues nothing');
});

test('CAP-4 the carry-forward is spent earliest-first, and only up to the excess', () => {
  const r = concessionalCapWithCarryForward({
    fyStartYear: 2026, contributions: 40_000, tsb: 100_000,
    unusedByFy: { 2022: 4_000, 2023: 9_000, 2024: 9_000 },
  });
  // Excess is 40,000 − 32,500 = 7,500. s291-20(5) takes 2022 first, then part of 2023.
  assert.deepEqual(r.applied, [{ fy: 2022, amount: 4_000 }, { fy: 2023, amount: 3_500 }]);
  assert.equal(r.carriedForward, 7_500);
  assert.equal(r.cap, 40_000, 'the cap rises to exactly what was needed, no more');
  // s291-20(4): "but not by more than the excess". The remaining 14,500 stays banked.
  assert.ok(r.cap < 32_500 + 22_000, 'unused cap is not free headroom');
});

test('CAP-5 no excess means no release, however much is banked', () => {
  // (3)(a): the carry-forward is not an election and not visible headroom. A member
  // under the cap keeps every dollar of it for a later year.
  const r = concessionalCapWithCarryForward({
    fyStartYear: 2026, contributions: 20_000, tsb: 0,
    unusedByFy: { 2023: 25_000 } });
  assert.equal(r.cap, 32_500);
  assert.equal(r.carriedForward, 0);
  assert.deepEqual(r.applied, []);
});

test('CAP-6 the \$500,000 gate is tested every year, on the opening balance', () => {
  // Demanding more than the banked cap could satisfy, so the gate is the only thing
  // that can be making the difference between the two arms — with a smaller demand,
  // s291-20(4)'s "not more than the excess" would be doing part of the work and the
  // test would not isolate what it names.
  const args = { fyStartYear: 2026, contributions: 100_000, unusedByFy: { 2023: 20_000 } };
  const under = concessionalCapWithCarryForward({ ...args, tsb: CARRY_FORWARD_TSB_THRESHOLD - 1 });
  const at    = concessionalCapWithCarryForward({ ...args, tsb: CARRY_FORWARD_TSB_THRESHOLD });

  assert.equal(under.cap, 52_500, 'below the threshold: the full 20,000 releases');
  assert.equal(at.cap,    32_500, 'AT the threshold: nothing releases — (3)(b) says "less than"');
  assert.equal(at.gateOpen, false);
});

// ─── The derived limits ──────────────────────────────────────────────────────

test('CAP-7 the SG base is derived from the cap, and the two interlock exactly', () => {
  // s10A(5): cap / charge_percentage x 100, floored to \$10. 2026-27:
  // 32,500 / 12 x 100 = 270,833.33 → 270,830. These match the ATO's published base.
  assert.equal(maxContributionsBase(2026), 270_830);
  assert.equal(maxContributionsBase(2025), 250_000);

  // The interlock is the point: 12% of the base IS the cap, to within the rounding.
  // That is what makes it impossible for the Super Guarantee ALONE to produce an
  // excess concessional contribution — so any clamping of the member's own streams
  // is genuinely the member's own doing.
  const sgOnFullBase = superGuaranteeAmount(maxContributionsBase(2026));
  assert.ok(sgOnFullBase <= concessionalCap(2026),
    `12% of the base (${sgOnFullBase}) must not exceed the cap (${concessionalCap(2026)})`);
  assert.ok(concessionalCap(2026) - sgOnFullBase < 10 * SG_CHARGE_PERCENTAGE / 100 + 0.01,
    'and must be under it only by the base\'s own \$10 rounding');
});

test('CAP-8 the base and the Div 293 threshold have diverged — do not hard-code either', () => {
  // Equal by construction through 2025-26, and \$20,830 apart from 1 July 2026.
  // s293-20's \$250,000 is a literal in the statute; the base moves with the cap.
  assert.equal(maxContributionsBase(2025), 250_000);
  assert.equal(maxContributionsBase(2026), 270_830);
  assert.equal(maxContributionsBase(2026) - 250_000, 20_830);
});

test('CAP-9 the non-concessional cap is 4x the concessional cap in every published year', () => {
  // s292-85(2)(a), confirmed against the ATO's own Table 4 rather than inferred.
  const TABLE_4 = { 2017: 100_000, 2018: 100_000, 2019: 100_000, 2020: 100_000,
                    2021: 110_000, 2022: 110_000, 2023: 110_000,
                    2024: 120_000, 2025: 120_000, 2026: 130_000 };
  for (const [fy, published] of Object.entries(TABLE_4)) {
    assert.equal(generalNonConcessionalCap(Number(fy)), published, `FY${fy}`);
    assert.equal(published, 4 * concessionalCap(Number(fy)), `FY${fy} is 4x`);
  }
});

test('CAP-10 s10A(6) truncates EARNINGS, and then the SG stops dead', () => {
  const base = maxContributionsBase(2026);   // 270,830
  // Mid-payment: only the slice below the base counts.
  assert.equal(countableQualifyingEarnings(30_000, base - 10_000, 2026), 10_000);
  // Past it: "treat the amount of that payment as if it were nil" — not a taper.
  assert.equal(countableQualifyingEarnings(30_000, base, 2026), 0);
  assert.equal(countableQualifyingEarnings(30_000, base + 50_000, 2026), 0);
});

// ─── Div 292 ─────────────────────────────────────────────────────────────────

test('CAP-11 the transfer balance cap is a hard nil, not a taper', () => {
  const tbc = transferBalanceCap(2026);   // 2,000,000
  const at    = nonConcessionalCap({ fyStartYear: 2026, tsb: tbc,     contributions: 10_000 });
  const under = nonConcessionalCap({ fyStartYear: 2026, tsb: tbc - 1, contributions: 10_000 });

  assert.equal(at.cap, 0);
  assert.equal(at.reason, 'TRANSFER_BALANCE_CAP');
  // One dollar under, and the whole general cap is back: s292-85(2)(b) says "equals
  // or exceeds", so there is no gradient here at all.
  assert.equal(under.cap, 130_000);
});

test('CAP-12 the bring-forward is 2x or 3x, on the first year cap space', () => {
  const g = 130_000, tbc = 2_000_000;
  const capFor = tsb => nonConcessionalCap({
    fyStartYear: 2026, tsb, age: 50, contributions: 400_000 }).cap;

  // (3)(e): space must EXCEED the general cap for any bring-forward at all.
  assert.equal(capFor(tbc - g), g, 'space exactly 1x ⇒ no bring-forward');
  // (5)(a): space at or under 2x ⇒ 2x.
  assert.equal(capFor(tbc - 2 * g), 2 * g);
  // (5)(b): "otherwise" ⇒ 3x. Note this is a two-way branch, not a ladder — a space
  // of 2.5x gives THREE years, not two.
  assert.equal(capFor(tbc - 2.5 * g), 3 * g);
  assert.equal(capFor(tbc - 10 * g), 3 * g);
});

test('CAP-13 the bring-forward needs a trigger, an age, and room', () => {
  const base = { fyStartYear: 2026, tsb: 1_000_000, age: 50, contributions: 400_000 };
  assert.equal(nonConcessionalCap(base).bringForwardTriggered, true);

  // (3)(a): contributions must actually exceed the general cap. Nobody is put into a
  // bring-forward for a contribution that fits.
  assert.equal(nonConcessionalCap({ ...base, contributions: 100_000 }).cap, 130_000);
  // (3)(c): under 75.
  assert.equal(nonConcessionalCap({ ...base, age: 75 }).cap, 130_000);
});

test('CAP-14 years two and three of an arrangement get the remainder, then nothing', () => {
  const bf = { firstFy: 2026, cap: 390_000, used: 150_000 };
  const y2 = nonConcessionalCap({ fyStartYear: 2027, tsb: 1_000_000, bringForward: bf });
  assert.equal(y2.cap, 240_000, 'the shortfall of the first year\'s cap');

  const spent = nonConcessionalCap({
    fyStartYear: 2027, tsb: 1_000_000, bringForward: { ...bf, used: 390_000 } });
  assert.equal(spent.cap, 0, 'a fully used arrangement leaves no room at all');
});

// ─── The monthly application ─────────────────────────────────────────────────

test('CAP-15 the SG alone can never breach the concessional cap', () => {
  // The interlock of CAP-7, run as arithmetic over a whole year: an earner far above
  // the base contributes exactly 12% of the base and then stops, which lands under
  // the cap by the base's rounding and no more.
  const caps = { concessionalYTD: 0, sgYTD: 0, qualifyingEarningsYTD: 0, unusedByFy: {}, tsbAtFyStart: 0 };
  let sg = 0, stoppedAt = null;
  for (let m = 1; m <= 12; m++) {
    const r = monthlyAuSuper({ fyStartYear: 2026, monthlyEarnings: 400_000 / 12,
      annualEarnings: 400_000, guaranteePct: 0.12, caps });
    if (r.sg === 0 && stoppedAt == null) stoppedAt = m;
    sg += r.sg;
    caps.concessionalYTD += r.sg;
    caps.sgYTD           += r.sg;
    caps.qualifyingEarningsYTD += 400_000 / 12;
  }
  assert.equal(+sg.toFixed(2), +(maxContributionsBase(2026) * 0.12).toFixed(2));
  assert.ok(sg <= concessionalCap(2026), 'under the cap, always');
  assert.equal(stoppedAt, 10, 'and it stops mid-year rather than tapering');
});

test('CAP-16 Div 291 rations the three streams SG → sacrifice → deductible', () => {
  // 18,000 SG + 7,500 sacrifice + 8,000 deductible = 33,500 against a 32,500 cap.
  const caps = { concessionalYTD: 0, sgYTD: 0, qualifyingEarningsYTD: 0, unusedByFy: {}, tsbAtFyStart: 0 };
  const tot = { sg: 0, sacrifice: 0, deductible: 0 };
  const clampedMonths = [];
  for (let m = 1; m <= 12; m++) {
    const r = monthlyAuSuper({ fyStartYear: 2026, monthlyEarnings: 12_500, annualEarnings: 150_000,
      guaranteePct: 0.12, sacrificePct: 0.05, deductibleAnnual: 8_000, caps });
    for (const k of ['sg', 'sacrifice', 'deductible']) tot[k] += r[k];
    caps.concessionalYTD += r.sg + r.sacrifice + r.deductible;
    caps.sgYTD           += r.sg;
    caps.qualifyingEarningsYTD += 12_500;
    if (r.clamps.includes('Div 291')) clampedMonths.push(m);
  }

  const total = +(tot.sg + tot.sacrifice + tot.deductible).toFixed(2);
  assert.equal(total, 32_500, 'the year lands exactly on the cap');
  // The employer's contribution is untouched — a member cannot decline an SG dollar,
  // so it cannot be the stream that gives way.
  assert.equal(+tot.sg.toFixed(2), 18_000);
  // The deductible gives way LAST: it is the one the member can redirect, since money
  // that cannot go in concessionally can still go in non-concessionally.
  assert.ok(tot.deductible < 8_000, 'the deductible absorbed the shortfall');
  assert.ok(tot.sacrifice > 7_000, 'the sacrifice was mostly preserved');
  assert.deepEqual(clampedMonths, [12], 'and the clamp is journalled in the month it bit');
});

test('CAP-17 carry-forward is reported as RELIEF, not as a clamp', () => {
  const r = monthlyAuSuper({
    fyStartYear: 2026, monthlyEarnings: 12_500, annualEarnings: 150_000,
    guaranteePct: 0.12, sacrificePct: 0.10,
    caps: { unusedByFy: { 2023: 20_000 }, tsbAtFyStart: 100_000 },
  });
  // 18,000 + 15,000 = 33,000 against 32,500: the excess of 500 releases 500 of cap.
  assert.equal(r.carriedForward, 500);
  assert.equal(r.concessionalCap, 33_000);
  // …and nothing was stopped, so nothing is named as having stopped it.
  assert.deepEqual(r.clamps, [], 'relief must not read as restriction');
});

test('CAP-18 the financial year is keyed by its START', () => {
  assert.equal(auFinancialYearOf(new Date(Date.UTC(2026, 6, 1))),  2026, '1 Jul 2026 ⇒ FY2026-27');
  assert.equal(auFinancialYearOf(new Date(Date.UTC(2027, 5, 30))), 2026, '30 Jun 2027 ⇒ FY2026-27');
  assert.equal(auFinancialYearOf(new Date(Date.UTC(2027, 6, 1))),  2027, 'and over the boundary');
  // A calendar-year reading would shift every cap by six months, which is silent:
  // the caps for adjacent years are often equal, so it would only surface in a year
  // the cap moved.
  assert.notEqual(concessionalCap(2025), concessionalCap(2026));
});

// ─── Regressions from the design-95 close-out review ─────────────────────────

test('CAP-19 a bring-forward arrangement is created, spent, and then stops', () => {
  // `nonConcessionalCap` reports that a year's contributions WOULD trigger an
  // arrangement, but nothing ever wrote one into state: `bringForward` stayed null
  // forever, s292-85(6)/(7)'s remainder branch was unreachable, and every financial
  // year re-evaluated as a NEW first year. A member contributing over the general cap
  // got a 3x cap EVERY year instead of once per three.
  //
  // Driven through the real settle roll rather than by hand, because the defect was
  // precisely that the handler's answer never reached state.
  const reducer = new AuTaxSettleApplyReducer({});

  const general = generalNonConcessionalCap(2026);        // 130,000
  let caps = { primary: { concessionalYTD: 0, sgYTD: 0, nonConcessionalYTD: 0,
                          qualifyingEarningsYTD: 0, unusedByFy: {}, tsbAtFyStart: 0,
                          bringForward: null, superKey: 'superAccount' } };
  const seen = [];

  for (let fy = 2026; fy <= 2030; fy++) {
    // What cap applies this year, given the arrangement state carried in?
    const cap = nonConcessionalCap({
      fyStartYear: fy, tsb: caps.primary.tsbAtFyStart, age: 50,
      contributions: 3 * general, bringForward: caps.primary.bringForward }).cap;
    seen.push(cap);

    // Contribute right up to it, then close the year.
    const contributed = cap;
    const state = {
      people: { primary: { birthDate: new Date(Date.UTC(1978, 0, 1)) } },
      superAccount: { balance: 0, ownerId: 'primary' },
      auSuperCapsByPerson: { primary: { ...caps.primary, nonConcessionalYTD: contributed } },
      effectiveExchangeRates: { USD_AUD: 1 }, baseExchangeRates: { USD_AUD: 1 },
    };
    const patch = reducer._extraStatePatches(state, {
      type: 'AU_TAX_SETTLE_APPLY', tax: 0, fxRate: 1, fyStartYear: fy,
      limitIndexFactor: 1, personTaxDetails: [{ personKey: 'primary', taxDetail: {} }],
    });
    caps = patch.auSuperCapsByPerson;
  }

  // Year one triggers: 3x the general cap. Years two and three spend the remainder,
  // which is nil because year one used it all. Year four is a fresh arrangement.
  assert.equal(seen[0], 3 * general, 'FY2026 triggers a bring-forward');
  assert.equal(seen[1], 0, 'FY2027 has nothing left');
  assert.equal(seen[2], 0, 'FY2028 has nothing left');
  assert.equal(seen[3], 3 * general, 'FY2029 may start a new one');
  assert.ok(seen.slice(0, 3).reduce((a, b) => a + b, 0) === 3 * general,
    'three years of contributions total exactly one bring-forward cap');
});

test('CAP-20 the settle resolves each member\'s own fund by ownerId', () => {
  // A two-person household has `superAccount` (one member's) and `spouseSuperAccount`
  // (the other's). Handing the same key to both would snapshot ONE balance as BOTH
  // their total superannuation balances, mis-gating the s291-20(3)(b) carry-forward
  // and the s292-85(2)(b) transfer-balance stop for both of them.
  const reducer = new AuTaxSettleApplyReducer({});

  const state = {
    people: { primary: {}, spouse: {} },
    superAccount:       { balance: 900_000, ownerId: 'primary' },
    spouseSuperAccount: { balance: 250_000, ownerId: 'spouse'  },
    auSuperCapsByPerson: {
      primary: { concessionalYTD: 0, nonConcessionalYTD: 0, unusedByFy: {}, tsbAtFyStart: 0 },
      spouse:  { concessionalYTD: 0, nonConcessionalYTD: 0, unusedByFy: {}, tsbAtFyStart: 0 },
    },
    effectiveExchangeRates: { USD_AUD: 1 }, baseExchangeRates: { USD_AUD: 1 },
  };
  const patch = reducer._extraStatePatches(state, {
    type: 'AU_TAX_SETTLE_APPLY', tax: 0, fxRate: 1, fyStartYear: 2026,
    limitIndexFactor: 1, personTaxDetails: [{ personKey: 'primary', taxDetail: {} }],
  });

  assert.equal(patch.auSuperCapsByPerson.primary.tsbAtFyStart, 900_000);
  assert.equal(patch.auSuperCapsByPerson.spouse.tsbAtFyStart,  250_000,
    'the spouse gets THEIR balance, not the household account\'s');
});
