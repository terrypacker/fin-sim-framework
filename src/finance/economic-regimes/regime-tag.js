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
 * Vocabulary of tags that can be applied to an EconomicShock's regime.
 * Tags are user-configurable on each Shock; strategies read them to decide
 * when to fire.  Add a tag here only when a strategy actually consumes it.
 *
 * Usage: shock.tags = [REGIME_TAG.ECONOMIC_STRESS]
 * Check: state.activeRegimes.some(r => r.tags?.includes(REGIME_TAG.ECONOMIC_STRESS))
 */
export const REGIME_TAG = Object.freeze({
  ECONOMIC_STRESS: 'ECONOMIC_STRESS',
});
