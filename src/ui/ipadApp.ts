import type { App } from './app';
import { api } from '../net/api';
import { ipad, listen, PushAction } from '../io/ipad';
import { setSaveHandler } from '../io/platform';
import { pencilGestures } from './pencil';

// What only the iPad app does: Pencil gestures, exports through the share sheet (Photos, Files, AirDrop)
// and push notifications for friend requests and invites. Nothing here runs in a browser.

export function startIpad(app: App) {
  pencilGestures(app);
  const { files, share } = ipad;
  if (files && share) {
    setSaveHandler(async (blob, filename) => {
      const name = filename.replace(/[/\\:]/g, '-');
      const { uri } = await files.writeFile({ path: name, data: await base64(blob), directory: 'CACHE' });
      try { await share.share({ title: name, files: [uri] }); } catch (e) { if (!/cancel/i.test(String((e as Error)?.message))) throw e; }
    });
  }
}

const base64 = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

let token: string | null = null;

/** Asks once for permission, then sends this iPad's token to the server so notices arrive as pushes. */
export async function registerPush(app: App) {
  const push = ipad.push;
  if (!push || !ipad.app) return;
  listen<{ value: string }>(push, 'registration', async ({ value }) => {
    token = value;
    const { apns } = await ipad.app!.info().catch(() => ({ apns: 'sandbox' as const }));
    api.addDevice(value, apns).catch(() => { token = null; });
  });
  listen<PushAction>(push, 'pushNotificationActionPerformed', (a) => {
    const d = a.notification.data ?? {};
    if (d.kind === 'invite' && typeof d.room === 'string') { if (app.ed.room?.id !== d.room) app.session.joinRoom(d.room); }
    else if (app.home.visible) app.home.openNotices();
    else app.home.loadNotices();
  });
  let { receive } = await push.checkPermissions();
  if (receive === 'prompt' || receive === 'prompt-with-rationale') ({ receive } = await push.requestPermissions());
  if (receive === 'granted') await push.register();
}

/** On log out: this iPad stops getting the account's pushes. */
export async function forgetPush() {
  if (!token) return;
  await api.removeDevice(token).catch(() => {});
  token = null;
  await badge(0);
}

/** The number on the app icon follows the unread notices; reading them clears the lock screen too. */
export async function badge(count: number) {
  await ipad.app?.setBadge({ count }).catch(() => {});
  if (!count) await ipad.push?.removeAllDeliveredNotifications().catch(() => {});
}
