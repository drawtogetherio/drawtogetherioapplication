import { FriendsList, api } from '../net/api';
import type { PublicProfile } from '../shared/profile';
import type { Editor } from '../editor';
import { confirmDialog, modal } from './dialogs';
import { h } from './dom';
import { avatarEl, nameLine } from './people';

/** Keeps `me.blocked` in step with the server's list. */
function setBlocked(ed: Editor, list: PublicProfile[]) {
  if (ed.me) ed.me.blocked = list.map((p) => p.id);
  ed.emit('blocked');
}

export async function blockPerson(ed: Editor, p: PublicProfile): Promise<boolean> {
  if (!(await confirmDialog(`Block ${p.displayName}?`, 'You won’t see them in chat or rooms, and they can’t join rooms you host.', 'Block'))) return false;
  try { setBlocked(ed, await api.block(p.id)); } catch (e) { ed.toast((e as Error).message); return false; }
  return true;
}

export async function unblockPerson(ed: Editor, id: string) {
  try { setBlocked(ed, await api.unblock(id)); } catch (e) { ed.toast((e as Error).message); }
}

export type PeopleTab = 'outgoing' | 'blocked';

/** Friend requests you sent and everyone you blocked, as two tabs of one window. `onFriends` hears the
 *  friends list after a request is cancelled, so whatever shows it can catch up. */
export async function peopleDialog(ed: Editor, tab: PeopleTab, onFriends?: (f: FriendsList) => void) {
  const list = h('div.blocked-list');
  const tabs = h('div.segmented.people-tabs', { role: 'tablist' });
  const row = (p: PublicProfile, label: string, act: () => Promise<void>) =>
    h('div.blocked-row', {}, avatarEl(p, 32), h('div.grow', {}, nameLine(p), h('small.muted', {}, '@' + p.handle)),
      h('button.btn.small', { type: 'button', onclick: async () => { await act(); render(); } }, label));
  const render = async () => {
    for (const b of tabs.children) {
      const on = (b as HTMLElement).dataset.tab === tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    }
    const shown = tab;
    const rows: HTMLElement[] = [];
    if (tab === 'outgoing') {
      const f = await api.friends().catch(() => null);
      if (f) onFriends?.(f);
      const out = f?.outgoing ?? [];
      if (!out.length) rows.push(h('p.muted', {}, 'No requests waiting.'));
      for (const p of out) rows.push(row(p, 'Cancel', async () => {
        try { onFriends?.(await api.removeFriend(p.id)); } catch (e) { ed.toast((e as Error).message); }
      }));
    } else {
      const people = await api.blocks().catch(() => []);
      if (!people.length) rows.push(h('p.muted', {}, 'No one is blocked.'));
      for (const p of people) rows.push(row(p, 'Unblock', () => unblockPerson(ed, p.id)));
    }
    if (shown === tab) list.replaceChildren(...rows);
  };
  const tabBtn = (t: PeopleTab, label: string) =>
    h('button', { type: 'button', role: 'tab', 'data-tab': t, onclick: () => { if (tab !== t) { tab = t; render(); } } }, label);
  tabs.append(tabBtn('outgoing', 'Outgoing requests'), tabBtn('blocked', 'Blocked'));
  await render();
  modal('Manage people', h('div.modal-body', {}, tabs, list), []);
  list.closest('.modal')?.classList.add('people-modal');
}
