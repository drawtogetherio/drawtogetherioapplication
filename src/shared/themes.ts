/**
 * App colour themes. Only the accent family changes; the dark workspace stays the same so artwork
 * colours read the same in every theme. `premium` themes need an active premium account.
 */
export interface Theme {
  id: string;
  name: string;
  premium: boolean;
  /** Buttons, selection, active tool, links. */
  accent: string;
  /** Hover / pressed shade of the accent. */
  accentHover: string;
  /** Background of the selected layer / preset (accent mixed into the panel colour). */
  accentTint: string;
  /** Text and icons drawn on top of the accent; dark for light accents. */
  onAccent: string;
}

export const THEMES: Theme[] = [
  { id: 'honey', name: 'Honey', premium: false, accent: '#f4c25b', accentHover: '#e8b13f', accentTint: '#3a3322', onAccent: '#2b1f04' },
  { id: 'blueberry', name: 'Blueberry', premium: false, accent: '#4f8cff', accentHover: '#3f7ef5', accentTint: '#2b3445', onAccent: '#ffffff' },
  { id: 'lavender', name: 'Lavender', premium: true, accent: '#b49cff', accentHover: '#a387fb', accentTint: '#332e45', onAccent: '#1d1238' },
  { id: 'mint', name: 'Mint', premium: true, accent: '#5fd3a5', accentHover: '#47c592', accentTint: '#253a33', onAccent: '#08281c' },
  { id: 'peach', name: 'Peach', premium: true, accent: '#ff9e7a', accentHover: '#f88a63', accentTint: '#3d2d28', onAccent: '#3a1305' },
];

export const DEFAULT_THEME = 'honey';

export function findTheme(id: string | null | undefined): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME)!;
}

/** Whether someone may use a theme (free themes always; premium ones with premium). */
export function canUseTheme(id: string, premium: boolean): boolean {
  const t = THEMES.find((x) => x.id === id);
  return !!t && (!t.premium || premium);
}
