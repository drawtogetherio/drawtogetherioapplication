import { DEFAULT_SHARE, ShareSettings, Visibility } from '../shared/protocol';
import { modal } from './dialogs';
import { h } from './dom';
import { icon } from './icons';

const CHOICES: { id: Exclude<Visibility, 'private'>; label: string; note?: string; icon: string }[] = [
  { id: 'open', label: 'Open link', note: 'Anyone with the link', icon: 'link' },
  { id: 'friends', label: 'Friends only', icon: 'users' },
  { id: 'unlisted', label: 'Unlisted', note: 'Hidden from friends lists', icon: 'eye' },
];

/** Who can join: the three ways to share, plus the extra switches for open links. */
export function shareFields(initial: ShareSettings) {
  const s: ShareSettings = { ...DEFAULT_SHARE, ...initial, visibility: initial.visibility === 'private' ? 'open' : initial.visibility };
  const toggle = (key: 'requireLogin' | 'friendsCanJoin' | 'approveJoins', label: string) => {
    const box = h('input', { type: 'checkbox', id: 'share-' + key, role: 'switch' });
    box.checked = s[key];
    box.addEventListener('change', () => { s[key] = box.checked; });
    return h('label.switch-row', {}, h('span', {}, label), box);
  };
  const options = h('div.share-options', {},
    toggle('requireLogin', 'Logged-in users only'),
    toggle('friendsCanJoin', 'Friends can join from their list'),
    toggle('approveJoins', 'Approve each join'),
  );
  const cards = CHOICES.map((c) => h('button.share-choice', {
    type: 'button', 'data-v': c.id, role: 'radio',
    html: `${icon(c.icon, 20)}<strong>${c.label}</strong>${c.note ? `<small>${c.note}</small>` : ''}`,
    onclick: () => { s.visibility = c.id; render(); },
  }));
  const render = () => {
    for (const b of cards) {
      const on = b.dataset.v === s.visibility;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    }
    options.hidden = s.visibility !== 'open';
  };
  render();
  const el = h('div.share-fields', {}, h('div.share-choices', { role: 'radiogroup', 'aria-label': 'Who can join' }, ...cards), options);
  return { el, value: (): ShareSettings => ({ ...s }) };
}

/** Pick how to share a canvas. Resolves with the settings, or null if cancelled. */
export function shareDialog(current: ShareSettings, alreadyShared: boolean): Promise<ShareSettings | null> {
  return new Promise((resolve) => {
    let result: ShareSettings | null = null;
    const f = shareFields(current);
    const ok = h('button.btn.primary', { type: 'button' }, alreadyShared ? 'Save' : 'Share');
    const close = modal(alreadyShared ? 'Sharing' : 'Share canvas', h('div.modal-body', {}, f.el), [ok], () => resolve(result));
    ok.addEventListener('click', () => { result = f.value(); close(); });
  });
}
