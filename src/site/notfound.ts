import './site.css';
import { initTheme } from '../ui/theme';
import { LOGO_SVG, brandHtml } from './brand';

// 404: unknown paths, private rooms, and /admin for anyone who isn't one.

initTheme();
document.getElementById('site')!.innerHTML = `
  <header class="site-header"><div class="header-left">${brandHtml('/')}</div></header>
  <main class="login-wrap">
    <div class="hive-bg"></div>
    <div class="login-card lost">
      ${LOGO_SVG}
      <p class="code">404</p>
      <h1>Nothing to draw here</h1>
      <p>This page doesn’t exist, or it’s a private canvas you weren’t invited to.</p>
      <div class="row"><a class="btn primary" href="/app">Open the app</a><a class="btn" href="/">Home</a></div>
    </div>
  </main>`;
