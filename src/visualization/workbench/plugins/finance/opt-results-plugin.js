import { hostPanePlugin } from './host-pane-plugin.js';

/** Displays the `#optResultsPane` host; the runtime owns it. See `hostPanePlugin`. */
export const OptResultsPlugin = hostPanePlugin('optResultsPane', { innerClass: '' });
