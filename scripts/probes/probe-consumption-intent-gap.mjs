#!/usr/bin/env node
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
 * probe-consumption-intent-gap.mjs — design 89 §5.1 step A, and the step-D regression
 * detector it became.
 *
 * `AccumulateConsumptionReducer` builds `state.cumulativeConsumption` — the quantity
 * the `consumption` and `DIE_WITH_TARGET` objectives maximize. Until design 89 §5.4
 * it read **`action.amount`**, while `ExpenseDebitReducer` caps the money at the
 * balance:
 *
 *     const debit = Math.min(action.amount, Math.max(0, account.balance));
 *
 * Both reducers see the same dispatched action, so on a plan that runs short the
 * accumulator books consumption the household never received. This probe measures
 * how much, per year, and in the objective's own units.
 *
 * ─── the two numbers, and why both are needed ────────────────────────────────
 *
 *   NOMINAL gap — Σ intent − Σ realized, in the debited account's own currency.
 *                 Easy to read, but a face-value sum across USD and AUD.
 *   REAL gap    — the same difference put through the reducer's OWN arithmetic:
 *                 FX-convert AUD to USD, then deflate by the residence price
 *                 level. This is what the objective actually sees, and it is the
 *                 number that decides whether design 89 §5.1 step D matters.
 *
 * Both figures are CROSS-CHECKED against the run's own `state.cumulativeConsumption`,
 * and the probe reports WHICH ONE the engine matched. That check began as a guard on
 * the probe's own faithfulness — a measurement of a bug is worthless if it is measured
 * by a second bug — and step D turned it into a permanent regression detector: the
 * engine must now match REALIZED, and matching INTENT again means either the
 * accumulators regressed or `realizedAmount` stopped being stamped.
 *
 * ─── the 3x trap (design 89 §10) ─────────────────────────────────────────────
 *
 * `EXPENSE_DEBIT` is journaled once per consuming reducer — three times — with an
 * identical payload. Intent is therefore summed over DISTINCT DISPATCHES
 * (`entry.action.instanceId`, which is the dispatched action's identity and is
 * shared by all three entries), never over entries and never by dividing by three:
 * a fourth reducer would silently make that divisor wrong.
 *
 * The CROSS-CHECK earned its keep here. The first version of this probe grouped on
 * `entry.action.id`, which does not exist — every entry looked like its own dispatch,
 * intent came out at exactly 3x, and the gap read as a spectacular 66.7%. That is the
 * design 89 §10 trap reproducing itself inside the tool built to measure a different
 * bug. The cross-check said "200% error, not faithful" and refused to endorse the
 * numbers. Keep it wired.
 *
 * ─── the expected result, stated in advance ──────────────────────────────────
 *
 * On any solvent plan the cap never binds, so the gap is EXACTLY zero and the two
 * candidate sources are indistinguishable. That is why `--stress` exists: a defect
 * that cannot be provoked cannot be characterised. It is also why step D was safe —
 * it changed nothing on any plan that does not run short.
 *
 * Usage:
 *   node scripts/probes/probe-consumption-intent-gap.mjs [--scenario <file.json>] [--index <n>]
 *                                                        [--stress <multiplier>]
 *
 *   --stress <x>  multiply monthly expenses by x before running, to force the cap
 *                 to bind. The probe reports `cumulativeDeficit` so a stress that
 *                 did not actually break the plan is visible rather than assumed.
 */

import { openSim }                        from '../lib/run.mjs';
import { loadBaseConfig, parseSourceArgs, describeSource } from '../lib/scenario-source.mjs';
import { JournalFxRates }                 from '../../src/finance/journal-reporting/report-currency.js';
import { AccumulateConsumptionUtilityReducer } from '../../src/finance/reducers/accumulate-consumption-utility-reducer.js';

// ─── args ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) {
  const { readFileSync } = await import('node:fs');
  const src  = readFileSync(new URL(import.meta.url), 'utf8');
  const from = src.indexOf('/**');
  console.log(src.slice(from, src.indexOf('*/', from) + 2));
  process.exit(0);
}
const flag   = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const stress = Number(flag('--stress') ?? 1);

const source = loadBaseConfig(parseSourceArgs(argv));
const cfg    = source.cfg;

// ─── stress: scale every expense lever, both param stores plus initialState ──
//
// [[two-param-stores-trap]] — cfg.params is an authored LIST and cfg.parameters a
// flat BAG; which one is populated depends on where the cfg came from, and setting
// only one is silently inert. initialState shadows both, so it is scaled too.
if (stress !== 1) {
  const scale = (v) => (typeof v === 'number' ? v * stress : v);
  for (const p of cfg.params ?? []) {
    if (p.name === 'monthlyExpenses') p.value = scale(p.value);
    if (p.name === 'spendingExpenseBands' && Array.isArray(p.value)) {
      p.value = p.value.map(b => ({ ...b, monthlyAmount: scale(b.monthlyAmount) }));
    }
  }
  if (cfg.parameters?.monthlyExpenses != null) {
    cfg.parameters = { ...cfg.parameters, monthlyExpenses: scale(cfg.parameters.monthlyExpenses) };
  }
  if (cfg.initialState?.monthlyExpenses != null) {
    cfg.initialState = { ...cfg.initialState, monthlyExpenses: scale(cfg.initialState.monthlyExpenses) };
  }
}

// ─── run ─────────────────────────────────────────────────────────────────────

const sim = openSim(cfg, { telemetry: 'full' });
sim.stepTo(new Date(cfg.simEnd));
const entries = sim.journal.journal ?? [];

console.log('design 89 §5.1 step A — the consumption intent gap');
console.log(describeSource(source));
console.log(`stress: ${stress}x monthly expenses` + (stress === 1 ? '  (unstressed)' : ''));
console.log(`journal: ${entries.length} entries\n`);

// ─── the price-level series, seq-ordered ─────────────────────────────────────
//
// `JournalFxRates` does this for the exchange rate; there is no shipped equivalent
// for the inflation accumulator (design 89 §9.b.1 proposes one as JournalPriceLevels,
// and this is the sketch of it). Seq rather than ts: several entries share a date,
// and the reducer sees whatever the previous entry left behind.
function priceLevelSeries(journal, cc) {
  const field  = `inflationAccumulator.${cc}`;
  const points = [];
  for (const e of journal) {
    for (const d of (e.stateDiff ?? [])) {
      if (d.field !== field) continue;
      if (points.length === 0 && typeof d.before === 'number') points.push({ seq: -1, v: d.before });
      if (typeof d.after === 'number') points.push({ seq: e.seq, v: d.after });
    }
  }
  return (seq) => {
    if (points.length === 0) return 1;
    let lo = 0, hi = points.length - 1;
    if (seq <= points[0].seq) return points[0].v;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (points[mid].seq <= seq) lo = mid; else hi = mid - 1; }
    return points[lo].v;
  };
}

const priceLevel = { US: priceLevelSeries(entries, 'US'), AU: priceLevelSeries(entries, 'AU') };
const fx = new JournalFxRates(sim.journal, {
  fallbackRate: () => sim.state?.effectiveExchangeRates?.USD_AUD ?? null,
});

// ─── walk the EXPENSE_DEBIT dispatches ───────────────────────────────────────

const years = new Map();   // year -> { intent, realized, realIntent, realRealized, n, capped }
const seen  = new Set();   // action ids already counted for intent (the 3x trap)
let idless  = 0;

for (const e of entries) {
  if (e.action?.type !== 'EXPENSE_DEBIT') continue;

  const d      = e.action.data ?? e.action;
  const amount = d.amount ?? 0;
  const key    = d.targetKey;

  // Realized: only the entry whose reducer actually moved money carries a delta.
  let realized = 0;
  for (const diff of (e.stateDiff ?? [])) {
    if (!(diff.field ?? '').endsWith('.balance')) continue;
    if ((diff.delta ?? 0) < 0) realized += -(diff.delta);
  }

  // Intent: once per DISPATCH. `action.instanceId` is the dispatched action's own
  // identity and is shared by all three entries (`Expense Debit`, `Accumulate
  // Consumption`, `Accumulate Consumption Utility`). Fall back to a composite key
  // only if a build ever omits it — and say so, because a silent fallback here
  // reintroduces the 3x trap.
  const id = e.action?.instanceId ?? null;
  if (id == null) idless++;
  const dispatchKey = id ?? `${e.date}|${key}|${amount}`;
  const firstSight  = !seen.has(dispatchKey);
  if (firstSight) seen.add(dispatchKey);

  const year = new Date(e.date).getUTCFullYear();
  const row  = years.get(year)
    ?? { intent: 0, realized: 0, realIntent: 0, realRealized: 0, uIntent: 0, uRealized: 0, n: 0, capped: 0 };

  // The reducer's own arithmetic: FX-convert, then deflate by the residence level.
  const code = sim.state?.[key]?.currency?.code ?? 'USD';
  const cc   = code === 'AUD' ? 'AU' : 'US';
  const rate = fx.rateAt(new Date(e.date).getTime()) ?? 1;
  const toUsd = (v) => (code === 'AUD' ? v / rate : v);
  const real  = (v) => toUsd(v) / (priceLevel[cc](e.seq) || 1);

  // The CRRA companion, computed from the SAME two candidate sources. Its utility
  // function is imported rather than re-derived: design 89 §5.4.1 rests on its exact
  // shape (u = 2 - 2/sqrt(c) at gamma=1.5, floor=1, bounded on [0,2)), and a probe
  // that re-implemented it could agree with a wrong formula.
  const u = (c) => AccumulateConsumptionUtilityReducer.utility(c);

  if (firstSight) {
    row.intent     += amount;
    row.realIntent += real(amount);
    row.uIntent    += u(real(amount));
    row.uRealized  += u(real(realized));
    row.n          += 1;
  }
  row.realized     += realized;
  row.realRealized += real(realized);
  // A dispatch whose realized leg is short of intent is one the cap bit on. Only
  // the money-moving entry has a delta, so test it there.
  if (realized > 0 && realized < amount - 1e-6) row.capped += 1;

  years.set(year, row);
}

if (idless) console.log(`NOTE: ${idless} EXPENSE_DEBIT entries carried no action id; ` +
                        'the composite dispatch key was used for those.\n');

// ─── the cross-check ─────────────────────────────────────────────────────────

const totals = [...years.values()].reduce((a, r) => ({
  intent:       a.intent       + r.intent,
  realized:     a.realized     + r.realized,
  realIntent:   a.realIntent   + r.realIntent,
  realRealized: a.realRealized + r.realRealized,
  n:            a.n            + r.n,
  capped:       a.capped       + r.capped,
  uIntent:      a.uIntent      + r.uIntent,
  uRealized:    a.uRealized    + r.uRealized,
}), { intent: 0, realized: 0, realIntent: 0, realRealized: 0, uIntent: 0, uRealized: 0, n: 0, capped: 0 });

const actual   = sim.state?.cumulativeConsumption ?? 0;
const relErr   = (v) => (actual > 0 ? Math.abs(v - actual) / actual : null);
const errIntent   = relErr(totals.realIntent);
const errRealized = relErr(totals.realRealized);
const TOL = 0.005;   // 0.5% — rate/price-level sampling slop

// Which source does the engine actually use? Design 89 step D changed the answer
// from INTENT to REALIZED, so this doubles as a permanent regression detector: a
// run that starts matching intent again means the accumulators have regressed (or
// that `realizedAmount` stopped being stamped, which looks identical from here).
const matches = errRealized != null && errRealized < TOL ? 'REALIZED'
              : errIntent   != null && errIntent   < TOL ? 'INTENT'
              : 'NEITHER';

console.log('CROSS-CHECK — which source is the engine booking, and is this probe faithful?');
console.log(`  state.cumulativeConsumption (the run)  ${actual.toFixed(0)}`);
console.log(`  replicated from REALIZED               ${totals.realRealized.toFixed(0)}` +
            `   (err ${errRealized == null ? '—' : `${(100 * errRealized).toFixed(3)}%`})`);
console.log(`  replicated from INTENT                 ${totals.realIntent.toFixed(0)}` +
            `   (err ${errIntent == null ? '—' : `${(100 * errIntent).toFixed(3)}%`})`);
console.log(`  => the engine is booking: ${matches}`);
if (matches === 'REALIZED') {
  console.log('     Correct as of design 89 §5.4 step D, and this probe is faithful.\n');
} else if (matches === 'INTENT') {
  console.log('     *** REGRESSION *** — step D made this REALIZED. Either the accumulators');
  console.log('     went back to `action.amount`, or ExpenseDebitReducer stopped stamping');
  console.log('     `realizedAmount` and they fell through to the fallback. See design 89 §5.4.\n');
} else {
  console.log('     NOT faithful to either — treat the REAL columns as indicative only.');
  console.log('     The NOMINAL columns are read straight off the journal and are unaffected.\n');
}

// ─── the table ───────────────────────────────────────────────────────────────

console.log('Per year — NOMINAL is a face-value sum across currencies; REAL is base-year USD.\n');
console.log(`${'year'.padStart(6)} ${'dispatches'.padStart(11)} ${'capped'.padStart(7)} ` +
            `${'intent'.padStart(13)} ${'realized'.padStart(13)} ${'gap'.padStart(13)} ${'gap%'.padStart(7)}`);
console.log('-'.repeat(78));
let shown = 0;
for (const y of [...years.keys()].sort()) {
  const r   = years.get(y);
  const gap = r.intent - r.realized;
  if (Math.abs(gap) < 1e-6 && r.capped === 0) continue;   // only print years that bite
  shown++;
  console.log(`${String(y).padStart(6)} ${String(r.n).padStart(11)} ${String(r.capped).padStart(7)} ` +
              `${r.intent.toFixed(0).padStart(13)} ${r.realized.toFixed(0).padStart(13)} ` +
              `${gap.toFixed(0).padStart(13)} ${(r.intent > 0 ? `${(100 * gap / r.intent).toFixed(1)}%` : '—').padStart(7)}`);
}
if (shown === 0) {
  console.log('  (no year has a gap — the cap never bound on this run)');
}
console.log('-'.repeat(78));

const gapNominal = totals.intent - totals.realized;
const gapReal    = totals.realIntent - totals.realRealized;
console.log(`${'TOTAL'.padStart(6)} ${String(totals.n).padStart(11)} ${String(totals.capped).padStart(7)} ` +
            `${totals.intent.toFixed(0).padStart(13)} ${totals.realized.toFixed(0).padStart(13)} ` +
            `${gapNominal.toFixed(0).padStart(13)} ` +
            `${(totals.intent > 0 ? `${(100 * gapNominal / totals.intent).toFixed(2)}%` : '—').padStart(7)}\n`);

// ─── the answer ──────────────────────────────────────────────────────────────

console.log('IN THE OBJECTIVE\'S UNITS (real base-year USD — what DIE_WITH_TARGET scores):');
console.log(`  consumption as booked (intent)     ${totals.realIntent.toFixed(0)}`);
console.log(`  consumption as received (realized) ${totals.realRealized.toFixed(0)}`);
console.log(`  overstatement                      ${gapReal.toFixed(0)}` +
            ` (${totals.realRealized > 0 ? `${(100 * gapReal / totals.realRealized).toFixed(2)}%` : '—'})\n`);

// The CRRA objective is the sharper case (design 89 §5.4.1): MAX_CRRA_UTILITY has no
// deficit penalty and feasibilityFirst defaults to false, so nothing else opposes an
// overstatement there. u is bounded on [0, 2), so the question is not "how large" but
// "does it move at all when the plan cannot fund itself".
const actualU = sim.state?.cumulativeConsumptionUtility ?? 0;
console.log('CRRA UTILITY (what MAX_CRRA_UTILITY maximizes, and its ONLY ruin signal):');
console.log(`  state.cumulativeConsumptionUtility  ${actualU.toFixed(1)}`);
console.log(`  from REALIZED                       ${totals.uRealized.toFixed(1)}`);
console.log(`  from INTENT                         ${totals.uIntent.toFixed(1)}` +
            `   (${totals.uRealized > 0 ? `${(100 * (totals.uIntent - totals.uRealized) / totals.uRealized).toFixed(1)}% higher` : '—'})`);
console.log(`  mean utility per dispatch           ${(totals.uRealized / Math.max(1, totals.n)).toFixed(3)}` +
            ` of a possible 2.000\n`);

console.log('AGAINST THE SEPARATE PENALTY TERM:');
console.log(`  state.cumulativeDeficit            ${(sim.state?.cumulativeDeficit ?? 0).toFixed(0)}` +
            `   [NOMINAL, mixed USD+AUD]`);
console.log(`  the nominal gap above              ${gapNominal.toFixed(0)}   [NOMINAL, mixed USD+AUD]`);
console.log(`  state.deficitMonths                ${sim.state?.deficitMonths ?? 0}`);
console.log(`  state.outOfFundsDate               ${sim.state?.outOfFundsDate ?? '(none)'}`);
console.log('  Two reasons these do not net out inside an objective:');
console.log('   1. DIFFERENT UNITS. AccumulateConsumptionReducer FX-converts and deflates;');
console.log('      AccumulateDeficitReducer adds action.amount raw, so cumulativeDeficit is a');
console.log('      face-value NOMINAL sum of USD and AUD deficits. One term is real base-year');
console.log('      USD, the other is a mixed-currency nominal total. They cannot offset cleanly.');
console.log('   2. DIFFERENT POINTS. The deficit is raised by OutOfFundsHandler when replenish');
console.log('      cannot fill the pool; the gap is created by the EXPENSE_DEBIT cap. Neither');
console.log('      is a restatement of the other.\n');

console.log(gapNominal > 0
  ? 'VERDICT: the gap is LIVE on this run — design 89 §5.1 steps B–D apply.'
  : 'VERDICT: the gap is ZERO on this run — the cap never bound, so the defect is\n'
  + '         LATENT here. Re-run with --stress to provoke it before writing step B\'s\n'
  + '         characterisation test.');
