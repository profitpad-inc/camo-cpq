// Register Service Worker
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/service-worker.js")
      .then((reg) => console.log("SW registered", reg))
      .catch((err) => console.error("SW registration failed", err));
  });
}


// IndexedDB setup
let db;
const request = indexedDB.open("cpqDB", 1);
request.onupgradeneeded = (e) => {
  db = e.target.result;
  db.createObjectStore("quotes", { keyPath: "id", autoIncrement: true });
};
request.onsuccess = (e) => {
  db = e.target.result;
  loadQuotes();
};

// Add quote
document.getElementById("addQuote").addEventListener("click", () => {
  const productSelect = document.getElementById("product");
  const product = productSelect.options[productSelect.selectedIndex].text;
  const price = parseFloat(productSelect.value);
  const quantity = parseInt(document.getElementById("quantity").value);
  const total = price * quantity;

  const quote = { product, quantity, total };

  const tx = db.transaction("quotes", "readwrite");
  tx.objectStore("quotes").add(quote);
  tx.oncomplete = loadQuotes;
});

// Load quotes from IndexedDB
function loadQuotes() {
  const tx = db.transaction("quotes", "readonly");
  const store = tx.objectStore("quotes");
  const request = store.getAll();
  request.onsuccess = () => {
    const quoteList = document.getElementById("quoteList");
    quoteList.innerHTML = "";
    request.result.forEach((q) => {
      const li = document.createElement("li");
      li.textContent = `${q.product} x${q.quantity} = $${q.total}`;
      quoteList.appendChild(li);
    });
  };
}

// Example HubSpot API call (unsafe in production)
document.getElementById("syncHubSpot").addEventListener("click", async () => {
//   const HUBSPOT_API_KEY = "YOUR_PRIVATE_KEY";
//   const HUBSPOT_CONTACT_ID = "99975942042";  // camo

  try {
    // const res = await fetch(
    //   `https://api.hubapi.com/crm/v3/objects/contacts/${HUBSPOT_CONTACT_ID}`,
    //   {
    //     headers: { Authorization: `Bearer ${HUBSPOT_API_KEY}` },
    //   },
    // );
    // const data = await res.json();
    // console.log("HubSpot data:", data);
    alert("Fetched contact data! Check console.");
  } catch (err) {
    console.error(err);
    alert("Error fetching HubSpot data");
  }
});
