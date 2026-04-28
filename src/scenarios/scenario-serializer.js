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
   * Reconstruct scenario nodes from a saved config and register them with the
   * services.  Call this after scenario.buildSim() so the simulation exists.
   *
   * Each service.register() call publishes a CREATE event on the shared bus,
   * which is picked up by:
   *   - BaseScenario's subscriber → wires the item into the simulation
   *   - EventScheduler's subscriber → adds the node to the graph
   *
   * Items are registered in dependency order so that references are already
   * in the service maps when CREATE fires:
   *   actions → events → handlers → reducers
   *
   * @param {object} config - serialized scenario config
   * @param {{ eventService, handlerService, actionService, reducerService }} services
   *   Pass ServiceRegistry.getInstance() or any object exposing the four service
   *   properties.
   */
  static deserialize(config, services) {
    const { eventService, handlerService, actionService, reducerService } = services;

    // 1. Actions first — handlers and reducers hold references to them.
    const actionMap = new Map();
    for (const d of (config.actions ?? [])) {
      const action = ScenarioSerializer._makeAction(d);
      actionService.register(action);   // publishes CREATE → graph node added
      actionMap.set(d.id, action);
    }

    // 2. Events
    const eventMap = new Map();
    for (const d of (config.events ?? [])) {
      const event = ScenarioSerializer._makeEvent(d);
      eventService.register(event);     // publishes CREATE → sim schedules (if enabled) + graph node added
      eventMap.set(d.id, event);
    }

    // 3. Handlers — resolve references before registering so the CREATE
    //    subscriber sees the fully-wired handler.
    for (const d of (config.handlers ?? [])) {
      const handler = new FinSimLib.Core.HandlerEntry(null, d.name);
      handler.id = d.id;
      for (const eid of (d.handledEventIds ?? [])) {
        const ev = eventMap.get(eid);
        if (ev) handler.handledEvents.push(ev);
      }
      for (const aid of (d.generatedActionIds ?? [])) {
        const action = actionMap.get(aid);
        if (action) handler.generatedActions.push(action);
      }
      handlerService.register(handler); // publishes CREATE → sim registers handlers + graph node added
    }

    // 4. Reducers — resolve references before registering.
    for (const d of (config.reducers ?? [])) {
      const reducer = ScenarioSerializer._makeReducer(d);
      reducer.id = d.id;
      for (const aid of (d.reducedActionIds ?? [])) {
        const action = actionMap.get(aid);
        if (action) reducer.reducedActions.push(action);
      }
      for (const aid of (d.generatedActionIds ?? [])) {
        const action = actionMap.get(aid);
        if (action) reducer.generatedActions.push(action);
      }
      reducerService.register(reducer); // publishes CREATE → sim wires reducers + graph node added
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
    let typeName;
    // Check subclasses before superclasses (order matters for instanceof).
    // AmountAction must be checked before FieldValueAction since it extends it.
    if (node instanceof C.AmountAction)           typeName = 'AmountAction';
    else if (node instanceof C.ScriptedAction)    typeName = 'ScriptedAction';
    else if (node instanceof C.FieldValueAction)  typeName = 'FieldValueAction';
    else if (node instanceof C.FieldAction)       typeName = 'FieldAction';
    else if (node instanceof C.Action)            typeName = 'Action';
    else throw new Error(`Unsupported action type ${node}`);

    return {
      __type:    typeName,
      id:        node.id,    // unique service-assigned id (separate from type)
      name:      node.name,
      type:      node.type,  // category discriminator for ReducerPipeline lookup
      value:     node.value,
      fieldName: node.fieldName,
      script:    node.script,  // ScriptedAction only; undefined for all other types
    };
  }

  static _serializeReducer(node) {
    return {
      __type:             node.reducerType ?? 'FieldReducer',
      id:                 node.id,
      name:               node.name,
      priority:           node.priority,
      fieldName:          node.fieldName,
      value:              node.value ?? null,  // FieldValueReducer subclasses only; null for others
      script:             node.script,  // ScriptedReducer only; undefined for all other types
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
    let action;
    switch (d.__type) {
      case 'Action':
        action = new C.Action(d.type, d.name)
      case 'FieldAction':
        action = new C.FieldAction(d.type, d.name, d.fieldName);
        break;
      case 'FieldValueAction':
        action = new C.FieldValueAction(d.type, d.name, d.fieldName, d.value);
        break;
      case 'AmountAction':
        action = new C.AmountAction(d.type, d.name, d.value ?? 0);
        break;
      case 'ScriptedAction':
        action = new C.ScriptedAction(d.type, d.name, d.fieldName ?? '', d.script ?? '');
        break;
      default:
        throw new Error(`Add support for deserialization of action type ${d.__type}.`);
    }
    action.id = d.id;  // restore the saved id (separate from type since action id != type)
    return action;
  }

  static _makeReducer(d) {
    const C = FinSimLib.Core;

    const fieldName = d.fieldName ?? '';
    switch (d.__type) {
      case 'ArrayReducer':
        return C.ReducerBuilder.array(fieldName).name(d.name).priority(d.priority).value(d.value ?? null).build();
      case 'NumericSumReducer':
        return C.ReducerBuilder.numericSum(fieldName).name(d.name).priority(d.priority).value(d.value ?? null).build();
      case 'MultiplicativeReducer':
        return C.ReducerBuilder.multiplicative(fieldName).name(d.name).priority(d.priority).value(d.value ?? null).build();
      case 'NoOpReducer':
        return C.ReducerBuilder.noOp().name(d.name).priority(d.priority).build();
      case 'ScriptedReducer':
        return new C.ScriptedReducer(d.name, d.priority, d.fieldName ?? '', d.script ?? '');
      case 'FieldReducer':
        return C.ReducerBuilder.field(fieldName).name(d.name).priority(d.priority).build();
      default:
        throw new Error(`Add support for deserialization of reducer type ${d.__type}.`);
    }
  }
}
