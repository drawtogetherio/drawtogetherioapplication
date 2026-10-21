import './site.css';
import { initTheme } from '../ui/theme';
import { LOGO_SVG, brandHtml } from './brand';

// 404: unknown paths, rooms you can't see, and /admin for anyone who isn't one. Says nothing about which.

initTheme();
document.getElementById('site')!.innerHTML = `
  <header class="site-header"><div class="header-left">${brandHtml('/')}</div></header>
  <main class="login-wrap">
    <div class="hive-bg"></div>
    <div class="login-card lost">
      ${LOGO_SVG}
      <p class="code">404</p>
      <h1>Page not found</h1>
      <p>There’s nothing at this address.</p>
      <div class="row"><a class="btn primary" href="/app">Open the app</a><a class="btn" href="/">Home</a></div>
    </div>
  </main>`;
