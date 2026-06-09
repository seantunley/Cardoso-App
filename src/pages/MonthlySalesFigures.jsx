import ArDocumentSummary from "@/components/reports/ArDocumentSummary";

// Standalone page wrapper for the Monthly Sales Figures report. Gives it the
// same page margins (p-6, centred max-width) as every other sidebar page — the
// report renders its own ReportFrame heading + toolbar inside.
export default function MonthlySalesFigures() {
  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      <ArDocumentSummary />
    </div>
  );
}
