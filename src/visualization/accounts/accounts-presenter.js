/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Account }                    from "../../finance/assets/account.js";
import { SIMULATION_BUS_MESSAGES }    from "../../simulation-framework/bus-messages.js";

/**
 * AccountsPresenter — wires AccountsView callbacks to AccountsController and
 * keeps the list in sync with the service bus.
 *
 * Also accepts a `people` prop that PeoplePresenter updates via its
 * `onPeopleChanged` hook, so the owner dropdown stays current.
 */
export class AccountsPresenter {
  /**
   * @param {{
   *   controller: import('./accounts-controller.js').AccountsController,
   *   view:       import('./accounts-view.js').AccountsView,
   *   bus:        import('../../simulation-framework/event-bus.js').EventBus
   * }}
   */
  constructor({ controller, view, bus }) {
    this._controller       = controller;
    this._view             = view;
    this._people           = [];
    this._journal          = null;
    this._getSimState      = null;
    this._renderThrottleMs = 0;
    this._listDirty        = false;
    this._listPending      = false;
    this._listLastRender   = 0;

    // ── Wire view callbacks → controller ───────────────────────────────────

    this._view.onSave = (data) => {
      if (data.id) {
        // Edit: derive changes, excluding id and type (immutable).
        const { id, type: _type, ...changes } = data;
        this._controller.update(id, changes);
      } else {
        this._controller.create(data);
      }
      this._view.hideForm();
    };

    this._view.onEdit = (account) => {
      this._view.showForm(account, this._people);
    };

    this._view.onDelete = (id) => {
      this._controller.delete(id);
      this._view.hideForm();
    };

    this._view.onCancel = () => {
      this._view.hideForm();
    };

    this._view.onHistory = (account) => {
      if (!this._journal) {
        this._view.showHistory([], account.name, account.currency?.symbol ?? '$');
        return;
      }
      const entries = this._controller.getHistory(account.id, this._journal);
      this._view.showHistory(entries, account.name, account.currency?.symbol ?? '$');
    };

    // ── React to service bus (deserialization, programmatic changes) ────────
    bus.subscribe('SERVICE_ACTION', { instanceOf: Account }, () => this._refresh());

    // Initial render.
    this._refresh();
  }

  /**
   * Attach the simulation journal so transaction history can be queried.
   * @param {import('../../simulation-framework/journal.js').Journal} journal
   */
  setJournal(journal) {
    this._journal = journal;
  }

  /**
   * Subscribe to the simulation bus so the account list re-renders on each
   * event occurrence using the same throttle used by ChartView / StatePanelView.
   * @param {import('../../simulation-framework/event-bus.js').EventBus} simBus
   */
  attachSimBus(simBus) {
    simBus.subscribe(SIMULATION_BUS_MESSAGES.EVENT_OCCURRENCE_END, () => {
      this._scheduleListUpdate();
    });
  }

  /** Mirror of ChartView.setRenderThrottle — called by SimulationAnimator. */
  setRenderThrottle(ms) {
    this._renderThrottleMs = ms ?? 0;
  }

  /**
   * Provide a getter for the live simulation state so renderList can read
   * current balances from sim.state[stateKey] rather than the original
   * (structuredClone'd-away) service objects.
   * @param {function(): object} getter
   */
  setSimStateGetter(getter) {
    this._getSimState = getter;
  }

  /**
   * Called by PeoplePresenter.onPeopleChanged to keep the owner dropdown in sync.
   * @param {import('../../finance/person.js').Person[]} people
   */
  setPeople(people) {
    this._people = people;
    this._refresh();
    this._view.updateOwnerOptions(people);
  }

  _scheduleListUpdate() {
    this._listDirty = true;
    if (this._listPending) return;
    this._listPending = true;

    const fire = () => {
      this._listPending = false;
      if (!this._listDirty) return;
      this._listDirty = false;
      this._listLastRender = performance.now();
      this._refresh();
    };

    if (this._renderThrottleMs > 0) {
      const elapsed = performance.now() - this._listLastRender;
      setTimeout(fire, Math.max(0, this._renderThrottleMs - elapsed));
    } else {
      requestAnimationFrame(fire);
    }
  }

  _refresh() {
    const accounts  = this._controller.list();
    const simState  = this._getSimState?.();
    const balanceMap = new Map();
    if (simState) {
      for (const acc of accounts) {
        if (acc.stateKey) {
          const liveBalance = simState[acc.stateKey]?.balance;
          if (liveBalance != null) balanceMap.set(acc.id, liveBalance);
        }
      }
    }
    this._view.renderList(accounts, this._people, balanceMap);
  }

  destroy() {
    this._view.destroy();
  }
}
