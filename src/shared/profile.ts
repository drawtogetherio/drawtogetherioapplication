// Profile rules shared by the browser and the server, so both validate the same way.

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

const HANDLE_RE = new RegExp(`^(${HANDLE_WORDS.join('|')})(${HANDLE_FOODS.join('|')})(\\d{0,4})$`);

export function randomHandle(rand: () => number = Math.random): string {
  const w = HANDLE_WORDS[Math.floor(rand() * HANDLE_WORDS.length)];
  const f = HANDLE_FOODS[Math.floor(rand() * HANDLE_FOODS.length)];
  return w + f;
}

/** "BurntoutPasta" or "BurntoutPasta42" (a number is added when the pair is taken). */
export function isValidHandle(h: string) { return HANDLE_RE.test(h); }

export function splitHandle(h: string): { word: string; food: string; num: string } | null {
  const m = HANDLE_RE.exec(h);
  return m ? { word: m[1], food: m[2], num: m[3] } : null;
}

export const DISPLAY_NAME_MAX = 32;

/**
 * Clean a display name: fancy Unicode letters become plain ones (NFKC), invisible and
 * direction-changing characters are removed, and stacked accents ("zalgo") are capped.
 */
export function sanitizeDisplayName(raw: string): string {
  let s = raw.normalize('NFKC');
  s = s.replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/gu, '');
  // Allow at most two combining marks on any character.
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

/** Returns an error message, or null when the name is fine. Expects a sanitized name. */
export function validateDisplayName(s: string): string | null {
  if (!s) return 'Pick a display name.';
  if (graphemeCount(s) > DISPLAY_NAME_MAX || s.length > DISPLAY_NAME_MAX * 4) return `Keep it to ${DISPLAY_NAME_MAX} characters or fewer.`;
  if (!/[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(s)) return 'Use at least one letter, number or emoji.';
  return null;
}

export const STATUS_MAX = 80;

/** Status message: same cleaning as display names; empty is allowed. Returns null if too long. */
export function cleanStatus(raw: string): string | null {
  const s = sanitizeDisplayName(raw);
  return graphemeCount(s) > STATUS_MAX || s.length > STATUS_MAX * 4 ? null : s;
}

export function normalizeColor(c: string): string | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(c.trim());
  return m ? '#' + m[1].toLowerCase() : null;
}

export interface LinkPlatform { id: string; label: string; pattern: RegExp; url: (u: string) => string; hint: string }

/** Profiles people can list. These are just usernames, no account connection. */
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

/** Normalise one link username; returns null if invalid. Empty string means "remove". */
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
  /** Avatar URL (small, pre-scaled) or null. */
  avatar: string | null;
  favoriteColor: string;
  links: Record<string, string>;
  /** Effective premium status (flag set and not expired). */
  premium: boolean;
  premiumUntil: number | null;
  /** Short status message ("Working on a comic"); empty when unset. */
  status: string;
  /** Premium: two colours for the name/profile gradient, or null. */
  gradient: [string, string] | null;
  /** Premium: animated (GIF) picture URL, or null. `avatar` stays a small still version. */
  avatarAnimated: string | null;
}

export interface MyProfile extends PublicProfile {
  /** True until the person has confirmed their profile once. */
  needsSetup: boolean;
  provider: 'discord' | 'dev';
  /** App colour theme id (see shared/themes.ts). */
  theme: string;
}

/** Avatars are stored at this size; they are only ever shown small. */
export const AVATAR_SIZE = 128;
export const AVATAR_MAX_BYTES = 48 * 1024;
/** Premium animated pictures are stored as uploaded (GIF), so they get a bigger, still modest limit. */
export const AVATAR_ANIM_MAX_BYTES = 768 * 1024;
export const AVATAR_ANIM_MAX_SIZE = 512;
