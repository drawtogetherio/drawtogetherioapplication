import { Badge, LINK_PLATFORMS, PublicProfile } from '../shared/profile';
import type { Role } from '../shared/protocol';
import { socialLogo } from './socials';
import { h } from './dom';
import { BADGE_SVGS, CROWN_SVG, HOST_SVG, STAR_SVG } from './icons';

export function initials(name: string) {
  const parts = [...name.trim()].filter((c) => /[\p{L}\p{N}]/u.test(c));
  return (parts[0] ?? '?').toUpperCase();
}

export function inkOn(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const l = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return l > 150 ? '#141418' : '#ffffff';
}

/** With a name gradient, the ring and the fallback picture use it instead of the profile colour. */
export function avatarEl(
  p: Pick<PublicProfile, 'avatar' | 'displayName' | 'favoriteColor'> & { avatarAnimated?: string | null; gradient?: [string, string] | null },
  size = 28, animate = false,
): HTMLElement {
  const g = p.gradient;
  const el = h(`span.avatar${g ? '.has-gradient' : ''}` as 'span', { style: `width:${size}px;height:${size}px;` + (g ? gradientStyle(g) : `--ring:${p.favoriteColor}`) });
  // The GIF only plays where it's showcased.
  const src = animate && p.avatarAnimated ? p.avatarAnimated : p.avatar;
  if (src) el.append(h('img', { src, alt: '', width: size, height: size, loading: 'lazy' }));
  else {
    el.textContent = initials(p.displayName);
    el.style.background = g ? `linear-gradient(135deg, ${g[0]}, ${g[1]})` : p.favoriteColor;
    el.style.color = inkOn(g ? g[0] : p.favoriteColor);
    el.style.fontSize = Math.round(size * 0.45) + 'px';
  }
  return el;
}

export function badges(role: Role | undefined, premium: boolean, extra: Badge[] = []): HTMLElement {
  const el = h('span.badges');
  el.innerHTML = (role === 'owner' ? CROWN_SVG : role === 'host' ? HOST_SVG : '') + (premium ? STAR_SVG : '') + extra.map((b) => BADGE_SVGS[b] ?? '').join('');
  return el;
}

export function gradientStyle(g: [string, string] | null | undefined) {
  return g ? `--g1:${g[0]};--g2:${g[1]}` : '';
}

export function nameText(p: Pick<PublicProfile, 'displayName' | 'gradient'>, cls = 'person-name', color?: string): HTMLElement {
  if (p.gradient) return h(`span.${cls}.gradient-name` as 'span', { style: gradientStyle(p.gradient) }, p.displayName);
  return h(`span.${cls}` as 'span', { style: color ? `color:${color}` : '' }, p.displayName);
}

export function nameLine(p: PublicProfile, role?: Role, you = false): HTMLElement {
  const name = nameText(p);
  return h('span.name-line', {}, name, badges(role, p.premium, p.badges), you ? h('span.you-tag', {}, 'you') : null);
}

const imgCache = new Map<string, HTMLImageElement>();
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

export function profileCardBody(p: PublicProfile, role?: Role, extra?: HTMLElement | null): HTMLElement {
  const links = h('div.profile-links');
  for (const pl of LINK_PLATFORMS) {
    const u = p.links[pl.id];
    if (u) links.append(h('a.profile-link', { href: pl.url(u), target: '_blank', rel: 'noopener noreferrer', title: pl.label }, socialLogo(pl.id, 22), h('span', {}, (pl.id === 'pixiv' ? '#' : '@') + u)));
  }
  const head = h(`div.profile-card-head${p.gradient ? '.has-gradient' : ''}` as 'div', { style: gradientStyle(p.gradient) },
    avatarEl(p, 64, true),
    h('div', {},
      h('div.profile-card-name', {}, nameText(p, 'card-name'), badges(role, p.premium, p.badges)),
      h('div.muted', {}, '@' + p.handle),
      p.status ? h('div.profile-status', {}, p.status) : null),
  );
  return h('div.modal-body.profile-card', {}, head, extra ?? null,
    links.childElementCount ? links : null);
}
