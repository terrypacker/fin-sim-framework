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
 * retired-roth-conversion-date.js — the Roth conversion's month and day (retired 11 Nov 2026).
 *
 * The bracket-fill rule converts up to `ceiling − the year's US ordinary income`, so it is only
 * right once the year's income is all booked. That is 31 December, after that day's order-0
 * income (TIPS / zero-coupon accretion, the last coupon and dividend). Any earlier date sizes
 * the conversion on part of the year. On the roth-timing-2026 plan, 1 December missed up to 89%
 * of a year's US income, and a "10%" fill landed in the 12% bracket. The conversion now always
 * runs on 31 December (`rothConversionDate`).
 *
 * Every saved plan carried the old default (1 December), because the app saves defaults, so the
 * inputs mostly recorded nobody's choice. Same bargain as `retired-rate-params.js`: drop the
 * input from both param stores, and WARN when dropping it changes what the plan does (a plan
 * that converts, on a date other than 31 December). A plan that never converts loses an
 * inert value silently.
 */

/** The retired inputs, and the date the policy now always uses. */
export const RETIRED_ROTH_CONVERSION_DATE_PARAMS = Object.freeze(['rothConversionMonth', 'rothConversionDay']);
const FIXED_MONTH = 12;
const FIXED_DAY   = 31;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Drop `rothConversionMonth` / `rothConversionDay` from `cfg.parameters` and `cfg.params` in
 * place. Safe to call twice.
 * @param {object} cfg
 * @param {object} [opts]
 * @param {function(string): void} [opts.warn=console.warn]
 * @returns {string[]} the warnings issued
 */
export function retireRothConversionDate(cfg, { warn = console.warn } = {}) {
  if (!cfg) return [];
  const typed = Array.isArray(cfg.params) ? cfg.params : [];
  const read  = (key) => {
    if (cfg.parameters && cfg.parameters[key] !== undefined) return cfg.parameters[key];
    return typed.find(p => p?.name === key)?.value;
  };
  const month    = read('rothConversionMonth');
  const day      = read('rothConversionDay');
  const converts = read('rothConversionEnabled') === true;

  for (const key of RETIRED_ROTH_CONVERSION_DATE_PARAMS) if (cfg.parameters) delete cfg.parameters[key];
  if (Array.isArray(cfg.params)) {
    cfg.params = cfg.params.filter(p => !RETIRED_ROTH_CONVERSION_DATE_PARAMS.includes(p?.name));
  }

  const notes = [];
  const m = Number.isFinite(month) ? month : FIXED_MONTH;
  const d = Number.isFinite(day)   ? day   : FIXED_DAY;
  if (converts && (m !== FIXED_MONTH || d < FIXED_DAY)) {
    notes.push(`Roth conversions now always run on 31 Dec; this plan had ${d} ${MONTHS[m - 1] ?? `month ${m}`}. `
      + 'The bracket fill counts the whole year\'s US income only at year end, so the yearly '
      + 'conversion amounts can change (smaller where income arrived after the old date).');
  }
  for (const n of notes) warn(n);
  return notes;
}
