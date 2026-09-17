/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { EventSeries } from '../events/event-series.js';
import { OneOffEvent } from '../events/one-off-event.js';

class EventSeriesBuilder {
  constructor() {
    this._id          = undefined;
    this._name        = undefined;
    this._type        = undefined;
    this._enabled     = true;
    this._color       = '#888888';
    this._interval    = undefined;
    this._startOffset = 0;
    this._order       = 0;
    this._data        = {};
    this._meta        = {};
    // Fixed calendar anchor. `SimulationAdapter._scheduleEventSeries` has always honoured
    // `month`/`day` on an EventSeries — "anchor to a fixed calendar date each year" — but the
    // builder had no way to say it, so the only reachable anchors were the interval snaps
    // (month-end, year-end, semiannual). Design 107 §5.2 needs 1 January and 1 July, which is
    // neither: an income year STARTS on those dates and every snap lands on an end.
    this._month       = undefined;
    this._day         = undefined;
  }

  id(v)          { this._id = v;          return this; }
  name(v)        { this._name = v;        return this; }
  type(v)        { this._type = v;        return this; }
  enabled(v)     { this._enabled = v;     return this; }
  color(v)       { this._color = v;       return this; }
  interval(v)    { this._interval = v;    return this; }
  startOffset(v) { this._startOffset = v; return this; }
  /** 1-based calendar month to anchor each firing to; requires `day()`. */
  month(v)       { this._month = v;       return this; }
  /** Day of month to anchor each firing to; requires `month()`. */
  day(v)         { this._day = v;         return this; }
  order(v)       { this._order = v;       return this; }
  data(v)        { this._data = v;        return this; }
  meta(v)        { this._meta = v;        return this; }

  build() {
    return new EventSeries({
      id:          this._id,
      name:        this._name,
      type:        this._type,
      enabled:     this._enabled,
      color:       this._color,
      interval:    this._interval,
      startOffset: this._startOffset,
      month:       this._month,
      day:         this._day,
      order:       this._order,
      data:        this._data,
      meta:        this._meta,
    });
  }
}

class OneOffEventBuilder {
  constructor() {
    this._id      = undefined;
    this._name    = undefined;
    this._type    = undefined;
    this._enabled = true;
    this._color   = '#888888';
    this._date    = undefined;
    this._data    = {};
    this._meta    = {};
  }

  id(v)      { this._id = v;      return this; }
  name(v)    { this._name = v;    return this; }
  type(v)    { this._type = v;    return this; }
  enabled(v) { this._enabled = v; return this; }
  color(v)   { this._color = v;   return this; }
  date(v)    { this._date = v;    return this; }
  data(v)    { this._data = v;    return this; }
  meta(v)    { this._meta = v;    return this; }

  build() {
    return new OneOffEvent({
      id:      this._id,
      name:    this._name,
      type:    this._type,
      enabled: this._enabled,
      color:   this._color,
      date:    this._date,
      data:    this._data,
      meta:    this._meta,
    });
  }
}

export class EventBuilder {
  static eventSeries() { return new EventSeriesBuilder(); }
  static oneOff()      { return new OneOffEventBuilder(); }
}
