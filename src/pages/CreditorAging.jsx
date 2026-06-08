// Aged Creditors as a first-class page inside the Creditors module, gated on
// can_access_creditors — so AP users who don't have general reports access can
// still reach it. The same report is also listed under the Reports page for
// Reports users; both render this one component and hit the same endpoint
// (which accepts either permission).
import AgedCreditors from "@/components/reports/AgedCreditors";

export default function CreditorAging() {
  return <AgedCreditors />;
}
