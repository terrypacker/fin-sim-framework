/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { $ }                               from '../ui-utils.js';
import { BaseComponent }                   from '../components/base-component.js';
import { EXECUTION_KINDS, EXECUTION_PHASES } from '../../simulation-framework/bus-messages.js';
import { APP_EVENTS }                        from '../app-display-settings.js';

/**
 * DashCardsComponent — owns the five execution-count cards:
 *   cardCurrentDate, cardEventExecutions, cardHandlerExecutions,
 *   cardActionExecutions, cardReducerExecutions.
 *
 * Subscribes to EXECUTION_BEGIN and EXECUTION_END so the date label tracks
 * the animation in real-time and counts stay current after each event.
 * Inherits setRenderThrottle() from BaseComponent so SimulationAnimator can
 * throttle updates during fast playback.
 */
export class DashCardsComponent extends BaseComponent {
  /**
   * @param {{ displaySettings?: import('../app-display-settings.js').AppDisplaySettings, formatDate?: function }} opts
   */
  constructor({ displaySettings, formatDate, appBus, root = null } = {}) {
    super();
    // The cards' runtime-owned host (WorkbenchRuntime.paneHost('dashCards')). It is detached
    // from the document while the Dashboard tab is closed, so lookups go inside it. Null in
    // unit tests, which put the cards straight into the document.
    this._root = root;
    this._formatDate = displaySettings?.formatDate ?? formatDate ?? (d => d?.toDateString() ?? '');
    this._sim        = null;
    this._pendingDate = null;

    const noop = () => [];
    this._drainBeginMsgs = noop;
    this._drainEndMsgs   = noop;

    if (appBus) {
      this.onCleanup(appBus.subscribe(APP_EVENTS.DISPLAY_SETTINGS_CHANGED, ({ formatDate: fmt }) => {
        this._formatDate = fmt;
        this.render();
      }));
    }
  }

  /**
   * Subscribe to the simulation bus. Call once per scenario.
   * @param {import('../../simulation-framework/event-bus.js').EventBus} simBus
   * @param {object} sim - the Simulation instance (for execution counters)
   */
  wireSimBus(simBus, sim) {
    this._sim = sim;
    this._drainBeginMsgs = this.busQueue(
      simBus,
      `EXECUTION_${EXECUTION_PHASES.BEGIN}`,
      () => this.render(),
      { kind: EXECUTION_KINDS.EVENT }
    );
    this._drainEndMsgs = this.busQueue(
      simBus,
      `EXECUTION_${EXECUTION_PHASES.END}`,
      () => this.render(),
      { kind: EXECUTION_KINDS.EVENT }
    );
  }

  /** Synchronous update — called externally on initial load and reset. */
  update(date) {
    this._pendingDate = date;
    this.render();
  }

  render() {
    this.scheduleRender(() => this._doRender());
  }

  _doRender() {
    const begins = this._drainBeginMsgs();
    const ends   = this._drainEndMsgs();
    const all    = [...begins, ...ends];

    if (all.length) {
      this._pendingDate = new Date(all[all.length - 1].date);
    }
    if (!this._pendingDate) return;

    const sim = this._sim;
    const set = (id, v) => {
      const el = this._root?.querySelector(`#${id}`) ?? $(id);
      if (el) el.innerText = v;
    };
    set('cardCurrentDate',       this._formatDate(this._pendingDate));
    set('cardEventExecutions',   sim?.eventExecutions   ?? 0);
    set('cardHandlerExecutions', sim?.handlerExecutions ?? 0);
    set('cardActionExecutions',  sim?.actionExecutions  ?? 0);
    set('cardReducerExecutions', sim?.reducerExecutions ?? 0);
  }
}
