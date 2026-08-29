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
 * probe-bucket-sequencing.mjs — is the plan actually DRAINING its buckets in order?
 *
 * `probe-bucket-cover.mjs` answers "is there enough in bucket 2". This answers the
 * other half, which is the half a bucket strategy actually exists for: **when the
 * money is needed, which sleeve is sold, and does equity get sold in a down year?**
 *
 * A cover schedule can look perfect while the plan sells equity every year anyway.
 * Two mechanisms hide it:
 *
 *   1. **The drawdown sleeve order** (`drawdownSleeveOrder`/`sleeveWeight::<CLASS>`,
 *      ascending = sold first) decides the order WITHIN an account. If EQUITY does
 *      not sort last, buckets are decorative.
 *   2. **Rebalancing to an allocation target refills bucket 2 by selling bucket 3.**
 *      This is the one people miss. Spending drains BOND first; the next rebalance
 *      restores the BOND target by selling EQUITY. Net of the round trip the plan
 *      sold equity to fund spending — laundered through the bond sleeve, and
 *      invisible in a cover schedule, which sees bucket 2 refilled and calls it
 *      healthy. Whether that is bad depends on the year: selling equity to rebuy
 *      bonds after a CRASH is the opposite of what a bucket strategy promises.
 *
 * ─── how the flows are measured: COST BASIS, not market value ────────────────
 *
 * Growth moves `marketValue` and never `costBasis`; only a transaction moves basis.
 * So the net purchase/sale of a sleeve over a year is Δ(Σ costBasis) — exact, with
 * no need to model returns, dividends or coupons. A negative Δ is a net disposal.
 *
 * That also hands back the realized return for free, since everything in the market
 * value that is not a flow is growth:
 *
 *     r ≈ (MV_end − MV_start − Δbasis) / MV_start
 *
 * **Two things will corrupt the basis signal and both are reported, not hidden:**
 *
 *   · **The residency move resets cost base** (design 62 — correct under s855-45:
 *     assets are re-acquired at market value on ceasing/becoming a resident). That
 *     is a basis jump with no transaction behind it, so the move year's row is
 *     flagged `‡` and its flows must not be read.
 *   · A bond **ladder roll** at maturity rebuys with carryover basis, so it nets to
 *     ~0 and is correctly invisible. A ladder REBUILD is a real flow and shows.
 *
 * ─── the arms ────────────────────────────────────────────────────────────────
 *
 * `--offset-priority <n>` puts the offset into the drawdown queue. This is the ONLY
 * in-queue way to reach an offset, and the engine's own docs say what it does:
 * `expense-event-handler.js` — "a priority applies to ALL spending, so the account
 * empties years early". So the arm is here to MEASURE that, not to endorse it: the
 * policy people actually want ("draw the offset once bucket 2 is exhausted") has no
 * lever, and this shows what the nearest available lever does instead.
 *
 * Deterministic by default (FX pinned, authored shocks kept — the crash is the whole
 * point here, unlike in the cover probe). Pass --no-shocks to remove it.
 *
 * Usage:
 *   node scripts/probes/probe-bucket-sequencing.mjs --scenario <file.json>
 *   node scripts/probes/probe-bucket-sequencing.mjs --scenario <f> --offset-priority 5
 *   node scripts/probes/probe-bucket-sequencing.mjs --scenario <f> --no-shocks --to 2045
 */

import { openSim, quiet } from '../lib/run.mjs';
import { loadBaseConfig, parseSourceArgs, describeSource } from '../lib/scenario-source.mjs';

const WRAPPER_TYPES = new Set(['ira', '401k', 'k401', 'roth', 'super']);
const SLEEVES       = ['CASH', 'BOND', 'EQUITY', 'GOLD'];

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has  = (n) => argv.includes(n);

const FROM     = Number(flag('--from', 2027));
const TO       = Number(flag('--to',   2045));
const OFF_PRIO = flag('--offset-priority', null);
const PIN_FX   = !has('--no-pin-fx');
const NO_SHOCK = has('--no-shocks');

const source = parseSourceArgs(argv);
const { cfg: base, ...meta } = loadBaseConfig(source);
const cfg = structuredClone(base);

/** cfg.params is a LIST of {key,value}; never leave a bag behind (ScenarioLoader .find()s it). */
function setParam(c, key, value) {
  if (!Array.isArray(c.params)) {
    const bag = (c.params && typeof c.params === 'object') ? c.params : {};
    c.params = Object.entries(bag).map(([k, v]) => ({ key: k, value: v }));
  }
  const row = c.params.find(r => (r.key ?? r.name) === key);
  if (row) row.value = value; else c.params.push({ key, value });
}
if (PIN_FX)   setParam(cfg, 'fxProcessModel', 'NONE');
if (NO_SHOCK) setParam(cfg, 'shocks', []);

const moveYear = (cfg.params ?? []).find(p => (p.key ?? p.name) === 'moveYear')?.value ?? null;

if (OFF_PRIO != null) {
  for (const a of cfg.accounts ?? []) if (a.type === 'offset') a.drawdownPriority = Number(OFF_PRIO);
  for (const v of Object.values(cfg.initialState ?? {})) if (v?.type === 'offset') v.drawdownPriority = Number(OFF_PRIO);
}

/** Per-sleeve (marketValue, costBasis) over ACCESSIBLE accounts, plus the offset. */
function cut(state) {
  const usdAud = state.effectiveExchangeRates?.USD_AUD ?? 1.55;
  const toUsd  = (v, c) => (c === 'AUD' ? v / usdAud : v);
  const o = { offset: 0, spend: (state.monthlyExpenses ?? 0) * 12 };
  for (const s of SLEEVES) { o[`mv_${s}`] = 0; o[`cb_${s}`] = 0; }
  for (const a of Object.values(state)) {
    if (!a || typeof a !== 'object' || !('balance' in a) || a.type === 'loan') continue;
    const ccy = a.currency?.code ?? 'USD';
    if (a.type === 'offset') { o.offset += toUsd(Math.max(0, a.balance ?? 0), ccy); continue; }
    if (WRAPPER_TYPES.has(a.type) || WRAPPER_TYPES.has(a.role)) continue;   // age-gated
    for (const h of a.holdings ?? []) {
      const s = SLEEVES.includes(h.allocation) ? h.allocation : 'EQUITY';
      o[`mv_${s}`] += toUsd(h.marketValue ?? 0, ccy);
      o[`cb_${s}`] += toUsd(h.costBasis   ?? 0, ccy);
    }
  }
  return o;
}

const sim  = openSim(cfg, { telemetry: 'off' });
const rows = [];
for (let y = FROM - 1; y <= TO; y++) {
  quiet(() => sim.stepTo(new Date(`${y}-12-31`)));
  rows.push({ year: y, ...cut(sim.state) });
}

const m = n => (Math.abs(n) < 500 ? '     ·' : `${n < 0 ? '-' : '+'}$${Math.abs(Math.round(n / 1000)).toLocaleString()}k`);
const v = n => `$${Math.round(n / 1000).toLocaleString()}k`;
const pc = n => (Number.isFinite(n) ? `${(n * 100).toFixed(0)}%`.padStart(5) : '    ·');

console.log(`\nBUCKET SEQUENCING  —  ${describeSource({ cfg: base, ...meta })}`);
console.log(`FX ${PIN_FX ? 'pinned' : 'stochastic'} · shocks ${NO_SHOCK ? 'removed' : 'as authored'}`
  + ` · offset ${OFF_PRIO != null ? `IN the drawdown queue (priority ${OFF_PRIO})` : 'out of the queue (as authored)'}`);
console.log(`flows are Δ(cost basis): negative = net SOLD. ‡ = residency move, basis reset — flows meaningless.\n`);
console.log('      equity │  BOND held   sold/  │ EQUITY held  sold/   │  offset  │ equity sold');
console.log('year  return │  (bucket 2)  bought │ (bucket 3)  bought   │  drawn   │ in a DOWN year');
console.log('──────┼──────┼──────────┼──────────┼──────────┼──────────┼──────────┼───────────────');

let soldDown = 0, soldDownYears = 0;
for (let i = 1; i < rows.length; i++) {
  const p = rows[i - 1], r = rows[i];
  const dB = r.cb_BOND   - p.cb_BOND;
  const dE = r.cb_EQUITY - p.cb_EQUITY;
  const rE = p.mv_EQUITY > 0 ? (r.mv_EQUITY - p.mv_EQUITY - dE) / p.mv_EQUITY : NaN;
  const dOff = p.offset - r.offset;
  const moved = moveYear && r.year === moveYear;
  const down  = Number.isFinite(rE) && rE < 0;
  const sold  = -dE;
  let note = '';
  if (moved) note = '‡ basis reset';
  else if (down && sold > 500) { note = `◄ SOLD ${v(sold)}`; soldDown += sold; soldDownYears++; }
  else if (down) note = '  (held)';
  console.log(`${r.year} │${moved ? '   ‡  ' : pc(rE)} │ ${v(r.mv_BOND).padStart(8)} │ ${(moved ? '     ‡' : m(dB)).padStart(8)} │`
    + ` ${v(r.mv_EQUITY).padStart(8)} │ ${(moved ? '     ‡' : m(dE)).padStart(8)} │ ${m(dOff).padStart(8)} │ ${note}`);
}

console.log(`\nequity sold during DOWN years: ${v(soldDown)} across ${soldDownYears} year(s)`
  + ` — this is the number a bucket strategy exists to drive to zero.`);
console.log(`offset drawn over the window: ${v(rows[0].offset - rows.at(-1).offset)}`
  + (OFF_PRIO == null ? '  (all of it consumed by loan P&I, not by spending — it is not in the queue)\n' : '\n'));
