import { hostPanePlugin } from './host-pane-plugin.js';

/** Displays the `#graphNodeHistoryPane` host; the runtime owns it. See `hostPanePlugin`. */
export const ExecHistoryPlugin = hostPanePlugin('graphNodeHistoryPane');
