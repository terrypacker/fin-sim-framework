/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { NODE_WIDTH, NODE_HEIGHT, COLUMN_GAP, ROW_GAP, PADDING_X, PADDING_Y } from './graph-metrics.js';

const KIND_ORDER = ['event', 'handler', 'action', 'reducer'];

/**
 * ColumnLayout — deterministic left-to-right DAG layout.
 *
 * Produces center coordinates:
 *
 *   Map<nodeId, { x, y }>
 */
export class ColumnLayout {

  apply(nodes, { width = 800, height = 400 } = {}) {

    const groups = new Map();

    for (const kind of KIND_ORDER) {
      groups.set(kind, []);
    }

    for (const node of nodes) {
      const kind = node.kind ?? 'other';

      if (!groups.has(kind)) {
        groups.set(kind, []);
      }

      groups.get(kind).push(node);
    }

    // Remove empty columns
    const active = [...groups.entries()]
    .filter(([, group]) => group.length > 0);

    const positions = new Map();

    active.forEach(([kind, group], colIdx) => {

      //
      // Fixed left-to-right column placement
      //
      const x =
          PADDING_X +
          (colIdx * COLUMN_GAP);

      //
      // Vertically center the entire column
      //
      const totalColumnHeight =
          (group.length * NODE_HEIGHT) +
          ((group.length - 1) * ROW_GAP);

      const startY =
          Math.max(
              PADDING_Y,
              (height - totalColumnHeight) / 2
          );

      //
      // Position nodes
      //
      group.forEach((node, rowIdx) => {

        const centerX =
            PADDING_X +
            (colIdx * COLUMN_GAP) +
            NODE_WIDTH / 2;

        const centerY =
            startY +
            (rowIdx * (NODE_HEIGHT + ROW_GAP)) +
            NODE_HEIGHT / 2;

        positions.set(node.id, {
          x: centerX,
          y: centerY,
        });

      });
    });

    return positions;
  }
}
