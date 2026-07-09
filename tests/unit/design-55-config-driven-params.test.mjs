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
 * design-55-config-driven-params.test.mjs
 *
 * Integration coverage for the configuration-driven parameter surface:
 *   - generated per-record params appear and seed from the records (round-trip),
 *   - legacy flat keys (MC/Opt/import) alias to their generated keys and cascade,
 *   - persisted legacy typed-param entries rename to generated keys,
 *   - editing a generated param cascades to the record and survives Rebuild (§6),
 *   - ParamFieldLinks auto-links generated params to editor fields (the §13
 *     mechanism that keeps a linked-field edit from being clobbered).
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { ServiceRegistry }         from '../../src/services/service-registry.js';
import { BaseScenario }            from '../../src/scenarios/base-scenario.js';
import { IntlRetirementScenario, INTL_RETIREMENT_DEFAULTS }
  from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioLoader }          from '../../src/scenarios/scenario-loader.js';
import { ParamFieldLinks }         from '../../src/visualization/scenario/param-field-links.js';

function freshCfg(overrides = {}) {
  const cfg = IntlRetirementScenario.buildDefaultConfig({}, undefined, undefined);
  cfg.initialState = {};
  cfg.scenarioClass = IntlRetirementScenario;
  return { ...cfg, ...overrides };
}

function loadCfg(cfg) {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  const scenario = new BaseScenario({
    context:  services.simulationContext,
    simStart: new Date(cfg.simStart),
    simEnd:   new Date(cfg.simEnd),
  });
  scenario.buildSim();
  new ScenarioLoader().load(cfg, services);
  return { services, sim: scenario.sim };
}

const acct = (cfg, k) => (cfg.accounts ?? []).find(a => a.stateKey === k);
const paramNamed = (cfg, n) => (cfg.params ?? []).find(p => p.name === n);

// ── Generated params appear and seed from records ──────────────────────────────

test('D55-1: generated per-record params appear, seeded from the record values', () => {
  const cfg = freshCfg();
  loadCfg(cfg);

  // contributionBasis is the retirement scalar exposed as a generated param. (balance
  // is NOT — a holdings-bearing account's balance is derived from Σ holdings, so no
  // balance param is generated for it; see the assertion below.)
  const roth = paramNamed(cfg, 'acct.rothAccount.contributionBasis');
  assert.ok(roth, 'generated Roth contributionBasis param exists');
  assert.strictEqual(roth.value, INTL_RETIREMENT_DEFAULTS.rothBasis);
  assert.deepStrictEqual(roth.node,
    { type: 'account', stateKey: 'rothAccount', field: 'contributionBasis' });

  // A holdings-bearing account's balance is derived (design 55 §13) — no balance param.
  assert.strictEqual(paramNamed(cfg, 'acct.rothAccount.balance'), undefined,
    'holdings-bearing account exposes no balance param (balance derives from holdings)');

  // The retired static keys are gone from the surface.
  assert.strictEqual(paramNamed(cfg, 'rothBalance'), undefined);
  assert.strictEqual(paramNamed(cfg, 'primaryMonthlyWage'), undefined);
});

// ── Alias back-compat: flat map (MC / Opt / raw import) ─────────────────────────

test('D55-2: legacy flat key in cfg.parameters aliases to the generated key and cascades', () => {
  const cfg = freshCfg();
  cfg.parameters = { ...(cfg.parameters ?? {}), rothBalance: 55_555 };
  loadCfg(cfg);

  assert.strictEqual(acct(cfg, 'rothAccount').balance, 55_555,
    'aliased legacy key cascades onto the record');
  assert.strictEqual(cfg.parameters.rothBalance, undefined, 'legacy flat key is removed');
  assert.strictEqual(cfg.parameters['acct.rothAccount.balance'], 55_555, 'value carried to generated key');
});

// ── Alias back-compat: persisted typed params (saved scenario) ──────────────────

test('D55-3: persisted legacy typed param is renamed to its generated key and cascades', () => {
  // Uses the property sale-year alias (a generated key that survives the holdings
  // model — balance aliases now target a derived, non-generated field). Exercises the
  // same rename + per-record group/label re-sync path (design 55 §4).
  const cfg = freshCfg();
  cfg.params = [
    { name: 'usHouseSaleYear', label: 'US House Sale Year', type: 'Number',
      group: 'Real Estate', value: 2_035,
      node: { type: 'realProperty', stateKey: 'usHouseProperty', field: 'plannedSaleYear' } },
  ];
  loadCfg(cfg);

  assert.strictEqual(paramNamed(cfg, 'usHouseSaleYear'), undefined, 'legacy entry renamed away');
  const gen = paramNamed(cfg, 'prop.usHouseProperty.plannedSaleYear');
  assert.ok(gen, 'generated key present after rename');
  assert.strictEqual(
    (cfg.realProperties ?? []).find(r => r.stateKey === 'usHouseProperty').plannedSaleYear, 2_035,
    'renamed entry still cascades');
  // The migrated entry adopts the per-record group/label (design 55 §4), not the
  // stale "Real Estate" group it carried as a static param.
  assert.strictEqual(gen.group, 'US · US House', 'migrated entry re-syncs to the per-record group');
  assert.strictEqual(gen.label, 'US House — Planned Sale Year', 'migrated entry re-syncs its derived label');
});

// ── Editing a generated param drives the record and survives Rebuild (§6) ────────

test('D55-4: editing a generated param cascades to the record and survives Rebuild', () => {
  const cfg = freshCfg();
  loadCfg(cfg);

  // Edit the linked param (as the account editor does via bindParamLinkedField).
  // contributionBasis is the retirement scalar that is param-linked in the editor.
  paramNamed(cfg, 'acct.rothAccount.contributionBasis').value = 71_000;

  // Rebuild on the same cfg (params already populated).
  loadCfg(cfg);

  assert.strictEqual(acct(cfg, 'rothAccount').contributionBasis, 71_000, 'edit cascaded to record');
  assert.strictEqual(paramNamed(cfg, 'acct.rothAccount.contributionBasis').value, 71_000,
    'param value round-trips (harvest keeps it in sync with the record)');
});

// ── ParamFieldLinks auto-links generated params (the §13 protection mechanism) ───

test('D55-5: ParamFieldLinks resolves the editor field to its generated param', () => {
  const cfg = freshCfg();
  loadCfg(cfg);

  const links = new ParamFieldLinks(cfg.params);
  const rothLink = links.getParamFor('account', 'rothAccount', 'contributionBasis');
  assert.ok(rothLink, 'account contributionBasis field links to a generated param');
  assert.strictEqual(rothLink.name, 'acct.rothAccount.contributionBasis');

  const wageLink = links.getParamFor('person', 'primary', 'monthlyWage');
  assert.ok(wageLink, 'person wage field links to a generated param');
  assert.strictEqual(wageLink.name, 'person.primary.monthlyWage');
});

// ── Additive params: property appreciation rate is not zeroed by the cascade ─────

test('D55-6: generated property appreciationRate round-trips (not rounded to 0)', () => {
  const cfg = freshCfg();
  loadCfg(cfg);
  const rate = paramNamed(cfg, 'prop.usHouseProperty.appreciationRate');
  assert.ok(rate, 'appreciationRate param generated');
  assert.ok(rate.value > 0 && rate.value < 1, `fractional rate preserved, got ${rate.value}`);
  // Rebuild and confirm the record keeps the fractional rate.
  loadCfg(cfg);
  const prop = (cfg.realProperties ?? []).find(r => r.stateKey === 'usHouseProperty');
  assert.ok(prop.appreciationRate > 0 && prop.appreciationRate < 1,
    `property appreciationRate survives Rebuild, got ${prop.appreciationRate}`);
});
