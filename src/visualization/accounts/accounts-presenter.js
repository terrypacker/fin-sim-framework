/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseComponent }   from '../components/base-component.js';
import { Account }          from "../../finance/assets/account.js";
import { EXECUTION_KINDS }  from "../../simulation-framework/bus-messages.js";

/**
 * AccountsPresenter — wires AccountsView callbacks to AccountsController and
 * keeps the list in sync with the service bus.
 *
 * Also accepts a `people` prop that PeoplePresenter updates via its
 * `onPeopleChanged` hook, so the owner dropdown stays current.
 */
export class AccountsPresenter extends BaseComponent {
  /**
   * @param {{
   *   controller: import('./accounts-controller.js').AccountsController,
   *   view:       import('./accounts-view.js').AccountsView,
   *   bus:        import('../../simulation-framework/event-bus.js').EventBus
   * }}
   */
  constructor({ controller, view, bus }) {
    super();
    this._controller  = controller;
    this._view        = view;
    this._people      = [];
    this._journal     = null;
    this._getSimState = null;

    const noop = () => [];
    this._drainServiceMsgs = noop;
    this._drainExecEndMsgs = noop;

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
    this._drainServiceMsgs = this.busQueue(bus, 'SERVICE_ACTION', () => this.render(), { instanceOf: Account });

    // Initial render.
    this._refresh();
  }

  render() {
    this.scheduleRender(() => {
      this._drainServiceMsgs();
      this._drainExecEndMsgs();
      this._refresh();
    });
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
   * event occurrence, coalesced via BaseComponent.scheduleRender.
   * @param {import('../../simulation-framework/event-bus.js').EventBus} simBus
   */
  attachSimBus(simBus) {
    this._drainExecEndMsgs = this.busQueue(
      simBus,
      'EXECUTION_END',
      () => this.render(),
      { kind: EXECUTION_KINDS.EVENT }
    );
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
    super.destroy();
    this._view.destroy();
  }
}
