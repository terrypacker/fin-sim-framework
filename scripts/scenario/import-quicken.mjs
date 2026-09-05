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
 * import-quicken.mjs — a Quicken portfolio export becomes a scenario's accounts.
 *
 * Reads a Quicken "Investing - Portfolio Value - By Account" CSV **exported with lots**,
 * maps it through a JSON mapping file, and writes an importable scenario export whose
 * accounts carry the real balances, the real per-lot cost bases and the real acquisition
 * dates — plus the `Security` records those lots are positions in.
 *
 *   node scripts/scenario/import-quicken.mjs \
 *     --csv  scenarios/quicken/export-with-lots.csv \
 *     --map  scenarios/quicken/mapping.json \
 *     --into scenarios/quicken/plan.json \
 *     --out  scenarios/quicken/plan-imported.json
 *
 * Run it with no `--out` first: that is a dry run, and it prints the whole report and
 * writes nothing.
 *
 * ─── why the lots export, and not the plain one ────────────────────────────────────
 *
 * Short vs. long term is computed per lot from `purchaseDate`, per country (AU Div 115
 * "at least 12 months", inclusive; US §1222(3) "more than 1 year", exclusive). The
 * non-lot export collapses each position to one blended row with no date, which
 * `holdings-fifo.js` reads as "carried in from boot" — oldest, always long-term. That is
 * a systematic understatement of tax on everything recently bought, and it is invisible.
 *
 * ─── what `--into` does, and what it deliberately does not ─────────────────────────
 *
 * `--into` names a workbench export to splice into. The output holds BOTH scenarios —
 * the original untouched, and a new record carrying the import — so the two can be
 * diffed in the workbench rather than one being silently replaced.
 *
 * Accounts the mapping does not name are LEFT EXACTLY AS THEY ARE. This tool restates
 * what Quicken knows about; it does not assert that Quicken knows about everything. The
 * AU side, the bequests and anything not yet set up keep their authored values.
 *
 * Without `--into` the output is a bare scenario — accounts, securities, dates and
 * nothing else. That is an inspection artifact, not a runnable plan: it has no toolsets,
 * no persons and no params, so importing it into the workbench gets you the numbers and
 * a drift-merge of the defaults for everything else.
 *
 * ─── the three writes that are not obvious ─────────────────────────────────────────
 *
 * **`cfg.initialState` is blanked.** It is a full second copy of every account,
 * holdings and all. This scenario has `toolsets`, so `ScenarioLoader` takes the compile
 * branch and regenerates it from `cfg.accounts` — but leaving a stale copy in the file
 * means a diff of the file is a lie, and a scenario that ever loses its toolsets would
 * load the pre-import balances instead.
 *
 * **`contributionBasis` params are re-synced.** Nine params in a plan of this shape
 * carry `node: {type:'account', field:'contributionBasis'}`. The param wins at load
 * (design 32), so writing only the account field leaves the old basis to reassert
 * itself against a new balance and break `contributionBasis + earningsBasis = balance`.
 *
 * **`simStart` moves to the snapshot date.** A portfolio export is stated as of a day.
 * Splicing a September snapshot into a plan that begins in January silently claims the
 * year's first eight months happened twice. `--keep-sim-start` opts out.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

import { parseFlags } from '../lib/cli.mjs';
import { money } from '../lib/format.mjs';
import { parseQuickenPortfolio } from '../lib/quicken-csv.mjs';
import { buildImport, IMPORT_LOT_PREFIX } from '../lib/quicken-import.mjs';

const opts = parseFlags(process.argv.slice(2), {
  usage: 'node scripts/scenario/import-quicken.mjs --csv <file> --map <file> [--into <file>] [--out <file>]',
  csv: { type: 'string', help: 'Quicken portfolio export, WITH lots (required)' },
  map: { type: 'string', help: 'JSON mapping file (required)' },
  into: { type: 'string', help: 'workbench export to splice into; omitted ⇒ a bare scenario' },
  out: { type: 'string', help: 'where to write; omitted ⇒ dry run, writes nothing' },
  name: { type: 'string', help: 'name for the new scenario record' },
  id: { type: 'string', help: 'id for the new scenario record' },
  index: { type: 'number', default: 0, help: 'which scenario in --into to splice' },
  keepSimStart: { type: 'flag', help: 'do NOT move simStart to the export snapshot date' },
  force: { type: 'flag', help: 'write even though errors were reported' },
});

if (!opts.csv || !opts.map) {
  console.error('\nimport-quicken: --csv and --map are both required.  -h for usage.\n');
  process.exit(2);
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const parsed = parseQuickenPortfolio(readFileSync(opts.csv, 'utf8'));
const mapping = readJson(opts.map);

// ── Resolve the target scenario ───────────────────────────────────────────────

let file = null, target = null;
if (opts.into) {
  file = readJson(opts.into);
  const list = Array.isArray(file?.scenarios) ? file.scenarios : null;
  if (!list?.length) {
    console.error(`\nimport-quicken: ${opts.into} has no \`scenarios\` array — that is the shape the `
      + `workbench exports.\n`);
    process.exit(2);
  }
  target = list[opts.index];
  if (!target) {
    console.error(`\nimport-quicken: --index ${opts.index} is out of range (${list.length} scenarios).\n`);
    process.exit(2);
  }
}

const result = buildImport(parsed, mapping, { targetAccounts: target?.accounts ?? [] });

// ── The report ────────────────────────────────────────────────────────────────

const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);

console.log(`\n══ Quicken import ═══════════════════════════════════════════════════════════`);
console.log(`  source     ${basename(opts.csv)}`);
console.log(`  snapshot   ${parsed.asOf ?? '(none in header)'}`);
console.log(`  mapping    ${basename(opts.map)}`);
console.log(`  target     ${opts.into ? `${basename(opts.into)} → "${target.name ?? target.id}"` : '(none — bare scenario)'}`);

const byStateKey = new Map((target?.accounts ?? []).map(a => [a.stateKey, a]));
const flaggedKeys = new Set(result.warnings.map(w => w.stateKey).filter(Boolean));

console.log(`\n  ── Accounts ──────────────────────────────────────────────────────────────`);
console.log(`  ${pad('stateKey', 28)}${rpad('before', 14)}${rpad('after', 14)}${rpad('Δ', 14)}${rpad('lots', 6)}  `);
let before = 0, after = 0;
for (const a of result.accounts) {
  const b = byStateKey.get(a.stateKey)?.balance ?? null;
  before += b ?? 0; after += a.balance;
  const flag = flaggedKeys.has(a.stateKey) ? ' ⚠' : '';
  console.log(`  ${pad(a.stateKey, 28)}${rpad(b == null ? '—' : money(b), 14)}${rpad(money(a.balance), 14)}`
    + `${rpad(b == null ? '—' : money(a.balance - b), 14)}${rpad(a.holdings.length, 6)}${flag}`);
}
console.log(`  ${pad('', 28)}${rpad(money(before), 14)}${rpad(money(after), 14)}${rpad(money(after - before), 14)}`
  + `${rpad(result.accounts.reduce((s, a) => s + a.holdings.length, 0), 6)}`);

const untouched = (target?.accounts ?? []).filter(a => !result.accounts.some(p => p.stateKey === a.stateKey));
if (untouched.length) {
  console.log(`\n  ── Left untouched (${untouched.length}) ────────────────────────────────────────`);
  console.log(`  ${untouched.map(a => a.stateKey).join(', ')}`);
}

console.log(`\n  ── Securities (${result.securities.length}) ─────────────────────────────────────────────`);
for (const s of result.securities) {
  console.log(`  ${pad(s.id, 14)}${pad(s.symbol || '—', 10)}${pad(s.rateKey ?? '—', 20)}${s.name ?? ''}`);
}

// Holding-period split, which is the whole reason the lots export is required.
const asOfMs = parsed.asOf ? Date.parse(`${parsed.asOf}T00:00:00Z`) : Date.now();
const YEAR = 365 * 24 * 3600 * 1000;
let shortMv = 0, longMv = 0, shortGain = 0, longGain = 0;
for (const a of result.accounts) {
  for (const h of a.holdings) {
    if (h.allocation === 'CASH') continue;
    const gain = h.marketValue - h.costBasis;
    const isLong = h.purchaseDate == null || (asOfMs - Date.parse(`${h.purchaseDate}T00:00:00Z`)) > YEAR;
    if (isLong) { longMv += h.marketValue; longGain += gain; } else { shortMv += h.marketValue; shortGain += gain; }
  }
}
console.log(`\n  ── Holding period (US §1222(3), at the snapshot date) ─────────────────────`);
console.log(`  ${pad('long-term', 14)}${rpad(money(longMv), 14)}  unrealized ${money(longGain)}`);
console.log(`  ${pad('short-term', 14)}${rpad(money(shortMv), 14)}  unrealized ${money(shortGain)}`);

if (result.warnings.length) {
  console.log(`\n  ── Data quality (${result.warnings.length}) ────────────────────────────────────────`);
  for (const w of result.warnings) console.log(`  ⚠ ${w.message}`);
}
if (result.errors.length) {
  console.log(`\n  ── ERRORS (${result.errors.length}) ────────────────────────────────────────────────`);
  for (const e of result.errors) console.log(`  ✗ ${e.message}`);
}

if (result.errors.length && !opts.force) {
  console.log(`\n  Nothing written — ${result.errors.length} error(s). These are mapping problems, not `
    + `Quicken\n  setup gaps; fix the mapping file. --force writes anyway.\n`);
  process.exit(1);
}
if (!opts.out) {
  console.log(`\n  Dry run — no --out, nothing written.\n`);
  process.exit(0);
}

// ── The write ─────────────────────────────────────────────────────────────────

const simStart = !opts.keepSimStart && parsed.asOf ? `${parsed.asOf}T00:00:00.000Z` : null;

let out;
if (target) {
  const imported = structuredClone(target);
  imported.id = opts.id ?? `${target.id ?? 'u:0'}-quicken`;
  imported.name = opts.name ?? `${target.name ?? 'Scenario'} (Quicken ${parsed.asOf ?? 'import'})`;
  imported.order = (target.order ?? 0) + 1;
  imported.active = false;

  const patchByKey = new Map(result.accounts.map(a => [a.stateKey, a]));
  imported.accounts = (imported.accounts ?? []).map((a) => {
    const patch = patchByKey.get(a.stateKey);
    if (!patch) return a;
    const { stateKey, ...fields } = patch;
    return { ...a, ...fields };
  });
  imported.securities = result.securities;

  // The param half of the design-32 pair. Both stores, or the account field is inert.
  const wanted = new Map(result.contributionBasisPatches.map(p => [p.stateKey, p.value]));
  imported.params = (imported.params ?? []).map((p) => {
    if (p?.node?.type !== 'account' || p.node.field !== 'contributionBasis') return p;
    if (!wanted.has(p.node.stateKey)) return p;
    return { ...p, value: wanted.get(p.node.stateKey) };
  });

  // Regenerated from cfg.accounts by the compile branch; a stale copy is a trap.
  imported.initialState = {};
  if (simStart) imported.simStart = simStart;

  out = { ...file, scenarios: [...file.scenarios, imported] };
} else {
  out = {
    scenarios: [{
      id: opts.id ?? 'u:quicken',
      name: opts.name ?? `Quicken import ${parsed.asOf ?? ''}`.trim(),
      order: 0,
      active: false,
      ...(simStart ? { simStart } : {}),
      accounts: result.accounts.map(a => ({ ...a, name: a.stateKey })),
      securities: result.securities,
      initialState: {},
    }],
  };
}

writeFileSync(opts.out, `${JSON.stringify(out, null, 2)}\n`);
console.log(`\n  Wrote ${opts.out}`);
console.log(`  ${result.accounts.length} account(s), `
  + `${result.accounts.reduce((s, a) => s + a.holdings.length, 0)} lot(s) prefixed "${IMPORT_LOT_PREFIX}", `
  + `${result.securities.length} securit${result.securities.length === 1 ? 'y' : 'ies'}.`);
if (simStart) console.log(`  simStart moved to ${simStart}.`);
console.log(`\n  Next:  node scripts/scenario/audit-scenario.mjs ${opts.out}\n`);
