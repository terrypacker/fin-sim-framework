/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Account } from "../../finance/account.js";

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
    this._controller = controller;
    this._view       = view;
    this._people     = [];

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

    // ── React to service bus (deserialization, programmatic changes) ────────
    bus.subscribe('SERVICE_ACTION', (msg) => {
      if (msg.item instanceof Account) this._refresh();
    });

    // Initial render.
    this._refresh();
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
    this._view.renderList(this._controller.list(), this._people);
  }
}
