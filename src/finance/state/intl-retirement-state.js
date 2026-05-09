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

import {SimulationState} from '../../simulation-framework/simulation-state.js';

export class InternationalRetirementFinancialState extends SimulationState {
  constructor({
      //People
    primary, spouse,
      //Accounts
    usSavingsAccount, fixedIncomeAccount, stockAccount,
    iraAccount, k401Account, rothAccount,
    auSavingsAccount, auStockAccount, superAccount,
    exchangeRateUsdToAud,
    intlTransferFeeUsd,
    ...rest
  } = {}) {
    super(rest);
    this.people = {primary, spouse};

    //TODO Remove these this should not be needed.
    this.personBirthDate = primary.birthDate;
    this.isAuResident = false;

    //US Accounts
    this._assignAccount('usSavingsAccount', usSavingsAccount);
    this._assignAccount('fixedIncomeAccount', fixedIncomeAccount);
    this._assignAccount('stockAccount', stockAccount);
    this._assignAccount('iraAccount', iraAccount);
    this._assignAccount('k401Account', k401Account);
    this._assignAccount('rothAccount', rothAccount);

    //AU Accounts
    this._assignAccount('auSavingsAccount', auSavingsAccount);
    this._assignAccount('auStockAccount', auStockAccount);
    this._assignAccount('superAccount', superAccount);

    //TODO Move to FX When available.
    this.exchangeRateUsdToAud = exchangeRateUsdToAud;
    this.intlTransferFeeUsd = intlTransferFeeUsd;

    // YTD tax accumulators
    this.usOrdinaryIncomeYTD = 0;
    this.usNegativeIncomeYTD = 0;
    this.usCapitalGainsYTD = 0;
    this.usPenaltyYTD = 0;
    this.auOrdinaryIncomeYTD = 0;
    this.auCapitalGainsYTD = 0;
    this.auNonResidentWithholdingYTD = 0;
    this.auSuperTaxYTD = 0;
    this.auFrankingCreditYTD = 0;
    this.ftcYTD = 0;

    this.superWithdrawalBlocked = false;
    this.outOfFundsDate = null;
  }
}

