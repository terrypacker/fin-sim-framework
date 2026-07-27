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
 * probe-foreign-property-cgt.mjs
 *
 * End-to-end runtime check for design 62 §5 (Gap 3): the foreign (US) house of an
 * AU resident is stepped up at the move and AU-assessed on sale, net of the AU
 * main-residence exemption. Drives the REAL IntlRetirementScenario through the
 * ScenarioLoader + Simulation — exercising the full runtime wiring
 * (ChangeResidencyApplyReducer → property state step-up → US_HOUSE_SALE_APPLY →
 * US/AU tax classification), which the unit tests cannot.
 *
 * Two runs of the reference US→AU retiree (moveYear 2031), each selling the US
 * house in 2035 (4 years after the move):
 *   A. US house as the primary residence, NOT rented → AU main-residence absence
 *      rule fully exempts it (s118-145) → auGain 0.
 *   B. US house as an investment property → fully AU-assessable from the stepped-up
 *      (market-value-at-move) basis → auGain > 0, routed to the AU CGT buckets.
 *
 * Usage:  node scripts/probe-foreign-property-cgt.mjs
 *         npm run probe:foreign-property-cgt
 */

import { ServiceRegistry }        from '../src/services/service-registry.js';
import { ScenarioLoader }         from '../src/scenarios/scenario-loader.js';
import { IntlRetirementScenario } from '../src/scenarios/intl-retirement-scenario.js';

const usd = n => '$' + Math.round(n).toLocaleString();
let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

/**
 * Run the reference scenario to 2036 with the US house sold in 2035. `mutate` can
 * tweak the US house config record (e.g. flip it to an investment property).
 */
function run(mutate) {
  ServiceRegistry.resetAll();
  const registry = ServiceRegistry.getInstance();
  registry.scenarioRegistry.loadPrebuilt([{
    cls: IntlRetirementScenario, order: 1, active: true,
    simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd:   new Date(Date.UTC(2036, 0, 1)),
  }]);
  const scenario = registry.scenarioService.createActiveScenario();
  scenario.buildSim();
  const cfg = registry.scenarioService.getActive();

  const usHouse = (cfg.realProperties ?? []).find(p => p.stateKey === 'usHouseProperty');
  usHouse.plannedSaleYear = 2035;            // sell 4 years after the 2031 move
  mutate?.(usHouse);

  new ScenarioLoader().load(cfg, registry);
  const sim = scenario.sim;
  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  try { sim.stepTo(new Date(Date.UTC(2036, 0, 1))); }
  finally { console.log = log; console.warn = warn; }

  // The emitted action's payload lives in `.action.data` (design 59 journal pattern);
  // the FY settle resets the YTD buckets, so the sale action is the durable evidence.
  const saleTax = sim.journal.getActions('US_HOUSE_SALE_TAX')[0]?.action?.data ?? null;
  return { sim, state: sim.state, saleTax };
}

console.log('═'.repeat(78));
console.log('FOREIGN (US) PROPERTY AU CGT — end-to-end runtime check (design 62 §5)');
console.log('═'.repeat(78));

// ── Run A: primary residence, not rented → AU-exempt ───────────────────────────
const A = run(null); // default US house is isPrimaryResidence:true, rentalEnabled:false
console.log('\nRun A — US house = primary residence, not rented (sold 2035, moved 2031):');
check('US house stepped up at the move (AU basis stamped)',
  A.state.usHouseProperty?.costBaseByCountry?.AU != null,
  A.state.usHouseProperty?.costBaseByCountry?.AU != null ? usd(A.state.usHouseProperty.costBaseByCountry.AU) : 'absent');
check('deemed-acquisition date stamped (July 2031 move)',
  A.state.usHouseProperty?.acquisitionDateByCountry?.AU != null,
  A.state.usHouseProperty?.acquisitionDateByCountry?.AU
    ? new Date(A.state.usHouseProperty.acquisitionDateByCountry.AU).toISOString().slice(0, 10) : 'absent');
check('sale emitted US_HOUSE_SALE_TAX', A.saleTax != null);
check('AU gain fully exempt (main-residence absence rule)', (A.saleTax?.auGain ?? 0) === 0, usd(A.saleTax?.auGain ?? 0));

// ── Run B: investment property → AU-assessable ─────────────────────────────────
const B = run(h => { h.isPrimaryResidence = false; });
console.log('\nRun B — US house = investment property (sold 2035, moved 2031):');
const auBasisB = B.state.usHouseProperty?.costBaseByCountry?.AU; // stamped at move; property is zeroed post-sale
check('sale emitted US_HOUSE_SALE_TAX with a positive AU gain', (B.saleTax?.auGain ?? 0) > 0, usd(B.saleTax?.auGain ?? 0));
check('AU gain is the post-move appreciation (proceeds − stepped-up basis)',
  (B.saleTax?.auGain ?? 0) > 0 && (B.saleTax.auGain <= B.saleTax.proceeds),
  `proceeds ${usd(B.saleTax?.proceeds ?? 0)}, auGain ${usd(B.saleTax?.auGain ?? 0)}`);
check('US gain still assessed independently (post-$500k exemption)', (B.saleTax?.gain ?? 0) >= 0, usd(B.saleTax?.gain ?? 0));

console.log('\n' + '═'.repeat(78));
console.log(failures === 0
  ? 'RESULT: PASS — foreign property stepped up at the move and AU-assessed on sale (MRE applied).'
  : `RESULT: FAIL — ${failures} check(s) failed.`);
console.log('═'.repeat(78));
process.exit(failures === 0 ? 0 : 1);
