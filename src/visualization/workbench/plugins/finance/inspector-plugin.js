import { hostPanePlugin } from './host-pane-plugin.js';

/** Displays the `#graphNodeEditPane` host; the runtime owns it. See `hostPanePlugin`. */
export const InspectorPlugin = hostPanePlugin('graphNodeEditPane');
