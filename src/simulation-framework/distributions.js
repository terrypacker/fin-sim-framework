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

/**
 * Uniform distribution over a date range [min, max].
 * Accepts min/max as ISO date strings or Date objects.
 * Returns a YYYY-MM-DD string so it can be stored as a scenario param.
 */
export class UniformDateDistribution {
  constructor({ min, max, anchor = null }) {
    this._min = new Date(min).getTime();
    this._max = new Date(max).getTime();
    if (Number.isNaN(this._min) || Number.isNaN(this._max))
      throw new RangeError('UniformDateDistribution: min and max must be valid dates');
    if (this._min > this._max)
      throw new RangeError('UniformDateDistribution: min must be <= max');
    this._anchor = _parseAnchor(anchor);
  }

  sample(rngFn) {
    const ms = this._min + rngFn() * (this._max - this._min);
    return _dateSample(ms, this._anchor);
  }
}

/**
 * Normal distribution over dates (design 117 D10): `mean` is a date, `stdDev` is in DAYS.
 * Samples an ISO day. It keeps the shape of a NORMAL year sweep when a year field becomes
 * a date, which UNIFORM_DATE would not.
 */
export class NormalDateDistribution {
  constructor({ mean, stdDev, anchor = null }) {
    this._mean = new Date(mean).getTime();
    if (Number.isNaN(this._mean))
      throw new RangeError('NormalDateDistribution: mean must be a valid date');
    if (!(stdDev >= 0)) throw new RangeError('NormalDateDistribution: stdDev (days) must be >= 0');
    this._stdDevMs = stdDev * DAY_MS;
    this._anchor   = _parseAnchor(anchor);
  }

  sample(rngFn) {
    if (this._stdDevMs === 0) return _dateSample(this._mean, this._anchor);
    // Box-Muller, as NormalDistribution: guard u1 away from 0 to avoid log(0)
    const u1 = Math.max(rngFn(), 1e-10);
    const u2 = rngFn();
    const z  = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return _dateSample(this._mean + this._stdDevMs * z, this._anchor);
  }
}

const DAY_MS = 86400000;

/** `'MM-DD'` → { month0, day }, or null. A date field pinned to one day of the year. */
function _parseAnchor(anchor) {
  const m = typeof anchor === 'string' ? /^(\d{2})-(\d{2})$/.exec(anchor) : null;
  return m ? { month0: Number(m[1]) - 1, day: Number(m[2]) } : null;
}

/**
 * A sampled instant → its ISO day. With an anchor (design 117 D5), the anchor date nearest
 * the instant, so a draw never lands on a day the loader rejects.
 */
function _dateSample(ms, anchor) {
  if (!anchor) return new Date(ms).toISOString().slice(0, 10);
  const y = new Date(ms).getUTCFullYear();
  let best = null;
  for (const yy of [y - 1, y, y + 1]) {
    const t = Date.UTC(yy, anchor.month0, anchor.day);
    if (best === null || Math.abs(t - ms) < Math.abs(best - ms)) best = t;
  }
  return new Date(best).toISOString().slice(0, 10);
}

/**
 * Actuarial lifespan distribution: samples a total-lifespan value (years from birth)
 * conditioned on the person having already survived to `currentAge`.
 *
 * Uses a Box-Muller normal draw centred at the life-table mean (by sex), then
 * clamps the result from below at max(currentAge + 0.5, draw) to ensure the
 * sampled lifespan is always >= the person's current age.  The distribution
 * is parameterised by { table, sex, currentAge }.
 *
 * `table` is a life-table object (e.g. CDC_2024) with per-sex { mean, stdDev }.
 */
export class ActuarialLifespanDistribution {
  constructor({ table, sex = 'M', currentAge = 0 }) {
    const row        = table?.[sex] ?? table?.default ?? { mean: 80, stdDev: 13 };
    this._mean       = row.mean;
    this._stdDev     = row.stdDev;
    this._currentAge = currentAge;
  }

  sample(rngFn) {
    if (this._stdDev === 0) return Math.max(this._mean, this._currentAge);
    const u1 = Math.max(rngFn(), 1e-10);
    const u2 = rngFn();
    const z  = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const raw = this._mean + this._stdDev * z;
    // Clamp: sampled lifespan must exceed current age (already lived these years)
    return Math.max(raw, this._currentAge + 1);
  }
}

export const DISTRIBUTION_TYPES = {
  CONSTANT:          'constant',
  UNIFORM:           'uniform',
  UNIFORM_DATE:      'uniformDate',
  NORMAL_DATE:       'normalDate',
  NORMAL:            'normal',
  LOG_NORMAL:        'logNormal',
  BERNOULLI:         'bernoulli',
  ACTUARIAL_LIFESPAN: 'actuarialLifespan',
};

/**
 * Instantiate a distribution from a plain config object.
 * @param {{ type: string, [key: string]: any }} config
 */
export function createDistribution(config) {
  switch (config.type) {
    case DISTRIBUTION_TYPES.CONSTANT:     return new ConstantDistribution(config);
    case DISTRIBUTION_TYPES.UNIFORM:      return new UniformDistribution(config);
    case DISTRIBUTION_TYPES.UNIFORM_DATE: return new UniformDateDistribution(config);
    case DISTRIBUTION_TYPES.NORMAL_DATE:  return new NormalDateDistribution(config);
    case DISTRIBUTION_TYPES.NORMAL:       return new NormalDistribution(config);
    case DISTRIBUTION_TYPES.LOG_NORMAL:   return new LogNormalDistribution(config);
    case DISTRIBUTION_TYPES.BERNOULLI:         return new BernoulliDistribution(config);
    case DISTRIBUTION_TYPES.ACTUARIAL_LIFESPAN: return new ActuarialLifespanDistribution(config);
    default: throw new Error(`Unknown distribution type: ${config.type}`);
  }
}
