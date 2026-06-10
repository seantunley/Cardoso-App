// Money-path smoke tests — the flows where a UI regression means an operator
// can't reach (or can't trust) the numbers:
//   1. Login rejects bad credentials VISIBLY (no-silent-failures rule).
//   2. Bootstrap login → forced password change (the CRIT-2 path) → app loads
//      → Customer Balances renders rather than crashing on an empty DB.
// Selectors target real strings from Login.jsx / ForcePasswordChangeModal.jsx /
// CustomerBalancesHeader.jsx — update them together with those components.
import { test, expect } from '@playwright/test';

const NEW_PASSWORD = 'e2e-Sm0ke!pass';

test.describe.serial('money-path smokes', () => {
  test('wrong credentials stay on /login with a visible error', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
    await page.getByPlaceholder(/^e\.g\./).fill('admin@example.com');
    await page.getByPlaceholder('••••••••').fill('definitely-wrong');
    await page.getByRole('button', { name: /authenticate/i }).click();
    // The error block renders "Err" + a human message; we must NOT navigate.
    await expect(page.getByText('Err', { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('bootstrap login forces a password change, then Customer Balances renders', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder(/^e\.g\./).fill('admin@example.com');
    await page.getByPlaceholder('••••••••').fill('admin123');
    await page.getByRole('button', { name: /authenticate/i }).click();

    // Bootstrap admin has must_change_password=1 → the forced-change modal.
    await expect(page.getByText('Set your password')).toBeVisible({ timeout: 15_000 });
    await page.getByPlaceholder('At least 6 characters').fill(NEW_PASSWORD);
    await page.getByPlaceholder('Repeat new password').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: /set password & continue/i }).click();

    // Modal closes and the authenticated shell is up (sidebar nav present).
    await expect(page.getByText('Set your password')).toBeHidden({ timeout: 15_000 });

    // Money path: Customer Balances mounts and shows its heading — on a fresh
    // empty DB this must render the empty state, not crash.
    await page.goto('/CustomerBalances');
    await expect(page.getByRole('heading', { name: /customer balances/i })).toBeVisible({ timeout: 15_000 });
  });
});
