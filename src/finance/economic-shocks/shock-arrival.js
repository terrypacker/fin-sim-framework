/*
 * Copyright (c) 2026 Terry Packer.
 *
 * This file is part of Terry Packer's Work.
 * See www.terrypacker.com for further info.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Random shock arrival — design 126 §3 (G1).
 *
 * A `shocks[]` entry may carry an `arrival` spec saying WHEN the shock may happen instead of
 * when it does:
 *
 *     { preset: 'DOTCOM_2000_LITE', arrival: { mode: 'WINDOW', fromYears: 0, toYears: 15, probability: 0.6 } }
 *
 * - `FIXED` (or no `arrival`): the authored `startDate`, exactly as before.
 * - `WINDOW`: with `probability` (default 1) the shock happens once, on the first of a month
 *   drawn uniformly from those in `[simStart + fromYears, simStart + toYears)`. A month on or
 *   after the run's end means it did not arrive: a shock that would have come after the plan
 *   ended did not come.
 *
 * The draw is made at COMPILE, so the drawn date feeds `scheduleShock` like an authored one and
 * design 121's delayed legs, recovery ticks and level effects follow it unchanged. It is a pure
 * function of (run seed, entry key): never the shared cursor, which would shift every later
 * draw, and never the MC parameter sampler, which would shift every other sampled variable in
 * an arm that enabled it. So path i's arrival is the same in every arm of a batch.
 *
 * Both uniforms are always drawn, the hit first and the month second, so an arm that changes
 * only `probability` keeps the same month on every path that arrives in both.
 */

import { keyedRng }  from '../../simulation-framework/simulation.js';
import { DateUtils } from '../../simulation-framework/date-utils.js';

export const ARRIVAL_MODES = Object.freeze(['FIXED', 'WINDOW']);

/** The `buildSim()` fallback seed, for a compile with no simulation to ask. */
const FALLBACK_SEED = 1;

/**
 * The stable key each entry's draw is made under (design 126 §3.3): the entry's own `id`, else
 * `<preset or shockId>#<n>` with n counting the EARLIER entries of the same preset. Not the
 * array index (reordering two different shocks would swap their dates) and not the bare preset
 * (two entries of one preset would draw the same date).
 *
 * @param {Array<object>} entries
 * @returns {string[]} one key per entry, index-aligned
 */
export function shockArrivalKeys(entries) {
  const seen = new Map();
  return (entries ?? []).map((entry) => {
    if (entry?.id != null && entry.id !== '') return String(entry.id);
    const base = entry?.preset ?? entry?.shockId ?? 'shock';
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}#${n}`;
  });
}

/**
 * Whether an entry's date is drawn rather than authored.
 *
 * @param {object} entry
 * @returns {boolean}
 */
export function isRandomArrival(entry) {
  return entry?.arrival != null && validateArrival(entry.arrival, entry) === 'WINDOW';
}

/**
 * Validate an `arrival` spec, returning its mode. An authoring error throws naming the shock:
 * a silent fallback would run the shock on a date nobody chose, or not at all.
 *
 * @param {object} arrival
 * @param {object} [entry]  for the message
 * @returns {'FIXED'|'WINDOW'}
 */
export function validateArrival(arrival, entry = {}) {
  const name = entry.id ?? entry.preset ?? entry.shockId ?? '?';
  const fail = (msg) => { throw new Error(`Shock "${name}": arrival ${msg}`); };
  if (typeof arrival !== 'object') fail(`must be an object, got ${JSON.stringify(arrival)}`);
  const mode = arrival.mode;
  if (mode === 'RATE') fail('mode RATE is not built yet (design 126 §8 step 3)');
  if (!ARRIVAL_MODES.includes(mode)) fail(`mode must be one of ${ARRIVAL_MODES.join(', ')}, got ${JSON.stringify(mode)}`);
  if (mode === 'FIXED') return mode;
  const { fromYears, toYears, probability = 1 } = arrival;
  if (!Number.isFinite(fromYears) || fromYears < 0) fail(`fromYears must be a number ≥ 0, got ${JSON.stringify(fromYears)}`);
  if (!Number.isFinite(toYears)) fail(`toYears must be a number, got ${JSON.stringify(toYears)}`);
  if (Math.round(toYears * 12) <= Math.round(fromYears * 12)) {
    fail(`window must span at least one month (fromYears ${fromYears}, toYears ${toYears})`);
  }
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    fail(`probability must be in [0, 1], got ${JSON.stringify(probability)}`);
  }
  return mode;
}

/**
 * Draw one WINDOW arrival.
 *
 * @param {object} arrival   a validated WINDOW spec
 * @param {object} opts
 * @param {number} opts.seed
 * @param {string} opts.key
 * @param {Date}   opts.startDate  the run's start
 * @param {Date}   [opts.endDate]  the run's end; a month on or after it does not arrive
 * @returns {?Date} the arrival, or null when the shock does not happen in the run
 */
export function drawWindowArrival(arrival, { seed, key, startDate, endDate = null }) {
  const rng   = keyedRng(seed ?? FALLBACK_SEED, `shock-arrival:${key}`, 0);
  const uHit  = rng();
  const uWhen = rng();

  const from  = DateUtils.addMonths(startDate, Math.round(arrival.fromYears * 12));
  const to    = DateUtils.addMonths(startDate, Math.round(arrival.toYears * 12));
  const first = from.getUTCDate() === 1
    ? from
    : new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  let months = 0;
  while (DateUtils.addMonths(first, months) < to) months++;

  if (!(uHit < (arrival.probability ?? 1))) return null;
  const date = DateUtils.addMonths(first, Math.floor(uWhen * months));
  return endDate && date >= endDate ? null : date;
}

/**
 * Every random arrival in a plan, drawn once (design 126 §3.5): `{ <key>: 'YYYY-MM-DD' | null }`
 * for each WINDOW entry, or null when no entry draws — so a plan without one gains no state.
 *
 * @param {Array<object>} entries  the `shocks` parameter
 * @param {object} opts  { seed, startDate, endDate }
 * @returns {?Object<string, ?string>}
 */
export function drawShockArrivals(entries, { seed, startDate, endDate = null }) {
  const list = Array.isArray(entries) ? entries : [];
  const keys = shockArrivalKeys(list);
  let out = null;
  list.forEach((entry, i) => {
    if (!isRandomArrival(entry)) return;
    const date = drawWindowArrival(entry.arrival, { seed, key: keys[i], startDate, endDate });
    (out ??= {})[keys[i]] = date ? date.toISOString().slice(0, 10) : null;
  });
  return out;
}

/**
 * The entries as they are to be scheduled: a drawn entry carries its drawn `startDate` (and no
 * `arrival`), one that did not arrive is null — resolved exactly like an empty row — and every
 * other entry is untouched.
 *
 * @param {Array<object>} entries
 * @param {?Object<string, ?string>} arrivals  from `drawShockArrivals`
 * @returns {Array<?object>}
 */
export function applyShockArrivals(entries, arrivals) {
  const list = Array.isArray(entries) ? entries : [];
  if (!arrivals) return list;
  const keys = shockArrivalKeys(list);
  return list.map((entry, i) => {
    if (!isRandomArrival(entry)) return entry;
    const iso = arrivals[keys[i]];
    if (!iso) return null;
    const { arrival, ...rest } = entry;
    return { ...rest, startDate: new Date(`${iso}T00:00:00Z`) };
  });
}
