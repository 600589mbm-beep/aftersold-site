# aftersold-site — Deploy Reference

Deployed to Cloudflare Workers from `600589mbm-beep/aftersold-site` (root: `/worker`).

## Live URLs

- Worker: https://aftersold-site.dakota-valley-haul-600589.workers.dev
- Health check: https://aftersold-site.dakota-valley-haul-600589.workers.dev/api/health
- Custom origin (CORS-allowed): https://getaftersold.com

## Cloudflare dashboard links

- Worker overview: https://dash.cloudflare.com/9fb0fb6420e7acf3a3b30d5e0d77ec4b/workers/services/view/aftersold-site/production
- Worker settings (vars, cron): https://dash.cloudflare.com/9fb0fb6420e7acf3a3b30d5e0d77ec4b/workers/services/view/aftersold-site/production/settings
- Deployments: https://dash.cloudflare.com/9fb0fb6420e7acf3a3b30d5e0d77ec4b/workers/services/view/aftersold-site/production/deployments
- Workers & Pages list: https://dash.cloudflare.com/9fb0fb6420e7acf3a3b30d5e0d77ec4b/workers-and-pages

## Runtime bindings

| Name | Type | Value |
|---|---|---|
| `DB` | D1 Database | `aftersold` (uuid `2f1b7300-daed-4ba1-9c9f-e01a0cbd27ab`) |
| `ALLOWED_ORIGIN` | Plaintext | `https://getaftersold.com` |
| `DOCUPOST_API_KEY` | Secret | (encrypted) |

## Schedule

- Cron: `0 14 * * *` — runs daily at 14:00 UTC (`runDailySend`)

## API endpoints

- `GET  /api/health` — liveness check
- `POST /api/list` — submit sender + recipients to DB
- `POST /api/test-send` — dry-run card render (add `?live=1` to actually mail via DocuPost)
- `POST /api/promo` — 2-minute promo eligibility check by IP hash

## DocuPost

- Dashboard: https://app.docupost.com/dashboard
- Developer API / API key / Sandbox toggle: https://app.docupost.com/dashboard?account_settings= (Account settings → Developer API)
- Docs — Send Letter API: https://help.docupost.com/help/send-letter-api
- Docs — Send Postcard API: https://help.docupost.com/help/send-postcard-api

**Before the daily cron can actually mail:** add funds on DocuPost, or enable Sandbox mode for testing.

## GitHub

- Repo: https://github.com/600589mbm-beep/aftersold-site
