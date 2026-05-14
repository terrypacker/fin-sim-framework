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
 * Statistical distribution classes for Monte Carlo parameter sampling.
 *
 * Each class implements `sample(rngFn)` where `rngFn` is a zero-argument
 * function that returns a uniform value in [0, 1) — compatible with the
 * seeded `sim.rng` produced by Simulation.createRNG().
 */

/**
 * Always returns the same value. Use for parameters that should not vary
 * across Monte Carlo iterations.
 */
export class ConstantDistribution {
  constructor({ value }) {
    this.value = value;
  }

  sample(_rngFn) {
    return this.value;
  }
}

/**
 * Uniform distribution over [min, max].
 */
export class UniformDistribution {
  constructor({ min, max }) {
    if (min > max) throw new RangeError('UniformDistribution: min must be <= max');
    this.min = min;
    this.max = max;
  }

  sample(rngFn) {
    return this.min + rngFn() * (this.max - this.min);
  }
}

/**
 * Normal (Gaussian) distribution with given mean and standard deviation.
 * Uses the Box-Muller transform; consumes two RNG values per sample.
 */
export class NormalDistribution {
  constructor({ mean, stdDev }) {
    if (stdDev < 0) throw new RangeError('NormalDistribution: stdDev must be >= 0');
    this.mean   = mean;
    this.stdDev = stdDev;
  }

  sample(rngFn) {
    if (this.stdDev === 0) return this.mean;
    // Box-Muller: guard u1 away from 0 to avoid log(0)
    const u1 = Math.max(rngFn(), 1e-10);
    const u2 = rngFn();
    const z  = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return this.mean + this.stdDev * z;
  }
}

/**
 * Log-normal distribution parameterised by the desired real-space mean and
 * standard deviation (not log-space mu/sigma).  Suitable for strictly
 * positive quantities such as account balances or growth rates > 0.
 *
 * Conversion: sigma² = ln(1 + (stdDev/mean)²), mu = ln(mean) - sigma²/2
 */
export class LogNormalDistribution {
  constructor({ mean, stdDev }) {
    if (mean <= 0) throw new RangeError('LogNormalDistribution: mean must be > 0');
    if (stdDev < 0) throw new RangeError('LogNormalDistribution: stdDev must be >= 0');
    const sigma2  = Math.log(1 + (stdDev / mean) ** 2);
    this._mu      = Math.log(mean) - sigma2 / 2;
    this._sigma   = Math.sqrt(sigma2);
  }

  sample(rngFn) {
    if (this._sigma === 0) return Math.exp(this._mu);
    const u1 = Math.max(rngFn(), 1e-10);
    const u2 = rngFn();
    const z  = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.exp(this._mu + this._sigma * z);
  }
}

/**
 * Bernoulli distribution: returns 1 with the given probability, 0 otherwise.
 */
export class BernoulliDistribution {
  constructor({ probability }) {
    if (probability < 0 || probability > 1)
      throw new RangeError('BernoulliDistribution: probability must be in [0, 1]');
    this.probability = probability;
  }

  sample(rngFn) {
    return rngFn() < this.probability ? 1 : 0;
  }
}

export const DISTRIBUTION_TYPES = {
  CONSTANT:    'constant',
  UNIFORM:     'uniform',
  NORMAL:      'normal',
  LOG_NORMAL:  'logNormal',
  BERNOULLI:   'bernoulli',
};

/**
 * Instantiate a distribution from a plain config object.
 * @param {{ type: string, [key: string]: any }} config
 */
export function createDistribution(config) {
  switch (config.type) {
    case DISTRIBUTION_TYPES.CONSTANT:   return new ConstantDistribution(config);
    case DISTRIBUTION_TYPES.UNIFORM:    return new UniformDistribution(config);
    case DISTRIBUTION_TYPES.NORMAL:     return new NormalDistribution(config);
    case DISTRIBUTION_TYPES.LOG_NORMAL: return new LogNormalDistribution(config);
    case DISTRIBUTION_TYPES.BERNOULLI:  return new BernoulliDistribution(config);
    default: throw new Error(`Unknown distribution type: ${config.type}`);
  }
}
