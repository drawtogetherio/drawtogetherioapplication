import type { CapacitorConfig } from '@capacitor/cli';

// The app shows doodlehive.net itself; the page detects the shell and keeps canvases with the Filesystem plugin,
// listens for Apple Pencil gestures through the Doodlehive plugin (plugins/doodlehive) and registers for push.
const config: CapacitorConfig = {
  appId: 'net.doodlehive.app',
  appName: 'Doodlehive',
  webDir: 'www',
  server: { url: process.env.DOODLEHIVE_URL || 'https://doodlehive.net/app', allowNavigation: ['doodlehive.net', '*.doodlehive.net', 'discord.com', '*.discord.com'] },
  ios: { contentInset: 'never', scheme: 'Doodlehive', limitsNavigationsToAppBoundDomains: false, appendUserAgent: 'DoodlehiveApp/iPad' },
  plugins: {
    // While the app is open the page shows its own notifications, so a push only updates the badge.
    PushNotifications: { presentationOptions: ['badge'] },
  },
};

export default config;
