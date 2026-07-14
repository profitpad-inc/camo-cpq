# Camo CPQ, Handoff Notes

## What this is

Camo CPQ is a small configure-price-quote tool. A user picks one product and any compatible add-ons, sees a live price/tax/discount/margin summary, and can push the resulting quote to HubSpot. It is a static, no-build, vanilla JavaScript single-page app, there is no backend server or database.

## How the app works, end to end

1. On load, the app shows a password form and fetches nothing until it is submitted.
2. On submit, it calls the same n8n webhook three times in parallel, once per sheet (`https://n8n.californiamobility.com/webhook/camo-cpq/pricing?p=<password>&sheet=products|options|packages`). A 401 or 403 from any of the three means wrong password, shown inline, no data loads. Any other non-2xx or network/CORS failure shows a generic "Could not reach the pricing service" message. On success, the three responses are merged into the product/add-on/package catalog, see the JSON contract below.
3. **Deal/product selection step** (new, between password and the main CPQ layout, `state.step === "deal-select"`): the user either searches for an existing HubSpot deal or skips straight to a price lookup. See "The deal/product selection step" below.
4. The user opens a product category, selects one product. Add-ons scoped to that product appear, grouped by category, with incompatible add-ons disabled once a conflicting add-on is selected. Product cards and the Quote Summary show the manufacturer-facing description; add-on cards show no description at all (by request). The customer-facing description is still fetched and kept on each product/add-on as `customerDescription`, unused for display, reserved for the HubSpot push described below.
5. The summary panel computes subtotal, tax (10% of the combined cost of everything selected, plus an extra 10% of each add-on's price on top, this is a pre-existing quirk in the original pricing formula, not something introduced here), discount ($ or %), and total in real time. A "Show Margin" toggle reveals cost and margin percentage for internal use.
6. "Push to HubSpot" POSTs the quote to a separate n8n webhook (`https://n8n.californiamobility.com/webhook/camo-cpq/update-hs`), which updates the selected deal and its line items, voids any previous quotes on that deal, and creates a new quote, returning `quote_link` and `deal_link` URLs, which then render as buttons. This call is unauthenticated, it does not use the site password. An info icon next to "Push to HubSpot" (`pushHubspotInfoHtml` in `app.js`) surfaces this update/void/create-new behavior to the user before they click it.

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
       { "name": "...", "description": "...", "sku": "...", "price": 0, "cost": 0, "tax_amount": 0 }
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
     "total": 0
   }
   ```
   `hs_deal_id`/`deal_name`/`deal_product` come from `state.selectedDeal` (from the deal-select step below) and are `null` when the user skipped straight to a price lookup; when present, the n8n workflow uses `hs_deal_id` to update that existing deal and its line items on the HubSpot side, void any previous quotes on it, and create a new quote. Each of `product` and every entry in `options` carries its own `tax_amount`, computed with the same pre-existing quirky formula described in step 5 (cost × 10% for both, plus an extra price × 10% for options only) and rounded to the nearest cent; the top-level `tax_amount` is their sum, also rounded to the nearest cent. `cost` and `margin` are the same combined-cost and margin-percentage figures shown behind the "Show Margin" toggle, not previously sent to this endpoint. `discount_amount` (dollars) and `discount_percentage` are both always populated as equivalent values regardless of which discount mode (`$` or `%`) the user typed into, computed from whichever one was entered. `tax_percentage`, `tax_location`, and `currency` are static values sent on every request, not computed from the quote.

## The deal/product selection step

Sits between the password gate and the main product/add-on/summary layout (`dealSelectSectionHtml()` in `app.js`, gated on `state.step === "deal-select"`).

- A search box calls `GET https://n8n.californiamobility.com/webhook/camo-cpq/hs-fetch?fetch=deals&search=<term>` once the trimmed input is 2+ characters, debounced 300ms. The endpoint accepts either a text search (matches on deal name) or a HubSpot deal record ID (e.g. `330227396341`), same query param either way.
- Response shape (verified against the live endpoint): `{"hs_deals": [{"createdate": "...", "dealname": "...", "hs_lastmodifieddate": "...", "hs_object_id": "...", "product": "..."}]}`. A search with no matches returns `200` with an **empty body**, not `{}` or `{"hs_deals": []}`, `app.js` handles this explicitly in `fetchDeals()`.
- `deal.product` is the HubSpot dropdown value for the package chosen on that deal (e.g. `"Bruno_Elite_CRE_2110_E"`), it is matched against each package's `hs_product_dropdown_property_value` (see below) to figure out which product/add-on SKUs to preselect. It can be `null`/`"N/A"`/an unrecognized value for older or manually-entered deals, in which case nothing is preselected and a small notice is shown instead of failing silently.
- Selecting a deal from the search results, or a successful `?hs_deal_id=` auto-lookup (see below), preselects that deal's matched product and option SKUs and jumps straight to the main CPQ layout.
- "Skip, just do a price lookup" jumps to the main CPQ layout with nothing preselected.
- **`?hs_deal_id=<record id>` query param**: on boot, if present, the app immediately calls the same `hs-fetch` search with that ID, in parallel with (not waiting on) the password-gated pricing fetch, since the deal lookup needs no password. The deal-select page shows a "Looking up deal…" spinner for as long as this is unresolved. An exact `hs_object_id` match skips the picker entirely and preselects like a manual selection would; no match shows an inline "Deal not found" notice and falls back to the normal search/skip picker.
- If the browser is offline (`state.isOnline` false, tracked via the `online`/`offline` window events), the deal-select step is skipped altogether and the app goes straight to the main CPQ layout as if "Skip — just do a price lookup" had been clicked (`resolveInitialStep()`, called once pricing data has loaded). This covers both cases: a `?hs_deal_id=` is present (the auto-lookup itself is skipped, no request attempted) and no `?hs_deal_id=` at all (the picker never appears, there's no working search without a connection). Only the automatic paths are affected; the manual search box will still attempt a search if the picker is showing and the user tries it while offline, it just surfaces a "Could not search deals" error like any other failed fetch.

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

| File | Purpose |
|---|---|
| `index.html` | Page shell, loads `app.js` |
| `app.js` | Everything: password form, pricing fetch + normalization, rendering, the HubSpot push |
| `styles.css` | Compiled Tailwind output |
| `service-worker.js`, `manifest.json`, `favicon*.png` | PWA shell, offline caching |

## Password protection

There is no client-side secret to hide, the password is only meaningful because the n8n workflow checks it. `app.js` appends whatever the visitor types as a `?p=` query parameter on the pricing request; it never stores, hashes, or validates it locally. A wrong password gets a 401/403 from the endpoint itself, and no product or add-on data is ever returned to the browser until the workflow accepts it. Since this is enforced server-side by n8n, changing the password is entirely an n8n-side change, nothing in this repo needs to change or be rebuilt.

**Current password (as of this writing): `13jul2026`.**

### Remembering the password across sessions

On a successful unlock, the password is saved to `localStorage` (`cpq-pricing-password`). On every future load, `app.js` retries that stored password automatically, skipping the login form entirely, it shows the deal-select step right away (see below) while the retry is in flight. If the pricing endpoint accepts it (or serves a cached response, see below), the person never sees the password prompt at all on that device. If it comes back 401/403 (e.g. the password was changed server-side), the stored value is cleared and a normal empty login form appears instead.

This also covers offline use: the service worker (`service-worker.js`) does network-first-then-cache for every GET request, including these cross-origin pricing fetches, so the first successful online unlock leaves a cached response for each of the three sheet URLs (password included in the query string). Replaying the same stored password while offline hits those caches instead of failing, so a returning offline visitor who already unlocked once doesn't get stuck on the password screen either.

## The `camo-cpq-pricing` endpoint

Request: `GET https://n8n.californiamobility.com/webhook/camo-cpq/pricing?p=<password>&sheet=<sheet>`, where `<sheet>` is one of `products`, `options`, or `packages`.

The n8n workflow behind this reads from a Google Sheet and can't fetch all three sheets in a single request without serializing them server-side, so `app.js` makes three separate calls, one per sheet, **in parallel** (`Promise.all`, see `fetchPricingData`), rather than one combined call. Omitting `sheet` entirely returns a `200` with an empty body, it's required.

This is a plain GET with no custom headers, so it does not trigger a CORS preflight, it just needs the response itself to carry `Access-Control-Allow-Origin`, which it already does.

On a wrong password it currently returns `401` with `{"error":{"message":"Incorrect password"}}` for any `sheet` value; the client treats both 401 and 403 (from any of the three calls) as "wrong password" and anything else non-2xx as "service unavailable."

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
      "category": "Chair Options",
      "compatible_base_product_skus": "access--flowx",
      "incompatible_option_skus": ""
    }
  ]
}
```

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

`.claude/launch.json` defines a `static-site` config (`python3 -m http.server 4173`) for previewing the site. There is no build step, edit `app.js` directly and reload.
