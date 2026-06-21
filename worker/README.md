# AfterSold mailer — DocuPost automation Worker

A Cloudflare Worker that receives orders from the site (`list.html`) and, on a
daily cron, mails the right card (birthday / anniversary / holiday) to each
recipient through the **DocuPost** Send Letter API.

```
list.html  ──POST /api/list──▶  Worker  ──stores──▶  D1 (orders, recipients, sends)
                                   │
                          daily cron 14:00 UTC
                                   ▼
                   matches today's occasions  ──▶  DocuPost  ──▶  paper in a mailbox
```

## What's where
- `src/worker.js` — HTTP routes + cron + DocuPost call + card templates
- `wrangler.toml` — D1 binding, daily cron, allowed origin
- `schema.sql` — D1 tables (`orders`, `recipients`, `sends`)
- `.dev.vars` — **local only, git-ignored** — holds `DOCUPOST_API_KEY` for `wrangler dev`

## The DocuPost key is a SECRET
It is **never** in the repo. Locally it lives in `.dev.vars` (git-ignored).
In production set it as a Worker secret (below). Because the key was shared in
plaintext, **rotate it in the DocuPost dashboard** and update both places.

## Deploy (one time)
From this `worker/` directory:

```bash
# 1. Auth + tooling
npx wrangler login

# 2. Create the database, then paste its id into wrangler.toml (database_id)
npx wrangler d1 create aftersold

# 3. Create the tables (local + production)
npx wrangler d1 execute aftersold --file=schema.sql
npx wrangler d1 execute aftersold --remote --file=schema.sql

# 4. Store the DocuPost key as a secret (paste the key when prompted)
npx wrangler secret put DOCUPOST_API_KEY

# 5. Ship it
npx wrangler deploy
```

`wrangler deploy` prints the URL, e.g. `https://aftersold-mailer.<your-subdomain>.workers.dev`.

## Wire the site to it
In `../list.html` set:

```js
var WORKER_URL = "https://aftersold-mailer.<your-subdomain>.workers.dev";
```

(While it still contains `YOURNAME`, the site silently skips the Worker and
falls back to the email handoff — so nothing breaks before you deploy.)

## Verify
```bash
# liveness
curl https://aftersold-mailer.<your-subdomain>.workers.dev/api/health

# dry run — shows the exact letter HTML, mails nothing
curl -X POST https://aftersold-mailer.<your-subdomain>.workers.dev/api/test-send

# REAL mail (costs postage) — sends one letter to the address in the body
curl -X POST "https://aftersold-mailer.<your-subdomain>.workers.dev/api/test-send?live=1" \
  -H 'Content-Type: application/json' \
  -d '{"recipient":{"name":"You","street":"123 Main St","city":"Austin","state":"TX","zip":"78704"},
       "sender":{"name":"Me","address1":"1 Sender Way","city":"Austin","state":"TX","zip":"78701"}}'
```

Run the cron by hand while testing:
```bash
npx wrangler dev --test-scheduled        # then hit /__scheduled?cron=0+14+*+*+*
```

## What it automates today
Date-driven cards, gated by each person's chosen categories:
- **Birthday** — on `birthday` (MM-DD), if "Birthday" is selected
- **Anniversary** — on `anniversary`, if "Anniversary" is selected
- **Home anniversary** — on `closing`, if "Anniversary" is selected
- **Holidays** — Dec 12 each year, if "Holidays" is selected (edit `HOLIDAYS` in `worker.js`)

The `sends` table dedupes so each occasion mails once per recipient per year.
Non-date categories (Just because, Thinking of you, Get well, Congrats, Local
history, Heritage) are stored but not yet auto-scheduled — add rules in
`occasionsFor()` when ready.

## Launch promo (one-time 50% off, enforced by IP)
`GET /api/promo` powers the cart's countdown. The visitor's IP is stored only as a
**salted SHA-256 hash** (no raw IP retained) in the `promo_offers` table. Each IP gets
**one 2-minute window**; refreshing does not reset it, and once the window passes the IP
is **locked out of the discount for 60 days**. Returns `{ eligible, msLeft }`.

- Optional secret for the hash:  `wrangler secret put PROMO_SALT`  (any random string;
  a local value lives in `.dev.vars`). Falls back to a default if unset.
- The 50%-off Stripe `dealLink`s already exist in `cart.html` PLANS; they're used only
  when `/api/promo` says the visitor is eligible.
- **To turn the promo on**, set `WORKER_URL` in **`cart.html`** (and `list.html`) to your
  deployed Worker URL. Until then the cart stays full price — no fake timer.
- Window/lockout are tunable: `PROMO_WINDOW_MS` / `PROMO_LOCKOUT_MS` in `worker.js`.
