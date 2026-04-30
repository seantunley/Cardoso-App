import { useState } from 'react';
import { Wallet, Users, BarChart3, PieChart, AlertTriangle, Boxes, ChevronRight } from 'lucide-react';
import AgedDebtors from '@/components/reports/AgedDebtors';
import SalesRepExposure from '@/components/reports/SalesRepExposure';
import BatWeekly from '@/components/reports/BatWeekly';
import BatYtd from '@/components/reports/BatYtd';
import BatExceptions from '@/components/reports/BatExceptions';
import InventoryValue from '@/components/reports/InventoryValue';

const REPORTS = [
  {
    group: 'Accounts Receivable',
    accent: 'hsl(33 95% 55%)',
    items: [
      { id: 'aged-debtors', name: 'Aged Debtors',       icon: Wallet, accent: 'hsl(33 95% 55%)',  component: AgedDebtors,       ready: true },
      { id: 'rep-exposure', name: 'Sales Rep Exposure', icon: Users,  accent: 'hsl(200 80% 55%)', component: SalesRepExposure,  ready: true },
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
  const [activeId, setActiveId] = useState('aged-debtors');
  const active = ALL_ITEMS.find(i => i.id === activeId);

  return (
    <div
      className="min-h-screen bg-background"
      style={{ background: 'hsl(var(--background))', color: 'hsl(var(--foreground))' }}
    >
      <div className="px-6 py-6">
        <div className="report-print-hide border-b border-border pb-5 mb-5">
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-3">§ Reports</div>
          <h1 className="font-display text-4xl lg:text-5xl leading-tight tracking-tight text-foreground">
            The <em className="text-phosphor">printable</em> archive.
          </h1>
          <p className="text-sm text-muted-foreground mt-3">
            Operational, accounting and reconciliation reports. Each report is filterable, chartable and printable.
          </p>
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
            {active?.component ? <active.component /> : (
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
