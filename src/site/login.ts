import './site.css';
import { ApiError, api } from '../net/api';
import { initTheme } from '../ui/theme';
import { DISCORD_SVG, LOGO_SVG, brandHtml } from './brand';
import { safeNext } from './common';

initTheme();

const params = new URLSearchParams(location.search);
const next = safeNext(params.get('next'));
const joining = /[?&]room=/.test(next);

async function main() {
  const root = document.getElementById('site')!;
  root.innerHTML = `
  <header class="site-header"><div class="header-left">${brandHtml('/')}</div></header>
  <main class="login-wrap">
    <div class="hive-bg"></div>
    <div class="login-card">
      ${LOGO_SVG}
      <h1>${joining ? 'Log in to join the room' : 'Log in to Doodlehive'}</h1>
      <p>${joining ? 'Your friend is waiting on the canvas.' : 'Draw with friends, keep your canvases, and pick up where you left off.'}</p>
      <div id="login-body"><p class="fine">Loading…</p></div>
    </div>
  </main>`;
  const body = document.getElementById('login-body')!;
  const cfg = await api.config();
  if (!cfg) { body.innerHTML = '<p class="login-error">Can’t reach the Doodlehive server right now. Please try again in a moment.</p>'; return; }
  // Already logged in? Go straight on.
  if (await api.me().catch(() => null)) { location.replace(next); return; }

  body.innerHTML = '';
  if (params.get('error')) body.insertAdjacentHTML('beforeend', '<p class="login-error" role="alert">Discord login didn’t finish. Please try again.</p>');
  if (cfg.discord) {
    const a = document.createElement('a');
    a.className = 'btn discord';
    a.href = api.discordUrl(next);
    a.innerHTML = `${DISCORD_SVG}<span>Continue with Discord</span>`;
    body.append(a);
    body.insertAdjacentHTML('beforeend', '<p class="fine">We only use your Discord name to set up your account. No password needed, and we never post anything.</p>');
  } else if (!cfg.devLogin) {
    body.insertAdjacentHTML('beforeend', '<p class="login-error">Login isn’t switched on yet. Check back soon!</p>');
  }
  if (cfg.devLogin) {
    const form = document.createElement('form');
    form.className = 'dev-login';
    form.innerHTML = `<label for="dev-name">Testing: log in as anyone</label>
      <div class="row"><input id="dev-name" type="text" maxlength="32" placeholder="Any name" autocomplete="off" required><button class="btn small" type="submit">Dev login</button></div>
      <p class="login-error" role="alert" hidden></p>`;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = form.querySelector('.login-error') as HTMLElement;
      try {
        await api.devLogin((form.querySelector('#dev-name') as HTMLInputElement).value);
        location.replace(next);
      } catch (ex) { err.hidden = false; err.textContent = (ex as ApiError).message; }
    });
    body.append(form);
  }
  if (joining) body.append(guestForm());
  else body.insertAdjacentHTML('beforeend', '<p class="login-alt">Just want to sketch? <a href="/app?offline=1">Draw without an account</a></p>');
}

/** Joining a friend's room without Discord: pick a name, get a random handle. */
function guestForm() {
  const form = document.createElement('form');
  form.className = 'guest-login';
  form.innerHTML = `<div class="or"><span>or join as a guest</span></div>
    <label for="guest-name">Your name in the room</label>
    <div class="row"><input id="guest-name" type="text" maxlength="32" placeholder="What should friends call you?" autocomplete="nickname" required><button class="btn small" type="submit">Join as guest</button></div>
    <p class="fine">Guests get a random handle like @SketchyPasta. Log in with Discord to keep your canvases, add friends and choose your own handle.</p>
    <p class="login-error" role="alert" hidden></p>`;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = form.querySelector('.login-error') as HTMLElement;
    try {
      await api.guestLogin((form.querySelector('#guest-name') as HTMLInputElement).value);
      location.replace(next);
    } catch (ex) { err.hidden = false; err.textContent = (ex as ApiError).message; }
  });
  return form;
}
main();
