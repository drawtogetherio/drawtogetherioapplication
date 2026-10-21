# Deploying Doodlehive to Railway

One Railway service runs everything: the Node server, the built web app, live rooms (WebSockets) and
the SQLite database (accounts, avatars, rooms) on a Railway volume. Every push to `main` on GitHub
redeploys automatically, and HTTPS certificates are handled by Railway.

The repo already contains what Railway needs:
- `railway.json`: build with `npm run build`, start with `npm start`, health check on `/healthz`, one replica.
- `.node-version` / `engines`: Node 22 (needed for the built-in SQLite).
- The server detects Railway and then: stores the database on the attached volume, turns dev login
  off, uses secure cookies, and redirects `www.doodlehive.net` to `doodlehive.net`.

## One-time setup (about 15 minutes)

### 1. Railway project
1. Sign up at https://railway.com with your GitHub account. Choose the **Hobby** plan
   (about $5/month, which includes usage for a small app like this; volumes and custom domains need a paid plan).
2. **New Project → Deploy from GitHub repo →** pick `doodlehive`. Allow Railway access to that repo when asked.
3. The first deploy starts. It will work, but don't invite anyone until the volume (step 2) is attached.

### 2. Volume (keeps accounts and rooms between deploys)
1. In the project, right-click the service (or use **+ New → Volume**) and attach a volume.
2. Mount path: `/data`. 1 GB is plenty to start.
3. In the volume's settings, turn on **Backups** (daily is fine).

The server finds the volume by itself (Railway sets `RAILWAY_VOLUME_MOUNT_PATH`). If the deploy
log ever says `WARNING: no volume attached`, the volume is missing.

### 3. Variables (service → Variables)

| Name | Value |
| --- | --- |
| `PUBLIC_URL` | `https://doodlehive.net` |
| `DISCORD_CLIENT_ID` | from the Discord developer portal |
| `DISCORD_CLIENT_SECRET` | from the Discord developer portal (keep it only here) |
| `DOWNLOAD_MAC_URL` | optional, later: link to the Mac app download (the landing page shows "soon" until set) |
| `DOWNLOAD_WINDOWS_URL` | optional, later: link to the Windows app download |
| `PATREON_URL` | optional: where the home-screen support banner links (default `https://www.patreon.com/doodlehive`) |
| `ADMIN_HANDLES` | your @handle (without the @; several separated by commas). Those accounts get the admin dashboard at `/admin` on their next login |

Saving variables redeploys the service.

### 4. Domain
1. Service → **Settings → Networking → Custom Domain**. Add `doodlehive.net`, then add `www.doodlehive.net`.
2. Railway shows a DNS record for each (a `CNAME`, plus sometimes a `TXT` for verification). Add exactly
   those at the place you bought the domain.
   - `www` is a normal `CNAME`.
   - The bare `doodlehive.net` needs your registrar to support `CNAME`/`ALIAS`/"flattening" at the root.
     Cloudflare, Namecheap and Porkbun do. If yours doesn't, move the domain's DNS to Cloudflare (free)
     and add the records there.
3. Wait for Railway to show both domains as active (minutes, sometimes up to an hour).

### 5. Discord
In https://discord.com/developers/applications → your **Doodlehive** app → **OAuth2 → Redirects**, add:

```
https://doodlehive.net/auth/discord/callback
```

Keep the `http://localhost:8787/auth/discord/callback` redirect too, so login keeps working locally.

## Everyday use
- **Update the site:** push to `main` (or merge a pull request). Railway builds and deploys it.
  If the build fails, the old version keeps running.
- **Rollback:** Railway → Deployments → pick an earlier one → Redeploy.
- **Logs:** Railway → the service → Deployments → View logs.
- **Give someone premium, badges, or a ban:** open https://doodlehive.net/admin (admins only).
  Without the dashboard: install the Railway CLI, run `railway link` once, then `railway ssh` and
  inside it `npm run admin -- premium SomeHandle 30` (or `forever` / `off`), or `npm run admin -- admin SomeHandle on`.
- Deploys restart the server for a few seconds; people in a room reconnect on their own.

## Limits to know about
- One server instance holds all live rooms. That covers a lot of people drawing at once; going past
  one instance later means moving rooms to Redis and the database to Postgres.
- The database is a single SQLite file on the volume; Railway's volume backups are the safety net.
