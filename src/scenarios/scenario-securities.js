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
 * Authoring `cfg.securities` — the write half of design 94 §10.2e.
 *
 * ### Why this is not a service
 *
 * Every other editable record in this app (person, account, collectible, company equity,
 * bequest) is a service record on the config graph. A `Security` deliberately is not
 * (design 94 §4): the run's registry is PLAIN, FROZEN data shared BY REFERENCE across
 * every history snapshot, every journal clone and every MPC rollout of a run, and that
 * sharing is what makes it free (§6.4 — it took the workbench clone cost from +7.2% to
 * +0.5%). A live, mutable service copy alongside `cfg.securities` would be a second store
 * of the same truth, which is the shape this repo has already been bitten by twice (the
 * two param stores; `state.people`'s three drifted projections).
 *
 * So securities live in exactly one place — the active scenario record — and this module
 * is the only writer. `ScenarioSerializer.serializeScenario` already reads
 * `scenario.securities` off the record (it never came from a service), `snapshotServices`
 * does not touch the key, and `ScenarioLoader` projects it into `sim.state.securities`
 * through `scenarioSecurityRegistry`. Writing here is therefore enough for Save, Download,
 * Rebuild and the run to agree.
 *
 * ### What is NOT here
 *
 * The four synthetic market securities (`sec-auto-*`). They are minted at load, not
 * authored, and are not the user's to edit — surfacing them in an editable list would
 * invite an author to change what every migrated equity lot in that market resolves to.
 * They are still OFFERED everywhere a security is picked, via `scenarioSecurityRegistry`.
 */

import { scenarioSecurityRegistry } from '../finance/holdings/security.js';

/**
 * The securities a scenario AUTHORS, as plain editable specs (never frozen records).
 *
 * @param {object|null} scenario - a scenario record
 * @returns {object[]} the authored list; empty when the scenario has none
 */
export function listScenarioSecurities(scenario) {
  return Array.isArray(scenario?.securities) ? scenario.securities : [];
}

/**
 * Insert or replace one security by id, and validate the whole resulting set.
 *
 * Validation runs over the WHOLE list rather than the one record, because the rules that
 * matter are collective: `scenarioSecurityRegistry` throws on a duplicate id and on the
 * reserved `sec-auto-` prefix, and it throws at LOAD — i.e. on a scenario that no longer
 * opens, long after the modal that broke it has closed. Raising here means the bad edit
 * is never committed.
 *
 * The list is REPLACED rather than mutated in place: a scenario record can be sitting in
 * a journal or a history snapshot, and an in-place push would rewrite what those recorded
 * (the journal live-alias defect, pre-empted).
 *
 * @param {object} scenario - the active scenario record; mutated (its `securities` key)
 * @param {object} spec     - a plain security spec carrying an `id`
 * @returns {object[]} the new authored list
 * @throws when the resulting set is one the registry would refuse
 */
export function upsertScenarioSecurity(scenario, spec) {
  if (!scenario) throw new Error('upsertScenarioSecurity: no scenario record.');
  if (spec?.id == null || spec.id === '') {
    throw new Error('Security: `id` is required and is what Holding.securityId names.');
  }
  const current = listScenarioSecurities(scenario);
  const idx     = current.findIndex(s => s?.id === spec.id);
  const next    = idx === -1 ? [...current, { ...spec }]
                             : current.map((s, i) => (i === idx ? { ...spec } : s));
  // Throws before anything is committed — the registry is the authority on the rules.
  // Built the way the RUN builds it (synthetics first, then the authored set), because
  // that composition is what makes `sec-auto-` reserved: `buildSecurityRegistry` alone
  // sees no collision, since the synthetics are not in the authored list. Validating the
  // narrower object would accept an id that bricks the scenario at load.
  scenarioSecurityRegistry({ securities: next });
  scenario.securities = next;
  return next;
}

/**
 * Remove one authored security by id.
 *
 * **Positions naming it are NOT rewritten**, and that is deliberate rather than an
 * omission. A lot whose `securityId` resolves to nothing falls back to its own inline
 * fields (`instrumentOf` merges `{ ...holding, ...security }` and there is no security),
 * so the run still works — but a reducer may never CHANGE a position's `securityId`
 * (design 94 §11's fourth walk: a position is a position IN something, and relabelling it
 * in place silently rewrites history). Clearing the field on every lot from here would be
 * that same write, one layer up. The account editor preserves an unresolved value as its
 * own option for exactly this case, so the author can see it and re-point it.
 *
 * @param {object} scenario
 * @param {string} id
 * @returns {object[]} the new authored list
 */
export function deleteScenarioSecurity(scenario, id) {
  if (!scenario) return [];
  const next = listScenarioSecurities(scenario).filter(s => s?.id !== id);
  scenario.securities = next;
  return next;
}

/**
 * Which accounts hold a position in this security, as `{ stateKey, name, lots }`.
 *
 * Read off the SCENARIO's accounts, not off a run's state: the question "is anything
 * still pointing at this?" has to be answerable before a delete, and before any sim
 * exists. Lots that name a security removed from the list still report here.
 *
 * @param {object|null} scenario
 * @param {string} id
 */
export function scenarioSecurityUsage(scenario, id) {
  const out = [];
  for (const a of scenario?.accounts ?? []) {
    const lots = (a?.holdings ?? []).filter(h => h?.securityId === id).length;
    if (lots > 0) out.push({ stateKey: a.stateKey ?? a.id ?? null, name: a.name ?? a.stateKey ?? '', lots });
  }
  return out;
}
