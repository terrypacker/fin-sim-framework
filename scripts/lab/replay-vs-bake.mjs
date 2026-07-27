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
 * replay-vs-bake.mjs — did the RUN go broke, or did the HARVEST of it? (design/80 F6)
 *
 * Reads a REAL exported decision log (`fin-sim-decisions` from browser localStorage)
 * plus the scenario it was harvested into, and computes all three terms:
 *
 *   A  = what the last epoch projected                (straight off the record)
 *   A′ = the run's realized closed-loop path          (`replayDecisions`)
 *   B  = the baked scenario re-run from t₀            (the saved file)
 *
 * A′ solvent + B insolvent  ⇒ the HARVEST broke it. Then the per-lever bisect below
 *                             says which bake, by re-running with one lever group's
 *                             harvested values reverted to the run's own last-epoch
 *                             sequence vs its collapse.
 * A′ insolvent              ⇒ the RUN was already broke and every epoch's projection
 *                             lied; the defect is in the controller, not the harvest.
 *
 * Usage:
 *   node scripts/lab/replay-vs-bake.mjs \
 *     --decisions scenarios/fin-sim-decisions.json \
 *     --scenario  scenarios/fin-sim-die-with.json
 */

import { readFileSync } from 'node:fs';

import { OPTIMIZATION_OBJECTIVES, objectivePrimaryMetric }
  from '../../src/finance/optimization/optimization-objectives.js';
import { replayDecisions } from '../../src/finance/mpc/replay.js';
import { loadScenario, withParams, readParams, runCfg, cloneCfg, fmtUsd }
  from '../lib/scenario-probe.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

const decFile = flag('decisions', 'scenarios/fin-sim-decisions.json');
const scnFile = flag('scenario',  'scenarios/fin-sim-die-with.json');

const doc = JSON.parse(readFileSync(decFile, 'utf8'));
const all = Array.isArray(doc.records) ? doc.records : Object.values(doc.records ?? doc);
const runId = flag('run', null) ?? all[all.length - 1]?.runId ?? null;
const recs = all.filter(r => runId == null || r.runId === runId)
  .sort((a, b) => new Date(a.asOfDate) - new Date(b.asOfDate));

const saved    = loadScenario(scnFile, flag('scenario-name', null));
const simStart = new Date(recs[0].simStart ?? saved.simStart);
const simEnd   = new Date(recs[0].simEnd   ?? saved.simEnd);

const goalKey = recs[0].goalMetric?.key ?? 'finalNetWorthUsd';
// Recover the objective from the metric the run stamped on its records.
const objective = Object.values(OPTIMIZATION_OBJECTIVES)
  .find(o => o?.metric?.key === goalKey && o?.family === 'DIE_WITH_TARGET')
  ?? OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH;
const metric = objectivePrimaryMetric(objective);

console.log(`\n=== replay vs bake · run ${runId} · ${recs.length} epochs ===`);
console.log(`  decisions ${decFile}`);
console.log(`  scenario  ${scnFile}`);
console.log(`  goal metric ${metric.label} (${metric.key}) · sim ${simStart.toISOString().slice(0, 10)} → ${simEnd.toISOString().slice(0, 10)}`);
console.log(`  levers ${(recs[0].controlKeys ?? []).join(', ')}\n`);

// ── Reconstruct the PRE-RUN params ───────────────────────────────────────────
// The saved scenario is post-harvest. Everything the harvest CREATED has to be
// undone, or the replay would start from the answer it is meant to check:
//   · spendingExpenseBands — keep only the preserved pre-run bands (§13.6.1);
//   · allocationGlidepath + allocationSchedule=GLIDEPATH — created by the harvest;
//     the run itself drove `allocWeight::*` under STATIC;
//   · roth / early-withdrawal schedules — accumulated by `actuate` during the run.
// The remaining controlled params (drawdownWeight::*, sleeveWeight::*, the two
// categoricals, bondLadderRungs) are overwritten by every epoch's controlParams,
// so their starting value cannot affect the replay.
// The pre-run BAND TABLE has to be reconstructed by SHAPE, not just by value.
// Each epoch's decision is written to `spendingExpenseBands[i].monthlyAmount` — an
// INDEX into the table as it stood during the run. Replaying those writes against a
// shorter table silently misses (or worse, appends), so the spending sequence never
// lands and the replay quietly measures the pre-run plan instead. The indices and
// their startAges are recoverable: `buildVariables` stamps `_bandIndex`/`_startAge`
// on every record's `controlVars`.
//
// Amounts for the reconstructed bands do not matter: index i is only ever active
// while the primary's age is inside band i, and by then the epoch that owns it has
// overwritten it. Only the preserved pre-run bands below the first decision keep a
// real value.
const bands  = readParams(saved, ['spendingExpenseBands']).spendingExpenseBands ?? [];
const preserved = bands.filter(b => b.monthlyAmount === bands[0]?.monthlyAmount);

const byIndex = new Map();
for (const r of recs) {
  const v = (r.controlVars ?? []).find(x => x && x._bandIndex != null);
  if (v && Number.isFinite(v._startAge)) byIndex.set(v._bandIndex, v._startAge);
}
const preRunBands = [...preserved];
for (const [idx, startAge] of [...byIndex.entries()].sort((a, b) => a[0] - b[0])) {
  preRunBands[idx] = { startAge, monthlyAmount: preserved[0]?.monthlyAmount ?? 5500 };
}
// Any hole left by an index no epoch ever targeted would shift every later index.
const holes = preRunBands.findIndex(b => b == null);
if (holes >= 0) {
  console.error(`cannot reconstruct the pre-run band table: no record targets index ${holes}`);
  process.exit(2);
}
console.log(`  reconstructed pre-run band table: ${preRunBands.length} bands`
  + ` (ages ${preRunBands.map(b => b.startAge).join(',')})\n`);

const preRunCfg = withParams(saved, {
  spendingExpenseBands:    preRunBands,
  allocationSchedule:      'STATIC',
  allocationGlidepath:     [],
  rothConversionSchedule:  [],
  earlyWithdrawalSchedule: [],
});
const baseParams = Object.fromEntries((preRunCfg.params ?? []).map(p => [p.key ?? p.name, p.value]));

const verdictOf = r => (r.solvent ?? !(r.scenarioFailed || (r.cumulativeDeficit ?? 0) > 0))
  ? '✅ solvent'
  : `❌ ruin ${r.outOfFundsDate ?? '?'} (${fmtUsd(r.cumulativeDeficit ?? 0)})`;

// ── A — what the last epoch projected ────────────────────────────────────────
const last = recs[recs.length - 1];
console.log(`  A  last epoch projected     ${fmtUsd(last.result?.[metric.key]).padStart(14)}`
  + `   ${verdictOf(last.result ?? {})}`);

// ── B — the saved (baked) scenario re-run from t₀ ────────────────────────────
const b = runCfg(saved);
console.log(`  B  baked scenario from t₀   ${fmtUsd(b.netLiquidity).padStart(14)}`
  + `   ${verdictOf(b)}`);

// Sanity: the pre-run scenario must be solvent, else nothing below is meaningful.
const pre = runCfg(preRunCfg);
console.log(`  ·  pre-run baseline         ${fmtUsd(pre.netLiquidity).padStart(14)}   ${verdictOf(pre)}`);

// ── A′ — the realized closed-loop path, reconstructed from the log ───────────
process.stdout.write(`  A′ replaying ${recs.length} epochs… `);
const quiet = fn => {
  const { log: l, warn: w } = console;
  console.log = () => {}; console.warn = () => {};
  try { return fn(); } finally { console.log = l; console.warn = w; }
};
const t0 = Date.now();
const replay = quiet(() => replayDecisions(recs, {
  baseParams, simStart, simEnd, cfgTemplate: cloneCfg(preRunCfg), objective, runId,
}));
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`  A′ realized closed-loop     ${fmtUsd(replay.result?.[metric.key]).padStart(14)}`
  + `   ${verdictOf(replay.result ?? {})}`);

// First epoch at which the realized path went under — the harvest's warnings never
// mention this because nothing was reading it.
const brokeAt = replay.epochs.find(e => e.scenarioFailed || e.cumulativeDeficit > 0);

console.log('');
console.log('  VERDICT');
const aPrimeSolvent = !(replay.result?.scenarioFailed || (replay.result?.cumulativeDeficit ?? 0) > 0);
if (aPrimeSolvent && !b.solvent) {
  console.log('    A′ SOLVENT, B INSOLVENT → the HARVEST broke it, not the run.');
  console.log('    The controller\'s own decisions, replayed in sequence, keep the plan solvent;');
  console.log('    the collapse of that sequence into scenario params does not. The levers baked');
  console.log('    as POINT (last-epoch-wins, applied from t₀ over the whole realized past) are');
  console.log('    the prime suspects — design/80 §2.4, and design/39 §13.6.3.');
} else if (!aPrimeSolvent) {
  console.log(`    A′ INSOLVENT (first shortfall at epoch ${replay.epochs.indexOf(brokeAt) + 1},`
    + ` ${brokeAt?.asOfDate?.toISOString?.().slice(0, 10)}) → the RUN was already broke.`);
  console.log('    Every epoch projected $0 deficit, so the per-epoch projections did not describe');
  console.log('    the path their own decisions produced. That is a design/39 CONTROLLER defect and');
  console.log('    the harvest is only the messenger.');
} else {
  console.log('    A′ and B are both solvent — this log does not reproduce the reported failure.');
}
console.log('');
