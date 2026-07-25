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
 * RenderScheduler — coalesce repaint requests, optionally rate-limited.
 *
 * Extracted from `BaseComponent`, where it had lived as four private fields and
 * two methods. Coalescing renders is a *scheduling* concern, not a DOM one, and
 * keeping it inside a DOM component base meant anything that wanted it had to
 * inherit `_getTemplate`, `append`, the inherited-badge helper and a parent/child
 * destroy tree along with it. `TimelinePresenter` needed only the scheduling —
 * it owns no DOM, its view does — and ended up with a second hand-rolled copy
 * (design 78 §6). This is the shared unit; `BaseComponent` now delegates to it.
 *
 * Two knobs, because the two callers genuinely differ:
 *
 * `immediate` — what a throttle of 0 means.
 *   'raf'  (default) defer to the next animation frame. Right for DOM components:
 *          a burst of bus messages becomes one paint, and painting off-frame is
 *          wasted work anyway.
 *   'sync' run the callback inline. Right for the timeline, whose contract is
 *          that stepping the simulation has repainted by the time `update()`
 *          returns — several tests depend on that, and so does single-stepping.
 *
 * `flushOnRelease` — whether dropping the throttle back to 0 runs a render that
 *   is already queued. The timeline needs this: playback ends by calling
 *   `setThrottle(0)`, and without a flush the last coalesced frame is dropped and
 *   the panel is left showing stale content with nothing following to correct it.
 *   Components that repaint on the next data tick anyway do not, and enabling it
 *   for them would change long-standing behaviour, so it is opt-in.
 *
 * Coalescing rule (preserved from the original): while a render is pending,
 * further `schedule()` calls mark it dirty but do NOT replace the queued
 * callback — the first one wins.
 */
export class RenderScheduler {
  /**
   * @param {object} [o]
   * @param {'raf'|'sync'} [o.immediate='raf']    behaviour when throttleMs is 0
   * @param {boolean}      [o.flushOnRelease=false] run a queued render when the throttle returns to 0
   */
  constructor({ immediate = 'raf', flushOnRelease = false } = {}) {
    this._immediate      = immediate;
    this._flushOnRelease = flushOnRelease;

    this.throttleMs = 0;
    this._pending   = null;   // timer id, `true` for a queued rAF, else null
    this._dirty     = false;
    this._fn        = null;
    this._lastTime  = 0;
  }

  /**
   * Set the minimum ms between renders. 0 restores immediate mode.
   * When `flushOnRelease` is set, dropping to 0 also runs any queued render.
   * @param {number} ms
   */
  setThrottle(ms) {
    const next = ms ?? 0;
    const releasing = next === 0 && this.throttleMs !== 0;
    this.throttleMs = next;
    if (releasing && this._flushOnRelease) this.flush();
  }

  /**
   * Request a render. Coalesces: while one is queued, later calls only mark the
   * result stale, and the originally queued callback is the one that runs.
   * @param {Function} fn
   */
  schedule(fn) {
    if (this.throttleMs === 0 && this._immediate === 'sync') { this._lastTime = _now(); fn(); return; }

    this._dirty = true;
    if (this._pending) return;
    this._fn = fn;

    const fire = () => {
      this._pending = null;
      if (!this._dirty) return;
      this._dirty    = false;
      this._lastTime = _now();
      const f = this._fn;
      this._fn = null;
      f?.();
    };

    if (this.throttleMs > 0) {
      const elapsed = _now() - this._lastTime;
      this._pending = setTimeout(fire, Math.max(0, this.throttleMs - elapsed));
    } else if (typeof requestAnimationFrame === 'function') {
      this._pending = true;
      requestAnimationFrame(fire);
    } else {
      this._pending = true;
      fire();
    }
  }

  /** Run a queued render immediately, if there is one. */
  flush() {
    if (!this._pending && !this._dirty) return;
    if (typeof this._pending === 'number') clearTimeout(this._pending);
    this._pending = null;
    if (!this._dirty) { this._fn = null; return; }
    this._dirty    = false;
    this._lastTime = _now();
    const f = this._fn;
    this._fn = null;
    f?.();
  }

  /** Drop any queued render without running it. */
  cancel() {
    if (typeof this._pending === 'number') clearTimeout(this._pending);
    this._pending = null;
    this._dirty   = false;
    this._fn      = null;
  }
}

/** performance.now() where available; Date.now() in bare test environments. */
function _now() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}
