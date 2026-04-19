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

/**
 * Base class for all messages published to the EventBus.
 * Every message has a type discriminator and an optional date.
 */
export class BusMessage {
  constructor({ type, date }) {
    this.type = type;
    this.date = date;
  }
}

/**
 * Published when a scheduled event fires (from execute()) and after each
 * action completes its reducer pipeline (from applyActions()).
 *
 * payload is either the raw scheduled event object or the tagged action object,
 * depending on the publish site.
 */
export class SimulationBusMessage extends BusMessage {
  constructor({ type, date, sim, payload, stateSnapshot }) {
    super({ type, date });
    this.sim = sim;
    this.payload = payload;
    this.stateSnapshot = stateSnapshot;
  }
}

/**
 * Published once per ActionNode added to the SimulationEventGraph.
 * Always has type 'DEBUG_ACTION'. Used by the graph visualizer.
 */
export class DebugActionBusMessage extends BusMessage {
  constructor({ date, payload }) {
    super({ type: 'DEBUG_ACTION', date });
    this.payload = payload;
  }
}
