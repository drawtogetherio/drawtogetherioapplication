export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function safeNext(next: string | null): string {
  return next && /^\/(?![/\\])/.test(next) ? next : '/app';
}
