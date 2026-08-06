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
 * mc-run.mjs — run Monte Carlo ARMS from a spec and write raw per-path results.
 *
 * An "arm" is one decision variant — retire now vs work another year, sell an asset
 * vs hold it — run over many sampled worlds. Arms only mean something in comparison,
 * so this writes RAW per-path rows (one file per arm) and leaves interpretation to
 * `mc-report.mjs`. That split is deliberate: an arm costs minutes of compute, a
 * report costs milliseconds, and the report is what you rewrite ten times.
 *
 * Usage:
 *   node scripts/montecarlo/mc-run.mjs --arms <spec.json> --out <dir> [-n 400] [options]
 *   node scripts/montecarlo/mc-run.mjs --arms scripts/specs/example-arms.json --out /tmp/mc -n 20
 *
 *   --arms <file>       REQUIRED. `{ "base": {...}, "arms": { "<key>": {levers} } }`
 *   --out <dir>         REQUIRED. One `<armKey>.json` per arm is written here.
 *   -n <count>          paths per arm (default 400)
 *   --only <keys>       comma-separated subset of arms to run
 *   --scenario <file>   base scenario export; omitted => synthetic default
 *   --index <n>         scenario index in that file
 *
 *   Risk model (what gets sampled):
 *   --paths             stochastic year-by-year equity returns (real sequence risk)
 *   --vol <n>           equity return vol when --paths (default 0.18)
 *   --drift <mode>      GEOMETRIC (default) | NONE — see below
 *   --property-paths    stochastic property appreciation path
 *   --shock             enable the manufactured single crash (severity + date)
 *   --no-recentre       skip the check that MC centers match the scenario. The runner
 *                       re-centres itself now, so this only silences the verification.
 *
 *   --mix               also record the per-year ASSET MIX on every path (design 82 §8),
 *                       so `mc-report.mjs` can report mix bands, threshold probabilities
 *                       and the mix conditioned on failure. Off by default: it builds an
 *                       allocation cube per sampled year, and an ordinary solvency run
 *                       has no reader for it. Adds roughly a megabyte per arm at n=400.
 *
 * ─── choosing a risk model ───────────────────────────────────────────────────
 *
 * Default (neither --paths nor --shock): only the LONG-RUN AVERAGE return is
 * uncertain — one rate is drawn per path and held for the whole horizon. This
 * captures estimation error but contains NO sequence-of-returns risk, so it
 * UNDERSTATES failure probability. Fine for "how wrong could my average be",
 * wrong for "could a bad decade ruin me".
 *
 * `--shock` adds one crash of random severity at a random date: a partial, and
 * frankly crude, sequence-risk proxy aimed at the early window where a crash does
 * the most damage. It was the best available before stochastic paths existed.
 *
 * `--paths` is the real thing: each year draws its own return, so bad decades happen
 * endogenously. Prefer it. Note that combining `--paths` with `--shock` DOUBLE-COUNTS
 * the downside — with real paths a crash year is already in the process — so
 * `--shock` should normally be off when `--paths` is on.
 *
 * `--drift GEOMETRIC` reads the return anchor as a CAGR and compensates by σ²/2, so
 * adding volatility widens the spread WITHOUT quietly lowering the central outcome.
 * With `NONE` the anchor is an arithmetic mean and raising vol also drags the median
 * down, which conflates "more risk" with "less return" — two different questions.
 *
 * ─── common random numbers (do not break these) ──────────────────────────────
 *
 * Path i is seeded deterministically from i, so path i is the SAME WORLD in every
 * arm and `mc-report.mjs` can pair them and ask "in how many individual worlds did
 * this decision change the outcome" — a far sharper question than comparing two
 * failure rates. This only holds if every arm runs the same n and samples the same
 * variable set. Enabling an extra sampled variable in one arm silently destroys the
 * pairing, so the risk-model flags above apply to ALL arms in a batch by design.
 */

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadBaseConfig, parseSourceArgs, describeSource } from '../lib/scenario-source.mjs';
import { buildVariant } from '../lib/variant.mjs';
import { buildMcConfig, runArm } from '../lib/mc.mjs';
import { pct } from '../lib/format.mjs';
import { MC_SAMPLER_CADENCE } from '../../src/finance/monte-carlo/intl-retirement-mc-runner.js';

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const has  = (n) => argv.includes(n);

const specFile = flag('--arms');
const outDir   = flag('--out');
if (!specFile || !outDir) {
  console.error('usage: mc-run.mjs --arms <spec.json> --out <dir> [-n 400] [options]  (see file header)');
  process.exit(2);
}

const n     = Number(flag('-n') ?? flag('--n') ?? 400);
const vol   = Number(flag('--vol') ?? 0.18);
const drift = flag('--drift') ?? 'GEOMETRIC';
const paths = has('--paths');
const propertyPaths = has('--property-paths');
const shock = has('--shock');
const recentre = !has('--no-recentre');
const mix = has('--mix');

const spec = JSON.parse(readFileSync(specFile, 'utf8'));
const only = flag('--only')?.split(',').map(s => s.trim());
const armKeys = Object.keys(spec.arms ?? {}).filter(k => !only || only.includes(k));
if (!armKeys.length) { console.error('no arms selected'); process.exit(2); }

const source = parseSourceArgs(argv);
const base = loadBaseConfig(source);
mkdirSync(outDir, { recursive: true });

const stochastic = (paths || propertyPaths)
  ? {
      ...(paths ? { equity: true, equityVol: vol, equityModel: 'WHITE_NOISE', equityDrift: drift } : {}),
      ...(propertyPaths ? { property: true } : {}),
    }
  : null;

const riskModel = {
  paths, propertyPaths, shock, vol: paths ? vol : null, drift: paths ? drift : null, recentre, mix,
};

console.log(`\n${describeSource(base)}`);
console.log(`arms: ${armKeys.join(', ')}`);
console.log(`n=${n}/arm  risk model: ${describeRisk()}`);
if (paths && shock) {
  console.log('** --paths WITH --shock double-counts the downside; see the header note.');
}
console.log('');

function describeRisk() {
  const parts = [];
  parts.push(paths ? `stochastic equity paths (vol ${vol}, drift ${drift})` : 'constant sampled return');
  if (propertyPaths) parts.push('stochastic property path');
  if (shock) parts.push('manufactured crash');
  if (mix) parts.push('recording asset mix');
  if (!recentre) parts.push('** CENTER CHECK SKIPPED **');
  return parts.join(' + ');
}

/**
 * Serialize an arm, keeping the mix matrix COMPACT inside an otherwise readable file.
 *
 * `JSON.stringify(x, null, 1)` puts every array element on its own line, which is what
 * makes an arm file diffable — and what would turn 144,000 mix numbers into 144,000
 * lines and several megabytes of indentation. The matrix goes in through a sentinel so
 * the surrounding record keeps its formatting and the bulk arrays stay on one line.
 *
 * It stays INSIDE the arm file rather than beside it because `mc-report.mjs` globs the
 * directory for `*.json` and treats each hit as an arm; a sibling `<arm>.mix.json`
 * would silently join the next report as a nameless extra arm.
 */
function serializeArm(record, mixSeries) {
  const SENTINEL = '@@MIX_SERIES@@';
  const json = JSON.stringify({ ...record, mixSeries: mixSeries ? SENTINEL : null }, null, 1);
  return mixSeries
    ? json.replace(`"${SENTINEL}"`, JSON.stringify(mixSeries))
    : json;
}

for (const [order, key] of armKeys.entries()) {
  const levers = { ...(spec.base ?? {}), ...(spec.arms[key] ?? {}) };
  if (stochastic) levers.stochastic = { ...(levers.stochastic ?? {}), ...stochastic };

  const cfg = buildVariant(base.cfg, levers);
  const { mcConfig, shocks, recentred } = buildMcConfig(cfg, { shock, recentre });
  const { rows, mixSeries, pathShape, provenance, ms } = await runArm({ cfg, n, mcConfig, shocks, mix });

  const fails = rows.filter(r => r.failed).length;
  // `order` preserves the spec's arm sequence. mc-report reads a DIRECTORY, so
  // without it the report falls back to filesystem order and the default
  // baseline-vs-rest pairing gets an arbitrary baseline — the spec's first arm is
  // the one the author meant as the reference point.
  // `samplerCadence` stamps WHICH INSTANT the recorded series was read at (design 82
  // §8.3). Switching MC off design 78's event cadence re-baselined `timeSeries` — and
  // therefore `pathShape` — while leaving every run OUTCOME bit-identical, so an arm
  // from before the switch is indistinguishable from one after it and silently not
  // comparable. An unstamped arm is a pre-switch arm; mc-report says so out loud.
  writeFileSync(join(outDir, `${key}.json`), serializeArm({
    arm: key, order, n, source: base.source, synthetic: base.synthetic,
    samplerCadence: MC_SAMPLER_CADENCE,
    riskModel, levers, recentred, provenance, pathShape, rows,
  }, mixSeries));

  const extras = pathShape?.medianHouseCagr != null
    ? `  houseCAGR=${pct(pathShape.medianHouseCagr)} repair p50=$${Math.round((pathShape.medianRepairSpend ?? 0) / 1000)}k`
    : '';
  console.log(`${key.padEnd(24)} fail ${String(fails).padStart(4)}/${n} `
    + `(${pct(fails / n).padStart(6)})${extras}  ${(ms / 1000).toFixed(0)}s`
    + (recentred.length ? `  [!! ${recentred.length} centers off-scenario]` : ''));
  for (const line of recentred) console.log(`    !! ${line}`);
}

console.log(`\nraw rows → ${outDir}/`);
console.log(`report:  node scripts/montecarlo/mc-report.mjs --dir ${outDir}`);
if (mix) {
  console.log(`mix:     node scripts/montecarlo/mc-report.mjs --dir ${outDir} --html ${join(outDir, 'mc-mix.html')}`);
}
