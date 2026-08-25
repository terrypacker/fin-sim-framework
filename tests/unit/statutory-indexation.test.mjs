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
 * statutory-indexation.test.mjs — design 95 §10, phase 9.
 *
 * Projecting a published contribution limit past the last year an authority has
 * published it for. Three properties carry the whole feature:
 *
 *   1. inside the published range NOTHING moves, whatever the factor;
 *   2. past it the level is multiplied and then rounded DOWN once (s960-285(2)),
 *      never rounded per year — which would compound a loss of up to a full step
 *      annually;
 *   3. a factor of 1 or less does not index at all (s960-285(4)) — caps never fall.
 *
 * ITAA97 s960-285 states all three explicitly and carries two worked examples;
 * IDX-3 replays them. The US provisions are drafted as an adjustment to the
 * "increase" rather than to the level, and reach the same place because their bases
 * are multiples of the step.
 *
 * Run with: node --test tests/unit/statutory-indexation.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { indexLimit, ROUNDING } from '../../src/finance/tax/statutory-indexation.js';
import {
  usContributionLimits, LAST_PUBLISHED_YEAR, US_CONTRIBUTION_LIMITS_BY_YEAR,
} from '../../src/finance/tax/us/us-contribution-limits.js';
import {
  concessionalCap, generalNonConcessionalCap, maxContributionsBase,
  transferBalanceCap, LAST_PUBLISHED_FY, SG_CHARGE_PERCENTAGE,
} from '../../src/finance/tax/au/au-super-limits.js';

// ─── The rule ────────────────────────────────────────────────────────────────

test('IDX-1 a factor of 1 or less does not index at all (s960-285(4))', () => {
  // The note under s291-20(2) — "annual indexation does not necessarily increase the
  // amount of the cap" — is this rule. Caps are monotonic non-decreasing: a
  // deflationary year leaves one where it was and never claws it back.
  assert.equal(indexLimit(24_500, 1,    500), 24_500);
  assert.equal(indexLimit(24_500, 0.98, 500), 24_500, 'deflation must not cut the cap');
  assert.equal(indexLimit(24_500, 0,    500), 24_500);

  // Guarding rather than letting the arithmetic through is what matters here: a
  // factor of 0.999 would otherwise round the level DOWN a whole step, turning a
  // mild deflation into a $500 cut no statute authorises.
  assert.equal(indexLimit(24_500, 0.999, 500), 24_500);
});

test('IDX-2 the level is rounded down once, not each year', () => {
  // Rounding the level: 24,500 x 1.03 = 25,235 → 25,000.
  assert.equal(indexLimit(24_500, 1.03, 500), 25_000);

  // Rounding EACH YEAR's increment would lose up to a full step annually and
  // compound. Ten years at 3%, done the wrong way, against the right way:
  let perYear = 24_500;
  for (let i = 0; i < 10; i++) perYear = Math.floor((perYear * 1.03) / 500) * 500;
  const onLevel = indexLimit(24_500, Math.pow(1.03, 10), 500);

  assert.ok(onLevel > perYear,
    `rounding the level (${onLevel}) must not lose ground to per-year rounding (${perYear})`);
  assert.ok(onLevel - perYear >= 500, 'and the gap is real, not a rounding artefact');
});

test('IDX-3 reproduces both worked examples in s960-285(2)', () => {
  // Example 1: "An amount of $140,000 is to be indexed, with a rounding amount of
  // $5,000. If the indexation factor increases this to an indexed amount of $143,000,
  // the indexed amount is rounded back down to $140,000."
  assert.equal(indexLimit(140_000, 143_000 / 140_000, 5_000), 140_000);

  // Example 2: "...to an indexed amount of $146,000, the indexed amount is rounded
  // down to $145,000."
  assert.equal(indexLimit(140_000, 146_000 / 140_000, 5_000), 145_000);
});

test('IDX-4 every rounding step is the one its own provision sets', () => {
  // Six provisions, three distinct steps on the US side and two more on the AU side.
  // A single shared step would be wrong for most of them, which is why they are named.
  assert.equal(ROUNDING.US_ELECTIVE_DEFERRAL,    500);     // §402(g)(4)
  assert.equal(ROUNDING.US_CATCH_UP,             500);     // §414(v)(2)(C)
  assert.equal(ROUNDING.US_ANNUAL_ADDITIONS,   1_000);     // §415(d)(4)(B)
  assert.equal(ROUNDING.US_COMPENSATION,       5_000);     // §401(a)(17)(B)
  assert.equal(ROUNDING.AU_CONCESSIONAL_CAP,   2_500);     // s960-285(7) item 2
  assert.equal(ROUNDING.AU_TRANSFER_BALANCE_CAP, 100_000); // s960-285(7) item 3
});

// ─── The published range is inviolable ───────────────────────────────────────

test('IDX-5 inside the published range the transcribed figures stand, whatever the factor', () => {
  // The authority's number for a year it has published is not ours to adjust, and a
  // caller whose accumulator has drifted must not be able to move it.
  for (const [year, published] of Object.entries(US_CONTRIBUTION_LIMITS_BY_YEAR)) {
    if (Number(year) >= LAST_PUBLISHED_YEAR) continue;
    assert.deepEqual(usContributionLimits(Number(year), { indexFactor: 3 }), published,
      `${year} must be immune to the factor`);
  }
  assert.equal(concessionalCap(2021, 5), 27_500);
  assert.equal(transferBalanceCap(2021, 5), 1_700_000);
});

test('IDX-6 no factor ⇒ the pre-phase-9 behaviour exactly', () => {
  // Every non-simulation caller — a unit test, a report, a UI probe — gets the last
  // published table unchanged. That is what kept phases 3 and 7 additive.
  assert.deepEqual(usContributionLimits(2040), US_CONTRIBUTION_LIMITS_BY_YEAR[LAST_PUBLISHED_YEAR]);
  assert.equal(concessionalCap(2040), concessionalCap(LAST_PUBLISHED_FY));
  assert.equal(maxContributionsBase(2040), maxContributionsBase(LAST_PUBLISHED_FY));
});

// ─── The projections ─────────────────────────────────────────────────────────

test('IDX-7 the US limits project on their own steps', () => {
  const f = Math.pow(1.025, 10);
  const p = usContributionLimits(2036, { indexFactor: f });

  // Each lands on a multiple of its own provision's step, not a shared one.
  assert.equal(p.electiveDeferral % ROUNDING.US_ELECTIVE_DEFERRAL, 0);
  assert.equal(p.annualAdditions  % ROUNDING.US_ANNUAL_ADDITIONS,  0);
  assert.equal(p.compensation     % ROUNDING.US_COMPENSATION,      0);

  // …and every one has actually grown, so the assertions above are not passing on
  // unchanged published figures that happen to be multiples already.
  const base = US_CONTRIBUTION_LIMITS_BY_YEAR[LAST_PUBLISHED_YEAR];
  for (const k of ['electiveDeferral', 'annualAdditions', 'compensation']) {
    assert.ok(p[k] > base[k], `${k} must project upward`);
  }
});

test('IDX-8 indexing the AU cap carries the two figures derived from it', () => {
  const f = Math.pow(1.025, 10);
  const cap = concessionalCap(2036, f);

  assert.ok(cap > concessionalCap(LAST_PUBLISHED_FY), 'control: the cap really moved');
  assert.equal(cap % ROUNDING.AU_CONCESSIONAL_CAP, 0);

  // s292-85(2)(a) — 4x, and the relation survives the projection exactly as it holds
  // in every published row.
  assert.equal(generalNonConcessionalCap(2036, f), 4 * cap);

  // SGAA s10A(5) — and so does the interlock that makes the whole cap structure
  // coherent: 12% of the projected base is the projected cap, to within the base's
  // own $10 rounding. If indexation broke this, the Super Guarantee alone could
  // start producing excess concessional contributions.
  const base = maxContributionsBase(2036, f);
  const sgOnBase = base * SG_CHARGE_PERCENTAGE / 100;
  assert.ok(sgOnBase <= cap, `12% of the projected base (${sgOnBase}) must not exceed ${cap}`);
  assert.ok(cap - sgOnBase < 10 * SG_CHARGE_PERCENTAGE / 100 + 0.01);
});

test('IDX-9 the transfer balance cap moves in long flat steps', () => {
  // A $100,000 rounding amount on a $2,000,000 cap means roughly one step every four
  // years at 2.5% — the cap is FLAT in between, which is what the published history
  // shows too (1.6M for four years, then 1.7M for two).
  const at = years => transferBalanceCap(2027 + years, Math.pow(1.025, years + 1));
  const seen = [at(0), at(1), at(2), at(3), at(4), at(5)];

  assert.equal(seen[0], 2_000_000, 'still flat after one year');
  assert.ok(seen.every(v => v % ROUNDING.AU_TRANSFER_BALANCE_CAP === 0));
  // Monotonic non-decreasing, and it does eventually move.
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1]);
  assert.ok(seen[seen.length - 1] > seen[0], 'and it is not frozen forever');
});

// ─── The accumulator's anchor ────────────────────────────────────────────────

test('IDX-10 the limit accumulator is anchored at the PUBLISHED horizon, not sim start', async () => {
  // This is the whole reason it is a third accumulator rather than a reuse of
  // `inflationAccumulator`. That one is 1.0 at SIM START, which is right for wages
  // and expenses and wrong for a published limit: the authority's figure for 2026
  // already contains the inflation up to 2026, and indexing it from sim start would
  // count that inflation twice.
  const { InflationAdjustReducer } = await import('../../src/finance/reducers/inflation-adjust-reducer.js');
  const r = new InflationAdjustReducer();

  const stateAt = year => ({
    inflationRates: { US: 0.03 },
    currentPeriods: { US: { startMs: Date.UTC(year, 0, 1) } },
    inflationAccumulator: { US: 1 },
    limitIndexAccumulator: { US: 1 },
  });

  // A period advance INTO the published horizon year must not index anything.
  const atHorizon = r.reduce(stateAt(LAST_PUBLISHED_YEAR), { type: 'US_PERIOD_ADVANCE' });
  assert.equal(atHorizon.limitIndexAccumulator.US, 1, 'the published year is not projected');
  assert.ok(atHorizon.inflationAccumulator.US > 1,
    'control: the wage accumulator DID advance, so the two are genuinely different');

  // The first year past it does.
  const past = r.reduce(stateAt(LAST_PUBLISHED_YEAR + 1), { type: 'US_PERIOD_ADVANCE' });
  assert.ok(Math.abs(past.limitIndexAccumulator.US - 1.03) < 1e-9);
});

test('IDX-11 the two countries index off their own horizons and their own years', async () => {
  // The AU key is a FINANCIAL year start and the US key a calendar year, which is
  // what `currentPeriods[cc].startMs` yields for each — 1 July against 1 January.
  // Reading one with the other's convention would shift a whole country's caps by a
  // year, silently, since adjacent years' caps are often equal.
  const { InflationAdjustReducer } = await import('../../src/finance/reducers/inflation-adjust-reducer.js');
  const r = new InflationAdjustReducer();

  const auAtHorizon = r.reduce({
    inflationRates: { AU: 0.03 },
    currentPeriods: { AU: { startMs: Date.UTC(LAST_PUBLISHED_FY, 6, 1) } },
    limitIndexAccumulator: { AU: 1 },
  }, { type: 'AU_PERIOD_ADVANCE' });
  assert.equal(auAtHorizon.limitIndexAccumulator.AU, 1, 'FY2026-27 is published, not projected');

  const auPast = r.reduce({
    inflationRates: { AU: 0.03 },
    currentPeriods: { AU: { startMs: Date.UTC(LAST_PUBLISHED_FY + 1, 6, 1) } },
    limitIndexAccumulator: { AU: 1 },
  }, { type: 'AU_PERIOD_ADVANCE' });
  assert.ok(Math.abs(auPast.limitIndexAccumulator.AU - 1.03) < 1e-9);
});

test('IDX-12 a live run indexes the caps and leaves the first year alone', async () => {
  const { specByName }   = await import('../helpers/golden-specs.js');
  const { IntlRetirementScenario } = await import('../../src/scenarios/intl-retirement-scenario.js');
  const { openSim, quiet } = await import('../../scripts/lib/run.mjs');

  const spec = specByName('payroll-limits');
  const cfg  = IntlRetirementScenario.buildDefaultConfig(
    { fxProcessModel: 'NONE', ...spec.params }, spec.simStart, spec.simEnd);
  const sim  = quiet(() => openSim(cfg, { telemetry: 'journal' }));
  quiet(() => sim.stepTo(new Date(cfg.simEnd)));

  const seen = new Set(); const byYear = {};
  for (const e of sim.journal.journal) {
    if (e.action?.type !== 'K401_CONTRIBUTION_APPLY') continue;
    if (seen.has(e.action.instanceId)) continue;
    seen.add(e.action.instanceId);
    const d = e.action.data ?? {};
    if (d.employerFunded || d.personKey !== 'primary') continue;
    const y = new Date(e.date).getUTCFullYear();
    byYear[y] = +((byYear[y] ?? 0) + (d.amount ?? 0)).toFixed(2);
  }

  // 2026 is the published year: the earner exhausts §402(g) at exactly the
  // transcribed $24,500, indexation or not.
  assert.equal(byYear[2026], US_CONTRIBUTION_LIMITS_BY_YEAR[2026].electiveDeferral);
  // Every later year is strictly larger — this golden's earner is above every limit,
  // so the deferral IS the limit and tracks it year by year.
  const years = Object.keys(byYear).map(Number).sort((a, b) => a - b);
  for (let i = 1; i < years.length; i++) {
    assert.ok(byYear[years[i]] > byYear[years[i - 1]],
      `${years[i]} (${byYear[years[i]]}) must exceed ${years[i - 1]} (${byYear[years[i - 1]]})`);
  }
  assert.ok(sim.state.limitIndexAccumulator.US > 1, 'and the accumulator really ran');
});
