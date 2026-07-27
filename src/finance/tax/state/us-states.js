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
 * The US states this model knows about (design 34) — the single list behind
 * every state-code choice in the app: the Person editor's residency-state
 * select, the `residencyState` / `stateMoveDestination` param enums, the
 * optimizer's categorical state axis, and the bequest editor's situs select.
 *
 * A state belongs here once it has a `BaseStateTaxRatesModule` registered in
 * StateTaxSettleService; `tests/unit/state-tax-rates.test.mjs` asserts the two
 * agree, so adding a rates module without listing it here (or vice versa) fails
 * the suite rather than silently leaving a state unselectable in the UI.
 *
 * Order is significant only in that it is the order the options are presented.
 *
 * Pure data — no imports, safe for both the finance layer and the UI.
 */

/** @typedef {{ code: string, name: string }} UsState */

/** @type {ReadonlyArray<UsState>} */
export const US_STATES = Object.freeze([
  Object.freeze({ code: 'NE', name: 'Nebraska' }),
  Object.freeze({ code: 'HI', name: 'Hawaii' }),
  Object.freeze({ code: 'SD', name: 'South Dakota' }),
]);

/**
 * Two-letter codes, in presentation order. Frozen — spread it (`[...US_STATE_CODES]`)
 * when a consumer needs a mutable array, e.g. a param schema's `options`.
 * @type {ReadonlyArray<string>}
 */
export const US_STATE_CODES = Object.freeze(US_STATES.map(s => s.code));

/**
 * Full state name for a code, or null when the code is not modelled.
 * @param {string|null|undefined} code
 * @returns {string|null}
 */
export function usStateName(code) {
  return US_STATES.find(s => s.code === code)?.name ?? null;
}

/**
 * `[value, label]` pairs for a `<select>`.
 *
 * @param {{ blankLabel?: string|null, labelStyle?: 'name'|'codeAndName' }} [opts]
 *        blankLabel — when set, prepends a `['', blankLabel]` option for the
 *        "no state of residency" case (design 34: null ⇒ no state income tax).
 *        labelStyle — 'name' (default) → "Nebraska"; 'codeAndName' → "NE — Nebraska".
 * @returns {Array<[string, string]>}
 */
export function usStateOptionPairs({ blankLabel = null, labelStyle = 'name' } = {}) {
  const pairs = US_STATES.map(s => [
    s.code,
    labelStyle === 'codeAndName' ? `${s.code} — ${s.name}` : s.name,
  ]);
  return blankLabel == null ? pairs : [['', blankLabel], ...pairs];
}
