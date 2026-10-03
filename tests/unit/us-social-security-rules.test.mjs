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
 * us-social-security-rules.test.mjs — design 118 phase 2.
 *
 *   SSR-TABLE-*: each transcribed table equals the regulation's table as saved in
 *                docs/us-social-security/ (the file is parsed, not re-typed)
 *   SSR-EX-*:    the regulation's own worked examples, before its dime/dollar rounding
 *   SSR-FRA-*, SSR-ENT-*, SSR-F-*: FRA, the entitlement month and the factor
 *   SSR-SP-*:    the spousal benefit (phase 3), including POMS RS 00615.020 method C
 *                and RS 00615.694, whose example figures are read from the saved page
 *   SSR-SV-*:    the survivor benefit (phase 4)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FRA_OWN_TABLE, FRA_SURVIVOR_TABLE, DRC_TABLE,
  fullRetirementAge, fraMonth, attainDate, attainMonth, monthIndex, monthIndexToMs,
  entitlementMonth, ownFactor, drcMonthlyRate, earlyReduction, normalizeClaimAge, SS_CLAIM_AGES,
  spousalReduction, spousalFactor, spousalPayable,
  survivorReduction, survivorFactor, survivorStartMonth, survivorBaseRatio, survivorBenefit,
} from '../../src/finance/account-rules/us/us-social-security-rules.js';

const DOCS = new URL('../../docs/us-social-security/', import.meta.url);
const read = (f) => readFileSync(new URL(f, DOCS), 'utf8');

/** 'M/D/YYYY' → 'YYYY-MM-DD'. */
const iso = (mdy) => {
  const [m, d, y] = mdy.split('/').map(Number);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

/** Each row of a saved CFR table: the `from` birth date (null for "Before …") and the cell text. */
function cfrRows(text) {
  const rows = [];
  const re = /(Before \d+\/\d+\/\d{4}|\d+\/\d+\/\d{4}—\d+\/\d+\/\d{4}|\d+\/\d+\/\d{4} and later|After \d+\/\d+\/\d{4})\s*\|\s*\n([^|]+)\|/g;
  for (const [, range, cell] of text.matchAll(re)) {
    let from;
    if (range.startsWith('Before')) from = null;
    else if (range.startsWith('After')) {
      // "After 1/1/1943" = from 1/2/1943.
      const d = new Date(Date.parse(iso(range.slice(6))) + 86_400_000);
      from = d.toISOString().slice(0, 10);
    } else from = iso(range.split(/—| and later/)[0]);
    rows.push({ from, cell: cell.trim() });
  }
  return rows;
}

const yearsMonths = (cell) => {
  const m = cell.match(/^(\d+) years(?: and (\d+) months)?\./);
  return { years: Number(m[1]), months: Number(m[2] ?? 0) };
};

// ── Tables equal the regulation on disk ────────────────────────────────────────

test('SSR-TABLE-1: FRA_OWN_TABLE is 20 CFR 404.409(a)', () => {
  const text = read('CFR-20-404.409-Full-Retirement-Age.txt');
  const partA = text.slice(text.indexOf('(a) What is'), text.indexOf('(b) What is'));
  const rows = cfrRows(partA).map(r => ({ from: r.from, ...yearsMonths(r.cell) }));
  assert.equal(rows.length, 13);
  assert.deepEqual(FRA_OWN_TABLE.map(r => ({ ...r })), rows);
});

test('SSR-TABLE-2: FRA_SURVIVOR_TABLE is 20 CFR 404.409(b)', () => {
  const text = read('CFR-20-404.409-Full-Retirement-Age.txt');
  const partB = text.slice(text.indexOf('(b) What is'), text.indexOf('(c) Can I'));
  const rows = cfrRows(partB).map(r => ({ from: r.from, ...yearsMonths(r.cell) }));
  assert.equal(rows.length, 14);
  assert.deepEqual(FRA_SURVIVOR_TABLE.map(r => ({ ...r })), rows);
});

test('SSR-TABLE-3: DRC_TABLE is 20 CFR 404.313(b)(2)', () => {
  const text = read('CFR-20-404.313-Delayed-Retirement-Credits.txt');
  const rows = cfrRows(text.slice(text.indexOf('(2) Credit percentages'), text.indexOf('Example:'))).map(r => {
    const m = r.cell.match(/^(\d+)\s*⁄\s*(\d+) of 1%/);
    return { from: r.from, num: Number(m[1]), den: Number(m[2]) };
  });
  assert.equal(rows.length, 12);
  assert.deepEqual(DRC_TABLE.map(r => ({ ...r })), rows);
});

// ── The regulation's worked examples ───────────────────────────────────────────

test('SSR-EX-1: 404.410(a) — FRA 65y8m, entitled 44 months early, PIA 980.50 ⇒ reduction 228.78', () => {
  const birth = '1941-06-15';                                   // FRA 65y8m row
  assert.deepEqual(fullRetirementAge(birth), { years: 65, months: 8 });
  const entitled = fraMonth(birth) - 44;
  const reduction = 980.50 * (1 - ownFactor(birth, entitled));
  assert.ok(Math.abs(reduction - (196.10 + 32.68)) < 0.01, `reduction ${reduction}`);
});

test('SSR-EX-2: 404.313 — Alan, born 1/15/1933, FRA Jan 1998, files Jan 1999 ⇒ 12 credits × 11/24% = 5.5%', () => {
  const birth = '1933-01-15';
  assert.equal(fraMonth(birth), monthIndex('1998-01-15'));       // attained 65 on 14 Jan 1998
  const entitled = monthIndex('1999-01-01');
  const factor = ownFactor(birth, entitled, entitled);
  assert.ok(Math.abs(factor - 1.055) < 1e-12, `factor ${factor}`);
  assert.ok(Math.abs(782.60 * (factor - 1) - 43.04) < 0.01);
});

// ── Ages and FRA ───────────────────────────────────────────────────────────────

test('SSR-FRA-1: an age is attained the day before the birthday (404.102)', () => {
  assert.equal(attainDate('1964-07-01', 62).toISOString().slice(0, 10), '2026-06-30');
  assert.equal(attainDate('1964-07-02', 62).toISOString().slice(0, 10), '2026-07-01');
  assert.equal(attainDate('1959-01-31', 66, 10).toISOString().slice(0, 10), '2025-11-29');
});

test('SSR-FRA-2: 1 Jan births fall in the previous year\'s row', () => {
  assert.deepEqual(fullRetirementAge('1960-01-01'), { years: 66, months: 10 });
  assert.deepEqual(fullRetirementAge('1960-01-02'), { years: 67, months: 0 });
  assert.deepEqual(fullRetirementAge('1962-01-01', 'survivor'), { years: 66, months: 10 });
  assert.deepEqual(fullRetirementAge('1962-01-02', 'survivor'), { years: 67, months: 0 });
});

// ── Entitlement month (404.311(a)) ─────────────────────────────────────────────

test('SSR-ENT-1: before FRA, the first month the person is that age throughout', () => {
  // Born 15 Mar 1964: attains 62 on 14 Mar 2026, so 62 throughout from April.
  assert.equal(entitlementMonth('1964-03-15', 62), monthIndex('2026-04-01'));
  // Born 2 Mar 1964: attains 62 on 1 Mar 2026, so March itself.
  assert.equal(entitlementMonth('1964-03-02', 62), monthIndex('2026-03-01'));
});

test('SSR-ENT-2: from FRA on, the month the age is attained', () => {
  assert.equal(entitlementMonth('1964-03-15', 67), monthIndex('2031-03-01'));
  assert.equal(entitlementMonth('1964-03-15', 70), monthIndex('2034-03-01'));
  assert.equal(entitlementMonth('1964-03-15', null), fraMonth('1964-03-15'));
});

test('SSR-ENT-3: a whole-year claim before a part-year FRA is still early', () => {
  // FRA 66y10m: a claim at 66 is 10 months early (minus the "throughout" month).
  const birth = '1959-06-20';
  assert.equal(fraMonth(birth) - entitlementMonth(birth, 66), 9);
  // and a claim at 67 is two months past FRA
  assert.equal(entitlementMonth(birth, 67) - fraMonth(birth), 2);
});

test('SSR-ENT-4: claim ages are whole years 62–70; blank means FRA', () => {
  assert.deepEqual(SS_CLAIM_AGES, [62, 63, 64, 65, 66, 67, 68, 69, 70]);
  assert.equal(normalizeClaimAge(''), null);
  assert.equal(normalizeClaimAge(null), null);
  assert.equal(normalizeClaimAge('64'), 64);
  for (const bad of [61, 71, 66.5, 'x']) assert.throws(() => normalizeClaimAge(bad), /ssClaimAge/);
});

// ── The factor ─────────────────────────────────────────────────────────────────

test('SSR-F-1: FRA 67, claimed on the 2nd-birthday boundary: 70% … 100% … 124%', () => {
  const birth = '1964-07-02';                                     // attains each age on the 1st
  const f = (age) => ownFactor(birth, entitlementMonth(birth, age));
  const expect = { 62: 0.70, 63: 0.75, 64: 0.80, 65: 1 - 0.4 / 3, 66: 1 - 0.2 / 3,
                   67: 1, 68: 1.08, 69: 1.16, 70: 1.24 };
  for (const [age, want] of Object.entries(expect)) {
    assert.ok(Math.abs(f(Number(age)) - want) < 1e-12, `age ${age}: ${f(Number(age))} vs ${want}`);
  }
});

test('SSR-F-2: credits earned in the filing year arrive the next January (404.313(c)(3))', () => {
  const birth = '1964-07-02';                                     // FRA Jul 2031
  const ent = entitlementMonth(birth, 68);                        // Jul 2032
  assert.equal(monthIndexToMs(ent), Date.UTC(2032, 6, 1));
  const rate = drcMonthlyRate(birth);
  // Jul–Dec 2031 (6 credits) are in the initial amount; Jan–Jun 2032 arrive Jan 2033.
  assert.ok(Math.abs(ownFactor(birth, ent, ent)          - (1 + 6 * rate))  < 1e-12);
  assert.ok(Math.abs(ownFactor(birth, ent, ent + 5)      - (1 + 6 * rate))  < 1e-12);
  assert.ok(Math.abs(ownFactor(birth, ent, monthIndex('2033-01-01')) - (1 + 12 * rate)) < 1e-12);
});

test('SSR-F-3: filing at 70 applies every credit at once (404.313(c)(2))', () => {
  const birth = '1964-07-02';
  const ent = entitlementMonth(birth, 70);
  assert.equal(ent, attainMonth(birth, 70));
  assert.ok(Math.abs(ownFactor(birth, ent, ent) - 1.24) < 1e-12);
});

test('SSR-F-4: the 404.410(a) reduction switches rate after 36 months', () => {
  assert.ok(Math.abs(earlyReduction(36) - 0.20) < 1e-12);
  assert.ok(Math.abs(earlyReduction(60) - 0.30) < 1e-12);
  assert.equal(earlyReduction(0), 0);
});

// ── The spousal benefit (phase 3) ─────────────────────────────────────────────

test('SSR-SP-EX-1: 404.410(b) — FRA 65y4m, spousal from 63, 28 months early, 412.40 ⇒ reduction 80.18', () => {
  assert.match(read('CFR-20-404.410-Reduction-Before-Full-Retirement-Age.txt'),
    /\$412\.40 × 28 ×\s*25\/36 × \.01\. The resulting \$80\.18/);
  const birth = '1939-06-15';                                     // FRA 65y4m row
  assert.deepEqual(fullRetirementAge(birth), { years: 65, months: 4 });
  const reduction = 412.40 * (1 - spousalFactor(birth, fraMonth(birth) - 28));
  assert.ok(Math.abs(reduction - 80.18) < 0.01, `reduction ${reduction}`);   // CFR truncates 80.189
});

test('SSR-SP-EX-2: POMS RS 00615.020 method C — full RIB off the full spouse benefit, then each reduced', () => {
  const text = read('POMS-RS-00615.020-Dual-Entitlement-Overview.txt');
  assert.match(text, /spouse is entitled to a benefit of \$1000 before reduction[\s\S]*RIB of \$400 before reduction[\s\S]*excess \(\$600\) is then reduced to \$540\. The RIB is reduced to \$380\.\s*The total payable is \$920/);
  const spousal = spousalPayable({ ownPia: 400, workerPia: 2000, ownBenefit: 380, ownBenefitNoDrc: 380, factor: 540 / 600 });
  assert.ok(Math.abs(spousal - 540) < 1e-9);
  assert.ok(Math.abs(380 + spousal - 920) < 1e-9);
});

test('SSR-SP-EX-3: POMS RS 00615.694 — delayed credits on the own benefit come out of the spousal excess', () => {
  const text = read('POMS-RS-00615.694-DRCs-In-Dual-Entitlement.txt');
  for (const step of ['RIB MBA in 4/02 is $400.00', 'Unreduced spouse benefit is $800 ($1600/2)',
    'Excess spouse benefit is $300 ($800 - $500)', 'RIB with DRCs is $410.00', 'Spouse payment is $290 ($700 - $410)']) {
    assert.ok(text.includes(step), step);
  }
  const spousal = spousalPayable({ ownPia: 500, workerPia: 1600, ownBenefit: 410, ownBenefitNoDrc: 400, factor: 1 });
  assert.ok(Math.abs(spousal - 290) < 1e-9);
});

test('SSR-SP-1: FRA 67 spousal factors: 65% at 62 … 100% from 67, never above', () => {
  const birth = '1964-07-02';
  const f = (age) => spousalFactor(birth, entitlementMonth(birth, age));
  const expect = { 62: 0.65, 63: 0.70, 64: 0.75, 65: 1 - 0.5 / 3, 66: 1 - 0.25 / 3, 67: 1, 70: 1 };
  for (const [age, want] of Object.entries(expect)) {
    assert.ok(Math.abs(f(Number(age)) - want) < 1e-12, `age ${age}: ${f(Number(age))} vs ${want}`);
  }
  assert.ok(Math.abs(spousalReduction(36) - 0.25) < 1e-12);
  assert.ok(Math.abs(spousalReduction(48) - 0.30) < 1e-12);
});

test('SSR-SP-2: own PIA at or above half the worker\'s ⇒ no spousal benefit (404.330(d))', () => {
  for (const ownPia of [1000, 1200]) {
    assert.equal(spousalPayable({ ownPia, workerPia: 2000, ownBenefit: ownPia, ownBenefitNoDrc: ownPia, factor: 1 }), 0);
  }
});

test('SSR-SP-3: no record of their own ⇒ half the worker\'s PIA, reduced by the spousal factor', () => {
  assert.ok(Math.abs(spousalPayable({ ownPia: 0, workerPia: 3000, ownBenefit: 0, ownBenefitNoDrc: 0, factor: 0.65 })
    - 975) < 1e-9);
});

test('SSR-SP-4: credits large enough to cover the excess suspend the spousal amount (not below zero)', () => {
  // Own 900 claimed at 70 (×1.24 = 1116); half the worker's PIA is 1000, excess 100 < 216 of credits.
  assert.equal(spousalPayable({ ownPia: 900, workerPia: 2000, ownBenefit: 1116, ownBenefitNoDrc: 900, factor: 1 }), 0);
});

// ── The survivor benefit (phase 4) ────────────────────────────────────────────

test('SSR-SV-EX-1: 404.410(c)(1) — survivor FRA 65y4m, from 64, 16 of 64 months, 785.70 ⇒ reduction 55.98', () => {
  assert.match(read('CFR-20-404.410-Reduction-Before-Full-Retirement-Age.txt'),
    /\$785\.70 × 16 × \.285 divided by 64 or \$55\.98/);
  const birth = '1941-06-15';                                     // survivor-table FRA 65y4m
  assert.deepEqual(fullRetirementAge(birth, 'survivor'), { years: 65, months: 4 });
  const start = fraMonth(birth, 'survivor') - 16;
  assert.equal(fraMonth(birth, 'survivor') - attainMonth(birth, 60), 64);
  assert.ok(Math.abs(785.70 * survivorReduction(birth, start) - 55.98) < 0.01);
});

test('SSR-SV-1: survivor FRA 67 ⇒ 28.5% at 60, about 20.4% at 62, none from FRA', () => {
  const birth = '1964-07-02';                                     // ages attained on the 1st
  const sFra = fraMonth(birth, 'survivor');
  assert.equal(sFra - attainMonth(birth, 60), 84);
  assert.ok(Math.abs(survivorReduction(birth, attainMonth(birth, 60)) - 0.285) < 1e-12);
  assert.ok(Math.abs(survivorReduction(birth, attainMonth(birth, 62)) - 0.285 * 60 / 84) < 1e-12);
  assert.equal(survivorFactor(birth, sFra), 1);
  assert.equal(survivorFactor(birth, sFra + 30), 1);
});

const DEC = '1964-07-02';                                        // deceased: FRA Jul 2031, 70 in Jul 2034

test('SSR-SV-2: deceased claimed at 62 ⇒ survivor capped at the larger of the RIB-LIM and 82½% (404.338(c))', () => {
  const t = survivorBaseRatio({ birthDate: DEC, entitledMi: entitlementMonth(DEC, 62), deathMi: monthIndex('2040-03-10') });
  assert.deepEqual(t, { ratio: 1, ribLimCap: 0.825 });           // 70% < 82½%
  // an unreduced survivor is cut to 82½%; one reduced below it keeps their own reduction
  assert.ok(Math.abs(survivorBenefit({ pia: 2000, ...t, factor: 1 }) - 1650) < 1e-9);
  assert.ok(Math.abs(survivorBenefit({ pia: 2000, ...t, factor: 0.75 }) - 1500) < 1e-9);
  // claimed at 66 (93⅓%): the RIB-LIM is the cap
  const at66 = survivorBaseRatio({ birthDate: DEC, entitledMi: entitlementMonth(DEC, 66), deathMi: monthIndex('2040-03-10') });
  assert.ok(Math.abs(at66.ribLimCap - (1 - 0.2 / 3)) < 1e-12);
});

test('SSR-SV-3: deceased claimed at 70 ⇒ the survivor inherits every credit (404.338(b))', () => {
  const t = survivorBaseRatio({ birthDate: DEC, entitledMi: entitlementMonth(DEC, 70), deathMi: monthIndex('2040-03-10') });
  assert.ok(Math.abs(t.ratio - 1.24) < 1e-12);
  assert.equal(t.ribLimCap, null);
});

test('SSR-SV-4: died at 68 without claiming ⇒ credits to the month before death; the January wait is ignored', () => {
  // Dies in Sep 2032: Jul 2031–Aug 2032 is 14 credits, though 8 were earned in the death year.
  const t = survivorBaseRatio({ birthDate: DEC, entitledMi: null, deathMi: monthIndex('2032-09-20') });
  assert.ok(Math.abs(t.ratio - (1 + 14 * 2 / 3 / 100)) < 1e-12);
  // a late claimant who dies in the filing year also passes on every credit (402(e)(2)(C))
  const late = survivorBaseRatio({ birthDate: DEC, entitledMi: entitlementMonth(DEC, 68), deathMi: monthIndex('2032-09-20') });
  assert.ok(Math.abs(late.ratio - 1.08) < 1e-12);
  // dying before FRA without a claim leaves the plain PIA
  assert.deepEqual(survivorBaseRatio({ birthDate: DEC, entitledMi: null, deathMi: monthIndex('2029-01-15') }),
    { ratio: 1, ribLimCap: null });
});

test('SSR-SV-5: a survivor under their FRA at the death waits for their claim month, and no later than survivor FRA (D10)', () => {
  const surv = '1966-07-02';                                      // 62 in Jul 2028, survivor FRA Jul 2033
  const death = monthIndex('2027-05-10');
  assert.equal(survivorStartMonth(surv, entitlementMonth(surv, 62), death), monthIndex('2028-07-01'));
  assert.equal(survivorStartMonth(surv, entitlementMonth(surv, 70), death), fraMonth(surv, 'survivor'));
  // widowed after their own claim: from the death month
  assert.equal(survivorStartMonth(surv, entitlementMonth(surv, 62), monthIndex('2030-02-03')), monthIndex('2030-02-01'));
  const w = survivorBenefit({ pia: 2000, ratio: 1, ribLimCap: null,
    factor: survivorFactor(surv, monthIndex('2028-07-01')) });
  assert.ok(Math.abs(w - 2000 * (1 - 0.285 * 60 / 84)) < 1e-9);
});
