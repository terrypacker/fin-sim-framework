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
   * Serialize the current scenario state into a config object.
   *
   * Reads directly from the service maps so that in-flight UI edits (name,
   * type, field values) are captured without relying on the ConfigGraphBuilder's
   * internal node structure.
   *
   * @param {{ eventService, handlerService, actionService, reducerService }} services
   *   The ServiceRegistry instance (or any object exposing the four service
   *   properties).  Pass `ServiceRegistry.getInstance()` from the save handler.
   * @param {string} name
   * @param {string|Date} simStart
   * @param {string|Date} simEnd
   * @param {object} initialState
   * @param {Array}  params
   * @returns {object} serialized scenario config
   */
  static serialize(services, name, simStart, simEnd, initialState, params) {
    const { eventService, handlerService, actionService, reducerService } = services;

    const toDateStr = (d) => {
      if (!d) return null;
      if (d instanceof Date) return d.toISOString().slice(0, 10);
      return String(d).slice(0, 10);
    };

    return {
      name,
      simStart: toDateStr(simStart),
      simEnd:   toDateStr(simEnd),
      events:   eventService.getAll().map(n => ScenarioSerializer._serializeEvent(n)),
      handlers: handlerService.getAll().map(n => ScenarioSerializer._serializeHandler(n)),
      actions:  actionService.getAll().map(n => ScenarioSerializer._serializeAction(n)),
      reducers: reducerService.getAll().map(n => ScenarioSerializer._serializeReducer(n)),
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
    else if (node instanceof C.FieldValueAction)          typeName = 'FieldValueAction';
    else throw new Error(`Unsupported action type ${node}`);

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
    }else if(d.__type == 'EventSeries') {
      return new FinSimLib.Core.EventSeries({
        id: d.id,
        name: d.name,
        type: d.type,
        interval: d.interval ?? 'month-end',
        startOffset: d.startOffset ?? 0,
        enabled: d.enabled ?? false,
        color: d.color ?? '#888888',
      });
    }else {
      throw new Error(`Add support for deserialization of event type ${d.__type}.`);
    }
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
      case 'FieldValueAction':
        return new C.FieldValueAction(d.type, d.name, d.fieldName, d.value);
      case 'AmountAction':
        return new C.AmountAction(d.type, d.name, d.value ?? 0);
        break;
      default: // AmountAction or unknown
        throw new Error(`Add support for deserialization of action type ${d.__type}.`);
    }
  }

  static _makeReducer(d) {
    const C = FinSimLib.Core;
    // For metric-based reducers fieldName is stored as 'metrics.X'; fromMetric takes 'X'
    const fieldName = d.fieldName ?? '';
    const metricName = fieldName.startsWith('metrics.') ? fieldName.slice(8) : fieldName;

    switch (d.__type) {
      case 'MetricReducer':
        return C.ReducerBuilder.metric(metricName).name(d.name).build();
      case 'ArrayMetricReducer':
        return C.ReducerBuilder.arrayMetric(metricName).name(d.name).build();
      case 'NumericSumMetricReducer':
        return C.ReducerBuilder.numericSum(metricName).name(d.name).build();
      case 'MultiplicativeMetricReducer':
        // MultiplicativeMetricReducer extends FieldReducer (no metrics. prefix)
        return C.ReducerBuilder.multiplicative(fieldName).name(d.name).build();
      case 'NoOpReducer':
        return C.ReducerBuilder.noOp().name(d.name).build();
      case 'StateFieldReducer':
        return C.ReducerBuilder.stateField().name(d.name).fieldName(d.fieldName).build();
        break;
      default:
        throw new Error(`Add support for deserialization of reducer type ${d.__type}.`);
    }
  }
}
