import { native } from '../io/native';
import { h } from './dom';
import { icon } from './icons';

/** Desktop app without a system title bar: the bar drags the window and, on Windows, holds the buttons. */
export function frameBar(bar: HTMLElement, slot = bar) {
  if (!native?.frameless) return bar;
  bar.classList.add(native.platform === 'mac' ? 'mac-inset' : 'drag');
  const win = native.window;
  if (!win) return bar;
  const b = (name: string, title: string, fn: () => void, cls = '') =>
    h(`button.icon-btn.win-btn${cls}` as 'button', { title, 'aria-label': title, html: icon(name), onclick: fn });
  slot.append(h('span.win-controls', {},
    b('winMin', 'Minimize', () => win.minimize()),
    b('winMax', 'Maximize', () => win.maximize()),
    b('winClose', 'Close', () => win.close(), '.win-close')));
  return bar;
}
