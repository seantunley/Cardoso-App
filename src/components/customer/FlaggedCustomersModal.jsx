import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/apiClient';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Flag, User } from "lucide-react";
import { cn } from "@/lib/utils";

const flagColors = {
  red: { bg: "bg-red-500/15", text: "text-red-400", border: "border-red-500/30", label: "Red Flag" },
  green: { bg: "bg-green-500/15", text: "text-green-400", border: "border-green-500/30", label: "Green Flag" },
  orange: { bg: "bg-orange-500/15", text: "text-orange-400", border: "border-orange-500/30", label: "Orange Flag" },
  none: { bg: "bg-slate-500/15", text: "text-slate-400", border: "border-slate-500/30", label: "No Flag" },
};

const PAGE_SIZE = 100;

async function fetchHubFlaggedCustomers({ flagColor, siteId, offset }) {
  const params = new URLSearchParams({
    flag_color: flagColor,
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  if (siteId) params.set('site_id', siteId);

  const response = await fetch(`/api/hub/records?${params.toString()}`, {
    credentials: 'include',
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error || 'Failed to fetch flagged customers');
  }

  return {
    records: Array.isArray(result.records) ? result.records : [],
    total: typeof result.total === 'number' ? result.total : 0,
    hasMore: Boolean(result.has_more),
  };
}

export default function FlaggedCustomersModal({
  flagColor,
  open,
  onClose,
  onCustomerClick,
  siteName,
  siteId,
  customers: externalCustomers,
  mode = 'local',
}) {
  const config = flagColors[flagColor] || flagColors.none;
  const [page, setPage] = useState(0);
  const [pagedCustomers, setPagedCustomers] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPage(0);
    setPagedCustomers([]);
    setTotalCount(0);
    setHasMore(false);
  }, [open, flagColor, mode, siteId]);

  const { data: fetchedPage, isFetching } = useQuery({
    queryKey: ['flagged-customers', mode, siteId || 'all-sites', flagColor, page],
    queryFn: async () => {
      if (mode === 'hub') {
        return fetchHubFlaggedCustomers({ flagColor, siteId, offset: page * PAGE_SIZE });
      }

      const result = await api.records.search({
        flagColor,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });

      return {
        records: Array.isArray(result.records) ? result.records : [],
        total: typeof result.total === 'number' ? result.total : 0,
        hasMore: Boolean(result.has_more),
      };
    },
    enabled: !!open && !!flagColor && !externalCustomers && !!flagColors[flagColor],
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!fetchedPage) return;
    // `open` is included so that a cache hit (fetchedPage unchanged) still
    // re-populates the list after the reset effect clears pagedCustomers.
    setPagedCustomers((current) => (page === 0 ? fetchedPage.records : [...current, ...fetchedPage.records]));
    setTotalCount(fetchedPage.total);
    setHasMore(fetchedPage.hasMore);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchedPage, page, open]);

  const displayCustomers = externalCustomers ?? pagedCustomers;
  const effectiveTotal = externalCustomers ? externalCustomers.length : totalCount;
  const isFetchingDisplay = !externalCustomers && isFetching;

  if (!flagColor || !flagColors[flagColor]) return null;

  const sortedCustomers = useMemo(() => (
    [...displayCustomers].sort((a, b) => {
      const numA = a.customer_number || a.data?.customer_number || "";
      const numB = b.customer_number || b.data?.customer_number || "";
      return String(numA).localeCompare(String(numB));
    })
  ), [displayCustomers]);

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
            {isFetchingDisplay && sortedCustomers.length === 0
              ? 'Loading...'
              : `${effectiveTotal || sortedCustomers.length} customer${(effectiveTotal || sortedCustomers.length) !== 1 ? 's' : ''}`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 overflow-y-auto flex-1 min-h-0 pr-2">
          {sortedCustomers.length === 0 && !isFetchingDisplay ? (
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
                  key={customer.id || `${customer.site_id || 'local'}-${custNum}`}
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

        {!externalCustomers && sortedCustomers.length > 0 && (
          <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
            <p className="text-xs text-muted-foreground">
              Showing {sortedCustomers.length} of {effectiveTotal || sortedCustomers.length}
            </p>
            {hasMore && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((current) => current + 1)}
                disabled={isFetchingDisplay}
              >
                {isFetchingDisplay ? 'Loading…' : 'Load more'}
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
