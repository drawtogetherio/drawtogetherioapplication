// Turns the single-file build into page content for a claude.ai Artifact preview
// (the host supplies <html>/<head>/<body>, so we keep only title, styles, markup and script).
import fs from 'node:fs';
const html = fs.readFileSync('dist-single/index.html', 'utf8');
const styles = [...html.matchAll(/<style[^>]*>[\s\S]*?<\/style>/g)].map((m) => m[0]).join('\n');
const scripts = [...html.matchAll(/<script[^>]*>[\s\S]*?<\/script>/g)].map((m) => m[0]).join('\n');
const out = `<title>drawwith.us</title>\n${styles}\n<div id="app"></div>\n${scripts}\n`;
fs.mkdirSync('preview', { recursive: true });
fs.writeFileSync('preview/drawwithus.html', out);
console.log('preview/drawwithus.html', (out.length / 1024).toFixed(0) + ' KB');
