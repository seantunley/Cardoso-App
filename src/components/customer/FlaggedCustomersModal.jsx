import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/apiClient';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Flag, User } from "lucide-react";
import { cn } from "@/lib/utils";

const flagColors = {
  red: { bg: "bg-red-500/15", text: "text-red-400", border: "border-red-500/30", label: "Red Flag" },
  green: { bg: "bg-green-500/15", text: "text-green-400", border: "border-green-500/30", label: "Green Flag" },
  orange: { bg: "bg-orange-500/15", text: "text-orange-400", border: "border-orange-500/30", label: "Orange Flag" },
  none: { bg: "bg-slate-500/15", text: "text-slate-400", border: "border-slate-500/30", label: "No Flag" },
};

export default function FlaggedCustomersModal({ flagColor, open, onClose, onCustomerClick, siteName, customers: externalCustomers }) {
  const config = flagColors[flagColor] || flagColors.none;

  // Self-fetch only when no external list is provided (hub passes its own pre-fetched records)
  const { data: fetchedCustomers = [], isFetching } = useQuery({
    queryKey: ['flagged-customers', flagColor],
    queryFn: async () => {
      const all = await api.entities.DataRecord.list('-created_date', 2000);
      return all.filter(r => r.flag_color === flagColor);
    },
    enabled: !!open && !!flagColor && !externalCustomers && !!flagColors[flagColor],
    staleTime: 30_000,
  });

  const displayCustomers = externalCustomers ?? fetchedCustomers;
  const isFetchingDisplay = !externalCustomers && isFetching;

  if (!flagColor || !flagColors[flagColor]) return null;

  const sortedCustomers = [...displayCustomers].sort((a, b) => {
    const numA = a.customer_number || a.data?.customer_number || "";
    const numB = b.customer_number || b.data?.customer_number || "";
    return String(numA).localeCompare(String(numB));
  });

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent
        className="max-w-2xl max-h-[70vh] flex flex-col overflow-hidden bg-card border-border"
        onKeyDown={(e) => { if (e.key === 'Enter') onClose(); }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <div className={cn("p-2 rounded-lg bg-muted")}>
              <Flag className={cn("w-5 h-5", config.text)} />
            </div>
            <div>
              {siteName && (
                <div className="text-xl font-semibold text-foreground mb-0.5">{siteName}</div>
              )}
              <div className="text-lg font-semibold text-foreground">
                {config.label} Customers
              </div>
            </div>
          </DialogTitle>
          <DialogDescription>
            {isFetchingDisplay ? 'Loading...' : `${sortedCustomers.length} customer${sortedCustomers.length !== 1 ? 's' : ''}`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 overflow-y-auto flex-1 min-h-0 pr-2">
          {sortedCustomers.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
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
                  className="p-4 bg-muted rounded-lg border border-border hover:border-border/70 hover:shadow-sm transition-all cursor-pointer"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 flex-1">
                      <div className="p-2 bg-card rounded-lg">
                        <User className="w-4 h-4 text-muted-foreground" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-foreground">
                          {custName || "Unknown Customer"}
                        </div>
                        <div className="text-sm text-muted-foreground">
                          Customer #{custNum}
                        </div>
                        {flagReason && (
                          <div className="text-xs text-muted-foreground mt-1 italic">
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
