import { hostPanePlugin } from './host-pane-plugin.js';

/** Displays the `#mcConfigPane` host; the runtime owns it. See `hostPanePlugin`. */
export const McConfigPlugin = hostPanePlugin('mcConfigPane', { innerClass: '' });
