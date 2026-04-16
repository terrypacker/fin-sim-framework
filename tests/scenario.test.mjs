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
 * scenario.test.mjs
 * Tests for Scenario
 * Run with: node --test tests/simulation.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';
import { Assert } from './helpers/assert.js';

import { ScenarioRunner } from '../assets/js/simulation-framework/scenario.js';
import { Simulation } from '../assets/js/simulation-framework/simulation.js';
import { DateUtils } from '../assets/js/simulation-framework/date-utils.js';

test('Run scenario', () => {
  const runner = new ScenarioRunner({
    createSimulation: (params, seed) => {
      const sim = new Simulation(params.startDate, { seed });

      // register handlers using params
      sim.register("QUARTERLY_PL", ({ sim }) => {
        const drift = params.drift;
        const vol = params.vol;

        return {
          return: drift + sim.rng() * vol
        };
      });

      sim.scheduleRecurring({
        startDate: params.startDate,
        type: "QUARTERLY_PL",
        intervalFn: (d) => DateUtils.addMonths(d, 3)
      });

      return sim;
    },

    evaluate: (sim) => {
      const history = sim.bus.getHistory();

      let total = 0;

      for (const e of history) {
        if (e.type === "QUARTERLY_PL") {
          total += e.payload.return || 0;
        }
      }

      return {
        totalReturn: total
      };
    }
  });

  const results = runner.monteCarlo({
    n: 100,
    baseParams: {
      startDate: new Date(2025, 0, 1),
      endDate: new Date(2075, 0, 1),
      drift: 0.02,
      vol: 0.05
    },
    perturb: (base, i) => ({
      ...base,
      drift: base.drift + (Math.random() - 0.5) * 0.01
    })
  });

  const summary = runner.summarize(results, r => r.totalReturn);
  assert.ok(results.length === 100, `Expected ${results.length} to equal 10-`)
});

