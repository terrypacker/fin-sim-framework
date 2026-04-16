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

export class Account {
  constructor(initialValue = 0) {
    this.balance = initialValue;
    this.credits = [];
    this.debits = [];
  }
}

export class AccountService {

  /**
   * Perform a transaction on an account
   * @param account
   * @param amount
   */
  transaction(account, amount, date) {
    if (amount > 0) {
      account.credits.push({
        amount: amount,
        date: date
      });

    }else if(amount < 0){
      account.debits.push({
        amount: amount,
        date: date
      });
    }
    account.balance = account.balance + amount;
  }
}
