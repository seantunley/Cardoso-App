// Shared tab identifiers for pages that support ?tab= deep-linking. Kept in one
// place so the Insights deep-links (services/insights.js) and the pages that
// read them (pages/InventoryMovement.jsx, pages/Trends.jsx) can't drift apart:
// a renamed tab id now fails to compile on both sides instead of silently
// falling back to the default tab. Plain constants only — no React — so the
// server-side insights engine can import the same source of truth the client
// validates against.

export const INVENTORY_MOVEMENT_TABS = {
  TOP_MOVERS: 'topMovers',
  DEAD_STOCK: 'deadStock',
  FORECAST: 'forecast',
  MOVEMENT_HISTORY: 'movementHistory',
};

export const TREND_TABS = {
  CUSTOMERS: 'customers',
  INVENTORY: 'inventory',
};

export const TREND_INVENTORY_VIEWS = {
  SALES: 'sales',
  MIX: 'mix',
  MOVEMENT: 'movement',
  SEASONAL: 'seasonal',
};
