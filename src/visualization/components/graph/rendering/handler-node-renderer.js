/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */
import {NodeRenderGroup} from "./default-node-renderer.js";

export class HandlerNodeRenderer {

  constructor(renderKit) {
    this.renderKit = renderKit;
  }

  render(ctx) {

    const title =
        ctx.node.name
        ?? ctx.node.handlerClass
        ?? 'Handler';

    return new NodeRenderGroup(
        this.renderKit.createCardChrome(ctx),
        this.renderKit.createTitleSection(ctx, {
          icon: '🛠️',
          title
        }),
        this.renderKit.createBadgeSection(ctx),
        this.renderKit.createFooterSection(ctx)
    );
  }
}
