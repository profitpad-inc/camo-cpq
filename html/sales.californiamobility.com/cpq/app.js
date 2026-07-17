// Vanilla JS port of an earlier React version of this app.
// Single mutable `state` object + one full re-render per state change,
// with focus/selection preserved across re-renders (see restoreFocus below).

// document.currentScript is only reliable during this script's own
// synchronous top-level execution (see below, not inside the "load"
// listener), so its URL is captured into a plain variable here for later
// use, rather than re-reading document.currentScript at registration time.
const APP_SCRIPT_URL = document.currentScript && document.currentScript.src;

function classNames(...arr) {
  return arr.filter(Boolean).join(" ");
}

// How long to wait after the user stops typing in a search box before doing
// anything about it — re-rendering the (filtered) picker for the product/
// add-on searches (setProductSearchQuery/setAddonSearchQuery below), or
// firing the actual network search for the deal search (setDealSearchQuery/
// runDealSearch below).
const SEARCH_DEBOUNCE_MS = 500;

// This app has no login or payment fields, so a password/payment-manager
// browser extension (1Password, LastPass, Bitwarden, Dashlane, etc.)
// offering to fill or save into any of its inputs is always a false
// positive — these are the respective attributes each one looks for to opt
// a field out. Spliced into every <input>/<select>/<textarea> below. This
// does NOT touch the key/credit-card/location-pin icon row iOS itself shows
// above the keyboard, that's a system-level WebKit/keyboard feature outside
// any web page's control (same on Safari and Chrome on iOS, since both sit
// on top of the same OS keyboard), only toggleable from the device's own
// Settings, not from here.
const FIELD_NO_AUTOFILL_ATTRS =
  'autocomplete="off" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-dashlane-ignore="true" data-form-type="other"';

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});
const currencyWhole = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// yyyy-mm-dd in the visitor's local time, what a native <input type="date">
// expects/returns.
function formatDateInput(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Quotes default to expiring 30 days out; the rep can still edit it per quote.
function defaultQuoteExpirationDate() {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return formatDateInput(d);
}

// --- pricing data (Google-auth-gated) ---
const PRICING_URL = "https://n8n.californiamobility.com/webhook/camo-cpq/pricing";
const HS_FETCH_URL = "https://n8n.californiamobility.com/webhook/camo-cpq/hs-fetch";
const HUBSPOT_DEAL_URL_BASE = "https://app-na2.hubspot.com/contacts/4185119/record/0-3/";

// From the OAuth 2.0 Client ID (type "Web application") created in the GCP
// project's "APIs & Services > Credentials" page. Public value, safe to ship
// client-side, it only identifies which app is requesting sign-in; it is not
// a secret and does not grant access by itself. See HANDOFF.md for the full
// GCP setup checklist and what n8n needs to verify on its end.
// chris.becher@profitpad.com https://console.cloud.google.com/auth/clients?project=camobility 
const GOOGLE_CLIENT_ID = "1062410601074-lkp9bo5oi2s893asvk0saa4bdsq4pshg.apps.googleusercontent.com";

// Client asked to hide the per-line-item Cost column for now (margin % stays
// visible under "Show Margin"); flip this back on if they want it restored.
const SHOW_COST_COLUMN = false;

// Below this margin %, the "Show Margin" button and the margin % text turn a
// warning colour, whether or not the margin is currently shown.
const LOW_MARGIN_THRESHOLD = 30;

// The pricing endpoint backs onto a Google Sheet and can't fetch all its
// sheets in one request without serializing them server-side, so each sheet
// is fetched with its own &sheet= call. `products` is split out from
// `options`/`packages` below: it's always fetched fresh (see
// fetchProductsSheet), the other two are cache-eligible (see
// fetchOptionsPackagesAndTaxes/loadPricingData).
const GOOGLE_UNAUTHORIZED_MESSAGE =
  "Your Google account isn't <a href=\"https://n8n.californiamobility.com/workflow/ZBPvOf0Se3qv5WM3/ab615d\" target=\"_blank\">authorized</a> to view pricing.  Email chris.becher@profitpad.com for help.";
const DEV_BYPASS_UNAUTHORIZED_MESSAGE =
  "Dev bypass password was <a href=\"https://n8n.californiamobility.com/workflow/ZBPvOf0Se3qv5WM3/ab615d\" target=\"_blank\">rejected</a> by the pricing service.";

function checkPricingResponses(responses, unauthorizedMessage) {
  if (responses.some((res) => res.status === 401 || res.status === 403)) {
    const err = new Error(unauthorizedMessage);
    err.code = "unauthorized";
    throw err;
  }
  if (responses.some((res) => !res.ok)) {
    const err = new Error("Could not reach the pricing service. Please try again.");
    err.code = "unavailable";
    throw err;
  }
}

// Best-effort: a miss on the taxes sheet (network failure, unexpected
// response shape, etc.) just means no tax rates loaded this session, not a
// broken sign-in — unlike the sheets above, which do treat any failure as
// fatal. `fetchCall` is a thunk (not the fetch call directly) so this can be
// reused for both the Bearer-token and dev-password auth paths below.
//
// Unlike products/options/packages (each wrapped as `{"<sheet>": [...]}`),
// this sheet responds with a bare top-level array, not `{"taxes": [...]}`.
async function fetchTaxRates(fetchCall) {
  try {
    const res = await fetchCall();
    if (!res.ok) {
      console.warn(`[taxes] sheet=taxes returned ${res.status}, no tax rates loaded this session.`);
      return [];
    }
    const data = await res.json();
    return Array.isArray(data) ? data : data.taxes || [];
  } catch (e) {
    console.warn("[taxes] sheet=taxes fetch failed, no tax rates loaded this session.", e);
    return [];
  }
}

// This is the session's live auth check: fetched fresh every single call,
// never through the 48-hour/30-day cache below, so a revoked Google account
// is caught right away instead of being masked by a still-fresh
// options/packages/taxes cache. "Fresh every call" still means "fresh
// whenever the network's actually reachable" — the plain fetch() below goes
// through the service worker's own network-first-with-cache-fallback (see
// service-worker.js), so an offline visitor still gets last-known-good
// products data instead of being stranded.
async function fetchProductsSheet(idToken) {
  const res = await fetch(`${PRICING_URL}?sheet=products`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  checkPricingResponses([res], GOOGLE_UNAUTHORIZED_MESSAGE);
  const data = await res.json();
  return data.products || [];
}

// options/packages/taxes are just catalog data, not part of the auth check
// above, so they're fine to serve from the cache below rather than always
// hitting the network.
async function fetchOptionsPackagesAndTaxes(idToken) {
  const responses = await Promise.all(
    ["options", "packages"].map((sheet) =>
      fetch(`${PRICING_URL}?sheet=${sheet}`, { headers: { Authorization: `Bearer ${idToken}` } }),
    ),
  );
  checkPricingResponses(responses, GOOGLE_UNAUTHORIZED_MESSAGE);

  const [options, packages] = await Promise.all(responses.map((res) => res.json()));
  const taxes = await fetchTaxRates(() =>
    fetch(`${PRICING_URL}?sheet=taxes`, { headers: { Authorization: `Bearer ${idToken}` } }),
  );
  return {
    options: options.options || [],
    packages: packages.packages || [],
    taxes,
  };
}

async function fetchPricingData(idToken) {
  const [products, rest] = await Promise.all([
    fetchProductsSheet(idToken),
    loadPricingData(() => fetchOptionsPackagesAndTaxes(idToken)),
  ]);
  return { products, ...rest };
}

// --- pricing data cache (options/packages/taxes) ---
// n8n's sheet-backed pricing endpoint doesn't change often enough to justify
// a network round-trip on every single sign-in, so the merged
// options/packages/taxes payload (products is excluded, see
// fetchProductsSheet above) is cached in localStorage, alongside the fetch
// time, and reused as-is:
//   - under 48 hours old: used straight away, no network call at all.
//   - 48 hours to 30 days old: a fresh fetch is attempted if the browser is
//     online (updating the cache on success); if that fails for any reason
//     other than an outright unauthorized/unauthenticated response, the
//     stale-but-still-under-30-days cache is served instead of showing an
//     error over what would otherwise just be a network hiccup.
//   - 30+ days old, or no cache at all: always fetched fresh; this is the
//     outer bound past which stale pricing shouldn't be trusted as a
//     fallback.
// An explicit page reload (F5/Cmd+R, or a true cache-bypassing hard reload,
// Cmd+Shift+R/Ctrl+Shift+R) always forces a fresh fetch regardless of cache
// age — JS can't reliably tell a plain reload apart from a hard one across
// browsers, so both are treated as "the visitor explicitly asked for a
// fresh load," which is the safer failure mode for a live pricing tool.
const PRICING_CACHE_STORAGE_KEY = "cpq-pricing-cache";
const PRICING_CACHE_SOFT_TTL_MS = 48 * 60 * 60 * 1000;
const PRICING_CACHE_HARD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function readPricingCache() {
  try {
    const raw = localStorage.getItem(PRICING_CACHE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.fetchedAt !== "number" || !parsed.data) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writePricingCache(data) {
  try {
    localStorage.setItem(PRICING_CACHE_STORAGE_KEY, JSON.stringify({ data, fetchedAt: Date.now() }));
  } catch {
    // localStorage unavailable (private browsing, quota exceeded, etc.);
    // caching is best-effort, the app still works, it just fetches fresh
    // every time.
  }
}

function isExplicitPageReload() {
  try {
    const [nav] = performance.getEntriesByType("navigation");
    return nav?.type === "reload";
  } catch {
    return false;
  }
}

// `fetchFresh` is a thunk wrapping either fetchOptionsPackagesAndTaxes(idToken)
// or fetchOptionsPackagesAndTaxesWithDevPassword(password), so this cache
// layer works the same for both auth paths.
async function loadPricingData(fetchFresh) {
  const cached = readPricingCache();
  const ageMs = cached ? Date.now() - cached.fetchedAt : Infinity;
  const forceRefresh = isExplicitPageReload();

  if (cached && !forceRefresh && ageMs < PRICING_CACHE_SOFT_TTL_MS) {
    return cached.data;
  }

  if (cached && !forceRefresh && ageMs < PRICING_CACHE_HARD_TTL_MS) {
    if (!navigator.onLine) return cached.data;
    try {
      const fresh = await fetchFresh();
      writePricingCache(fresh);
      return fresh;
    } catch (e) {
      if (e.code === "unauthorized") throw e;
      return cached.data;
    }
  }

  const fresh = await fetchFresh();
  writePricingCache(fresh);
  return fresh;
}

// --- local dev auth bypass ---
// Skips the Google Sign-In click during local development, on this computer
// (localhost) and on a phone hitting this computer's LAN IP over wifi, since
// Google Identity Services is registered against specific origins (see
// HANDOFF.md) and a phone's LAN-IP origin isn't one of them. Two things must
// both be true before this ever activates, so it can't fire in production
// (served from a public IP/domain, never localhost or a private LAN address):
//   1. isLocalDevHost() — the page's own hostname is localhost or an RFC1918
//      private address.
//   2. dev-auth.local.js exists next to this file and defines
//      window.__CPQ_DEV_AUTH__.password. That file is gitignored, never
//      committed, so the password never ships in source anyone could view on
//      the live site; it only exists on a machine where a developer created
//      it. Copy dev-auth.local.js.example to create one.
// The static dev server has no auth of its own, so anyone else on the same
// wifi who found/guessed that file's URL while it's running could read the
// password too. Fine for a trusted home/office network during dev, not a
// substitute for real auth anywhere else.
function isLocalDevHost(hostname) {
  if (hostname === "localhost" || hostname === "127.0.0.1") return true;
  return /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(hostname);
}

const DEV_BYPASS_CANDIDATE = isLocalDevHost(window.location.hostname);

function loadDevAuthConfig() {
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = "./dev-auth.local.js";
    script.onload = () => resolve(window.__CPQ_DEV_AUTH__ || null);
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
}

async function fetchProductsSheetWithDevPassword(password) {
  const res = await fetch(`${PRICING_URL}?sheet=products&p=${encodeURIComponent(password)}`);
  checkPricingResponses([res], DEV_BYPASS_UNAUTHORIZED_MESSAGE);
  const data = await res.json();
  return data.products || [];
}

async function fetchOptionsPackagesAndTaxesWithDevPassword(password) {
  const responses = await Promise.all(
    ["options", "packages"].map((sheet) =>
      fetch(`${PRICING_URL}?sheet=${sheet}&p=${encodeURIComponent(password)}`),
    ),
  );
  checkPricingResponses(responses, DEV_BYPASS_UNAUTHORIZED_MESSAGE);

  const [options, packages] = await Promise.all(responses.map((res) => res.json()));
  const taxes = await fetchTaxRates(() =>
    fetch(`${PRICING_URL}?sheet=taxes&p=${encodeURIComponent(password)}`),
  );
  return {
    options: options.options || [],
    packages: packages.packages || [],
    taxes,
  };
}

async function fetchPricingDataWithDevPassword(password) {
  const [products, rest] = await Promise.all([
    fetchProductsSheetWithDevPassword(password),
    loadPricingData(() => fetchOptionsPackagesAndTaxesWithDevPassword(password)),
  ]);
  return { products, ...rest };
}

async function authenticateWithDevBypass(password) {
  state.authLoading = true;
  state.authError = null;
  render();
  try {
    const raw = await fetchPricingDataWithDevPassword(password);
    const data = normalizePricingData(raw);
    state.products = data.products;
    state.addons = data.addons;
    state.productCategories = data.productCategories;
    state.addonCategories = data.addonCategories;
    state.packages = data.packages;
    state.taxRates = data.taxRates;
    state.authed = true;
    state.devBypass = true;
    state.userEmail = "chris.becher@profitpad.com";
    state.userName = "Local dev";
    resolveInitialStep();
    console.warn("[dev-auth] Google sign-in bypassed via dev-auth.local.js; not a verified session.");
  } catch (e) {
    state.authError =
      e.code === "unauthorized"
        ? e.message + " Check the password in dev-auth.local.js."
        : "Could not reach the pricing service. Please try again.";
  } finally {
    state.authLoading = false;
    state.checkingGoogleSession = false;
    render();
  }
}

// --- HubSpot deal search (used by the deal/product selection step) ---
async function fetchDeals(search) {
  const url = `${HS_FETCH_URL}?fetch=deals&search=${encodeURIComponent(search)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error("Could not search deals. Please try again.");
  }
  // A no-match search returns a 200 with an empty body, not `{}`.
  const text = await res.text();
  if (!text) return [];
  const data = JSON.parse(text);
  return Array.isArray(data.hs_deals) ? data.hs_deals : [];
}

// Looks up the contacts on a chosen deal, used to prefill/edit the ship-to
// address (see loadContactsForDeal below). Same endpoint family as
// fetchDeals, so it's assumed to have the same "no match -> 200 with an
// empty body" behavior.
async function fetchContactsForDeal(dealId) {
  const url = `${HS_FETCH_URL}?fetch=contacts&search=${encodeURIComponent(dealId)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error("Could not load this deal's contacts.");
  }
  const text = await res.text();
  if (!text) return [];
  const data = JSON.parse(text);
  return Array.isArray(data.contacts) ? data.contacts : [];
}

// While online, returning visitors are recognized by Google's own sign-in
// session, not by anything this app stores: on boot, google.accounts.id
// .prompt() attempts a silent sign-in (One Tap / auto-select) using that
// existing Google session, and if it succeeds we get a fresh ID token
// without the user clicking anything. If there's no active Google session
// (or the user dismissed it before), the explicit "Sign in with Google"
// button renders instead. See renderGoogleButton() and initGoogleAuth()
// below.
//
// That path needs a live network round-trip to Google, though, so it can't
// work offline. The last successfully-verified token is kept in localStorage
// purely so an offline returning visitor isn't stranded on the sign-in
// screen (see boot section): if the app boots offline and finds one, it's
// replayed straight into authenticateWithGoogle() without going through
// Google at all. That fetch then fails over the network (there's no
// connection to n8n either) and the service worker's cache fallback serves
// the last successful pricing response instead, exactly like it always has
// for offline visits, see service-worker.js. Because that path never
// actually reaches n8n, it doesn't matter that the replayed token may have
// since expired; it's only there so the fetch has *a* header to send.
// Whenever the app is online, this stored value is never trusted on its
// own, initGoogleAuth() always re-verifies a fresh token with n8n instead.
const GOOGLE_SESSION_STORAGE_KEY = "cpq-google-last-session";

function loadStoredGoogleSession() {
  try {
    const raw = localStorage.getItem(GOOGLE_SESSION_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function storeGoogleSession(idToken, email, name) {
  try {
    localStorage.setItem(GOOGLE_SESSION_STORAGE_KEY, JSON.stringify({ idToken, email, name }));
  } catch {
    // localStorage unavailable (private browsing, quota, etc.); sign-in
    // still works, offline replay just won't be available on this device.
  }
}

function clearStoredGoogleSession() {
  try {
    localStorage.removeItem(GOOGLE_SESSION_STORAGE_KEY);
  } catch {
    // ignore
  }
}

// Decodes the ID token's payload for display only (name/email shown in the
// header). This is NOT verification, it's just reading a JWT's own claims
// client-side; the token's signature is verified server-side by n8n before
// any pricing data is served.
function decodeIdTokenPayload(idToken) {
  try {
    const payload = idToken.split(".")[1];
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

// state.userName is a single display string (Google's "name" claim, or
// "Local dev" on the dev bypass); the update-hs push wants first/last
// separately, so split on the first space rather than storing both shapes.
function splitFullName(fullName) {
  const trimmed = (fullName || "").trim();
  if (!trimmed) return { firstName: "", lastName: "" };
  const spaceIndex = trimmed.indexOf(" ");
  if (spaceIndex === -1) return { firstName: trimmed, lastName: "" };
  return {
    firstName: trimmed.slice(0, spaceIndex),
    lastName: trimmed.slice(spaceIndex + 1),
  };
}

// The endpoint returns raw sheet-shaped rows (snake_case, comma-joined SKU
// lists, split customer/manufacturer descriptions). Normalize once here so
// the rest of the app only deals with one shape.
function splitSkuList(str) {
  if (!str) return [];
  return String(str)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// The endpoint no longer sends product_categories/option_categories lists;
// derive them from the products/options themselves, in first-seen order.
function uniqueInOrder(values) {
  const seen = new Set();
  const result = [];
  for (const v of values) {
    if (v && !seen.has(v)) {
      seen.add(v);
      result.push(v);
    }
  }
  return result;
}

// Zip -> sales tax rate lookup (see sheet=taxes). Every field but Zip/tax_rate
// is thrown out, this app has no use for city/county/state/rate_type. The
// sheet carries one special "zip_unknown" row (its Zip value is literally
// that string, not a real zip) whose tax_rate is the fallback used whenever
// the ship-to zip is blank or isn't one of the sheet's recognized zips.
function normalizeTaxRates(rawTaxes) {
  const byZip = {};
  let unknownRate = 0;
  for (const row of rawTaxes || []) {
    const rate = Number(row.tax_rate) || 0;
    if (row.Zip === "zip_unknown") {
      unknownRate = rate;
      continue;
    }
    // Sheet zips come back as numbers (e.g. 90001), which would drop a
    // leading zero on zips outside CA's 9xxxx range; re-pad to 5 digits so
    // lookups against state.shipTo.zip (always a 5-digit string) still match.
    const zip = String(row.Zip ?? "").trim().padStart(5, "0");
    if (zip) byZip[zip] = rate;
  }
  return { byZip, unknownRate };
}

// Falls back to the sheet's "zip_unknown" rate whenever no zip is entered or
// the entered zip isn't a recognized key, same convention the sheet itself
// uses.
function getTaxRate(zip) {
  const trimmed = String(zip || "").trim();
  if (trimmed && Object.prototype.hasOwnProperty.call(state.taxRates.byZip, trimmed)) {
    return state.taxRates.byZip[trimmed];
  }
  return state.taxRates.unknownRate;
}

function normalizePricingData(raw) {
  const products = (raw.products || []).map((p) => ({
    sku: p.sku,
    baseSku: p.base_sku,
    name: p.name,
    description: p.manufacturer_description || "",
    // kept for the HubSpot push, which should eventually send the customer-facing copy instead
    customerDescription: p.customer_description || "",
    category: p.category,
    unit_price: Number(p.price) || 0,
    unit_cost: Number(p.cost) || 0,
    // the HubSpot product dropdown value for this product, kept for the HubSpot push
    hsProduct: p.hs_product || "",
  }));

  const addons = (raw.options || []).map((o) => ({
    sku: o.sku,
    name: o.name,
    // not shown in the add-on cards, kept only for the HubSpot push and search
    description: o.manufacturer_description || "",
    customerDescription: o.customer_description || "",
    category: o.category,
    unit_price: Number(o.price) || 0,
    unit_cost: Number(o.cost) || 0,
    // compatible_base_product_skus lists product base_sku values, not full product skus
    parentBaseSkus: splitSkuList(o.compatible_base_product_skus),
    incompatible_skus: splitSkuList(o.incompatible_option_skus),
    // comma-joined list of configuration choices, same convention as the
    // other multi-value sheet columns above; empty when the add-on has no
    // configuration choice at all
    configurations: splitSkuList(o.configuration),
    maxQuantity: Math.max(1, Math.floor(Number(o.max_quantity)) || 1),
  }));

  const packages = (raw.packages || []).map((pkg) => ({
    packageName: pkg.package_name,
    // the value HubSpot stores on a deal's `product` property; matched
    // against a deal's `product` field to find which package it maps to
    hsProductDropdownValue: pkg.hs_product_dropdown_property_value,
    productSku: pkg.product_sku,
    optionSkus: splitSkuList(pkg.option_skus),
  }));

  return {
    productCategories: uniqueInOrder(products.map((p) => p.category)),
    addonCategories: uniqueInOrder(addons.map((a) => a.category)),
    products,
    addons,
    packages,
    taxRates: normalizeTaxRates(raw.taxes),
  };
}

// --- state ---
const state = {
  authed: false,
  authLoading: false,
  authError: null,
  // true only while attempting a silent Google sign-in on boot, so the login
  // form never flashes for a returning visitor; see boot section below.
  checkingGoogleSession: false,
  // true when the local dev auth bypass (see "local dev auth bypass" above)
  // signed us in instead of Google; never true in production.
  devBypass: false,
  // set once authed, from the Google ID token's own claims; display only.
  userEmail: null,
  userName: null,
  userMenuOpen: false,

  products: [],
  addons: [],
  productCategories: [],
  addonCategories: [],
  packages: [],
  // zip -> tax rate lookup (see sheet=taxes), plus the sheet's zip_unknown
  // fallback rate; see normalizeTaxRates/getTaxRate.
  taxRates: { byZip: {}, unknownRate: 0 },

  // "deal-select" (choose an existing deal or skip to a price lookup) or
  // "cpq" (the main product/add-on/summary layout)
  step: "deal-select",
  selectedDeal: null,
  dealMatchFailed: false,
  dealSearchQuery: "",
  dealSearchResults: [],
  dealSearchLoading: false,
  dealSearchError: null,
  // holds the ?hs_deal_id= value when the auto-lookup found no match
  dealIdNotFound: null,

  // contacts on the selected deal, fetched once a deal is chosen (see
  // loadContactsForDeal), used to prefill/edit the ship-to address below.
  // Empty whenever no deal is selected, or the deal has no contacts.
  contacts: [],
  contactsLoading: false,
  contactsError: null,
  selectedContactId: null,
  // editable ship-to address, prefilled from the selected contact
  // (applyContactToShipTo) but editable independent of it; sent with the
  // HubSpot push so n8n can write it back onto that contact.
  shipTo: { firstName: "", lastName: "", street: "", city: "", state: "", zip: "" },

  productSku: null,
  addonSkus: new Set(),
  // sku -> selected configuration string (only relevant for add-ons with 2+
  // configurations); sku -> raw typed quantity string (only relevant for
  // add-ons with max_quantity > 1), see getAddonConfiguration/getAddonQuantity
  addonConfig: new Map(),
  addonQty: new Map(),
  openProductCat: null,
  openAddonCat: null,
  productSearchQuery: "",
  addonSearchQuery: "",
  discountType: "$",
  discountValue: "",
  // freeform comment sent in the main push-to-hubspot body, separate from
  // the send-quote-email note above
  quoteComment: "",
  // yyyy-mm-dd, defaults to 30 days out at page load (see
  // defaultQuoteExpirationDate), editable from there
  quoteExpirationDate: defaultQuoteExpirationDate(),
  quoteLink: null,
  dealLink: null,
  quoteLoading: false,
  // true once product/add-ons/discount have changed since the last
  // successful push, so "Push to HubSpot" re-enables itself; see
  // pushHubspotDisabled in summarySectionHtml
  pricingDirty: false,
  marginHeld: false,
  isOnline: navigator.onLine,

  quoteEmailModalOpen: false,
  // committed recipient chips, plus whatever's still being typed and hasn't
  // been turned into a chip yet (see setQuoteEmailDraft)
  quoteEmailChips: [],
  quoteEmailDraft: "",
  quoteEmailSubject: "",
  quoteEmailNote: "",
  quoteEmailSending: false,
  quoteEmailError: null,
  quoteEmailSent: false,
};

function getSelectedProduct() {
  return state.products.find((p) => p.sku === state.productSku) || null;
}

function getProductScopedAddons(selectedProduct) {
  if (!selectedProduct) return [];
  return state.addons.filter(
    (a) =>
      Array.isArray(a.parentBaseSkus) && a.parentBaseSkus.includes(selectedProduct.baseSku),
  );
}

function getIncompatibleSkuSet() {
  const set = new Set();
  for (const a of state.addons) {
    if (state.addonSkus.has(a.sku) && Array.isArray(a.incompatible_skus)) {
      for (const inc of a.incompatible_skus) set.add(inc);
    }
  }
  return set;
}

function getSelectedAddons() {
  return state.addons.filter((a) => state.addonSkus.has(a.sku));
}

// Falls back to the first available configuration when none has been
// explicitly chosen yet, so a push to HubSpot always carries a real value
// instead of blank, same fallback pattern used for packages/defaults elsewhere.
function getAddonConfiguration(addon) {
  if (!addon.configurations.length) return null;
  return state.addonConfig.get(addon.sku) || addon.configurations[0];
}

// The stored value is the raw typed string (see setAddonQuantity), not yet
// clamped to [1, maxQuantity]; this is what pricing/the HubSpot push use.
function getAddonQuantity(addon) {
  const n = Math.round(Number(state.addonQty.get(addon.sku)));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, addon.maxQuantity || 1);
}

// What the quantity <input> itself displays: the raw typed string, so typing
// isn't fought by a clamped value re-rendering over it mid-keystroke (same
// reasoning as state.discountValue).
function getAddonQuantityInputValue(addon) {
  return state.addonQty.get(addon.sku) ?? "1";
}

// Collapses case and punctuation differences (spaces, hyphens, etc.) so a
// search for "cre 2110" matches a SKU like "cre-2110" and vice versa.
function normalizeForSearch(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Searches name, sku, and both description fields (manufacturer- and
// customer-facing), even where a field isn't otherwise shown in the UI.
// `words` is the space-split, normalized query (see normalizeForSearch); an
// item matches only if EVERY word matches SOME field (words can match
// different fields), so "2110 outdoor" narrows to items matching both.
function matchesSearch(item, words) {
  if (!words.length) return true;
  const haystacks = [item.name, item.sku, item.description, item.customerDescription]
    .filter(Boolean)
    .map(normalizeForSearch);
  return words.every((word) => haystacks.some((h) => h.includes(word)));
}

// keep add-ons consistent with the selected product
function syncAddonsToProduct() {
  const selectedProduct = getSelectedProduct();
  if (!selectedProduct) {
    if (state.addonSkus.size) state.addonSkus = new Set();
    return;
  }
  const allowed = new Set(getProductScopedAddons(selectedProduct).map((a) => a.sku));
  const next = new Set([...state.addonSkus].filter((sku) => allowed.has(sku)));
  if (next.size !== state.addonSkus.size) state.addonSkus = next;
}

// --- actions ---
// `isStoredSessionReplay` is true only when this call came from replaying
// the localStorage-cached token on boot (see GOOGLE_SESSION_STORAGE_KEY
// above), not from an explicit Google button click. A 401 on that path is
// almost always just the cached token's normal ~1hr expiry, not a genuinely
// unauthorized account, since an unauthorized account would never have been
// able to store a session in the first place, so instead of showing an
// "isn't authorized" error and waiting on a click, just reload straight into
// a clean sign-in screen, the same effect as the manual refresh a visitor
// would otherwise reach for. clearStoredGoogleSession() below already runs
// before the reload, so the next boot has no stored session to replay and
// won't loop, it lands on the plain "Sign in with Google" button. An
// explicit button click that comes back 401 is a fresh account pick, so
// that one really can be a genuinely unauthorized account, keep showing
// that message instead of reloading.
async function authenticateWithGoogle(idToken, isStoredSessionReplay = false) {
  state.authLoading = true;
  state.authError = null;
  render();
  try {
    const raw = await fetchPricingData(idToken);
    const data = normalizePricingData(raw);
    state.products = data.products;
    state.addons = data.addons;
    state.productCategories = data.productCategories;
    state.addonCategories = data.addonCategories;
    state.packages = data.packages;
    state.taxRates = data.taxRates;
    state.authed = true;
    const claims = decodeIdTokenPayload(idToken);
    state.userEmail = claims?.email || null;
    state.userName = claims?.name || null;
    storeGoogleSession(idToken, state.userEmail, state.userName);
    resolveInitialStep();
  } catch (e) {
    if (e.code === "unauthorized") {
      // Not this user's fault the account isn't allowlisted; don't leave
      // Google auto-selecting the same rejected account on the next visit,
      // and don't let a rejected account keep unlocking offline replay either.
      window.google?.accounts?.id?.disableAutoSelect();
      clearStoredGoogleSession();
    }
    if (e.code === "unauthorized" && isStoredSessionReplay) {
      window.location.reload();
      return;
    }
    state.authError =
      e.code === "unauthorized" || e.code === "unavailable"
        ? e.message
        : "Could not reach the pricing service. Please try again.";
  } finally {
    state.authLoading = false;
    state.checkingGoogleSession = false;
    render();
  }
}

// Clears the app's own session and tells Google not to silently sign this
// browser back in on the next load; the explicit button reappears instead.
function signOut() {
  if (state.devBypass) {
    // Google was never initialized on this boot path (see DEV_BYPASS_CANDIDATE
    // below), so there's no button state to reset here; reloading just
    // re-runs the same dev bypass check from scratch.
    window.location.reload();
    return;
  }
  window.google?.accounts?.id?.disableAutoSelect();
  clearStoredGoogleSession();
  state.authed = false;
  state.userEmail = null;
  state.userName = null;
  state.userMenuOpen = false;
  state.products = [];
  state.addons = [];
  state.productCategories = [];
  state.addonCategories = [];
  state.packages = [];
  state.taxRates = { byZip: {}, unknownRate: 0 };
  state.step = "deal-select";
  state.selectedDeal = null;
  state.dealIdNotFound = null;
  state.contacts = [];
  state.contactsError = null;
  state.selectedContactId = null;
  applyContactToShipTo(null);
  // maybeAutoLookupDeal() only ever runs its ?hs_deal_id= lookup once per
  // page load (dealAutoLookupAttempted guards against re-fetching on every
  // render); resetting it here lets a fresh sign-in resolve the deal again
  // instead of leaving the "Looking up deal…" spinner stuck forever with
  // nothing left to un-stick it. dealAutoLookupPromise itself is left alone
  // and reused as-is, its result doesn't change just because of a sign-out.
  dealAutoLookupAttempted = false;
  render();
}

// Finds the package whose HubSpot dropdown value matches a deal's `product`
// field, then preselects that package's product & option SKUs.
function findPackageForDeal(deal) {
  if (!deal || !deal.product) return null;
  return (
    state.packages.find((pkg) => pkg.hsProductDropdownValue === deal.product) || null
  );
}

// Sets state.addonSkus to a package's option_skus (intersected with the
// add-ons actually loaded), shared by applyPackageSelection (deal auto-match)
// and selectProduct (product-sku auto-match) below.
function applyPackageAddons(pkg) {
  if (!pkg) return;
  const allowedOptionSkus = new Set(pkg.optionSkus);
  state.addonSkus = new Set(state.addons.filter((a) => allowedOptionSkus.has(a.sku)).map((a) => a.sku));
}

function applyPackageSelection(pkg) {
  if (!pkg) return;
  const product = state.products.find((p) => p.sku === pkg.productSku);
  if (product) {
    state.productSku = product.sku;
    state.openProductCat = product.category;
  }
  applyPackageAddons(pkg);
  syncAddonsToProduct();
}

// Finds the package whose product_sku matches a selected product, so
// selectProduct() below can auto-select that package's add-ons any time a
// product is chosen directly (not just when preselected via a matched deal).
function findPackageForProduct(productSku) {
  return state.packages.find((pkg) => pkg.productSku === productSku) || null;
}

// Prefills the editable ship-to address from a HubSpot contact; called with
// `null` when no contact is selected (no deal, or the deal has no
// contacts), which just blanks the address out.
function applyContactToShipTo(contact) {
  state.shipTo = {
    firstName: contact?.firstname || "",
    lastName: contact?.lastname || "",
    street: contact?.address_street || "",
    city: contact?.address_city || "",
    state: contact?.address_state || "",
    zip: contact?.address_zip || "",
  };
}

// Fetches the contacts on a deal once it's chosen, so the ship-to address
// (see shipToSectionHtml) can be prefilled from one of them. Fired off from
// chooseDeal, not awaited there, since it shouldn't block getting to the CPQ
// layout.
async function loadContactsForDeal(dealId) {
  state.contactsLoading = true;
  state.contactsError = null;
  render();
  try {
    const contacts = await fetchContactsForDeal(dealId);
    state.contacts = contacts;
    state.selectedContactId = contacts.length ? contacts[0].hs_contact_id : null;
    applyContactToShipTo(contacts[0] || null);
  } catch (e) {
    state.contacts = [];
    state.selectedContactId = null;
    state.contactsError = e.message || "Could not load this deal's contacts.";
    applyContactToShipTo(null);
  } finally {
    state.contactsLoading = false;
    render();
  }
}

function selectContact(contactId) {
  state.selectedContactId = contactId;
  applyContactToShipTo(state.contacts.find((c) => c.hs_contact_id === contactId) || null);
  state.pricingDirty = true;
  render();
}

function chooseDeal(deal) {
  state.selectedDeal = deal;
  const pkg = findPackageForDeal(deal);
  applyPackageSelection(pkg);
  state.dealMatchFailed = !pkg;
  state.step = "cpq";
  setDealIdInUrl(deal.hs_object_id);
  loadContactsForDeal(deal.hs_object_id);
  render();
}

function skipToPriceLookup() {
  state.selectedDeal = null;
  state.dealMatchFailed = false;
  state.step = "cpq";
  state.contacts = [];
  state.contactsLoading = false;
  state.contactsError = null;
  state.selectedContactId = null;
  applyContactToShipTo(null);
  render();
}

let dealSearchDebounceHandle = null;

function setDealSearchQuery(value) {
  state.dealSearchQuery = value;
  state.dealSearchError = null;
  if (dealSearchDebounceHandle) clearTimeout(dealSearchDebounceHandle);

  const trimmed = value.trim();
  if (trimmed.length < 2) {
    state.dealSearchResults = [];
    state.dealSearchLoading = false;
    render();
    return;
  }

  state.dealSearchLoading = true;
  render();
  dealSearchDebounceHandle = setTimeout(() => runDealSearch(trimmed), SEARCH_DEBOUNCE_MS);
}

async function runDealSearch(term) {
  try {
    const results = await fetchDeals(term);
    if (state.dealSearchQuery.trim() !== term) return; // stale, a newer search superseded it
    state.dealSearchResults = results;
    state.dealSearchError = null;
  } catch (e) {
    if (state.dealSearchQuery.trim() !== term) return;
    state.dealSearchError = e.message || "Could not search deals. Please try again.";
    state.dealSearchResults = [];
  } finally {
    if (state.dealSearchQuery.trim() === term) state.dealSearchLoading = false;
    render();
  }
}

// Reads ?hs_deal_id= once on boot. The deal doesn't need a password, so the
// lookup itself is kicked off immediately here, in parallel with (and
// usually well before) the password-gated pricing fetch, rather than
// waiting for pricing to finish first. maybeAutoLookupDeal(), called once
// pricing data (and packages) have loaded, just awaits this same in-flight
// promise instead of starting a fresh request. Skipped entirely while
// offline, there's no point attempting a lookup that can't succeed.
const hsDealIdParam = new URLSearchParams(window.location.search).get("hs_deal_id");
const dealAutoLookupPromise = hsDealIdParam && state.isOnline ? fetchDeals(hsDealIdParam) : null;
let dealAutoLookupAttempted = false;
// Set once the user backs out via "Change Deal" and the ?hs_deal_id= is
// stripped from the URL, so the deal-select step doesn't fall back into the
// "Looking up deal…" spinner for a param that no longer applies.
let hsDealIdCleared = false;

// Drops ?hs_deal_id= from the visible URL without navigating, so a reload
// (or the user going back to the picker) doesn't re-trigger the same
// auto-lookup or show a stale "Looking up deal…" state.
function clearDealIdFromUrl() {
  if (!hsDealIdParam) return;
  hsDealIdCleared = true;
  const url = new URL(window.location.href);
  url.searchParams.delete("hs_deal_id");
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
}

// Reflects a chosen deal into ?hs_deal_id= (without navigating) so reloading
// or bookmarking the page returns straight to that deal via the auto-lookup.
function setDealIdInUrl(dealId) {
  if (!dealId) return;
  const url = new URL(window.location.href);
  if (url.searchParams.get("hs_deal_id") === String(dealId)) return;
  url.searchParams.set("hs_deal_id", dealId);
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
}

async function maybeAutoLookupDeal() {
  if (!hsDealIdParam || dealAutoLookupAttempted) return;
  dealAutoLookupAttempted = true;
  if (!state.isOnline) {
    skipToPriceLookup();
    return;
  }
  try {
    const results = await dealAutoLookupPromise;
    const match = results.find((d) => String(d.hs_object_id) === String(hsDealIdParam));
    if (match) {
      chooseDeal(match);
    } else {
      state.dealIdNotFound = hsDealIdParam;
      render();
    }
  } catch (e) {
    state.dealIdNotFound = hsDealIdParam;
    render();
  }
}

// Called once pricing data has loaded, decides what the deal-select step
// should do right out of the gate. A ?hs_deal_id= takes priority; otherwise,
// offline visitors skip straight to a price lookup too, there's no working
// search without a connection, so there's nothing useful to show them there.
function resolveInitialStep() {
  if (hsDealIdParam) {
    maybeAutoLookupDeal();
  } else if (!state.isOnline) {
    skipToPriceLookup();
  }
}

function selectProduct(sku) {
  // Only auto-apply a matched package's add-ons when the product actually
  // changes, so re-clicking the already-selected product card doesn't wipe
  // out add-ons the rep has since customized away from the package default.
  const productChanged = state.productSku !== sku;
  state.productSku = sku;
  if (productChanged) applyPackageAddons(findPackageForProduct(sku));
  syncAddonsToProduct();
  state.addonSearchQuery = "";
  state.pricingDirty = true;
  const product = getSelectedProduct();
  if (product) state.openProductCat = product.category;
  render();
}

function toggleAddon(sku) {
  const next = new Set(state.addonSkus);
  if (next.has(sku)) next.delete(sku);
  else next.add(sku);
  state.addonSkus = next;
  state.pricingDirty = true;
  render();
}

function clearAddons() {
  state.addonSkus = new Set();
  state.pricingDirty = true;
  render();
}

function setAddonConfiguration(sku, value) {
  state.addonConfig.set(sku, value);
  state.pricingDirty = true;
  renderPicker();
  renderSummary();
}

function setAddonQuantity(sku, value) {
  // Keep only digits, same "sanitize but don't clamp" approach as
  // setDiscountValue; clamping to [1, maxQuantity] happens at read time
  // (getAddonQuantity), not here, so the field isn't fought while typing.
  state.addonQty.set(sku, String(value).replace(/[^\d]/g, ""));
  state.pricingDirty = true;
  renderPicker();
  renderSummary();
}

function incAddonQuantity(sku) {
  const addon = state.addons.find((a) => a.sku === sku);
  if (!addon) return;
  setAddonQuantity(sku, Math.min(getAddonQuantity(addon) + 1, addon.maxQuantity || 1));
}

function decAddonQuantity(sku) {
  const addon = state.addons.find((a) => a.sku === sku);
  if (!addon) return;
  setAddonQuantity(sku, Math.max(getAddonQuantity(addon) - 1, 1));
}

function toggleProductCat(cat) {
  state.openProductCat = state.openProductCat === cat ? null : cat;
  render();
}

function toggleAddonCat(cat) {
  state.openAddonCat = state.openAddonCat === cat ? null : cat;
  render();
}

// Filtering the picker is the one thing typing in these two fields actually
// needs to show live, and even that doesn't need to happen on every
// keystroke — debounced (SEARCH_DEBOUNCE_MS) after typing stops, same
// debounce-a-cheap-render idea as runDealSearch's network debounce above,
// just without a network call behind it.
let productSearchDebounceHandle = null;

function setProductSearchQuery(value) {
  state.productSearchQuery = value;
  if (productSearchDebounceHandle) clearTimeout(productSearchDebounceHandle);
  productSearchDebounceHandle = setTimeout(renderPicker, SEARCH_DEBOUNCE_MS);
}

let addonSearchDebounceHandle = null;

function setAddonSearchQuery(value) {
  state.addonSearchQuery = value;
  if (addonSearchDebounceHandle) clearTimeout(addonSearchDebounceHandle);
  addonSearchDebounceHandle = setTimeout(renderPicker, SEARCH_DEBOUNCE_MS);
}

function setDiscountType(type) {
  state.discountType = type;
  state.pricingDirty = true;
  render();
}

function setDiscountValue(value) {
  // Keep digits and a single decimal point; strip anything else the user
  // types or pastes (letters, extra dots, minus signs, etc).
  const sanitized = value
    .replace(/[^\d.]/g, "")
    .replace(/(\..*)\./g, "$1");
  state.discountValue = sanitized;
  state.pricingDirty = true;
  renderSummary();
}

// Nothing else on screen reflects the comment live, so there's nothing to
// re-render on every keystroke — state.quoteComment is only read at push
// time. The textarea's own auto-grow still needs to run per keystroke, but
// that's a direct height tweak on the existing node, not a rebuild (see
// autoGrowCommentTextarea). A single reconciling renderSummary() on blur
// (below, in the focusout listener) catches up anything else that depends on
// state.pricingDirty, e.g. the "already pushed" push-button state.
function setQuoteComment(value) {
  state.quoteComment = value;
  state.pricingDirty = true;
  autoGrowCommentTextarea();
}

function setQuoteExpirationDate(value) {
  state.quoteExpirationDate = value;
  state.pricingDirty = true;
  render();
}

function setShipToField(field, value) {
  // ZIP is digits-only and capped at 5, so typing a 6th digit (or any
  // letter) is simply rejected rather than accepted and flagged after the
  // fact; isZipValid() below still covers the 1-4 digit "incomplete" case,
  // which can't be blocked at typing time without stopping the user
  // mid-entry.
  // Same reasoning as setQuoteComment above: nothing else on screen reflects
  // these fields live (not even the zip-format error message, which is fine
  // to only settle on blur rather than flicker while a valid zip is still
  // being typed one digit at a time), so no re-render here — see the
  // reconciling renderSummary() on blur in the focusout listener below.
  state.shipTo[field] = field === "zip" ? value.replace(/[^\d]/g, "").slice(0, 5) : value;
  state.pricingDirty = true;
}

function isZipValid() {
  return state.shipTo.zip === "" || /^\d{5}$/.test(state.shipTo.zip);
}

function toggleMargin() {
  state.marginHeld = !state.marginHeld;
  render();
  if (state.marginHeld) {
    requestAnimationFrame(() => {
      window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
    });
  }
}

function roundToCent(n) {
  return Math.round(n * 100) / 100;
}

async function handlePushToHubspot() {
  const selectedProduct = getSelectedProduct();
  if (!selectedProduct) return;
  const selectedAddons = getSelectedAddons();

  const taxRate = getTaxRate(state.shipTo.zip);
  const productCost = selectedProduct.unit_cost || 0;
  const product = {
    name: selectedProduct.name,
    description: selectedProduct.customerDescription,
    sku: selectedProduct.sku,
    hs_product: selectedProduct.hsProduct,
    price: selectedProduct.unit_price,
    cost: productCost,
    tax_amount: roundToCent(productCost * taxRate),
  };

  const options = selectedAddons.map((a) => {
    const quantity = getAddonQuantity(a);
    const unitPrice = a.unit_price || 0;
    const totalPrice = unitPrice * quantity;
    const cost = (a.unit_cost || 0) * quantity;
    return {
      name: a.name,
      description: a.customerDescription,
      sku: a.sku,
      quantity,
      configuration: getAddonConfiguration(a) || "",
      // update-hs applies quantity itself on the HubSpot side, so this is the
      // per-unit price, not price * quantity (unlike cost/tax_amount below)
      price: unitPrice,
      cost,
      // combined-cost rate (like the product) plus the extra rate-of-price quirk on add-ons
      tax_amount: roundToCent(cost * taxRate + totalPrice * taxRate),
    };
  });

  const subtotal =
    product.price + selectedAddons.reduce((s, a) => s + (a.unit_price || 0) * getAddonQuantity(a), 0);
  const cost = product.cost + options.reduce((s, o) => s + o.cost, 0);
  const taxAmount = roundToCent(product.tax_amount + options.reduce((s, o) => s + o.tax_amount, 0));
  const rawDiscount = Number(state.discountValue || 0);
  const discountAmount =
    state.discountType === "$"
      ? Math.min(rawDiscount, subtotal)
      : subtotal * (Math.min(rawDiscount, 100) / 100);
  const discountPercentage = subtotal > 0 ? (discountAmount / subtotal) * 100 : 0;
  const totalBeforeTax = subtotal - discountAmount;
  const total = totalBeforeTax + taxAmount;
  const margin = totalBeforeTax !== 0 ? ((subtotal - cost - discountAmount) / totalBeforeTax) * 100 : 0;

  state.quoteLoading = true;
  state.quoteLink = null;
  state.dealLink = null;
  state.quoteEmailChips = [];
  state.quoteEmailDraft = "";
  render();
  try {
    const res = await fetch("https://n8n.californiamobility.com/webhook/camo-cpq/update-hs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hs_deal_id: state.selectedDeal ? state.selectedDeal.hs_object_id : null,
        deal_name: state.selectedDeal ? state.selectedDeal.dealname : null,
        deal_product: state.selectedDeal ? state.selectedDeal.product : null,
        rep_first_name: splitFullName(state.userName).firstName || null,
        rep_last_name: splitFullName(state.userName).lastName || null,
        rep_email: state.userEmail || null,
        product,
        options,
        subtotal,
        cost,
        margin,
        discount_amount: discountAmount,
        discount_percentage: discountPercentage,
        tax_amount: taxAmount,
        tax_percentage: Number((taxRate * 100).toFixed(2)),
        tax_location: state.shipTo.zip.trim(),
        currency: "USD",
        total,
        comment: state.quoteComment.trim(),
        quote_expiration_date: state.quoteExpirationDate,
        ship_to: {
          hs_contact_id: state.selectedContactId,
          first_name: state.shipTo.firstName.trim(),
          last_name: state.shipTo.lastName.trim(),
          street: state.shipTo.street.trim(),
          city: state.shipTo.city.trim(),
          state: state.shipTo.state.trim(),
          zip: state.shipTo.zip.trim(),
        },
      }),
    });
    const data = await res.json();
    if (data.quote_link) state.quoteLink = data.quote_link;
    if (data.deal_link) state.dealLink = data.deal_link;
    if (Array.isArray(data.contacts)) {
      state.quoteEmailChips = uniqueInOrder(data.contacts.map((c) => c.email).filter(Boolean));
    }
    state.pricingDirty = false;
  } catch (e) {
    console.error("HubSpot push failed:", e);
  } finally {
    state.quoteLoading = false;
    render();
  }
}

// --- send quote email ---
const SEND_QUOTE_EMAIL_URL = "https://n8n.californiamobility.com/webhook/camo-cpq/send-quote-email";
const QUOTE_EMAIL_FROM = "chris.becher@profitpad.com";

function buildQuoteEmailBodyHtml() {
  const note = state.quoteEmailNote.trim();
  const quoteHref = state.quoteLink
    ? `href="${escapeHtml(state.quoteLink)}" target="_blank"`
    : "";
  return `<div id="email_body"><p>Click to <a ${quoteHref}>view your quote</a>!<br>${
    note ? `<p>${escapeHtml(note)}</p>` : ""
  }</div>`;
}

function buildQuoteEmailSubject() {
  const product = getSelectedProduct();
  return `Quote for ${product ? product.name : ""}`;
}

// Splits on comma or whitespace as the visitor types, turning every
// complete token into a chip; whatever's left (no trailing delimiter yet)
// stays as the in-progress draft.
function setQuoteEmailDraft(value) {
  const parts = value.split(/[,\s]+/);
  if (parts.length > 1) {
    state.quoteEmailChips.push(...parts.slice(0, -1).map((s) => s.trim()).filter(Boolean));
    state.quoteEmailDraft = parts[parts.length - 1];
  } else {
    state.quoteEmailDraft = value;
  }
  state.quoteEmailSent = false;
  renderQuoteEmailModal();
}

function commitQuoteEmailDraft() {
  const email = state.quoteEmailDraft.trim();
  if (email) state.quoteEmailChips.push(email);
  state.quoteEmailDraft = "";
  state.quoteEmailSent = false;
  renderQuoteEmailModal();
}

function removeQuoteEmailChip(index) {
  state.quoteEmailChips.splice(index, 1);
  state.quoteEmailSent = false;
  renderQuoteEmailModal();
}

// Backspacing with an empty draft "un-tiles" the last chip back into plain,
// editable text instead of just deleting it outright; it re-tiles on blur
// (see the focusout listener below) or as soon as a delimiter is typed again.
function untileLastQuoteEmailChip() {
  if (state.quoteEmailChips.length === 0) return;
  state.quoteEmailDraft = state.quoteEmailChips.pop();
  state.quoteEmailSent = false;
  renderQuoteEmailModal();
  const draftEl = document.getElementById("quote-email-draft");
  if (draftEl) {
    const len = draftEl.value.length;
    draftEl.setSelectionRange(len, len);
  }
}

function openSendQuoteModal() {
  state.quoteEmailModalOpen = true;
  state.quoteEmailError = null;
  state.quoteEmailSent = false;
  if (!state.quoteEmailSubject) {
    state.quoteEmailSubject = buildQuoteEmailSubject();
  }
  renderQuoteEmailModal();
}

function closeSendQuoteModal() {
  state.quoteEmailModalOpen = false;
  renderQuoteEmailModal();
}

function setQuoteEmailSubject(value) {
  state.quoteEmailSubject = value;
  state.quoteEmailSent = false;
  renderQuoteEmailModal();
}

function setQuoteEmailNote(value) {
  state.quoteEmailNote = value;
  state.quoteEmailSent = false;
  renderQuoteEmailModal();
}

async function handleSendQuoteEmail() {
  // Whatever's still sitting in the draft (typed but not yet delimited into
  // a chip) counts as a recipient too, so hitting Send works without having
  // to type a trailing comma/space first.
  const trailingDraft = state.quoteEmailDraft.trim();
  const allEmails = trailingDraft ? [...state.quoteEmailChips, trailingDraft] : state.quoteEmailChips;
  const toEmails = allEmails.join(",");
  if (!toEmails) return;

  state.quoteEmailSending = true;
  state.quoteEmailError = null;
  renderQuoteEmailModal();
  try {
    const res = await fetch(SEND_QUOTE_EMAIL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hs_deal_id: state.selectedDeal ? state.selectedDeal.hs_object_id : null,
        quote_link: state.quoteLink,
        to_emails: toEmails,
        subject: state.quoteEmailSubject.trim(),
        note_from_rep: state.quoteEmailNote.trim(),
        body_html: buildQuoteEmailBodyHtml(),
      }),
    });
    if (!res.ok) {
      throw new Error("Could not send the quote email. Please try again.");
    }
    state.quoteEmailSent = true;
    state.quoteEmailChips = allEmails;
    state.quoteEmailDraft = "";
  } catch (e) {
    state.quoteEmailError = e.message || "Could not send the quote email. Please try again.";
  } finally {
    state.quoteEmailSending = false;
    renderQuoteEmailModal();
  }
}

// --- templates ---
function loginSectionHtml() {
  // The actual button is rendered imperatively into #google-signin-button by
  // renderGoogleButton() (called from render(), see below), since Google
  // Identity Services attaches its own iframe/markup to a live DOM node
  // rather than accepting an HTML string. This just reserves the container.
  return `
    <div class="login-card">
      <h2 class="login-card__title">Sign in required</h2>
      <p class="login-card__subtitle">Sign in with your Google account to load Camo CPQ.</p>
      <div class="stack-3">
        ${
          state.authLoading || state.checkingGoogleSession
            ? `<div class="panel__loading"><span class="spinner" aria-hidden="true"></span>Signing you in…</div>`
            : `<div id="google-signin-button"></div>`
        }
        ${state.authError ? `<p class="form-error">${state.authError}</p>` : ""}
      </div>
    </div>
  `;
}

function dealResultCardHtml(deal) {
  const metaParts = [`Record ID: ${escapeHtml(deal.hs_object_id)}`];
  if (deal.product) metaParts.push(escapeHtml(deal.product));
  return `
    <button type="button" data-action="choose-deal" data-deal-id="${escapeHtml(deal.hs_object_id)}"
      class="option-card">
      <div class="option-card__row">
        <div class="option-card__body">
          <div class="option-card__title">${escapeHtml(deal.dealname || "Untitled deal")}</div>
          <div class="option-card__description">${metaParts.join(" · ")}</div>
        </div>
      </div>
    </button>
  `;
}

function dealSelectSectionHtml() {
  // A ?hs_deal_id= is still being resolved for as long as it hasn't come
  // back a definite miss, this spans both the password-gated pricing fetch
  // and the deal fetch itself (which starts before pricing even finishes,
  // see dealAutoLookupPromise above), so show a loading state the whole
  // time instead of a picker that looks idle while work happens silently.
  if (hsDealIdParam && !hsDealIdCleared && !state.dealIdNotFound) {
    return `
      <div class="login-card login-card--wide">
        <h2 class="login-card__title">Start a quote</h2>
        <div class="panel__loading"><span class="spinner" aria-hidden="true"></span>Looking up deal ${escapeHtml(hsDealIdParam)}…</div>
      </div>
    `;
  }

  const trimmed = state.dealSearchQuery.trim();

  let resultsHtml = "";
  if (state.dealSearchLoading) {
    resultsHtml = `<div class="panel__loading"><span class="spinner" aria-hidden="true"></span>Searching…</div>`;
  } else if (state.dealSearchError) {
    resultsHtml = `<p class="form-error">${escapeHtml(state.dealSearchError)}</p>`;
  } else if (trimmed.length >= 2 && state.dealSearchResults.length === 0) {
    resultsHtml = `<p class="muted-text">No deals found for "${escapeHtml(trimmed)}".</p>`;
  } else if (state.dealSearchResults.length > 0) {
    resultsHtml = `<div class="stack-2 deal-results">${state.dealSearchResults.map(dealResultCardHtml).join("")}</div>`;
  }

  const autoLookupNotice = state.dealIdNotFound
    ? `<p class="form-error">Deal "${escapeHtml(state.dealIdNotFound)}" wasn't found. Search for it below, or continue with a price lookup.</p>`
    : "";

  return `
    <div class="login-card login-card--wide">
      <h2 class="login-card__title">Start a quote</h2>
      <p class="login-card__subtitle">Search for an existing HubSpot deal to auto-fill its product, or skip straight to a price lookup.</p>

      ${autoLookupNotice}

      <div class="stack-3">
        <div>
          <input type="text" id="deal-search-input" data-action="set-deal-search" ${FIELD_NO_AUTOFILL_ATTRS}
            class="input input--block" placeholder="Search by deal name or record ID…"
            value="${escapeHtml(state.dealSearchQuery)}" />
          ${resultsHtml}
        </div>

        <div class="deal-select-divider">or</div>

        <button type="button" data-action="skip-deal-select" class="btn btn--muted btn--block">
          Skip — just do a price lookup
        </button>
      </div>
    </div>
  `;
}

function optionCardHtml({ sku, title, description, price, selected, disabled, action, extraAttrs = "" }) {
  return `
    <button type="button" data-action="${action}" data-sku="${escapeHtml(sku)}" ${extraAttrs}
      ${disabled ? "disabled" : ""}
      class="${classNames(
        "option-card",
        selected && "option-card--selected",
        disabled && "option-card--disabled",
      )}">
      <div class="option-card__row">
        <div class="${classNames(
          "option-card__indicator option-card__indicator--radio",
          selected && "option-card__indicator--checked",
        )}"></div>
        <div class="option-card__body">
          <div class="option-card__title">${escapeHtml(title)}</div>
          ${description ? `<div class="option-card__description">${escapeHtml(description)}</div>` : ""}
        </div>
        <div class="option-card__price-wrap">
          <div class="option-card__price">${currencyWhole.format(Number(price || 0))}</div>
        </div>
      </div>
    </button>
  `;
}

function checkboxCardHtml({ sku, title, description, price, checked, disabled, extrasHtml }) {
  const check = `
    <svg class="option-card__check-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3">
      <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
    </svg>`;
  const button = `
    <button type="button" data-action="toggle-addon" data-sku="${escapeHtml(sku)}"
      ${disabled ? "disabled" : ""}
      class="${classNames(
        "option-card",
        checked && "option-card--selected",
        disabled && "option-card--disabled",
      )}">
      <div class="option-card__row">
        <div class="${classNames(
          "option-card__indicator option-card__indicator--checkbox",
          checked ? "option-card__indicator--checked" : "",
        )}">
          ${checked ? check : ""}
        </div>
        <div class="option-card__body">
          <div class="option-card__title">${escapeHtml(title)}</div>
          ${description ? `<div class="option-card__description">${escapeHtml(description)}</div>` : ""}
        </div>
        <div class="option-card__price-wrap">
          <div class="option-card__price">${currencyWhole.format(Number(price || 0))}</div>
        </div>
      </div>
    </button>
  `;
  // extrasHtml (configuration select / quantity stepper) is a sibling of the
  // button, not nested inside it — a <select>/<input> nested inside a
  // <button> is invalid HTML and the outer button would swallow their clicks.
  if (!extrasHtml) return button;
  return `<div class="option-card-group">${button}${extrasHtml}</div>`;
}

// Configuration select + quantity stepper shown under a checked add-on card,
// only when that add-on actually has something to choose (2+ configurations
// and/or a max_quantity > 1); otherwise the card renders with no extras at all.
function addonExtrasHtml(addon) {
  const configHtml =
    addon.configurations.length > 1
      ? `
    <div class="addon-extra__row">
      <span class="addon-extra__label">Configuration</span>
      <select class="input addon-extra__select" data-action="set-addon-config" data-sku="${escapeHtml(addon.sku)}" ${FIELD_NO_AUTOFILL_ATTRS}>
        ${addon.configurations
          .map(
            (c) =>
              `<option value="${escapeHtml(c)}" ${getAddonConfiguration(addon) === c ? "selected" : ""}>${escapeHtml(c)}</option>`,
          )
          .join("")}
      </select>
    </div>`
      : "";

  const quantity = getAddonQuantity(addon);
  const qtyHtml =
    addon.maxQuantity > 1
      ? `
    <div class="addon-extra__row">
      <span class="addon-extra__label">Quantity</span>
      <div class="qty-stepper">
        <button type="button" data-action="dec-addon-qty" data-sku="${escapeHtml(addon.sku)}"
          aria-label="Decrease quantity" ${quantity <= 1 ? "disabled" : ""}>&minus;</button>
        <input type="text" inputmode="numeric" class="qty-stepper__input"
          data-action="set-addon-qty" data-sku="${escapeHtml(addon.sku)}" ${FIELD_NO_AUTOFILL_ATTRS}
          value="${escapeHtml(getAddonQuantityInputValue(addon))}" />
        <button type="button" data-action="inc-addon-qty" data-sku="${escapeHtml(addon.sku)}"
          aria-label="Increase quantity" ${quantity >= addon.maxQuantity ? "disabled" : ""}>&plus;</button>
      </div>
    </div>`
      : "";

  return `<div class="addon-extra">${configHtml}${qtyHtml}</div>`;
}

function accordionSectionHtml({ title, count, isOpen, toggleAction, cat, bodyHtml }) {
  return `
    <div>
      <button type="button" data-action="${toggleAction}" data-cat="${escapeHtml(cat)}"
        class="accordion-toggle">
        <span class="accordion-toggle__title">${escapeHtml(title)}</span>
        <div class="accordion-toggle__meta">
          <span class="badge">${count}</span>
          <svg class="${classNames("accordion-toggle__chevron", isOpen ? "accordion-toggle__chevron--open" : "")}" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.94a.75.75 0 111.08 1.04l-4.24 4.5a.75.75 0 01-1.08 0l-4.24-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
          </svg>
        </div>
      </button>
      ${isOpen ? `<div class="accordion-body">${bodyHtml}</div>` : ""}
    </div>
  `;
}

function searchInputHtml({ id, action, value, placeholder, disabled }) {
  return `
    <input type="search" id="${id}" data-action="${action}" ${FIELD_NO_AUTOFILL_ATTRS}
      class="input input--block panel__search" placeholder="${escapeHtml(placeholder)}"
      value="${escapeHtml(value)}" ${disabled ? "disabled" : ""} />
  `;
}

function productSectionHtml() {
  const selectedProduct = getSelectedProduct();
  const query = normalizeForSearch(state.productSearchQuery);
  const queryWords = query ? query.split(" ") : [];
  const searchedProducts = queryWords.length
    ? state.products.filter((p) => matchesSearch(p, queryWords))
    : state.products;

  const catsHtml = !state.authed
    ? `<div class="panel__loading"><span class="spinner" aria-hidden="true"></span>Loading products…</div>`
    : state.productCategories
        .map((cat) => {
          const items = searchedProducts.filter((p) => p.category === cat);
          if (items.length === 0) return "";
          const isOpen = query ? true : state.openProductCat === cat;
          const body = items
            .map((p) =>
              optionCardHtml({
                sku: p.sku,
                title: p.name,
                description: p.description,
                price: p.unit_price,
                selected: state.productSku === p.sku,
                disabled: false,
                action: "select-product",
              }),
            )
            .join("");
          return accordionSectionHtml({
            title: cat,
            count: items.length,
            isOpen,
            toggleAction: "toggle-product-cat",
            cat,
            bodyHtml: `<div class="stack-3">${body}</div>`,
          });
        })
        .join("");

  const noResultsHtml =
    state.authed && query && searchedProducts.length === 0
      ? `<p class="muted-text">No products match "${escapeHtml(state.productSearchQuery.trim())}".</p>`
      : "";

  return `
    <section class="panel">
      <div class="panel__header">
        <h2 class="section-title">Product</h2>
        <p class="section-subtitle">Select one product to begin. Prices shown include install & shipping but exclude tax.</p>
        ${searchInputHtml({
          id: "product-search-input",
          action: "set-product-search",
          value: state.productSearchQuery,
          placeholder: "Search products by name, SKU, or description…",
          disabled: !state.authed,
        })}
      </div>
      <div class="panel__body">${catsHtml}${noResultsHtml}</div>
    </section>
  `;
}

function addonSectionHtml() {
  const selectedProduct = getSelectedProduct();
  const productScopedAddons = getProductScopedAddons(selectedProduct);
  const incompatibleSkuSet = getIncompatibleSkuSet();
  const selectedAddons = getSelectedAddons();
  const query = normalizeForSearch(state.addonSearchQuery);
  const queryWords = query ? query.split(" ") : [];
  const searchedAddons = queryWords.length
    ? productScopedAddons.filter((a) => matchesSearch(a, queryWords))
    : productScopedAddons;

  let body = "";
  if (!selectedProduct) {
    body = `<div class="muted-text">Choose a product to see available add-ons.</div>`;
  } else if (productScopedAddons.length === 0) {
    body = `<div class="muted-text">No add-ons available for this product.</div>`;
  } else if (query && searchedAddons.length === 0) {
    body = `<div class="muted-text">No add-ons match "${escapeHtml(state.addonSearchQuery.trim())}".</div>`;
  } else {
    body = state.addonCategories
      .map((cat) => {
        const items = searchedAddons.filter((a) => a.category === cat);
        if (items.length === 0) return "";
        const isOpen = query ? true : state.openAddonCat === cat;
        const cardsHtml = items
          .map((a) => {
            const isChecked = state.addonSkus.has(a.sku);
            const isDisabled = !isChecked && incompatibleSkuSet.has(a.sku);
            const hasExtras = isChecked && (a.configurations.length > 1 || a.maxQuantity > 1);
            return checkboxCardHtml({
              sku: a.sku,
              title: a.name,
              // Quantity only ever means something once the add-on is
              // actually selected; an unchecked card always shows the plain
              // per-unit price, even if a stale quantity is still stored
              // from a previous selection.
              price: isChecked ? a.unit_price * getAddonQuantity(a) : a.unit_price,
              checked: isChecked,
              disabled: isDisabled,
              extrasHtml: hasExtras ? addonExtrasHtml(a) : "",
            });
          })
          .join("");
        return accordionSectionHtml({
          title: cat,
          count: items.length,
          isOpen,
          toggleAction: "toggle-addon-cat",
          cat,
          bodyHtml: `<div class="stack-3">${cardsHtml}</div>`,
        });
      })
      .join("");
  }

  const clearBtn =
    selectedProduct && selectedAddons.length > 0
      ? `
      <div class="panel__sticky-actions">
        <button data-action="clear-addons" class="btn btn--muted btn--floating">Clear add-ons</button>
      </div>`
      : "";

  return `
    <section class="panel">
      <div class="panel__header">
        <h2 class="section-title">Add-ons</h2>
        <p class="section-subtitle">Only add-ons compatible with the selected product are shown.</p>
        ${searchInputHtml({
          id: "addon-search-input",
          action: "set-addon-search",
          value: state.addonSearchQuery,
          placeholder: "Search add-ons by name, SKU, or description…",
          disabled: !selectedProduct || productScopedAddons.length === 0,
        })}
      </div>
      <div class="panel__body">
        ${body}
        ${clearBtn}
      </div>
    </section>
  `;
}

// Contact picker + editable ship-to address, only shown once a deal is
// selected (contacts are fetched per-deal, see loadContactsForDeal). Editing
// the address fields doesn't call HubSpot itself, they're only sent along
// with the rest of the quote on "Push to HubSpot" (see handlePushToHubspot),
// which is what actually writes them back onto the selected contact.
function shipToSectionHtml() {
  if (!state.selectedDeal) return "";

  const selectedContact =
    state.contacts.find((c) => c.hs_contact_id === state.selectedContactId) || null;

  let statusHtml = "";
  if (state.contactsLoading) {
    statusHtml = `<div class="panel__loading"><span class="spinner" aria-hidden="true"></span>Loading contacts…</div>`;
  } else if (state.contactsError) {
    statusHtml = `<p class="form-error">${escapeHtml(state.contactsError)}</p>`;
  } else if (state.contacts.length === 0) {
    statusHtml = `<p class="muted-text">No HubSpot contact found on this deal — this address is quote-only and won't sync to HubSpot.</p>`;
  }

  const contactLabel = (c) => {
    const name = [c.firstname, c.lastname].filter(Boolean).join(" ");
    return name ? (c.email ? `${name} (${c.email})` : name) : c.email || c.hs_contact_id;
  };

  const contactPickerHtml =
    state.contacts.length > 1
      ? `
    <div>
      <label class="field-label" for="ship-to-contact-select">Contact</label>
      <select id="ship-to-contact-select" data-action="select-ship-to-contact" class="input input--block" ${FIELD_NO_AUTOFILL_ATTRS}>
        ${state.contacts
          .map(
            (c) => `<option value="${escapeHtml(c.hs_contact_id)}" ${
              state.selectedContactId === c.hs_contact_id ? "selected" : ""
            }>${escapeHtml(contactLabel(c))}</option>`,
          )
          .join("")}
      </select>
    </div>`
      : state.contacts.length === 1
        ? `
    <div>
      <span class="field-label">Contact</span>
      <p class="ship-to__contact-display">${escapeHtml(contactLabel(state.contacts[0]))}</p>
    </div>`
        : "";

  const hubspotNoteHtml = selectedContact
    ? `<p class="muted-text ship-to__hubspot-note">Editing this address will update the contact in HubSpot.</p>`
    : "";

  const field = (key, label, extraAttrs = "", errorHtml = "") => `
    <div>
      <div class="ship-to__field">
        <label class="ship-to__field-label" for="ship-to-${key}">${label}</label>
        <input type="text" id="ship-to-${key}" data-action="set-ship-to-field" data-field="${key}"
          class="input ship-to__field-input" value="${escapeHtml(state.shipTo[key])}" ${FIELD_NO_AUTOFILL_ATTRS} ${extraAttrs} />
      </div>
      ${errorHtml}
    </div>
  `;

  const zipErrorHtml = isZipValid() ? "" : `<p class="ship-to__error">Zip must be 5 digits.</p>`;

  return `
    <div class="ship-to">
      <h3 class="subsection-title">Install Address</h3>
      ${statusHtml}
      ${contactPickerHtml}
      ${hubspotNoteHtml}
      ${field("street", "Street")}
      ${field("city", "City")}
      ${field("state", "State")}
      ${field("zip", "Zip", `maxlength="5" inputmode="numeric"`, zipErrorHtml)}
    </div>
  `;
}

// Comment + expiration date, plus the ship-to block; hidden entirely without
// a selected deal, same reasoning as shipToSectionHtml() above, there's no
// quote to attach these details to on a skip-straight-to-price-lookup quote.
function quoteDetailsHtml() {
  if (!state.selectedDeal) return "";
  return `
    <div class="quote-details">
      <div class="quote-details__columns">
        <div class="quote-details__col">
          <h3 class="subsection-title">Quote Details</h3>
          <div>
            <label class="field-label" for="quote-expiration-date">Expiration date</label>
            <input type="text" id="quote-expiration-date" readonly ${FIELD_NO_AUTOFILL_ATTRS}
              class="input input--block" value="${escapeHtml(state.quoteExpirationDate)}" />
          </div>
          <div>
            <label class="field-label" for="quote-comment">Comment</label>
            <textarea id="quote-comment" data-action="set-quote-comment" ${FIELD_NO_AUTOFILL_ATTRS}
              class="input input--block textarea textarea--autogrow" rows="2"
              placeholder="Optional comment shown on the quote">${escapeHtml(state.quoteComment)}</textarea>
          </div>
        </div>
        <div class="quote-details__col">
          ${shipToSectionHtml()}
        </div>
      </div>
    </div>
  `;
}

function summarySectionHtml() {
  const selectedProduct = getSelectedProduct();
  const selectedAddons = getSelectedAddons();

  const lineItems = [
    ...(selectedProduct
      ? [{
          name: selectedProduct.name,
          description: selectedProduct.description,
          price: selectedProduct.unit_price,
          cost: selectedProduct.unit_cost,
          sku: selectedProduct.sku,
        }]
      : []),
    ...selectedAddons.map((a) => {
      const qty = getAddonQuantity(a);
      const config = getAddonConfiguration(a);
      return {
        name: a.name,
        description: config ? `Configuration: ${config}` : "",
        price: a.unit_price * qty,
        cost: a.unit_cost * qty,
        sku: a.sku,
        addon: true,
        qty,
      };
    }),
  ];

  const subtotal = lineItems.reduce((s, item) => s + Number(item.price || 0), 0);
  const cost = lineItems.reduce((s, item) => s + Number(item.cost || 0), 0);
  const taxRate = getTaxRate(state.shipTo.zip);
  const tax =
    cost * taxRate +
    selectedAddons.reduce((s, a) => s + Number(a.unit_price || 0) * getAddonQuantity(a) * taxRate, 0);
  const rawDiscount = Number(state.discountValue || 0);
  const discountAmount =
    state.discountType === "$"
      ? Math.min(rawDiscount, subtotal)
      : subtotal * (Math.min(rawDiscount, 100) / 100);
  const totalBeforeTax = subtotal - discountAmount;
  const total = totalBeforeTax + tax;
  const marginPct = totalBeforeTax !== 0 ? ((subtotal - cost - discountAmount) / totalBeforeTax) * 100 : 0;
  const isLowMargin = marginPct < LOW_MARGIN_THRESHOLD;
  const isLowMarginFromDiscount = isLowMargin && discountAmount > 0;

  const marginHeld = state.marginHeld;
  const showCostColumn = marginHeld && SHOW_COST_COLUMN;

  const rowsHtml =
    lineItems.length === 0
      ? `<p class="muted-text">No items selected yet.</p>`
      : `
    <div class="line-items">
      <div class="line-items__head">
        <div class="line-items__col">Item</div>
        ${showCostColumn ? `<div class="line-items__col--amount">Cost</div>` : ""}
        <div class="line-items__col--amount">Price</div>
      </div>
      <div class="line-items__body">
        ${lineItems
          .map(
            (item) => `
          <div class="${classNames("line-item", item.addon && "line-item--addon")}">
            <div class="line-item__body">
              <div class="line-item__name">${escapeHtml(item.name)}${item.qty > 1 ? ` <span class="line-item__qty">× ${item.qty}</span>` : ""}</div>
              ${item.description ? `<div class="line-item__desc">${escapeHtml(item.description)}</div>` : ""}
            </div>
            ${showCostColumn ? `<div class="line-item__cost">${item.cost > 0 ? currencyWhole.format(item.cost) : "—"}</div>` : ""}
            <div class="line-item__price-wrap">
              <div class="line-item__price">${currencyWhole.format(Number(item.price || 0))}</div>
            </div>
          </div>
        `,
          )
          .join("")}
      </div>
    </div>
  `;

  const pushHubspotInfoHtml = `
    <span class="info-tooltip">
      <button type="button" class="info-tooltip__trigger" aria-label="What happens when you push to HubSpot" tabindex="0">i</button>
      <span class="info-tooltip__bubble" role="tooltip">Pushing to HubSpot will update the deal &amp; line items, void all previous quotes, and create a new quote.</span>
    </span>
  `;

  const alreadyPushed = Boolean(state.dealLink) && !state.pricingDirty;
  const pushHubspotDisabled =
    !state.isOnline || !state.selectedDeal || !selectedProduct || state.quoteLoading || alreadyPushed;
  const pushHubspotTitle = !state.isOnline
    ? "No internet connection"
    : !state.selectedDeal
      ? "Select a deal first"
      : !selectedProduct
        ? "Select a product first"
        : alreadyPushed
          ? "Already pushed — change the price to push again"
          : "";

  const pushButtonHtml = `
    <button type="button" data-action="push-hubspot" ${pushHubspotDisabled ? "disabled" : ""}
      ${pushHubspotTitle ? `title="${escapeHtml(pushHubspotTitle)}"` : ""}
      class="btn btn--primary">
      ${state.quoteLoading ? "Sending…" : "Push to HubSpot"}
    </button>
    ${pushHubspotInfoHtml}
  `;

  const secondaryActionsHtml = `
    ${
      state.dealLink
        ? `<a href="${escapeHtml(state.dealLink)}" target="_blank" rel="noopener noreferrer" class="btn btn--muted">View HubSpot Deal</a>`
        : ""
    }
    ${
      state.quoteLink
        ? `<a href="${escapeHtml(state.quoteLink)}" target="_blank" rel="noopener noreferrer" class="btn btn--gold">Sign Quote</a>
           <button type="button" data-action="open-send-quote" class="btn btn--gold">Send Quote</button>`
        : ""
    }
  `;

  return `
    <div class="summary">
      <div class="summary__header">
        <h2 class="section-title">Quote Summary</h2>
        ${
          marginHeld
            ? `<div class="summary__margin-group">
                <span class="${classNames("summary__margin", isLowMarginFromDiscount && "summary__margin--warning")}">Margin: ${marginPct.toFixed(1)}%</span>
                <span class="summary__margin-divider">|</span>
                <span class="summary__margin">Tax Rate: ${(taxRate * 100).toFixed(2)}%</span>
              </div>`
            : ""
        }
      </div>
      <p class="confidential-notice">Confidential. Pricing shown below is for internal/authorized use only, not for external distribution.</p>

      ${rowsHtml}

      <div class="totals">
        <div class="totals__row">
          <span class="totals__label">Subtotal</span>
          ${showCostColumn ? `<span class="totals__amount">${currencyWhole.format(cost)}</span>` : ""}
          <span class="totals__amount totals__amount--strong">${currencyWhole.format(subtotal)}</span>
        </div>

        <div class="totals__row totals__row--discount">
          <span class="totals__label">Discount</span>
          ${showCostColumn ? `<span class="totals__spacer"></span>` : ""}
          <div class="discount-controls">
            <div class="segmented">
              <button type="button" data-action="set-discount-type" data-type="$" class="${classNames(
                "segmented__btn",
                state.discountType === "$" ? "segmented__btn--active" : "",
              )}">$</button>
              <button type="button" data-action="set-discount-type" data-type="%" class="${classNames(
                "segmented__btn",
                state.discountType === "%" ? "segmented__btn--active" : "",
              )}">%</button>
            </div>
            <input type="text" inputmode="decimal" id="discount-value-input"
              data-action="set-discount-value" value="${escapeHtml(state.discountValue)}"
              class="input input--discount" ${FIELD_NO_AUTOFILL_ATTRS}
              placeholder="0" />
          </div>
        </div>
        ${
          discountAmount > 0
            ? `<div class="totals__row totals__row--applied">
                <span class="totals__label">Discount applied</span>
                ${showCostColumn ? `<span class="totals__spacer"></span>` : ""}
                <span class="totals__amount">-${currencyWhole.format(discountAmount)}</span>
              </div>`
            : ""
        }

        <div class="totals__row">
          <span class="totals__label">Tax</span>
          ${showCostColumn ? `<span class="totals__spacer"></span>` : ""}
          <span class="totals__amount totals__amount--strong">${currency.format(tax)}</span>
        </div>

        <div class="totals__row totals__row--total">
          <span class="totals__label">Total</span>
          ${showCostColumn ? `<span class="totals__spacer"></span>` : ""}
          <span class="totals__amount">${currency.format(total)}</span>
        </div>
      </div>

      ${quoteDetailsHtml()}

      <div class="summary__actions">
        <div class="summary__actions-top">
          <div class="summary__actions-row">
            ${pushButtonHtml}
          </div>
          <button type="button" data-action="toggle-margin" class="${classNames("btn", "btn--muted", "btn--margin-toggle", isLowMarginFromDiscount && "btn--margin-toggle--warning")}">
            ${marginHeld ? "Hide Margin" : "Show Margin"}
          </button>
        </div>
        ${
          secondaryActionsHtml.trim()
            ? `<div class="summary__actions-row">${secondaryActionsHtml}</div>`
            : ""
        }
      </div>
    </div>
  `;
}

function dealBannerHtml() {
  const changeDealButton = `<button type="button" data-action="back-to-deal-select" class="btn btn--muted deal-banner__change">Change Deal</button>`;

  if (!state.selectedDeal) {
    return `
      <div class="deal-banner">
        <span class="deal-banner__text muted-text">No deal selected — price lookup only.</span>
        ${changeDealButton}
      </div>
    `;
  }

  const notice = state.dealMatchFailed
    ? ` — couldn't match this deal's product to a package, please select manually.`
    : "";
  const dealLabel = escapeHtml(state.selectedDeal.dealname || state.selectedDeal.hs_object_id);
  const dealLink = state.selectedDeal.hs_object_id
    ? `<a href="${escapeHtml(HUBSPOT_DEAL_URL_BASE + state.selectedDeal.hs_object_id)}" target="_blank" rel="noopener noreferrer"><strong>${dealLabel}</strong></a>`
    : `<strong>${dealLabel}</strong>`;
  return `
    <div class="deal-banner">
      <span class="deal-banner__text">Configuring for deal: ${dealLink}${notice}</span>
      ${changeDealButton}
    </div>
  `;
}

function quoteEmailChipInputHtml() {
  const chipsHtml = state.quoteEmailChips
    .map(
      (email, i) => `
    <span class="chip">
      ${escapeHtml(email)}
      <button type="button" class="chip__remove" data-action="remove-quote-email-chip"
        data-index="${i}" aria-label="Remove ${escapeHtml(email)}" ${state.quoteEmailSending ? "disabled" : ""}>&times;</button>
    </span>
  `,
    )
    .join("");

  return `
    <div class="chip-input" data-action="focus-quote-email-draft">
      ${chipsHtml}
      <input type="text" id="quote-email-draft" data-action="set-quote-email-draft"
        class="chip-input__field" ${FIELD_NO_AUTOFILL_ATTRS}
        placeholder="${state.quoteEmailChips.length ? "" : "name@example.com, other@example.com"}"
        value="${escapeHtml(state.quoteEmailDraft)}" ${state.quoteEmailSending ? "disabled" : ""} />
    </div>
  `;
}

// Everything that goes inside #quote-email-form-content — the part of the
// send-quote modal that's safe to fully re-render on every keystroke. The
// modal shell and the iframe preview live outside this, see
// renderQuoteEmailModal() below, so they're never touched by this.
function quoteEmailFormContentHtml() {
  const sendDisabled =
    state.quoteEmailSending || (state.quoteEmailChips.length === 0 && !state.quoteEmailDraft.trim());
  const toPreviewParts = state.quoteEmailDraft.trim()
    ? [...state.quoteEmailChips, state.quoteEmailDraft.trim()]
    : state.quoteEmailChips;
  const toPreview = toPreviewParts.length
    ? escapeHtml(toPreviewParts.join(", "))
    : `<span class="muted-text">—</span>`;

  return `
    <h2 class="section-title">Send Quote</h2>

    <div class="stack-3">
      <div>
        <label class="field-label" for="quote-email-draft">Recipient email address(es)</label>
        ${quoteEmailChipInputHtml()}
      </div>
      <div>
        <label class="field-label" for="quote-email-subject">Subject</label>
        <input type="text" id="quote-email-subject" data-action="set-quote-email-subject"
          class="input input--block" value="${escapeHtml(state.quoteEmailSubject)}" ${FIELD_NO_AUTOFILL_ATTRS}
          ${state.quoteEmailSending ? "disabled" : ""} />
      </div>
      <div>
        <label class="field-label" for="quote-email-note">Note</label>
        <textarea id="quote-email-note" data-action="set-quote-email-note"
          class="input input--block textarea" rows="3" ${FIELD_NO_AUTOFILL_ATTRS}
          placeholder="Let me know if you want any changes!"
          ${state.quoteEmailSending ? "disabled" : ""}>${escapeHtml(state.quoteEmailNote)}</textarea>
      </div>
    </div>

    <div class="email-preview">
      <div class="email-preview__row">
        <span class="email-preview__label">From</span>
        <span class="email-preview__value">${escapeHtml(QUOTE_EMAIL_FROM)}</span>
      </div>
      <div class="email-preview__row">
        <span class="email-preview__label">To</span>
        <span class="email-preview__value">${toPreview}</span>
      </div>
      <div class="email-preview__row">
        <span class="email-preview__label">Subject</span>
        <span class="email-preview__value">${escapeHtml(state.quoteEmailSubject)}</span>
      </div>
      <div class="email-preview__body">${buildQuoteEmailBodyHtml()}</div>
    </div>

    ${state.quoteEmailError ? `<p class="form-error">${escapeHtml(state.quoteEmailError)}</p>` : ""}
    ${state.quoteEmailSent ? `<p class="email-sent-notice">Quote email sent.</p>` : ""}

    <button type="button" data-action="send-quote-email" ${sendDisabled ? "disabled" : ""}
      class="btn btn--primary btn--block">
      ${state.quoteEmailSending ? "Sending…" : "Send Quote"}
    </button>
  `;
}

function backToDealSelect() {
  clearDealIdFromUrl();
  state.step = "deal-select";
  render();
}

// Initials for the header avatar: prefer the Google account's display name
// (first letter of up to the first two words), falling back to the first
// two letters of the email's local part when only an email is available.
function getUserInitials() {
  const name = state.userName?.trim();
  if (name) {
    const initials = name
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join("");
    if (initials) return initials.toUpperCase();
  }
  const email = state.userEmail?.trim();
  if (email) return email.slice(0, 2).toUpperCase();
  return "?";
}

// Rendered into #header-user-menu, which lives in the static header markup
// in index.html, outside #app — same reason the Google button is rendered
// separately (see renderGoogleButton), so it survives every #app re-render
// instead of being torn down and recreated on every state change.
function headerUserMenuHtml() {
  if (!state.authed) return "";
  const label = escapeHtml(state.userEmail || state.userName || "");
  return `
    <div class="user-menu">
      <button type="button" data-action="toggle-user-menu" class="user-menu__avatar"
        aria-haspopup="true" aria-expanded="${state.userMenuOpen ? "true" : "false"}"
        aria-label="Account menu">${escapeHtml(getUserInitials())}</button>
      ${
        state.userMenuOpen
          ? `
        <div class="user-menu__panel" role="menu">
          <div class="user-menu__email">${label}</div>
          <button type="button" data-action="sign-out" class="btn btn--muted btn--block">Sign out</button>
        </div>
      `
          : ""
      }
    </div>
  `;
}

function appHtml() {
  // Sign-in always gates the deal search, even while a silent sign-in
  // attempt is still in flight on boot (see boot section below) — the
  // deal-select screen (and its search box) only ever appears once
  // state.authed is actually true. loginSectionHtml() shows its own
  // spinner while state.checkingGoogleSession/authLoading are in progress.
  if (!state.authed) {
    return loginSectionHtml();
  }
  if (state.step !== "cpq") {
    return dealSelectSectionHtml();
  }
  return `
    ${dealBannerHtml()}
    <div class="layout-grid" id="picker-root">
      ${productSectionHtml()}
      ${addonSectionHtml()}
    </div>
    <div id="summary-root">
      ${summarySectionHtml()}
    </div>
  `;
}

// --- render loop with focus preservation ---
const root = document.getElementById("app");
const headerUserMenuEl = document.getElementById("header-user-menu");
const devBypassBannerEl = document.getElementById("dev-bypass-banner");

// Kept separate from render()'s #app replacement so opening/closing the
// menu (or a state change elsewhere) doesn't need to re-render the whole
// app just to keep the header in sync.
function renderHeaderUserMenu() {
  headerUserMenuEl.innerHTML = headerUserMenuHtml();
}

// See "local dev auth bypass" above. Kept separate from #app for the same
// reason as the header user menu, and so it's visible even on the login
// screen, before state.authed flips true.
function renderDevBypassBanner() {
  devBypassBannerEl.style.display = state.devBypass ? "block" : "none";
  devBypassBannerEl.textContent = state.devBypass
    ? "Local dev: Google SSO bypassed via dev-auth.local.js."
    : "";
}

function captureFocus(container = root) {
  const el = document.activeElement;
  if (!el || !el.id || !container.contains(el)) return null;
  return {
    id: el.id,
    selectionStart: "selectionStart" in el ? el.selectionStart : null,
    selectionEnd: "selectionEnd" in el ? el.selectionEnd : null,
  };
}

function restoreFocus(saved) {
  if (!saved) return;
  const el = document.getElementById(saved.id);
  if (!el) return;
  el.focus();
  if (saved.selectionStart != null && "setSelectionRange" in el) {
    try {
      el.setSelectionRange(saved.selectionStart, saved.selectionEnd);
    } catch {
      // input type doesn't support selection ranges; ignore
    }
  }
}

// The send-quote modal is built once, outside #app, and never torn down —
// only its "form content" sub-panel is re-rendered on state changes. This
// keeps the embedded quote iframe (a sibling of that sub-panel, not part of
// it) from ever being removed from the document, which is what was causing
// it to reload/flash on every keystroke when it lived inside #app's
// full-innerHTML-replacement render cycle.
const quoteModalEl = document.createElement("div");
quoteModalEl.className = "quote-email-modal";
quoteModalEl.dataset.action = "close-send-quote-backdrop";
quoteModalEl.style.display = "none";
quoteModalEl.innerHTML = `
  <div class="quote-email-modal__panel">
    <div class="quote-email-modal__header">
      <button type="button" data-action="close-send-quote" class="quote-email-modal__close" aria-label="Close">&times;</button>
    </div>
    <div class="send-quote">
      <div class="send-quote__form" id="quote-email-form-content"></div>
      <div class="send-quote__preview" id="quote-iframe-container"></div>
    </div>
  </div>
`;
document.body.appendChild(quoteModalEl);

const quoteFormContentEl = document.getElementById("quote-email-form-content");
const quoteIframeContainerEl = document.getElementById("quote-iframe-container");

let quoteIframeEl = null;

function getOrCreateQuoteIframe() {
  if (!quoteIframeEl) {
    quoteIframeEl = document.createElement("iframe");
    quoteIframeEl.className = "send-quote__iframe";
    quoteIframeEl.title = "Quote preview";
  }
  return quoteIframeEl;
}

// The quote page (hs-sites.com) is a cross-origin document we can't inject
// CSS into, and it renders at a fixed desktop-ish width, so on a narrower
// preview pane it needs horizontal scrolling to see the full page. Instead,
// we lay the iframe out at a fixed "desktop" width, then shrink the whole
// element down with a CSS transform to fit the pane's actual width — this
// scales the rendered page visually (like a browser zoom-out) without
// touching its content, so only vertical scrolling is ever needed.
const QUOTE_IFRAME_NATIVE_WIDTH = 1024;
const QUOTE_IFRAME_NATIVE_HEIGHT = 3000;

function applyQuoteIframeScale() {
  if (!quoteIframeEl) return;
  const containerWidth = quoteIframeContainerEl.clientWidth;
  if (!containerWidth) return;
  const scale = Math.min(1, containerWidth / QUOTE_IFRAME_NATIVE_WIDTH);
  quoteIframeEl.style.width = `${QUOTE_IFRAME_NATIVE_WIDTH}px`;
  quoteIframeEl.style.height = `${QUOTE_IFRAME_NATIVE_HEIGHT}px`;
  quoteIframeEl.style.transform = `scale(${scale})`;
}

const quoteIframeResizeObserver = new ResizeObserver(() => applyQuoteIframeScale());
quoteIframeResizeObserver.observe(quoteIframeContainerEl);

function renderQuoteEmailModal() {
  quoteModalEl.style.display = state.quoteEmailModalOpen ? "flex" : "none";
  document.body.style.overflow = state.quoteEmailModalOpen ? "hidden" : "";
  if (!state.quoteEmailModalOpen) return;

  const saved = captureFocus(quoteModalEl);
  quoteFormContentEl.innerHTML = quoteEmailFormContentHtml();
  restoreFocus(saved);

  const iframe = getOrCreateQuoteIframe();
  const desiredSrc = state.quoteLink || "";
  if (iframe.src !== desiredSrc) iframe.src = desiredSrc;
  if (iframe.parentNode !== quoteIframeContainerEl) {
    quoteIframeContainerEl.appendChild(iframe);
  }
  // Scaling is handled by quoteIframeResizeObserver below, not here — this
  // function runs on every keystroke in the modal's form fields, and forcing
  // a layout read + style write on every render was jank-y enough on mobile
  // Safari to drop fast typing. The observer already fires whenever the
  // pane's real size changes, including this display:none -> flex moment.
}

// .panel__body (product/add-on lists) are torn down and recreated on every
// render along with the rest of #app, which would otherwise reset their
// scroll position to the top on every click. There's no stable id to key off
// of, but the panels always render in the same order, so position in the
// NodeList is enough.
function capturePanelScroll() {
  return Array.from(root.querySelectorAll(".panel__body")).map((el) => el.scrollTop);
}

function restorePanelScroll(saved) {
  // .panel__body has scroll-behavior: smooth (styles.css), which would
  // otherwise animate this restore from the post-remount scrollTop of 0 up
  // to the saved position instead of snapping there instantly. Passing an
  // explicit behavior overrides the CSS, same trick used for the
  // window.scrollTo below.
  root.querySelectorAll(".panel__body").forEach((el, i) => {
    if (saved[i] != null) el.scrollTo({ top: saved[i], behavior: "instant" });
  });
}

// Grows the comment textarea to fit its content instead of scrolling
// internally: reset to "auto" first so scrollHeight reflects a shrink too
// (deleting a wrapped line), not just its previous, already-grown height.
// #app's innerHTML is fully replaced on every render, so this has to re-run
// after every render, not just on this field's own input event.
function autoGrowCommentTextarea() {
  const el = document.getElementById("quote-comment");
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

// Google Identity Services attaches its button to a live DOM node rather
// than accepting an HTML string, so it can't be part of appHtml() like
// everything else; render it into the placeholder loginSectionHtml() left
// behind, after every re-render, same pattern as renderQuoteEmailModal().
function renderGoogleButton() {
  const container = document.getElementById("google-signin-button");
  if (!container || !window.google?.accounts?.id) return;
  window.google.accounts.id.renderButton(container, {
    type: "standard",
    theme: "outline",
    size: "large",
    width: 300,
    // "pill" is the roundest corner option Google's button supports; it's
    // rendered inside a cross-origin iframe, so its CSS isn't ours to
    // override otherwise.
    shape: "pill",
  });
}

// The native <input type="date"> couldn't be restyled (it's browser/OS
// chrome, not something CSS can reach), so the expiration date field is a
// plain readonly text input driven by Flatpickr (vendored locally under
// ./vendor/, no CDN dependency, so it still works offline) for an on-brand
// calendar dropdown instead — see the flatpickr-* overrides in styles.css.
// Same reason as renderGoogleButton() above: #app's innerHTML is fully
// replaced on every render, which would leave a stale instance pointing at
// a detached input, so the old instance is torn down and a fresh one
// attached after every re-render.
let expirationDatePicker = null;

function renderExpirationDatePicker() {
  expirationDatePicker?.destroy();
  expirationDatePicker = null;
  const el = document.getElementById("quote-expiration-date");
  if (!el || !window.flatpickr) return;
  expirationDatePicker = window.flatpickr(el, {
    dateFormat: "Y-m-d",
    // altInput shows a friendlier "Jan 4, 2027" format while the original
    // (now hidden) input, and the onChange dateStr below, stay in the
    // Y-m-d form state.quoteExpirationDate/the HubSpot push expect.
    altInput: true,
    altFormat: "M j, Y",
    altInputClass: "input input--block",
    defaultDate: state.quoteExpirationDate || undefined,
    minDate: "today",
    // Flatpickr swaps in the browser's native date input on touch devices
    // by default, overriding the on-brand calendar this field exists to
    // show in the first place (see the comment above this function).
    disableMobile: true,
    onChange: (_dates, dateStr) => setQuoteExpirationDate(dateStr),
  });
  // altInput doesn't inherit the original input's id, which would leave the
  // "Expiration date" <label for="quote-expiration-date"> pointing at the
  // now-hidden original instead of the visible field; move the id over.
  if (expirationDatePicker.altInput) {
    expirationDatePicker.input.removeAttribute("id");
    expirationDatePicker.altInput.id = "quote-expiration-date";
  }
}

// render()/renderPicker()/renderSummary() each only *schedule* their actual
// rebuild for the next animation frame, coalescing repeated calls to the
// same one within that frame into a single DOM rebuild. Without this, each
// keystroke synchronously tore down and rebuilt whatever it was typed into
// (innerHTML replacement, then refocus) — on a phone, typing faster than one
// rebuild-and-refocus cycle could complete raced the keyboard's own
// composition, dropping characters. state.* is already current by the time a
// deferred rebuild runs, so nothing is lost, it just repaints less often.
const scheduledRenders = new Set();

function scheduleRender(key, fn) {
  if (scheduledRenders.has(key)) return;
  scheduledRenders.add(key);
  requestAnimationFrame(() => {
    scheduledRenders.delete(key);
    fn();
  });
}

function render() {
  scheduleRender("app", renderNow);
}

function renderNow() {
  const saved = captureFocus();
  const savedScroll = capturePanelScroll();
  root.innerHTML = appHtml();
  restoreFocus(saved);
  restorePanelScroll(savedScroll);
  autoGrowCommentTextarea();
  renderQuoteEmailModal();
  renderGoogleButton();
  renderExpirationDatePicker();
  renderHeaderUserMenu();
  renderDevBypassBanner();
}

// Typing in the product/add-on search boxes only changes productSectionHtml()/
// addonSectionHtml()'s own output. Routing it through renderPicker() instead of
// the full render() skips rebuilding summarySectionHtml() and dealBannerHtml()
// on every keystroke there, which is pure waste since neither depends on the
// search query.
function renderPickerNow() {
  const el = document.getElementById("picker-root");
  if (!el) return;
  const saved = captureFocus(el);
  const savedScroll = capturePanelScroll();
  el.innerHTML = `${productSectionHtml()}${addonSectionHtml()}`;
  restoreFocus(saved);
  restorePanelScroll(savedScroll);
}

function renderPicker() {
  scheduleRender("picker", renderPickerNow);
}

// Typing in the Comment/ship-to/discount fields only changes
// summarySectionHtml()'s own output, not the product/add-on catalog markup
// rendered alongside it in appHtml() — which, for a real catalog's worth of
// product/add-on cards, is the expensive part to re-serialize and reparse.
// Rebuilding only #summary-root for those fields (see setQuoteComment/
// setShipToField/setDiscountValue below) means a keystroke there no longer
// touches that catalog markup at all, which batching render() to one rebuild
// per frame didn't address on its own.
function renderSummaryNow() {
  const el = document.getElementById("summary-root");
  if (!el) return;
  const saved = captureFocus(el);
  el.innerHTML = summarySectionHtml();
  restoreFocus(saved);
  autoGrowCommentTextarea();
  renderExpirationDatePicker();
}

function renderSummary() {
  scheduleRender("summary", renderSummaryNow);
}

// --- event delegation ---
// click/input/keydown are delegated on `document`, not `root`, because the
// send-quote modal is deliberately mounted outside #app (see quoteModalEl
// above) so its contents never go through #app's innerHTML replacement.

// Closes the account menu on any click outside it. This has to run and
// finish *before* the action-switch listener below: that listener's
// "toggle-user-menu" case calls renderHeaderUserMenu(), which replaces
// #header-user-menu's contents and detaches e.target from the document —
// if this check ran after that, e.target.closest("#header-user-menu") would
// already be evaluating a disconnected node and wrongly report "outside",
// closing the menu on the same click that opened it.
document.addEventListener("click", (e) => {
  if (!state.userMenuOpen) return;
  if (e.target.closest("#header-user-menu")) return;
  state.userMenuOpen = false;
  renderHeaderUserMenu();
});

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;
  switch (action) {
    case "select-product":
      selectProduct(el.dataset.sku);
      break;
    case "toggle-addon": {
      const disabled = el.hasAttribute("disabled");
      if (!disabled) toggleAddon(el.dataset.sku);
      break;
    }
    case "toggle-product-cat":
      toggleProductCat(el.dataset.cat);
      break;
    case "toggle-addon-cat":
      toggleAddonCat(el.dataset.cat);
      break;
    case "clear-addons":
      clearAddons();
      break;
    case "inc-addon-qty":
      if (!el.hasAttribute("disabled")) incAddonQuantity(el.dataset.sku);
      break;
    case "dec-addon-qty":
      if (!el.hasAttribute("disabled")) decAddonQuantity(el.dataset.sku);
      break;
    case "set-discount-type":
      setDiscountType(el.dataset.type);
      break;
    case "toggle-margin":
      toggleMargin();
      break;
    case "push-hubspot":
      handlePushToHubspot();
      break;
    case "skip-deal-select":
      skipToPriceLookup();
      break;
    case "back-to-deal-select":
      backToDealSelect();
      break;
    case "choose-deal": {
      const deal = state.dealSearchResults.find(
        (d) => String(d.hs_object_id) === el.dataset.dealId,
      );
      if (deal) chooseDeal(deal);
      break;
    }
    case "open-send-quote":
      openSendQuoteModal();
      break;
    case "close-send-quote":
      closeSendQuoteModal();
      break;
    case "close-send-quote-backdrop":
      // only a direct click on the backdrop padding should close it, not a
      // click somewhere inside the panel that happened to bubble up here
      if (e.target === el) closeSendQuoteModal();
      break;
    case "focus-quote-email-draft":
      document.getElementById("quote-email-draft")?.focus();
      break;
    case "remove-quote-email-chip":
      if (!el.hasAttribute("disabled")) removeQuoteEmailChip(Number(el.dataset.index));
      break;
    case "send-quote-email":
      if (!el.hasAttribute("disabled")) handleSendQuoteEmail();
      break;
    case "sign-out":
      signOut();
      break;
    case "toggle-user-menu":
      state.userMenuOpen = !state.userMenuOpen;
      renderHeaderUserMenu();
      break;
  }
});

document.addEventListener("input", (e) => {
  if (e.target.dataset.action === "set-discount-value") {
    setDiscountValue(e.target.value);
  }
  if (e.target.dataset.action === "set-deal-search") {
    setDealSearchQuery(e.target.value);
  }
  if (e.target.dataset.action === "set-product-search") {
    setProductSearchQuery(e.target.value);
  }
  if (e.target.dataset.action === "set-addon-search") {
    setAddonSearchQuery(e.target.value);
  }
  if (e.target.dataset.action === "set-addon-config") {
    setAddonConfiguration(e.target.dataset.sku, e.target.value);
  }
  if (e.target.dataset.action === "set-addon-qty") {
    setAddonQuantity(e.target.dataset.sku, e.target.value);
  }
  if (e.target.dataset.action === "set-quote-comment") {
    setQuoteComment(e.target.value);
  }
  if (e.target.dataset.action === "set-ship-to-field") {
    setShipToField(e.target.dataset.field, e.target.value);
  }
  if (e.target.dataset.action === "select-ship-to-contact") {
    selectContact(e.target.value);
  }
  if (e.target.dataset.action === "set-quote-email-draft") {
    setQuoteEmailDraft(e.target.value);
  }
  if (e.target.dataset.action === "set-quote-email-subject") {
    setQuoteEmailSubject(e.target.value);
  }
  if (e.target.dataset.action === "set-quote-email-note") {
    setQuoteEmailNote(e.target.value);
  }
});

document.addEventListener("keydown", (e) => {
  if (e.target.dataset.action !== "set-quote-email-draft") return;
  if (e.key === "Enter") {
    e.preventDefault();
    commitQuoteEmailDraft();
  } else if (e.key === "Backspace" && state.quoteEmailDraft === "") {
    untileLastQuoteEmailChip();
  }
});

// Re-tiles whatever's left in the draft (e.g. a chip that was un-tiled by
// backspacing into it, see untileLastQuoteEmailChip) once focus leaves the
// field, so it doesn't just sit there as loose, uncommitted text.
//
// Every keystroke re-renders #quote-email-form-content, which destroys and
// recreates this same input, and that destruction fires a "focusout" on the
// outgoing node even though the user never actually left the field —
// restoreFocus() re-focuses its replacement synchronously right after. So
// the check is deferred a tick: by then, a same-field re-render has already
// refocused the new node (activeElement.id is back to "quote-email-draft"
// and nothing is committed), while a real blur (clicking elsewhere) leaves
// activeElement pointing at whatever was actually clicked.
document.addEventListener("focusout", (e) => {
  if (e.target.dataset.action !== "set-quote-email-draft") return;
  setTimeout(() => {
    if (document.activeElement?.id !== "quote-email-draft" && state.quoteEmailDraft.trim()) {
      commitQuoteEmailDraft();
    }
  }, 0);
});

// setQuoteComment/setShipToField (above) skip re-rendering on every
// keystroke; this catches the summary panel up once the user leaves either
// field, so anything depending on state.pricingDirty or zip validity isn't
// stuck showing what it looked like before they started typing.
document.addEventListener("focusout", (e) => {
  if (e.target.dataset.action === "set-quote-comment" || e.target.dataset.action === "set-ship-to-field") {
    renderSummary();
  }
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.quoteEmailModalOpen) {
    closeSendQuoteModal();
  }
  if (e.key === "Escape" && state.userMenuOpen) {
    state.userMenuOpen = false;
    renderHeaderUserMenu();
  }
});

// --- online/offline tracking ---
window.addEventListener("online", () => {
  state.isOnline = true;
  render();
});
window.addEventListener("offline", () => {
  state.isOnline = false;
  render();
});

// --- re-check auth when the app is resumed, not just freshly loaded ---
// Closing a tab and reopening one to the same URL is a fresh navigation,
// the boot logic below runs again from scratch, no issue there. But
// switching away and back, minimizing/restoring the window, or backgrounding
// and foregrounding an installed PWA (this app's manifest.json enables
// "Add to Home Screen") often doesn't reload the page at all — the browser
// (or OS, for a PWA) just suspends and later resumes the exact same JS
// execution, so none of the one-time boot code at the bottom of this file
// runs again. That includes the products-sheet fetch that doubles as this
// session's live auth check (see fetchProductsSheet above), so a revoked
// account wouldn't be caught again until an actual reload happened, even
// while online the whole time.
// `visibilitychange` covers the ordinary "tab/window/app came back into
// view" case; `pageshow` with `persisted: true` additionally covers a
// same-page restore from the browser's back/forward cache specifically,
// which doesn't always fire visibilitychange in every browser. Either one
// just re-runs the products check, not a full re-authentication, so it
// doesn't touch anything else about the current session (selected
// product/add-ons/deal, in-progress quote, etc. are left exactly as they were).
let revalidatingAuthOnResume = false;

async function revalidateAuthOnResume() {
  if (!state.authed || state.devBypass) return;
  if (!state.isOnline) return;
  if (revalidatingAuthOnResume) return;

  const storedGoogleSession = loadStoredGoogleSession();
  if (!storedGoogleSession) return;

  revalidatingAuthOnResume = true;
  try {
    await fetchProductsSheet(storedGoogleSession.idToken);
  } catch (e) {
    if (e.code === "unauthorized") {
      // Same handling as a rejected stored-session replay on boot (see
      // authenticateWithGoogle): don't leave a revoked account signed in or
      // auto-selectable, and reload straight into a clean sign-in screen
      // rather than leaving a scary error sitting over whatever was on
      // screen. This can interrupt an in-progress quote, but continuing to
      // let a revoked account keep using pricing data isn't the safer
      // failure mode here.
      window.google?.accounts?.id?.disableAutoSelect();
      clearStoredGoogleSession();
      window.location.reload();
    }
    // Any other failure (a network hiccup despite navigator.onLine, a
    // transient 5xx, etc.) isn't worth interrupting an already-working
    // session over; just leave things as they are.
  } finally {
    revalidatingAuthOnResume = false;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") revalidateAuthOnResume();
});
window.addEventListener("pageshow", (e) => {
  if (e.persisted) revalidateAuthOnResume();
});

// --- boot ---
render();

// Called once the Google Identity Services script (loaded async in
// index.html) is confirmed ready, see the load/error listeners on that
// script tag below, which is what actually invokes this. Only sets Google
// up to handle an *explicit* button click; there's no silent/One-Tap
// sign-in attempt here at all (see the storedGoogleSession replay below for
// how returning visitors skip the button instead).
function initGoogleAuth() {
  if (!window.google?.accounts?.id) {
    // Script didn't load (blocked, offline, etc). There's no local fallback,
    // Google has to do the actual signing in, so just surface it instead of
    // leaving an unexplained empty button container.
    state.authError = "Could not load Google Sign-In. Check your connection and reload.";
    render();
    return;
  }
  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: (response) => authenticateWithGoogle(response.credential),
  });
  render();
}

function bootGoogleAuth() {
  const storedGoogleSession = loadStoredGoogleSession();

  if (storedGoogleSession) {
    // Skip Google's own sign-in flow (and its silent-sign-in prompt) entirely
    // on a returning visit: replay the last verified ID token straight into
    // authenticateWithGoogle() instead. While online, that token still gets
    // fully re-verified by n8n on this call (see authenticateWithGoogle); an
    // expired/rejected token just falls back to the explicit Google button
    // below, same as a first-time visitor. While offline, there's no reaching
    // n8n either, so the service worker's cache fallback serves the last
    // successful pricing response, exactly like it always has for offline
    // visits, see GOOGLE_SESSION_STORAGE_KEY above.
    state.checkingGoogleSession = true;
    render();
    authenticateWithGoogle(storedGoogleSession.idToken, true);
  }

  // Google Identity Services is still initialized in parallel (not only when
  // there's no stored session) so the explicit "Sign in with Google" button
  // is ready to use immediately if the stored-token replay above fails.
  if (window.google?.accounts?.id) {
    // Already loaded and executed by the time this line runs (e.g. cached,
    // or this synchronous script happened to run after the async one).
    initGoogleAuth();
  } else {
    // Deliberately NOT window's `load` event here — that waits for every
    // resource on the page, including the header/favicon images pulled from
    // HubSpot's CDN, which was adding multiple seconds before the sign-in
    // button ever had a chance to appear. Waiting on this one script tag's
    // own load/error event gets the button up as soon as Google's script
    // itself is actually ready, nothing else on the page should hold it back.
    const script = document.getElementById("google-identity-script");
    if (script) {
      script.addEventListener("load", initGoogleAuth, { once: true });
      script.addEventListener("error", initGoogleAuth, { once: true });
    } else {
      // Shouldn't happen (the tag lives in index.html), but don't hang forever.
      window.addEventListener("load", initGoogleAuth);
    }
  }
}

// See "local dev auth bypass" above: on a candidate host, try the local dev
// config before ever touching Google. If it's missing or has no password
// (e.g. a teammate running the same static server without opting in), fall
// straight back to the normal Google boot path below, nothing else changes.
if (DEV_BYPASS_CANDIDATE) {
  state.checkingGoogleSession = true;
  render();
  loadDevAuthConfig().then((config) => {
    if (config && config.password) {
      authenticateWithDevBypass(config.password);
    } else {
      state.checkingGoogleSession = false;
      render();
      bootGoogleAuth();
    }
  });
} else {
  bootGoogleAuth();
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    // service-worker.js lives one directory up from cpq/ (see its own
    // top-of-file comment for why). Resolved against this script's own URL
    // (APP_SCRIPT_URL, captured above) rather than either "./service-worker.js"
    // (resolves against *the page's* URL, which breaks on a no-trailing-slash
    // ".../cpq") or a hardcoded absolute path (broke when this app moved from
    // being served under an IP + "/sales.californiamobility.com/cpq" path to
    // living at that domain's own root, doubling the path, see HANDOFF.md).
    const swUrl = APP_SCRIPT_URL
      ? new URL("../service-worker.js", APP_SCRIPT_URL).href
      : "../service-worker.js";
    navigator.serviceWorker
      .register(swUrl)
      .catch((err) => console.error("SW registration failed:", err));
  });
}
