/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */
export class NodeRenderKit {

  createCardChrome(ctx) {
    const {
      x, y, width, height,
      bgColor,
      borderColor,
      borderWidth
    } = ctx;

    return [

      // shadow
      {
        type: 'rect',
        silent: true,
        shape: {
          x: x + 2,
          y: y + 3,
          width,
          height,
          r: 8
        },
        style: {
          fill: 'rgba(0,0,0,0.10)'
        }
      },

      // card
      {
        type: 'rect',
        shape: {
          x,
          y,
          width,
          height,
          r: 8
        },
        style: {
          fill: bgColor,
          stroke: borderColor,
          lineWidth: borderWidth
        }
      }
    ];
  }

  createTitleSection(ctx, {
    icon,
    title
  }) {

    const {
      x,
      y,
      width,
      padding
    } = ctx;

    return [

      // icon
      {
        type: 'text',

        style: {
          text: icon,

          x: x + padding,
          y: y + 14,

          fontSize: 14,

          textVerticalAlign: 'middle'
        }
      },

      // title
      {
        type: 'text',

        style: {
          text: title,

          x: x + 30,
          y: y + 14,

          width: width - 80,

          overflow: 'truncate',

          fontSize: 11,
          fontWeight: 'bold',

          fill: '#fff',

          textVerticalAlign: 'middle'
        }
      },

      // divider
      {
        type: 'line',

        shape: {
          x1: x + padding,
          y1: y + 26,
          x2: x + width - padding,
          y2: y + 26
        },

        style: {
          stroke: 'rgba(255,255,255,0.08)',
          lineWidth: 1
        }
      }
    ];
  }


  createBadgeSection(ctx) {

    const badges = [];

    if (ctx.exec?.fired) {
      badges.push({
        text: 'Fired',
        bg: '#d8f8e8',
        fg: '#18794e'
      });
    }

    if (ctx.hasBp) {
      badges.push({
        text: '⏸ BP',
        bg: '#ffe0e0',
        fg: '#9f1c1c'
      });
    }

    const {
      x,
      y,
      width,
      padding
    } = ctx;

    const children = [];

    let badgeY = y + 8;

    for (const badge of badges) {

      const badgeWidth =
          Math.max(40, badge.text.length * 6 + 12);

      const bx =
          x + width - badgeWidth - padding;

      children.push({

        type: 'rect',

        shape: {
          x: bx,
          y: badgeY,
          width: badgeWidth,
          height: 16,
          r: 8
        },

        style: {
          fill: badge.bg
        }
      });

      children.push({

        type: 'text',

        style: {
          text: badge.text,

          x: bx + badgeWidth / 2,
          y: badgeY + 8,

          textAlign: 'center',
          textVerticalAlign: 'middle',

          fontSize: 8,
          fontWeight: 'bold',

          fill: badge.fg
        }
      });

      badgeY += 18;
    }

    return children;
  }

  createFooterSection(ctx) {

    const isActive = !!ctx.exec?.fired;

    const {
      x,
      y,
      height,
      padding
    } = ctx;

    return [

      // activity dot
      {
        type: 'circle',

        shape: {
          cx: x + padding + 4,
          cy: y + height - 12,
          r: 4
        },

        style: {
          fill: isActive
              ? '#22c55e'
              : '#777',

          shadowBlur: isActive ? 8 : 0,
          shadowColor: '#22c55e'
        }
      },

      // activity label
      {
        type: 'text',

        style: {
          text: isActive
              ? 'active'
              : 'idle',

          x: x + padding + 14,
          y: y + height - 12,

          fontSize: 9,

          fill: '#aaa',

          textVerticalAlign: 'middle'
        }
      }
    ];
  }

  createReducerMetrics(ctx, {
    mutationCount
  }) {

    const {
      x,
      y,
      padding
    } = ctx;

    return [

      {
        type: 'text',

        style: {
          text: `State Changes: ${mutationCount}`,

          x: x + padding,
          y: y + 44,

          fontSize: 9,

          fill: '#9ecbff'
        }
      }
    ];
  }

  createEventMetrics(ctx, {
    emitted
  }) {

    const {
      x,
      y,
      padding
    } = ctx;

    return [

      {
        type: 'text',

        style: {
          text: emitted
              ? 'Event emitted'
              : 'Awaiting emission',

          x: x + padding,
          y: y + 44,

          fontSize: 9,

          fill: emitted
              ? '#7ee787'
              : '#999'
        }
      }
    ];
  }

  createActionMetrics(ctx, {
    payloadSize
  }) {

    const {
      x,
      y,
      padding
    } = ctx;

    return [

      {
        type: 'text',

        style: {
          text: `Payload: ${payloadSize} bytes`,

          x: x + padding,
          y: y + 44,

          fontSize: 9,

          fill: '#9ecbff'
        }
      }
    ];
  }

  createHandlerMetrics(ctx, {
    durationMs
  }) {

    const {
      x,
      y,
      padding
    } = ctx;

    const slow =
        durationMs > 100;

    return [

      {
        type: 'text',

        style: {
          text: `Exec: ${durationMs} ms`,

          x: x + padding,
          y: y + 44,

          fontSize: 9,

          fill: slow
              ? '#ffb86b'
              : '#8be9fd'
        }
      }
    ];
  }
}
