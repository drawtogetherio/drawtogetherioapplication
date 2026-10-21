import { siArtstation, siBluesky, siDeviantart, siInstagram, siPixiv, siTiktok, siTumblr, siTwitch, siX, siYoutube } from 'simple-icons';
import { h } from './dom';

const LOGOS: Record<string, { path: string; hex: string }> = {
  twitter: siX, instagram: siInstagram, youtube: siYoutube, deviantart: siDeviantart, bluesky: siBluesky,
  twitch: siTwitch, artstation: siArtstation, tiktok: siTiktok, tumblr: siTumblr, pixiv: siPixiv,
};

export function socialLogo(platform: string, size = 28): HTMLElement {
  const logo = LOGOS[platform];
  const el = h('span.social-logo', { style: `width:${size}px;height:${size}px;background:#${logo?.hex ?? '555'}` });
  if (logo) el.innerHTML = `<svg viewBox="0 0 24 24" width="${Math.round(size * 0.58)}" height="${Math.round(size * 0.58)}" aria-hidden="true"><path fill="#fff" d="${logo.path}"/></svg>`;
  return el;
}
