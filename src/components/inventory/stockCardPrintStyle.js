/* ── Stock-card print styles (injected while MovementHistoryView is mounted) ──
 * Prints one item's stock card (opening → movements → closing) on a letterhead
 * sheet, same branding as the BAT tab / daily-sales document prints. Portrait —
 * a single-item ledger is seven narrow columns.
 *
 * Everything is gated on `body.print-stock-card`, which the Print button adds
 * just before window.print() and removes on afterprint. That keeps a plain
 * Ctrl+P on this page (or any other) completely unaffected — only the button
 * produces the sheet — and the stylesheet is removed on unmount so it can never
 * leak page-wide rules to other routes. */
export const STOCK_CARD_PRINT_STYLE = `
@page { size: A4 portrait; margin: 10mm 8mm; }
@media print {
  body.print-stock-card { visibility: hidden; background: #fff; }
  body.print-stock-card #stock-card-printable {
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
  body.print-stock-card #stock-card-printable * { visibility: visible; }

  #stock-card-printable .sc-head { display: flex; align-items: flex-end; justify-content: space-between; border-bottom: 2px solid #111; padding-bottom: 3mm; margin-bottom: 4mm; }
  #stock-card-printable .sc-depot { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #111; margin: 0 0 1.5mm; }
  #stock-card-printable h1 { font-size: 16px; font-weight: 700; margin: 0 0 1mm; letter-spacing: -0.01em; }
  #stock-card-printable .sc-sub { font-size: 10px; color: #333; margin: 0 0 1mm; font-weight: 600; }
  #stock-card-printable .sc-head p { font-size: 9px; color: #666; margin: 0; }
  #stock-card-printable .sc-brand { text-align: right; font-size: 9px; color: #888; text-transform: uppercase; letter-spacing: 0.15em; white-space: nowrap; }
  #stock-card-printable .sc-logo { display: block; height: 13mm; margin: 0 0 1.5mm auto; print-color-adjust: exact; -webkit-print-color-adjust: exact; }

  #stock-card-printable .sc-summary { display: flex; gap: 8mm; flex-wrap: wrap; margin-bottom: 3mm; }
  #stock-card-printable .sc-summary .lbl { color: #666; text-transform: uppercase; letter-spacing: 0.06em; font-size: 8px; }
  #stock-card-printable .sc-summary .val { font-weight: 700; font-size: 12px; }

  #stock-card-printable table { width: 100%; border-collapse: collapse; font-size: 9px; page-break-inside: auto; }
  #stock-card-printable thead tr { background: #f0f0f0; }
  #stock-card-printable th { text-align: left; padding: 2.5px 4px; border-bottom: 1.5px solid #888; font-weight: 600; font-size: 8px; text-transform: uppercase; letter-spacing: 0.03em; }
  #stock-card-printable td { padding: 2px 4px; border-bottom: 1px solid #ddd; vertical-align: top; }
  #stock-card-printable tr { page-break-inside: avoid; }
  #stock-card-printable .tr-bound td { background: #f6f6f6; font-weight: 700; border-top: 1.5px solid #888; }
  #stock-card-printable .td-right { text-align: right; }
  #stock-card-printable .td-center { text-align: center; }
  #stock-card-printable .td-mono { font-family: 'Courier New', monospace; }
  #stock-card-printable .td-muted { color: #666; }
}
`;
