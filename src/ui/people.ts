import type { PublicProfile } from '../shared/profile';
import type { Role } from '../shared/protocol';
import { h } from './dom';
import { CROWN_SVG, HOST_SVG, STAR_SVG } from './icons';

export function initials(name: string) {
  const parts = [...name.trim()].filter((c) => /[\p{L}\p{N}]/u.test(c));
  return (parts[0] ?? '?').toUpperCase();
}

/** Readable text colour on top of a background colour. */
export function inkOn(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const l = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return l > 150 ? '#141418' : '#ffffff';
}

/** Round avatar: the uploaded picture, or an initial on the person's favourite colour. */
export function avatarEl(p: Pick<PublicProfile, 'avatar' | 'displayName' | 'favoriteColor'>, size = 28): HTMLElement {
  const el = h('span.avatar', { style: `width:${size}px;height:${size}px;--ring:${p.favoriteColor}` });
  if (p.avatar) el.append(h('img', { src: p.avatar, alt: '', width: size, height: size, loading: 'lazy' }));
  else {
    el.textContent = initials(p.displayName);
    el.style.background = p.favoriteColor;
    el.style.color = inkOn(p.favoriteColor);
    el.style.fontSize = Math.round(size * 0.45) + 'px';
  }
  return el;
}

/** Badges: crown for the room owner, shield for hosts, star for premium. Owners who are premium get both. */
export function badges(role: Role | undefined, premium: boolean): HTMLElement {
  const el = h('span.badges');
  el.innerHTML = (role === 'owner' ? CROWN_SVG : role === 'host' ? HOST_SVG : '') + (premium ? STAR_SVG : '');
  return el;
}

export function nameLine(p: PublicProfile, role?: Role, you = false): HTMLElement {
  const name = h('span.person-name', {}, p.displayName);
  return h('span.name-line', {}, name, badges(role, p.premium), you ? h('span.you-tag', {}, 'you') : null);
}

const imgCache = new Map<string, HTMLImageElement>();
/** Decoded avatar image for drawing on the canvas (null until loaded). */
export function avatarImage(url: string, onLoad: () => void): HTMLImageElement | null {
  let img = imgCache.get(url);
  if (!img) {
    img = new Image();
    img.src = url;
    img.onload = onLoad;
    imgCache.set(url, img);
  }
  return img.complete && img.naturalWidth ? img : null;
}
