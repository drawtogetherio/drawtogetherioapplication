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
npm run admin -- premium BurntoutPasta 30       # premium for 30 days (or "forever" / "off")
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
- Fixed or **Unlimited** canvas; brush/eraser presets with pen pressure, smoothing, hardness, flow
- Selection (rect/ellipse/lasso) with move/rotate/scale/flip; fill bucket; shapes; eyedropper
- Procreate-style brush library (tap the selected brush/eraser) with pressure-stroke previews; icon drop-downs for selection and shape modes
- R + drag rotates the view (Shift snaps 15°), Z + drag zooms
- Flip/pan/zoom/rotate view, undo/redo (incl. two/three-finger taps), HSV colour picker
- Layers with 17 blend modes, opacity, lock transparency, merge, clear; folders
- Export PNG, JPG and layered PSD (folders become PSD groups)

**Themes**
- Default **Honey** (soft yellow) accent; switch in Menu → Theme. Saved to the account when logged in,
  otherwise on the device.
- Themes live in `src/shared/themes.ts` (accent, hover, tint, text-on-accent). Add one there and it
  shows up in the menu. Themes flagged `premium` are locked without premium, and the server enforces it.
  Blueberry (the old blue) is free; Lavender, Mint and Peach are flagged premium as examples.

**Accounts (v0.2)**
- Discord login creates the account; no passwords stored
- First login opens profile setup: picture, display name, handle, favourite colour, links
- Handles are always `<ArtWord><Food>` (e.g. `@BurntoutPasta`, `@ArtblockedSandwich`), pre-generated
  and changeable with two pickers + Shuffle. A number is added only when the random pick keeps landing on taken pairs (2,500 combos).
- Display names: anything up to 32 characters. Zalgo/stacked accents, invisible and control
  characters, and fancy-Unicode tricks are cleaned out (checked on the server too).
- Pictures are cropped to a 128×128 square and compressed (WebP, ~1–10 KB) in the browser before
  upload; animated images become static. The server rejects anything over 48 KB.
- Links to Twitter, Instagram, YouTube, DeviantArt, Bluesky, Twitch, ArtStation, TikTok, Tumblr,
  pixiv: just a typed username, nothing connected.
- Favourite colour as a 6-digit hex (no alpha)
- `premium` + `premium_until` stored per user for later; set with `npm run admin`

**Home screen (v0.5)**
- Friends on the left, online first (seen in the last ~75 s), with presence dots and status messages.
  Add by @handle, accept/decline requests. Premium friends show the star, their name gradient and GIF avatar.
- Recent canvases in the middle with thumbnails; the first tile is always **Create new**, and the
  **+** in the top-left does the same: choose **Draw alone** (a private canvas) or **Shared room**.
- Every saved canvas is a room. Private ones only open for their owner; share one any time from the
  canvas or the tile's ⋯ menu (rename, share, make private, delete).
- Status message (80 characters) in Edit profile. Premium: name gradient and an animated GIF avatar (≤768 KB, ≤512 px).

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
src/tools/     brush/eraser, fill, select/transform, shapes, eyedropper
src/ui/        app shell, layers panel, dialogs, profile editor, room UI (members, chat, bubbles), session
src/net/       HTTP API client, room WebSocket client
src/shared/    code used by both client and server: profile rules, handle words, wire protocol
src/io/        PNG/JPG/PSD export, platform save adapter
server/        Node server: Discord OAuth, sessions, profiles, avatars, rooms (SQLite + WebSockets)
```

**Ops.** Every canvas change is a small deterministic JSON `Op`. `DrawDoc.apply()` returns the
inverse ops, so undo/redo are ops too and sync like anything else. Replaying the log reproduces
the canvas pixel for pixel (`tests/replay.mjs`).

**Rooms.** The server keeps each room's op log (in SQLite) and is the authority on who owns what:
it stamps the author/owner on each op and rejects edits to someone else's layer unless the sender
is a host. Clients apply their own changes immediately and the server relays them to everyone else;
if the server ever rejects one, that client reloads the room state. In-progress strokes are streamed
separately (~30 times a second) so others see them before they're finished.

**Database.** SQLite via Node's built-in `node:sqlite` (Node 22.5+), file at `server/data/`.
Easy to move to Postgres later; all queries are in `server/db.ts`.

**Platforms.** The same web app is meant to be wrapped with Tauri (Windows/Mac) and Capacitor (iPad).

### Known limits (fine for now, worth revisiting)
- Two hosts restructuring the same folder at the exact same moment can see different orders until reload.
- Undoing a stroke restores whole 256px tiles, so it can also undo a host's edit in the same tile of your layer.
- One server process holds all rooms; scaling out later needs sticky sessions or a shared pub/sub.

## Tests

```bash
# Solo drawing (static build, no server):
npm run build && (cd dist && python3 -m http.server 4180)
node tests/smoke.mjs http://localhost:4180/app/
node tests/touch.mjs http://localhost:4180/app/
node tests/replay.mjs http://localhost:4180/app/
node tests/pickers.mjs http://localhost:4180/app/   # brush library, mode drop-downs, R/Z view keys

# Two people in a room (server with dev login + vite):
DB_PATH=/tmp/dw-test.db npm run dev
DB_PATH=/tmp/dw-test.db node tests/room.mjs   # screenshots in test-results/room/
DB_PATH=/tmp/dw-test.db node tests/site.mjs   # landing, login, home, friends, private canvases
```
Set `CHROMIUM=/path/to/chrome` if Playwright's bundled browser isn't installed.
