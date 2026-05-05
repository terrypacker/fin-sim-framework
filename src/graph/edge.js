/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */
export class Edge {
  constructor({ from, to, type }) {
    this.from = from;
    this.to = to;

    this.type =
        type; // 'config' | 'triggers' | 'causes' | 'instance-of'
  }
}
