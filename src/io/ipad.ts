// The iPad app's native plugins, as Capacitor injects them into the page. All null in a browser and on desktop.

type Listener<T> = (e: T) => void;
type Handle = { remove(): Promise<void> | void };
interface Plugin { addListener<T>(event: string, cb: Listener<T>): Promise<Handle> | Handle }

/** The system action iPadOS has set for a double-tap or squeeze (Settings → Apple Pencil). */
export type SystemPencilAction = 'ignore' | 'switchEraser' | 'switchPrevious' | 'showColorPalette' | 'showInkAttributes' | 'showContextualPalette' | 'runSystemShortcut';

/** A double-tap or squeeze; x/y (CSS pixels in the page) only when the Pencil hovers over the screen. */
export interface PencilGesture { action: SystemPencilAction; hover: boolean; x?: number; y?: number; z?: number; altitude?: number; azimuth?: number; roll?: number }

export interface NativeInfo { apns: 'sandbox' | 'production'; pencilOnly: boolean; hoverPreview: boolean; squeeze: boolean }

/** ipad/plugins/doodlehive */
export interface DoodlehivePlugin extends Plugin {
  info(): Promise<NativeInfo>;
  setBadge(o: { count: number }): Promise<void>;
}

type Permission = 'prompt' | 'prompt-with-rationale' | 'granted' | 'denied';
export interface PushAction { actionId: string; notification: { data?: Record<string, unknown> } }

/** @capacitor/push-notifications */
export interface PushPlugin extends Plugin {
  checkPermissions(): Promise<{ receive: Permission }>;
  requestPermissions(): Promise<{ receive: Permission }>;
  register(): Promise<void>;
  removeAllDeliveredNotifications(): Promise<void>;
}

/** @capacitor/filesystem and @capacitor/share, for exports through the share sheet. */
export interface FilesystemPlugin { writeFile(o: { path: string; data: string; directory: string }): Promise<{ uri: string }> }
export interface SharePlugin { share(o: { title?: string; files?: string[] }): Promise<unknown> }

const plugins = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean; Plugins?: Record<string, unknown> } }).Capacitor;
const get = <T>(name: string) => (plugins?.isNativePlatform?.() ? (plugins.Plugins?.[name] as T | undefined) ?? null : null);

export const ipad = {
  app: get<DoodlehivePlugin>('Doodlehive'),
  push: get<PushPlugin>('PushNotifications'),
  files: get<FilesystemPlugin>('Filesystem'),
  share: get<SharePlugin>('Share'),
};

/** addListener returns a handle or a promise of one depending on how the bridge was set up. */
export function listen<T>(p: Plugin, event: string, cb: Listener<T>) { void Promise.resolve(p.addListener(event, cb)); }
