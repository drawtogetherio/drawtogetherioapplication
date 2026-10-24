import { api } from '../net/api';
import type { PublicProfile } from '../shared/profile';
import type { Editor } from '../editor';
import { confirmDialog, modal } from './dialogs';
import { clear, h } from './dom';
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

/** Everyone you blocked, with a way back. */
export async function blockedDialog(ed: Editor) {
  const list = h('div.blocked-list');
  const render = (people: PublicProfile[]) => {
    clear(list);
    if (!people.length) list.append(h('p.muted', {}, 'No one is blocked.'));
    for (const p of people) {
      list.append(h('div.blocked-row', {}, avatarEl(p, 32), h('div.grow', {}, nameLine(p), h('small.muted', {}, '@' + p.handle)),
        h('button.btn.small', { type: 'button', onclick: async () => { await unblockPerson(ed, p.id); render(await api.blocks().catch(() => [])); } }, 'Unblock')));
    }
  };
  render(await api.blocks().catch(() => []));
  modal('Blocked people', h('div.modal-body', {}, list), []);
}
