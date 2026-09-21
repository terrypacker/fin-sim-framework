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
 * The derivation manifest (design 39 §14.9.4): what a compile DERIVES from params, as opposed
 * to what a run REALIZES.
 *
 * An MPC rollout does not compile from t₀. It compiles the candidate's plan, then
 * `OptimizationProblem._injectSnapshot` replaces `sim.state` and `sim.queue` with a snapshot of
 * "now". A snapshot holds two kinds of fact, and they need opposite treatment:
 *
 *   · **realized history** (balances, lots, cumulative counters, `rngState`, events already
 *     consumed): comes from the snapshot, always. The compile has never seen it.
 *   · **derived from params** (control-policy state fields, and the event series of toolsets
 *     whose `schedules()` is a pure function of params): comes from the fresh compile, always.
 *     The snapshot's copy is the OLD plan's, frozen when the snapshot was taken.
 *
 * Before this module, injection restored everything and then patched a growing list of
 * exceptions by hand: four special cases in `_seededSim`, one of which was silently
 * corrupting the snapshot (§14.9.7). A toolset now declares its derived facts next to the code
 * that derives them, so a new lever cannot forget to:
 *
 *   derivedState:  ['withinTierDraw', '*.drawdownPriority']   // top-level key, or `*.<field>`
 *   derivedEvents: ['ROTH_CONVERSION_POLICY_EVALUATE']         // event types
 *   derivedStateAt(context) { return (state, nowMs) => patch } // the compile's value AT now
 *
 * `derivedEvents` is only sound for a `schedules()` that reads no sim state: the compile has
 * to be able to produce the same events a run would, from params alone.
 *
 * **`derivedState` is the compile's value at t₀.** A value that legitimately changes MID-RUN
 * from params would be reverted to its t₀ value by that pick. Such a value declares
 * `derivedStateAt` instead: a function, built from the compile's own context, that answers
 * "what does this plan say the value is at `nowMs`, given the run so far?" The design 109 pool
 * shapes are the first (design 39 §14.9.8). A design 81 recorded decision applied at its date
 * is still reverted, because the drawdown fields it writes are declared t₀-style.
 */

const WILDCARD = '*.';

/**
 * The union of every toolset's declarations, deduplicated and in first-seen order.
 *
 * @param {Array<object>} toolsets  resolved toolsets, in compile order
 * @param {object} [context]  the compile's context; `derivedStateAt` is bound to it
 * @returns {{ state: string[], events: string[], at: Function[] }}
 */
export function collectDerivedManifest(toolsets, context = null) {
  const state = new Set();
  const events = new Set();
  const at = [];
  for (const t of toolsets ?? []) {
    for (const p of t?.derivedState  ?? []) state.add(p);
    for (const e of t?.derivedEvents ?? []) events.add(e);
    if (typeof t?.derivedStateAt === 'function' && context) {
      const fn = t.derivedStateAt(context);
      if (typeof fn === 'function') at.push(fn);
    }
  }
  return { state: [...state], events: [...events], at };
}

/**
 * Apply every `derivedStateAt` answer to an injected state, in toolset order. Each sees the
 * state the previous one produced. Pure.
 *
 * @param {object}     state
 * @param {Function[]} fns    `manifest.at`
 * @param {number}     nowMs  the snapshot's date
 * @returns {object}
 */
export function applyDerivedStateAt(state, fns, nowMs) {
  let out = state;
  for (const fn of fns ?? []) {
    const patch = fn(out, nowMs);
    if (patch && Object.keys(patch).length) out = { ...out, ...patch };
  }
  return out;
}

/**
 * Capture the derived state paths from a compiled (not yet injected) state.
 *
 * Returns what `applyDerivedState` needs and nothing else, so the capture can be taken before
 * injection overwrites `sim.state`. A path the compile does not produce is simply absent.
 *
 * @param {object}   state  the freshly compiled `sim.state`
 * @param {string[]} paths  manifest state paths
 * @returns {{ top: object, perKey: Map<string, Map<string, *>> }}
 */
export function captureDerivedState(state, paths) {
  const top = {};
  const perKey = new Map();          // field → Map(stateKey → value)
  for (const path of paths ?? []) {
    if (path.startsWith(WILDCARD)) {
      const field = path.slice(WILDCARD.length);
      const byKey = new Map();
      for (const [k, v] of Object.entries(state ?? {})) {
        if (v && typeof v === 'object' && !Array.isArray(v) && field in v) byKey.set(k, v[field]);
      }
      perKey.set(field, byKey);
    } else if (state && state[path] !== undefined) {
      top[path] = structuredClone(state[path]);
    }
  }
  return { top, perKey };
}

/**
 * Lay captured derived state over an injected (snapshot) state. Pure: returns a new state and
 * copies only the objects it changes.
 *
 * A `*.<field>` value is written only onto a key present on BOTH sides: an object the run
 * created after t₀ (an inherited account) has no compiled counterpart and keeps its own.
 *
 * @param {object} state     the injected snapshot state
 * @param {{ top: object, perKey: Map }} captured  from `captureDerivedState`
 * @returns {object}
 */
export function applyDerivedState(state, captured) {
  let out = Object.keys(captured.top).length ? { ...state, ...captured.top } : state;
  for (const [field, byKey] of captured.perKey) {
    for (const [k, v] of byKey) {
      const obj = out[k];
      if (!obj || typeof obj !== 'object' || Array.isArray(obj) || obj[field] === v) continue;
      if (out === state) out = { ...state };
      out[k] = { ...obj, [field]: v };
    }
  }
  return out;
}

/**
 * Capture the compiled queue's derived events that fall strictly after `afterMs`.
 *
 * Strictly after, because `Simulation.stepTo` runs every event dated ≤ its target: a snapshot
 * taken at `afterMs` holds exactly the events after it, and these are their compiled twins.
 *
 * @param {Array}    queueData  `sim.queue.data` of the fresh compile
 * @param {string[]} types      manifest event types
 * @param {number}   afterMs
 * @returns {Array} deep-enough copies (own `data`), in queue order
 */
export function captureDerivedEvents(queueData, types, afterMs) {
  if (!types?.length) return [];
  const want = new Set(types);
  return (queueData ?? [])
    .filter(e => want.has(e.type) && new Date(e.date).getTime() > afterMs)
    .map(e => ({ ...e, date: new Date(e.date), ...(e.data ? { data: { ...e.data } } : {}) }));
}

/** Pairs a compiled event with its snapshot twin: same type, same date, same name. */
const pairKey = (e) => `${e.type}|${new Date(e.date).getTime()}|${e.name ?? ''}`;

/**
 * Replace the injected queue's future derived events with the compile's.
 *
 * Done through the heap's own operations, never by editing its array: `restoreData` trusts the
 * array to already be a valid heap. And done by PAIRING, so a candidate that leaves an event
 * unchanged leaves the heap unchanged: a paired event keeps its heap slot and `instanceId` and
 * only takes the compile's `data` (which the comparator does not read). Only a real difference
 * removes or adds a node, and only those can re-resolve a same-`(date, order)` tie elsewhere
 * (the "queue is not a total order" hazard).
 *
 * @param {object} sim       the injected sim (its queue is the snapshot's)
 * @param {Array}  compiled  from `captureDerivedEvents`
 * @param {string[]} types   manifest event types
 * @returns {{ paired: number, removed: number, added: number }}
 */
export function spliceDerivedEvents(sim, compiled, types) {
  if (!types?.length) return { paired: 0, removed: 0, added: 0 };
  const want  = new Set(types);
  const nowMs = new Date(sim.currentDate).getTime();
  const heap  = sim.queue;

  const pending = new Map();                       // pairKey → compiled events, FIFO
  for (const e of compiled) {
    const k = pairKey(e);
    if (!pending.has(k)) pending.set(k, []);
    pending.get(k).push(e);
  }

  let paired = 0;
  const orphans = [];
  for (const item of heap.data) {
    if (!want.has(item.type) || new Date(item.date).getTime() <= nowMs) continue;
    const twin = pending.get(pairKey(item))?.shift();
    if (twin) { item.data = twin.data; paired++; }
    else orphans.push(heap.keyFn(item));
  }
  for (const key of orphans) heap.removeByKey(key);

  let added = 0;
  for (const list of pending.values()) {
    for (const e of list) {
      heap.push({ ...e, instanceId: sim.nextEventInstanceId++ });
      added++;
    }
  }
  return { paired, removed: orphans.length, added };
}
