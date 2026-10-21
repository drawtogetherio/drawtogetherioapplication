import { LINK_PLATFORMS, PublicProfile } from '../shared/profile';
import type { Role } from '../shared/protocol';
import { socialLogo } from './socials';
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
export function avatarEl(
  p: Pick<PublicProfile, 'avatar' | 'displayName' | 'favoriteColor'> & { avatarAnimated?: string | null },
  size = 28, animate = false,
): HTMLElement {
  const el = h('span.avatar', { style: `width:${size}px;height:${size}px;--ring:${p.favoriteColor}` });
  // The animated picture (premium) only plays where it's showcased; everywhere else uses the small still.
  const src = animate && p.avatarAnimated ? p.avatarAnimated : p.avatar;
  if (src) el.append(h('img', { src, alt: '', width: size, height: size, loading: 'lazy' }));
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

/** Premium name gradient as inline style (text filled with the gradient). */
export function gradientStyle(g: [string, string] | null | undefined) {
  return g ? `--g1:${g[0]};--g2:${g[1]}` : '';
}

/** A display name: in the premium gradient when there is one, otherwise optionally in `color`. */
export function nameText(p: Pick<PublicProfile, 'displayName' | 'gradient'>, cls = 'person-name', color?: string): HTMLElement {
  if (p.gradient) return h(`span.${cls}.gradient-name` as 'span', { style: gradientStyle(p.gradient) }, p.displayName);
  return h(`span.${cls}` as 'span', { style: color ? `color:${color}` : '' }, p.displayName);
}

export function nameLine(p: PublicProfile, role?: Role, you = false): HTMLElement {
  const name = nameText(p);
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

/** Profile card contents (picture, name, badges, status, colour, links). Used for members and friends. */
export function profileCardBody(p: PublicProfile, role?: Role, extra?: HTMLElement | null): HTMLElement {
  const links = h('div.profile-links');
  for (const pl of LINK_PLATFORMS) {
    const u = p.links[pl.id];
    if (u) links.append(h('a.profile-link', { href: pl.url(u), target: '_blank', rel: 'noopener noreferrer', title: pl.label }, socialLogo(pl.id, 22), h('span', {}, (pl.id === 'pixiv' ? '#' : '@') + u)));
  }
  const head = h(`div.profile-card-head${p.gradient ? '.has-gradient' : ''}` as 'div', { style: gradientStyle(p.gradient) },
    avatarEl(p, 64, true),
    h('div', {},
      h('div.profile-card-name', {}, nameText(p, 'card-name'), badges(role, p.premium)),
      h('div.muted', {}, '@' + p.handle),
      p.status ? h('div.profile-status', {}, p.status) : null,
      h('div.fav', {}, h('span.fav-swatch', { style: `background:${p.favoriteColor}` }), h('span.muted', {}, p.favoriteColor))),
  );
  return h('div.modal-body.profile-card', {}, head, extra ?? null,
    links.childElementCount ? links : h('p.muted', {}, 'No other profiles listed.'));
}
