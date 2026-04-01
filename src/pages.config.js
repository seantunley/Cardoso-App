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
import AuditLog from './pages/AuditLog';
import CustomerBalances from './pages/CustomerBalances';
import HubDashboard from './pages/HubDashboard';
import HubBackups from './pages/HubBackups';
import HubSyncLog from './pages/HubSyncLog';
import Connections from './pages/Connections';
import CustomerSearch from './pages/CustomerSearch';
import Dashboard from './pages/Dashboard';
import Records from './pages/Records';
import Reports from './pages/Reports';
import Users from './pages/Users';
import Inventory from './pages/Inventory';
import __Layout from './Layout.jsx';


export const PAGES = {
    "AuditLog": AuditLog,
    "CustomerBalances": CustomerBalances,
    "Inventory": Inventory,
    "HubDashboard": HubDashboard,
    "HubBackups": HubBackups,
    "HubSyncLog": HubSyncLog,
    "Connections": Connections,
    "CustomerSearch": CustomerSearch,
    "Dashboard": Dashboard,
    "Records": Records,
    "Reports": Reports,
    "Users": Users,
}

export const pagesConfig = {
    mainPage: "CustomerSearch",
    Pages: PAGES,
    Layout: __Layout,
};