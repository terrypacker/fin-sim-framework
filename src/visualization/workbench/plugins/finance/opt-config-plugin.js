import { hostPanePlugin } from './host-pane-plugin.js';

/** Displays the `#optConfigPane` host; the runtime owns it. See `hostPanePlugin`. */
export const OptConfigPlugin = hostPanePlugin('optConfigPane', { innerClass: '' });
