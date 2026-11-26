// Cloud storage: free accounts get a capped allowance on the server; premium has no cap.

/** The free allowance an admin hasn't changed yet (Admin → Site). */
export const DEFAULT_FREE_CLOUD_MB = 50;
export const FREE_CLOUD_MB_MAX = 100_000;
export const MB = 1024 * 1024;
/** Free accounts are warned from this share of the cap on. */
export const STORAGE_WARN_AT = 0.8;
/** The `field` of the 413 a cloud save gets when it doesn't fit. */
export const STORAGE_FULL = 'storage';

export interface CloudCanvas {
  id: string; name: string; bytes: number; updatedAt: number;
  visibility: 'private' | 'open' | 'friends' | 'unlisted';
  thumb: string | null;
}
export interface StorageInfo {
  used: number;
  /** Bytes allowed; null when there is no cap (premium). */
  cap: number | null;
  /** Biggest first. */
  canvases: CloudCanvas[];
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${Math.max(0, Math.round(n))} B`;
  if (n < MB) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * MB) return `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`;
  return `${(n / 1024 / MB).toFixed(1)} GB`;
}

/** 0..1+, or 0 without a cap. */
export const storageShare = (s: Pick<StorageInfo, 'used' | 'cap'>) => s.cap == null ? 0 : s.cap <= 0 ? (s.used > 0 ? Infinity : 1) : s.used / s.cap;
export const storageFits = (s: Pick<StorageInfo, 'used' | 'cap'>, need: number) => s.cap == null || s.used + need <= s.cap;
