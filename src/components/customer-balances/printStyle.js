/* ── print styles (injected once) ── */
export const PRINT_STYLE = `
@page {
  size: auto;
  margin: 8mm;
}

@media print {
  html, body {
    margin: 0 !important;
    padding: 0 !important;
    background: #fff !important;
  }

  body { visibility: hidden; background: #fff; }
  #customer-balances-printable {
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
    font-size: 11px;
  }
  #customer-balances-printable * { visibility: visible; }

  .cb-print-header { margin-bottom: 5mm; border-bottom: 2px solid #000; padding-bottom: 3mm; }
  .cb-print-header h1 { font-size: 16px; font-weight: 700; margin: 0 0 2px 0; }
  .cb-print-header p  { font-size: 11px; color: #555; margin: 0; }

  .cb-print-summary {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 4mm;
    font-size: 12px;
  }
  .cb-print-summary strong { font-size: 14px; }

  table { width: 100%; border-collapse: collapse; font-size: 10px; page-break-inside: auto; }
  thead tr { background: #f0f0f0; }
  th { text-align: left; padding: 3px 5px; border-bottom: 1.5px solid #888; font-weight: 600; font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em; }
  td { padding: 2px 5px; border-bottom: 1px solid #ddd; vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  .td-right { text-align: right; }
  .td-mono  { font-family: 'Courier New', monospace; }
  .td-muted { color: #666; }
  .td-top   { background: #fffbeb; }
  .td-amount-high { color: #c00; font-weight: 700; }
  .td-amount-mid  { color: #b45309; font-weight: 600; }
  .flag-dot {
    display: inline-block;
    width: 7px; height: 7px;
    border-radius: 50%;
    margin-right: 4px;
    vertical-align: middle;
  }
  .flag-red    { background: #ef4444; }
  .flag-orange { background: #f97316; }
  .flag-yellow { background: #eab308; }
  .flag-green  { background: #22c55e; }
  .flag-blue   { background: #3b82f6; }
  .flag-purple { background: #a855f7; }
  .flag-pink   { background: #ec4899; }
  .flag-gray   { background: #9ca3af; }
  tr { page-break-inside: avoid; }
  .cb-no-print { display: none !important; }
}
`;
