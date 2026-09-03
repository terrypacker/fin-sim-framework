import { hostPanePlugin } from './host-pane-plugin.js';

/** Displays the `#mcRunsPane` host; the runtime owns it. See `hostPanePlugin`. */
export const McRunsPlugin = hostPanePlugin('mcRunsPane', { innerClass: '' });
