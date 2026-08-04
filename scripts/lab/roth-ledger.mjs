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
 * roth-ledger.mjs — what does the Roth actually COST, year by year? (design 84 P3 / G3)
 *
 * A Roth held by an Australian resident is a foreign trust to the ATO: distributed
 * earnings are ordinary income under s99B ITAA 1936, with **no** foreign tax credit,
 * because the US levies nothing for FITO to relieve. But those earnings are booked into
 * `auOrdinaryIncomeYTD` alongside every other receipt, and the AU return has no Roth
 * row — so a single run cannot say what the wrapper cost. Only a difference between
 * arms can, and a difference tells you the size of an effect while explaining nothing
 * about where it came from.
 *
 * This is the missing instrument. It runs ONE scenario and attributes the Australian
 * tax bill to the Roth, per year, at the right rate.
 *
 * ─── why the marginal rate, and why by removal ──────────────────────────────────
 *
 * An average rate would understate the charge badly. The Roth slice does not sit at
 * the bottom of the return — it stacks on top of whatever else the household realised
 * that year, so it is taxed in the highest bracket the year reaches. This computes the
 * attributable tax by REMOVAL: settle the year as it happened, then settle it again
 * with the Roth slice taken out, and difference the two.
 *
 *     attributable = tax(as it happened) − tax(without the Roth slice)
 *
 * Removal, not addition. The slice is already in the accumulators by settle time, so
 * stacking another copy on top would price a second, hypothetical withdrawal and
 * double-count. Removal answers the question actually being asked: given everything
 * else this household did, what did the Roth add?
 *
 * Both settles go through the SAME branch the engine uses — per-person when
 * `auPersonOrdinaryIncomeYTD` is populated, household otherwise — so the "as it
 * happened" figure must reproduce the engine's own number. It is checked against the
 * settle action's `tax` every year and any drift is reported: that cross-foot is what
 * makes the attribution column trustworthy rather than merely plausible.
 *
 * ─── reading the output ─────────────────────────────────────────────────────────
 *
 * `wdCorpus` is contributions withdrawn — tax-free under s99B(2)(a) and penalty-free
 * under §72(t). A decant smaller than the contribution basis moves ONLY this, which
 * looks like action in the journal while reducing the Australian exposure by nothing.
 * If `wdEarnings` is zero while `wdCorpus` is large, the decant has not started
 * working yet.
 *
 * `margRate` is the rate the LAST dollar of Roth earnings paid. It is the number that
 * picks decant years: the good years are the ones with room underneath them.
 *
 * Usage:
 *   node scripts/lab/roth-ledger.mjs --scenario plan.json
 *   node scripts/lab/roth-ledger.mjs --scenario plan.json \
 *        --levers '{"rothDecant":{"startYear":2027,"endYear":2030,"annual":40000}}'
 *   node scripts/lab/roth-ledger.mjs --scenario plan.json --csv /tmp/roth.csv
 *
 * Options:
 *   --scenario <f>  workbench export; omitted ⇒ the synthetic default (engine smoke test)
 *   --index <n>     which scenario in the file (default 0)
 *   --levers <json> a lever bag, applied via buildVariant — point it at any arm
 *   --csv <path>    also write the per-year table as CSV
 *   --by-account    one row per Roth per year instead of the household aggregate
 *
 * Cost: runs with full telemetry (the bus is how actions are observed), so this is the
 * slow path — seconds, not milliseconds. That is fine for a report you read once and
 * wrong for a grid cell. Do not import it into a sweep.
 */

import { writeFileSync } from 'node:fs';

import { loadBaseConfig, parseSourceArgs, describeSource } from '../lib/scenario-source.mjs';
import { buildVariant }        from '../lib/variant.mjs';
import { openSim, quiet }      from '../lib/run.mjs';
import { money, pct, columns } from '../lib/format.mjs';
import { TaxSettleService }    from '../../src/finance/tax-settle-service.js';
import { toAUD }               from '../../src/finance/tax/tax-fx.js';

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const has  = (n) => argv.includes(`--${n}`);

if (has('help') || has('h')) {
  console.log(/** @type {string} */ (String(
    'roth-ledger.mjs — per-year Australian tax attributable to the Roth.\n'
    + 'See the file header for options and for how the attribution is computed.')));
  process.exit(0);
}

// The tax actions that put Roth money onto an Australian return. All three are
// s99B assessable and none carry US tax for FITO to relieve; the rollover pair covers
// converted principal, whose IRA-earnings portion is denied the corpus exemption.
const ROTH_AU_TAX_ACTIONS = new Set([
  'ROTH_WITHDRAWAL_EARNINGS_TAX',
  'ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_TAX',
  'ROTH_ROLLOVER_WITHDRAWAL_CONTRIB_TAX',
]);

const yearOf = (d) => new Date(d).getUTCFullYear();

/** Household total of one Roth ledger field, across every Roth in the plan. */
function sum(state, ownerOf, field) {
  let t = 0;
  for (const key of ownerOf.keys()) t += state[key]?.[field] ?? 0;
  return t;
}

function main() {
  const source = parseSourceArgs(argv);
  const { cfg: base, synthetic } = loadBaseConfig({
    file:  flag('scenario', source?.file ?? null),
    index: Number(flag('index', 0)),
  });

  const levers = flag('levers') ? JSON.parse(flag('levers')) : {};
  const cfg    = Object.keys(levers).length ? buildVariant(base, levers) : base;

  // stateKey → owner, so an earnings action can be attributed to the right person's
  // AU return (design 76 books per-person, and the settle computes per-person).
  const ownerOf = new Map();
  for (const a of cfg.accounts ?? []) {
    if (a.role === 'roth-ira') ownerOf.set(a.stateKey, a.ownerId ?? null);
  }
  if (ownerOf.size === 0) {
    console.error('roth-ledger: this scenario has no roth-ira account — nothing to report.');
    process.exit(1);
  }

  const svc      = new TaxSettleService();
  const perYear  = new Map();   // year → { slices: Map<stateKey, audAmount>, penaltyUsd, wdEarningsUsd }
  const settles  = new Map();   // year → { state (pre-settle clone), engineTax }

  const bucket = (y) => {
    if (!perYear.has(y)) perYear.set(y, { slices: new Map(), penaltyUsd: 0, wdEarningsUsd: 0 });
    return perYear.get(y);
  };

  // Year-boundary balances. Without these the table cannot distinguish "no s99B
  // exposure because the wrapper was decanted" from "no exposure because the wrapper
  // was never drawn" — opposite conclusions with identical tax columns.
  const sampler = (state, date) => ({
    year:     yearOf(date),          // the record carries no stamp of its own
    balance:  sum(state, ownerOf, 'balance'),
    contrib:  sum(state, ownerOf, 'contributionBasis'),
    earnings: sum(state, ownerOf, 'earningsBasis'),
    // Converted principal is the THIRD corpus layer (design 36). It comes out
    // s99B-free except for the IRA-earnings share each lot carries, so a fall in
    // it explains a balance fall without any tax action — sample it, or the leak
    // check below reports every corpus distribution as an escape (which is what
    // it did until design 84 G9 gave the drawdown path a way to reach it at all).
    rollContrib:  sum(state, ownerOf, 'rolloverContribBasis'),
    rollEarnings: sum(state, ownerOf, 'rolloverEarningsBasis'),
    residency: state.people?.[[...ownerOf.values()][0] ?? 'primary']?.residency ?? null,
  });

  const sim = openSim(cfg, { telemetry: 'full', sampler, samplerCadence: 'year-boundary' });

  // Roth → AU income, as it is booked. The AUD figure is taken with the rate live at
  // the action, which is the rate the reducer itself used — not the settle-date rate.
  sim.bus.subscribe('EXECUTION_END', { kind: 'ACTION' }, (msg) => {
    const action = msg.payload?.data?.action;
    if (!action || !ROTH_AU_TAX_ACTIONS.has(action.type)) return;
    const y = yearOf(msg.date);
    const b = bucket(y);
    b.penaltyUsd    += action.penaltyAmount ?? 0;
    b.wdEarningsUsd += action.amount ?? 0;
    // Only an AU resident is assessed; a US-resident draw contributes penalty only.
    if (action.residency !== 'AU') return;
    const key = action.stateKey ?? [...ownerOf.keys()][0];
    const aud = toAUD(action.amount ?? 0, 'USD', msg.sim.state);
    b.slices.set(key, (b.slices.get(key) ?? 0) + aud);
  });

  // The pre-settle state, captured BEFORE the reducer resets the YTD accumulators —
  // the only moment the year's Australian return still exists in full.
  sim.bus.subscribe('EXECUTION_BEGIN', { kind: 'ACTION' }, (msg) => {
    const action = msg.payload?.data?.action;
    if (action?.type !== 'AU_TAX_SETTLE_APPLY') return;
    settles.set(yearOf(msg.date), {
      state:     structuredClone(msg.sim.state),
      engineTax: action.tax ?? 0,
    });
  });

  quiet(() => sim.stepTo(new Date(cfg.simEnd)));

  const balances = new Map((sim.samples ?? []).map(r => [r.year, r]));

  // ── attribute ────────────────────────────────────────────────────────────────
  const rows  = [];
  const drift = [];
  for (const [year, s] of [...settles.entries()].sort((a, b) => a[0] - b[0])) {
    const b = perYear.get(year);
    const sliceTotal = b ? [...b.slices.values()].reduce((x, v) => x + v, 0) : 0;

    const asHappened = settleTotal(svc, s.state);
    if (Math.abs(asHappened - s.engineTax) > 1) {
      drift.push({ year, ours: asHappened, engine: s.engineTax });
    }

    let withoutRoth = asHappened;
    if (sliceTotal > 0) withoutRoth = settleTotal(svc, removeRothSlice(s.state, b.slices, ownerOf));

    const attributable = Math.max(0, asHappened - withoutRoth);
    const bal = balances.get(year);
    rows.push({
      year,
      residency:    bal?.residency ?? null,
      rothBalance:  bal?.balance   ?? null,
      rothContrib:  bal?.contrib   ?? null,
      rothEarnings: bal?.earnings  ?? null,
      rothRollContrib:  bal?.rollContrib  ?? 0,
      rothRollEarnings: bal?.rollEarnings ?? 0,
      auOrdinary:   s.state.auOrdinaryIncomeYTD ?? 0,
      slice:        sliceTotal,
      penaltyUsd:   b?.penaltyUsd ?? 0,
      wdEarningsUsd: b?.wdEarningsUsd ?? 0,
      auTaxTotal:   asHappened,
      attributable,
      margRate:     sliceTotal > 0 ? attributable / sliceTotal : null,
    });
  }

  report({ rows, drift, cfg, synthetic, source: flag('scenario', null) });
  if (flag('csv')) writeCsv(flag('csv'), rows);
}

/**
 * Total AU liability for a state, through the SAME branch `AuTaxSettleHandler` picks.
 * Mirroring it is what lets the "as it happened" column be cross-footed against the
 * engine's own figure — a bespoke reimplementation could not be checked.
 */
function settleTotal(svc, state) {
  if (state.auPersonOrdinaryIncomeYTD && Object.keys(state.auPersonOrdinaryIncomeYTD).length > 0) {
    const details = svc.computeAuTaxPerPerson(state);
    if (details.length > 0) return details.reduce((sum, p) => sum + p.taxDetail.netLiability, 0);
  }
  return svc.computeAuTax(state).netLiability;
}

/**
 * The counterfactual: the same year with the Roth's contribution to it removed.
 *
 * Both the household accumulator and the OWNER's per-person entry have to come down
 * together. Removing only the household figure would leave the per-person branch — the
 * one the settle actually takes — completely unchanged, and the attribution would come
 * back as zero for every year: a confident, well-formatted "the Roth costs nothing".
 */
function removeRothSlice(state, slices, ownerOf) {
  const next = { ...state };
  let total = 0;
  const byPerson = { ...(state.auPersonOrdinaryIncomeYTD ?? {}) };

  for (const [stateKey, aud] of slices) {
    total += aud;
    const owner = ownerOf.get(stateKey);
    if (owner != null && byPerson[owner] != null) {
      byPerson[owner] = Math.max(0, byPerson[owner] - aud);
    }
  }
  next.auOrdinaryIncomeYTD = Math.max(0, (state.auOrdinaryIncomeYTD ?? 0) - total);
  if (Object.keys(byPerson).length > 0) next.auPersonOrdinaryIncomeYTD = byPerson;
  return next;
}

function report({ rows, drift, cfg, synthetic, source }) {
  console.log(`\nRoth ledger — ${describeSource({ source, synthetic })}`);
  console.log(`horizon ${new Date(cfg.simStart).getUTCFullYear()}–${new Date(cfg.simEnd).getUTCFullYear()}`);
  if (synthetic) console.log('** SYNTHETIC DEFAULT ** — an engine check, not a statement about a plan.');

  // ── the leak check ───────────────────────────────────────────────────────────
  // Money can leave a Roth without emitting a withdrawal-tax action, in which case
  // Australia never assesses it and every tax column below is understated while
  // looking perfectly well-formed. Balance is the independent witness: while resident
  // and past the growth, a fall the booked withdrawals do not explain is a leak.
  //
  // "Explained" means SOME ledger layer came down by it. Three of the four are
  // s99B corpus and emit nothing on the way out — regular contributions, converted
  // principal, and (for the converted part) everything except each lot's stamped
  // IRA-earnings share. Counting only the earnings actions would flag every corpus
  // distribution as an escape.
  const leaks = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1], cur = rows[i];
    if (cur.residency !== 'AU' || prev.rothBalance == null || cur.rothBalance == null) continue;
    const drop = prev.rothBalance - cur.rothBalance;
    if (drop <= 1000) continue;                       // growth or noise
    const booked = cur.wdEarningsUsd
                 + (prev.rothContrib     - cur.rothContrib)
                 + (prev.rothRollContrib - cur.rothRollContrib);
    if (drop - booked > Math.max(1000, drop * 0.05)) {
      leaks.push({ year: cur.year, drop, booked, gap: drop - booked });
    }
  }
  if (leaks.length > 0) {
    console.log(`\n!! ${leaks.length} year(s) where the Roth balance FELL by more than the`);
    console.log('   withdrawals booked against it. Money left the wrapper without emitting a');
    console.log('   withdrawal-tax action, so s99B was never applied to it and every tax column');
    console.log('   below UNDERSTATES the cost of holding. Do not compare arms until this is');
    console.log('   understood — the hold arm is the one it flatters.');
    for (const l of leaks.slice(0, 6)) {
      console.log(`   ${l.year}: balance −${money(l.drop)}, booked ${money(l.booked)}, unexplained ${money(l.gap)}`);
    }
    if (leaks.length > 6) console.log(`   …and ${leaks.length - 6} more`);
  }

  const assessed = rows.filter(r => r.slice > 0);
  if (assessed.length === 0) {
    console.log('\nNo Roth earnings were assessed in Australia over this run.');
    console.log('That is a real answer if the wrapper was emptied before the move, and a');
    console.log('SETUP problem if it was not — check residency, and check that the decant');
    console.log('actually drew earnings rather than only corpus.');
  }

  // Every year with a Roth still standing OR any Roth activity: the balance
  // trajectory is what tells you WHY a tax column is empty.
  const shown = rows.filter(r => (r.rothBalance ?? 0) > 1 || r.slice > 0 || r.penaltyUsd > 0);
  columns({
    title: 'Roth balance and the Australian tax attributable to it, by year',
    rows:  shown,
    columns: [
      { head: 'year',       get: r => r.year, width: 7, align: 'left' },
      { head: 'res',        get: r => r.residency ?? '—', width: 5 },
      { head: 'balance $',  get: r => money(r.rothBalance),  width: 13 },
      { head: 'corpus $',   get: r => money(r.rothContrib),  width: 12 },
      // Converted principal, kept in its OWN column rather than folded into corpus.
      // It is corpus for the most part, but each lot carries a stamped IRA-earnings
      // share that s99B(2)(a) refuses the exemption to, so "how much of the wrapper
      // is conversions" is a different question from "how much is contributions" —
      // and under §408A(d)(4)(B) it is drawn BEFORE earnings, which is what decides
      // whether a given year's withdrawal is assessable at all.
      { head: 'convtd $',   get: r => money(r.rothRollContrib), width: 12 },
      { head: 'earnings $', get: r => money(r.rothEarnings), width: 13 },
      { head: 'wdEarn $',   get: r => money(r.wdEarningsUsd), width: 12 },
      { head: 'penalty $',  get: r => money(r.penaltyUsd),   width: 11 },
      { head: 'Roth sl A$', get: r => money(r.slice),        width: 13 },
      { head: 'marg rate',  get: r => pct(r.margRate) },
      { head: 'attrib A$',  get: r => money(r.attributable), width: 12 },
    ],
  });

  const sum = (k) => rows.reduce((t, r) => t + (r[k] ?? 0), 0);
  const totalSlice = sum('slice'), totalAttrib = sum('attributable');
  console.log('\nLifetime');
  console.log(`  §72(t) penalty paid                 ${money(sum('penaltyUsd'))} (USD)`);
  console.log(`  Roth earnings assessed in AU        ${money(totalSlice)} (AUD)`);
  console.log(`  AU tax attributable to the Roth     ${money(totalAttrib)} (AUD)`);
  if (totalSlice > 0) {
    console.log(`  effective rate on the Roth slice    ${pct(totalAttrib / totalSlice)}`);
  }

  if (drift.length > 0) {
    console.log(`\n!! CROSS-FOOT FAILED in ${drift.length} year(s) — the attribution is NOT trustworthy.`);
    console.log('   This reporter reproduced a different liability than the engine settled, so the');
    console.log('   counterfactual is being differenced against the wrong baseline. Investigate');
    console.log('   before quoting any number above.');
    for (const d of drift.slice(0, 5)) {
      console.log(`   ${d.year}: ours ${money(d.ours)} vs engine ${money(d.engine)}`);
    }
  }
}

function writeCsv(path, rows) {
  const head = 'year,wdEarningsUsd,penaltyUsd,auOrdinaryAud,rothSliceAud,marginalRate,attributableAud,auTaxTotalAud';
  const body = rows.map(r => [
    r.year, r.wdEarningsUsd, r.penaltyUsd, r.auOrdinary, r.slice,
    r.margRate ?? '', r.attributable, r.auTaxTotal,
  ].join(','));
  writeFileSync(path, `﻿${[head, ...body].join('\n')}\n`);
  console.log(`\nwrote ${path}`);
}

main();
