/**
 * SplitPane — renders a resizable multi-pane split container.
 *
 * Supports two directions:
 *   'horizontal' (default) — panes side by side; sizes are flex fractions
 *   'vertical'             — panes stacked; first pane is flex:1, last pane
 *                            has a fixed px height driven by layout.getBottomSize()
 *
 * @param {object}               opts
 * @param {WorkbenchLayoutModel} opts.layout     — for size persistence
 * @param {string[]}             opts.panes      — ordered pane names
 * @param {'horizontal'|'vertical'} [opts.direction='horizontal']
 */
export class SplitPane {
  constructor({ layout, panes, direction = 'horizontal' }) {
    this.layout    = layout;
    this.panes     = panes;
    this.direction = direction;
    this.el        = null;
    this._paneEls  = new Map();
  }

  mount(container) {
    this.el = document.createElement('div');
    this.el.className = 'wb-split' + (this.direction === 'vertical' ? ' wb-split--v' : '');

    if (this.direction === 'vertical') {
      this._mountVertical();
    } else {
      this._mountHorizontal();
    }

    container.appendChild(this.el);
  }

  unmount() {
    this.el?.remove();
    this.el = null;
    this._paneEls.clear();
  }

  /** @returns {HTMLElement | undefined} */
  getPaneEl(name) {
    return this._paneEls.get(name);
  }

  // ── Horizontal ──────────────────────────────────────────────────────────────

  _mountHorizontal() {
    const sizes = this.layout.getSizes();
    this.panes.forEach((name, i) => {
      const paneEl = document.createElement('div');
      paneEl.className = 'wb-pane';
      paneEl.dataset.pane = name;
      paneEl.style.flex = sizes[i] ?? 1;
      this._paneEls.set(name, paneEl);
      this.el.appendChild(paneEl);

      if (i < this.panes.length - 1) {
        this.el.appendChild(this._buildGutterH(i));
      }
    });
  }

  _buildGutterH(leftIndex) {
    const gutter = document.createElement('div');
    gutter.className = 'wb-gutter';

    let dragStartX = 0, leftFlex = 0, rightFlex = 0, totalFlex = 0;
    const leftPaneName  = this.panes[leftIndex];
    const rightPaneName = this.panes[leftIndex + 1];

    gutter.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const leftEl  = this._paneEls.get(leftPaneName);
      const rightEl = this._paneEls.get(rightPaneName);

      dragStartX = e.clientX;
      leftFlex   = parseFloat(leftEl.style.flex)  || 1;
      rightFlex  = parseFloat(rightEl.style.flex) || 1;
      totalFlex  = leftFlex + rightFlex;

      const splitWidth = this.el.clientWidth;

      const onMove = (ev) => {
        const delta     = ev.clientX - dragStartX;
        const deltaFlex = (delta / splitWidth) * totalFlex;
        leftEl.style.flex  = Math.max(0.05 * totalFlex, leftFlex  + deltaFlex);
        rightEl.style.flex = Math.max(0.05 * totalFlex, rightFlex - deltaFlex);
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        this._persistHSizes();
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    return gutter;
  }

  _persistHSizes() {
    const sizes = this.panes.map(name => parseFloat(this._paneEls.get(name)?.style.flex ?? 1));
    this.layout.setSizes(sizes);
    this.layout.save();
  }

  // ── Vertical ────────────────────────────────────────────────────────────────

  _mountVertical() {
    const bottomH = this.layout.getBottomSize();

    this.panes.forEach((name, i) => {
      const paneEl = document.createElement('div');
      paneEl.className = 'wb-pane';
      paneEl.dataset.pane = name;

      if (i === 0) {
        // Top pane fills all remaining space
        paneEl.style.flex = '1';
        paneEl.style.minHeight = '0';
      } else {
        // Bottom pane: fixed height (flex: none)
        paneEl.style.flex   = 'none';
        paneEl.style.height = bottomH + 'px';
      }

      this._paneEls.set(name, paneEl);
      this.el.appendChild(paneEl);

      if (i < this.panes.length - 1) {
        this.el.appendChild(this._buildGutterV(i));
      }
    });
  }

  _buildGutterV(topIndex) {
    const gutter = document.createElement('div');
    gutter.className = 'wb-gutter wb-gutter--v';
    const bottomPaneName = this.panes[topIndex + 1];

    gutter.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const bottomEl = this._paneEls.get(bottomPaneName);
      const startY   = e.clientY;
      const startH   = bottomEl.offsetHeight;

      const onMove = (ev) => {
        const delta = startY - ev.clientY;  // drag up → taller bottom pane
        bottomEl.style.height = Math.max(60, startH + delta) + 'px';
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        const h = parseFloat(this._paneEls.get(bottomPaneName).style.height);
        this.layout.setBottomSize(h);
        this.layout.save();
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    return gutter;
  }
}
