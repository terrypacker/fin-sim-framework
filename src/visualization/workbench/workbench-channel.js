/** Control message types for the workbench BroadcastChannel. */
export const WB_PANEL = {
  CLOSING: 'wb.panel.closing',
};

/**
 * WorkbenchChannel — bridges a WorkbenchBus across browser windows using BroadcastChannel.
 *
 * Usage (main window):
 *   const ch = new WorkbenchChannel('my-app');
 *   ch.attachBus(runtime.bus, [WB_EVENTS.SELECTION_CHANGED, WB_EVENTS.RUNTIME_TICK]);
 *   ch.onControl(msg => { if (msg.type === WB_PANEL.CLOSING) reattach(msg); });
 *
 * Usage (panel window):
 *   const ch = new WorkbenchChannel('my-app');           // same name
 *   ch.attachBus(runtime.bus, [WB_EVENTS.SELECTION_CHANGED, WB_EVENTS.RUNTIME_TICK]);
 *   window.addEventListener('beforeunload', () => ch.post({ type: WB_PANEL.CLOSING, ... }));
 *
 * Bus events are tagged `_wbBus: true` to distinguish them from control messages.
 * The `_relaying` flag prevents within-window echo (BroadcastChannel already prevents
 * cross-window echo per spec, but the guard is retained for clarity).
 */
export class WorkbenchChannel {
  constructor(channelName = 'sim-workbench') {
    this._bc = new BroadcastChannel(channelName);
    this._bus = null;
    this._relaying = false;
    this._controlHandlers = [];

    this._bc.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg?._wbBus) {
        this._inboundBusEvent(msg._wbEvent);
      } else {
        this._controlHandlers.forEach(fn => fn(msg));
      }
    });
  }

  /**
   * Wire to a WorkbenchBus.
   * Outbound: specified event types are posted to the channel.
   * Inbound:  channel bus messages are published to the local bus.
   */
  attachBus(bus, eventTypes) {
    this._bus = bus;

    for (const type of eventTypes) {
      bus.subscribe(type, (msg) => {
        if (this._relaying) return;
        try {
          this._bc.postMessage({ _wbBus: true, _wbEvent: msg });
        } catch (e) {
          if (e instanceof DOMException && e.name === 'DataCloneError') {
            // Payload contains non-cloneable values (e.g. class instances with functions).
            // Forward a type-only signal so panel windows still see the event.
            this._bc.postMessage({ _wbBus: true, _wbEvent: { type: msg.type } });
          } else {
            throw e;
          }
        }
      });
    }

    return this;
  }

  /** Post a non-bus control message to other windows. */
  post(msg) {
    this._bc.postMessage(msg);
  }

  /**
   * Register a handler for non-bus control messages.
   * Returns an unsubscribe function.
   */
  onControl(fn) {
    this._controlHandlers.push(fn);
    return () => {
      this._controlHandlers = this._controlHandlers.filter(h => h !== fn);
    };
  }

  close() {
    this._bc.close();
  }

  _inboundBusEvent(event) {
    if (!this._bus || this._relaying) return;
    this._relaying = true;
    try {
      this._bus.publish(event);
    } finally {
      this._relaying = false;
    }
  }
}
