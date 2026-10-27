import './site.css';
import { ApiError, api } from '../net/api';
import { BADGES, type Badge, type PublicProfile } from '../shared/profile';
import { NOTICE_MAX, type SiteSettings } from '../shared/site';
import { initTheme } from '../ui/theme';
import { brandHtml } from './brand';
import { ART_NAMES, art } from '../ui/art';
import { icon } from '../ui/icons';
import { renderMarkdown } from '../ui/markdown';
import { esc } from './common';

// Admin dashboard (/admin). The server only answers these routes for admins.

initTheme();

interface AdminUser extends PublicProfile {
  provider: string; admin: boolean; banned: boolean; createdAt: number; hasPremium: boolean; online: boolean; ip: string | null; rooms: number;
}
interface Stats {
  online: number; drawing: number; liveRooms: { id: string; name: string; owner: string; people: number }[];
  users: { total: number; guests: number; premium: number; today: number; banned: number };
  rooms: number; ipBans: number; counters: Record<string, number>;
}
interface IpBan { ip: string; reason: string; createdAt: number }
interface LogRow { action: string; target: string; at: number; admin: string | null }

const SECTIONS = ['Overview', 'Site', 'What’s new', 'Users', 'IP bans', 'Log'] as const;
type Section = (typeof SECTIONS)[number];

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, (data as { error?: string }).error ?? 'Something went wrong. Try again.');
  return data as T;
}
const fmt = new Intl.NumberFormat();
const n = (v: number) => fmt.format(v);
const when = (t: number) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const day = (t: number) => new Date(t).toLocaleDateString([], { dateStyle: 'medium' });
const hours = (ms: number) => { const h = Math.floor(ms / 36e5); return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`; };

const root = document.getElementById('site')!;
let page: HTMLElement, toast: HTMLElement;
let timer = 0;

function say(msg: string, bad = false) {
  toast.textContent = msg;
  toast.className = 'admin-toast show' + (bad ? ' bad' : '');
  setTimeout(() => toast.classList.remove('show'), 2500);
}
const failing = (e: unknown) => say((e as Error).message, true);

// ---- Overview ----
// A section switch while a fetch is in flight must not let the old page draw over the new one.
const stale = (s: Section) => page.dataset.section !== s;

async function overview() {
  const s = await call<Stats>('GET', '/api/admin/stats');
  if (stale('Overview')) return;
  const c = s.counters;
  const tile = (v: number, label: string, cls = '') => `<div class="stat-tile ${cls}"><b>${n(v)}</b><span>${label}</span></div>`;
  page.innerHTML = `
    <h2>Right now</h2>
    <div class="stat-grid">${tile(s.online, 'Online', 'hot')}${tile(s.drawing, 'In rooms', 'hot')}${tile(s.liveRooms.length, 'Live rooms', 'hot')}</div>
    <h2>Accounts</h2>
    <div class="stat-grid">${tile(s.users.total, 'Accounts')}${tile(s.users.premium, 'Premium')}${tile(s.users.today, 'New today')}${tile(s.users.guests, 'Guests')}${tile(s.users.banned, 'Banned')}${tile(s.ipBans, 'IP bans')}${tile(s.rooms, 'Canvases')}</div>
    <h2>Drawn in rooms</h2>
    <div class="stat-grid">${tile(c.strokes, 'Strokes')}${tile(c.smudges, 'Smudges')}${tile(c.fills, 'Fills')}${tile(c.shapes, 'Shapes')}${tile(c.undos, 'Undos')}${tile(c.redos, 'Redos')}${tile(c.messages, 'Chat messages')}${tile(c.ops, 'All edits')}</div>
    <p class="fine">Server up ${hours(c.uptime)}. Counts cover shared rooms, not offline drawing. Guests are removed a few hours after they leave. <button class="link" id="sweep">Sweep now</button></p>
    <h2>Live rooms</h2>
    ${s.liveRooms.length ? `<table class="admin-table"><tr><th>Room</th><th>Owner</th><th>People</th></tr>
      ${s.liveRooms.map((r) => `<tr><td><a href="/app?room=${esc(r.id)}">${esc(r.name)}</a></td><td>@${esc(r.owner)}</td><td>${r.people}</td></tr>`).join('')}</table>` : '<p class="fine">Nobody is drawing together right now.</p>'}`;
  page.querySelector('#sweep')!.addEventListener('click', async () => {
    try { const r = await call<{ guests: number }>('POST', '/api/admin/sweep'); say(`Removed ${r.guests} guest${r.guests === 1 ? '' : 's'}`); } catch (e) { failing(e); }
  });
  timer = window.setTimeout(() => { if (page.dataset.section === 'Overview') overview().catch(failing); }, 5000);
}

// ---- Users ----
let users: AdminUser[] = [];
let query = '', filter = '';

async function usersPage() {
  page.innerHTML = `
    <div class="admin-tools">
      <input id="q" type="search" placeholder="Search name or @handle" value="${esc(query)}" autocomplete="off">
      <select id="filter">${[['', 'Everyone'], ['premium', 'Premium'], ['admin', 'Admins'], ['banned', 'Banned'], ['guests', 'Guests']].map(([v, l]) => `<option value="${v}"${v === filter ? ' selected' : ''}>${l}</option>`).join('')}</select>
    </div>
    <div id="user-list"></div>
    <aside id="drawer" class="drawer" hidden></aside>`;
  const q = page.querySelector('#q') as HTMLInputElement, f = page.querySelector('#filter') as HTMLSelectElement;
  let t = 0;
  q.addEventListener('input', () => { clearTimeout(t); t = window.setTimeout(() => { query = q.value; loadUsers(); }, 250); });
  f.addEventListener('change', () => { filter = f.value; loadUsers(); });
  await loadUsers();
}

async function loadUsers() {
  users = await call<AdminUser[]>('GET', `/api/admin/users?q=${encodeURIComponent(query)}&filter=${filter}`);
  const list = page.querySelector('#user-list');
  if (!list) return;
  if (!users.length) { list.innerHTML = '<p class="fine">Nobody matches.</p>'; return; }
  const flags = (u: AdminUser) => [u.admin && '<i class="flag admin">admin</i>', u.banned && '<i class="flag banned">banned</i>', u.online && '<i class="flag online">online</i>'].filter(Boolean).join('');
  const premium = (u: AdminUser) => (!u.hasPremium ? '—' : u.premiumUntil ? (u.premium ? 'until ' + day(u.premiumUntil) : 'expired') : 'forever');
  list.innerHTML = `<table class="admin-table"><tr><th>Person</th><th>Login</th><th>Premium</th><th>Badges</th><th>Joined</th><th>Address</th><th></th></tr>
    ${users.map((u) => `<tr data-id="${esc(u.id)}">
      <td><div class="who"><span class="dot" style="background:${esc(u.favoriteColor)}"></span><div><b>${esc(u.displayName)}</b> ${flags(u)}<br><small>@${esc(u.handle)}</small></div></div></td>
      <td>${esc(u.provider)}</td><td>${premium(u)}</td><td>${u.badges.map((b) => BADGES[b]).join(', ') || '—'}</td>
      <td>${day(u.createdAt)}</td><td class="mono">${u.ip ? esc(u.ip) : '—'}</td>
      <td><button class="btn small" data-manage="${esc(u.id)}">Manage</button></td></tr>`).join('')}</table>`;
  for (const b of list.querySelectorAll<HTMLElement>('[data-manage]')) b.addEventListener('click', () => drawer(b.dataset.manage!));
}

function drawer(id: string) {
  const u = users.find((x) => x.id === id);
  const el = page.querySelector('#drawer') as HTMLElement | null;
  if (!el) return;
  if (!u) { el.hidden = true; return; }
  const patch = async (body: Record<string, unknown>, done = 'Saved') => {
    try {
      const fresh = await call<AdminUser>('PATCH', '/api/admin/users/' + id, body);
      users = users.map((x) => (x.id === id ? fresh : x));
      say(done);
      await loadUsers();
      drawer(id);
    } catch (e) { failing(e); }
  };
  el.hidden = false;
  el.innerHTML = `
    <div class="drawer-head"><div><b>${esc(u.displayName)}</b><br><small>@${esc(u.handle)} · ${esc(u.provider)}${u.rooms ? ` · ${u.rooms} canvases` : ''}</small></div><button class="icon-x" aria-label="Close">×</button></div>
    <h3>Premium</h3>
    <div class="row"><button class="btn small" data-premium="30">30 days</button><button class="btn small" data-premium="365">1 year</button><button class="btn small" data-premium="forever">Forever</button><button class="btn small" data-premium="off">Off</button></div>
    <h3>Badges</h3>
    <div class="row wrap">${(Object.keys(BADGES) as Badge[]).map((b) => `<label class="check"><input type="checkbox" data-badge="${b}"${u.badges.includes(b) ? ' checked' : ''}> ${BADGES[b]}</label>`).join('')}</div>
    <h3>Account</h3>
    <div class="row wrap">
      <button class="btn small" data-act="clearStatus">Clear status</button>
      <button class="btn small" data-act="removeAvatar">Remove avatar</button>
      <button class="btn small" data-act="signOut">Sign out everywhere</button>
      ${u.provider === 'guest' ? '' : `<button class="btn small" data-admin="${u.admin ? 0 : 1}">${u.admin ? 'Remove admin' : 'Make admin'}</button>`}
    </div>
    <h3>Bans</h3>
    <div class="row wrap">
      <button class="btn small ${u.banned ? '' : 'danger'}" data-ban="${u.banned ? 0 : 1}">${u.banned ? 'Unban account' : 'Ban account'}</button>
      ${u.ip ? `<button class="btn small danger" data-banip="${esc(u.ip)}">Ban address ${esc(u.ip)}</button>` : ''}
      <button class="btn small danger" data-delete>Delete account</button>
    </div>`;
  el.querySelector('.icon-x')!.addEventListener('click', () => { el.hidden = true; });
  for (const b of el.querySelectorAll<HTMLElement>('[data-premium]')) b.addEventListener('click', () => { const v = b.dataset.premium!; patch({ premium: /^\d+$/.test(v) ? Number(v) : v }); });
  for (const c of el.querySelectorAll<HTMLInputElement>('[data-badge]')) c.addEventListener('change', () => patch({ badges: [...el.querySelectorAll<HTMLInputElement>('[data-badge]:checked')].map((x) => x.dataset.badge) }));
  for (const b of el.querySelectorAll<HTMLElement>('[data-act]')) b.addEventListener('click', () => patch({ [b.dataset.act!]: true }, 'Done'));
  el.querySelector<HTMLElement>('[data-admin]')?.addEventListener('click', (e) => patch({ admin: (e.currentTarget as HTMLElement).dataset.admin === '1' }));
  el.querySelector<HTMLElement>('[data-ban]')!.addEventListener('click', (e) => {
    const on = (e.currentTarget as HTMLElement).dataset.ban === '1';
    if (!on || confirm(`Ban @${u.handle}? They’ll be signed out and can’t log in.`)) patch({ banned: on }, on ? 'Banned' : 'Unbanned');
  });
  el.querySelector<HTMLElement>('[data-banip]')?.addEventListener('click', async (e) => {
    const ip = (e.currentTarget as HTMLElement).dataset.banip!;
    if (!confirm(`Ban ${ip}? Everyone from that address is blocked.`)) return;
    try { await call('POST', '/api/admin/ip-bans', { ip, reason: '@' + u.handle }); say('Address banned'); } catch (ex) { failing(ex); }
  });
  el.querySelector<HTMLElement>('[data-delete]')!.addEventListener('click', async () => {
    if (!confirm(`Delete @${u.handle} and their canvases? This can’t be undone.`)) return;
    try { await call('DELETE', '/api/admin/users/' + id); say('Account deleted'); el.hidden = true; await loadUsers(); } catch (ex) { failing(ex); }
  });
}

// ---- Site: signup badge and the home screen message ----
async function sitePage() {
  const [site, sync] = await Promise.all([call<SiteSettings>('GET', '/api/admin/site'), call<{ on: boolean; from: string | null; last: number | null; hours: number }>('GET', '/api/admin/sync')]);
  if (stale('Site')) return;
  const nt = site.notice;
  page.innerHTML = `${sync.on ? `
    <h2>Beta data</h2>
    <p class="fine">A copy of ${esc(sync.from!)}, refreshed every ${sync.hours} hours. Last copied ${sync.last ? when(sync.last) : 'never'}.
      Copying replaces everything on beta, including test rooms, and restarts it for a moment.</p>
    <button class="btn small" id="sync-now">Copy live data now</button>` : ''}
    <h2>New accounts</h2>
    <label class="site-row"><input type="checkbox" id="early-badge" ${site.earlyBadge ? 'checked' : ''}> Every new account gets the ${esc(BADGES.early)} badge</label>
    <h2>Home screen message</h2>
    <form class="site-form" id="notice-form">
      <input name="text" placeholder="What everyone sees at the top of the home screen" maxlength="${NOTICE_MAX}" value="${esc(nt.text)}" autocomplete="off">
      <div class="site-row"><label>Background <input type="color" name="bg" value="${nt.bg}"></label><label>Text <input type="color" name="fg" value="${nt.fg}"></label>
        <label><input type="checkbox" name="on" ${nt.on ? 'checked' : ''}> Show it</label></div>
      <p class="fine">Preview</p>
      <div class="notice-preview"><div class="site-notice"></div><div class="fake-home"><span></span><span></span></div></div>
      <button class="btn small primary" type="submit">Save</button>
    </form>`;
  page.querySelector('#sync-now')?.addEventListener('click', async () => {
    if (!confirm('Replace everything on beta with a fresh copy of live?')) return;
    try { await call('POST', '/api/admin/sync'); say('Copying… beta restarts, reload in a minute'); } catch (ex) { failing(ex); }
  });
  page.querySelector('#early-badge')!.addEventListener('change', async (e) => {
    try { await call('PATCH', '/api/admin/site', { earlyBadge: (e.target as HTMLInputElement).checked }); say('Saved'); } catch (ex) { failing(ex); }
  });
  const form = page.querySelector<HTMLFormElement>('#notice-form')!, bar = page.querySelector<HTMLElement>('.notice-preview .site-notice')!;
  const read = () => { const f = new FormData(form); return { text: String(f.get('text')), bg: String(f.get('bg')), fg: String(f.get('fg')), on: f.get('on') === 'on' }; };
  const preview = () => {
    const n = read();
    bar.textContent = n.text || 'Your message';
    bar.style.background = n.bg; bar.style.color = n.fg;
    bar.style.opacity = n.on && n.text ? '1' : '0.45';
  };
  form.addEventListener('input', preview);
  preview();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await call('PATCH', '/api/admin/site', { notice: read() }); say('Saved'); } catch (ex) { failing(ex); }
  });
}

// ---- What's new: markdown shown under Preferences → About ----
const NEWS_ICONS = ['brush', 'smudge', 'eraser', 'fill', 'select', 'lasso', 'wand', 'shape', 'eyedropper', 'gradient', 'layers', 'grid', 'undo', 'redo', 'pencil', 'camera', 'download', 'folder', 'link', 'chat', 'users', 'bell', 'settings', 'cloud', 'lock', 'eye', 'star', 'sparkle', 'info', 'warning', 'check', 'device', 'home', 'search', 'target', 'rotate', 'fit'];
const NEWS_TOOLS: [string, string, string][] = [['Heading', '## ', ''], ['Bold', '**', '**'], ['Italic', '*', '*'], ['Link', '[', '](https://)'], ['List', '- ', ''], ['Quote', '> ', ''], ['Accent', '[accent]', '[/accent]'], ['Rule', '\n---\n', '']];

async function newsPage() {
  const news = await call<{ md: string; at: number }>('GET', '/api/admin/whatsnew');
  if (stale('What’s new')) return;
  page.innerHTML = `
    <h2>What’s new</h2>
    <p class="fine">Shown under Preferences → About. Markdown, plus <code>[accent]…[/accent]</code> for the reader’s accent colour, <code>[icon:name]</code> for an app icon and <code>[art:name]</code> for a graphic (on its own line it becomes a big one).</p>
    <div class="news-edit">
      <div>
        <div class="news-tools">${NEWS_TOOLS.map(([t]) => `<button type="button" class="btn small" data-tool="${t}">${t}</button>`).join('')}</div>
        <textarea id="news-md" spellcheck="true" placeholder="## Fresh paint&#10;- [icon:brush] New brushes&#10;[accent]Thanks for drawing with us.[/accent]">${esc(news.md)}</textarea>
        <h3>Graphics</h3>
        <div class="news-gallery">${ART_NAMES.map((n) => `<button type="button" title="[art:${n}]" data-ins="[art:${n}]">${art(n, 36)}</button>`).join('')}</div>
        <h3>Icons</h3>
        <div class="news-gallery icons">${NEWS_ICONS.map((n) => `<button type="button" title="[icon:${n}]" data-ins="[icon:${n}]">${icon(n, 20)}</button>`).join('')}</div>
        <div class="site-row"><button class="btn small primary" id="news-save" type="button">Save</button><span class="fine" id="news-at">${news.at ? 'Updated ' + when(news.at) : 'Nothing published yet'}</span></div>
      </div>
      <div><h3>Preview</h3><div class="news-preview md"></div></div>
    </div>`;
  const ta = page.querySelector<HTMLTextAreaElement>('#news-md')!, preview = page.querySelector<HTMLElement>('.news-preview')!;
  const render = () => { preview.innerHTML = renderMarkdown(ta.value) || '<span class="fine">Nothing yet.</span>'; };
  const insert = (before: string, after: string) => {
    const a = ta.selectionStart, b = ta.selectionEnd, v = ta.value;
    ta.setRangeText(before + v.slice(a, b) + after, a, b, 'end');
    if (a === b) ta.setSelectionRange(a + before.length, a + before.length);
    ta.focus(); render();
  };
  for (const b of page.querySelectorAll<HTMLElement>('[data-tool]')) b.addEventListener('click', () => { const t = NEWS_TOOLS.find((x) => x[0] === b.dataset.tool)!; insert(t[1], t[2]); });
  for (const b of page.querySelectorAll<HTMLElement>('[data-ins]')) b.addEventListener('click', () => insert(b.dataset.ins!, ''));
  ta.addEventListener('input', render);
  render();
  page.querySelector('#news-save')!.addEventListener('click', async () => {
    try {
      const r = await call<{ at: number }>('PUT', '/api/admin/whatsnew', { md: ta.value });
      page.querySelector('#news-at')!.textContent = 'Updated ' + when(r.at);
      say('Saved');
    } catch (ex) { failing(ex); }
  });
}

// ---- IP bans ----
async function ipBans() {
  const list = await call<IpBan[]>('GET', '/api/admin/ip-bans');
  if (stale('IP bans')) return;
  page.innerHTML = `
    <form class="admin-tools" id="ban-form"><input name="ip" placeholder="IP address" required autocomplete="off"><input name="reason" placeholder="Reason (optional)" maxlength="120"><button class="btn small danger" type="submit">Ban</button></form>
    ${list.length ? `<table class="admin-table"><tr><th>Address</th><th>Reason</th><th>Since</th><th></th></tr>
      ${list.map((b) => `<tr><td class="mono">${esc(b.ip)}</td><td>${esc(b.reason) || '—'}</td><td>${when(b.createdAt)}</td><td><button class="btn small" data-ip="${esc(b.ip)}">Remove</button></td></tr>`).join('')}</table>` : '<p class="fine">No banned addresses.</p>'}`;
  page.querySelector('#ban-form')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget as HTMLFormElement);
    try { await call('POST', '/api/admin/ip-bans', { ip: f.get('ip'), reason: f.get('reason') }); say('Address banned'); await ipBans(); } catch (ex) { failing(ex); }
  });
  for (const b of page.querySelectorAll<HTMLElement>('[data-ip]')) b.addEventListener('click', async () => {
    try { await call('DELETE', '/api/admin/ip-bans', { ip: b.dataset.ip }); await ipBans(); } catch (ex) { failing(ex); }
  });
}

// ---- Log ----
async function logPage() {
  const rows = await call<LogRow[]>('GET', '/api/admin/log');
  if (stale('Log')) return;
  page.innerHTML = rows.length ? `<table class="admin-table"><tr><th>When</th><th>Admin</th><th>Action</th><th>Who</th></tr>
    ${rows.map((r) => `<tr><td>${when(r.at)}</td><td>@${esc(r.admin ?? '?')}</td><td>${esc(r.action)}</td><td>${esc(r.target)}</td></tr>`).join('')}</table>` : '<p class="fine">Nothing yet.</p>';
}

const PAGES: Record<Section, () => Promise<void>> = { Overview: overview, Site: sitePage, 'What’s new': newsPage, Users: usersPage, 'IP bans': ipBans, Log: logPage };

function show(s: Section) {
  clearTimeout(timer);
  page.dataset.section = s;
  for (const b of root.querySelectorAll<HTMLElement>('.admin-nav button')) b.classList.toggle('active', b.textContent === s);
  page.innerHTML = '<p class="fine">Loading…</p>';
  PAGES[s]().catch(failing);
}

async function main() {
  const me = await api.me().catch(() => null);
  if (!me) { location.replace('/login?next=/admin'); return; }
  if (!me.admin) { location.replace('/404'); return; }
  root.innerHTML = `
    <header class="site-header"><div class="header-left">${brandHtml('/app')}<span class="admin-tag">Admin</span></div><a class="btn small" href="/app">Back to the app</a></header>
    <main class="admin-wrap">
      <nav class="admin-nav" aria-label="Sections">${SECTIONS.map((s) => `<button type="button">${s}</button>`).join('')}</nav>
      <section class="admin-page"></section>
    </main>
    <div class="admin-toast" role="status"></div>`;
  page = root.querySelector('.admin-page')!;
  toast = root.querySelector('.admin-toast')!;
  for (const b of root.querySelectorAll<HTMLElement>('.admin-nav button')) b.addEventListener('click', () => show(b.textContent as Section));
  show('Overview');
}
main();
