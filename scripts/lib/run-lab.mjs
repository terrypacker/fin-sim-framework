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
 * run-lab.mjs — the shared half of design 81 §10's script surface.
 *
 * Six tools (`run:inspect`, `run:replay`, `run:branch`, `run:sweep`, `run:attribute`,
 * `run:seeds`) that all do the same four things first: find a recorded run in a scenario,
 * say what it decides and when, build a VARIANT of it, and run the variant. Written once
 * here for the reason `grid.mjs` exists — six copies of "find the bag, select the run" is
 * six places the CLI and the app can come to disagree about what a run is.
 *
 * ─── a run is a param, so the lab is a param edit ────────────────────────────────
 *
 * This is the payoff design 81 §9 predicted, arriving as an absence of code. Under the old
 * design a "counterfactual at epoch 12" needed a bespoke driver that re-seeded a snapshot and
 * replayed a log. Here it is: copy the scenario, add a row to the bag, run it. Every tool
 * below is `withActiveRun` + `runCfg`, and the interesting part of each is what it puts in the
 * bag — not how it runs anything.
 *
 * ─── the ONE selector, again ─────────────────────────────────────────────────────
 *
 * `resolveActiveMpcRun` / `activeDecisionsAt` are imported, never re-implemented, for the
 * discipline design 109 §7 records: normalizing the same object three times with three
 * slightly different option sets is how it comes to mean three things. The CLI must read a
 * run exactly as the engine does, or `run:inspect` describes a plan the simulation is not
 * playing.
 */

import { resolveActiveMpcRun, activeDecisionsAt, describeRunSource }
  from '../../src/finance/mpc/run-schedule.js';
import { cloneCfg, runCfg, fmtUsd } from './scenario-probe.mjs';

/** The `mpcRuns` bag on a scenario cfg, as a plain object (never null). */
export function runBagOf(cfg) {
  const v = (cfg?.params ?? []).find(p => (p.key ?? p.name) === 'mpcRuns')?.value;
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
}

/** Every recorded run in a scenario, with the label the app's picker shows. */
export function listRuns(cfg) {
  return Object.entries(runBagOf(cfg))
    .map(([runId, entry]) => ({
      runId, entry,
      label: describeRunSource(entry?.source, runId),
      rows:  Array.isArray(entry?.decisions) ? entry.decisions.length : 0,
    }));
}

/**
 * The run a tool operates on: the one named, else the scenario's own selection, else the
 * only one there is.
 *
 * Falling back to `mpcActiveRun` rather than to "the first" is deliberate: a scenario that
 * already selects a run has answered the question, and a tool that silently picked a
 * different entry would report on a plan the file does not run. With several runs and no
 * selection it REFUSES and lists them, because guessing there is how a session ends up
 * comparing two things it thinks are one.
 */
export function pickRun(cfg, runId = null) {
  const runs = listRuns(cfg);
  if (runs.length === 0) throw new Error('this scenario carries no recorded MPC runs (`mpcRuns` is empty)');

  if (runId) {
    const hit = runs.find(r => r.runId === runId);
    if (!hit) {
      throw new Error(`no recorded run '${runId}'. Available:\n`
        + runs.map(r => `  ${r.runId}  ${r.label}`).join('\n'));
    }
    return hit;
  }

  const selected = (cfg?.params ?? []).find(p => (p.key ?? p.name) === 'mpcActiveRun')?.value;
  const active = selected ? runs.find(r => r.runId === selected) : null;
  if (active) return active;
  if (runs.length === 1) return runs[0];

  throw new Error(`this scenario carries ${runs.length} recorded runs and selects none — `
    + `name one with --run:\n${runs.map(r => `  ${r.runId}  ${r.label}`).join('\n')}`);
}

/** Write a param into a cfg's params list, creating a minimal entry when it is absent. */
function _setParam(cfg, key, value, type) {
  const p = (cfg.params ?? []).find(pp => (pp.key ?? pp.name) === key);
  if (p) { p.value = value; return; }
  if (!Array.isArray(cfg.params)) cfg.params = [];
  cfg.params.push({ name: key, label: key, type, value });
}

/**
 * A COPY of the scenario playing `entry` under `runId`.
 *
 * `entry` defaults to the one already in the bag, so the common case is "select this run".
 * Passing a modified entry is how every variant below is built — a branch, a lever removed,
 * a swept value. The bag is replaced rather than merged so an experiment cannot inherit a
 * half-edited entry from the file.
 */
export function withActiveRun(cfg, runId, entry = null, { enabled = true } = {}) {
  const next = cloneCfg(cfg);
  const bag  = { ...runBagOf(next) };
  if (entry) bag[runId] = entry;
  _setParam(next, 'mpcRuns',       bag,     'MpcRuns');
  _setParam(next, 'mpcActiveRun',  runId,   'MpcRunSelect');
  _setParam(next, 'mpcRunEnabled', enabled, 'Boolean');
  return next;
}

/**
 * A COPY of the scenario with no run playing — the BASE plan, and the control every
 * comparison below needs.
 *
 * `mpcRunEnabled: false` rather than clearing the selection, so the control differs from the
 * arm in exactly one param. Clearing `mpcActiveRun` would also work and would differ in two,
 * which is the confound design 110 §6.5 keeps finding in pooled studies.
 */
export function withoutRun(cfg) {
  const next = cloneCfg(cfg);
  _setParam(next, 'mpcRunEnabled', false, 'Boolean');
  return next;
}

/** The run's rows, normalized exactly as the engine normalizes them (sorted, junk dropped). */
export function decisionsOf(entry, runId = 'run') {
  const run = resolveActiveMpcRun({ mpcRuns: { [runId]: entry }, mpcActiveRun: runId });
  return run?.decisions ?? [];
}

/** The decisions IN FORCE at a date — what the simulation would be running on then. */
export function inForceAt(entry, date, runId = 'run') {
  const run = resolveActiveMpcRun({ mpcRuns: { [runId]: entry }, mpcActiveRun: runId });
  const ms  = new Date(date).getTime();
  const at  = activeDecisionsAt(run, ms);
  if (!at) return { throughMs: null, rows: [] };
  const rows = [];
  for (const [lever, list] of at.byLever) for (const r of list) rows.push({ lever, ...r });
  rows.sort((a, b) => a.lever.localeCompare(b.lever) || a.key.localeCompare(b.key));
  return { throughMs: at.throughMs, rows };
}

/** The distinct levers a run decides, in a stable order. */
export function leversOf(entry, runId = 'run') {
  return [...new Set(decisionsOf(entry, runId).map(r => r.lever))].sort();
}

/**
 * The entry with one lever's rows removed.
 *
 * `run:attribute`'s primitive, and the reason it is a REMOVAL rather than a substitution:
 * dropping a lever's rows leaves the base scenario's own value governing it, which is the
 * only counterfactual that is both well-defined and authored by somebody. Substituting "the
 * last epoch's value" instead would compare the run against a plan nobody ever chose.
 */
export function withoutLever(entry, lever) {
  return { ...entry, decisions: (entry?.decisions ?? []).filter(d => d?.lever !== lever) };
}

/**
 * The entry with rows added (or superseding) at a date — one counterfactual.
 *
 * Superseding, not editing: a later row on the same (lever, key) wins from its date, which is
 * exactly the forward-effective revision the mechanism already supports. Rewriting the
 * original row would change the plan's PAST as well, which is a different question and not
 * the one `--at` asks.
 */
export function branchAt(entry, at, sets) {
  const date = new Date(at).toISOString();
  return { ...entry, decisions: [...(entry?.decisions ?? []), ...sets.map(s => ({ ...s, date }))] };
}

/**
 * Parse `--set 'LEVER:key=value'`, or `'key=value'` when the run leaves no doubt.
 *
 * The lever is part of a row's identity (§4.4), so it cannot be optional in general: two
 * levers may legitimately decide the same key. It IS optional when exactly one lever in this
 * run decides that key, which is the usual case and saves the typing. Ambiguity is reported
 * with both candidates rather than resolved by a rule the user would have to know.
 */
export function parseSet(spec, entry, runId = 'run') {
  const eq = String(spec).indexOf('=');
  if (eq < 0) throw new Error(`--set '${spec}': expected LEVER:key=value or key=value`);
  const lhs = spec.slice(0, eq).trim();
  const raw = spec.slice(eq + 1).trim();
  const value = raw === '' ? null : (Number.isFinite(Number(raw)) ? Number(raw) : raw);

  const colon = lhs.indexOf(':');
  if (colon > 0) return { lever: lhs.slice(0, colon).trim(), key: lhs.slice(colon + 1).trim(), value };

  // Sorted, so the message is the same on every run rather than following whichever lever
  // happened to decide first — an error a user pastes into a bug report has to be stable.
  const owners = [...new Set(decisionsOf(entry, runId).filter(d => d.key === lhs).map(d => d.lever))].sort();
  if (owners.length === 1) return { lever: owners[0], key: lhs, value };
  if (owners.length === 0) {
    throw new Error(`--set '${spec}': no lever in this run decides '${lhs}'. `
      + 'Name it explicitly as LEVER:key=value.');
  }
  throw new Error(`--set '${spec}': '${lhs}' is decided by ${owners.join(' and ')} — `
    + 'name one as LEVER:key=value.');
}

/**
 * Run one arm and return the solvency-first summary `scenario-probe` already defines.
 *
 * `telemetry: 'off'` because nothing here reads the journal, and it is ~12x on a 44-year run
 * — which is what makes a six-cell sweep practical at all.
 */
export function runArm(cfg, { to = null } = {}) {
  return runCfg(cfg, { to, telemetry: 'off' });
}

/** `+$12,345` / `−$2,000` / `—`, for a delta column. */
export function fmtDelta(n) {
  if (!Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}${fmtUsd(Math.abs(n))}`;
}

/** One line per arm, with a delta against a baseline. Solvency first, always. */
export function reportRow(label, r, base = null, { width = 30 } = {}) {
  const verdict = r.solvent
    ? '✅ solvent'
    : `❌ ruin ${r.outOfFundsDate} (${r.deficitMonths}mo)`;
  const delta = base ? `  Δ ${fmtDelta((r.netWorth ?? 0) - (base.netWorth ?? 0))}` : '';
  console.log(`  ${label.padEnd(width)} ${verdict.padEnd(30)} NW ${fmtUsd(r.netWorth).padStart(14)}${delta}`);
}

/** The header every tool prints, so a transcript says which plan it was about. */
export function printRunHeader(file, cfg, run) {
  console.log(`\n${file} — ${cfg.name ?? '(unnamed)'}`);
  console.log(`  run ${run.runId}: ${run.label} · ${run.rows} row(s)\n`);
}
