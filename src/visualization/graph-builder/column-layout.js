/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

// Must match .g-node CSS dimensions
const NODE_WIDTH  = 180;
const NODE_HEIGHT = 40;

const KIND_ORDER = ['event', 'handler', 'action', 'reducer'];

/**
 * ColumnLayout — positions nodes in vertical columns grouped by kind.
 *
 * apply(nodes, { width, height }) returns a Map<id, { x, y }> so the
 * caller can position nodes without coupling layout to the renderer.
 */
export class ColumnLayout {
  apply(nodes, { width = 800, height = 400 } = {}) {
    const groups = new Map();
    for (const kind of KIND_ORDER) groups.set(kind, []);

    for (const node of nodes) {
      const kind = node.kind ?? 'other';
      if (!groups.has(kind)) groups.set(kind, []);
      groups.get(kind).push(node);
    }

    const active = [...groups.entries()].filter(([, g]) => g.length > 0);
    const numCols = active.length;
    const positions = new Map();

    active.forEach(([, group], colIdx) => {
      const x = width * (colIdx + 1) / (numCols + 1) - NODE_WIDTH / 2;

      group.forEach((node, rowIdx) => {
        const y = height * (rowIdx + 1) / (group.length + 1) - NODE_HEIGHT / 2;
        positions.set(node.id, { x, y });
      });
    });

    return positions;
  }
}
