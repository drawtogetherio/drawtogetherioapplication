# Doodlehive

https://doodlehive.net

A drawing app for web, Windows, Mac and iPad where people can draw on the same canvas together.

## Run it

```bash
npm install
cp server/.env.example server/.env   # optional: add Discord keys here (see below)
npm run dev                          # site on http://localhost:5173 (app at /app), server on :8787
```

`npm run dev` starts both the web app (Vite) and the server. Without Discord keys the login page
offers **Dev login** (type any name), which is handy for testing with two browser windows.
The app also still works with no server at all: it just skips login and draws offline.

Pages:
- `/` landing page: brand, Log in, "Drawing together with friends", Open in browser + Mac/Windows downloads
  (the download buttons say "soon" until `DOWNLOAD_MAC_URL` / `DOWNLOAD_WINDOWS_URL` are set)
- `/login` login with Discord (plus Dev login locally); `?next=` returns you where you were
- `/app` the app. Logged out, it sends you to `/login`. `/app?room=code` opens a room; `/app?offline=1`
  draws without an account. Desktop clients should open `https://doodlehive.net/app`.

Other commands:

```bash
npm run build          # production web build in dist/
npm start              # run the server; it also serves dist/ on PUBLIC_URL (see DEPLOY.md for Railway)
npm run typecheck      # client + server
npm run build:preview  # one self-contained offline HTML file in preview/
npm run admin -- users                          # list accounts
npm run admin -- premium SomeHandle 30           # premium for 30 days (or "forever" / "off")
```

### Discord login

1. Create an application named **Doodlehive** at https://discord.com/developers/applications.
2. Under **OAuth2**, add the redirect `http://localhost:8787/auth/discord/callback`
   (in production: `https://doodlehive.net/auth/discord/callback`, with `PUBLIC_URL=https://doodlehive.net`).
3. Put the **Client ID** and **Client Secret** in `server/.env`. Never commit that file.
4. Restart `npm run dev`. Dev login turns off automatically once Discord is configured
   (force it with `DEV_LOGIN=1` or `0`).

Only the `identify` scope is requested: we read the Discord user id and name, nothing else.

## Features

**Drawing (v0.1)**
- Fixed or **Unlimited** canvas; brush/eraser presets with pen pressure, smoothing, hardness, flow; **Smudge** (S) drags and blends paint in place
- **Brush library (v0.21)**: one library in categories (General, Pencil, Pen, Eraser) that brush, eraser and
  smudge all pick from (`src/engine/brush.ts`, `BRUSH_LIBRARY`). Graphite, crayon, charcoal and the flat
  brush carry **grain**: a seeded paper texture fixed to the canvas, so every device renders the same
  speckle and strokes line up; the Grain slider in the options bar tunes it. Cube, flat and chisel brushes
  have a square tip. Dragging the Size or Opacity slider shows a preview of the brush at that size.
- **Layer effects** (canvas menu or the layers panel's ✦): Gaussian blur, motion blur, mosaic, chromatic
  aberration, glitch, sharpen and noise. Each is one `effect` op, computed with plain arithmetic in a fixed
  order (`src/engine/effects.ts`) so every client bakes the same pixels; nothing is re-applied per frame.
- Selection (rect/ellipse/lasso) with move/rotate/scale/flip; fill bucket; shapes; eyedropper
- Procreate-style brush library (tap the selected brush/eraser) with pressure-stroke previews; icon drop-downs for selection and shape modes
- R + drag rotates the view (Shift snaps 15°), Z + drag zooms
- Flip/pan/zoom/rotate view, undo/redo (incl. two/three-finger taps), HSV colour picker
- Layers with 17 blend modes, opacity, lock transparency, merge, clear; folders
- Export PNG, JPG and layered PSD (folders become PSD groups)

**Themes**
- Default **Honey** (soft yellow) accent is the free theme. Premium unlocks the other swatches and a
  custom colour (`custom:#rrggbb`, derived hover/tint/text in `findTheme`). Switch in Preferences →
  Appearance; saved to the account when logged in, otherwise on the device.
- Themes live in `src/shared/themes.ts` (accent, hover, tint, text-on-accent). Add one there and it
  shows up. The server enforces the premium lock.

**Accounts (v0.2)**
- Discord login creates the account; no passwords stored
- First login opens profile setup: picture, display name, handle, profile colour, socials
- Handles: people with an account pick any free handle (2–32 letters, numbers, `_`, `.` and `-`, unique
  ignoring case), with a live availability check. New Discord accounts start with their Discord username
  (plus a number if it's taken).
- Guests: someone opening an invite link can **Join as guest** without Discord. They get a random
  `<ArtWord><Food>-<4 digits>` handle (e.g. `@BurntoutPasta-4821`, checked for clashes), can draw in rooms they're invited to, and can't make
  canvases, add friends or choose a handle. Guests are temporary: the cookie ends with the browser, the
  session lasts 3 hours past their last activity, and the account is removed at the next sweep after
  that (`server/sweep.ts`, every 10 minutes; admins can also sweep from the dashboard).
- Display names: anything up to 32 characters. Zalgo/stacked accents, invisible and control
  characters, and fancy-Unicode tricks are cleaned out (checked on the server too).
- Uploading a picture opens a cropper (drag to move; slider, scroll or pinch to zoom), then it's cut to a 128×128 square and compressed (WebP, ~1–10 KB) in the browser before
  upload; animated images become static. The server rejects anything over 48 KB.
- Links to Twitter, Instagram, YouTube, DeviantArt, Bluesky, Twitch, ArtStation, TikTok, Tumblr,
  pixiv: just a typed username, nothing connected.
- Profile colour as a 6-digit hex (no alpha)
- `premium` + `premium_until` stored per user for later; set with `npm run admin`

**Home screen (v0.5)**
- Friends on the left, online first (seen in the last ~75 s), with presence dots and status messages.
  Add by @handle, accept/decline requests. Premium friends show the star, their name gradient and GIF avatar.
- Recent canvases in the middle with thumbnails; the first tile is always **Create new**: choose
  **Draw alone** (a private canvas), **Shared room**, or paste a room link or code to join one.
- **Where canvases live (v0.19).** Free accounts keep their canvases in the browser (IndexedDB), so
  they only exist on that device and the server stores nothing for them. Premium accounts keep
  canvases on the server, so every device sees them. A tile from the other side moves when opened:
  a free account opening an old server canvas brings it to the device; a premium account opening a
  device canvas uploads it to the account. Server canvases of free owners that go unused for 30 days
  are deleted. Browsers may evict site data when the device is low on space (Safari after 7 days
  without a visit), so a free account's canvases are only as safe as the device.
- Sharing from a device canvas opens a **live-only room** seeded with the drawing. Everyone in it
  keeps a copy on their own device as they draw. When the host leaves (or drops) the room stays up
  for `EPHEMERAL_GRACE_MS` (2 minutes) so they can come back; then everyone is told the host left,
  their copy stays, and the room is deleted from the server. **Stop sharing** in the canvas menu
  ends it right away; the host keeps drawing on their copy.
- Server canvases are rooms. Private ones only open for their owner; share one any time from the
  canvas or the tile's ⋯ menu (rename, share, make private, delete).
- Sharing asks who can join: **Open link** (switches: logged-in users only, friends can join from
  their list, approve each join), **Friends only**, or **Unlisted** (friends just see you online).
  With approval on, hosts get "<name> wants to join the session" in chat with Allow / Deny.
- Friends in an open or friends-only room show a **Join** button. Hosts invite friends from the
  dock (person+ icon); invited friends get a toast and skip approval.
- The dock's link button opens **Share links**: the draw link, the room code (paste it on the home
  screen) and a **watch link** (`?room=code&watch=key`). Watchers see the canvas and chat but get no
  tools, undo, layers or export; they can be removed like anyone else. The key is only sent to hosts.
- A bell by the account button counts unread notifications: friend requests (accept or decline
  right there), accepted requests, room invites (Join) and system notices such as premium ending
  within a day. They arrive live over the event stream; the server keeps the last 100 per person.
- A honey banner at the top of the home screen links to Patreon (`PATREON_URL`, default
  patreon.com/doodlehive). It shows once per browser session; its X hides it for good (saved with
  the preferences).
- **Preferences** (account menu, or the canvas menu's cog) in four groups: Appearance (theme, Dark /
  Light / System), Canvas (brush outline on hover, name bubbles, draw with a finger), Pressure (a
  Simple slider or an Advanced graph: drag points, click to add, drag off to remove; `src/shared/curve.ts`)
  and Shortcuts (click a key, press a new one). Saved on the account, so they follow you between
  devices; offline they stay on the device.
- A premium name gradient replaces the profile colour everywhere: avatar ring, bubble outline while
  drawing, layer folder, profile card (no swatch), and the colour field in Edit profile.
- Presence on your card: Online, Away, Do not disturb, Offline (invisible). Friends see changes
  live over `/api/events` (Server-Sent Events).
- Status message (80 characters) on your card. Premium: name gradient and an animated GIF avatar (≤768 KB, ≤512 px).

**Admin dashboard**
- `/admin` is only served to admins; everyone else gets the 404 page (`404.html`), as does any
  unknown path, an unknown room, or a private room you weren't let into. The first admins come from the
  `ADMIN_HANDLES` variable or `npm run admin -- admin <handle> on`; admins can promote others there.
- Overview: online now, people in rooms, live rooms, accounts, premium, new today, guests, bans, plus
  running totals of strokes, smudges, fills, shapes, undos, redos and chat messages drawn in rooms
  (`server/stats.ts`, batched to the `stats` table every 10 s).
- Users: search and filter, then manage: premium (30 days, a year, forever, off), badges (Staff,
  Supporter, Featured artist, Early bee, shown next to the name), rename, clear status, remove avatar,
  sign out everywhere, make admin, ban/unban, ban their address, delete the account and its canvases.
- IP bans: a banned address gets a plain 403 everywhere, sockets included. Every action is in the Log.
- Addresses: each signed-in person's current address is kept in memory only (never stored) so an
  admin can ban it; only admins see it. The ban list itself is stored.

**Shared rooms (v0.2)**
- Start a room, share the invite link (`?room=code`), others join after logging in
- Each person gets a folder named after them, coloured with their favourite colour. Their layers
  (and any sub-folders they make) live there.
- Everyone can only edit their own layers. The room owner and hosts they appoint can edit anyone's
  layers (moderation) and remove people (blocked from rejoining for 10 minutes).
- Live strokes: you see others' strokes as they draw, with a name bubble (picture + display name)
  pointing at their pen. Bubbles can be turned off in the menu.
- Setting to hide other people's folders from your Layers panel
- Member list with badges: crown = owner, shield = host, star = premium (all shown together).
  Tap someone to see their profile and links. Badges are SVG, not emoji.
- Chat in the bottom-left (press Enter), with typing indicators; messages fade when chat is closed
- Undo/redo works in rooms (undo is just another change sent to everyone)

## Architecture

```
src/core/      document model: ops, layers + folders, tiled surfaces, undo history
src/engine/    brush dabs, flood fill, shapes, selection transforms, layer compositing
src/view/      viewport (pan/zoom/rotate/flip), screen renderer, pointer + gesture input
src/tools/     brush/eraser, smudge, fill, select/transform, shapes, eyedropper
src/ui/        app shell, layers panel, dialogs, profile editor, room UI (members, chat, bubbles), session
src/net/       HTTP API client, room WebSocket client
src/shared/    code used by both client and server: profile rules, handle words, wire protocol
src/io/        PNG/JPG/PSD export, platform save adapter
server/        Node server: Discord OAuth, sessions, profiles, avatars, rooms (SQLite + WebSockets)
```

**Ops.** Every canvas change is a small deterministic JSON `Op`. `DrawDoc.apply()` returns the
inverse ops, so undo/redo are ops too and sync like anything else. Replaying the log reproduces
the canvas pixel for pixel (`tests/replay.mjs`).

**Device canvases.** `src/io/localStore.ts` keeps canvases and their op logs in IndexedDB per
account; `LocalCopy` appends each op as it happens and makes thumbnails. A live-only room
(`rooms.ephemeral`) is created with the device copy's ops as its seed, and every member's copy is
rebuilt from the room's history on each (re)connect and then follows it op by op.

**Rooms.** The server keeps each room's op log (in SQLite) and is the authority on who owns what:
it stamps the author/owner on each op and rejects edits to someone else's layer unless the sender
is a host. Clients apply their own changes immediately and the server relays them to everyone else;
if the server ever rejects one, that client reloads the room state. In-progress strokes are streamed
separately (~30 times a second) so others see them before they're finished.

**Database.** SQLite via Node's built-in `node:sqlite` (Node 22.5+), file at `server/data/`.
Easy to move to Postgres later; all queries are in `server/db.ts`.

**Safety.** Everything goes through the server; people never connect to each other, so nobody can see
anyone's address. Addresses are only used in memory to rate limit (guest sign-ups, logins, uploads,
friend requests, room creation, sockets) and to let admins ban one; they are never stored or logged,
apart from the admin ban list. Every room message is checked
for shape and size before it is saved or relayed (`server/validate.ts`); cross-site requests and
sockets are refused; pages carry a content security policy and anti-framing headers; cookies are
HttpOnly, SameSite and Secure; uploads are checked by their bytes; sessions expire after 30 days and
guests a few hours after they leave.

**Platforms (v0.20).** `desktop/` is the Windows and Mac app: an Electron window on doodlehive.net
whose preload script exposes `window.doodlehiveNative`, a canvas store backed by plain files in the
app's data folder (`canvases/<id>/meta.json`, `ops.jsonl`, `thumb`). `ipad/` is the Capacitor
project for the same site; there the page uses the Filesystem plugin (`src/io/capacitorStore.ts`).
`src/io/native.ts` picks the bridge, and `localStore.ts` routes to it instead of IndexedDB, so a
device canvas in the apps is as permanent as any file. The apps update from the downloads host, not
from GitHub (see DEPLOY.md). Every canvas shows where it lives at the top right: a cloud for the
server, a yellow **In Cache** warning in a browser (hover: the browser may clear it, get the app), and
a device icon in the apps. Home tiles carry the same mark.

### Known limits (fine for now, worth revisiting)
- Two hosts restructuring the same folder at the exact same moment can see different orders until reload.
- Undoing a stroke restores whole 256px tiles, so it can also undo a host's edit in the same tile of your layer.
- One server process holds all rooms; scaling out later needs sticky sessions or a shared pub/sub.

## Tests

```bash
# Solo drawing (static build, no server):
npm run build && (cd dist && python3 -m http.server 4180)
node tests/smoke.mjs http://localhost:4180/app.html
node tests/touch.mjs http://localhost:4180/app.html
node tests/replay.mjs http://localhost:4180/app.html
node tests/pickers.mjs http://localhost:4180/app.html   # brush library, mode drop-downs, R/Z view keys
node tests/brushes.mjs http://localhost:4180/app.html   # categories, grain, square tips, shared smudge/eraser library, slider preview, effects

# Two people in a room (server with dev login + vite):
DB_PATH=/tmp/dw-test.db npm run dev
DB_PATH=/tmp/dw-test.db node tests/room.mjs   # screenshots in test-results/room/
DB_PATH=/tmp/dw-test.db node tests/site.mjs   # landing, login, home, friends, private canvases
node tests/share.mjs                          # sharing, joining from friends, approval, invites, presence
node tests/spectate.mjs                       # watch links: chat only, no edits or export, removable
node tests/smudge.mjs                         # smudge: drags paint, undo, selection clip, room sync
DB_PATH=... node tests/notices.mjs            # bell: friend requests, invites, premium warning, clear
DB_PATH=... node tests/prefs.mjs              # preferences: groups, themes, pressure graph, key binds, sync, gradients
DB_PATH=... node tests/admin.mjs              # admin: gating, stats, premium/badges, bans, IP bans, log, delete
DB_PATH=... node tests/local.mjs              # device canvases, live-only rooms, host leaves, premium on/off (server needs EPHEMERAL_GRACE_MS=1500)
node tests/security.mjs                       # cross-site requests, rate limits, headers, op validation
```
Set `CHROMIUM=/path/to/chrome` if Playwright's bundled browser isn't installed.
