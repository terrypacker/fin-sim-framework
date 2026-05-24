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

  constructor() {
    //TODO remove this or relocate it so we can control it
    this._canvas = document.createElement('canvas');
    this._context = this._canvas.getContext('2d');
  }

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
        // CRITICAL FOR PAN/ZOOM: Clip the element to the current coordinate system
        clip: ctx.clip,
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
        // CRITICAL FOR PAN/ZOOM: Clip the element to the current coordinate system
        clip: ctx.clip,
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
      textStyle,
      api,
      width,
      height,
      x,
      y,
      padding
    } = ctx;

    const titleText = `${icon} ${title}`
    const titleTextMetrics = this.getTextWidth(titleText, {
      fontFamily: textStyle.fontFamily,
      fontSize: 14,
      fontStyle: textStyle.fontStyle,
      fontWeight: textStyle.fontWeight
    });

    return [

      // icon
      {
        type: 'text',
        style: api.style({
          text: icon,
          x: x + padding,
          y: y + titleTextMetrics.height,
          fontSize: 14,
          textVerticalAlign: 'middle'
        })
      },
      // title
      {
        type: 'text',
        style: api.style({
          text: title,
          x: x + 30,
          y: y + 14,
          width: width - 30 - padding,
          overflow: 'truncate',
          fontSize: 11,
          fontWeight: 'bold',
          textFill: '#fff',
          textVerticalAlign: 'middle'
        })
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
        // CRITICAL FOR PAN/ZOOM: Clip the element to the current coordinate system
        clip: ctx.clip,
        style: {
          stroke: 'rgba(255,255,255,0.08)',
          lineWidth: 1
        }
      }
    ];
  }

  createBadgeSection(ctx) {
    const {
      textStyle,
      api,
      width,
      height,
      x,
      y,
      padding
    } = ctx;

    const badges = [];
    if (ctx.exec?.stateChanges?.length > 0) {
      badges.push({
        text: 'Changed',
        bg: '#794112',
        fg: '#c7b9a4'
      });
    }

    if (ctx.hasBp) {
      badges.push({
        text: '⏸ BP',
        bg: '#9b1b1b',
        fg: '#dac8c8'
      });
    }

    const children = [];

    let badgeY;
    let badgeHeight;
    let badgeX = x + width;
    for (const badge of badges) {
      const textMetrics = this.getTextWidth(badge.text, {
        fontFamily: textStyle.fontFamily,
        fontSize: 8,
        fontStyle: textStyle.fontStyle,
        fontWeight: textStyle.fontWeight
      });
      const badgeWidth = textMetrics.width + 12;
      //Set badge height on first pass
      if(typeof badgeHeight === 'undefined') {
        badgeHeight = textMetrics.height + 4;
      }
      badgeX = badgeX - (badgeWidth + padding);
      //Set Y on first pass
      if(typeof badgeY === 'undefined') {
        badgeY = y + height - (padding + badgeHeight);
      }
      children.push({
        type: 'rect',
        shape: {
          x: badgeX,
          y: badgeY,
          width: badgeWidth,
          height: badgeHeight,
          r: 4
        },
        // CRITICAL FOR PAN/ZOOM: Clip the element to the current coordinate system
        clip: ctx.clip,
        style: api.style({
          fill: badge.bg
        })
      });

      children.push({
        type: 'text',
        style: api.style({
          text: badge.text,
          x: badgeX + badgeWidth / 2,
          y: badgeY + badgeHeight / 2,
          textAlign: 'center',
          textVerticalAlign: 'middle',
          fontSize: 8,
          fontWeight: 'bold',
          textFill: badge.fg
        })
      });
    }
    return children;
  }

  createFooterSection(ctx) {

    const {
      textStyle,
      api,
      height,
      x,
      y,
      padding
    } = ctx;

    const isActive = !!ctx.exec?.fired;
    const activeText = isActive
        ? 'active'
        : 'idle';
    const textMetrics = this.getTextWidth(activeText, {
      fontFamily: textStyle.fontFamily,
      fontSize: 9,
      fontStyle: textStyle.fontStyle,
      fontWeight: textStyle.fontWeight
    });

    return [
      // activity dot
      {
        type: 'circle',
        shape: {
          cx: x + padding + 4,
          cy: y + height - (padding + textMetrics.height),
          r: 4
        },
        // CRITICAL FOR PAN/ZOOM: Clip the element to the current coordinate system
        clip: ctx.clip,
        style: api.style({
          fill: isActive
              ? '#22c55e'
              : '#777',
          shadowBlur: isActive ? 8 : 0,
          shadowColor: '#22c55e'
        })
      },

      // activity label
      {
        type: 'text',
        style: api.style({
          text: activeText,

          x: x + padding + 14,
          y: y + height - (padding + textMetrics.height),
          fontSize: 9,
          textFill: '#aaa',
          textVerticalAlign: 'middle'
        })
      }
    ];
  }

  createReducerMetrics(ctx, {
    mutationCount
  }) {

    const {
      textStyle,
      api,
      width,
      height,
      x,
      y,
      padding
    } = ctx;

    const metricsText =  `State Changes: ${mutationCount}`;
    const metrics = this.getTextWidth(metricsText, {
      fontFamily: textStyle.fontFamily,
      fontSize: 9,
      fontStyle: textStyle.fontStyle,
      fontWeight: textStyle.fontWeight
    });

    return [
      {
        type: 'text',
        style: api.style({
          text: metricsText,
          x: x + width - (padding + metrics.width),
          y: y + height - (padding + metrics.height),
          fontSize: 9,
          textFill: '9ecbff'
        })
      }
    ];
  }

  createEventMetrics(ctx, {
    emitted
  }) {

    const {
      textStyle,
      api,
      width,
      height,
      x,
      y,
      padding
    } = ctx;

    const metricsText = emitted
        ? 'Event emitted'
        : 'Awaiting emission';
    const metrics = this.getTextWidth(metricsText, {
      fontFamily: textStyle.fontFamily,
      fontSize: 9,
      fontStyle: textStyle.fontStyle,
      fontWeight: textStyle.fontWeight
    });

    return [
      {
        type: 'text',
        style: api.style({
          text: metricsText,
          x: x + width - (padding + metrics.width),
          y: y + height - (padding + metrics.height),
          fontSize: 9,
          textFill: emitted
              ? '#7ee787'
              : '#999'
        })
      }
    ];
  }

  createActionMetrics(ctx, {
    payloadSize
  }) {

    const {
      textStyle,
      api,
      width,
      height,
      x,
      y,
      padding
    } = ctx;

    const metricsText = `Payload: ${payloadSize} bytes`;
    const metrics = this.getTextWidth(metricsText, {
      fontFamily: textStyle.fontFamily,
      fontSize: 9,
      fontStyle: textStyle.fontStyle,
      fontWeight: textStyle.fontWeight
    });

    return [
      {
        type: 'text',
        style: api.style({
          text: metricsText,
          x: x + width -( padding + metrics.width),
          y: y + height - (padding + metrics.height),
          fontSize: 9,
          textFill: '9ecbff'
        })
      }
    ];
  }

  createHandlerMetrics(ctx, {
    durationMs
  }) {

    const {
      textStyle,
      api,
      width,
      height,
      x,
      y,
      padding
    } = ctx;

    const slow =
        durationMs > 5;

    const metricsText = `Exec: ${durationMs} ms`;
    const metrics = this.getTextWidth(metricsText, {
      fontFamily: textStyle.fontFamily,
      fontSize: 9,
      fontStyle: textStyle.fontStyle,
      fontWeight: textStyle.fontWeight
    });

    return [
      {
        type: 'text',
        style: api.style({
          text: metricsText,
          x: x + width -( padding + metrics.width),
          y: y + height - (padding + metrics.height),
          fontSize: 9,
          textFill: slow
              ? '#ffb86b'
              : '#8be9fd'
        })
      }
    ];
  }

  /**
   * Measures the width and height of text based on font properties.
   * @param {string} text - The string to measure.
   * @param {Object} options - Font style options.
   * @returns {Object} { width, height }
   */
  getTextWidth(text, options) {
    const { fontFamily, fontSize, fontStyle, fontWeight } = options;

    if (!this._context) {
      // Fallback when canvas 2D context is unavailable (e.g. jsdom in tests).
      const size = typeof fontSize === 'number' ? fontSize : parseFloat(fontSize) || 12;
      return { width: size * 0.6 * text.length, height: size };
    }

    // Order is important for the browser to parse it correctly.
    this._context.font = `${fontStyle || 'normal'} ${fontWeight || 'normal'} ${fontSize} ${fontFamily}`;

    const metrics = this._context.measureText(text);
    return {
      width: metrics.width,
      height: metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent
    };
  }
}
