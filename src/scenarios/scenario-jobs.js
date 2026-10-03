/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { validateJobs } from '../finance/payroll/employment.js';

/**
 * Authoring `cfg.jobs` — design 116 §7, the write half of employment spells.
 *
 * Jobs are plain scenario data on the active scenario record, for the reason securities are
 * (`scenario-securities.js`): one store. `serializeScenario` reads `scenario.jobs` off the
 * record, the compiler reads it off the definition, and this module is the only writer, so
 * Save, Download, Rebuild and the run agree without a service copy to drift.
 *
 * Every write REPLACES the list rather than mutating it, because a scenario record can be
 * sitting in a journal or a history snapshot (the journal live-alias defect, pre-empted).
 */

/** Every job the scenario authors; empty when it has none. */
export function listScenarioJobs(scenario) {
  return Array.isArray(scenario?.jobs) ? scenario.jobs : [];
}

/** One person's jobs, in authored order. */
export function listPersonJobs(scenario, personId) {
  return listScenarioJobs(scenario).filter(j => j?.personId === personId);
}

/**
 * A job id not already used in `taken`: `<personId>-job-<n>`. Stable once assigned — the
 * phase-4 sweep key `job.<id>.<field>` is built from it.
 */
export function nextJobId(personId, taken) {
  const used = new Set(taken);
  for (let n = 1; ; n++) {
    const id = `${personId}-job-${n}`;
    if (!used.has(id)) return id;
  }
}

/**
 * Replace one person's jobs with `rows`, validating the result first.
 *
 * Rows without an id are given one. Validation covers this person's rows only (overlap,
 * inverted or unparseable dates); the loader re-checks the whole set at every load, but
 * raising here means a bad edit is never committed — the loader's error arrives on a
 * scenario that no longer opens, long after the editor that could fix it has closed.
 *
 * @param {object}        scenario  the active scenario record; its `jobs` key is replaced
 * @param {string}        personId
 * @param {Array<object>} rows      this person's complete job list (may be empty)
 * @returns {Array<object>} the new scenario-wide list
 * @throws {Error} naming every problem, when the rows cannot run
 */
export function replacePersonJobs(scenario, personId, rows) {
  if (!scenario) throw new Error('replacePersonJobs: no scenario record.');
  const others = listScenarioJobs(scenario).filter(j => j?.personId !== personId);
  const taken  = others.map(j => j.id);
  const mine   = (rows ?? []).map(r => {
    const id = r.id ?? nextJobId(personId, taken);
    taken.push(id);
    return { ...r, id, personId };
  });
  const errors = validateJobs(mine, [{ id: personId }]);
  // An id another person already uses would be a duplicate only the loader could see.
  for (const j of mine) {
    if (others.some(o => o.id === j.id)) errors.push(`Job "${j.id}": duplicate id.`);
  }
  if (errors.length > 0) throw new Error(errors.join('\n'));
  const next = [...others, ...mine];
  if (next.length > 0) scenario.jobs = next;
  else delete scenario.jobs;
  return next;
}

/**
 * Remove a deleted person's jobs. Without this the loader rejects the scenario on its
 * next load: a job naming no person is an error, not a warning (§4.6).
 */
export function deletePersonJobs(scenario, personId) {
  if (!scenario || listPersonJobs(scenario, personId).length === 0) return;
  replacePersonJobs(scenario, personId, []);
}
