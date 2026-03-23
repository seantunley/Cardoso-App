import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Eye, Flag, Edit, Trash2, Calendar, User } from "lucide-react";
import { format } from "date-fns";

const actionConfig = {
  viewed: { icon: Eye, label: "Viewed", color: "bg-blue-100 text-blue-700 border-blue-200" },
  flag_added: { icon: Flag, label: "Flag Added", color: "bg-green-100 text-green-700 border-green-200" },
  flag_updated: { icon: Flag, label: "Flag Updated", color: "bg-amber-100 text-amber-700 border-amber-200" },
  flag_removed: { icon: Trash2, label: "Flag Removed", color: "bg-red-100 text-red-700 border-red-200" },
  record_edited: { icon: Edit, label: "Record Edited", color: "bg-purple-100 text-purple-700 border-purple-200" },
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
      <DialogContent className="max-w-3xl max-h-[80vh] bg-gray-900 border-gray-700">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <div className="p-2 bg-gray-800 rounded-lg">
              <Calendar className="w-5 h-5 text-gray-400" />
            </div>
            <div>
              <div className="text-lg font-semibold text-white">
                Activity Log
              </div>
              <div className="text-sm text-gray-400 font-normal">
                Recent customer record activity
              </div>
            </div>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 overflow-y-auto max-h-[60vh] pr-2">
          {isLoading ? (
            <div className="text-center py-8 text-gray-400">
              Loading activity logs...
            </div>
          ) : error ? (
            <div className="text-center py-8 text-red-400">
              {error.message || "Failed to load activity logs"}
            </div>
          ) : logs.length === 0 ? (
            <div className="text-center py-8 text-gray-400">
              No activity logged yet
            </div>
          ) : (
            logs.map((log) => {
              const config = actionConfig[log.action_type] || actionConfig.viewed;
              const Icon = config.icon;

              return (
                <div
                  key={log.id}
                  className="p-4 bg-gray-800 rounded-lg border border-gray-700 hover:bg-gray-800/80 transition-all"
                >
                  <div className="flex items-start gap-3">
                    <div className={`p-2 rounded-lg ${config.color.split(" ")[0]}`}>
                      <Icon className="w-4 h-4" />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2 mb-1">
                        <div>
                          <div className="font-semibold text-white">
                            {log.resource_name || "Customer Activity"}
                          </div>
                          <div className="text-sm text-gray-400">
                            {log.resource_id ? `Record #${log.resource_id}` : "No record id"}
                          </div>
                        </div>

                        <Badge variant="outline" className={`${config.color} border`}>
                          {config.label}
                        </Badge>
                      </div>

                      <div className="flex items-center gap-4 text-xs text-gray-400 mt-2">
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
                        <div className="text-xs text-gray-300 mt-2 italic bg-gray-900 p-2 rounded">
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