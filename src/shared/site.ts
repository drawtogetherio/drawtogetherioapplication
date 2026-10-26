// Site-wide settings an admin changes from the dashboard.
import { normalizeColor } from './profile';

export const NOTICE_MAX = 200;

export interface SiteNotice { on: boolean; text: string; bg: string; fg: string }
export interface SiteSettings {
  /** New accounts start with the Early bee badge. */
  earlyBadge: boolean;
  /** A line across the top of the home screen. */
  notice: SiteNotice;
}

export const DEFAULT_SITE: SiteSettings = { earlyBadge: true, notice: { on: false, text: '', bg: '#fdb302', fg: '#212021' } };

export function cleanSite(raw: unknown): SiteSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const n = (r.notice && typeof r.notice === 'object' ? r.notice : {}) as Record<string, unknown>;
  const text = typeof n.text === 'string' ? n.text.replace(/\s+/g, ' ').trim().slice(0, NOTICE_MAX) : '';
  return {
    earlyBadge: r.earlyBadge !== false,
    notice: {
      on: n.on === true && !!text, text,
      bg: (typeof n.bg === 'string' && normalizeColor(n.bg)) || DEFAULT_SITE.notice.bg,
      fg: (typeof n.fg === 'string' && normalizeColor(n.fg)) || DEFAULT_SITE.notice.fg,
    },
  };
}
