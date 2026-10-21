// Saving files: the web build downloads; native wrappers register their own handler.

export type SaveHandler = (blob: Blob, filename: string) => Promise<void>;

let handler: SaveHandler | null = null;

export function setSaveHandler(h: SaveHandler | null) { handler = h; }

export async function saveFile(blob: Blob, filename: string): Promise<void> {
  if (handler) return handler(blob, filename);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
