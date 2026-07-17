# Camo CPQ, Handoff Notes

## What this is

Camo CPQ is a small configure-price-quote tool. A user picks one product and any compatible add-ons, sees a live price/tax/discount/margin summary, and can push the resulting quote to HubSpot. It is a static, no-build, vanilla JavaScript single-page app, there is no backend server or database.

## How the app works, end to end

1. On load, the app shows a "Sign in with Google" button and fetches nothing until the visitor signs in.
2. On a successful Google sign-in, it calls the same n8n webhook three times in parallel, once per sheet (`https://n8n.californiamobility.com/webhook/camo-cpq/pricing?sheet=products|options|packages`), sending the Google ID token as `Authorization: Bearer <idToken>` on each request. A 401 or 403 from any of the three means the signed-in Google account isn't allowlisted, shown inline, no data loads. Any other non-2xx or network/CORS failure shows a generic "Could not reach the pricing service" message. On success, the three responses are merged into the product/add-on/package catalog, see the JSON contract below.
3. **Deal/product selection step** (new, between sign-in and the main CPQ layout, `state.step === "deal-select"`): the user either searches for an existing HubSpot deal or skips straight to a price lookup. See "The deal/product selection step" below.
4. The user opens a product category, selects one product. Add-ons scoped to that product appear, grouped by category, with incompatible add-ons disabled once a conflicting add-on is selected. Product cards and the Quote Summary show the manufacturer-facing description; add-on cards show no description at all (by request). The customer-facing description is still fetched and kept on each product/add-on as `customerDescription`, unused for display, reserved for the HubSpot push described below.
5. The summary panel computes subtotal, tax (10% of the combined cost of everything selected, plus an extra 10% of each add-on's price on top, this is a pre-existing quirk in the original pricing formula, not something introduced here), discount ($ or %), and total in real time. A "Show Margin" toggle reveals cost and margin percentage for internal use.
6. "Push to HubSpot" POSTs the quote to a separate n8n webhook (`https://n8n.californiamobility.com/webhook/camo-cpq/update-hs`), which updates the selected deal and its line items, voids any previous quotes on that deal, and creates a new quote, returning `quote_link` and `deal_link` URLs, which then render as buttons. This call is unauthenticated, it does not require the Google sign-in. An info icon next to "Push to HubSpot" (`pushHubspotInfoHtml` in `app.js`) surfaces this update/void/create-new behavior to the user before they click it.

   The POST body (`handlePushToHubspot()` in `app.js`):
   ```json
   {
     "hs_deal_id": "330227396341",
     "deal_name": "Some Deal Name",
     "deal_product": "Bruno_Elite_CRE_2110_E",
     "product": {
       "name": "...", "description": "...", "sku": "...",
       "price": 0, "cost": 0, "tax_amount": 0
     },
     "options": [
       { "name": "...", "description": "...", "sku": "...", "quantity": 1, "configuration": "...", "price": 0, "cost": 0, "tax_amount": 0 }
     ],
     "subtotal": 0,
     "cost": 0,
     "margin": 0,
     "discount_amount": 0,
     "discount_percentage": 0,
     "tax_amount": 0,
     "tax_percentage": 5,
     "tax_location": "12345",
     "currency": "USD",
     "total": 0,
     "comment": "",
     "quote_expiration_date": "2026-08-15",
     "ship_to": {
       "hs_contact_id": "508812292839",
       "first_name": "Chris",
       "last_name": "Becher",
       "street": "850 El Chorro Way",
       "city": "Sacramento",
       "state": "CA",
       "zip": "95864"
     }
   }
   ```
   `hs_deal_id`/`deal_name`/`deal_product` come from `state.selectedDeal` (from the deal-select step below) and are `null` when the user skipped straight to a price lookup; when present, the n8n workflow uses `hs_deal_id` to update that existing deal and its line items on the HubSpot side, void any previous quotes on it, and create a new quote. Each of `product` and every entry in `options` carries its own `tax_amount`, computed with the same pre-existing quirky formula described in step 5 (cost × 10% for both, plus an extra price × 10% for options only) and rounded to the nearest cent; the top-level `tax_amount` is their sum, also rounded to the nearest cent. `cost` and `margin` are the same combined-cost and margin-percentage figures shown behind the "Show Margin" toggle, not previously sent to this endpoint. `discount_amount` (dollars) and `discount_percentage` are both always populated as equivalent values regardless of which discount mode (`$` or `%`) the user typed into, computed from whichever one was entered. `tax_percentage`, `tax_location`, and `currency` are static values sent on every request, not computed from the quote.

   Each `options[]` entry's `quantity` (an integer, always ≥ 1) and `configuration` (a string, empty when the add-on has no configuration choice) come from the new `max_quantity`/`configuration` sheet columns described below. `price`, `cost`, and `tax_amount` for an option are already multiplied by its `quantity`, this endpoint doesn't need to do that multiplication itself. Products carry neither field, quantity/configuration are add-ons only.

   `comment` is a freeform note the rep types directly on the quote (`state.quoteComment`, a new "Comment" field in the Quote Summary panel), separate from the note on the "Send Quote" email modal (`state.quoteEmailNote`, unchanged, still only used in the email body, never sent here). `quote_expiration_date` is `yyyy-mm-dd`, defaulting to 30 days from today (`defaultQuoteExpirationDate()` in `app.js`) but editable per quote via the calendar dropdown described below; it's just a value passed through, `app.js` does nothing else with it. `ship_to` is the editable shipping address described below; `hs_contact_id` is `null` whenever no HubSpot contact is selected (no deal, or the deal has no contacts), in which case the address fields are sent as-is (freeform, quote-only) and n8n shouldn't attempt to write them back onto any contact.

   The expiration date field itself (`#quote-expiration-date`) isn't a native `<input type="date">` — that calendar dropdown is unstyleable browser/OS chrome, and the ask was an on-brand look, so it's a plain `readonly` text input driven by Flatpickr instead (`renderExpirationDatePicker()` in `app.js`, on-brand overrides in `styles.css` under the `flatpickr-*` selectors). Same reasoning as the Google Sign-In button (`renderGoogleButton()`): since `render()` fully replaces `#app`'s innerHTML on every state change, the old Flatpickr instance would be left pointing at a detached DOM node, so it's torn down and a fresh one attached after every re-render instead. `onChange` calls `setQuoteExpirationDate()` with Flatpickr's own `dateFormat: "Y-m-d"` output, matching `state.quoteExpirationDate`'s format exactly.

## The deal/product selection step

Sits between the sign-in gate and the main product/add-on/summary layout (`dealSelectSectionHtml()` in `app.js`, gated on `state.step === "deal-select"`).

- A search box calls `GET https://n8n.californiamobility.com/webhook/camo-cpq/hs-fetch?fetch=deals&search=<term>` once the trimmed input is 2+ characters, debounced 300ms. The endpoint accepts either a text search (matches on deal name) or a HubSpot deal record ID (e.g. `330227396341`), same query param either way.
- Response shape (verified against the live endpoint): `{"hs_deals": [{"createdate": "...", "dealname": "...", "hs_lastmodifieddate": "...", "hs_object_id": "...", "product": "..."}]}`. A search with no matches returns `200` with an **empty body**, not `{}` or `{"hs_deals": []}`, `app.js` handles this explicitly in `fetchDeals()`.
- `deal.product` is the HubSpot dropdown value for the package chosen on that deal (e.g. `"Bruno_Elite_CRE_2110_E"`), it is matched against each package's `hs_product_dropdown_property_value` (see below) to figure out which product/add-on SKUs to preselect. It can be `null`/`"N/A"`/an unrecognized value for older or manually-entered deals, in which case nothing is preselected and a small notice is shown instead of failing silently.
- Selecting a deal from the search results, or a successful `?hs_deal_id=` auto-lookup (see below), preselects that deal's matched product and option SKUs and jumps straight to the main CPQ layout.
- "Skip, just do a price lookup" jumps to the main CPQ layout with nothing preselected.
- **`?hs_deal_id=<record id>` query param**: on boot, if present, the app immediately calls the same `hs-fetch` search with that ID, in parallel with (not waiting on) the sign-in-gated pricing fetch, since the deal lookup needs no sign-in. The deal-select page shows a "Looking up deal…" spinner for as long as this is unresolved. An exact `hs_object_id` match skips the picker entirely and preselects like a manual selection would; no match shows an inline "Deal not found" notice and falls back to the normal search/skip picker.
- If the browser is offline (`state.isOnline` false, tracked via the `online`/`offline` window events), the deal-select step is skipped altogether and the app goes straight to the main CPQ layout as if "Skip — just do a price lookup" had been clicked (`resolveInitialStep()`, called once pricing data has loaded). This covers both cases: a `?hs_deal_id=` is present (the auto-lookup itself is skipped, no request attempted) and no `?hs_deal_id=` at all (the picker never appears, there's no working search without a connection). Only the automatic paths are affected; the manual search box will still attempt a search if the picker is showing and the user tries it while offline, it just surfaces a "Could not search deals" error like any other failed fetch.

## The install address / HubSpot contacts

Shown in the Quote Summary panel as "Install Address" (`shipToSectionHtml()` in `app.js`, still `state.shipTo`/`ship_to` internally) once a deal is selected; there's nothing to show without one, since contacts are looked up per-deal, so this section is absent entirely on a skip-straight-to-price-lookup quote.

- On `chooseDeal()` (a manual pick from search results, or a successful `?hs_deal_id=` auto-lookup, see above), `app.js` fires off `GET https://n8n.californiamobility.com/webhook/camo-cpq/hs-fetch?fetch=contacts&search=<hs_deal_id>` (`fetchContactsForDeal()`/`loadContactsForDeal()`), in the background, not blocking the jump to the CPQ layout.
- Response shape (as given, not yet independently re-verified against the live endpoint the way the deals/pricing shapes were): `{"contacts": [{"hs_contact_id": "...", "email": "...", "firstname": "...", "lastname": "...", "address_street": null, "address_city": "...", "address_state": null, "address_zip": "..."}]}`. Address fields can individually be `null`. Assumed, by analogy with `fetchDeals()`/the deals endpoint, to also return `200` with an **empty body** (not `{}`/`{"contacts": []}`) when a deal has no contacts; `fetchContactsForDeal()` handles that case the same way `fetchDeals()` does. Worth confirming against the live endpoint the first time this is actually exercised.
- The first contact returned is preselected automatically. If the deal has 2+ contacts, a "Contact" dropdown appears to switch between them. If it has zero, the address fields are simply left blank, with a small note that this address is quote-only and won't sync to HubSpot.
- Selecting a contact (or the auto-preselected one) prefills Street/City/State/ZIP (`applyContactToShipTo()`); those fields stay freely editable from there, independent of the contact record, and switching the "Contact" dropdown overwrites them again with that contact's stored address, discarding any manual edits. The contact's `firstname`/`lastname` are still captured into `state.shipTo` and still sent as `ship_to.first_name`/`ship_to.last_name` in the push body below, they're just not shown or editable in this section (by request, the rep didn't need to see/change them here).
- A note next to the fields ("Editing this address will update this contact in HubSpot") makes clear that this isn't a passive display field, even though nothing is actually written to HubSpot until "Push to HubSpot" is clicked; editing here only changes local state (see `ship_to` in the POST body above), and it's the `update-hs` n8n workflow's job to actually apply `ship_to` back onto the contact identified by `ship_to.hs_contact_id`.

## The `packages` array (part of the `camo-cpq-pricing` response)

Added to the pricing endpoint alongside `products`/`options` specifically to support preselecting a deal's product/add-ons. Each entry:

```json
{
  "package_name": "Bruno Elan Straight Indoor",
  "hs_product_dropdown_property_value": "Bruno_Elan_SRE_3050",
  "product_sku": "bruno--sre-3050--indoor-straight",
  "option_skus": "bruno--sre-3050--power-folding-footrest, bruno--sre-3050--power-swivel-seat, bruno--sre-3050--15.5ft-anodized-power-folding-hinge"
}
```

- `hs_product_dropdown_property_value` is matched against a HubSpot deal's `product` field (see above), it is not a SKU.
- `option_skus` is a comma-joined string like the other SKU lists in this endpoint, not a JSON array, `app.js` splits it with the existing `splitSkuList()` helper.
- `option_skus` can be an empty string (some packages have no add-ons).

## Rendering approach

There is no framework. `app.js` keeps one mutable `state` object and re-renders the whole `#app` container to an HTML string on every change (`render()`), using event delegation (`data-action` attributes) instead of per-element listeners. Focus and text-selection are captured before a re-render and restored after, so typing in the discount field does not lose cursor position.

The "Send Quote" modal's preview iframe (`quoteIframeContainerEl`) loads a cross-origin HubSpot quote page (`state.quoteLink`), which we can't inject CSS into or measure the height of. On screens under 900px it's hidden entirely (`.send-quote__preview` in `styles.css`), the "Sign Quote" / "View HubSpot Deal" buttons are the only way to view it there. At 900px and up, `applyQuoteIframeScale()` lays the iframe out at a fixed desktop-sized box (`QUOTE_IFRAME_NATIVE_WIDTH`/`QUOTE_IFRAME_NATIVE_HEIGHT`) and shrinks it with a CSS `transform: scale()` to fit the preview pane's actual width, a `ResizeObserver` on the pane keeps this in sync as the window/pane resizes. This avoids horizontal scrolling inside the iframe without touching the page it's showing; the trade-off is blank space at the bottom if the real page is shorter than the fixed native height.

## File map

Everything now lives under one `html/` root, served by a single static file server, not two separate subdomain hosts:

| File | Purpose |
|---|---|
| `html/index.html` | Thin client-side redirect (meta refresh) to `./sales.californiamobility.com/cpq` |
| `html/sales.californiamobility.com/index.html` | Another redirect stub, to `./cpq` |
| `html/sales.californiamobility.com/cpq/index.html` | Page shell, loads `app.js` and the Google Identity Services script, the actual app |
| `html/sales.californiamobility.com/cpq/app.js` | Everything: Google sign-in, pricing fetch + normalization, rendering, the HubSpot push |
| `html/sales.californiamobility.com/cpq/styles.css` | Hand-written CSS, app-specific, no build step, no framework |
| `html/sales.californiamobility.com/cpq/vendor/flatpickr.min.js`, `flatpickr.min.css` | Vendored (not CDN-linked) copy of Flatpickr v4.6.13, MIT licensed, pinned/downloaded once rather than fetched at runtime so it still works offline like everything else here; drives the expiration date field's calendar dropdown, see below |
| `html/sales.californiamobility.com/cpq/service-worker.js`, `manifest.json` | PWA shell, offline caching |
| `html/globals/global.css` | Shared brand tokens + reset, meant to be reused by other California Mobility webtools, not just this one (renamed from `static.californiamobility.com/`, since it's not actually a separate host) |
| `html/globals/index.html` | Same redirect stub pattern, to `../sales.californiamobility.com/cpq`, still unclear why this folder needs one at all, worth a quick check with the team |

The `sales.californiamobility.com` folder name is a holdover from when this was conceptually two subdomains; it's kept because the live host serves it at that path (`http://34.20.174.32/sales.californiamobility.com/cpq`, per the redirect targets), not because there's an actual subdomain behind it, it's all one server now.

## Deployment

This app deploys as a single static site rooted at `html/`. `sales.californiamobility.com/cpq/index.html` links `global.css` with a relative path (`../../globals/global.css`), which resolves because `globals/` is a sibling directory under the same `html/` root, everything under `html/` is relative now, not absolute-URL-based. No nginx configs exist in this repo currently; if they exist, they're managed outside this codebase.

`service-worker.js`'s `PRECACHE_URLS` now points at `../../globals/global.css` (was the old absolute `https://static.californiamobility.com/global.css`, a host that no longer factors into this setup), matching the relative-path scheme used everywhere else under `html/`.

## Google sign-in

**Status: client-side half is implemented on the `feature/google-auth` branch; the n8n workflow still needs to be updated to actually verify tokens (see spec below), and a real GCP OAuth Client ID needs to be dropped into `GOOGLE_CLIENT_ID` in `app.js`. Until both of those happen, this doesn't function as a real gate, same as the old password wasn't a real gate without the n8n check.**

The password gate (`?p=<password>`, checked server-side by n8n) has been replaced with Google Sign-In. There is still no client-side secret, the security boundary is entirely server-side; the client's job is only to obtain a Google ID token and attach it to the pricing request, not to decide who's allowed in.

- `app.js` loads the Google Identity Services script (`https://accounts.google.com/gsi/client`, tag added in `index.html`) and renders the standard "Sign in with Google" button (`renderGoogleButton()`, `shape: "pill"` for the roundest corners Google's button supports, it's rendered inside a cross-origin iframe so its CSS isn't otherwise ours to override) in place of the old password form.
- Sign-in is a hard gate in front of everything else, including the deal search step: `appHtml()` only renders the deal-select screen once `state.authed` is true, never speculatively while a sign-in attempt is still in flight. (The `?hs_deal_id=` auto-lookup network call itself can still kick off immediately on boot, same as before, since that endpoint needs no auth either way, it's just that nothing about it is shown to the visitor until they've signed in.)
- On sign-in, Google calls back with a signed ID token (a JWT). `app.js` sends it as `Authorization: Bearer <idToken>` on each of the three pricing sheet requests (`fetchPricingData` in `app.js`), instead of the old `?p=` query param.
- A 401/403 from any of the three calls means "this Google account isn't authorized," shown inline, same as a wrong password before. `app.js` never decides this itself, it only reacts to what n8n returns.
- The token payload is decoded client-side purely for display (`decodeIdTokenPayload`). The signed-in account is shown via an avatar button in the site header (`headerUserMenuHtml`/`renderHeaderUserMenu` in `app.js`, rendered into the static `#header-user-menu` placeholder in `index.html`, outside `#app`, same pattern as the Google Sign-In button), showing the account's initials; clicking it opens a small panel with the full email and a "Sign out" button. This is not verification, reading a JWT's own claims proves nothing about its authenticity; n8n verifying the signature is what actually matters.

### Returning visitors, online or offline

There is deliberately no silent/One-Tap sign-in prompt (`google.accounts.id.prompt()` is never called): a returning visitor should never be interrupted by a Google prompt, and shouldn't need to click the Google button again either. Instead, the last successfully-verified ID token is kept in `localStorage` (`cpq-google-last-session`, see `GOOGLE_SESSION_STORAGE_KEY` in `app.js`), and on boot, if one is found, it's replayed straight into `authenticateWithGoogle()`, skipping Google's own sign-in flow entirely, the same effect the old stored-password auto-retry had.

- While online, that replayed token still goes through the normal `Authorization: Bearer` pricing fetch, so n8n fully re-verifies it (signature, `aud`, `exp`) exactly as it would a fresh token; an expired or no-longer-allowlisted token is rejected (401/403) and falls back to the explicit "Sign in with Google" button, same as a first-time visitor. `google.accounts.id.initialize()` still runs on boot regardless (so that fallback button works immediately), it just never calls `.prompt()`. Since a stored session can only exist for an account that was previously allowlisted, a 401/403 on this specific replay path is treated as a plain expiry rather than "account isn't authorized": `authenticateWithGoogle(idToken, isStoredSessionReplay)` in `app.js` clears the stored session and immediately calls `window.location.reload()` instead of showing an error, landing the visitor straight on a clean "Sign in with Google" button with one click needed, rather than a scary rejection message sitting next to a button that would have worked anyway. Because the stored session is already cleared before the reload, the next boot has nothing left to replay, so this can't loop. A 401/403 from an explicit button click (a freshly chosen account) keeps the original "isn't authorized" message instead of reloading, since that one can genuinely be an unallowlisted account.
- While offline, that fetch fails over the network instead (there's no reaching n8n offline either), and the service worker's existing cache-fallback handling serves the last successful pricing response, exactly as it always has for offline visits, see `service-worker.js`. Because that path never actually reaches n8n, it doesn't matter that the replayed token may have since expired, it only needs to exist so the fetch has a header value to send; nothing is actually re-verified until the visitor is back online.
- If a stored session's account turns out not to be allowlisted (401/403), `disableAutoSelect()`/`clearStoredGoogleSession()` runs so a rejected account's token isn't kept around to replay again.
- This stored token is cleared on sign-out and on a 401/403 (account no longer allowlisted), same as it's set on a successful sign-in.

### What's needed from GCP

1. A Google Cloud project (existing org project, or a new one dedicated to this).
2. **OAuth consent screen**, configured once per project:
   - User type: **External** (needed since the allowlist may include email addresses outside the org's own Workspace domain, e.g. dealers/manufacturers on personal Gmail).
   - Publishing status: if the allowlist is small (fewer than 100 people), leave it in **Testing** and add each allowed email as a "test user" there — this gives a free, Google-enforced second check on top of n8n's own allowlist. If it needs to scale past 100 or avoid the "unverified app" warning screen, it'll need to go through **Production**/verification instead, at which point the allowlist is enforced by n8n alone.
3. **Credentials > Create Credentials > OAuth client ID**, type **Web application**.
   - **Authorized JavaScript origins**: add every origin this app is actually served from, e.g. `http://localhost:4173` for local dev, plus whatever the production origin is (per the Deployment section above, currently `http://34.20.174.32`, or the real domain once one exists).
   - **Authorized redirect URIs**: none needed, the Google Identity Services button/One Tap flow used here doesn't redirect.
4. The resulting **Client ID** (looks like `xxxxxxxxxxxx-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy.apps.googleusercontent.com`). This is public, safe to commit, it identifies the app requesting sign-in, it's not a secret and grants nothing by itself. Drop it into `GOOGLE_CLIENT_ID` in `app.js` (currently a `REPLACE_ME` placeholder).
   - No client secret is needed anywhere for this flow, not in this repo and not in n8n; ID-token verification only needs the token itself plus this same Client ID (to check the `aud` claim matches) and Google's public signing keys, all fetchable without any credential.
5. The actual **explicit email allowlist** (since that's the access model chosen here) isn't a GCP setting by itself, it's a list n8n needs to check the signed-in email against, maintained wherever's convenient (a sheet, an n8n variable, etc.). If Testing mode's 100-person test-user list (#2 above) is used, that list should stay in sync with whatever n8n checks, so a removed access doesn't linger as a valid sign-in that then just gets rejected downstream, or vice versa.

### What n8n needs to change

The `camo-cpq-pricing` webhook currently checks `?p=` against a fixed password. It needs to instead:

1. Read the token from the `Authorization: Bearer <idToken>` header (no more `?p=` param to check).
2. **Verify the ID token's signature** against Google's public keys (JWKS at `https://www.googleapis.com/oauth2/v3/certs`), don't trust the JWT's claims until the signature checks out. Most JWT/Google-auth libraries available in an n8n Function/Code node (e.g. `google-auth-library`'s `verifyIdToken`, or a generic JWKS-verifying JWT library) do this in one call. Reject with 401 if verification fails for any reason.
3. Confirm the token's `aud` claim equals the GCP OAuth Client ID from above, and `iss` is `https://accounts.google.com` or `accounts.google.com`, and `exp` hasn't passed. A verifying library normally checks all of this when given the expected audience; hand-rolled JWT decoding must check these explicitly.
4. Check the token's `email` claim against the maintained allowlist (see above). Reject with 401/403 if not present.
5. Only then behave exactly as it does today: return the sheet data for `sheet=products|options|packages`, same response shape as now, nothing about the JSON contract changes.
6. Because the client now sends a custom `Authorization` header instead of putting everything in the URL, this is no longer a "simple" CORS request, browsers will send a preflight `OPTIONS` request first. The webhook needs to respond to `OPTIONS` with `Access-Control-Allow-Origin`, `Access-Control-Allow-Headers: Authorization`, and `Access-Control-Allow-Methods: GET` (or however n8n's CORS handling is configured), or every pricing fetch will fail at the preflight before the actual GET is even sent.

## The `camo-cpq-pricing` endpoint

**This section describes the endpoint as it's actually live in n8n today, which is still the old password contract, not what `app.js` on `feature/google-auth` now sends. See "What n8n needs to change" above; this section needs a pass once that migration actually happens.**

Request (live today): `GET https://n8n.californiamobility.com/webhook/camo-cpq/pricing?p=<password>&sheet=<sheet>`, where `<sheet>` is one of `products`, `options`, or `packages`. Once n8n is migrated, the password query param goes away and the client instead sends `Authorization: Bearer <googleIdToken>`.

The n8n workflow behind this reads from a Google Sheet and can't fetch all three sheets in a single request without serializing them server-side, so `app.js` makes three separate calls, one per sheet, **in parallel** (`Promise.all`, see `fetchPricingData`), rather than one combined call. Omitting `sheet` entirely returns a `200` with an empty body, it's required.

This is currently a plain GET with no custom headers, so it does not trigger a CORS preflight today, it just needs the response itself to carry `Access-Control-Allow-Origin`, which it already does. Once migrated to the `Authorization` header, this stops being true, see point 6 under "What n8n needs to change" above, preflight `OPTIONS` handling will need to be added.

On a wrong password it currently returns `401` with `{"error":{"message":"Incorrect password"}}` for any `sheet` value; the client treats both 401 and 403 (from any of the three calls) as "unauthorized" and anything else non-2xx as "service unavailable." The post-migration 401/403 body shape (for an unrecognized/unauthorized Google account) is up to whoever implements the n8n side, `app.js` doesn't read the error body at all, it shows its own fixed message either way.

### Actual response shape (verified against the live endpoint)

Each call returns only the one key matching its `sheet` value, confirmed by calling it directly, not a spec written in advance:

```json
// ?sheet=products
{
  "products": [
    {
      "row_number": 2,
      "sku": "access--flowx--180",
      "base_sku": "access--flowx",
      "name": "FlowX with 180° turn",
      "customer_description": "Access Flow X 180 Curved Stairlift. ...",
      "manufacturer_description": "Curved Stairlift.  Package price for 1 single 180º turn",
      "price": 15745,
      "cost": 10600,
      "photo_url": "",
      "category": "Access FlowX"
    }
  ]
}
```

```json
// ?sheet=options
{
  "options": [
    {
      "row_number": 2,
      "sku": "access--flowx--auto-folding-footrest",
      "name": "Automatic Folding Footrest",
      "customer_description": "",
      "manufacturer_description": "Automatic folding footrest",
      "price": 600,
      "cost": 294,
      "configuration": "",
      "max_quantity": "",
      "category": "Chair Options",
      "compatible_base_product_skus": "access--flowx",
      "incompatible_option_skus": ""
    }
  ]
}
```

`configuration` and `max_quantity` are both consumed now (`app.js`, `normalizePricingData`):

- `configuration` is a comma-joined list of configuration choices, same convention as `compatible_base_product_skus`/`incompatible_option_skus` (e.g. `"Left, Right"`); empty/blank means the add-on has no configuration choice. Normalized into `configurations` (an array). When an add-on has 2+ configurations, a select appears under its card once checked (`addonExtrasHtml` in `app.js`), defaulting to the first listed choice until the user picks one (`getAddonConfiguration`).
- `max_quantity` is a plain number; blank/`0`/non-numeric all normalize to `1` (`Math.max(1, ...)` in `normalizePricingData`). When `max_quantity` is greater than 1, a quantity stepper (1 to `max_quantity`) appears under the add-on's card once checked, defaulting to 1 (`getAddonQuantity`). Quantity multiplies that add-on's price, cost, and tax everywhere: the add-on card's own displayed price, the Quote Summary line item and totals, and the `options[]` entries sent to `update-hs` (see below). Products have no quantity or configuration concept, this is add-ons only.

`?sheet=packages` returns `{"packages": [...]}`, shape documented separately below.

There is no `product_categories` / `option_categories` list anymore, the endpoint used to send these but no longer does. `app.js` derives both client-side from the `category` field on the products/options actually returned, deduped in first-seen order (`uniqueInOrder` in `normalizePricingData`). This means a category with zero products/options simply won't appear, there's no way to know about categories that exist in the sheet but have no rows.

Things that are easy to get wrong here, and did trip up earlier versions of this integration:

- The top-level keys are `products` / `options`, not `productCategories` / `addonCategories` / `addons`.
- Prices are under `price` / `cost`, not `unit_price` / `unit_cost`.
- There are two description fields, `customer_description` and `manufacturer_description`. Either can be empty. For products, the app displays `manufacturer_description` (falling back to `customer_description` if that's blank); `customer_description` is kept as `customerDescription` on the normalized object for the HubSpot push, not shown in the UI. For add-ons, no description is shown at all, `customerDescription` is still kept on the normalized object for the same reason.
- **`compatible_base_product_skus` lists a product's `base_sku`, not its `sku`.** A product's own `sku` is the specific variant (e.g. `access--flowx--180`), but add-on compatibility is scoped to the `base_sku` (e.g. `access--flowx`), which is shared across all variants of that base product. Matching an add-on's compatible list against `product.sku` instead of `product.base_sku` will silently show zero compatible add-ons for every product. `app.js` normalizes this into `parentBaseSkus` and matches against `product.baseSku`.
- `compatible_base_product_skus` and `incompatible_option_skus` are comma-joined strings (e.g. `"bruno--cre-2110, bruno--cre-2110e"`, note the space after the comma), not JSON arrays. `app.js` splits and trims these into arrays (`normalizePricingData` / `splitSkuList`).
- `incompatible_option_skus` refers to full option `sku` values (not base skus), matched directly.

## Local development

`.claude/launch.json` defines a single `static-site` config (`python3 -m http.server 4173`, serving `html/`), matching how the production host serves everything from one root now. There is no build step, edit `app.js` directly and reload.

The app itself is at `http://localhost:4173/sales.californiamobility.com/cpq/`, not the server root, opening `http://localhost:4173/` locally hits the redirect stub described above. Because the whole `html/` tree is now one server root both locally and in production, the relative `global.css` link resolves correctly in both places, there's no longer a local/production split to work around here.

Since the `python3 -m http.server` in `.claude/launch.json` binds all interfaces, not just `localhost`, a phone on the same wifi can reach it at `http://<this computer's LAN IP>:4173/sales.californiamobility.com/cpq/` too, useful for testing on a real device without deploying.

### Skipping Google Sign-In locally

Google Identity Services is registered against specific origins (see "What's needed from GCP" above, currently just `http://localhost:4173`); a phone's LAN-IP origin isn't one of them, so the Google button may not work there at all. `app.js` (see "local dev auth bypass" comment near `fetchPricingData`) can skip Google entirely on both localhost and a phone-over-LAN-IP, still loading real pricing data via the old `?p=` password n8n still accepts:

1. Copy `dev-auth.local.js.example` to `dev-auth.local.js` (same directory), fill in the password.
2. `dev-auth.local.js` is gitignored, never committed, so the password never ships in source anyone could view on the live site.
3. This only ever activates when the page's own hostname is `localhost`/`127.0.0.1`/a private LAN address (`isLocalDevHost()`), which production never is, and only when `dev-auth.local.js` is actually present. A yellow banner appears whenever it's active, and it's logged to the console.
4. Anyone else on the same wifi who found the file's URL while the dev server is running could read the password too. Fine for a trusted home/office network during dev, not a substitute for real auth anywhere else.
