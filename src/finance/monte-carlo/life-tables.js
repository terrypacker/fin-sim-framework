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
 * Actuarial life-table data for Monte Carlo lifespan draws (design/27 §5, §10 Q1).
 *
 * Each table is a { sex: { mean, stdDev } } structure giving the
 * unconditional life expectancy (from birth) in years.  The ActuarialLifespanDistribution
 * samples from a normal distribution truncated from below at the person's current age
 * so the draw is always >= current age (no time-travel deaths).
 *
 * Table source: CDC 2024 (US), ABS 2020-22 (AU). Values are approximations
 * suitable for Monte Carlo sensitivity analysis — not actuarial certification.
 *
 * Residency keying (§10 Q1): table is selected once at MC-variable-registration
 * time from Person.residency at boot.  Mid-life moves do not redraw (Path A).
 */
export const CDC_2024 = {
  id: 'CDC_2024',
  label: 'CDC 2024 (US)',
  // Approximate national life-expectancy parameters by sex (CDC 2024 Life Tables)
  M: { mean: 76.3, stdDev: 13.0 },
  F: { mean: 81.2, stdDev: 13.0 },
  // Default sex when not specified
  default: { mean: 78.5, stdDev: 13.0 },
};

export const AU_2022 = {
  id: 'AU_2022',
  label: 'ABS 2020-22 (AU)',
  // Australian Bureau of Statistics 2020-22 life tables
  M: { mean: 81.3, stdDev: 12.5 },
  F: { mean: 85.3, stdDev: 12.0 },
  default: { mean: 83.2, stdDev: 12.5 },
};

/**
 * Resolve the life table for a given residency string.
 * Returns CDC_2024 for US residency and as the fallback (§10 Q1).
 *
 * @param {string} [residency] - e.g. 'US', 'AUS'
 * @returns {object} Life-table object
 */
export function lookupLifeTable(residency) {
  if (residency === 'AUS') return AU_2022;
  return CDC_2024;
}
