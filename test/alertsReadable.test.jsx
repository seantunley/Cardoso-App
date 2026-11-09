// @vitest-environment jsdom
// Alerts are readable where admins already look: the Operations health panel
// lists each alert's message with Acknowledge — for admins only. Non-admins
// keep the count (src/components/health/SageHealthPanel.jsx).
//
// Uses the REAL AuthProvider (fed by a mocked /api/auth/me) rather than a
// hand-written useAuth mock — an earlier mock used the wrong property name and
// hid a bug that made isAdmin always false.

import { it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '../src/lib/AuthContext.jsx';
import SageHealthPanel from '../src/components/health/SageHealthPanel.jsx';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const health = (alerts, count = alerts?.length ?? 0) => ({
  status: 'warn', sage: { ok: true }, sources: [], connections: [], errors24h: 0, recentErrors: [], jobFailures24h: 0,
  activeAlerts: count, criticalAlerts: 0, ...(alerts ? { alerts } : {}), backup: null,
});
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function setup(role, healthFor) {
  const calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, opts = {}) => {
    const u = String(url);
    calls.push([u, opts.method || 'GET']);
    if (u.endsWith('/api/auth/me')) return json({ id: 1, email: 'x@y', role });
    return healthFor(u, opts);
  });
  render(
    <AuthProvider>
      <QueryClientProvider client={new QueryClient()}><SageHealthPanel /></QueryClientProvider>
    </AuthProvider>,
  );
  return calls;
}

it('admin: lists alert messages and acknowledges one', async () => {
  let current = [{ id: 7, rule_name: 'customer-sync-stale', severity: 'warning', message: "Customer sync 'Customer CARDAT' last synced successfully 30.0 hours ago", fired_at: '2026-11-08T08:00:00Z' }];
  const calls = setup('admin', (u) => {
    if (u.endsWith('/acknowledge')) { current = []; return json({ ok: true }); }
    return json(health(current));
  });

  fireEvent.click(await screen.findByText('Active alerts'));
  expect(await screen.findByText(/Customer sync 'Customer CARDAT' last synced successfully 30.0 hours ago/)).toBeTruthy();

  fireEvent.click(await screen.findByText('Acknowledge')); // only appears once the real auth says admin
  await waitFor(() => expect(screen.getByText('No active alerts.')).toBeTruthy());
  expect(calls).toContainEqual(['/api/system/alerts/7/acknowledge', 'POST']);
});

it('non-admin: sees only the count, and no Acknowledge button', async () => {
  setup('user', () => json(health(undefined, 2)));
  fireEvent.click(await screen.findByText('Active alerts'));
  expect(await screen.findByText(/2 active alerts — an administrator can see the details here/)).toBeTruthy();
  expect(screen.queryByText('Acknowledge')).toBeNull();
});
