import { Check, AlertTriangle, Clock, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import moment from "moment";

export default function ConnectionStatus({ connection }) {
  const getStatusInfo = (status) => {
    switch (status) {
      case "active":
        return {
          icon: Check,
          label: "Connected",
          color: "text-emerald-400",
          bgColor: "bg-emerald-900/20",
          borderColor: "border-emerald-700",
          description: "Connection is working properly"
        };
      case "error":
        return {
          icon: AlertCircle,
          label: "Connection Failed",
          color: "text-rose-400",
          bgColor: "bg-rose-900/20",
          borderColor: "border-rose-700",
          description: "Unable to connect - check credentials"
        };
      case "testing":
        return {
          icon: Clock,
          label: "Testing",
          color: "text-blue-400",
          bgColor: "bg-blue-900/20",
          borderColor: "border-blue-700",
          description: "Testing connection..."
        };
      case "inactive":
      default:
        return {
          icon: AlertTriangle,
          label: "Inactive",
          color: "text-gray-400",
          bgColor: "bg-gray-800/20",
          borderColor: "border-gray-700",
          description: "Connection is not active"
        };
    }
  };

  const statusInfo = getStatusInfo(connection.status);
  const StatusIcon = statusInfo.icon;

  return (
    <div className={cn("rounded-lg border p-4", statusInfo.bgColor, statusInfo.borderColor)}>
      <div className="flex items-start gap-3">
        <StatusIcon className={cn("w-5 h-5 mt-0.5", statusInfo.color)} />
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h4 className={cn("font-semibold text-sm", statusInfo.color)}>
              {statusInfo.label}
            </h4>
          </div>
          <p className="text-xs text-gray-400 mt-1">{statusInfo.description}</p>
          {connection.last_sync && (
            <p className="text-xs text-gray-500 mt-2">
              Last synced: {moment(connection.last_sync).fromNow()}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}