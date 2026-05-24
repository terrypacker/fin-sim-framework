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
   * @param results      - array of results from runBatch / monteCarlo
   * @param mapResults   - r => number  (e.g. r => r.result.totalReturn)
   * @param mapFailure   - optional: r => { failed: boolean, outOfFundsDate: Date|null }
   *                       When provided, adds successRate, failureCount, and
   *                       medianOutOfFundsDate to the returned summary.
   * @returns {{ mean, p10, p50, p90, [successRate], [failureCount], [medianOutOfFundsDate] }}
   */
  summarize(results, mapResults, mapFailure = null) {
    const values = results.map(mapResults);

    values.sort((a, b) => a - b);

    const mean = values.reduce((a, b) => a + b, 0) / values.length;

    const summary = {
      mean,
      p10: values[Math.floor(values.length * 0.1)],
      p50: values[Math.floor(values.length * 0.5)],
      p90: values[Math.floor(values.length * 0.9)]
    };

    if (mapFailure) {
      const failureInfos  = results.map(mapFailure);
      const failed        = failureInfos.filter(f => f.failed);
      summary.failureCount  = failed.length;
      summary.successRate   = (results.length - failed.length) / results.length;

      const failureTimes = failed
        .map(f => f.outOfFundsDate)
        .filter(d => d instanceof Date)
        .map(d => d.getTime())
        .sort((a, b) => a - b);

      if (failureTimes.length > 0) {
        summary.medianOutOfFundsDate = new Date(failureTimes[Math.floor(failureTimes.length * 0.5)]);
      }

      const deficits = failed
        .map(f => f.cumulativeDeficit ?? 0)
        .sort((a, b) => a - b);

      if (deficits.length > 0) {
        summary.p50Deficit = deficits[Math.floor(deficits.length * 0.5)];
        summary.p90Deficit = deficits[Math.floor(deficits.length * 0.9)];
      }

      const deficitMonths = failed
        .map(f => f.deficitMonths ?? 0)
        .sort((a, b) => a - b);

      if (deficitMonths.length > 0) {
        summary.p50DeficitMonths = deficitMonths[Math.floor(deficitMonths.length * 0.5)];
        summary.p90DeficitMonths = deficitMonths[Math.floor(deficitMonths.length * 0.9)];
      }
    }

    return summary;
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
