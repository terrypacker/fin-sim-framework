/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

export class BaseComponent {
  constructor({ parent } = {}) {
    this._children = new Set();
    this._cleanups = [];

    if (parent) {
      parent._registerChild(this);
      this._parent = parent;
    }
  }

  _registerChild(child) {
    this._children.add(child);
  }

  /**
   * Register a cleanup (event listener, timer, observer, etc.)
   */
  onCleanup(fn) {
    this._cleanups.push(fn);
  }

  /**
   * Destroy children first, then self cleanups
   */
  destroy() {
    // destroy children
    for (const child of this._children) {
      try { child.destroy(); } catch (e) { console.error(e); }
    }
    this._children.clear();

    // run cleanups
    for (const fn of this._cleanups) {
      try { fn(); } catch (e) { console.error(e); }
    }
    this._cleanups = [];
  }



  // ─────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────
  /**
   * Usage:
   *   this._debouncedSearch = this.debounce(() => this._searchChanged(), 200);
   *   this._input.addEventListener('input', this._debouncedSearch);
   * @param fn
   * @param ms
   * @return {(function(...[*]): void)|*}
   */
  debounce(fn, ms = 200) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  /**
   * Add event listener with automatic cleanup
   */
  listen(target, event, handler, options) {
    target.addEventListener(event, handler, options);
    this.onCleanup(() => target.removeEventListener(event, handler, options));
    return handler;
  }

  listenOnce(target, event, handler, options) {
    const wrapped = (e) => {
      handler(e);
      target.removeEventListener(event, wrapped, options);
    };
    target.addEventListener(event, wrapped, options);
    return wrapped;
  }

  /**
   * setTimeout with auto cleanup
   */
  setTimeout(fn, ms) {
    const id = window.setTimeout(fn, ms);
    this.onCleanup(() => clearTimeout(id));
    return id;
  }

  /**
   * setInterval with auto cleanup
   */
  setInterval(fn, ms) {
    const id = window.setInterval(fn, ms);
    this.onCleanup(() => clearInterval(id));
    return id;
  }

  /**
   * requestAnimationFrame with auto cleanup
   */
  raf(fn) {
    const id = requestAnimationFrame(fn);
    this.onCleanup(() => cancelAnimationFrame(id));
    return id;
  }

  /**
   * Observe resize with auto cleanup
   */
  observeResize(el, handler) {
    const ro = new ResizeObserver(handler);
    ro.observe(el);
    this.onCleanup(() => ro.disconnect());
    return ro;
  }

  /**
   * Observe intersection with auto cleanup
   */
  observeIntersection(el, handler, options) {
    const io = new IntersectionObserver(handler, options);
    io.observe(el);
    this.onCleanup(() => io.disconnect());
    return io;
  }

  /**
   * Append DOM node with auto removal
   */
  append(parent, child) {
    parent.appendChild(child);
    this.onCleanup(() => child.remove());
    return child;
  }

  // ── Throttled rendering ───────────────────────────────────────────────────

  /**
   * Set the minimum ms between renders. 0 (default) uses requestAnimationFrame.
   * Call with a positive value (e.g. 1000) during playback to reduce paint pressure.
   */
  setRenderThrottle(ms) {
    this._renderThrottleMs = ms ?? 0;
  }

  /**
   * Schedule fn to run at the next render opportunity, coalescing rapid calls
   * into a single paint. Respects _renderThrottleMs: 0 → RAF, >0 → setTimeout.
   */
  scheduleRender(fn) {
    this._renderDirty = true;
    if (this._renderPending) return;
    this._renderPending = true;

    const fire = () => {
      this._renderPending = false;
      if (!this._renderDirty) return;
      this._renderDirty = false;
      this._renderLastTime = performance.now();
      fn();
    };

    const throttle = this._renderThrottleMs ?? 0;
    if (throttle > 0) {
      const elapsed = performance.now() - (this._renderLastTime ?? 0);
      setTimeout(fire, Math.max(0, throttle - elapsed));
    } else {
      requestAnimationFrame(fire);
    }
  }

}
