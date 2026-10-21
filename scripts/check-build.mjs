// Fails the build if a page is missing from dist/, so a broken build never replaces a working deploy.
import fs from 'node:fs';

const pages = ['dist/index.html', 'dist/login.html', 'dist/app.html', 'dist/admin.html', 'dist/404.html'];
const missing = pages.filter((p) => !fs.existsSync(p));
if (missing.length) {
  console.error('Build is missing pages: ' + missing.join(', '));
  process.exit(1);
}
console.log('Build has all pages: ' + pages.join(', '));
