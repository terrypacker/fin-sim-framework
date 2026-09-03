import { hostPanePlugin } from './host-pane-plugin.js';

/**
 * Displays the `#timelineContainer` host; the runtime owns it. See `hostPanePlugin`.
 *
 * `wb-pane-host` rather than the default `wb-plugin-fill`: the timeline manages its own
 * overflow, and a wrapper with `overflow-y: auto` would give it a second scrollbar.
 */
export const TimelinePlugin = hostPanePlugin('timelineContainer', {
  outerClass: 'wb-pane-host',
  innerClass: 'tl-container',
});
