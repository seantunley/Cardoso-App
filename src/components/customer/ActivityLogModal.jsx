import { useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Eye, Flag, Edit, Trash2, Calendar, User } from "lucide-react";
import { format } from "date-fns";

const actionConfig = {
  viewed: { icon: Eye, label: "Viewed", color: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
  flag_added: { icon: Flag, label: "Flag Added", color: "bg-green-500/15 text-green-400 border-green-500/30" },
  flag_updated: { icon: Flag, label: "Flag Updated", color: "bg-amber-500/15 text-amber-400 border-amber-500/30" },
  flag_removed: { icon: Trash2, label: "Flag Removed", color: "bg-red-500/15 text-red-400 border-red-500/30" },
  record_edited: { icon: Edit, label: "Record Edited", color: "bg-purple-500/15 text-purple-400 border-purple-500/30" },
};

async function fetchActivityLogs() {
  const res = await fetch("/api/activity-logs", {
    credentials: "include",
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : [];
  } catch {
    data = [];
  }

  if (!res.ok) {
    throw new Error(data.error || "Failed to load activity logs");
  }

  return Array.isArray(data) ? data : [];
}

export default function ActivityLogModal({ open, onClose }) {
  const { data: logs = [], isLoading, error } = useQuery({
    queryKey: ["activityLogs"],
    queryFn: fetchActivityLogs,
    enabled: open,
  });

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent
        className="max-w-3xl max-h-[80vh] bg-card border-border"
        onKeyDown={(e) => { if (e.key === 'Enter') onClose(); }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <div className="p-2 bg-muted rounded-lg">
              <Calendar className="w-5 h-5 text-muted-foreground" />
            </div>
            <div className="text-lg font-semibold text-foreground">
              Activity Log
            </div>
          </DialogTitle>
          <DialogDescription>
            Recent customer record activity
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 overflow-y-auto max-h-[60vh] pr-2">
          {isLoading ? (
            <div className="text-center py-8 text-muted-foreground">
              Loading activity logs...
            </div>
          ) : error ? (
            <div className="text-center py-8 text-red-400">
              {error.message || "Failed to load activity logs"}
            </div>
          ) : logs.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No activity logged yet
            </div>
          ) : (
            logs.map((log) => {
              const config = actionConfig[log.action_type] || actionConfig.viewed;
              const Icon = config.icon;
              const iconBg = config.color.split(" ")[0];

              return (
                <div
                  key={log.id}
                  className="p-4 bg-muted rounded-lg border border-border hover:bg-muted/80 transition-all"
                >
                  <div className="flex items-start gap-3">
                    <div className={`p-2 rounded-lg ${iconBg}`}>
                      <Icon className="w-4 h-4" />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2 mb-1">
                        <div>
                          <div className="font-semibold text-foreground">
                            {log.resource_name || "Customer Activity"}
                          </div>
                          <div className="text-sm text-muted-foreground">
                            {log.resource_id ? `Record #${log.resource_id}` : "No record id"}
                          </div>
                        </div>

                        <Badge variant="outline" className={`${config.color} border`}>
                          {config.label}
                        </Badge>
                      </div>

                      <div className="flex items-center gap-4 text-xs text-muted-foreground mt-2">
                        <div className="flex items-center gap-1">
                          <User className="w-3 h-3" />
                          <span>{log.user_name || log.user_email}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <Calendar className="w-3 h-3" />
                          <span>
                            {log.created_date
                              ? format(new Date(log.created_date), "MMM d, yyyy 'at' h:mm a")
                              : "Unknown date"}
                          </span>
                        </div>
                      </div>

                      {log.action_details && (
                        <div className="text-xs text-muted-foreground mt-2 italic bg-card p-2 rounded">
                          {log.action_details}
                        </div>
                      )}
                    </div>
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
