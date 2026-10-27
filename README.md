# Camo CPQ

A small configure-price-quote tool for California Mobility. A sales rep signs in with Google, picks a product and any compatible add-ons, sees a live price, tax, and discount summary, and can push the resulting quote to HubSpot.

It's a static, no-build, vanilla JavaScript single-page app. There's no backend server or database: pricing data and the HubSpot push go through n8n webhooks.

**Live site:** https://profitpad-inc.github.io/camo-cpq/cpq/

## Repository layout

| Path | What it is |
|---|---|
| `docs/` | The site itself, published by GitHub Pages |
| `docs/cpq/` | The app: `index.html`, `app.js`, `styles.css`, PWA manifest, vendored Flatpickr |
| `docs/globals/global.css` | Shared brand tokens and reset |
| `docs/service-worker.js` | Offline caching (lives above `cpq/` on purpose, see `HANDOFF.md`) |
| `HANDOFF.md` | Detailed notes on how everything works; read this before making changes |
| `.archive/` | Earlier versions of the app, kept for reference only |

## Running locally

Serve the `docs/` folder with any static file server, for example:

```bash
python3 -m http.server 4173 --directory docs
```

Then open http://localhost:4173/cpq/.

To skip Google Sign-In during local development, copy `docs/cpq/dev-auth.local.js.example` to `docs/cpq/dev-auth.local.js` and fill in the dev password. That file is gitignored and only takes effect on localhost or a LAN IP. See `HANDOFF.md` for details.

## Deploying

GitHub Pages serves `docs/` from the `main` branch, so pushing to `main` deploys. There's no build step.

The site's origin (`https://profitpad-inc.github.io`) must be allowed in two places for sign-in and pricing to work:

- the Google OAuth client's authorized JavaScript origins
- the n8n webhook's CORS settings
