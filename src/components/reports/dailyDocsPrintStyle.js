/* ── Daily Sales "documents for one day" print styles (injected once) ──
 * The Daily Sales Figures report already has its own ReportFrame print sheet
 * (#daily-sales-figures-printable, landscape). This second sheet is for the
 * per-row Print button, which lists every Invoice / Credit Note / Debit Note
 * posted on ONE day. Both stylesheets are present at the same time, so this one
 * is gated on `body.print-day-docs`: only when that class is set (added right
 * before window.print(), removed on afterprint) does it take over — hiding the
 * figures sheet and revealing #daily-docs-printable. Same letterhead/branding
 * as the BAT reconciliation print, retargeted. */
export const DAILY_DOCS_PRINT_STYLE = `
@media print {
  /* When printing a single day's documents, suppress the main figures sheet
     (it is otherwise visibility:visible via its own print stylesheet). The
     day-docs block is a SIBLING of that sheet (rendered outside ReportFrame),
     so hiding the sheet does not hide it. */
  body.print-day-docs #daily-sales-figures-printable { display: none !important; }

  /* And the reverse: on a normal report print (no class), keep the day-docs
     block out entirely — defence-in-depth on top of its inline visibility. */
  body:not(.print-day-docs) #daily-docs-printable { display: none !important; }

  body.print-day-docs #daily-docs-printable {
    visibility: visible;
    position: absolute;
    left: 0; top: 0;
    width: 100%;
    margin: 0; padding: 0;
    box-sizing: border-box;
    background: #fff;
    color: #000;
    font-family: Arial, Helvetica, sans-serif;
    font-size: 10px;
  }
  body.print-day-docs #daily-docs-printable * { visibility: visible; }

  .ddoc-print-header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    margin-bottom: 4mm;
    border-bottom: 2px solid #111;
    padding-bottom: 3mm;
  }
  .ddoc-print-header .ddoc-print-depot {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: #111;
    margin: 0 0 1.5mm 0;
  }
  .ddoc-print-header h1 { font-size: 17px; font-weight: 700; margin: 0 0 1mm 0; letter-spacing: -0.01em; }
  .ddoc-print-header .ddoc-print-sub { font-size: 11px; color: #333; margin: 0 0 1mm 0; font-weight: 600; }
  .ddoc-print-header p  { font-size: 9px; color: #666; margin: 0; }
  .ddoc-print-header .ddoc-print-brand {
    text-align: right;
    font-size: 9px;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.15em;
    white-space: nowrap;
  }
  .ddoc-print-header .ddoc-print-logo {
    display: block;
    height: 13mm;
    margin: 0 0 1.5mm auto;
    print-color-adjust: exact;
    -webkit-print-color-adjust: exact;
  }

  .ddoc-print-section-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #111;
    margin: 4mm 0 1.5mm 0;
    page-break-after: avoid;
  }

  #daily-docs-printable table { width: 100%; border-collapse: collapse; font-size: 9px; page-break-inside: auto; margin-bottom: 2mm; }
  #daily-docs-printable thead tr { background: #f0f0f0; }
  #daily-docs-printable th { text-align: left; padding: 2.5px 4px; border-bottom: 1.5px solid #888; font-weight: 600; font-size: 8px; text-transform: uppercase; letter-spacing: 0.03em; }
  #daily-docs-printable td { padding: 2px 4px; border-bottom: 1px solid #ddd; vertical-align: top; }
  #daily-docs-printable tfoot td { border-top: 1.5px solid #888; border-bottom: none; font-weight: 700; padding-top: 3px; }
  #daily-docs-printable tr { page-break-inside: avoid; }

  .ddoc-grand {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-top: 4mm;
    border-top: 2px solid #111;
    padding-top: 2mm;
    font-size: 12px;
    font-weight: 700;
  }

  .td-right { text-align: right; }
  .td-center { text-align: center; }
  .td-mono  { font-family: 'Courier New', monospace; }
  .td-muted { color: #666; }
}
`;
