// ─── Fields Tab ─────────────────────────────────────────────────────────────

const CUSTOMER_FIELDS = [
  { key: "customer_number",     label: "Customer Number",     fallbacks: "customer_number, CustomerNumber",             mode: "sync" },
  { key: "customer_name",       label: "Customer Name",       fallbacks: "customer_name, CustomerName, name",           mode: "sync" },
  { key: "age_analysis",        label: "Age Analysis",        fallbacks: "age_analysis, AgeAnalysis",                   mode: "sync" },
  { key: "outstanding_balance", label: "Outstanding Balance", fallbacks: "outstanding_balance, OutstandingBalance, AMTDUE, BalanceDue", mode: "sync" },
  { key: "age_current",         label: "Age Current",         fallbacks: "age_current, AgeCurrent, Current",            mode: "sync" },
  { key: "age_7_days",          label: "Age 7 Days",          fallbacks: "age_7_days, Age7Days, AMTDUE07",              mode: "sync" },
  { key: "age_14_days",         label: "Age 14 Days",         fallbacks: "age_14_days, Age14Days, AMTDUE14",            mode: "sync" },
  { key: "age_21_days",         label: "Age 21 Days",         fallbacks: "age_21_days, Age21Days, AMTDUE21",            mode: "sync" },
  { key: "last_unpaid_invoice_1",       label: "Invoice 1 Number",        fallbacks: "last_unpaid_invoice_1, LastUnpaidInvoice1",                       mode: "sync" },
  { key: "last_unpaid_invoice_1_amount", label: "Invoice 1 Amount",        fallbacks: "last_unpaid_invoice_1_amount, LastUnpaidInvoice1Amount",            mode: "sync" },
  { key: "last_unpaid_invoice_1_date",   label: "Invoice 1 Date",          fallbacks: "last_unpaid_invoice_1_date, LastUnpaidInvoice1Date",                mode: "sync" },
  { key: "last_unpaid_invoice_2",       label: "Invoice 2 Number",        fallbacks: "last_unpaid_invoice_2, LastUnpaidInvoice2",                       mode: "sync" },
  { key: "last_unpaid_invoice_2_amount", label: "Invoice 2 Amount",        fallbacks: "last_unpaid_invoice_2_amount, LastUnpaidInvoice2Amount",            mode: "sync" },
  { key: "last_unpaid_invoice_2_date",   label: "Invoice 2 Date",          fallbacks: "last_unpaid_invoice_2_date, LastUnpaidInvoice2Date",                mode: "sync" },
  { key: "last_unpaid_invoice_3",       label: "Invoice 3 Number",        fallbacks: "last_unpaid_invoice_3, LastUnpaidInvoice3",                       mode: "sync" },
  { key: "last_unpaid_invoice_3_amount", label: "Invoice 3 Amount",        fallbacks: "last_unpaid_invoice_3_amount, LastUnpaidInvoice3Amount",            mode: "sync" },
  { key: "last_unpaid_invoice_3_date",   label: "Invoice 3 Date",          fallbacks: "last_unpaid_invoice_3_date, LastUnpaidInvoice3Date",                mode: "sync" },
  { key: "last_unpaid_invoice_4",       label: "Invoice 4 Number",        fallbacks: "last_unpaid_invoice_4, LastUnpaidInvoice4",                       mode: "sync" },
  { key: "last_unpaid_invoice_4_amount", label: "Invoice 4 Amount",        fallbacks: "last_unpaid_invoice_4_amount, LastUnpaidInvoice4Amount",            mode: "sync" },
  { key: "last_unpaid_invoice_4_date",   label: "Invoice 4 Date",          fallbacks: "last_unpaid_invoice_4_date, LastUnpaidInvoice4Date",                mode: "sync" },
  { key: "last_unpaid_invoice_5",       label: "Invoice 5 Number",        fallbacks: "last_unpaid_invoice_5, LastUnpaidInvoice5",                       mode: "sync" },
  { key: "last_unpaid_invoice_5_amount", label: "Invoice 5 Amount",        fallbacks: "last_unpaid_invoice_5_amount, LastUnpaidInvoice5Amount",            mode: "sync" },
  { key: "last_unpaid_invoice_5_date",   label: "Invoice 5 Date",          fallbacks: "last_unpaid_invoice_5_date, LastUnpaidInvoice5Date",                mode: "sync" },
  { key: "last_receipt_1",               label: "Receipt 1 Number",        fallbacks: "last_receipt_1, LastReceipt1",                                    mode: "sync" },
  { key: "last_receipt_1_amount",        label: "Receipt 1 Amount",        fallbacks: "last_receipt_1_amount, LastReceipt1Amount",                       mode: "sync" },
  { key: "last_receipt_1_date",          label: "Receipt 1 Date",          fallbacks: "last_receipt_1_date, LastReceipt1Date",                           mode: "sync" },
  { key: "last_receipt_2",               label: "Receipt 2 Number",        fallbacks: "last_receipt_2, LastReceipt2",                                    mode: "sync" },
  { key: "last_receipt_2_amount",        label: "Receipt 2 Amount",        fallbacks: "last_receipt_2_amount, LastReceipt2Amount",                       mode: "sync" },
  { key: "last_receipt_2_date",          label: "Receipt 2 Date",          fallbacks: "last_receipt_2_date, LastReceipt2Date",                           mode: "sync" },
  { key: "last_receipt_3",               label: "Receipt 3 Number",        fallbacks: "last_receipt_3, LastReceipt3",                                    mode: "sync" },
  { key: "last_receipt_3_amount",        label: "Receipt 3 Amount",        fallbacks: "last_receipt_3_amount, LastReceipt3Amount",                       mode: "sync" },
  { key: "last_receipt_3_date",          label: "Receipt 3 Date",          fallbacks: "last_receipt_3_date, LastReceipt3Date",                           mode: "sync" },
  { key: "last_receipt_4",               label: "Receipt 4 Number",        fallbacks: "last_receipt_4, LastReceipt4",                                    mode: "sync" },
  { key: "last_receipt_4_amount",        label: "Receipt 4 Amount",        fallbacks: "last_receipt_4_amount, LastReceipt4Amount",                       mode: "sync" },
  { key: "last_receipt_4_date",          label: "Receipt 4 Date",          fallbacks: "last_receipt_4_date, LastReceipt4Date",                           mode: "sync" },
  { key: "last_receipt_5",               label: "Receipt 5 Number",        fallbacks: "last_receipt_5, LastReceipt5",                                    mode: "sync" },
  { key: "last_receipt_5_amount",        label: "Receipt 5 Amount",        fallbacks: "last_receipt_5_amount, LastReceipt5Amount",                       mode: "sync" },
  { key: "last_receipt_5_date",          label: "Receipt 5 Date",          fallbacks: "last_receipt_5_date, LastReceipt5Date",                           mode: "sync" },
  { key: "sales_rep",                    label: "Sales Rep",               fallbacks: "sales_rep, SalesRep, SALEREP, SalesRepCode, salesrep, SalesPerson, SalesPersonCode, Sales Rep, Sales Rep Code, SalesRepName, SalesPersonName, Salesman, SalesmanCode, SalesmanName, Rep, RepCode, RepName", mode: "sync" },
  { key: "account_type",                 label: "Account Type",            fallbacks: "account_type, AccountType, ACCOUNT_TYPE, accounttype, Type, CUSTOMER_TYPE, CustomerType, customer_type, Class, CustomerClass, Account Type", mode: "sync" },
  { key: "terms",               label: "Payment Terms",       fallbacks: "terms, Terms, PaymentTerms",                  mode: "sync" },
  { key: "note",                label: "Note",                fallbacks: "note, Note, notes",                           mode: "local-only" },
];

const INVENTORY_FIELDS = [
  { key: "item_number",      label: "Item Number",      fallbacks: "item_number, ItemNumber, ItemNo, ITEMNO",            mode: "sync" },
  { key: "item_description", label: "Item Description", fallbacks: "item_description, ItemDescription, Description, DESC", mode: "sync" },
  { key: "qty_on_hand",      label: "Qty on Hand",      fallbacks: "qty_on_hand, QtyOnHand, Quantity, QTY, OnHand",      mode: "sync" },
  { key: "last_cost",        label: "Last Cost",        fallbacks: "last_cost, LastCost, Cost, COST",                    mode: "sync" },
  { key: "price_list",       label: "Price List",       fallbacks: "price_list, PriceList, PRICE_LIST",                  mode: "sync" },
  { key: "price",            label: "Price",            fallbacks: "price, Price, SellPrice, UnitPrice",                 mode: "sync" },
];

const MODE_BADGE = {
  "sync":          { label: "Sync",          cls: "bg-accent/10 text-accent border-accent/30" },
  "sync-if-empty": { label: "Sync if empty", cls: "bg-yellow-900/50 text-yellow-300 border-yellow-700" },
  "local-only":    { label: "Local only",    cls: "bg-gray-700 text-gray-300 border-gray-600" },
};

function FieldsTable({ fields }) {
  return (
    <div className="rounded-xl border border-border bg-card overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/40">
            <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase w-48">Field Key</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase w-44">Label</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase">SQL Fallback Names</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase w-32">Mode</th>
          </tr>
        </thead>
        <tbody>
          {fields.map(f => {
            const badge = MODE_BADGE[f.mode] || MODE_BADGE["sync"];
            return (
              <tr key={f.key} className="border-b border-border last:border-0 hover:bg-muted/20">
                <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{f.key}</td>
                <td className="px-4 py-2.5 text-foreground text-sm">{f.label}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground/70 leading-relaxed">{f.fallbacks}</td>
                <td className="px-4 py-2.5">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${badge.cls}`}>
                    {badge.label}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function FieldsTab() {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Customer Fields</h3>
        <FieldsTable fields={CUSTOMER_FIELDS} />
      </div>
      <div>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Inventory Fields</h3>
        <FieldsTable fields={INVENTORY_FIELDS} />
      </div>
    </div>
  );
}
