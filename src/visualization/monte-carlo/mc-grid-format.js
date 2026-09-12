/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { fmtCompact } from '../money-format.js';

/**
 * A lever value as an axis label: a fraction below 1 as a percentage (rates are the
 * common case), a year as itself, a large amount compact, anything else as text.
 */
export function formatAxisValue(v) {
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return Math.abs(v) >= 10_000 ? fmtCompact(v) : String(v);
    if (Math.abs(v) < 1) return `${+(v * 100).toFixed(2)}%`;
    return String(+v.toFixed(4));
  }
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  return String(v);
}

/** "45s", "3m 10s", "1h 5m". */
export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
