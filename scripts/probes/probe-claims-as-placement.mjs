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
 * probe-claims-as-placement.mjs — what does joining pool CLAIMS to PLACEMENT cost?
 *
 * Design 97 §12.2 deliberately kept two levers apart: a pool `target` SIZES a class, and
 * `allocationLocationPolicy` decides WHERE it sits. The stated reason was that one lever
 * silently rewriting another is how levers stop meaning what they say. The price of that
 * separation is that a claim cannot exclude: the location policy's preference lists are SOFT,
 * so a class whose target exceeds its preferred accounts' capacity spills into every account
 * with room left — including a Roth, which is the most valuable shelter in the book and the
 * last place a bond belongs.
 *
 * Before joining them, price it. Pinning bonds out of a Roth is not free: design 61 §12.2 Q4
 * measured asset location as worth millions over a 44-year horizon, and every one of those
 * dollars was measured with the planner free to put whatever it liked wherever it fit.
 *
 * ─── the arms ────────────────────────────────────────────────────────────────
 *
 *   CONTROL      today's behaviour — soft preference, no exclusion.
 *   NO-BOND      the Roths may hold anything EXCEPT bonds. This is the control an author
 *                actually wants: it is a statement about the one class that must not be
 *                sheltered there, and it leaves the planner free about the rest.
 *   EQUITY-ONLY  the Roths may hold ONLY equity. The tight form of the same instinct,
 *                measured to show what over-constraining costs relative to NO-BOND.
 *
 * Each is run at TWO buffer sizes, because the constraint only binds when the bond target is
 * large enough to overflow its preferred accounts:
 *
 *   binding      the plan's authored bond buffer, whose target exceeds the whole book — so
 *                BOND saturates the mix and the overflow has to go somewhere.
 *   slack        a buffer small enough that the bond target fits its preferred accounts, so
 *                the exclusion should cost approximately nothing. An arm that moves here is
 *                measuring something other than the exclusion.
 *
 * `relaxed` is the diagnostic that makes the result readable: the share of the book the
 * planner had to place in VIOLATION of the exclusion to keep each account's composition
 * summing to its own total (design 97 §23 rule 3). It is the arm's own confession. A large
 * `relaxed` means the placement was infeasible against this book, and the arm is therefore
 * NOT measuring the policy the author wrote — it is measuring a partial, silently-relaxed
 * version of it, and its net-worth delta should not be read as the price of that policy.
 *
 * Usage:
 *   node scripts/probes/probe-claims-as-placement.mjs --scenario <file.json> [--index 0]
 *                                                     [--slack-years 8] [--as-of 2039-09-01]
 */

import { openSim, quiet, summarize } from '../lib/run.mjs';
import { allParams }                 from '../lib/variant.mjs';
import { loadBaseConfig, parseSourceArgs, describeSource } from '../lib/scenario-source.mjs';
import { ALLOCATION }                from '../../src/finance/holdings/allocation.js';

const argv   = process.argv.slice(2);
const at     = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const source = parseSourceArgs(argv);
const SLACK  = Number(at('--slack-years', 8));
const AS_OF  = new Date(at('--as-of', '2039-09-01'));
const ROTHS  = ['rothAccount', 'spouseRothAccount'];

const ALL = [ALLOCATION.EQUITY, ALLOCATION.BOND, ALLOCATION.CASH, ALLOCATION.GOLD];
const ARMS = [
  { id: 'CONTROL',     eligibility: null },
  { id: 'NO-BOND',     eligibility: ALL.filter(c => c !== ALLOCATION.BOND) },
  { id: 'EQUITY-ONLY', eligibility: [ALLOCATION.EQUITY] },
];

/** The live rebalancer instance — the seam is set on the object, not through a param. */
function rebalancerIn(sim) {
  const all = [...new Set([...sim.reducers.map.values()].flat().map(w => w.reducer ?? w))];
  return all.find(r => r.constructor?.name === 'RebalanceToTargetReducer') ?? null;
}

/** Per-account composition, as fractions, at whatever date the sim is currently at. */
function composition(state) {
  const rows = [];
  for (const [key, v] of Object.entries(state)) {
    if (!v || typeof v !== 'object' || !Array.isArray(v.holdings)) continue;
    const comp = {}; let total = 0;
    for (const h of v.holdings) { comp[h.allocation] = (comp[h.allocation] ?? 0) + (h.marketValue ?? 0); total += h.marketValue ?? 0; }
    if (total > 1000) rows.push({ key, role: v.role, total, comp });
  }
  return rows.sort((a, b) => b.total - a.total);
}

function runArm({ cfg, arm, bufferYears }) {
  const c = structuredClone(cfg);
  const graph = c.params.find(p => p.name === 'liquidityGraph')?.value;
  if (!graph) throw new Error('scenario carries no `liquidityGraph` param — nothing to join');
  if (bufferYears != null) {
    // The pool whose target is large enough to overflow: the one sized in YEARS_OF_SPEND
    // carrying a BOND claim. Named by shape rather than by id so the probe is not pinned to
    // one plan's naming.
    const bond = graph.pools.find(p => p.target && p.claims.some(cl => cl.sleeves?.includes(ALLOCATION.BOND)));
    if (!bond) throw new Error('no targeted pool claims BOND — this probe has nothing to vary');
    bond.target = { ...bond.target, value: bufferYears };
  }
  const sim = openSim(c, { telemetry: 'off' });
  const reb = rebalancerIn(sim);
  if (!reb) throw new Error('scenario does not select TARGET_ALLOCATION — placement is not in play');
  if (arm.eligibility) reb.locationEligibility = new Map(ROTHS.map(k => [k, new Set(arm.eligibility)]));

  let atDate = null;
  quiet(() => {
    sim.stepTo(AS_OF);
    atDate = composition(sim.state);
    sim.stepTo(new Date(c.simEnd));
  });
  // Reported as a SHARE OF THE BOOK per rebalance call, not a raw sum: the sum is a flow
  // across ~90 period advances and reads as an implausibly large number against a book a
  // fortieth its size. The share is the honest figure — "this fraction of the portfolio was
  // placed in violation of the constraint, every period".
  const relaxedShare = reb._eligibilityBook > 0 ? reb._eligibilityRelaxed / reb._eligibilityBook : 0;
  return { row: summarize(sim, allParams(c)), atDate, relaxedShare, state: sim.state };
}

const { cfg, source: srcLabel, synthetic } = loadBaseConfig(source);
console.log(describeSource ? describeSource({ source: srcLabel, synthetic }) : srcLabel);

const authored = cfg.params.find(p => p.name === 'liquidityGraph')?.value
  ?.pools.find(p => p.target && p.claims.some(cl => cl.sleeves?.includes(ALLOCATION.BOND)));
const M = (x) => (x == null ? '—' : (x / 1e6).toFixed(3) + 'm');

for (const [label, years] of [['binding (authored)', null], [`slack (${SLACK}y)`, SLACK]]) {
  console.log(`\n${'═'.repeat(78)}\n${label}  —  bond pool '${authored?.id}' target ${years ?? authored?.target?.value} ${authored?.target?.mode}\n${'═'.repeat(78)}`);
  const results = [];
  for (const arm of ARMS) results.push({ arm, ...runArm({ cfg, arm, bufferYears: years }) });

  const base = results[0];
  console.log('\narm          terminal NW   after-tax NW   vs CONTROL   failed   relaxed');
  for (const r of results) {
    const dNW = r.row.netWorth - base.row.netWorth;
    console.log(
      r.arm.id.padEnd(12),
      M(r.row.netWorth).padStart(11),
      M(r.row.afterTaxNW).padStart(14),
      ((dNW >= 0 ? '+' : '') + M(dNW)).padStart(12),
      String(r.row.failed).padStart(8),
      ((r.relaxedShare * 100).toFixed(1) + '%').padStart(9));
  }

  console.log(`\nRoth composition at ${AS_OF.toISOString().slice(0, 10)}:`);
  for (const r of results) {
    for (const key of ROTHS) {
      const row = r.atDate.find(x => x.key === key);
      if (!row) { console.log(' ', r.arm.id.padEnd(12), key.padEnd(20), '(empty)'); continue; }
      const pct = c2 => (((row.comp[c2] ?? 0) / row.total) * 100).toFixed(0).padStart(3) + '%';
      console.log(' ', r.arm.id.padEnd(12), key.padEnd(20), (row.total / 1000).toFixed(0).padStart(6) + 'k',
        'EQ', pct('EQUITY'), 'BOND', pct('BOND'), 'CASH', pct('CASH'), 'GOLD', pct('GOLD'));
    }
  }
}
