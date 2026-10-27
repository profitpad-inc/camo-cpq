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
// visible under "Show Margin", since hidden too, see SHOW_MARGIN_PCT); flip this back on if they want it restored.
const SHOW_COST_COLUMN = false;

// Client asked to swap the "Margin: X%" readout in the summary header for the
// active pricebook's name; flip this back on to show margin again (it sits
// before the pricebook name when restored).
const SHOW_MARGIN_PCT = false;

// The pricing endpoint backs onto a Google Sheet and can't fetch all its
// sheets in one request without serializing them server-side, so each sheet
// is fetched with its own &sheet= call. `products` is split out from
// `options`/`packages`/`taxes`/`pricebooks` below: it's always fetched fresh
// (see fetchProductsSheet), the rest are cache-eligible (see
// fetchCatalogSheets/loadPricingData).
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
// this sheet responds with a bare top-level array holding a single object with
// two row lists, `zip_taxes` and `city_taxes` (see extractTaxSheet below for
// the older shapes still tolerated).
async function fetchTaxRates(fetchCall) {
  try {
    const res = await fetchCall();
    if (!res.ok) {
      console.warn(`[taxes] sheet=taxes returned ${res.status}, no tax rates loaded this session.`);
      return { zip_taxes: [], city_taxes: [] };
    }
    return extractTaxSheet(await res.json());
  } catch (e) {
    console.warn("[taxes] sheet=taxes fetch failed, no tax rates loaded this session.", e);
    return { zip_taxes: [], city_taxes: [] };
  }
}

// The taxes sheet has shipped in a few shapes as the n8n workflow settled in,
// so normalize them all down to `{ zip_taxes, city_taxes }` here rather than
// making the callers care:
//   - current:  [{ "zip_taxes": [...], "city_taxes": [...] }]
//   - unwrapped `{ "zip_taxes": [...], "city_taxes": [...] }`
//   - legacy zip-only `{ "taxes": [...] }` or a bare array of zip rows
// A legacy payload yields no city rows at all, which getTaxRate handles fine —
// it just falls straight through to the zip lookup, as it always did.
function extractTaxSheet(data) {
  const entries = Array.isArray(data) ? data : [data];
  const zipRows = [];
  const cityRows = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (Array.isArray(entry.zip_taxes) || Array.isArray(entry.city_taxes)) {
      zipRows.push(...(entry.zip_taxes || []));
      cityRows.push(...(entry.city_taxes || []));
      continue;
    }
    // legacy: a bare zip row, or the old `{ "taxes": [...] }` wrapper
    if (Array.isArray(entry.taxes)) zipRows.push(...entry.taxes);
    else zipRows.push(entry);
  }
  return { zip_taxes: zipRows, city_taxes: cityRows };
}

// Best-effort for the same reason as fetchTaxRates above: this sheet is new,
// and a miss here just means every price falls back to the base pricebook
// column for this session rather than a broken sign-in.
//
// Same bare-array-holding-one-object shape as the taxes sheet:
// `[{ "pricebooks": [...] }]`.
async function fetchPricebooks(fetchCall) {
  try {
    const res = await fetchCall();
    if (!res.ok) {
      console.warn(
        `[pricebooks] sheet=pricebooks returned ${res.status}, falling back to the base pricebook.`,
      );
      return [];
    }
    return extractPricebookSheet(await res.json());
  } catch (e) {
    console.warn("[pricebooks] sheet=pricebooks fetch failed, falling back to the base pricebook.", e);
    return [];
  }
}

// Flattens the documented `[{ "pricebooks": [...] }]` down to a plain row
// array, also tolerating the unwrapped `{ "pricebooks": [...] }` object and a
// bare array of rows — same defensiveness as extractTaxSheet above, and for
// the same reason: this sheet is new enough that its wrapper may still move.
function extractPricebookSheet(data) {
  const entries = Array.isArray(data) ? data : [data];
  const rows = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (Array.isArray(entry.pricebooks)) rows.push(...entry.pricebooks);
    else rows.push(entry);
  }
  return rows;
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

// options/packages/taxes/pricebooks are just catalog data, not part of the
// auth check above, so they're fine to serve from the cache below rather than
// always hitting the network.
async function fetchCatalogSheets(idToken) {
  const authHeaders = { Authorization: `Bearer ${idToken}` };
  const responses = await Promise.all(
    ["options", "packages"].map((sheet) =>
      fetch(`${PRICING_URL}?sheet=${sheet}`, { headers: authHeaders }),
    ),
  );
  checkPricingResponses(responses, GOOGLE_UNAUTHORIZED_MESSAGE);

  const [options, packages] = await Promise.all(responses.map((res) => res.json()));
  const [taxes, pricebooks] = await Promise.all([
    fetchTaxRates(() => fetch(`${PRICING_URL}?sheet=taxes`, { headers: authHeaders })),
    fetchPricebooks(() => fetch(`${PRICING_URL}?sheet=pricebooks`, { headers: authHeaders })),
  ]);
  return {
    options: options.options || [],
    packages: packages.packages || [],
    taxes,
    pricebooks,
  };
}

async function fetchPricingData(idToken) {
  const [products, rest] = await Promise.all([
    fetchProductsSheet(idToken),
    loadPricingData(() => fetchCatalogSheets(idToken)),
  ]);
  return { products, ...rest };
}

// --- pricing data cache (options/packages/taxes/pricebooks) ---
// n8n's sheet-backed pricing endpoint doesn't change often enough to justify
// a network round-trip on every single sign-in, so the merged
// options/packages/taxes/pricebooks payload (products is excluded, see
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
// Key is versioned: the options sheet's single `price` column became the
// price_base/price_1..price_9 pricebook columns, and the payload gained a
// `pricebooks` list, so a cache written before that change has neither. Rather
// than serve one for up to 48 hours (silently pricing everything off the base
// column with no pricebook rows to switch on), bumping the key retires those
// entries outright. The pre-pricebook shapes are still tolerated downstream —
// see BASE_PRICE_KEYS — this just avoids leaning on that on a fresh deploy.
// Bumped again (v2 -> v3) when the pricebooks sheet moved from city/zip rows
// to lead_source rows and the options sheet's price_1..price_9 columns became
// named ones (price_kaiser, price_regional_center, ...).
const PRICING_CACHE_STORAGE_KEY = "cpq-pricing-cache-v4";
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

// `fetchFresh` is a thunk wrapping either fetchCatalogSheets(idToken) or
// fetchCatalogSheetsWithDevPassword(password), so this cache layer works the
// same for both auth paths.
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

async function fetchCatalogSheetsWithDevPassword(password) {
  const responses = await Promise.all(
    ["options", "packages"].map((sheet) =>
      fetch(`${PRICING_URL}?sheet=${sheet}&p=${encodeURIComponent(password)}`),
    ),
  );
  checkPricingResponses(responses, DEV_BYPASS_UNAUTHORIZED_MESSAGE);

  const [options, packages] = await Promise.all(responses.map((res) => res.json()));
  const [taxes, pricebooks] = await Promise.all([
    fetchTaxRates(() => fetch(`${PRICING_URL}?sheet=taxes&p=${encodeURIComponent(password)}`)),
    fetchPricebooks(() => fetch(`${PRICING_URL}?sheet=pricebooks&p=${encodeURIComponent(password)}`)),
  ]);
  return {
    options: options.options || [],
    packages: packages.packages || [],
    taxes,
    pricebooks,
  };
}

async function fetchPricingDataWithDevPassword(password) {
  const [products, rest] = await Promise.all([
    fetchProductsSheetWithDevPassword(password),
    loadPricingData(() => fetchCatalogSheetsWithDevPassword(password)),
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
    state.pricebooks = data.pricebooks;
    state.priceColumns = data.priceColumns;
    // Points every unit_price at the right pricebook column before anything
    // reads one; re-run whenever the contact or the pricebook dropdown changes.
    applyActivePricebook();
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

// City -> and zip -> sales tax rate lookups (see sheet=taxes). The city rows
// (`city_taxes`, keyed on `Location`/`Rate`) are the primary lookup, the zip
// rows (`zip_taxes`, keyed on `Zip`/`tax_rate`) are the fallback; see
// getTaxRate. Every other field on both is thrown out, this app has no use for
// county/state/rate_type/notes.
//
// The zip rows carry one special "zip_unknown" row (its Zip value is literally
// that string, not a real zip) whose tax_rate is the fallback used whenever
// neither the ship-to city nor its zip is one of the sheet's recognized keys.
function normalizeTaxRates(rawTaxes) {
  const { zip_taxes: zipRows, city_taxes: cityRows } = extractTaxSheet(rawTaxes || []);
  const byZip = {};
  const byCity = {};
  // lowercased city key -> the sheet's own spelling of it, so the summary panel
  // can show which row a rate came from ("Piedmont → 10.25%") in the sheet's
  // casing rather than whatever the rep happened to type; see resolveTaxRate.
  const cityNames = {};
  let unknownRate = 0;

  for (const row of zipRows) {
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

  for (const row of cityRows) {
    // Keys are lowercased (and the lookup lowercases too, see getTaxRate) so a
    // rep typing "san diego" or "SAN DIEGO" still matches the sheet's
    // "San Diego". Whatever the contact record or the rep typed is free text,
    // there's no reason to expect it to match the sheet's casing.
    const label = String(row.Location ?? "").trim();
    const city = label.toLowerCase();
    if (city) {
      byCity[city] = Number(row.Rate) || 0;
      cityNames[city] = label;
    }
  }

  return { byZip, byCity, cityNames, unknownRate };
}

// Shown in place of a matched city/zip whenever a lookup falls through to the
// sheet's own fallback row (the taxes sheet's "zip_unknown" rate, the
// pricebooks sheet's "fallback" row), so the summary panel can always say
// *why* a rate/pricebook is what it is rather than showing a bare number.
const LOCATION_FALLBACK_LABEL = "Default";

// City first, zip second: an unincorporated address inside a city's zip pays
// the county rate, so the city name is the more precise signal when the sheet
// recognizes it. Falls back to the zip rows whenever the city is blank or
// unrecognized, and finally to the sheet's own "zip_unknown" rate when neither
// matches, same convention the sheet itself uses.
//
// Returns `{ rate, source, label }` rather than just the rate so the summary
// panel can show which key the rate actually came from; getTaxRate below is
// the rate-only wrapper everything that doesn't care uses.
function resolveTaxRate(city, zip) {
  const { byCity, cityNames, byZip, unknownRate } = state.taxRates;
  const cityKey = String(city || "").trim().toLowerCase();
  if (cityKey && Object.prototype.hasOwnProperty.call(byCity, cityKey)) {
    return { rate: byCity[cityKey], source: "city", label: cityNames[cityKey] || cityKey };
  }
  const trimmedZip = String(zip || "").trim();
  if (trimmedZip && Object.prototype.hasOwnProperty.call(byZip, trimmedZip)) {
    return { rate: byZip[trimmedZip], source: "zip", label: trimmedZip };
  }
  return { rate: unknownRate, source: "fallback", label: LOCATION_FALLBACK_LABEL };
}

function getTaxRate(city, zip) {
  return resolveTaxRate(city, zip).rate;
}

// --- pricebooks: which price column a quote reads from ---
// Products and options don't carry a single `price`. They each carry a set of
// pricebook columns (`price_base`, `price_kaiser`, `price_regional_center`,
// ...), and both sheets carry the same set. Which column applies is decided
// per quote by the pricebooks sheet (`?sheet=pricebooks`): one row per
// pricebook, each naming its column in `pricebook`, with a `location_type` of
// "fallback", "lead_source" or "manual", a semicolon-separated `searches` list
// (lead_source rows only), and a `status`.
//
// Resolution order:
//   1. A pricebook the rep picked from the dropdown beside "Show Pricebook"
//      (state.pricebookOverride), always wins until the deal changes.
//   2. The selected contact's HubSpot `lead_source`, matched against each
//      active lead_source row's `searches`. Case-insensitive and trimmed, since
//      both sides are typed by people.
//   3. The sheet's own active "fallback" row.
//   4. The hardcoded base column, if the sheet didn't load at all (it's
//      best-effort, see fetchPricebooks).
// "manual" rows are never picked automatically, only from the dropdown.
const BASE_PRICEBOOK = "price_base";
// The base column has shipped under more than one name (the original `price`,
// and `base_price` before it settled on `price_base`); treat them as
// interchangeable so a mid-rollout sheet, or a pre-bump cached payload, still
// prices instead of reading 0.
const BASE_PRICE_KEYS = [BASE_PRICEBOOK, "base_price", "price"];

// Turns a column name into what the rep sees: "price_regional_center" ->
// "Regional Center".
function pricebookDisplayName(book) {
  return String(book || "")
    .replace(/^price_/i, "")
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function emptyPricebooks() {
  return { rows: [], fallback: BASE_PRICEBOOK };
}

function normalizePricebooks(rawPricebooks) {
  const rows = [];
  let fallback = BASE_PRICEBOOK;

  for (const row of extractPricebookSheet(rawPricebooks || [])) {
    const book = String(row.pricebook ?? "").trim();
    if (!book) continue;
    const locationType = String(row.location_type ?? "").trim().toLowerCase();
    const active = String(row.status ?? "").trim().toLowerCase() === "active";
    const searches = String(row.searches ?? "")
      .split(";")
      .map((term) => term.trim().toLowerCase())
      .filter(Boolean);
    rows.push({ book, locationType, active, searches });
    if (locationType === "fallback" && active) fallback = book;
  }

  return { rows, fallback };
}

// True when the products and options sheets actually carry the named column, so
// a pricebook the pricebooks sheet lists before those columns exist (or after
// one is removed) isn't offered or reported as being in use when it can't be.
// Checked against both sheets, and a column has to be on both to count: pricing
// products off one column while every add-on silently fell back to price_base
// would be a quote nobody could explain. A sheet that returned no rows at all
// contributes no columns and is skipped rather than failing every check.
function isPricebookAvailable(book) {
  if (book === BASE_PRICEBOOK) return true;
  const columnSets = [state.priceColumns.products, state.priceColumns.options].filter(
    (columns) => columns.length > 0,
  );
  if (!columnSets.length) return false;
  return columnSets.every((columns) => columns.includes(book));
}

// The pricebooks offered in the dropdown: every active row whose column the
// catalog actually carries, in sheet order. Falls back to just the base column
// when the sheet didn't load, so the dropdown always has the active book in it.
function selectablePricebooks() {
  const books = uniqueInOrder(
    state.pricebooks.rows
      .filter((row) => row.active && isPricebookAvailable(row.book))
      .map((row) => row.book),
  );
  if (!books.includes(state.activePricebook)) books.unshift(state.activePricebook);
  return books;
}

function selectedContactLeadSource() {
  const contact = state.contacts.find((c) => c.hs_contact_id === state.selectedContactId);
  return String(contact?.lead_source ?? "").trim();
}

// Returns `{ book, source, label }`: the summary panel shows *why* a pricebook
// was picked (the matched lead source, "Manual", or "Default"), not just which
// one. resolvePricebook below is the book-only wrapper.
function resolvePricebookMatch() {
  const override = state.pricebookOverride;
  if (override && isPricebookAvailable(override)) {
    return { book: override, source: "manual", label: "Manual" };
  }

  const leadSource = selectedContactLeadSource();
  const leadKey = leadSource.toLowerCase();
  if (leadKey) {
    const row = state.pricebooks.rows.find(
      (r) =>
        r.active &&
        r.locationType === "lead_source" &&
        r.searches.includes(leadKey) &&
        isPricebookAvailable(r.book),
    );
    if (row) return { book: row.book, source: "lead_source", label: leadSource };
  }

  const sheetFallback = state.pricebooks.fallback || BASE_PRICEBOOK;
  const book = isPricebookAvailable(sheetFallback) ? sheetFallback : BASE_PRICEBOOK;
  return { book, source: "fallback", label: LOCATION_FALLBACK_LABEL };
}

function resolvePricebook() {
  return resolvePricebookMatch().book;
}

// Reading the first row's keys is the sheet's own contract for this: any key
// with "price" in its name is a pricebook column, so a new price_N column
// starts working here the moment it's added to the sheet, with no change
// needed on this side. Products and options are read separately (same set
// expected on both, but each is detected from its own first row rather than
// assuming that).
function detectPriceColumns(rows) {
  const first = (rows || [])[0];
  if (!first || typeof first !== "object") return [];
  return Object.keys(first).filter((key) => key.toLowerCase().includes("price"));
}

// Pulls one row's pricebook columns into a { column: number } map, so
// applyActivePricebook() can repoint unit_price at any of them later without
// re-fetching anything. `price_base` is always populated, under that canonical
// name whichever alias the row actually used, since it's the last-resort
// fallback in priceFromBook below.
//
// A blank (or non-numeric) cell is left out of the map entirely rather than
// stored as 0, so a row that just hasn't been filled in for a column the rest
// of the sheet has falls back to its base price instead of quoting $0. A real
// 0 in the sheet is a number and is kept as one.
function extractPrices(row, priceColumns) {
  const prices = {};
  for (const key of priceColumns) {
    const value = row[key];
    if (value === "" || value === null || value === undefined) continue;
    const price = Number(value);
    if (Number.isFinite(price)) prices[key] = price;
  }
  const baseKey = BASE_PRICE_KEYS.find((key) => key in row);
  prices[BASE_PRICEBOOK] = baseKey ? Number(row[baseKey]) || 0 : 0;
  return prices;
}

// Reads a row's max_discount as dollars. Tolerates the column header varying
// in case/spacing ("Max Discount", "max discount") and the cell coming through
// currency-formatted ("$1,200.00"), both of which a plain Number() turns into
// 0, silently dropping that item out of the summed max discount. Blank or
// unparseable still counts as 0, see maxDiscountCodeHtml().
function readMaxDiscount(row) {
  const key = Object.keys(row || {}).find((k) => k.toLowerCase().replace(/[^a-z]/g, "") === "maxdiscount");
  if (!key) return 0;
  const value = row[key];
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

// Falls back to the base column whenever the resolved pricebook names a column
// this row doesn't actually have, e.g. the sheet points a location at price_4
// before that column exists on the products/options sheets.
function priceFromBook(item, book) {
  const prices = item.prices || {};
  return typeof prices[book] === "number" ? prices[book] : prices[BASE_PRICEBOOK] || 0;
}

// Repoints every product's and add-on's unit_price at whichever pricebook
// column resolvePricebookMatch() currently picks (the rep's dropdown choice,
// else the contact's lead source, else the fallback row). Everything
// downstream (cards, summary, margin, the HubSpot push) keeps reading a plain
// unit_price, so this is the only place that knows there's more than one price
// column at all.
//
// Returns true when the active column actually changed, which is the caller's
// cue that the product/add-on cards need re-rendering too, not just the
// summary panel.
function applyActivePricebook() {
  const book = resolvePricebook();
  const changed = book !== state.activePricebook;
  state.activePricebook = book;
  for (const product of state.products) product.unit_price = priceFromBook(product, book);
  for (const addon of state.addons) addon.unit_price = priceFromBook(addon, book);
  return changed;
}

function normalizePricingData(raw) {
  // Each sheet's pricebook columns, detected from its own first row; see
  // detectPriceColumns/extractPrices above.
  const productPriceColumns = detectPriceColumns(raw.products);
  const optionPriceColumns = detectPriceColumns(raw.options);

  const products = (raw.products || []).map((p) => {
    const prices = extractPrices(p, productPriceColumns);
    return {
      sku: p.sku,
      baseSku: p.base_sku,
      name: p.name,
      description: p.manufacturer_description || "",
      // kept for the HubSpot push, which should eventually send the customer-facing copy instead
      customerDescription: p.customer_description || "",
      category: p.category,
      // every pricebook column this row carries, kept so applyActivePricebook()
      // can switch between them as the contact or the dropdown changes
      prices,
      // starts on the base column; applyActivePricebook() repoints it at
      // whichever column resolvePricebookMatch() picks
      unit_price: prices[BASE_PRICEBOOK],
      unit_cost: Number(p.cost) || 0,
      // max discount ($) the rep can give on this product, see maxDiscountCodeHtml()
      maxDiscount: readMaxDiscount(p),
      // the HubSpot product dropdown value for this product, kept for the HubSpot push
      hsProduct: p.hs_product || "",
    };
  });

  const addons = (raw.options || []).map((o) => {
    const prices = extractPrices(o, optionPriceColumns);
    return {
      sku: o.sku,
      name: o.name,
      // not shown in the add-on cards, kept only for the HubSpot push and search
      description: o.manufacturer_description || "",
      customerDescription: o.customer_description || "",
      category: o.category,
      prices,
      unit_price: prices[BASE_PRICEBOOK],
      unit_cost: Number(o.cost) || 0,
      // max discount ($) per unit, multiplied by quantity in the summary
      maxDiscount: readMaxDiscount(o),
      // compatible_base_product_skus lists product base_sku values, not full product skus
      parentBaseSkus: splitSkuList(o.compatible_base_product_skus),
      incompatible_skus: splitSkuList(o.incompatible_option_skus),
      // comma-joined list of configuration choices, same convention as the
      // other multi-value sheet columns above; empty when the add-on has no
      // configuration choice at all
      configurations: splitSkuList(o.configuration),
      maxQuantity: Math.max(1, Math.floor(Number(o.max_quantity)) || 1),
    };
  });

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
    pricebooks: normalizePricebooks(raw.pricebooks),
    // which pricebook columns each sheet actually carries; see
    // isPricebookAvailable
    priceColumns: { products: productPriceColumns, options: optionPriceColumns },
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
  // city -> and zip -> tax rate lookups (see sheet=taxes), plus the sheet's
  // zip_unknown fallback rate; see normalizeTaxRates/getTaxRate.
  taxRates: { byZip: {}, byCity: {}, cityNames: {}, unknownRate: 0 },
  // the pricebooks sheet's rows plus its active fallback column; see
  // normalizePricebooks/resolvePricebookMatch.
  pricebooks: emptyPricebooks(),
  // the pricebook columns the products/options sheets actually carry, detected
  // from each sheet's first row; see detectPriceColumns/isPricebookAvailable
  priceColumns: { products: [], options: [] },
  // the pricebook column every unit_price currently reflects, re-resolved by
  // applyActivePricebook()
  activePricebook: BASE_PRICEBOOK,
  // a pricebook column the rep picked from the dropdown beside "Show Pricebook";
  // null means "pick automatically" (lead source, then fallback). Cleared
  // whenever a different deal (or no deal) is chosen.
  pricebookOverride: null,

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

  // One entry per stairlift on the quote, each with its own product and
  // add-ons (see newLine). The product/add-on panels always edit the line
  // whose id is activeLineId; the summary and the HubSpot push read every
  // line. Filled by resetLines() right after this object.
  lines: [],
  activeLineId: null,
  // the "+" popover in the Quote Summary (clone the active line or add a new one)
  addLineMenuOpen: false,
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

// A quote line is one stairlift: its product plus its own add-on selection.
// addonConfig is sku -> selected configuration string (only relevant for
// add-ons with 2+ configurations); addonQty is sku -> raw typed quantity
// string (only relevant for add-ons with max_quantity > 1), see
// getAddonConfiguration/getAddonQuantity. `id` is an instance id rather than
// the product sku, so the same product can be on a quote twice. Passing
// `from` copies that line's whole selection (the "Clone" choice).
let nextLineId = 1;

function newLine(from) {
  return {
    id: nextLineId++,
    productSku: from ? from.productSku : null,
    addonSkus: new Set(from ? from.addonSkus : []),
    addonConfig: new Map(from ? from.addonConfig : []),
    addonQty: new Map(from ? from.addonQty : []),
  };
}

function resetLines() {
  const line = newLine();
  state.lines = [line];
  state.activeLineId = line.id;
  state.addLineMenuOpen = false;
}

resetLines();

function getActiveLine() {
  return state.lines.find((l) => l.id === state.activeLineId) || state.lines[0];
}

// "Stairlift 1", "Stairlift 2", ... by position, so labels renumber when a
// line is removed.
function lineLabel(line) {
  return `Stairlift ${state.lines.indexOf(line) + 1}`;
}

// The manufacturer part of a sku, everything before the first "--" (e.g.
// "bruno" from "bruno--sre-3050--indoor-straight"). Every product on one
// quote has to share it, so Bruno and Access products never mix.
function brandOf(sku) {
  return String(sku || "").split("--")[0].trim().toLowerCase();
}

function brandDisplayName(brand) {
  return brand.charAt(0).toUpperCase() + brand.slice(1);
}

// The brand the active line is locked to by the other lines' products, or
// null when no other line has a product yet (a single-product quote can
// still switch brands freely).
function lockedBrand() {
  const other = state.lines.find((l) => l !== getActiveLine() && l.productSku);
  return other ? brandOf(other.productSku) : null;
}

function getSelectedProduct(line = getActiveLine()) {
  return state.products.find((p) => p.sku === line.productSku) || null;
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
    if (getActiveLine().addonSkus.has(a.sku) && Array.isArray(a.incompatible_skus)) {
      for (const inc of a.incompatible_skus) set.add(inc);
    }
  }
  return set;
}

function getSelectedAddons(line = getActiveLine()) {
  return state.addons.filter((a) => line.addonSkus.has(a.sku));
}

// Falls back to the first available configuration when none has been
// explicitly chosen yet, so a push to HubSpot always carries a real value
// instead of blank, same fallback pattern used for packages/defaults elsewhere.
function getAddonConfiguration(addon, line = getActiveLine()) {
  if (!addon.configurations.length) return null;
  return line.addonConfig.get(addon.sku) || addon.configurations[0];
}

// The stored value is the raw typed string (see setAddonQuantity), not yet
// clamped to [1, maxQuantity]; this is what pricing/the HubSpot push use.
function getAddonQuantity(addon, line = getActiveLine()) {
  const n = Math.round(Number(line.addonQty.get(addon.sku)));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, addon.maxQuantity || 1);
}

// What the quantity <input> itself displays: the raw typed string, so typing
// isn't fought by a clamped value re-rendering over it mid-keystroke (same
// reasoning as state.discountValue).
function getAddonQuantityInputValue(addon) {
  return getActiveLine().addonQty.get(addon.sku) ?? "1";
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

// keep the active line's add-ons consistent with its product
function syncAddonsToProduct() {
  const line = getActiveLine();
  const selectedProduct = getSelectedProduct(line);
  if (!selectedProduct) {
    if (line.addonSkus.size) line.addonSkus = new Set();
    return;
  }
  const allowed = new Set(getProductScopedAddons(selectedProduct).map((a) => a.sku));
  const next = new Set([...line.addonSkus].filter((sku) => allowed.has(sku)));
  if (next.size !== line.addonSkus.size) line.addonSkus = next;
}

// Every line with a product chosen, in order; empty lines are skipped by the
// totals (they add nothing) but block the push, see summarySectionHtml.
function linesWithProduct() {
  return state.lines.filter((l) => getSelectedProduct(l));
}

// Quote-wide figures summed across every line: subtotal (price), cost, tax
// (each product's cost x rate, plus each add-on's price x rate) and max
// discount (each add-on's per unit, times its quantity).
function quoteFigures(taxRate) {
  let subtotal = 0;
  let cost = 0;
  let tax = 0;
  let maxDiscount = 0;
  for (const line of linesWithProduct()) {
    const product = getSelectedProduct(line);
    subtotal += Number(product.unit_price || 0);
    cost += Number(product.unit_cost || 0);
    tax += Number(product.unit_cost || 0) * taxRate;
    maxDiscount += product.maxDiscount || 0;
    for (const a of getSelectedAddons(line)) {
      const qty = getAddonQuantity(a, line);
      subtotal += Number(a.unit_price || 0) * qty;
      cost += Number(a.unit_cost || 0) * qty;
      tax += Number(a.unit_price || 0) * qty * taxRate;
      maxDiscount += (a.maxDiscount || 0) * qty;
    }
  }
  return { subtotal, cost, tax, maxDiscount };
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
// won't loop, it lands on the plain "Sign in with Google" button — where
// initGoogleAuth()'s silent one-tap prompt (see below) then gets a fresh
// token without the visitor needing to click it, as long as their browser's
// own Google session is still alive. That's also why disableAutoSelect()
// (which tells Google to stop silently offering this account) only runs for
// a genuinely-rejected explicit pick below, not for this replay-expiry path:
// calling it here would block that same silent re-sign-in on every reload.
// An explicit button click that comes back 401 is a fresh account pick, so
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
    state.pricebooks = data.pricebooks;
    state.priceColumns = data.priceColumns;
    // Points every unit_price at the right pricebook column before anything
    // reads one; re-run whenever the contact or the pricebook dropdown changes.
    applyActivePricebook();
    state.authed = true;
    const claims = decodeIdTokenPayload(idToken);
    state.userEmail = claims?.email || null;
    state.userName = claims?.name || null;
    storeGoogleSession(idToken, state.userEmail, state.userName);
    resolveInitialStep();
  } catch (e) {
    if (e.code === "unauthorized") {
      // Don't let a rejected/expired account keep unlocking offline replay.
      clearStoredGoogleSession();
      if (!isStoredSessionReplay) {
        // A freshly chosen account was genuinely rejected (not just an
        // expired stored-session replay, see comment above authenticateWithGoogle);
        // don't leave Google auto-selecting that same account on the next visit.
        window.google?.accounts?.id?.disableAutoSelect();
      }
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
  state.taxRates = { byZip: {}, byCity: {}, cityNames: {}, unknownRate: 0 };
  state.pricebooks = emptyPricebooks();
  state.priceColumns = { products: [], options: [] };
  state.activePricebook = BASE_PRICEBOOK;
  state.pricebookOverride = null;
  state.step = "deal-select";
  state.selectedDeal = null;
  state.dealIdNotFound = null;
  state.contacts = [];
  state.contactsError = null;
  state.selectedContactId = null;
  applyContactToShipTo(null);
  resetLines();
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

// Sets the active line's addonSkus to a package's option_skus (intersected
// with the add-ons actually loaded), shared by applyPackageSelection (deal auto-match)
// and selectProduct (product-sku auto-match) below.
function applyPackageAddons(pkg) {
  if (!pkg) return;
  const allowedOptionSkus = new Set(pkg.optionSkus);
  getActiveLine().addonSkus = new Set(state.addons.filter((a) => allowedOptionSkus.has(a.sku)).map((a) => a.sku));
}

function applyPackageSelection(pkg) {
  if (!pkg) return;
  const product = state.products.find((p) => p.sku === pkg.productSku);
  if (product) {
    getActiveLine().productSku = product.sku;
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
  // The selected contact's lead_source decides which pricebook column prices
  // come from (unless the rep picked one from the dropdown), and every caller
  // sets selectedContactId before calling this; callers all re-render after
  // this, so no render here.
  applyActivePricebook();
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
  state.pricebookOverride = null;
  // A different deal starts over at one stairlift; its package (if any)
  // fills that first line.
  resetLines();
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
  state.pricebookOverride = null;
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
  // Same guard as the disabled product cards (see productSectionHtml): every
  // stairlift on a quote has to be the same brand.
  const brand = lockedBrand();
  if (brand && brandOf(sku) !== brand) return;
  // Only auto-apply a matched package's add-ons when the product actually
  // changes, so re-clicking the already-selected product card doesn't wipe
  // out add-ons the rep has since customized away from the package default.
  const productChanged = getActiveLine().productSku !== sku;
  getActiveLine().productSku = sku;
  if (productChanged) applyPackageAddons(findPackageForProduct(sku));
  syncAddonsToProduct();
  state.addonSearchQuery = "";
  state.pricingDirty = true;
  const product = getSelectedProduct();
  if (product) state.openProductCat = product.category;
  render();
}

function toggleAddon(sku) {
  const next = new Set(getActiveLine().addonSkus);
  if (next.has(sku)) next.delete(sku);
  else next.add(sku);
  getActiveLine().addonSkus = next;
  state.pricingDirty = true;
  render();
}

function clearAddons() {
  getActiveLine().addonSkus = new Set();
  state.pricingDirty = true;
  render();
}

function setAddonConfiguration(sku, value) {
  getActiveLine().addonConfig.set(sku, value);
  state.pricingDirty = true;
  renderPicker();
  renderSummary();
}

function setAddonQuantity(sku, value) {
  // Keep only digits, same "sanitize but don't clamp" approach as
  // setDiscountValue; clamping to [1, maxQuantity] happens at read time
  // (getAddonQuantity), not here, so the field isn't fought while typing.
  getActiveLine().addonQty.set(sku, String(value).replace(/[^\d]/g, ""));
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

// Points the product/add-on panels at another line. Search boxes and open
// categories belong to whatever was being edited before, so they reset, with
// the new line's product category opened so its selection is visible.
function focusLine(id) {
  state.activeLineId = id;
  state.productSearchQuery = "";
  state.addonSearchQuery = "";
  const product = getSelectedProduct();
  state.openProductCat = product ? product.category : null;
  state.openAddonCat = null;
}

function selectLine(id) {
  if (id === state.activeLineId) return;
  focusLine(id);
  render();
}

function toggleAddLineMenu() {
  state.addLineMenuOpen = !state.addLineMenuOpen;
  render();
}

function closeAddLineMenu() {
  state.addLineMenuOpen = false;
  render();
}

// `clone` copies the active line's product and add-on selection (including
// configurations and quantities); otherwise the new line starts empty.
function addLine(clone) {
  const line = newLine(clone ? getActiveLine() : null);
  state.lines.push(line);
  state.addLineMenuOpen = false;
  state.pricingDirty = true;
  focusLine(line.id);
  render();
}

function removeLine(id) {
  if (state.lines.length < 2) return;
  const index = state.lines.findIndex((l) => l.id === id);
  if (index === -1) return;
  const line = state.lines[index];
  if (getSelectedProduct(line) && !window.confirm(`Remove ${lineLabel(line)} from this quote?`)) return;
  state.lines.splice(index, 1);
  state.pricingDirty = true;
  if (state.activeLineId === id) focusLine(state.lines[Math.max(0, index - 1)].id);
  render();
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

// Quote subtotal (every line's product + add-ons, before tax and discount),
// the base the discount is measured against.
function getQuoteSubtotal() {
  return roundToCent(quoteFigures(0).subtotal);
}

// Switching between $ and % converts the value already in the box so the
// discount itself stays the same (e.g. $100 on a $1000 quote becomes 10%).
function setDiscountType(type) {
  if (type === state.discountType) return;
  const subtotal = getQuoteSubtotal();
  if (state.discountValue !== "" && subtotal > 0) {
    const raw = Number(state.discountValue);
    const converted = type === "%" ? (raw / subtotal) * 100 : (raw / 100) * subtotal;
    state.discountValue = String(type === "%" ? roundToCent(converted) : Math.round(converted));
  }
  state.discountType = type;
  state.pricingDirty = true;
  render();
}

function setDiscountValue(value) {
  // Keep digits and a single decimal point; strip anything else the user
  // types or pastes (letters, extra dots, minus signs, etc). $ discounts are
  // whole dollars, so the decimal point and anything after it is dropped;
  // % discounts allow at most 2 decimal places.
  let sanitized = value
    .replace(/[^\d.]/g, "")
    .replace(/(\..*)\./g, "$1");
  sanitized =
    state.discountType === "$"
      ? sanitized.replace(/\..*$/, "")
      : sanitized.replace(/(\.\d{2})\d+/, "$1");
  state.discountValue = sanitized;
  state.pricingDirty = true;
  renderSummary();
}

// Run on blur rather than per keystroke so the rep can type freely: a $
// discount over the quote subtotal snaps back to the subtotal (rounded down
// to whole dollars, so it never exceeds the quote), and a %
// discount over 100 snaps back to 100.
function clampDiscountValue() {
  const raw = Number(state.discountValue || 0);
  const max = state.discountType === "%" ? 100 : Math.floor(getQuoteSubtotal());
  if (raw <= max) return;
  state.discountValue = String(max);
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

// The rep's pick from the Pricebook dropdown beside "Show Pricebook". It sticks
// for the rest of this deal's quote, even across contact switches, since the
// rep chose it on purpose. A column switch changes the product/add-on card
// prices too, not just the summary panel, so this needs a full render().
function setPricebookOverride(book) {
  state.pricebookOverride = book || null;
  state.pricingDirty = true;
  applyActivePricebook();
  render();
}

function isZipValid() {
  return state.shipTo.zip === "" || /^\d{5}$/.test(state.shipTo.zip);
}

// All install-address fields are mandatory, but only on a deal-backed quote —
// that address is what gets written back onto the deal's HubSpot contact. On a
// skip-straight-to-price-lookup quote there's nothing to push, so the City/Zip
// fields shown there (see shipToSectionHtml) exist purely to drive the tax rate
// lookup and are entirely optional; a blank address just falls back to the
// taxes sheet's zip_unknown rate, same as before those fields were shown at
// all. Returns a { field: message } map of just the invalid fields; an empty
// object means the address is complete. Like the zip error, these settle on
// blur via the focusout renderSummary() below, not on every keystroke.
const SHIP_TO_REQUIRED_FIELDS = ["street", "city", "state", "zip"];
function shipToErrors() {
  const errors = {};
  if (state.selectedDeal) {
    for (const key of SHIP_TO_REQUIRED_FIELDS) {
      if (!String(state.shipTo[key]).trim()) errors[key] = "Required.";
    }
  }
  // Only layer the format message on top once something's actually been typed
  // (an empty zip is already covered by "Required." above).
  if (!errors.zip && !isZipValid()) errors.zip = "Zip must be 5 digits.";
  return errors;
}

function isShipToComplete() {
  return Object.keys(shipToErrors()).length === 0;
}

function toggleMargin() {
  state.marginHeld = !state.marginHeld;
  render();
}

function roundToCent(n) {
  return Math.round(n * 100) / 100;
}

async function handlePushToHubspot() {
  // Same gate as the disabled push button: every line needs a product.
  if (!state.lines.every((l) => getSelectedProduct(l))) return;
  // Same gate as the disabled push button: never push a deal-backed quote with
  // an incomplete install address.
  if (state.selectedDeal && !isShipToComplete()) {
    render();
    return;
  }

  const taxRate = getTaxRate(state.shipTo.city, state.shipTo.zip);
  // One entry per stairlift, in line order, each carrying its own options.
  const products = state.lines.map((line) => {
    const selectedProduct = getSelectedProduct(line);
    const productCost = selectedProduct.unit_cost || 0;
    const options = getSelectedAddons(line).map((a) => {
      const quantity = getAddonQuantity(a, line);
      const unitPrice = a.unit_price || 0;
      const totalPrice = unitPrice * quantity;
      const cost = (a.unit_cost || 0) * quantity;
      return {
        name: a.name,
        description: a.customerDescription,
        sku: a.sku,
        quantity,
        configuration: getAddonConfiguration(a, line) || "",
        // update-hs applies quantity itself on the HubSpot side, so this is the
        // per-unit price, not price * quantity (unlike cost/tax_amount below)
        price: unitPrice,
        cost,
        tax_amount: roundToCent(totalPrice * taxRate),
        // per-unit max discount * quantity, same as cost/tax_amount
        max_discount: (a.maxDiscount || 0) * quantity,
      };
    });
    return {
      name: selectedProduct.name,
      description: selectedProduct.customerDescription,
      sku: selectedProduct.sku,
      hs_product: selectedProduct.hsProduct,
      price: selectedProduct.unit_price,
      cost: productCost,
      tax_amount: roundToCent(productCost * taxRate),
      max_discount: selectedProduct.maxDiscount || 0,
      options,
    };
  });

  // Quote-wide totals: each product plus its options' (already quantity-
  // multiplied) figures, summed across every line.
  const sumLines = (fn) => products.reduce((s, p) => s + fn(p) + p.options.reduce((t, o) => t + fn(o, true), 0), 0);
  const subtotal = sumLines((item, isOption) => (isOption ? item.price * item.quantity : item.price));
  const cost = sumLines((item) => item.cost);
  const taxAmount = roundToCent(sumLines((item) => item.tax_amount));
  const rawDiscount = Number(state.discountValue || 0);
  const discountAmount =
    state.discountType === "$"
      ? Math.min(rawDiscount, subtotal)
      : subtotal * (Math.min(rawDiscount, 100) / 100);
  const discountPercentage = subtotal > 0 ? (discountAmount / subtotal) * 100 : 0;
  const totalBeforeTax = subtotal - discountAmount;
  const total = totalBeforeTax + taxAmount;
  const margin = totalBeforeTax !== 0 ? ((subtotal - cost - discountAmount) / totalBeforeTax) * 100 : 0;
  // same sum the summary's MD<sum> code shows
  const maxDiscount = sumLines((item) => item.max_discount);

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
        products,
        subtotal,
        cost,
        margin,
        discount_amount: discountAmount,
        discount_percentage: discountPercentage,
        max_discount: maxDiscount,
        // the pricebook column every price in this body was read from, e.g. "price_kaiser"
        pricebook: state.activePricebook,
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
  const names = linesWithProduct().map((l) => getSelectedProduct(l).name);
  return `Quote for ${names.join(", ")}`;
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

// `disabledReason`, when set, greys the section out, keeps it closed, and shows
// the reason as a hover tooltip. It's aria-disabled rather than disabled, since
// a truly disabled button doesn't show its title tooltip in every browser; the
// click handler checks aria-disabled instead.
function accordionSectionHtml({ title, count, isOpen, toggleAction, cat, bodyHtml, disabledReason }) {
  const open = isOpen && !disabledReason;
  return `
    <div>
      <button type="button" data-action="${toggleAction}" data-cat="${escapeHtml(cat)}"
        ${disabledReason ? `aria-disabled="true" title="${escapeHtml(disabledReason)}"` : ""}
        class="${classNames("accordion-toggle", disabledReason && "accordion-toggle--disabled")}">
        <span class="accordion-toggle__title">${escapeHtml(title)}</span>
        <div class="accordion-toggle__meta">
          <span class="badge">${count}</span>
          <svg class="${classNames("accordion-toggle__chevron", open ? "accordion-toggle__chevron--open" : "")}" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.94a.75.75 0 111.08 1.04l-4.24 4.5a.75.75 0 01-1.08 0l-4.24-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
          </svg>
        </div>
      </button>
      ${open ? `<div class="accordion-body">${bodyHtml}</div>` : ""}
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
  const brand = lockedBrand();
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
          // A group with nothing of the quote's brand in it is greyed out
          // whole; mixed groups grey out just the other-brand cards below.
          const groupLocked = Boolean(brand) && items.every((p) => brandOf(p.sku) !== brand);
          const body = items
            .map((p) =>
              optionCardHtml({
                sku: p.sku,
                title: p.name,
                description: p.description,
                price: p.unit_price,
                selected: getActiveLine().productSku === p.sku,
                // every stairlift on a quote has to be the same brand
                disabled: Boolean(brand) && brandOf(p.sku) !== brand,
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
            disabledReason: groupLocked
              ? `Products from different manufacturers can't be on the same quote. This quote is ${brandDisplayName(brand)} only.`
              : null,
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
        <p class="section-subtitle">${
          state.lines.length > 1 ? `Choose the product for ${escapeHtml(lineLabel(getActiveLine()))}.` : "Select one product to begin."
        } Prices shown include install & shipping but exclude tax.</p>
        ${
          brand
            ? `<p class="section-subtitle">Other stairlifts on this quote lock it to ${escapeHtml(brandDisplayName(brand))} products.</p>`
            : ""
        }
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
            const isChecked = getActiveLine().addonSkus.has(a.sku);
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

// Contact picker + editable ship-to address. Editing the address fields
// doesn't call HubSpot itself, they're only sent along with the rest of the
// quote on "Push to HubSpot" (see handlePushToHubspot), which is what actually
// writes them back onto the selected contact.
//
// Without a selected deal there's no contact to pick from (contacts are fetched
// per-deal, see loadContactsForDeal) and nothing to push, so this collapses to
// just the two fields the tax rate lookup actually reads — City and Zip, both
// optional, see shipToErrors — rather than hiding the whole block. A price
// lookup still needs a real tax rate, and before this those quotes were stuck
// on the taxes sheet's zip_unknown fallback with no way to say where the
// install actually is.
function shipToSectionHtml() {
  if (!state.selectedDeal) return taxLocationFieldsHtml();

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

  const errors = shipToErrors();
  const errorHtml = (key) => (errors[key] ? `<p class="ship-to__error">${errors[key]}</p>` : "");

  return `
    <div class="ship-to">
      <h3 class="subsection-title">Install Address</h3>
      ${statusHtml}
      ${contactPickerHtml}
      ${hubspotNoteHtml}
      ${shipToFieldHtml("street", "Street *", "", errorHtml("street"))}
      ${shipToFieldHtml("city", "City *", "", errorHtml("city"))}
      ${shipToFieldHtml("state", "State *", "", errorHtml("state"))}
      ${shipToFieldHtml("zip", "Zip *", `maxlength="5" inputmode="numeric"`, errorHtml("zip"))}
    </div>
  `;
}

function shipToFieldHtml(key, label, extraAttrs = "", errorHtml = "") {
  return `
    <div>
      <div class="ship-to__field">
        <label class="ship-to__field-label" for="ship-to-${key}">${label}</label>
        <input type="text" id="ship-to-${key}" data-action="set-ship-to-field" data-field="${key}"
          class="input ship-to__field-input" value="${escapeHtml(state.shipTo[key])}" ${FIELD_NO_AUTOFILL_ATTRS} ${extraAttrs} />
      </div>
      ${errorHtml}
    </div>
  `;
}

// The no-deal variant of the block above: City + Zip only, no asterisks (they
// aren't required here) and no contact picker or HubSpot note (there's no
// contact and nothing gets pushed). Same state.shipTo fields and same
// set-ship-to-field action underneath, so the tax rate lookup doesn't need to
// care which variant produced them.
function taxLocationFieldsHtml() {
  const errors = shipToErrors();
  return `
    <div class="ship-to">
      <h3 class="subsection-title">Install Address</h3>
      <p class="muted-text">Used for the sales tax rate only, not saved anywhere.</p>
      ${shipToFieldHtml("city", "City")}
      ${shipToFieldHtml(
        "zip",
        "Zip",
        `maxlength="5" inputmode="numeric"`,
        errors.zip ? `<p class="ship-to__error">${errors.zip}</p>` : "",
      )}
    </div>
  `;
}

// Comment + expiration date + (with "Show Pricebook" on) the Pricebook dropdown,
// plus the ship-to block. Expiration date and comment only render with a
// selected deal, since there's no quote to attach them to on a
// skip-straight-to-price-lookup quote; the Pricebook dropdown renders either
// way, so the Quote Details column shows whenever there's a deal or margin is
// on. The ship-to column always renders, in its City/Zip-only form without a
// deal, since the tax rate lookup needs those either way (see
// shipToSectionHtml/taxLocationFieldsHtml).
function quoteDetailsHtml() {
  const dealFieldsHtml = state.selectedDeal
    ? `
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
          </div>`
    : "";
  const pricebookHtml = state.marginHeld ? pricebookSelectHtml() : "";
  const quoteFieldsHtml =
    dealFieldsHtml || pricebookHtml
      ? `
        <div class="quote-details__col">
          <h3 class="subsection-title">Quote Details</h3>
          ${dealFieldsHtml}
          ${pricebookHtml}
        </div>`
      : "";

  return `
    <div class="quote-details">
      <div class="quote-details__columns">
        ${quoteFieldsHtml}
        <div class="quote-details__col">
          ${shipToSectionHtml()}
        </div>
      </div>
    </div>
  `;
}

// One tab per stairlift ("Stairlift 1", "Stairlift 2", ...), on the left of
// the Subtotal row: clicking one points the product/add-on panels at it, the x
// removes it (only once there's more than one), and + toggles the clone/new popover right
// beside it (addLineMenuHtml). + stays disabled while any line still has no
// product, so empty lines can't pile up.
function lineTabsHtml() {
  const emptyLine = state.lines.find((l) => !getSelectedProduct(l));
  const canRemove = state.lines.length > 1;
  const tabsHtml = state.lines
    .map((line) => {
      const isActive = line.id === state.activeLineId;
      return `
      <div class="${classNames("line-tab", isActive && "line-tab--active")}">
        <button type="button" data-action="select-line" data-line-id="${line.id}" class="line-tab__select"
          ${isActive ? `aria-current="true"` : ""}>${escapeHtml(lineLabel(line))}</button>
        ${
          canRemove
            ? `<button type="button" data-action="remove-line" data-line-id="${line.id}" class="line-tab__remove"
                aria-label="Remove ${escapeHtml(lineLabel(line))}">&times;</button>`
            : ""
        }
      </div>`;
    })
    .join("");
  return `
    <div class="line-tabs">
      ${tabsHtml}
      <div class="line-tabs__add">
        <button type="button" data-action="toggle-add-line" class="line-tab line-tab--add"
          ${emptyLine ? `disabled title="Choose a product for ${escapeHtml(lineLabel(emptyLine))} first"` : `title="Add another stairlift"`}
          aria-label="Add another stairlift" aria-expanded="${state.addLineMenuOpen}">+</button>
        ${addLineMenuHtml()}
      </div>
    </div>
  `;
}

// The popover + opens, anchored right beside it: copy the stairlift being
// edited, or start a blank one. Closed by clicking anywhere outside it or by
// Escape (see the document listeners below).
function addLineMenuHtml() {
  if (!state.addLineMenuOpen) return "";
  return `
    <div class="add-line-menu" role="menu">
      <button type="button" role="menuitem" data-action="add-line" data-clone="true" class="add-line-menu__item">
        Clone ${escapeHtml(lineLabel(getActiveLine()))}
      </button>
      <button type="button" role="menuitem" data-action="add-line" class="add-line-menu__item">Add a new one</button>
    </div>
  `;
}

// One line's product row plus its add-on rows, the shape rowsHtml renders.
function lineItemsFor(line) {
  const product = getSelectedProduct(line);
  if (!product) return [];
  return [
    {
      name: product.name,
      description: product.description,
      price: product.unit_price,
      cost: product.unit_cost,
      sku: product.sku,
    },
    ...getSelectedAddons(line).map((a) => {
      const qty = getAddonQuantity(a, line);
      const config = getAddonConfiguration(a, line);
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
}

function summarySectionHtml() {
  const multiLine = state.lines.length > 1;
  const groups = state.lines.map((line) => ({ line, items: lineItemsFor(line) }));
  const hasAnyProduct = groups.some((g) => g.items.length > 0);
  const emptyLine = state.lines.find((l) => !getSelectedProduct(l));

  // Shows which city/zip the tax rate matched next to the rate itself (see the
  // summary__margin-group markup below).
  const taxMatch = resolveTaxRate(state.shipTo.city, state.shipTo.zip);
  const taxRate = taxMatch.rate;
  const { subtotal, cost, tax, maxDiscount } = quoteFigures(taxRate);
  const rawDiscount = Number(state.discountValue || 0);
  const discountAmount =
    state.discountType === "$"
      ? Math.min(rawDiscount, subtotal)
      : subtotal * (Math.min(rawDiscount, 100) / 100);
  const totalBeforeTax = subtotal - discountAmount;
  const total = totalBeforeTax + tax;
  const marginPct = totalBeforeTax !== 0 ? ((subtotal - cost - discountAmount) / totalBeforeTax) * 100 : 0;

  const marginHeld = state.marginHeld;
  const showCostColumn = marginHeld && SHOW_COST_COLUMN;

  // `badgeHtml` (the stairlift number, multi-stairlift quotes only) goes in
  // front of the product's name, on the same line.
  const itemRowHtml = (item, badgeHtml = "") => `
          <div class="${classNames("line-item", item.addon && "line-item--addon")}">
            <div class="line-item__body">
              <div class="line-item__name">${badgeHtml}${escapeHtml(item.name)}${item.qty > 1 ? ` <span class="line-item__qty">× ${item.qty}</span>` : ""}</div>
              ${item.description ? `<div class="line-item__desc">${escapeHtml(item.description)}</div>` : ""}
            </div>
            ${showCostColumn ? `<div class="line-item__cost">${item.cost > 0 ? currencyWhole.format(item.cost) : "—"}</div>` : ""}
            <div class="line-item__price-wrap">
              <div class="line-item__price">${currencyWhole.format(Number(item.price || 0))}</div>
            </div>
          </div>
        `;

  // With one stairlift the rows read exactly as they always have; with more,
  // each line's rows sit in their own card, the one being edited highlighted.
  // Each card is identified by a small numbered badge in front of its product
  // name (matching the "Stairlift N" tabs) rather than a title row of its own.
  // Clicking anywhere on a card switches the product/add-on panels to it; the
  // badge is a real button so that's reachable from the keyboard too.
  const bodyHtml = multiLine
    ? groups
        .map(({ line, items }) => {
          const badgeHtml = `<button type="button" data-action="select-line" data-line-id="${line.id}"
            class="line-group__badge" aria-label="${escapeHtml(lineLabel(line))}"
            title="${escapeHtml(lineLabel(line))}">${state.lines.indexOf(line) + 1}</button>`;
          return `
        <div class="${classNames("line-group", line.id === state.activeLineId && "line-group--active")}"
          data-action="select-line" data-line-id="${line.id}">
          ${
            items.length
              ? items.map((item, i) => itemRowHtml(item, i === 0 ? badgeHtml : "")).join("")
              : `<div class="line-item__name">${badgeHtml}<span class="muted-text">No product selected yet.</span></div>`
          }
        </div>`;
        })
        .join("")
    : groups[0].items.map((item) => itemRowHtml(item)).join("");

  const rowsHtml =
    !hasAnyProduct && !multiLine
      ? `<p class="muted-text">No items selected yet.</p>`
      : `
    <div class="line-items">
      <div class="line-items__head">
        <div class="line-items__col">Item</div>
        ${showCostColumn ? `<div class="line-items__col--amount">Cost</div>` : ""}
        <div class="line-items__col--amount">Price</div>
      </div>
      <div class="line-items__body">
        ${bodyHtml}
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
  // The install address is mandatory, but it only exists on a deal-backed
  // quote, so this gate only applies once a deal is selected.
  const shipToIncomplete = Boolean(state.selectedDeal) && !isShipToComplete();
  // Same test that turns the RD code red (see maxDiscountCodeHtml): the
  // discount is more than the selection's summed max_discount allows.
  const overMaxDiscount = discountAmount > 0 && Math.round(maxDiscount - discountAmount) < 0;
  const pushHubspotDisabled =
    !state.isOnline ||
    !state.selectedDeal ||
    Boolean(emptyLine) ||
    shipToIncomplete ||
    overMaxDiscount ||
    state.quoteLoading ||
    alreadyPushed;
  const pushHubspotTitle = !state.isOnline
    ? "No internet connection"
    : !state.selectedDeal
      ? "Select a deal first"
      : emptyLine
        ? `Choose a product for ${lineLabel(emptyLine)}${multiLine ? " or remove it" : ""} first`
        : shipToIncomplete
          ? "Complete the install address first"
          : overMaxDiscount
            ? "Discount is over the allowed maximum"
            : alreadyPushed
              ? "Already pushed — change the price to push again"
              : "";

  // When the over-max discount is the reason push is blocked, the button is
  // aria-disabled instead of disabled: it still looks disabled, but a click
  // reaches the handler, which flashes the red RD code to show why
  // (flashMaxDiscountCode). A truly disabled button swallows the click.
  const blockedByDiscount = pushHubspotTitle === "Discount is over the allowed maximum";
  const pushButtonHtml = `
    <button type="button" data-action="push-hubspot"
      ${blockedByDiscount ? `aria-disabled="true"` : pushHubspotDisabled ? "disabled" : ""}
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
                ${
                  SHOW_MARGIN_PCT
                    ? `<span class="summary__margin">Margin: ${marginPct.toFixed(1)}%</span>
                       <span class="summary__margin-divider">|</span>`
                    : ""
                }
                <span class="summary__margin">Pricebook: ${escapeHtml(pricebookDisplayName(state.activePricebook))}</span>
                <span class="summary__margin-divider">|</span>
                <span class="summary__margin">Tax Rate: ${escapeHtml(taxMatch.label)} → ${(taxRate * 100).toFixed(2)}%</span>
              </div>`
            : ""
        }
      </div>
      <p class="confidential-notice">Confidential. Pricing shown below is for internal/authorized use only, not for external distribution.</p>

      ${rowsHtml}

      <div class="totals">
        ${lineTabsHtml()}
        <table class="totals-table">
          <tbody>
            <tr>
              <th scope="row">Subtotal</th>
              ${showCostColumn ? `<td class="totals-table__cost">${currency.format(cost)}</td>` : ""}
              <td>${currency.format(subtotal)}</td>
            </tr>
            <tr>
              <th scope="row">
                Discount${
                  state.discountType === "%" && discountAmount > 0
                    ? ` <span class="totals-table__discount-amount">(-${currency.format(discountAmount)})</span>`
                    : ""
                }
              </th>
              ${showCostColumn ? `<td class="totals-table__cost"></td>` : ""}
              <td>
                <div class="totals-table__discount-field">
                  <div class="segmented segmented--compact">
                    <button type="button" data-action="set-discount-type" data-type="$" class="${classNames(
                      "segmented__btn",
                      state.discountType === "$" ? "segmented__btn--active" : "",
                    )}">$</button>
                    <button type="button" data-action="set-discount-type" data-type="%" class="${classNames(
                      "segmented__btn",
                      state.discountType === "%" ? "segmented__btn--active" : "",
                    )}">%</button>
                  </div>
                  <input type="text" inputmode="${state.discountType === "$" ? "numeric" : "decimal"}" id="discount-value-input"
                    data-action="set-discount-value" value="${escapeHtml(state.discountValue)}"
                    class="${classNames("totals-table__input", discountAmount > 0 && "totals-table__input--applied")}"
                    aria-label="Discount ${state.discountType === "$" ? "in dollars" : "in percent"}"
                    ${FIELD_NO_AUTOFILL_ATTRS} placeholder="0" />
                </div>
              </td>
            </tr>
            <tr>
              <th scope="row">Sales Tax</th>
              ${showCostColumn ? `<td class="totals-table__cost"></td>` : ""}
              <td>${currency.format(tax)}</td>
            </tr>
            <tr class="totals-table__total">
              <th scope="row">Total</th>
              ${showCostColumn ? `<td class="totals-table__cost"></td>` : ""}
              <td>${currency.format(total)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      ${maxDiscountCodeHtml(discountAmount, maxDiscount)}

      ${quoteDetailsHtml()}

      <div class="summary__actions">
        <div class="summary__actions-top">
          <div class="summary__actions-row">
            ${pushButtonHtml}
          </div>
          <button type="button" data-action="toggle-margin" class="btn btn--muted btn--margin-toggle">
            ${marginHeld ? "Hide Pricebook" : "Show Pricebook"}
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

// Always shown under the totals, from the summed max_discount of every line's
// product and add-ons (each add-on's times its quantity). With no discount
// applied it's "MD<max>"; once one is, it's "RD<max - discount>", the discount
// the rep has left, turning red when that goes negative. Deliberately cryptic:
// it should read as a stray code to a customer looking over the rep's
// shoulder, but tells the rep how much room they have.
function maxDiscountCodeHtml(discountAmount, maxDiscount) {
  if (discountAmount <= 0) {
    return `<div class="totals__code">MD${Math.round(maxDiscount)}</div>`;
  }
  const remaining = Math.round(maxDiscount - discountAmount);
  const overClass = remaining < 0 ? " totals__code--over" : "";
  return `<div class="totals__code${overClass}">RD${remaining}</div>`;
}

// Pulses the MD/RD code under the totals, used when a push is blocked by an
// over-max discount. Done straight on the DOM (no re-render); removing the
// class and forcing a reflow first lets repeated clicks restart the animation.
function flashMaxDiscountCode() {
  const el = document.querySelector(".totals__code");
  if (!el) return;
  el.classList.remove("totals__code--flash");
  void el.offsetWidth;
  el.classList.add("totals__code--flash");
}

// The Pricebook dropdown in the Quote Details column, below Comment, shown only
// while "Show Pricebook" is on: every active pricebook the catalog carries, with
// whichever one is currently pricing the quote selected (whether the rep
// picked it or it was resolved automatically).
function pricebookSelectHtml() {
  const options = selectablePricebooks()
    .map(
      (book) =>
        `<option value="${escapeHtml(book)}" ${book === state.activePricebook ? "selected" : ""}>${escapeHtml(
          pricebookDisplayName(book),
        )}</option>`,
    )
    .join("");
  return `
    <div>
      <label class="field-label" for="pricebook-select">Pricebook</label>
      <select id="pricebook-select" data-action="set-pricebook" class="input input--block" ${FIELD_NO_AUTOFILL_ATTRS}>
        ${options}
      </select>
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
  state.quoteLink = null;
  state.dealLink = null;
  state.quoteEmailChips = [];
  state.quoteEmailDraft = "";
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
// Same idea for the add-stairlift popover: any click outside the + button and
// its popover closes it (clicks on the + itself toggle it via the action
// switch, and its menu items close it themselves via addLine()).
document.addEventListener("click", (e) => {
  if (!state.addLineMenuOpen) return;
  if (e.target.closest(".line-tabs__add")) return;
  closeAddLineMenu();
});

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
      if (el.getAttribute("aria-disabled") !== "true") toggleProductCat(el.dataset.cat);
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
    case "select-line":
      selectLine(Number(el.dataset.lineId));
      break;
    case "remove-line":
      removeLine(Number(el.dataset.lineId));
      break;
    case "toggle-add-line":
      if (!el.hasAttribute("disabled")) toggleAddLineMenu();
      break;
    case "add-line":
      addLine(el.dataset.clone === "true");
      break;
    case "set-discount-type":
      setDiscountType(el.dataset.type);
      break;
    case "toggle-margin":
      toggleMargin();
      break;
    case "push-hubspot":
      if (el.getAttribute("aria-disabled") === "true") flashMaxDiscountCode();
      else handlePushToHubspot();
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
  if (e.target.dataset.action === "set-pricebook") {
    setPricebookOverride(e.target.value);
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

// Each keystroke's renderSummary() recreates the discount input, which fires
// a focusout on the old node even though the rep is still typing (same issue
// as the quote email draft above), so only clamp once focus has really left.
document.addEventListener("focusout", (e) => {
  if (e.target.dataset.action !== "set-discount-value") return;
  setTimeout(() => {
    if (document.activeElement?.id !== "discount-value-input") clampDiscountValue();
  }, 0);
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.quoteEmailModalOpen) {
    closeSendQuoteModal();
  }
  if (e.key === "Escape" && state.addLineMenuOpen) {
    closeAddLineMenu();
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
      // authenticateWithGoogle): clear the stored token and reload straight
      // into a clean sign-in screen rather than leaving a scary error
      // sitting over whatever was on screen. This can interrupt an
      // in-progress quote, but continuing to let a revoked account keep
      // using pricing data isn't the safer failure mode here. Deliberately
      // NOT disableAutoSelect() here, same reasoning as authenticateWithGoogle:
      // this is almost always just the token's normal ~1hr expiry, not a
      // genuinely revoked account, and disabling auto-select would block the
      // silent one-tap re-sign-in that's about to run on the reload.
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
// script tag below, which is what actually invokes this. Always sets Google
// up to handle an explicit button click; when `attemptSilentSignIn` is true
// (there was no stored session to replay, see bootGoogleAuth below) it also
// fires a one-tap silent sign-in attempt off Google's own browser session,
// so a returning visitor whose stored token has expired gets a fresh one
// without clicking anything, as long as they're still signed into Google in
// this browser. `auto_select: true` is what makes that silent when exactly
// one Google session is available; without it, one-tap still shows a small
// (still clickless-if-ignored, but visible) account chooser instead of
// firing the callback outright.
function initGoogleAuth(attemptSilentSignIn) {
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
    auto_select: true,
  });
  if (attemptSilentSignIn) {
    google.accounts.id.prompt();
  }
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

  // Only attempt the silent one-tap sign-in when there's no stored token to
  // replay instead; if the replay above succeeds, one-tap would just be a
  // redundant round-trip, and if it's still in flight, a second concurrent
  // sign-in call would be wasted work at best.
  const attemptSilentSignIn = !storedGoogleSession;

  // Google Identity Services is still initialized in parallel (not only when
  // there's no stored session) so the explicit "Sign in with Google" button
  // is ready to use immediately if the stored-token replay above fails.
  if (window.google?.accounts?.id) {
    // Already loaded and executed by the time this line runs (e.g. cached,
    // or this synchronous script happened to run after the async one).
    initGoogleAuth(attemptSilentSignIn);
  } else {
    // Deliberately NOT window's `load` event here — that waits for every
    // resource on the page, including the header/favicon images pulled from
    // HubSpot's CDN, which was adding multiple seconds before the sign-in
    // button ever had a chance to appear. Waiting on this one script tag's
    // own load/error event gets the button up as soon as Google's script
    // itself is actually ready, nothing else on the page should hold it back.
    const script = document.getElementById("google-identity-script");
    if (script) {
      script.addEventListener("load", () => initGoogleAuth(attemptSilentSignIn), { once: true });
      script.addEventListener("error", () => initGoogleAuth(attemptSilentSignIn), { once: true });
    } else {
      // Shouldn't happen (the tag lives in index.html), but don't hang forever.
      window.addEventListener("load", () => initGoogleAuth(attemptSilentSignIn));
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
