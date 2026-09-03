import { hostPanePlugin } from './host-pane-plugin.js';

/** Displays the `#optRunsPane` host; the runtime owns it. See `hostPanePlugin`. */
export const OptRunsPlugin = hostPanePlugin('optRunsPane', { innerClass: '' });
