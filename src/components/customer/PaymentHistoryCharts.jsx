// Lazy-loaded chart used inside CustomerLookup. Splitting it out keeps Recharts
// (~100 KB) off the initial bundle for the default landing page.

import { BarChart, Bar, XAxis, YAxis, Tooltip, Cell, ResponsiveContainer } from 'recharts';

export default function PaymentHistoryCharts({ lagData }) {
  const barColor = (lagDays) => {
    if (lagDays <= 7) return '#22c55e';
    if (lagDays <= 21) return '#f59e0b';
    return '#ef4444';
  };

  if (!lagData?.length) return null;

  return (
    <div className="mb-4 rounded-xl border border-border bg-muted/40 p-4">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Payment Lag History</p>
      <ResponsiveContainer width="100%" height={120}>
        <BarChart data={lagData} margin={{ top: 4, right: 4, left: -20, bottom: 4 }}>
          <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} unit="d" />
          <Tooltip
            contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 6, fontSize: 11 }}
            labelStyle={{ color: 'hsl(var(--foreground))' }}
            formatter={(val) => [`${val} days`, 'Lag']}
          />
          <Bar dataKey="lagDays" radius={[3, 3, 0, 0]}>
            {lagData.map((entry, index) => (
              <Cell key={index} fill={barColor(entry.lagDays)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
