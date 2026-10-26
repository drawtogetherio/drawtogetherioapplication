/** Only the accent changes between themes, so artwork reads the same in all of them. */
export interface Theme {
  id: string;
  name: string;
  premium: boolean;
  accent: string;
  accentHover: string;
  accentTint: string;
  onAccent: string;
}

export const THEMES: Theme[] = [
  { id: 'honey', name: 'Honey', premium: false, accent: '#fdb302', accentHover: '#e5a200', accentTint: '#42361c', onAccent: '#212021' },
  { id: 'blueberry', name: 'Blueberry', premium: true, accent: '#4f8cff', accentHover: '#3f7ef5', accentTint: '#2b3445', onAccent: '#ffffff' },
  { id: 'lavender', name: 'Lavender', premium: true, accent: '#b49cff', accentHover: '#a387fb', accentTint: '#332e45', onAccent: '#1d1238' },
  { id: 'mint', name: 'Mint', premium: true, accent: '#5fd3a5', accentHover: '#47c592', accentTint: '#253a33', onAccent: '#08281c' },
  { id: 'peach', name: 'Peach', premium: true, accent: '#ff9e7a', accentHover: '#f88a63', accentTint: '#3d2d28', onAccent: '#3a1305' },
];

export const DEFAULT_THEME = 'honey';

/** Premium: any accent, stored as `custom:#rrggbb`. */
const CUSTOM = /^custom:(#[0-9a-f]{6})$/i;
export const customTheme = (hex: string) => 'custom:' + hex.toLowerCase();

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hex = (c: number[]) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);

export function findTheme(id: string | null | undefined): Theme {
  const m = id && CUSTOM.exec(id);
  if (m) {
    const c = rgb(m[1]);
    const light = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2] > 150;
    return {
      id: customTheme(m[1]), name: 'Custom', premium: true, accent: m[1].toLowerCase(),
      accentHover: hex(mix(c, [0, 0, 0], 0.1)), accentTint: hex(mix(c, [33, 32, 33], 0.75)), onAccent: light ? '#212021' : '#ffffff',
    };
  }
  return THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME)!;
}

export const isTheme = (id: string) => CUSTOM.test(id) || THEMES.some((t) => t.id === id);

export function canUseTheme(id: string, premium: boolean): boolean {
  return isTheme(id) && (!findTheme(id).premium || premium);
}
