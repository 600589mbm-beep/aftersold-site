# AfterSold — marketing site

**Live site:** https://600589mbm-beep.github.io/aftersold-site/

Static marketing website for **AfterSold**, a done-for-you client-retention mail
service for real estate agents: agents send their past-client list once, and
AfterSold automatically mails handwritten-style cards (home anniversaries,
birthdays, holidays) signed with the agent's name.

Pure HTML + CSS + a few lines of vanilla JS. No frameworks, no build step —
open `index.html` in a browser and it works; GitHub Pages serves it as-is.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The whole landing page (hero → problem → how it works → campaign calendar → ROI → pricing → FAQ → final CTA) |
| `css/style.css` | Design system ("warm stationery": cream, navy, brand red, gold) |
| `js/main.js` | Scroll fade-in via IntersectionObserver (respects `prefers-reduced-motion`) |
| `privacy.html`, `terms.html` | Placeholder legal pages — replace before real launch |

## Editing copy

All copy lives directly in `index.html` — every section is fenced with an HTML
comment (`<!-- Hero -->`, `<!-- Pricing -->`, …). Edit the text in place,
commit, push: GitHub Pages redeploys automatically within a minute or two.

Pricing tiers are plain markup inside `<section id="pricing">`; FAQ items are
native `<details>` blocks inside `<section id="faq">`.

## Swapping the Calendly link (do this first)

Every CTA points at the placeholder `https://calendly.com/REPLACE-ME`, each
marked with a `<!-- TODO: replace Calendly URL -->` comment. Replace all of
them in one go:

```bash
grep -rl 'calendly.com/REPLACE-ME' . --include='*.html' \
  | xargs sed -i 's|https://calendly.com/REPLACE-ME|https://calendly.com/YOUR-HANDLE/10min-demo|g'
```

## Custom domain later

1. Buy the domain, then in your DNS create:
   - apex (`aftersold.com`): four `A` records → `185.199.108.153`,
     `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - `www`: `CNAME` → `600589mbm-beep.github.io`
2. Repo **Settings → Pages → Custom domain** → enter the domain (this commits a
   `CNAME` file), wait for the DNS check, then tick **Enforce HTTPS**.
3. Update the `<link rel="canonical">` and `og:url` tags in `index.html` to the
   new domain.
