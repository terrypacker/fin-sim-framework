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

export class MinHeap {
  constructor(compareFn) {
    this.data = [];
    this.compare = compareFn;
  }

  push(item) {
    this.data.push(item);
    this.bubbleUp(this.data.length - 1);
  }

  pop() {
    if (this.data.length === 0) return null;

    const top = this.data[0];
    const end = this.data.pop();

    if (this.data.length > 0) {
      this.data[0] = end;
      this.bubbleDown(0);
    }

    return top;
  }

  peek() {
    return this.data[0] || null;
  }

  size() {
    return this.data.length;
  }

  bubbleUp(index) {
    const item = this.data[index];

    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      const parent = this.data[parentIndex];

      if (this.compare(item, parent) >= 0) break;

      this.data[index] = parent;
      this.data[parentIndex] = item;
      index = parentIndex;
    }
  }

  bubbleDown(index) {
    const length = this.data.length;
    const item = this.data[index];

    while (true) {
      let left = index * 2 + 1;
      let right = index * 2 + 2;
      let swap = null;

      if (left < length) {
        if (this.compare(this.data[left], item) < 0) {
          swap = left;
        }
      }

      if (right < length) {
        if (
            this.compare(this.data[right],
                swap === null ? item : this.data[left]
            ) < 0
        ) {
          swap = right;
        }
      }

      if (swap === null) break;

      this.data[index] = this.data[swap];
      this.data[swap] = item;
      index = swap;
    }
  }
}
