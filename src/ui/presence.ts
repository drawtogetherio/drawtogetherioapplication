import type { Presence, PresenceMode } from '../shared/profile';

export function presenceLabel(p: Presence) {
  return p === 'online' ? 'Online' : p === 'away' ? 'Away' : p === 'dnd' ? 'Do not disturb' : 'Offline';
}

/** The choices on your card. "Offline" keeps you hidden while you use the app. */
export const MODE_CHOICES: { mode: PresenceMode; label: string; shows: Presence }[] = [
  { mode: 'auto', label: 'Online', shows: 'online' },
  { mode: 'away', label: 'Away', shows: 'away' },
  { mode: 'dnd', label: 'Do not disturb', shows: 'dnd' },
  { mode: 'invisible', label: 'Offline', shows: 'offline' },
];
