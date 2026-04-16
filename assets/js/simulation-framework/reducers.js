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

export class ReducerPipeline {
  constructor() {
    this.map = new Map(); // actionType -> [{priority, fn}]
  }

  register(actionType, fn, priority = 100, name = 'anonymous') {
    if (!this.map.has(actionType)) {
      this.map.set(actionType, []);
    }

    const list = this.map.get(actionType);

    list.push({ fn, priority, name });

    // Keep sorted (lowest runs first)
    list.sort((a, b) => a.priority - b.priority);
  }

  get(actionType) {
    return this.map.get(actionType) || [];
  }
}

export const PRIORITY = {
  PRE_PROCESS: 10,

  // Core financial mechanics
  CASH_FLOW: 20,
  POSITION_UPDATE: 30,
  COST_BASIS: 40,

  // Tax layer
  TAX_CALC: 60,
  TAX_APPLY: 70,

  // Derived / reporting
  METRICS: 90,
  LOGGING: 100
};
