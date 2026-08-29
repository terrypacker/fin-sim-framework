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
 * probe-refill-laundering.mjs — does the DRAW ORDER survive the REBALANCER?
 *
 * Design 97 §7, and the one question that has to be answered before any cell of
 * `scenarios/offset-bond-pool/STUDY.md` is worth filling in.
 *
 * The study's two arms differ only in where the offset sits in the drawdown sequence:
 *
 *   A "shock absorber"  cash → BOND sleeve → offset → EQUITY sleeve
 *   B "dry powder"      cash → offset → EQUITY sleeve → BOND sleeve
 *
 * But spending is not the only thing that moves a sleeve. **Rebalancing to an
 * allocation target refills bucket 2 by selling bucket 3.** Arm A drains BOND; the next
 * drift-band rebalance restores the BOND target by selling EQUITY. Net of the round trip
 * arm A sold equity to fund spending — laundered through the bond sleeve — and a cover
 * schedule cannot see it, because bucket 2 looks refilled.
 *
 * If that dominates, the two arms converge and the study's table measures the
 * rebalancer rather than the draw order. This probe measures exactly that, and states
 * the verdict rather than leaving it to be eyeballed.
 *
 * ─── how the flows are measured: COST BASIS, not market value ────────────────
 *
 * Growth moves `marketValue` and never `costBasis`; only a transaction moves basis. So a
 * sleeve's net purchase/sale over a year is Δ(Σ costBasis) — exact, with no need to model
 * returns, dividends or coupons. Negative = net disposal. Two things corrupt the signal
 * and both are flagged rather than hidden: the residency move resets cost base (design 62,
 * correct under s855-45), and a ladder REBUILD is a real flow while a ladder ROLL carries
 * basis over and correctly nets to ~0. Same convention as `probe-bucket-sequencing.mjs`.
 *
 * NET, not gross: a year that sells $100k of equity and buys $100k back reads as zero.
 * That is the right reduction for this question — laundering IS a net position — but it
 * means a busy year understates turnover.
 *
 * ─── what the arms are ───────────────────────────────────────────────────────
 *
 * The sequence is built from the scenario's own accounts (design 97): every taxable
 * BROKERAGE contributes a CASH+BOND pool and an EQUITY+GOLD pool; cash/savings accounts
 * and the offset go in whole. Accounts the sequence does not name — the age-gated
 * wrappers — follow it in their ordinary `drawdownPriority` order, which for a
 * pre-60 household is where they already were.
 *
 * ⚠️ CONTROL is not a third arm of the same experiment. It has no sequence at all, so
 * its wrappers keep their authored priorities (super 1, 401k 2, roth 3) AHEAD of the
 * taxable book, while under either sequence they fall behind it. Read control for the
 * cost of sequencing at all; read A vs B for the question this probe exists to answer.
 *
 * Usage:
 *   node scripts/probes/probe-refill-laundering.mjs --scenario <file.json>
 *   node scripts/probes/probe-refill-laundering.mjs --scenario <f> --shock DOTCOM_2000_LITE --shock-year 2033
 *   node scripts/probes/probe-refill-laundering.mjs --scenario <f> --no-shocks --to 2042
 */

import { openSim, quiet, summarize } from '../lib/run.mjs';
import { loadBaseConfig, parseSourceArgs, describeSource } from '../lib/scenario-source.mjs';
import { allParams } from '../lib/variant.mjs';
import { SHOCK_LIBRARY } from '../../src/finance/economic-shocks/shock-library.js';

const WRAPPER_TYPES = new Set(['ira', '401k', 'k401', 'roth', 'super']);
const CASH_TYPES    = new Set(['savings', 'checking']);
const SLEEVES       = ['CASH', 'BOND', 'EQUITY', 'GOLD'];

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has  = (n) => argv.includes(n);

const FROM       = Number(flag('--from', 2027));
const TO         = Number(flag('--to',   2042));
const SHOCK      = flag('--shock', null);
const SHOCK_YEAR = flag('--shock-year', null);
const PIN_FX     = !has('--no-pin-fx');
const NO_SHOCK   = has('--no-shocks');
// STUDY.md's dry-powder arm says "spend the offset and use the bonds to buy into the market".
// It does not say what funds spending once the offset is dry, and the two readings are
// different arms: EQUITY (the default — bonds are never spent, they are only a rebalance
// source) or BOND (bonds are spent, just after the offset instead of before it). The answer
// moves the arm's headline number, so it is a flag rather than a silent choice.
const B_TAIL     = (flag('--b-tail', 'equity') === 'bonds') ? 'bonds' : 'equity';

// An unknown preset resolves to null in the toolset and the run silently has NO shock at
// all — indistinguishable from a no-crash column, and the exact failure mode this probe
// already throws for on an inert sequence. Refuse it here instead.
if (SHOCK && !SHOCK_LIBRARY[SHOCK]) {
  console.error(`unknown --shock '${SHOCK}'. Known: ${Object.keys(SHOCK_LIBRARY).join(', ')}`);
  process.exit(1);
}

const source = parseSourceArgs(argv);
const { cfg: base, ...meta } = loadBaseConfig(source);

/**
 * cfg.params is a LIST of param rows; never leave a bag behind.
 *
 * ⚠️ The row's identity field is **`name`**, not `key`: `ScenarioLoader` syncs
 * `cfg.params → cfg.parameters` with `cfg.parameters[p.name] = p.value`. A row pushed as
 * `{ key, value }` reads back fine here and is **silently dropped on the way to the
 * compiler** — which is exactly how this probe's first run came back with all three arms
 * byte-identical and a confident "the arms converge" verdict. Write both.
 */
function setParam(c, key, value) {
  if (!Array.isArray(c.params)) {
    const bag = (c.params && typeof c.params === 'object') ? c.params : {};
    c.params = Object.entries(bag).map(([k, v]) => ({ name: k, key: k, value: v }));
  }
  const row = c.params.find(r => (r.name ?? r.key) === key);
  if (row) row.value = value; else c.params.push({ name: key, key, value });
}
const getParam = (c, key) => (c.params ?? []).find(p => (p.key ?? p.name) === key)?.value ?? null;

/** Classify the scenario's accounts into the three pool kinds the arms are built from. */
function poolsOf(cfg) {
  const taxable = [], cash = [], offset = [];
  for (const a of cfg.accounts ?? []) {
    if (!a?.stateKey) continue;
    if (a.type === 'offset')                                   offset.push(a.stateKey);
    else if (a.type === 'brokerage' && !WRAPPER_TYPES.has(a.type)) taxable.push(a.stateKey);
    else if (CASH_TYPES.has(a.type))                            cash.push(a.stateKey);
  }
  return { taxable, cash, offset };
}

/**
 * The two arms, plus a no-sequence control. Sleeves are listed EXHAUSTIVELY for every
 * taxable account: what a sequence does not claim keeps its own drawdownPriority and can
 * be reached ahead of a lower-priority pool, which would silently make the arm not the arm
 * (design 97 §3.1).
 */
function buildArms(cfg) {
  const { taxable, cash, offset } = poolsOf(cfg);
  const bondPools   = taxable.map(k => ({ key: k, sleeves: ['CASH', 'BOND'] }));
  const equityPools = taxable.map(k => ({ key: k, sleeves: ['EQUITY', 'GOLD'] }));
  const cashPools   = cash.map(k => ({ key: k }));
  const offPools    = offset.map(k => ({ key: k }));
  return [
    { id: 'CONTROL', label: 'no sequence (drawdownPriority)',      seq: null },
    { id: 'A',       label: 'bonds absorb, offset overflows past', seq: [...cashPools, ...bondPools, ...offPools, ...equityPools] },
    { id: 'B',       label: `offset spent, then ${B_TAIL === 'bonds' ? 'bonds, then equity' : 'equity (bonds never spent)'}`,
      seq: B_TAIL === 'bonds'
        ? [...cashPools, ...offPools, ...bondPools, ...equityPools]
        : [...cashPools, ...offPools, ...equityPools, ...bondPools] },
  ];
}

/**
 * Per-sleeve (marketValue, costBasis) over ACCESSIBLE accounts, plus the offset — and,
 * separately, per-ACCOUNT equity totals over EVERY account including the age-gated
 * wrappers. The second set is only for measuring the year's equity return (see
 * `untouchedReturn`); it is deliberately not filtered to the accessible book.
 */
function cut(state) {
  const usdAud = state.effectiveExchangeRates?.USD_AUD ?? 1.55;
  const toUsd  = (v, c) => (c === 'AUD' ? v / usdAud : v);
  const o = { offset: 0, eqByLot: {} };
  for (const s of SLEEVES) { o[`mv_${s}`] = 0; o[`cb_${s}`] = 0; }
  for (const [k, a] of Object.entries(state)) {
    if (!a || typeof a !== 'object' || !('balance' in a) || a.type === 'loan') continue;
    const ccy = a.currency?.code ?? 'USD';
    if (a.type === 'offset') { o.offset += toUsd(Math.max(0, a.balance ?? 0), ccy); continue; }
    const wrapper = WRAPPER_TYPES.has(a.type) || WRAPPER_TYPES.has(a.role);
    for (const h of a.holdings ?? []) {
      const s  = SLEEVES.includes(h.allocation) ? h.allocation : 'EQUITY';
      const mv = toUsd(h.marketValue ?? 0, ccy);
      const cb = toUsd(h.costBasis   ?? 0, ccy);
      // Per-LOT, not per-account: a rebalance touches some lots of an account and leaves
      // others alone, and in the crash year an account-level test found nothing untouched
      // anywhere — the one year the measurement exists for.
      if (s === 'EQUITY' && h.id != null) o.eqByLot[`${k}::${h.id}`] = { mv, cb };
      if (wrapper) continue;                 // age-gated: not part of the accessible book
      o[`mv_${s}`] += mv;
      o[`cb_${s}`] += cb;
    }
  }
  return o;
}

/**
 * The year's equity return, measured on the equity NOBODY TOUCHED.
 *
 * The obvious estimator — `(ΔMV − Δbasis) / MV` over the whole book — is **circular here
 * and it fooled the first run of this probe.** Selling an appreciated lot drops market
 * value by the proceeds but drops cost basis by only the BASIS share, so the residual
 * reads as a loss: selling equity manufactures the "down year" that the headline metric
 * then counts the selling in. The arm that sells more looks like it lived through more
 * down years, which is exactly backwards.
 *
 * So: take only the LOTS whose cost basis did not move at all this year (no sale, no
 * purchase, no reinvested dividend, no contribution) and read `ΔMV / MV` off them. Per-lot
 * rather than per-account because a rebalance touches some lots of an account and leaves
 * others alone — an account-level test came back empty in the crash year, which is the one
 * year the measurement exists for. Measured the SAME way in every arm, so the arms are
 * compared over one year set instead of each over its own.
 *
 * Returns null when nothing was left untouched, rather than falling back to the estimator
 * that caused the problem.
 */
function untouchedReturn(prev, next) {
  let mv0 = 0, mv1 = 0;
  for (const [id, p0] of Object.entries(prev.eqByLot)) {
    const p1 = next.eqByLot[id];
    if (!p1 || p0.mv <= 0) continue;
    if (Math.abs(p1.cb - p0.cb) > 1) continue;      // basis moved ⇒ a flow ⇒ not a clean read
    mv0 += p0.mv; mv1 += p1.mv;
  }
  return mv0 > 0 ? (mv1 - mv0) / mv0 : null;
}

function runArm(arm) {
  const cfg = structuredClone(base);
  if (PIN_FX)   setParam(cfg, 'fxProcessModel', 'NONE');
  if (NO_SHOCK) setParam(cfg, 'shocks', []);
  else if (SHOCK) setParam(cfg, 'shocks', [{ preset: SHOCK, startDate: `${SHOCK_YEAR ?? 2029}-01-01` }]);
  if (arm.seq) setParam(cfg, 'drawdownSequence', arm.seq);

  const sim  = openSim(cfg, { telemetry: 'off' });
  // A silent no-op is the failure mode this probe is most exposed to: an inert axis
  // reports "the arms converge", which is the same shape as the finding. Refuse to run
  // rather than report a number the arm never earned.
  if (arm.seq && !Array.isArray(sim.state.drawdownSequence)) {
    throw new Error(`arm ${arm.id}: drawdownSequence never reached state — the axis is inert`);
  }
  const rows = [];
  for (let y = FROM - 1; y <= TO; y++) {
    quiet(() => sim.stepTo(new Date(`${y}-12-31`)));
    rows.push({ year: y, ...cut(sim.state) });
  }
  return { rows, row: summarize(sim, allParams(cfg)) };
}

// ─── run ──────────────────────────────────────────────────────────────────────

const cfgProbe  = structuredClone(base);
const moveYear  = getParam(cfgProbe, 'moveYear');
const arms      = buildArms(cfgProbe);
const results   = new Map();
for (const arm of arms) results.set(arm.id, { arm, ...runArm(arm) });

/** Per-year net flows for one arm, aligned on the year index. */
function flows(res) {
  const out = [];
  for (let i = 1; i < res.rows.length; i++) {
    const p = res.rows[i - 1], r = res.rows[i];
    const dE   = r.cb_EQUITY - p.cb_EQUITY;
    const dB   = r.cb_BOND   - p.cb_BOND;
    const rE   = untouchedReturn(p, r);
    out.push({ year: r.year, dE, dB, rE, offDrawn: p.offset - r.offset, moved: moveYear === r.year });
  }
  return out;
}

const v  = n => `$${Math.round(n / 1000).toLocaleString()}k`;
const m  = n => (Math.abs(n) < 500 ? '     ·' : `${n < 0 ? '-' : '+'}$${Math.abs(Math.round(n / 1000)).toLocaleString()}k`);
const pc = n => (Number.isFinite(n) ? `${(n * 100).toFixed(0)}%`.padStart(5) : '    ·');

console.log(`\nREFILL LAUNDERING  —  ${describeSource({ cfg: base, ...meta })}`);
console.log(`FX ${PIN_FX ? 'pinned' : 'stochastic'} · shocks `
  + (NO_SHOCK ? 'removed' : SHOCK ? `${SHOCK} @ ${SHOCK_YEAR ?? 2029}` : 'as authored')
  + ` · ${FROM}–${TO} · arm B tail: ${B_TAIL}`);
console.log('flows are Δ(cost basis): negative = net SOLD. ‡ = residency move, basis reset.');
console.log('eq ret is measured on the equity NO arm touched that year (see untouchedReturn).\n');

const fA = flows(results.get('A')), fB = flows(results.get('B'));
// Down years come from the CONTROL arm, so both arms are judged over ONE year set. An
// arm-specific set would let a heavier seller pick up extra "down years" of its own making.
const downYears = new Set(flows(results.get('CONTROL'))
  .filter(x => !x.moved && Number.isFinite(x.rE) && x.rE < 0).map(x => x.year));

console.log('             ARM A  bonds absorb        │  ARM B  bonds as powder       │');
console.log('year   eq ret│  equity     bond   offset │  equity     bond   offset │  A−B equity');
console.log('───────┼─────┼────────┼────────┼────────┼────────┼────────┼────────┼────────────');
for (let i = 0; i < fA.length; i++) {
  const a = fA[i], b = fB[i];
  const tag = a.moved ? ' ‡' : (downYears.has(a.year) ? ' ▼ down year' : '');
  const dd  = a.moved ? '     ‡' : m(a.dE - b.dE);
  console.log(`${a.year}  │${a.moved ? '   ‡ ' : pc(a.rE)}│ ${(a.moved ? '     ‡' : m(a.dE)).padStart(6)} │ ${(a.moved ? '     ‡' : m(a.dB)).padStart(6)} │ ${m(a.offDrawn).padStart(6)} │`
    + ` ${(b.moved ? '     ‡' : m(b.dE)).padStart(6)} │ ${(b.moved ? '     ‡' : m(b.dB)).padStart(6)} │ ${m(b.offDrawn).padStart(6)} │ ${dd.padStart(6)}${tag}`);
}

// ─── the verdict ──────────────────────────────────────────────────────────────

const soldDown = (f) => f.filter(x => !x.moved && downYears.has(x.year) && x.dE < 0)
                         .reduce((s, x) => s - x.dE, 0);
const soldAll  = (f) => f.filter(x => !x.moved && x.dE < 0).reduce((s, x) => s - x.dE, 0);

const dA = soldDown(fA), dB2 = soldDown(fB);
const aA = soldAll(fA),  aB  = soldAll(fB);
const spread = Math.abs(dA - dB2) / Math.max(dA, dB2, 1);

const downList = [...downYears].sort();
console.log(`\n─── equity sold (net Δbasis), ${FROM}–${TO} ────────────────────────────────`);
console.log(`  down years (control arm, untouched-lot return < 0): `
  + (downList.length ? downList.join(', ') : 'NONE — the window has no down year, so the'
     + ' down-year column is vacuous and only the whole-window column carries information'));
console.log(`               in DOWN years        over the whole window`);
console.log(`  arm A        ${v(dA).padStart(10)}          ${v(aA).padStart(10)}`);
console.log(`  arm B        ${v(dB2).padStart(10)}          ${v(aB).padStart(10)}`);
console.log(`  A − B        ${m(dA - dB2).padStart(10)}          ${m(aA - aB).padStart(10)}`
  + `   (${(spread * 100).toFixed(1)}% of the larger)`);

console.log(`\n─── the study's own cell (terminal), all three arms ──────────────────────`);
for (const id of ['CONTROL', 'A', 'B']) {
  const { arm, row } = results.get(id);
  console.log(`  ${id.padEnd(8)} ${arm.label.padEnd(34)} netLiq ${v(row.netLiq).padStart(9)}`
    + `  NW ${v(row.netWorth).padStart(9)}  ${row.failed ? `OOF ${row.oofDate}` : 'no OOF'}`);
}

console.log('\n─── verdict ─────────────────────────────────────────────────────────────');
if (downList.length === 0) {
  console.log('  NO VERDICT: the window contains no down year, so the metric this probe turns on');
  console.log('  was never exercised. Re-run with a shock inside the window (--shock/--shock-year).');
} else if (downList.length === 1) {
  console.log(`  Read with care — the whole down-year column rests on ONE year (${downList[0]}).`);
  console.log(`  ${spread < 0.10 ? 'THE ARMS CONVERGE' : 'THE ARMS SEPARATE'} on it `
    + `(${(spread * 100).toFixed(1)}% apart), and a single crash date is not "a crash":`);
  console.log('  re-run with the other presets and dates before treating it as the answer.');
} else if (spread < 0.10) {
  console.log(`  THE ARMS CONVERGE (${(spread * 100).toFixed(1)}% apart on equity sold in down years).`);
  console.log('  The rebalancer is refilling bucket 2 by selling bucket 3, so the draw order is');
  console.log('  not what the table would be measuring. Design 97 §6.4 (a refill rule separable');
  console.log('  from the drift band) has to land before the cells mean anything.');
} else {
  console.log(`  THE ARMS SEPARATE (${(spread * 100).toFixed(1)}% apart on equity sold in down years).`);
  console.log('  The draw order survives the rebalancer, so the table measures what it claims to.');
  console.log('  The refill rule stays deferred.');
}
console.log('  Deterministic, one path, FX pinned: this sizes the mechanism, it does not price');
console.log('  the risk. A fixed return gives the equity-heavier arm no bad tail.\n');
