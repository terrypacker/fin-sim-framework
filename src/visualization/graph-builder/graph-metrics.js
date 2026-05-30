/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

// ── Node geometry ──────────────────────────────────────────────────────────────
export const NODE_WIDTH  = 180;
export const NODE_HEIGHT = 56;

// ── Column layout ──────────────────────────────────────────────────────────────
export const COLUMN_GAP = 280;   // horizontal distance between column centres
export const ROW_GAP    = 80;    // vertical gap between nodes in the same column
export const PADDING_X  = 80;    // left margin before the first column
export const PADDING_Y  = 60;    // top margin before the first row

// ── Edge routing ───────────────────────────────────────────────────────────────
export const BACKWARD_MARGIN  = 30;  // clearance past node edge when routing backwards
export const EDGE_SPACING     = 10;  // Y pixels between fan-out exit/entry anchors
export const LANE_OFFSET      = 12;  // X pixels between lanes sharing the same midX column
export const OBSTACLE_MARGIN  =  8;  // horizontal clearance added around node body for obstacle detection

// ── Arrowhead ─────────────────────────────────────────────────────────────────
export const ARROW_SIZE = 8;   // tip-to-base length
export const ARROW_HALF = 5;   // half the base width

// ── Edge style ────────────────────────────────────────────────────────────────
// SVG edge colors are driven by CSS (--edge-color / --edge-color-highlight).
// These constants mirror the dark-theme defaults and are kept for public API compatibility.
export const EDGE_COLOR           = '#2e3a50'; // mirrors --edge-color dark default
export const EDGE_COLOR_HIGHLIGHT = '#f0a500'; // mirrors --edge-color-highlight (amber)
export const EDGE_WIDTH           = 2;
export const EDGE_WIDTH_HIGHLIGHT = 3;
export const EDGE_OPACITY         = 0.7;
export const EDGE_OPACITY_HIGHLIGHT = 1;
