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

import { SimulationState } from '../simulation-framework/simulation-state.js';
import { Account } from './account.js';

/**
 * FinancialState extends SimulationState with the standard fields common to
 * financial simulations.
 *
 * Standard fields (in addition to `metrics` from SimulationState)
 * ───────────────────────────────────────────────────────────────
 * checkingAccount  {Account}  Primary liquid cash account used for income
 *                             credits, expense debits, and tax payments.
 *                             Managed via `AccountService` outside of state.
 *
 * Subclasses add scenario-specific fields such as investment accounts,
 * YTD income trackers, residency flags, and retirement accounts.
 *
 * Usage
 * ─────
 * // Direct use
 * const sim = new Simulation(startDate, {
 *   initialState: new FinancialState({ checkingAccount: new Account(50000) }).toPlain()
 * });
 *
 * // Subclass use
 * class RetirementState extends FinancialState {
 *   constructor(opts = {}) {
 *     super(opts);
 *     this.portfolioValue   = opts.portfolioValue   ?? 0;
 *     this.annualWithdrawal = opts.annualWithdrawal ?? 0;
 *   }
 * }
 * const sim = new Simulation(startDate, {
 *   initialState: new RetirementState({
 *     checkingAccount: new Account(10000),
 *     portfolioValue:  800000,
 *   }).toPlain()
 * });
 */
export class FinancialState extends SimulationState {
  constructor({ checkingAccount = new Account(0), ...rest } = {}) {
    super(rest);
    this.checkingAccount = checkingAccount;
  }
}

