# Sahara Delivery

A game logistics system — driver app, warehouse dashboard, admin panel, and Discord
notifications. Built for roleplay/game servers (FiveM, Roblox, Minecraft economies, etc.)
where deliveries are tracked manually, not by GPS.

## What's inside

| App | URL | Who uses it |
|---|---|---|
| Login | `/` | Everyone — routes you by role |
| Driver app | `/driver.html` | Drivers — see assigned runs, start transit, mark delivered, flag exceptions |
| Warehouse dashboard | `/warehouse.html` | Ops staff — log orders, pick/pack board, assign drivers |
| Admin panel | `/admin.html` | Admins — analytics, user management, depots |
| **Place an order** | `/order.html` | **Customers (players) — public form, submit an order and get a tracking code. No login.** |
| **Order tracking** | `/track.html` | **Customers (players) — public page, enter an order code to see status. No login.** |

One Node.js server runs everything: the REST API, all three frontends, and the SQLite
database. No external database needed.

## Quick start

Requires **Node.js 22+** (uses the built-in SQLite — no native compilation).

```bash
npm install
npm start
```

That's it. On first run the server creates an admin account and **prints its password in
the console** — sign in with `admin` and that password, then set everything else up from
inside the app. There's no `.env` to write and no secret to pick (the login secret is
generated and saved automatically).

Connect Discord from the **admin panel → Settings** tab: paste a webhook URL, hit
**Send test**, save. No file editing.

### Want demo data to explore first?

```bash
npm run seed     # adds demo depots, drivers, orders, and known logins
npm start
```

Demo accounts:

```
admin   / admin123     admin panel
ops1    / ops123       warehouse (North Depot)
ops2    / ops123       warehouse (South Depot)
driver1 / drive123     driver app
driver2 / drive123
driver3 / drive123
```

Delete `sahara-delivery.db` to start over. (If you seed, the demo `admin` is used and the
auto-generated one is skipped.)

## Discord notifications

The easiest way: **admin panel → Settings**. Paste your webhook URLs, hit **Send test** to
confirm each one reaches the right channel, and save. Changes take effect immediately — no
restart, no file editing.

To create a webhook in Discord: **Server Settings → Integrations → Webhooks → New Webhook**,
pick the channel, and copy the URL.

You can also set these as environment variables instead (handy for automated deploys) —
`DISCORD_WEBHOOK_DISPATCH`, `DISCORD_WEBHOOK_ALERTS`, `DISCORD_WEBHOOK_CUSTOMER`,
`PUBLIC_URL`. An env var takes precedence and locks that field in the Settings tab so the
two don't fight.

Events that post to the staff channel: new order logged, picking started, packed, driver
assigned, run started, delivered, and exceptions (with the driver's note).

## Self-service ordering

Players can place their own orders at `/order.html` — no login. They enter their name,
pick a depot, say where it's going, and describe what they need in a free-text items box
(so they can order anything, not from a fixed catalog). On submit they get an `ORD-XXXXXX`
code and a direct link to track it. The order lands on the warehouse board exactly like a
staff-entered one and pings the dispatch channel.

Guardrails on the public endpoint, since it's open:
- Required fields (name, destination, items, depot) and a valid depot are enforced.
- Field lengths are capped (name 40, destination 100, items 600 chars).
- Rate limited to 5 orders per IP per 10 minutes.
- Self-service orders are always standard priority — staff can bump them to express on the
  board, so players can't all flag themselves urgent.

Staff can still log orders themselves from the warehouse dashboard (useful for phone/in-game
requests). Both paths produce identical orders.

## Customer notifications

Players who place orders get their own updates, two ways:

**1. Public tracking page (`/track.html`)** — no login. A player enters their order code
(e.g. `ORD-AB3CD9`) and sees a friendly status timeline: received → preparing →
out for delivery → delivered, with a delay banner if something goes wrong. Warehouse
staff can hit "Copy track link" on any order to grab a shareable link.

**2. Customer Discord channel** — set `DISCORD_WEBHOOK_CUSTOMER` to a webhook for a
public channel (e.g. `#order-updates`). Players get plain-language pings at the milestones
they care about: order received, preparing, out for delivery, delivered, and delayed.
Internal details (driver names beyond "on the way", staff IDs, raw job refs) stay in the
staff channels. If you also set `PUBLIC_URL`, each customer ping includes a clickable
"Track it" link straight to the tracking page.

The tracking endpoint only ever returns customer-safe fields — order code, customer name,
destination, items, and a simplified stage. Driver assignments and internal notes never
leak (the one exception is a delay note, which is shown deliberately so players know why
their order is late).

## Job lifecycle

```
order logged → picking → packed → assigned → in transit → delivered
                                      ↘ exception ↗ (resume or send back to depot)
```

Who can do what:
- **Warehouse**: log orders, start picks, mark packed, assign drivers, resolve exceptions
- **Driver**: start the run, mark delivered, flag an exception (only on their own jobs)
- **Admin**: everything, plus users and depots

## Free hosting

The whole system is one Node process. Two easy paths:

**Render — one-click blueprint (recommended)**

This repo ships a `render.yaml`, so Render configures everything for you.
1. Push this folder to a GitHub repo.
2. On [render.com](https://render.com): **New → Blueprint** → connect the repo → **Apply**.
3. When it's live, open the URL. Check the deploy logs for your first admin password.

Heads up on Render's free tier: free web services have an **ephemeral filesystem** and
spin down after ~15 minutes of inactivity, so the SQLite database **resets on restart or
redeploy**. That's fine for testing — first-run setup just regenerates the admin and the
app works immediately — but you'll lose order history.

To make data permanent, you need a paid instance with a persistent disk (~$7/mo plus
$0.25/GB/mo). In `render.yaml`: change `plan: free` to `plan: starter` and uncomment the
`disk:` block at the bottom. Orders and accounts then survive forever.

**Docker (any host, or your own box) — free and persistent**

```bash
docker build -t sahara-delivery .
docker run -p 3000:3000 -v sahara-delivery-data:/data sahara-delivery
```

The `-v sahara-delivery-data:/data` volume keeps the database between restarts, with no monthly
cost. Running it on a spare PC / Raspberry Pi / game-server box and exposing it with a free
Cloudflare Tunnel is the best zero-cost, always-on, *persistent* option.

**Fly.io** is another good choice — it supports a small persistent volume on its free
allowance, which gives you free persistence that Render's free tier can't.

## Configuration (all optional)

Nothing here is required — the app runs with zero config and you set Discord up in the
Settings tab. Environment variables exist mainly for automated deploys, and override the
in-app settings when present.

```
JWT_SECRET=long-random-string          # auto-generated if unset
ADMIN_PASSWORD=...                     # sets the first-run admin password (else random)
DISCORD_WEBHOOK_DISPATCH=https://...   # routine events
DISCORD_WEBHOOK_ALERTS=https://...     # exceptions only
DISCORD_WEBHOOK_CUSTOMER=https://...   # customer order updates
PUBLIC_URL=https://...                 # for tracking links in customer pings
PORT=3000
DB_PATH=./sahara-delivery.db                   # set to /data/sahara-delivery.db on a persistent disk
```

## API overview

All endpoints are under `/api`, JSON in/out, `Authorization: Bearer <token>`.

```
POST  /auth/login                {username, password} → {token, user}
GET   /me
GET   /warehouses                POST /warehouses (admin)
GET   /users (admin/wh)          POST /users (admin)      PATCH /users/:id (admin)
GET   /drivers (wh/admin)        — drivers with active job counts
GET   /orders                    POST /orders (wh/admin)
GET   /jobs                      — drivers see only their own
POST  /jobs                     {order_id} — starts picking
PATCH /jobs/:id/assign          {driver_id} (wh/admin)
PATCH /jobs/:id/status          {status, note?}
GET   /events                    — activity log
GET   /stats (wh/admin)          — analytics
GET   /track/:ref                — PUBLIC, no auth — customer order status
GET   /public/depots             — PUBLIC, no auth — depot list for the order form
POST  /order                     — PUBLIC, no auth — customer submits an order (rate limited)
```

## Project structure

```
server.js        Express API + static file server + Discord notifications
db.js            SQLite schema (Node built-in sqlite, no native deps)
seed.js          Demo data
public/
  index.html     Login
  order.html     Public order form (no login)
  track.html     Public order tracking (no login)
  driver.html    Driver app (mobile-first, dark)
  warehouse.html Warehouse dashboard
  admin.html     Admin panel
  assets/        Shared CSS + JS helpers
```
