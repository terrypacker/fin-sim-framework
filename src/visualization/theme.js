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
 * Reads a CSS custom property from the document root at call time.
 * Use this instead of hardcoded hex values in JS so colors respond to theme changes.
 *
 * @param {string} varName  e.g. '--text-dim'
 * @returns {string}
 */
export function readThemeColor(varName) {
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
}

/**
 * Chart series color palette — 12 distinct hues for data series.
 * These are intentional design colors for distinguishing datasets and are
 * not part of the UI chrome theme.
 */
export const CHART_PALETTE = [
  '#60a5fa', '#34d399', '#f59e0b', '#f87171', '#a78bfa',
  '#38bdf8', '#fb923c', '#4ade80', '#e879f9', '#fbbf24',
  '#94a3b8', '#f472b6',
];
