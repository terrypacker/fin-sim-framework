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
 * scenario-source.mjs — where a lab tool gets its BASE scenario cfg.
 *
 * Every tool under scripts/lab and scripts/montecarlo starts from one base cfg
 * and mutates copies of it. There are two ways to get one, and the distinction
 * matters for what a result MEANS:
 *
 *   · `--scenario <file.json>`  a workbench export (`{ "scenarios": [...] }`).
 *     This is a real, hand-tuned plan. Its `initialState` carries persisted
 *     balances, holdings, growth-rate maps and per-account overrides that the
 *     param bag alone cannot reproduce. Use this to answer a question ABOUT A
 *     PLAN.
 *
 *   · no flag — `IntlRetirementScenario.buildDefaultConfig()`, the framework's
 *     synthetic default. Round numbers, no persisted state, same canonical
 *     stateKeys (`usHouseProperty`, `usStockAccount`, `primary`, `spouse`, …).
 *     Use this to answer a question ABOUT THE ENGINE, or to smoke-test a tool.
 *
 * The default exists so every tool here runs from a fresh clone with no private
 * data. It is NOT a stand-in for a real plan: its simEnd is ~15 years out and no
 * property carries a `plannedSaleYear`, so solvency questions on it are close to
 * meaningless. A tool that prints a decision should say which source it used.
 *
 * GOTCHA: a persisted `initialState` SHADOWS param-level growth rates. Setting
 * `brokerageGrowthRate` on a file-sourced cfg without also rewriting the
 * `baseGrowthRates` / `effectiveGrowthRates` maps produces a silently inert
 * lever — the sim keeps using the persisted map. `applyEquityShift` in
 * ./variant.mjs is the fix; use it rather than setting rate params by hand.
 */

import { readFileSync } from 'node:fs';

import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';

/**
 * Load the base cfg a tool will build variants from.
 *
 * @param {object}  [opts]
 * @param {?string} [opts.file]   path to a workbench export; null ⇒ built-in default
 * @param {number}  [opts.index]  which scenario in the file (default 0)
 * @param {object}  [opts.params] params passed to buildDefaultConfig (default source only)
 * @returns {{ cfg: object, source: string, synthetic: boolean }}
 */
export function loadBaseConfig({ file = null, index = 0, params = {} } = {}) {
  if (file) {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    const list = doc.scenarios ?? (Array.isArray(doc) ? doc : [doc]);
    const cfg = list[index];
    if (!cfg) throw new Error(`no scenario at index ${index} in ${file}`);
    return { cfg, source: `${file}#${index}`, synthetic: false };
  }
  return {
    cfg: IntlRetirementScenario.buildDefaultConfig(params),
    source: 'IntlRetirementScenario.buildDefaultConfig()',
    synthetic: true,
  };
}

/**
 * Pull `--scenario` / `--index` out of an argv array.
 * Returns the parsed values; does not remove them from argv.
 */
export function parseSourceArgs(argv) {
  const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const idx = at('--index');
  return { file: at('--scenario') ?? null, index: idx != null ? Number(idx) : 0 };
}

/**
 * One line naming the base cfg, for a report header. A synthetic source gets an
 * explicit warning: a reader must not mistake a smoke test for a decision.
 */
export function describeSource({ source, synthetic }) {
  return synthetic
    ? `base: ${source}  ** SYNTHETIC DEFAULT — illustrative only, not a real plan **`
    : `base: ${source}`;
}
