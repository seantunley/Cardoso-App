// @vitest-environment jsdom
// Alerts are readable where admins already look: the Operations health panel
// lists each alert's message with Acknowledge (src/components/health/SageHealthPanel.jsx).

import { it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import SageHealthPanel from '../src/components/health/SageHealthPanel.jsx';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const health = (alerts) => ({
  status: 'warn', sage: { ok: true }, sources: [], connections: [], errors24h: 0, recentErrors: [], jobFailures24h: 0,
  activeAlerts: alerts.length, criticalAlerts: 0, alerts, backup: null,
});

it('lists alert messages and acknowledges one', async () => {
  let current = [{ id: 7, rule_name: 'customer-sync-stale', severity: 'warning', message: "Customer sync 'Customer CARDAT' last synced successfully 30.0 hours ago", fired_at: '2026-11-08T08:00:00Z' }];
  const calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, opts = {}) => {
    calls.push([String(url), opts.method || 'GET']);
    if (String(url).endsWith('/acknowledge')) { current = []; return new Response(JSON.stringify({ ok: true }), { status: 200 }); }
    return new Response(JSON.stringify(health(current)), { status: 200 });
  });
  render(<QueryClientProvider client={new QueryClient()}><SageHealthPanel /></QueryClientProvider>);

  fireEvent.click(await screen.findByText('Active alerts'));
  expect(await screen.findByText(/Customer sync 'Customer CARDAT' last synced successfully 30.0 hours ago/)).toBeTruthy();

  fireEvent.click(screen.getByText('Acknowledge'));
  await waitFor(() => expect(screen.getByText('No active alerts.')).toBeTruthy());
  expect(calls).toContainEqual(['/api/system/alerts/7/acknowledge', 'POST']);
});
