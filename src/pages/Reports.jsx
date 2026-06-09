import { lazy, Suspense, Fragment, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Wallet, Users, BarChart3, PieChart, AlertTriangle, Boxes, Receipt, CalendarDays } from 'lucide-react';
import { api } from '@/api/apiClient';
import { hasPermission } from '@/lib/permissions';
import SavedViews from '@/components/reports/SavedViews';

// Each report pulls in recharts and bespoke logic; lazy-load so the
// active report is the only chunk fetched, instead of shipping all six
// on first paint.
const AgedDebtors      = lazy(() => import('@/components/reports/AgedDebtors'));
const AgedCreditors    = lazy(() => import('@/components/reports/AgedCreditors'));
const SalesRepExposure = lazy(() => import('@/components/reports/SalesRepExposure'));
const BatWeekly        = lazy(() => import('@/components/reports/BatWeekly'));
const BatYtd           = lazy(() => import('@/components/reports/BatYtd'));
const BatExceptions    = lazy(() => import('@/components/reports/BatExceptions'));
const InventoryValue   = lazy(() => import('@/components/reports/InventoryValue'));
const DailySalesFigures = lazy(() => import('@/components/reports/DailySalesFigures'));

const REPORTS = [
  {
    group: 'Accounts Receivable',
    accent: 'hsl(33 95% 55%)',
    items: [
      { id: 'aged-debtors', name: 'Aged Debtors',       icon: Wallet,       accent: 'hsl(33 95% 55%)',  component: AgedDebtors,       ready: true },
      { id: 'rep-exposure', name: 'Sales Rep Exposure', icon: Users,        accent: 'hsl(200 80% 55%)', component: SalesRepExposure,  ready: true },
      { id: 'daily-sales',  name: 'Daily Sales Figures', icon: CalendarDays, accent: 'hsl(145 55% 45%)', component: DailySalesFigures, ready: true },
    ],
  },
  {
    group: 'Accounts Payable',
    accent: 'hsl(280 70% 65%)',
    items: [
      { id: 'aged-creditors', name: 'Aged Creditors', icon: Receipt, accent: 'hsl(280 70% 65%)', component: AgedCreditors, ready: true },
    ],
  },
  {
    group: 'BAT Reconciliation',
    accent: 'hsl(33 95% 55%)',
    items: [
      { id: 'bat-weekly',     name: 'Weekly Reconciliation', icon: BarChart3,     accent: 'hsl(33 95% 55%)',  component: BatWeekly,     ready: true },
      { id: 'bat-ytd',        name: 'YTD Fee Breakdown',     icon: PieChart,      accent: 'hsl(280 70% 65%)', component: BatYtd,        ready: true },
      { id: 'bat-exceptions', name: 'Exceptions Summary',    icon: AlertTriangle, accent: 'hsl(0 72% 50%)',   component: BatExceptions, ready: true },
    ],
  },
  {
    group: 'Inventory',
    accent: 'hsl(145 55% 45%)',
    items: [
      { id: 'inv-value', name: 'Value & Composition', icon: Boxes, accent: 'hsl(145 55% 45%)', component: InventoryValue, ready: true },
    ],
  },
];

export default function Reports() {
  const { data: currentUser } = useQuery({ queryKey: ["currentUser"], queryFn: () => api.auth.me(), staleTime: Infinity });
  // Daily Sales Figures exposes the same posted-document figures as Monthly Sales
  // Figures, so it sits behind can_access_monthly_reports. Hide it (and block a
  // direct ?report=daily-sales) for Reports-only users, matching the API guard.
  const canMonthly = hasPermission(currentUser, 'can_access_monthly_reports');
  const groups = useMemo(
    () => REPORTS
      .map((g) => ({ ...g, items: g.items.filter((it) => it.id !== 'daily-sales' || canMonthly) }))
      .filter((g) => g.items.length > 0),
    [canMonthly],
  );
  const allItems = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  // The active report lives in the URL (?report=<id>) so dashboard deep-links,
  // saved views, and browser back/forward all work and the view is shareable.
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('report');
  const activeId = allItems.some(i => i.id === requested) ? requested : 'aged-debtors';
  const setActiveId = (id) =>
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('report', id);
      return next;
    }, { replace: true });
  const active = allItems.find(i => i.id === activeId);

  return (
    <div
      className="min-h-screen bg-background"
      style={{ background: 'hsl(var(--background))', color: 'hsl(var(--foreground))' }}
    >
      <div className="px-6 py-6">
        <div className="report-print-hide border-b border-border pb-5 mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>

            <h1 className="font-display text-4xl lg:text-5xl leading-tight tracking-tight text-foreground">
              The <em className="text-phosphor">printable</em> archive.
            </h1>
            <p className="text-sm text-muted-foreground mt-3">
              Operational, accounting and reconciliation reports. Each report is filterable, chartable and printable.
            </p>
          </div>
          <SavedViews />
        </div>

        {/* Report selector — a horizontal toolbar across the top, so the report
            itself gets the full width of the page instead of a second sidebar
            competing with the app nav. Wraps on narrow screens. */}
        <div className="report-print-hide mb-5 flex flex-wrap items-center gap-x-1.5 gap-y-2 border-b border-border pb-4">
          {groups.map((group, gi) => (
            <Fragment key={group.group}>
              {gi > 0 && <span className="mx-1.5 hidden h-5 w-px self-center bg-border sm:block" aria-hidden />}
              <span className="mr-0.5 font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground/50">{group.group}</span>
              {group.items.map((item) => {
                const Icon = item.icon;
                const isActive = activeId === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => item.ready && setActiveId(item.id)}
                    disabled={!item.ready}
                    title={item.name}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors ${
                      isActive ? 'bg-card' : 'border-border text-foreground/80 hover:bg-card/60'
                    } ${!item.ready ? 'cursor-not-allowed opacity-40' : ''}`}
                    style={isActive ? { borderColor: item.accent, color: item.accent } : undefined}
                  >
                    <Icon className="h-3.5 w-3.5" style={{ color: item.accent }} strokeWidth={isActive ? 2 : 1.5} />
                    {item.name}
                    {!item.ready && <span className="ml-0.5 text-[8px] text-muted-foreground/60">soon</span>}
                  </button>
                );
              })}
            </Fragment>
          ))}
        </div>

        <main>
          {active?.component ? (
            <Suspense fallback={
              <div className="bg-card border border-border p-12 text-center text-muted-foreground" style={{ borderRadius: '12px' }}>
                <p className="font-mono text-[11px] uppercase tracking-[0.2em]">Loading report…</p>
              </div>
            }>
              <active.component />
            </Suspense>
          ) : (
            <div className="bg-card border border-border p-12 text-center text-muted-foreground" style={{ borderRadius: '12px' }}>
              <p className="font-mono text-[11px] uppercase tracking-[0.2em]">Select a report above.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
