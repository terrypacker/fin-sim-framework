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
 * export-json.mjs — write an arm's cfg as a workbench-importable scenario export.
 *
 * The lab builds its cfg in memory and hands it straight to `ScenarioLoader.load`. The
 * browser's Upload button takes the same object one envelope out: `{ scenarios: [record] }`,
 * where a record is a cfg plus the RECORD-IDENTITY fields (`id`, `name`, `order`, `prebuilt`,
 * `scenarioId`) that a cfg does not carry. So an export is the cfg wearing those — see below
 * for why it is the cfg itself and not `serializeScenario`'s output.
 *
 * ─── the id is deliberately ABSENT ──────────────────────────────────────────────────
 *
 * `ScenarioRegistry.upsertUserScenarios` is an UPSERT keyed on `id`: a record whose `u:<N>`
 * matches something already in localStorage UPDATES it in place, silently taking that
 * scenario's config with it. That is the same hazard `getNextUserScenarioId` documents having
 * cost Copy once already. Emitting no `id` takes the other branch — the registry mints a
 * fresh `u:<N>` past every id currently loaded — so an import can only ever ADD. `active` is
 * omitted for the same reason: an export that arrives claiming to be active would silently
 * switch the workbench away from whatever the user was looking at.
 *
 * ─── the cfg is NOT run through `serializeScenario` ─────────────────────────────────
 *
 * That looks like the sanctioned path and is the wrong one here. `_serializeAccount` reads a
 * LIVE account instance — `account.type` is a class field and `__type` falls back to
 * `constructor.name` — whereas `buildDefaultConfig` emits account LITERALS that already carry
 * `__type` and have no `type` at all. Serializing those degrades every one of them to
 * `__type: 'Object', type: null`, and the failure is not subtle: `usStockAccount` stops being
 * a BROKERAGE account, so `liquidityGraph`'s sleeve-narrowing validator rejects the graph and
 * the import throws on load. (Measured, not reasoned: the first version of this file did it.)
 *
 * `buildDefaultConfig`'s output IS the serialized shape — plain records, `__type`
 * discriminators, full ISO date strings — which is exactly what `ScenarioSerializer` would be
 * asked to produce. So the record is the cfg, JSON-round-tripped, wearing the identity fields.
 * `_assertSerializable` below is what holds that claim: a cfg that ever grows a `Date` or a
 * class instance stops silently surviving the trip and says so.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { IntlRetirementScenario } from '../../../src/scenarios/intl-retirement-scenario.js';

import { buildScenario } from './scenario.mjs';
import { arms }          from './arms.mjs';

/**
 * Fields that identify a scenario RECORD rather than describe its configuration — the ones a
 * cfg does not carry. Mirrors `ScenarioService.RECORD_IDENTITY_FIELDS`; `id` and `active` are
 * the two deliberately left unset (see the header).
 */
const IDENTITY = Object.freeze({ order: 100, prebuilt: false });

/**
 * Throw unless `value` survives a JSON round-trip unchanged.
 *
 * The whole export rests on the cfg already being in serialized shape. A `Date`, a class
 * instance or a function would each cross the wire as something else, and every one of those
 * failures is silent on this path: the file writes, the browser loads it, and the scenario is
 * subtly not the one the lab ran.
 *
 * An `undefined` OBJECT PROPERTY is fine and is expected: `buildDefaultConfig` writes
 * `stateMoveYear: p.stateMoveYear ?? undefined` for a dozen optional keys, and the loader
 * reads absent and undefined identically (`if (val === undefined) continue`). Inside an ARRAY
 * it is not fine — JSON turns a hole into `null`, which is a value — so the array branch
 * checks each element rather than trusting the object rule.
 */
function _assertSerializable(value, path = 'cfg', inArray = false) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function') throw new Error(`${path} is a function, which JSON drops`);
    if (value === undefined && inArray) {
      throw new Error(`${path} is an undefined array element; JSON rewrites it to null`);
    }
    return;
  }
  if (value instanceof Date) {
    throw new Error(`${path} is a Date; buildDefaultConfig is expected to emit ISO strings`);
  }
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${path} is a ${value.constructor?.name ?? 'class'} instance, not a plain record`);
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => _assertSerializable(v, `${path}[${i}]`, true));
    return;
  }
  for (const k of Object.keys(value)) _assertSerializable(value[k], `${path}.${k}`);
}

/**
 * Turn one lab cfg into a scenario RECORD.
 *
 * @param {object} cfg    a cfg from `buildScenario`
 * @param {string} name   the name the workbench will show
 * @returns {object} a record for the `{ scenarios: [...] }` envelope
 */
export function toScenarioRecord(cfg, name) {
  _assertSerializable(cfg);

  const record = {
    // A JSON clone, not a reference: the caller still holds this cfg and may run it, and
    // `ScenarioLoader.load` mutates a cfg in place (alias rewrites, the params sync, the
    // design 55 §14 de-generate, a live `scenarioClass` stamped onto it).
    ...JSON.parse(JSON.stringify(cfg)),
    name,
    ...IDENTITY,
    // The serializable form of the scenario class, which the loader resolves back into
    // `cfg.scenarioClass` so the scenario-level param schema and drift-merge apply.
    scenarioId: IntlRetirementScenario.scenarioId(),
  };

  // `__type` is what `deserializePersonsAccounts` reconstructs an account's CLASS from, and
  // therefore what gives `usStockAccount` the BROKERAGE type the pool validator demands. A
  // record that lost it would still write, and then throw on load in the browser.
  for (const a of record.accounts ?? []) {
    if (!a.__type || a.__type === 'Object') {
      throw new Error(`account '${a.stateKey ?? a.name}' has no usable __type ('${a.__type}') — `
        + `the record is not in serialized shape and will not load`);
    }
  }

  // `id`/`active` must be ABSENT, not present-and-undefined. Asserted rather than assumed:
  // a cfg that ever carries one would hand the browser an overwrite.
  if ('id' in record || 'active' in record) {
    throw new Error('cfg carries an id/active field; strip it — an import must never overwrite');
  }
  return record;
}

/**
 * Build the requested arms and write them as one importable file.
 *
 * All arms land in ONE document because that is how they stay comparable in the workbench:
 * `upsertUserScenarios` gives each its own fresh id, so importing the file adds N scenarios
 * that differ only in `liquidityGraph`.
 *
 * @param {object}   o
 * @param {string[]} o.armKeys   which arms, e.g. ['C']
 * @param {string}   o.file      output path
 * @param {string|null} o.shock  shock preset, or null for no crash
 * @param {number}   o.crash     crash year (ignored when shock is null)
 * @param {string}   [o.tag]     suffix for the scenario names
 * @returns {{file:string, names:string[]}}
 */
export function exportArms({ armKeys, file, shock, crash, tag = '' }) {
  const wanted = new Set(armKeys);
  const chosen = arms().filter(a => wanted.has(a.key));
  const unknown = armKeys.filter(k => !chosen.some(a => a.key === k));
  if (unknown.length) throw new Error(`unknown arm(s): ${unknown.join(', ')}`);

  const scenarios = chosen.map((arm) => {
    const cfg = buildScenario({
      params: {
        liquidityGraph: arm.graph,
        shocks: shock ? [{ preset: shock, startDate: `${crash}-01-01` }] : [],
      },
    });
    const name = `Seq-risk ${arm.key} — ${arm.label}${tag ? ` (${tag})` : ''}`;
    return toScenarioRecord(cfg, name);
  });

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ scenarios }, null, 2));
  return { file, names: scenarios.map(s => s.name) };
}
