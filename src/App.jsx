import React, { useEffect, useMemo, useState } from "react";
import Papa from 'papaparse'

function classNames(...arr) {
  return arr.filter(Boolean).join(" ");
}
const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

// --- constants ---
const sheetId = "14zzAWJNgDxZgXAm713sq3K8fhWDNJPZ49SGYssBQH00";
const sheetGids = {
  categories: 512714440,
  products: 1610198502,
  addons: 1688740072,
};

// --- helpers ---
function priceStringToFloat(s) {
  if (!s) return 0;
  return parseFloat(s.replace(/[^\d.]/g, "")) || 0;
}

async function getSheet(sheetId, gid) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&gid=${gid}`;
  const res = await fetch(url);
  if (!res.ok) return { cols: {}, rows: [] };

  const text = await res.text();
  const { data } = Papa.parse(text, {
    header: true,
    skipEmptyLines: true,
  });

  const rows = data.map((row) => {
    // normalize empty strings
    const cleanRow = {};
    Object.entries(row).forEach(([k, v]) => {
      cleanRow[k.trim()] = v?.trim() || "";
    });
    return cleanRow;
  });

  const cols = {};
  rows.forEach((row) => {
    Object.entries(row).forEach(([k, v]) => {
      if (!v) return;
      if (!cols[k]) cols[k] = [];
      cols[k].push(v);
    });
  });

  return { cols, rows };
}

async function loadProductsFromSheets() {
  const retJson = {
    products: {},
    addons: {},
    productCategories: [],
    addonCategories: [],
  };

  // Categories
  const categoriesSheet = await getSheet(sheetId, sheetGids.categories);
  retJson["productCategories"] =
    categoriesSheet.cols["Product Categories"] || [];
  retJson["addonCategories"] = categoriesSheet.cols["Add-on Categories"] || [];

  // Products
  const productsSheet = await getSheet(sheetId, sheetGids.products);
  productsSheet.rows.forEach((row) => {
    retJson.products[row["Product SKU"]] = {
      category: row["Product Category"],
      manufacturer: row["Manufacturer"],
      sku: row["Product SKU"],
      name: row["Product Name"],
      description: row["Product Description"],
      unit_price: priceStringToFloat(row["Our Price"]),
      unit_cost: priceStringToFloat(row["Cost"]),
    };
  });

  // Add-ons
  const addonsSheet = await getSheet(sheetId, sheetGids["addons"]);
  addonsSheet.rows.forEach((row) => {
    retJson.addons[row["Add-on SKU"]] = {
      category: row["Add-on Category"],
      manufacturer: row["Manufacturer"],
      sku: row["Add-on SKU"],
      name: row["Add-on Name"],
      description: row["Add-on Description"],
      unit_price: priceStringToFloat(row["Our Price"]),
      unit_cost: priceStringToFloat(row["Cost"]),
      parent_skus:
        row["Compatible Parent SKUs"]?.replace(/\s+/g, "").split(",") || [],
      incompatible_skus:
        row["Incompatible Add-on SKUs"]?.replace(/\s+/g, "").split(",") || [],
    };
  });

  console.log(retJson);
  return retJson;
}

// --- Hook (integrates with your app) ---
export function useProducts() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState({
    products: {},
    addons: {},
    productCategories: [],
  });

  useEffect(() => {
    async function load() {
      try {
        const json = await loadProductsFromSheets();
        setData(json);
      } catch (e) {
        setError(e.message || String(e));
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const products = useMemo(() => Object.values(data.products || {}), [data]);
  const addons = useMemo(() => Object.values(data.addons || {}), [data]);
  const productCategories = useMemo(
    () => Object.values(data.productCategories || []),
    [data],
  );
  const addonCategories = useMemo(
    () => Object.values(data.addonCategories || []),
    [data],
  );

  return {
    loading,
    error,
    products,
    addons,
    productCategories,
    addonCategories,
  };
}

function Header() {
  return (
    <div className="px-4">
      <header className="sticky top-0 z-20 bg-gray-50/80 backdrop-blur border-b border-gray-200">
        <div className="mx-auto px-4 py-3 flex items-center justify-between">
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">
            Camo CPQ
          </h1>
          <div className="text-xs sm:text-sm">
            Demo • Source: <a className="text-[#56B0CB] hover:text-[#3d8fa8] underline" href="https://docs.google.com/spreadsheets/d/14zzAWJNgDxZgXAm713sq3K8fhWDNJPZ49SGYssBQH00/edit" target="_blank">Camo CPQ Products</a>
          </div>
        </div>
      </header>
    </div>
  );
}

function OptionCard({
  title,
  description,
  price,
  selected,
  disabled,
  onSelect,
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={classNames(
        "w-full text-left rounded-2xl border border-gray-200 p-4 shadow-sm transition-shadow bg-white hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-[#56B0CB] disabled:opacity-50 disabled:cursor-not-allowed",
        selected && "ring-2 ring-[#56B0CB]",
        disabled && "opacity-50 cursor-not-allowed",
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={classNames(
            "mt-1 h-4 w-4 flex-none rounded-full border",
            selected
              ? "bg-[#56B0CB] border-[#56B0CB]"
              : "bg-white border-gray-300",
          )}
        />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-gray-900 line-clamp-2">{title}</div>
          {description && (
            <div className="text-sm text-gray-500 mt-0.5 line-clamp-3">
              {description}
            </div>
          )}
        </div>
        <div className="text-right">
          <div className="font-semibold">
            {currency.format(Number(price || 0))}
          </div>
        </div>
      </div>
    </button>
  );
}

function CheckboxCard({
  title,
  description,
  price,
  checked,
  disabled,
  onToggle,
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className={classNames(
        "w-full text-left rounded-2xl border border-gray-200 p-4 shadow-sm transition-shadow bg-white hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-[#56B0CB] disabled:opacity-50 disabled:cursor-not-allowed",
        checked && "ring-2 ring-[#56B0CB]",
        disabled && "opacity-50 cursor-not-allowed",
      )}
    >
      <div className="flex items-start gap-3">
        {/* Fake checkbox */}
        <div
          className={classNames(
            "mt-1 h-4 w-4 flex-none rounded-sm border flex items-center justify-center",
            checked
              ? "bg-[#56B0CB] border-[#56B0CB]"
              : "bg-white border-gray-300",
          )}
        >
          {checked && (
            <svg
              className="h-3 w-3 text-white"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={3}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M5 13l4 4L19 7"
              />
            </svg>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="font-medium text-gray-900 line-clamp-2">{title}</div>
          {description && (
            <div className="text-sm text-gray-500 mt-0.5 line-clamp-3">
              {description}
            </div>
          )}
        </div>

        <div className="text-right">
          <div className="font-semibold">
            {currency.format(Number(price || 0))}
          </div>
        </div>
      </div>
    </button>
  );
}

function Summary({
  product,
  addons,
  discountType,
  setDiscountType,
  discountValue,
  setDiscountValue,
  quoteLink,
  dealLink,
  quoteLoading,
  onPushToHubspot,
}) {
  const [marginHeld, setMarginHeld] = useState(false);

  useEffect(() => {
    if (marginHeld) {
      requestAnimationFrame(() => {
        window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
      });
    }
  }, [marginHeld]);

  const lineItems = [
    ...(product
      ? [{ name: product.name, description: product.description, price: product.unit_price, cost: product.unit_cost, sku: product.sku }]
      : []),
    ...addons.map((a) => ({ name: a.name, description: a.description, price: a.unit_price, cost: a.unit_cost, sku: a.sku, addon: true })),
  ];

  const subtotal = lineItems.reduce((s, item) => s + Number(item.price || 0), 0);
  const cost = lineItems.reduce((s, item) => s + Number(item.cost || 0), 0);
  // products taxed on cost, addons taxed on price; discount doesn't affect tax
  const tax =
    cost * 0.1 +
    addons.reduce((s, a) => s + Number(a.unit_price || 0) * 0.1, 0);
  const rawDiscount = Number(discountValue || 0);
  const discountAmount =
    discountType === "$"
      ? Math.min(rawDiscount, subtotal)
      : subtotal * (Math.min(rawDiscount, 100) / 100);
  const totalBeforeTax = subtotal - discountAmount;
  const total = totalBeforeTax + tax;
  const marginPct =
    totalBeforeTax !== 0
      ? ((subtotal - cost - discountAmount) / totalBeforeTax) * 100
      : 0;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
      <h2 className="text-lg font-semibold mb-4">Quote Summary</h2>

      {lineItems.length === 0 ? (
        <p className="text-sm text-gray-500">No items selected yet.</p>
      ) : (
        <div className="space-y-4 mb-4">
          {lineItems.map((item) => (
            <div key={item.sku} className={classNames("flex items-start justify-between gap-4", item.addon && "pl-4 border-l-2 border-gray-100")}>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-gray-900">{item.name}</div>
                {item.description && (
                  <div className="text-sm text-gray-500 mt-0.5">{item.description}</div>
                )}
              </div>
              <div className="text-right whitespace-nowrap">
                <div className="font-semibold text-gray-900">{currency.format(Number(item.price || 0))}</div>
                {marginHeld && item.cost > 0 && (
                  <div className="text-xs text-gray-400 mt-0.5">Cost: {currency.format(item.cost)}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-gray-100 pt-4 space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-gray-600">Subtotal</span>
          <span className="font-medium">{currency.format(subtotal)}</span>
        </div>
        {marginHeld && (
          <div className="flex justify-between text-sm text-gray-400">
            <span>Cost</span>
            <span>{currency.format(cost)}</span>
          </div>
        )}

        {/* Discount row */}
        <div className="flex items-center justify-between gap-4 py-1">
          <span className="text-sm text-gray-600">Discount</span>
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs font-medium">
              <button
                type="button"
                onClick={() => setDiscountType("$")}
                className={classNames(
                  "px-2.5 py-1.5 transition-colors",
                  discountType === "$"
                    ? "bg-[#56B0CB] text-white"
                    : "bg-white text-gray-600 hover:bg-gray-50",
                )}
              >
                $
              </button>
              <button
                type="button"
                onClick={() => setDiscountType("%")}
                className={classNames(
                  "px-2.5 py-1.5 transition-colors",
                  discountType === "%"
                    ? "bg-[#56B0CB] text-white"
                    : "bg-white text-gray-600 hover:bg-gray-50",
                )}
              >
                %
              </button>
            </div>
            <input
              type="number"
              min="0"
              step={discountType === "%" ? "1" : "50"}
              value={discountValue}
              onChange={(e) => setDiscountValue(e.target.value)}
              className="w-24 text-right border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#56B0CB]"
              placeholder="0"
            />
          </div>
        </div>
        {discountAmount > 0 && (
          <div className="flex justify-between text-sm text-green-600">
            <span>Discount applied</span>
            <span>-{currency.format(discountAmount)}</span>
          </div>
        )}
        {marginHeld && (
          <div className="flex justify-between text-sm text-gray-400">
            <span>Total before tax</span>
            <span>{currency.format(totalBeforeTax)}</span>
          </div>
        )}
        <div className="flex justify-between text-sm">
          <span className="text-gray-600">Tax</span>
          <span className="font-medium">{currency.format(tax)}</span>
        </div>

        <div className="flex justify-between font-semibold text-base border-t border-gray-100 pt-3 mt-1">
          <span>Total</span>
          <span>{currency.format(total)}</span>
        </div>
        {marginHeld && (
          <div className="flex justify-between text-sm font-medium text-gray-700 pt-1">
            <span>Margin</span>
            <span>{marginPct.toFixed(1)}%</span>
          </div>
        )}
      </div>

      {/* Action buttons — left group / right */}
      <div className="flex items-center justify-between mt-6">
        {/* Left group: Push to HubSpot → View HubSpot Deal, then View Quote right beside it */}
        <div className="flex items-center gap-2">
          {dealLink ? (
            <a
              href={dealLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block px-4 py-2 rounded-xl bg-[#56B0CB] hover:bg-[#4a9ab8] text-white text-sm font-medium transition-colors"
            >
              View HubSpot Deal
            </a>
          ) : (
            <button
              type="button"
              disabled={!product || quoteLoading}
              onClick={onPushToHubspot}
              className="px-4 py-2 rounded-xl bg-[#56B0CB] hover:bg-[#4a9ab8] text-white text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {quoteLoading ? "Sending…" : "Push to HubSpot"}
            </button>
          )}
          {quoteLink && (
            <a
              href={quoteLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block px-4 py-2 rounded-xl bg-[#DDB244] hover:bg-[#c9a33e] text-white text-sm font-medium transition-colors"
            >
              View Quote
            </a>
          )}
        </div>

        {/* Right: View Margin — toggle */}
        <div>
          <button
            type="button"
            onClick={() => setMarginHeld((v) => !v)}
            className="px-4 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 text-gray-800 text-sm font-medium transition-colors"
          >
            {marginHeld ? "Hide Margin" : "View the Margin"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AccordionSection({ title, count, isOpen, onToggle, children }) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="w-full rounded-2xl overflow-hidden border border-gray-200 hover:shadow-md overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-[#56B0CB] flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100"
      >
        <span className="text-sm font-medium text-gray-900">{title}</span>
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center rounded-full bg-white border border-gray-200 px-2 py-0.5 text-xs text-gray-600">
            {count}
          </span>
          <svg
            className={classNames(
              "h-4 w-4 text-gray-500 transition-transform duration-300",
              isOpen ? "rotate-180" : "",
            )}
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.94a.75.75 0 111.08 1.04l-4.24 4.5a.75.75 0 01-1.08 0l-4.24-4.5a.75.75 0 01.02-1.06z"
              clipRule="evenodd"
            />
          </svg>
        </div>
      </button>
      {isOpen && <div className="p-3">{children}</div>}
    </div>
  );
}

export default function App() {
  const {
    loading,
    error,
    products,
    addons,
    productCategories,
    addonCategories,
  } = useProducts();
  const [productSku, setProductSku] = useState(null);
  const [addonSkus, setAddonSkus] = useState(new Set());
  const [openProductCat, setOpenProductCat] = useState(null);
  const [openAddonCat, setOpenAddonCat] = useState(null);
  const [discountType, setDiscountType] = useState("$");
  const [discountValue, setDiscountValue] = useState("");
  const [quoteLink, setQuoteLink] = useState(null);
  const [dealLink, setDealLink] = useState(null);
  const [quoteLoading, setQuoteLoading] = useState(false);

  const selectedProduct = useMemo(
    () => products.find((p) => p.sku === productSku) || null,
    [products, productSku],
  );

  const productScopedAddons = useMemo(() => {
    if (!selectedProduct) return [];
    return addons.filter(
      (a) =>
        Array.isArray(a.parent_skus) &&
        a.parent_skus.includes(selectedProduct.sku),
    );
  }, [addons, selectedProduct]);

  const incompatibleSkuSet = useMemo(() => {
    const set = new Set();
    for (const a of addons) {
      if (addonSkus.has(a.sku) && Array.isArray(a.incompatible_skus)) {
        for (const inc of a.incompatible_skus) set.add(inc);
      }
    }
    return set;
  }, [addons, addonSkus]);

  // keep add-ons consistent with selected product
  useEffect(() => {
    if (!selectedProduct && addonSkus.size) {
      setAddonSkus(new Set());
      return;
    }
    if (selectedProduct) {
      const allowed = new Set(productScopedAddons.map((a) => a.sku));
      const next = new Set([...addonSkus].filter((sku) => allowed.has(sku)));
      if (next.size !== addonSkus.size) setAddonSkus(next);
    }
  }, [selectedProduct, productScopedAddons]);

  const toggleAddon = (sku) => {
    const next = new Set(addonSkus);
    if (next.has(sku)) next.delete(sku);
    else next.add(sku);
    setAddonSkus(next);
  };

  const selectedAddons = useMemo(
    () => addons.filter((a) => addonSkus.has(a.sku)),
    [addons, addonSkus],
  );

  const handlePushToHubspot = async () => {
    if (!selectedProduct) return;

    const lineItems = [
      { name: selectedProduct.name, description: selectedProduct.description, price: selectedProduct.unit_price, sku: selectedProduct.sku },
      ...selectedAddons.map((a) => ({ name: a.name, description: a.description, price: a.unit_price, sku: a.sku })),
    ];
    const subtotal = lineItems.reduce((s, i) => s + i.price, 0);
    const cost = selectedProduct.unit_cost || 0;
    const tax =
      cost * 0.1 +
      selectedAddons.reduce((s, a) => s + a.unit_price * 0.1, 0);
    const rawDiscount = Number(discountValue || 0);
    const discountAmount =
      discountType === "$"
        ? Math.min(rawDiscount, subtotal)
        : subtotal * (Math.min(rawDiscount, 100) / 100);
    const total = subtotal - discountAmount + tax;

    setQuoteLoading(true);
    setQuoteLink(null);
    setDealLink(null);
    try {
      const res = await fetch("https://n8n.californiamobility.com/webhook/camocpq-demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ line_items: lineItems, subtotal, tax, discount: discountAmount, total }),
      });
      const data = await res.json();
      if (data.quote_link) setQuoteLink(data.quote_link);
      if (data.deal_link) setDealLink(data.deal_link);
    } catch (e) {
      console.error("HubSpot push failed:", e);
    } finally {
      setQuoteLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      <Header />

      <main className="mx-auto w-full px-4 py-4 space-y-6">
        {loading && (
          <div className="text-center text-gray-600">Loading products…</div>
        )}
        {error && <div className="text-center text-red-600">{error}</div>}

        {!loading && !error && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Product Picker (Accordion) */}
            <section className="bg-white rounded-2xl border border-gray-200 shadow-sm pb-2">
              <div className="p-4 border-b border-gray-100">
                <h2 className="text-lg font-semibold">Product</h2>
                <p className="text-sm text-gray-500">
                  Select one product to begin. Prices shown include install &
                  shipping but exclude tax.
                </p>
              </div>

              <div className="p-4 space-y-3 h-[60vh] overflow-y-scroll scroll-smooth">
                {productCategories.map((cat) => {
                  const items = products.filter((p) => p.category === cat);
                  if (items.length === 0) return null;
                  const isOpen = openProductCat === cat;
                  return (
                    <AccordionSection
                      key={cat}
                      title={cat}
                      count={items.length}
                      isOpen={isOpen}
                      onToggle={() =>
                        setOpenProductCat((prev) => (prev === cat ? null : cat))
                      }
                    >
                      <div className="space-y-3">
                        {items.map((p) => (
                          <OptionCard
                            key={p.sku}
                            title={p.name}
                            description={p.description}
                            price={p.unit_price}
                            selected={productSku === p.sku}
                            onSelect={() => {
                              setProductSku(p.sku);
                              setOpenProductCat(cat); // open the clicked product's category
                            }}
                          />
                        ))}
                      </div>
                    </AccordionSection>
                  );
                })}
              </div>
            </section>

            {/* Add-on Picker */}
            <section className="bg-white rounded-2xl border border-gray-200 shadow-sm pb-2 ">
              <div className="p-4 border-b border-gray-100">
                <h2 className="text-lg font-semibold">Add-ons</h2>
                <p className="text-sm text-gray-500">
                  Only add-ons compatible with the selected product are shown.
                </p>
              </div>

              <div className="p-4 space-y-3 h-[60vh] overflow-y-scroll scroll-smooth flex flex-col">
                {!selectedProduct && (
                  <div className="text-sm text-gray-500">
                    Choose a product to see available add-ons.
                  </div>
                )}
                {selectedProduct && productScopedAddons.length === 0 && (
                  <div className="text-sm text-gray-500">
                    No add-ons available for this product.
                  </div>
                )}

                {selectedProduct &&
                  addonCategories.map((cat) => {
                    const items = productScopedAddons.filter(
                      (a) => a.category === cat,
                    );
                    console.log(addonCategories);
                    if (items.length === 0) return null;
                    const isOpen = openAddonCat === cat;
                    return (
                      <AccordionSection
                        key={cat}
                        title={cat}
                        count={items.length}
                        isOpen={isOpen}
                        onToggle={() =>
                          setOpenAddonCat((prev) => (prev === cat ? null : cat))
                        }
                      >
                        <div className="space-y-3">
                          {items.map((a) => {
                            const isChecked = addonSkus.has(a.sku);
                            const isDisabled =
                              !isChecked && incompatibleSkuSet.has(a.sku);
                            return (
                              <CheckboxCard
                                key={a.sku}
                                title={a.name}
                                description={a.description}
                                price={a.unit_price}
                                checked={isChecked}
                                disabled={isDisabled}
                                onToggle={() =>
                                  !isDisabled && toggleAddon(a.sku)
                                }
                              />
                            );
                          })}
                        </div>
                      </AccordionSection>
                    );
                  })}

                {selectedProduct && selectedAddons.length > 0 && (
                  <div className="sticky bottom-0 pt-2 z-30 flex justify-end mt-auto">
                    <button
                      className="sm:w-auto px-4 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 text-gray-800 text-sm"
                      onClick={() => setAddonSkus(new Set())}
                    >
                      Clear add-ons
                    </button>
                  </div>
                )}
              </div>
            </section>
          </div>
        )}

        {!loading && !error && (
          <Summary
            product={selectedProduct}
            addons={selectedAddons}
            discountType={discountType}
            setDiscountType={setDiscountType}
            discountValue={discountValue}
            setDiscountValue={setDiscountValue}
            quoteLink={quoteLink}
            dealLink={dealLink}
            quoteLoading={quoteLoading}
            onPushToHubspot={handlePushToHubspot}
          />
        )}
      </main>
    </div>
  );
}
