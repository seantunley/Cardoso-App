import { Link } from "react-router-dom";
import {
  Settings,
  LogOut,
  ChevronLeft,
  ChevronRight,
  KeyRound,
  Sun,
  Moon,
} from "lucide-react";
import { applyTheme } from "@/lib/AuthContext";

// ── Custom nav SVG icons ──────────────────────────────────────────────────────
const IconCustomerSearch = ({ className, style }) => (
  <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} style={style}>
    <circle cx="8" cy="7" r="3" fill="#60a5fa" opacity="0.9"/>
    <path d="M3 16c0-2.761 2.239-4 5-4s5 1.239 5 4" stroke="#3b82f6" strokeWidth="1.6" strokeLinecap="round" fill="none"/>
    <circle cx="8" cy="7" r="3" stroke="#93c5fd" strokeWidth="1" fill="none"/>
    <line x1="14" y1="14" x2="18" y2="18" stroke="#93c5fd" strokeWidth="1.8" strokeLinecap="round"/>
    <circle cx="14" cy="11" r="3" stroke="#60a5fa" strokeWidth="1.6" fill="none"/>
  </svg>
);

const IconHubDashboard = ({ className, style }) => (
  <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} style={style}>
    <circle cx="10" cy="10" r="7.5" stroke="#818cf8" strokeWidth="1.5" fill="none"/>
    <ellipse cx="10" cy="10" rx="3.5" ry="7.5" stroke="#818cf8" strokeWidth="1.2" fill="none"/>
    <line x1="2.5" y1="10" x2="17.5" y2="10" stroke="#a5b4fc" strokeWidth="1.2"/>
    <line x1="3.5" y1="6.5" x2="16.5" y2="6.5" stroke="#818cf8" strokeWidth="0.9" opacity="0.6"/>
    <line x1="3.5" y1="13.5" x2="16.5" y2="13.5" stroke="#818cf8" strokeWidth="0.9" opacity="0.6"/>
    <circle cx="10" cy="10" r="1.2" fill="#c7d2fe"/>
  </svg>
);

const IconSiteBackups = ({ className, style }) => (
  <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} style={style}>
    <rect x="2" y="3" width="16" height="4" rx="1.5" fill="#0e7490" opacity="0.7"/>
    <rect x="2" y="8.5" width="16" height="4" rx="1.5" fill="#0e7490" opacity="0.5"/>
    <circle cx="15.5" cy="5" r="1" fill="#67e8f9"/>
    <circle cx="15.5" cy="10.5" r="1" fill="#67e8f9" opacity="0.6"/>
    <path d="M10 14.5 L10 18 M10 18 L7.5 15.5 M10 18 L12.5 15.5" stroke="#22d3ee" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const IconCustomerBalances = ({ className, style }) => (
  <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} style={style}>
    <line x1="10" y1="2.5" x2="10" y2="5" stroke="#34d399" strokeWidth="1.6" strokeLinecap="round"/>
    <line x1="10" y1="5" x2="4" y2="8" stroke="#10b981" strokeWidth="1.4" strokeLinecap="round"/>
    <line x1="10" y1="5" x2="16" y2="8" stroke="#10b981" strokeWidth="1.4" strokeLinecap="round"/>
    <rect x="2" y="8" width="4" height="3" rx="1" fill="#34d399" opacity="0.85"/>
    <rect x="14" y="8" width="4" height="3" rx="1" fill="#34d399" opacity="0.6"/>
    <line x1="2" y1="17.5" x2="18" y2="17.5" stroke="#6ee7b7" strokeWidth="1.4" strokeLinecap="round"/>
    <line x1="10" y1="11" x2="10" y2="17.5" stroke="#10b981" strokeWidth="1.2" strokeLinecap="round"/>
    <circle cx="10" cy="5" r="1" fill="#6ee7b7"/>
  </svg>
);

const IconInventory = ({ className, style }) => (
  <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} style={style}>
    <rect x="2" y="11" width="7" height="7" rx="1" fill="#fb923c" opacity="0.9"/>
    <rect x="11" y="11" width="7" height="7" rx="1" fill="#fb923c" opacity="0.65"/>
    <rect x="6" y="3" width="8" height="7" rx="1" fill="#fdba74" opacity="0.9"/>
    <line x1="10" y1="3" x2="10" y2="10" stroke="#f97316" strokeWidth="1"/>
    <line x1="6" y1="6.5" x2="14" y2="6.5" stroke="#f97316" strokeWidth="1"/>
  </svg>
);

// Network Devices — stacked server racks with status LEDs + signal bars.
const IconNetworkDevices = ({ className, style }) => (
  <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} style={style}>
    {/* Back rack */}
    <rect x="3.5" y="3" width="13" height="5" rx="1" fill="#22d3ee" opacity="0.35"/>
    {/* Front rack */}
    <rect x="2.5" y="6.5" width="13" height="5" rx="1" fill="#06b6d4"/>
    <rect x="2.5" y="6.5" width="13" height="0.7" fill="#67e8f9" opacity="0.7"/>
    {/* LEDs */}
    <circle cx="13.5" cy="9" r="0.6" fill="#22c55e"/>
    <circle cx="11.5" cy="9" r="0.6" fill="#fbbf24"/>
    {/* Signal bars rising bottom-right */}
    <rect x="8"  y="15"   width="1.5" height="2"   rx="0.2" fill="#a78bfa"/>
    <rect x="10" y="13.5" width="1.5" height="3.5" rx="0.2" fill="#a78bfa"/>
    <rect x="12" y="12"   width="1.5" height="5"   rx="0.2" fill="#c4b5fd"/>
    <rect x="14" y="10.5" width="1.5" height="6.5" rx="0.2" fill="#c4b5fd"/>
  </svg>
);

// Collections — phone receiver with a phosphor pulse signal beside it.
const IconCollections = ({ className, style }) => (
  <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} style={style}>
    {/* Phone receiver body */}
    <path d="M5 3.5c-0.7 0-1.3 0.5-1.4 1.2L3 8.5c1.5 1 3 2.5 4 4l3.8-0.6c0.7-0.1 1.2-0.7 1.2-1.4L11.5 8c-1.5-1-3-2.5-4-4L5 3.5Z"
          fill="#f97316"/>
    <path d="M5 3.5c-0.7 0-1.3 0.5-1.4 1.2L3 8.5c1.5 1 3 2.5 4 4l3.8-0.6c0.7-0.1 1.2-0.7 1.2-1.4L11.5 8c-1.5-1-3-2.5-4-4L5 3.5Z"
          stroke="#fdba74" strokeWidth="0.4"/>
    {/* Signal arcs */}
    <path d="M14 5.5c1 0.5 1.7 1.5 1.7 2.7" stroke="#34d399" strokeWidth="1.4" strokeLinecap="round" fill="none"/>
    <path d="M14.5 3c2 0.7 3.3 2.5 3.3 4.7" stroke="#34d399" strokeWidth="1.4" strokeLinecap="round" fill="none" opacity="0.55"/>
    {/* Bottom dot */}
    <circle cx="14" cy="14" r="1.4" fill="#fbbf24"/>
  </svg>
);

// Credit Debug — laboratory flask with bubbling phosphor liquid.
const IconCreditDebug = ({ className, style }) => (
  <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} style={style}>
    {/* Flask outline */}
    <path d="M8 2.5h4v4l3.5 8c0.4 0.9-0.3 1.9-1.3 1.9H5.8c-1 0-1.7-1-1.3-1.9L8 6.5v-4Z"
          fill="#1e293b" stroke="#94a3b8" strokeWidth="0.7" strokeLinejoin="round"/>
    {/* Liquid (phosphor amber) */}
    <path d="M6 12.5l1.7-3.8h4.6L14 12.5c0.3 0.8-0.2 1.5-1 1.5H7c-0.8 0-1.3-0.7-1-1.5Z"
          fill="#f59e0b"/>
    {/* Surface highlight */}
    <ellipse cx="10" cy="9" rx="2" ry="0.3" fill="#fde68a" opacity="0.5"/>
    {/* Bubbles */}
    <circle cx="9" cy="11" r="0.5" fill="#fef3c7" opacity="0.8"/>
    <circle cx="11" cy="12" r="0.4" fill="#fef3c7" opacity="0.6"/>
    <circle cx="10" cy="9.5" r="0.3" fill="#fef3c7"/>
    {/* Stopper */}
    <rect x="7.5" y="2" width="5" height="1.4" rx="0.4" fill="#a78bfa"/>
  </svg>
);

// JTI — spreadsheet-style document with "JTI" stamped across it in
// phosphor. Distinct from the BAT Reconciliation icon (compare bars)
// so the operator can tell at a glance which is which.
const IconJti = ({ className, style }) => (
  <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} style={style}>
    {/* Document body */}
    <rect x="3" y="2.5" width="14" height="15" rx="1" fill="#1f2937" stroke="#9ca3af" strokeWidth="0.6"/>
    {/* Sheet ruling */}
    <line x1="5" y1="6"  x2="15" y2="6"  stroke="#4b5563" strokeWidth="0.4"/>
    <line x1="5" y1="9"  x2="15" y2="9"  stroke="#4b5563" strokeWidth="0.4"/>
    <line x1="5" y1="12" x2="15" y2="12" stroke="#4b5563" strokeWidth="0.4"/>
    <line x1="5" y1="15" x2="15" y2="15" stroke="#4b5563" strokeWidth="0.4"/>
    {/* JTI stamp */}
    <text x="10" y="11.7" textAnchor="middle" fontFamily="monospace" fontSize="4.5" fontWeight="bold" fill="#fb923c">JTI</text>
  </svg>
);

// Reconciliation — two parallel columns with a phosphor compare bracket.
const IconReconciliationCompare = ({ className, style }) => (
  <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} style={style}>
    {/* Left column (BAT) - amber */}
    <rect x="2" y="4" width="5" height="12" rx="0.8" fill="#f97316"/>
    <rect x="2" y="4" width="5" height="0.7" fill="#fed7aa" opacity="0.6"/>
    <line x1="3" y1="7"  x2="6" y2="7"  stroke="#fef3c7" strokeWidth="0.6" opacity="0.7"/>
    <line x1="3" y1="9"  x2="6" y2="9"  stroke="#fef3c7" strokeWidth="0.6" opacity="0.7"/>
    <line x1="3" y1="11" x2="6" y2="11" stroke="#fef3c7" strokeWidth="0.6" opacity="0.7"/>
    {/* Right column (Sage) - green */}
    <rect x="13" y="4" width="5" height="12" rx="0.8" fill="#10b981"/>
    <rect x="13" y="4" width="5" height="0.7" fill="#a7f3d0" opacity="0.6"/>
    <line x1="14" y1="7"  x2="17" y2="7"  stroke="#d1fae5" strokeWidth="0.6" opacity="0.7"/>
    <line x1="14" y1="9"  x2="17" y2="9"  stroke="#d1fae5" strokeWidth="0.6" opacity="0.7"/>
    <line x1="14" y1="11" x2="17" y2="11" stroke="#d1fae5" strokeWidth="0.6" opacity="0.7"/>
    {/* Compare bracket arrows */}
    <path d="M7.5 9 L9.5 9 M10.5 9 L12.5 9" stroke="#fbbf24" strokeWidth="1.2" strokeLinecap="round"/>
    <circle cx="10" cy="9" r="1" fill="#fbbf24"/>
    <path d="M9 8.5 L8.2 9 L9 9.5 M11 8.5 L11.8 9 L11 9.5"
          stroke="#fde68a" strokeWidth="0.7" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
  </svg>
);

// Site Metrics — overlapping bar chart + circular gauge accent.
const IconSiteMetrics = ({ className, style }) => (
  <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} style={style}>
    {/* Background bars */}
    <rect x="2"  y="9"  width="2.5" height="8"  rx="0.4" fill="#a78bfa" opacity="0.7"/>
    <rect x="5.2" y="6"  width="2.5" height="11" rx="0.4" fill="#8b5cf6"/>
    <rect x="8.4" y="11" width="2.5" height="6"  rx="0.4" fill="#a78bfa" opacity="0.85"/>
    <rect x="11.6" y="4" width="2.5" height="13" rx="0.4" fill="#7c3aed"/>
    <rect x="14.8" y="8" width="2.5" height="9"  rx="0.4" fill="#a78bfa" opacity="0.85"/>
    {/* Highlights on tallest */}
    <rect x="11.6" y="4" width="2.5" height="0.5" fill="#ddd6fe"/>
    {/* Gauge dot top-right */}
    <circle cx="16.5" cy="3.5" r="1.6" fill="#fbbf24"/>
    <circle cx="16.5" cy="3.5" r="0.7" fill="#fef3c7"/>
  </svg>
);

// Trends — gradient line chart climbing with markers.
const IconTrends = ({ className, style }) => (
  <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} style={style}>
    {/* Background area fill */}
    <path d="M2 16 L2 13 L6 11 L9 12.5 L13 7 L18 4 L18 16 Z" fill="#34d399" opacity="0.18"/>
    {/* Line */}
    <path d="M2 13 L6 11 L9 12.5 L13 7 L18 4" stroke="#10b981" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    {/* Markers */}
    <circle cx="2"  cy="13"   r="1" fill="#34d399" stroke="#064e3b" strokeWidth="0.4"/>
    <circle cx="6"  cy="11"   r="1" fill="#34d399" stroke="#064e3b" strokeWidth="0.4"/>
    <circle cx="9"  cy="12.5" r="1" fill="#34d399" stroke="#064e3b" strokeWidth="0.4"/>
    <circle cx="13" cy="7"    r="1" fill="#34d399" stroke="#064e3b" strokeWidth="0.4"/>
    <circle cx="18" cy="4"    r="1.4" fill="#fbbf24" stroke="#78350f" strokeWidth="0.4"/>
    {/* Baseline */}
    <line x1="1.5" y1="17" x2="18.5" y2="17" stroke="#6ee7b7" strokeWidth="0.7" opacity="0.7"/>
  </svg>
);


// Reconciliation — phosphor pulse cutting through stacked ledger rows.
// Teal rows = static records; amber waveform = live matching across them.
// Reports — stacked report sheets with a colourful bar-chart popping forward.
const IconReports = ({ className, style }) => (
  <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} style={style}>
    {/* Back sheet (offset for depth) */}
    <rect x="6" y="1.5" width="11" height="13" rx="1" fill="#cbd5e1" opacity="0.5"/>
    {/* Middle sheet */}
    <rect x="4.5" y="3" width="11" height="13" rx="1" fill="#94a3b8" opacity="0.7"/>
    {/* Front sheet */}
    <rect x="3" y="4.5" width="11" height="13" rx="1" fill="#f1f5f9"/>
    <rect x="3" y="4.5" width="11" height="2" rx="1" fill="#e2e8f0"/>
    {/* Title lines on front sheet */}
    <line x1="4.5" y1="5.5" x2="11"  y2="5.5" stroke="#475569" strokeWidth="0.5"/>
    {/* Chart bars on the front sheet (colourful) */}
    <rect x="4.5" y="13"   width="1.4" height="3.5" rx="0.2" fill="#f97316"/>
    <rect x="6.4" y="11.5" width="1.4" height="5"   rx="0.2" fill="#10b981"/>
    <rect x="8.3" y="12"   width="1.4" height="4.5" rx="0.2" fill="#3b82f6"/>
    <rect x="10.2" y="9.5" width="1.4" height="7"   rx="0.2" fill="#a855f7"/>
    {/* Trend line over the bars */}
    <path d="M5.2 13 L7.1 11.5 L9 12 L10.9 9.5"
          stroke="#fbbf24" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    {/* Trend dot */}
    <circle cx="10.9" cy="9.5" r="0.8" fill="#fbbf24" stroke="#78350f" strokeWidth="0.3"/>
  </svg>
);

// Operations icon — monitor/heartbeat metaphor. The Operations page is
// "what's the system doing?" so the icon reads as a status display:
// scope screen frame + pulse line + activity dots in indigo.
const IconOperations = ({ className, style }) => (
  <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} style={style}>
    {/* Monitor frame */}
    <rect x="2" y="3" width="16" height="11" rx="1.4" fill="#4f46e5" opacity="0.15"/>
    <rect x="2" y="3" width="16" height="11" rx="1.4" stroke="#818cf8" strokeWidth="0.8" fill="none"/>
    {/* Stand */}
    <line x1="10" y1="14" x2="10" y2="16.5" stroke="#818cf8" strokeWidth="1.1" strokeLinecap="round"/>
    <line x1="6" y1="17" x2="14" y2="17" stroke="#818cf8" strokeWidth="1.1" strokeLinecap="round"/>
    {/* Pulse line across screen */}
    <path d="M3.5 9.5 L6 9.5 L7 7 L9 11 L11 8 L13 10 L16.5 10"
          stroke="#a5b4fc" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    {/* Status dots — green = ok */}
    <circle cx="14.5" cy="5.5" r="0.7" fill="#34d399"/>
    <circle cx="16" cy="5.5" r="0.7" fill="#34d399" opacity="0.5"/>
  </svg>
);

const IconReconciliation = ({ className, style }) => (
  <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} style={style}>
    {/* Subtle ledger frame */}
    <rect x="1.5" y="3" width="17" height="14" rx="1.2" fill="#0d9488" opacity="0.12"/>
    {/* Stacked ledger rows */}
    <line x1="3" y1="5.5"  x2="17" y2="5.5"  stroke="#14b8a6" strokeWidth="0.7" opacity="0.55"/>
    <line x1="3" y1="8"    x2="17" y2="8"    stroke="#14b8a6" strokeWidth="0.7" opacity="0.55"/>
    <line x1="3" y1="12"   x2="17" y2="12"   stroke="#14b8a6" strokeWidth="0.7" opacity="0.55"/>
    <line x1="3" y1="14.5" x2="17" y2="14.5" stroke="#14b8a6" strokeWidth="0.7" opacity="0.55"/>
    {/* Soft phosphor halo behind the pulse */}
    <path d="M1 10 L4 10 L5.5 7 L7.5 13 L9.5 8 L11.5 12 L13.5 9.5 L19 9.5"
          stroke="#f59e0b" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none" opacity="0.25"/>
    {/* Phosphor pulse waveform */}
    <path d="M1 10 L4 10 L5.5 7 L7.5 13 L9.5 8 L11.5 12 L13.5 9.5 L19 9.5"
          stroke="#f59e0b" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    {/* Leading-edge dot */}
    <circle cx="19" cy="9.5" r="1.1" fill="#f59e0b"/>
  </svg>
);
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { lazy, Suspense, useEffect, useState } from "react";
import { useAuth } from "@/lib/AuthContext";
import { hasPermission } from "@/lib/permissions";
import { toast } from "sonner";
import { reportClientError } from "@/lib/clientLog";

const ChangePasswordModal = lazy(() => import("@/components/users/ChangePasswordModal"));
const SettingsPanel = lazy(() => import("@/components/settings/SettingsPanel"));

const APP_VERSION = "2026.3.9";

const navItems = [
  { name: "Customer Management", icon: IconCustomerSearch,        page: "CustomerSearch",   permission: "can_access_customer_search", siteOnly: true },
  // Same icon as the site-mode entry above so the sidebar looks
  // identical regardless of install mode — operator sees one
  // consistent "Customer Management" affordance whether they're on
  // a site or the hub.
  { name: "Customer Management", icon: IconCustomerSearch,        page: "HubDashboard",     hubOnly: true },
  { name: "Customer Balances",   icon: IconCustomerBalances,      page: "CustomerBalances", permission: "can_access_customer_balances" },
  { name: "Collections",         icon: IconCollections,           page: "Collections",      permission: "can_access_collections", siteOnly: true },
  { name: "Inventory",           icon: IconInventory,             page: "Inventory",        permission: "can_access_inventory" },
  { name: "Stock Expiry",        icon: IconInventory,             page: "StockReceiptExpiry", permission: "can_access_stock_receipt_expiry" },
  { name: "Network Devices",     icon: IconNetworkDevices,        page: "NetworkDevices",   permission: "can_access_network_devices" },
  { name: "Reconciliation",      icon: IconReconciliationCompare, page: "HubReconciliation",permission: "can_access_hub_reconciliation", hubOnly: true },
  { name: "Site Metrics",        icon: IconSiteMetrics,           page: "HubMetrics",       permission: "can_access_hub_metrics", hubOnly: true },
  { name: "Site Backups",        icon: IconSiteBackups,           page: "HubBackups",       permission: "can_access_hub_backups", hubOnly: true },
  { name: "Trends",              icon: IconTrends,                page: "HubTrends",        permission: "can_access_hub_trends", hubOnly: true },
  { name: "Credit Debug",        icon: IconCreditDebug,           page: "CreditDebug",      adminOnly: true, siteOnly: true },
  { name: "Reconciliation",      icon: IconReconciliationCompare, page: "Reconciliation",   permission: "can_access_reconciliation", siteOnly: true },
  { name: "JTI",                 icon: IconJti,                   page: "Jti",              permission: "can_access_jti", siteOnly: true },
  { name: "JTI",                 icon: IconJti,                   page: "HubJti",           permission: "can_access_jti", hubOnly: true },
  { name: "Reports",             icon: IconReports,               page: "Reports",          permission: "can_access_reports" },
  // Operations — admin-only home for background job runs, system errors,
  // deploys, and (in hub mode) per-site sync log. Same admin gating as
  // Credit Debug — hidden from the sidebar for non-admins; the page also
  // self-guards so direct URL access shows a clear "admin only" message.
  { name: "Operations",          icon: IconOperations,            page: "Operations",       adminOnly: true },
];

export default function Layout({ children, currentPageName }) {
  const [isCollapsed, setIsCollapsed]       = useState(true);
  const [theme, setTheme]                   = useState(() => localStorage.getItem('cardoso-theme') || 'dark');
  const [hubMode, setHubMode]               = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [settingsOpen, setSettingsOpen]     = useState(false);
  const [isSavingPassword, setIsSavingPassword] = useState(false);
  const [versionStatus, setVersionStatus]   = useState({
    currentVersion: APP_VERSION,
    latestVersion:  APP_VERSION,
    updateAvailable: false,
  });
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [showUpdateConfirm, setShowUpdateConfirm] = useState(false);
  const [backupAttention, setBackupAttention] = useState(false);
  const [, setBuildClickCount] = useState(0);
  const [showBuildDiagnostics, setShowBuildDiagnostics] = useState(false);
  const [layoutStartedAt] = useState(() => new Date());
  // Sage MSSQL connectivity. When the pool has been failing for >5 min the
  // server-side probe sets attention=true; we render a top-of-page banner
  // so an operator notices before they start chasing "missing credit notes"
  // that's actually just a dead Sage connection. Site-mode only — the hub
  // doesn't have a Sage connection.
  const [sageHealth, setSageHealth] = useState(null);

  const { user: currentUser, logout } = useAuth();
  const isAdmin = currentUser?.role === "admin";

  useEffect(() => {
    fetch("/api/app-info")
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.hub_mode) setHubMode(true); })
      .catch(err => reportClientError("Layout.appInfo", err));
  }, []);

  useEffect(() => {
    if (!currentUser) return;
    let isMounted = true;
    fetch("/api/app-version-status", { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d && isMounted) setVersionStatus({
          currentVersion:  d.currentVersion  || APP_VERSION,
          latestVersion:   d.latestVersion   || APP_VERSION,
          updateAvailable: Boolean(d.updateAvailable),
        });
      })
      .catch(err => reportClientError("Layout.versionStatus", err));
    return () => { isMounted = false; };
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser || !hubMode || !isAdmin) {
      setBackupAttention(false);
      return;
    }

    let cancelled = false;

    const pollBackupAttention = async () => {
      try {
        const res = await fetch("/api/hub/backup-status", { credentials: "include" });
        const data = res.ok ? await res.json() : null;
        if (!cancelled) setBackupAttention(Boolean(data?.sql_attention));
      } catch {
        if (!cancelled) setBackupAttention(true);
      }
    };

    pollBackupAttention();
    const timer = setInterval(pollBackupAttention, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [currentUser, hubMode, isAdmin]);

  // Sage health poll — site mode only, only for users who can see BAT
  // (otherwise we'd be making a permission-gated API call that 403s on
  // every tick for non-BAT users, polluting their browser console).
  useEffect(() => {
    if (!currentUser || hubMode) {
      setSageHealth(null);
      return;
    }
    const canSeeBat = isAdmin || hasPermission(currentUser, "can_access_reconciliation");
    if (!canSeeBat) return;

    let cancelled = false;
    const pollSage = async () => {
      try {
        const res = await fetch("/api/bat/sage-health", { credentials: "include" });
        const data = res.ok ? await res.json() : null;
        if (!cancelled) setSageHealth(data);
      } catch {
        // Network blip — don't mark Sage as down on a transient client-side
        // fetch failure; the next tick will catch a real outage.
      }
    };
    pollSage();
    const timer = setInterval(pollSage, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [currentUser, hubMode, isAdmin]);

  const triggerUpdate = async () => {
    if (!isAdmin || updateInstalling) return;
    setShowUpdateConfirm(true);
  };

  const handleBuildBadgeClick = () => {
    setBuildClickCount((count) => {
      const next = count + 1;
      if (next >= 7) {
        setShowBuildDiagnostics(true);
        return 0;
      }
      return next;
    });

    if (versionStatus.updateAvailable && isAdmin && !showUpdateConfirm) {
      triggerUpdate();
    }
  };

  const confirmUpdate = async () => {
    setShowUpdateConfirm(false);
    setUpdateInstalling(true);
    try {
      const res = await fetch('/api/app-update-trigger', { method: 'POST', credentials: 'include' });
      const data = await res.json();
      if (!res.ok) {
        setUpdateInstalling(false);
      }
    } catch (e) {
      setUpdateInstalling(false);
    }
  };

  const handleChangePassword = async (userId, newPassword) => {
    setIsSavingPassword(true);
    try {
      const res = await fetch(`/api/users/${userId}/password`, {
        method: "PUT", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: newPassword }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || "Failed"); }
      setChangePasswordOpen(false);
    } catch (err) { alert(err.message); }
    finally { setIsSavingPassword(false); }
  };

  const canShowNavItem = (item) => {
    if (!currentUser) return false;
    if (item.hubOnly && !hubMode) return false;
    if (item.siteOnly && hubMode) return false;
    if (item.adminOnly && !isAdmin) return false;
    if (item.permission) return hasPermission(currentUser, item.permission);
    return true;
  };

  const visibleNavItems = navItems.filter(canShowNavItem);
  const canSeeSettings  = isAdmin
    || hasPermission(currentUser, "can_access_settings")
    || hasPermission(currentUser, "can_manage_users")
    || hasPermission(currentUser, "can_manage_rules");

  return (
    <div className="min-h-screen bg-background text-foreground">
      <aside
        className={cn(
          "fixed top-0 left-0 z-50 hidden h-full flex-col lg:flex transition-all duration-300 ease-out",
          isCollapsed ? "w-14" : "w-60"
        )}
        style={{
          background: "hsl(var(--sidebar-background))",
          color: "hsl(var(--sidebar-foreground))",
          borderRight: "1px solid hsl(var(--sidebar-border))",
        }}
      >
        {/* ── Brand block ── */}
        <div className="px-3 pt-6 pb-5" style={{ borderBottom: "1px solid hsl(var(--sidebar-border))" }}>
          <div className={cn("flex items-center", isCollapsed ? "justify-center" : "gap-3")}>
            {/* Signature phosphor square */}
            <div
              className="shrink-0"
              style={{
                width: "22px",
                height: "22px",
                background: "var(--phosphor)",
                boxShadow: "0 0 20px hsla(33, 95%, 55%, 0.5)",
              }}
            />
            <div
              className={cn(
                "min-w-0 overflow-hidden transition-all duration-200 ease-out",
                isCollapsed ? "w-0 opacity-0" : "w-full opacity-100"
              )}
            >
              <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-[hsl(var(--sidebar-foreground))/0.6] whitespace-nowrap">
                Cardoso Cigarettes
              </div>
              <div className="font-display text-lg leading-tight text-[hsl(var(--sidebar-foreground))] whitespace-nowrap">
                Ledger
              </div>
            </div>
          </div>
          {currentUser && !isCollapsed && (
            <div className="mt-6 space-y-1">
              <p
                className="truncate font-mono text-[10px] uppercase tracking-[0.2em]"
                style={{ color: "hsla(var(--sidebar-foreground), 0.5)" }}
              >
                Operator
              </p>
              <p className="truncate text-xs font-medium text-[hsl(var(--sidebar-foreground))]">
                {currentUser.full_name || "User"}
              </p>
              <p className="truncate font-mono text-[10px]" style={{ color: "hsla(var(--sidebar-foreground), 0.45)" }}>
                {currentUser.email}
              </p>
            </div>
          )}
        </div>

        {/* ── Nav items — terminal list with phosphor left-bar on active ── */}
        <nav className={cn("flex-1 overflow-y-auto", isCollapsed ? "py-3 px-1 flex flex-col items-center" : "py-3 px-3")}>
          {!isCollapsed && (
            <div
              className="px-2 pb-2 mb-1 font-mono text-[9px] uppercase tracking-[0.25em]"
              style={{ color: "hsla(var(--sidebar-foreground), 0.4)" }}
            >
              § Navigation
            </div>
          )}
          <div className={cn("space-y-0.5", isCollapsed && "flex flex-col items-center w-full")}>
            {visibleNavItems.map((item) => {
              const isActive = currentPageName === item.page;
              const showAttention = item.page === "HubBackups" && backupAttention;
              return (
                <Link
                  key={item.page}
                  to={`/${item.page}`}
                  title={isCollapsed ? item.name : undefined}
                  className={cn(
                    "relative flex items-center text-xs font-medium transition-colors duration-150 group",
                    isCollapsed ? "justify-center w-10 h-10 mx-auto" : "gap-3 pl-4 pr-2 py-2.5 w-full text-sm"
                  )}
                  style={{
                    color: isActive
                      ? "hsl(var(--sidebar-accent-foreground))"
                      : "hsla(var(--sidebar-foreground), 0.65)",
                    background: isActive ? "hsl(var(--sidebar-accent))" : "transparent",
                  }}
                  onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.color = "hsl(var(--sidebar-foreground))"; }}
                  onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.color = "hsla(var(--sidebar-foreground), 0.65)"; }}
                >
                  {/* Phosphor active indicator — left bar */}
                  {isActive && (
                    <span
                      className="absolute left-0 top-1 bottom-1 w-[2px]"
                      style={{
                        background: "var(--phosphor)",
                        boxShadow: "0 0 12px hsla(33, 95%, 55%, 0.7)",
                      }}
                    />
                  )}
                  <item.icon className="h-6 w-6 shrink-0" />
                  {showAttention && (
                    <span
                      className={cn(
                        "absolute inline-flex h-1.5 w-1.5",
                        isCollapsed ? "top-1.5 right-1.5" : "top-2.5 right-2.5"
                      )}
                      style={{
                        background: "var(--phosphor)",
                        boxShadow: "0 0 8px hsla(33, 95%, 55%, 0.8)",
                      }}
                    />
                  )}
                  <span
                    className={cn(
                      "overflow-hidden whitespace-nowrap transition-all duration-200 ease-out tracking-tight",
                      isCollapsed ? "w-0 opacity-0" : "opacity-100"
                    )}
                  >
                    {item.name}
                  </span>
                </Link>
              );
            })}
          </div>
        </nav>
        <div
          className={cn(isCollapsed ? "p-1 flex flex-col items-center space-y-0.5" : "space-y-0 p-3")}
          style={{ borderTop: "1px solid hsl(var(--sidebar-border))" }}
        >
          {!isCollapsed && (
            <div
              className="px-2 pb-2 font-mono text-[9px] uppercase tracking-[0.25em]"
              style={{ color: "hsla(var(--sidebar-foreground), 0.4)" }}
            >
              § Controls
            </div>
          )}
          {canSeeSettings && (
            <SidebarButton
              onClick={() => setSettingsOpen(true)}
              icon={Settings}
              label="Settings"
              collapsed={isCollapsed}
            />
          )}

          <SidebarButton
            onClick={() => {
              const next = theme === 'dark' ? 'light' : 'dark';
              setTheme(next);
              applyTheme(next);
              fetch('/api/auth/me', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ theme_preference: next }) })
                .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); })
                .catch(err => { toast.error(`Couldn't save theme: ${err.message}`); reportClientError("Layout.themeSave", err); });
            }}
            icon={theme === 'dark' ? Sun : Moon}
            label={theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
            collapsed={isCollapsed}
          />

          <SidebarButton
            onClick={() => setChangePasswordOpen(true)}
            icon={KeyRound}
            label="Password"
            collapsed={isCollapsed}
          />

          <SidebarButton
            onClick={() => logout(true)}
            icon={LogOut}
            label="Logout"
            collapsed={isCollapsed}
          />

          <SidebarButton
            onClick={() => setIsCollapsed(!isCollapsed)}
            icon={isCollapsed ? ChevronRight : ChevronLeft}
            label="Collapse"
            collapsed={isCollapsed}
          />

          <div className={cn("overflow-hidden transition-all duration-200 ease-out", isCollapsed ? "max-h-0 opacity-0" : "max-h-24 opacity-100")}>
            <div
              className={cn(
                "mt-3 mx-1 px-2 py-1.5 transition-colors font-mono text-[9px] uppercase tracking-[0.2em]",
                versionStatus.updateAvailable && isAdmin ? "cursor-pointer" : ""
              )}
              style={{
                borderLeft: versionStatus.updateAvailable
                  ? "2px solid var(--phosphor)"
                  : "2px solid transparent",
                color: versionStatus.updateAvailable
                  ? "var(--phosphor)"
                  : "hsla(var(--sidebar-foreground), 0.35)",
                background: versionStatus.updateAvailable && isAdmin
                  ? "hsla(33, 95%, 55%, 0.05)"
                  : "transparent",
              }}
              title={
                versionStatus.updateAvailable
                  ? isAdmin
                    ? updateInstalling
                      ? "Installing update…"
                      : `New: v${versionStatus.latestVersion} — click to install`
                    : `New: v${versionStatus.latestVersion}`
                  : `v${versionStatus.currentVersion} — shipped with care. Probably coffee.`
              }
              onClick={handleBuildBadgeClick}
            >
              <div className="flex items-center justify-between">
                <span>Build</span>
                <span className="tabular-nums" style={{ color: "hsla(var(--sidebar-foreground), 0.55)" }}>
                  v{versionStatus.currentVersion}
                </span>
              </div>
              {versionStatus.updateAvailable && (
                updateInstalling
                  ? <p className="mt-1 animate-pulse">Installing…</p>
                  : showUpdateConfirm
                  ? (
                    <div className="mt-1.5 flex gap-1">
                      <button
                        onClick={(e) => { e.stopPropagation(); confirmUpdate(); }}
                        className="flex-1 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.2em] border border-current hover:bg-current hover:text-[hsl(var(--sidebar-background))] transition-colors"
                      >Install</button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setShowUpdateConfirm(false); }}
                        className="flex-1 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.2em] hover:bg-[hsl(var(--sidebar-accent))] transition-colors"
                        style={{ color: "hsla(var(--sidebar-foreground), 0.6)" }}
                      >Cancel</button>
                    </div>
                  )
                  : <p className="mt-1">→ v{versionStatus.latestVersion} available{isAdmin ? " · click" : ""}</p>
              )}
            </div>
          </div>
        </div>
      </aside>
      <header
        className="fixed left-0 right-0 top-0 z-50 flex h-14 items-center justify-between px-4 lg:hidden"
        style={{ background: "hsl(var(--sidebar-background))", borderBottom: "1px solid hsl(var(--sidebar-border))", color: "hsl(var(--sidebar-foreground))" }}
      >
        <div className="flex items-center gap-3">
          <div
            style={{
              width: "18px",
              height: "18px",
              background: "var(--phosphor)",
              boxShadow: "0 0 16px hsla(33, 95%, 55%, 0.5)",
            }}
          />
          <div className="flex flex-col leading-tight">
            <span className="font-mono text-[9px] uppercase tracking-[0.25em]" style={{ color: "hsla(var(--sidebar-foreground), 0.55)" }}>Cardoso Cigarettes</span>
            <span className="font-display text-base">Ledger</span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {canSeeSettings && (
            <Button variant="ghost" size="icon" onClick={() => setSettingsOpen(true)}><Settings className="h-5 w-5 text-amber-400" /></Button>
          )}
          <Button variant="ghost" size="icon" onClick={() => { const next = theme === 'dark' ? 'light' : 'dark'; setTheme(next); applyTheme(next); fetch('/api/auth/me', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ theme_preference: next }) }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); }).catch(err => { toast.error(`Couldn't save theme: ${err.message}`); reportClientError("Layout.themeSave", err); }); }} title={theme === 'dark' ? 'Light Mode' : 'Dark Mode'}>
            {theme === 'dark' ? <Sun className="h-5 w-5 text-accent" /> : <Moon className="h-5 w-5 text-muted-foreground" />}
          </Button>
          <Button variant="ghost" size="icon" onClick={() => setChangePasswordOpen(true)} title="Change Password">
            <KeyRound className="h-5 w-5 text-muted-foreground" />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => logout(true)} title="Logout">
            <LogOut className="h-5 w-5 text-muted-foreground" />
          </Button>
        </div>
      </header>
      <nav className="fixed bottom-0 left-0 right-0 z-50 flex items-center border-t border-border bg-card px-2 py-2 lg:hidden overflow-x-auto">
        {visibleNavItems.map((item) => {
          const isActive = currentPageName === item.page;
          const showAttention = item.page === "HubBackups" && backupAttention;
          return (
            <Link key={item.page} to={`/${item.page}`}
              className={cn("relative flex flex-col items-center gap-1 rounded-xl px-3 py-2 transition-all flex-shrink-0", isActive ? "text-foreground" : "text-muted-foreground")}>
              <item.icon className="h-5 w-5" style={!isActive && item.color ? { color: item.color } : undefined} />
              {showAttention && <span className="absolute top-1.5 right-2.5 inline-flex h-2.5 w-2.5 rounded-full bg-amber-400 ring-2 ring-card" />}
              <span className="text-xs font-medium truncate max-w-[60px] text-center">{item.name}</span>
            </Link>
          );
        })}
      </nav>
      <main className={cn("bg-background pt-16 pb-[calc(5rem+env(safe-area-inset-bottom))] transition-all duration-300 lg:pt-0 lg:pb-0", isCollapsed ? "lg:ml-14" : "lg:ml-60")}>
        {sageHealth?.attention && (
          <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.15em] text-destructive flex items-center gap-3">
            <span className="inline-flex h-2 w-2 rounded-full bg-destructive animate-pulse" />
            <span>
              Sage unreachable for {sageHealth.downForMinutes} min · {sageHealth.consecutiveFailures} failed probes
              {sageHealth.lastError && <span className="ml-2 normal-case tracking-normal text-destructive/70">({sageHealth.lastError})</span>}
            </span>
          </div>
        )}
        {children}
      </main>
      {currentUser && changePasswordOpen && (
        <Suspense fallback={null}>
          <ChangePasswordModal
            user={currentUser}
            open={changePasswordOpen}
            onClose={() => setChangePasswordOpen(false)}
            onSave={handleChangePassword}
            isSaving={isSavingPassword}
          />
        </Suspense>
      )}

      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsPanel
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            hubMode={hubMode}
          />
        </Suspense>
      )}

      {showBuildDiagnostics && (
        <div className="fixed inset-0 z-[1002] flex items-center justify-center bg-background/60 px-6 backdrop-blur-sm">
          <div className="w-full max-w-md border border-border bg-card p-5 shadow-[0_0_36px_hsla(33,95%,55%,0.18)]">
            <div className="mb-4 flex items-start justify-between gap-4 border-b border-border pb-3">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-accent">
                  Build diagnostics
                </div>
                <h2 className="mt-2 font-display text-2xl text-foreground">Operator mode: calm</h2>
              </div>
              <button
                type="button"
                onClick={() => setShowBuildDiagnostics(false)}
                className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground transition-colors hover:text-foreground"
              >
                Close
              </button>
            </div>
            <dl className="grid grid-cols-[110px_1fr] gap-x-4 gap-y-3 font-mono text-[10px] uppercase tracking-[0.14em]">
              <dt className="text-muted-foreground">Current</dt>
              <dd className="text-foreground tabular-nums">v{versionStatus.currentVersion}</dd>
              <dt className="text-muted-foreground">Latest</dt>
              <dd className="text-foreground tabular-nums">v{versionStatus.latestVersion}</dd>
              <dt className="text-muted-foreground">Mode</dt>
              <dd className="text-foreground">{hubMode ? "Hub" : "Site"}</dd>
              <dt className="text-muted-foreground">Role</dt>
              <dd className="text-foreground">{currentUser?.role || "Unknown"}</dd>
              <dt className="text-muted-foreground">Uptime</dt>
              <dd className="text-foreground">{Math.max(1, Math.round((Date.now() - layoutStartedAt.getTime()) / 60000))} min</dd>
              <dt className="text-muted-foreground">Status</dt>
              <dd className="text-foreground">{versionStatus.updateAvailable ? "Update waiting" : "Current"}</dd>
            </dl>
          </div>
        </div>
      )}
    </div>
  );
}

function SidebarButton({ onClick, icon: Icon, label, collapsed }) {
  return (
    <button
      onClick={onClick}
      title={collapsed ? label : undefined}
      className={cn(
        "flex items-center text-xs font-medium transition-colors duration-150 w-full",
        collapsed ? "justify-center w-10 h-10" : "gap-3 pl-4 pr-2 py-2.5"
      )}
      style={{ color: "hsla(var(--sidebar-foreground), 0.55)" }}
      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--phosphor)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = "hsla(var(--sidebar-foreground), 0.55)"; }}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className={cn("overflow-hidden whitespace-nowrap tracking-tight", collapsed ? "w-0 opacity-0" : "opacity-100")}>
        {label}
      </span>
    </button>
  );
}
