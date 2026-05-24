/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

export class ScenarioSerializer {

  /**
   * Serialize the current graph state into a scenario config object.
   */
  static serialize(graphBuilder, name, simStart, simEnd, initialState, params) {
    const toDateStr = (d) => {
      if (!d) return null;
      if (d instanceof Date) return d.toISOString().slice(0, 10);
      return String(d).slice(0, 10);
    };

    return {
      name,
      simStart: toDateStr(simStart),
      simEnd:   toDateStr(simEnd),
      events:   graphBuilder.getKind('event').map(n => ScenarioSerializer._serializeEvent(n)),
      handlers: graphBuilder.getKind('handler').map(n => ScenarioSerializer._serializeHandler(n)),
      actions:  graphBuilder.getKind('action').map(n => ScenarioSerializer._serializeAction(n)),
      reducers: graphBuilder.getKind('reducer').map(n => ScenarioSerializer._serializeReducer(n)),
      initialState: initialState ?? {},
      params:   params ?? [],
    };
  }

  /**
   * Reconstruct scenario nodes from a saved config and register them with the scenario.
   * Call this after scenario.buildSim() so this.sim exists.
   */
  static deserialize(config, scenario) {
    // Build action instances indexed by their type (= id)
    const actionMap = new Map();
    for (const d of (config.actions ?? [])) {
      actionMap.set(d.id, ScenarioSerializer._makeAction(d));
    }

    // Build event instances and register/add them
    const eventMap = new Map();
    for (const d of (config.events ?? [])) {
      const event = ScenarioSerializer._makeEvent(d);
      eventMap.set(d.id, event);
      if (event.enabled) {
        scenario.scheduleEvent(event);
      } else {
        scenario.eventSchedulerUI.addEvent(event);
      }
    }

    // Reconstruct handlers
    for (const d of (config.handlers ?? [])) {
      const handler = new FinSimLib.Core.HandlerEntry(null, d.name);
      for (const eid of (d.handledEventIds ?? [])) {
        const ev = eventMap.get(eid);
        if (ev) handler.handledEvents.push(ev);
      }
      for (const aid of (d.generatedActionIds ?? [])) {
        const action = actionMap.get(aid);
        if (action) handler.generatedActions.push(action);
      }
      // registerHandler assigns handler.id and wires to sim + graph
      scenario.registerHandler(handler);
    }

    // Reconstruct reducers
    for (const d of (config.reducers ?? [])) {
      const reducer = ScenarioSerializer._makeReducer(d);
      // Pre-assign the saved id; registerReducer only assigns if !reducer.id
      reducer.id = d.id;
      for (const aid of (d.reducedActionIds ?? [])) {
        const action = actionMap.get(aid);
        if (action) reducer.reducedActions.push(action);
      }
      for (const aid of (d.generatedActionIds ?? [])) {
        const action = actionMap.get(aid);
        if (action) reducer.generatedActions.push(action);
      }
      scenario.registerReducer(reducer);
    }

    // Advance scenario ID counters to avoid collisions with future nodes
    const maxNum = (items, prefix) =>
      (items ?? []).reduce((m, d) => {
        const match = d.id?.match(new RegExp(`^${prefix}(\\d+)$`));
        return match ? Math.max(m, parseInt(match[1]) + 1) : m;
      }, 1);

    scenario._nextEventId   = Math.max(scenario._nextEventId,   maxNum(config.events,   'e'));
    scenario._nextHandlerId = Math.max(scenario._nextHandlerId,  (config.handlers?.length ?? 0) + 1);
    scenario._nextReducerId = Math.max(scenario._nextReducerId,  maxNum(config.reducers, 'r'));
    scenario._nextActionId  = Math.max(scenario._nextActionId,   (config.actions?.length ?? 0) + 1);
  }

  // ─── Serializers ──────────────────────────────────────────────────────────────

  static _serializeEvent(node) {
    const d = {
      __type:   node.eventType === 'OneOff' ? 'OneOffEvent' : 'EventSeries',
      id:       node.id,
      name:     node.name,
      type:     node.type,
      enabled:  node.enabled ?? false,
      color:    node.color ?? '#888888',
    };
    if (node.eventType === 'OneOff') {
      d.date = node.date instanceof Date ? node.date.toISOString() : node.date;
    } else {
      d.interval    = node.interval;
      d.startOffset = node.startOffset ?? 0;
    }
    return d;
  }

  static _serializeHandler(node) {
    return {
      __type:             'HandlerEntry',
      id:                 node.id,
      name:               node.name,
      handledEventIds:    (node.handledEvents    ?? []).map(e => e.id),
      generatedActionIds: (node.generatedActions ?? []).map(a => a.id),
    };
  }

  static _serializeAction(node) {
    const C = FinSimLib.Core;
    let typeName = 'AmountAction';
    // Check subclasses before superclasses
    if (node instanceof C.RecordNumericSumMetricAction)     typeName = 'RecordNumericSumMetricAction';
    else if (node instanceof C.RecordArrayMetricAction)     typeName = 'RecordArrayMetricAction';
    else if (node instanceof C.RecordMultiplicativeMetricAction) typeName = 'RecordMultiplicativeMetricAction';
    else if (node instanceof C.RecordBalanceAction)         typeName = 'RecordBalanceAction';
    else if (node instanceof C.RecordMetricAction)          typeName = 'RecordMetricAction';

    // fieldName on RecordMetricAction subclasses includes 'metrics.' prefix — strip it
    const rawField = node.fieldName;
    const fieldName = rawField?.startsWith('metrics.') ? rawField.slice(8) : rawField;

    return {
      __type:    typeName,
      id:        node.type,   // action id = type (convention from EventScheduler.addAction)
      name:      node.name,
      type:      node.type,
      value:     node.value,
      fieldName,
    };
  }

  static _serializeReducer(node) {
    return {
      __type:             node.reducerType ?? 'MetricReducer',
      id:                 node.id,
      name:               node.name,
      priority:           node.priority,
      fieldName:          node.fieldName,
      reducedActionIds:   (node.reducedActions   ?? []).map(a => a.id),
      generatedActionIds: (node.generatedActions ?? []).map(a => a.id),
    };
  }

  // ─── Constructors ─────────────────────────────────────────────────────────────

  static _makeEvent(d) {
    if (d.__type === 'OneOffEvent') {
      return new FinSimLib.Core.OneOffEvent({
        id:      d.id,
        name:    d.name,
        type:    d.type,
        date:    d.date ? new Date(d.date) : new Date(),
        enabled: d.enabled ?? false,
        color:   d.color ?? '#888888',
      });
    }
    return new FinSimLib.Core.EventSeries({
      id:          d.id,
      name:        d.name,
      type:        d.type,
      interval:    d.interval ?? 'month-end',
      startOffset: d.startOffset ?? 0,
      enabled:     d.enabled ?? false,
      color:       d.color ?? '#888888',
    });
  }

  static _makeAction(d) {
    const C = FinSimLib.Core;
    switch (d.__type) {
      case 'RecordNumericSumMetricAction':
        return new C.RecordNumericSumMetricAction(d.name, d.fieldName, d.value);
      case 'RecordArrayMetricAction':
        return new C.RecordArrayMetricAction(d.name, d.fieldName, d.value);
      case 'RecordMultiplicativeMetricAction':
        return new C.RecordMultiplicativeMetricAction(d.name, d.fieldName, d.value);
      case 'RecordBalanceAction':
        return new C.RecordBalanceAction();
      case 'RecordMetricAction':
        return new C.RecordMetricAction(d.type, d.name, d.fieldName, d.value);
      default: // AmountAction or unknown
        return new C.AmountAction(d.type, d.name, d.value ?? 0);
    }
  }

  static _makeReducer(d) {
    const C = FinSimLib.Core;
    // For metric-based reducers fieldName is stored as 'metrics.X'; fromMetric takes 'X'
    const fieldName = d.fieldName ?? '';
    const metricName = fieldName.startsWith('metrics.') ? fieldName.slice(8) : fieldName;

    switch (d.__type) {
      case 'MetricReducer':
        return C.MetricReducer.fromMetric(metricName).withName(d.name);
      case 'ArrayMetricReducer':
        return C.ArrayMetricReducer.fromMetric(metricName).withName(d.name);
      case 'NumericSumMetricReducer':
        return C.NumericSumMetricReducer.fromMetric(metricName).withName(d.name);
      case 'MultiplicativeMetricReducer':
        // MultiplicativeMetricReducer extends FieldReducer (no metrics. prefix)
        return C.MultiplicativeMetricReducer.fromMetric(fieldName).withName(d.name);
      case 'NoOpReducer':
        return new C.NoOpReducer(d.name);
      default:
        return C.MetricReducer.fromMetric(metricName || '').withName(d.name);
    }
  }
}
