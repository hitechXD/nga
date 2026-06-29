# Shalom SMP — Website + Order Admin Panel

## What's in here
- `public/index.html` — your store front (ranks, checkout modal)
- `public/admin.html` — password-protected admin dashboard at `/admin.html`
- `server.js` — backend: creates orders, receives UroPay's webhook, lets admin approve and auto-delivers the rank via RCON
- `orders.json` — auto-created local database of orders (don't delete while server is running)

## How the flow works
1. A player clicks "Buy King" on the site → fills IGN + email → hits "Pay with UroPay"
2. The site calls `POST /api/create-order` on your backend, which saves the order as `awaiting_payment`
3. **(You need to wire this part)** That endpoint should call UroPay's real order-creation API and get back a checkout URL, which the player is redirected to
4. Player pays on UroPay's page
5. UroPay calls your webhook: `POST /webhook/uropay` → order flips to `paid_pending_approval`
6. You open `play.shalomsmp.in/admin.html` (or wherever you host this), log in, see the order, click **"Approve & Deliver"**
7. The backend connects to your Minecraft server over RCON and runs the configured command (e.g. `lp user Steve parent add king`) — order becomes `delivered`

You stay in control: nothing reaches your Minecraft server until you personally click Approve. If you'd rather it auto-deliver the instant UroPay confirms payment (no manual click), that's a one-line change in `server.js` — happy to make that change if you want full automation instead.

## Setup
```bash
npm install
cp .env.example .env
# edit .env: set ADMIN_PASSWORD, RCON_HOST/PORT/PASSWORD, and UroPay keys once you have them
npm start
```
Then visit `http://localhost:3000` for the site and `http://localhost:3000/admin.html` for the dashboard.

## Still to do (needs your UroPay account details)
Two `TODO` blocks in `server.js` are placeholders because I don't have your UroPay merchant docs/API key:
1. **`/api/create-order`** — needs to call UroPay's real "create order" endpoint and return a real checkout URL
2. **`/webhook/uropay`** — needs to verify UroPay's webhook signature using their documented method, and read their actual payload field names (I guessed `reference` / `status` / `uropay_order_id`)

Send me UroPay's API docs (or even just their webhook payload sample + your merchant key) and I'll fill both in for real.

## Minecraft server requirements
- RCON enabled in `server.properties`:
  ```
  enable-rcon=true
  rcon.port=25575
  rcon.password=yourStrongPassword
  ```
- A permissions plugin like LuckPerms (the example commands use `lp user {ign} parent add <tier>`) — adjust `RANK_COMMANDS` in `server.js` to match whatever your server actually uses (kits, prefixes, permission groups, etc.)

## Deploying with your domain
Since you now have `play.shalomsmp.in`, point that domain at wherever you host this Node app (a VPS, Railway, Render, etc.), and update `RCON_HOST` to your Minecraft server's actual address if the backend and game server aren't on the same machine.
