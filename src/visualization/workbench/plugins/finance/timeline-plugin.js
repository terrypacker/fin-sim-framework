import { WorkbenchComponent } from '../../component.js';

export class TimelinePlugin extends WorkbenchComponent {
  constructor(_runtime) { super(); }
  render() {
    const el = document.createElement('div');
    el.id = 'timelineContainer';
    el.className = 'tl-container';
    return el;
  }
}
