export const LOGO_SVG = `<svg class="logo-mark" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
  <path d="M16 2.5l11.7 6.75v13.5L16 29.5 4.3 22.75V9.25z" fill="var(--accent)"/>
  <path d="M10 21.5c2.5-.6 3.6-2.8 5.7-6.4l3.4-4.6 2.6 2.4-4.2 3.6c-3.9 2.8-6.2 3.6-7.5 5z" fill="var(--on-accent)"/>
</svg>`;

export function brandHtml(href = '/') {
  return `<a class="brand-link" href="${href}" aria-label="Doodlehive home">${LOGO_SVG}<span class="brand-word">doodle<span>hive</span></span></a>`;
}

export const DISCORD_SVG = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M20.3 4.6A19.6 19.6 0 0 0 15.4 3l-.6 1.3a18 18 0 0 0-5.6 0L8.6 3a19.5 19.5 0 0 0-4.9 1.6C.6 9.2-.3 13.7.1 18.1a19.8 19.8 0 0 0 6 3l1.3-2a12.8 12.8 0 0 1-2-1l.5-.4a14 14 0 0 0 12.2 0l.5.4c-.7.4-1.3.7-2 1l1.3 2a19.7 19.7 0 0 0 6-3c.5-5.1-.8-9.6-3.6-13.5zM8 15.4c-1.2 0-2.2-1.1-2.2-2.4S6.8 10.6 8 10.6s2.2 1.1 2.2 2.4-1 2.4-2.2 2.4zm8 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4z"/></svg>`;
export const APPLE_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M16.4 12.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.7-2-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.4-.9-1.7 0-3.3 1-4.2 2.6-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8 1.6 0 2 .8 3.4.8 1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9-.1 0-2.7-1-2.7-4.1zM13.9 5c.7-.9 1.2-2 1-3.2-1 0-2.3.7-3 1.6-.7.8-1.2 2-1.1 3.1 1.2.1 2.3-.6 3.1-1.5z"/></svg>`;
export const WINDOWS_SVG = `<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="currentColor" d="M3 5.1l7.4-1v7.2H3zm8.3-1.2L21 2.5v8.8h-9.7zM3 12.6h7.4v7.3L3 18.9zm8.3 0H21v8.9l-9.7-1.4z"/></svg>`;
export const GLOBE_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z"/></svg>`;
