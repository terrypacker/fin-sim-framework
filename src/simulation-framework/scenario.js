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

export class ScenarioRunner {
  constructor({ createSimulation, evaluate }) {
    this.createSimulation = createSimulation;
    this.evaluate = evaluate;
  }

  runScenario(params, seed) {
    const sim = this.createSimulation(params, seed);

    sim.stepTo(params.endDate);

    return this.evaluate(sim);
  }

  runBatch({ scenarios }) {
    const results = [];

    for (const s of scenarios) {
      const result = this.runScenario(s.params, s.seed);
      results.push({ ...s, result });
    }

    return results;
  }

  monteCarlo({ n, baseParams, perturb }) {
    const scenarios = [];

    for (let i = 0; i < n; i++) {
      scenarios.push({
        seed: i + 1,
        params: perturb(baseParams, i)
      });
    }

    return this.runBatch({ scenarios })
  }

  /**
   *
   * @param results - [] result from each simulation
   * @param mapResults - r => r.result.totalReturn
   * @returns {{mean: number, p10: *, p50: *, p90: *}}
   */
  summarize(results, mapResults) {
    const values = results.map(mapResults);

    values.sort((a, b) => a - b);

    const mean = values.reduce((a, b) => a + b, 0) / values.length;

    return {
      mean,
      p10: values[Math.floor(values.length * 0.1)],
      p50: values[Math.floor(values.length * 0.5)],
      p90: values[Math.floor(values.length * 0.9)]
    };
  }

  /**
   * Simple optimization example
   * @param initialParams
   * @param runner
   * @param iterations
   * @param mutate
   * @param mapResultToScore
   * @returns {{bestParams: *, bestScore: number}}
   */
  optimize({ initialParams, runner, iterations, mutate, mapResultToScore}) {
    let bestParams = initialParams;
    let bestScore = -Infinity;

    for (let i = 0; i < iterations; i++) {
      const candidate = mutate(bestParams);

      const result = runner.runScenario(candidate, i);
      const score = mapResultToScore(result);

      if (score > bestScore) {
        bestScore = score;
        bestParams = candidate;
      }
    }

    return { bestParams, bestScore };
  }
}
