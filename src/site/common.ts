import type { MyProfile } from '../shared/profile';

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Header chip for someone already logged in: their picture, name and a button into the app. */
export function headerUser(me: MyProfile): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'header-user';
  const pic = me.avatar
    ? `<img src="${esc(me.avatar)}" alt="">`
    : `<span class="initial" style="background:${esc(me.favoriteColor)}">${esc([...me.displayName][0] ?? '?')}</span>`;
  wrap.innerHTML = `${pic}<span class="name">${esc(me.displayName)}</span><a class="btn small primary" href="/app">Open app</a>`;
  return wrap;
}

/** Only allow going back to a page on this site after login. */
export function safeNext(next: string | null): string {
  return next && /^\/(?![/\\])/.test(next) ? next : '/app';
}
