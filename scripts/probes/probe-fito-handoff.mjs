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
 * probe-fito-handoff.mjs — design 83 G5. What is the Art. 22(2) figure, really?
 *
 * `UsTaxSettleHandler` hands Australia one number, `usTaxPaidOnUsSourceAud`, and it
 * is the entire input to the AU FITO. The treaty calls that number the US tax
 * "creditable against Australian tax in accordance with paragraph (2)". This probe
 * computes it four ways on the same run so the choice can be made on evidence
 * rather than on a reading, per design 83 §11 step 4.
 *
 *   V0  as shipped — netLiability(full) − netLiability(without US-source income),
 *       i.e. a differential of two liabilities that are already NET of the full FTC,
 *       including the re-sourced basket that IS the Art. 22(4) credit.
 *   V1  option (a) — the same differential with the Art. 22(4) credit suppressed in
 *       both passes. This is the minimal reading of 22(4)'s non-erosion sentence:
 *       the 22(2) figure must not be measured after the credit that may not reduce it.
 *       **Since design 83 G3 this is a NO-OP and V1 == V0.** G3 deleted the separate
 *       re-sourced basket, so there is no longer a credit line that IS the 22(4)
 *       relief — it is now blended into general and passive. The erosion did not go
 *       away (V2 still exceeds V0 by ~US\$1.0m lifetime); it stopped being separable
 *       by basket, which makes G5's fix harder than §11 assumed, not moot.
 *   V2  option (b) — a pre-credit differential (grossTax), i.e. the US tax on the
 *       US-source income before ANY foreign tax credit.
 *   V3  the composition, not a tax. Art. 22(2) is expressly limited to US tax "other
 *       than United States tax imposed ... solely by reason of citizenship", and
 *       Art. 27(1)(b) repeats the carve-out for sourcing. Every V above is a
 *       differential on the CITIZEN's worldwide return, so all of them include tax
 *       that 22(2) excludes. Whether that matters is a question about WHAT the
 *       US-source income is, so the probe reports it by action type and leaves the
 *       treaty article to the reader.
 *
 * Nothing here changes the model. It reports; §11 step 4 decides.
 *
 * Usage:
 *   node scripts/probes/probe-fito-handoff.mjs [--scenario <file.json>] [--index n]
 *                                              [--json] [--to YYYY-MM-DD]
 */

import { loadBaseConfig, parseSourceArgs, describeSource } from '../lib/scenario-source.mjs';
import { openSim, quiet } from '../lib/run.mjs';
import { money } from '../lib/format.mjs';
import { UsTaxSettleHandler, withoutUsSourceIncome } from '../../src/finance/tax/tax-settle-classes.js';
import { toAUD } from '../../src/finance/tax/tax-fx.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt  = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : dflt;
};

const loaded = loadBaseConfig(parseSourceArgs(argv));
const cfg    = loaded.cfg;
const asJson = flag('--json');

// ─── Intercept the settle to compute the variants against the SAME state ─────
//
// Wrapping the handler rather than re-deriving state afterwards is what makes the
// variants comparable: every V below sees the identical YTD accumulators, so the
// differences are the definition of the 22(2) figure and nothing else.
const rows = [];
const originalCall = UsTaxSettleHandler.prototype.call;
UsTaxSettleHandler.prototype.call = function ({ state }) {
  const svc = this._settleService;
  const full = svc.computeUsTax(state);

  // Shared with the handler on purpose — a local copy of this goes stale the moment
  // a new accumulator is added, and then the probe measures a different model.
  const without = svc.computeUsTax(withoutUsSourceIncome(state));

  // V1 — suppress the Art. 22(4) credit (the re-sourced basket) on the WITH side
  // too. The without-side already has it suppressed, post-G8.
  const noRelief = svc.computeUsTax({ ...state, ftcCurrentResourced: 0, ftcPoolResourced: {} });

  const v0 = Math.max(0, full.netLiability - without.netLiability);
  const v1 = Math.max(0, noRelief.netLiability - without.netLiability);
  const v2 = Math.max(0, full.grossTax - without.grossTax);

  rows.push({
    year: new Date(state.currentPeriods?.US?.startMs ?? 0).getUTCFullYear() || null,
    usSourceOrdinary: state.usSourceOrdinaryUsdYTD ?? 0,
    usSourceCapGains: state.usSourceCapGainsUsdYTD ?? 0,
    netLiability:     full.netLiability,
    resourcedCredit:  full.ftc?.resourced?.credit ?? 0,
    v0, v1, v2,
    v0Aud: toAUD(v0, 'USD', state),
    v1Aud: toAUD(v1, 'USD', state),
    v2Aud: toAUD(v2, 'USD', state),
  });

  return originalCall.call(this, { state });
};

const sim = quiet(() => openSim(cfg, { telemetry: 'full' }));
quiet(() => sim.stepTo(opt('--to') ? new Date(opt('--to')) : new Date(cfg.simEnd)));

// ─── V3: what the US-source income actually IS ───────────────────────────────
// Summed from the journal's per-action state diffs, so it is the model's own
// accounting rather than a second guess at it.
const composition = new Map();
for (const entry of sim.journal.journal) {
  for (const d of entry.stateDiff ?? []) {
    if (d.field !== 'usSourceOrdinaryUsdYTD' && d.field !== 'usSourceCapGainsUsdYTD') continue;
    const delta = (d.after ?? 0) - (d.before ?? 0);
    // The settle resets these to zero; that is not income.
    if (delta <= 0) continue;
    const key = `${entry.action.type} → ${d.field === 'usSourceCapGainsUsdYTD' ? 'capGains' : 'ordinary'}`;
    composition.set(key, (composition.get(key) ?? 0) + delta);
  }
}

const sum = (k) => rows.reduce((s, r) => s + r[k], 0);

if (asJson) {
  console.log(JSON.stringify({ rows, composition: Object.fromEntries(composition) }, null, 1));
} else {
  console.log(`\nAU FITO handoff — the Art. 22(2) figure, four ways — ${describeSource(loaded)}\n`);
  const head = ['year', 'US-src ord', 'US-src CG', '22(4) credit', 'V0 shipped', 'V1 no-22(4)', 'V2 pre-credit'];
  console.log(head.map((h, i) => (i === 0 ? h.padEnd(6) : h.padStart(15))).join(''));
  for (const r of rows) {
    if (r.usSourceOrdinary === 0 && r.usSourceCapGains === 0) continue;
    console.log([
      String(r.year ?? '?').padEnd(6),
      money(r.usSourceOrdinary).padStart(15),
      money(r.usSourceCapGains).padStart(15),
      money(r.resourcedCredit).padStart(15),
      money(r.v0).padStart(15),
      money(r.v1).padStart(15),
      money(r.v2).padStart(15),
    ].join(''));
  }
  console.log(`\nLifetime FITO funding (USD before conversion):`);
  console.log(`  V0 shipped      ${money(sum('v0')).padStart(14)}`);
  console.log(`  V1 no 22(4)     ${money(sum('v1')).padStart(14)}   `
    + `delta ${money(sum('v1') - sum('v0'))}`);
  console.log(`  V2 pre-credit   ${money(sum('v2')).padStart(14)}   `
    + `delta ${money(sum('v2') - sum('v0'))}`);

  console.log(`\nV3 — what the US-source income is (lifetime USD). Art. 22(2) excludes US tax`);
  console.log(`imposed "solely by reason of citizenship", and every V above is a differential`);
  console.log(`on the citizen's worldwide return, so each one includes tax 22(2) does not reach.`);
  console.log(`Which articles govern these items decides how much that matters:\n`);
  const items = [...composition.entries()].sort((a, b) => b[1] - a[1]);
  const total = items.reduce((s, [, v]) => s + v, 0);
  for (const [k, v] of items) {
    console.log(`  ${k.padEnd(48)}${money(v).padStart(14)}  ${(100 * v / total).toFixed(1)}%`);
  }
  console.log(`  ${'TOTAL'.padEnd(48)}${money(total).padStart(14)}`);
}
