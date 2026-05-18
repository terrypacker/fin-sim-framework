/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */
import { NodeRenderGroup } from "./default-node-renderer.js";

export class ReducerNodeRenderer {

  constructor(renderKit) {
    this.renderKit = renderKit;
  }

  render( ctx ) {

    const reducerName =
        ctx.node.name
        ?? ctx.node.reducerType
        ?? 'Reducer';

    const mutationCount =
        ctx.exec?.stateChanges?.length ?? 0;

    return new NodeRenderGroup(

        this.renderKit.createCardChrome(ctx),

        this.renderKit.createTitleSection(ctx, {
          icon: '🧠',
          title: reducerName
        }),

        this.renderKit.createBadgeSection(ctx),

        this.renderKit.createReducerMetrics(ctx, {
          mutationCount
        }),

        this.renderKit.createFooterSection(ctx)
    );
  }
}
