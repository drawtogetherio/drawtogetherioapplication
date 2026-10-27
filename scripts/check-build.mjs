// Fails the build if a page is missing from dist/, so a broken build never replaces a working deploy.
import fs from 'node:fs';

const pages = ['dist/index.html', 'dist/login.html', 'dist/app.html', 'dist/admin.html', 'dist/404.html'];
const missing = pages.filter((p) => !fs.existsSync(p));
if (missing.length) {
  console.error('Build is missing pages: ' + missing.join(', '));
  process.exit(1);
}
console.log('Build has all pages: ' + pages.join(', '));

// Canvas logs are for the beta site only: a build for anywhere else must not contain them.
const env = process.env;
const beta = env.BETA ? env.BETA === '1' : (env.RAILWAY_ENVIRONMENT_NAME ?? '').toLowerCase() === 'beta' || /^https?:\/\/beta\./i.test(env.PUBLIC_URL ?? '');
const js = fs.readdirSync('dist/assets').filter((f) => f.endsWith('.js'));
const logged = js.filter((f) => fs.readFileSync(`dist/assets/${f}`, 'utf8').includes('doodlehive-canvas-log'));
if (!beta && logged.length) {
  console.error('Canvas logs ended up in a non-beta build: ' + logged.join(', '));
  process.exit(1);
}
if (beta && !logged.length) {
  console.error('Beta build is missing canvas logs');
  process.exit(1);
}
console.log(beta ? 'Beta build: canvas logs included' : 'Live build: no canvas logs');
