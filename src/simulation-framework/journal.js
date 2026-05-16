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
 * A single reducer execution recorded in the journal.
 *
 * Dual-mode architecture:
 *   Journal  → "What changed?" — durable, ordered, state-centric
 *   ExGraph  → "Why/how?"     — runtime causal DAG (ephemeral)
 *
 * Names (event.name, action.name, reducer.name) are denormalized here so
 * the Timeline can render without graph lookups.  nodeId fields carry the
 * config-graph node ID so the UI can open the NodeEditModal on demand.
 *
 * Parentage:
 *   action.parentId = the action that *emitted* this one (causal parent).
 *   action.siblingIndex = position among actions emitted by the same parent
 *                         in the same call (temporal order within siblings).
 *   Temporal predecessor across the whole journal = entry at seq - 1.
 *   These are NOT the same concept.
 *
 * action.data holds selective action-instance payload fields needed for UI
 * display and reporting (sum row, tax document) without cloning the full object.
 *
 * emittedInstanceIds — UUID[] — causal forward-links to the execution graph.
 * emittedTypes       — string[] — type strings for display without graph lookup.
 */
export class JournalEntry {
  constructor({
    id,
    seq,
    date,
    executionId,
    event,
    action,
    reducer,
    stateDiff,
    emittedInstanceIds,
    emittedTypes,
  }) {
    this.id  = id;   // UUID — unique identity for this journal entry
    this.seq = seq;  // monotonic int — total order; set by Journal.addEntry()

    this.date        = date;
    this.executionId = executionId; // hierarchical exec ID, e.g. 'e1.1:h1.1:a1.1:r1.1'

    // { nodeId: string|null, type: string, name: string, color: string|null }
    this.event = event;

    // { instanceId: UUID, parentId: UUID|null, rootId: UUID|null,
    //   siblingIndex: number, nodeId: string|null, type: string, name: string,
    //   data: { amount?, tax?, isLongTerm?, value?, cc?, taxDetail?, personTaxDetails? } }
    this.action = action;

    // { nodeId: string|null, name: string }
    this.reducer = reducer;

    this.stateDiff          = stateDiff;
    this.emittedInstanceIds = emittedInstanceIds; // UUID[] — for graph cross-reference
    this.emittedTypes       = emittedTypes;       // string[] — for display without graph lookup
  }
}

function _dateKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export class Journal {
  constructor({ enabled = false } = {}) {
    this.enabled   = enabled;
    this.journal   = [];
    this._seq      = 0;
    this.snapshots = new Map(); // dateKey → { seq, state }
  }

  addEntry(entry) {
    entry.seq = this._seq++;
    this.journal.push(entry);
  }

  /**
   * Record a full state snapshot keyed by simulation date.
   * First write for a given date wins — call once per event after all
   * reducers for that event have run.
   */
  addSnapshot(date, state) {
    const key = _dateKey(date);
    if (!this.snapshots.has(key)) {
      this.snapshots.set(key, { seq: this._seq, state: structuredClone(state) });
    }
  }

  /**
   * Return the nearest snapshot whose seq is ≤ the given seq, or null.
   * Used to fast-forward replay: apply diffs from snapshot.seq onward.
   */
  snapshotBefore(seq) {
    let best = null;
    for (const snap of this.snapshots.values()) {
      if (snap.seq <= seq && (!best || snap.seq > best.seq)) best = snap;
    }
    return best;
  }

  getActions(type) {
    return this.journal.filter(e => e.action.type === type);
  }

  getStateTimeline(field) {
    return this.journal
      .map(e => ({ date: e.date, diff: e.stateDiff?.find(d => d.field === field) }))
      .filter(({ diff }) => diff != null)
      .map(({ date, diff }) => ({ date, value: diff.after }));
  }

  traceEvent(date) {
    return this.journal.filter(e => e.date.getTime() === date.getTime());
  }
}
