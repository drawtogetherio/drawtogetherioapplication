// Patreon account linking: OAuth, then the membership check that grants premium while someone is an active patron.
import { config } from './config.ts';
import { UserRow, db, getUser } from './db.ts';

const app = () => config.patreonApp!;
export const patreonEnabled = () => !!config.patreonApp;
const redirectUri = () => config.publicUrl + '/auth/patreon/callback';
const RECHECK_MS = 12 * 60 * 60 * 1000;

export function authorizeUrl(state: string) {
  const q = new URLSearchParams({ response_type: 'code', client_id: app().clientId, redirect_uri: redirectUri(), scope: 'identity identity.memberships', state });
  return `${app().api}/oauth2/authorize?${q}`;
}

interface Tokens { access: string; refresh: string; expires: number }

async function token(body: Record<string, string>): Promise<Tokens | null> {
  const r = await fetch(`${app().api}/api/oauth2/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: app().clientId, client_secret: app().clientSecret, ...body }),
  });
  if (!r.ok) return null;
  const t = await r.json() as { access_token: string; refresh_token: string; expires_in: number };
  return { access: t.access_token, refresh: t.refresh_token, expires: Date.now() + t.expires_in * 1000 };
}

/** Who the token belongs to and whether they are an active patron (of PATREON_CAMPAIGN_ID when set). */
async function identity(access: string) {
  const q = new URLSearchParams({ include: 'memberships.campaign', 'fields[user]': 'full_name', 'fields[member]': 'patron_status' });
  const r = await fetch(`${app().api}/api/oauth2/v2/identity?${q}`, { headers: { Authorization: `Bearer ${access}` } });
  if (!r.ok) return null;
  const d = await r.json() as {
    data: { id: string; attributes?: { full_name?: string } };
    included?: { type: string; attributes?: { patron_status?: string | null }; relationships?: { campaign?: { data?: { id: string } | null } } }[];
  };
  const campaign = app().campaignId;
  const active = (d.included ?? []).some((m) => m.type === 'member' && m.attributes?.patron_status === 'active_patron' && (!campaign || m.relationships?.campaign?.data?.id === campaign));
  return { id: d.data.id, name: d.data.attributes?.full_name || 'Patreon', active };
}

function store(userId: string, who: { name: string; active: boolean }, t: Tokens | null) {
  db.prepare('UPDATE users SET patreon_name = ?, patreon_active = ?, patreon_tokens = ?, patreon_checked = ? WHERE id = ?').run(who.name, who.active ? 1 : 0, t ? JSON.stringify(t) : null, Date.now(), userId);
}

/** Finishes the OAuth flow for a logged-in person. */
export async function linkPatreon(u: UserRow, code: string): Promise<'linked' | 'failed' | 'taken'> {
  const t = await token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() });
  const who = t && await identity(t.access);
  if (!t || !who) return 'failed';
  if (db.prepare('SELECT 1 FROM users WHERE patreon_id = ? AND id <> ?').get(who.id, u.id)) return 'taken';
  db.prepare('UPDATE users SET patreon_id = ? WHERE id = ?').run(who.id, u.id);
  store(u.id, who, t);
  return 'linked';
}

export function unlinkPatreon(userId: string) {
  db.prepare('UPDATE users SET patreon_id = NULL, patreon_name = NULL, patreon_active = 0, patreon_tokens = NULL, patreon_checked = NULL WHERE id = ?').run(userId);
}

const checking = new Set<string>();

/** Re-reads the patron status once the last look is old (or now, with `force`); a revoked link counts as not a patron. */
export async function refreshPatreon(u: UserRow, force = false): Promise<UserRow> {
  if (!u.patreon_id || !patreonEnabled() || checking.has(u.id) || (!force && u.patreon_checked && Date.now() - u.patreon_checked < RECHECK_MS)) return u;
  checking.add(u.id);
  try {
    let t = u.patreon_tokens ? JSON.parse(u.patreon_tokens) as Tokens : null;
    if (t && t.expires < Date.now() + 60_000) t = await token({ grant_type: 'refresh_token', refresh_token: t.refresh });
    const who = t && await identity(t.access);
    store(u.id, who ?? { name: u.patreon_name ?? 'Patreon', active: false }, t);
    return getUser(u.id)!;
  } catch { return u; } finally { checking.delete(u.id); }
}
