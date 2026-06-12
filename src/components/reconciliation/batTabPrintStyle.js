/* ── BAT reconciliation tab print styles (injected while mounted) ──
 * Same letterhead/branding as the Customer Balances print, retargeted to
 * #bat-tab-printable and set LANDSCAPE because the reconciliation lists carry
 * many columns. Prints the active tab (Paid / Non-Compliant / Exceptions) with
 * a header that states the depot, year, week number and tab name.
 * The sheet is REMOVED when InvoiceMatching unmounts: its @page landscape and
 * body{visibility:hidden} are page-wide, and left in <head> they would force
 * landscape on (or blank out) prints from other pages. */
export const BAT_TAB_PRINT_STYLE = `
@page {
  size: A4 landscape;
  margin: 8mm;
}

@media print {
  html, body {
    margin: 0 !important;
    padding: 0 !important;
    background: #fff !important;
  }

  body { visibility: hidden; background: #fff; }
  #bat-tab-printable {
    visibility: visible;
    position: absolute;
    left: 0;
    top: 0;
    width: 100%;
    margin: 0;
    padding: 0;
    box-sizing: border-box;
    background: #fff;
    color: #000;
    font-family: Arial, Helvetica, sans-serif;
    font-size: 10px;
  }
  #bat-tab-printable * { visibility: visible; }

  .bat-print-header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    margin-bottom: 4mm;
    border-bottom: 2px solid #111;
    padding-bottom: 3mm;
  }
  .bat-print-header .bat-print-depot {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: #111;
    margin: 0 0 1.5mm 0;
  }
  .bat-print-header h1 { font-size: 17px; font-weight: 700; margin: 0 0 1mm 0; letter-spacing: -0.01em; }
  .bat-print-header .bat-print-sub { font-size: 11px; color: #333; margin: 0 0 1mm 0; font-weight: 600; }
  .bat-print-header p  { font-size: 9px; color: #666; margin: 0; }
  .bat-print-header .bat-print-brand {
    text-align: right;
    font-size: 9px;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.15em;
    white-space: nowrap;
  }
  .bat-print-header .bat-print-logo {
    display: block;
    height: 13mm;
    margin: 0 0 1.5mm auto;
    print-color-adjust: exact;
    -webkit-print-color-adjust: exact;
  }

  .bat-print-summary {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 3mm;
    font-size: 11px;
  }
  .bat-print-summary strong { font-size: 13px; }

  /* All table selectors are scoped to #bat-tab-printable: other print sheets
     (Customer Balances, Creditors, reports) can share <head> with this one, and
     bare table/th/td rules would restyle their prints. */
  #bat-tab-printable table { width: 100%; border-collapse: collapse; font-size: 9px; page-break-inside: auto; }
  #bat-tab-printable thead tr { background: #f0f0f0; }
  #bat-tab-printable th { text-align: left; padding: 2.5px 4px; border-bottom: 1.5px solid #888; font-weight: 600; font-size: 8px; text-transform: uppercase; letter-spacing: 0.03em; }
  #bat-tab-printable td { padding: 2px 4px; border-bottom: 1px solid #ddd; vertical-align: top; }
  #bat-tab-printable tfoot td { border-top: 1.5px solid #888; border-bottom: none; font-weight: 700; padding-top: 3px; }
  #bat-tab-printable tr:last-child td { border-bottom: none; }
  #bat-tab-printable .td-right { text-align: right; }
  #bat-tab-printable .td-center { text-align: center; }
  #bat-tab-printable .td-mono  { font-family: 'Courier New', monospace; }
  #bat-tab-printable .td-muted { color: #666; }
  #bat-tab-printable tr { page-break-inside: avoid; }
  .bat-no-print { display: none !important; }
}
`;
