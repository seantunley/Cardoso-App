// Getting-started articles — hand-authored. These describe app mechanics only
// (signing in, the sidebar, the theme toggle, the command palette) — no
// business rules — so they are safe seed content. Module-specific articles that
// touch business logic are authored separately and reviewed with Sean.

/** @typedef {import('./../types.js').HelpArticle} HelpArticle */

/** @type {HelpArticle[]} */
export const gettingStartedArticles = [
  {
    slug: "welcome",
    title: "Welcome to Cardoso",
    summary: "What the app is for and how this help centre is organised.",
    category: "getting-started",
    audience: "everyone",
    keywords: ["about", "overview", "intro", "help", "manual"],
    body: [
      {
        type: "p",
        text: "The Cardoso app is the depot's day-to-day workspace: customer balances and collections, BAT reconciliation, inventory and pricing, reports, and — on the hub — a fleet-wide view of every site.",
      },
      {
        type: "p",
        text: "This help centre is organised into the same sections you see in the sidebar. Use the search box on the left to jump straight to a topic, or browse a category below.",
      },
      {
        type: "callout",
        tone: "tip",
        text: "Press the search box and start typing — results rank by title first, then by content, so a word or two is usually enough.",
      },
    ],
  },
  {
    slug: "finding-your-way-around",
    title: "Finding your way around",
    summary: "The sidebar, groups, collapsing, and switching pages.",
    category: "getting-started",
    audience: "everyone",
    keywords: ["sidebar", "navigation", "menu", "pages", "layout", "groups"],
    body: [
      {
        type: "p",
        text: "Everything is reached from the sidebar on the left. Pages are organised into collapsible groups — Customers, Inventory, Reports, and so on. Click a group heading to open or close it.",
      },
      {
        type: "steps",
        items: [
          "Click a group heading to expand it.",
          "Click a page name to open that page.",
          "Use the chevron at the top of the sidebar to collapse it to icons only when you want more room.",
        ],
      },
      {
        type: "p",
        text: "Which pages you see depends on your permissions. If you can't find a page you expect, an administrator may need to grant you access.",
      },
    ],
  },
  {
    slug: "search-and-shortcuts",
    title: "Search & keyboard shortcuts",
    summary: "Open the command palette to jump anywhere fast.",
    category: "getting-started",
    audience: "everyone",
    keywords: ["command", "palette", "shortcut", "keyboard", "ctrl k", "search"],
    body: [
      {
        type: "p",
        text: "The command palette is the fastest way to move around. It lets you jump to any page or run common actions without reaching for the mouse.",
      },
      {
        type: "steps",
        items: [
          "Press **Ctrl+K** (or **⌘K** on a Mac) to open the palette.",
          "Start typing a page or action name.",
          "Use the arrow keys to highlight a result and press **Enter**.",
          "Press **Esc** to close it.",
        ],
      },
    ],
  },
  {
    slug: "light-and-dark-theme",
    title: "Light and dark theme",
    summary: "Switch the display theme; your choice is remembered.",
    category: "getting-started",
    audience: "everyone",
    keywords: ["theme", "dark", "light", "appearance", "display", "contrast"],
    body: [
      {
        type: "p",
        text: "The app ships in a dark theme and also offers a light theme. Use the sun/moon toggle in the sidebar footer to switch between them.",
      },
      {
        type: "p",
        text: "Your choice is saved to your account, so the app opens in the same theme next time — on any device where you sign in.",
      },
    ],
  },
];
