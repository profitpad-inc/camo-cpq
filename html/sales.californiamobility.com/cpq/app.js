// Vanilla JS port of an earlier React version of this app.
// Single mutable `state` object + one full re-render per state change,
// with focus/selection preserved across re-renders (see restoreFocus below).

function classNames(...arr) {
  return arr.filter(Boolean).join(" ");
}

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

// The pricing endpoint backs onto a Google Sheet and can't fetch all three
// sheets in one request without serializing them server-side, so each sheet
// is fetched with its own &sheet= call, in parallel, and merged here.
const PRICING_SHEETS = ["products", "options", "packages"];

async function fetchPricingData(idToken) {
  const responses = await Promise.all(
    PRICING_SHEETS.map((sheet) =>
      fetch(`${PRICING_URL}?sheet=${sheet}`, {
        headers: { Authorization: `Bearer ${idToken}` },
      }),
    ),
  );

  if (responses.some((res) => res.status === 401 || res.status === 403)) {
    const err = new Error("Your Google account isn't authorized to view pricing.");
    err.code = "unauthorized";
    throw err;
  }
  if (responses.some((res) => !res.ok)) {
    const err = new Error("Could not reach the pricing service. Please try again.");
    err.code = "unavailable";
    throw err;
  }

  const [products, options, packages] = await Promise.all(responses.map((res) => res.json()));
  return {
    products: products.products || [],
    options: options.options || [],
    packages: packages.packages || [],
  };
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
  // set once authed, from the Google ID token's own claims; display only.
  userEmail: null,
  userName: null,
  userMenuOpen: false,

  products: [],
  addons: [],
  productCategories: [],
  addonCategories: [],
  packages: [],

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

  productSku: null,
  addonSkus: new Set(),
  openProductCat: null,
  openAddonCat: null,
  productSearchQuery: "",
  addonSearchQuery: "",
  discountType: "$",
  discountValue: "",
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
async function authenticateWithGoogle(idToken) {
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
  state.step = "deal-select";
  state.selectedDeal = null;
  state.dealIdNotFound = null;
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

function applyPackageSelection(pkg) {
  if (!pkg) return;
  const product = state.products.find((p) => p.sku === pkg.productSku);
  if (product) {
    state.productSku = product.sku;
    state.openProductCat = product.category;
  }
  const allowedOptionSkus = new Set(pkg.optionSkus);
  state.addonSkus = new Set(state.addons.filter((a) => allowedOptionSkus.has(a.sku)).map((a) => a.sku));
  syncAddonsToProduct();
}

function chooseDeal(deal) {
  state.selectedDeal = deal;
  const pkg = findPackageForDeal(deal);
  applyPackageSelection(pkg);
  state.dealMatchFailed = !pkg;
  state.step = "cpq";
  setDealIdInUrl(deal.hs_object_id);
  render();
}

function skipToPriceLookup() {
  state.selectedDeal = null;
  state.dealMatchFailed = false;
  state.step = "cpq";
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
  dealSearchDebounceHandle = setTimeout(() => runDealSearch(trimmed), 300);
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
  state.productSku = sku;
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

function toggleProductCat(cat) {
  state.openProductCat = state.openProductCat === cat ? null : cat;
  render();
}

function toggleAddonCat(cat) {
  state.openAddonCat = state.openAddonCat === cat ? null : cat;
  render();
}

function setProductSearchQuery(value) {
  state.productSearchQuery = value;
  render();
}

function setAddonSearchQuery(value) {
  state.addonSearchQuery = value;
  render();
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
  render();
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

  const productCost = selectedProduct.unit_cost || 0;
  const product = {
    name: selectedProduct.name,
    description: selectedProduct.customerDescription,
    sku: selectedProduct.sku,
    hs_product: selectedProduct.hsProduct,
    price: selectedProduct.unit_price,
    cost: productCost,
    tax_amount: roundToCent(productCost * 0.1),
  };

  const options = selectedAddons.map((a) => {
    const cost = a.unit_cost || 0;
    return {
      name: a.name,
      description: a.customerDescription,
      sku: a.sku,
      price: a.unit_price,
      cost,
      // combined-cost 10% (like the product) plus the extra 10%-of-price quirk on add-ons
      tax_amount: roundToCent(cost * 0.1 + a.unit_price * 0.1),
    };
  });

  const subtotal = product.price + options.reduce((s, o) => s + o.price, 0);
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
        product,
        options,
        subtotal,
        cost,
        margin,
        discount_amount: discountAmount,
        discount_percentage: discountPercentage,
        tax_amount: taxAmount,
        tax_percentage: 5,
        tax_location: "12345",
        currency: "USD",
        total,
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
        ${state.authError ? `<p class="form-error">${escapeHtml(state.authError)}</p>` : ""}
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
          <input type="text" id="deal-search-input" data-action="set-deal-search" autocomplete="off"
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

function checkboxCardHtml({ sku, title, description, price, checked, disabled }) {
  const check = `
    <svg class="option-card__check-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3">
      <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
    </svg>`;
  return `
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
    <input type="search" id="${id}" data-action="${action}" autocomplete="off"
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
            return checkboxCardHtml({
              sku: a.sku,
              title: a.name,
              price: a.unit_price,
              checked: isChecked,
              disabled: isDisabled,
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
    ...selectedAddons.map((a) => ({
      name: a.name,
      price: a.unit_price,
      cost: a.unit_cost,
      sku: a.sku,
      addon: true,
    })),
  ];

  const subtotal = lineItems.reduce((s, item) => s + Number(item.price || 0), 0);
  const cost = lineItems.reduce((s, item) => s + Number(item.cost || 0), 0);
  const tax = cost * 0.1 + selectedAddons.reduce((s, a) => s + Number(a.unit_price || 0) * 0.1, 0);
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
              <div class="line-item__name">${escapeHtml(item.name)}</div>
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
        ${marginHeld ? `<span class="summary__margin">Margin: ${marginPct.toFixed(1)}%</span>` : ""}
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
              class="input input--discount"
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

      <div class="summary__actions">
        <div class="summary__actions-top">
          <div class="summary__actions-row">
            ${pushButtonHtml}
          </div>
          <button type="button" data-action="toggle-margin" class="btn btn--muted btn--margin-toggle">
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
        class="chip-input__field" autocomplete="off"
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
          class="input input--block" value="${escapeHtml(state.quoteEmailSubject)}"
          ${state.quoteEmailSending ? "disabled" : ""} />
      </div>
      <div>
        <label class="field-label" for="quote-email-note">Note</label>
        <textarea id="quote-email-note" data-action="set-quote-email-note"
          class="input input--block textarea" rows="3"
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
    <div class="layout-grid">
      ${productSectionHtml()}
      ${addonSectionHtml()}
    </div>
    ${summarySectionHtml()}
  `;
}

// --- render loop with focus preservation ---
const root = document.getElementById("app");
const headerUserMenuEl = document.getElementById("header-user-menu");

// Kept separate from render()'s #app replacement so opening/closing the
// menu (or a state change elsewhere) doesn't need to re-render the whole
// app just to keep the header in sync.
function renderHeaderUserMenu() {
  headerUserMenuEl.innerHTML = headerUserMenuHtml();
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

function render() {
  const saved = captureFocus();
  const savedScroll = capturePanelScroll();
  root.innerHTML = appHtml();
  restoreFocus(saved);
  restorePanelScroll(savedScroll);
  renderQuoteEmailModal();
  renderGoogleButton();
  renderHeaderUserMenu();
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
  authenticateWithGoogle(storedGoogleSession.idToken);
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

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./service-worker.js")
      .catch((err) => console.error("SW registration failed:", err));
  });
}
