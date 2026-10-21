import { api, Friend } from '../net/api';
import type { RoomClient } from '../net/roomClient';
import { h } from './dom';
import { avatarEl, nameLine } from './people';
import { presenceLabel } from './presence';

/** Hosts invite friends to the room they're in (the friend icon, bottom right). */
export class InvitePanel {
  readonly el = h('div.panel.invite-panel');
  private invited = new Set<string>();

  async render(room: RoomClient) {
    let friends: Friend[] = [];
    try { friends = (await api.friends()).friends; } catch { /* shown as empty */ }
    const inRoom = new Set(room.members.map((m) => m.id));
    const rows = friends.map((f) => {
      const here = inRoom.has(f.id), sent = this.invited.has(f.id + room.id);
      const btn = h('button.btn.small', { type: 'button', disabled: here || sent }, here ? 'Here' : sent ? 'Invited' : 'Invite');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try { await api.invite(room.id, f.id); this.invited.add(f.id + room.id); btn.textContent = 'Invited'; }
        catch (e) { btn.disabled = false; btn.textContent = (e as Error).message; }
      });
      return h(`div.invite-row.${f.presence}` as 'div', {},
        h('span.presence-wrap', {}, avatarEl(f, 32), h('i.presence-dot')),
        h('div.invite-text', {}, nameLine(f), h('small.muted', {}, presenceLabel(f.presence))),
        btn);
    });
    this.el.replaceChildren(
      h('div.panel-title', {}, 'Invite friends'),
      rows.length ? h('div.invite-list', {}, ...rows) : h('p.muted.invite-empty', {}, 'No friends yet'),
    );
  }
}
