/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { DefaultNodeRenderer } from "./default-node-renderer.js";
import { ReducerNodeRenderer } from "./reducer-node-renderer.js";
import { NodeRenderKit } from "./node-render-kit.js";
import {ActionNodeRenderer} from "./action-node-renderer.js";
import {EventNodeRenderer} from "./event-node-renderer.js";
import {HandlerNodeRenderer} from "./handler-node-renderer.js";

export class NodeRendererRegistry {
  constructor() {
    this.renderers = new Map();
  }

  register(kind, renderer) {
    this.renderers.set(kind, renderer);
  }

  get(kind) {
    return this.renderers.get(kind)
        || this.renderers.get('default');
  }

  registerDefaults(renderKit = new NodeRenderKit()) {
    this.register(
        'event',
        new EventNodeRenderer(renderKit)
    );

    this.register(
        'action',
        new ActionNodeRenderer(renderKit)
    );

    this.register(
        'handler',
        new HandlerNodeRenderer(renderKit)
    );

    this.register(
        'reducer',
        new ReducerNodeRenderer(renderKit)
    );

    this.register(
        'default',
        new DefaultNodeRenderer(renderKit)
    );
  }
}
