/**
 * pages.config.js - Page routing configuration
 *
 * This file is AUTO-GENERATED. Do not add imports or modify PAGES manually.
 * Pages are auto-registered when you create files in the ./pages/ folder.
 *
 * THE ONLY EDITABLE VALUE: mainPage
 * This controls which page is the landing page (shown when users visit the app).
 *
 * Example file structure:
 *
 *   import HomePage from './pages/HomePage';
 *   import Dashboard from './pages/Dashboard';
 *    *
 *   export const PAGES = {
 *       "HomePage": HomePage,
 *       "Dashboard": Dashboard,
 *    *   }
 *
 *   export const pagesConfig = {
 *       mainPage: "HomePage",
 *       Pages: PAGES,
 *   };
 *
 * Example with Layout (wraps all pages):
 *
 *   import Home from './pages/Home';
 *    *   import __Layout from './Layout.jsx';
 *
 *   export const PAGES = {
 *       "Home": Home,
 *    *   }
 *
 *   export const pagesConfig = {
 *       mainPage: "Home",
 *       Pages: PAGES,
 *       Layout: __Layout,
 *   };
 *
 * To change the main page from HomePage to Dashboard, use find_replace:
 *   Old: mainPage: "HomePage",
 *   New: mainPage: "Dashboard",
 *
 * The mainPage value must match a key in the PAGES object exactly.
 */
import React from "react";
import __Layout from './Layout.jsx';

const AuditLog = React.lazy(() => import('./pages/AuditLog'));
const Collections = React.lazy(() => import('./pages/Collections'));
const CustomerBalances = React.lazy(() => import('./pages/CustomerBalances'));
const HubDashboard = React.lazy(() => import('./pages/HubDashboard'));
const HubBackups = React.lazy(() => import('./pages/HubBackups'));
const HubMetrics = React.lazy(() => import('./pages/HubMetrics'));
const HubTrends = React.lazy(() => import('./pages/HubTrends'));
const HubSyncLog = React.lazy(() => import('./pages/HubSyncLog'));
const HubReconciliation = React.lazy(() => import('./pages/HubReconciliation'));
const Connections = React.lazy(() => import('./pages/Connections'));
const CustomerSearch = React.lazy(() => import('./pages/CustomerSearch'));
const Dashboard = React.lazy(() => import('./pages/Dashboard'));
const Records = React.lazy(() => import('./pages/Records'));
const Reports = React.lazy(() => import('./pages/Reports'));
const Users = React.lazy(() => import('./pages/Users'));
const Inventory = React.lazy(() => import('./pages/Inventory'));
const NetworkDevices = React.lazy(() => import('./pages/NetworkDevices'));
const CreditDebug = React.lazy(() => import('./pages/CreditDebug'));
const Reconciliation = React.lazy(() => import('./pages/Reconciliation'));
const Operations = React.lazy(() => import('./pages/Operations'));
const Jti = React.lazy(() => import('./pages/Jti'));
const HubJti = React.lazy(() => import('./pages/HubJti'));
const InventoryMovement = React.lazy(() => import('./pages/InventoryMovement'));
const PriceList = React.lazy(() => import('./pages/PriceList'));
const StockReceipts = React.lazy(() => import('./pages/StockReceipts'));


export const PAGES = {
    "AuditLog": AuditLog,
    "Collections": Collections,
    "CustomerBalances": CustomerBalances,
    "Inventory": Inventory,
    "NetworkDevices": NetworkDevices,
    "HubDashboard": HubDashboard,
    "HubBackups": HubBackups,
    "HubMetrics": HubMetrics,
    "HubTrends": HubTrends,
    "HubSyncLog": HubSyncLog,
    "HubReconciliation": HubReconciliation,
    "Connections": Connections,
    "CustomerSearch": CustomerSearch,
    "Dashboard": Dashboard,
    "Records": Records,
    "Reports": Reports,
    "Users": Users,
    "CreditDebug": CreditDebug,
    "Reconciliation": Reconciliation,
    "Operations": Operations,
    "Jti": Jti,
    "HubJti": HubJti,
    "InventoryMovement": InventoryMovement,
    "PriceList": PriceList,
    "StockReceipts": StockReceipts,
}

export const pagesConfig = {
    mainPage: "CustomerSearch",
    Pages: PAGES,
    Layout: __Layout,
};
