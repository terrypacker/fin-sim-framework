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
 * Resolve the active scheduled appreciation rate for a given date.
 *
 * Selects the entry with the latest `date <= currentDate`. When no entry
 * qualifies (schedule is empty, null, or all entries are in the future)
 * returns `fallbackRate` unchanged — backward-compatible with every holding
 * and asset that has no schedule.
 *
 * @param {Array<{date: Date|string, rate: number}>|null} schedule
 * @param {Date} currentDate
 * @param {number} fallbackRate
 * @returns {number}
 */
export function resolveScheduledRate(schedule, currentDate, fallbackRate) {
  if (!schedule || schedule.length === 0) return fallbackRate;

  const now = currentDate instanceof Date ? currentDate.getTime() : new Date(currentDate).getTime();

  let best = null;
  let bestTime = -Infinity;
  for (const entry of schedule) {
    const t = entry.date instanceof Date ? entry.date.getTime() : new Date(entry.date).getTime();
    if (t <= now && t > bestTime) {
      bestTime = t;
      best = entry;
    }
  }

  return best !== null ? best.rate : fallbackRate;
}
