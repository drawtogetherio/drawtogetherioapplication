import './site.css';
import { api } from '../net/api';
import { initTheme } from '../ui/theme';
import { APPLE_SVG, GLOBE_SVG, WINDOWS_SVG, brandHtml } from './brand';
import { esc } from './common';

initTheme();

const isMac = /Mac|iPhone|iPad/.test(navigator.platform) || /Mac OS/.test(navigator.userAgent);

function downloadButton(os: 'mac' | 'windows', url: string | null | undefined) {
  const label = `<span class="long">Download for </span>${os === 'mac' ? 'Mac' : 'Windows'}`;
  const icon = os === 'mac' ? APPLE_SVG : WINDOWS_SVG;
  if (url) return `<a class="btn" href="${esc(url)}">${icon}<span>${label}</span></a>`;
  return `<span class="btn" aria-disabled="true" title="Coming soon">${icon}<span>${label}</span><span class="soon">soon</span></span>`;
}

function render(downloads: { mac: string | null; windows: string | null } | undefined) {
  const dl = isMac
    ? downloadButton('mac', downloads?.mac) + downloadButton('windows', downloads?.windows)
    : downloadButton('windows', downloads?.windows) + downloadButton('mac', downloads?.mac);

  document.getElementById('site')!.innerHTML = `
  <main class="intro">
    <div class="intro-brand">${brandHtml('/')}</div>
    <h1>Drawing together with friends</h1>
    <p class="lede">Make a room, send the link, and you’re all drawing on the same canvas.</p>
    <div class="stage">
      <div class="cta-row"><a class="btn primary" href="/app">${GLOBE_SVG}<span>Open in browser</span></a>${dl}</div>
      ${scene()}
    </div>
    <p class="account-line" id="account-line">Already have an account? <a href="/login">Log in</a></p>
  </main>
  <footer class="intro-footer">© ${new Date().getFullYear()} Doodlehive</footer>`;
}

function scene() {
  return `<div class="mock" aria-hidden="true">
    <svg class="doodles" viewBox="0 0 960 540">
      <g fill="none" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="780" cy="150" r="58" fill="#f4c25b" stroke="#e8b13f" stroke-width="5"/>
        <path d="M780 62v-22M780 238v22M692 150h-22M868 150h22M718 88l-15-15M842 88l15-15M718 212l-15 15M842 212l15 15" stroke="#e8b13f" stroke-width="6"/>
        <path d="M760 140h.1M800 140h.1M762 166c10 10 26 10 36 0" stroke="#2b1f04" stroke-width="6"/>
        <path d="M120 150c-20-20-40 5 0 30 40-25 20-50 0-30" stroke="#e8578a" stroke-width="5"/>
        <path d="M210 430V320l65-58 65 58v110zM262 430v-50h30v50M300 340h24v22h-24z" stroke="#2b2b33" stroke-width="5"/>
        <path d="M40 440C200 370 360 390 520 440S760 470 860 418" stroke="#3fbf7f" stroke-width="7"/>
        <path d="M380 170C350 168 345 128 375 122 380 92 425 88 437 112 457 94 492 108 490 135 508 140 510 165 494 170" stroke="#5aa9ff" stroke-width="6"/>
        <path d="M640 440c-4-30 2-50 0-80" stroke="#3fbf7f" stroke-width="5"/>
        <circle cx="640" cy="316" r="14" stroke="#e8578a" stroke-width="5"/>
        <circle cx="618" cy="338" r="14" stroke="#e8578a" stroke-width="5"/>
        <path d="M662 324a14 14 0 1 1-2 28" stroke="#e8578a" stroke-width="5"/>
        <circle cx="640" cy="338" r="8" fill="#f4c25b" stroke="none"/>
      </g>
    </svg>
    <div class="mock-bubble" style="--c:#5aa9ff;left:51.5%;top:31.5%"><b>K</b>Kiwi</div>
    <div class="mock-bubble" style="--c:#e8578a;left:68.8%;top:65.2%"><b>M</b>Mochi</div>
    <div class="mock-bubble" style="--c:#3fbf7f;left:89.6%;top:77.4%"><b>P</b>Pasta</div>
    <div class="mock-chat">
      <span style="--c:#e8578a"><strong>Mochi</strong>flowers by the house?</span>
      <span style="--c:#5aa9ff"><strong>Kiwi</strong>on it, doing clouds</span>
    </div>
  </div>`;
}

async function main() {
  render(undefined);
  const cfg = await api.config();
  if (!cfg) return;
  if (cfg.downloads?.mac || cfg.downloads?.windows) render(cfg.downloads);
  const me = await api.me().catch(() => null);
  if (me) {
    document.getElementById('account-line')!.innerHTML =
      `Signed in as ${esc(me.displayName)}. <a href="/app">Open your canvases</a>`;
  }
}
main();
