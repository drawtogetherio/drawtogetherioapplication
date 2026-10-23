import type { Prefs } from './prefs';
// Profile rules shared by browser and server.

export const HANDLE_WORDS = [
  'Burntout', 'Artblocked', 'Smudged', 'Overworked', 'Unfinished', 'Sketchy', 'Wobbly', 'Crooked', 'Muddy',
  'Overblended', 'Oversaturated', 'Undersaturated', 'Scribbly', 'Erased', 'Procrastinating', 'Halfbaked',
  'Shaky', 'Unshaded', 'Lopsided', 'Blotchy', 'Smeared', 'Uninspired', 'Blurry', 'Pixelated', 'Jittery',
  'Rushed', 'Abandoned', 'Undone', 'Overlayered', 'Unrendered', 'Messy', 'Clumsy', 'Stiff', 'Deadlined',
  'Caffeinated', 'Sleepless', 'Tangled', 'Faded', 'Lumpy', 'Gridless', 'Wonky', 'Traced', 'Smudgy',
  'Perspectiveless', 'Handless', 'Offmodel', 'Flatshaded', 'Thumbnailed', 'Underpaid', 'Selftaught',
] as const;

export const HANDLE_FOODS = [
  'Pasta', 'Sandwich', 'Noodle', 'Dumpling', 'Burrito', 'Pancake', 'Waffle', 'Taco', 'Bagel', 'Croissant',
  'Muffin', 'Pretzel', 'Nugget', 'Tofu', 'Pickle', 'Potato', 'Toast', 'Ramen', 'Biscuit', 'Donut',
  'Cupcake', 'Meatball', 'Pierogi', 'Gnocchi', 'Onigiri', 'Mochi', 'Churro', 'Nacho', 'Crouton', 'Omelette',
  'Pudding', 'Cabbage', 'Turnip', 'Radish', 'Lasagna', 'Ravioli', 'Quesadilla', 'Samosa', 'Bao', 'Falafel',
  'Hotdog', 'Pizza', 'Scone', 'Crumpet', 'Kimchi', 'Tamale', 'Empanada', 'Flan', 'Risotto', 'Dango',
] as const;

const RANDOM_HANDLE_RE = new RegExp(`^(${HANDLE_WORDS.join('|')})(${HANDLE_FOODS.join('|')})-\\d{4}$`);

export function isRandomHandle(h: string) { return RANDOM_HANDLE_RE.test(h); }

export const HANDLE_MIN = 2;
export const HANDLE_MAX = 32;

/** 2–32 letters, numbers, underscores, periods and hyphens. Returns the problem, or null. */
export function handleError(h: string): string | null {
  if (h.length < HANDLE_MIN) return `Use at least ${HANDLE_MIN} characters.`;
  if (h.length > HANDLE_MAX) return `Keep it to ${HANDLE_MAX} characters or fewer.`;
  if (!/^[A-Za-z0-9_.-]+$/.test(h)) return 'Use letters, numbers, underscores, periods and hyphens only.';
  if (/^[.-]|[.-]$|[.-]{2}/.test(h)) return 'Periods and hyphens can’t start or end a handle, or sit next to each other.';
  return null;
}

export function isValidHandle(h: string) { return handleError(h) === null; }

export function suggestHandle(name: string): string {
  const h = name.normalize('NFKD').replace(/[^A-Za-z0-9_.-]/g, '').replace(/[.-]{2,}/g, '.').replace(/^[.-]+|[.-]+$/g, '').slice(0, HANDLE_MAX).replace(/[.-]+$/, '');
  return h.length >= HANDLE_MIN ? h : '';
}

export const DISPLAY_NAME_MAX = 32;

/** NFKC, no invisible or direction-changing characters, at most two combining marks per character. */
export function sanitizeDisplayName(raw: string): string {
  let s = raw.normalize('NFKC');
  s = s.replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/gu, '');
  s = s.replace(/(\P{M})(\p{M}{0,2})\p{M}*/gu, '$1$2');
  s = s.replace(/^\p{M}+/u, '');
  s = s.replace(/\s+/gu, ' ').trim();
  return s;
}

export function graphemeCount(s: string): number {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<unknown> } }).Segmenter;
  if (!Seg) return [...s].length;
  let n = 0;
  for (const _ of new Seg(undefined, { granularity: 'grapheme' }).segment(s)) n++;
  return n;
}

export function validateDisplayName(s: string): string | null {
  if (!s) return 'Pick a display name.';
  if (graphemeCount(s) > DISPLAY_NAME_MAX || s.length > DISPLAY_NAME_MAX * 4) return `Keep it to ${DISPLAY_NAME_MAX} characters or fewer.`;
  if (!/[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(s)) return 'Use at least one letter, number or emoji.';
  return null;
}

export const STATUS_MAX = 80;

export function cleanStatus(raw: string): string | null {
  const s = sanitizeDisplayName(raw);
  return graphemeCount(s) > STATUS_MAX || s.length > STATUS_MAX * 4 ? null : s;
}

export function normalizeColor(c: string): string | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(c.trim());
  return m ? '#' + m[1].toLowerCase() : null;
}

export interface LinkPlatform { id: string; label: string; pattern: RegExp; url: (u: string) => string; hint: string }

export const LINK_PLATFORMS: LinkPlatform[] = [
  { id: 'twitter', label: 'Twitter', pattern: /^[A-Za-z0-9_]{1,15}$/, url: (u) => `https://twitter.com/${u}`, hint: 'username' },
  { id: 'instagram', label: 'Instagram', pattern: /^[A-Za-z0-9._]{1,30}$/, url: (u) => `https://instagram.com/${u}`, hint: 'username' },
  { id: 'youtube', label: 'YouTube', pattern: /^[A-Za-z0-9._-]{3,30}$/, url: (u) => `https://youtube.com/@${u}`, hint: 'handle' },
  { id: 'deviantart', label: 'DeviantArt', pattern: /^[A-Za-z0-9-]{3,20}$/, url: (u) => `https://www.deviantart.com/${u}`, hint: 'username' },
  { id: 'bluesky', label: 'Bluesky', pattern: /^[a-z0-9-]+(\.[a-z0-9-]+)+$/, url: (u) => `https://bsky.app/profile/${u}`, hint: 'name.bsky.social' },
  { id: 'twitch', label: 'Twitch', pattern: /^[A-Za-z0-9_]{3,25}$/, url: (u) => `https://twitch.tv/${u}`, hint: 'username' },
  { id: 'artstation', label: 'ArtStation', pattern: /^[A-Za-z0-9_-]{3,30}$/, url: (u) => `https://www.artstation.com/${u}`, hint: 'username' },
  { id: 'tiktok', label: 'TikTok', pattern: /^[A-Za-z0-9._]{2,24}$/, url: (u) => `https://www.tiktok.com/@${u}`, hint: 'username' },
  { id: 'tumblr', label: 'Tumblr', pattern: /^[A-Za-z0-9-]{1,32}$/, url: (u) => `https://${u}.tumblr.com`, hint: 'blog name' },
  { id: 'pixiv', label: 'pixiv', pattern: /^\d{1,12}$/, url: (u) => `https://www.pixiv.net/users/${u}`, hint: 'user ID (numbers)' },
];

export function normalizeLink(platform: string, value: string): string | null {
  const p = LINK_PLATFORMS.find((x) => x.id === platform);
  if (!p) return null;
  let v = value.trim().replace(/^@/, '');
  if (!v) return '';
  if (platform === 'bluesky') { v = v.toLowerCase(); if (!v.includes('.')) v += '.bsky.social'; }
  return p.pattern.test(v) ? v : null;
}

export interface PublicProfile {
  id: string;
  handle: string;
  displayName: string;
  avatar: string | null;
  favoriteColor: string;
  links: Record<string, string>;
  premium: boolean;
  premiumUntil: number | null;
  status: string;
  gradient: [string, string] | null;
  /** Premium GIF; `avatar` is its still. */
  avatarAnimated: string | null;
  /** How the GIF is cropped on display, as fractions of the crop square (see `cleanCrop`). */
  avatarCrop: ImageCrop | null;
  banner: string | null;
  guest: boolean;
  badges: Badge[];
  pinned: PinnedCanvas[];
}

/** A canvas shown on its owner's profile; the thumbnail is public. */
export interface PinnedCanvas { id: string; name: string; thumb: string | null }
export const PINNED_MAX = 5;
export const cleanPinned = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && /^[a-z0-9]{1,16}$/.test(x)))].slice(0, PINNED_MAX) : []);

/** Badges an admin can hand out, shown next to the name. */
export const BADGES = { staff: 'Staff', supporter: 'Supporter', artist: 'Featured artist', early: 'Early bee' } as const;
export type Badge = keyof typeof BADGES;
export const cleanBadges = (v: unknown): Badge[] => (Array.isArray(v) ? [...new Set(v.filter((b): b is Badge => typeof b === 'string' && b in BADGES))] : []);

/** `offline` also covers "appear offline". */
export type Presence = 'online' | 'away' | 'dnd' | 'offline';
export type PresenceMode = 'auto' | 'away' | 'dnd' | 'invisible';
export const PRESENCE_MODES: PresenceMode[] = ['auto', 'away', 'dnd', 'invisible'];

export interface MyProfile extends PublicProfile {
  presenceMode: PresenceMode;
  needsSetup: boolean;
  provider: 'discord' | 'dev' | 'guest';
  theme: string;
  prefs: Prefs;
  admin: boolean;
  /** Linked Patreon account; `active` patrons have premium. */
  patreon: { name: string; active: boolean } | null;
}

export const AVATAR_SIZE = 128;
export const AVATAR_MAX_BYTES = 48 * 1024;
export const AVATAR_ANIM_MAX_BYTES = 4 * 1024 * 1024;
export const AVATAR_ANIM_MAX_SIZE = 1024;
export const BANNER_W = 1200;
export const BANNER_H = 400;
export const BANNER_MAX_BYTES = 400 * 1024;

/** GIFs can't be re-encoded in the browser, so the crop is applied on display: the picture's offset and size relative to the crop square. */
export interface ImageCrop { x: number; y: number; w: number; h: number }
export function cleanCrop(raw: unknown): ImageCrop | null {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const n = (k: string) => (typeof c[k] === 'number' && Number.isFinite(c[k]) ? Math.round((c[k] as number) * 1e4) / 1e4 : NaN);
  const r = { x: n('x'), y: n('y'), w: n('w'), h: n('h') };
  return r.w >= 1 && r.h >= 1 && r.w <= 50 && r.h <= 50 && r.x >= 0 && r.y >= 0 && r.x + 1 <= r.w + 1e-3 && r.y + 1 <= r.h + 1e-3 ? r : null;
}
