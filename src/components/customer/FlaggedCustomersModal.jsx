import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Flag, User } from "lucide-react";
import { cn } from "@/lib/utils";

const flagColors = {
  red: { bg: "bg-red-100", text: "text-red-700", border: "border-red-200", label: "Red Flag" },
  green: { bg: "bg-green-100", text: "text-green-700", border: "border-green-200", label: "Green Flag" },
  orange: { bg: "bg-orange-100", text: "text-orange-700", border: "border-orange-200", label: "Orange Flag" },
};

export default function FlaggedCustomersModal({ flagColor, customers, open, onClose, onCustomerClick }) {
  if (!flagColor) return null;

  const config = flagColors[flagColor];
  const sortedCustomers = [...customers].sort((a, b) => {
    const numA = a.customer_number || a.data?.customer_number || "";
    const numB = b.customer_number || b.data?.customer_number || "";
    return String(numA).localeCompare(String(numB));
  });

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[80vh] bg-gray-900 border-gray-700">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <div className={cn("p-2 rounded-lg bg-gray-800")}>
              <Flag className={cn("w-5 h-5", config.text)} />
            </div>
            <div>
              <div className="text-lg font-semibold text-white">
                {config.label} Customers
              </div>
              <div className="text-sm text-gray-400 font-normal">
                {sortedCustomers.length} customer{sortedCustomers.length !== 1 ? 's' : ''}
              </div>
            </div>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-2 overflow-y-auto max-h-[60vh] pr-2">
          {sortedCustomers.length === 0 ? (
            <div className="text-center py-8 text-gray-400">
              No customers with {flagColor} flags
            </div>
          ) : (
            sortedCustomers.map((customer) => {
              const custNum = customer.customer_number || customer.data?.customer_number;
              const custName = customer.customer_name || customer.data?.customer_name;
              const flagReason = customer.flag_reason || customer.data?.flag_reason;

              return (
                <div
                  key={customer.id}
                  onClick={() => {
                    onCustomerClick(customer);
                    onClose();
                  }}
                  className="p-4 bg-gray-800 rounded-lg border border-gray-700 hover:border-gray-600 hover:shadow-sm transition-all cursor-pointer"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 flex-1">
                      <div className="p-2 bg-gray-900 rounded-lg">
                        <User className="w-4 h-4 text-gray-400" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-white">
                          {custName || "Unknown Customer"}
                        </div>
                        <div className="text-sm text-gray-400">
                          Customer #{custNum}
                        </div>
                        {flagReason && (
                          <div className="text-xs text-gray-300 mt-1 italic">
                            "{flagReason}"
                          </div>
                        )}
                      </div>
                    </div>
                    <Badge className={cn("border", config.bg, config.text, config.border)}>
                      <Flag className="w-3 h-3 mr-1" />
                      {config.label}
                    </Badge>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}