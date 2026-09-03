import { hostPanePlugin } from './host-pane-plugin.js';

/** Displays the `#actionPanelDetails` host; the runtime owns it. See `hostPanePlugin`. */
export const ActionDetailPlugin = hostPanePlugin('actionPanelDetails', { innerClass: 'actionPanelDetails wb-plugin-fill' });
