import './site.css';
import { api } from '../net/api';
import { initTheme } from '../ui/theme';
import { APPLE_SVG, GLOBE_SVG, WINDOWS_SVG, brandHtml } from './brand';
import { esc, headerUser } from './common';

initTheme();

const isMac = /Mac|iPhone|iPad/.test(navigator.platform) || /Mac OS/.test(navigator.userAgent);

const ICON = {
  room: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="15" rx="3"/><path d="M12 8.5v7M8.5 12h7"/></svg>',
  link: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
  draw: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20c4-1 5-4 9-9l4-4 3 3-4 4c-5 4-8 5-9 9"/><path d="M15 6l3 3"/></svg>',
};

function downloadButton(os: 'mac' | 'windows', url: string | null | undefined) {
  const label = os === 'mac' ? 'Download for Mac' : 'Download for Windows';
  const icon = os === 'mac' ? APPLE_SVG : WINDOWS_SVG;
  if (url) return `<a class="btn" href="${esc(url)}">${icon}<span>${label}</span></a>`;
  return `<span class="btn" aria-disabled="true" title="The desktop app is on its way">${icon}<span>${label}</span><span class="soon">soon</span></span>`;
}

function render(downloads: { mac: string | null; windows: string | null } | undefined) {
  const dl = isMac
    ? downloadButton('mac', downloads?.mac) + downloadButton('windows', downloads?.windows)
    : downloadButton('windows', downloads?.windows) + downloadButton('mac', downloads?.mac);
  const ctas = `<a class="btn primary" href="/app">${GLOBE_SVG}<span>Open in browser</span></a>${dl}`;

  document.getElementById('site')!.innerHTML = `
  <header class="site-header">
    <div class="header-left">${brandHtml('/')}</div>
    <div class="header-right" id="header-right"><a class="btn small primary" href="/login">Log in</a></div>
  </header>

  <main>
    <section class="hero">
      <div class="hive-bg"></div>
      <div class="hero-inner">
        <div>
          <span class="eyebrow">One canvas, all your friends</span>
          <h1>Drawing together <em>with friends</em></h1>
          <p class="lede">Start a room, send the link, and watch everyone’s strokes show up live on the same canvas.
            Each person gets their own layers, so nobody draws over your work.</p>
          <div class="cta-row">${ctas}</div>
          <p class="cta-note">Works with Apple Pencil, Wacom and other pens, plus a mouse or finger.</p>
        </div>
        ${mockCanvas()}
      </div>
    </section>

    <section class="section" id="how">
      <h2>From “wanna draw?” to drawing in seconds</h2>
      <p class="sub">No setup and no file juggling. Log in with Discord, make a room, and your friends are one click away.</p>
      <div class="steps">
        <div class="step">
          <div class="step-icon">${ICON.room}</div>
          <h3>Create a room</h3>
          <p>Pick a canvas size, or go unlimited like a whiteboard, and you’re in.</p>
        </div>
        <div class="step">
          <div class="step-icon">${ICON.link}</div>
          <h3>Share the link</h3>
          <p>Copy the invite link and drop it in your group chat or Discord server.</p>
          <div class="share-demo"><span>doodlehive.net/app?room=k7mq2xpa</span><b>Copied</b></div>
        </div>
        <div class="step">
          <div class="step-icon">${ICON.draw}</div>
          <h3>Draw together</h3>
          <p>See where friends are drawing, chat in the corner, and keep going whenever you like. Your canvases are saved.</p>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="features">
        <div class="feature"><strong>Pen pressure</strong><span>Size and opacity follow your pen, with smoothing for clean lines.</span></div>
        <div class="feature"><strong>Your own layers</strong><span>Everyone gets a folder in their favourite colour. Hosts can tidy up.</span></div>
        <div class="feature"><strong>Draw alone too</strong><span>Private canvases for solo sketching, saved to your account.</span></div>
        <div class="feature"><strong>Take it with you</strong><span>Export PNG, JPG or a layered PSD with everyone’s layers.</span></div>
      </div>
    </section>

    <div class="cta-band">
      <h2>Ready to doodle?</h2>
      <p>Open Doodlehive in your browser now, or grab the desktop app.</p>
      <div class="cta-row">${ctas}</div>
    </div>
  </main>

  <footer class="site-footer">
    <span>© ${new Date().getFullYear()} Doodlehive</span>
    <span><a href="/app">Open app</a> · <a href="/login">Log in</a></span>
  </footer>`;
}

function mockCanvas() {
  return `<div class="mock" aria-hidden="true">
    <div class="mock-bar"><i></i><i></i><i></i></div>
    <svg class="doodles" viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice">
      <path d="M70 210c18-60 52-92 92-88s48 52 18 70-62-8-40-40 82-40 112-10" fill="none" stroke="#2b2b33" stroke-width="5" stroke-linecap="round"/>
      <path d="M232 92c24-14 56-8 70 14s2 52-22 58" fill="none" stroke="#e8578a" stroke-width="7" stroke-linecap="round"/>
      <circle cx="300" cy="196" r="34" fill="#f4c25b" opacity=".85"/>
      <path d="M286 192c4 6 10 8 16 6M290 182h.1M308 182h.1" fill="none" stroke="#2b1f04" stroke-width="4" stroke-linecap="round"/>
      <path d="M120 250c30 8 70 6 104-4" fill="none" stroke="#3fbf7f" stroke-width="6" stroke-linecap="round"/>
    </svg>
    <div class="mock-bubble" style="--c:#e8578a;left:75%;top:52%"><b>M</b>Mochi</div>
    <div class="mock-bubble" style="--c:#3fbf7f;left:56%;top:81%"><b>P</b>Pasta</div>
    <div class="mock-chat">
      <span style="--c:#e8578a"><strong>Mochi</strong>add a sun?</span>
      <span style="--c:#3fbf7f"><strong>Pasta</strong>on it ☀️</span>
    </div>
  </div>`;
}

async function main() {
  const cfg = await api.config();
  render(cfg?.downloads);
  if (!cfg) return;
  const me = await api.me().catch(() => null);
  if (me) document.getElementById('header-right')!.replaceChildren(headerUser(me));
}
main();
