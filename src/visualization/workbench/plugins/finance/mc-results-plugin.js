import { hostPanePlugin } from './host-pane-plugin.js';

/** Displays the `#mcResultsPane` host; the runtime owns it. See `hostPanePlugin`. */
export const McResultsPlugin = hostPanePlugin('mcResultsPane', { innerClass: '' });
