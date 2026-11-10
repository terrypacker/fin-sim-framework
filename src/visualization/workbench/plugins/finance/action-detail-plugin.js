import { hostPanePlugin } from './host-pane-plugin.js';

/** Displays the `#actionPanelDetails` host; the runtime owns it. See `hostPanePlugin`. */
export const ACTION_DETAIL_HOST = { innerClass: 'actionPanelDetails wb-plugin-fill' };
export const ActionDetailPlugin = hostPanePlugin('actionPanelDetails', ACTION_DETAIL_HOST);
