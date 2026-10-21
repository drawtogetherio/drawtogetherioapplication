import type { CapacitorConfig } from '@capacitor/cli';

// The app shows doodlehive.net itself; the page detects the shell and keeps canvases with the Filesystem plugin.
const config: CapacitorConfig = {
  appId: 'net.doodlehive.app',
  appName: 'Doodlehive',
  webDir: 'www',
  server: { url: process.env.DOODLEHIVE_URL || 'https://doodlehive.net/app', allowNavigation: ['doodlehive.net', '*.doodlehive.net', 'discord.com', '*.discord.com'] },
  ios: { contentInset: 'never', scheme: 'Doodlehive', limitsNavigationsToAppBoundDomains: false },
};

export default config;
