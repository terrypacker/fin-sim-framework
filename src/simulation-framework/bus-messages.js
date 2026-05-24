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

export const SIMULATION_BUS_MESSAGES = {
  EVENT_OCCURRENCE_START: 'EVENT_OCCURRENCE_START',
  EVENT_OCCURRENCE_END: 'EVENT_OCCURRENCE_END',
  HANDLED_EVENT: 'HANDLED_EVENT',
  ACTION_RESULT: 'ACTION_RESULT',
  REDUCER_RESULT: 'REDUCER_RESULT'
}
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
 * Published once per Event occurrence at the start.
 * Always has type 'EVENT_OCCURRENCE_START'.
 */
export class EventStartBusMessage extends BusMessage {
  constructor({ date, payload }) {
    super({ type: SIMULATION_BUS_MESSAGES.EVENT_OCCURRENCE_START, date });
    this.payload = payload;
  }
}

/**
 * Published once per Event occurrence at the end after the event is complete.
 * Always has type 'EVENT_OCCURRENCE_END'.
 */
export class EventEndBusMessage extends BusMessage {
  constructor({ date, payload }) {
    super({ type: SIMULATION_BUS_MESSAGES.EVENT_OCCURRENCE_END, date });
    this.payload = payload;
  }
}

/**
 * Published once per each Action processed an event occurrence.
 * Always has type 'HANDLED_EVENT'.
 */
export class EventHandledMessage extends BusMessage {
  constructor({ date, payload }) {
    super({ type: SIMULATION_BUS_MESSAGES.HANDLED_EVENT, date });
    this.payload = payload;
  }
}

/**
 * Published once per Action occurrence.
 * Always has type 'ACTION_RESULT'.
 */
export class ActionResultMessage extends BusMessage {
  constructor({ date, payload }) {
    super({ type: SIMULATION_BUS_MESSAGES.ACTION_RESULT, date });
    this.payload = payload;
  }
}

/**
 * Published once per Reducer execution.
 * Always has type 'REDUCER_RESULT'.
 */
export class ReducerResultMessage extends BusMessage {
  constructor({ date, payload }) {
    super({ type: SIMULATION_BUS_MESSAGES.REDUCER_RESULT, date });
    this.payload = payload;
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

/**
 * Published by service-layer CRUD operations.
 * Always has bus type 'SERVICE_ACTION'.
 *
 * @property {'CREATE'|'UPDATE'|'DELETE'} actionType - The operation performed
 * @property {string}  classType    - Constructor name of the item (e.g. 'AmountAction', 'EventSeries')
 * @property {*}       item         - The item returned from the service call (may differ from originalItem after CREATE/UPDATE)
 * @property {*}       originalItem - The item as passed into the service call (null for CREATE)
 */
export class ServiceActionEvent extends BusMessage {
  constructor({ actionType, classType, item, originalItem = null }) {
    super({ type: 'SERVICE_ACTION' });
    this.actionType   = actionType;
    this.classType    = classType;
    this.item         = item;
    this.originalItem = originalItem;
  }
}
