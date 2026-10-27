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

**Everyday drawing tools (v0.33)**
- **Guides** (one top-bar button): symmetry (vertical, horizontal, quadrant, radial) mirrors strokes and
  shapes; a grid with rulers and snapping; a floating reference image panel (`src/ui/guides.ts`,
  `src/ui/reference.ts`).
- **QuickShape**: hold still at the end of a stroke and it snaps to a line, circle, arc or polyline
  (`src/engine/quickShape.ts`). Shapes gained polygon, star, arrow, speech bubble, polyline, curve and arc,
  placed by clicks for the point shapes (`src/tools/shapeTool.ts`).
- **Gradient** fill mode (linear or radial, to a colour or transparent) as a deterministic op
  (`src/engine/gradient.ts`).
- **Adjustments** in the Effects popover: HSB, colour balance, curves, levels, invert, gradient map; each
  can also be an adjustment layer that recolours what is below it (`src/engine/effects.ts`, compositor).
- **Palettes**: saved palettes in the colour picker, import `.aco`, `.ase`, `.swatches` and text, colour
  harmony modes (`src/shared/palettes.ts`).
- **Selection**: feather, grow/shrink, invert, colour range, select layer content, saved selections;
  Alt+Backspace fills the layer or selection, Shift+Alt+Backspace recolours it (`src/engine/selection.ts`).
- **Reference layer** for the fill tool and the magic wand (sample one layer instead of the active one or all).
- **Layers**: search, colour tags, multi-select with Ctrl/Shift, merge visible, flatten.
- **Quick menu**: right click, pen barrel button or Q opens a ring of eight shortcuts under the pointer;
  its centre button customises them. **Ctrl+K** opens a searchable command palette. Both run from one
  registry (`src/ui/commands.ts`).
- **Accessibility**: icon-only controls are named by their tooltips, keyboard focus shows a ring, F6 moves
  focus between bars, reduced motion is honoured, and a left-handed preference mirrors the layout.

**Brush engine (v0.34)**
- **Dynamics** (`src/engine/brush.ts`): tip angle (fixed or following the stroke), scatter, size/flow/angle
  jitter, hue/saturation/brightness jitter, **wet mixing** (each dab picks up the paint under it) and
  **tilt shading** (a leaning pen stretches the dab and thins the paint; strokes carry `tilt` only when the
  brush uses it). Randomness is seeded from the op id, so every client replays the same dabs; the server
  range-checks each number (`src/shared/brush.ts`, `server/validate.ts`).
- **Brush images**: a tip shape, a **dual tip** multiplied into the dab, and a **texture** (fixed to the
  canvas or moving with the dab) are small greyscale PNGs kept as content-addressed assets
  (`src/shared/brushAssets.ts`, `src/engine/brushAssets.ts`): the id is the SHA-256 of the normalised file,
  256 px and 64 KB at most. They live in IndexedDB and are uploaded once to `PUT /api/brush-assets/:id`
  (signature and size checked, never decoded server-side; 200 per user per hour); a room refuses a stroke
  naming an asset it hasn't got, and peers fetch missing ones before applying the op. A brush whose image
  is unavailable draws with a round tip.
- **Brush editor** groups the sliders into collapsible sections (Stroke, Pressure, Texture, Dual tip, Scatter,
  Colour, Wet mix, Tilt); brush codes carry the image ids, so a shared code still works once the images
  are on the server.
- **Import** (`src/io/brushImport.ts`): the library's Import button reads Photoshop `.abr` (versions 1, 2 and
  6+, `src/shared/abr.ts`: sampled tips, computed tips, scatter, texture, dual brush, colour dynamics) and
  Procreate `.brush` / `.brushset` (`src/shared/bplist.ts` unarchives the `Brush.archive` plist; `Shape.png`
  and `Grain.png` become the tip and texture). A set lands in a category named after the file. Imported
  brushes are flagged (`CustomBrush.imported`) and have no share code: Copy code or the editor's share
  button first asks the owner to confirm they hold the rights, once per brush, and their images are only
  uploaded when they are drawn in a room.
  Procreate is a trademark of Savage Interactive; Photoshop is a trademark of Adobe. Doodlehive reads
  their file formats and is not affiliated with or endorsed by either.

**Windows, loading bar, gestures (v0.34)**
- The room **chat**, the **minimap** and the **reference** image are small windows: drag by the bar, and the
  spot (and the reference's size, via its corner grip) is kept on the device in localStorage
  (`src/ui/float.ts`); an undo arrow puts a window back in its corner. The minimap's X hides it
  (Preferences → Layout turns it on again). The reference zooms with buttons, wheel or pinch, rotates by
  twisting or a quarter-turn button, and swaps its image with the file button.
- A **loading bar** shows a canvas replaying: on the start screen at first, then as a bar over the app when
  another canvas is opened or a room joined (`Session.progress`, `App.loading`).
- Preferences → **Gestures** lists every touch and pen gesture, next to Shortcuts.

**Performance (v0.32)**
- Fills, effects, PNG/JPG encoding, thumbnails and `.hivecanvas` zips run in a Web Worker
  (`src/engine/offload.ts`); the page falls back to doing them inline if the worker fails to start.
- Undo snapshots only the strip of each 256 px tile a stroke touched (`tiles` keys like `3,2@0,160`);
  history cost counts area. Device logs past 8 MB of undo pixels squash to a snapshot once the pen is up.
- A view-wide recomposite (zooming out on a big canvas with many layers) is spread over frames within a
  10 ms budget, with the previous composite shown scaled under the rows still to come
  (`src/view/canvasView.ts`). `tests/compbench.mjs` has the numbers.
- `src/ui/memory.ts` watches canvas memory and caps undo history as it nears the device budget.

**Branding (v0.31)**
- Logo by [Logocraftz](https://www.fiverr.com/logocraftz), credited in Preferences → About. The kit's
  originals are in `src/assets/brand/kit`; `src/site/brand.ts` inlines copies with plain fills. The mark
  has a version for dark backgrounds (`mark-on-dark.svg`) and one for light (`mark-on-light.svg`), and CSS
  shows the one for the current mode; the wordmark is one SVG in `currentColor`. `public/favicon.svg`
  follows the browser's colour scheme. `public/apple-touch-icon.png`, `public/og.png` and
  `desktop/build/icon.png` are rendered from the same artwork.
- Brand colours: Dark `#212021`, Honey `#fdb302`, White `#ffffff`. Honey is the default accent; dark mode
  is built on Dark, light mode on White with Dark text. The last mode is kept in localStorage
  (`doodlehive.mode`) so the loading screen matches it.

**Drawing (v0.1)**
- Fixed or **Unlimited** canvas; brush/eraser presets with pen pressure, smoothing, hardness, flow; **Smudge** (S) drags and blends paint in place
- **Brush library (v0.21)**: one library in categories (General, Pencil, Pen, Eraser) that brush, eraser and
  smudge all pick from (`src/engine/brush.ts`, `BRUSH_LIBRARY`). Graphite, crayon, charcoal and the flat
  brush carry **grain**: a seeded paper texture fixed to the canvas, so every device renders the same
  speckle and strokes line up; the Grain slider in the options bar tunes it. Cube, flat and chisel brushes
  have a square tip. Dragging the Size or Opacity slider shows a preview of the brush at that size.
  The star on a brush row keeps it on the library's ★ tab; the list is saved in prefs
  (`favoriteBrushes`), so it follows the account.
- **Your own brushes (v0.24)**: every brush row has a ⋯ menu with Clone and Copy code; the library
  head adds a brush from the current settings, pastes a brush code, or makes a category. The editor
  (`src/ui/brushEditor.ts`) has a slider for every `BrushParams` field, the tip shape, a live preview and
  the brush's share code. Codes are `hive-` plus base64url of the name and numbers
  (`src/shared/brush.ts`, `brushCode` / `parseBrushCode`); pasting one into another account's library
  recreates the brush. Brushes (`customBrushes`, up to 80) and categories (`brushCategories`, up to 12)
  live in prefs; `cleanPrefs` validates them with the same ranges the server uses for strokes
  (`validBrush`). Deleting a category moves its brushes to General. `ed.preset(id)` looks a brush up in
  your own list first, then the library.
- **Studio layout (v0.24)**: Preferences → Layout switches between Simple (bars and popovers) and
  Studio: a vertical toolbar and brush properties on the left, a colour wheel, swatches and layers on
  the right. Panels drag by their title to float over the canvas, drop on an edge to dock there (any
  side, in the order dropped), resize from the corner grip, and close with X; the Layout group lists
  which panels show and resets the arrangement. Positions are saved in prefs (`panels`) with the
  account. `src/ui/panels.ts` (`Studio`) owns the frames; the app moves the same tool buttons, options
  bar, sliders, colour picker and layers panel between the simple bars and the studio frames
  (`App.applyLayout`), so both layouts share one state. The colour wheel is the picker's `setWheel`
  mode: a hue ring drawn once around the saturation/value square.
- **Clipping masks and layer masks (v0.24)**: the layers panel's clip button clips a layer to the one
  below (consecutive clipped layers render as a group over their base; hiding the base hides them). The
  mask button adds a mask: paint on it hides, erase shows; the mask thumbnail sits beside the layer's
  and clicking either picks what the tools edit. Apply bakes the mask into the pixels; delete and undo
  restore it. Ops carry `mask: true` when they target the mask, so rooms and replay stay exact; PSD
  export writes masks and clipping.
- **Invite link embeds (v0.24)**: an invite link (`/app?room=ID&by=handle`) is served with Open Graph
  tags, so Discord and friends show "<name> has invited you to draw!", the description, and the canvas
  as a large image (`serveInvite` in `server/index.ts`). `by` is the sharer's handle, added by the app
  when it copies the link and dropped from the address bar once the room opens; an unknown handle
  falls back to the room's owner. The image comes from `/og/ID`, a public route that serves the
  room's thumbnail (owners now upload one for live-only rooms too, and flush it before copying the
  link), versioned by `thumb_version` so chat apps refetch it. Private and unknown rooms get
  `public/og.png`, the Doodlehive card, which the landing page also uses as its `og:image`.
- **Pinned canvases (v0.25)**: Edit profile → Pinned canvases picks up to `PINNED_MAX` (5) of your own
  saved, non-private canvases; their thumbnails sit on your profile card and open full size in a
  lightbox. The server keeps the room ids in `users.pinned`, checks ownership on save, drops private
  or deleted rooms from the card, and serves the pictures from `/pins/ID`, the only public thumbnail
  route besides `/og/ID`.
- **Patreon linking (v0.25)**: with `PATREON_CLIENT_ID` and `PATREON_CLIENT_SECRET` set, Edit profile
  shows a Patreon field: Link Patreon runs OAuth (`/auth/patreon`, `server/patreon.ts`), stores the
  Patreon id and tokens on the user (never sent to the browser) and reads the memberships. An active
  patron (of `PATREON_CAMPAIGN_ID`, if set) counts as premium through `isPremium`; the status is
  re-read every 12 hours when the app loads, with Check again, and drops when the link is revoked.
  Unlink removes the link and that premium. Admin-granted premium is separate and unaffected.
- **Profile dialog (v0.25)**: picture and banner share one strip at the top (`cropImage` in
  `src/ui/avatarCrop.ts` crops both, round for pictures, 3:1 for banners; banners are stored at
  1200 × 400 and shown on profile cards). GIF pictures go through the same Upload picture button for
  premium accounts, up to 4 MB and 1024 px; since a browser can't re-encode a GIF, the file is
  stored as uploaded with its crop (`avatarCrop`, fractions of the crop square) and `avatarEl`
  applies the crop on display, while the still is cut from the first frame. The profile colour is an
  embedded picker (`src/ui/hsvField.ts`, sharing `drawSV` with the canvas picker); the Gradient
  toggle swaps it to two swatches with the name previewed. The Premium section has three states:
  blurred perks behind a Patreon prompt (with Link Patreon and a link to the page), "not an active
  patron" with Check again and Unlink, or the perks list with the link status.
- **Fill lasso and magic wand (v0.26)**: the bucket's drop-down has a **Fill lasso** mode that fills the
  shape you draw (shown as marching ants while you drag); with **Fill
  inside lines** on, only the parts of it that lines close off (`enclosedFill` in `src/engine/fill.ts`:
  the lasso's surroundings are the colour most of its edge sits on, and whatever of that colour can't
  be reached from the edge is inside the lines). Tolerance, Expand and the layer reference are shared
  with the bucket. The selection tool's **Magic wand** mode selects the connected area of similar
  colour under the click; the mask becomes a polygon along pixel edges (`src/engine/contour.ts`), with
  holes, so a selection now carries `holes` and every clip uses the even-odd rule.
- **Brush stabilizer (v0.26)**: the Stabilizer checkbox (and its slider) in the brush options puts the
  brush on a rope behind the cursor (`pull` in `src/tools/brushTool.ts`, up to 160 screen px); the
  overlay draws the rope and the cursor, the line ends where the brush is when you lift, and other
  people's cursor bubble follows the brush, not the pointer (`pen()`). Saved with the preferences.
- **Short brush bar (v0.26)**: the Simple layout's brush options show only the preset, Stabilizer and
  the Pressure Size/Opacity checkboxes; Flow, Hardness, Grain and Smoothing stay in the Studio brush
  panel. The pressure checkboxes are preferences (`pressureSize`, `pressureOpacity`, applied to the
  brush and eraser by `applyPressure`), so they are remembered.
- **Canvases remember how they were held (v0.26)**: the view's rotation and flips are kept per canvas
  on the device (`src/view/turns.ts`, localStorage) and restored on the next open, fitted so the
  turned canvas still fits the screen. Per device, so nobody's rotation turns anyone else's room.
- **Long strokes (v0.26)**: a stroke that outgrows `MAX_STROKE_PTS` (40k samples) is committed and
  continued as a new one, instead of being rejected as "Unknown edit".
- **Strokes are coverage, not piles of dabs (v0.26)**: `StrokeRenderer` (`src/engine/brush.ts`) paints
  grey coverage into a scratch surface where round dabs combine by maximum (`lighten`), so a pixel
  holds the brush's coverage however many dabs land on it: a light touch, Pressure → Opacity, or a
  slow stroke no longer shows the dab pattern or dark specks. Hairlines (under 2.5 px) are a ribbon
  of quads added once per pixel, so a 0.5 px line is an even grey. The coverage level is what the old
  overlapping dabs settled at (`1 - (1 - flow)^(1/spacing)`), so every brush keeps its darkness.
  Grain multiplies the coverage (`paper`), square brushes still stamp. `sync` copies the touched
  coverage into the stroke buffer as coloured pixels after each input event (microtask) and at the
  end, so the compositor and replay see the same buffer as before. The dab path also takes a median
  of three pressure samples, so a stray spike doesn't make one fat dab.
- **Pen strokes wait for pressure (v0.25)**: a pen down that reports pressure 0 (iPads do this on the
  first sample) starts the stroke on the first sample that has pressure, instead of dotting the canvas
  with the previous stroke's size (`pendingDown` in `src/view/input.ts`).
- **Layer effects** (the ✦ button by the flip buttons lists them; the layers panel's ✦ too): Gaussian blur, motion blur, mosaic, chromatic
  aberration, glitch, sharpen and noise. Each is one `effect` op, computed with plain arithmetic in a fixed
  order (`src/engine/effects.ts`) so every client bakes the same pixels; nothing is re-applied per frame.
  Picking one opens a floating bar (under the selection, or top centre for the whole layer) and the
  canvas itself previews the effect live (`src/ui/effectsBar.ts`): the processed pixels replace the
  layer's through the view's live layer, clipped to the selection when there is one, and only the
  on-screen part is processed. Enter or ✓ bakes it, Escape or drawing cancels. The bar notes that
  the bake can be undone only while it is still in the undo history.
- Selection (rect/ellipse/lasso/magic wand) with move/rotate/scale/flip; fill bucket and fill lasso; shapes; eyedropper
- Procreate-style brush library (tap the selected brush/eraser) with pressure-stroke previews; icon drop-downs for selection and shape modes
- R + drag rotates the view (Shift snaps 15°), Z + drag zooms
- Flip/pan/zoom/rotate view, undo/redo (incl. two/three-finger taps), HSV colour picker
- **History** panel (sidebar, beside undo): every edit in order; click one to jump there
- **Minimap** in the stage corner: the whole drawing with the view on it; drag the window to pan,
  click outside it to recentre (Preferences → Layout turns it off)
- **Focus mode** (F): fullscreen with the UI hidden; Tab (from the canvas) or a four-finger tap hides and shows the UI; F6 moves keyboard focus between bars
- Pen: predicted and coalesced samples, a low-latency canvas (Preferences → Performance), tilt and
  azimuth read into the brush, a pen test pad under Preferences → Pressure (pressure, tilt, express keys)
- Touch: touch-and-hold opens the eyedropper, pinch-rotate snaps to 0°
- **Canvas memory** meter in the layers panel head: pixels plus undo history against the device's
  budget; undo history is kept shorter as it climbs and a warning shows before the browser gives up
- Installable (PWA): a service worker keeps the app shell offline; home offers to pick up the
  canvas that was open last time after a relaunch or a crash
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
  Add by @handle, accept/decline requests. Requests you sent live behind **Manage outgoing requests** at
  the bottom of the column (v0.30): one small window with an **Outgoing requests** tab (cancel) and a
  **Blocked** tab (unblock); the account menu's **Blocked people** opens the same window. Premium friends show the star, their name gradient and GIF avatar.
- The middle (v0.29): a thin start card (**Draw alone**, **Open shared room**, **Join room**, **Open
  file**), a **Recent** row of your canvases with thumbnails, and **Shared with you**: rooms of other
  people you joined (`room_visits`, recorded on each join), newest first, with the host's name and
  whether the room is open now, so a lobby can be rejoined from home. Private rooms show no
  thumbnail there. At the bottom, cards for Patreon and, when `DISCORD_INVITE_URL` is set, the
  Discord server. The + top right opens the create menu (the same three choices plus a join box).
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
- In a room, a member's profile card (member list, or the picture by their name in chat) has **Add
  friend** and **Block**. Blocking hides their messages, bubbles and presence from you, ends the
  friendship, and keeps them out of rooms you host (they are dropped from one you're hosting at the
  time, and `Room.access` refuses them afterwards). The account menu's **Blocked people** unblocks;
  `blocked` on your profile carries the ids. Chat closes itself once a message is sent, so keys go
  back to the canvas.
- The drawing screen's menu has a bell next to your name; a red dot on the menu button and the bell
  means unread notifications. The bell opens them as a dialog with the same actions as the home bell.
- Each home tile's menu has **Properties**: size, where the canvas is stored, and the people a host
  invited (their pictures, names on hover; `rooms.invited` keeps the list). A device canvas in the
  browser offers **Save as file** (.hivecanvas); in the desktop app, a folder button shows the files
  (`canvases:reveal`, desktop 0.24). A server canvas offers **Move to this device**, which keeps a
  copy here and lets the room close once you leave it.
- The bell on your profile card (top of the friends list) counts unread notifications: friend requests (accept or decline
  right there), accepted requests, room invites (Join) and system notices such as premium ending
  within a day. They arrive live over the event stream; the server keeps the last 100 per person.
  Clicking your picture on that card opens the account menu (profile, preferences, sign out); the
  drawing screen's topbar has no logo or account button, only the hamburger menu.
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
- Site: whether every new account starts with the Early bee badge (on by default; guests never get
  it), and a home screen message with background and text colours, previewed as you type. Settings are
  one JSON row in the `site` table (`src/shared/site.ts` cleans them); `/api/config` carries the
  message while it is on, and the home screen shows it above the Patreon banner.
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
- Your pen comes first (v0.27). Others' live points are painted just before each frame
  (`CanvasView.prepare`), only when they land on screen; off-screen strokes wait and are painted in one
  go when they commit. While your pen is down, others' previews catch up ten times a second and their
  committed edits wait (`RoomClient.hold`), so a big fill or effect never lands mid-stroke. The brush
  tool doesn't send cursor positions while streaming a stroke (the live points already say where it is).
- Fast joins (v0.28). Every `config.snapshotEvery` (400) edits the server asks one client (the owner,
  else a host, else anyone drawing) for a snapshot: the canvas as ops (`DrawDoc.snapshot`), uploaded
  to `/api/rooms/:id/snapshot` with the room's `seq` it stands for. The server checks the tree it
  describes matches what it knows (no handing yourself a layer), stores it in `room_snapshots`, and
  from then on a welcome is the snapshot plus the edits after it. `room_ops` keeps the full history.
  Every `op` message and the sender's `ack` carry `seq`, so a client knows exactly which state it
  holds (`RoomClient.lastSeq`, `settled()`).
- A refused edit is taken back locally (`Editor.rollback`, from the inverse kept for recent sends)
  instead of reconnecting and replaying the room; only an edit too old to roll back reloads.
  Big undo pixels go out as several `tiles` ops (`wireOps`), each within the room's limits.
- Hosts get an **Edit log** (dock button): every edit by person, with a Remove on anything that
  touched pixels. Removing rebuilds the layer from its history without that edit (`removeEdit`,
  `/api/rooms/:id/history`), and sends the tiles that differ as an ordinary edit everyone gets
  and the host can undo. Later edits on the layer stay. Ops carry `at`, set by the server.
- Preferences → Performance: turn off others' strokes as they draw (only the bubble shows; the
  finished stroke still lands), and have others' finished edits land in batches every 2, 5 or
  10 s (`RoomClient.batchMs`). Your own drawing is never delayed.
- Server limits on what a member can make everyone else paint: strokes are bounded by path length and
  length × size (`strokeFits`, shared with the brush tool, which splits long strokes well before the
  limit), live previews by points per second (600/s, burst 4000; a dropped preview still commits), and
  cursors to 25/s with sane coordinates. Live strokes are keyed by sender, so nobody can end another
  person's preview.
- Setting to hide other people's folders from your Layers panel
- Member list with badges: crown = owner, shield = host, star = premium (all shown together).
  Tap someone to see their profile and links. Badges are SVG, not emoji.
- Chat in the bottom-left (press Enter), with typing indicators; messages fade when chat is closed
- @mentions and emoji (v0.27). Typing `@` lists the people in the room (display name or handle);
  pick one and the message carries `<@id>`, shown as their display name in their profile colour or
  gradient. Being mentioned plays a short chime (WebAudio, no asset; off in Preferences → Canvas),
  shows a toast and highlights the message. `:smile:` and other Discord-style codes
  (`src/shared/emoji.ts`) suggest as you type and become the character when sent.
- Preferences → About shows the web app version (`__APP_VERSION__`, from package.json at build
  time) and, inside the desktop or iPad app, the installed app's version.
- Undo/redo works in rooms (undo is just another change sent to everyone)

## Architecture

```
src/core/      document model: ops, layers + folders, tiled surfaces, undo history
src/engine/    brush dabs, flood fill, shapes, selection transforms, layer compositing; worker.ts +
               offload.ts run fills, effects, image encoding and .hivecanvas zips in a Web Worker
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
app's data folder (`canvases/<id>/meta.json`, `ops.jsonl`, `thumb`). On Windows the window is
frameless: the topbar is the drag region and carries its own minimize, maximize and close buttons
(`native.window`); on Mac the system traffic lights stay, inset into the topbar. `ipad/` is the Capacitor
project for the same site; there the page uses the Filesystem plugin (`src/io/capacitorStore.ts`).
`src/io/native.ts` picks the bridge, and `localStore.ts` routes to it instead of IndexedDB, so a
device canvas in the apps is as permanent as any file. The apps update from the downloads host, not
from GitHub (see DEPLOY.md). Every canvas shows where it lives at the top right: a cloud for the
server, a yellow **In Cache** warning in a browser (hover: the browser may clear it, get the app), and
a device icon in the apps. Home tiles carry the same mark.

**Files (.hivecanvas, .hivelapse).** `src/shared/hivecanvas.ts` reads and writes both, for the app and
the server. A `.hivecanvas` is a zip of `manifest.json`, `tree.json` (folders and layers) and the
layers' 256 px tiles as PNGs: the canvas as it looks now, never its undo history. Export saves one,
**Open a file** on the home screen opens one, and the desktop app opens them from the file manager.
A device canvas moves to a premium account as a `.hivecanvas` (`POST /api/rooms/import`), so a long
history full of undo pixels can't block it. Undo keeps only the part of each tile a stroke touched
(`tiles` keys like `3,2@0,160`), and a device log that still grows past 8 MB of undo pixels is rewritten
as a snapshot once the pen is up, and when it is next opened (`DrawDoc.compactLog`).
Timelapses (`src/io/lapse.ts`) are recorded only on the device: every 10 s the composited tiles that
changed are kept losslessly in their own IndexedDB database, merged in pairs past 2000 frames. **Export →
Timelapse…** makes a 1080p or 4K video in the browser, or saves the frames as a `.hivelapse`. The server
never takes a timelapse.

### Known limits (fine for now, worth revisiting)
- Joining replays the whole op log (yielding every 24 ms). Long-lived rooms would load faster with a
  periodic snapshot (`tiles` op) replacing old ops, as `LocalCopy.heavy` already does on devices.
- Two hosts restructuring the same folder at the exact same moment can see different orders until reload.
- Undoing a stroke restores the part of each 256px tile it touched, so it can also undo a host's edit in that
  same strip of your layer.
- One server process holds all rooms; scaling out later needs sticky sessions or a shared pub/sub.

## Tests

```bash
# Solo drawing (static build, no server):
npm run build && (cd dist && python3 -m http.server 4180)
node tests/smoke.mjs http://localhost:4180/app.html
node tests/touch.mjs http://localhost:4180/app.html
node tests/replay.mjs http://localhost:4180/app.html
node tests/pickers.mjs http://localhost:4180/app.html   # brush library, mode drop-downs, R/Z view keys
node tests/brushes.mjs http://localhost:4180/app.html   # categories, grain, square tips, custom brushes and codes, slider preview, effects
node tests/masks.mjs http://localhost:4180/app.html     # clipping masks, layer masks, replay
node tests/studio.mjs http://localhost:4180/app.html    # studio layout: docking, floating, resizing, colour wheel, back to simple
node tests/pen.mjs http://localhost:4180/app.html       # a pen down with no pressure waits for the next sample
node tests/tools.mjs http://localhost:4180/app.html     # fill lasso (inside lines or not), magic wand with holes, rope stabilizer, long strokes split
node tests/undo.mjs http://localhost:4180/app.html      # partial-tile undo, memory meter, history panel, minimap
node tests/guides.mjs http://localhost:4180/app.html    # symmetry, grid snapping, rulers, reference panel
node tests/shapes.mjs http://localhost:4180/app.html    # QuickShape, point shapes, arrows, bubbles
node tests/gradient.mjs http://localhost:4180/app.html  # gradient fill mode
node tests/adjust.mjs http://localhost:4180/app.html    # adjustments and adjustment layers
node tests/palettes.mjs http://localhost:4180/app.html  # saved palettes, import, harmonies
node tests/selection.mjs http://localhost:4180/app.html # feather, grow/shrink, invert, colour range, fill/recolour shortcuts
node tests/reference.mjs http://localhost:4180/app.html # reference layer for fills and the wand
node tests/layers.mjs http://localhost:4180/app.html    # search, tags, multi-select, merge visible, flatten
node tests/quickmenu.mjs http://localhost:4180/app.html # quick menu and command palette
node tests/a11y.mjs http://localhost:4180/app.html      # names, focus ring, F6, reduced motion, left-handed layout
node tests/dynamics.mjs http://localhost:4180/app.html  # seeded replay, scatter, colour jitter, wet mix, tilt, follow angle, editor sections
node tests/tips.mjs http://localhost:4180/app.html      # tip, dual and texture images, missing-asset fallback, IndexedDB persistence
node tests/import.mjs http://localhost:4180/app.html    # Photoshop .abr (v2 and v6) and Procreate .brushset import
node tests/pwa.mjs http://localhost:4180                # manifest, icons, service worker precache, offline /app
node tests/compbench.mjs --layers 20                    # compositor timings at 4K with N layers

# Two people in a room (server with dev login + vite):
DB_PATH=/tmp/dw-test.db npm run dev
DB_PATH=/tmp/dw-test.db node tests/room.mjs   # rooms, chat, friends from chat, menu notifications, blocking, kick; screenshots in test-results/room/
DB_PATH=/tmp/dw-test.db node tests/site.mjs   # landing, login, home, friends, private canvases
node tests/share.mjs                          # sharing, joining from friends, approval, invites, presence
node tests/spectate.mjs                       # watch links: chat only, no edits or export, removable
node tests/smudge.mjs                         # smudge: drags paint, undo, selection clip, room sync
DB_PATH=... node tests/notices.mjs            # bell: friend requests, invites, premium warning, clear
DB_PATH=... node tests/prefs.mjs              # preferences: groups, themes, pressure graph, key binds, sync, gradients
DB_PATH=... node tests/assets.mjs             # brush images: upload rules, room rejections, a tip drawn by one person shows for another
DB_PATH=... node tests/admin.mjs              # admin: gating, stats, premium/badges, bans, IP bans, log, delete, site settings
DB_PATH=... node tests/room.mjs               # start the server with SNAPSHOT_EVERY=5 so the snapshot check passes
DB_PATH=... node tests/local.mjs              # device canvases, live-only rooms, host leaves, premium on/off (server needs EPHEMERAL_GRACE_MS=1500)
DB_PATH=... node tests/hivecanvas.mjs         # .hivecanvas export/open/move to server, log compaction, timelapse + video (HIVE_OPS=ops.jsonl adds a real canvas)
node tests/security.mjs                       # cross-site requests, rate limits, headers, op validation
node tests/embed.mjs                          # invite link embeds: Open Graph tags, sharer's name, public canvas image, private fallback
DB_PATH=... node tests/pins.mjs               # pinned canvases: limits, ownership, public thumbnails, picker, lightbox
DB_PATH=... node tests/profile.mjs            # profile dialog: premium states, GIF picture with crop, banner, colour/gradient picker
node tests/media.mjs                          # pictures on R2 against a signature-checking mock: upload, replace, remove, move at startup, beta prefix (starts its own servers)
node tests/sync.mjs                           # beta on a copy of live: secret, scrubbed sessions/tokens, daily refresh, admin copy-now (starts its own servers)
node tests/patreon.mjs                        # Patreon linking against a mock (server needs PATREON_CLIENT_ID=test-client PATREON_CLIENT_SECRET=test-secret PATREON_CAMPAIGN_ID=c1 PATREON_API=http://localhost:8799)
```

Performance with several people drawing (built app served by the server, so it measures production code):

```bash
npm run build && PUBLIC_URL=http://localhost:8787 DEV_LOGIN=1 DB_PATH=/tmp/dw-bench.db npm start
node tests/lagbench.mjs --bots 3              # you + 3 bots drawing: fps, long tasks, pen sample gaps, render, pen-up, quiet-time hitches, undo
node tests/lagbench.mjs --bots 3 --fixed      # same on a fixed 2400×1600 canvas (zoomed out to fit)
node tests/relaybench.mjs --bots 4            # server relay latency for ops and live chunks
```
`lagbench` bots are WebSocket members that behave like the app (live chunks every 33 ms, cursors every
50 ms, the stroke op on pen-up), each in its own band of the view; the measured client uses the studio
layout so the layers panel is open. Add `--json file` to collect runs.
Set `CHROMIUM=/path/to/chrome` if Playwright's bundled browser isn't installed.
