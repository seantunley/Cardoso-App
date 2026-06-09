import { lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Wallet, Users, BarChart3, PieChart, AlertTriangle, Boxes, Receipt, ChevronRight, CalendarDays } from 'lucide-react';
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

const ALL_ITEMS = REPORTS.flatMap(g => g.items);

export default function Reports() {
  // The active report lives in the URL (?report=<id>) so dashboard deep-links,
  // saved views, and browser back/forward all work and the view is shareable.
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('report');
  const activeId = ALL_ITEMS.some(i => i.id === requested) ? requested : 'aged-debtors';
  const setActiveId = (id) =>
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('report', id);
      return next;
    }, { replace: true });
  const active = ALL_ITEMS.find(i => i.id === activeId);

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

        <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
          <aside className="report-print-hide space-y-5">
            {REPORTS.map(group => (
              <div key={group.group}>
                <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground mb-2 px-1">
                  {group.group}
                </div>
                <ul className="space-y-px">
                  {group.items.map(item => {
                    const Icon = item.icon;
                    const isActive = activeId === item.id;
                    return (
                      <li key={item.id}>
                        <button
                          onClick={() => item.ready && setActiveId(item.id)}
                          disabled={!item.ready}
                          className={`group w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left transition-all ${
                            isActive ? 'bg-card' : 'hover:bg-card/50'
                          } ${!item.ready ? 'opacity-40 cursor-not-allowed' : ''}`}
                          style={{
                            border: isActive ? `1px solid ${item.accent}` : '1px solid transparent',
                            borderLeftWidth: isActive ? '2px' : '1px',
                            borderRadius: '12px',
                            boxShadow: isActive ? `0 0 12px ${item.accent}25` : 'none',
                          }}
                        >
                          <span className="flex items-center gap-2.5">
                            <Icon className="h-4 w-4" style={{ color: item.accent }} strokeWidth={isActive ? 2 : 1.5} />
                            <span
                              className="font-mono text-[11px] uppercase tracking-[0.15em]"
                              style={{ color: isActive ? item.accent : 'hsl(var(--foreground))' }}
                            >
                              {item.name}
                            </span>
                          </span>
                          {!item.ready && (
                            <span className="font-mono text-[9px] uppercase tracking-[0.15em] text-muted-foreground/60">soon</span>
                          )}
                          {item.ready && isActive && (
                            <ChevronRight className="h-3 w-3" style={{ color: item.accent }} />
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </aside>

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
                <p className="font-mono text-[11px] uppercase tracking-[0.2em]">Select a report from the left.</p>
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
