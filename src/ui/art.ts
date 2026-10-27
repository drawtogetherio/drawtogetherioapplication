// Flat 64x64 graphics for What's new. Two tones: the text colour and the theme accent, so they sit in any theme.
const A = 'var(--accent)', T = 'currentColor';
const ART: Record<string, string> = {
  sparkles: `<path fill="${A}" d="M26 6l5 14 14 5-14 5-5 14-5-14-14-5 14-5z"/><path fill="${T}" opacity=".55" d="M50 34l2.4 6.6L59 43l-6.6 2.4L50 52l-2.4-6.6L41 43l6.6-2.4zM14 44l1.6 4.4L20 50l-4.4 1.6L14 56l-1.6-4.4L8 50l4.4-1.6z"/>`,
  rocket: `<path fill="${T}" d="M32 4c8 6 12 16 12 28v8H20v-8C20 20 24 10 32 4z"/><circle cx="32" cy="24" r="5" fill="${A}"/><path fill="${A}" d="M20 30l-9 10 9 4zM44 30l9 10-9 4z"/><path fill="${A}" d="M26 44h12l-6 16z"/><rect x="26" y="40" width="12" height="4" fill="${T}" opacity=".5"/>`,
  palette: `<path fill="${T}" d="M32 6C17 6 6 17 6 31c0 15 12 25 24 25 5 0 7-3 6-7-1-4 1-7 5-7h6c6 0 11-5 11-12C58 16 46 6 32 6z"/><circle cx="20" cy="30" r="5" fill="${A}"/><circle cx="29" cy="18" r="5" fill="${A}" opacity=".75"/><circle cx="43" cy="20" r="5" fill="${A}" opacity=".5"/><circle cx="20" cy="43" r="5" fill="${A}" opacity=".9"/>`,
  brush: `<path fill="${T}" d="M52 6l6 6-24 28-8-6z"/><rect x="24" y="30" width="10" height="8" transform="rotate(-50 29 34)" fill="${A}"/><path fill="${A}" d="M24 38c-6 0-10 4-10 10 0 4-2 7-6 9 8 2 18 1 22-4 3-4 3-8 1-12z"/>`,
  bulb: `<path fill="${A}" d="M32 4a18 18 0 0 1 10 33c-2 1-3 3-3 5v2H25v-2c0-2-1-4-3-5A18 18 0 0 1 32 4z"/><rect x="25" y="48" width="14" height="5" rx="2" fill="${T}"/><rect x="27" y="55" width="10" height="5" rx="2" fill="${T}" opacity=".6"/><path stroke="${T}" stroke-width="3" stroke-linecap="round" opacity=".5" d="M6 24h5M53 24h5M11 8l4 4M53 8l-4 4"/>`,
  heart: `<path fill="${A}" d="M32 58S6 42 6 22a13 13 0 0 1 26-4 13 13 0 0 1 26 4c0 20-26 36-26 36z"/><path fill="#fff" opacity=".35" d="M16 16a7 7 0 0 1 8 2c-4 1-7 4-8 8-2-3-2-8 0-10z"/>`,
  megaphone: `<path fill="${T}" d="M8 26h10l26-14v40L18 38H8z"/><rect x="8" y="26" width="10" height="12" fill="${A}"/><path fill="${T}" opacity=".6" d="M14 38h8l4 14h-8z"/><path stroke="${A}" stroke-width="3" stroke-linecap="round" fill="none" d="M50 24a8 8 0 0 1 0 16M54 18a15 15 0 0 1 0 28"/>`,
  wrench: `<path fill="${T}" d="M56 18a14 14 0 0 1-18 18L16 58a5 5 0 0 1-8-8l22-22A14 14 0 0 1 48 10l-8 8 4 4z"/><path fill="${A}" d="M50 44l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/>`,
  bug: `<ellipse cx="32" cy="38" rx="14" ry="18" fill="${A}"/><circle cx="32" cy="18" r="8" fill="${T}"/><path stroke="${T}" stroke-width="3" stroke-linecap="round" d="M18 30l-8-4M18 40H8M18 50l-8 4M46 30l8-4M46 40h10M46 50l8 4"/><path stroke="${T}" stroke-width="3" opacity=".5" d="M32 24v32"/><circle cx="29" cy="16" r="1.6" fill="#fff"/><circle cx="35" cy="16" r="1.6" fill="#fff"/>`,
  gift: `<rect x="8" y="26" width="48" height="32" rx="3" fill="${T}"/><rect x="6" y="18" width="52" height="10" rx="2" fill="${T}" opacity=".7"/><rect x="28" y="18" width="8" height="40" fill="${A}"/><path fill="${A}" d="M32 18c-8-2-12-8-10-12 3-3 8 2 10 10 2-8 7-13 10-10 2 4-2 10-10 12z"/>`,
  flag: `<rect x="12" y="6" width="4" height="52" rx="2" fill="${T}"/><path fill="${A}" d="M16 8h38l-8 12 8 12H16z"/>`,
  party: `<path fill="${T}" d="M6 58L22 20l22 22z"/><path fill="${A}" d="M22 20l22 22-6 2-18-18z"/><circle cx="38" cy="12" r="3" fill="${A}"/><circle cx="54" cy="24" r="3" fill="${A}"/><circle cx="50" cy="8" r="2.5" fill="${T}" opacity=".6"/><path stroke="${A}" stroke-width="3" stroke-linecap="round" fill="none" d="M46 18c4-4 6-2 10-6"/><path stroke="${T}" stroke-width="3" stroke-linecap="round" fill="none" opacity=".6" d="M32 8c0 4 4 4 4 8"/>`,
  pencil: `<path fill="${T}" d="M12 44l32-32 8 8-32 32H12z"/><path fill="${A}" d="M44 12l6-6 8 8-6 6z"/><path fill="${A}" opacity=".7" d="M12 44l8 8-10 2z"/>`,
  star: `<path fill="${A}" d="M32 4l8.5 17.3L59 24 45.5 37.1 48.7 56 32 47.1 15.3 56l3.2-18.9L5 24l18.5-2.7z"/>`,
  cloud: `<path fill="${T}" d="M18 50a12 12 0 0 1-2-24 16 16 0 0 1 31 4 10 10 0 0 1 1 20z"/><path fill="${A}" d="M32 58l-9-10h5V36h8v12h5z"/>`,
  trophy: `<path fill="${A}" d="M18 6h28v16a14 14 0 0 1-28 0z"/><path fill="${A}" opacity=".6" d="M18 10H8c0 10 4 16 12 18v-6c-4-1-6-5-6-12zM46 10h10c0 10-4 16-12 18v-6c4-1 6-5 6-12z"/><rect x="28" y="34" width="8" height="10" fill="${T}"/><rect x="18" y="44" width="28" height="6" rx="2" fill="${T}"/><rect x="14" y="50" width="36" height="8" rx="2" fill="${T}" opacity=".7"/>`,
  zap: `<path fill="${A}" d="M36 4L12 36h16l-4 24 24-32H32z"/>`,
  layers: `<path fill="${T}" opacity=".45" d="M32 34L4 48l28 14 28-14z"/><path fill="${T}" opacity=".7" d="M32 22L4 36l28 14 28-14z"/><path fill="${A}" d="M32 6L4 20l28 14 28-14z"/>`,
  shield: `<path fill="${T}" d="M32 4l24 8v18c0 14-10 24-24 30C18 54 8 44 8 30V12z"/><path stroke="${A}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none" d="M20 32l8 8 16-16"/>`,
  chat: `<path fill="${T}" d="M32 6C17 6 6 15 6 27c0 6 3 11 8 15l-2 12 12-7a30 30 0 0 0 8 1c15 0 26-9 26-21S47 6 32 6z"/><circle cx="21" cy="27" r="3.5" fill="${A}"/><circle cx="32" cy="27" r="3.5" fill="${A}"/><circle cx="43" cy="27" r="3.5" fill="${A}"/>`,
  people: `<circle cx="22" cy="20" r="10" fill="${T}"/><path fill="${T}" d="M4 54c0-12 8-20 18-20s18 8 18 20z"/><circle cx="46" cy="22" r="8" fill="${A}"/><path fill="${A}" d="M42 36c10 0 18 8 18 18H44c0-6-1-12-4-16 1-1 1-2 2-2z"/>`,
  phone: `<rect x="16" y="4" width="32" height="56" rx="6" fill="${T}"/><rect x="20" y="12" width="24" height="36" rx="2" fill="${A}" opacity=".85"/><circle cx="32" cy="54" r="2.5" fill="#fff" opacity=".7"/>`,
  laptop: `<rect x="8" y="10" width="48" height="32" rx="4" fill="${T}"/><rect x="12" y="14" width="40" height="24" rx="2" fill="${A}" opacity=".85"/><path fill="${T}" opacity=".7" d="M4 46h56l-4 6H8z"/>`,
};

export const ART_NAMES = Object.keys(ART);
export const hasArt = (n: string) => n in ART;
export function art(name: string, size = 64): string {
  return `<svg class="art" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true">${ART[name] ?? ''}</svg>`;
}
