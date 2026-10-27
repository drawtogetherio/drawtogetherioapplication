import './markdown.css';
import { art, hasArt } from './art';
import { hasIcon, icon } from './icons';
import { esc } from '../site/common';

// A small markdown renderer for What's new. Everything an admin types is escaped; only the tags below come out.
// Extras: [accent]…[/accent] colours text with the theme accent (a whole block when on its own lines),
// [icon:name] drops in an app icon, [art:name] a flat graphic (a figure when alone on a line).

const safeHref = (u: string) => (/^(https?:\/\/|mailto:)/i.test(u) || /^\/(?![/\\])/.test(u) ? u : null);

function span(s: string): string {
  // Already escaped. Code spans stay literal.
  return s.split(/(`[^`]+`)/).map((part, i) => {
    if (i % 2) return `<code>${part.slice(1, -1)}</code>`;
    return part
      .replace(/\[icon:([a-zA-Z]+)\]/g, (m, n) => (hasIcon(n) ? `<i class="md-icon">${icon(n, 20)}</i>` : m))
      .replace(/\[art:([a-z]+)\]/g, (m, n) => (hasArt(n) ? `<i class="md-art">${art(n, 32)}</i>` : m))
      .replace(/\[accent\]/g, '<span class="md-accent">').replace(/\[\/accent\]/g, '</span>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => {
        const u = safeHref(href);
        return u ? `<a href="${u}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
      })
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/~~(.+?)~~/g, '<s>$1</s>')
      .replace(/(^|[\s(])\*(?!\s)(.+?)\*/g, '$1<em>$2</em>')
      .replace(/(^|[\s(])_(?!\s)(.+?)_(?=$|[\s.,!?)])/g, '$1<em>$2</em>');
  }).join('');
}

function inline(lines: string[]): string {
  let out = lines.map((l) => span(esc(l.trim()))).join('<br>');
  const open = (out.match(/<span class="md-accent">/g) ?? []).length, close = (out.match(/<\/span>/g) ?? []).length;
  for (let i = close; i < open; i++) out += '</span>';
  return out;
}

const RULE = /^(-{3,}|\*{3,})$/, HEAD = /^(#{1,3})\s+(.+)/, UL = /^[-*]\s+/, OL = /^\d+[.)]\s+/, QUOTE = /^>\s?/;
const blockStart = (l: string) => !l.trim() || RULE.test(l) || HEAD.test(l) || UL.test(l) || OL.test(l) || QUOTE.test(l) || /^\[\/?accent\]$/.test(l.trim()) || /^\[art:[a-z]+\]$/.test(l.trim());

export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let depth = 0;
  const take = (test: RegExp, i: number) => { const got: string[] = []; while (i < lines.length && test.test(lines[i])) got.push(lines[i++].replace(test, '')); return [got, i] as const; };
  for (let i = 0; i < lines.length;) {
    const l = lines[i], t = l.trim();
    let m: RegExpExecArray | null;
    if (!t) { i++; continue; }
    if (t === '[accent]') { out.push('<div class="md-accent">'); depth++; i++; continue; }
    if (t === '[/accent]') { if (depth) { out.push('</div>'); depth--; } i++; continue; }
    if ((m = /^\[art:([a-z]+)\]$/.exec(t)) && hasArt(m[1])) { out.push(`<figure class="md-figure">${art(m[1], 96)}</figure>`); i++; continue; }
    if (RULE.test(t)) { out.push('<hr>'); i++; continue; }
    if ((m = HEAD.exec(l))) { out.push(`<h${m[1].length}>${span(esc(m[2].trim()))}</h${m[1].length}>`); i++; continue; }
    if (UL.test(l) || OL.test(l)) {
      const ol = OL.test(l), [items, next] = take(ol ? OL : UL, i);
      out.push(`<${ol ? 'ol' : 'ul'}>${items.map((x) => `<li>${inline([x])}</li>`).join('')}</${ol ? 'ol' : 'ul'}>`);
      i = next; continue;
    }
    if (QUOTE.test(l)) { const [q, next] = take(QUOTE, i); out.push(`<blockquote>${inline(q)}</blockquote>`); i = next; continue; }
    const para: string[] = [l];
    for (i++; i < lines.length && !blockStart(lines[i]); i++) para.push(lines[i]);
    out.push(`<p>${inline(para)}</p>`);
  }
  while (depth--) out.push('</div>');
  return out.join('');
}
