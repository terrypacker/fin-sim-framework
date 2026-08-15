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
 * Registry of observers bracketing every reducer invocation.
 *
 * An observer sees state immediately **before** a reducer runs and immediately **after**
 * the resulting state is assigned, and may write state and emit actions in response. It
 * is the reducer-side counterpart of {@link DerivedMetricsRegistry}: the engine knows
 * only "call these", and every scrap of domain meaning lives in the registered function.
 *
 * ─── why this exists, when reducers already return their own state ──────────────────
 *
 * Some invariants are properties of a *transition* rather than of an action, and no
 * single reducer can maintain them because no single reducer knows it is the one that
 * moved the thing. Design 87 phase 3's §988 currency lot ledger is the motivating case:
 * a foreign-currency cash balance is credited from roughly twenty places — AU rent, AU
 * wages, interest, dividends, coupons, sale proceeds, transfers — about half of which
 * patch `state[key].balance` directly rather than going through `AccountService`. Wiring
 * each one by hand is precisely the pattern that produced design 87's G2 (two conversion
 * paths, one of them unrealized for months) and the third such path found later in
 * `fx-transfer-apply-reducer.js`. An observer cannot be forgotten by a *new* credit path,
 * which is the same argument that moved the CASH-basis invariant to `_patchHolding`
 * rather than leaving it in each reducer (design 87 §11a).
 *
 * ─── the contract ───────────────────────────────────────────────────────────────────
 *
 * An observer is `{ before(state), after(state, token, action, date) }`:
 *
 *   `before` runs before the reducer and returns an opaque token — whatever the observer
 *   needs to remember. **It must capture by VALUE, not by reference.** `AccountService`
 *   mutates state entries in place (see its `transaction()`), so an observer that stashed
 *   `state.someAccount` and compared it afterwards would be comparing an object with
 *   itself and would see nothing. Capture the numbers.
 *
 *   `after` runs once the reducer's state has been assigned, and may mutate that state
 *   and return an array of actions. Returned actions are decorated and unshifted onto the
 *   action queue exactly as a reducer's own `next` actions are, so they are processed
 *   immediately after the movement that caused them.
 *
 * Observers run in insertion order, and `after` runs in the SAME order as `before` (not
 * reversed): these are peers maintaining independent invariants, not nested resources.
 *
 * ─── computation, not observation ───────────────────────────────────────────────────
 *
 * Observers run at **every** telemetry level, including `silent` and Monte Carlo. That is
 * deliberate and follows the contract stated in `simulation.js`: telemetry suppresses
 * observation, never computation. An observer that maintains a tax basis is computing
 * state that later periods read, so gating it on `!silent` would make a run's tax figures
 * depend on whether anyone was watching — the exact trap that once left `netWorth` at 0
 * rather than absent in every silent run.
 *
 * The name is therefore slightly wrong in a useful way: an observer *observes a
 * transition* but is free to *write*. Anything registered here is load-bearing.
 *
 * ─── cost ───────────────────────────────────────────────────────────────────────────
 *
 * `before`/`after` run on every reducer invocation — order 10^5 times in a 44-year plan —
 * so an observer must be O(1)-ish in the size of state. Scanning `Object.entries(state)`
 * here is quadratic over a run and is the single easiest way to make this expensive; cache
 * whatever key list you need and invalidate it, rather than re-deriving it per reducer.
 *
 * Usage:
 *   const registry = new ReducerObserverRegistry();
 *   registry.register(currencyLotObserver);
 *   sim = new Simulation(start, { opts: { reducerObservers: registry } });
 */
export class ReducerObserverRegistry {
  constructor() {
    this._observers = [];
  }

  /**
   * Add an observer.
   * @param {{before: function(object): *, after: function(object, *, object, Date): (object[]|void)}} observer
   */
  register(observer) {
    this._observers.push(observer);
  }

  /** True when nothing is registered — lets the caller skip the bracket entirely. */
  get isEmpty() {
    return this._observers.length === 0;
  }

  /**
   * Run every observer's `before`, returning the tokens for the matching `after`.
   * @param {object} state
   * @returns {Array} one token per observer, positionally matched
   */
  before(state) {
    const tokens = new Array(this._observers.length);
    for (let i = 0; i < this._observers.length; i++) {
      tokens[i] = this._observers[i].before?.(state);
    }
    return tokens;
  }

  /**
   * Run every observer's `after` and collect the actions they emit.
   *
   * @param {object} state   mutable post-reducer state
   * @param {Array}  tokens  the array returned by {@link before}
   * @param {object} action  the action whose reducer just ran
   * @param {Date}   date    current simulation date
   * @returns {object[]} actions to enqueue; empty when nobody emitted
   */
  after(state, tokens, action, date) {
    let emitted = null;
    for (let i = 0; i < this._observers.length; i++) {
      const out = this._observers[i].after?.(state, tokens?.[i], action, date);
      if (out && out.length) (emitted ??= []).push(...out);
    }
    return emitted ?? [];
  }
}
