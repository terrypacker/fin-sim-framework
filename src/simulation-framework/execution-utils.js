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
 * Build a hierarchical execution ID from a parent path, a config node ID,
 * and the execution index for that node in this run.
 *
 * Each segment has the form `{nodeId}.{index}`, e.g. 'e1.1'.
 * The full path is colon-separated: 'e1.1:h1.1:a1.1:r1.1'
 *
 * @param {string|null} parentId   - Full execution ID of the parent node, or null for roots.
 * @param {string}      nodeId     - Config-graph node ID (e.g. 'e1', 'h2').
 * @param {number}      index      - Execution count for this node (1-based).
 * @returns {string}
 */
export function buildExecutionId(parentId, nodeId, index) {
  const segment = `${nodeId}.${index}`;
  return parentId ? `${parentId}:${segment}` : segment;
}

/**
 * Return the parent execution ID by stripping the last segment from a full path.
 * Returns null if the path has no parent (i.e. it is a root event ID).
 *
 * @param {string} executionId
 * @returns {string|null}
 */
export function parentIdOf(executionId) {
  const lastColon = executionId.lastIndexOf(':');
  return lastColon === -1 ? null : executionId.slice(0, lastColon);
}

/**
 * Extract the config node ID from a single execution ID segment.
 * e.g. 'e1.1:h2.3' → 'h2'  (last segment, before the dot)
 *
 * @param {string} executionId
 * @returns {string}
 */
export function nodeIdOf(executionId) {
  const lastSegment = executionId.slice(executionId.lastIndexOf(':') + 1);
  return lastSegment.slice(0, lastSegment.lastIndexOf('.'));
}

/**
 * Extract the execution index from a full execution ID.
 * e.g. 'e1.1:h2.3' → 3  (last segment, after the dot)
 *
 * @param {string} executionId
 * @returns {number}
 */
export function executionIndexOf(executionId) {
  const lastSegment = executionId.slice(executionId.lastIndexOf(':') + 1);
  return Number(lastSegment.slice(lastSegment.lastIndexOf('.') + 1));
}
