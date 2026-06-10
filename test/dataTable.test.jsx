// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import DataTable from '../src/components/shared/DataTable.jsx';

// No vitest globals in this repo → RTL's auto-cleanup never registers, and the
// DOM accumulates across tests (duplicate-text query failures). Clean explicitly.
afterEach(cleanup);

const COLUMNS = [
  { key: 'code', label: 'Code', mono: true },
  { key: 'name', label: 'Vendor' },
  { key: 'amount', label: 'Outstanding', align: 'right', format: (v) => `R ${Number(v).toFixed(2)}` },
];
const ROWS = [
  { code: 'V001', name: 'Acme', amount: 1234.5 },
  { code: 'V002', name: 'Bolt', amount: 99 },
];

// virtualize={false}: jsdom has no layout, the virtualizer would window
// everything to zero rows. The non-virtual path is also the print path.
function renderTable(props = {}) {
  return render(
    <DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.code} virtualize={false} {...props} />,
  );
}

describe('DataTable', () => {
  it('renders all rows with formatted cells', () => {
    renderTable();
    expect(screen.getByText('Acme')).toBeTruthy();
    expect(screen.getByText('R 1234.50')).toBeTruthy();
    expect(screen.getByText('R 99.00')).toBeTruthy();
  });

  it('header click and keyboard Enter both fire onSortChange', () => {
    const onSortChange = vi.fn();
    renderTable({ onSortChange, sortKey: 'amount', sortDir: 'desc' });
    const header = screen.getByText(/Outstanding/).closest('th');
    fireEvent.click(header);
    fireEvent.keyDown(header, { key: 'Enter' });
    expect(onSortChange).toHaveBeenCalledTimes(2);
    expect(onSortChange).toHaveBeenCalledWith('amount');
    // Active sort exposed to assistive tech.
    expect(header.getAttribute('aria-sort')).toBe('descending');
  });

  it('rows are keyboard-actionable when onRowClick is provided', () => {
    const onRowClick = vi.fn();
    renderTable({ onRowClick });
    const row = screen.getByText('Acme').closest('tr');
    expect(row.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onRowClick).toHaveBeenCalledWith(ROWS[0]);
  });

  it('rows are not focusable without onRowClick', () => {
    renderTable();
    const row = screen.getByText('Acme').closest('tr');
    expect(row.getAttribute('tabindex')).toBe(null);
  });
});
