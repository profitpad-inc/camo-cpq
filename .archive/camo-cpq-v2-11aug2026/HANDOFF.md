# Camo CPQ, Handoff Notes

## What this is

Camo CPQ is a small configure-price-quote tool. A user picks one product and any compatible add-ons, sees a live price/tax/discount/margin summary, and can push the resulting quote to HubSpot. It is a static, no-build, vanilla JavaScript single-page app, there is no backend server or database.

## How the app works, end to end

1. On load, the app shows a "Sign in with Google" button and fetches nothing until the visitor signs in.
2. On a successful Google sign-in, it calls the same n8n webhook three times in parallel, once per sheet (`https://n8n.californiamobility.com/webhook/camo-cpq/pricing?sheet=products|options|packages`), sending the Google ID token as `Authorization: Bearer <idToken>` on each request. A 401 or 403 from any of the three means the signed-in Google account isn't allowlisted, shown inline, no data loads. Any other non-2xx or network/CORS failure shows a generic "Could not reach the pricing service" message. On success, the three responses are merged into the product/add-on/package catalog, see the JSON contract below.
3. **Deal/product selection step** (new, between sign-in and the main CPQ layout, `state.step === "deal-select"`): the user either searches for an existing HubSpot deal or skips straight to a price lookup. See "The deal/product selection step" below.
4. The user opens a product category, selects one product. Add-ons scoped to that product appear, grouped by category, with incompatible add-ons disabled once a conflicting add-on is selected. Product cards and the Quote Summary show the manufacturer-facing description; add-on cards show no description at all (by request). The customer-facing description is still fetched and kept on each product/add-on as `customerDescription`, unused for display, reserved for the HubSpot push described below.
5. The summary panel computes subtotal, tax (the zip-based tax rate, see below, applied to the product's cost, plus that same rate applied to each add-on's price, not its cost), discount ($ or %), and total in real time. A "Show Margin" toggle reveals cost and margin percentage for internal use.
6. "Push to HubSpot" POSTs the quote to a separate n8n webhook (`https://n8n.californiamobility.com/webhook/camo-cpq/update-hs`), which updates the selected deal and its line items, voids any previous quotes on that deal, and creates a new quote, returning `quote_link` and `deal_link` URLs, which then render as buttons. This call is unauthenticated, it does not require the Google sign-in. An info icon next to "Push to HubSpot" (`pushHubspotInfoHtml` in `app.js`) surfaces this update/void/create-new behavior to the user before they click it.

   The POST body (`handlePushToHubspot()` in `app.js`):
   ```json
   {
     "hs_deal_id": "330227396341",
     "deal_name": "Some Deal Name",
     "deal_product": "Bruno_Elite_CRE_2110_E",
     "rep_first_name": "Chris",
     "rep_last_name": "Becher",
     "rep_email": "chris.becher@profitpad.com",
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
   `hs_deal_id`/`deal_name`/`deal_product` come from `state.selectedDeal` (from the deal-select step below) and are `null` when the user skipped straight to a price lookup; when present, the n8n workflow uses `hs_deal_id` to update that existing deal and its line items on the HubSpot side, void any previous quotes on it, and create a new quote. Each of `product` and every entry in `options` carries its own `tax_amount`, computed with the same formula described in step 5 (the product's `tax_amount` is its cost × the zip-based tax rate; each option's `tax_amount` is its price × that same rate, not its cost) and rounded to the nearest cent; the top-level `tax_amount` is their sum, also rounded to the nearest cent. `cost` and `margin` are the same combined-cost and margin-percentage figures shown behind the "Show Margin" toggle, not previously sent to this endpoint. `discount_amount` (dollars) and `discount_percentage` are both always populated as equivalent values regardless of which discount mode (`$` or `%`) the user typed into, computed from whichever one was entered. `tax_percentage` and `tax_location` come from the zip-based tax rate lookup described below (the "Install Address" zip and its looked-up rate); `currency` is still a static value sent on every request. `rep_first_name`/`rep_last_name`/`rep_email` identify which rep pushed the quote, from the signed-in Google account's `name`/`email` claims (`state.userName`/`state.userEmail`, set in `authenticateWithGoogle()`); `rep_first_name`/`rep_last_name` are split from the single `name` claim on the first space (`splitFullName()` in `app.js`), so a name with no space (or a multi-word last name) won't split perfectly. On the local dev auth bypass, which has no real Google token to read claims from, `state.userName` is hardcoded to `"Local dev"` (splitting to `rep_first_name: "Local"`, `rep_last_name: "dev"`) and `state.userEmail` is hardcoded to a real address so pushes from a dev session still land on a valid HubSpot owner.

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

## The `taxes` array (part of the `camo-cpq-pricing` response) and zip-based tax rate lookup

A fourth sheet, `?sheet=taxes`, same `PRICING_URL` endpoint as `products`/`options`/`packages`, same `Authorization: Bearer <idToken>` / dev-bypass `?p=<password>` credential as those three, and confirmed working correctly under both. It's fetched separately from them (not in the same all-or-nothing `Promise.all`, see `fetchTaxRates()` in `app.js`), so a miss here just means no tax rates loaded this session rather than a broken sign-in — a deliberate exception to the "any failure is fatal" rule the other three sheets use, since this one is newer and more likely to have rough edges while it settles in. Once it succeeds at least once, it's merged into the same combined pricing payload as `products`/`options`/`packages` and gets the same app-level cache treatment described below, plus the service worker's own offline/cache fallback underneath that, with no extra code.

Response is `{"taxes": [...]}` (~1816 rows), same wrapped-object shape as `products`/`options`/`packages`; `fetchTaxRates()` in `app.js` also tolerates a bare top-level array (`Array.isArray(data) ? data : data.taxes || []`), since the n8n workflow briefly returned it unwrapped that way during initial testing. Each row:

```json
{
  "row_number": 2,
  "Zip": 90001,
  "City": "Los Angeles",
  "County": "Los Angeles County",
  "Stairlift Region": "Los Angeles",
  "State": "CA",
  "tax_rate": 0.0975,
  "rate_type": "City"
}
```

Only `Zip` and `tax_rate` are used, everything else (`City`/`County`/`Stairlift Region`/`State`/`rate_type`/`row_number`) is thrown out. `normalizeTaxRates()` in `app.js` builds a plain zip-string -> `tax_rate` lookup (`state.taxRates.byZip`), re-padding each `Zip` to 5 digits since the sheet returns it as a bare number (e.g. `90001`), which would otherwise silently drop a leading zero on a zip outside CA's `9xxxx` range.

The sheet carries one special row for this, always last in the response: `"Zip": "zip_unknown"` (a literal string, not a real zip), whose `tax_rate` is the fallback rate. `getTaxRate(zip)` (`app.js`) looks up `state.shipTo.zip` first and falls back to this `zip_unknown` rate whenever the ship-to zip is blank or isn't a recognized key, this is also what's shown/sent before a deal (and its zip) has been selected at all.

This rate is looked up from the editable "Install Address" zip (`state.shipTo.zip`, see below), the only zip captured anywhere in the app; it's shown next to the margin percentage once "Show Margin" is toggled (`summarySectionHtml()`), and it populates `tax_percentage` (as a percent, e.g. `9.75` for a `0.0975` rate) and `tax_location` (the zip itself) in the `update-hs` push body below, both of which used to be hardcoded stub values (`5` and `"12345"`) before this lookup existed. It also drives the actual `tax_amount` dollar figure everywhere it's computed (the Quote Summary display and the `update-hs` push body): `product cost * tax rate`, plus `add-on price * tax rate` for each selected add-on (add-on cost is not taxed). An earlier version of this formula also taxed each add-on's cost on top of its price and taxed the product's combined cost (product + all add-ons) rather than just the product's own cost, both double-counted and have been corrected.

## The pricing data cache (options/packages/taxes; `products` is deliberately excluded)

`products` is split out from the other two core sheets (`fetchProductsSheet()`/`fetchProductsSheetWithDevPassword()` in `app.js`) and always fetched fresh, every single call, never through the cache described below. It's the sheet whose 401/403 response doubles as this session's live auth check, so it can't be allowed to go stale, an account whose access was just revoked needs to be caught immediately, not masked by a still-fresh cache of some other sheet. "Fetched fresh" still just means a plain `fetch()` call, so it goes through the service worker's own network-first-with-cache-fallback (see below) like any other request: fresh whenever the network's actually reachable, last-known-good from the service worker's cache when it isn't.

The merged `options`/`packages`/`taxes` payload (the combined return value of `fetchOptionsPackagesAndTaxes()`/`fetchOptionsPackagesAndTaxesWithDevPassword()`) is cached separately, in `localStorage` (`cpq-pricing-cache`, raw pre-normalization shape, alongside the time it was fetched), since none of the three gate access on their own, they're just catalog data, so a routine sign-in doesn't need to cost a round-trip to n8n for them every time. `loadPricingData()` in `app.js` wraps both auth paths and decides what to do based on the cache's age:

- **Under 48 hours old**: used as-is, no network call at all.
- **48 hours to 30 days old**: a fresh fetch is attempted if `navigator.onLine`, and the cache is overwritten on success; if that fetch fails for any reason other than an outright `unauthorized` result (a real 401/403), the stale-but-still-under-30-days cache is served instead of surfacing an error over what would otherwise just be a network hiccup. If the browser is offline, the cache is used without even attempting the fetch.
- **30+ days old, or no cache yet**: always fetched fresh, no fallback; this is the outer bound past which stale pricing data shouldn't be trusted even as a last resort.

An explicit page reload (`performance.getEntriesByType("navigation")[0].type === "reload"`, checked by `isExplicitPageReload()`) always forces a fresh fetch of `options`/`packages`/`taxes` regardless of the cache's age (`products` is already always-fresh, see above, so a reload changes nothing for it). This covers both a plain refresh (F5/Cmd+R) and a true cache-bypassing hard reload (Cmd+Shift+R/Ctrl+Shift+R); JS has no reliable, cross-browser way to tell those two apart, so both are treated as "the visitor explicitly asked for a fresh load," the safer failure mode for a live pricing tool than silently continuing to serve a cache the visitor is actively trying to shake loose.

This `options`/`packages`/`taxes` cache lives underneath (and is separate from) the service worker's own network-first-with-cache-fallback handling described below, it's what actually avoids the network call in the first place for those three; the service worker's own cache is still what serves any of the four sheets on a genuinely offline visit once a fetch is actually attempted (`products` always attempts one; `options`/`packages`/`taxes` only do once 30+ days stale, or on an explicit reload, while offline). It's also separate from the Google sign-in session cache (`GOOGLE_SESSION_STORAGE_KEY`, see below), which is about staying signed in, not about the pricing data itself; the caches don't interact.

### Re-checking auth on resume, not just on load

"`products` is always fetched fresh" above only actually holds if the boot code that calls `fetchPricingData()` runs in the first place, and that code (near the bottom of `app.js`, under `--- boot ---`) is one-time, top-level script execution — it does not automatically re-run just because the visitor comes back to an already-loaded page. Closing a tab and opening a new one to the same URL is a fresh navigation, so that's not an issue; but switching away and back, minimizing/restoring the window, or backgrounding and foregrounding this app once installed as a PWA (`manifest.json` supports "Add to Home Screen") can all resume the exact same JS execution without reloading anything, in which case the products-sheet auth check simply never fires again, even while online the whole time.

`revalidateAuthOnResume()` in `app.js` covers this: it's wired to both `visibilitychange` (fires whenever the tab/window/app becomes visible again) and `pageshow` with `event.persisted` (specifically covers a same-page restore from the browser's back/forward cache, which doesn't reliably fire `visibilitychange` in every browser). Whenever either fires, if the visitor is already signed in (not the local dev bypass, which has no real token to re-check) and the browser reports itself online, it re-runs just `fetchProductsSheet()` with the stored session's ID token, the same auth check `fetchPricingData()` already does on a real load, without touching `options`/`packages`/`taxes` or anything else about the current session, so an in-progress product/add-on/deal selection is left alone. A 401/403 here is handled the same way a rejected stored-session replay is handled at boot: clear the stored session and reload straight into a clean sign-in screen, which can interrupt whatever the visitor was doing, accepted as the safer failure mode over continuing to let a revoked account use pricing data.

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
| `html/sales.californiamobility.com/service-worker.js` | PWA offline caching; deliberately lives one directory *above* `cpq/`, not inside it, see "Service worker scope" below |
| `html/sales.californiamobility.com/cpq/manifest.json` | PWA manifest (name, icons, standalone display) |
| `html/sales.californiamobility.com/globals/global.css` | Shared brand tokens + reset, meant to be reused by other California Mobility webtools, not just this one (renamed from `static.californiamobility.com/`, since it's not actually a separate host). Lives under `sales.californiamobility.com/`, a sibling of `cpq/` and of `service-worker.js`, **not** at the `html/` root — this doc previously said `html/globals/`, that was stale relative to an earlier restructuring |
| `html/sales.californiamobility.com/globals/index.html` | Same redirect stub pattern, to `../cpq`, still unclear why this folder needs one at all, worth a quick check with the team |

The `sales.californiamobility.com` folder name is a holdover from when this was conceptually two subdomains; it's kept because the live host serves it at that path (`http://34.20.174.32/sales.californiamobility.com/cpq`, per the redirect targets), not because there's an actual subdomain behind it, it's all one server now.

## Deployment

This app deploys as a single static site rooted at `html/`. `sales.californiamobility.com/cpq/index.html` links `global.css` with a relative path (`../globals/global.css`, one level up from `cpq/` into the sibling `globals/` folder), and `service-worker.js` does the same from its own location one level further up (`./globals/global.css`, since from there `globals/` is a direct sibling, not one level up) — both resolve because `globals/` lives under `sales.californiamobility.com/` alongside `cpq/` and `service-worker.js`, not at the `html/` root. No nginx configs exist in this repo currently; if they exist, they're managed outside this codebase.

## Service worker scope: why it lives outside `cpq/`

`service-worker.js` lives at `html/sales.californiamobility.com/service-worker.js`, one directory above `cpq/`, not inside it. This matters for offline use of the no-trailing-slash URL, `https://sales.californiamobility.com/cpq` — which isn't a typo/edge case, it's the actual redirect target of `sales.californiamobility.com/index.html`'s meta-refresh (`url=./cpq`, see the file map above).

A service worker only intercepts requests whose URL starts with its scope string, and by default that scope is the directory containing the SW script itself. With the file at `cpq/service-worker.js`, the default scope is `.../cpq/` (trailing slash); `.../cpq` (no slash) doesn't start with that string, so a visit to the no-slash URL was never actually controlled by the service worker at all, no fetch handler in this file could ever run for it, no matter what that handler did. Online, that visit still "worked" because the browser could reach the network directly; offline, there was nothing installed to catch it, so it failed outright, while `.../cpq/` (with the slash) worked fine since that's the URL the service worker actually installs itself against on a normal first visit.

Moving the file up one level makes its default scope `.../sales.californiamobility.com/`, which is a prefix of both `.../cpq` and `.../cpq/`, so both are covered. `PRECACHE_URLS` and the navigate-fallback path in `service-worker.js` were updated to the new `./cpq/...`-relative paths to match (they're relative to the *service worker's own* location, not the page's).

The registration call itself (`navigator.serviceWorker.register(...)` in `app.js`, near the bottom) doesn't use a plain relative `"./service-worker.js"` string, for a related reason: a relative path resolves against *the current page's own URL*, so `"./service-worker.js"` from a document loaded at the no-slash `.../cpq` would actually resolve one level too high (to `.../service-worker.js`, wrong location) instead of `.../cpq/service-worker.js`, since `.../cpq` has no trailing slash to resolve "the current directory" against.

An earlier version of this worked around that by hardcoding the absolute path `/sales.californiamobility.com/service-worker.js`, which broke once this app started being served with `sales.californiamobility.com` as the real domain root rather than an IP + `/sales.californiamobility.com/cpq` path, since the hardcoded prefix then doubled up (`sales.californiamobility.com/sales.californiamobility.com/service-worker.js`, a 404 whose response's `text/html` body then also fails registration with an "unsupported MIME type" error). It's resolved instead against this script's *own* URL: `APP_SCRIPT_URL` (`document.currentScript.src`, captured once at the top of `app.js` while that's still reliable, since `document.currentScript` is `null` again by the time the `"load"` listener that actually calls `register()` runs) plus `new URL("../service-worker.js", APP_SCRIPT_URL)`. Since `APP_SCRIPT_URL` always ends in the literal file `cpq/app.js`, "one directory up" is unambiguous regardless of the page's own URL shape or of whatever path this app is actually deployed under.

`CACHE_NAME` was bumped (`cpq-v2-cache-v5` → `cpq-v2-cache-v6`) alongside this move so returning visitors' browsers install the new precache list under the new scope rather than continuing to serve out of the old one.

`service-worker.js`'s `PRECACHE_URLS` now points at `../../globals/global.css` (was the old absolute `https://static.californiamobility.com/global.css`, a host that no longer factors into this setup), matching the relative-path scheme used everywhere else under `html/`.

## Google sign-in

**Status: client-side half is fully implemented and merged to `main` (the old `feature/google-auth` branch it started on has been deleted, it was already an ancestor of `main`), including a real GCP OAuth Client ID in `GOOGLE_CLIENT_ID` in `app.js`. Whether the n8n workflow has actually been updated to verify tokens (see spec below) isn't visible from this repo and hasn't been independently re-confirmed here; until it has, this doesn't function as a real gate, same as the old password wasn't a real gate without the n8n check.**

The password gate (`?p=<password>`, checked server-side by n8n) has been replaced with Google Sign-In. There is still no client-side secret, the security boundary is entirely server-side; the client's job is only to obtain a Google ID token and attach it to the pricing request, not to decide who's allowed in.

- `app.js` loads the Google Identity Services script (`https://accounts.google.com/gsi/client`, tag added in `index.html`) and renders the standard "Sign in with Google" button (`renderGoogleButton()`, `shape: "pill"` for the roundest corners Google's button supports, it's rendered inside a cross-origin iframe so its CSS isn't otherwise ours to override) in place of the old password form.
- Sign-in is a hard gate in front of everything else, including the deal search step: `appHtml()` only renders the deal-select screen once `state.authed` is true, never speculatively while a sign-in attempt is still in flight. (The `?hs_deal_id=` auto-lookup network call itself can still kick off immediately on boot, same as before, since that endpoint needs no auth either way, it's just that nothing about it is shown to the visitor until they've signed in.)
- On sign-in, Google calls back with a signed ID token (a JWT). `app.js` sends it as `Authorization: Bearer <idToken>` on each of the three pricing sheet requests (`fetchPricingData` in `app.js`), instead of the old `?p=` query param.
- A 401/403 from any of the three calls means "this Google account isn't authorized," shown inline, same as a wrong password before. `app.js` never decides this itself, it only reacts to what n8n returns.
- The token payload is decoded client-side purely for display (`decodeIdTokenPayload`). The signed-in account is shown via an avatar button in the site header (`headerUserMenuHtml`/`renderHeaderUserMenu` in `app.js`, rendered into the static `#header-user-menu` placeholder in `index.html`, outside `#app`, same pattern as the Google Sign-In button), showing the account's initials; clicking it opens a small panel with the full email and a "Sign out" button. This is not verification, reading a JWT's own claims proves nothing about its authenticity; n8n verifying the signature is what actually matters.

### Returning visitors, online or offline

The last successfully-verified ID token is kept in `localStorage` (`cpq-google-last-session`, see `GOOGLE_SESSION_STORAGE_KEY` in `app.js`), and on boot, if one is found, it's replayed straight into `authenticateWithGoogle()`, skipping Google's own sign-in flow entirely, the same effect the old stored-password auto-retry had.

- While online, that replayed token still goes through the normal `Authorization: Bearer` pricing fetch, so n8n fully re-verifies it (signature, `aud`, `exp`) exactly as it would a fresh token; an expired or no-longer-allowlisted token is rejected (401/403). Since a stored session can only exist for an account that was previously allowlisted, a 401/403 on this specific replay path is treated as a plain expiry rather than "account isn't authorized": `authenticateWithGoogle(idToken, isStoredSessionReplay)` in `app.js` clears the stored session and immediately calls `window.location.reload()` instead of showing an error. Because the stored session is already cleared before the reload, the next boot has nothing left to replay, so this can't loop.
- **Only on that reload does the visitor actually not need to click anything**: with no stored session left to replay, `bootGoogleAuth()` calls `initGoogleAuth(attemptSilentSignIn: true)`, which sets `auto_select: true` on `google.accounts.id.initialize()` and immediately calls `google.accounts.id.prompt()`, a silent one-tap sign-in against the browser's own live Google account session (independent of anything this app stores). If that browser is still signed into the same Google account, this gets a fresh ID token and re-authenticates with no click at all; the explicit "Sign in with Google" button is still rendered underneath as a fallback for whenever one-tap doesn't fire (no active Google session, the visitor dismissed it before, third-party-cookie restrictions, etc). One-tap is only attempted when there's no stored session to replay in the first place, replaying is always tried first.
- A 401/403 from an explicit button click (a freshly chosen account) keeps the original "isn't authorized" message instead of reloading, since that one can genuinely be an unallowlisted account, and this is the only case that calls `disableAutoSelect()`. A plain stored-session-replay expiry (the common case, since the ID token's own lifetime is short) deliberately does **not** call `disableAutoSelect()`, doing so would tell Google to stop silently offering that account and defeat the one-tap re-sign-in on the very next reload; `revalidateAuthOnResume()`'s mid-session 401 handling follows the same rule for the same reason.
- While offline, that fetch fails over the network instead (there's no reaching n8n offline either), and the service worker's existing cache-fallback handling serves the last successful pricing response, exactly as it always has for offline visits, see `service-worker.js`. Because that path never actually reaches n8n, it doesn't matter that the replayed token may have since expired, it only needs to exist so the fetch has a header value to send; nothing is actually re-verified until the visitor is back online.
- If a stored session's account turns out not to be allowlisted via an explicit button click (401/403), `disableAutoSelect()`/`clearStoredGoogleSession()` runs so a rejected account's token isn't kept around to replay again, and one-tap won't keep silently offering it either.
- This stored token is cleared on sign-out and on any 401/403, same as it's set on a successful sign-in. Sign-out (`signOut()`) also calls `disableAutoSelect()`, an explicit sign-out shouldn't be immediately undone by a silent one-tap re-sign-in on the next load.

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

**This section describes the endpoint's original password contract. `app.js` on `main` has already switched to sending `Authorization: Bearer <googleIdToken>` instead (see "Google sign-in" above); whether n8n has actually been updated to match isn't visible from this repo. See "What n8n needs to change" above; this section needs a pass once that's confirmed.**

Request (original contract): `GET https://n8n.californiamobility.com/webhook/camo-cpq/pricing?p=<password>&sheet=<sheet>`, where `<sheet>` is one of `products`, `options`, or `packages`. Once n8n is migrated, the password query param goes away and the client instead sends `Authorization: Bearer <googleIdToken>`.

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
