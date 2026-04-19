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

export class JournalEntry {
  constructor({
    date, eventType, action,
    reducer, prevState, nextState, emittedActions, sourceEvent
  }) {
    this.date = date;
    this.eventType = eventType;
    this.action = action;
    this.reducer = reducer;
    this.prevState = prevState;
    this.nextState = nextState;
    this.emittedActions = emittedActions;
    this.sourceEvent = sourceEvent;
  }
}

export class Journal {
  constructor({enabled = false}) {
    this.enabled = enabled;
    this.journal = [];
  }

  addEntry(journalEntry) {
    this.journal.push(journalEntry);
  }

  getActions(type) {
    return this.journal.filter(j => j.action.type === type);
  }

  getStateTimeline(field) {
    return this.journal.map(j => ({
      date: j.date,
      value: j.nextState[field]
    }));
  }

  /**
   * Trace a single event on a date
   * @param date
   * @returns {*[]}
   */
  traceEvent(date) {
    return this.journal.filter(j =>
        j.date.getTime() === date.getTime()
    );
  }
}
