import type { Op } from '../core/model';
import type { LocalCanvas } from './localStore';
import { capacitorBridge } from './capacitorStore';

/** Canvas metadata as the native shells store it: the thumbnail travels as bytes. */
export type NativeCanvas = Omit<LocalCanvas, 'thumb'> & { thumb: { type: string; bytes: Uint8Array } | null };

/** What the desktop app's preload script exposes to the page. */
export interface NativeBridge {
  platform: 'windows' | 'mac' | 'linux';
  version: string;
  canvases: {
    list(user: string): Promise<NativeCanvas[]>;
    get(id: string): Promise<NativeCanvas | null>;
    put(c: NativeCanvas): Promise<void>;
    loadOps(id: string): Promise<Op[]>;
    appendOps(id: string, ops: Op[]): Promise<void>;
    replaceOps(id: string, ops: Op[]): Promise<void>;
    delete(id: string): Promise<void>;
  };
}

const w = window as unknown as { doodlehiveNative?: NativeBridge; Capacitor?: { isNativePlatform?: () => boolean; Plugins?: { Filesystem?: object } } };
const cap = w.Capacitor?.isNativePlatform?.() && w.Capacitor.Plugins?.Filesystem;
export const native: NativeBridge | null = w.doodlehiveNative ?? (cap ? capacitorBridge(cap as Parameters<typeof capacitorBridge>[0]) : null);
/** Inside the desktop or iPad app, where device storage is permanent. */
export const isNativeApp = !!native;
