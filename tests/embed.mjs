// Invite link embeds: Open Graph tags name who shared the link and show the canvas. Needs the server with dev login.
// Usage: node tests/embed.mjs [http://localhost:8787]
import { chromium } from '@playwright/test';

const base = (process.argv[2] ?? 'http://localhost:8787').replace(/\/$/, '');
let failed = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++; };
const suffix = Math.floor(Math.random() * 1e6);
const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(body) });
const login = async (name) => { const r = await post('/auth/dev', { name }); return { cookie: (r.headers.get('set-cookie') ?? '').split(';')[0], me: await r.json() }; };
const bot = { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' } };
const meta = (html, k) => html.match(new RegExp(`<meta property="${k}" content="([^"]*)"`))?.[1];

const ren = await login('Ren' + suffix), sam = await login('Sam' + suffix);
const room = await (await post('/api/rooms', { name: 'Dragons', settings: { infinite: true }, share: { visibility: 'open' } }, { Cookie: ren.cookie })).json();
// A 2×2 PNG stands in for the canvas thumbnail.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGP4z8DwHwYBABIBA/0t7cyoAAAAAElFTkSuQmCC', 'base64');
let r = await fetch(`${base}/api/rooms/${room.id}/thumb`, { method: 'PUT', headers: { Cookie: ren.cookie, Origin: base }, body: png });
check(r.ok, 'the owner uploads a thumbnail');

r = await fetch(`${base}/app?room=${room.id}&by=${ren.me.handle}`, bot);
let html = await r.text();
check(r.status === 200 && meta(html, 'og:title') === `${ren.me.displayName} has invited you to draw!`, 'the invite link embeds with the sharer’s name in the title');
check(meta(html, 'og:description') === `${ren.me.displayName} has invited you to draw on DoodleHive! No account needed just click to join!`, 'and the description');
check(meta(html, 'og:image') === `${base}/og/${room.id}?v=1` && meta(html, 'twitter:card') === 'summary_large_image', 'with the canvas image, versioned so chat apps refetch it');
r = await fetch(meta(html, 'og:image'), bot);
check(r.ok && r.headers.get('content-type') === 'image/png' && Buffer.from(await r.arrayBuffer()).equals(png), 'the image route serves the thumbnail without a login');
html = await (await fetch(`${base}/app?room=${room.id}&by=${sam.me.handle}`, bot)).text();
check(meta(html, 'og:title').startsWith(sam.me.displayName), 'a member who shares the link is named instead');
html = await (await fetch(`${base}/app?room=${room.id}&by=nobody-${suffix}`, bot)).text();
check(meta(html, 'og:title').startsWith(ren.me.displayName), 'an unknown handle falls back to the owner');
html = await (await fetch(`${base}/app?room=${room.id}&watch=abcdefghijklmnop`, bot)).text();
check(meta(html, 'og:title') === `${ren.me.displayName} has invited you to watch them draw!`, 'watch links say so');

const secret = await (await post('/api/rooms', { name: 'Secret', settings: { infinite: true }, share: { visibility: 'private' } }, { Cookie: ren.cookie })).json();
await fetch(`${base}/api/rooms/${secret.id}/thumb`, { method: 'PUT', headers: { Cookie: ren.cookie, Origin: base }, body: png });
const card = Buffer.from(await (await fetch(`${base}/og.png`)).arrayBuffer());
r = await fetch(`${base}/og/${secret.id}`, bot);
check(r.ok && Buffer.from(await r.arrayBuffer()).equals(card) && card.length > 1000, 'a private room’s embed shows the Doodlehive card, never the canvas');
r = await fetch(`${base}/og/nope`, bot);
check(r.ok && Buffer.from(await r.arrayBuffer()).equals(card), 'so does an unknown room');
html = await (await fetch(`${base}/app?room=${room.id}`, { headers: { Cookie: sam.cookie } })).text();
check(html.includes('<script') && meta(html, 'og:title') && !html.includes('</head>\n  <meta'), 'people opening the link still get the app page');

// The link the app copies carries the sharer's handle.
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const ctx = await browser.newContext();
await fetch(`${base}/api/me`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ren.cookie, Origin: base }, body: JSON.stringify({ done: true }) });
await ctx.addCookies([{ name: 'dw_session', value: ren.cookie.split('=')[1], url: base }]);
const page = await ctx.newPage();
await page.goto(`${base}/app?room=${room.id}`);
await page.waitForFunction(() => window.doodlehive?.ed.room?.status === 'open');
check((await page.evaluate(() => window.doodlehive.session.inviteLink())) === `${base}/app?room=${room.id}&by=${ren.me.handle}`, 'Copy invite link adds the sharer’s handle');
check(!(await page.evaluate(() => location.search.includes('by='))), 'opening a link drops it from the address bar');
await browser.close();

if (failed) process.exit(1);
console.log('all passed');
