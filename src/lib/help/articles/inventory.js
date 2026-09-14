// Inventory & pricing articles. Written from the actual screens (Inventory,
// InventoryMovement, StockReceipts, PriceList). Describes what the screens
// visibly do, in plain language (Sage table names in the code's tooltips are
// left out — end users don't need them). Forecast/movement formulas beyond what
// a column label states are deferred to an SME, not invented.

/** @typedef {import('./../types.js').HelpArticle} HelpArticle */

/** @type {HelpArticle[]} */
export const inventoryArticles = [
  {
    slug: "inventory-list",
    title: "The inventory list",
    summary: "Browse stock on hand, filter it, and export or print the view.",
    category: "inventory",
    audience: "everyone",
    keywords: ["inventory", "stock", "items", "on hand", "price", "cost", "export", "csv", "commodity"],
    body: [
      {
        type: "p",
        text: "The Inventory list shows every stock item with its quantity on hand, last cost, and selling price. The subtitle line tells you how many items are showing and which filters are active.",
      },
      { type: "h", text: "Finding items" },
      {
        type: "list",
        items: [
          "Type in the search box to match an item number or description.",
          "**Commodity** and **Price list** pills narrow the list.",
          "On the hub, a **Site** dropdown picks one branch or all.",
          "**Hide zero qty** removes items with no stock on hand.",
          "**Highlight price ≤ cost** shades rows where the selling price is at or below the last cost.",
        ],
      },
      { type: "h", text: "The columns" },
      {
        type: "p",
        text: "Item Number, Description, Qty on Hand, Last Cost, Price, Price List, and UOM (the stocking unit — Each, Box, Carton). Click any header to sort; drag a column edge to resize it (double-click to reset). A tile above the table totals the inventory holding for the current view.",
      },
      {
        type: "p",
        text: "Use **Export CSV** to download the current, filtered view, or **Print** for a printable copy. **Refresh** reloads from Sage.",
      },
      {
        type: "callout",
        tone: "info",
        text: "The list is capped for speed — if you see a \"Showing N of M\" banner, refine your search to reach the rest.",
      },
    ],
  },
  {
    slug: "inventory-movement",
    title: "Sales velocity, dead stock & forecasting",
    summary: "Top movers, dead stock, and the reorder forecast in Inventory Movement.",
    category: "inventory",
    audience: "managers",
    keywords: ["movement", "top movers", "dead stock", "forecast", "reorder", "velocity", "abc", "sync", "sales"],
    body: [
      {
        type: "p",
        text: "Inventory Movement analyses sales history from Sage. It has up to four tabs: Top Movers, Dead Stock, Forecast, and Movement History (the last two are site-only).",
      },
      {
        type: "list",
        items: [
          "**Top Movers** — best-selling items over a period you choose (Last 7/30/90 days, YTD, Last 12 months, or a custom range). Each row opens a sales trend.",
          "**Dead Stock** — items with no sale in a threshold you set (30/60/90/180 days, 1 year), with the capital tied up in them.",
          "**Forecast** — a reorder view with daily demand, reorder point, days of stock, and a suggested order quantity; switch to **Reorder Plan** for the buy list.",
        ],
      },
      {
        type: "p",
        text: "On a site, **Sync from Sage** pulls the latest shipment history, and **Recompute** rebuilds the forecast after a sync. Filter any tab by commodity, supplier, and item search.",
      },
      {
        type: "callout",
        tone: "info",
        text: "Forecast **Settings** (lead time, order cycle, service level, minimum order quantity) are admin-only. The exact formulas behind the forecast columns are configured there and by your planning policy.",
      },
    ],
  },
  {
    slug: "stock-expiry",
    title: "Recording stock expiry dates",
    summary: "Capture expiry dates against receipt lines synced from Sage.",
    category: "inventory",
    audience: "managers",
    keywords: ["expiry", "stock receipts", "receipt", "expire", "batch", "shelf life", "sync"],
    body: [
      {
        type: "p",
        text: "Stock Expiry lets you record expiry dates against purchase-order receipt lines. On a site the screen is split: receipt lines on the left, an entry panel on the right.",
      },
      {
        type: "steps",
        items: [
          "Click **Sync from Sage** to pull the latest receipts (site only).",
          "Turn on **Missing expiry only** to see just the lines still needing a date — your capture worklist.",
          "Select a receipt line on the left.",
          "On the right, enter the expiry date, the quantity at that expiry (defaults to the received quantity), and an optional note such as a batch number.",
          "Click **Add Expiry Entry**. It's recorded against you and logged.",
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: "On the hub this screen is read-only — a single list across sites showing each line's expiry date, quantity, and who entered it. Capture happens on the site.",
      },
    ],
  },
  {
    slug: "price-list",
    title: "Producing a customer price list",
    summary: "Pick a price list and commodity, then print or download a customer-ready PDF.",
    category: "inventory",
    audience: "everyone",
    keywords: ["price list", "pricing", "pdf", "catalogue", "print", "customer", "quote", "exclusions"],
    body: [
      {
        type: "p",
        text: "The Price List page produces a customer-ready catalogue of selling prices, sourced live from Sage.",
      },
      {
        type: "steps",
        items: [
          "Choose a **Price list** (STD is the master list; others are customer-tier specific).",
          "Optionally filter by **Commodity** and **Supplier**, or search for specific items.",
          "Click **Download PDF** for a saved copy, or **Print** to open it with a print dialog.",
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: "The PDF carries your depot letterhead and does not show the supplier filter — it's meant to go straight to a customer.",
      },
      {
        type: "p",
        text: "**Exclusions in Settings** (admin-only) controls which item codes are hidden from price lists.",
      },
    ],
  },
  {
    slug: "stock-take-barcodes",
    title: "Stock take: the barcode map",
    summary: "Scan a barcode on a phone to see what an item is, and teach the system barcodes it has not met.",
    category: "inventory",
    audience: "everyone",
    keywords: ["stock take", "stocktake", "barcode", "scan", "scanner", "count", "phone", "camera", "pack size", "carton"],
    body: [
      {
        type: "p",
        text: "Sage has no barcode field, so the link between a barcode and an item is kept in this app. **Stock Take** is where that map is built and used. Nothing on this screen changes anything in Sage — it only reads from it.",
      },
      { type: "h", text: "Before you start" },
      {
        type: "list",
        items: [
          "Pick your **Location** at the top. On-hand figures and the item search are for that branch.",
          "If the screen says the item list has never been loaded, tap **Refresh item list** to read the items and their pack sizes from Sage.",
          "The header shows how much of the stock is covered, for example \"312 of 989 items holding stock\".",
        ],
      },
      { type: "h", text: "Scanning" },
      {
        type: "list",
        items: [
          "**A Bluetooth scanner** types straight into the box and needs no taps at all — the box takes the focus back after every action.",
          "**The phone camera** works through the **Camera** button on Android phones and on desktop Chrome or Edge. iPhones cannot read barcodes from the camera, and the camera needs the site to be on a secure (https) address. When either is missing the screen says so and you use the scanner or type the number.",
          "**Typing** the number printed under the bars always works.",
        ],
      },
      { type: "h", text: "When the barcode is known" },
      {
        type: "p",
        text: "You get the item, its description, what the barcode means (**1 CARTON = 10 EACH**), the quantity on hand in both the stocking unit and the scanned pack size, and the average cost. You can re-point the barcode to a different item or pack size, or remove it.",
      },
      { type: "h", text: "When the barcode is new" },
      {
        type: "steps",
        items: [
          "Search for the item by number or description. Items the branch actually holds are listed first.",
          "Choose the item, then choose the **pack size** the barcode sits on.",
          "The mapping is saved against your name, and the next person who scans that label gets the answer straight away.",
        ],
      },
      {
        type: "callout",
        tone: "warning",
        text: "The pack size is the part that matters. A carton and a single carry different barcodes and must be mapped to different units — counting a carton as a single is wrong by the whole carton, and that error works its way into stock value and cost.",
      },
      {
        type: "callout",
        tone: "info",
        text: "A label read by a camera and the same label read by a laser scanner can come back as 12 or 13 digits. Both forms are treated as the same barcode, so you never have to map a label twice.",
      },
    ],
  },
];
