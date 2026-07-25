/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { RenderScheduler } from './render-scheduler.js';

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


  _getTemplate(templateId) {
    const tmpl = document.getElementById(templateId);
    return tmpl.content.firstElementChild.cloneNode(true);
  }

  /**
   * Tag an editor's `.node-header` with an "Inherited" badge when the record was
   * promoted from a Bequest (design 63 §14 — `node.inherited === true`), so a
   * user editing an inherited account / property / collectible can see at a glance
   * that it's decedent-sourced (and its FMV is funded at the inheritance date, not
   * authored here). No-op for ordinary records and when the header is absent.
   * @param {HTMLElement} el   - the cloned editor template root
   * @param {object|null} node - the record being edited
   */
  _applyInheritedBadge(el, node) {
    if (!node?.inherited) return;
    const header = el.querySelector('.node-header');
    if (!header || header.querySelector('.node-inherited-badge')) return;
    const badge = document.createElement('span');
    badge.className = 'node-inherited-badge';
    badge.textContent = 'Inherited';
    badge.title = 'Promoted from a bequest (design 63) — funded at the inheritance date.';
    header.appendChild(badge);
  }

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
   * Subscribe to a bus message type, buffering received messages in an internal queue.
   * When any message arrives, renderFn() is called (typically () => this.render()).
   * Returns a drain() function that returns and clears all queued messages.
   *
   * Allows bus subscribers to accumulate messages between render frames and process
   * them in batch at render time, rather than re-rendering on every message.
   *
   * Usage:
   *   this._drainService = this.busQueue(bus, 'SERVICE_ACTION', () => this.render());
   *   // In your render function:
   *   const msgs = this._drainService(); // get & clear queued messages
   *
   * @param {EventBus}  bus       - The bus to subscribe to
   * @param {string}    type      - Message type (e.g. 'SERVICE_ACTION')
   * @param {function}  renderFn  - Called when a message arrives (e.g. () => this.render())
   * @param {object}   [filter]   - Optional filter object { kind, subtype, instanceOf }
   * @returns {function(): Array} drain — returns and clears the queued messages.
   *   The returned function also carries an `unsubscribe()` method that removes
   *   the subscription from the bus (also run automatically on destroy()).
   */
  busQueue(bus, type, renderFn, filter) {
    const queue = [];
    const subscriber = (msg) => {
      queue.push(msg);
      renderFn();
    };
    const unsubscribe = filter
      ? bus.subscribe(type, filter, subscriber)
      : bus.subscribe(type, subscriber);

    // Without this, subscribers accumulate on long-lived buses (the simulation
    // shares the persistent ServiceRegistry bus), pinning whole component graphs
    // — including prior simulations — across every scenario Rebuild.
    this.onCleanup(unsubscribe);

    const drain = () => queue.splice(0);
    drain.unsubscribe = unsubscribe;
    return drain;
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
  //
  // Delegated to RenderScheduler. The behaviour is unchanged — throttle 0 means
  // requestAnimationFrame, a positive throttle rate-limits with an elapsed-aware
  // timer, and a queued render is never replaced by a later one. It lives in its
  // own class now so that non-component callers (TimelinePresenter) can coalesce
  // renders without inheriting this base's DOM helpers. See render-scheduler.js.

  /** Lazily created so subclasses need not call super() before scheduling. */
  get _scheduler() {
    if (!this.__scheduler) this.__scheduler = new RenderScheduler({ immediate: 'raf' });
    return this.__scheduler;
  }

  /**
   * Set the minimum ms between renders. 0 (default) uses requestAnimationFrame.
   * Call with a positive value (e.g. 1000) during playback to reduce paint pressure.
   */
  setRenderThrottle(ms) {
    this._scheduler.setThrottle(ms);
  }

  /** Current throttle in ms. Retained as a field-shaped read: several component tests assert it. */
  get _renderThrottleMs() { return this._scheduler.throttleMs; }
  set _renderThrottleMs(ms) { this._scheduler.setThrottle(ms); }

  /**
   * Schedule fn to run at the next render opportunity, coalescing rapid calls
   * into a single paint. Respects the throttle: 0 → RAF, >0 → setTimeout.
   */
  scheduleRender(fn) {
    this._scheduler.schedule(fn);
  }

}
