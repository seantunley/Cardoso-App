// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { TooltipProvider } from '../src/components/ui/tooltip.jsx';
import CrossrefPanel from '../src/components/reconciliation/CrossrefPanel.jsx';

// jsdom has no layout, so the real virtualizer would window to zero rows.
// Stub it to "everything visible" so the filter output is observable.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }) => ({
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 31, end: (index + 1) * 31 })),
    getTotalSize: () => count * 31,
    measureElement: () => {},
  }),
}));

afterEach(cleanup);

const MATCH = {
  stats: { matched: 2, autoCorrections: 0, mismatches: 1, unmatchedSupplier: 1, unmatchedCardoso: 1 },
  results: [
    { extraction_id: 1, cardoso_id: 10, invoice_number: 'INV100', year: 2026, week_number: 3, supplier_amount: 100, cardoso_amount: 100, difference: 0, matched: true },
    { extraction_id: 2, cardoso_id: 11, invoice_number: 'INV200', year: 2026, week_number: 4, supplier_amount: 50, cardoso_amount: 40, difference: 10, matched: true, amount_mismatch: true },
    { extraction_id: 3, cardoso_id: null, invoice_number: 'INV100', year: 2025, week_number: 3, supplier_amount: 70, matched: false },
    { extraction_id: null, cardoso_id: 12, invoice_number: 'INV300', cardoso_amount: 30, matched: false },
  ],
};

function renderPanel() {
  return render(<TooltipProvider><CrossrefPanel match={MATCH} /></TooltipProvider>);
}
const bodyRows = () => within(document.querySelector('tbody')).queryAllByRole('row');

describe('CrossrefPanel', () => {
  it('renders every row and flags duplicate invoice numbers', () => {
    renderPanel();
    expect(bodyRows()).toHaveLength(4);
    expect(screen.getByText('4 of 4 rows')).toBeTruthy();
    expect(screen.getAllByText('×2 dup')).toHaveLength(2);
    expect(screen.getByText('▲ Cardoso only')).toBeTruthy();
  });

  it('filters by year, week and invoice search', () => {
    renderPanel();
    const [yearSel, weekSel] = screen.getAllByRole('combobox');
    fireEvent.change(yearSel, { target: { value: '2026' } });
    expect(bodyRows()).toHaveLength(2);
    fireEvent.change(weekSel, { target: { value: '4' } });
    expect(bodyRows()).toHaveLength(1);
    expect(screen.getByText('INV200')).toBeTruthy();

    fireEvent.click(screen.getByText('Clear'));
    fireEvent.change(screen.getByPlaceholderText('Invoice #'), { target: { value: 'inv1' } });
    expect(bodyRows()).toHaveLength(2);
    expect(screen.getByText('2 of 4 rows')).toBeTruthy();
  });
});
